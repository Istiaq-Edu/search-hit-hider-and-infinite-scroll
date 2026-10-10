import { describe, it, expect } from "vitest";
import {
  buildCache,
  canPublishCache,
  entriesFromCache,
  parseCache,
  prefsFromCache,
  serializeCache,
  type ShhCache,
} from "../src/content/cache-state";
// `isBlockingActive` used to live in cache-state and be tested here. It was a
// behaviourally identical second copy of `isEngineActive` — the very
// triplication the consolidation removed — so the test moved to
// prefs-transition.test.ts, which tests the one surviving predicate.
import { isEngineActive } from "../src/content/prefs-transition";
import { DEFAULT_PREFS, type BlockEntry, type EngineId, type Prefs } from "../src/shared/types";

// ============================================================
// `_shh_cache` pre-paint layer — D5
//
// The preload (document_start) reads this cache synchronously to hide blocked
// results before the first paint. That layer had ZERO test coverage: the write
// and read lived inside index.ts, which is side-effecting, so no test could bind
// to them. D5 shipped through a 5-axis review and a 500-test suite for that
// reason.
//
// D5 itself: recoverStateFromCache returned `{entries: [], prefs}` for BOTH
// "there is no cache" and "the cache says you have nothing blocked". On a cold
// background the first case yields an empty list; updateCache then published it
// as `{"domains":[]}`, which the next load cannot distinguish from an
// authoritative empty list. A transient hiccup became a permanent loss of
// pre-paint hiding for that origin.
//
// Binds to the SHIPPED functions (google-ancestor-guard.test.ts:24-28 — a
// mirror copy survives a full revert of the shipped code, so tests import it).
// ============================================================

const ENGINE: EngineId = "google";

function entry(domain: string, enabled = true): BlockEntry {
  return { domain, mode: "block", enabled, createdAt: 1 };
}

// Deep-ish clone. A shallow spread would copy the *reference* to
// DEFAULT_PREFS.engineToggles, so the "toggled off" case below would mutate the
// module-level defaults and silently poison every test that runs after it —
// which is exactly what happened the first time this file was written.
// DEFAULT_PREFS is shared mutable state; never hand it out by reference.
function prefs(over: Partial<Prefs> = {}): Prefs {
  return {
    ...DEFAULT_PREFS,
    engineToggles: { ...DEFAULT_PREFS.engineToggles },
    pausedEngines: [...DEFAULT_PREFS.pausedEngines],
    ...over,
  };
}

describe("parseCache — absent and corrupt input are 'no idea', not 'empty'", () => {
  it("returns null for absent input", () => {
    expect(parseCache(null)).toBeNull();
    expect(parseCache("")).toBeNull();
  });

  it("returns null for corrupt JSON rather than throwing", () => {
    expect(parseCache("{not json")).toBeNull();
  });

  it("returns null for a non-object payload", () => {
    expect(parseCache('"a string"')).toBeNull();
    expect(parseCache("42")).toBeNull();
    expect(parseCache("null")).toBeNull();
  });

  it("treats a non-array domains field as NO IDEA, not as an empty list", () => {
    // The D5 trap, entered from the front door. An earlier revision of this
    // file asserted the OPPOSITE — that parseCache returns a cache object with
    // `domains: []` — while cache-state.ts's own comment claimed it refused to
    // do that. Both could not be true, and the code was on the wrong side:
    // recoverStateFromCache() treats any non-null cache as authoritative, so
    // manufacturing `[]` here published an authoritative empty list over a good
    // cache and permanently disabled pre-paint hiding for that origin.
    expect(parseCache(JSON.stringify({ domains: "not-an-array" }))).toBeNull();
    expect(parseCache(JSON.stringify({ domains: 42 }))).toBeNull();
  });

  it("treats an ABSENT domains field as no idea too", () => {
    expect(parseCache(JSON.stringify({ wildcard: false, debug: true }))).toBeNull();
  });

  it("still accepts a legitimately empty list", () => {
    // The distinction that matters: `domains: []` is an array, and an empty
    // array is a real answer — "the user has nothing blocked". Rejecting it
    // would make an authoritative empty list indistinguishable from a corrupt
    // one, and a user who unblocked everything would keep a stale cache that
    // pre-hides their results.
    const c = parseCache(JSON.stringify({ domains: [] }));
    expect(c).not.toBeNull();
    expect(c!.domains).toEqual([]);
    expect(c!.paused).toBe(false);
  });

  it("drops non-string entries", () => {
    const c = parseCache(JSON.stringify({ domains: ["a.com", 7, null, "b.com"] }));
    expect(c!.domains).toEqual(["a.com", "b.com"]);
  });

  it("round-trips through serialize", () => {
    const original: ShhCache = { domains: ["a.com"], wildcard: false, paused: true, debug: true };
    expect(parseCache(serializeCache(original))).toEqual(original);
  });
});

