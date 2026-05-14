import type { EngineAdapter } from "../engines/base";

export class Deduper {
  private seen: Set<string>;

  constructor() {
    this.seen = new Set();
  }

  isDuplicate(node: Element, engine: EngineAdapter): boolean {
    const id = this.getNodeId(node, engine);
    if (!id) return false;
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    return false;
  }

  reset(): void {
    this.seen.clear();
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
