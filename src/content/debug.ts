// ============================================================
// Runtime debug gate + built-in field diagnostics
//
// Every verbose diagnostic in this extension is gated behind the
// "Debug mode" toggle (popup → Advanced). This module owns that flag,
// so no other file needs to know where it is stored.
//
// WHY A MODULE-LEVEL FLAG AND NOT A THREADED PROP:
// Engine adapters are stateless singletons constructed once in
// registry.ts with no config object, so there is nowhere to hang a
// per-page flag without reshaping the EngineAdapter interface that
// seven engines implement. A module flag with explicit accessors is
// the smallest change that reaches google.ts and the preload.
//
// WHY THE FLAG IS SEEDED TWICE (see seedDebugFromCache):
// getResultNodes() can run on the very first scan, potentially before
// the async prefs load resolves. Seeding synchronously from the
// preload's localStorage cache means the gate is already correct for
// that first scan — otherwise enabling Debug mode would take effect
// one page load late, which is exactly the wrong direction: the load
// you are trying to diagnose would stay silent.
//
// WHY THE COLLECTOR LIVES HERE TOO:
// Field debugging happens on a different machine, so a standalone
// paste-in script has to be transferred by hand first. Building it
// into the extension means the workflow is: toggle Debug mode,
// reload, run  copy(__shhDiag())  in the console, paste.
// ============================================================

// The discovery probe calls the SHIPPED Google guards rather than re-deriving
// them. google-dom.ts imports nothing, so this edge cannot create a cycle.
import {
  GOOGLE_HEADING_SELECTOR,
  SECTION_HEADING_THRESHOLD,
  googleDisplayDomains,
  isGoogleNonResult,
  looksLikeGoogleAggregate,
  looksLikeGoogleSection,
} from "./engines/google-dom";

let debugEnabled = false;

/**
 * Was this document restored from the back/forward cache?
 *
 * Extracted as a pure predicate because jsdom does not implement
 * `performance.getEntriesByType` at all, so the field could not be tested
 * inline — and the previous revision simply hard-coded `false` under a comment
 * describing when it "would" be true. A field that always lies is worse than
 * no field. Same extraction pattern as `shouldReScan` and `isEngineActive`.
 */
export function isBfcacheRestore(navType: string | null | undefined): boolean {
  return navType === "back_forward";
}

/** Read the navigation type defensively — the API is missing in jsdom. */
function readNavigationType(): string | null {
  try {
    if (typeof performance === "undefined" || !performance.getEntriesByType) return null;
    const e = performance.getEntriesByType("navigation")[0] as { type?: string } | undefined;
    return e?.type ?? null;
  } catch {
    return null;
  }
}

/** Last `n` chars, with an explicit marker when anything was dropped. */
function tail(s: string, n: number): string {
  return s.length <= n ? s : "...(truncated, oldest lines dropped)\n" + s.slice(-n);
}

/** `browser` is not reachable from a plain module; the manifest is a backstop. */
function safeManifestVersion(): string | null {
  try {
    return (globalThis as { browser?: { runtime?: { getManifest?: () => { version?: string } } } })
      .browser?.runtime?.getManifest?.()?.version ?? null;
  } catch {
    return null;
  }
}

/** Turn verbose diagnostics on/off. Called on prefs load and pref change. */
export function setDebugMode(on: boolean): void {
  debugEnabled = on === true;
}

/** True when verbose diagnostics should be emitted. */
export function isDebugMode(): boolean {
  return debugEnabled;
}

/**
 * Best-effort synchronous seed from the preload's localStorage cache.
 *
 * Cheap and side-effect free; a missing or corrupt cache simply leaves
 * the flag at its default. The authoritative value arrives with prefs.
 */
export function seedDebugFromCache(): void {
  try {
    const raw = localStorage.getItem("_shh_cache");
    if (!raw) return;
    const c = JSON.parse(raw) as { debug?: unknown };
    if (typeof c.debug === "boolean") setDebugMode(c.debug);
  } catch {
    /* localStorage unavailable or JSON corrupted — keep the default */
  }
}

// ── Counters, timings and live state ─────────────────────────────────────
//
// WHY THESE EXIST
// ---------------
// A field review of the show/hide fixes found that `collectDiagnostics` could
// count markers but could not answer the three questions that actually decide
// the bug:
//
//   1. Is the matcher EMPTY because the user has no blocks, or because the
//      background was cold and we fell back to the cache? Those look identical
//      from the outside and need opposite fixes.
//   2. When a blocked result is VISIBLE, which guard rejected it? Without this
//      the report is "0 stamped, 12 buttons" and nothing more.
//   3. When did each init phase run relative to the preload's 2s reveal? The
//      intermittency turned on that ordering and it was never measurable.
//
// The counters are plain integer increments — cheap enough to leave ungated,
// which avoids the confusing case where Debug mode was switched on late and
// every count reads zero. The EXPENSIVE parts (markup slices, href samples,
// the discovery probe's host resolution) stay behind the toggle.

