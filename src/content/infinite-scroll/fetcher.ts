export interface FetchResult {
  doc: Document;
  nextUrl: string | null;
}

import { isDebugMode } from "../debug";

/**
 * Fetch a search results page and parse it into a Document.
 * `init` allows engines that paginate via POST (e.g. Startpage) to supply
 * method/body; GET is the default for all other engines.
 * Returns null on any error (network, non-2xx, parse failure, captcha).
 */
export async function fetchPage(
  url: string,
  signal: AbortSignal,
  delayMs: number,
  init?: RequestInit
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
      ...init,
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": navigator.language,
        ...(init?.method === "POST"
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });

    if (!response.ok) return null;

    const html = await response.text();

    // Empty/whitespace-only body: a transient server hiccup (observed live
    // on Google as 200-with-empty-body), NOT a soft block and NOT a results
    // page. Parsing it wastes work and the shape gate would misfile it.
    // Debug-gated one-liner so the next field log answers "what did Google
    // actually return" instead of guessing.
    if (html.trim().length === 0) {
      if (isDebugMode()) {
        // eslint-disable-next-line no-console
        console.log(
          `[SHH] fetch empty body: status=${response.status} ` +
            `redirected=${response.redirected} url=${(response.url || url).slice(0, 120)}`
        );
      }
      return null;
    }

    // Debug-gated fetch receipt: status, redirect trail, body size. Without
    // this, "page yielded no results" is undiagnosable — a 302 to consent, a
    // 200 interstitial and a 200 empty shell all look identical downstream.
    if (isDebugMode()) {
      // eslint-disable-next-line no-console
      console.log(
        `[SHH] fetch ok: status=${response.status} len=${html.length} ` +
          `redirected=${response.redirected} url=${(response.url || url).slice(0, 120)}`
      );
    }

    const doc = new DOMParser().parseFromString(html, "text/html");

    // Inject a <base> tag so relative URLs resolve against the fetched URL.
    // Without this, links like "/search?p=2" resolve to "about:blank/search?p=2"
    // and pagination detection fails on subsequent fetches. Injected BEFORE the
    // block checks below because the soft-block probe reads resolved hrefs.
    const base = doc.createElement("base");
    base.href = url;
    if (doc.head) {
      doc.head.prepend(base);
    }

    // Google (and sometimes Bing) serve CAPTCHA/"sorry" interstitials with
    // HTTP 200.  Startpage redirects to /sp/captcha.  Treating them as a
    // results page yields zero results and can derail pagination — report
    // them as failures so the manager backs off (3 consecutive errors stop
    // infinite scroll, native pagination remains).
    const finalUrl = response.url || url;
    const looksLikeCaptcha =
      finalUrl.includes("/sorry/") ||
      finalUrl.includes("/sp/captcha") ||
      doc.getElementById("captcha") !== null ||
      doc.querySelector("form[action*='/sorry']") !== null ||
      doc.querySelector(".g-recaptcha") !== null;
    if (looksLikeCaptcha) return null;

    // Soft block / JS-gated shell — the failure mode that silently killed
    // Google infinite scroll. Google answers automated GETs with HTTP 200 and a
    // full-size document that contains NO result markup at all (a redirect
    // interstitial or a client-rendered shell). Verified 2026-08-30: three UA /
    // param combinations each returned ~92 KB with div.g=0, #rso=0, h3=0 and
    // body text "Please click here if you are not redirected within a few
    // seconds." — none of which the captcha heuristic above catches.
    if (looksLikeSoftBlock(doc, url)) return null;

    return { doc, nextUrl: null };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return null;
  }
}

/**
 * Copy that only ever appears on a bot gate / JS-redirect interstitial.
 * Deliberately specific: a "no results found" page is NOT a soft block, and
 * mislabelling one would show the user a bogus "connection lost, retry" error
 * every time they reach the end of the result list.
 */
const SOFT_BLOCK_TEXT: RegExp[] = [
  /click here if you are not redirected/i,
  /if you are not redirected[^.]{0,40}within/i,
  /not redirected automatically/i,
  /enable javascript[^.]{0,40}continue/i,
  /please enable javascript/i,
  /to continue, (please )?(enable|turn on) javascript/i,
  /our systems have detected unusual traffic/i,
  /verify (that )?you are (a )?human/i,
  /checking your browser before accessing/i,
  /attention required!/i,
];