describe("buildCache", () => {
  it("writes only ENABLED entries", () => {
    // A disabled entry must not be pre-hidden: the content script will not
    // re-hide it, so preload hiding would produce a visible "unblock" flash.
    const c = buildCache([entry("a.com"), entry("b.com", false)], prefs(), ENGINE);
    expect(c.domains).toEqual(["a.com"]);
  });

  it("empties the list and flags paused when blocking is suspended", () => {
    const c = buildCache([entry("a.com")], prefs({ pausedGlobally: true }), ENGINE);
    expect(c.domains).toEqual([]);
    expect(c.paused).toBe(true);
  });

  it("carries wildcard and debug so the preload can seed them synchronously", () => {
    const c = buildCache([], prefs({ subdomainWildcard: false, debugMode: true }), ENGINE);
    expect(c.wildcard).toBe(false);
    expect(c.debug).toBe(true);
  });
});

describe("canPublishCache — the D5 guard", () => {
  const empty: ShhCache = { domains: [], wildcard: true, paused: false, debug: false };

  it("REFUSES an empty list derived from a non-authoritative state", () => {
    // The regression. A degraded start holds [] because messaging failed.
    // Publishing it would overwrite a good cache and kill pre-paint hiding
    // permanently for this origin.
    expect(canPublishCache(empty, false)).toBe(false);
  });

  it("allows an empty list from an authoritative state", () => {
    // A warm load with a genuinely empty block list is correct and must be
    // publishable — otherwise a user who unblocked everything keeps a stale
    // cache that pre-hides their results.
    expect(canPublishCache(empty, true)).toBe(true);
  });

  it("allows a NON-empty list even from a non-authoritative state", () => {
    // Degraded but informed: a real cache payload still helps the next load.
    const c: ShhCache = { ...empty, domains: ["a.com"] };
    expect(canPublishCache(c, false)).toBe(true);
  });

  it("still allows publishing while PAUSED, even from a degraded state", () => {
    // Pause is a positive instruction, not an absence of information. With the
    // guard as first written, a degraded tab that paused would be unable to
    // record the pause — and the next load's preload would keep pre-hiding
    // results the user had suspended. The payload's own `paused` flag is the
    // discriminator, not the caller's provenance flag.
    const paused: ShhCache = { ...empty, paused: true, domains: [] };
    expect(canPublishCache(paused, false)).toBe(true);
  });

  it("refuses a non-authoritative empty list that is NOT paused", () => {
    expect(canPublishCache(empty, false)).toBe(false);
  });
});

describe("entriesFromCache / prefsFromCache", () => {
  it("rebuilds entries as enabled blocks", () => {
    // The cache stores no mode, so a perma-ban degrades to a regular block
    // while the background is cold. Documented consequence, not an oversight.
    const entries = entriesFromCache({ domains: ["a.com", "b.com"], wildcard: true, paused: false, debug: false });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ domain: "a.com", mode: "block", enabled: true, createdAt: 0 });
  });

  it("never hands out DEFAULT_PREFS's nested objects by reference", () => {
    // The result of prefsFromCache becomes the module-level `prefs` in
    // content/index.ts. If it aliased the defaults, one write through it would
    // poison DEFAULT_PREFS for the whole process.
    const p = prefsFromCache({ domains: [], wildcard: true, paused: false, debug: false });
    expect(p.engineToggles).not.toBe(DEFAULT_PREFS.engineToggles);
    expect(p.pausedEngines).not.toBe(DEFAULT_PREFS.pausedEngines);
  });

  it("does not let a write through the result corrupt DEFAULT_PREFS", () => {
    const p = prefsFromCache({ domains: [], wildcard: true, paused: false, debug: false });
    p.engineToggles.google = false;
    p.pausedEngines.push("google");
    expect(DEFAULT_PREFS.engineToggles.google).toBe(true);
    expect(DEFAULT_PREFS.pausedEngines).toEqual([]);
  });

  it("layers prefs over the defaults", () => {
    const p = prefsFromCache({ domains: [], wildcard: false, paused: false, debug: true });
    expect(p.subdomainWildcard).toBe(false);
    expect(p.debugMode).toBe(true);
    // Untouched keys keep their defaults.
    expect(p.pausedGlobally).toBe(DEFAULT_PREFS.pausedGlobally);
    expect(p.infiniteScroll).toBe(DEFAULT_PREFS.infiniteScroll);
  });
});
