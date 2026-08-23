import type { EngineAdapter } from "../engines/base";
import { Sentinel } from "./sentinel";
import { Deduper } from "./deduper";
import { fetchPage } from "./fetcher";
import { saveScrollState, loadScrollState, isStateFresh, clearScrollState, type ScrollState } from "./persist";

// Inline CSS properties that truncate text in server-rendered HTML from SPAs.
// Stripped from fetched nodes before appending to the live DOM.
const TRUNCATION_PROPS = [
  '-webkit-line-clamp', 'line-clamp',
  'text-overflow',
  'overflow', 'overflow-x', 'overflow-y',
];

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
      this.log("Fetch error:", err);
      this.sentinel?.setState("error", () => this.retryFetch());
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
   * Copy a fetched page's <style> rules into the appended container so its
   * class-based styling (emotion css-* hashes) resolves. Rules are FILTERED:
   * document-level selectors (html/body/:root/*) are dropped — the fetched
   * page's theme can differ from the live one (server default vs. user
   * preference), and porting them would recolor results to the wrong theme.
   * Only class/element-scoped rules survive. Duplicates (live or earlier
   * pages) are skipped; injected tags carry data-shh-fetched-style.
   */
  private portStyles(sourceDoc: Document, pageContainer: HTMLElement): void {
    try {
      const liveTexts = new Set<string>();
      for (const s of document.querySelectorAll("style")) {
        const t = (s.textContent ?? "").trim();
        if (t) liveTexts.add(t);
      }
      for (const s of sourceDoc.querySelectorAll("style")) {
        const t = (s.textContent ?? "").trim();
        if (!t || liveTexts.has(t) || this.portedStyleHashes.has(t)) continue;
        const filtered = this.filterDocumentScopedRules(t);
        if (!filtered) continue;
        this.portedStyleHashes.add(t);
        const style = document.createElement("style");
        style.setAttribute("data-shh-fetched-style", "true");
        style.textContent = filtered;
        pageContainer.appendChild(style);
      }
    } catch { /* styling is cosmetic — never fail the append on it */ }
  }

  /** Drop rules that style the whole document (theme fights); keep the rest. */
  private filterDocumentScopedRules(cssText: string): string | null {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText);
      const kept: string[] = [];
      for (const rule of sheet.cssRules) {
        const sel = (rule as CSSStyleRule).selectorText ?? "";
        if (/^\s*(html|body|:root|\*|\*,)\b/i.test(sel) || /^\s*(html|body|:root)\b/i.test(sel)) {
          continue; // document-level theme rule — the live page already has one
        }
        kept.push(rule.cssText);
      }
      return kept.length > 0 ? kept.join("\n") : null;
    } catch {
      return cssText; // unparsable — port as-is rather than losing styling
    }
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
      clone.querySelectorAll("script").forEach((s) => s.remove());
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
    // SSR markup can carry class names the live page never defines.
    if (this.config.portFetchedStyles && sourceDoc) {
      this.portStyles(sourceDoc, pageContainer);
    }

    // Report the individual result nodes (not the wrapper) so the blocking
    // pipeline keeps per-result hiding granularity.
    const appended = Array.from(resultHost.children) as Element[];
    this.onNewNodes(appended);
    this.interceptPagination();
    // Track page container for efficient discard
    this.pageContainers.set(this.currentPage, pageContainer);
    this.discardOldPages();
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
    // Only restore scroll if extra pages were loaded — avoids auto-scrolling
    // to the bottom on a fresh first-page visit.
    if (saved.loadedPages <= 1) return;

    // Defer scroll restoration after DOM is stable
    requestAnimationFrame(() => {
      window.scrollTo(0, saved.scrollY);
    });
  }

  private log(msg: string, data?: unknown): void {
    if (this.config.debugMode) {
      console.log(`[InfiniteScroll] ${msg}`, data ?? "");
    }
  }
}
