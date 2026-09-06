// ============================================================
// Result-identity guards
//
// WHY THIS FILE EXISTS
// --------------------
// The blocking pipeline can be handed several DOM nodes for what the user
// sees as ONE search result. Every node then gets its own block button and,
// when blocked, its own placeholder box — the "double block buttons / double
// boxes" report of 2026-08-30.
//
// The two shapes that produce duplicates:
//
//   • WRAPPER + RESULT. The MutationObserver reports raw ADDED nodes. Infinite
//     scroll appends a whole page as a single `<div data-inf-page="N">`, and
//     Google re-renders results by replacing a block with a new wrapper. Those
//     wrappers are containers, not results.
//
//   • CONTAINER-FROM-A-SUBTREE. Google resolves its results stream by ID
//     (#rso, #center_col …). An ID can never be found from INSIDE a subtree,
//     so asking the adapter for results within an added node returns nothing
//     and the caller falls back to "the added node is itself one result" —
//     which is exactly how a wrapper became a result.
//
// The guards here are deliberately cheap and engine-agnostic: they only ever
// REJECT a node that is demonstrably a container or demonstrably already
// handled, so a false positive costs one button on one node instead of
// inventing duplicate UI.
// ============================================================

/** Elements that carry a result title. */
export const RESULT_HEADING_SELECTOR = 'h3, h2, [role="heading"]';

/**
 * Marks a node we have already dealt with.
 *
 *  • data-shh-result      — hidden (hider.ts)
 *  • data-shh-btn         — carries a block button (ui/block-button.ts)
 *  • data-shh-placeholder — one of our own placeholder boxes (hider.ts)
 *  • data-shh-preloaded   — pre-hidden by the document_start preload
 */
export const SELECTOR_PROCESSED =
  '[data-shh-result], [data-shh-btn], [data-shh-placeholder], [data-shh-preloaded]';

/** Markers that mean "this node already has content-script UI on it". */
const SELECTOR_STAMPED =
  '[data-shh-result], [data-shh-btn], [data-shh-placeholder]';

/** True when `el` wraps results we have already processed — it is a container. */
export function containsProcessed(el: Element): boolean {
  try {
    return el.querySelector(SELECTOR_PROCESSED) !== null;
  } catch {
    return false;
  }
}

/**
 * True when `el` overlaps something already processed in EITHER direction: it
 * wraps a processed result, or it sits inside one.
 *
 * Used on the observer's fallback path, where the node was NOT vouched for by
 * the engine adapter and we are guessing that it is one result.
 *
 * `data-shh-preloaded` deliberately does NOT match on SELF here: a node the
 * preload hid is hidden but has NO content-script UI yet — skipping it would
 * silently drop its placeholder box (or its reveal, when the preload acted on
 * a stale cache). It only counts as an ANCESTOR (a node inside a pre-hidden
 * result must not be processed separately) or as a DESCENDANT (via
 * containsProcessed — a wrapper around a pre-hidden result is a container).
 */
export function overlapsProcessed(el: Element): boolean {
  try {
    if (el.closest(SELECTOR_STAMPED)) return true; // self or an ancestor, UI exists
    const preloadedAncestor = el.closest("[data-shh-preloaded]");
    if (preloadedAncestor && preloadedAncestor !== el) return true; // inside one
  } catch { /* selector unsupported — fall through */ }
  return containsProcessed(el);
}

/**
 * True when `el` carries several result titles — it is a LIST of results, not
 * one of them.
 *
 * The threshold matches SECTION_HEADING_THRESHOLD in engines/google-dom.ts,
 * which has been doing the same job for the structural walk since v1.8.4.
 */
export function looksLikeResultList(el: Element): boolean {
  try {
    return el.querySelectorAll(RESULT_HEADING_SELECTOR).length >= 2;
  } catch {
    return false;
  }
}
