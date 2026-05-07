import type { BlockEntry, BlockMode } from "../../shared/types";
import { normalizeDomain, getRootDomain, toASCIIDomain } from "../../shared/domain-utils";

// ============================================================
// O(1) domain matcher using indexed Sets
// ============================================================

export interface MatchResult {
  matched: boolean;
  mode: BlockMode;
  domain: string;
}

export class DomainMatcher {
  private blockSet: Map<string, BlockEntry> = new Map();
  private pbanSet: Map<string, BlockEntry> = new Map();
  private subdomainWildcard: boolean;

  constructor(entries: BlockEntry[], subdomainWildcard = true) {
    this.subdomainWildcard = subdomainWildcard;
    this.rebuild(entries);
  }

  rebuild(entries: BlockEntry[]): void {
    this.blockSet.clear();
    this.pbanSet.clear();
    for (const entry of entries) {
      if (!entry.enabled) continue;
      const key = normalizeDomain(entry.domain);
      if (entry.mode === "pban") {
        this.pbanSet.set(key, entry);
      } else {
        this.blockSet.set(key, entry);
      }
    }
  }

  match(url: string): MatchResult {
    const hostname = this.extractHost(url);
    if (!hostname) return { matched: false, mode: "block", domain: "" };

    // Check perma-ban first (higher priority)
    const pbanResult = this.checkSet(hostname, this.pbanSet);
    if (pbanResult) {
      return { matched: true, mode: "pban", domain: pbanResult.domain };
    }

    // Check regular block
    const blockResult = this.checkSet(hostname, this.blockSet);
    if (blockResult) {
      return { matched: true, mode: "block", domain: blockResult.domain };
    }

    return { matched: false, mode: "block", domain: "" };
  }

  private checkSet(
    hostname: string,
    set: Map<string, BlockEntry>
  ): BlockEntry | null {
    const normalized = normalizeDomain(hostname, true);
    const ascii = toASCIIDomain(normalized);

    // Direct match
    if (set.has(normalized)) return set.get(normalized) ?? null;
    if (ascii !== normalized && set.has(ascii)) return set.get(ascii) ?? null;

    if (!this.subdomainWildcard) return null;

    // Walk up the domain hierarchy
    let current = normalized;
    while (current.includes(".")) {
      const dotIdx = current.indexOf(".");
      current = current.slice(dotIdx + 1);
      if (set.has(current)) return set.get(current) ?? null;
      const asciiCurrent = toASCIIDomain(current);
      if (asciiCurrent !== current && set.has(asciiCurrent)) {
        return set.get(asciiCurrent) ?? null;
      }
    }

    // Also try root domain (PSL-aware)
    const root = getRootDomain(normalized);
    if (root !== normalized && set.has(root)) return set.get(root) ?? null;

    return null;
  }

  private extractHost(url: string): string {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      const m = url.match(/^(?:https?|ftp):\/\/([^/?#]+)/i);
      return m?.[1]?.split(":")?.[0]?.toLowerCase() ?? "";
    }
  }

  get size(): number {
    return this.blockSet.size + this.pbanSet.size;
  }
}
