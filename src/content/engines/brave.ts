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

  getResultNodes(doc: Document): Element[] {
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
}
