import type { EngineAdapter } from "./base";
import type { EngineId } from "../../shared/types";
import { isHostWithin, parseHttpUrl } from "./url-utils";
import { findNextPageLink } from "../infinite-scroll/native-advance";

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

  getResultNodes(doc: Document | Element): Element[] {
    // Prioritize broad organic-result selectors (React DDG 2025+)
    const candidates = [
      'ol.react-results--main > li[data-layout="organic"]',
      'li[data-layout="organic"]',
      'article[data-testid="result"]',
      'div#links div.results_links_deep div.links_main',
      'div#links div.nrn-react-div',
      'div#links > div.result',
    ];
    for (const sel of candidates) {
      const nodes = Array.from(doc.querySelectorAll(sel)) as Element[];
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  getResultUrl(node: Element): string | null {
    // React DDG: data-testid result has a direct link
    const a =
      node.querySelector("article[data-testid='result'] h2 a[href]") ??
      node.querySelector("h2 a[href]") ??
      node.querySelector("a.result__a[href]") ??
      node.querySelector("a[href]");
    const raw = a?.getAttribute("href") ?? "";
    if (!raw) return null;

    // Relative and protocol-relative hrefs exist in the HTML (non-JS) build;
    // resolve them so every caller receives an absolute destination.
    const url = parseHttpUrl(raw, "https://duckduckgo.com");
    if (!url) return null;

    if (isHostWithin(url.hostname, "duckduckgo.com")) {
      // /l/?uddg=<destination> is DDG's redirect wrapper. Without a decodable
      // destination the only URL available is DDG itself — returning it would
      // make the block button hide DuckDuckGo instead of the result.
      const target = url.searchParams.get("uddg");
      if (!target) return null;
      const dest = parseHttpUrl(target);
      // The wrapper's target can point back at DDG too (an internal link, or
      // a crafted wrapper). Same rule applies: never target the engine.
      if (!dest || isHostWithin(dest.hostname, "duckduckgo.com")) return null;
      return dest.toString();
    }

    return url.toString();
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

  onInit(): void {
    // Enable DDG's native infinite scroll via localStorage
    try {
      const raw = localStorage.getItem('duckduckgo_settings');
      const s = raw ? JSON.parse(raw) : {};
      if (s.kav !== '1') {
        s.kav = '1';
        localStorage.setItem('duckduckgo_settings', JSON.stringify(s));
      }
    } catch { /* ignore */ }
  }

  // ── Infinite scroll ──────────────────────────────────────────────────
  // DDG has built-in infinite scroll (kav setting in localStorage).
  // When enabled, it auto-loads results on scroll — our MutationObserver
  // catches those.  getNextPageUrl returns null (no fetch needed).

  /**
   * Extract the DDG vqd (session verification) token from a document.
   * Searches hidden inputs, meta tags, script content, data attributes,
   * and falls back to a regex scan of the entire HTML body text.
   */
  private extractVqd(doc: Document): string | null {
    // 1. Hidden input (most common in legacy HTML)
    const input = doc.querySelector<HTMLInputElement>('input[name="vqd"]');
    if (input?.value) return input.value;

    // 2. Meta tag
    const meta = doc.querySelector<HTMLMetaElement>('meta[name="vqd"]');
    if (meta?.content) return meta.content;

    // 3. data-vqd attribute on any element
    const dataAttr = doc.querySelector('[data-vqd]');
    if (dataAttr) return dataAttr.getAttribute('data-vqd');

    // 4. URL search params (fetched pages already have vqd in URL)
    try {
      const urlVqd = new URL(doc.URL).searchParams.get('vqd');
      if (urlVqd) return urlVqd;
    } catch { /* ignore */ }

    // 5. Search inline scripts for vqd patterns
    const scripts = doc.querySelectorAll('script:not([src])');
    for (const s of scripts) {
      const text = s.textContent ?? '';
      const m = text.match(/["']vqd["']\s*:\s*["']([^"']+)["']/);
      if (m?.[1]) return m[1];
      const m2 = text.match(/vqd['"]?\s*[:=]\s*['"]([a-zA-Z0-9_-]+)['"]/);
      if (m2?.[1]) return m2[1];
    }

    // 6. Last resort: regex over the full HTML body text
    const html = doc.documentElement?.outerHTML ?? '';
    const m = html.match(/vqd=([a-zA-Z0-9_-]+)/);
    if (m?.[1]) return m[1];
    const m2 = html.match(/vqd['"]?\s*[:=]\s*['"]([a-zA-Z0-9_-]+)['"]/);
    if (m2?.[1]) return m2[1];

    return null;
  }

  /**
   * DDG paginates ITSELF: `onInit()` enables the engine's own auto-load
   * (`kav`) and its "More results" button appends hydrated nodes. Emulating
   * that with fetch()+clone would replace a working native path with a
   * bot-gate-prone one, so we declare the observe strategy and never touch
   * the list.
   */
  getPagingStrategy(): "observe" {
    return "observe";
  }

  getPaginationSelectors(): string[] {
    // FAIL-OPEN: never hide DDG's own "More results" control or footer. This
    // list used to hide `div.result--more` / `form.results--more` — i.e. the
    // engine's working control — which is the exact anti-pattern the native
    // strategy exists to remove. (It was inert only because no manager ever
    // started for DDG; that gate is now capability-based.)
    return [];
  }

  getManualNextPageUrl(doc: Document): string | null {
    // Semantic last resort: any anchor DDG itself labels "next".
    return findNextPageLink(doc, this.getResultNodes(doc));
  }

  getResultId(node: Element): string | null {
    return node.getAttribute('data-id') ?? null;
  }

  getResultsContainer(doc?: Document): Element | null {
    const d = doc ?? document;
    // Broad set of possible DDG result containers (ordered by likelihood)
    const sels = [
      'ol.react-results--main',
      'section.results',
      'div#links',
      'div.results',
      '.serp__results',
      '[data-testid="results"]',
    ];
    for (const sel of sels) {
      const el = d.querySelector(sel);
      if (el) return el;
    }
    return null;
  }
}
