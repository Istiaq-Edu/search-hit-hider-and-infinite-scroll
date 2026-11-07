// ============================================================
// `_shh_cache` limits and sanitization — the untrusted-input boundary
//
// WHY THIS FILE EXISTS
// --------------------
// The pre-paint cache lives in `localStorage` on the PAGE's origin. Any script
// that runs on a search engine can read it (privacy) and WRITE it (integrity).
// The preload reads it synchronously at document_start — before the extension's
// own storage can validate anything — so every operation derived from it has to
// be bounded and sanitized THERE, not only in the content script.
//
// Three concrete failure modes this closes:
//
//   1. UNABOUNDED CSS. `buildHasRules` turns each domain into up to nine
//      selector fragments inside `:is()`. A hostile page that writes 200k
//      entries makes every subsequent load build hundreds of thousands of
//      fragments at document_start and stall the page. The payload persists in
//      localStorage, so the DoS outlives the page that planted it.
//
//   2. UNABOUNDED PARSING. `JSON.parse` of a multi-megabyte payload and a
//      per-entry `new URL()` on each element both run before first paint.
//
//   3. DOTLESS / MALFORMED ENTRIES. The old sanitizer accepted `"com"`, and
//      with `subdomainWildcard` on that hides every .com result — a page could
//      censor an entire SERP for the duration of the load. Entries are now
//      required to look like hostnames (a dot, valid labels, ASCII).
//
// The caps sit far above any realistic personal list (field reports top out
// around 70 entries; even large imports stay four figures), so a legitimate
// user never hits them, while a poisoned cache can only do bounded damage.
// ============================================================

/** Reject anything larger than this outright: no parse, no sanitize. */
export const MAX_CACHE_RAW_LENGTH = 256 * 1024;

/** Most entries the preload will match against. Excess is ignored. */
export const MAX_CACHE_DOMAINS = 5000;

/**
 * Most entries that get a CSS `:has()` rule. Selector cost grows with this
 * number, and the JS path (which has no per-domain stylesheet cost) still
 * covers everything above it.
 */
export const MAX_CSS_DOMAINS = 1200;

/** Longest legal DNS hostname in ASCII (RFC 1035). */
export const MAX_DOMAIN_LENGTH = 253;

/** Longest legal DNS label. */
const MAX_LABEL_LENGTH = 63;

// Lowercase ASCII letters, digits, dots, hyphens and underscores. Anything
// else can never appear in a hostname — and quotes/braces would break out of
// the CSS attribute selectors the preload builds from these values.
const HOSTNAME_SAFE = /^[a-z0-9._-]+$/;

/**
 * Parse a raw cache payload. Returns null for absent, oversized, non-object or
 * corrupt input — the caller must treat that as "no idea", never as "the user
 * has no blocks" (see cache-state.ts, defect D5).
 */
export function readCachePayload(raw: string | null): Record<string, unknown> | null {
  if (!raw || raw.length > MAX_CACHE_RAW_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Normalize one cache entry to an ASCII hostname, or null if it is not usable.
 *
 * `stripWww` mirrors the user preference exactly like the matcher does: entries
 * written with the preference OFF may legitimately carry a `www.` label, and
 * removing it unconditionally made the preload hide the bare host that the
 * content script considers unblocked (pre-hidden, then revealed at idle — a
 * flash, and a lost pre-paint block for the actual www host).
 */
export function toCacheDomain(raw: unknown, stripWww: boolean): string | null {
  if (typeof raw !== "string") return null;
  let d = raw.trim().toLowerCase();
  if (!d) return null;
  // Punycode-convert IDNs; hostnames parsed from page URLs are always ASCII, so
  // a unicode entry would never match. On failure the safety checks below
  // decide, which is what rejects malformed input.
  try {
    d = new URL("https://" + d).hostname;
  } catch { /* keep going — the hostname checks are the real gate */ }
  while (d.endsWith(".")) d = d.slice(0, -1);
  if (stripWww && d.startsWith("www.")) d = d.slice(4);
  if (!d || d.length > MAX_DOMAIN_LENGTH) return null;
  if (!HOSTNAME_SAFE.test(d)) return null;
  // Dotless hosts cannot appear in search results, and with wildcard matching
  // on they would hide every site under that suffix.
  if (!d.includes(".")) return null;
  for (const label of d.split(".")) {
    if (!label || label.length > MAX_LABEL_LENGTH) return null;
  }
  return d;
}

/**
 * Sanitize a cache `domains` array. Accepts anything (a page can write
 * anything); returns a deduplicated ASCII list of at most MAX_CACHE_DOMAINS.
 */
export function sanitizeCacheDomains(list: unknown, stripWww: boolean): string[] {
  const out: string[] = [];
  if (!Array.isArray(list)) return out;
  const seen = new Set<string>();
  for (const raw of list as unknown[]) {
    if (out.length >= MAX_CACHE_DOMAINS) break;
    const d = toCacheDomain(raw, stripWww);
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
}