// ── Guard-rejection counters ─────────────────────────────────────────────
//
// One key per exit from processResults' guard chain plus the adapter's own
// discovery guards. `rejectedBy` is what turns "nothing was hidden" into a
// diagnosis.
// ── Production rejection counters ─────────────────────────────────────────
//
// WHY TWO TABLES. An earlier revision put the diagnostic probe's reasons
// (notHeading/noHost/nonResult/aggregate/section/multiCite) into the SAME table
// as the production guards, but only ever assigned them to a separate
// `discovery.probeRejectedBy` field. Six rows were therefore permanently 0 and
// the report printed them under the header "which guard ate the result" — so a
// reader saw `adapterOfferedNone: 0` and concluded "the adapter always offered
// results", the exact opposite of the one counter that diagnoses a Google class
// rotation. A zero that means "never wired" is a lie by omission. Split now.
export type RejectionReason =
  | "alreadyStamped"        // processResults: node carried data-shh-result
  | "containsProcessed"     // a nested result/button/placeholder -> container
  | "insideProcessed"       // an ancestor is already handled
  | "noUrl"                 // engine could not resolve a destination
  | "noMatcher"             // processResults bailed: prefs/matcher/engine absent
  | "adapterOfferedNone"    // a whole scan produced zero result nodes
  | "skippedContainer"      // overlapped another result or looked like a result list
  | "nodeThrew";            // hideResult/injectButton threw for ONE node

// The probe's verdicts, kept separate precisely because they are produced by a
// DIFFERENT walk (debug.ts's own `diagnoseOne`) and never by processResults.
export type ProbeRejectionReason =
  | "notHeading"
  | "noHost"
  | "nonResult"
  | "aggregate"
  | "section"
  | "multiCite";

const REJECTION_REASONS: RejectionReason[] = [
  "alreadyStamped",
  "containsProcessed",
  "insideProcessed",
  "noUrl",
  "noMatcher",
  "adapterOfferedNone",
  "skippedContainer",
  "nodeThrew",
];

const rejections: Record<RejectionReason, number> = REJECTION_REASONS.reduce(
  (acc, k) => { acc[k] = 0; return acc; },
  {} as Record<RejectionReason, number>
);

// Counters for the MOST RECENT processResults() batch only.
//
// `alreadyStamped` is incremented for every stamped node on EVERY re-scan, and
// on Google a related-search or pagination is an SPA navigation — the document
// is never reloaded. Ten results over five re-scans read `50` in the
// cumulative table and it is usually the largest number there, presented as
// "which guard ate the result". The delta answers the real question (what
// happened on the last pass) and the cumulative total is still available.
let lastScanRejections: Record<RejectionReason, number> | null = null;

/** Count one rejection. Cheap enough to call ungated. */
export function bumpRejection(reason: RejectionReason, n = 1): void {
  rejections[reason] += n;
  if (lastScanRejections) lastScanRejections[reason] += n;
}

/** Call at the top of every processResults() batch. */
export function beginRejectionBatch(): void {
  lastScanRejections = REJECTION_REASONS.reduce(
    (acc, k) => { acc[k] = 0; return acc; },
    {} as Record<RejectionReason, number>
  );
}

export function rejectionSnapshot(): Record<RejectionReason, number> {
  return { ...rejections };
}

export function lastBatchSnapshot(): Record<RejectionReason, number> | null {
  return lastScanRejections ? { ...lastScanRejections } : null;
}

export function resetRejections(): void {
  for (const k of REJECTION_REASONS) rejections[k] = 0;
  lastScanRejections = null;
}

// ── Init-phase timings ───────────────────────────────────────────────────
//
// `performance.now()` deltas from the very first statement of the content
// script. This is the measurement that decides whether the preload's 2s reveal
// beat the authoritative pass — the intermittency's root ordering, which was
// previously unmeasurable and therefore argued about.
const marks: Array<{ label: string; t: number }> = [];
// ALWAYS ON, deliberately. An earlier revision gated this on the debug toggle
// and claimed "a normal load allocates nothing" — but `init-start` is recorded
// before prefs have arrived (the first messaging round-trip is what reveals
// debugMode), so a gate keyed on it would discard the only marks that matter.
// Cost is ~9 marks and ~9 attribute writes per load, no allocation worth
// defending. `enableTimings`/`disableTimings` exist for tests, which need a
// clean slate and a way to prove the gate is respected.
let marksEnabled = true;
// Mirrored onto <html> so the PRELOAD's diagnostic can read them. Both scripts
// record against the same document performance timeline, which is what makes
// the ordering question ("did the 2s cover-reveal beat the authoritative
// processResults?") answerable at all.
const ATTR_MARKS = "data-shh-diag-marks";

/** Record a phase boundary. Cost is one array push plus one attribute write. */
export function diagMark(label: string): void {
  if (!marksEnabled) return;
  const t = Math.round(performance.now());
  marks.push({ label, t });
  try {
    document.documentElement.setAttribute(
      ATTR_MARKS,
      marks.map((m) => `${m.t}:${m.label}`).join("|")
    );
  } catch { /* detached document — ignore */ }
}

/** Clear the timeline and resume recording. Used by tests. */
export function enableTimings(): void {
  marksEnabled = true;
  marks.length = 0;
}

export function disableTimings(): void {
  marksEnabled = false;
}

export function timingSnapshot(): { label: string; tMs: number; deltaMs: number }[] {
  let prev = 0;
  return marks.map((m) => {
    const row = { label: m.label, tMs: m.t, deltaMs: m.t - prev };
    prev = m.t;
    return row;
  });
}

