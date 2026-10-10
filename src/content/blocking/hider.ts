import type { MatchResult } from "./matcher";
import { GOOGLE_COVER_CANDIDATE_SELECTOR, revealCoverSubtree } from "../markers";

// ============================================================
// DOM hide/show/restore logic for search result nodes
// ============================================================

/**
 * The URL a node was hidden for. Exported because `reconcile.ts` reads it to
 * decide whether a node still belongs to its blocked domain — the producer and
 * the consumer of this attribute MUST agree, so there is one name for it.
 */
export const ATTR_SHH_URL = "data-shh-url";

/** "confirmed safe" — the ONLY marker preload.css's cover respects. */
const ATTR_SHH_OK = "data-shh-ok";
/** the preload's hide marker; also exempt from the cover. */
const ATTR_SHH_PRELOADED = "data-shh-preloaded";

/**
 * The Google anti-flicker cover only exists on Google hosts, so the show-once
 * exemption must not fire elsewhere.
 *
 * Reads the host from the NODE'S OWN document, not the ambient `location`.
 * That is both more correct (a node knows which document it belongs to) and
 * the only version that is testable: under vitest the ambient location is the
 * test runner's, so an ambient read made this silently return false in every
 * test and the fix would have shipped unverified.
 */
function isGoogleHost(node: Element): boolean {
  const view = node.ownerDocument?.defaultView;
  const h = view?.location?.hostname
    ?? (typeof location !== "undefined" ? location.hostname : "");
  return (
    h === "www.google.com" ||
    h.startsWith("www.google.") ||
    h.startsWith("google.co") ||
    h === "encrypted.google.com"
  );
}

const ATTR_SHH_RESULT = "data-shh-result";
const ATTR_SHH_MODE = "data-shh-mode";
const ATTR_SHH_PLACEHOLDER = "data-shh-placeholder";
const CLASS_HIDDEN = "shh-hidden";
const CLASS_PBAN = "shh-pban";
const CLASS_PLACEHOLDER = "shh-placeholder";
const CLASS_SHOWN_NOTICE = "shh-shown-notice";
// Applied to the result node itself when temporarily shown — creates the
// visual wrapper box so all result content appears contained together.
const CLASS_SHOWN_RESULT = "shh-shown-result";

export interface HideContext {
  node: Element;
  url: string;
  result: MatchResult;
}

/**
 * Hide a result node. For regular blocks, inserts an external placeholder.
 * For perma-bans, removes from view completely.
 */
export function hideResult(
  node: Element,
  result: MatchResult,
  url: string,
  showNotices: boolean,
  onShowOnce: (node: Element) => void,
  onUnblock: (domain: string) => void,
  onPermaban: (domain: string, node: Element) => void
): void {
  if (node.getAttribute(ATTR_SHH_RESULT)) return; // already processed

  node.setAttribute(ATTR_SHH_RESULT, result.mode);
  node.setAttribute(ATTR_SHH_URL, url);

  if (result.mode === "pban") {
    (node as HTMLElement).style.setProperty("display", "none", "important");
    node.classList.add(CLASS_PBAN);
    // data-shh-preloaded intentionally NOT removed here — the preload CSS rule
    // ([data-shh-preloaded="true"]{display:none!important}) keeps the element
    // hidden even if Google's JS resets the inline style before the next paint.
    // It is only removed in restoreResult() when the node must become visible.
    return;
  }

  (node as HTMLElement).style.setProperty("display", "none", "important");
  node.classList.add(CLASS_HIDDEN);
  // data-shh-preloaded intentionally NOT removed — see pban comment above.

  if (showNotices) {
    // Never stack boxes. A re-processing pass that reaches this node without
    // clearing the stamp first (races with the observer, or a container that
    // slipped past the guards) would otherwise leave a second placeholder
    // beside the one already sitting here — the "double box" half of the
    // 2026-08-30 Google report.
    const stale = node.previousElementSibling;
    if (stale?.getAttribute(ATTR_SHH_PLACEHOLDER)) stale.remove();

    const placeholder = buildPlaceholder(
      result.domain,
      () => onShowOnce(node),
      () => onUnblock(result.domain),
      () => onPermaban(result.domain, node)
    );
    node.parentElement?.insertBefore(placeholder, node);
  }
}

