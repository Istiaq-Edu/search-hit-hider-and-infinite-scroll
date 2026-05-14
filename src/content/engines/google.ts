import type { EngineAdapter } from "./base";
import type { EngineId } from "../../shared/types";

// ============================================================
// Google adapter
// Button placement mirrors the "Google Hit Hider by Domain" userscript
// by Jefferson Scher (v2.3.4, March 2025):
//   • Prefer the h3/h2 title heading as the button target and APPEND inside it.
//   • This keeps the button out of the cite-row flex container that contains
//     Google's three-dot feedback button, eliminating overlap.
//   • A secondary flex-detection pass in content/index.ts further repositions
//     the button absolutely if its parent is still a flex container.
// ============================================================

export class GoogleAdapter implements EngineAdapter {
  readonly id: EngineId = "google";
  readonly name = "Google";

  private isImages = false;
  private isNews = false;

  matches(url: URL): boolean {
    const h = url.hostname;
    return (
      h === "www.google.com" ||
      h.startsWith("www.google.") ||
      h.startsWith("google.co") ||
      h === "news.google.com" ||
      h.startsWith("news.google.") ||
      h === "encrypted.google.com"
    );
  }

  onInit(doc: Document): void {
    const search = doc.location?.search ?? "";
    this.isImages = search.includes("tbm=isch") || search.includes("udm=2");
    this.isNews = search.includes("tbm=nws");
  }

  getResultNodes(doc: Document): Element[] {
    if (this.isImages) return this.getImageNodes(doc);
    if (this.isNews) return this.getNewsNodes(doc);
    return this.getWebNodes(doc);
  }

  // ── Web results ──────────────────────────────────────────────
  private getWebNodes(doc: Document): Element[] {
    // Try selectors in priority order — first one that produces valid results wins.
    // Using a priority list avoids double-matching when both div.g and div.tF2Cxc
    // exist in the DOM simultaneously (e.g. if Google nests one inside the other).
    //
    //   div.g             — classic selector, still used in many Google layouts
    //   div.tF2Cxc        — 2025 per-result card replacing div.g in updated SERP
    //   #rso > div > div  — structural fallback when neither class is present
    //   #rso > div        — broadest structural fallback
    const candidateSelectors = [
      "div.g:not(.g .g)",
      "div.tF2Cxc:not(.tF2Cxc .tF2Cxc)",
      "#rso > div > div",
      "#rso > div",
    ];

    for (const sel of candidateSelectors) {
      const nodes = Array.from(doc.querySelectorAll(sel)) as Element[];
      const filtered = nodes.filter((n) => this.isValidResult(n));
      if (filtered.length > 0) return filtered;
    }
    return [];
  }

  /**
   * A node is a valid organic result if:
   *  - it has at least one non-Google link (so we can determine the domain)
   *  - it has a heading/title element
   *  - it hasn't already been processed by us
   */
  private isValidResult(n: Element): boolean {
    if (n.getAttribute("data-shh-result")) return false;
    if (!n.querySelector("h3, h2, [role='heading']")) return false;

    // Must have at least one link pointing outside Google.
    // Accepts both:
    //   • Direct external hrefs (resolved a.href is non-Google)
    //   • Google /url?q= redirect wrappers that encode an external destination —
    //     these appear in the raw HTML before Google's hydration JS replaces them
    //     with direct hrefs.  Without this check, nodes whose links are still in
    //     redirect form are filtered out; the content script never processes them;
    //     the preload's data-shh-preloaded attribute is the only protection, and
    //     if Google's JS strips that attribute the result flashes visible.
    const links = Array.from(n.querySelectorAll("a[href]")) as HTMLAnchorElement[];
    return links.some((a) => {
      if (this.isExternalHref(a.href)) return true;
      // Unwrap /url?q= redirect and check the destination host.
      const raw = a.getAttribute("href") ?? "";
      if (raw.startsWith("/url?") || raw.includes("google.com/url")) {
        try {
          const qs = raw.slice(raw.indexOf("?") + 1);
          const q = new URLSearchParams(qs).get("q");
          if (q && q.startsWith("http")) {
            const u = new URL(q);
            return (
              !u.hostname.includes("google.") &&
              !u.hostname.includes("gstatic.") &&
              !u.hostname.includes("googleapis.")
            );
          }
        } catch { /* ignore malformed URLs */ }
      }
      return false;
    });
  }

