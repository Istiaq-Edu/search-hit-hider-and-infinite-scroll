import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================
// Background message serialization
//
// `handleMessage` bodies are read-modify-write cycles over the cold cache and
// storage. With two messages in flight, both `getEntries()` calls observe
// `cachedEntries === null`, both load the same snapshot, and the second
// `persistEntries` overwrites the first mutation — last-write-wins data loss
// (two tabs blocking at once, double imports, rapid slider writes).
//
// The fix is a promise-chain queue in background/service-worker.ts. These
// tests drive the real onMessage listener with a storage.get that yields, so
// the second message arrives while the first handler is genuinely mid-flight.
// ============================================================

interface Store {
  entries: Array<{ domain: string; mode: string }>;
  prefs: unknown;
}

function installBrowser(store: Store) {
  const listeners: Array<(msg: unknown, sender: unknown) => unknown> = [];
  const setCalls: Array<Record<string, unknown>> = [];

  const browserMock = {
    storage: {
      local: {
        get: async (key: string) => {
          // Yield so a cold load is still in flight when the second message
          // is enqueued — the exact interleaving that loses data.
          await Promise.resolve();
          return { [key]: key === "shh_entries" ? store.entries : undefined };
        },
        set: async (obj: Record<string, unknown>) => {
          setCalls.push(obj);
          if ("shh_entries" in obj) {
            store.entries = obj.shh_entries as Store["entries"];
          }
        },
        remove: async () => {},
      },
      sync: {
        get: async () => ({ shh_prefs: store.prefs }),
        set: async (obj: Record<string, unknown>) => {
          if ("shh_prefs" in obj) store.prefs = obj.shh_prefs;
        },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    runtime: {
      onMessage: {
        addListener: (fn: (msg: unknown, sender: unknown) => unknown) => {
          listeners.push(fn);
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
  return { listeners, setCalls };
}

async function boot() {
  vi.resetModules();
  const store: Store = { entries: [], prefs: undefined };
  const env = installBrowser(store);
  await import("../../src/background/service-worker");
  expect(env.listeners).toHaveLength(1);
  return { store, ...env, listener: env.listeners[0]! };
}

const addedDomains = (calls: Array<Record<string, unknown>>): string[] => {
  const listWrites = calls.filter((c) => "shh_entries" in c);
  const lastListWrite = listWrites[listWrites.length - 1];
  const entries = (lastListWrite?.shh_entries ?? []) as Store["entries"];
  return entries.map((e) => e.domain).sort();
};

describe("background onMessage serialization", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    // Let fire-and-forget broadcasts settle before the module is discarded.
    await Promise.resolve();
  });

  it("keeps both entries when two mutating messages race on a cold cache", async () => {
    const { listener, setCalls } = await boot();

    await Promise.all([
      listener({ type: "ADD_ENTRY", domain: "a.com", mode: "block" }, {}),
      listener({ type: "ADD_ENTRY", domain: "b.com", mode: "block" }, {}),
    ]);

    // Flush the 500 ms debounced storage write.
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    expect(addedDomains(setCalls)).toEqual(["a.com", "b.com"]);
  });

  it("does not wedge the queue when one handler rejects", async () => {
    const { listener } = await boot();

    // BULK_IMPORT iterates msg.entries -> TypeError on a malformed message.
    await expect(
      listener({ type: "BULK_IMPORT", entries: null }, {}),
    ).rejects.toThrow();

    // The NEXT message must still run: a poisoned chain would hang the popup.
    const res = (await listener({ type: "GET_LIST" }, {})) as {
      entries: unknown[];
    };
    expect(res.entries).toEqual([]);
  });
});
