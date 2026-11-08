import type { EngineId } from "../../shared/types";

// ============================================================
// EngineAdapter interface — every engine implements this
// ============================================================

export type PagingStrategy = "native" | "observe" | "fetch";

export interface EngineAdapter {
  readonly id: EngineId;
  readonly name: string;

  /** Return true if this adapter handles the given URL */
  matches(url: URL): boolean;

  /**
   * Return all result container elements.
   * Each element is the top-level node that will be hidden/shown.
   *
   * `doc` is a Document on the full-page scan but an ELEMENT on the observer
   * path, which hands us the raw node that was just added. The type says so
   * instead of casting at the call site: an adapter must be able to answer
   * "which results are in here?" for a subtree, and an adapter that resolves
   * its stream by ID (Google: #rso) simply cannot — which is exactly why the
   * caller needs the container guards in blocking/dedupe.ts.
   */
  getResultNodes(doc: Document | Element): Element[];

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

  /**
   * How page N+1 is produced on THIS page.
   *
   * The SERP is owned by the engine's JavaScript runtime. A document we fetch
   * ourselves is a second, dead document: no hydration, no session tokens, no
   * stylesheet lineage. Cloning its nodes into the live page means emulating
   * the engine's renderer — which is why the fetch strategy needs thousands of
   * lines of CSS archaeology and still breaks on every markup rotation.
   *
   *   "native"  — the engine has its own "show more" control; press it and let
   *               the engine fetch, render and style the new results.
   *   "observe" — the engine already auto-loads on scroll; stay out of its DOM
   *               entirely. Our job is to not break it.
   *   "fetch"   — legacy fallback for static SSR pages with no in-page runtime.
   *
   * Default "fetch" preserves the behaviour of every adapter that predates
   * this contract.
   */
  getPagingStrategy?(doc: Document): PagingStrategy;

  /**
   * Native strategies only: is there still another batch available from the
   * engine's own control? The manager must never hardcode another engine's
   * selectors to answer this.
   */
  hasNativeNextPage?(doc: Document): boolean;

  /** Return the URL for the next page of results (e.g. the "Next" button href), or null. */
  getNextPageUrl?(doc: Document, currentUrl?: string): string | null;

  /**
   * Fail-open escape hatch: a real, engine-owned URL the user can click when
   * automatic loading has stopped. Unlike getNextPageUrl (which is a FETCH
   * input and may be bot-gated), this one is only ever used as a normal link.
   * Engines with client-driven paging should derive it from the search URL.
   */
  getManualNextPageUrl?(doc: Document, pageNo?: number): string | null;

  /**
   * Optional: return a wrapper element from a FETCHED doc that fetched result
   * nodes should be appended inside. The manager shallow-clones it (keeping
   * classes/attributes for styling context — e.g. Startpage's emotion rules
   * are ancestor-scoped) and places the cloned result nodes within. Return
   * null for the default plain page container.
   */
  getFetchWrapper?(doc: Document): Element | null;

  /**
   * Optional: return a full request descriptor for the next page instead of
   * a plain GET URL — for engines whose pagination requires POST form data
   * with a session token (Startpage's `sc`). `pageNo` is the 1-based number
   * of the page being fetched. Return null to fall back to getNextPageUrl /
   * end of results.
   */
  getNextPageRequest?(doc: Document, pageNo: number): { url: string; method: "POST"; body: Record<string, string> } | null;

  /** CSS selectors for pagination elements to hide when infinite scroll is active. */
  getPaginationSelectors?(): string[];

  /**
   * Return the element that fetched pages should be inserted BEFORE —
   * typically the visible pagination block. Must be a descendant of
   * `container`. Return null to use the generic pagination selectors /
   * append-at-end fallback. Used by engines that keep their pager visible
   * (e.g. Yandex) so auto-loaded results land above it, not below.
   */
  getInsertionAnchor?(container: Element): Element | null;

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
   * Primary operation for the "native" strategy: make the PAGE ITSELF produce
   * the next batch by pressing its own control. No fetch(), no DOMParser, no
   * node cloning — the engine renders and styles its own results.
   *
   * The returned promise MUST resolve only once new result nodes exist in the
   * live document (observe the DOM, don't sleep a fixed duration). Reject to
   * signal a failed advance; the manager then backs off and, if the failures
   * are terminal, leaves the engine's native controls intact and visible.
   *
   * `signal` is owned by the manager. Implementations MUST forward it to any
   * wait loop so destroy()/navigation can cancel an in-flight advance instead
   * of leaving a 10-second observer/interval running against a torn-down DOM.
   */
  triggerNextPage?(doc: Document, signal?: AbortSignal): Promise<void>;
}
