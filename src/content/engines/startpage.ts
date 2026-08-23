import type { EngineAdapter } from "./base";
import type { EngineId } from "../../shared/types";

// ============================================================
// Startpage adapter — www.startpage.com
//
// Selector history and quirks are documented inline at
// RESULT_SELECTORS below. In short: four markup generations from the
// userscript era plus the 2026 <section id="main"> layout verified live.
//
// Other quirks ported from the userscript:
//   • Results render late (POST-based search + React hydration) — the
//     content script defers init by ~400 ms (see index.ts).
//   • "Anonymous view" proxy links (ixquick-proxy.com/do/spg/highlight.pl
//     and us-browse.startpage.com/av/proxy) wrap the real destination in
//     a `u` query parameter — unwrapped in getResultUrl().
//
// Infinite scroll: Startpage pagination is NOT a GET URL — page 2+ is a
// POST to /sp/search carrying a session `sc` token (without it Startpage
// treats the request as a bot). The pager form's hidden inputs (sc, t,
// segment, lui, language, cat) are ported wholesale into the POST body.
// If a fetched page yields no result nodes (client-hydrated markup), the
// manager's empty-page guard stops loading and the visible native
// pagination remains as the manual fallback.
// ============================================================

// Markup generations (ported from the Google-Hit-Hider userscript's
// dated history, plus live verification):
//   2018    : [data-view="results"] ol.list-flat > li.search-result > h3 > a
//   2019    : section.w-gl > div.w-gl__result > a.w-gl__result-title
//   05/2024 : div#main > div.w-gl > div.result > a.result-title.result-link
//   12/2024 : section#main > div.css-ndwlbg > div.article (news results)
//   08/2026 : <section id="main"> wraps the results (div#main matches NOTHING
//             on the live site); results are still div.result children of
//             div.w-gl, and the pager is div.pagination-container > nav.pagination
//             holding a POST form with hidden sc/t/segment/lui/language/cat inputs.
//
// Selectors are therefore tag-agnostic on #main, with an unscoped fallback
// so a future container change degrades gracefully.
const RESULT_SELECTORS = [
  // 2026 live layout (section#main) + 2024 variant (div#main)
  "#main div.w-gl > div.result",
  "#main div.w-bg > div.result",
  // Unscoped fallback: container-tag-proof
  "div.w-gl > div.result",
  // 2019 layout
  "div.w-gl__result",
  // Dec 2024 news layout
  "section#main div.css-ndwlbg > div.article",
  // 2018 legacy layout
  "[data-view='results'] li.search-result",
  "ol.list-flat > li",
];

// The next-page control: Startpage's pager is a form with submit buttons.
const PAGER_CONTROL_SELECTORS = [
  "div.pagination button",
  "form[action*='/sp/search'] button[type='submit']",
  "button.pagination__next",
];

export class StartpageAdapter implements EngineAdapter {
  readonly id: EngineId = "startpage";
  readonly name = "Startpage";

  matches(url: URL): boolean {
    const h = url.hostname;
    if (h === "us-browse.startpage.com") return false; // anonymous-view proxy host
    return (
      h === "startpage.com" ||
      h === "www.startpage.com" ||
      h.endsWith(".startpage.com")
    );
  }

