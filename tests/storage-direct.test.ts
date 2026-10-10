import { describe, it, expect, beforeEach, vi } from "vitest";
import { STORAGE_KEY_LIST, STORAGE_KEY_PREFS } from "../src/shared/types";

// ============================================================
// The content script must not depend on a live background page
// ============================================================
//
// Field report, 2026-09-30: "the extension is not responsive until I open the
// extension once after every page load."
//
// That is an MV3 EVENT-PAGE cold start. `init()`'s first action used to be
// `sendMessage(GET_LIST)`, which must WAKE the suspended background; a cold
// wake routinely exceeds the 2500 ms budget, burns the retry ladder (up to
// 5.8 s) and lands in a degraded cache start. Opening the popup reads storage,
// which wakes the worker — which is exactly why that appeared to fix it.
//
// These tests drive the two storage helpers with the message bus made
// deliberately hostile, and require the read to still succeed. The whole point
// is that no message ever needs to be sent.
// ============================================================

interface MsgEnv {
  w: Record<string, any>;
  sent: unknown[];
}

function makeEnv(opts: { storageBroken?: boolean; syncHangs?: boolean } = {}): MsgEnv {
  const sent: unknown[] = [];
  const store: Record<string, unknown> = {
    // The real keys, imported from the shipped module rather than retyped —
    // a mistyped literal here would make every test pass against an empty
    // store and prove nothing.
    [STORAGE_KEY_LIST]: [
      { domain: "blocked.com", mode: "block", enabled: true, createdAt: 0 },
      { domain: "off.com", mode: "block", enabled: false, createdAt: 1 },
    ],
    [STORAGE_KEY_PREFS]: { debugMode: true, subdomainWildcard: false },
  };
  const w: Record<string, any> = {
    browser: {
      storage: {
        local: {
          get: async (k: string) => {
            if (opts.storageBroken) throw new Error("storage unavailable");
            return { [k]: store[k] };
          },
          set: async () => {},
        },
        sync: {
          get: async (k: string) => {
            if (opts.storageBroken) throw new Error("storage unavailable");
            // Firefox's storage.sync talks to a REMOTE server when signed in.
            // It can hang for seconds. The block list is local and must not
            // wait on it.
            if (opts.syncHangs) return new Promise(() => {});
            return { [k]: store[k] };
          },
          set: async () => {},
        },
      },
      runtime: {
        getManifest: () => ({ version: "1.8.20" }),
        // Every message HANGS. If the read path ever reaches this, the promise
        // never settles and the test times out — which is the failure we are
        // preventing, expressed as a test.
        sendMessage: (m: unknown) => {
          sent.push(m);
          return new Promise(() => {});
        },
        onMessage: { addListener() {} },
      },
    },
  };
  return { w, sent };
}

async function loadMessaging(env: MsgEnv) {
  // Fresh module registry per test so nothing is cached between cases.
  vi.resetModules();
  (globalThis as any).browser = env.w.browser;
  return (await import("../src/content/messaging")) as typeof import("../src/content/messaging");
}

describe("direct storage reads do not need the background", () => {
  let env: MsgEnv;
  beforeEach(() => { env = makeEnv(); });

  it("reads the block list without sending a single message", async () => {
    const m = await loadMessaging(env);
    const entries = await m.getListDirect();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.domain).toBe("blocked.com");
    expect(env.sent).toEqual([]);
  });

  it("reads prefs without sending a single message", async () => {
    const m = await loadMessaging(env);
    const prefs = await m.getPrefsDirect();
    expect(prefs.subdomainWildcard).toBe(false);
    expect(env.sent).toEqual([]);
  });

  it("REJECTS when storage is unavailable, so init falls through a tier", async () => {
    // Must not degrade to a silent `[]`: a broken storage that looks like an
    // empty block list is the D5 failure, and the tier-1 `try` can only catch a
    // rejection. An empty list here would make a healthy storage look empty.
    const broken = makeEnv({ storageBroken: true });
    const m = await loadMessaging(broken);
    await expect(m.getListDirect()).rejects.toThrow("storage unavailable");
  });

  it("reads the LIST even when storage.sync HANGS", async () => {
    // The flaw this replaced: both reads shared one `Promise.all` deadline, so a
    // slow sync (remote server, bad connection, signed-out-then-syncing) took
    // the BLOCK LIST down with it — which dropped straight back into the
    // messaging path the direct read exists to avoid, i.e. the exact cold-worker
    // symptom being fixed. The list is `storage.local`: local, ~1 ms, and it
    // must never wait on a networked call.
    const slow = makeEnv({ syncHangs: true });
    const m = await loadMessaging(slow);
    const entries = await m.getListDirect();
    expect(entries).toHaveLength(2);
    expect(slow.sent).toEqual([]);
  });

  it("keeps the message bus for WRITES, which genuinely need the background", async () => {
    // Guards against over-correcting: deleting the bus would stop writes from
    // broadcasting to other tabs. Only READS moved.
    const m = await loadMessaging(env);
    expect(typeof m.addEntry).toBe("function");
    expect(typeof m.removeEntry).toBe("function");
    expect(typeof m.undoLast).toBe("function");
    // ...and the old read path is retained as tier 2, not deleted.
    expect(typeof m.getList).toBe("function");
    expect(typeof m.getPrefs).toBe("function");
  });
});