export function convertHiddenToPermaban(node: Element): void {
  const placeholder = findPlaceholder(node);
  if (placeholder) placeholder.remove();

  node.setAttribute(ATTR_SHH_RESULT, "pban");
  node.removeAttribute(ATTR_SHH_MODE);
  (node as HTMLElement).style.setProperty("display", "none", "important");
  node.classList.remove(CLASS_HIDDEN, CLASS_SHOWN_RESULT);
  node.classList.add(CLASS_PBAN);
}

/**
 * Show a result temporarily (show-once).
 * - Removes the external placeholder.
 * - Makes the result node visible and adds the shh-shown-result class so
 *   the entire result content is visually wrapped in a container box.
 * - Inserts a slim notice strip at the top with "Hide Again" and "Unblock".
 */
export function showOnce(
  node: Element,
  domain: string,
  onHideAgain: () => void,
  onUnblock: (domain: string) => void
): void {
  // Remove any leftover shown-notice bar first
  node.querySelector("." + CLASS_SHOWN_NOTICE)?.remove();

  // Use display:block!important (inline) rather than just removeProperty.
  // Inline style !important wins over any stylesheet !important regardless of
  // selector specificity — including the :has() rules we inject via
  // adoptedStyleSheets.  This lets the "Show" button work even when a
  // persistent :has() rule targets the result container.
  (node as HTMLElement).style.setProperty("display", "block", "important");
  // Release the preload attribute-based CSS rule too.
  node.removeAttribute("data-shh-preloaded");
  // ...and any INNER preload marks (A2 F2 companion): when the adapter
  // offered the wrapper (outer level) while the preload hid an inner node,
  // hideResult stamped the WRAPPER as the result — revealing it must also
  // lift the inner preload hides, or the shown result renders with holes.
  node.querySelectorAll("[data-shh-preloaded]").forEach((inner) => {
    (inner as HTMLElement).style.removeProperty("display");
    inner.removeAttribute("data-shh-preloaded");
    inner.classList.remove("shh-hidden");
  });
  node.classList.remove(CLASS_HIDDEN);
  node.classList.add(CLASS_SHOWN_RESULT);
  // Google-specific cover CSS sets opacity:0!important and pointer-events:none!important
  // on any div.g / div.tF2Cxc that lacks both data-shh-ok and data-shh-preloaded.
  // Removing data-shh-preloaded (above) causes this element to re-match that rule,
  // making it layout-visible (display:block) but paint-invisible (opacity:0).
  // Inline !important always beats stylesheet !important — override both properties
  // so the result is fully visible and interactive after the user clicks Show.
  (node as HTMLElement).style.setProperty("opacity", "1", "important");
  (node as HTMLElement).style.setProperty("pointer-events", "auto", "important");

  // *** THE INNER-COVER FIX (field capture 2026-09-29) ***
  //
  // The two overrides above apply to THIS node only, and they are not enough
  // when the adapter offered a WRAPPER and the preload hid something INSIDE
  // it — which is the normal case on the 2026 layout
  // (`#rso > div.MjjYud > div.A6K0A > div.tF2Cxc > div.N54PNb > div.kb0PBd`,
  // and the preload's own SELS matches BOTH div.tF2Cxc and div.g).
  //
  // Sweeping `data-shh-preloaded` off the descendants (above) is what arms the
  // trap: a descendant that had it is now neither `[data-shh-ok]` nor
  // `[data-shh-preloaded]`, so it MATCHES the cover and takes
  // `opacity:0 !important; pointer-events:none !important`. The parent's inline
  // `opacity:1` cannot rescue it — opacity does not cascade as an override, so
  // a child with its own opacity:0 stays invisible however the parent is set.
  //
  // The observed symptom was exactly this: the notice bar and the result's
  // outer box visible, the body's content an empty correctly-sized area
  // (opacity:0 preserves layout; display:none would have collapsed it).
  //
  // The only lever the cover exposes is `data-shh-ok`, so stamp it on every
  // descendant the cover could still match. Semantically correct too: the user
  // has just asked to see this result, which is precisely what the marker
  // means — `preload.ts` sets it on every node it has positively cleared.
  if (isGoogleHost(node)) {
    const exempt = [node, ...node.querySelectorAll(GOOGLE_COVER_CANDIDATE_SELECTOR)];
    for (const el of exempt) {
      // Only while the cover is not already lifted for it; do not resurrect a
      // marker the node legitimately carries for another reason.
      if (!el.hasAttribute(ATTR_SHH_PRELOADED)) el.setAttribute(ATTR_SHH_OK, "true");
    }
  }
  node.setAttribute(ATTR_SHH_MODE, "shown-once");

  // Insert the slim notice strip at the very top of the now-visible result.
  const bar = buildShownNoticeBar(domain, onHideAgain, onUnblock);
  node.insertBefore(bar, node.firstChild);
}