// ── Live resolver reference ──────────────────────────────────────────────
//
// WHY A RESOLVER AND NOT JUST A MATCHER FUNCTION
// ----------------------------------------------
// The first version of this instrumentation exposed only `setDiagMatcher`, and
// the D1 detector re-derived everything else itself: it walked a hard-coded list
// of Google class names and read `<cite>` text for the URL. A review showed
// that made the report lie in both directions —
//
//   * FALSE POSITIVE: RESULT_CANDIDATES includes three SECTION wrappers, so one
//     blocked result inside `MjjYud > tF2Cxc > N54PNb > kb0PBd` was counted up
//     to FOUR times. An AI Overview whose first cited source is blocked is
//     deliberately left visible by the ambiguity guard, and the probe reported
//     it as a defect. A result the PRELOAD hid (data-shh-preloaded, no
//     data-shh-result) was reported as "visible".
//   * FALSE NEGATIVE: a breadcrumb cite (`example.com › page`) is split by
//     `domainFromDisplayText` in production and NOT by the probe, so real
//     blocked results were invisible to it. And if Google rotates its classes
//     the probe iterates nothing and reports a confident zero.
//
// The only way a diagnostic can be trusted is if it calls the SAME functions
// the code under test calls. So the content script registers the engine's own
// discovery + URL resolution, and this module measures rather than guesses.
export interface DiagResolver {
  /** The production result discovery, verbatim. */
  resultNodes: () => Element[];
  /** The production per-node URL resolution, verbatim. */
  resultUrl: (node: Element) => string | null;
  /** The live matcher. */
  isBlocked: (url: string) => boolean;
  /** False when blocking is suspended — NOTHING is hidden by design then. */
  engineActive: boolean;
  engineId: string | null;
  /** False when the page is not a recognised search results page. */
  isSerp: boolean;
}

let resolver: DiagResolver | null = null;

export function setDiagResolver(r: DiagResolver | null): void {
  resolver = r;
}

export function getDiagResolver(): DiagResolver | null {
  return resolver;
}

export interface DiagMatcherInfo {
  /** Length of the stored list, including disabled entries. */
  entriesTotal: number;
  /** Domains the matcher actually holds — disabled entries are skipped by it. */
  entriesEnabled: number;
  wildcard: boolean;
  /**
   * Where the list came from — the D5 discriminator.
   *
   * `storage` is the healthy fast path: the content script read
   * `storage.local` / `storage.sync` itself, with no background round-trip and
   * so no dependency on a cold MV3 event page. `background` means it fell back
   * to messaging. `cache`/`defaults` mean a degraded start. `paused` means the
   * saved state said the user suspended blocking.
   */
  source: "storage" | "background" | "cache" | "defaults" | "paused" | "unknown";
  degradedStart: boolean;
  stateAuthoritative: boolean;
}

let matcherInfo: DiagMatcherInfo = {
  entriesTotal: -1,
  entriesEnabled: -1,
  wildcard: true,
  source: "unknown",
  degradedStart: false,
  stateAuthoritative: true,
};

/** Called whenever the matcher or its provenance changes. */
export function setDiagMatcherInfo(patch: Partial<DiagMatcherInfo>): void {
  matcherInfo = { ...matcherInfo, ...patch };
}

// ── Built-in field diagnostic ────────────────────────────────────────────
//
// Port of docs/field-diagnostic.js. Kept in TypeScript so it cannot drift
// from the attributes the content scripts actually write.

/** Selectors counted unconditionally — cheap, and useful even with debug off. */
const COUNT_SELECTORS = [
  "#rso",
  "#search",
  "#center_col",
  "div.MjjYud",
  "div.tF2Cxc",
  "div.N54PNb",
  "div.kb0PBd",
  "div.g",
  "h3",
  "cite",
  "#pnnext",
] as const;

/**
 * Per-result containers, most specific first. Divergences between these
 * counts are diagnostic on their own: kb0PBd is the 2026 per-result node
 * while MjjYud / tF2Cxc are section wrappers, so a healthy page shows
 * kb0PBd >> MjjYud.
 */
const RESULT_CANDIDATES = [
  "div.kb0PBd",
  "div.N54PNb",
  "div.g",
  "div.tF2Cxc",
  "div.MjjYud",
] as const;

export interface ShhDiagPreload {
  raw: string;
  version: string | null;
  host: string | null;
  domains: string | null;
  paused: string | null;
  activeAttribute: string | null;
}

export interface ShhDiagLifecycle {
  shhDiag: string;
  processed: string | null;
}

export interface ShhDiagEffect {
  stampedResult: number;
  hidden: number;
  clearedOk: number;
  placeholders: number;
  /** Injected block buttons. Must not exceed the number of on-screen results. */
  buttons: number;
  /** Headings carrying two or more buttons — the "double block buttons" symptom. */
  headingsWithTwoButtons: number;
  /**
   * THE D1 SIGNAL. Results that are on screen, carry NO `data-shh-result`, and
   * whose URL the CURRENT matcher says is blocked.
   *
   * On a healthy page this is 0. If it is > 0, a domain the user has blocked is
   * visible — and the count is exactly how many. That is the defect the D1 fix
   * addresses (a domain blocked while the tab was open was never applied to
   * results already on screen), and it is invisible to every other field in
   * this report: those results look completely normal.
   */
  visibleButBlocked: number;
  /** Sample hosts behind `visibleButBlocked`, so the paste is actionable. */
  visibleButBlockedHosts: string[];
  /** True when there were more matches than the 8-host sample holds. */
  visibleButBlockedTruncated: boolean;
  /**
   * False when the D1 loop could not run because no resolver was registered.
   * A previous revision reported `visibleButBlocked: 0` in that case, which
   * reads as "no problem" on precisely the page you would paste it from.
   */
  detectorArmed: boolean;
  /** False when blocking is suspended — nothing is hidden, by design. */
  engineActive: boolean;
  isSerp: boolean | null;
  engineId: string | null;
}

