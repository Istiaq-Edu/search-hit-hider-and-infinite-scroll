import { parse } from "tldts";

// ============================================================
// Domain normalization and PSL-aware utilities
// ============================================================

/**
 * Normalize a domain: lowercase, strip www if requested, trim whitespace.
 */
export function normalizeDomain(domain: string, stripWww = true): string {
  let d = domain.trim().toLowerCase();
  if (d.startsWith("http://") || d.startsWith("https://")) {
    try {
      d = new URL(d).hostname;
    } catch {
      d = d.replace(/^https?:\/\//, "").split("/")[0] ?? d;
    }
  }
  d = (d.split("/")[0] ?? d).trim();
  d = (d.split("?")[0] ?? d).trim();
  d = (d.split("#")[0] ?? d).trim();
  // Strip port number (e.g. "example.com:8080" → "example.com")
  // Only strip if it's not an IPv6 address and the part after ":" is all digits.
  if (!d.startsWith("[")) {
    const colonIdx = d.lastIndexOf(":");
    if (colonIdx !== -1 && /^\d+$/.test(d.slice(colonIdx + 1))) {
      d = d.slice(0, colonIdx);
    }
  }
  if (stripWww && d.startsWith("www.")) {
    d = d.slice(4);
  }
  return d;
}

/**
 * Extract PSL-aware root domain from a full hostname.
 * e.g. "blog.sub.example.co.uk" -> "example.co.uk"
 * Uses tldts for accurate public suffix list support.
 */
export function getRootDomain(hostname: string): string {
  const result = parse(hostname, { allowPrivateDomains: true });
  if (result.domain) return result.domain;
  return hostname;
}

/**
 * Get domain hierarchy for block dialog choices.
 * Returns levels from most specific to least specific (excluding TLD-only).
 * e.g. "blog.sub.example.co.uk" -> ["blog.sub.example.co.uk", "sub.example.co.uk", "example.co.uk"]
 */
export function getDomainLevels(hostname: string): string[] {
  const normalized = normalizeDomain(hostname, true);
  const result = parse(normalized, { allowPrivateDomains: true });
  const root = result.domain ?? normalized;
  const levels: string[] = [];

  // Walk from most specific to root
  let current = normalized;
  while (current.length >= root.length) {
    levels.push(current);
    if (current === root) break;
    const dotIdx = current.indexOf(".");
    if (dotIdx === -1) break;
    current = current.slice(dotIdx + 1);
  }

  return levels.filter((l, i, arr) => arr.indexOf(l) === i);
}

/**
 * Extract hostname from a URL string. Returns empty string on failure.
 */
export function getHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    const m = url.match(/^(?:https?|ftp):\/\/([^/?#]+)/i);
    if (!m?.[1]) return "";
    return m[1].split(":")[0]?.toLowerCase() ?? "";
  }
}

/**
 * Normalize to punycode-compatible ASCII for IDN domains.
 * Falls back to the input if encoding fails.
 */
export function toASCIIDomain(domain: string): string {
  try {
    const url = new URL("https://" + domain);
    return url.hostname;
  } catch {
    return domain;
  }
}

/**
 * Check if `candidate` matches `blocked` considering subdomain wildcard.
 * e.g. blocked = "example.com", candidate = "sub.example.com" -> true (with wildcard)
 */
export function domainMatches(
  candidate: string,
  blocked: string,
  subdomainWildcard: boolean
): boolean {
  const c = candidate.toLowerCase();
  const b = blocked.toLowerCase();
  if (c === b) return true;
  if (subdomainWildcard && c.endsWith("." + b)) return true;
  return false;
}

/**
 * Strip www. prefix from a domain (non-destructive for non-www domains).
 */
export function stripWww(domain: string): string {
  if (domain.startsWith("www.")) return domain.slice(4);
  return domain;
}

/** IPv4 check — avoid treating IP addresses as domains */
export function isIPv4(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
}
