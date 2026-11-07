import { describe, it, expect, vi } from "vitest";

// ============================================================
// Background cache invalidation vs. in-flight cold reads
//
// `getEntries` / `getPrefs` fill the warm cache from storage. A storage change
// from another context (sync from another device, the local prefs mirror after
// a sync failure) invalidates that cache while the read is in flight. The read
// may have started BEFORE the write that caused the invalidation, so the
// snapshot it resolves with is stale — installing it means later handlers
// operate on, and write back, the pre-write state.
//
// The fix is a cache generation: bump on invalidation AND on local commit, and
// re-read when the generation moved under an in-flight read. These tests drive
// the real service worker and hold `storage.get` open across a write so the
// exact interleaving is reproducible.
// ============================================================

interface Entry {
  domain: string;
  mode: string;
  enabled: boolean;
  createdAt: number;
}

const entry = (domain: string): Entry => ({
  domain,
  mode: "block",
  enabled: true,
  createdAt: 0,
});

const settle = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function installBrowser(store: { entries: Entry[]; prefs: unknown }) {
  const onMessage: Array<(msg: unknown, sender: unknown) => unknown> = [];
  const onChanged: Array<(changes: unknown, area: string) => void> = [];
  let localGetHook: ((key: string) => Promise<unknown> | null) | null = null;
  let syncGetHook: (() => Promise<unknown> | null) | null = null;

  const browserMock = {
    storage: {
      local: {
        get: async (key: string) => {
          const held = localGetHook?.(key);
          if (held) return held;
          return { [key]: key === "shh_entries" ? store.entries : undefined };
        },
        set: async (obj: Record<string, unknown>) => {
          if ("shh_entries" in obj) store.entries = obj.shh_entries as Entry[];
        },
        remove: async () => {},
      },
      sync: {
        get: async () => {
          const held = syncGetHook?.();
          if (held) return held;
          return { shh_prefs: store.prefs };
        },
        set: async () => {},
      },
      onChanged: {
        addListener: (fn: (changes: unknown, area: string) => void) => {
          onChanged.push(fn);
        },
        removeListener() {},
      },
    },
    runtime: {
      onMessage: {
        addListener: (fn: (msg: unknown, sender: unknown) => unknown) => {
          onMessage.push(fn);
        },
      },
    },
    tabs: {
      onRemoved: { addListener() {} },
      query: async () => [],
      sendMessage: async () => {},
    },
  };

  (globalThis as any).browser = browserMock;

  return {
    onMessage,
    onChanged,
    setLocalGetHook(fn: typeof localGetHook) {
      localGetHook = fn;
    },
    setSyncGetHook(fn: typeof syncGetHook) {
      syncGetHook = fn;
    },
  };
}

async function boot() {
  vi.resetModules();
  const store = { entries: [] as Entry[], prefs: undefined as unknown };
  const env = installBrowser(store);
  await import("../../src/background/service-worker");
  // init()'s warm-up runs outside the message queue; let it settle before a
  // test installs a holding hook, so the hook captures the test's read only.
  await settle(10);
  expect(env.onMessage).toHaveLength(1);
  return { store, ...env, listener: env.onMessage[0]! };
}

describe("background cache generation", () => {
  it("does not install a cold list read that was invalidated mid-read", async () => {
    const { listener, store, onChanged, setLocalGetHook } = await boot();

    // Cache lost to an external change (the invalidation half of the race).
    onChanged[0]!({ shh_entries: { newValue: [] } }, "local");

    let resolveStale!: (v: unknown) => void;
    let held = false;
    setLocalGetHook((key) => {
      if (key !== "shh_entries" || held) return null;
      held = true;
      return new Promise((resolve) => {
        resolveStale = resolve;
      });
    });

    const pending = listener({ type: "GET_LIST" }, {}) as Promise<{
      entries: Entry[];
    }>;
    await settle(); // handleMessage reaches the held read

    // The write lands while the read is in flight, then the read returns the
    // snapshot from BEFORE it.
    store.entries = [entry("new.com")];
    onChanged[0]!({ shh_entries: { newValue: store.entries } }, "local");
    resolveStale({ shh_entries: [entry("old.com")] });

    const res = await pending;
    expect(res.entries.map((e) => e.domain)).toEqual(["new.com"]);
  });

  it("does not install a cold prefs read that was invalidated mid-read", async () => {
    const { listener, store, onChanged, setSyncGetHook } = await boot();

    onChanged[0]!({ shh_prefs: { newValue: {} } }, "sync");

    let resolveStale!: (v: unknown) => void;
    let held = false;
    setSyncGetHook(() => {
      if (held) return null;
      held = true;
      return new Promise((resolve) => {
        resolveStale = resolve;
      });
    });

    const pending = listener({ type: "GET_PREFS" }, {}) as Promise<{
      prefs: { pausedGlobally: boolean };
    }>;
    await settle();

    store.prefs = { pausedGlobally: false };
    onChanged[0]!({ shh_prefs: { newValue: store.prefs } }, "sync");
    resolveStale({ shh_prefs: { pausedGlobally: true } });

    const res = await pending;
    expect(res.prefs.pausedGlobally).toBe(false);
  });
});