/** Why a result-shaped node was not offered as a result. Debug mode only. */
export interface ShhDiagDiscovery {
  /** Nodes the adapter actually returned this page load. */
  offeredLastScan: number;
  probeSelector: string | null;
  /**
   * Which guard rejected the probe node, or `notRejected` when no guard the
   * probe knows about fired. The previous revision used `null` for both "it was
   * offered" and "not offered by a guard the probe does not check", so a
   * reader took the second as the first.
   */
  probeRejectedBy: ProbeRejectionReason | "notRejected" | null;
  probeHeadingFound: boolean | null;
  probeHost: string | null;
  probeCiteCount: number | null;
  /**
   * Nodes shaped like a multi-result section (>=2 headings) whose descent would
   * resolve nothing — the population the `google-dom.ts` section-skip guard
   * discards. Restricted to nodes with NO result-shaped descendants: the
   * previous version counted every section wrapper Google ships (MjjYud,
   * tF2Cxc) and then described the resulting number as "the evidence B1 would
   * need", manufacturing support for a fix the code deliberately withheld.
   */
  sectionShaped: number;
  /**
   * Result-shaped nodes citing MORE THAN ONE distinct domain — the population
   * the `google-dom.ts` ambiguity guard discards. Non-zero here is the evidence
   * B2 would need.
   */
  multiCite: number;
}

export interface ShhDiagResults {
  resolvedBy: string | null;
  count: number;
  allCandidateCounts: Record<string, number>;
  /** Only populated when Debug mode is on — costs a 1500-char slice. */
  pathFromRso: string | null;
  citeInsideResult: boolean | null;
  citeText: string | null;
  firstResultHTML: string | null;
}

export interface ShhDiagLinkEncoding {
  opaqueGoto: number;
  urlRedirect: number;
  direct: number;
  internal: number;
  total: number;
  samples: { opaqueGoto: string[]; urlRedirect: string[]; direct: string[] };
}

export interface ShhDiagnostics {
  accounting: ResultAccounting;
  url: string;
  debugMode: boolean;
  /** Non-empty when the report was truncated because Debug mode is off. */
  hint: string;
  build: {
    version: string | null;
    firefox: string | null;
    userAgent: string;
    /** True when this document is a bfcache restore — several paths re-run. */
    bfcacheRestored: boolean;
  };
  preload: ShhDiagPreload;
  /** Matcher size + provenance. `source: "cache"` with `entries: 0` is D5. */
  matcher: DiagMatcherInfo;
  /** Init-phase timeline, in ms from the content script's first statement. */
  timings: { label: string; tMs: number; deltaMs: number }[];
  lifecycle: ShhDiagLifecycle;
  /** Per-guard rejection counts — which guard ate the result. */
  rejected: Record<RejectionReason, number>;
  /** Only the most recent processResults() batch. See `beginRejectionBatch`. */
  rejectedLastBatch: Record<RejectionReason, number> | null;
  effect: ShhDiagEffect;
  discovery: ShhDiagDiscovery;
  results: ShhDiagResults;
  linkEncoding: ShhDiagLinkEncoding;
  counts: Record<string, number>;
}

const EMPTY_SAMPLES = { opaqueGoto: [], urlRedirect: [], direct: [] };

/**
 * Snapshot everything needed to debug a "nothing is hidden" report.
 *
 * Always safe to call. With Debug mode off it returns the cheap,
 * non-identifying summary plus a hint; the heavy fields (markup slice,
 * href samples, DOM path) are only collected when the toggle is on.
 */
/** One result-shaped leaf and what the extension actually did with it. */
export interface ResultOutcome {
  selector: string;
  state: "hidden" | "button" | "shownOnce" | "unmarked";
  /** Production-resolved URL, or null when the adapter could not resolve one. */
  url: string | null;
  /** The live matcher's verdict on `url`, or null when unknown. */
  matched: boolean | null;
  /** Which guard explains an `unmarked` leaf. */
  why: "not-blocked" | "noUrl" | "section" | "aggregate" | "multiCite" | "noMatcher" | "unknown";
}

export interface ResultAccounting {
  /** Result-shaped leaves on the page (section wrappers excluded). */
  leaves: number;
  /** Leaves the adapter offered for processing. */
  offered: number;
  hidden: number;
  withButton: number;
  shownOnce: number;
  /** Leaves with neither a hide nor a button — the ambiguous population. */
  unmarked: number;
  /**
   * Of the unmarked leaves, how many the LIVE matcher says ARE blocked. >0 is a
   * confirmed defect, and it is not a guess: it comes from the same matcher the
   * blocking path uses, via the production resolver.
   */
  unmarkedButBlocked: number;
  /** Per-leaf detail for the unmarked ones (capped). */
  detail: ResultOutcome[];
}

/**
 * Classify every result-shaped leaf by its real DOM outcome.
 *
 * A "leaf" is a result-shaped candidate with NO result-shaped descendant, so
 * section wrappers are excluded — counting a wrapper as a result is exactly
 * what inflated `discovery.multiCite` 6x.
 *
 * The four "unmarked" causes are indistinguishable from the outside today:
 * correctly not blocked / dropped by a discovery guard / unresolvable URL /
 * dropped by an aggregate. Each is resolved here with the SHIPPED guards
 * (`looksLikeGoogleSection`, `looksLikeGoogleAggregate`, `googleDisplayDomains`)
 * and the PRODUCTION resolver, so a field report can finally tell them apart.
 */
