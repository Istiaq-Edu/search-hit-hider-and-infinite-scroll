// ============================================================
// Domain normalization and root domain extraction
//
// Root-domain extraction uses the real Public Suffix List via `tldts`.
// The previous hand-maintained COMPOUND_TLDS table had no wildcard, exception
// or private-section rules, so it got `tienda.com.co` (com.co), `x.s3.
// amazonaws.com` (amazonaws.com) and `alice.github.io` (github.io) wrong. On a
// hosting platform that turns an exact-site block into a block of every tenant
// — and with subdomain wildcard on, of the entire platform.
//
// `allowPrivateDomains: true` is required: PSL private entries (github.io,
// blogspot.com, s3.amazonaws.com, vercel.app, …) are exactly the multi-tenant
// suffixes users need as their root boundary.
// ============================================================

import { getDomain } from "tldts";

/**
 * Extract the registrable root domain from a hostname.
 * e.g. "blog.sub.example.co.uk" -> "example.co.uk"
 * e.g. "www.example.com" -> "example.com"
 *
 * Unknown suffixes, IP addresses and dotless hosts fall back to the
 * normalized host itself rather than guessing at the last two labels: a wrong
 * guess can widen a block to an unrelated site.
 */
export function getRootDomain(hostname: string): string {
  const normalized = normalizeDomain(hostname, false);
  if (!normalized || isIPv4(normalized)) return normalized;
  // tldts orders ICU/punycode handling for IDNs; it returns null for hosts it
  // cannot classify (IPs, single labels), where the host is already the most
  // specific meaningful level.
  const root = getDomain(normalized, { allowPrivateDomains: true });
  return root ?? normalized;
}

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
  // Strip a trailing root-zone dot ("example.com." → "example.com") — hostnames
  // parsed from URLs never carry it, so keeping it would never match.
  while (d.endsWith(".")) {
    d = d.slice(0, -1);
  }
  if (stripWww && d.startsWith("www.")) {
    d = d.slice(4);
  }
  return d;
}

// Hostname-safe characters after lowercase: ASCII letters, digits, dots,
// hyphens, and underscores. Anything else (spaces, quotes, braces, slashes,
// angle brackets, …) can never appear in a real hostname and — critically —
// quotes/braces would break out of the CSS attribute selectors the preload
// builds from block-list entries.
const DOMAIN_CHARS = /^[a-z0-9._-]+$/;

/**
 * Whether a (normalized) string can plausibly be stored and later
 * interpolated into CSS selectors / URL matching. Non-ASCII is allowed here;
 * callers that feed CSS generation must additionally punycode-convert
 * (see content/cache-limits.ts).
 */
export function isValidDomain(domain: string): boolean {
  if (!domain || domain.length < 2) return false;
  // Search results never link to dotless hosts, and a bare TLD like "com"
  // with subdomain wildcard would hide every .com site — require a dot.
  if (!domain.includes(".")) return false;
  // At least one label containing a non-dot character
  if (!/[a-z0-9]/.test(domain)) return false;
  // ASCII-only fast path; otherwise allow unicode letters (IDN) but reject
  // characters that are neither hostname-safe ASCII nor non-ASCII letters.
  if (DOMAIN_CHARS.test(domain)) return true;
  // Unicode (IDN) path: allow letters/marks/digits of any script, plus dots
  // and hyphens; reject anything else.
  return /^[\p{L}\p{N}.-]+$/u.test(domain);
}

/**
 * Get domain hierarchy for block dialog choices.
 * Returns levels from most specific to least specific (excluding TLD-only).
 * e.g. "blog.sub.example.co.uk" -> ["blog.sub.example.co.uk", "sub.example.co.uk", "example.co.uk"]
 *
 * `stripWww` mirrors the user preference. With it enabled the `www.` label is
 * not an addressable level (matching is www-insensitive); with it disabled
 * `www.example.com` stays selectable, so an exact-host block on a www site is
 * actually expressible. It was hard-coded to true, which made the preference
 * inert and exact-host blocks impossible on www hosts.
 */
export function getDomainLevels(hostname: string, stripWww = true): string[] {
  const normalized = normalizeDomain(hostname, stripWww);
  if (!normalized) return [];
  const root = getRootDomain(normalized);
  const levels: string[] = [];

  // tldts may return a root that is not a suffix of the normalized host when
  // the host was a public suffix itself; in that case the host is the only
  // meaningful level.
  if (!normalized.endsWith(root)) return [normalized];

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
