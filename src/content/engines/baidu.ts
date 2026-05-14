import type { EngineAdapter } from "./base";
import type { EngineId } from "../../shared/types";

// ============================================================
// Baidu adapter
// ============================================================

export class BaiduAdapter implements EngineAdapter {
  readonly id: EngineId = "baidu";
  readonly name = "Baidu";

  matches(url: URL): boolean {
    return url.hostname === "www.baidu.com";
  }

  getResultNodes(doc: Document): Element[] {
    // Regular results
    const regular = Array.from(
      doc.querySelectorAll(
        "#content_left > div.result.c-container, #content_left > div.result-op.c-container"
      )
    );
    return regular;
  }

  getResultUrl(node: Element): string | null {
    // Baidu uses redirect URLs — extract from data-mu attribute or cite
    const mu = node.getAttribute("mu");
    if (mu) return mu;

    const cite = node.querySelector("a.c-showurl[href]");
    if (cite) {
      const text = cite.textContent?.trim();
      if (text && text.includes(".")) {
        return text.startsWith("http") ? text : "https://" + text;
      }
    }

    const a = node.querySelector("h3 > a[href]");
    return a?.getAttribute("href") ?? null;
  }

  getButtonTarget(node: Element): Element | null {
    return (
      node.querySelector("h3 > a") ??
      node.querySelector("h3") ??
      node.querySelector("a[href]")
    );
  }

  // ── Infinite scroll ──────────────────────────────────────────────────

  getNextPageUrl(doc: Document): string | null {
    const selectors = [
      '#page a.n',
      'a.n',
      'a[class*="next"]',
      'a[href*="pn="]',
    ];
    for (const sel of selectors) {
      const btn = doc.querySelector<HTMLAnchorElement>(sel);
      if (btn?.href) {
        // Verify it's a "next" link, not a page number
        const text = btn.textContent?.trim().toLowerCase() ?? '';
        if (!text || text === '下一页' || text === 'next' || text.includes('>')) return btn.href;
      }
    }
    return null;
  }

  getPaginationSelectors(): string[] {
    return ['#page', '#page-wrap'];
  }

  getResultId(_node: Element): string | null {
    return null;
  }

  getResultsContainer(doc?: Document): Element | null {
    const d = doc ?? document;
    return d.querySelector('#content_left');
  }
}