function buildResultAccounting(doc: Document, res: DiagResolver | null): ResultAccounting {
  const acc: ResultAccounting = {
    leaves: 0, offered: 0, hidden: 0, withButton: 0, shownOnce: 0,
    unmarked: 0, unmarkedButBlocked: 0, detail: [],
  };

  let offeredSet: Set<Element> | null = null;
  if (res) {
    try {
      offeredSet = new Set(res.resultNodes());
    } catch { /* the adapter threw; `offered` stays 0 and `why` degrades to unknown */ }
  }

  const sel = RESULT_CANDIDATES.join(",");
  const seen = new Set<Element>();
  for (const s of RESULT_CANDIDATES) {
    for (const el of Array.from(doc.querySelectorAll(s))) {
      if (seen.has(el)) continue;
      if (el.querySelectorAll(sel).length > 0) continue; // a container, not a leaf
      seen.add(el);
      acc.leaves++;
      if (offeredSet && offeredSet.has(el)) acc.offered++;

      if (el.hasAttribute("data-shh-result")) { acc.hidden++; continue; }
      // The block button is signalled two ways and BOTH must be checked, on the
      // node ITSELF as well as its subtree: `injectBlockButton` stamps
      // `data-shh-btn` on the container it was handed (the result node), while
      // the button element itself only carries the `shh-block-btn` class and
      // may be injected into a heading deeper down. An earlier revision of this
      // check looked only at descendants for the attribute, so every
      // button-bearing result was misreported as `unmarked` — withButton came
      // out 0 on a page with two buttons on it.
      const hasButton =
        el.hasAttribute("data-shh-btn") ||
        el.classList.contains("shh-block-btn") ||
        !!el.querySelector("[data-shh-btn], .shh-block-btn");
      if (hasButton) { acc.withButton++; continue; }
      if (el.classList.contains("shh-shown-result")) { acc.shownOnce++; continue; }

      acc.unmarked++;
      let url: string | null = null;
      try { url = res ? res.resultUrl(el) : null; } catch { url = null; }
      let matched: boolean | null = null;
      if (url && res) {
        try { matched = res.isBlocked(url); } catch { matched = null; }
      }
      if (matched === true) acc.unmarkedButBlocked++;

      let why: ResultOutcome["why"];
      if (!res) why = "noMatcher";
      else if (looksLikeGoogleSection(el)) why = "section";
      else if (looksLikeGoogleAggregate(el)) why = "aggregate";
      else if (!url) why = "noUrl";
      else if (googleDisplayDomains(el).length > 1) why = "multiCite";
      else why = matched === true ? "unknown" : "not-blocked";

      if (acc.detail.length < 12) {
        acc.detail.push({ selector: s, state: "unmarked", url, matched, why });
      }
    }
  }
  return acc;
}

