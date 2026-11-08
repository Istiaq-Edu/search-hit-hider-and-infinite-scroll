import type { EngineAdapter, PagingStrategy } from "../engines/base";
import { Sentinel } from "./sentinel";
import { Deduper, unwrapProxyDestination } from "./deduper";
import { fetchPage } from "./fetcher";
import { extractFaviconDataAny } from "./favicon-data";
import { saveScrollState, loadScrollState, isStateFresh, clearScrollState, type ScrollState, type SavedPageRequest } from "./persist";
import { revealCoverSubtree } from "../markers";
import {
  delegateNextPage,
  findNativeAdvanceControl,
  findNextPageLink,
  visibleResultCount,
} from "./native-advance";

/**
 * First-party favicon services, per engine. These are hosts the ENGINE
 * ITSELF requests with every result destination when painting page 1 —
 * reusing them for clone chips discloses nothing the engine doesn't
 * already receive. Anything outside this list is treated as third-party
 * (opt-in only). Keyed by engine id; regex-matched against full URLs.
 */
const FIRST_PARTY_FAVICON_SERVICES: Record<string, RegExp[]> = {
  yandex: [/^https:\/\/favicon\.yandex\.(?:com|net|ru)\/favicon\/v2\//i],
  // Google's own icon service: every page-1 result chip already requests
  // gstatic s2 favicons for each destination, so reusing the endpoint for
  // auto-loaded clones discloses nothing the engine doesn't already
  // receive (same argument as Yandex above).
  google: [/^https:\/\/www\.gstatic\.com\/s2\/favicons/i, /^https:\/\/www\.google\.com\/s2\/favicons/i],
  // Bing/DDG/Brave/Baidu: no known first-party favicon endpoint
  // reachable from fetched pages — left empty until field-verified.
};

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
// url( added 2026-09-06 (A4 Q3): a fetched inline style like
// cursor:url(https://attacker/pixel),auto passed BOTH gates (cursor is not a
// palette property; the value has no hex/rgb/gradient) and was ported onto
// clones — a no-consent tracking beacon on hover. The favicon-subtree
// exception in sanitizeInlineStyles/harvestRule still lets legitimate
// url(data:) icon art through.
const PALETTE_VALUES = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\bcolor-scheme\b|gradient\(|\burl\(/i;

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

/** Only "end" is a genuine end of results. The other two are OUR stops. */
type PagingStopReason = "end" | "failed" | "limit";

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
  /** Owns click listeners on pager links; aborted on teardown instead of
   *  cloning anchors (cloning destroyed the engine's own handlers). */
  private pagerAbort: AbortController | null = null;
  private scrollSaveBound = false;

  private isLoading = false;
  /** True while saved pages are being re-fetched; scroll saves are frozen. */
  private isReplaying = false;
  private currentPage = 1;
  /** Requests for pages appended by auto-load, replayed on reload/back so a
   *  persisted deep scroll offset can actually be reached. */
  private loadedRequests: SavedPageRequest[] = [];
  private nextUrl: string | null = null;
  // Engines that paginate via POST (Startpage) supply a request descriptor
  // instead of a plain GET URL; nextUrl is kept in sync for the sentinel state.
  private nextPageRequest: { url: string; init: RequestInit } | null = null;
  private consecutiveEmptyPages = 0;
  private hasMore = true;
  private currentUrl: string;

  private scrollSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private observerDeferTimer: ReturnType<typeof setTimeout> | null = null;
  /** Client-rendered "show more" controls can appear after document_end. */
  private capabilityProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private capabilityProbeAttempts = 0;
  private destroyed = false;
  private isTriggerEngine = false;
  /**
   * Which mechanism produces page N+1 on the CURRENT SERP. Decided per page,
   * not per engine: Yandex serves both a classic pager SERP and a continuous
   * SERP, and the right behaviour is the opposite in each case.
   */
  private strategy: PagingStrategy = "fetch";
  /** "observe": the engine already paginates itself — we must not touch its DOM. */
  private observeOnly = false;
  private consecutiveErrors = 0;
  /** True when paging stopped because the old maxPages limit was reached
   *  (distinguishes it from a genuine end so raising the limit resumes). */
  private stoppedAtMaxPages = false;
  // Generation token for in-flight fetches (B1): destroy() and every new
  // fetchNextPage() bump it, so a stale continuation (jitter sleep outliving
  // an abort, SPA re-search) can never write state — or clear the guard —
  // of the CURRENT fetch. `destroyed` alone cannot express this: init()
  // resets it on the same instance after handleNavigation().
  private fetchEpoch = 0;

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
    // Capability is a property of THIS page, not of the engine. Yandex ships
    // both a classic pager SERP and a continuous SERP; treating them as one
    // strategy is what made the auto-loader unreliable and stranded users.
    this.strategy = this.resolveStrategy();
    this.isTriggerEngine = this.strategy === "native";
    this.observeOnly = this.strategy === "observe";

    if (this.isTriggerEngine) {
      // The engine produces its own next batch; no URL is needed up front.
      this.nextUrl = "trigger://page";
      this.nextPageRequest = null;
      this.hasMore = true;
    } else if (this.observeOnly) {
      this.nextUrl = null;
      this.nextPageRequest = null;
      this.hasMore = false;
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
    this.stoppedAtMaxPages = false;
    // Deliberately NOT reset here: the capability reprobe calls destroy() +
    // init(), and resetting the attempt counter on every init would make the
    // probe loop forever. Only a genuine new search resets it.
    // B2: soft-block strikes must not leak across searches — two errors on
    // SERP A plus one transient null on SERP B would hit the 3-strike stop
    // and kill the new query with no retry button.
    this.consecutiveErrors = 0;

    // B3: arm navigation detection BEFORE the pager-less early return — a
    // manager born on a last page (or a not-yet-rendered pager) must still
    // hear about SPA navigation to a multi-page SERP, or infinite scroll
    // stays dead for the whole document session. Self-cleaning: it removes
    // any previous listener pair first; destroy() tears it down.
    this.startNavigationDetection();

    // Arm the capability reprobe BEFORE the early returns. On a continuous
    // SERP there is no pager link at document_end, so hasMore=false and the
    // old placement (after the early returns) was unreachable — a late-
    // hydrating "show more" control could never be adopted, which is exactly
    // the strand-the-user failure we are fixing.
    if (this.strategy === "fetch") {
      this.armCapabilityReprobe();
    }

    // Seed the deduper with page-1 results for EVERY strategy. The native
    // branch diffs by identity and then filters through the deduper, so an
    // engine that REPLACES its nodes (rather than appending) would otherwise
    // re-emit page 1 as "new" and stack duplicate block buttons.
    try {
      for (const node of this.engine.getResultNodes(document)) {
        this.deduper.isDuplicate(node, this.engine);
      }
    } catch { /* dedupe seeding is best-effort */ }

    // "observe": the engine already paginates itself on scroll. Injecting a
    // sentinel or wrapper divs into its framework-owned results list is what
    // BREAKS that native behaviour. Stay outside the list, never fetch, and
    // still surface a real link in case the engine stops early.
    if (this.observeOnly) {
      // The engine paginates itself. Add OUR fallback only when it exposes
      // neither its own control nor a next link — otherwise this is pure UI
      // noise on a page that already has everything it needs.
      if (!this.pageHasNativeNavigation()) this.createPassiveSentinel();
      return;
    }

    if (!this.hasMore) {
      // FAIL-OPEN: no auto-loading, but never leave the user without a way
      // to reach the next page (this is the exact Yandex failure report).
      // Skipped when the page already shows its own next link.
      if (!findNextPageLink(document, this.engine.getResultNodes(document))) {
        if (this.manualNextUrl()) this.createPassiveSentinel();
      }
      return;
    }

    if (this.isTriggerEngine) {
      // Native delegation needs only a trigger and an observer. No pager
      // hiding, no page markers, no scroll replay, no DOM inside the list.
      this.createSentinel();
      this.startObserver();
      this.log(`Initialized (strategy=native, threshold=${this.config.threshold}, maxPages=${this.config.maxPages})`);
      return;
    }

    this.hidePagination();
    this.markInitialPage();
    this.interceptPagination();

    this.createSentinel();
    this.startObserver();
    this.bindScrollSave();

    if (this.config.persist) {
      this.tryRestoreScroll();
    }

    this.log(`Initialized (threshold=${this.config.threshold}, maxPages=${this.config.maxPages}, persist=${this.config.persist})`);
  }

  destroy(): void {
    this.destroyed = true;
    // A replay's finally is epoch-gated and bails after teardown, so without
    // this reset a SPA navigation mid-replay would leave the flag set forever
    // and writeScrollState() would refuse to save for the whole tab session.
    this.isReplaying = false;
    // destroy() is also called by the capability reprobe's destroy()+init().
    // An in-flight fetch's finally is epoch-gated and will NOT run after the
    // epoch bump, so isLoading must be cleared here or the re-inited session
    // is permanently stuck ("isLoading=true" makes every advance a no-op).
    this.isLoading = false;
    // B1: kill stale fetch continuations even when no re-init follows.
    this.fetchEpoch++;
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
    this.unbindScrollSave();
    if (this.observerDeferTimer) {
      clearTimeout(this.observerDeferTimer);
      this.observerDeferTimer = null;
    }
    if (this.capabilityProbeTimer) {
      clearTimeout(this.capabilityProbeTimer);
      this.capabilityProbeTimer = null;
    }
    if (this.faviconRetryTimer) {
      clearTimeout(this.faviconRetryTimer);
      this.faviconRetryTimer = null;
    }
    // Ported styles and icon intel belong to the old search. Style tags are
    // document-global (their [data-inf-page] scope stays valid but their
    // rules accumulate on every SPA navigation); the icon maps are keyed by
    // the old result hosts. Leaving them made long-lived tabs grow without
    // bound and could paint stale rules onto the next search.
    document.querySelectorAll("style[data-shh-fetched-style]").forEach((s) => s.remove());
    this.portedStyleHashes.clear();
    this.faviconInline.clear();
    this.faviconIntel = null;
    this.tier0SampleLogged = false;
    this.loadedRequests = [];
    // Navigation listeners too (A1 7b): without this, a leaked closure fired
    // on the next popstate/hashchange would call handleNavigation() on this
    // DESTROYED manager — re-initializing infinite scroll the user had just
    // toggled off — and after a later toggle-on, TWO managers would race the
    // same DOM (duplicate sentinels, duplicate appends).
    this.removeNavigationListeners();
    this.removePaginationListeners();
    // Hand the native pager back (S2): destroy() runs on toggle-off and on
    // SPA re-search — in both cases the engine's own pager must reappear so
    // the user can paginate manually. handleNavigation() re-hides it on the
    // fresh results page.
    this.restorePagination();
    this.pageContainers.clear();
  }

  /**
   * Apply live preference changes without tearing the session down.
   * Recreating the manager on every popup keystroke would lose the dedupe
   * set, appended pages, and scroll position.
   */
  updateConfig(prefs: Partial<InfiniteScrollPrefs>): void {
    const prev = this.config;
    this.config = { ...prev, ...prefs };

    if (this.observer && this.sentinel && prev.threshold !== this.config.threshold) {
      this.observer.disconnect();
      this.observer = this.createObserver();
      this.observer.observe(this.sentinel.element);
    }

    if (prev.persist !== this.config.persist) {
      if (this.config.persist) {
        if (this.hasMore) this.bindScrollSave();
      } else {
        this.unbindScrollSave();
        clearScrollState();
      }
    }

    if (this.hasMore && this.currentPage >= this.config.maxPages) {
      this.stoppedAtMaxPages = true;
      this.finishPaging("limit");
    } else if (this.stoppedAtMaxPages && this.currentPage < this.config.maxPages) {
      // maxPages was raised after the auto-loader had already stopped at the
      // old limit: resume (and re-observe so a visible sentinel fires now).
      this.stoppedAtMaxPages = false;
      this.hasMore = true;
      this.sentinel?.setState("idle");
      this.hidePagination();
      if (this.observer && this.sentinel) {
        this.observer.unobserve(this.sentinel.element);
        this.observer.observe(this.sentinel.element);
      }
    }
  }

  private removeNavigationListeners(): void {
    if (this.onNavigate) {
      window.removeEventListener("popstate", this.onNavigate);
      window.removeEventListener("hashchange", this.onNavigate);
      this.onNavigate = null;
    }
  }

  handleNavigation(): void {
    // B6a: location ALREADY points at the new SERP — save under the OLD url
    // (currentUrl is updated only after destroy), or a later reload of the
    // new URL passes the url-match gate with the old session's page count.
    this.writeScrollState(this.currentUrl);
    this.deduper.reset();
    this.destroy();
    this.currentUrl = window.location.href;
    this.nextUrl = null;
    this.nextPageRequest = null;
    this.consecutiveEmptyPages = 0;
    this.hasMore = true;
    this.isLoading = false;
    this.currentPage = 1;
    // A3 F2: a fresh SERP can have favicon chips even when the previous
    // search's captures exhausted the retry budget — without this reset,
    // intel stayed permanently dead for the whole SPA session.
    this.faviconRetryCount = 0;
    this.pageContainers.clear();
    this.capabilityProbeAttempts = 0;
    // New search = new result domains: page-1 icon intel is stale by
    // definition and must be recaptured on the next append.
    this.faviconIntel = null;
    this.init();
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private removePaginationListeners(): void {
    this.pagerAbort?.abort();
    this.pagerAbort = null;
    // Markers are document-wide (the pager can sit outside the results
    // container, e.g. Google's #botstuff), so sweep the whole document.
    document.querySelectorAll("a[data-inf-intercept]").forEach((link) => {
      link.removeAttribute("data-inf-intercept");
    });
  }

  /** Elements the native pager was hiding on — remembered so it can be
   *  restored (S2, 2026-09-06 review): nothing ever un-hid the pager, so
   *  toggling infinite scroll off mid-session (or reaching maxPages) left
   *  the user with NO way to paginate manually until a full reload. */
  private hiddenPagerEls: HTMLElement[] = [];

  private hidePagination(): void {
    const selectors = this.engine.getPaginationSelectors?.();
    if (!selectors) return;
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const html = el as HTMLElement;
        if (!this.hiddenPagerEls.includes(html)) this.hiddenPagerEls.push(html);
        html.style.display = "none";
      }
    }
  }

  /** Restore the native pager (display reversal). Safe when nothing was
   *  hidden — the elements are only cleared by hidePagination itself. */
  private restorePagination(): void {
    for (const el of this.hiddenPagerEls) {
      try { el.style.removeProperty("display"); } catch { /* detached */ }
    }
    this.hiddenPagerEls = [];
    // The pager is visible again: page-number links for pages already in the
    // DOM should scroll to them instead of reloading the SERP.
    this.interceptPagination();
  }

  /**
   * Terminal stop: no further AUTOMATIC pages; hand navigation back.
   *
   * FAIL-OPEN INVARIANT — a stop caused by our own failure (bot gate, rotated
   * class, dead connection, page limit) must never masquerade as "End of
   * results" and must never remove the user's ability to reach page N+1.
   * The engine's own next-page link is therefore rendered on EVERY stop,
   * including the ones where the pager was hidden by the fetch strategy.
   */
  private finishPaging(reason: PagingStopReason = "end"): void {
    this.hasMore = false;
    // A GENUINE end has no next page to offer. Rendering the live page-1
    // pager href there would point at an already-loaded page 2 and make
    // "End of results." unreachable — a regression on every fetch engine.
    this.sentinel?.setManualFallback(reason === "end" ? null : this.manualNextUrl());
    if (reason === "failed") {
      this.showError();
    } else {
      this.sentinel?.setState("done");
    }
    this.restorePagination();
  }

  /** Transient failure states must ALSO carry the manual link, not just the label. */
  private showError(): void {
    this.sentinel?.setManualFallback(this.manualNextUrl());
    this.sentinel?.setState("error", () => this.retryFetch());
  }

  /**
   * A real, engine-owned URL for manual navigation. Never a fetch() input.
   *
   * Order matters: `nextUrl` is the ACTUAL next page (page N+1) advanced after
   * every successful fetch. `getNextPageUrl(document)` reads the LIVE page-1
   * pager, which never advances — using it first produced a link back to an
   * already-loaded page 2. It is only a last-resort fallback.
   */
  private manualNextUrl(): string | null {
    const safe = (u: string | null | undefined): string | null => {
      if (!u) return null;
      try {
        const parsed = new URL(u);
        return /^https?:$/.test(parsed.protocol) ? parsed.toString() : null;
      } catch {
        return null;
      }
    };
    return (
      safe(this.nextUrl) ??
      safe(this.engine.getManualNextPageUrl?.(document, this.currentPage)) ??
      safe(this.engine.getNextPageUrl?.(document)) ??
      // Semantic last resort for engines with no paging API at all: any
      // anchor the page itself labels "next". Never a class-name guess.
      safe(findNextPageLink(document, this.engine.getResultNodes(document))) ??
      null
    );
  }

  /** Does the page already expose its own way forward? */
  private pageHasNativeNavigation(): boolean {
    const results = this.engine.getResultNodes(document);
    return (
      findNativeAdvanceControl(document, results) !== null ||
      findNextPageLink(document, results) !== null
    );
  }

  /**
   * A sentinel that only OFFERS NAVIGATION. Used when the engine already
   * paginates itself, or when auto-loading never started. It is placed AFTER
   * the results container — never as a child of a framework-owned list.
   */
  private createPassiveSentinel(): void {
    if (this.sentinel) return;
    this.sentinel = new Sentinel(this.container);
    this.sentinel.setManualFallback(this.manualNextUrl());
    this.sentinel.setState("manual");
  }

  /**
   * Intercept clicks on page-number links for pages auto-load already
   * appended: scroll to the loaded page instead of navigating away.
   *
   * Scoped to the engine's pagination selectors — the previous document-wide
   * `a[href]` scan plus `parseInt(text)` hijacked ANY link whose text merely
   * STARTED with a digit ("10 best VPNs", "3D printing") and called
   * preventDefault() before checking that a loaded page existed. Listeners
   * live on one AbortController so teardown never has to clone anchors
   * (cloning silently discarded the engine's own click handlers).
   */
  /**
   * Hiding the pager and intercepting its links are different concerns.
   * Engines that keep their pager visible still want numeric links to scroll
   * to an already-loaded page instead of reloading the SERP.
   */
  private paginationInterceptSelectors(): string[] {
    return (
      this.engine.getPaginationInterceptSelectors?.() ??
      this.engine.getPaginationSelectors?.() ??
      []
    );
  }

  private interceptPagination(): void {
    if (this.destroyed) return;
    const selectors = this.paginationInterceptSelectors();
    if (selectors.length === 0) return;
    if (!this.pagerAbort) this.pagerAbort = new AbortController();
    const signal = this.pagerAbort.signal;
    const seen = new Set<Element>();
    for (const sel of selectors) {
      let roots: Element[];
      try {
        roots = Array.from(document.querySelectorAll(sel));
      } catch {
        continue; // engine-supplied selector, but never let a bad one throw
      }
      for (const root of roots) {
        const links = root.matches("a[href]")
          ? [root as HTMLAnchorElement]
          : Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"));
        for (const link of links) {
          if (seen.has(link) || link.hasAttribute("data-inf-intercept")) continue;
          const text = link.textContent?.trim() ?? "";
          if (!/^\d+$/.test(text)) continue;
          const pageNum = Number(text);
          if (pageNum < 2) continue;
          if (!this.container.querySelector(`[data-inf-page="${pageNum}"]`)) continue;
          seen.add(link);
          link.setAttribute("data-inf-intercept", "1");
          link.addEventListener(
            "click",
            (e) => {
              const target = this.container.querySelector<HTMLElement>(
                `[data-inf-page="${pageNum}"]`
              );
              // Page containers get discarded as the session grows; never
              // swallow a click that has nowhere to go.
              if (!target) return;
              e.preventDefault();
              target.scrollIntoView({ behavior: "smooth", block: "start" });
            },
            { signal }
          );
        }
      }
    }
  }

  /** Nearest ancestor of `el` that is a direct child of the results container. */
  private containerChild(el: Element): Element | null {
    let cur: Element = el;
    while (cur.parentElement && cur.parentElement !== this.container) {
      cur = cur.parentElement;
    }
    return cur.parentElement === this.container ? cur : null;
  }

  /**
   * Locate the pager as a direct child of the container, however deep the
   * engine nests it. Required now that pagers stay VISIBLE: fetched pages
   * must land ABOVE them even when the container is a broad fallback like
   * Google's #center_col, where #navcnt sits inside #botstuff.
   */
  private findPagerInContainer(): Element | null {
    const selectors = [
      '#pagination-snippet',
      'nav[role="pagination"]',
      '.pagination',
      ...this.paginationInterceptSelectors(),
    ];
    for (const sel of selectors) {
      let el: Element | null = null;
      try {
        el = this.container.querySelector(sel);
      } catch {
        continue;
      }
      if (!el) continue;
      const child = this.containerChild(el);
      if (child) return child;
    }
    return null;
  }

  private createSentinel(): void {
    if (this.isTriggerEngine) {
      // Native delegation: we are a guest in a framework-owned list. A
      // foreign <div> child (sentinel, page wrapper, page marker) is what
      // breaks the engine's own reconciliation and strands the user. Keep
      // every injected node OUTSIDE the results container.
      this.sentinel = new Sentinel(this.container);
      this.sentinel.setManualFallback(this.manualNextUrl());
      return;
    }
    // Place the spinner directly beneath the streamed results when the
    // engine exposes a pager anchor (Startpage/Bing/Yandex); otherwise
    // after the container, as before.
    let anchor = this.engine.getInsertionAnchor?.(this.container) ?? null;
    // Placement invariant (2026-09-08 Yandex field round): a mid-list anchor
    // puts the spinner — and every page inserted before it — into the middle
    // of the results. Only accept anchors that sit after the last result.
    if (anchor && !this.afterLastResult(anchor)) anchor = null;
    this.sentinel = new Sentinel(this.container, anchor ?? undefined);
  }

  /**
   * True when `ref` sits strictly after the last result the adapter can
   * resolve inside the container. Auto-loaded pages and the spinner must
   * never splice into the middle of the existing result list — a stray
   * in-list "next" control (Yandex's cee continuous-scroll chunk) otherwise
   * hijacks insertion and stacks every fetched page right after the first
   * result card. Unknown container (no results resolvable) → true: keep the
   * engine's own anchor choice, as before.
   */
  private afterLastResult(ref: Element): boolean {
    try {
      const children = Array.from(this.container.children);
      const refIdx = children.indexOf(ref);
      if (refIdx === -1) return false;
      let lastResultIdx = -1;
      for (const node of this.engine.getResultNodes(this.container)) {
        // Our own appended pages hold result-shaped nodes; counting them
        // would reject every anchor after the first append (the newest page
        // becomes the "last result").
        if (node.closest("[data-inf-page]")) continue;
        let cur: Element | null = node;
        while (cur && cur.parentElement !== this.container) cur = cur.parentElement;
        if (!cur) continue;
        const idx = children.indexOf(cur);
        if (idx > lastResultIdx) lastResultIdx = idx;
      }
      return lastResultIdx === -1 || refIdx > lastResultIdx;
    } catch {
      return true; // unreadable — trust the engine's anchor
    }
  }

  private createObserver(): IntersectionObserver {
    return new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void this.fetchNextPage();
        }
      },
      { rootMargin: `${this.config.threshold}px` }
    );
  }

  private startObserver(): void {
    this.observer = this.createObserver();
    if (this.sentinel) {
      // Defer by 2s so the sentinel doesn't fire immediately on short
      // first pages where it's already within the threshold. Tracked (B7):
      // an untracked timer survived destroy() and observed the NEXT
      // session's sentinel early; rapid navigations stacked timers.
      if (this.observerDeferTimer) clearTimeout(this.observerDeferTimer);
      this.observerDeferTimer = setTimeout(() => {
        this.observerDeferTimer = null;
        if (this.observer && this.sentinel) {
          this.observer.observe(this.sentinel.element);
        }
      }, 2000);
    }
  }

  /** Navigation listener retained so destroy() can remove it (A1 finding 7b:
   *  leaked popstate/hashchange closures resurrected infinite scroll after
   *  the user toggled it off and pressed Back — handleNavigation() on a
   *  destroyed manager re-inits it against the user's pref). */
  private onNavigate: (() => void) | null = null;

  private startNavigationDetection(): void {
    // Remove any pair a previous init() on this instance registered —
    // handleNavigation() destroys and re-inits on the SAME object, so a
    // fresh init must never stack a second listener pair.
    this.removeNavigationListeners();
    if (this.urlCheckInterval) {
      clearInterval(this.urlCheckInterval);
      this.urlCheckInterval = null;
    }
    const onUrlChange = (): void => {
      if (window.location.href === this.currentUrl) return;
      // Continuous SERPs pushState a new `p=` as each batch is appended.
      // That is NOT a new search: tearing the session down on every batch
      // would reset currentPage, the deduper and the observer forever.
      if (
        this.strategy !== "fetch" &&
        this.isSameSearch(window.location.href, this.currentUrl)
      ) {
        this.currentUrl = window.location.href;
        return;
      }
      this.handleNavigation();
    };
    this.onNavigate = onUrlChange;
    window.addEventListener("popstate", this.onNavigate);
    window.addEventListener("hashchange", this.onNavigate);
    // Fallback polling for engines that use history.pushState without popstate
    this.urlCheckInterval = setInterval(onUrlChange, 2000);
  }

  /** True when two URLs differ only by a pagination parameter. */
  private isSameSearch(a: string, b: string): boolean {
    try {
      const ua = new URL(a);
      const ub = new URL(b);
      if (ua.origin !== ub.origin || ua.pathname !== ub.pathname) return false;
      const PAGING_PARAMS = ["p", "page", "start", "offset"];
      for (const key of PAGING_PARAMS) {
        ua.searchParams.delete(key);
        ub.searchParams.delete(key);
      }
      ua.hash = "";
      ub.hash = "";
      return ua.toString() === ub.toString();
    } catch {
      return false;
    }
  }

  private async fetchNextPage(): Promise<void> {
    if (this.isLoading || !this.hasMore) return;
    if (!this.isTriggerEngine && !this.nextUrl) return;
    if (this.currentPage >= this.config.maxPages) {
      // Release the native pager (S2): at maxPages the auto-loader stops by
      // design — the user must be able to continue manually from here.
      this.stoppedAtMaxPages = true;
      this.finishPaging("limit");
      return;
    }

    // B1: claim a generation. Every post-await write below (and the finally
    // guard release) applies only while this is still the newest generation.
    const epoch = ++this.fetchEpoch;
    this.isLoading = true;
    this.sentinel?.setState("loading");

    // ── Native delegation (press the engine's own control) ───────────
    if (this.isTriggerEngine) {
      // Identity snapshot, not a count. Engines insert before a pager,
      // re-order the list and replace containers wholesale; slicing by array
      // offset silently reported the wrong nodes in all three cases.
      const baseline = new Set(this.engine.getResultNodes(document));
      this.abortController?.abort();
      this.abortController = new AbortController();
      try {
        // A tight click loop looks like a bot to the engine and re-triggers
        // the very block we are trying to avoid. Back off like the fetch path.
        if (this.consecutiveErrors > 0) {
          await this.nativeBackoff(this.abortController.signal);
        }
        if (epoch !== this.fetchEpoch) return;

        if (this.engine.triggerNextPage) {
          await this.engine.triggerNextPage(document, this.abortController.signal);
        } else {
          // No adapter code required: the shared detector finds the engine's
          // own control and the shared delegate presses it and waits for the
          // ENGINE to render. Re-discover each time — engines replace the
          // control after a batch.
          const control = findNativeAdvanceControl(
            document,
            this.engine.getResultNodes(document)
          );
          if (!control) throw new Error("Native advance control disappeared");
          await delegateNextPage({
            doc: document,
            control,
            count: () => visibleResultCount(this.engine.getResultNodes(document)),
            signal: this.abortController.signal,
          });
        }
        if (epoch !== this.fetchEpoch) return;
        // maxPages is live. updateConfig() may have lowered it (and called
        // finishPaging("limit")) while this advance was in flight; appending
        // now would put a page past the limit the user just chose.
        if (!this.hasMore || this.currentPage >= this.config.maxPages) {
          this.stoppedAtMaxPages = true;
          this.finishPaging("limit");
          return;
        }

        const newNodes = this.engine
          .getResultNodes(document)
          .filter((n) => !baseline.has(n));
        const deduped = newNodes.filter((n) => !this.deduper.isDuplicate(n, this.engine));
        if (deduped.length > 0) this.onNewNodes(deduped);

        this.consecutiveErrors = 0;
        this.currentPage++;

        // Only the adapter knows whether another batch exists. The old
        // hardcoded DuckDuckGo selector made hasMore false after ONE page
        // for every other engine — a dead feature disguised as "end".
        const nativeMore = this.engine.hasNativeNextPage
          ? this.engine.hasNativeNextPage(document)
          : findNativeAdvanceControl(document, this.engine.getResultNodes(document)) !== null;
        this.hasMore = nativeMore && this.currentPage < this.config.maxPages;
        if (!this.hasMore) {
          this.finishPaging(nativeMore ? "limit" : "end");
        } else {
          this.sentinel?.setState("idle");
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (epoch !== this.fetchEpoch) return;
        this.consecutiveErrors++;
        this.log("Native advance failed:", err);
        if (this.consecutiveErrors >= 3) {
          this.finishPaging("failed");
        } else {
          this.showError();
        }
      } finally {
        // Epoch-gated: a stale continuation must not clear the guard of the
        // fetch that the re-initialized session is running right now.
        if (epoch === this.fetchEpoch) this.isLoading = false;
      }
      return;
    }

    // ── Fetch-based (standard URL pagination) ───────────────────────
    this.abortController?.abort();
    this.abortController = new AbortController();

    try {
      // ── Back off after a soft block ────────────────────────────────────
      // Google serves soft blocks as HTTP 200 with a full-size body, so the
      // normal cadence looks like a healthy fetch to the caller and we kept
      // re-requesting immediately — which re-triggers the block. That is why
      // auto-loading stalled instead of recovering (field report 2026-08-30:
      // first fetch came back with no stream at all, the retry succeeded).
      const backoffMs =
        this.consecutiveErrors > 0
          ? this.config.fetchDelay * Math.pow(3, this.consecutiveErrors)
          : this.config.fetchDelay;
      if (backoffMs !== this.config.fetchDelay) {
        this.log(`backing off ${Math.round(backoffMs)}ms after ${this.consecutiveErrors} error(s)`);
      }

      const requestUrl = this.nextUrl!;
      const requestInit = this.nextPageRequest?.init;
      const result = await fetchPage(
        requestUrl,
        this.abortController.signal,
        backoffMs,
        requestInit
      );
      if (epoch !== this.fetchEpoch) return;

      if (!result) {
        this.consecutiveErrors++;
        if (this.consecutiveErrors >= 3) {
          this.log("Too many consecutive errors, stopping");
          this.finishPaging("failed");
        } else {
          this.showError();
        }
        return;
      }
      this.consecutiveErrors = 0;

      const newNodes = this.filterResults(this.engine.getResultNodes(result.doc));
      const rawCount = newNodes.length;
      const deduped = newNodes.filter((n) => !this.deduper.isDuplicate(n, this.engine));

      // maxPages is live: updateConfig() may have lowered it while this
      // request was in flight, and appending here would put a page past the
      // limit the user just chose (and flip the sentinel back to idle after
      // updateConfig already finished paging).
      if (this.currentPage >= this.config.maxPages) {
        this.stoppedAtMaxPages = true;
        this.finishPaging("limit");
        return;
      }

      // Increment BEFORE appending and building the next request: the page
      // container marker and the next page number must both reflect the page
      // that was just fetched (building first, incrementing later produced
      // an off-by-one that re-fetched the same page for POST engines).
      this.currentPage++;

      if (deduped.length > 0) {
        this.appendNodes(deduped, result.doc);
        this.consecutiveEmptyPages = 0;
        this.loadedRequests.push(this.toSavedRequest(requestUrl, requestInit));
        // Appending may leave the pager rendered/visible (engines that keep
        // it); arm scroll-to-page interception for the new containers.
        this.interceptPagination();
      } else {
        // A 200 page with zero extractable results is either a soft block
        // page or a client-hydrated response whose result markup never
        // appears in the raw HTML (Startpage renders results from a JSON
        // hydration payload). Stop after two empties instead of hammering
        // the engine with pointless requests.
        this.consecutiveEmptyPages++;
        // Discriminators (field-log 2026-09-06): "0 extracted" and
        // "all duplicates" are OPPOSITE diagnoses — markup drift vs genuine
        // end / clamped pagination — but the old single message hid which.
        this.log(
          `Fetched page yielded no result nodes (${this.consecutiveEmptyPages}) — ` +
            `extracted=${newNodes.length} of raw=${rawCount}, kept-after-dedupe=0`
        );
      }

      const fetchedReq = this.buildNextPageRequest(result.doc);
      if (fetchedReq) {
        this.nextPageRequest = fetchedReq;
        this.nextUrl = fetchedReq.url;
      } else {
        const fetchedNext = this.engine.getNextPageUrl?.(result.doc) ?? null;
        // An empty-but-shaped page (transient response, or a client-hydrated
        // page whose raw HTML carries no pager) must NOT end the session
        // here: overwriting a known-good nextUrl with null on one bad page
        // permanently killed pagination after a single hiccup (field log
        // 2026-09-06: one "no result nodes" page → hasMore=false forever).
        // Only advance when the fetched doc actually yields a pager.
        if (fetchedNext) {
          this.nextUrl = fetchedNext;
          this.nextPageRequest = null;
        } else if (deduped.length === 0) {
          this.log(
            "empty page carried no pager — keeping previous next URL (transient?)"
          );
        } else {
          // Real results but no pager on the fetched page: genuine end.
          this.nextUrl = null;
          this.nextPageRequest = null;
        }
      }
      // The page limit is live: maxPages can be lowered while this request
      // is in flight (updateConfig finishes paging at the new limit), so the
      // continuation must not append one page past it or flip the sentinel
      // back to idle. Mark the stop so raising maxPages can resume later.
      this.hasMore =
        !!(this.nextPageRequest || this.nextUrl) &&
        this.currentPage < this.config.maxPages;
      if (this.consecutiveEmptyPages >= 2) {
        this.hasMore = false;
      }
      if (
        !this.hasMore &&
        this.currentPage >= this.config.maxPages &&
        (this.nextPageRequest || this.nextUrl)
      ) {
        this.stoppedAtMaxPages = true;
      }

      this.sentinel?.setState(this.hasMore ? "idle" : "done");
      // Session over (genuine end / 2 empties / 3 strikes) → hand pagination
      // back to the engine's native pager (S2). Two empty-but-200 pages is
      // OUR extraction failing, not the engine running out of results.
      if (!this.hasMore) {
        this.finishPaging(this.consecutiveEmptyPages >= 2 ? "failed" : "end");
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (epoch !== this.fetchEpoch) return;
      // Thrown network failures count toward the same 3-strike budget as
      // null results — otherwise a dead connection retries once per
      // sentinel crossing forever (unbounded cycle, no backoff).
      this.consecutiveErrors++;
      this.log("Fetch error:", err);
      if (this.consecutiveErrors >= 3) {
        this.log("Too many consecutive errors, stopping");
        this.finishPaging("failed");
      } else {
        this.showError();
      }
    } finally {
      // Epoch-gated for the same reason as the trigger branch above: a stale
      // continuation must not release the CURRENT fetch's isLoading guard.
      if (epoch === this.fetchEpoch) this.isLoading = false;
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

  /** Serialize a fetch request for scroll-state replay (localStorage-safe). */
  private toSavedRequest(url: string, init?: RequestInit): SavedPageRequest {
    const body = typeof init?.body === "string" ? init.body : undefined;
    return {
      url,
      ...(init?.method === "POST" ? { method: "POST" } : {}),
      ...(body !== undefined ? { body } : {}),
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
      } else if (rule instanceof CSSKeyframesRule) {
        // Global by design — animations have no selectors to scope and are
        // safe outside the container.
        out.push(rule.cssText);
      } else if (rule instanceof CSSFontFaceRule) {
        // @font-face DROPPED (A4 Q3, 2026-09-06): it is global with no
        // selector to scope, and its src:url(...) is a fetch of
        // attacker-controllable origin when the fetched page is hostile.
        // Glyph data could also redraw displayed text. The palette gates
        // exist precisely to keep fetched resources off the live page.
      } else {
        // Anything else (@import, @charset, @namespace, unknown at-rules):
        // DROP. These act document-globally — an @import would fetch remote
        // CSS into the live page unscoped, recreating the exact leak this
        // scoping exists to prevent.
      }
    }
    return out;
  }

  /**
   * Measure the live page's result-card presentation and inline it onto the
   * appended clones (Yandex 2026-09-08: rotated-class builds style cards via
   * wrapper classes the fetched SSR markup doesn't carry).
   *
   * Reference = the live result node with the RICHEST computed presentation
   * (most card-defining properties non-default). The clones' top-level nodes
   * then receive, inline: padding, border-radius, background-color,
   * background-image, box-shadow, border, and margin-bottom (card spacing).
   *
   * Engine-gated: engines whose fetched markup already matches the live
   * stylesheet (same generation — Google, Bing, DDG…) gain nothing, and
   * inlining presentation there could FIGHT live rules. Runs only for yandex.
   */
  private applyLiveCardPresentation(sourceNodes: Element[], resultHost: HTMLElement): void {
    if (sourceNodes.length === 0) return;
    if (this.engine.id !== "yandex") return;
    try {
      const liveResults = this.engine.getResultNodes(this.container).filter(
        (n) => !n.closest("[data-inf-page]")
      );
      if (liveResults.length === 0) return;

      // Pick the reference: the live result with the most non-default
      // card-defining properties (a plain unboxed result scores ~0).
      const CARD_PROPS = [
        "padding-top", "padding-bottom", "padding-left", "padding-right",
        "border-radius", "background-color", "background-image",
        "box-shadow", "border-top-width", "margin-bottom",
      ] as const;
      const score = (el: Element): number => {
        const cs = window.getComputedStyle(el);
        let s = 0;
        if (parseFloat(cs.paddingTop) > 0 || parseFloat(cs.paddingBottom) > 0) s += 2;
        if (cs.borderRadius && cs.borderRadius !== "0px") s += 2;
        const bg = cs.backgroundColor;
        if (bg && !/rgba?\(0,\s*0,\s*0,\s*0\)|transparent/.test(bg)) s += 2;
        if (cs.boxShadow && cs.boxShadow !== "none") s += 3;
        if (parseFloat(cs.marginBottom) > 0) s += 1;
        return s;
      };
      // ── Card-unit resolution (field round 7, 2026-09-09 — cardGap:null) ──
      // The 1.8.17 field receipt came back cardGap:null, and with live
      // results provably resolvable (placement receipt lastResult=14) the
      // ONLY path to null was the old refScore<=2 early return: NO resolved
      // result node carries a card look. On the cee build getResultNodes
      // resolves at the inner content level (div.Organic) while the card BOX
      // lives on the rotated per-result WRAPPER above it — 1.8.16's box
      // transfer AND 1.8.17's gap transfer both measured the wrong DOM level
      // and silently never ran. Resolve each live result to its CARD UNIT:
      // the result itself when it carries the card look, else the nearest
      // ancestor below the container that does — never entering an ancestor
      // that also contains another result (that is a group/section wrapper,
      // not a card).
      const cardUnit = (r: Element): Element => {
        let unit: Element = r;
        while (unit.parentElement && unit.parentElement !== this.container) {
          if (score(unit) >= 2) break;
          const parent = unit.parentElement;
          if (liveResults.some((o) => o !== r && parent.contains(o))) break;
          unit = parent;
        }
        return unit;
      };
      const units = liveResults.map(cardUnit);
      let ref: Element = units[0]!;
      let refScore = -1;
      for (const u of units) {
        const s = score(u);
        if (s > refScore) {
          ref = u;
          refScore = s;
        }
      }
      // NOTE: no early return on refScore<=2 anymore. Even when no unit shows
      // a card look, the inter-card GAP below is still real and must
      // transfer — an unboxed-but-spaced list is the correct rendering there.

      // ── Inter-card gap (field round 6, 2026-09-09) ────────────────────────
      // Boxes transferred fine in 1.8.16 but clones still rendered TOUCHING:
      // on the cee build the card box lives on the result node while the gap
      // lives on its (rotated-class) wrapper — the reference node's own
      // margin-bottom measures 0 and nothing transfers. Never trust a single
      // element's margins for spacing: measure the GEOMETRIC gap between
      // consecutive live result boxes (rect bottom → next rect top), which is
      // correct wherever the live build keeps it (li margin, wrapper margin,
      // or container gap). Median over consecutive pairs, capped to kill
      // layout outliers (sticky headers, interleaved ads).
      const measureCardGap = (): number => {
        // Measure the rendered distance between consecutive CARD UNITS, not
        // raw result nodes — on the cee build the visible boxes are the
        // wrappers, and their content children sit INSIDE those boxes.
        const rects = units
          .map((u) => u.getBoundingClientRect())
          .filter((r) => r.height > 0 && r.bottom > 0);
        if (rects.length < 2) return -1;
        // Compare in document order (getResultNodes order can differ from
        // visual order when the adapter resolves at mixed DOM levels).
        rects.sort((a, b) => a.bottom - b.bottom);
        const gaps: number[] = [];
        for (let i = 1; i < rects.length; i++) {
          const prev = rects[i - 1]!;
          const cur = rects[i]!;
          const gap = cur.top - prev.bottom;
          // Overlap = different visual column or a measured mid-card node —
          // not evidence of spacing; skip rather than pollute the median.
          if (gap >= 0 && gap < 400) gaps.push(gap);
        }
        if (gaps.length === 0) return -1;
        gaps.sort((a, b) => a - b);
        const median = gaps[Math.floor(gaps.length / 2)]!;
        return median > 0 ? Math.round(median * 10) / 10 : -1;
      };
      const geometricGap = measureCardGap();
      // Fallback: the reference node's own margin (1.8.16 behavior) when the
      // geometric probe cannot run (hidden container, jsdom zero-layout) or
      // measures no gap.
      const refMarginBottom = parseFloat(window.getComputedStyle(ref).marginBottom);
      let gapPx = geometricGap;
      let gapSource = "geometric";
      if (gapPx <= 0) {
        gapPx = refMarginBottom > 0 ? refMarginBottom : 0;
        gapSource = "ref-margin";
      }
      this.lastCardGap = { px: gapPx, source: gapSource };

      const cs = window.getComputedStyle(ref);
      const cloned = Array.from(resultHost.children) as HTMLElement[];
      for (const c of cloned) {
        const s = window.getComputedStyle(c);
        // Only dress clones that are NOT already card-styled (fetched markup
        // matching live classes keeps its own rules — never fight them).
        if (score(c) >= 2) continue;
        for (const prop of CARD_PROPS) {
          const val = cs.getPropertyValue(prop);
          if (val && val !== "none" && !/^0(px)?$/.test(val)) {
            c.style.setProperty(prop, val);
          }
        }
        // Live cards separate via margin-bottom; ensure a gap even when the
        // wrapper list resets margins.
        const mb = parseFloat(cs.marginBottom);
        if (mb > 0) c.style.setProperty("margin-bottom", `${mb}px`);
        // Spacing between cloned cards: the measured live gap (or the ref's
        // own margin when geometry was unavailable). Applied even when the
        // card-prop loop skipped margin-bottom (ref margin 0 — the cee case).
        if (gapPx > 0) c.style.setProperty("margin-bottom", `${gapPx}px`);
      }
      // The page container's hardcoded 20px top margin separated an appended
      // page from the page above by a fixed seam regardless of the real card
      // gap. Match the measured gap so consecutive pages read as one stream.
      // Guard: without a fetch wrapper the host's parent is the LIVE results
      // container — never write layout there.
      const pageEl = resultHost.parentElement;
      if (gapPx > 0 && pageEl && pageEl.getAttribute("data-inf-page") !== null) {
        pageEl.style.setProperty("margin-top", `${gapPx}px`);
      }
    } catch {
      /* computed-style probing must never break the append */
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
    // finishPaging() deliberately clears hasMore; a retry must reopen the
    // session, drop the strike budget and re-arm the next URL that a failed
    // fetch may have nulled. Without this the Try Again button was a no-op.
    this.hasMore = true;
    this.consecutiveErrors = 0;
    this.consecutiveEmptyPages = 0;
    this.stoppedAtMaxPages = false;
    if (this.strategy === "fetch" && !this.nextUrl && !this.nextPageRequest) {
      const req = this.buildNextPageRequest(document);
      if (req) {
        this.nextPageRequest = req;
        this.nextUrl = req.url;
      } else {
        this.nextUrl = this.engine.getNextPageUrl?.(document) ?? null;
      }
    }
    if (this.strategy === "fetch") this.hidePagination();
    void this.fetchNextPage();
  }

  /**
   * Re-evaluate capability shortly after init. Content scripts run at
   * document_end, but a SPA may paint its "show more" control later. A
   * strategy chosen too early is a strategy that is wrong for the whole
   * session — the single most common cause of "auto infinite scroll failed
   * and now I can't navigate".
   */
  /**
   * Decide how page N+1 is produced on THIS page.
   *
   * An adapter may declare it explicitly. When it does not, the decision is
   * made from the DOM by ONE shared detector instead of per-engine selector
   * lists — the same capability question has the same answer for every
   * engine, and a new engine needs no paging code at all.
   */
  private resolveStrategy(): PagingStrategy {
    // An explicit declaration is a CONTRACT, not a hint. Yandex returns
    // "fetch" on a classic pager SERP because its own detector said no;
    // overriding that here would call triggerNextPage on a page it already
    // rejected, throw, and burn all three strikes without ever fetching.
    const declared = this.engine.getPagingStrategy?.(document);
    if (declared) return declared;
    // No declaration: the DOM decides, so a new engine needs no paging code.
    try {
      const results = this.engine.getResultNodes(document);
      return findNativeAdvanceControl(document, results) ? "native" : "fetch";
    } catch {
      return "fetch"; // an unreadable DOM must never break init()
    }
  }

  private armCapabilityReprobe(): void {
    if (this.capabilityProbeTimer) clearTimeout(this.capabilityProbeTimer);
    this.capabilityProbeTimer = setTimeout(() => {
      this.capabilityProbeTimer = null;
      if (this.destroyed) return;
      const next = this.resolveStrategy();
      if (next !== "fetch") {
        this.destroy();
        this.currentUrl = window.location.href;
        this.init();
        return;
      }
      if (++this.capabilityProbeAttempts < 5) this.armCapabilityReprobe();
    }, 800);
  }

  /** Abort-aware exponential backoff between native advances. */
  private nativeBackoff(signal: AbortSignal): Promise<void> {
    const ms = Math.min(
      30_000,
      this.config.fetchDelay * Math.pow(3, this.consecutiveErrors)
    );
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      function onAbort(): void {
        clearTimeout(timer);
        resolve();
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Drop pagination elements from an already-resolved result list. */
  private filterResults(results: Element[]): Element[] {
    // Intercept selectors describe where the pager LIVES, which is what we
    // need to drop pager nodes from a fetched page. The hide list may be
    // empty on purpose (fail-open) and would then let pager nodes through.
    const paginationSelectors = this.paginationInterceptSelectors();
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
      // An engine's fetch wrapper can carry an id (Yandex's ul#search-result).
      // Importing it verbatim duplicates the id in the live document —
      // engine JS resolving that id (getElementById/querySelector return the
      // first match, the original, but hash-anchors and strict tooling can
      // still trip). The clone needs the CLASSES for styling context; the
      // id is never functional on a container whose position we control.
      if (wrapClone.id && document.getElementById(wrapClone.id)) {
        wrapClone.removeAttribute("id");
      }
      // A UL/OL wrapper outside the engine's own stylesheet context falls
      // back to BROWSER DEFAULT list styling (bullets + indent) when the
      // live page's list rules are class-scoped and the fetched classes
      // don't match (rotated-class builds). Reset defensively — matching
      // the live list reset (.serp-list_left_yes{list-style:none;margin:0;
      // padding:0} in every captured generation).
      if (wrapClone.tagName === "UL" || wrapClone.tagName === "OL") {
        wrapClone.style.listStyle = "none";
        wrapClone.style.margin = "0";
        wrapClone.style.padding = "0";
      }
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

    // ── Live card-presentation transfer (Yandex 2026-09-08, 5th round) ──────
    // The live SERP styles result cards through wrapper classes that the
    // FETCHED (SSR) page does not share — on rotated-class builds the live
    // stylesheet has no rules for the fetched markup's class names, so clones
    // render as unboxed, unspaced text (field: "not inside its cards or
    // spaced in between results"). PortFetchedStyles is engine-gated to
    // Startpage for a reason (palette safety), so instead MEASURE the live
    // card presentation once per append and inline it: the cloned top-level
    // result nodes get the live padding / radius / background / border /
    // shadow / spacing. Theme-correct by construction, class-agnostic.
    this.applyLiveCardPresentation(nodes, resultHost);

    // Insert before the SENTINEL when it lives inside the container (the
    // spinner then always sits directly beneath the newest results), else
    // before an engine-provided anchor (e.g. a visible pager), else at the
    // end of the results container. The parentNode guards keep insertBefore
    // from throwing on misplaced references.
    const sentinelEl = this.sentinel?.element ?? null;
    let anchor = this.engine.getInsertionAnchor?.(this.container) ?? null;
    // Same placement invariant as createSentinel: an anchor that sits inside
    // the result range would splice fetched pages into the middle of the list
    // (field 2026-09-08: pages + spinner landing right after the FIRST card).
    if (anchor && !this.afterLastResult(anchor)) anchor = null;
    const pagination = anchor ?? this.findPagerInContainer();
    // The generic pagination fallback must ALSO respect the invariant — an
    // in-list element matching ".pagination" is exactly the same hijack.
    const insertRef =
      sentinelEl && sentinelEl.parentNode === this.container && this.afterLastResult(sentinelEl)
        ? sentinelEl
        : pagination && pagination.parentNode === this.container && this.afterLastResult(pagination)
          ? pagination
          : null;
    if (insertRef) {
      this.container.insertBefore(pageContainer, insertRef);
    } else {
      this.container.appendChild(pageContainer);
    }
    // Placement receipt (debug): WHERE the page landed relative to the
    // results — the field report needed exactly this and it was invisible.
    if (this.config.debugMode) {
      const kids = Array.from(this.container.children);
      const idx = kids.indexOf(pageContainer);
      let last = -1;
      try {
        for (const n of this.engine.getResultNodes(this.container)) {
          // Skip results inside page containers we appended ourselves —
          // counting them made the FIRST append always report MID-LIST
          // (the fresh page was its own "last result").
          if (n.closest("[data-inf-page]")) continue;
          let cur: Element | null = n;
          while (cur && cur.parentElement !== this.container) cur = cur.parentElement;
          if (cur) last = Math.max(last, kids.indexOf(cur));
        }
      } catch { /* ignore */ }
      const pos = last === -1 ? "unknown" : idx > last ? "after-results" : "MID-LIST";
      this.log(
        `page placement: index=${idx}/${kids.length} lastResult=${last} → ${pos}` +
          (pos === "MID-LIST" ? " (insertRef was in-list — report this)" : "")
      );
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
    // Re-skin clones with the LIVE page's theme before anything renders
    // (Startpage only — other engines' fetched markup carries its own CSS).
    if (this.config.portFetchedStyles && sourceDoc && appended.length > 0) {
      // Fill the URL-line slot Startpage's hydration normally writes
      // (clones are never hydrated) BEFORE tinting, so the filled span
      // gets the live theme color in the same pass.
      this.hydrateDisplayUrls(appended);
      this.reSkinClones(appended);
    }
    // Favicon provisioning runs for EVERY engine (field evidence Aug 24:
    // Yandex/Bing fetched pages ship favicon chips but no icon art — their
    // hydration never touches our clones). Guards inside keep it safe:
    // tier-0 blob parsing is engine-gated, CSP filtering is engine-gated,
    // and monograms preserve never-blank.
    if (appended.length > 0) {
      this.ensureCloneFavicons(appended, sourceDoc);
    }
    if (this.config.debugMode) {
      const page = appended[0]?.closest("[data-inf-page]") as HTMLElement | null;
      // Engine-aware chip probe: Google's chips are <img>s (s2/favicons or
      // data: art), not [class*=favicon] elements — the old counter read 0
      // on every Google append and looked like total failure.
      const chipSel =
        this.engine.id === "google"
          ? 'img[src*="favicons" i], img[src^="data:image"], img[src="about:blank"], img:not([src])'
          : '[class*="favicon" i]';
      const chips = page?.querySelectorAll(chipSel).length ?? 0;
      const painted =
        this.engine.id === "google"
          ? Array.from(page?.querySelectorAll<HTMLImageElement>(chipSel) ?? [])
              .filter((img) => img.complete && img.naturalWidth > 0 || /^data:/i.test(img.src))
              .length
          : page?.querySelectorAll(
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
        cardGap: this.lastCardGap,
      }));
    }
    this.onNewNodes(appended);

    // ── Reveal safety-net for appended pages (Google) ────────────────────
    // The preload's anti-flicker cover (opacity:0) matches div.g / div.tF2Cxc
    // that carry no marker. tryHide() deliberately leaves section-shaped
    // wrappers (>=2 headings) unstamped — fail-open for HIDING — but that
    // means a fetched page whose results ship inside a tF2Cxc section (the
    // 2026-09-06 q=porn SERP) lands ENTIRELY under the cover. Page 1 has two
    // reveal nets (2s timeout + __shhRevealGoogle); appended pages had NONE:
    // whole pages rendered at opacity:0 forever, sized and painted but
    // invisible (field log 2026-09-06, v1.8.7).
    //
    // Runs AFTER onNewNodes so blocked results already carry data-shh-result
    // (hideResult) and are skipped — only genuinely-unhandled nodes get the
    // ok stamp. Stale-cache directions are safe both ways: the content
    // script's list is authoritative and has already run.
    //
    // The selector and the marker rules are the SHARED definitions from
    // markers.ts, not a third copy of the string. The comment there records
    // what three copies cost the last time they drifted; this call site is now
    // one of its consumers, so a cover change reaches it automatically.
    if (this.engine.id === "google") {
      try {
        revealCoverSubtree(pageContainer);
      } catch { /* cosmetic — never fail the append */ }
    }

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
  /** Last measured live inter-card gap and its source (diagnostics). */
  private lastCardGap: { px: number; source: string } | null = null;

  /**
   * Page-1 favicon intelligence (host->icon map + learned URL pattern),
   * captured on the first append and reused for the session. Cached
   * because page-1 is immutable AND gets discarded after ~6 pages —
   * recomputing per append both wasted cycles and lost the data forever.
   */
  private faviconIntel: { map: Map<string, string>; pattern: string | null } | null = null;

  /**
   * First-party inline icon art (host -> data: URL) parsed from Startpage's
   * SSR JSON state ("faviconData"). Merged into faviconIntel.map at capture
   * time; kept separately so fetched snapshots can extend it per append
   * (each fetched page carries its OWN inline blob with page-2+ hosts).
   */
  private faviconInline: Map<string, string> = new Map();

  /** One-shot guard for the tier-0 empty-sample diagnostic. */
  private tier0SampleLogged = false;

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
   * Innermost favicon paint targets (mutation-proven against the wipe
   * bug): elements whose class mentions "favicon" and which contain NO
   * other such element — the .favicon icon layer, never the a.favicon-
   * link wrapper whose clearing deleted whole chips.
   *
   * ENGINE-AWARE: Google's SERP never uses "favicon" in a class name — its
   * chips are <img> elements (s2/favicons URLs or inline data: art) with
   * rotating hash classes. On Google, the <img> IS the icon layer; when it
   * is missing or dead on a clone, we synthesize a replacement <img> inside
   * the chip's slot so the painter has a target to paint.
   */
  private getFaviconIconEls(root: ParentNode): HTMLElement[] {
    const all = Array.from(root.querySelectorAll<HTMLElement>('[class*="favicon" i]'));
    const innermost = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
    if (this.engine.id !== "google") return innermost;

    // Google: favicon <img>s are the icon layer — first-party s2 URLs,
    // inline data: art, or a blank src (about:blank / none) when the result
    // has no icon. All three are paint targets; discovery is src-shape
    // based, immune to class rotation (XNo5Ab today, hash-du-jour later).
    const imgs = Array.from(root.querySelectorAll<HTMLImageElement>(
      'img[src*="favicons" i], img[src^="data:image"], img[src="about:blank"], img:not([src])'
    ));
    for (const img of imgs) {
      if (!innermost.includes(img)) innermost.push(img);
    }
    return innermost;
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
      // Google chips: the <img> itself is the favicon (s2/favicons or
      // data: art) — no class marker exists.
      if (
        this.engine.id === "google" &&
        cur.tagName === "IMG" &&
        /s2\/favicons/i.test((cur as HTMLImageElement).src || "")
      ) return true;
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
   *   0. First-party inline art from THIS page's SSR JSON ("faviconData",
   *      data: URLs — exact artwork, no network, CSP-proof). Merged into
   *      the session map so later pages can reuse earlier art.
   *   1. Live page-1 chip of the SAME destination domain — exact artwork,
   *      first-party URL (built once per append).
   *   2. Icon-endpoint pattern learned from any live chip, {domain}-substituted.
   *   3. DuckDuckGo public icon service (opt-in; CSP-blocked on Startpage).
   *   4. NEVER-BLANK guarantee: synthesized monogram — first letter of the
   *      host on a deterministic per-host color. Live evidence shows
   *      Startpage's own hydration can leave even PAGE-1 chips blank
   *      (React #423 partial recovery), so "no source" is a normal state,
   *      not an error: blank white circles are the one unacceptable result.
   */
  private ensureCloneFavicons(appended: Element[], sourceDoc?: Document): void {
    try {
      if (appended.length === 0) return;
      this.loadFaviconIntel(false);
      const liveIcons = this.faviconIntel!.map;
      const pattern = this.faviconIntel!.pattern;
      let urlFilled = 0;
      let monograms = 0;
      // Tier 0: this fetched snapshot's own inline blob. Each page carries
      // its OWN hosts' art — exactly the page-2 domains the page-1 intel
      // structurally cannot cover. First record wins across pages.
      if (
        sourceDoc &&
        this.engine.id === "startpage"
      ) {
        try {
          let blobScripts = 0;
          const before = this.faviconInline.size;
          const scriptEls = Array.from(sourceDoc.querySelectorAll("script"));
          for (const el of scriptEls) {
            const txt = el.textContent ?? "";
            if (txt.indexOf("faviconData") === -1 || txt.length >= 3_000_000) continue;
            blobScripts++;
            const r = extractFaviconDataAny(txt);
            for (const [h, u] of r.map) {
              if (!this.faviconInline.has(h)) this.faviconInline.set(h, u);
            }
            if (r.via === "escaped") {
              this.log(
                "tier0 lenient:",
                `escaped-blob parsed, ${r.map.size} entries (${this.faviconInline.size - before} new after dedupe)`
              );
            }
            // Diagnostic: blob present but nothing extracted means the
            // payload SHAPE drifted (nulls, renamed keys). Dump a bounded
            // sample so the next console log pins it without guessing.
            // Deferred to after the loop: an earlier script may parse fine,
            // and a premature EMPTY dump would mislabel the page.
            if (
              this.faviconInline.size === before &&
              !this.tier0SampleLogged &&
              el === scriptEls[scriptEls.length - 1]
            ) {
              this.tier0SampleLogged = true;
              const idx = txt.indexOf("faviconData");
              const occ = txt.split("faviconData").length - 1;
              const datas = txt.split("data:image").length - 1;
              const sample = txt.slice(Math.max(0, idx - 100), idx + 240);
              this.log(
                "tier0 EMPTY sample:",
                `occ=${occ} dataImgs=${datas} …${sample.replace(/\s+/g, " ")}…`
              );
            }
          }
          // Diagnostic: do fetched snapshots still carry the SSR blob at
          // all? (Live page 1 stopped carrying it — inline:0 in field logs.)
          this.log("tier0 scan:", `${blobScripts} fetched scripts contain faviconData, map now ${this.faviconInline.size}`);
        } catch { /* cosmetic — tier simply stays empty */ }
      }
      for (const node of appended) {
        try {
          const dest = this.engine.getResultUrl(node);
          if (!dest) continue;
          let host: string;
          try { host = new URL(dest).hostname.replace(/^www\./, ""); } catch { continue; }
          for (const icon of this.getFaviconIconEls(node)) {
            // ── Google: the chip IS an <img> ─────────────────────────────
            // Google ships favicon art as <img> (s2/favicons or data:), not
            // as background-image spans like Startpage. A loaded img or
            // data: art is already painted; a blank/dead one gets re-pointed
            // at Google's first-party s2 endpoint. Never blank.
            // ENGINE-GATED (A2 F1): Brave's chips are ALSO favicon-classed
            // <img>s (imgs.search.brave.com) — un-gated, this branch
            // re-pointed every page-2+ Brave destination at google.com/s2
            // (privacy leak; CSP-blocked renders blank). Other engines fall
            // through to the background/monogram paths.
            if (icon.tagName === "IMG" && this.engine.id === "google") {
              const img = icon as HTMLImageElement;
              if (img.complete && img.naturalWidth > 0) { urlFilled++; continue; }
              const src = img.src || "";
              if (/^data:/i.test(src)) { urlFilled++; continue; }
              // Already pointed at an icon service (gstatic s2, google s2)?
              // Keep Google's own URL exactly — its params (sz, chl) are
              // Google's, and rewriting them is pointless churn.
              if (/\/s2\/favicons/i.test(src)) { urlFilled++; continue; }
              const s2 =
                this.faviconInline.get(host) ??
                liveIcons.get(host) ??
                `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
              if (src !== s2) img.src = s2;
              urlFilled++;
              continue;
            }
            // Non-Google <img> chips (Brave, others): the img IS the engine's
            // own art — leave the src alone (re-pointing would leak the
            // destination to a third party). Count as painted.
            if (icon.tagName === "IMG") { urlFilled++; continue; }
            // Already REALLY painted? (Placeholder backgrounds — the SSR's
            // self-referential search-page URL — do NOT count: they look
            // painted to a naive check while rendering as garbage.)
            const cur = icon.style.backgroundImage;
            const curUrl = cur && cur !== "none"
              ? (/url\((["']?)([^"')]+)\1\)/.exec(cur)?.[2] ?? null)
              : null;
            if (curUrl && !this.isSelfReferentialIconUrl(curUrl)) {
              urlFilled++;
              continue;
            }
            const url =
              this.faviconInline.get(host) ??
              liveIcons.get(host) ??
              (pattern && pattern.includes("{domain}")
                ? pattern.replace("{domain}", host)
                : null) ??
              // Engine-level first-party fallback: a KNOWN public endpoint
              // of the engine's own icon service, used as an explicit
              // allowlist entry (not learned — Yandex routes its chips
              // through opaque token proxies that cannot be templatized).
              // Same disclosure argument as the allowlist above: the engine
              // already sends every destination to this service on page 1.
              (this.engine.id === "yandex"
                ? `https://favicon.yandex.net/favicon/v2/https://${host}?size=16`
                : null) ??
              // Third-party fallback is OPT-IN (default off): it would tell
              // DuckDuckGo every auto-loaded destination via the URL. It is
              // also force-disabled on Startpage regardless of config: its
              // CSP (img-src 'self' blob: data: *.startpage.com — verified
              // live Aug 2026) blocks the request, and a blocked <img>-less
              // background just renders as an empty chip, silently breaking
              // the never-blank guarantee this painter exists for.
              (this.config.allowThirdPartyIcons && this.engine.id !== "startpage"
                ? `https://icons.duckduckgo.com/ip3/${host}.ico`
                : null);
            if (url) {
              // Only REAL art is worth preserving: vector/canvas media, or
              // an <img> with proven pixels. A DEAD <img> (field evidence:
              // Startpage's own CDN 403s) is removable garbage — clearing
              // it before painting was the missing piece that made the
              // painter skip every chip while counting success.
              if (
                this.hasRealMediaChild(icon) ||
                this.hasLoadedImgChild(icon)
              ) {
                urlFilled++;
                continue;
              }
              icon.textContent = "";
              icon.style.backgroundImage = `url("${url}")`;
              icon.style.backgroundSize = "contain";
              icon.style.backgroundPosition = "center";
              icon.style.backgroundRepeat = "no-repeat";
              urlFilled++;
            } else {
              this.paintMonogram(icon, host);
              monograms++;
            }
          }
        } catch { /* one bad node must not stop the rest */ }
      }
      this.log(
        "favicon paint outcome:",
        `${urlFilled} urls, ${monograms} monograms — ` +
          // Post-paint chip state: catches any pipeline stage that clears
          // inline styles after we paint (the outcome counter lies when the
          // paint is later wiped — faviconsPainted:0 in field logs).
          (() => {
            try {
              const first = appended
                .map((n) => this.getFaviconIconEls(n)[0])
                .find(Boolean);
              if (!first) return "chip: none";
              const cs = window.getComputedStyle(first);
              // Ancestor-opacity check: the chip itself can be display:block
              // while a cover (opacity:0) ancestor makes the whole page
              // invisible — the field probe that lied with visible=true on
              // 2026-09-06. Walk up to the page container boundary.
              let coveredByAncestor = false;
              for (let cur: Element | null = first; cur && !cur.hasAttribute("data-inf-page"); cur = cur.parentElement) {
                const a = window.getComputedStyle(cur);
                if (a.opacity === "0" || a.visibility === "hidden" || a.display === "none") {
                  coveredByAncestor = true;
                  break;
                }
              }
              return `chip: bg=${cs.backgroundImage.slice(0, 60)} size=${cs.width}x${cs.height} visible=${cs.display !== "none" && cs.visibility !== "hidden" && !coveredByAncestor}`;
            } catch { return "chip: ?"; }
          })()
      );
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
    // Remove only CONFIRMED-BROKEN images (complete && naturalWidth === 0 —
    // their src failed; on Startpage that's the CDN AccessDenied class).
    // Still-LOADING images are kept: the letter + background paint
    // underneath, and whichever finishes wins — deleting a pending image
    // destroyed art that was about to arrive (field evidence: Yandex page-2
    // icons load a beat after append). Proven-pixel images / vector media
    // then suppress the visible letter.
    for (const img of Array.from(icon.querySelectorAll("img"))) {
      if (img.complete && img.naturalWidth === 0) img.remove();
    }
    if (this.hasRealMediaChild(icon) || this.hasLoadedImgChild(icon)) return;
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
    return icon.querySelector("svg, canvas, video") !== null;
  }

  /**
   * Does this chip contain an <img> with PROVEN pixels?
   *
   * Field evidence (Aug 24 logs): current-generation chips ship an <img>
   * whose load FAILS (page-1 error{target:img} events; Startpage's own CDN
   * answers AccessDenied). Treating any <img> as "already real art" made
   * the painter skip dead images and count them as painted — outcome said
   * N urls while faviconsPainted stayed 0 and the chip rendered blank.
   * Only complete, dimension-bearing images count now; a broken <img> is
   * removable garbage, not art.
   */
  private hasLoadedImgChild(icon: HTMLElement): boolean {
    const imgs = icon.querySelectorAll("img");
    for (const img of Array.from(imgs)) {
      if (img.complete && img.naturalWidth > 0) return true;
    }
    return false;
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
   *
   * Tier 0 (first-party inline art): Startpage SSR embeds every result's
   * icon as a data: URL ("faviconData") in the page's JSON state — both on
   * live page 1 (read via document) and inside every fetched snapshot we
   * already hold (sourceDoc). Parsing needs no network and no permissions,
   * and data: URLs pass Startpage's CSP (img-src … data:) that blocks every
   * third-party icon service. Page-1 chips are often blank precisely because
   * hydration crashed — the JSON blob survives the crash, so this tier ALSO
   * repairs page-1 blanks via buildLiveFaviconMap below.
   */
  private loadFaviconIntel(repaint: boolean): void {
    try {
      const wasEmpty =
        !this.faviconIntel ||
        (this.faviconIntel.map.size === 0 && !this.faviconIntel.pattern);
      if (!wasEmpty) return;
      let inlineMap = new Map<string, string>();
      let inlineVia: "plain" | "escaped" | "none" = "none";
      try {
        // Live document first (covers page-1 results even when their chips
        // never got painted); fetched snapshots merge in per append.
        for (const el of Array.from(document.querySelectorAll("script"))) {
          const txt = el.textContent ?? "";
          if (txt.indexOf("faviconData") !== -1 && txt.length < 3_000_000) {
            const r = extractFaviconDataAny(txt);
            if (r.map.size > 0) {
              inlineMap = r.map;
              inlineVia = r.via;
              break;
            }
          }
        }
      } catch { /* cosmetic — fall through to chip harvesting */ }
      // MERGE, never assign: faviconInline accumulates art extracted from
      // each fetched snapshot. Assigning here (an earlier draft) wiped the
      // accumulated map on EVERY still-empty-intel recapture (the retry
      // path runs up to 6×), destroying page-2 art before page-3 could
      // reuse it — mutation-caught by the first-snapshot-wins test.
      for (const [h, u] of inlineMap) {
        if (!this.faviconInline.has(h)) this.faviconInline.set(h, u);
      }
      this.faviconIntel = {
        map: this.buildLiveFaviconMap(),
        pattern: this.learnLiveFaviconPattern(),
      };
      if (this.engine.id === "startpage") {
        for (const [h, u] of this.faviconInline) {
          if (!this.faviconIntel.map.has(h)) this.faviconIntel.map.set(h, u);
        }
      }
      // CSP safety net: a URL the page's policy blocks renders as an
      // INVISIBLE failure (no <img> error event for backgrounds), which is
      // exactly how blank chips looked "painted" in earlier rounds. On
      // Startpage only self/data/blob sources may paint (verified header:
      // img-src 'self' blob: data: *.startpage.com); drop anything else
      // from the paint maps and let monograms keep never-blank instead.
      if (this.engine.id === "startpage") {
        for (const [h, u] of Array.from(this.faviconIntel.map)) {
          if (!this.isCspSafeFaviconUrl(u)) this.faviconIntel.map.delete(h);
        }
      }
      const nowFilled =
        this.faviconIntel.map.size > 0 || !!this.faviconIntel.pattern;
      this.log(
        "favicon intel captured:",
        `${this.faviconIntel.map.size} hosts, pattern: ${this.faviconIntel.pattern ? "yes" : "none"}, inline: ${this.faviconInline.size}` +
          (inlineVia === "escaped" ? " (escaped blob)" : "")
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
    const liveIcons = new Map(this.faviconInline);
    for (const [h, u] of this.faviconIntel?.map ?? []) {
      if (!liveIcons.has(h)) liveIcons.set(h, u);
    }
    const pattern = this.faviconIntel?.pattern ?? null;
    for (const icon of this.getFaviconIconEls(node)) {
      // ── Google: chip is an <img> — re-point src, never background ──────
      // ENGINE-GATED like the append-time painter (A2 F1).
      if (icon.tagName === "IMG" && this.engine.id === "google") {
        const img = icon as HTMLImageElement;
        if (img.complete && img.naturalWidth > 0) continue;
        const src = img.src || "";
        if (/^data:/i.test(src)) continue;
        if (/\/s2\/favicons/i.test(src)) continue;
        const s2 =
          liveIcons.get(host) ??
          `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
        if (src !== s2) img.src = s2;
        continue;
      }
      // Non-Google <img> chips: engine's own art — never re-point.
      if (icon.tagName === "IMG") continue;
      // Placeholder backgrounds don't count as painted — same rule as the
      // append-time painter (see ensureCloneFavicons).
      const cur = icon.style.backgroundImage;
      const curUrl = cur && cur !== "none"
        ? (/url\((["']?)([^"')]+)\1\)/.exec(cur)?.[2] ?? null)
        : null;
      if (curUrl && !this.isSelfReferentialIconUrl(curUrl)) continue;
      const url =
        liveIcons.get(host) ??
        (pattern && pattern.includes("{domain}")
          ? pattern.replace("{domain}", host)
          : null) ??
        // Engine-level first-party fallback (mirrors ensureCloneFavicons).
        (this.engine.id === "yandex"
          ? `https://favicon.yandex.net/favicon/v2/https://${host}?size=16`
          : null) ??
        (this.config.allowThirdPartyIcons && this.engine.id !== "startpage"
          ? `https://icons.duckduckgo.com/ip3/${host}.ico`
          : null);
      if (url) {
        // Proven pixels only — a dead <img> is garbage to clear, not art
        // (mirrors the append-time painter; see hasLoadedImgChild).
        if (
          this.hasRealMediaChild(icon) ||
          this.hasLoadedImgChild(icon)
        ) {
          continue;
        }
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
      // Google's chips are favicon <img>s with hash classes — no class
      // mentions "favicon". Harvest them the same way (first-party s2
      // URLs or inline data: art), so appended clones can reuse page-1
      // intel exactly like Startpage.
      if (this.engine.id === "google") {
        els.push(
          ...Array.from(
            document.querySelectorAll<HTMLImageElement>(
              'img[src*="favicons" i], img[src^="data:image"]'
            )
          ).filter((el) => !el.closest("[data-inf-page]"))
        );
      }
      for (const el of els) {
        const host = this.hostOfChipResult(el);
        if (!host || map.has(host)) continue;
        const url = this.iconUrlOfChip(el);
        if (url && !this.isSelfReferentialIconUrl(url)) map.set(host, url);
      }
    } catch { /* ignore */ }
    return map;
  }

  /**
   * Placeholder guard. Unhydrated chips carry the SSR's PLACEHOLDER
   * background — the search page's OWN url (verified in the shipped emotion
   * rule: .css-srotke{background-image:url(<the /sp/search document
   * itself>)}). Harvesting it filled the intel map with 10 hosts of garbage
   * and painted every clone with a stretched search-page image that reads
   * exactly like "no favicon" while the counter said success. A chip URL is
   * self-referential when it resolves to this document's own path (query /
   * hash ignored), or is Startpage's search endpoint on ANY startpage
   * domain (live markup ships it in absolute form).
   */
  private isSelfReferentialIconUrl(raw: string): boolean {
    try {
      const u = new URL(raw, window.location.href);
      const here = new URL(window.location.href);
      if (u.origin === here.origin && u.pathname === here.pathname) return true;
      if (
        /(^|\.)startpage\.com$/i.test(u.hostname) &&
        /\/sp\/search/i.test(u.pathname)
      ) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * CSP paint-safety for Startpage (img-src 'self' blob: data:
   * *.startpage.com — header verified live Aug 2026). data:/blob: always
   * pass; http(s) must be startpage-hosted. Everything else would render
   * as an invisible failure on this engine.
   */
  private isCspSafeFaviconUrl(raw: string): boolean {
    if (/^data:/i.test(raw) || /^blob:/i.test(raw)) return true;
    try {
      const u = new URL(raw, window.location.href);
      return (
        /^https?:$/i.test(u.protocol) &&
        /(^|\.)startpage\.com$/i.test(u.hostname)
      );
    } catch {
      return false;
    }
  }

  /** Icon URL carried by a chip at any layer: CSS background or inner <img>. */
  private iconUrlOfChip(chip: HTMLElement): string | null {
    const m = /url\((["']?)([^"')]+)\1\)/.exec(
      window.getComputedStyle(chip).backgroundImage
    );
    if (m?.[2]) return m[2];
    // Proven pixels only: a dead <img> (Startpage's CDN 403s) must not
    // seed intel with URLs that would paint invisible failures onto
    // clones — the same disease hasLoadedImgChild cures at paint time.
    const imgs = chip.matches("img")
      ? [chip as HTMLImageElement]
      : Array.from(chip.querySelectorAll<HTMLImageElement>("img[src]"));
    for (const img of imgs) {
      if (img.complete && img.naturalWidth > 0 && img.src) return img.src;
    }
    return null;
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
   * Extract the icon-URL template from live page-1 favicon chips.
   *
   * Two accepted shapes, both validated by round-trip (the templatized
   * segment must hold the chip result's own hostname):
   * 1. Query-parameter shape — first-party URL with ?h=<site> / ?url=<site>
   *    etc. (Startpage's endpoint). Restricted to startpage.com hosts.
   * 2. Path-embedded shape — favicon service URLs that embed the RESULT
   *    DESTINATION in the path, e.g. Yandex's
   *    https://favicon.yandex.net/favicon/v2/https://<site>?size=16 .
   *    The destination is a full URL there; the host segment is replaced
   *    with {domain}. Only favicon.* hosts of the CURRENT ENGINE are
   *    trusted (first-party services that already receive every
   *    destination as part of rendering the page — using them adds zero
   *    new disclosure; third-party services stay opt-in/off).
   */
  private learnLiveFaviconPattern(): string | null {
    try {
      const els = Array.from(document.querySelectorAll<HTMLElement>('[class*="favicon" i]'))
        .filter((el) => !el.closest("[data-inf-page]"));
      for (const el of els) {
        const url = this.iconUrlOfChip(el);
        if (!url) continue;
        // The icon endpoint carries the target site in its query/path —
        // templatize any parameter-looking segment.
        const u = url;
        const q = u.indexOf("?");
        if (q !== -1) {
          // e.g. https://www.startpage.com/.../favicon?h=<site>&...
          const candidate = u.replace(/([?&](?:h|domain|host|url)=)[^&"]+/i, "$1{domain}");
          if (candidate !== u && this.patternRoundTripValid(el, u)) {
            return candidate;
          }
          // Path-embedded full-URL destinations:
          //   https://favicon.yandex.net/favicon/v2/https://<site>?size=16
          // First-party only, via an explicit per-engine allowlist of known
          // favicon services. These services sit on sibling domains
          // (favicon.yandex.net vs yandex.com) that suffix matching cannot
          // bridge — and they're first-party because the ENGINE ITSELF sends
          // every destination there when painting page 1, so reusing them
          // discloses nothing new. Anything not on the list stays opt-in/off.
          const pm = /^(https:\/\/favicon\.[a-z0-9.-]+\/(?:[^?"']*\/)*)(https?:\/\/[^/"']+)\?(.*)$/i.exec(u);
          if (pm && pm[2]) {
            try {
              const allowed = FIRST_PARTY_FAVICON_SERVICES[this.engine.id] ?? [];
              const firstParty = allowed.some((re) => re.test(u));
              const destHost = new URL(pm[2]).hostname.replace(/^www\./, "");
              const ownResult = destHost === this.hostOfChipResult(el);
              if (
                firstParty &&
                ownResult &&
                /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(destHost)
              ) {
                // candidate: prefix + {domain} + rest-of-path?query
                return `${pm[1]}{domain}?${pm[3]}`;
              }
            } catch { /* malformed service or destination URL */ }
          }
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Round-trip check for query-shaped patterns: the templatized segment
   * must hold a HOSTNAME-shaped value equal to (or an apex/suffix of) the
   * observed chip's own destination. Opaque values (base64, tokens) fail
   * and poison every later substitution with 404s.
   */
  private patternRoundTripValid(chip: HTMLElement, originalUrl: string): boolean {
    const q = originalUrl.indexOf("?");
    if (q === -1) return false;
    const rawValue = originalUrl.slice(q + 1).match(/(?:^|&)(?:h|domain|host|url)=([^&"]+)/i);
    const val = rawValue?.[1] ?? "";
    let decoded = "";
    try { decoded = decodeURIComponent(val); } catch { decoded = val; }
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?\/?$/i.test(decoded)) return false;
    // The value must match the chip's actual destination (apex-tolerant).
    const dest = this.hostOfChipResult(chip);
    if (!dest) return true; // no anchor available — accept host-shape only
    const d = decoded.replace(/^www\./, "").replace(/\/$/, "").toLowerCase();
    return d === dest || d.endsWith("." + dest) || dest.endsWith("." + d);
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
    if (this.scrollSaveBound) return;
    this.scrollSaveBound = true;
    window.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("beforeunload", this.saveScrollStateInternal);
    window.addEventListener("pagehide", this.saveScrollStateInternal);
  }

  private unbindScrollSave(): void {
    if (this.scrollSaveTimer) {
      clearTimeout(this.scrollSaveTimer);
      this.scrollSaveTimer = null;
    }
    if (!this.scrollSaveBound) return;
    this.scrollSaveBound = false;
    window.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("beforeunload", this.saveScrollStateInternal);
    window.removeEventListener("pagehide", this.saveScrollStateInternal);
  }

  private onScroll = (): void => {
    if (this.scrollSaveTimer) clearTimeout(this.scrollSaveTimer);
    this.scrollSaveTimer = setTimeout(() => this.saveScrollStateInternal(), 1000);
  };

  /** Live saves use the current href; handleNavigation passes the OLD one. */
  private saveScrollStateInternal = (): void => {
    this.writeScrollState(window.location.href);
  };

  private writeScrollState(url: string): void {
    if (!this.config.persist) return;
    // A replay is rebuilding the very pages the record describes. Saving in
    // that window wrote `loadedPages` while `loadedRequests` was still empty
    // (it used to be assigned only after the loop), so the next load took the
    // "legacy state" branch and cleared the record — deep restore worked at
    // most once. Keep the old record until the replay finishes.
    if (this.isReplaying) return;
    // Native/observe strategies cannot replay their loaded content: storing
    // a page count with no requests would restore nothing and then clear the
    // user's state on the next load. The engine owns that content.
    if (this.strategy !== "fetch") return;
    saveScrollState({
      url,
      scrollY: window.scrollY,
      loadedUrls: this.loadedRequests.map((r) => r.url),
      loadedPages: this.currentPage,
      timestamp: Date.now(),
      loadedRequests: this.loadedRequests.map((r) => ({ ...r })),
    });
  }

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
    if (saved.loadedPages <= 1) {
      clearScrollState();
      return;
    }
    // Native restoration succeeds when page 1 alone is tall enough for the
    // saved offset. Deeper offsets need the appended pages back first.
    const maxY = document.documentElement.scrollHeight - window.innerHeight;
    if (saved.scrollY <= maxY) {
      requestAnimationFrame(() => {
        if (this.destroyed) return;
        window.scrollTo(0, saved.scrollY);
      });
      return;
    }
    const requests = saved.loadedRequests ?? [];
    if (requests.length === 0) {
      // Legacy state (saved before requests were recorded) or a trigger
      // engine: replay is impossible. Never clamp-jump to the end of page 1.
      clearScrollState();
      return;
    }
    void this.replayScrollState(saved, requests);
  }

  /**
   * Re-fetch the auto-loaded pages recorded in the saved state, then restore
   * the scroll offset. Runs before the sentinel's first observation and
   * holds isLoading so no concurrent auto-fetch can interleave.
   */
  private async replayScrollState(
    saved: ScrollState,
    requests: SavedPageRequest[]
  ): Promise<void> {
    const epoch = ++this.fetchEpoch;
    this.isReplaying = true;
    this.isLoading = true;
    this.sentinel?.setState("loading");
    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const cap = Math.max(0, Math.min(requests.length, this.config.maxPages - 1));
    this.loadedRequests = [];

    try {
      for (let i = 0; i < cap; i++) {
        if (this.destroyed || epoch !== this.fetchEpoch) return;
        // maxPages is live (updateConfig can lower it mid-replay): never
        // restore more pages than the current limit allows.
        if (this.currentPage >= this.config.maxPages) {
          this.stoppedAtMaxPages = true;
          break;
        }
        const req = requests[i];
        if (!req) break;
        // The scroll record lives in PAGE-origin localStorage, so a script on
        // the search engine can rewrite it. Only replay requests this engine
        // could have produced; otherwise a poisoned record becomes a
        // credentialed fetch (or an arbitrary POST body) against any host the
        // extension has permissions for.
        if (!this.isReplayableRequest(req)) {
          this.log("Ignoring unreplayable saved request", req.url);
          break;
        }

        let result: Awaited<ReturnType<typeof fetchPage>> = null;
        try {
          result = await fetchPage(
            req.url,
            signal,
            i === 0 ? 0 : this.config.fetchDelay,
            this.savedRequestInit(req)
          );
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          break;
        }
        if (!result || this.destroyed || epoch !== this.fetchEpoch) break;

        // Post-fetch work is inside the same guard as the normal path. This
        // promise is fire-and-forgotten, so one throwing engine call used to
        // reject silently and leave `isLoading` true for the rest of the
        // session: the sentinel stayed on "Loading more results…" with no
        // retry control.
        try {
          const nodes = this.filterResults(this.engine.getResultNodes(result.doc));
          const deduped = nodes.filter((n) => !this.deduper.isDuplicate(n, this.engine));
          this.currentPage++;
          if (deduped.length > 0) {
            this.appendNodes(deduped, result.doc);
            this.interceptPagination();
            this.loadedRequests.push({ ...req });
          }
          // Keep nextUrl aligned with the deepest page actually restored; a
          // failure part-way leaves the previous page's link, which points at
          // exactly the next page to fetch.
          const nextReq = this.buildNextPageRequest(result.doc);
          if (nextReq) {
            this.nextPageRequest = nextReq;
            this.nextUrl = nextReq.url;
          } else {
            this.nextPageRequest = null;
            this.nextUrl = this.engine.getNextPageUrl?.(result.doc) ?? null;
          }
        } catch (err) {
          this.log("Replay page could not be applied:", err);
          break;
        }

        // Enough height to cover the saved offset: further pages are pure
        // network cost. Measured AFTER the append, so it reflects the DOM.
        if (document.documentElement.scrollHeight >= saved.scrollY + window.innerHeight) {
          break;
        }
      }
    } finally {
      // Release OUR replay flag even on the early-return paths. Only touch it
      // when no newer replay superseded this one, so a stale replay cannot
      // clear the flag of the fetch that replaced it. destroy() also resets
      // it, because teardown bumps the epoch before this finally runs.
      if (epoch === this.fetchEpoch) this.isReplaying = false;
      // Every other session-visible flag is released here, including after a
      // throw. Epoch-gated like the normal path: a stale replay must not
      // clear the state of the fetch that superseded it.
      if (this.destroyed || epoch !== this.fetchEpoch) return;
      this.hasMore =
        !!(this.nextUrl || this.nextPageRequest) &&
        this.currentPage < this.config.maxPages;
      this.sentinel?.setState(this.hasMore ? "idle" : "done");
      if (!this.hasMore) this.restorePagination();
      this.isLoading = false;

      requestAnimationFrame(() => {
        if (this.destroyed || epoch !== this.fetchEpoch) return;
        const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        window.scrollTo(0, Math.min(saved.scrollY, maxY));
      });
    }
  }

  /**
   * A saved request is only replayable when it targets this engine over
   * http(s), uses a method this extension emits, and carries a bounded body.
   * `_shh_*` scroll state is page-origin and therefore untrusted input.
   */
  private isReplayableRequest(req: SavedPageRequest): boolean {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return false;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (req.method !== undefined && req.method !== "GET" && req.method !== "POST") {
      return false;
    }
    if (req.body !== undefined && req.body.length > 8192) return false;
    try {
      return this.engine.matches(url);
    } catch {
      return false;
    }
  }

  /** Rebuild the fetch init for a saved replay request (POST engines). */
  private savedRequestInit(req: SavedPageRequest): RequestInit | undefined {
    if (req.method !== "POST") return undefined;
    return {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      ...(req.body !== undefined ? { body: req.body } : {}),
    };
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
