import type { EngineAdapter } from "./base";
import type { EngineId } from "../../shared/types";

// ============================================================
// Brave Search adapter — search.brave.com
//
// DOM structure (confirmed from live HTML):
//   Each result is:  div.snippet[data-type="web"|"news"|"videos"]
//   Title link:      a.l1[href]  (first <a> with class l1 inside)
//   Fallback link:   .result-content a[href], .result-wrapper a[href]
//   Domain text:     cite.snippet-url
//
// The svelte hash suffix on class names (e.g. "svelte-jmfu5f") changes
// on deployments, so all selectors use only the stable parts of class names.
// ============================================================

const BRAVE_HOSTS = new Set([
  "search.brave.com",
  // Tor .onion
  "search.brave4u7jddbv7cyvyptnt5corw0tamlzo53lwd5s7vm223nr3ro2ryd.onion",
]);

export class BraveAdapter implements EngineAdapter {
  readonly id: EngineId = "brave";
  readonly name = "Brave Search";

  matches(url: URL): boolean {
    return BRAVE_HOSTS.has(url.hostname);
  }

  getResultNodes(doc: Document | Element): Element[] {
    const selectors = [
      '#results > .snippet',
      'div.snippet[data-type="web"]',
      'div.snippet[data-type="news"]',
      'div.snippet[data-type="videos"]',
      '.snippet',
    ];
    for (const sel of selectors) {
      const nodes = Array.from(doc.querySelectorAll(sel))
        .filter((n) => !n.getAttribute("data-shh-result") && this.getResultUrl(n) !== null);
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  getResultUrl(node: Element): string | null {
    // Primary: the main title anchor (class "l1" — stable Brave naming)
    const titleAnchor = node.querySelector<HTMLAnchorElement>("a.l1[href]");
    if (titleAnchor) {
      const href = titleAnchor.getAttribute("href") ?? "";
      if (href.startsWith("http") && !this.isBraveUrl(href)) return href;
    }

    // Fallback: any external link inside the result content area
    const links = node.querySelectorAll<HTMLAnchorElement>(
      ".result-content a[href], .result-wrapper a[href]"
    );
    for (const a of links) {
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("http") && !this.isBraveUrl(href)) return href;
    }

    // Last fallback: cite text (domain shown under the title)
    const cite = node.querySelector("cite.snippet-url");
    if (cite?.textContent) {
      const raw = cite.textContent.trim().split(/[\s›»/]/)[0]?.trim() ?? "";
      if (raw.includes(".")) return "https://" + raw + "/";
    }

    return null;
  }

  private isBraveUrl(href: string): boolean {
    try {
      const h = new URL(href).hostname;
      return h.endsWith(".brave.com") || BRAVE_HOSTS.has(h);
    } catch {
      return false;
    }
  }

  getButtonTarget(node: Element): Element | null {
    // Return the main title anchor (a.l1).
    // The button will be inserted AFTER this element, landing as a sibling
    // inside div.result-content — between the title link and the description.
    //
    // IMPORTANT: do NOT return elements that are INSIDE a.l1 (e.g.
    // div.search-snippet-title lives inside the anchor). Inserting a <button>
    // inside an <a> is invalid HTML and causes unpredictable browser behaviour.
    const titleAnchor = node.querySelector<HTMLAnchorElement>("a.l1");
    if (titleAnchor) return titleAnchor;

    // Fallback for edge cases (e.g. news/video cards with different markup)
    return node.querySelector(".result-content") ?? node.querySelector(".result-wrapper") ?? null;
  }

  observerOptions(): MutationObserverInit {
    return { childList: true, subtree: true };
  }

  // ── Infinite scroll ──────────────────────────────────────────────────

  getNextPageUrl(doc: Document): string | null {
    // Prefer the document's own URL when the environment supplies one; a
    // DOMParser document reports "about:blank" and relies on the injected
    // <base href> for baseURI. doc.baseURI alone is wrong in test/iframe
    // environments whose window URL has nothing to do with the parsed page.
    const docUrl = doc.URL;
    const base = /^https?:/i.test(docUrl) ? docUrl : doc.baseURI;
    if (!base || !/^https?:/i.test(base)) return null;

    let currentOffset = 0;
    try {
      currentOffset = parseInt(new URL(base).searchParams.get("offset") ?? "0", 10) || 0;
    } catch { /* unparsable base — fall through with offset 0 */ }

    // An explicit Next control is the most reliable signal.
    for (const sel of ['a[aria-label="Next page"]', 'a[aria-label="Next"]']) {
      const btn = doc.querySelector<HTMLAnchorElement>(sel);
      if (btn?.href && btn.getAttribute("aria-disabled") !== "true") return btn.href;
    }

    // Offset links: choose the SMALLEST offset greater than the current one.
    // `querySelector` used to take the first match, which is the pager's own
    // "1" link on some builds — auto-load then re-fetched page 1 forever.
    let bestOffset = Number.POSITIVE_INFINITY;
    let bestHref: string | null = null;
    for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href*="offset="]'))) {
      let u: URL;
      try {
        u = new URL(a.getAttribute("href") ?? "", base);
      } catch {
        continue;
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      const off = parseInt(u.searchParams.get("offset") ?? "", 10);
      if (!Number.isFinite(off) || off <= currentOffset) continue;
      if (off < bestOffset) {
        bestOffset = off;
        bestHref = u.toString();
      }
    }
    if (bestHref) return bestHref;

    // Last resort: construct the next offset. Brave caps it at 9.
    try {
      if (currentOffset >= 9) return null;
      const url = new URL(base);
      url.searchParams.set("offset", String(currentOffset + 1));
      return url.toString();
    } catch {
      return null;
    }
  }

  getPaginationSelectors(): string[] {
    return []; // Keep pagination visible per user requirement
  }

  getResultId(_node: Element): string | null {
    return null; // Fall back to URL-hash deduplication
  }

  getResultsContainer(doc?: Document): Element | null {
    const d = doc ?? document;
    return d.querySelector("#results");
  }
}
