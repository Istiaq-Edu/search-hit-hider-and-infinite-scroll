/**
 * Shared marker-attribute helpers used by BOTH the preload observer
 * (document_start, isolated world) and the content script.
 *
 * Extracted 2026-09-07 from preload.ts Case D after the 1.8.10 crash field
 * report: the observer watches data-shh-ok / data-shh-preloaded to self-heal
 * Google's attribute strips — but reacting to our OWN setAttribute echoes
 * (remove ok → tryHide → re-stamp ok → new record → …) is an unbounded
 * microtask loop that starves the event loop and crashes the tab. The
 * predicate below is the discriminator; it lives in its own module so tests
 * bind to SHIPPED code instead of a mirror (A5-R1 lesson).
 */

/**
 * True when an attribute-mutation record for `el` is our OWN SET echoing
 * back — i.e. the watched marker attribute is still PRESENT on the element.
 *
 * The actionable case is the opposite: Google's DOM reconciliation STRIPS
 * our markers, which leaves the attribute ABSENT. Only absent-marker
 * records should trigger the self-heal walk-up; present-marker records are
 * self-echoes and must be ignored.
 *
 * data-shh-preloaded happened to be loop-safe without this predicate (its
 * writes are idempotent — tryHide early-returns on an already-stamped
 * node); data-shh-ok is NOT (Case D removes it before re-evaluating, so
 * every re-stamp armed the next removal).
 */
export function isOwnEchoRecord(
  attributeName: string | null,
  el: Element
): boolean {
  if (!attributeName) return false;
  if (
    attributeName !== "data-shh-ok" &&
    attributeName !== "data-shh-preloaded"
  ) {
    return false;
  }
  return el.hasAttribute(attributeName);
}

// ============================================================
// The Google anti-flicker cover
// ============================================================
// preload.css carries the rule that makes an un-evaluated Google result
// invisible, and preload.ts re-queries the same set to stamp `data-shh-ok` on
// the ones it has cleared. Those two MUST agree exactly, or a node can be
// excluded from the reveal while still matching the cover — which is the
// blank-result bug this selector's single definition prevents.
//
// A third consumer appeared in 2026-09: `showOnce` has to exempt a revealed
// result's INNER div.g, because it can no longer rely on the inline
// `opacity:1` it sets on the outer node. `opacity` does not cascade as an
// override — a descendant with its own `opacity:0 !important` stays invisible
// no matter what the parent says. The only way to lift the cover on a
// descendant is the marker the cover already respects: `data-shh-ok`.
//
// Lives here because preload.ts and blocking/hider.ts are bundled as SEPARATE
// entry points but share this isolated world, and a third copy of this string
// is how the two drifted into disagreeing in the first place.
export const GOOGLE_COVER_SELECTOR = [
  // Classic div.g (pre-2025) and div.tF2Cxc (2025 per-result card).
  // The `:not(.g .g)` / `:not(.tF2Cxc .tF2Cxc)` guards target only the OUTERMOST
  // node of each class, so a nested result is never covered twice.
  "div.g:not(.g .g):not([data-shh-ok]):not([data-shh-preloaded])",
  "div.tF2Cxc:not(.tF2Cxc .tF2Cxc):not([data-shh-ok]):not([data-shh-preloaded])",
].join(",");

/** The same cover, WITHOUT the safety markers — i.e. "what could be covered". */
export const GOOGLE_COVER_CANDIDATE_SELECTOR = [
  "div.g:not(.g .g)",
  "div.tF2Cxc:not(.tF2Cxc .tF2Cxc)",
].join(",");

