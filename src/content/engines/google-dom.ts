// ============================================================
// Google SERP structural DOM helpers
//
// WHY THIS FILE EXISTS
// --------------------
// Google's per-result container is identified by build-generated, rotation-prone
// class names (`div.g`, `div.tF2Cxc`). Every layer of this extension used to pin
// node discovery to those two class names, so when Google rotated them the whole
// engine silently found zero results (see
// docs/plans/2026-08-30-google-failure-diagnosis.md).
//
// This module replaces class-name pinning with STRUCTURE: resolve the results
// stream by id (ids are stable far longer than hashes), then treat its top-level
// children as candidate results. Class names are kept only as a last-resort
// fallback so nothing regresses on layouts that still ship them.
//
// Shared by the content-script adapter AND the document_start preload so the two
// can never drift apart again.
// ============================================================

/** Elements that carry a result title. Used for the "is this a section?" probe. */
export const GOOGLE_HEADING_SELECTOR = 'h3, h2, [role="heading"]';

/**
 * Results-stream containers, most specific first.
 *
 *   #rso                              — classic results stream (still current in most layouts)
 *   #center_col div#search            — 2026 layout: #rso may be absent, results hang off #search
 *   [data-async-context^="query:"]    — async/rendered result fragments
 *   #res                              — legacy results wrapper
 *   #center_col                       — broadest fallback; ad/pagination filters below keep it safe
 */
export const GOOGLE_STREAM_SELECTORS = [
  "#rso",
  "#center_col div#search",
  "#center_col #search",
  '[data-async-context^="query:"]',
  "#res",
  "#center_col",
];

/**
 * Non-result page furniture. Never treat these (or their subtrees) as results.
 * Includes our own injected UI so re-scans are idempotent.
 */
export const GOOGLE_NON_RESULT_SELECTORS = [
  "script", "style", "noscript", "template", "link", "meta",
  "#botstuff", "#navcnt", "#foot", "#xjs", "#footcnt",
  'nav[role="navigation"]',
  "#is-sentinel", "#is-spinner-style",
  "[data-shh-placeholder]", ".shh-placeholder", ".shh-toast", ".shh-dialog",
  ".shh-block-btn",
];

/**
 * Ad / sponsored containers. Blocking these would fight the user's ad-blocker and
 * would surface "blocked" placeholders over content the user never asked to filter.
 */
export const GOOGLE_AD_SELECTORS = [
  "#tads", "#taw", "#bottomads", "#rhs", "#taw-container",
  "[data-text-ad]", ".uEierd", ".ads-ad", ".Krnil",
  ".commercial-unit-desktop-top", ".commercial-unit-mobile-top",
  ".pla-unit", ".pa_carousel", ".cu-container", ".top-pla-group",
];

/** Legacy per-result class anchors. Last-resort only — Google rotates these. */
export const GOOGLE_LEGACY_RESULT_SELECTORS = [
  "div.g:not(.g .g)",
  "div.tF2Cxc:not(.tF2Cxc .tF2Cxc)",
];

/**
 * How deep we follow a multi-result section looking for individual results.
 *
 * Field-captured 2026-08-30 the real nesting is five levels below the stream:
 *   #rso > div.MjjYud > div.A6K0A > div.tF2Cxc > div.N54PNb > div.kb0PBd
 * A cap of 3 stopped the walk at div.tF2Cxc — the "Web results" SECTION — and
 * then offered div.N54PNb, the element wrapping EVERY result, as a single
 * result. 6 gives headroom without risking runaway recursion (the walk only
 * continues while a node still looks like a multi-result section).
 */
const MAX_DESCENT_DEPTH = 6;

/** A node with this many headings is a section wrapper, not a single result. */
export const SECTION_HEADING_THRESHOLD = 2;

/**
 * A node citing this many DIFFERENT domains is an aggregate — an AI Overview, a
 * video carousel, a "Discussions" block — not one result.
 */
const AGGREGATE_HOST_THRESHOLD = 4;

function matchesAny(el: Element, selectors: string[]): boolean {
  for (const sel of selectors) {
    try {
      if (el.matches(sel)) return true;
    } catch { /* invalid selector for this element — ignore */ }
  }
  return false;
}

/** True for page furniture / our own UI / ad containers. */
export function isGoogleNonResult(el: Element): boolean {
  return matchesAny(el, GOOGLE_NON_RESULT_SELECTORS) || matchesAny(el, GOOGLE_AD_SELECTORS);
}

function isGoogleHost(host: string): boolean {
  const h = host.toLowerCase();
  return h.includes("google.") || h.includes("gstatic.") || h.includes("googleapis.");
}