  private isExternalHref(href: string): boolean {
    if (!href) return false;
    try {
      const u = new URL(href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      const h = u.hostname;
      return (
        !h.includes("google.") &&
        !h.includes("gstatic.") &&
        !h.includes("googleapis.")
      );
    } catch {
      return false;
    }
  }

  // ── Image results ─────────────────────────────────────────────
  private getImageNodes(doc: Document): Element[] {
    const selectors = ["div.isv-r", "div.rg_di", "g-img.mNsIhb"];
    for (const sel of selectors) {
      const nodes = Array.from(doc.querySelectorAll(sel));
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  // ── News results ──────────────────────────────────────────────
  private getNewsNodes(doc: Document): Element[] {
    const selectors = [
      "#rso div[data-hveid]",
      "#rso g-card",
      "#rso .WlydOe",
    ];
    for (const sel of selectors) {
      const nodes = Array.from(doc.querySelectorAll(sel));
      const filtered = nodes.filter((n) => n.querySelector("a[href]"));
      if (filtered.length > 0) return filtered;
    }
    return [];
  }

  // ── URL extraction ─────────────────────────────────────────────
  getResultUrl(node: Element): string | null {
    if (this.isImages) return this.getImageUrl(node);

    // Prefer the actual href of any external link (most reliable, avoids
    // cite-text path components like "example.com › category › page")
    const links = Array.from(
      node.querySelectorAll("a[href]")
    ) as HTMLAnchorElement[];

    for (const a of links) {
      if (this.isExternalHref(a.href)) return a.href;
    }

    // Unwrap Google's /url?q= redirect links
    for (const a of links) {
      const raw = a.getAttribute("href") ?? "";
      if (raw.startsWith("/url?") || raw.includes("google.com/url")) {
        const qs = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw;
        const q = new URLSearchParams(qs).get("q");
        if (q && q.startsWith("http")) return q;
      }
    }

    // Last fallback: cite text (take only the domain part, before any ›)
    const cite = node.querySelector("cite");
    if (cite?.textContent) {
      const raw = cite.textContent.trim();
      // Strip breadcrumb path: "example.com › category › page" → "example.com"
      const domainPart = raw.split(/\s*[›»/]\s*/)[0]?.trim() ?? "";
      if (domainPart.includes(".")) {
        return domainPart.startsWith("http")
          ? domainPart
          : "https://" + domainPart;
      }
    }

    return null;
  }

  private getImageUrl(node: Element): string | null {
    const a = node.querySelector("a[href]") as HTMLAnchorElement | null;
    const href = a?.getAttribute("href") ?? "";
    if (href.startsWith("http") && !href.includes("google.")) return href;
    return null;
  }

  // ── Button target ──────────────────────────────────────────────
  /**
   * Return the element inside which the block button will be placed.
   *
   * Priority order (mirrors the Jefferson Scher userscript v2.3.4):
   *   1. h3 / h2 title heading — button is APPENDed inside; the heading sits
   *      above the cite/source row so there is no risk of overlapping the
   *      three-dot feedback button that Google places in the cite-row flex
   *      container.
   *   2. cite element — fallback; caller inserts AFTER (exitAnchor applied).
   *   3. Domain span class fallback.
   *   4. Parent of first external link.
   */
  getButtonTarget(node: Element): Element | null {
    // Prefer h3 (or h2) — the content script will APPEND inside the heading,
    // keeping the button outside the cite-row flex container entirely.
    const heading = node.querySelector("h3") ?? node.querySelector("h2");
    if (heading) return heading;

    // Secondary: cite element (insert after, using exitAnchor)
    const cite = node.querySelector("cite");
    if (cite) return this.exitAnchor(cite, node);

    // Tertiary: span that shows the domain (class VuuXrf in some Google versions)
    const domainSpan = node.querySelector(".VuuXrf, .qzEoUe");
    if (domainSpan) return this.exitAnchor(domainSpan, node);

    // Last resort: parent of first link
    const firstLink = node.querySelector("a[href]");
    return firstLink?.parentElement ?? null;
  }

  /**
   * Walk up from `el` through any <a> ancestors until we reach
   * an element whose parent is NOT an <a> (or we hit the root node).
   * This ensures the returned element can be safely inserted after
   * without placing our button inside a link.
   */
  private exitAnchor(el: Element, root: Element): Element {
    let current: Element = el;
    while (
      current.parentElement &&
      current.parentElement !== root &&
      current.parentElement.tagName === "A"
    ) {
      current = current.parentElement;
    }
    return current;
  }

  observerOptions(): MutationObserverInit {
    return { childList: true, subtree: true };
  }

  // ── Infinite scroll ──────────────────────────────────────────────────

  getNextPageUrl(doc: Document): string | null {
    const selectors = [
      '#pnnext',
      'a[aria-label^="Next"]',
      'a[aria-label^="Next page"]',
      'a[href*="/search?"][href*="start="]:last-of-type',
    ];
    for (const sel of selectors) {
      const btn = doc.querySelector<HTMLAnchorElement>(sel);
      if (btn?.href) return btn.href;
    }
    return null;
  }

  getPaginationSelectors(): string[] {
    return ['#foot', '#navcnt', '#xjs > div:last-child', 'nav[role="navigation"]'];
  }

  getResultId(node: Element): string | null {
    return node.getAttribute('data-ved') ?? null;
  }

  getResultsContainer(doc?: Document): Element | null {
    const d = doc ?? document;
    for (const sel of ['#rso', '#center_col', '#res']) {
      const el = d.querySelector(sel);
      if (el) return el;
    }
    return null;
  }
}
