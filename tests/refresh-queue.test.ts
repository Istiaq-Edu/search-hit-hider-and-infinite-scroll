import { describe, it, expect } from "vitest";
import {
  RefreshQueue,
  shouldReScan,
  runSuspendTeardown,
  SUSPEND_OBLIGATIONS,
  type RefreshKind,
  type SuspendDeps,
  type SuspendObligation,
} from "../src/content/refresh-queue";

// ============================================================
// Refresh queueing and re-scan gating
//
// WHY THIS FILE EXISTS
// --------------------
// A mutation review of the show/hide fixes found that `src/content/index.ts` had
// ZERO test binding. Eight separate reverts — the module-scope `onMessage`
// listener, the D1 reconcile call site, the D5 `canPublishCache` guard, the
// suspend teardown, the `wasActive` read — all left the suite green. The pure
// helpers were pinned; the wiring that actually ships was not.
//
// So the two untestable decisions were moved into `refresh-queue.ts` and are
// pinned here. This is the same extraction discipline used for
// `dedupe.isInsideProcessedTerritory` (A5-R1) and `blocking/reconcile.ts`.
//
// Binds to the SHIPPED functions — a mirror copy survives a full revert.
// ============================================================

describe("RefreshQueue — messages that arrive before init() finishes", () => {
  it("defers everything until finish()", () => {
    const q = new RefreshQueue();
    expect(q.ready).toBe(false);
    expect(q.offer("prefs")).toBeNull();
    expect(q.offer("list")).toBeNull();
    expect(q.ready).toBe(false);
  });

  it("runs a message immediately once ready", () => {
    const q = new RefreshQueue();
    q.finish();
    expect(q.ready).toBe(true);
    expect(q.offer("prefs")).toBe("prefs");
    expect(q.offer("list")).toBe("list");
  });

  // The defect this pins: a single `pendingRefresh` slot where "prefs"
  // overwrote "list". init()'s await is up to ~8s wide, so both kinds can
  // arrive inside it — and refreshPrefs never re-reads the block list, so the
  // dropped LIST_UPDATED left a newly blocked domain visible.
  it("keeps BOTH kinds when they share the init window", () => {
    const q = new RefreshQueue();
    q.offer("prefs");
    q.offer("list");
    expect(q.finish().sort()).toEqual(["list", "prefs"]);
  });

  it("keeps both regardless of arrival order", () => {
    for (const order of [["list", "prefs"], ["prefs", "list"]] as const) {
      const q = new RefreshQueue();
      for (const kind of order) q.offer(kind as RefreshKind);
      expect(q.finish().sort()).toEqual(["list", "prefs"]);
    }
  });

  it("drains list BEFORE prefs", () => {
    // Fixed order, and it is not arbitrary: a prefs change can flip
    // active/inactive, and that decision must be made against a current list.
    const q = new RefreshQueue();
    q.offer("prefs");
    q.offer("list");
    expect(q.finish()).toEqual(["list", "prefs"]);
  });

  it("drains a single kind once", () => {
    const q = new RefreshQueue();
    q.offer("list");
    expect(q.finish()).toEqual(["list"]);
  });

  it("drains nothing when idle", () => {
    expect(new RefreshQueue().finish()).toEqual([]);
  });

  it("is idempotent — a second finish() cannot double-run a refresh", () => {
    const q = new RefreshQueue();
    q.offer("list");
    expect(q.finish()).toEqual(["list"]);
    expect(q.finish()).toEqual([]);
  });

  it("clears pending state so a later offer is not drained twice", () => {
    const q = new RefreshQueue();
    q.offer("prefs");
    q.finish();
    expect(q.pending).toEqual([]);
  });

  it("does not lose an offer that arrives after finish()", () => {
    const q = new RefreshQueue();
    q.finish();
    expect(q.offer("prefs")).toBe("prefs");
    expect(q.finish()).toEqual([]); // already delivered, not re-queued
  });

  // The paused-at-load case: init() RETURNS EARLY, so finish() runs with state
  // that is barely built. The queue must still drain, because that is the only
  // way an unpause reaches the tab.
  it("drains a message that arrived while init() was still running", () => {
    const q = new RefreshQueue();
    q.offer("prefs");
    expect(q.finish()).toEqual(["prefs"]);
  });
});

