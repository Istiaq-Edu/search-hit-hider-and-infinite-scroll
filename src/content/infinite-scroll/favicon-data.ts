/**
 * Inline favicon extractor for Startpage's server-rendered pages.
 *
 * Ground truth (verified live Aug 2026 + archived Jan 2026 capture): the SSR
 * embeds a JSON state blob in a <script> tag where every result carries its
 * favicon ALREADY INLINE as a data: URL:
 *
 *   "url":"https://www.test.de/","sourceIndex":0,"siteLinks":[],
 *   "faviconData":"data:image/png;base64,iVBORw0KGgo..."
 *
 * Hydration copies these onto the chips — but hydration crashes on some
 * generations (React #418/#423), and our auto-loaded clones are never
 * hydrated at all. The bytes ship in every fetched page we already hold;
 * parsing them out needs no network, no permissions, and produces data:
 * URLs that Startpage's CSP explicitly allows (img-src … data:) — unlike
 * any third-party icon service, which its CSP blocks.
 *
 * Record shape assumptions kept MINIMAL and validated defensively:
 * - the destination URL is the nearest "url" value before the record's
 *   "sourceIndex" marker (site-link URLs sit further back, so populated
 *   siteLinks arrays cannot poison the mapping);
 * - "faviconData" must be a data:image/* URL — anything else is dropped.
 */

const FAVICON_DATA_RE = /"faviconData"\s*:\s*("(?:[^"\\]|\\.)*")/g;
const URL_VALUE_RE = /"(?:url|link|href)"\s*:\s*("(?:[^"\\]|\\.)*")/g;
const SOURCE_INDEX_RE = /"sourceIndex"/g;

/** Upper bound on extracted entries per page — defensive, payloads are ~10. */
const MAX_ENTRIES_PER_PAGE = 300;

/** Decode a JSON string literal token (including the surrounding quotes). */
function decodeJsonString(token: string): string | null {
  try {
    const val = JSON.parse(token);
    return typeof val === "string" ? val : null;
  } catch {
    // Tolerate truncated escape sequences by falling back to a manual
    // unescape of the escapes we actually encounter in this payload.
    return token
      .slice(1, -1)
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\"/g, '"')
      .replace(/\\\//g, "/")
      .replace(/\\\\/g, "\\");
  }
}

/**
 * Destination hostname for one record. Prefers the "url" nearest BEFORE the
 * record's "sourceIndex" marker (the result's own URL); falls back to the
 * nearest preceding "url" anywhere in the segment when the marker is absent
 * (schema drift tolerance).
 */
function hostOfSegment(segment: string): string | null {
  SOURCE_INDEX_RE.lastIndex = 0;
  let anchor = segment.length;
  let m: RegExpExecArray | null;
  // Nearest sourceIndex in the segment (records carry exactly one; take the
  // last match before the faviconData we segmented at).
  while ((m = SOURCE_INDEX_RE.exec(segment)) !== null) anchor = m.index;

  URL_VALUE_RE.lastIndex = 0;
  let best: string | null = null;
  while ((m = URL_VALUE_RE.exec(segment)) !== null) {
    if (m.index >= anchor) break;
    const captured = m[1];
    if (typeof captured === "string") best = captured;
  }
  if (!best) return null;
  const raw = decodeJsonString(best);
  if (!raw) return null;
  // Archive snapshots wrap destinations in /web/<timestamp>/<real url>;
  // live pages never do. Strip when present.
  const stripped = raw.replace(
    /^https?:\/\/web\.archive\.org\/web\/\d+[a-z_]*\//i,
    ""
  );
  if (!/^https?:\/\//i.test(stripped)) return null;
  try {
    return new URL(stripped).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Extract host -> dataURL favicon mappings from a page's inline JSON state.
 * Pure function: no DOM, no network. Returns only records whose faviconData
 * is a usable data:image URL; malformed input yields a partial or empty map,
 * never a throw.
 */
export function extractFaviconData(jsonText: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!jsonText || jsonText.indexOf("faviconData") === -1) return map;

  FAVICON_DATA_RE.lastIndex = 0;
  let segStart = 0;
  let match: RegExpExecArray | null;
  while ((match = FAVICON_DATA_RE.exec(jsonText)) !== null) {
    const segment = jsonText.slice(segStart, match.index);
    segStart = match.index + match[0].length;

    const iconRaw = decodeJsonString(match[1] ?? "");
    if (!iconRaw || !/^data:image\//i.test(iconRaw)) continue;

    const host = hostOfSegment(segment);
    if (!host) continue;
    // First record wins — duplicates across pages carry identical art.
    if (!map.has(host) && map.size < MAX_ENTRIES_PER_PAGE) {
      map.set(host, iconRaw);
    }
  }
  return map;
}

/**
 * Single-pass unescape of JSON-style escapes in a larger text blob. Unlike
 * String.replace chains, pair boundaries survive (\\" does not become a
 * bare quote half-way through a \\\\ sequence).
 */
function unescapeJsonish(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      i++;
      if (next === '"') out += '"';
      else if (next === "/") out += "/";
      else if (next === "\\") out += "\\";
      else out += ch + next; // unknown escape: keep verbatim
    } else {
      out += ch;
    }
  }
  return out;
}

/** Where a successful extraction came from — diagnostics. */
export type ExtractVia = "plain" | "escaped" | "none";

/**
 * Lenient front door: try the plain parser first; when the blob mentions
 * faviconData but yields NOTHING, retry once on an unescaped copy. Live
 * generations increasingly double-encode the state blob
 * (\"faviconData\":\"data:image/…\") — the plain regex cannot match across
 * escape backslashes, which showed up in the field as
 * "tier0 scan: 1 … map now 0".
 */
export function extractFaviconDataAny(
  jsonText: string
): { map: Map<string, string>; via: ExtractVia } {
  const plain = extractFaviconData(jsonText);
  if (plain.size > 0) return { map: plain, via: "plain" };
  if (!jsonText || jsonText.indexOf("faviconData") === -1) {
    return { map: plain, via: "none" };
  }
  const loose = extractFaviconData(unescapeJsonish(jsonText));
  if (loose.size > 0) return { map: loose, via: "escaped" };
  return { map: loose, via: "none" };
}