/**
 * Re-hide a result after the user clicked "Hide Again".
 * Reverses showOnce: removes the wrapper class, notice bar, and re-hides.
 */
export function rehideResult(
  node: Element,
  result: MatchResult,
  url: string,
  showNotices: boolean,
  onShowOnce: (node: Element) => void,
  onUnblock: (domain: string) => void,
  onPermaban: (domain: string, node: Element) => void
): void {
  node.querySelector("." + CLASS_SHOWN_NOTICE)?.remove();
  node.classList.remove(CLASS_SHOWN_RESULT);

  // Clear the opacity/pointer-events overrides set by showOnce() so the
  // re-hidden element does not carry stale inline styles.
  (node as HTMLElement).style.removeProperty("opacity");
  (node as HTMLElement).style.removeProperty("pointer-events");

  // Clear processed flag so hideResult will run again
  node.removeAttribute(ATTR_SHH_RESULT);
  node.removeAttribute(ATTR_SHH_MODE);
  node.classList.remove(CLASS_HIDDEN);

  hideResult(node, result, url, showNotices, onShowOnce, onUnblock, onPermaban);
}

/**
 * Every preload-hidden DESCENDANT of `node` (not `node` itself).
 *
 * Callers must re-test each of these before revealing one — see
 * `revealPreloadHiding` for why.
 */
export function preloadHiddenDescendants(node: Element): HTMLElement[] {
  return Array.from(
    node.querySelectorAll<HTMLElement>("[data-shh-preloaded]")
  );
}

/**
 * Lift preload-applied hiding on `node` AND everything inside it.
 *
 * Narrower than restoreResult() on purpose:
 *   - does NOT touch placeholders. A placeholder is the PREVIOUS SIBLING of the
 *     result it belongs to, so clearing one from here could strip the control
 *     off a *different*, still-blocked neighbouring result.
 *   - does NOT clear data-shh-result. Callers reach this only when no
 *     descendant is stamped (processResults rejects those via the container
 *     guard first), so there is nothing legitimate to clear.
 *
 * UNCONDITIONAL on the subtree — the caller is responsible for deciding that
 * every descendant really is safe to reveal. `processResults` uses
 * `revealPreloadHiding` (which re-tests each one); `restoreResult` uses this
 * directly, because it is only ever called for a node the user has explicitly
 * unblocked.
 */
export function clearPreloadHiding(node: Element): void {
  const targets: Element[] = [
    node,
    ...Array.from(node.querySelectorAll("[data-shh-preloaded]")),
  ];
  for (const el of targets) {
    (el as HTMLElement).style.removeProperty("display");
    el.removeAttribute("data-shh-preloaded");
    el.classList.remove(CLASS_HIDDEN);
  }
}

/** True when `node` or anything inside it carries a preload hide. */
export function hasPreloadHiding(node: Element): boolean {
  return (
    node.hasAttribute("data-shh-preloaded") ||
    node.querySelector("[data-shh-preloaded]") !== null
  );
}

