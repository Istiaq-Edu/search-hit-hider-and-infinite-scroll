import type { EngineId } from "../../shared/types";

// ============================================================
// EngineAdapter interface — every engine implements this
// ============================================================

export interface EngineAdapter {
  readonly id: EngineId;
  readonly name: string;

  /** Return true if this adapter handles the given URL */
  matches(url: URL): boolean;

  /**
   * Return all result container elements on the current page.
   * Each element is the top-level node that will be hidden/shown.
   */
  getResultNodes(doc: Document): Element[];

  /**
   * Extract the destination URL from a result container.
   * Returns null if extraction fails (skip this node).
   */
  getResultUrl(node: Element): string | null;

  /**
   * Return the element inside the result node where the block button
   * should be inserted next to (usually the title link or heading).
   */
  getButtonTarget(node: Element): Element | null;

  /**
   * MutationObserver options for this engine (for dynamic results).
   * Return null to use the default observer options.
   */
  observerOptions?(): MutationObserverInit;

  /**
   * Optional: called once after the adapter is initialized on a page.
   * Useful for engine-specific CSS injection or deferred scans.
   */
  onInit?(doc: Document): void;

  // ── Infinite scroll (optional) ────────────────────────────────────────

  /** Return the URL for the next page of results (e.g. the "Next" button href), or null. */
  getNextPageUrl?(doc: Document, currentUrl?: string): string | null;

  /** CSS selectors for pagination elements to hide when infinite scroll is active. */
  getPaginationSelectors?(): string[];

  /**
   * Return a unique identifier string for a result node (used for deduplication).
   * Return null to fall back to URL-hash dedup.
   */
  getResultId?(node: Element): string | null;

  /**
   * Return the container element that holds all search results.
   * New pages from infinite scroll are appended into this container.
   * If not provided, the parent of the first result node is used (less reliable).
   */
  getResultsContainer?(doc?: Document): Element | null;

  /**
   * Optional: triggers loading of the next page by interacting with the page
   * (e.g., clicking a "Load More" button in a SPA).  When present, the
   * manager calls this instead of fetch() + getNextPageUrl().
   * The returned promise must resolve when new result nodes appear in the DOM.
   */
  triggerNextPage?(doc: Document): Promise<void>;
}