describe("shouldReScan — a mid-session suspend must hold", () => {
  const live = {
    engineActive: true,
    matcherReady: true,
    prefsReady: true,
    engineKnown: true,
  };

  it("allows a re-scan when everything is ready and active", () => {
    expect(shouldReScan(live)).toBe(true);
  });

  // The defect this pins. `observer.stop()` is NOT what makes suspend hold —
  // the two real re-entry points are the visibilitychange handler and the 1.5s
  // SPA URL watcher, and neither is the ResultObserver. A suspended tab still
  // has a live `matcher` holding the whole block list, so the next tab focus
  // re-hid the page AND restarted the observer and scroll manager.
  it("REFUSES a re-scan while suspended", () => {
    expect(shouldReScan({ ...live, engineActive: false })).toBe(false);
  });

  it("refuses when the matcher, prefs or engine are not ready", () => {
    expect(shouldReScan({ ...live, matcherReady: false })).toBe(false);
    expect(shouldReScan({ ...live, prefsReady: false })).toBe(false);
    expect(shouldReScan({ ...live, engineKnown: false })).toBe(false);
  });

  it("is false for every not-ready combination — never accidentally true", () => {
    for (const active of [true, false]) {
      for (const matcherReady of [true, false]) {
        for (const prefsReady of [true, false]) {
          for (const engineKnown of [true, false]) {
            const expected = active && matcherReady && prefsReady && engineKnown;
            expect(
              shouldReScan({ engineActive: active, matcherReady, prefsReady, engineKnown })
            ).toBe(expected);
          }
        }
      }
    }
  });
});

// The teardown itself. This is the A5-R1 replacement.
//
// The previous revision exported `SUSPEND_HANDLERS` — a map of eight empty
// arrow functions — with a comment calling it "the load-bearing half", and
// asserted in two test files that the map's keys matched a list. Nothing in
// `src/` imported it. Deleting `observer?.stop()` from index.ts left the suite
// green; so did deleting the entire teardown. The test below cannot pass that
// way: it drives the SHIPPED `runSuspendTeardown` with spies and asserts every
// obligation actually fired, in order.
describe("runSuspendTeardown", () => {
  function spies(): { deps: SuspendDeps; calls: SuspendObligation[] } {
    const calls: SuspendObligation[] = [];
    const deps = Object.fromEntries(
      SUSPEND_OBLIGATIONS.map((k) => [k, () => { calls.push(k); }])
    ) as unknown as SuspendDeps;
    return { deps, calls };
  }

  it("discharges EVERY obligation", () => {
    const { deps, calls } = spies();
    const { ran, failed } = runSuspendTeardown(deps);
    expect(failed).toEqual([]);
    expect(ran).toEqual([...SUSPEND_OBLIGATIONS]);
    // And every one actually ran — not merely that the names came back.
    for (const o of SUSPEND_OBLIGATIONS) {
      expect(calls).toContain(o);
    }
  });

  it("stops the observer BEFORE destroying the scroll manager", () => {
    // If the manager is torn down first, an appended page can land while the
    // observer is still live and be re-hidden by the manager's own
    // onNewNodes → processResults path.
    const { deps, calls } = spies();
    runSuspendTeardown(deps);
    expect(calls.indexOf("stopObserver")).toBeLessThan(
      calls.indexOf("destroyScrollManager")
    );
  });

  it("reveals what is already hidden BEFORE anything else", () => {
    const { deps, calls } = spies();
    runSuspendTeardown(deps);
    expect(calls[0]).toBe("revealHiddenNodes");
  });

  it("publishes the paused cache LAST", () => {
    // writeCache publishes `paused:true`; a later load's preload reads it and
    // stands down. Doing it early would leave a window where the cache says
    // active while the page is being torn down.
    const { deps, calls } = spies();
    runSuspendTeardown(deps);
    expect(calls[calls.length - 1]).toBe("writeCache");
  });

  it("does NOT abort the rest of the teardown when one layer throws", () => {
    // The whole point of a teardown: a failure in one layer must not strand the
    // page with another layer still armed. That asymmetry IS the blank-SERP
    // failure (cover attached, reveal hook missing).
    const calls: SuspendObligation[] = [];
    const deps = Object.fromEntries(
      SUSPEND_OBLIGATIONS.map((k) => [
        k,
        () => {
          calls.push(k);
          if (k === "clearHasRules") throw new Error("preload hook missing");
        },
      ])
    ) as unknown as SuspendDeps;

    const { ran, failed } = runSuspendTeardown(deps);
    expect(failed).toEqual(["clearHasRules"]);
    expect(ran).not.toContain("clearHasRules");
    // Everything else still ran — critically the cover disarm and the cache write.
    expect(calls).toContain("disarmStaticCover");
    expect(calls).toContain("writeCache");
    expect(calls).toContain("stopObserver");
  });

  it("has no duplicates in the obligation list", () => {
    expect(new Set(SUSPEND_OBLIGATIONS).size).toBe(SUSPEND_OBLIGATIONS.length);
  });
});
