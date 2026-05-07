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
}
