import type { EngineAdapter, PagingStrategy } from "./base";
import type { EngineId } from "../../shared/types";
import { isHostWithin, parseHttpUrl } from "./url-utils";
import { awaitNewResults, pressNativeControl } from "../infinite-scroll/native-advance";

// ============================================================
// Yandex adapter — organic results with redirect URL unwrapping
// ============================================================

export const YANDEX_HOSTS = new Set([
  "ya.ru", "yandex.ru", "yandex.com", "yandex.by", "yandex.kz",
  "yandex.ua", "yandex.tr", "yandex.eu", "yandex.fr", "yandex.de",
  "yandex.lt", "yandex.lv", "yandex.ee", "yandex.md", "yandex.tj",
  "yandex.uz", "yandex.tm", "yandex.kg", "yandex.az", "yandex.ge",
  "yandex.am",
]);

/** Native "show more" wording across Yandex locales (and the English SERP). */
const MORE_TEXT =
  /показать\s+ещ[её]|ещ[её]\s+результат|show\s+more|load\s+more|more\s+results|10\s+more|дальше|ещё\s+ещё/i;

/** Structural markers on the control itself — not a rotated class name. */
const MORE_MARKER = /more|ещ[её]|дальше/i;

/** Yandex builds that paginate themselves on scroll. */
const CONTINUOUS_MARKER = /infinite|continuous|\bcee\b/i;

/** Node.DOCUMENT_POSITION_FOLLOWING (avoids relying on the global in tests). */
const DOC_POS_FOLLOWING = 4;

