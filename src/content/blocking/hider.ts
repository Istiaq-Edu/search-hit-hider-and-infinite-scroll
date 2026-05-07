import type { MatchResult } from "./matcher";

// ============================================================
// DOM hide/show/restore logic for search result nodes
// ============================================================

const ATTR_SHH_RESULT = "data-shh-result";
const ATTR_SHH_MODE = "data-shh-mode";
const ATTR_SHH_URL = "data-shh-url";
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
  onUnblock: (domain: string) => void
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
    const placeholder = buildPlaceholder(
      result.domain,
      () => onShowOnce(node),
      () => onUnblock(result.domain)
    );
    node.parentElement?.insertBefore(placeholder, node);
  }
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
  onUnblock: (domain: string) => void
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

  hideResult(node, result, url, showNotices, onShowOnce, onUnblock);
}

/**
 * Fully restore a result (after unblocking). Removes placeholder and all markers.
 */
export function restoreResult(node: Element): void {
  const placeholder = findPlaceholder(node);
  if (placeholder) placeholder.remove();

  node.querySelector("." + CLASS_SHOWN_NOTICE)?.remove();
  (node as HTMLElement).style.removeProperty("display");
  // Clear any opacity/pointer-events overrides set by showOnce().
  (node as HTMLElement).style.removeProperty("opacity");
  (node as HTMLElement).style.removeProperty("pointer-events");
  node.removeAttribute(ATTR_SHH_RESULT);
  node.removeAttribute(ATTR_SHH_MODE);
  node.removeAttribute(ATTR_SHH_URL);
  // Remove the preload marker so the preload CSS rule
  // ([data-shh-preloaded="true"]{display:none!important}) stops applying.
  node.removeAttribute("data-shh-preloaded");
  node.classList.remove(CLASS_HIDDEN, CLASS_PBAN, CLASS_SHOWN_RESULT);
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
  onUnblock: () => void
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

  div.append(domainSpan, sep, label, showBtn, unblockBtn);
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
