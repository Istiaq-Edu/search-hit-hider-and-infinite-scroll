export interface FetchResult {
  doc: Document;
  nextUrl: string | null;
}

/**
 * Fetch a search results page and parse it into a Document.
 * Returns null on any error (network, non-2xx, parse failure).
 */
export async function fetchPage(
  url: string,
  signal: AbortSignal,
  delayMs: number
): Promise<FetchResult | null> {
  if (delayMs > 0) {
    // Add ±50% jitter to avoid detection patterns
    const jitter = delayMs * (0.5 + Math.random());
    await sleep(jitter);
  }

  try {
    const response = await fetch(url, {
      signal,
      credentials: "include",
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": navigator.language,
        "Cache-Control": "no-cache",
      },
    });

    if (!response.ok) return null;

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");

    // Inject a <base> tag so relative URLs resolve against the fetched URL.
    // Without this, links like "/search?p=2" resolve to "about:blank/search?p=2"
    // and pagination detection fails on subsequent fetches.
    const base = doc.createElement("base");
    base.href = url;
    if (doc.head) {
      doc.head.prepend(base);
    }

    return { doc, nextUrl: null };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
