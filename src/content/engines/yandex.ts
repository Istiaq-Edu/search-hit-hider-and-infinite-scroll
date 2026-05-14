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

  getResultNodes(doc: Document): Element[] {
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
    for (const sel of selectors) {
      const btn = doc.querySelector<HTMLAnchorElement>(sel);
      if (btn?.href) return btn.href;
    }
    return null;
  }

  getPaginationSelectors(): string[] {
    return ['.Pager', '.pager', 'nav[role="navigation"]'];
  }

  getResultId(_node: Element): string | null {
    return null;
  }

  getResultsContainer(doc?: Document): Element | null {
    const d = doc ?? document;
    return d.querySelector('#search-results, ol.serp-list, .serp-list, [class*="serp"]');
  }
}