export function collectDiagnostics(doc: Document = document): ShhDiagnostics {
  const q = (sel: string): Element | null => doc.querySelector(sel);
  const qa = (sel: string): Element[] => Array.from(doc.querySelectorAll(sel));
  const html = doc.documentElement;

  // ── Which build is loaded, and what did it see? ────────────────────────
  // Written synchronously by preload.ts at document_start:
  //   build=v1.8.20+56f9ebf;host=www.google.com;domains=71;paused=false
  //
  // The key was `v` until 2026-09-29, when the build stamp began carrying its
  // own leading "v" and the attribute read "v=v1.8.20+...". Both spellings are
  // accepted so a report from a pre-stamp build still parses.
  const preloadRun = html.getAttribute("data-shh-preload-run") ?? "";
  const fieldOf = (name: string): string | null => {
    const m = new RegExp(`(?:^|;)\\s*${name}=([^;]*)`).exec(preloadRun);
    return m?.[1] ?? null;
  };

  const preload: ShhDiagPreload = {
    raw: preloadRun || "(missing — preload script did not run)",
    version: fieldOf("build") ?? fieldOf("v"),
    host: fieldOf("host"),
    domains: fieldOf("domains"),
    paused: fieldOf("paused"),
    // Set only when the block list is non-empty AND the host is Google;
    // arms the static anti-flicker CSS cover.
    activeAttribute: html.getAttribute("data-shh-active"),
  };

  // ── What did the main content script do? ───────────────────────────────
  // shhLog() mirrors every [SHH] console line into <html data-shh-diag>.
  //
  // The window was 800 chars of a 10-line ring buffer, which dropped the
  // `engine=… entries=N` line on any load that retried — exactly the loads
  // worth diagnosing. Raised to 4000 chars; shhLog's own ring is widened in
  // index.ts to match.
  const diag = html.getAttribute("data-shh-diag") ?? "";
  const lifecycle: ShhDiagLifecycle = {
    // KEEP THE TAIL. `slice(0, 4000)` kept the OLDEST lines of a ring buffer
    // and silently dropped the newest — which are exactly the interesting ones
    // (`init done:`, `reconciled:`, `cache write skipped`, `resume re-read
    // list`). The truncation was invisible, so a long session showed a stale
    // head and read as if nothing had happened since page load.
    shhDiag: tail(diag, 4000) || "(empty — main content script did not run)",
    processed: /init done: processed=(\d+)/.exec(diag)?.[1] ?? null,
  };

  // ── Matcher provenance: the D5 discriminator ───────────────────────────
  // `source: "cache"` with `entries: 0` means a cold background produced an
  // empty matcher, and pre-paint hiding is suppressed for the session (D5).
  // `entries >= 1` with `visibleButBlocked > 0` means the state is fine and
  // the defect is in the guards (D1 / the section guards).
  const matcher = { ...matcherInfo };

  const timings = timingSnapshot();

  // ── Proof of effect: did anything actually get hidden? ─────────────────
  //
  // visibleButBlocked is the single most important number in this report. It
  // re-runs the LIVE matcher over every on-screen result that carries no
  // stamp. A hit means the user's own block list says that result should be
  // hidden and it is not — the reported bug, quantified.
  // Walk the PRODUCTION discovery, not a hard-coded class list, and resolve each
  // node with the PRODUCTION resolver. An earlier revision did neither: it
  // iterated `RESULT_CANDIDATES` (which includes three section wrappers, so one
  // blocked result was counted up to four times) and read `<cite>` text (which
  // does not split breadcrumbs, so real blocked results were invisible to it —
  // and which reports an AI Overview the ambiguity guard DELIBERATELY left
  // visible as a defect). If a diagnostic does not call the same functions the
  // code under test calls, it measures a different system.
  const visibleButBlockedHosts: string[] = [];
  let visibleButBlocked = 0;
  let visibleButBlockedTruncated = false;
  if (resolver) {
    let nodes: Element[] = [];
    try {
      // *** NOT resolver.resultNodes() — that made this scan structurally dead. ***
      //
      // `isValidResult()` already excludes any node carrying `data-shh-result`
      // (google.ts), and the loop below skips exactly those nodes. So after the
      // first processing pass `resultNodes()` is EMPTY, the loop never executes,
      // and `visibleButBlocked` was always 0. The report calls it "the single
      // most important number" and it could not fire — a diagnostic that cannot
      // detect the defect it exists for, in the one place a field report is read
      // for that exact verdict.
      //
      // Enumerate DOM leaves the same way `buildResultAccounting` does, so both
      // diagnostics measure the same population. A container is skipped (it has
      // candidate descendants), and the per-node stamp checks below are what
      // decide whether a leaf is genuinely visible-but-blocked.
      const sel = RESULT_CANDIDATES.join(",");
      const seen = new Set<Element>();
      for (const s of RESULT_CANDIDATES) {
        for (const el of Array.from(doc.querySelectorAll(s))) {
          if (seen.has(el)) continue;
          if (el.querySelectorAll(sel).length > 0) continue; // a container, not a leaf
          seen.add(el);
          nodes.push(el);
        }
      }
    } catch { /* the adapter threw — reported via rejected.adapterOfferedNone */ }
    for (const el of nodes) {
      // Skip anything the extension already decided about:
      //   data-shh-result  — the content script hid it (working as intended)
      //   data-shh-preloaded / .shh-hidden / .shh-pban — the preload hid it
      // Counting the preload's layer as "visible" is how a correctly-working
      // degraded start manufactures D1 evidence.
      if (el.hasAttribute("data-shh-result")) continue;
      if (
        el.hasAttribute("data-shh-preloaded") ||
        el.classList.contains("shh-hidden") ||
        el.classList.contains("shh-pban")
      ) {
        continue;
      }
      let url: string | null = null;
      try {
        url = resolver.resultUrl(el);
      } catch { continue; }
      if (!url) continue;
      let blocked = false;
      try {
        blocked = resolver.isBlocked(url);
      } catch { continue; }
      if (!blocked) continue;
      visibleButBlocked++;
      // Cap the SAMPLE only. The previous version `continue`d before the
      // increment, so the reported number silently saturated at 8 while the
      // UI claimed it was exact.
      if (visibleButBlockedHosts.length < 8) {
        let host = url;
        try { host = new URL(url).hostname || url; } catch { /* keep raw */ }
        visibleButBlockedHosts.push(host.slice(0, 60));
      } else {
        visibleButBlockedTruncated = true;
      }
    }
  }

  const effect: ShhDiagEffect = {
    stampedResult: qa("[data-shh-result]").length,
    hidden: qa("[data-shh-preloaded]").length,
    clearedOk: qa("[data-shh-ok]").length,
    placeholders: qa(".shh-placeholder").length,
    // Duplicate-UI check (field report 2026-08-30: "double block buttons /
    // double boxes"). Every visible result should carry AT MOST one button and
    // every blocked result AT MOST one placeholder, so these two counts must
    // never exceed the number of results on screen. If `buttons` is higher
    // than the number of visible results, a container is still being processed
    // as a result — see blocking/dedupe.ts.
    buttons: qa(".shh-block-btn").length,
    // Headings holding more than one button — the exact visible symptom.
    headingsWithTwoButtons: Array.from(doc.querySelectorAll("h3, h2")).filter(
      (h) => h.querySelectorAll(".shh-block-btn").length > 1
    ).length,
    visibleButBlocked,
    visibleButBlockedHosts,
    visibleButBlockedTruncated,
    /** The detector could not run — no resolver was registered. */
    detectorArmed: resolver !== null,
    /** False when blocking is suspended: nothing is hidden, by design. */
    engineActive: resolver?.engineActive ?? true,
    isSerp: resolver?.isSerp ?? null,
    engineId: resolver?.engineId ?? null,
  };

  // ── Structure ─────────────────────────────────────────────────────────
  const found: Array<{ sel: string; n: number }> = [];
  const allCandidateCounts: Record<string, number> = {};
  for (const sel of RESULT_CANDIDATES) {
    const n = qa(sel).length;
    allCandidateCounts[sel] = n;
    if (n > 0) found.push({ sel, n });
  }
  const best = found[0] ?? null;
  const first = best ? q(best.sel) : null;

  // ── Link encoding ─────────────────────────────────────────────────────
  // The single most diagnostic question. On 2026-08-30 Google switched to
  // opaque /goto?url= tokens, which silently defeated every "is this link
  // external?" check in the codebase.
  const links = qa("#rso a[href]");
  const linkEncoding: ShhDiagLinkEncoding = {
    opaqueGoto: 0,
    urlRedirect: 0,
    direct: 0,
    internal: 0,
    total: links.length,
    samples: { ...EMPTY_SAMPLES },
  };

  const wantSamples = debugEnabled;
  const push = (bucket: "opaqueGoto" | "urlRedirect" | "direct", v: string): void => {
    if (!wantSamples) return;
    if (linkEncoding.samples[bucket].length < 2) {
      linkEncoding.samples[bucket].push(v.slice(0, 90));
    }
  };

  for (const el of links) {
    const a = el as HTMLAnchorElement;
    const raw = a.getAttribute("href") ?? "";
    if (raw.includes("/goto?url=")) {
      linkEncoding.opaqueGoto++;
      push("opaqueGoto", raw);
    } else if (raw.startsWith("/url?") || raw.includes("google.com/url")) {
      linkEncoding.urlRedirect++;
      push("urlRedirect", raw);
    } else if (/^https?:/i.test(a.href)) {
      linkEncoding.direct++;
      push("direct", a.href);
    } else {
      linkEncoding.internal++;
    }
  }

  // ── Counts (always collected — cheap) ──────────────────────────────────
  const counts: Record<string, number> = {};
  for (const sel of COUNT_SELECTORS) counts[sel] = qa(sel).length;

  // ── Heavy fields: Debug mode only ──────────────────────────────────────
  let pathFromRso: string | null = null;
  let citeInsideResult: boolean | null = null;
  let citeText: string | null = null;
  let firstResultHTML: string | null = null;

  if (debugEnabled && first) {
    const chain: string[] = [];
    for (let el: Element | null = first; el; el = el.parentElement) {
      const cls = el.className ? "." + String(el.className).split(" ")[0] : "";
      chain.unshift(el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + cls);
      if (el.id === "rso") break;
    }
    pathFromRso = chain.join(" > ") || null;

    const cite = first.querySelector("cite");
    citeInsideResult = cite !== null;
    citeText = cite?.textContent?.trim() ?? null;
    firstResultHTML = first.outerHTML.slice(0, 1500);
  }

  // ── Discovery probe: why was this node not offered as a result? ─────────
  // The blocker-gap closer. B1 (section-shaped nodes dropped) and B2 (cards
  // citing more than one domain) are deliberately NOT implemented because no
  // capture could prove either fires. These counts are meant to be that
  // evidence — but an earlier revision of this probe manufactured it: it
  // counted section wrappers Google INTENDS to descend into (MjjYud, tF2Cxc)
  // as "section shaped", and its comment then described that non-zero number
  // as "the evidence B1 would need". It also ran the guards in a different
  // order than production, so `section` was unreachable for the case it exists
  // for while `multiCite` shadowed it, and `aggregate`/`nonResult` were dead
  // branches. Fixed below: the guards are the SHIPPED ones, in the SHIPPED
  // order, and the population counts are restricted to nodes production would
  // actually reject.
  const discovery: ShhDiagDiscovery = {
    offeredLastScan: 0,
    probeSelector: null,
    probeRejectedBy: null,
    probeHeadingFound: null,
    probeHost: null,
    probeCiteCount: null,
    sectionShaped: 0,
    multiCite: 0,
  };

  if (debugEnabled) {
    //
    // BOTH populations are restricted to LEAF result nodes — candidates with no
    // result-shaped descendant of their own.
    //
    // The descendant filter is not optional, and getting it wrong is how the
    // instrument manufactures its own evidence. `RESULT_CANDIDATES` contains
    // three section wrappers (MjjYud, tF2Cxc, N54PNb). A wrapper containing
    // five results from five different domains trivially has >1 distinct
    // domain, so WITHOUT this filter a page with exactly ONE genuine
    // multi-cite card measured `multiCite: 6` — a 6x overcount on the number
    // that is supposed to be the evidence for shipping B2. A reviewer reading
    // "multiCite: 6" would conclude multi-cite cards are common and implement
    // B2 against a number that was mostly section wrappers.
    //
    // `sectionShaped` was restricted first; `multiCite` was missed, because
    // restricting one population makes it look like the other was handled.
    for (const el of qa(RESULT_CANDIDATES.join(","))) {
      const isLeaf = el.querySelectorAll(RESULT_CANDIDATES.join(",")).length === 0;
      if (!isLeaf) continue; // a wrapper: production descends through it
      if (el.querySelectorAll(GOOGLE_HEADING_SELECTOR).length >= SECTION_HEADING_THRESHOLD) {
        discovery.sectionShaped++;
      }
      // Resolved domains, NOT raw cite text. `example.com > page` and
      // `example.com > other` are one domain; comparing raw text called them
      // two and inflated multiCite independently of the wrapper problem.
      if (new Set(googleDisplayDomains(el)).size > 1) discovery.multiCite++;
    }

    // Verdict on one node, using the SAME guards in the SAME order as
    // walkResults(). See engines/google-dom.ts.
    //
    // The node is sampled from the REJECTED population — an un-stamped,
    // un-preloaded candidate that the production discovery did not offer. The
    // previous version sampled `q(best.sel)`, the first match of the MOST
    // SPECIFIC candidate selector, which is systematically the node type most
    // likely to be offered. The probe was biased toward "no defect found" by
    // construction.
    let probe: Element | null = null;
    let probeSel: string | null = null;
    const offered = new Set<Element>();
    try {
      for (const n of resolver?.resultNodes() ?? []) offered.add(n);
    } catch { /* adapter threw — falls through to the DOM-based sample */ }
    for (const sel of RESULT_CANDIDATES) {
      for (const el of qa(sel)) {
        if (offered.has(el)) continue;
        if (el.hasAttribute("data-shh-result")) continue;
        if (el.hasAttribute("data-shh-preloaded")) continue;
        probe = el;
        probeSel = sel;
        break;
      }
      if (probe) break;
    }

    if (probe) {
      discovery.probeSelector = probeSel;
      const heading = probe.querySelector(GOOGLE_HEADING_SELECTOR);
      discovery.probeHeadingFound = heading !== null;
      const citeEls = Array.from(probe.querySelectorAll("cite"));
      discovery.probeCiteCount = citeEls.length;
      const domains = googleDisplayDomains(probe);
      discovery.probeHost = domains.length === 1 ? domains[0]! : null;

      // Mirrors walkResults(): nonResult -> section -> aggregate -> isValid.
      if (isGoogleNonResult(probe)) {
        discovery.probeRejectedBy = "nonResult";
      } else if (looksLikeGoogleSection(probe)) {
        // Only "section" when production is skipping it as a container. If
        // walkResults would first DESCEND and find results, the node is fine.
        const desc = probe.querySelectorAll(RESULT_CANDIDATES.join(",")).length;
        discovery.probeRejectedBy = desc === 0 ? "section" : "notRejected";
      } else if (looksLikeGoogleAggregate(probe)) {
        discovery.probeRejectedBy = "aggregate";
      } else if (!heading) {
        // Inside isValid(), which walkResults runs LAST — after the section and
        // aggregate guards. The previous probe checked the heading first, so it
        // named `notHeading` for nodes production skips as sections.
        discovery.probeRejectedBy = "notHeading";
      } else if (domains.length === 0) {
        discovery.probeRejectedBy = "noHost";
      } else if (domains.length > 1) {
        discovery.probeRejectedBy = "multiCite";
      } else {
        // NOT `null`. `null` is documented as "it WAS offered", and the previous
        // revision set it here too — which fires for "not offered, and rejected
        // by a guard the probe does not check". That told a reader the node was
        // healthy. `notRejected` means exactly what it says.
        discovery.probeRejectedBy = "notRejected";
      }
    }
  }

  // ── Result accounting: what happened to every result-shaped leaf ──────────
  //
  // Two independent reviews converged on this being the missing measurement,
  // and the field run is why. `processed=5` is the ADAPTER'S OFFERED count
  // (`index.ts` logs `getCachedResultNodes().length`), not the number of
  // results on the page. A SERP showing a dozen-odd results offered only five
  // because `looksLikeGoogleSection`, `looksLikeGoogleAggregate` and the
  // multi-cite ambiguity guard each drop nodes ENTIRELY — by design, failing
  // open — and NOT ONE of them increments a `rejected` counter. So the single
  // most likely reason a blocked result stays visible produces no trace
  // anywhere in the report.
  //
  // This block closes that. Every result-shaped LEAF is classified by its
  // actual DOM outcome, and anything ambiguous is named using the PRODUCTION
  // resolver's verdict rather than a re-derived guess.
  const accounting = buildResultAccounting(doc, resolver);

  return {
    accounting,
    url: doc.location?.href ?? "(no location)",
    debugMode: debugEnabled,
    hint: debugEnabled
      ? ""
      : "Debug mode is OFF — markup samples, href samples and the discovery " +
        "probe are omitted. Enable it in SHH → Advanced, reload, then run " +
        "copy(__shhDiag()).",
    build: {
      // Fall back to the manifest: a field paste that cannot name the build it
      // came from is a paste you cannot act on, and `preload.version` is null
      // whenever the preload did not run — which is itself a thing being
      // diagnosed.
      version: preload.version ?? safeManifestVersion(),
      firefox:
        typeof navigator !== "undefined" && /Firefox\/(\d+)/.test(navigator.userAgent)
          ? (/Firefox\/(\d+)/.exec(navigator.userAgent)?.[1] ?? null)
          : null,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "(none)",
      // Measured, via an extracted pure predicate so it is testable at all
      // (jsdom has no performance.getEntriesByType).
      bfcacheRestored: isBfcacheRestore(readNavigationType()),
    },
    preload,
    matcher,
    timings,
    lifecycle,
    rejected: rejectionSnapshot(),
    rejectedLastBatch: lastBatchSnapshot(),
    effect,
    discovery,
    results: {
      resolvedBy: best?.sel ?? null,
      count: best?.n ?? 0,
      allCandidateCounts,
      pathFromRso,
      citeInsideResult,
      citeText,
      firstResultHTML,
    },
    linkEncoding,
    counts,
  };
}
