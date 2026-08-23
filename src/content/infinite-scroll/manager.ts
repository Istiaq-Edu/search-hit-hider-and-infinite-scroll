import type { EngineAdapter } from "../engines/base";
import { Sentinel } from "./sentinel";
import { Deduper, unwrapProxyDestination } from "./deduper";
import { fetchPage } from "./fetcher";
import { saveScrollState, loadScrollState, isStateFresh, clearScrollState, type ScrollState } from "./persist";

// Inline CSS properties that truncate text in server-rendered HTML from SPAs.
// Stripped from fetched nodes before appending to the live DOM.
const TRUNCATION_PROPS = [
  '-webkit-line-clamp', 'line-clamp',
  'text-overflow',
  'overflow', 'overflow-x', 'overflow-y',
];

// Declaration properties that carry THEME PALETTE. Ported rules keep layout
// only — fetched pages encode the server-default (light) palette in class
// rules, and same-generation css-* hashes match our clones, so any color /
// background that survives porting paints appended results in the wrong
// theme (recolored site links, white favicon chips).
const PALETTE_PROPS =
  /(^|-)(color|background|border|outline|box-shadow|text-shadow|filter|backdrop-filter|opacity|fill|stroke|caret-color|column-rule)(-|$)/i;

// Values that smuggle paint in through otherwise-innocent properties
// (e.g. `-webkit-text-fill`, gradients on `background-image` are already
// caught by the property list; this catches color-bearing values elsewhere).
const PALETTE_VALUES = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\bcolor-scheme\b|gradient\(/i;

// Pure-geometry exceptions inside palette-named families: these carry no
// paint and must survive (favicon chips are circles via border-radius).
const GEOMETRY_EXCEPTIONS = /^(-webkit-)?border(?:-radius|-top-left-radius|-top-right-radius|-bottom-left-radius|-bottom-right-radius)$/i;

export interface InfiniteScrollPrefs {
  threshold: number;
  maxPages: number;
  persist: boolean;
  freshnessMinutes: number;
  fetchDelay: number;
  debugMode: boolean;
  /**
   * Copy the fetched page's <style> rules into the appended page container.
   * Needed when fetched SSR markup uses style classes (e.g. emotion css-*
   * hashes) that the live page's client-rendered stylesheet does not define —
   * without it, auto-loaded results render with wrong colors (Startpage).
   */
  portFetchedStyles?: boolean;
  /**
   * Allow the DuckDuckGo public icon service as a LAST-resort favicon
   * source for clone chips. Default OFF: it makes the browser request
   * icons.duckduckgo.com with every auto-loaded destination host in the
   * URL — third-party disclosure of browsing. Startpage's CSP blocks that
   * request today, but a policy change would silently activate it.
   * The primary sources (same-domain page-1 artwork + learned first-party
   * pattern) need no consent.
   */
  allowThirdPartyIcons?: boolean;
}

const DEFAULT_PREFS: InfiniteScrollPrefs = {
  threshold: 800,
  maxPages: 20,
  persist: true,
  freshnessMinutes: 30,
  fetchDelay: 1500,
  debugMode: false,
};

export class InfiniteScrollManager {
  private engine: EngineAdapter;
  private container: Element;
  private onNewNodes: (nodes: Element[]) => void;
  private config: InfiniteScrollPrefs;

  private sentinel: Sentinel | null = null;
  private observer: IntersectionObserver | null = null;
  private deduper: Deduper;
  private abortController: AbortController | null = null;
  private urlCheckInterval: ReturnType<typeof setInterval> | null = null;
  private pageContainers = new Map<number, HTMLElement>();

  private isLoading = false;
  private currentPage = 1;
  private nextUrl: string | null = null;
  // Engines that paginate via POST (Startpage) supply a request descriptor
  // instead of a plain GET URL; nextUrl is kept in sync for the sentinel state.
  private nextPageRequest: { url: string; init: RequestInit } | null = null;
  private consecutiveEmptyPages = 0;
  private hasMore = true;
  private currentUrl: string;

  private scrollSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private isTriggerEngine = false;
  private consecutiveErrors = 0;

  constructor(
    engine: EngineAdapter,
    container: Element,
    onNewNodes: (nodes: Element[]) => void,
    prefs?: Partial<InfiniteScrollPrefs>
  ) {
    this.engine = engine;
    this.container = container;
    this.onNewNodes = onNewNodes;
    this.config = { ...DEFAULT_PREFS, ...prefs };
    this.deduper = new Deduper();
    this.currentUrl = window.location.href;
  }

  init(): void {
    this.destroyed = false;
    this.isTriggerEngine = typeof this.engine.triggerNextPage === "function";

    if (this.isTriggerEngine) {
      // Trigger-based engines don't need a next URL upfront
      this.nextUrl = "trigger://page";
      this.hasMore = true;
    } else {
      const req = this.buildNextPageRequest(document);
      if (req) {
        this.nextPageRequest = req;
        this.nextUrl = req.url;
      } else {
        this.nextUrl = this.engine.getNextPageUrl?.(document) ?? null;
        this.nextPageRequest = null;
      }
      this.hasMore = !!(this.nextPageRequest || this.nextUrl);
    }
    this.currentPage = 1;
    this.consecutiveEmptyPages = 0;

    if (!this.hasMore) {
      return;
    }

    this.hidePagination();
    this.markInitialPage();
    this.interceptPagination();

    // Seed the deduper with page-1 results so a fetched page that repeats
    // them (Startpage re-serves the tail of page 1 at the top of page 2,
    // with different proxy params) cannot append visible duplicates.
    try {
      for (const node of this.engine.getResultNodes(document)) {
        this.deduper.isDuplicate(node, this.engine);
      }
    } catch { /* dedupe seeding is best-effort */ }

    this.createSentinel();
    this.startObserver();
    this.startNavigationDetection();
    this.bindScrollSave();

    if (this.config.persist) {
      this.tryRestoreScroll();
    }

    this.log(`Initialized (threshold=${this.config.threshold}, maxPages=${this.config.maxPages}, persist=${this.config.persist})`);
  }

  destroy(): void {
    this.destroyed = true;
    this.observer?.disconnect();
    this.observer = null;
    this.sentinel?.remove();
    this.sentinel = null;
    this.abortController?.abort();
    this.abortController = null;
    if (this.urlCheckInterval) {
      clearInterval(this.urlCheckInterval);
      this.urlCheckInterval = null;
    }
    if (this.scrollSaveTimer) {
      clearTimeout(this.scrollSaveTimer);
      this.scrollSaveTimer = null;
    }
    if (this.faviconRetryTimer) {
      clearTimeout(this.faviconRetryTimer);
      this.faviconRetryTimer = null;
    }
    window.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("beforeunload", this.saveScrollStateInternal);
    window.removeEventListener("pagehide", this.saveScrollStateInternal);
    this.removePaginationListeners();
    this.pageContainers.clear();
  }

  handleNavigation(): void {
    this.saveScrollStateInternal();
    this.deduper.reset();
    this.destroy();
    this.currentUrl = window.location.href;
    this.nextUrl = null;
    this.nextPageRequest = null;
    this.consecutiveEmptyPages = 0;
    this.hasMore = true;
    this.isLoading = false;
    this.currentPage = 1;
    this.pageContainers.clear();
    // New search = new result domains: page-1 icon intel is stale by
    // definition and must be recaptured on the next append.
    this.faviconIntel = null;
    this.init();
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private removePaginationListeners(): void {
    const links = this.container.querySelectorAll<HTMLAnchorElement>('a[data-inf-intercept]');
    for (const link of links) {
      link.removeAttribute('data-inf-intercept');
      const clone = link.cloneNode(true) as HTMLAnchorElement;
      link.parentNode?.replaceChild(clone, link);
    }
  }

  private hidePagination(): void {
    const selectors = this.engine.getPaginationSelectors?.();
    if (!selectors) return;
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        (el as HTMLElement).style.display = "none";
      }
    }
  }

  /**
   * Intercept clicks on visible pagination page-number links so that
   * if the page was already fetched by infinite scroll, we scroll to
   * that content instead of navigating away (full page reload).
   */
  private interceptPagination(): void {
    const links = document.querySelectorAll<HTMLAnchorElement>(
      'a[href]:not([data-inf-intercept])'
    );
    for (const link of links) {
      const text = link.textContent?.trim() ?? '';
      const pageNum = parseInt(text, 10);
      if (isNaN(pageNum) || pageNum < 2) continue;
      if (!this.container.querySelector(`[data-inf-page="${pageNum}"]`)) continue;
      link.setAttribute('data-inf-intercept', '1');
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const target = this.container.querySelector<HTMLElement>(
          `[data-inf-page="${pageNum}"]`
        );
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    }
  }

  private createSentinel(): void {
    // Place the spinner directly beneath the streamed results when the
    // engine exposes a pager anchor (Startpage/Bing/Yandex); otherwise
    // after the container, as before.
    const anchor = this.engine.getInsertionAnchor?.(this.container) ?? null;
    this.sentinel = new Sentinel(this.container, anchor ?? undefined);
  }

  private startObserver(): void {
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void this.fetchNextPage();
        }
      },
      { rootMargin: `${this.config.threshold}px` }
    );
    if (this.sentinel) {
      // Defer by 2s so the sentinel doesn't fire immediately on short
      // first pages where it's already within the threshold.
      setTimeout(() => {
        if (this.observer && this.sentinel) {
          this.observer.observe(this.sentinel.element);
        }
      }, 2000);
    }
  }

  private startNavigationDetection(): void {
    const onNavigate = () => {
      if (window.location.href !== this.currentUrl) {
        this.handleNavigation();
      }
    };
    window.addEventListener("popstate", onNavigate);
    window.addEventListener("hashchange", onNavigate);
    // Fallback polling for engines that use history.pushState without popstate
    this.urlCheckInterval = setInterval(() => {
      if (window.location.href !== this.currentUrl) {
        this.handleNavigation();
      }
    }, 2000);
  }

  private async fetchNextPage(): Promise<void> {
    if (this.isLoading || !this.hasMore) return;
    if (!this.isTriggerEngine && !this.nextUrl) return;
    if (this.currentPage >= this.config.maxPages) {
      this.hasMore = false;
      this.sentinel?.setState("done");
      return;
    }

    this.isLoading = true;
    this.sentinel?.setState("loading");

    // ── Trigger-based (click button, wait for DOM changes) ──────────
    if (this.isTriggerEngine) {
      try {
        const beforeCount = this.engine.getResultNodes(document).length;
        await this.engine.triggerNextPage!(document);
        if (this.destroyed) return;

        const allNodes = this.engine.getResultNodes(document);
        const newNodes = allNodes.slice(beforeCount);
        const deduped = newNodes.filter((n) => !this.deduper.isDuplicate(n, this.engine));

        if (deduped.length > 0) {
          this.onNewNodes(deduped);
        }

        this.currentPage++;
        const btn = document.querySelector('button[data-testid="more-results"], button.result--more__btn, .results--more button, a.result--more__link');
        this.hasMore = !!btn && this.currentPage < this.config.maxPages;
        this.sentinel?.setState(this.hasMore ? "idle" : "done");
        this.sentinel?.setState(this.hasMore ? "idle" : "done");
      } catch (err) {
        if (this.destroyed) return;
        // Button not found = no more pages, not an error
        if ((err as Error)?.message?.includes("No")) {
          this.hasMore = false;
          this.sentinel?.setState("done");
        } else {
          this.sentinel?.setState("error", () => this.retryFetch());
        }
      } finally {
        this.isLoading = false;
      }
      return;
    }

    // ── Fetch-based (standard URL pagination) ───────────────────────
    this.abortController?.abort();
    this.abortController = new AbortController();

    try {
      const result = await fetchPage(
        this.nextUrl!,
        this.abortController.signal,
        this.config.fetchDelay,
        this.nextPageRequest?.init
      );
      if (this.destroyed) return;

      if (!result) {
        this.consecutiveErrors++;
        if (this.consecutiveErrors >= 3) {
          this.log("Too many consecutive errors, stopping");
          this.hasMore = false;
          this.sentinel?.setState("done");
        } else {
          this.sentinel?.setState("error", () => this.retryFetch());
        }
        return;
      }
      this.consecutiveErrors = 0;

      const newNodes = this.extractNewNodes(result.doc);
      const deduped = newNodes.filter((n) => !this.deduper.isDuplicate(n, this.engine));

      // Increment BEFORE appending and building the next request: the page
      // container marker and the next page number must both reflect the page
      // that was just fetched (building first, incrementing later produced
      // an off-by-one that re-fetched the same page for POST engines).
      this.currentPage++;

      if (deduped.length > 0) {
        this.appendNodes(deduped, result.doc);
        this.consecutiveEmptyPages = 0;
      } else {
        // A 200 page with zero extractable results is either a soft block
        // page or a client-hydrated response whose result markup never
        // appears in the raw HTML (Startpage renders results from a JSON
        // hydration payload). Stop after two empties instead of hammering
        // the engine with pointless requests.
        this.consecutiveEmptyPages++;
        this.log("Fetched page yielded no result nodes", this.consecutiveEmptyPages);
      }

      const fetchedReq = this.buildNextPageRequest(result.doc);
      if (fetchedReq) {
        this.nextPageRequest = fetchedReq;
        this.nextUrl = fetchedReq.url;
      } else {
        this.nextUrl = this.engine.getNextPageUrl?.(result.doc) ?? null;
        this.nextPageRequest = null;
      }
      this.hasMore = !!(this.nextPageRequest || this.nextUrl);
      if (this.consecutiveEmptyPages >= 2) {
        this.hasMore = false;
      }

      this.sentinel?.setState(this.hasMore ? "idle" : "done");
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (this.destroyed) return;
      // Thrown network failures count toward the same 3-strike budget as
      // null results — otherwise a dead connection retries once per
      // sentinel crossing forever (unbounded cycle, no backoff).
      this.consecutiveErrors++;
      this.log("Fetch error:", err);
      if (this.consecutiveErrors >= 3) {
        this.log("Too many consecutive errors, stopping");
        this.hasMore = false;
        this.sentinel?.setState("done");
      } else {
        this.sentinel?.setState("error", () => this.retryFetch());
      }
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Build the next-page request for POST-paginated engines (Startpage);
   * null for all GET-based engines.
   */
  private buildNextPageRequest(doc: Document): { url: string; init: RequestInit } | null {
    const req = this.engine.getNextPageRequest?.(doc, this.currentPage + 1);
    if (!req) return null;
    return {
      url: req.url,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(req.body).toString(),
      },
    };
  }

  /** Style texts already ported from fetched pages (dedupe across pages). */
  private portedStyleHashes = new Set<string>();

  /**
   * Copy a fetched page's <style> rules so its class-based styling (emotion
   * css-* hashes) resolves on appended results. EVERY selector is rewritten
   * under the `[data-inf-page]` scope — the attribute every appended page
   * container carries (and the initial results never do):
   *   • document-level rules (html/body/:root) become the scope itself, so
   *     the fetched build's CSS custom properties (design tokens referenced
   *     via var()) are re-defined per page container instead of hijacking
   *     the live document's theme;
   *   • class and ELEMENT rules (img/svg/…) get the scope prefix, so they
   *     cannot reach the original page-1 results — the unscoped port
   *     recolored their text and broke their favicons whenever a fetched
   *     build's structural classes (.w-gl/.result) or element rules
   *     collided with the live page's.
   * Sheets are appended to <head> ONCE per unique text (raw-text dedupe is
   * correct precisely because the scope is container-independent) and
   * therefore survive discardOldPages() trimming old page containers.
   */
  private portStyles(sourceDoc: Document): void {
    try {
      const scope = "[data-inf-page]";
      const liveTexts = new Set<string>();
      for (const s of document.querySelectorAll("style")) {
        const t = (s.textContent ?? "").trim();
        if (t) liveTexts.add(t);
      }
      for (const s of sourceDoc.querySelectorAll("style")) {
        const t = (s.textContent ?? "").trim();
        if (!t || liveTexts.has(t) || this.portedStyleHashes.has(t)) continue;
        const scoped = this.scopeCss(t, scope);
        if (!scoped) continue;
        this.portedStyleHashes.add(t);
        const style = document.createElement("style");
        style.setAttribute("data-shh-fetched-style", "true");
        style.textContent = scoped;
        document.head.appendChild(style);
      }
    } catch { /* styling is cosmetic — never fail the append on it */ }
  }

  /** Prefix every selector with `scope`; html/body/:root become the scope. */
  private scopeCss(cssText: string, scope: string): string | null {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText);
      const out = this.scopeRuleList(sheet.cssRules, scope);
      return out.length > 0 ? out.join("\n") : null;
    } catch {
      // Unparsable sheet: drop it rather than port it unscoped — a raw copy
      // is exactly the global-recolor/favicon leak this scoping exists to
      // prevent.
      return null;
    }
  }

  private scopeRuleList(rules: CSSRuleList, scope: string): string[] {
    const out: string[] = [];
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        const sel = rule.selectorText ?? "";
        // Document-level selectors carry the fetched build's SERVER-DEFAULT
        // palette (verified: Startpage's `html,body{color:#202945}` is the
        // light theme). Porting them — even scoped to the page container —
        // paints appended results in the wrong theme when the user runs a
        // non-default one (the live theme comes from client-side hydration,
        // which fetched HTML never receives). Appended nodes sit inside the
        // live <body>, so they inherit the live theme naturally; drop these.
        if (/^(html|body|:root|\*)$/i.test(sel.trim())) continue;
        const rewritten = sel
          .split(",")
          .map((part) => {
            const s = part.trim();
            if (!s) return null;
            return `${scope} ${s}`;
          })
          .filter((x): x is string => x !== null)
          .join(",");
        if (rewritten) {
          // Strip PALETTE declarations (color/background/borders/shadows…)
          // from ported rules: fetched pages carry the SERVER-DEFAULT light
          // palette in class rules too, and same-generation css-* hashes
          // match our cloned nodes — painting them light inside a dark
          // theme (recolored site links, white favicon chips). Layout
          // properties (display/flex/padding/margins/sizes) survive.
          const decls = this.stripPaletteDecls(rule.style);
          if (decls) out.push(`${rewritten}{${decls}}`);
        }
      } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
        const inner = this.scopeRuleList(rule.cssRules, scope);
        if (inner.length > 0) {
          const condition = rule instanceof CSSMediaRule
            ? `@media ${rule.conditionText}`
            : `@supports ${rule.conditionText}`;
          out.push(`${condition}{${inner.join("\n")}}`);
        }
      } else if (
        rule instanceof CSSKeyframesRule || rule instanceof CSSFontFaceRule
      ) {
        // Global by design — animations and font definitions have no selectors
        // to scope and are safe (or required) outside the container.
        out.push(rule.cssText);
      } else {
        // Anything else (@import, @charset, @namespace, unknown at-rules):
        // DROP. These act document-globally — an @import would fetch remote
        // CSS into the live page unscoped, recreating the exact leak this
        // scoping exists to prevent.
      }
    }
    return out;
  }

  /** Insert a page marker so interceptPagination can find page boundaries. */
  private markInitialPage(): void {
    const marker = document.createElement('div');
    marker.setAttribute('data-inf-page', '1');
    marker.style.cssText = 'height:1px;width:100%;pointer-events:none';
    const first = this.engine.getResultNodes(document)[0];
    if (first?.parentElement) {
      first.parentElement.insertBefore(marker, first);
    } else {
      this.container.prepend(marker);
    }
  }

  private retryFetch(): void {
    this.isLoading = false;
    void this.fetchNextPage();
  }

  private extractNewNodes(doc: Document): Element[] {
    const results = this.engine.getResultNodes(doc);
    const paginationSelectors = this.engine.getPaginationSelectors?.() ?? [];
    return results.filter((n) => {
      const id = n.id || "";
      if (id === "botstuff" || id === "navcnt") return false;
      for (const sel of paginationSelectors) {
        if (n.matches(sel)) return false;
      }
      return true;
    });
  }

  private appendNodes(nodes: Element[], sourceDoc?: Document): void {
    // Wrap the page's results in a container (mirrors the userscript pattern
    // that works reliably for Brave).  This provides proper spacing and keeps
    // fetched nodes grouped together.
    //
    // Engines whose fetched markup depends on ancestor styling context
    // (Startpage's emotion-scoped classes) can provide a wrapper element from
    // the fetched doc; it is shallow-cloned (classes/attributes preserved,
    // original children not) and the result clones live inside it.
    const pageContainer = document.createElement('div');
    pageContainer.id = `shh-inf-page-${this.currentPage}`;
    pageContainer.setAttribute('data-inf-page', String(this.currentPage));
    pageContainer.style.marginTop = '20px';

    let resultHost: HTMLElement = pageContainer;
    const wrapper = sourceDoc ? this.engine.getFetchWrapper?.(sourceDoc) : null;
    if (wrapper) {
      const wrapClone = document.importNode(wrapper, false) as HTMLElement;
      pageContainer.appendChild(wrapClone);
      resultHost = wrapClone;
    }

    // Brave's server-rendered HTML carries inline styles on inner elements
    // that truncate text (-webkit-line-clamp, overflow:hidden, etc.).  The
    // live page's Svelte hydration normally manages these, but our fetched
    // nodes never get hydrated.  Strip these properties so the full text
    // renders.

    function stripTruncationStyles(el: HTMLElement): void {
      for (const prop of TRUNCATION_PROPS) {
        if (el.style.getPropertyValue(prop)) {
          el.style.removeProperty(prop);
        }
      }
    }

    for (const node of nodes) {
      const clone = document.importNode(node, true) as Element;
      // Fetched pages may carry <script> elements and inline event handlers.
      // Scripts inside a DOMParser document are inert, but they EXECUTE when
      // adopted into the live document — strip them, along with on* attributes.
      // Per-result emotion <style> tags (Startpage embeds them with the
      // SERVER-DEFAULT light palette) must never enter the live document —
      // they apply document-wide and same-generation css-* hashes collide
      // with the live page's rules. Instead of inserting them, HARVEST their
      // layout declarations onto the matched clone elements inline first
      // (harvestFetchedStyles) — clones become self-contained.
      clone.querySelectorAll("script").forEach((s) => s.remove());
      this.harvestFetchedStyles(clone);
      this.sanitizeInlineStyles(clone);
      for (const el of [clone, ...Array.from(clone.querySelectorAll("*"))]) {
        for (const attr of el.getAttributeNames()) {
          if (attr.startsWith("on")) el.removeAttribute(attr);
        }
      }
      // Strip truncation styles only from elements likely to have them
      // (avoids querySelectorAll('*') which iterates all descendants)
      const truncateTargets = clone.querySelectorAll<HTMLElement>(
        'p, span, div, [style*="clamp"], [style*="overflow"]'
      );
      if (clone instanceof HTMLElement) {
        stripTruncationStyles(clone);
      }
      for (const desc of truncateTargets) {
        stripTruncationStyles(desc);
      }
      resultHost.appendChild(clone);
    }

    // Insert before the SENTINEL when it lives inside the container (the
    // spinner then always sits directly beneath the newest results), else
    // before an engine-provided anchor (e.g. a visible pager), else at the
    // end of the results container. The parentNode guards keep insertBefore
    // from throwing on misplaced references.
    const sentinelEl = this.sentinel?.element ?? null;
    const anchor = this.engine.getInsertionAnchor?.(this.container) ?? null;
    const pagination =
      anchor ??
      this.container.querySelector('#pagination-snippet, nav[role="pagination"], .pagination');
    const insertRef =
      sentinelEl && sentinelEl.parentNode === this.container
        ? sentinelEl
        : pagination && pagination.parentNode === this.container
          ? pagination
          : null;
    if (insertRef) {
      this.container.insertBefore(pageContainer, insertRef);
    } else {
      this.container.appendChild(pageContainer);
    }

    // Port the fetched page's own styles when the engine needs it: fetched
    // SSR markup can carry class names the live page never defines. Sheets
    // are scoped to [data-inf-page] and appended to <head>, so they style
    // every appended page and cannot touch the original results.
    if (this.config.portFetchedStyles && sourceDoc) {
      this.portStyles(sourceDoc);
    }

    // Report the individual result nodes (not the wrapper) so the blocking
    // pipeline keeps per-result hiding granularity.
    const appended = Array.from(resultHost.children) as Element[];
    // Re-skin clones with the LIVE page's theme before anything renders.
    if (this.config.portFetchedStyles && sourceDoc && appended.length > 0) {
      // Fill the URL-line slot Startpage's hydration normally writes
      // (clones are never hydrated) BEFORE tinting, so the filled span
      // gets the live theme color in the same pass.
      this.hydrateDisplayUrls(appended);
      this.reSkinClones(appended);
      // Current-generation Startpage SSR carries NO favicon URLs at all —
      // icons are painted by hydration, which clones never receive
      // (diagnostics prove faviconsPainted:0). Assign them ourselves.
      this.ensureCloneFavicons(appended);
    }
    if (this.config.debugMode) {
      const page = appended[0]?.closest("[data-inf-page]") as HTMLElement | null;
      const chips = page?.querySelectorAll('[class*="favicon" i]').length ?? 0;
      const painted = page?.querySelectorAll(
        '[class*="favicon" i][style*="background-image"], [class*="favicon" i] [style*="background-image"]'
      ).length ?? 0;
      const tinted = page
        ? page.querySelectorAll(
            "a.result-title[style], [class*='display-url'][style], [class*='link-text'][style], p.description[style]"
          ).length
        : 0;
      this.log("page appended:", JSON.stringify({
        nodes: appended.length,
        faviconEls: chips,
        faviconsPainted: painted,
        tintedEls: tinted,
        refColors: { title: this.lastRefTitle, path: this.lastRefPath },
      }));
    }
    this.onNewNodes(appended);
    this.interceptPagination();
    // Track page container for efficient discard
    this.pageContainers.set(this.currentPage, pageContainer);
    this.discardOldPages();
  }

  /**
   * Copy only LAYOUT declarations from a fetched rule's declaration block.
   * Palette-bearing properties (colors, backgrounds, borders, shadows,
   * filters, opacity) are dropped — they encode the fetched build's
   * server-default light theme and must never reach the live document.
   */
  private stripPaletteDecls(style: CSSStyleDeclaration): string {
    const out: string[] = [];
    for (let i = 0; i < style.length; i++) {
      const prop = style.item(i);
      if (PALETTE_PROPS.test(prop)) continue;
      const val = style.getPropertyValue(prop);
      if (val && PALETTE_VALUES.test(val)) continue;
      out.push(`${prop}:${val}`);
    }
    return out.join(";");
  }

  /** Last measured live reference colors (diagnostics). */
  private lastRefTitle: string | null = null;
  private lastRefPath: string | null = null;

  /**
   * Page-1 favicon intelligence (host->icon map + learned URL pattern),
   * captured on the first append and reused for the session. Cached
   * because page-1 is immutable AND gets discarded after ~6 pages —
   * recomputing per append both wasted cycles and lost the data forever.
   */
  private faviconIntel: { map: Map<string, string>; pattern: string | null } | null = null;

  /** Pending empty-intel retry (hydration may land late — React #423). */
  private faviconRetryTimer: number | null = null;
  /** Empty-intel retry attempts so far (cap the loop; then self-diagnose). */
  private faviconRetryCount = 0;

  /**
   * First computed text color found in the LIVE document for any of these
   * role selectors — excluding anything inside auto-loaded page containers
   * (clones are unstyled until this very function runs; measuring them
   * would feed the clone its own nothing).
   */
  private measureLiveColor(sels: string[]): string | null {
    try {
      for (const sel of sels) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          if (el.closest("[data-inf-page]")) continue;
          const c = window.getComputedStyle(el as HTMLElement).color;
          if (c && c !== "rgba(0, 0, 0, 0)" && c !== "") return c;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Give fetched clones the LIVE page's presentation: text colors measured
   * from page-1 counterparts (matched by structural role), plus promotion
   * of lazy-loaded images so icons/photos fetch immediately instead of
   * waiting for a hydration that never reaches clones.
   * Fetched HTML carries the
   * SERVER-DEFAULT light palette inline (per-result emotion styles — which
   * we strip — plus class rules), while the user's theme (e.g. dark) is
   * applied client-side and never reaches the clones. Measure computed
   * colors from live page-1 results and apply them inline to the appended
   * counterparts, matching by structural role (title link / snippet / url
   * path). Inline values win over any residual class styling, so appended
   * results render in the user's theme by construction.
   */
  private reSkinClones(appended: Element[]): void {
    try {
      // Measure reference colors DIRECTLY from the DOM, NOT via
      // engine.getResultNodes(): the adapter filters out nodes already
      // stamped data-shh-result — which is ALL of page 1 by auto-load
      // time — so that path always yielded zero references and silently
      // disabled the whole re-skin in production.
      const titleSels = ["a.result-title", "a.w-gl__result-title", "a.wgl-site-title", "h2 a[href]", "h3 a[href]", "a.result-link"];
      const snippetSels = ["p.description", "p.desc", ".result-description", "p.w-gl__description", "div.description"];
      // Site-link line: cover the real Startpage anatomy (verified in
      // archived SERP markup: a.wgl-display-url > span.link-text). The tint
      // must land on the span itself — its own class rule (.link-text /
      // default-link-text) sets a color that beats inheritance from the
      // anchor. Specific selectors precede broad catch-alls.
      const pathSels = [
        "a[class*='display-url']", "a.wgl-display-url > span[class*='link-text' i]",
        "[class*='display-url']", "span[class*='link-text' i]",
        "span.result-link-path", "cite", ".result-url", "[class*='url-wrap']",
      ];
      const refTitle = this.measureLiveColor(titleSels);
      const refSnippet = this.measureLiveColor(snippetSels);
      const refPath = this.measureLiveColor(pathSels);
      this.lastRefTitle = refTitle;
      this.lastRefPath = refPath;

      const targets = [...appended];
      // The fetch wrapper itself may be a result-styled host; include it.
      const wrapper = appended[0]?.closest("[data-inf-page]")?.firstElementChild;
      if (wrapper && !targets.includes(wrapper)) targets.push(wrapper);

      for (const node of targets) {
        if (!node.isConnected) continue;
        if (refTitle) {
          for (const el of node.querySelectorAll(titleSels.join(", "))) {
            (el as HTMLElement).style.color = refTitle;
            // The VISIBLE title text usually lives in a styled CHILD
            // (verified 2026 Startpage anatomy: a.result-title >
            // h2.wgl-title, whose own emotion class sets a literal color
            // and whose :visited variant paints it purple). Inline color
            // on the anchor cannot reach it — inheritance loses to the
            // child's own rule — so stamp the heading/span children too.
            for (const t of el.querySelectorAll<HTMLElement>("h1, h2, h3, h4, span")) {
              t.style.color = refTitle;
            }
          }
        }
        if (refSnippet) {
          for (const el of node.querySelectorAll(snippetSels.join(", "))) {
            (el as HTMLElement).style.color = refSnippet;
          }
        }
        if (refPath) {
          for (const el of node.querySelectorAll(pathSels.join(", "))) {
            (el as HTMLElement).style.color = refPath;
          }
        }
        // Favicons: fetched markup references lazy-loaded icon URLs that the
        // live page's hydration normally triggers — clones never get it.
        // Make every icon-bearing element eager so the browser fetches now.
        for (const img of node.querySelectorAll("img")) {
          const lazy = img.getAttribute("loading");
          if (lazy) img.setAttribute("loading", "eager");
          for (const attr of ["data-src", "data-original", "data-lazy-src"]) {
            const v = img.getAttribute(attr);
            if (v && !img.getAttribute("src")) img.setAttribute("src", v);
          }
        }
      }
    } catch { /* re-skinning is cosmetic — never fail the append on it */ }
  }

  /**
   * Harvest per-result emotion CSS: for every <style> inside the clone,
   * find elements the rules match and stamp the NON-palette declarations
   * onto them inline (palette is re-derived from the live page instead).
   * One exception: `background-image` on favicon elements IS the icon
   * itself (Startpage paints favicons as CSS backgrounds on a chip span,
   * not <img>) — preserved so icons render; its chip background-color
   * still gets dropped as theme paint. <style> tags are removed after
   * harvest — nothing fetched enters the document-wide stylesheet pool.
   */
  private harvestFetchedStyles(clone: Element): void {
    try {
      for (const tag of Array.from(clone.querySelectorAll("style"))) {
        let sheet: CSSStyleSheet | null = null;
        try {
          sheet = new CSSStyleSheet();
          sheet.replaceSync(tag.textContent ?? "");
        } catch { sheet = null; }
        if (sheet) {
          for (const rule of sheet.cssRules) {
            this.harvestRule(rule, clone);
          }
        }
        tag.remove();
      }
    } catch { /* harvesting is cosmetic — never fail the append on it */ }
  }

  /** Apply one fetched rule's layout declarations to matching clone nodes. */
  private harvestRule(rule: CSSRule, root: ParentNode): void {
    try {
      if (rule instanceof CSSStyleRule) {
        const sel = rule.selectorText ?? "";
        // Document-level rules have no clone-scoped meaning; skip.
        if (/^(html|body|:root|\*)$/i.test(sel.trim())) return;
        let matched: Element[] | null = null;
        try { matched = Array.from(root.querySelectorAll(sel)); } catch { return; }
        if (!matched || matched.length === 0) return;
        for (const el of matched) {
          const target = el as HTMLElement;
          for (let i = 0; i < rule.style.length; i++) {
            const prop = rule.style.item(i);
            const val = rule.style.getPropertyValue(prop);
            if (!val) continue;
            if (PALETTE_PROPS.test(prop) && !GEOMETRY_EXCEPTIONS.test(prop)) {
              // Favicon exception: background-image on (or under) a
              // favicon element IS the ICON, not theme paint. Real markup:
              // <span class="favicon-container …"><span class="css-hash"
              // style="background-image:url(icon)"> — the class lives on
              // the chip, the paint on the child.
              const paintsFavicon =
                prop === "background-image" &&
                this.isWithinFavicon(target);
              if (paintsFavicon) {
                target.style.setProperty(prop, val);
              }
              continue;
            }
            if (PALETTE_VALUES.test(val)) continue;
            target.style.setProperty(prop, val);
          }
        }
      } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
        // SKIP conditional blocks: harvesting their rules would FLATTEN
        // viewport-dependent styles onto every clone. Verified real case
        // (Startpage): desktop hides the raw URL text via `.css-x{display:
        // none}`, and only `@media (max-width:990px)` re-shows it — with
        // the server-default navy color. Flattened, clones would render
        // the mobile variant on desktop. Top-level rules match the live
        // desktop presentation; conditional variants are dropped.
      }
      // @keyframes/@font-face: animation/transform keyframes are layout-ish;
      // harvest nothing (names may collide document-wide) — clones keep
      // static layout only.
    } catch { /* single rule failing must not kill the harvest */ }
  }

  /**
   * Split an inline style string into declarations WITHOUT breaking values
   * that contain semicolons inside quotes or url(...) parentheses.
   */
  private splitStyleDecls(css: string): string[] {
    const out: string[] = [];
    let cur = "";
    let quote: string | null = null;
    let paren = 0;
    for (const ch of css) {
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
        continue;
      }
      if (ch === "(") paren++;
      if (ch === ")") paren = Math.max(0, paren - 1);
      if (ch === ";" && paren === 0) {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  /**
   * Fetched HTML can carry palette in INLINE style="" attributes too —
   * harvestFetchedStyles only handled <style> tags. Same policy as rule
   * harvesting: drop paint, keep layout, preserve icon backgrounds inside
   * favicon subtrees. Runs BEFORE the clone is adopted into the live
   * document, so no fetched paint can flash on screen.
   */
  private sanitizeInlineStyles(clone: Element): void {
    try {
      const els = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("*"))];
      for (const el of els) {
        if (!(el instanceof HTMLElement)) continue;
        const css = el.getAttribute("style");
        if (!css) continue;
        const kept: string[] = [];
        // Quote/paren-aware split: a naive css.split(";") corrupts values
        // containing semicolons (url(data:...;base64), content:"a;b").
        for (const decl of this.splitStyleDecls(css)) {
          const trimmed = decl.trim();
          if (!trimmed) continue;
          const colon = trimmed.indexOf(":");
          if (colon === -1) continue;
          const prop = trimmed.slice(0, colon).trim();
          const val = trimmed.slice(colon + 1).trim();
          if (!prop || !val) continue;
          if (PALETTE_PROPS.test(prop) && !GEOMETRY_EXCEPTIONS.test(prop)) {
            // Icon backgrounds inside favicon subtrees ARE the icon.
            if (prop === "background-image" && this.isWithinFavicon(el)) kept.push(`${prop}:${val}`);
            continue;
          }
          if (PALETTE_VALUES.test(val)) continue;
          kept.push(`${prop}:${val}`);
        }
        if (kept.length) el.setAttribute("style", kept.join(";"));
        else el.removeAttribute("style");
      }
    } catch { /* cosmetic; never fail the append */ }
  }

  /**
   * Innermost favicon paint targets: elements whose class mentions
   * "favicon" and which contain NO other such element. Selecting every
   * matching ancestor too (a.favicon-link > .favicon-container > .favicon)
   * made an earlier build clear the anchor's content — deleting the whole
   * chip subtree and erasing auto-loaded favicons entirely.
   */
  private getFaviconIconEls(root: ParentNode): HTMLElement[] {
    const all = Array.from(root.querySelectorAll<HTMLElement>('[class*="favicon" i]'));
    return all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
  }

  /**
   * Current-generation Startpage SSR ships the visible URL-line slot
   * (span.link-text inside a.wgl-display-url) EMPTY — hydration normally
   * writes the URL text into it, and clones are never hydrated. Fill that
   * slot ourselves from the anchor's aria-label, and hide the mobile-
   * variant span (default-link-text) whose document-wide class rule paints
   * it navy (#202C46) at narrow viewports.
   */
  private hydrateDisplayUrls(nodes: Element[]): void {
    try {
      for (const node of nodes) {
        const anchors = node.querySelectorAll<HTMLAnchorElement>(
          "a.wgl-display-url, a[class*='display-url']"
        );
        for (const a of anchors) {
          const label = (a.getAttribute("aria-label") ?? "").trim();
          const spans = Array.from(a.querySelectorAll<HTMLElement>("span[class*='link-text' i]"));
          const slot = spans.find((s) => !(s.textContent ?? "").trim());
          if (slot && label) slot.textContent = label;
          for (const s of spans) {
            if (/default-link-text/i.test(s.className)) s.style.display = "none";
          }
        }
      }
    } catch { /* cosmetic; never fail the append */ }
  }

  /** Does this element carry, or live inside, a favicon chip? */
  private isWithinFavicon(el: Element): boolean {
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (/favicon/i.test(cur.className || "")) return true;
      // Stop at the page-container boundary.
      if (cur.hasAttribute("data-inf-page")) break;
    }
    return false;
  }

  /**
   * Paint favicons on clone results. Diagnostics prove Startpage NEVER paints
   * clone icons itself (its loader is hydration-driven, and clones are never
   * hydrated). Paint IMMEDIATELY on the innermost favicon layer
   * (getFaviconIconEls), after CLEARING any letter-avatar content ("D"/"EF").
   * Painting every class-matching ancestor instead made one earlier build
   * wipe the whole chip subtree off the page.
   *
   * Iterate the RESULT NODES (appended), never the page container's
   * children: engines hosting clones in a fetched wrapper (Startpage's
   * div.w-gl) make that container's sole child the WRAPPER — resolving its
   * URL yielded the first result's host, painting every result with the
   * first result's icon (the "EF everywhere" bug).
   *
   * Icon source priority:
   *   1. Live page-1 chip of the SAME destination domain — exact artwork,
   *      first-party URL (built once per append).
   *   2. Icon-endpoint pattern learned from any live chip, {domain}-substituted.
   *   3. DuckDuckGo public icon service (opt-in).
   *   4. NEVER-BLANK guarantee: synthesized monogram — first letter of the
   *      host on a deterministic per-host color. Live evidence shows
   *      Startpage's own hydration can leave even PAGE-1 chips blank
   *      (React #423 partial recovery), so "no source" is a normal state,
   *      not an error: blank white circles are the one unacceptable result.
   */
  private ensureCloneFavicons(appended: Element[]): void {
    try {
      if (appended.length === 0) return;
      this.loadFaviconIntel(false);
      const liveIcons = this.faviconIntel!.map;
      const pattern = this.faviconIntel!.pattern;
      let filled = 0;
      for (const node of appended) {
        try {
          const dest = this.engine.getResultUrl(node);
          if (!dest) continue;
          let host: string;
          try { host = new URL(dest).hostname.replace(/^www\./, ""); } catch { continue; }
          for (const icon of this.getFaviconIconEls(node)) {
            // Harvested inline icon (per-result emotion rules) — done.
            const cur = icon.style.backgroundImage;
            if (cur && cur !== "none") continue;
            const url =
              liveIcons.get(host) ??
              (pattern && pattern.includes("{domain}")
                ? pattern.replace("{domain}", host)
                : null) ??
              // Third-party fallback is OPT-IN (default off): it would tell
              // DuckDuckGo every auto-loaded destination via the URL.
              (this.config.allowThirdPartyIcons
                ? `https://icons.duckduckgo.com/ip3/${host}.ico`
                : null);
            if (url) {
              // Only REAL media children (<img>/<svg>/…) are icons worth
              // preserving. Empty slot elements (<span/> placeholders the
              // SSR ships inside the chip) are NOT icons — treating them
              // as sacred made the guard bail on EVERY chip and paint
              // nothing while the counter lied "filled".
              if (this.hasRealMediaChild(icon)) {
                filled++;
                continue;
              }
              icon.textContent = "";
              icon.style.backgroundImage = `url("${url}")`;
              icon.style.backgroundSize = "contain";
              icon.style.backgroundPosition = "center";
              icon.style.backgroundRepeat = "no-repeat";
              filled++;
            } else {
              this.paintMonogram(icon, host);
              filled++;
            }
          }
        } catch { /* one bad node must not stop the rest */ }
      }
      this.log("favicon fallback filled:", String(filled));
    } catch { /* favicon assignment is cosmetic — never fail the append */ }
  }

  /**
   * Deterministic per-host monogram: hue hashed from the hostname, letter
   * centered on the chip. No network, no privacy exposure, stable across
   * pages — and it guarantees no chip ever ships blank.
   */
  private paintMonogram(icon: HTMLElement, host: string): void {
    let hash = 5381;
    for (let i = 0; i < host.length; i++) hash = ((hash << 5) + hash + host.charCodeAt(i)) | 0;
    const hue = Math.abs(hash) % 360;
    const bg = `hsl(${hue}, 62%, 42%)`;
    const fg = "hsl(0, 0%, 100%)";
    const label = (host.replace(/^www\./, "").split(".")[0] ?? "?").charAt(0).toUpperCase();
    if (this.hasRealMediaChild(icon)) return; // real child markup wins
    icon.textContent = label;
    icon.style.backgroundColor = bg;
    icon.style.color = fg;
    icon.style.display = "flex";
    icon.style.alignItems = "center";
    icon.style.justifyContent = "center";
    icon.style.fontWeight = "700";
    icon.style.fontSize = "12px";
    icon.style.lineHeight = "1";
    icon.style.backgroundImage = "none";
    icon.style.borderRadius = "50%";
  }

  /**
   * Does this chip contain a REAL media element (<img>/<svg>/<canvas>)?
   * Only those count as already-painted icons. The SSR ships EMPTY slot
   * elements (<span/>, empty <div/>) inside chips — treating any element
   * child as "already an icon" made the paint guard skip every chip.
   */
  private hasRealMediaChild(icon: HTMLElement): boolean {
    return icon.querySelector("img, svg, canvas, video") !== null;
  }

  /**
   * Capture page-1 favicon intel (host->icon map + learned URL pattern).
   * Page-1 is immutable ONCE HYDRATED — but hydration can land LONG after
   * our first append (observed live: React #423 recovers by re-rendering
   * the whole root), and the user may never trigger a second append. So an
   * EMPTY capture must be retried on a timer, not just on the next scroll,
   * and already-appended blank chips repainted when intel finally arrives.
   *
   * `repaint` (timer path): walk ALL appended pages and fill any chip the
   * earlier blind pass skipped. Populated snapshots are never re-captured,
   * so steady-state cost stays at zero extra sweeps.
   */
  private loadFaviconIntel(repaint: boolean): void {
    try {
      const wasEmpty =
        !this.faviconIntel ||
        (this.faviconIntel.map.size === 0 && !this.faviconIntel.pattern);
      if (!wasEmpty) return;
      this.faviconIntel = {
        map: this.buildLiveFaviconMap(),
        pattern: this.learnLiveFaviconPattern(),
      };
      const nowFilled =
        this.faviconIntel.map.size > 0 || !!this.faviconIntel.pattern;
      this.log(
        "favicon intel captured:",
        `${this.faviconIntel.map.size} hosts, pattern: ${this.faviconIntel.pattern ? "yes" : "none"}`
      );
      if (!nowFilled) {
        this.faviconRetryCount++;
        if (this.faviconRetryCount <= 6) {
          if (this.faviconRetryTimer) clearTimeout(this.faviconRetryTimer);
          if (!this.destroyed) {
            this.faviconRetryTimer = window.setTimeout(() => {
              this.faviconRetryTimer = null;
              if (!this.destroyed) this.loadFaviconIntel(true);
            }, 1500);
          }
          return;
        }
        // Retries exhausted and page-1 still shows nothing we can read —
        // the markup generation changed. Dump raw chip evidence so the
        // next console log pins the new anatomy exactly.
        try {
          const sample = document.querySelector<HTMLElement>('[class*="favicon" i]');
          const chipHtml =
            sample
              ? (sample.closest("a") ?? sample).outerHTML.slice(0, 1200)
              : "(no [class*=favicon] element found at all)";
          this.log("favicon intel UNAVAILABLE after retries; chip snapshot:", chipHtml);
        } catch { /* diagnostics only */ }
        return;
      }
      if (!repaint) return;
      // Intel just arrived — repaint chips appended while we were blind.
      for (const container of Array.from(this.pageContainers.values())) {
        for (const node of Array.from(container.querySelectorAll("[data-shh-result]"))) {
          try { this.paintResultIcons(node); } catch { /* per-node isolation */ }
        }
      }
    } catch { /* cosmetic — never fail the append */ }
  }

  /** Paint every unpainted favicon chip on ONE result node (pure DOM). */
  private paintResultIcons(node: Element): void {
    const dest = this.engine.getResultUrl(node);
    if (!dest) return;
    let host: string;
    try { host = new URL(dest).hostname.replace(/^www\./, ""); } catch { return; }
    const liveIcons = this.faviconIntel?.map ?? new Map<string, string>();
    const pattern = this.faviconIntel?.pattern ?? null;
    for (const icon of this.getFaviconIconEls(node)) {
      const cur = icon.style.backgroundImage;
      if (cur && cur !== "none") continue;
      const url =
        liveIcons.get(host) ??
        (pattern && pattern.includes("{domain}")
          ? pattern.replace("{domain}", host)
          : null) ??
        (this.config.allowThirdPartyIcons
          ? `https://icons.duckduckgo.com/ip3/${host}.ico`
          : null);
      if (url) {
        if (this.hasRealMediaChild(icon)) continue;
        icon.textContent = "";
        icon.style.backgroundImage = `url("${url}")`;
        icon.style.backgroundSize = "contain";
        icon.style.backgroundPosition = "center";
        icon.style.backgroundRepeat = "no-repeat";
      } else {
        // Never-blank guarantee applies on repaints too.
        this.paintMonogram(icon, host);
      }
    }
  }

  /**
   * Map destination hostname -> rendered icon URL, harvested from LIVE
   * page-1 favicon chips (never from our own appended containers).
   * LAYER-TOLERANT: the icon may sit on ANY favicon-classed element
   * (innermost .favicon in the 2025 build, possibly the container in a
   * later one) or arrive as an <img> inside the chip subtree — harvest
   * whichever layer actually carries it.
   */
  private buildLiveFaviconMap(): Map<string, string> {
    const map = new Map<string, string>();
    try {
      const els = Array.from(document.querySelectorAll<HTMLElement>('[class*="favicon" i]'))
        .filter((el) => !el.closest("[data-inf-page]"));
      for (const el of els) {
        const host = this.hostOfChipResult(el);
        if (!host || map.has(host)) continue;
        const url = this.iconUrlOfChip(el);
        if (url) map.set(host, url);
      }
    } catch { /* ignore */ }
    return map;
  }

  /** Icon URL carried by a chip at any layer: CSS background or inner <img>. */
  private iconUrlOfChip(chip: HTMLElement): string | null {
    const m = /url\((["']?)([^"')]+)\1\)/.exec(
      window.getComputedStyle(chip).backgroundImage
    );
    if (m?.[2]) return m[2];
    const img = chip.matches("img")
      ? (chip as HTMLImageElement)
      : chip.querySelector<HTMLImageElement>("img[src]");
    return img?.src || null;
  }

  /** Destination host of the result a favicon chip belongs to. */
  private hostOfChipResult(chip: HTMLElement): string | null {
    try {
      let cur: Element | null = chip;
      while (cur && !cur.hasAttribute("data-inf-page")) {
        const a = cur.querySelector<HTMLAnchorElement>("a[href]");
        if (a) {
          const href = a.getAttribute("href") ?? "";
          // Shared identity rule (deduper.ts) so dedup hashing and icon
          // provisioning can never disagree about what a result's
          // destination is.
          const unwrapped = unwrapProxyDestination(href, window.location.href);
          if (unwrapped) return new URL(unwrapped).hostname.replace(/^www\./, "");
          try {
            if (/^https?:\/\//i.test(href)) {
              return new URL(href).hostname.replace(/^www\./, "");
            }
          } catch { /* keep climbing */ }
        }
        cur = cur.parentElement;
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Extract the icon-URL template from live page-1 favicon chips: find a
   * first-party startpage.com URL and replace the hostname segment with a
   * {domain} placeholder. Returns null when no usable pattern exists.
   */
  private learnLiveFaviconPattern(): string | null {
    try {
      const els = Array.from(document.querySelectorAll<HTMLElement>('[class*="favicon" i]'))
        .filter((el) => !el.closest("[data-inf-page]"));
      for (const el of els) {
        const url = this.iconUrlOfChip(el);
        if (!url || !/startpage\.com/i.test(url)) continue;
        // The icon endpoint carries the target site in its query/path —
        // templatize any parameter-looking segment.
        const u = url;
        const q = u.indexOf("?");
        if (q !== -1) {
          // e.g. https://www.startpage.com/.../favicon?h=<site>&...
          const candidate = u.replace(/([?&](?:h|domain|host|url)=)[^&"]+/i, "$1{domain}");
          if (candidate === u) continue; // no param matched — try next chip
          // Round-trip validation: the templatized segment must hold a
          // HOSTNAME-shaped value (the observed chip's own destination,
          // e.g. h=efset.org). A base64/path/opaque value would fail this
          // and poison every later substitution with 404s — reject it.
          // (Validating against startpage.com's own host can NEVER pass:
          // the param carries the RESULT's domain, not ours.)
          const rawValue = u.slice(q + 1).match(/(?:^|&)(?:h|domain|host|url)=([^&"]+)/i);
          const val = rawValue?.[1] ?? "";
          let decoded = "";
          try { decoded = decodeURIComponent(val); } catch { decoded = val; }
          const hostShape = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?\/?$/i.test(decoded);
          if (!hostShape) continue; // opaque value — try the next chip
          return candidate;
        }
        // Path-based patterns vary per build — too risky to guess.
        continue;
      }
    } catch { /* ignore */ }
    return null;
  }

  /** Remove pages above the viewport to keep the DOM lean (keep ~5 pages). */
  private discardOldPages(): void {
    if (this.currentPage <= 6) return;
    const cutoffPage = this.currentPage - 6;
    for (const [page, container] of this.pageContainers) {
      if (page > cutoffPage) continue;
      // Check if page is above viewport without forced reflow
      // Use a cached estimate based on scroll position at append time
      const rect = container.getBoundingClientRect();
      if (rect.bottom < -100) {
        container.remove();
        this.pageContainers.delete(page);
      }
    }
  }

  private bindScrollSave(): void {
    window.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("beforeunload", this.saveScrollStateInternal);
    window.addEventListener("pagehide", this.saveScrollStateInternal);
  }

  private onScroll = (): void => {
    if (this.scrollSaveTimer) clearTimeout(this.scrollSaveTimer);
    this.scrollSaveTimer = setTimeout(() => this.saveScrollStateInternal(), 1000);
  };

  private saveScrollStateInternal = (): void => {
    if (!this.config.persist) return;
    saveScrollState({
      url: window.location.href,
      scrollY: window.scrollY,
      loadedUrls: [],
      loadedPages: this.currentPage,
      timestamp: Date.now(),
    });
  };

  private tryRestoreScroll(): void {
    const saved = loadScrollState();
    if (!saved) return;
    if (!isStateFresh(saved, this.config.freshnessMinutes)) {
      clearScrollState();
      return;
    }
    if (saved.url !== window.location.href) return;
    // Only restore on BACK/FORWARD or RELOAD. A fresh navigation (a new
    // search that lands on the same URL) must open at the TOP — restoring
    // here jumped every re-search straight to the bottom of the page.
    const navType = this.getNavigationType();
    if (navType !== "back_forward" && navType !== "reload") {
      clearScrollState();
      return;
    }
    // Only restore if extra pages were loaded — avoids auto-scrolling
    // to the bottom on a fresh first-page visit.
    if (saved.loadedPages <= 1) return;
    // Never clamp-jump: auto-loaded pages are NOT re-fetched on load, so a
    // saved offset beyond the current document height would be clamped by
    // the browser to (bottom of page 1) — the exact "lands at bottom" bug.
    const maxY = document.documentElement.scrollHeight - window.innerHeight;
    if (saved.scrollY > maxY) {
      clearScrollState();
      return;
    }
    // Defer scroll restoration after DOM is stable
    requestAnimationFrame(() => {
      window.scrollTo(0, saved.scrollY);
    });
  }

  /**
   * How did this page load? "back_forward" (history), "reload", or
   * "navigate" (fresh navigation — link, form submit, address bar).
   * Uses Navigation Timing level 2 with the legacy API as fallback.
   */
  private getNavigationType(): string {
    try {
      const timing = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      if (timing?.type) return timing.type;
      const legacy = (
        performance as Performance & { navigation?: { type?: number } }
      ).navigation;
      if (legacy?.type === 2) return "back_forward";
      if (legacy?.type === 1) return "reload";
    } catch { /* ignore */ }
    return "navigate";
  }

  private log(msg: string, data?: unknown): void {
    if (this.config.debugMode) {
      console.log(`[InfiniteScroll] ${msg}`, data ?? "");
    }
  }
}