/**
 * Lift preload hiding on `node` and on every descendant that is NOT still
 * blocked. This is the reveal path used by `processResults`, and the predicate
 * is not optional decoration — it is the guard.
 *
 * WHY A PREDICATE IS REQUIRED
 * ---------------------------
 * SELF is always safe: the caller reaches the reveal branch only because this
 * node's own destination does not match, and the adapter is authoritative for
 * the node it offered.
 *
 * DESCENDANTS are not. Two independent reasons:
 *   1. The check must cover them at all. The preload and the adapter routinely
 *      pick different DOM levels for the same result — the preload stamps the
 *      inner `div.g`, the adapter offers the wrapping `tF2Cxc`/`MjjYud` — so a
 *      self-only test missed exactly that case and left the inner node at
 *      `display:none` with the block button trapped inside it (audit D3).
 *   2. ...but an unmatched WRAPPER can still contain a blocked result. The
 *      preload and the adapters resolve a destination with DIFFERENT selectors
 *      and different fallback scopes, so they can disagree about the same
 *      subtree. `data-shh-preloaded` is deliberately absent from
 *      `SELECTOR_PROCESSED` (see dedupe.ts:36-51), so `containsProcessed` does
 *      NOT protect this case.
 *
 * Clearing a descendant blindly trades "blocked result hidden with a trapped
 * button" for "blocked result VISIBLE" — the exact symptom this change set
 * exists to remove. Hence one re-test per descendant.
 */
export function revealPreloadHiding(
  node: Element,
  isStillBlocked: (el: Element) => boolean
): void {
  if (node.hasAttribute("data-shh-preloaded")) clearPreloadHiding(node);
  for (const inner of preloadHiddenDescendants(node)) {
    if (isStillBlocked(inner)) continue;
    clearPreloadHiding(inner);
  }
}

/**
 * Fully restore a result (after unblocking). Removes placeholder and all markers.
 */
export function restoreResult(node: Element): void {
  const placeholder = findPlaceholder(node);
  if (placeholder) placeholder.remove();

  node.querySelector("." + CLASS_SHOWN_NOTICE)?.remove();
  // Clear any opacity/pointer-events overrides set by showOnce().
  (node as HTMLElement).style.removeProperty("opacity");
  (node as HTMLElement).style.removeProperty("pointer-events");
  node.removeAttribute(ATTR_SHH_RESULT);
  node.removeAttribute(ATTR_SHH_MODE);
  node.removeAttribute(ATTR_SHH_URL);
  // Inline display + the preload marker on self and every inner node, so the
  // preload CSS rule ([data-shh-preloaded="true"]{display:none!important})
  // stops applying. The subtree walk matters for the same reason as
  // clearPreloadHiding() — see its comment (A2 F2a, audit D3).
  clearPreloadHiding(node);

  // *** AND LIFT THE COVER — the step that was missing here ***
  //
  // clearPreloadHiding() above REMOVES `data-shh-preloaded`, and the cover's
  // selector excludes exactly that attribute:
  //   html[data-shh-active] div.g:not([data-shh-ok]):not([data-shh-preloaded])
  // So removing it does not merely un-hide the node — it RE-ARMS the cover on
  // any node the cover can match. A result the user just unblocked then renders
  // as a full-height blank gap: the same reported symptom, reached by a
  // different, entirely deterministic, user-initiated path.
  //
  // `showOnce` had to add this same stamp for this same reason (see its
  // "INNER-COVER FIX" note); restoreResult performs the identical removal with
  // none of the mitigation. `opacity` does not cascade as an override, so the
  // stamp has to reach the whole subtree, not just this node.
  if (isGoogleHost(node)) revealCoverSubtree(node);

  node.classList.remove(CLASS_PBAN, CLASS_SHOWN_RESULT);
}

/**
 * Find all hidden/processed result nodes on the page.
 */
