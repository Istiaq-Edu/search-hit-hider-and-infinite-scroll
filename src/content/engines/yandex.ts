import type { EngineAdapter } from "./base";
import type { EngineId } from "../../shared/types";

// ============================================================
// Yandex adapter — organic results with redirect URL unwrapping
// ============================================================

const YANDEX_HOSTS = new Set([
  "ya.ru", "yandex.ru", "yandex.com", "yandex.by", "yandex.kz",
  "yandex.ua", "yandex.tr", "yandex.eu", "yandex.fr", "yandex.de",
  "yandex.lt", "yandex.lv", "yandex.ee", "yandex.md", "yandex.tj",
  "yandex.uz", "yandex.tm", "yandex.kg", "yandex.az", "yandex.ge",
  "yandex.am",
]);

export class YandexAdapter implements EngineAdapter {
  readonly id: EngineId = "yandex";
  readonly name = "Yandex";

  matches(url: URL): boolean {
    const h = url.hostname;
    return (
      h === "yandex.com" ||
      h === "www.yandex.com" ||
      YANDEX_HOSTS.has(h) ||
      h.endsWith(".yandex.com") ||
      h.endsWith(".ya.ru")
    );
  }

  getResultNodes(doc: Document | Element): Element[] {
    // Modern Yandex organic result containers
    const selectors = [
      "li.serp-item",
      "div.serp-item",
      "div.Organic",
      "div.organic",
    ];
    for (const sel of selectors) {
      const nodes = Array.from(doc.querySelectorAll(sel)).filter(
        (n) => this.getResultUrl(n) !== null && !this.isAdResult(n)
      );
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  getResultUrl(node: Element): string | null {
    // Try title link first
    const titleLink =
      node.querySelector("a.OrganicTitle-Link[href]") ??
      node.querySelector(".OrganicTitle a[href]") ??
      node.querySelector(".organic__title-wrapper a[href]") ??
      node.querySelector("h2 a[href]") ??
      node.querySelector("h3 a[href]");

    if (titleLink) {
      const href = titleLink.getAttribute("href") ?? "";
      return this.unwrapRedirect(href, node);
    }

    // Fallback to displayed domain
    const displayed = this.getDisplayedDomain(node);
    if (displayed) return "https://" + displayed + "/";

    return null;
  }

  private unwrapRedirect(href: string, node: Element): string {
    // Yandex may use redirect URLs — try to extract the real target
    if (!this.isYandexUrl(href)) return href;

    // Try query params
    try {
      const url = new URL(href, "https://yandex.com");
      const target =
        url.searchParams.get("url") ??
        url.searchParams.get("u") ??
        url.searchParams.get("target");
      if (target && target.startsWith("http")) return target;
    } catch {
      // ignore
    }

    // Try displayed domain fallback
    const displayed = this.getDisplayedDomain(node);
    if (displayed) return "https://" + displayed + "/";

    return href;
  }

  private isYandexUrl(href: string): boolean {
    try {
      const host = new URL(href).hostname;
      return (
        YANDEX_HOSTS.has(host) ||
        host.endsWith(".yandex.") ||
        host === "ya.ru" ||
        host.endsWith(".ya.ru")
      );
    } catch {
      return false;
    }
  }

  private getDisplayedDomain(node: Element): string {
    const sels = [
      ".organic__path",
      ".organic__url-text",
      ".Path",
      ".Path-Item",
      ".serp-url",
      "cite",
    ];
    for (const sel of sels) {
      const el = node.querySelector(sel);
      if (el) {
        const txt = el.textContent
          ?.replace(/\s+/g, " ")
          .trim()
          .replace(/^https?:\/\//i, "")
          .split(/[/\s>]/)[0]
          ?.replace(/[.,;:]+$/, "")
          .toLowerCase();
        if (txt && txt.includes(".")) return txt;
      }
    }
    return "";
  }

  private isAdResult(node: Element): boolean {
    const cls = node.className?.toString().toLowerCase() ?? "";
    return (
      cls.includes("serp-adv") ||
      cls.includes("adv-item") ||
      cls.includes("direct") ||
      node.getAttribute("data-fast-name") === "direct" ||
      node.querySelector('[data-fast-name="direct"]') !== null
    );
  }

  getButtonTarget(node: Element): Element | null {
    return (
      node.querySelector("a.OrganicTitle-Link") ??
      node.querySelector(".OrganicTitle a") ??
      node.querySelector("h2 a") ??
      node.querySelector("h3 a")
    );
  }

  // ── Infinite scroll ──────────────────────────────────────────────────

  getNextPageUrl(doc: Document): string | null {
    const selectors = [
      'a.Pager-Item_type_next',
      'a[aria-label="Next page"]',
      'a[aria-label="Next"]',
      'a.pager__next',
    ];
    const pagerNexts: string[] = [];
    for (const sel of selectors) {
      for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>(sel))) {
        // Same discriminator as getInsertionAnchor: an AI-card or converter
        // "next" control must never be mistaken for the pager — its href
        // would become the next fetch URL (an in-page anchor re-fetches the
        // SAME page: dedupe eats it, two empties end the session).
        if (a.href && this.isPagerNextLink(a)) pagerNexts.push(a.href);
      }
    }
    // Last match wins: when both a top and a bottom pager render, they point
    // at the same next page; the bottom one is the real pager.
    return pagerNexts.length > 0 ? (pagerNexts[pagerNexts.length - 1] ?? null) : null;
  }

  getPaginationSelectors(): string[] {
    // Keep pagination visible as fallback — Yandex's bot detection makes
    // automatic fetching unreliable, so users need manual page links.
    return [];
  }

  /** Next links are PAGER nexts only when they point at a paginated /search
   *  URL (…&p=N). Anything else — a source-scroller or gallery control inside
   *  an AI card, a related-query chip — is NOT a pager, and treating it as one
   *  made getInsertionAnchor land auto-loaded pages and the spinner directly
   *  after the FIRST result card (field report 2026-09-08: "animation shown
   *  after first result box, results added after first result card"). */
  private isPagerNextLink(a: HTMLAnchorElement | Element): boolean {
    const href = a.getAttribute("href");
    if (!href) return false;
    try {
      const u = new URL(href, "https://yandex.com");
      return /^\/search\/?$/.test(u.pathname) && /[?&]p=\d+/.test(u.search);
    } catch {
      return false;
    }
  }

  /**
   * Anchor for infinite scroll insertion: Yandex's pager stays visible, so
   * fetched pages must be inserted BEFORE it. The pager block is located by
   * walking up from the "Next" link to the element whose parent is the
   * results container — resilient to Yandex renaming its pager classes.
   */
  getInsertionAnchor(container: Element): Element | null {
    // Use the LAST matching link: some layouts render pager controls at the
    // top as well, and a stray aria-label="Next" link inside a result card
    // must never win over the real bottom pager.
    const nexts = container.querySelectorAll(
      'a.Pager-Item_type_next, a[aria-label="Next page"], a[aria-label="Next"], a.pager__next'
    );
    // Only links that actually paginate the search qualify. Class/aria alone
    // is not enough: Yandex's AI-answer and converter cards carry "next"
    // controls of their own, and the first of those used to hijack the
    // anchor (verified: anchor resolved to the AI card's li — pages and the
    // spinner were inserted right after the first result).
    const pagerNexts = Array.from(nexts).filter((a) =>
      this.isPagerNextLink(a as HTMLAnchorElement)
    );
    const next = pagerNexts.length > 0 ? pagerNexts[pagerNexts.length - 1] : null;
    if (!next) return null;
    let el: Element = next;
    while (el.parentElement && el.parentElement !== container) {
      el = el.parentElement;
    }
    // If the walk escaped the container (pager lives outside it), let the
    // manager fall back to append-at-end instead of a misplaced insert.
    return el.parentElement === container ? el : null;
  }

  /**
   * Yandex styles result cards via rules scoped to the results list
   * (.serp-list_left_yes{list-style:none}, li.serp-item margins) and — after
   * the 2026 card redesign — via CSS custom properties the list carries.
   * Dropping fetched li.serp-item nodes into a plain div wrapper (the
   * manager default) strips that context: margins collapse oddly and the
   * group renders as ONE condensed block instead of separate cards (field
   * report 2026-09-08). Hosting the clones inside a shallow clone of the
   * fetched page's own results list restores per-card styling.
   */
  getFetchWrapper(doc: Document): Element | null {
    // querySelector returns the first match in DOCUMENT order, so a single
    // comma list cannot express "prefer the organic list". Iterate.
    for (const sel of [
      "ul#search-result.serp-list",
      "ul.serp-list_left_yes",
      "ol.serp-list",
      "ul.serp-list",
    ]) {
      const el = doc.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  getResultId(_node: Element): string | null {
    return null;
  }

  getResultsContainer(doc?: Document): Element | null {
    const d = doc ?? document;
    // Iterate alternatives in priority order: querySelector on a comma list
    // returns the first match in DOCUMENT order, which could hand back the
    // right-column list (serp-list_right_yes) or an in-card list when those
    // precede the organic list. ul#search-result is the organic list.
    for (const sel of [
      "ul#search-result",
      "#search-results",
      "ol.serp-list",
      "ul.serp-list",
    ]) {
      const el = d.querySelector(sel);
      if (el) return el;
    }
    return null;
  }
}
