// ============================================================
// run-load.ts — drive ONE page load through the real pipeline.
//
// This harness imports the SHIPPED modules, not a transcription:
//
//   await import("src/content/preload.ts")   <- the real document_start IIFE
//   await import("src/content/index.ts")     <- the real content script
//     (which calls the real init / earlyHideFromCache / processResults /
//      updateCache / refreshPrefs / refreshEntries / reviveFromBackground,
//      the real DomainMatcher, the real hideResult/restoreResult/showOnce,
//      the real adapters, the real messaging.ts on top of the fake browser)
//
// Only ONE thing is mocked: InfiniteScrollManager. It needs
// IntersectionObserver, scroll geometry and fetch, none of which exist in
// jsdom, and it is not on the show/hide path this audit is about. It is
// replaced by a stub whose onAppend callback is exposed so a scenario can
// still simulate an appended page going through processResults.
//
// TASK ORDER mirrors a real MV3 document_start load:
//
//   task A  preload.ts        (stream empty — nothing to hide yet)
//   task B  content/index.ts  (init(): injectHidingStyles, earlyHideFromCache,
//                              then the FIRST await — also stream empty)
//   task C  the page's own JS hydrates the results   <-- the pre-paint window
//   task D  DOMContentLoaded  (optional per scenario)
//   then the virtual clock runs: messaging, retries, processResults, revive
// ============================================================

import { vi } from "vitest";
import { hydrateResults, resetDocument, googleSkeleton, ddgSkeleton, type FakeResult } from "./dom";
import { installFakeBrowser, type MessagingProfile, type ServerStore } from "./fake-browser";
import { installFreshDom } from "./jsdom-env";
import { probeVisibility, collectRules, type VisibilityReport } from "./visibility";

export interface ScenarioSpec {
  id: string;
  label: string;
  engine: "google" | "ddg";
  results: FakeResult[];
  /** The result node we judge. Must be one of `results`. */
  probeHost: string;
  /** What the BACKGROUND holds. */
  server: ServerStore;
  /** What `_shh_cache` holds at document_start. null = no cache key at all. */
  cache: string | null;
  profile: MessagingProfile;
  /** Fire DOMContentLoaded this many virtual ms after hydration. null = never. */
  domContentLoadedAtMs: number | null;
  /**
   * false (default, and what manifest.json implies for every engine but
   * Startpage): the results exist before content/index.js starts, so
   * earlyHideFromCache() has something to hide.
   * true: model an engine whose content script is document_start and whose
   * results only appear later (Startpage) — then checkpoint 1 is taken after
   * the content script is already running.
   */
  hydrateAfterContentScript?: boolean;
  /** Virtual ms at which the page's deferred JS drops our inline style. */
  styleResetAtMs: number | null;
  /** Extra virtual ms to drive after the last checkpoint. */
  settleMs: number;
  /**
   * Runs after the last checkpoint, still on the virtual clock, for the
   * live-update paths (refreshEntries / refreshPrefs) and for observing an
   * appended infinite-scroll page.
   */
  actions?: (h: LoadHooks) => Promise<void>;
  /** Observer for a scenario that wants the raw node at each checkpoint. */
  onCheckpoint?: (
    name: CheckpointName,
    t: number,
    node: Element,
    report: VisibilityReport
  ) => void;
}

export type CheckpointName =
  | "1-prePaint"
  | "2-afterFirstAwait"
  | "3-afterMessaging"
  | "4-afterProcessResults"
  | "5-afterRevive";

export interface Checkpoint {
  name: CheckpointName;
  t: number;
  nodePresent: boolean;
  report: VisibilityReport | null;
}

export interface LoadResult {
  spec: ScenarioSpec;
  checkpoints: Checkpoint[];
  /** Every [SHH] console line the shipped code emitted, in order. */
  logs: string[];
  /** The <html data-shh-diag> attribute value at the end. */
  diag: string;
  /** _shh_cache after the load — did updateCache() heal it? */
  cacheAfter: string | null;
  /** Did init() get far enough to register the popup message listener? */
  listenerAttached: boolean;
  messagesIssued: number;
  messagesHung: number;
  /** Selectors the product generated that jsdom's engine could not evaluate. */
  unparsableSelectors: string[];
  /** Rules the visibility model had in force, for the evidence dump. */
  rulesInForce: string[];
  /** Virtual ms at which the simulated page-JS style reset landed, or null. */
  styleResetAt: number | null;
}

