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
  private stripWww: boolean;
  private cache = new Map<string, MatchResult>();
  private readonly CACHE_MAX = 1000;

  constructor(entries: BlockEntry[], subdomainWildcard = true, stripWww = true) {
    this.subdomainWildcard = subdomainWildcard;
    this.stripWww = stripWww;
    this.rebuild(entries);
  }

  rebuild(entries: BlockEntry[]): void {
    this.blockSet.clear();
    this.pbanSet.clear();
    this.cache.clear();
    for (const entry of entries) {
      if (!entry.enabled) continue;
      // Store keys in ASCII (punycode) form: hostnames extracted from URLs are
      // always ASCII, so a unicode-typed entry (münchen.de) would otherwise
      // never match its punycode form (xn--mnchen-3ya.de).
      //
      // The entry is normalized with the LIVE preference, exactly like the
      // preload's `toCacheDomain(raw, stripWww)`. Hard-coding `false` here made
      // the two layers disagree whenever an entry carried a `www.` label
      // (legacy data, or an import made while the preference was off): the
      // preload stripped it and pre-hid the bare host, while this matcher kept
      // it exact and then revealed that host at idle — a flash, an Unblock
      // control for a domain the list does not match, and a lost pre-paint
      // block for the www host. With stripping ON, an entry and a host with
      // `www.` are aliases; with it OFF, the label stays significant.
      const key = toASCIIDomain(normalizeDomain(entry.domain, this.stripWww));
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

    // Check cache first
    const cached = this.cache.get(hostname);
    if (cached) return cached;

    // Check perma-ban first (higher priority)
    const pbanResult = this.checkSet(hostname, this.pbanSet);
    if (pbanResult) {
      const result = { matched: true, mode: "pban" as const, domain: pbanResult.domain };
      this.cacheSet(hostname, result);
      return result;
    }

    // Check regular block
    const blockResult = this.checkSet(hostname, this.blockSet);
    const result = blockResult
      ? { matched: true, mode: "block" as const, domain: blockResult.domain }
      : { matched: false, mode: "block" as const, domain: "" };
    this.cacheSet(hostname, result);
    return result;
  }

  private cacheSet(hostname: string, result: MatchResult): void {
    if (this.cache.size >= this.CACHE_MAX) {
      // Evict oldest 25% entries
      const evictCount = Math.ceil(this.CACHE_MAX * 0.25);
      const keys = this.cache.keys();
      for (let i = 0; i < evictCount; i++) {
        const key = keys.next();
        if (key.done) break;
        this.cache.delete(key.value);
      }
    }
    this.cache.set(hostname, result);
  }

  private checkSet(
    hostname: string,
    set: Map<string, BlockEntry>
  ): BlockEntry | null {
    const normalized = normalizeDomain(hostname, this.stripWww);
    const raw = normalizeDomain(hostname, false);

    // Direct match. Both variants are checked: with www-stripping on, a
    // legacy entry may still be stored WITH `www.` (preference changed, or an
    // import), and it must match the host it names.
    if (set.has(normalized)) return set.get(normalized) ?? null;
    if (raw !== normalized && set.has(raw)) return set.get(raw) ?? null;

    // ASCII variants (single conversion each, reused below)
    const ascii = toASCIIDomain(normalized);
    if (ascii !== normalized && set.has(ascii)) return set.get(ascii) ?? null;
    const rawAscii = toASCIIDomain(raw);
    if (rawAscii !== raw && set.has(rawAscii)) return set.get(rawAscii) ?? null;

    if (!this.subdomainWildcard) return null;

    // Walk up the domain hierarchy — derive ASCII by slicing, no URL parsing
    let current = normalized;
    while (current.includes(".")) {
      const dotIdx = current.indexOf(".");
      current = current.slice(dotIdx + 1);
      if (set.has(current)) return set.get(current) ?? null;
      // Derive ASCII variant from the sliced hostname
      const asciiCurrent = toASCIIDomain(current);
      if (asciiCurrent !== current && set.has(asciiCurrent)) {
        return set.get(asciiCurrent) ?? null;
      }
    }

    // Also try the PSL-aware root domain — only as last resort
    const root = toASCIIDomain(getRootDomain(normalized));
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
