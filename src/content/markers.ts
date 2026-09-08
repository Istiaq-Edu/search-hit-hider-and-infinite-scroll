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