/** Handles handed to a scenario's `actions` hook, which runs before cleanup. */
export interface LoadHooks {
  /** Push a popup-style message at the content script (LIST_UPDATED / PREFS_UPDATED). */
  emit(type: "PREFS_UPDATED" | "LIST_UPDATED"): void;
  /** Insert results the way the page's own JS / infinite scroll would. */
  appendNodes(nodes: FakeResult[]): Element[];
  /** Run the stubbed InfiniteScrollManager's onAppend (the real append path). */
  appendViaManager(nodes: FakeResult[]): Element[];
  /** Advance the virtual clock (awaits microtasks, so promises settle). */
  settle(ms: number): Promise<void>;
  /** Probe the result node right now. */
  probe(): VisibilityReport | null;
  /** Every [SHH] line logged so far. */
  logs(): string[];
  /** The fake browser's audit counters. */
  issued(): number;
  listenerCount(): number;
  /** Current virtual time. */
  now(): number;
}

const PRELOAD = "../../../src/content/preload.ts";
const INDEX = "../../../src/content/index.ts";

let stubHandle: { instances: unknown[] } = { instances: [] };

async function drive(
  logs: string[],
  needle: RegExp,
  budgetMs: number,
  fromMs: number
): Promise<{ t: number; found: boolean }> {
  let t = fromMs;
  // Check before advancing: with latency 0 the awaited messaging settles in the
  // very first microtask checkpoint, so t is already past the event.
  if (logs.some((l) => needle.test(l))) return { t, found: true };
  while (t < budgetMs) {
    // Fine-grained through init() (every await matters), coarse afterwards.
    const step = t < 12_000 ? 10 : 500;
    await vi.advanceTimersByTimeAsync(step);
    t += step;
    if (logs.some((l) => needle.test(l))) return { t, found: true };
  }
  return { t, found: false };
}

