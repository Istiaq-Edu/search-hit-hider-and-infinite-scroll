import type { EngineAdapter } from "../engines/base";

export class Deduper {
  private seen: Set<string>;
  private insertionOrder: string[];
  private readonly MAX_SIZE = 500;
  private readonly EVICT_COUNT = 125;

  constructor() {
    this.seen = new Set();
    this.insertionOrder = [];
  }

  isDuplicate(node: Element, engine: EngineAdapter): boolean {
    const id = this.getNodeId(node, engine);
    if (!id) return false;
    if (this.seen.has(id)) return true;

    // Evict oldest entries if at capacity
    if (this.seen.size >= this.MAX_SIZE) {
      for (let i = 0; i < this.EVICT_COUNT; i++) {
        const oldest = this.insertionOrder.shift();
        if (oldest) this.seen.delete(oldest);
      }
    }

    this.seen.add(id);
    this.insertionOrder.push(id);
    return false;
  }

  reset(): void {
    this.seen.clear();
    this.insertionOrder = [];
  }

  get size(): number {
    return this.seen.size;
  }

  private getNodeId(node: Element, engine: EngineAdapter): string {
    if (engine.getResultId) {
      const attrId = engine.getResultId(node);
      if (attrId) return attrId;
    }
    const link = node.querySelector<HTMLAnchorElement>("a[href]");
    if (link?.href) {
      return simpleHash(link.href);
    }
    return "";
  }
}

function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return "h" + Math.abs(hash).toString(36);
}