// ============================================================
// The "we decided not to hide this, so it must not stay covered" step
// ============================================================
/**
 * Lift the cover on `el` — stamp the marker the cover respects — when `el` is a
 * node the cover could be holding at `opacity:0 !important`.
 *
 * WHY THIS EXISTS (field report 2026-10-10: "results are not visible on the
 * screen but there is space for that result")
 * ---------------------------------------------------------------------------
 * `opacity:0` preserves layout, so a node left under the cover occupies its
 * full height and paints nothing — the symptom is a blank gap, not a collapse.
 *
 * The cover matches EVERY `div.g` / `div.tF2Cxc` in the document, but only two
 * things ever lift it:
 *   • `tryHide()` — when it positively evaluates the node and decides it is not
 *     blocked (preload.ts), or
 *   • a reveal pass (`revealRemainingGoogle` / `__shhRevealGoogle`) — which runs
 *     at discrete moments only (2 s after DOMContentLoaded, after
 *     `processResults`, on bfcache restore, after an infinite-scroll append).
 *
 * `tryHide()` also has three deliberate FAIL-OPEN guards — container, section,
 * aggregate — which `return` WITHOUT hiding the node because hiding it would
 * take several unrelated results down with it. That was correct for hiding and
 * wrong for the cover: the node was left in the "undetermined" state, which the
 * cover renders as invisible.
 *
 * A node that arrives AFTER the last reveal pass therefore stayed at
 * `opacity:0` forever, and nothing in the extension could ever lift it — the
 * adapter refuses to offer it (`walkResults`' own section/aggregate guards),
 * the content script's `processResults` never sees it, and the preload's
 * observer had already declined to touch it. Reproduced against the shipped
 * bundle: a section-shaped card appended after the reveal windows reported
 * `visible: false`, `hiddenAt: self`, with no `data-shh-*` marker of any kind.
 *
 * This is the missing step: every node the cover can match ends up POSITIVELY
 * determined — `data-shh-preloaded` (hidden) or `data-shh-ok` (shown) — so no
 * node can be left in the state the cover renders as a blank gap.
 *
 * SAFETY: stamping `data-shh-ok` on a container is not a way to reveal a
 * blocked result. A blocked node is hidden by its OWN `display:none !important`
 * plus `data-shh-preloaded` (which the cover selector already excludes), so it
 * stays hidden however its ancestors are marked.
 *
 * @returns true when the marker was stamped by THIS call.
 */
export function revealCoverCandidate(el: Element): boolean {
  let isCandidate = false;
  try {
    isCandidate = el.matches(GOOGLE_COVER_CANDIDATE_SELECTOR);
  } catch {
    return false; // unreadable / foreign-namespace node — nothing to lift
  }
  if (!isCandidate) return false;
  return stampCoverOk(el);
}

/**
 * Stamp the marker the cover respects, unless the node is ALREADY determined in
 * either direction.
 *
 * Split out of `revealCoverCandidate` so a caller that obtained its nodes from
 * `querySelectorAll(GOOGLE_COVER_CANDIDATE_SELECTOR)` does not have to re-run
 * the same selector through `matches()` — the query is already the gate.
 */
function stampCoverOk(el: Element): boolean {
  if (
    el.hasAttribute("data-shh-ok") ||
    el.hasAttribute("data-shh-preloaded") ||
    el.hasAttribute("data-shh-result")
  ) {
    return false;
  }
  el.setAttribute("data-shh-ok", "true");
  return true;
}

/**
 * Lift the cover on `root` AND on every cover-matching descendant.
 *
 * WHY THE SUBTREE WALK IS REQUIRED (and why it is not the same as the guards'
 * single-node stamp):
 *   `opacity` does not cascade as an override. A node at `opacity:1` cannot
 *   rescue a child that carries its own `opacity:0 !important`, so stamping the
 *   outer node alone leaves an inner cover-matching card invisible. The preload
 *   and the adapter routinely pick different DOM levels for the same result
 *   (`showOnce` documents the same trap for the same reason).
 *
 * WHERE IT IS SAFE TO USE THIS, AND WHERE IT IS NOT:
 *   - SAFE: `restoreResult` (the user explicitly unblocked this result, so
 *     nothing under it may stay hidden) and the infinite-scroll append net
 *     (its page subtree has already been through `processResults`, so blocked
 *     cards inside it carry `data-shh-result` and are refused below).
 *   - NOT SAFE in `tryHide`'s CONTAINER guard. There the observer is walking
 *     `querySelectorAll(SELS)` in document order, so the container is evaluated
 *     BEFORE its own descendants — sweeping the subtree would stamp a blocked
 *     child safe before `tryHide` ever judged it, i.e. it would REVEAL a
 *     blocked result. That call site must keep the single-node form.
 *
 * @returns how many nodes this call stamped.
 */
export function revealCoverSubtree(root: Element): number {
  let stamped = revealCoverCandidate(root) ? 1 : 0;
  let candidates: Element[];
  try {
    candidates = Array.from(
      root.querySelectorAll(GOOGLE_COVER_CANDIDATE_SELECTOR)
    );
  } catch {
    return stamped; // unreadable subtree — the root stamp still stands
  }
  for (const el of candidates) {
    if (stampCoverOk(el)) stamped++;
  }
  return stamped;
}
