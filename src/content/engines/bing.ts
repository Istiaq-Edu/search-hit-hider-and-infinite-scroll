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
    // Keep pagination visible as a manual fallback (consistent with Yandex
    // and Brave): if automatic fetching breaks (rate limit, markup change),
    // users can still page through results manually. Auto-loaded pages are
    // inserted above the pager via getInsertionAnchor().
    return [];
  }

  /**
   * Anchor for infinite scroll insertion: Bing's pager stays visible, so
   * fetched pages must be inserted BEFORE it. Located by walking up from
   * the "Next" link to the element whose parent is the results container —
   * resilient to Bing restructuring the pager's inner markup.
   */
  getInsertionAnchor(container: Element): Element | null {
    const next = container.querySelector(
      'a.sb_pagN, a.sb_pagN_bp, a[title="Next page"], a[title="Next"]'
    );
    if (!next) return null;
    let el: Element = next;
    while (el.parentElement && el.parentElement !== container) {
      el = el.parentElement;
    }
    if (el.parentElement !== container) return null;
    // Never anchor on an element that itself contains the results list.
    // When the container is the broad #b_content wrapper, the walk from the
    // Next link reaches ol#b_results (whose parent IS #b_content) — using it
    // as the anchor would insert pages ABOVE the whole results list.
    if (el.id === "b_results" || el.querySelector("#b_results, li.b_algo")) return null;
    return el;
  }

  getResultId(_node: Element): string | null {
    return null;
  }

  getResultsContainer(doc?: Document): Element | null {
    const d = doc ?? document;
    // Prefer the results list itself. querySelector returns the first match
    // in DOCUMENT order, so listing #b_content first resolves to the broad
    // wrapper (it CONTAINS #b_results) — which misplaces both the sentinel
    // and the page-insertion anchor.
    return d.querySelector("#b_results") ?? d.querySelector("#b_content");
  }
}
