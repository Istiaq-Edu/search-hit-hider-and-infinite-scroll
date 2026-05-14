import type { EngineAdapter } from "./base";
import type { EngineId } from "../../shared/types";

// ============================================================
// Bing adapter
// ============================================================

export class BingAdapter implements EngineAdapter {
  readonly id: EngineId = "bing";
  readonly name = "Bing";

  matches(url: URL): boolean {
    return url.hostname === "www.bing.com";
  }

  getResultNodes(doc: Document): Element[] {
    return Array.from(
      doc.querySelectorAll("#b_content ol#b_results > li.b_algo")
    );
  }

  getResultUrl(node: Element): string | null {
    // Real URL from cite element (more reliable than href which may be tracking)
    const cite = node.querySelector("li.b_algo > div:not(.b_algo_group) cite");
    if (cite?.textContent) {
      const text = cite.textContent.trim();
      if (text.includes(".")) {
        return text.startsWith("http") ? text : "https://" + text;
      }
    }
    const a = node.querySelector("h2 > a[href]");
    return a?.getAttribute("href") ?? null;
  }

  getButtonTarget(node: Element): Element | null {
    return node.querySelector("h2 > a") ?? node.querySelector("h2");
  }

  // ── Infinite scroll ──────────────────────────────────────────────────

  getNextPageUrl(doc: Document): string | null {
    const selectors = [
      'a.sb_pagN',
      'a[title="Next page"]',
      'a[title="Next"]',
      'a.sb_pagN_bp',
    ];
    for (const sel of selectors) {
      const btn = doc.querySelector<HTMLAnchorElement>(sel);
      if (btn?.href) return btn.href;
    }
    return null;
  }

  getPaginationSelectors(): string[] {
    return ['li.b_pag', 'nav[role="navigation"]', '#b_results li.b_pag'];
  }

  getResultId(_node: Element): string | null {
    return null;
  }

  getResultsContainer(doc?: Document): Element | null {
    const d = doc ?? document;
    return d.querySelector('#b_content, #b_results');
  }
}
