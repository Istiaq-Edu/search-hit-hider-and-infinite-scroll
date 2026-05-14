import type { EngineAdapter } from "../engines/base";
import { Sentinel } from "./sentinel";
import { Deduper } from "./deduper";
import { fetchPage } from "./fetcher";
import { saveScrollState, loadScrollState, isStateFresh, clearScrollState, type ScrollState } from "./persist";

export interface InfiniteScrollPrefs {
  threshold: number;
  maxPages: number;
  persist: boolean;
  freshnessMinutes: number;
  fetchDelay: number;
  debugMode: boolean;
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

  private isLoading = false;
  private currentPage = 1;
  private nextUrl: string | null = null;
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
      this.nextUrl = this.engine.getNextPageUrl?.(document) ?? null;
      this.hasMore = !!this.nextUrl;
    }
    this.currentPage = 1;

    if (!this.hasMore) {
      this.log("No next page URL found — infinite scroll not available");
      return;
    }

    this.hidePagination();
    this.createSentinel();
    this.startObserver();
    this.startUrlPolling();
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
  }

  handleNavigation(): void {
    this.log("Navigation detected, resetting");
    this.saveScrollStateInternal();
    this.deduper.reset();
    this.destroy();
    this.currentUrl = window.location.href;
    this.nextUrl = null;
    this.hasMore = true;
    this.isLoading = false;
    this.currentPage = 1;
    this.init();
  }

  // ── Private ─────────────────────────────────────────────────────────────

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

  private createSentinel(): void {
    this.sentinel = new Sentinel(this.container);
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
      this.observer.observe(this.sentinel.element);
    }
  }

  private startUrlPolling(): void {
    this.urlCheckInterval = setInterval(() => {
      if (window.location.href !== this.currentUrl) {
        this.handleNavigation();
      }
    }, 1000);
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
        this.log(`Trigger appended ${deduped.length} items (page ${this.currentPage})`);
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
      const result = await fetchPage(this.nextUrl!, this.abortController.signal, this.config.fetchDelay);
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

      if (deduped.length > 0) {
        this.appendNodes(deduped);
      }

      const fetchedNextUrl = this.engine.getNextPageUrl?.(result.doc);
      this.nextUrl = fetchedNextUrl ?? null;
      this.hasMore = !!this.nextUrl;
      this.currentPage++;

      this.sentinel?.setState(this.hasMore ? "idle" : "done");
      this.log(`Appended ${deduped.length} items (page ${this.currentPage})`);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (this.destroyed) return;
      this.log("Fetch error:", err);
      this.sentinel?.setState("error", () => this.retryFetch());
    } finally {
      this.isLoading = false;
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

  private appendNodes(nodes: Element[]): void {
    const fragment = document.createDocumentFragment();
    const appended: Element[] = [];

    for (const node of nodes) {
      const clone = node.cloneNode(true) as Element;
      clone.setAttribute("data-inf-page", String(this.currentPage));
      fragment.appendChild(clone);
      appended.push(clone);
    }

    this.container.appendChild(fragment);
    this.onNewNodes(appended);
    this.discardOldPages();
  }

  /** Remove pages above the viewport to keep the DOM lean (keep ~5 pages). */
  private discardOldPages(): void {
    if (this.currentPage <= 6) return;
    const cutoffPage = this.currentPage - 6;
    const nodes = this.container.querySelectorAll<HTMLElement>('[data-inf-page]');
    for (const node of nodes) {
      const page = parseInt(node.getAttribute('data-inf-page') ?? '0', 10);
      if (page > cutoffPage) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom < -100) {
        node.remove();
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
