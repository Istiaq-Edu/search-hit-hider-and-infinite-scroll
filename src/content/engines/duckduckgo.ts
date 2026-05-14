import type { EngineAdapter } from "./base";
import type { EngineId } from "../../shared/types";

// ============================================================
// DuckDuckGo adapter — classic + React results
// ============================================================

export class DuckDuckGoAdapter implements EngineAdapter {
  readonly id: EngineId = "duckduckgo";
  readonly name = "DuckDuckGo";

  matches(url: URL): boolean {
    const h = url.hostname;
    return (
      h === "duckduckgo.com" ||
      h === "noai.duckduckgo.com" ||
      h === "start.duckduckgo.com" ||
      h === "safe.duckduckgo.com"
    );
  }

  getResultNodes(doc: Document): Element[] {
    // React results (modern DDG)
    const reactResults = Array.from(
      doc.querySelectorAll("ol.react-results--main > li[data-layout='organic']")
    );
    if (reactResults.length > 0) return reactResults;

    // Legacy results
    const legacy = Array.from(
      doc.querySelectorAll(
        "div#links div.results_links_deep div.links_main, div#links div.nrn-react-div"
      )
    );
    if (legacy.length > 0) return legacy;

    // Fallback
    return Array.from(doc.querySelectorAll("div#links > div.result"));
  }

  getResultUrl(node: Element): string | null {
    // React DDG: data-testid result has a direct link
    const a =
      node.querySelector("article[data-testid='result'] h2 a[href]") ??
      node.querySelector("h2 a[href]") ??
      node.querySelector("a.result__a[href]") ??
      node.querySelector("a[href]");
    return a?.getAttribute("href") ?? null;
  }

  getButtonTarget(node: Element): Element | null {
    return (
      node.querySelector("h2 a") ??
      node.querySelector("h2") ??
      node.querySelector(".result__title") ??
      node.querySelector("a[href]")
    );
  }

  observerOptions(): MutationObserverInit {
    return { childList: true, subtree: true };
  }

  // ── Infinite scroll ──────────────────────────────────────────────────

  getNextPageUrl(doc: Document): string | null {
    // Try direct "More results" link first
    const moreLink = doc.querySelector<HTMLAnchorElement>(
      'a.result--more__link, a[data-testid="result--more"], .result--more a'
    );
    if (moreLink?.href) return moreLink.href;

    // Try extracting from the "More results" form
    const form = doc.querySelector<HTMLFormElement>(
      'form[action*="html"], form.tile--more__form'
    );
    if (form) {
      const baseUrl = new URL(window.location.origin + (form.getAttribute('action') ?? '/'));
      const formData = new FormData(form);
      for (const [key, val] of formData) {
        baseUrl.searchParams.set(key, val.toString());
      }
      return baseUrl.toString();
    }

    // Fallback: manually increment s/dc params from current URL
    const cur = new URL(window.location.href);
    const s = parseInt(cur.searchParams.get('s') ?? '0', 10);
    if (!isNaN(s)) {
      const next = new URL(window.location.href);
      next.searchParams.set('s', String(s + 30));
      next.searchParams.set('dc', String(s + 31));
      return next.toString();
    }

    return null;
  }

  getPaginationSelectors(): string[] {
    return ['.results--footer', 'div.result--more', '#footer'];
  }

  getResultId(node: Element): string | null {
    return node.getAttribute('data-id') ?? null;
  }

  getResultsContainer(doc?: Document): Element | null {
    const d = doc ?? document;
    return d.querySelector('#links, ol.react-results--main');
  }
}
