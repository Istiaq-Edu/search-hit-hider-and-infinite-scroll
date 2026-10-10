// ============================================================
// Message-refresh queueing and suspend/resume gating
//
// WHY THIS FILE EXISTS
// --------------------
// `content/index.ts` is side-effecting — importing it runs `init()`. A mutation
// review of the show/hide fixes found that NONE of the wiring in that file was
// covered: reverting the module-scope `onMessage` listener, the D1 call site,
// the D5 guard, the suspend teardown, or the `wasActive` read all left the
// suite green. The pure helpers were pinned; the part that actually ships was
// not.
//
// This module owns the two decisions that were untestable there, so a test can
// bind to the shipped function rather than a mirror:
//
//   1. RefreshQueue — what to do with a background message that arrives before
//      the content script has finished initialising.
//   2. shouldReScan — whether the visibility/URL watchers may re-run
//      processResults, i.e. whether a mid-session SUSPEND actually holds.
//
// (2) exists because `observer.stop()` is not what makes suspend hold. The two
// real re-entry points are the `visibilitychange` handler and the 1.5s SPA URL
// watcher, and neither is the ResultObserver. A suspended tab re-hid the whole
// page — placeholders and all — on the very next tab focus.
// ============================================================

export type RefreshKind = "prefs" | "list";

/**
 * Tracks refresh requests that arrive before the content script is ready.
 *
 * A single slot is not enough. `prefs` overwrote `list`, so a PREFS_UPDATED
 * followed by a LIST_UPDATED during init's (seconds-wide) await ran only
 * `refreshPrefs` — and `refreshPrefs` never re-reads the block list, so the
 * newly blocked domain stayed visible. Two independent flags; bounded at two.
 */
export class RefreshQueue {
  private initComplete = false;
  private pendingPrefs = false;
  private pendingList = false;

  /** True once `finish()` has run — the live path no longer needs queueing. */
  get ready(): boolean {
    return this.initComplete;
  }

  /** Which refreshes are outstanding, for tests and diagnostics. */
  get pending(): readonly RefreshKind[] {
    const out: RefreshKind[] = [];
    if (pendingOrder(this.pendingList, this.pendingPrefs, "list")) out.push("list");
    if (pendingOrder(this.pendingList, this.pendingPrefs, "prefs")) out.push("prefs");
    return out;
  }

  /**
   * Record an incoming message.
   *
   * Returns the refresh to run NOW, or null when it must be deferred until
   * `finish()`. Deferral is required for the paused-at-load case: that tab
   * returns from `init()` before it has any state, and running a refresh
   * against half-built state is how a resume ends up matching nothing.
   */
  offer(kind: RefreshKind): RefreshKind | null {
    if (this.initComplete) return kind;
    if (kind === "prefs") this.pendingPrefs = true;
    else this.pendingList = true;
    return null;
  }

  /**
   * Mark initialisation complete and return everything that must now run.
   *
   * Order is fixed: list before prefs. A prefs change can flip
   * active/inactive, and that decision must be made against a current list.
   * Idempotent — a second call returns an empty array, so a duplicate
   * `finish()` cannot double-run a refresh.
   */
  finish(): RefreshKind[] {
    if (this.initComplete) return [];
    this.initComplete = true;
    const out: RefreshKind[] = [];
    if (this.pendingList) out.push("list");
    if (this.pendingPrefs) out.push("prefs");
    this.pendingList = false;
    this.pendingPrefs = false;
    return out;
  }
}

// Small helper so `pending` reads in the same order as `finish`.
function pendingOrder(
  list: boolean,
  prefs: boolean,
  which: RefreshKind
): boolean {
  return which === "list" ? list : prefs;
}

/**
 * May a visibility / SPA-navigation watcher re-run `processResults`?
 *
 * `engineActive` is the single gate. A suspended tab still has a live `matcher`
 * holding the full block list, so any unguarded re-scan re-hides the page the
 * suspend just revealed — and restarts the observer and scroll manager that the
 * suspend tore down. That made pause a no-op in practice.
 */
export function shouldReScan(state: {
  engineActive: boolean;
  matcherReady: boolean;
  prefsReady: boolean;
  engineKnown: boolean;
}): boolean {
  return (
    state.engineActive &&
    state.matcherReady &&
    state.prefsReady &&
    state.engineKnown
  );
}

/**
 * The obligations a mid-session suspend must discharge.
 *
 * Enumerated so the teardown is auditable against a list — and, since
 * `runSuspendTeardown` below, ENFORCED. The previous revision exported a
 * `SUSPEND_HANDLERS` map of empty arrow functions with a comment claiming it
 * was "the load-bearing half" because a missing key would be a type error.
 * Nothing in `src/` ever imported it: deleting `observer?.stop()` from the
 * teardown, or the entire eight-step block, left the whole suite green. That
 * is this repo's documented A5-R1 failure mode (a test that mirrors a copy
 * survives a full revert of the production change) restated with extra
 * confidence in the comment.
 *
 * `runSuspendTeardown` is the real thing: it owns the ORDER and the COMPLETENESS
 * of the teardown, takes its side effects as injected dependencies, and returns
 * what it ran. `index.ts` supplies the real closures. A test can therefore pass
 * spies, assert every obligation fired, and go RED if any call is deleted.
 *
 * `guardReEntry` is deliberately NOT in this list: it is not a teardown call but
 * a standing condition — the `shouldReScan` guard consulted by the
 * `visibilitychange` handler and the 1.5s URL watcher, which suspend discharges
 * by setting `engineActive = false`. It is covered where it lives.
 */
export const SUSPEND_OBLIGATIONS = [
  "revealHiddenNodes",
  "clearHasRules",
  "revealGoogleCover",
  "disarmStaticCover",
  "stopObserver",
  "destroyScrollManager",
  "writeCache",
] as const;

export type SuspendObligation = (typeof SUSPEND_OBLIGATIONS)[number];

/**
 * The side effects a suspend performs, injected so this module stays pure and
 * testable — the same reason `shouldReScan` and `classifyPrefsTransition` take
 * their inputs rather than reading module state.
 */
export interface SuspendDeps {
  revealHiddenNodes(): void;
  clearHasRules(): void;
  revealGoogleCover(): void;
  disarmStaticCover(): void;
  stopObserver(): void;
  destroyScrollManager(): void;
  writeCache(): void;
}

/**
 * Discharge every suspend obligation, in order, and report what ran.
 *
 * ORDER IS LOAD-BEARING, not cosmetic:
 *   - `revealHiddenNodes` first, so nothing is left hidden while later steps run.
 *   - `disarmStaticCover` BEFORE `stopObserver` is irrelevant, but both must
 *     precede `writeCache`, which publishes `paused:true` — a later load's
 *     preload reads that and stands down.
 *   - `stopObserver` before `destroyScrollManager`, so no new nodes arrive from
 *     an appended page while the manager is being torn down.
 *
 * A dependency that throws does NOT abort the rest: the whole point of a
 * teardown is that a failure in one layer must not strand the page with another
 * layer still armed (that asymmetry is the blank-SERP failure). The thrown
 * dependency is named in the return value so the caller can log it.
 */
export function runSuspendTeardown(deps: SuspendDeps): {
  ran: SuspendObligation[];
  failed: SuspendObligation[];
} {
  const ran: SuspendObligation[] = [];
  const failed: SuspendObligation[] = [];
  for (const name of SUSPEND_OBLIGATIONS) {
    try {
      deps[name]();
      ran.push(name);
    } catch {
      failed.push(name);
    }
  }
  return { ran, failed };
}
