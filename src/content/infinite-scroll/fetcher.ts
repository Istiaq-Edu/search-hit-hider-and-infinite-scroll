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
    await sleep(delayMs);
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

    return { doc, nextUrl: null };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
