import { describe, it, expect, afterEach, vi } from "vitest";
import { popUndoEntry, saveUndoEntry, loadPrefs, savePrefs } from "../src/shared/storage";
import {
  DEFAULT_PREFS,
  STORAGE_KEY_PREFS,
  STORAGE_KEY_PREFS_LOCAL,
  STORAGE_KEY_UNDO,
  type BlockEntry,
  type Prefs,
} from "../src/shared/types";

// ============================================================
// Undo scoping and prefs durability
//
// Both defects only appear in degraded states, which is why neither had a
// test: the undo map and the sync/local prefs mirrors are two stores that can
// legitimately disagree. The tests drive the SHIPPED functions against an
// in-memory browser.storage with one store deliberately failing/stale.
// ============================================================

interface Env {
  local: Record<string, unknown>;
  sync: Record<string, unknown>;
}

function installBrowser(
  opts: { syncSetFails?: boolean; syncGetFails?: boolean; localSetFails?: boolean } = {}
): Env {
  const env: Env = { local: {}, sync: {} };
  const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const browser = {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: clone(env.local[k]) }),
        set: async (obj: Record<string, unknown>) => {
          if (opts.localSetFails) throw new Error("local quota exceeded");
          Object.assign(env.local, clone(obj));
        },
        remove: async (k: string) => { delete env.local[k]; },
      },
      sync: {
        get: async (k: string) => {
          if (opts.syncGetFails) throw new Error("sync unavailable");
          return { [k]: clone(env.sync[k]) };
        },
        set: async (obj: Record<string, unknown>) => {
          if (opts.syncSetFails) throw new Error("sync quota exceeded");
          Object.assign(env.sync, clone(obj));
        },
      },
    },
  };
  vi.stubGlobal("browser", browser);
  return env;
}

function entry(domain: string, createdAt: number): BlockEntry {
  return { domain, mode: "block", enabled: true, createdAt };
}

function prefs(over: Partial<Prefs> = {}): Prefs {
  return {
    ...DEFAULT_PREFS,
    engineToggles: { ...DEFAULT_PREFS.engineToggles },
    pausedEngines: [...DEFAULT_PREFS.pausedEngines],
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("popUndoEntry — scoped undo never falls through to another domain", () => {
  it("returns null for a missing domain and leaves other records intact", async () => {
    installBrowser();
    await saveUndoEntry(entry("a.com", 1000), "add");

    // The toast for a domain whose record was evicted (50-entry cap, a second
    // tab, or a remove that found nothing) must do nothing. It used to pop the
    // NEWEST record of any domain, adding or deleting a block the user never
    // clicked.
    expect(await popUndoEntry("missing.com")).toBeNull();
    // The other record is still there — the failed lookup consumed nothing.
    expect((await popUndoEntry("a.com"))?.entry.domain).toBe("a.com");
  });

  it("still falls back to the newest record when no domain is supplied", async () => {
    installBrowser();
    await saveUndoEntry(entry("old.com", 1000), "add");
    await saveUndoEntry(entry("new.com", 2000), "add");

    const record = await popUndoEntry();
    expect(record?.entry.domain).toBe("new.com");
    // Popping is destructive, so the other record must remain.
    expect((await popUndoEntry())?.entry.domain).toBe("old.com");
  });

  it("does not treat inherited object properties as a record", async () => {
    installBrowser();
    // "__proto__" can never be a stored domain, but the map is read from
    // storage and a prototype lookup must not be mistaken for a record.
    expect(await popUndoEntry("__proto__")).toBeNull();
  });
});

describe("prefs durability — the newer mirror wins", () => {
  it("keeps a saved pref when storage.sync rejects the write", async () => {
    installBrowser({ syncSetFails: true });
    const saved = prefs({ debugMode: true, subdomainWildcard: false });
    await savePrefs(saved);

    // The local mirror now carries a timestamp; sync is empty/stale. The next
    // background start must not revert to defaults or to a stale synced copy.
    const loaded = await loadPrefs();
    expect(loaded.debugMode).toBe(true);
    expect(loaded.subdomainWildcard).toBe(false);
  });

  it("prefers a NEWER synced value (cross-device update)", async () => {
    const env = installBrowser();
    env.sync[STORAGE_KEY_PREFS] = { ...prefs({ debugMode: true }), __shhSavedAt: 2000 };
    env.local[STORAGE_KEY_PREFS_LOCAL] = { ...prefs({ debugMode: false }), __shhSavedAt: 1000 };

    expect((await loadPrefs()).debugMode).toBe(true);
  });

  it("prefers the local mirror when it is newer than sync", async () => {
    const env = installBrowser();
    env.sync[STORAGE_KEY_PREFS] = { ...prefs({ debugMode: false }), __shhSavedAt: 1000 };
    env.local[STORAGE_KEY_PREFS_LOCAL] = { ...prefs({ debugMode: true }), __shhSavedAt: 2000 };

    expect((await loadPrefs()).debugMode).toBe(true);
  });

  it("prefers sync for legacy payloads with no timestamp", async () => {
    const env = installBrowser();
    env.sync[STORAGE_KEY_PREFS] = { debugMode: true };
    env.local[STORAGE_KEY_PREFS_LOCAL] = { debugMode: false };

    expect((await loadPrefs()).debugMode).toBe(true);
  });

  it("falls back to the local mirror when sync cannot be read", async () => {
    const env = installBrowser({ syncGetFails: true });
    env.local[STORAGE_KEY_PREFS_LOCAL] = { ...prefs({ debugMode: true }), __shhSavedAt: 1 };

    expect((await loadPrefs()).debugMode).toBe(true);
  });

  it("never leaks the internal timestamp into the returned prefs", async () => {
    installBrowser({ syncSetFails: true });
    await savePrefs(prefs());
    const loaded = await loadPrefs();
    expect("__shhSavedAt" in (loaded as unknown as Record<string, unknown>)).toBe(false);
  });
});

// ============================================================
// Upgrade path + degraded writes. Both were introduced with the map-shaped
// undo store and the write-through prefs mirror; neither is reachable in the
// happy path, which is exactly why they need a test.
// ============================================================

describe("legacy single-slot undo payload", () => {
  it("upgrades a bare BlockEntry into a scoped record", async () => {
    const env = installBrowser();
    env.local[STORAGE_KEY_UNDO] = entry("old.com", 1000);

    const record = await popUndoEntry("old.com");
    expect(record?.action).toBe("remove");
    expect(record?.entry.domain).toBe("old.com");
    // The upgraded record is consumed, not left behind as a corrupt map.
    expect(await popUndoEntry("old.com")).toBeNull();
  });

  it("does not throw when the legacy payload is popped without a domain", async () => {
    const env = installBrowser();
    env.local[STORAGE_KEY_UNDO] = entry("old.com", 1000);
    expect((await popUndoEntry())?.entry.domain).toBe("old.com");
  });
});

describe("prefs mirror is best-effort", () => {
  it("still saves to sync when storage.local rejects the mirror write", async () => {
    const env = installBrowser({ localSetFails: true });
    await savePrefs(prefs({ debugMode: true, subdomainWildcard: false }));

    expect(env.sync[STORAGE_KEY_PREFS]).toBeDefined();
    expect(env.local[STORAGE_KEY_PREFS_LOCAL]).toBeUndefined();
    expect((await loadPrefs()).debugMode).toBe(true);
  });

  it("reports failure when neither store accepts the write", async () => {
    installBrowser({ localSetFails: true, syncSetFails: true });
    await expect(savePrefs(prefs())).rejects.toThrow();
  });
});
