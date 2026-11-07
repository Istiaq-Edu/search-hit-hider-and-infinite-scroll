// ============================================================
// Shared URL helpers for engine adapters
//
// Every adapter must answer one question the same way: "is this href a real
// destination, or is it a link back into the search engine?" Getting that
// wrong is not cosmetic — a fallback that returns the engine's own redirect
// URL makes the block button hide the engine instead of the result.
// ============================================================

/** Parse an absolute http(s) URL, optionally resolving against a base. */
export function parseHttpUrl(raw: string, base?: string): URL | null {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

/** True when `host` is `domain` itself or one of its subdomains. */
export function isHostWithin(host: string, domain: string): boolean {
  // URL.hostname preserves a root-zone trailing dot ("www.bing.com."). Without
  // normalising it, a link back into the engine with a trailing dot looks like
  // an EXTERNAL destination and the block button targets the engine itself.
  const h = host.toLowerCase().replace(/\.+$/, "");
  const d = domain.toLowerCase().replace(/\.+$/, "");
  return h === d || h.endsWith("." + d);
}