export async function runLoad(spec: ScenarioSpec): Promise<LoadResult> {
  // ── clean slate ──────────────────────────────────────────────────────
  // A brand-new JSDOM window per load: the previous load's MutationObservers
  // are still attached to the previous document, and mutating that same
  // document again would let them rewrite this load's DOM at the wrong
  // granularity. See harness/jsdom-env.ts.
  vi.resetModules();
  vi.useRealTimers();
  installFreshDom(location.href);
  resetDocument(spec.engine === "google" ? googleSkeleton() : ddgSkeleton());

  if (spec.cache !== null) localStorage.setItem("_shh_cache", spec.cache);

  const fb = installFakeBrowser(spec.server, spec.profile);

  const logs: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    const line = a.map((x) => (typeof x === "string" ? x : safeStr(x))).join(" ");
    if (line.includes("[SHH")) logs.push(line);
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  // ── virtual clock ────────────────────────────────────────────────────
  vi.useFakeTimers({
    toFake: [
      "setTimeout", "clearTimeout",
      "setInterval", "clearInterval",
      "requestAnimationFrame", "cancelAnimationFrame",
      "Date",
    ],
  });

  // ── the one mock ─────────────────────────────────────────────────────
  stubHandle = { instances: [] };
  vi.doMock("../../../src/content/infinite-scroll/manager", () => ({
    InfiniteScrollManager: class {
      constructor(
        public engine: unknown,
        public container: unknown,
        public onAppend?: (nodes: Element[]) => void,
        public config?: Record<string, unknown>
      ) {
        stubHandle.instances.push(this);
      }
      init(): void { /* scroll/IntersectionObserver/fetch: out of scope */ }
      destroy(): void { /* noop */ }
    },
  }));

  const checkpoints: Checkpoint[] = [];
  let t = 0;
  let styleResetAt: number | null = null;

  const locateProbe = (): Element | null =>
    (document.querySelector(
      spec.engine === "google"
        ? `#rso div.MjjYud[data-ved="ved-${spec.probeHost}"]`
        : `li[data-layout="organic"]:has(a[href="https://${spec.probeHost}/page"])`
    ) as Element | null) ??
    ((document.querySelector(`[href*="${spec.probeHost}"]`)?.closest(
      "li, div.MjjYud"
    ) ?? null) as Element | null);

  const snap = (name: CheckpointName, at: number): void => {
    const target = locateProbe();
    if (!target) return;
    const report = probeVisibility(target);
    checkpoints.push({ name, t: at, nodePresent: true, report });
    spec.onCheckpoint?.(name, at, target, report);
  };

  try {
    // ── task A: the preload at document_start (manifest.json:101) ──────
    await import(PRELOAD);

    // ── task B: the page's own JS inserts the results ──────────────────
    // On Google this is the two-step hydration the preload's cover exists
    // for. It lands between document_start and document_idle, i.e. BEFORE
    // content/index.js runs (manifest.json:151 runs it at document_idle, and
    // only Startpage's copy is document_start).
    if (!spec.hydrateAfterContentScript) {
      hydrateResults(spec.engine, spec.results);
      await vi.advanceTimersByTimeAsync(0); // drain MutationObserver microtasks
      snap("1-prePaint", t);
    }

    // ── task C: DOMContentLoaded (optional) ────────────────────────────
    if (spec.domContentLoadedAtMs !== null) {
      await vi.advanceTimersByTimeAsync(Math.max(0, spec.domContentLoadedAtMs - t));
      t = spec.domContentLoadedAtMs;
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);
    }

    // ── task D: the content script at document_idle ────────────────────
    await import(INDEX);
    await vi.advanceTimersByTimeAsync(0); // drain the sync prologue's microtasks
    // The result nodes DO exist here — this is precisely the window
    // earlyHideFromCache() (index.ts:916) exists to close.
    snap("2-afterFirstAwait", t);

    // ── task E: late hydration (only when asked for) ──────────────────
    if (spec.hydrateAfterContentScript) {
      hydrateResults(spec.engine, spec.results);
      await vi.advanceTimersByTimeAsync(0);
      snap("1-prePaint", t);
    }

    // ── drive to the messaging checkpoint ─────────────────────────────
    // NOTE: "state loaded" is only logged on the RECOVERED-retry path
    // (index.ts:208 sits in the `else` of the catch), so the happy path's
    // first post-state line is the "engine=…" decision log. Finding that is
    // the honest signal that entries+prefs are loaded. (The misplaced log is
    // itself reported as defect D6.)
    const m = await drive(logs, /engine=|degraded start|state loaded/, 60_000, t);
    t = m.t;
    snap("3-afterMessaging", t);

    // ── drive to processResults ───────────────────────────────────────
    const p = await drive(logs, /init done/, 60_000, t);
    t = p.t;
    snap("4-afterProcessResults", t);

    // ── the page's deferred style reset, if scheduled ─────────────────
    if (spec.styleResetAtMs !== null && spec.styleResetAtMs > t) {
      await vi.advanceTimersByTimeAsync(spec.styleResetAtMs - t);
      t = spec.styleResetAtMs;
      styleResetAt = t;
      // Google's deferred scripts rebuild `style` from their own state, which
      // silently drops our inline display:none. The shipped code defends
      // against exactly this (index.ts:944-956).
      for (const n of document.querySelectorAll("[data-shh-result],[data-shh-preloaded]")) {
        n.removeAttribute("style");
      }
    }

    // ── drive the reviver (only runs on a degraded start) ─────────────
    const degraded = logs.some((l) => l.includes("degraded start"));
    if (degraded) {
      const r = await drive(logs, /revived from background/, 90_000, t);
      t = r.t;
    }
    await vi.advanceTimersByTimeAsync(spec.settleMs);
    t += spec.settleMs;
    snap("5-afterRevive", t);

    const { rules, unparsable } = collectRules();

    // ── the scenario's own post-load actions, still on the virtual clock ──
    if (spec.actions) {
      await spec.actions({
        emit: (type) => fb.__audit.emit(type),
        appendNodes: (nodes) => hydrateResults(spec.engine, nodes),
        appendViaManager: (nodes) => {
          const added = hydrateResults(spec.engine, nodes);
          const mgr = stubHandle.instances[0] as
            | { onAppend?: (n: Element[]) => void }
            | undefined;
          mgr?.onAppend?.(added);
          return added;
        },
        settle: async (ms) => {
          await vi.advanceTimersByTimeAsync(ms);
          t += ms;
        },
        probe: () => {
          const n = locateProbe();
          return n ? probeVisibility(n) : null;
        },
        logs: () => [...logs],
        issued: () => fb.__audit.issued(),
        listenerCount: () => fb.__audit.listenerCount(),
        now: () => t,
      });
    }

    return {
      spec,
      checkpoints,
      logs,
      diag: document.documentElement.getAttribute("data-shh-diag") ?? "",
      cacheAfter: localStorage.getItem("_shh_cache"),
      listenerAttached: fb.__audit.listenerCount() > 0,
      messagesIssued: fb.__audit.issued(),
      messagesHung: fb.__audit.hung(),
      unparsableSelectors: unparsable,
      rulesInForce: rules.map(
        (x) => `${x.origin} ${x.display ? "display:" + x.display : ""}${x.opacity ? " opacity:" + x.opacity : ""} :: ${x.selector.slice(0, 70)}`
      ),
      styleResetAt,
    };
  } finally {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

function safeStr(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}
