import { describe, it, expect, vi } from "vitest";
import {
  broadcastToTabs,
  shouldEvictTab,
  MAX_CONSECUTIVE_SEND_FAILURES,
} from "../../src/background/broadcast";

// ============================================================
// Broadcast recipient selection — C1
//
// The service worker kept `activeTabIds` and pruned it whenever a send FAILED.
// A content script registers its `runtime.onMessage` listener as the LAST
// statement of init() — after a messaging round-trip, a 400ms Brave/Startpage
// sleep, cache writes and a full first-page processResults() scan. So "this tab
// has no receiver yet" is the EXPECTED state for the first second of every page
// load, not evidence of a dead tab.
//
//   t0  Tab A sends GET_LIST -> registered. A has no listener yet.
//   t1  User blocks a domain in tab B -> broadcast LIST_UPDATED.
//       sendMessage(A) rejects -> A was EVICTED, permanently.
//   t2  User blocks a second domain. The set is non-empty, so the
//       tabs.query({}) rescue never runs. A is never contacted again.
//
// The tab stayed deaf for the rest of its page life, so blocking from the popup
// or a second tab silently did nothing there.
//
// Binds to the SHIPPED selector (google-ancestor-guard.test.ts:24-28).
// ============================================================

function makeDeps(opts: {
  /** Tabs with a live receiver. */
  live: number[];
  /** Tab ids the tabs API reports. */
  allTabs: number[] | null;
}) {
  const sent: number[] = [];
  const send = vi.fn(async (tabId: number) => {
    sent.push(tabId);
    return opts.live.includes(tabId);
  });
  const queryTabIds = vi.fn(async () => opts.allTabs);
  return { deps: { send, queryTabIds }, sent, send, queryTabIds };
}

describe("broadcastToTabs — a tab mid-init() is not a dead tab", () => {
  it("does not give up on a tab that had no receiver yet", async () => {
    // Tab 1 is mid-init (no receiver). Tab 2 is live. The user blocks in tab 2.
    const { deps, sent } = makeDeps({ live: [2], allTabs: [1, 2] });

    const out = await broadcastToTabs([1, 2], 2, deps);

    // Tab 1 failed, so the sweep ran and re-tried everything not yet tried.
    expect(out.swept).toBe(true);
    expect(sent).toContain(1);
    expect(out.failed).toEqual([1]);
  });

  it("delivers to a tab the candidate set missed entirely", async () => {
    // The realistic shape: activeTabIds is empty after a worker restart, or a
    // tab's first message has not landed. The sweep must find it.
    const { deps, sent } = makeDeps({ live: [7], allTabs: [7] });

    const out = await broadcastToTabs([], undefined, deps);

    expect(out.swept).toBe(true);
    expect(sent).toEqual([7]);
    expect(out.delivered).toEqual([7]);
  });

  it("does NOT sweep when every send succeeded", async () => {
    // The happy path must keep its O(active) cost — the eviction this replaces
    // was a deliberate 2026-05-16 performance optimisation.
    const { deps, queryTabIds } = makeDeps({ live: [1, 2], allTabs: [1, 2, 3] });

    const out = await broadcastToTabs([1, 2], undefined, deps);

    expect(out.swept).toBe(false);
    expect(queryTabIds).not.toHaveBeenCalled();
    expect(out.delivered).toEqual([1, 2]);
  });

  it("never messages the tab that originated the change", async () => {
    // The sender already applied the change optimistically; a round-trip would
    // be wasted work at best and a re-entrancy hazard at worst.
    const { deps, sent } = makeDeps({ live: [1, 2], allTabs: [1, 2] });

    await broadcastToTabs([1, 2], 1, deps);

    expect(sent).not.toContain(1);
    expect(sent).toEqual([2]);
  });

  it("does not retry a tab the sweep already failed on", async () => {
    // A genuinely dead tab must not be retried in a loop.
    const { deps, send } = makeDeps({ live: [2], allTabs: [1, 2] });

    await broadcastToTabs([1, 2], undefined, deps);

    const attemptsToTab1 = send.mock.calls.filter((c) => c[0] === 1).length;
    expect(attemptsToTab1).toBe(1);
  });

  it("reports no sweep when the tabs API is unavailable", async () => {
    const { deps, sent } = makeDeps({ live: [2], allTabs: null });

    const out = await broadcastToTabs([1, 2], undefined, deps);

    expect(out.swept).toBe(false);
    expect(out.failed).toEqual([1]);
    expect(sent).toEqual([1, 2]);
  });

  it("treats a stale candidate id as harmless", async () => {
    // Nothing prunes activeTabIds on close any more, so it can hold ids of
    // tabs that are gone. That costs exactly one failed send — which is the
    // signal that triggers the sweep. Cheap and self-correcting.
    const { deps } = makeDeps({ live: [2], allTabs: [2] });

    const out = await broadcastToTabs([999, 2], undefined, deps);

    expect(out.swept).toBe(true);
    expect(out.delivered).toEqual([2]);
  });

  it("handles an empty candidate set with no tabs at all", async () => {
    // An empty candidate set is the state right after a service-worker
    // restart, so the sweep is mandatory and it does run — it just finds
    // nothing. `swept` reports that the query happened, not that it found work.
    const { deps } = makeDeps({ live: [], allTabs: [] });
    const out = await broadcastToTabs([], undefined, deps);
    expect(out).toEqual({ delivered: [], failed: [], swept: true });
  });

  it("sweeps when there are no candidates, even with nothing to report as failed", async () => {
    // The regression this pins: an early return on `failed.length === 0` alone
    // skipped the sweep whenever the candidate set was empty, which is exactly
    // the post-restart case where the sweep is the only way to find anyone.
    const { deps, queryTabIds } = makeDeps({ live: [3], allTabs: [3] });
    const out = await broadcastToTabs([], undefined, deps);
    expect(queryTabIds).toHaveBeenCalled();
    expect(out.delivered).toEqual([3]);
  });

  it("delivers to a tab that appears only in the sweep", async () => {
    const { deps, sent } = makeDeps({ live: [5], allTabs: [5] });
    const out = await broadcastToTabs([1], undefined, deps); // 1 dead, 5 unknown
    expect(sent).toEqual([1, 5]);
    expect(out.delivered).toEqual([5]);
  });
});

describe("shouldEvictTab — a tab mid-injection is not a dead tab", () => {
  // The eviction threshold. A content script has no receiver between
  // document_start and document_idle injection, so ONE rejection is the
  // expected state early in every page load. Evicting on it is the defect
  // broadcast.ts exists to undo.
  it("does NOT evict on the first failure", () => {
    expect(shouldEvictTab(1)).toBe(false);
  });

  it("does not evict on the second", () => {
    expect(shouldEvictTab(2)).toBe(false);
  });

  it("evicts on the third consecutive failure", () => {
    expect(shouldEvictTab(MAX_CONSECUTIVE_SEND_FAILURES)).toBe(true);
  });

  it("evicts on anything beyond the threshold", () => {
    expect(shouldEvictTab(MAX_CONSECUTIVE_SEND_FAILURES + 1)).toBe(true);
  });

  it("never evicts at zero", () => {
    expect(shouldEvictTab(0)).toBe(false);
  });
});
