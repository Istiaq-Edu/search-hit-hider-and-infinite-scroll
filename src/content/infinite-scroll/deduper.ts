import type { EngineAdapter } from "../engines/base";

/**
 * Unwrap search-engine proxy/redirect wrappers to the real destination:
 * Startpage anonymous-view links hide the target in a `u` query parameter
 * (ixquick-proxy.com/do/spg/highlight.pl?...&u=<dest> and
 * startpage.com/av/proxy?...&u=<dest>). Shared by dedup hashing AND
 * favicon provisioning so the identity rule cannot drift between them.
 * Returns null when href is not a proxy wrapper.
 */
export function unwrapProxyDestination(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    if (
      !/ixquick-proxy\.com$/.test(url.hostname) &&
      !(url.hostname === "startpage.com" || url.hostname.endsWith(".startpage.com"))
    ) {
      return null;
    }
    const u = url.searchParams.get("u");
    if (u && /^https?:\/\//i.test(u)) {
      const dest = new URL(u);
      return dest.toString();
    }
  } catch { /* malformed — not a usable wrapper */ }
  return null;
}

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
    // Hash the DESTINATION URL, not the raw first-anchor href: Startpage
    // wraps destinations in per-request proxy links (ixquick-proxy / av/
    // proxy with volatile params), and hydration rewrites page-1 anchors —
    // same result, different hash, duplicates appended. Unwrapping both
    // sides makes page-1 and fetched copies collide correctly.
    const link = node.querySelector<HTMLAnchorElement>("a[href]");
    const href = link?.getAttribute("href");
    if (href) {
      return simpleHash(this.canonicalizeUrl(href));
    }
    return "";
  }

  /**
   * Reduce a result href to its stable identity: unwrap search-engine
   * proxy/redirect wrappers to the real destination, strip tracking
   * parameters and fragments so hydration rewrites cannot change the hash.
   */
  private canonicalizeUrl(href: string): string {
    try {
      let url = new URL(href, window.location.href);
      const unwrapped = unwrapProxyDestination(href, window.location.href);
      if (unwrapped) {
        try { url = new URL(unwrapped); } catch { /* keep outer */ }
      }
      url.hash = "";
      // Tracking-parameter policy: prefix matches for param FAMILIES
      // (utm_*, ref*), exact matches for specific session tokens
      // (sc — Startpage's per-search token; cat/segment/lui/language are
      // Startpage pager fields that vary per request).
      const TRACKING_PARAM =
        /^(utm_|ref|referrer|sp_|atb)|(?:^)(cat|segment|lui|language|sc)$/i;
      const keep: [string, string][] = [];
      url.searchParams.forEach((v, k) => {
        if (!TRACKING_PARAM.test(k)) {
          keep.push([k, v]);
        }
      });
      url.search = "";
      for (const [k, v] of keep) url.searchParams.append(k, v);
      url.hostname = url.hostname.replace(/^www\./, "");
      return url.toString();
    } catch {
      return href;
    }
  }
}

function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return "h" + Math.abs(hash).toString(36);
}