/**
 * Visible text of a parsed document with script/style/noscript stripped.
 *
 * `body.textContent` alone is useless here: the Google interstitial is ~92 KB
 * of inline <script>, so its textContent is huge even though the user sees one
 * sentence.
 */
function visibleText(doc: Document): string {
  try {
    const body = doc.body;
    if (!body) return "";
    const clone = body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("script, style, noscript, template").forEach((n) => n.remove());
    return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

/** Two hostnames are the same site if they share their last two labels. */
function sameSite(a: string, b: string): boolean {
  const norm = (h: string): string => h.toLowerCase().replace(/^www\./, "");
  const [ha, hb] = [norm(a), norm(b)];
  if (!ha || !hb) return false;
  if (ha === hb) return true;
  const tail = (h: string): string => h.split(".").slice(-2).join(".");
  return tail(ha) === tail(hb);
}

/**
 * Does this document link anywhere off the search engine's own site?
 *
 * Every results page does — that is literally what a result is. Interstitials
 * link back to the engine at most (support.google.com, /sorry/, a JS redirect).
 * Deliberately engine-agnostic: it reads resolved hrefs rather than result
 * class names, so an engine whose markup we have never seen is not misjudged.
 */
function hasOutboundResultLinks(doc: Document, requestUrl: string): boolean {
  let requestHost: string;
  try {
    requestHost = new URL(requestUrl).hostname;
  } catch {
    return true; // Cannot tell — fail open rather than suspect a real page.
  }
  try {
    for (const a of Array.from(doc.querySelectorAll("a[href]")) as HTMLAnchorElement[]) {
      const href = a.href;
      if (!href || !/^https?:/i.test(href)) continue;
      let host: string;
      try {
        host = new URL(href).hostname;
      } catch {
        continue;
      }
      if (!sameSite(host, requestHost)) return true;
    }
  } catch { /* unreadable document — fail open */ }
  return false;
}

/**
 * Anything that identifies a real search-results page: a results stream
 * container, a result heading, or a link leaving the engine's site.
 *
 * Exported because the infinite-scroll manager applies the same test to a
 * fetched page that parsed fine but yielded zero results — see there for why
 * the two layers must agree.
 *
 * Fails OPEN by design. A false negative here costs the old behaviour (paging
 * stops quietly); a false positive invents a new bug (a healthy page reported
 * as "connection lost"). When in doubt, this says "it is a results page".
 */
export function hasSearchResultsShape(doc: Document, requestUrl?: string): boolean {
  try {
    if (doc.querySelector('h1, h2, h3, [role="heading"]')) return true;
    for (const sel of SERP_SHAPE_SELECTORS) {
      if (doc.querySelector(sel)) return true;
    }
  } catch { /* detached or unusual document — fall through to the link probe */ }
  if (requestUrl && hasOutboundResultLinks(doc, requestUrl)) return true;
  // No URL to compare against: judge on markup alone.
  return requestUrl ? false : true;
}

/** Result-stream / result-node markers shared by the engines we support. */
const SERP_SHAPE_SELECTORS = [
  // Results stream containers (Google, Bing, DuckDuckGo, SearXNG, Baidu, Yandex)
  "#rso", "#search", "#res", "#center_col", "#b_results", "#b_content",
  "#links", "#web", "#main_results", "#results", "#content_left",
  // Async result fragments
  '[data-async-context]',
  // Per-result nodes
  ".serp-item", ".b_algo", ".result", "[data-testid='result']",
];

/**
 * True when a 200 response is a bot gate rather than a results page.
 *
 * Two independent signals, either sufficient:
 *   • Interstitial wording — the exact string Google served on 2026-08-30.
 *   • No search-results shape at all: no stream container, no headings, and no
 *     link leaving the engine's own site. A genuine last page still renders the
 *     stream container and the pager, so this does NOT fire at the end of the
 *     result list.
 */
function looksLikeSoftBlock(doc: Document, requestUrl: string): boolean {
  const text = visibleText(doc).slice(0, 4000);
  if (text && SOFT_BLOCK_TEXT.some((re) => re.test(text))) return true;
  return !hasSearchResultsShape(doc, requestUrl);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
