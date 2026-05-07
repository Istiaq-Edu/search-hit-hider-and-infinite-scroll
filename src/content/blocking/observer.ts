// ============================================================
// MutationObserver for infinite scroll / AJAX result loading
// ============================================================

export type NodeHandler = (nodes: Element[]) => void;

export class ResultObserver {
  private observer: MutationObserver | null = null;
  private handler: NodeHandler;
  private ignoreSelectors: string[];

  constructor(handler: NodeHandler, ignoreSelectors: string[] = []) {
    this.handler = handler;
    this.ignoreSelectors = ignoreSelectors;
  }

  start(root: Element = document.body, options?: MutationObserverInit): void {
    if (this.observer) return;

    this.observer = new MutationObserver((mutations) => {
      const newNodes: Element[] = [];

      for (const mutation of mutations) {
        if (mutation.type !== "childList") continue;
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node as Element;
          if (this.shouldIgnore(el)) continue;
          newNodes.push(el);
        }
      }

      if (newNodes.length > 0) {
        this.handler(newNodes);
      }
    });

    this.observer.observe(root, options ?? {
      childList: true,
      subtree: true,
    });
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  private shouldIgnore(el: Element): boolean {
    for (const sel of this.ignoreSelectors) {
      if (el.matches(sel) || el.closest(sel)) return true;
    }
    return false;
  }
}
