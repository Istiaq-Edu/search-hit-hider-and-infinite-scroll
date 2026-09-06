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

let debugEnabled = false;

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
  url: string;
  debugMode: boolean;
  /** Non-empty when the report was truncated because Debug mode is off. */
  hint: string;
  preload: ShhDiagPreload;
  lifecycle: ShhDiagLifecycle;
  effect: ShhDiagEffect;
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
export function collectDiagnostics(doc: Document = document): ShhDiagnostics {
  const q = (sel: string): Element | null => doc.querySelector(sel);
  const qa = (sel: string): Element[] => Array.from(doc.querySelectorAll(sel));
  const html = doc.documentElement;

  // ── Which build is loaded, and what did it see? ────────────────────────
  // Written synchronously by preload.ts at document_start:
  //   v=1.8.3;host=www.google.com;domains=71;paused=false
  const preloadRun = html.getAttribute("data-shh-preload-run") ?? "";
  const fieldOf = (name: string): string | null => {
    const m = new RegExp(`(?:^|;)\\s*${name}=([^;]*)`).exec(preloadRun);
    return m?.[1] ?? null;
  };

  const preload: ShhDiagPreload = {
    raw: preloadRun || "(missing — preload script did not run)",
    version: fieldOf("v"),
    host: fieldOf("host"),
    domains: fieldOf("domains"),
    paused: fieldOf("paused"),
    // Set only when the block list is non-empty AND the host is Google;
    // arms the static anti-flicker CSS cover.
    activeAttribute: html.getAttribute("data-shh-active"),
  };

  // ── What did the main content script do? ───────────────────────────────
  // shhLog() mirrors every [SHH] console line into <html data-shh-diag>.
  const diag = html.getAttribute("data-shh-diag") ?? "";
  const lifecycle: ShhDiagLifecycle = {
    shhDiag: diag.slice(0, 800) || "(empty — main content script did not run)",
    processed: /init done: processed=(\d+)/.exec(diag)?.[1] ?? null,
  };

  // ── Proof of effect: did anything actually get hidden? ─────────────────
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

  return {
    url: doc.location?.href ?? "(no location)",
    debugMode: debugEnabled,
    hint: debugEnabled
      ? ""
      : "Debug mode is OFF — markup samples and href samples omitted. " +
        "Enable it in SHH → Advanced, reload, then run copy(__shhDiag()).",
    preload,
    lifecycle,
    effect,
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