const NATIVE_CONTROL_SELECTOR = [
  "button",
  '[role="button"]',
  "a",
  "[data-bem]",
  "[data-testid]",
  "[data-state]",
  '[class*="more"]',
  '[class*="More"]',
  '[class*="MORE"]',
].join(",");

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
    const displayUrl = displayed ? parseHttpUrl("https://" + displayed + "/") : null;
    return displayUrl?.toString() ?? null;
  }

  private unwrapRedirect(href: string, node: Element): string | null {
    // Yandex may use redirect URLs — try to extract the real target.
    const url = parseHttpUrl(href, "https://yandex.com");
    if (!url) return null;
    if (!this.isYandexUrl(url.href)) return url.toString();

    // Try query params
    const target =
      url.searchParams.get("url") ??
      url.searchParams.get("u") ??
      url.searchParams.get("target");
    if (target) {
      const dest = parseHttpUrl(target);
      if (dest) return dest.toString();
    }

    // Try displayed domain fallback. Never return the redirect URL itself:
    // the only domain it names is Yandex, so blocking it would hide the
    // engine's own links instead of the destination the user aimed at.
    const displayed = this.getDisplayedDomain(node);
    const displayUrl = displayed ? parseHttpUrl("https://" + displayed + "/") : null;
    return displayUrl?.toString() ?? null;
  }

  private isYandexUrl(href: string): boolean {
    const url = parseHttpUrl(href);
    if (!url) return false;
    const host = url.hostname;
    for (const domain of YANDEX_HOSTS) {
      if (isHostWithin(host, domain)) return true;
    }
    return isHostWithin(host, "ya.ru");
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
    // FAIL-OPEN INVARIANT: Yandex never lets us hide its pager or its
    // "show more" control. Fetching /search?p=N from a content script is
    // routinely bot-gated (the request has no document-navigation semantics
    // and carries none of the engine's in-page session state). When our
    // automatic layer fails — for ANY reason — the engine's own controls
    // must still be on screen and clickable. An empty selector list means
    // hidePagination() is a no-op and every native link keeps its handlers.
    return [];
  }

  // ── Native paging (primary strategy) ──────────────────────────────────
  //
  // Yandex has shipped its own continuous scroll ("Показать ещё" / "10 more
  // answers") since 2011: the engine's JS fetches the next batch WITH its own
  // session tokens and appends fully hydrated, fully styled result nodes to
  // the live list. That is strictly better than anything a guest content
  // script can reconstruct from a detached document — and it is the reason
  // the fetch/clone/restyle path below has needed five rounds of Yandex
  // field patches. We now delegate to it whenever it is available.

  /**
   * Decide by CAPABILITY, not by engine name. A classic Yandex SERP only has
   * a pager link (fetch fallback); a continuous SERP has its own control
   * (delegate); a SERP that already loads on scroll needs us to stop touching
   * its list entirely (observe).
   */
  getPagingStrategy(doc: Document): PagingStrategy {
    if (this.nativeMoreControl(doc)) return "native";
    if (this.hasNativeAutoScroll(doc) || this.hasTerminalNativeControl(doc)) {
      return "observe";
    }
    return "fetch";
  }

  hasNativeNextPage(doc: Document): boolean {
    return this.nativeMoreControl(doc) !== null;
  }

  /**
   * Fail-open: even if the native control and every automated path are gone,
   * give the user a real link to the next SERP page. Prefer the engine's own
   * pager href; on continuous layouts derive it from the current search URL
   * (Yandex page N+1 is `p=N`). This is a plain navigation — the browser
   * supplies the referer, cookies and document-fetch semantics that our
   * content-script fetch() cannot.
   */
  getManualNextPageUrl(doc: Document, pageNo = 1): string | null {
    // The live document's pager still points at page 2 no matter how many
    // batches we have appended. Only trust it for a fresh page-1 session;
    // afterwards the derived URL must track the pages already loaded.
    const pager = pageNo <= 1 ? this.getNextPageUrl(doc) : null;
    if (pager) return pager;
    // In the live document doc.URL is the SERP URL. In a detached/parsed
    // document it is "about:blank"; fall back to the tab URL where possible.
    const href = /^https?:/i.test(doc.URL ?? "")
      ? doc.URL
      : typeof window !== "undefined"
        ? window.location.href
        : "";
    try {
      const u = new URL(href, "https://yandex.com");
      if (!/^https?:$/.test(u.protocol)) return null;
      if (!/\/(?:search|yandsearch)\/?$/.test(u.pathname) && !u.searchParams.has("text")) {
        return null;
      }
      const inUrl = Number(u.searchParams.get("p") ?? "0");
      const base = Number.isFinite(inUrl) ? inUrl : 0;
      // Yandex page 1 is p=0, page 2 is p=1, ...; `pageNo` is 1-based and
      // counts the batches already shown. Take the larger so a pushState'd
      // URL and our own counter can never produce a backwards link.
      u.searchParams.set("p", String(Math.max(base + 1, pageNo)));
      return u.toString();
    } catch {
      return null;
    }
  }

  /**
   * Press Yandex's own control, then wait for the ENGINE to add results.
   * No fetch(), no DOMParser, no clone, no CSS porting, no favicon painting.
   */
  async triggerNextPage(doc: Document, signal?: AbortSignal): Promise<void> {
    const control = this.nativeMoreControl(doc);
    if (!control) {
      throw new Error("Yandex native advance control disappeared");
    }
    // Count VISIBLE results, not merely present ones. A continuous SERP can
    // ship the next batch hidden in the DOM and reveal it with an attribute
    // flip; a "total nodes" count would never change and the advance would
    // time out. awaitNewResults watches those same attributes.
    const count = (): number =>
      this.getResultNodes(doc).filter(
        (n) =>
          !n.hasAttribute("hidden") &&
          n.getAttribute("aria-hidden") !== "true" &&
          !/display\s*:\s*none/i.test(n.getAttribute("style") ?? "")
      ).length;
    const baseline = count();
    pressNativeControl(control);
    await awaitNewResults({
      baseline,
      count,
      root: doc.documentElement,
      timeoutMs: 10_000,
      ...(signal ? { signal } : {}),
    });
  }

  /** Yandex's own "show more" affordance, discovered structurally. */
  private nativeMoreControl(doc: Document): HTMLElement | null {
    const root = doc.body ?? doc.documentElement;
    if (!root) return null;

    // A genuine "show more" control sits AFTER the last result. Header,
    // sidebar and nav "More" links sit before it — treating one of those as
    // the pager control would disable the working fetch path.
    const results = this.getResultNodes(doc);
    const lastResult = results.length > 0 ? results[results.length - 1]! : null;

    let best: HTMLElement | null = null;
    let bestScore = 0;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(NATIVE_CONTROL_SELECTOR))) {
      if (this.isIneligibleNativeControl(el, lastResult)) continue;
      const score = this.nativeControlScore(el);
      if (score <= 0) continue;
      // Later wins on ties: the bottom-of-list control is the real one.
      if (score >= bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  private isIneligibleNativeControl(el: HTMLElement, lastResult: Element | null): boolean {
    // Anything inside a result card is a snippet/gallery control, not paging.
    if (
      el.closest(
        "li.serp-item, div.serp-item, .Organic, div.organic, " +
          "[data-inf-page], #is-sentinel"
      )
    ) {
      return true;
    }
    // Position invariant: must be after the last organic result.
    if (lastResult && !(lastResult.compareDocumentPosition(el) & DOC_POS_FOLLOWING)) {
      return true;
    }
    // A numbered pager link or the classic pager "Next" NAVIGATES away. It is
    // a manual fallback, never an append-style advance control.
    if (this.isPagerNextLink(el)) return true;
    if (/^\d+$/.test((el.textContent ?? "").trim())) return true;
    const href = el.getAttribute("href") ?? "";
    // Never press a script/data URL. A page that names one is not a paging
    // control, and clicking it would execute page-supplied script.
    if (/^\s*(?:javascript|data|vbscript):/i.test(href)) return true;
    if (href && !href.startsWith("#")) {
      try {
        const u = new URL(href, "https://yandex.com");
        // A /search?p= link is a full navigation, not an append control.
        if (/^\/search\/?$/.test(u.pathname) && /[?&]p=\d+/.test(u.search)) return true;
        // A link to an external destination is a result/ad link, never paging.
        if (/^https?:/i.test(href) && !this.isYandexUrl(u.href)) return true;
      } catch { /* opaque href — let the score decide */ }
    }
    if (
      el.hasAttribute("hidden") ||
      el.getAttribute("aria-hidden") === "true" ||
      el.getAttribute("aria-disabled") === "true" ||
      (el as HTMLButtonElement).disabled === true ||
      /display\s*:\s*none/i.test(el.getAttribute("style") ?? "")
    ) {
      return true;
    }
    return false;
  }

  private nativeControlScore(el: HTMLElement): number {
    // STRONG signals come from semantic attributes; a rotated class name
    // containing "more" is weak evidence and must never select a control on
    // its own (a header "More" menu would otherwise flip classic Yandex to
    // the native strategy and disable the working fetch path).
    const strong = [
      el.getAttribute("data-bem"),
      el.getAttribute("data-state"),
      el.getAttribute("data-testid"),
      el.getAttribute("aria-label"),
    ]
      .filter(Boolean)
      .join(" ");
    const weak = [el.getAttribute("id"), el.className?.toString()]
      .filter(Boolean)
      .join(" ");
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    let score = 0;
    if (MORE_MARKER.test(strong)) score += 10;
    // Only short controls: a result snippet can legitimately contain "more".
    if (text.length > 0 && text.length <= 80 && MORE_TEXT.test(text)) score += 10;
    if (MORE_MARKER.test(weak) && score > 0) score += 4;
    if (/pager|pagination|page-/i.test(`${strong} ${weak}`)) score -= 12;
    return score < 10 ? 0 : score;
  }

  /** A disabled/terminal "more" control means the engine itself stopped. */
  private hasTerminalNativeControl(doc: Document): boolean {
    const root = doc.body ?? doc.documentElement;
    if (!root) return false;
    return Array.from(root.querySelectorAll<HTMLElement>(NATIVE_CONTROL_SELECTOR)).some(
      (el) => {
        if (el.closest("li.serp-item, div.serp-item, .Organic, div.organic")) return false;
        const disabled =
          el.getAttribute("aria-disabled") === "true" ||
          (el as HTMLButtonElement).disabled === true;
        if (!disabled) return false;
        const strong = [
          el.getAttribute("data-bem"),
          el.getAttribute("data-testid"),
          el.getAttribute("aria-label"),
        ]
          .filter(Boolean)
          .join(" ");
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        return (
          MORE_MARKER.test(strong) ||
          (text.length > 0 && text.length <= 80 && MORE_TEXT.test(text))
        );
      }
    );
  }

  /**
   * Some Yandex builds already auto-load on scroll with no button at all.
   * Injecting a sentinel or wrapper divs into their framework-owned list is
   * what breaks that native behaviour — the correct action is to do nothing.
   * Conservative detection: an explicit continuous-scroll marker. A false
   * positive only degrades to the native pager, which we never hide.
   */
  private hasNativeAutoScroll(doc: Document): boolean {
    const root = doc.body ?? doc.documentElement;
    if (!root) return false;
    // A classic SERP still exposes its pager — that belongs to the fetch path.
    if (this.getNextPageUrl(doc)) return false;
    // Only explicit engine state markers qualify. A class name containing
    // "infinite" (an animation utility, a carousel) is far too common to
    // justify turning infinite scroll OFF for the whole session.
    return Array.from(root.querySelectorAll<HTMLElement>("[data-bem], [data-state]")).some(
      (el) =>
        !el.closest("li.serp-item, div.serp-item, .Organic, div.organic") &&
        CONTINUOUS_MARKER.test(
          [el.getAttribute("data-bem"), el.getAttribute("data-state")]
            .filter(Boolean)
            .join(" ")
        )
    );
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
    if (el.parentElement !== container) return null;
    // POSITION VERIFICATION (field 2026-09-08, second round): a genuine pager
    // block sits AFTER the last result in the container. Yandex's cee
    // continuous-scroll variant renders inline load-more controls BETWEEN
    // results — real /search?&p= links that pass the href-shape filter above.
    // Any anchor that precedes the last result is such an in-list widget;
    // anchoring there splices fetched pages and the spinner into the middle
    // of the list. Refuse and let the manager append at the end instead.
    const children = Array.from(container.children);
    const anchorIdx = children.indexOf(el);
    let lastResultIdx = -1;
    try {
      for (const node of this.getResultNodes(container)) {
        let cur: Element | null = node;
        while (cur && cur.parentElement !== container) cur = cur.parentElement;
        if (!cur) continue;
        const idx = children.indexOf(cur);
        if (idx > lastResultIdx) lastResultIdx = idx;
      }
    } catch { /* unreadable container — skip the position check */ }
    // Strictly AFTER the last result: an anchor that sits ON or BEFORE a
    // result is an in-card control or an inline chunk, never the bottom
    // pager. (No results extracted → -1 → check vacuous, anchor accepted.)
    if (lastResultIdx >= 0 && anchorIdx <= lastResultIdx) return null;
    return el;
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
    // Fast path by stable id (SSR fetches ship it); then RESULT-ANCHORED:
    // the list that actually hosts the most fetched result nodes — a bare
    // class-ordered query can resolve to the AI card's own list when the
    // id is absent (same trap as getResultsContainer, field 2026-09-08).
    const byId = doc.querySelector("ul#search-result.serp-list");
    if (byId) return byId;
    const results = this.getResultNodes(doc);
    if (results.length > 0) {
      const tally = new Map<Element, number>();
      for (const r of results) {
        const host = r.closest("ol.serp-list, ul.serp-list");
        if (host) tally.set(host, (tally.get(host) ?? 0) + 1);
      }
      let best: Element | null = null;
      let bestCount = 0;
      for (const [host, count] of tally) {
        if (count > bestCount) {
          best = host;
          bestCount = count;
        }
      }
      if (best) return best;
    }
    for (const sel of ["ul.serp-list_left_yes", "ol.serp-list", "ul.serp-list"]) {
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
    // Fast path: the organic list by its stable id (classic + SSR variants).
    const byId = d.querySelector("ul#search-result");
    if (byId) return byId;
    // RESULT-ANCHORED resolution (field 2026-09-08, cee variant). Two traps
    // proven by the placement receipts:
    //   1. ul#search-result is ABSENT on the live cee DOM, and the first
    //      .serp-list in document order is the AI-answer card's own list.
    //   2. When the li.serp-item class ALSO rotated away, getResultNodes
    //      falls back to div.Organic — whose parent is a PER-RESULT wrapper
    //      (one result each). A "most results" tally then tied at 1 and the
    //      FIRST result card won the container (receipt: lastResult=1 with
    //      processed=10): marker, spinner, and every appended page rendered
    //      INSIDE result card #1.
    // Invariant: the results container is the nearest shared ancestor that
    // holds a MAJORITY of the resolved results — a single result's wrapper
    // can never be it. Tally parent-chains, take the highest host that
    // crosses half, preferring the SHALLOWEST host when several do (the
    // deeper one is a sub-list inside the stream).
    const results = this.getResultNodes(d);
    if (results.length >= 2) {
      const majority = Math.floor(results.length / 2);
      const tally = new Map<Element, number>();
      for (const r of results) {
        let host: Element | null = r.parentElement;
        while (host) {
          tally.set(host, (tally.get(host) ?? 0) + 1);
          host = host.parentElement;
        }
      }
      const hosts = Array.from(tally.entries())
        .filter(([, n]) => n > majority)
        .sort((a, b) => {
          const depth = (el: Element): number => {
            let n = 0;
            for (let p: Element | null = el; p; p = p.parentElement) n++;
            return n;
          };
          // DEEPEST majority ancestor wins: the nearest shared ancestor of
          // the results is the stream itself. Shallower holders (content
          // columns, body, html) also carry a majority but appending there
          // lands pages outside the results flow.
          return depth(b[0]) - depth(a[0]);
        });
      if (hosts.length > 0) {
        const chosen = hosts[0]![0];
        return chosen;
      }
    }
    // No majority (0-1 results resolvable) — legacy best-effort order.
    for (const sel of ["#search-results", "ol.serp-list", "ul.serp-list"]) {
      const el = d.querySelector(sel);
      if (el) return el;
    }
    return null;
  }
}
