// ============================================================
// Block-list reconciliation
//
// WHY THIS FILE EXISTS
// --------------------
// When the block list changes under an open tab (the popup, a second tab, an
// import, an undo), the content script reconciles the page against the new
// list in `refreshEntries`.
//
// That reconciliation used to walk `getHiddenNodes()` — i.e.
// `[data-shh-result]` — and nothing else. A result that is currently VISIBLE
// carries no such stamp, so it was never reconsidered. Concretely:
//
//   1. A Google tab is open showing results for "widget".
//   2. The user blocks `spam.com` from the popup (or from a second tab).
//      `LIST_UPDATED` reaches the tab and refreshEntries() runs.
//   3. The reconciliation walks the stamped nodes. spam.com was never hidden
//      here, so it is not in that set.
//   4. `processResults` is then called with ONLY the cleared nodes — so the
//      already-visible spam.com result is never matched, never hidden.
//
// The result: the user blocked a domain and the tab they were looking at kept
// showing it until a reload. That is the reported "sometimes the blocked URL
// shows, sometimes it doesn't" — it depends only on whether the page was
// loaded before or after the domain was added, with no timing flakiness at all.
//
// The fix is to reconcile BOTH sets: nodes we previously stamped (which may
// need restoring or re-stamping) and nodes that are currently visible (which
// may need hiding for the first time).
//
// WHY A SEPARATE FILE
// -------------------
// `index.ts` is a side-effecting module — importing it runs `init()`. The
// reconciliation therefore cannot be unit-tested from there. This mirrors what
// the repo already did for `dedupe.isInsideProcessedTerritory`, which was
// extracted specifically so a test could bind to the SHIPPED guard instead of
// a mirror copy (review finding A5-R1, 2026-09-06).
// ============================================================

import { ATTR_SHH_URL } from "./hider";

export interface ReconcileBuckets {
  /** No longer blocked — lift every hide layer and show the result. */
  toRestore: Element[];
  /**
   * Still blocked, or newly blocked — hand these to `processResults` so it
   * re-stamps (and rebuilds the placeholder for) each one.
   */
  toRestamp: Element[];
}

/**
 * Decide what to do with each known node when the block list has changed.
 *
 * @param stampedNodes  Nodes carrying `data-shh-result`. Their URL is read
 *                      from the attribute — the URL they were actually hidden
 *                      for. Deliberately NOT re-derived from the engine: if
 *                      extraction has since failed we must not spuriously
 *                      reveal a result the user still wants hidden.
 * @param visibleNodes  Currently-visible result nodes with no stamp. These are
 *                      the ones the old walk missed entirely.
 * @param isBlocked     Predicate over a resolved URL.
 * @param visibleUrlOf  Resolves a visible node's destination, or null when it
 *                      has none (in which case the node is left alone).
 */
export function reconcileAgainstBlockList(
  stampedNodes: Iterable<Element>,
  visibleNodes: Iterable<Element>,
  isBlocked: (url: string) => boolean,
  visibleUrlOf: (node: Element) => string | null
): ReconcileBuckets {
  const toRestore: Element[] = [];
  const toRestamp: Element[] = [];
  // A node can arrive in both sets (e.g. the caller passes a full snapshot).
  // A stamped node must never be treated as merely-visible: it carries hide
  // state that has to be cleared deliberately, not left to processResults.
  const seen = new Set<Element>();

  for (const node of stampedNodes) {
    if (seen.has(node)) continue;
    seen.add(node);
    const url = node.getAttribute(ATTR_SHH_URL) ?? "";
    if (url && isBlocked(url)) toRestamp.push(node);
    else toRestore.push(node);
  }

  for (const node of visibleNodes) {
    if (seen.has(node)) continue;
    seen.add(node);
    const url = visibleUrlOf(node);
    // No resolvable destination: processResults would skip it anyway
    // (index.ts `if (!url) continue`). Leave it untouched.
    if (!url) continue;
    if (isBlocked(url)) toRestamp.push(node);
    // Not blocked and not stamped — already correct. Nothing to do.
  }

  return { toRestore, toRestamp };
}