export function getHiddenNodes(): NodeListOf<Element> {
  return document.querySelectorAll(`[${ATTR_SHH_RESULT}]`);
}

/**
 * Restore all results for a given domain (after unblocking).
 * Returns the list of nodes that were actually restored so callers can
 * inject block buttons on them without re-running the full matcher
 * (which would immediately re-hide them if a parent/wildcard domain
 * still exists in the block list).
 */
export function restoreByDomain(domain: string): Element[] {
  const restored: Element[] = [];
  for (const node of getHiddenNodes()) {
    const url = node.getAttribute(ATTR_SHH_URL) ?? "";
    try {
      const host = new URL(url).hostname;
      if (host === domain || host.endsWith("." + domain)) {
        restoreResult(node);
        restored.push(node);
      }
    } catch {
      // skip
    }
  }
  return restored;
}

// ============================================================
// External placeholder — intentionally unobtrusive.
// Just a single muted line with the domain name and two text-link
// buttons; no coloured backgrounds, no prominent icons.
// ============================================================

function buildPlaceholder(
  domain: string,
  onShowOnce: () => void,
  onUnblock: () => void,
  onPermaban: () => void
): HTMLElement {
  const div = document.createElement("div");
  div.className = CLASS_PLACEHOLDER;
  div.setAttribute(ATTR_SHH_PLACEHOLDER, "true");

  const domainSpan = document.createElement("span");
  domainSpan.className = "shh-placeholder-domain";
  domainSpan.textContent = domain;

  const sep = document.createElement("span");
  sep.className = "shh-placeholder-sep";
  sep.textContent = "·";

  const label = document.createElement("span");
  label.className = "shh-placeholder-label";
  label.textContent = "hidden";

  const showBtn = document.createElement("button");
  showBtn.type = "button";
  showBtn.className = "shh-btn shh-btn-show";
  showBtn.textContent = "Show";
  showBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    div.remove();
    onShowOnce();
  });

  const unblockBtn = document.createElement("button");
  unblockBtn.type = "button";
  unblockBtn.className = "shh-btn shh-btn-unblock";
  unblockBtn.textContent = "Unblock";
  unblockBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    div.remove();
    onUnblock();
  });

  const permaBtn = document.createElement("button");
  permaBtn.type = "button";
  permaBtn.className = "shh-btn shh-btn-perma";
  permaBtn.textContent = "Perma";
  permaBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    div.remove();
    onPermaban();
  });

  div.append(domainSpan, sep, label, showBtn, unblockBtn, permaBtn);
  return div;
}

// ============================================================
// Inline notice strip (top of shown result, inside the wrapper box).
// Quiet header strip — small text, subtle separator line below it.
// ============================================================

function buildShownNoticeBar(
  domain: string,
  onHideAgain: () => void,
  onUnblock: (domain: string) => void
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = CLASS_SHOWN_NOTICE;
  bar.setAttribute("data-shh-shown-notice", "true");

  const text = document.createElement("span");
  text.className = "shh-shown-domain";
  text.textContent = domain;

  const sep = document.createElement("span");
  sep.className = "shh-shown-sep";
  sep.textContent = "·";

  const label = document.createElement("span");
  label.className = "shh-shown-label";
  label.textContent = "showing once";

  const hideBtn = document.createElement("button");
  hideBtn.type = "button";
  hideBtn.className = "shh-btn shh-btn-rehide";
  hideBtn.textContent = "Hide Again";
  hideBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    onHideAgain();
  });

  const unblockBtn = document.createElement("button");
  unblockBtn.type = "button";
  unblockBtn.className = "shh-btn shh-btn-unblock";
  unblockBtn.textContent = "Unblock";
  unblockBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    bar.remove();
    onUnblock(domain);
  });

  bar.append(text, sep, label, hideBtn, unblockBtn);
  return bar;
}

function findPlaceholder(node: Element): Element | null {
  return node.previousElementSibling?.getAttribute(ATTR_SHH_PLACEHOLDER)
    ? node.previousElementSibling
    : null;
}
