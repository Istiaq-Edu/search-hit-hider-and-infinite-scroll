// ============================================================
// Broadcast recipient selection
//
// WHY THIS FILE EXISTS
// --------------------
// The service worker tracks which tabs hold a content script in `activeTabIds`
// so a broadcast does not have to message every tab in the window. The set is
// populated when a tab SENDS us a message, and it was pruned whenever a send
// FAILED.
//
// That pruning is the defect. A content script's `runtime.onMessage` listener
// is now registered at MODULE SCOPE, before `init()` runs — so the "no
// receiver" window is no longer init()'s body. It is the gap between
// document_start (preload) and content-script injection at document_idle
// (pinned by tests/manifest.test.ts), which on a Google SERP is seconds.
// "This tab has no receiver yet" is therefore still the EXPECTED state early in
// every page load, not evidence of a dead tab.
//
// Interleaving that produced the field report:
//
//   t0  Tab A (Google) sends GET_LIST -> activeTabIds.add(A).
//       A has no onMessage listener yet (document_idle has not run).
//   t1  User blocks a domain in tab B. ADD_ENTRY -> broadcast LIST_UPDATED.
//       tabs.sendMessage(A) rejects ("Receiving end does not exist").
//       activeTabIds.delete(A)            <-- permanent
//   t2  User blocks a second domain. The set is non-empty, so the
//       tabs.query({}) rescue below never runs. A is never contacted again.
//
// A tab that missed one broadcast stayed deaf for the rest of its page life.
// The user blocked a domain and the tab they were looking at never heard —
// which is indistinguishable from the block not working.
//
// THE FIX, and why it is shaped this way
// -------------------------------------
// The `activeTabIds.delete()` on send failure is removed entirely, and a failed
// send triggers a ONE-TIME `tabs.query({})` sweep instead.
//
// Not a union-on-every-broadcast: the eviction was a deliberate 2026-05-16
// performance optimisation (see docs/plans/2026-05-16-comprehensive-
// optimization-plan.md), and paying a `tabs.query` on every mutation to fix a
// correctness bug would regress it. Re-querying only when a send actually
// failed keeps the O(active) happy path and makes the slow path self-healing.
//
// A stale id costs one failed send, which is exactly the signal that triggers
// the sweep — so the two mechanisms are complementary, not redundant.
// `tabs.onRemoved` still prunes on close; what nothing prunes is NAVIGATION, so
// a tab that left an engine page keeps its id and fails every send. Bounded and
// self-correcting, but it does mean the sweep can fire on more mutations than an
// earlier draft of this comment claimed. service-worker.ts pairs it with a
// consecutive-failure counter so an id is evicted only after K failures in a
// row — never on the first.
// ============================================================

export interface BroadcastDeps {
  /** Deliver to a tab. Reject (or return false) when there is no receiver. */
  send: (tabId: number) => Promise<boolean>;
  /** All tab ids currently open, or null if the tabs API is unavailable. */
  queryTabIds: () => Promise<number[] | null>;
}

export interface BroadcastOutcome {
  /** Tabs we successfully delivered to. */
  delivered: number[];
  /** Tabs that had no receiver this time. NOT evicted — see the file header. */
  failed: number[];
  /** Whether the recovery sweep ran. */
  swept: boolean;
}

/**
 * Should this tab id be evicted from the candidate set?
 *
 * Evicting on the FIRST failure is the defect this module exists to undo: a
 * content script has no receiver between document_start and injection, so a
 * single rejection is the expected state early in every page load. Requiring K
 * CONSECUTIVE failures keeps the correctness fix while still bounding the set —
 * `tabs.onRemoved` prunes on close, but nothing prunes on navigation, so a tab
 * that left an engine page would otherwise fail on every broadcast forever and
 * force a sweep each time.
 *
 * A success clears the counter, so a tab that recovers is trusted again
 * immediately — no cooldown, no flapping.
 */
export const MAX_CONSECUTIVE_SEND_FAILURES = 3;

export function shouldEvictTab(failures: number): boolean {
  return failures >= MAX_CONSECUTIVE_SEND_FAILURES;
}

/**
 * Deliver `message` to every candidate tab.
 *
 * @param candidates Tab ids believed to hold a content script. Treated as a
 *                   HINT, not ground truth — a stale or incomplete set is
 *                   corrected by the sweep below.
 * @param exceptTabId Tab that sent the originating message; it has already
 *                    applied the change optimistically.
 */
export async function broadcastToTabs(
  candidates: Iterable<number>,
  exceptTabId: number | undefined,
  deps: BroadcastDeps
): Promise<BroadcastOutcome> {
  // Union first. A candidate set can only ever be a hint: it is empty after a
  // worker restart, and it can miss a tab whose first message has not landed
  // yet. Stale ids are harmless — they cost one failed send, which is the
  // signal that triggers the sweep.
  const targets = new Set<number>();
  for (const id of candidates) {
    if (id !== exceptTabId) targets.add(id);
  }

  const delivered: number[] = [];
  const failed = new Set<number>();
  for (const tabId of targets) {
    if (await deps.send(tabId)) delivered.push(tabId);
    else failed.add(tabId);
  }

  // Sweep when the candidate set failed to tell us anything useful: either a
  // send had no receiver (our set may be stale — a tab mid-init() is the
  // expected case, not a dead one), or we had no candidates at all, which is
  // the state right after a service-worker restart.
  if (failed.size === 0 && targets.size > 0) {
    return { delivered, failed: [], swept: false };
  }

  const allTabs = await deps.queryTabIds();
  if (allTabs === null) {
    return { delivered, failed: Array.from(failed), swept: false };
  }

  const reached = new Set(delivered);
  for (const tabId of allTabs) {
    if (tabId === exceptTabId) continue;
    if (reached.has(tabId)) continue;   // already delivered — do not re-send
    if (failed.has(tabId)) continue;    // already failed — do not retry in a loop
    if (await deps.send(tabId)) {
      reached.add(tabId);
      delivered.push(tabId);
    } else {
      failed.add(tabId);
    }
  }

  return { delivered, failed: Array.from(failed), swept: true };
}
