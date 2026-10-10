import { describe, it, expect } from "vitest";
import {
  isEngineActive,
  classifyPrefsTransition,
  SUSPEND_OBLIGATIONS,
} from "../src/content/prefs-transition";
import { DEFAULT_PREFS, ALL_ENGINE_IDS, type EngineId, type Prefs } from "../src/shared/types";

// ============================================================
// Prefs-change transitions — coverage for the P5 prerequisite
//
// `refreshPrefs` had ZERO tests: it lives in a side-effecting module. It has 13
// branches, and making `PREFS_UPDATED` actually broadcast (defect C2 — it
// currently has no sender at all) turns every one of them live at once, for the
// first time anywhere. Five were unsafe.
//
// This file covers the DECISION half of that, which is where the risk lives,
// and pins the obligation list the teardown is audited against. The DOM half
// needs the audit harness's page-load driver (see the plan's P5 note).
//
// Binds to the SHIPPED functions per google-ancestor-guard.test.ts:24-28 —
// a mirror copy survives a full revert of the real code, so tests import it.
// ============================================================

// Deep-ish clone. A shallow spread hands out the REFERENCE to
// DEFAULT_PREFS.engineToggles and DEFAULT_PREFS.pausedEngines, so writing
// through it would mutate the module-level defaults and poison every later test
// in the process. This is a live hazard, not a hypothetical: types.ts:61-63
// builds engineToggles with Object.fromEntries.
function prefs(over: Partial<Prefs> = {}): Prefs {
  return {
    ...DEFAULT_PREFS,
    engineToggles: { ...DEFAULT_PREFS.engineToggles },
    pausedEngines: [...DEFAULT_PREFS.pausedEngines],
    ...over,
  };
}

describe("isEngineActive", () => {
  it("is active with default prefs", () => {
    expect(isEngineActive(prefs(), "google")).toBe(true);
  });

  it("is inactive when paused globally", () => {
    expect(isEngineActive(prefs({ pausedGlobally: true }), "google")).toBe(false);
  });

  it("is inactive when THIS engine is paused", () => {
    expect(isEngineActive(prefs({ pausedEngines: ["google"] }), "google")).toBe(false);
  });

  it("leaves other engines alone when one is paused", () => {
    const p = prefs({ pausedEngines: ["google"] });
    expect(isEngineActive(p, "bing")).toBe(true);
  });

  it("is inactive when this engine is toggled off", () => {
    const p = prefs();
    p.engineToggles.bing = false;
    expect(isEngineActive(p, "bing")).toBe(false);
  });

  it("treats a MISSING toggle key as enabled", () => {
    // `!== false`, not `=== true`. A partial prefs payload (older version,
    // hand-edited storage, a lossy import) must not silently disable an engine
    // — that would stop blocking with no visible cause.
    const p = prefs();
    delete (p.engineToggles as Partial<Record<EngineId, boolean>>).google;
    expect(isEngineActive(p, "google")).toBe(true);
  });

  it("agrees across every engine for a globally-paused payload", () => {
    const p = prefs({ pausedGlobally: true });
    for (const id of ALL_ENGINE_IDS) {
      expect(isEngineActive(p, id)).toBe(false);
    }
  });
});

describe("classifyPrefsTransition", () => {
  it("suspends on active → inactive", () => {
    expect(classifyPrefsTransition(true, false)).toBe("suspend");
  });

  it("resumes on inactive → active", () => {
    expect(classifyPrefsTransition(false, true)).toBe("resume");
  });

  it("does nothing on active → active", () => {
    expect(classifyPrefsTransition(true, true)).toBe("none");
  });

  it("does nothing on inactive → inactive", () => {
    expect(classifyPrefsTransition(false, false)).toBe("none");
  });

  // The whole table, so a future edit to the classifier is caught.
  it("covers the full 2x2 truth table", () => {
    const table = [
      { was: false, is: false, expect: "none" },
      { was: false, is: true, expect: "resume" },
      { was: true, is: false, expect: "suspend" },
      { was: true, is: true, expect: "none" },
    ] as const;
    for (const row of table) {
      expect(classifyPrefsTransition(row.was, row.is)).toBe(row.expect);
    }
  });

  it("never returns a transition for an unchanged state", () => {
    // Guards the resume branch's precondition at the CLASSIFIER level: equal
    // inputs must give "none".
    //
    // This does NOT test the real precondition, which lives in index.ts —
    // that `wasActive` is read from committed state rather than recomputed
    // from the NEW prefs. An earlier version of this test computed both
    // arguments to be equal BY ITSELF, so it reduced to
    // `classifyPrefsTransition(x, x) === "none"` and passed against a
    // classifier that returned "none" unconditionally. The call-site
    // precondition is covered structurally by refresh-queue.test.ts.
    expect(classifyPrefsTransition(true, true)).toBe("none");
    expect(classifyPrefsTransition(false, false)).toBe("none");
  });
});

// The suspend teardown's OBLIGATION LIST is asserted here; the teardown's
// BEHAVIOUR is asserted in refresh-queue.test.ts against the shipped
// `runSuspendTeardown`. This file previously duplicated that as a
// SUSPEND_HANDLERS shape check — a map of empty arrows that nothing in `src/`
// imported, so it constrained nothing about the teardown. Duplicated coverage
// of a list is not coverage of a teardown.
describe("SUSPEND_OBLIGATIONS", () => {
  it("includes the obligations whose absence was a live defect", () => {
    // `disarmStaticCover` is the one a mutation review caught: removing only
    // `data-shh-active` left the PRIMARY Google cover (an adopted stylesheet
    // whose handle lives in the preload closure) attached, so results rendered
    // after a pause sat at opacity:0 + pointer-events:none forever.
    expect(SUSPEND_OBLIGATIONS).toContain("disarmStaticCover");
    expect(SUSPEND_OBLIGATIONS).toContain("stopObserver");
    expect(SUSPEND_OBLIGATIONS).toContain("destroyScrollManager");
    expect(SUSPEND_OBLIGATIONS).toContain("writeCache");
  });

  it("does NOT list guardReEntry — it is a standing condition, not a call", () => {
    // Re-entry is gated by `shouldReScan`, which the visibilitychange handler
    // and the 1.5s URL watcher consult on every event. It is discharged by
    // `engineActive` being false, not by a teardown step. Listing it here
    // implied a call that does not exist.
    expect(SUSPEND_OBLIGATIONS).not.toContain("guardReEntry");
  });

  it("has no duplicates", () => {
    expect(new Set(SUSPEND_OBLIGATIONS).size).toBe(SUSPEND_OBLIGATIONS.length);
  });
});
