import type { EngineId, Prefs } from "../shared/types";

// ============================================================
// Prefs-change transition decisions
//
// WHY THIS FILE EXISTS
// --------------------
// `refreshPrefs` reacts to a live prefs change (pause, unpause, engine toggle)
// by picking one of three paths. Two things about it were unsafe to ship
// untested:
//
//   1. The "is blocking active for this engine" predicate was written out
//      THREE times verbatim in index.ts — in `init`, in `reviveFromBackground`,
//      and in `refreshPrefs`. The resume branch is only correct if all three
//      agree; if they drift, a tab can compute `engineActive = false` at load,
//      stay that way through a resume, and re-hide nothing. One source of truth
//      removes the class of bug rather than one instance of it.
//
//   2. `refreshPrefs` had ZERO tests, because it lived in a side-effecting
//      module. It has 13 branches; making `PREFS_UPDATED` broadcast (C2) turns
//      ALL of them live at once, for the first time anywhere. Five are unsafe.
//      Testing the decision BEFORE the broadcast ships is the whole point — it
//      is cheaper to fix a decision table than a live regression.
//
// Same extraction rationale as `dedupe.isInsideProcessedTerritory` (A5-R1) and
// `blocking/reconcile.ts`: a test must bind to the shipped function, because a
// mirror copy survives a full revert of the real one.
// ============================================================

/**
 * Is blocking active for `engineId` under `prefs`?
 *
 * The single source of truth. Note `engineToggles[id] !== false` rather than
 * `=== true`: a missing key (older prefs payload, partial import) must read as
 * ENABLED, not silently disable an engine.
 */
export function isEngineActive(prefs: Prefs, engineId: EngineId): boolean {
  return (
    !prefs.pausedGlobally &&
    !prefs.pausedEngines.includes(engineId) &&
    prefs.engineToggles[engineId] !== false
  );
}

export type PrefsTransition =
  /** No active/inactive change — only the cheap cache refresh applies. */
  | "none"
  /** Blocking was suspended mid-session: reveal everything, tear down. */
  | "suspend"
  /** Blocking was resumed mid-session: run the processing `init` skipped. */
  | "resume";

/**
 * Which path a prefs change takes.
 *
 * `wasActive` must be the value `init`/`refreshPrefs` last committed, not a
 * recomputation — recomputing it from the NEW prefs would make the comparison
 * vacuous and the transition would never fire.
 */
export function classifyPrefsTransition(
  wasActive: boolean,
  isActive: boolean
): PrefsTransition {
  if (wasActive && !isActive) return "suspend";
  if (!wasActive && isActive) return "resume";
  return "none";
}

// The suspend obligations — and the load-bearing SUSPEND_HANDLERS map that
// enforces them — now live in `refresh-queue.ts`. They sat here before, as a
// plain array with no consumer, and a mutation review proved the gap: deleting
// `observer?.stop()` from the teardown in index.ts left 625/625 green while the
// array still listed it. A constant nothing reads is a comment; the map is
// type-checked against the obligation list, so a dropped step is a `tsc` error.
//
// Each obligation was a live defect while `PREFS_UPDATED` was still unsent:
//
//   revealHiddenNodes    lift inline display, hide classes and preload marks
//   clearHasRules        drop the :has() sheet (needs preload.ts to honour an
//                        empty list — C3, coupled)
//   revealGoogleCover    `__shhRevealGoogle()` — without it, nodes the cover
//                        marked opacity:0 stay invisible AND unclickable
//   disarmStaticCover    detach the adopted cover sheet + drop
//                        html[data-shh-active]; the attribute gates only the
//                        STATIC rule, and the sheet handle lives in the preload
//                        closure, so this needs the preload's own hook
//   stopObserver         stop new nodes being hidden
//   destroyScrollManager appended pages would keep arriving and be re-hidden
//   writeCache           publish the paused payload so the next load's preload
//                        stands down
//
// `guardReEntry` used to be listed here. It is not a teardown call but a
// standing condition — the `shouldReScan` guard consulted by the
// `visibilitychange` handler and the 1.5s URL watcher — so it moved to where it
// actually lives. See `SUSPEND_OBLIGATIONS` in refresh-queue.ts.
export { SUSPEND_OBLIGATIONS, runSuspendTeardown, type SuspendObligation, type SuspendDeps } from "./refresh-queue";
