// ============================================================
// fake-browser.ts — a controllable `browser.*` stand-in.
//
// The one thing the field bug hinges on is WHEN the background answers. MV3
// event pages are cold-start latency machines: the same `runtime.sendMessage`
// can resolve in a few milliseconds on a warm page and hang for many seconds
// on a cold one (index.ts:179-210 exists precisely to bound that). The harness
// therefore makes the answer time a first-class, reproducible input:
//
//   latency: "fast" | "slow" | "never" | number   (virtual ms, fake timers)
//   failFirstRounds: how many message ROUNDS hang before it starts answering
//
// A "round" = one Promise.all([getList(), getPrefs()]) batch, i.e. 2 messages.
// This is what makes degraded mode (index.ts:196-206) reproducible instead of
// something you have to get lucky with.
// ============================================================

import type { BlockEntry, Prefs, ExtMessage } from "../../../src/shared/types";
import { DEFAULT_PREFS } from "../../../src/shared/types";

export type Latency = "fast" | "slow" | "never" | number;

export interface ServerStore {
  entries: BlockEntry[];
  prefs: Prefs;
}

export interface MessagingProfile {
  /** Virtual ms before a message resolves. */
  latency: Latency;
  /**
   * How many message ROUNDS hang (never resolve) before the background starts
   * answering normally. Use `Infinity` for "never recovers".
   * A round is complete once the same in-flight count peaks; simpler and
   * sufficient here: a round boundary is every 2 messages that were issued
   * while the background was cold.
   */
  failFirstRounds: number;
  /** Deterministic LCG seed for per-run jitter. */
  seed: number;
  /** Max extra virtual ms added to `latency` per round. */
  jitterMs: number;
}

/** Deterministic 32-bit LCG — same seed, same jitter, on every machine. */
export function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

export function resolveLatency(p: MessagingProfile): number | "never" {
  if (p.latency === "never") return "never";
  if (p.latency === "fast") return 0;
  if (p.latency === "slow") return 3000;
  return p.latency;
}

interface FakeBrowser {
  runtime: {
    getManifest(): { version: string };
    sendMessage(msg: unknown): Promise<unknown>;
    onMessage: {
      addListener(fn: (msg: unknown) => void): void;
      removeListener(fn: (msg: unknown) => void): void;
      hasListener(fn: (msg: unknown) => void): boolean;
    };
  };
  storage: {
    local: { get(k: string): Promise<Record<string, unknown>>; set(o: Record<string, unknown>): Promise<void>; clear(): Promise<void> };
    sync: { get(k: string): Promise<Record<string, unknown>>; set(o: Record<string, unknown>): Promise<void> };
  };
  __audit: {
    /** How many sendMessage calls have been issued. */
    issued(): number;
    /** How many are still unsettled (hung). */
    hung(): number;
    /** Push a popup-style message to the content script. */
    emit(type: "PREFS_UPDATED" | "LIST_UPDATED"): void;
    /** How many content-script listeners are attached. */
    listenerCount(): number;
  };
}

/** Number of messages issued per init() attempt batch (getList + getPrefs). */
const MESSAGES_PER_ROUND = 2;

export function installFakeBrowser(
  store: ServerStore,
  profile: MessagingProfile
): FakeBrowser {
  const rnd = lcg(profile.seed);
  const base = resolveLatency(profile);

  let issued = 0;
  let hung = 0;
  const listeners = new Set<(msg: unknown) => void>();
  const storageArea = new Map<string, unknown>();

  function answer(msg: ExtMessage): unknown {
    switch (msg.type) {
      case "GET_LIST":
        return { entries: store.entries.map((e) => ({ ...e })) };
      case "GET_PREFS":
        return { prefs: { ...DEFAULT_PREFS, ...store.prefs } };
      case "ADD_ENTRY": {
        const dup = store.entries.some((e) => e.domain === msg.domain);
        if (dup) return { entry: null, duplicate: true };
        const entry: BlockEntry = {
          domain: msg.domain,
          mode: msg.mode,
          enabled: true,
          createdAt: Date.now(),
        };
        store.entries.push(entry);
        return { entry, duplicate: false };
      }
      case "REMOVE_ENTRY":
        store.entries = store.entries.filter((e) => e.domain !== msg.domain);
        return {};
      case "UPDATE_ENTRY":
        store.entries = store.entries.map((e) =>
          e.domain === msg.domain ? { ...e, ...msg.patch } : e
        );
        return {};
      case "UNDO_LAST":
        return { restored: null };
      default:
        return {};
    }
  }

  const api: FakeBrowser = {
    runtime: {
      getManifest: () => ({ version: "1.8.18-audit" }),
      sendMessage(msg) {
        issued += 1;
        // A "round" is one init() attempt's getList + getPrefs pair, so the
        // 1-based round number is ceil(issued / 2). failFirstRounds = 0
        // therefore means "the background is always warm", which is the case
        // this harness needs for the "fast background" column of the matrix.
        const round = Math.ceil(issued / MESSAGES_PER_ROUND);
        const cold = round <= profile.failFirstRounds;
        if (base === "never" || cold) {
          hung += 1;
          return new Promise<never>(() => { /* hangs like a cold event page */ });
        }
        const jitter = profile.jitterMs > 0 ? Math.floor(rnd() * (profile.jitterMs + 1)) : 0;
        const delay = base + jitter;
        return new Promise((res) => setTimeout(() => res(answer(msg as ExtMessage)), delay));
      },
      onMessage: {
        addListener(fn) { listeners.add(fn); },
        removeListener(fn) { listeners.delete(fn); },
        hasListener(fn) { return listeners.has(fn); },
      },
    },
    storage: {
      local: {
        get: async (k) => (storageArea.has(k) ? { [k]: storageArea.get(k) } : {}),
        set: async (o) => { for (const [k, v] of Object.entries(o)) storageArea.set(k, v); },
        clear: async () => { storageArea.clear(); },
      },
      sync: {
        get: async (k) => (storageArea.has(k) ? { [k]: storageArea.get(k) } : {}),
        set: async (o) => { for (const [k, v] of Object.entries(o)) storageArea.set(k, v); },
      },
    },
    __audit: {
      issued: () => issued,
      hung: () => hung,
      emit: (type) => { for (const fn of listeners) fn({ type }); },
      listenerCount: () => listeners.size,
    },
  };

  (globalThis as unknown as { browser: FakeBrowser }).browser = api;
  return api;
}

/** Build a server store from a compact description. */
export function serverStore(
  entries: Array<[string, "block" | "pban"]>,
  prefs: Partial<Prefs> = {}
): ServerStore {
  return {
    entries: entries.map(([domain, mode], i) => ({
      domain, mode, enabled: true, createdAt: 1_700_000_000_000 + i,
    })),
    prefs: { ...DEFAULT_PREFS, ...prefs },
  };
}

/** Build a `_shh_cache` payload in the exact shape updateCache() writes. */
export function shhCache(
  domains: string[],
  opts: { wildcard?: boolean; paused?: boolean; debug?: boolean } = {}
): string {
  return JSON.stringify({
    domains,
    wildcard: opts.wildcard !== false,
    paused: opts.paused === true,
    debug: opts.debug === true,
  });
}