/** Domain-ish display-URL slots. <cite> first; these are the styled variants. */
const GOOGLE_DISPLAY_URL_SELECTORS = [
  "cite",
  ".VuuXrf", ".qzEoUe", ".UdQCqe", ".byrV5b", ".HGLrCf",
];

/** Pull a hostname out of display-URL text: "a.com › docs" | "https://a.com/x". */
function domainFromDisplayText(text: string): string | null {
  const first = text.split(/\s*[›»·|]\s*/)[0] ?? "";
  let candidate = first.trim();
  if (!candidate) return null;

  if (/^https?:\/\//i.test(candidate)) {
    try {
      candidate = new URL(candidate).hostname;
    } catch {
      return null;
    }
  } else {
    // Bare form — cut at any whitespace or path delimiter.
    candidate = candidate.split(/[\s/?#]/)[0] ?? "";
  }

  candidate = candidate.replace(/^www\./i, "").trim().toLowerCase();
  // Must look like a hostname: at least one dot, hostname-safe characters only.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(candidate)) return null;
  if (isGoogleHost(candidate)) return null;
  return candidate;
}

/**
 * The domain shown in a result's display-URL slot — what the user actually
 * reads on screen.
 *
 * THIS IS THE ONLY USABLE DOMAIN SOURCE ON GOOGLE AS OF 2026-08-30.
 * Field capture: title links are `href="/goto?url=CAESUQHrOzAVzBTZa…"`. That is
 * a protobuf-wrapped opaque token — `CAESUQ…` decodes to field 1 = 1, field 4 =
 * 81-byte blob — so the destination cannot be recovered from the link at all.
 * Everything in this extension that classified links as "external" looked for
 * `/url?q=`, found nothing, and rejected every result: processed=0.
 *
 * Also means the :has() CSS layer is inert on this layout (it matches on
 * `a[href*="://domain/"]`, and the domain is not in the href). The JS paths in
 * the preload and the content script carry blocking instead.
 */
/**
 * Every DISTINCT domain shown in a node's display-URL slots.
 *
 * Tries the display-URL selectors in order and stops at the first one that
 * yields anything: <cite> is canonical, and the styled variants
 * (.VuuXrf, .qzEoUe, …) repeat the same text on every known layout, so
 * mixing them would manufacture domains that are not really there.
 */
export function googleDisplayDomains(el: Element): string[] {
  const out = new Set<string>();
  try {
    for (const sel of GOOGLE_DISPLAY_URL_SELECTORS) {
      for (const node of Array.from(el.querySelectorAll(sel))) {
        const text = node.textContent ?? "";
        if (!text.trim()) continue;
        const domain = domainFromDisplayText(text);
        if (domain) out.add(domain);
      }
      if (out.size > 0) break;
    }
  } catch { /* unreadable node */ }
  return Array.from(out);
}

export function googleDisplayDomain(el: Element): string | null {
  const domains = googleDisplayDomains(el);
  if (domains.length === 0) return null;

  // *** AMBIGUITY GUARD ***
  // A node citing SEVERAL different domains is not one result — it is an
  // AI Overview, an answer box, a news cluster. Judging it by its FIRST cite
  // meant one blocked domain hid the whole block, which is exactly the
  // "it removed other search results" field report of 2026-08-30.
  //
  // Two slots showing the same host (title cite + a sitelink cite) still
  // collapse to one entry here, so genuine results are unaffected.
  if (domains.length > 1) return null;

  return domains[0] ?? null;
}

/**
 * True when `el` cites many DIFFERENT domains — an AI Overview, a video
 * carousel, a news cluster — rather than being one result.
 *
 * Why this exists: an AI Overview sits at the top of #rso as a single block
 * that cites a dozen sources. It carries no per-result markup, so the heading
 * probe below cannot tell it apart from one organic result: if any ONE cited
 * domain is on the block list, the entire answer disappears. Skipping such a
 * node is deliberate and fail-open — a blocked domain inside an aggregate stays
 * visible rather than taking unrelated content down with it.
 *
 * Counts HOSTS, not links, so a single result with sitelinks (all the same
 * domain) is still recognised as one result.
 */
export function looksLikeGoogleAggregate(el: Element): boolean {
  try {
    const hosts = new Set<string>();

    const consider = (host: string | null | undefined): boolean => {
      if (!host) return false;
      const h = host.toLowerCase().replace(/^www\./, "");
      if (!h || isGoogleHost(h)) return false;
      hosts.add(h);
      return hosts.size >= AGGREGATE_HOST_THRESHOLD;
    };

    const links = Array.from(el.querySelectorAll("a[href]")) as HTMLAnchorElement[];
    for (const a of links) {
      const href = a.href;
      if (!href) continue;
      let host: string;
      try {
        host = new URL(href).hostname;
      } catch {
        continue;
      }
      if (consider(host)) return true;
    }

    // *** OPAQUE-LINK FALLBACK ***
    // Since 2026-08-30 Google's result links are `/goto?url=<opaque>`, which
    // resolve to www.google.com — so the loop above can NEVER accumulate a
    // non-Google host and this guard silently stopped firing. That is the
    // direct cause of the "it removed other search results" report: an
    // AI Overview stopped being recognised as an aggregate, was offered up
    // as one result, and got hidden because its first cited domain matched.
    //
    // The display URLs are the only place a domain still exists, so count
    // those instead. Fails open as before when there is nothing to count.
    for (const d of googleDisplayDomains(el)) {
      if (consider(d)) return true;
    }
  } catch { /* unreadable node — fail open: not an aggregate */ }
  return false;
}

/**
 * True when `el` wraps MULTIPLE results (a "Discussions" block, an appended
 * infinite-scroll page, a video carousel) rather than being one result.
 *
 * Used to decide whether to descend into a node or treat it as a leaf result.
 * Deliberately fail-OPEN on ambiguity: a node with several headings is treated as
 * a section and recursed into, so we never hide a whole section because one of
 * its results matched the block list.
 */
export function looksLikeGoogleSection(el: Element): boolean {
  if (isGoogleNonResult(el)) return false;
  try {
    return el.querySelectorAll(GOOGLE_HEADING_SELECTOR).length >= SECTION_HEADING_THRESHOLD;
  } catch {
    return false;
  }
}

/**
 * Resolve the element that holds the stream of results.
 * Returns null when the page is not a Google SERP (consent page, /sorry/, AI Mode shell).
 */
export function resolveGoogleStream(doc: Document | Element): Element | null {
  for (const sel of GOOGLE_STREAM_SELECTORS) {
    try {
      const el = doc.querySelector(sel);
      if (el) return el;
    } catch { /* invalid selector — try the next candidate */ }
  }
  return null;
}

/**
 * Collect individual result nodes structurally.
 *
 * Walks the top-level children of each candidate stream container, descending into
 * nodes that wrap multiple results. The first container that yields any valid
 * result wins — so a stale-but-present `#rso` shell cannot shadow a working
 * `#center_col div#search` underneath it.
 *
 * `isValid` is supplied by the caller (the adapter's `isValidResult`); this module
 * stays free of blocking policy.
 */
export function collectGoogleResults(
  doc: Document | Element,
  isValid: (el: Element) => boolean
): Element[] {
  for (const sel of GOOGLE_STREAM_SELECTORS) {
    let stream: Element | null = null;
    try {
      stream = doc.querySelector(sel);
    } catch { /* invalid selector — try the next candidate */ }
    if (!stream) continue;

    const found: Element[] = [];
    const seen = new Set<Element>();
    walkResults(stream, 0, isValid, found, seen);
    if (found.length > 0) return found;
  }
  return [];
}

function walkResults(
  parent: Element,
  depth: number,
  isValid: (el: Element) => boolean,
  out: Element[],
  seen: Set<Element>
): void {
  let children: Element[];
  try {
    children = Array.from(parent.children);
  } catch {
    return;
  }

  for (const child of children) {
    if (seen.has(child)) continue;
    if (isGoogleNonResult(child)) continue;

    if (depth < MAX_DESCENT_DEPTH && looksLikeGoogleSection(child)) {
      const before = out.length;
      walkResults(child, depth + 1, isValid, out, seen);
      // Descending found nothing usable (e.g. a section whose children are not
      // themselves valid results) — fall back to treating the node as one result
      // rather than dropping it.
      if (out.length > before) continue;
    }

    // *** SECTION FALLBACK GUARD ***
    // Descending failed, but this node still wraps several headings. It is a
    // container whose children we could not identify as results — NOT one
    // result. Offering it as a match would let a single blocked domain hide
    // everything inside it (field case: div.N54PNb wraps the entire result
    // list). Skip it: failing to hide is always better than hiding the page.
    if (looksLikeGoogleSection(child)) continue;

    // Aggregate guard — checked only after descending has failed, so a genuine
    // multi-result section (an appended infinite-scroll page) that the heading
    // probe already resolved into individual results is never affected.
    if (looksLikeGoogleAggregate(child)) continue;

    if (isValid(child)) {
      seen.add(child);
      out.push(child);
    }
  }
}