  getResultNodes(doc: Document): Element[] {
    for (const sel of RESULT_SELECTORS) {
      const nodes = Array.from(doc.querySelectorAll(sel)).filter(
        (n) => !n.getAttribute("data-shh-result") && this.getResultUrl(n) !== null
      );
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  getResultUrl(node: Element): string | null {
    const a =
      node.querySelector<HTMLAnchorElement>("a.result-title[href]") ??
      node.querySelector<HTMLAnchorElement>("a.w-gl__result-title[href]") ??
      node.querySelector<HTMLAnchorElement>("a.result-link[href]") ??
      node.querySelector<HTMLAnchorElement>("h3 a[href]") ??
      node.querySelector<HTMLAnchorElement>("h2 a[href]") ??
      node.querySelector<HTMLAnchorElement>("a[href]");
    if (!a) return null;
    const href = a.getAttribute("href") ?? "";
    if (!href) return null;

    const unwrapped = this.unwrapProxy(href);
    if (unwrapped) return unwrapped;

    // Absolute external links only; Startpage-internal paths ("/do/...",
    // "/sp/...") are not result destinations.
    if (href.startsWith("http")) return href;
    return null;
  }

  /**
   * Unwrap Startpage "anonymous view" proxy links, which hide the real
   * destination in a `u` query parameter:
   *   https://ixquick-proxy.com/do/spg/highlight.pl?...&u=https%3A%2F%2Fexample.com
   *   https://us-browse.startpage.com/av/proxy?...&u=https%3A%2F%2Fexample.com
   * (ported from the userscript's Startpage branch)
   */
  private unwrapProxy(href: string): string | null {
    const isProxy =
      href.includes("ixquick-proxy.com/do/spg/highlight.pl") ||
      href.includes("startpage.com/av/proxy");
    if (!isProxy) return null;
    try {
      const q = href.slice(href.indexOf("?") + 1);
      // URLSearchParams.get() already percent-decodes the value once.
      const u = new URLSearchParams(q).get("u");
      if (u && u.startsWith("http")) return u;
    } catch { /* malformed proxy link — fall through */ }
    return null;
  }

  getButtonTarget(node: Element): Element | null {
    // The title ANCHOR is the target: the generic "after" insertion places
    // the button to the right of the title link, matching the userscript's
    // Startpage rule (insert after the <a>, never inside it).
    return (
      node.querySelector<HTMLAnchorElement>("a.result-title") ??
      node.querySelector<HTMLAnchorElement>("a.w-gl__result-title") ??
      node.querySelector<HTMLAnchorElement>("h3 a") ??
      node.querySelector<HTMLAnchorElement>("a.result-link") ??
      node.querySelector<HTMLAnchorElement>("a[href]")
    );
  }

  observerOptions(): MutationObserverInit {
    return { childList: true, subtree: true };
  }

  // ── Infinite scroll ──────────────────────────────────────────────────

  /**
   * Page 2+ must be POSTed to /sp/search with the session `sc` token and
   * the page number in a form-urlencoded body (verified against SearXNG's
   * Startpage engine and the degoogle extension). The token is read from
   * the search form's hidden input — present both on the live page and in
   * fetched responses (the form is server-rendered).
   */
  /**
   * Page 2+ must be POSTed to /sp/search with the session `sc` token and
   * the page number in a form-urlencoded body (verified against SearXNG's
   * Startpage engine, the degoogle extension, and the live 2026 SERP).
   *
   * The body is built from the pager form's OWN hidden inputs (sc, t=device,
   * segment=startpage.udog, lui, language, cat — read wholesale so Startpage
   * adding/renaming fields cannot break the request), then `page` is set and
   * `query` is added. Falls back to the search-bar form + hydration JSON for
   * the sc token when the pager form is absent.
   */
  getNextPageRequest(doc: Document, pageNo: number): { url: string; method: "POST"; body: Record<string, string> } | null {
    const pagerForm = doc.querySelector<HTMLFormElement>("form[action*='/sp/search']");
    const body: Record<string, string> = {};

    if (pagerForm) {
      for (const input of pagerForm.querySelectorAll<HTMLInputElement>("input[type='hidden']")) {
        const name = input.getAttribute("name");
        const value = input.value || input.getAttribute("value");
        if (name && value && name !== "page") body[name] = value;
      }
    }
    if (!body.sc) {
      const sc = this.formValue(doc, "sc") || this.extractScToken(doc);
      if (!sc) return null;
      body.sc = sc;
      // SearXNG sends these on page 2+; include when the form didn't.
      body.t = body.t || "device";
      body.segment = body.segment || "startpage.udog";
      body.cat = body.cat || "web";
    }

    body.page = String(pageNo);
    const query =
      this.formValue(doc, "query") ||
      // Live page fallback: the query is always in the URL on /sp/search.
      (doc.location ? new URLSearchParams(doc.location.search).get("query") ?? "" : "");
    if (query) body.query = query;

    const action = pagerForm?.getAttribute("action") ?? "/sp/search";
    const url = action.startsWith("http")
      ? action
      : "https://www.startpage.com" + (action.startsWith("/") ? action : "/" + action);
    return { url, method: "POST", body };
  }

  /**
   * Read a form input's value from either a LIVE document (React-controlled
   * inputs hold the value as a property; the attribute stays stale) or a
   * fetched/DOMParser document (server-rendered attribute only — .value on
   * a detached input mirrors the attribute, so property-first is safe).
   */
  private formValue(doc: Document, name: string): string {
    const input = doc.querySelector<HTMLInputElement>(`input[name='${name}']`);
    if (!input) return "";
    return input.value || input.getAttribute("value") || "";
  }

  private extractScToken(doc: Document): string | null {
    const input = doc.querySelector<HTMLInputElement>("input[name='sc']");
    const fromInput = input?.value ?? input?.getAttribute("value");
    if (fromInput) return fromInput;
    // Fallback: the token also appears inside the React hydration JSON.
    try {
      for (const s of doc.querySelectorAll("script:not([src])")) {
        const m = (s.textContent ?? "").match(/"sc"\s*:\s*"([^"]+)"/);
        if (m?.[1]) return m[1];
      }
    } catch { /* ignore */ }
    return null;
  }

  getPaginationSelectors(): string[] {
    // Keep pagination visible as the manual fallback — Startpage's POST
    // pagination may stop working (token change, bot wall), and unlike a
    // GET-based engine there is no URL to fall back to.
    return [];
  }

  getResultsContainer(doc?: Document): Element | null {
    const d = doc ?? document;
    return (
      d.querySelector("#main") ??
      d.querySelector("section.mainline__web") ??
      d.querySelector(".w-gl")?.parentElement ??
      null
    );
  }

  /**
   * Anchor for infinite scroll insertion: the pager block. Located by
   * walking up from the next-page control (a form button) to the element
   * whose parent is the results container — resilient to pager markup
   * changes, with a guard against anchoring on the results themselves
   * (the Bing top-insertion lesson).
   */
  getInsertionAnchor(container: Element): Element | null {
    for (const sel of PAGER_CONTROL_SELECTORS) {
      const control = container.querySelector(sel);
      if (!control) continue;
      let el: Element = control;
      while (el.parentElement && el.parentElement !== container) {
        el = el.parentElement;
      }
      if (el.parentElement !== container) continue;
      if (el.querySelector("div.result, div.w-gl__result, div.article")) return null;
      return el;
    }
    return null;
  }

  getResultId(_node: Element): string | null {
    return null; // fall back to URL-hash dedup
  }

  /**
   * Fetched result nodes are styled by ancestor-scoped emotion rules
   * (`.w-gl-hash .css-x { … }`), so appending bare result divs loses their
   * styling context. Hosting the clones inside a shallow clone of the
   * results container preserves it.
   */
  getFetchWrapper(doc: Document): Element | null {
    return doc.querySelector("#main div.w-gl, div.w-gl");
  }
}
