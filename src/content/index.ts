import type { BlockEntry, Prefs, BlockMode } from "../shared/types";
import { DEFAULT_PREFS } from "../shared/types";
import { detectEngine } from "./engines/registry";
import type { EngineAdapter } from "./engines/base";
import type { MatchResult } from "./blocking/matcher";
import { DomainMatcher } from "./blocking/matcher";
import { hideResult, showOnce, rehideResult, restoreByDomain, getHiddenNodes, convertHiddenToPermaban, restoreResult, hasPreloadHiding, revealPreloadHiding } from "./blocking/hider";
import { ResultObserver } from "./blocking/observer";
import { containsProcessed, isInsideProcessedTerritory, looksLikeResultList, overlapsProcessed } from "./blocking/dedupe";
import { reconcileAgainstBlockList } from "./blocking/reconcile";
import { classifyPrefsTransition, isEngineActive } from "./prefs-transition";
import { RefreshQueue, shouldReScan, runSuspendTeardown, type RefreshKind } from "./refresh-queue";
import {
  CACHE_KEY,
  buildCache,
  canPublishCache,
  entriesFromCache,
  parseCache,
  prefsFromCache,
  serializeCache,
} from "./cache-state";
import { injectBaseStyles } from "./ui/styles";
import { injectBlockButton } from "./ui/block-button";
import { showBlockDialog } from "./ui/block-dialog";
import { showToast } from "./ui/toast";
import { getList, getPrefs, getListDirect, getPrefsDirect, addEntry, removeEntry, updateEntry, undoLast } from "./messaging";
import { InfiniteScrollManager } from "./infinite-scroll/manager";
import { setDebugMode, isDebugMode, seedDebugFromCache, collectDiagnostics, bumpRejection, beginRejectionBatch, diagMark, setDiagResolver, setDiagMatcherInfo } from "./debug";

// ============================================================
// Content script entry point
// ============================================================

// Shared action handler class — reduces per-node closure allocations
class ResultActions {
  constructor(
    private node: Element,
    private domain: string,
    private url: string,
    private matchResult: MatchResult,
    private prefs: Prefs,
    private engine: EngineAdapter,
    private onStateChange: () => void
  ) {}

  doShowOnce = (): void => {
    showOnce(this.node, this.domain, this.doRehide, this.doUnblock);
  };

  doRehide = (): void => {
    rehideResult(this.node, this.matchResult, this.url, this.prefs.showNotices,
      this.doShowOnce, this.doUnblock, this.doPermaban);
  };

  doUnblock = async (): Promise<void> => {
    const releasedRoots = restoreByDomain(this.domain);
    const releasedSet = new Set(releasedRoots);

    entries = entries.filter((e) => e.domain !== this.domain);
    refreshMatcher();
    updateCache();
    updateHasRules();

    const allNodes = getCachedResultNodes();
    processResults(allNodes.filter((n) => !releasedSet.has(n)));

    for (const n of releasedRoots) {
      const nodeUrl = this.engine.getResultUrl(n);
      if (nodeUrl) injectButtonForResult(n, nodeUrl);
    }

    await removeEntry(this.domain);
    showToast(`Unblocked ${this.domain}`, async () => {
      const restored = await undoLast();
      if (restored) {
        entries = [...entries, restored];
        refreshMatcher();
        updateCache();
        processResults(this.engine.getResultNodes(document));
        updateHasRules();
      }
    });
  };

  doPermaban = async (): Promise<void> => {
    entries = entries.map((entry) =>
      entry.domain === this.domain ? { ...entry, mode: "pban" as const, enabled: true } : entry
    );
    refreshMatcher();
    updateCache();
    updateHasRules();
    convertHiddenToPermaban(this.node);
    await updateEntry(this.domain, { mode: "pban", enabled: true });
    showToast(`Perma-banned ${this.domain}`, async () => {
      entries = entries.map((entry) =>
        entry.domain === this.domain ? { ...entry, mode: "block" as const, enabled: true } : entry
      );
      refreshMatcher();
      updateCache();
      updateHasRules();
      restoreResult(this.node);
      hideResult(
        this.node,
        { matched: true, domain: this.domain, mode: "block" },
        this.url,
        this.prefs.showNotices,
        this.doShowOnce,
        this.doUnblock,
        this.doPermaban
      );
      await updateEntry(this.domain, { mode: "block", enabled: true });
    });
  };
}

let entries: BlockEntry[] = [];
let prefs: Prefs | null = null;
let matcher: DomainMatcher | null = null;
let observer: ResultObserver | null = null;
let infiniteScrollManager: InfiniteScrollManager | null = null;
let cachedResultNodes: Element[] | null = null;
// Whether blocking is currently active for this engine (not paused, engine on).
// Tracked so pref changes can transition the page live instead of requiring
// a reload — and so a paused load never hides results it cannot unhide.
let engineActive = false;
// Set when init proceeded from cache/defaults because the background was
// unreachable; reviveFromBackground() heals the state once messaging works.
let degradedStart = false;
// Whether the `entries` we hold came from the real block list. False only while
// running on a degraded (cache-or-defaults) start. D5: an empty list from a
// non-authoritative state must never be published to `_shh_cache`, or it
// becomes indistinguishable from "the user has nothing blocked" and kills
// pre-paint hiding on that origin permanently. See content/cache-state.ts.
let stateAuthoritative = true;

// â”€â”€ Module-scope flags: DECLARED HERE ON PURPOSE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// `init()` is invoked from a top-level `if/else` further down this module, and
// its synchronous prefix — which includes the cache prime — therefore runs
// BEFORE any `let` declared further down has been initialised. These flags used
// to live next to the functions that use them, and the result was a bug no
// amount of source reading made obvious:
//
//   * the prime set `pagePrimed = true`, and then this module's own
//     `let pagePrimed = false` initialiser ran and overwrote it, so the
//     post-authoritative reconcile never happened and a result the stale cache
//     matcher had hidden stayed hidden with no Unblock control;
//   * `tabWired` read as `undefined` on the first call and `false` on the
//     second, so the one-time per-tab hooks were wired twice.
//
// Both latches were inert in the built bundle, which is also why a mutation that
// deleted one of them left the suite GREEN. Keep every flag init()'s synchronous
// prefix can touch above the `void init()` call site.
let pageWired = false;
let pagePrimed = false;
let tabWired = false;

// Concise always-on lifecycle logging — appears in the page console with an
// [SHH] prefix AND is mirrored into <html data-shh-diag> so it survives
// console filters and being opened late. Inspect anytime from DevTools:
//   document.documentElement.getAttribute("data-shh-diag")
const shhDiagLines: string[] = [];
function shhLog(msg: string, data?: unknown): void {
  const line = `t=${Math.round(performance.now())}ms ${msg}` + (data !== undefined && data !== "" ? ` ${String(data)}` : "");
  console.log(`[SHH] ${line}`);
  shhDiagLines.push(line);
  // Was a 10-line ring, which dropped the `engine=—¦ entries=N` line on exactly
  // the retried loads worth diagnosing. Widened to 40; collectDiagnostics reads
  // the first 4000 chars of the joined string.
  if (shhDiagLines.length > 40) shhDiagLines.shift();
  try {
    document.documentElement.setAttribute("data-shh-diag", shhDiagLines.join(" | "));
  } catch { /* detached document — ignore */ }
}

// â”€â”€ Debug gate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Seed synchronously from the preload's localStorage cache so the flag is
// already correct for the FIRST result scan — that scan can happen before
// the async prefs load resolves, and a late flag would silence exactly the
// load we are trying to diagnose. The authoritative pref value is applied
// in init() / refreshPrefs().
seedDebugFromCache();

// Expose the built-in field diagnostic on the page. Deliberately installed
// before engine detection so it is available even on pages we do not
// recognise — "engine not detected" is itself a diagnosis.
//
// Usage from DevTools:  copy(__shhDiag())
(window as Window & { __shhDiag?: () => unknown }).__shhDiag = () => collectDiagnostics();

/**
 * One-click paste-out for field testing.
 *
 * `__shhDiag()` returns an object, which `copy()` puts on the clipboard as
 * JSON-ish text that is painful to read and easy to truncate. This flattens the
 * same report into a labelled, copy-pasteable block, with a short VERDICT line
 * up top so the most important number does not have to be hunted for.
 *
 * Usage from the page console:  copy(__shhDiagText())
 *
 * WHY THE PAGE-WORLD BRIDGE BELOW IS NOT OPTIONAL
 * ----------------------------------------------
 * A content script runs in an ISOLATED WORLD: same DOM, separate JavaScript
 * global. So `window.__shhDiagText` set here is invisible to the page's console
 * — typing `copy(__shhDiagText())` there yields
 *
 *     Uncaught ReferenceError: __shhDiagText is not defined
 *
 * which is exactly what a field run on 2026-09-30 produced. The instructions
 * in the popup have been wrong about this since the function was added, and no
 * amount of rebuilding would have fixed it.
 *
 * `window.wrappedJSObject` is the page's own global, reachable from a content
 * script in Firefox. Publishing the function there makes it callable from the
 * console the user is already looking at. Two properties make this safe:
 *   - it RETURNS A STRING. Primitives cross compartments unchanged, so nothing
 *     needs `cloneInto`/`exportFunction` and no DOM object is ever handed to the
 *     page;
 *   - it is READ-ONLY in effect: it runs `collectDiagnostics` and formats a
 *     string. It changes nothing.
 * An injected `<script>` element would be the other way to reach the page world,
 * and it is the WRONG one here: it is an inline script, which Google's
 * `script-src 'nonce-...' 'strict-dynamic'` blocks, and the CSP audit this
 * session established that we ship zero inline scripts on purpose.
 */
function installPageBridge(fn: () => string, name: string): void {
  try {
    const pageGlobal = (window as unknown as { wrappedJSObject?: Record<string, unknown> })
      .wrappedJSObject;
    if (!pageGlobal) return;
    // `cloneInto` is REQUIRED. Assigning the content-script function directly
    // makes the name visible from the page — so `typeof __shhDiagText` is
    // "function" and the failure moves to the CALL, where Firefox raises
    // "Permission denied to access object". Cloning the function into the page
    // compartment with `functions: "callable"` is what makes it invocable.
    // It is a no-op-safe feature test: absent outside a content script.
    const clone = (globalThis as { cloneInto?: (v: unknown, t: unknown, o?: unknown) => unknown })
      .cloneInto;
    pageGlobal[name] = clone
      ? clone(fn, pageGlobal, { functions: "callable" })
      : fn;
  } catch { /* not a content script context (tests) — the local copy still works */ }
}

/**
 * The preload's cover audit, formatted as a paste-safe string.
 *
 * WHY THIS WRAPPER EXISTS (it is not decoration)
 * ---------------------------------------------
 * The audit itself lives in `preload.ts` as `window.__shhCoverAudit()`. A
 * content script — including the preload — runs in an ISOLATED WORLD, so that
 * name is INVISIBLE to the page console, which is where a user actually types.
 * Telling someone to run `__shhCoverAudit()` there yields
 *
 *     Uncaught ReferenceError: __shhCoverAudit is not defined
 *
 * which is the exact mistake this repo already made once: the popup shipped
 * `copy(__shhDiagText())` for weeks while the function was only ever set in the
 * content-script world (field run 2026-09-30; see `tests/diag-bridge.test.ts`).
 * I repeated it. So the audit is bridged the same way everything else is —
 * through `installPageBridge`, which publishes a STRING-returning function onto
 * the page's own global.
 *
 * Returning a STRING rather than the object is deliberate: primitives cross
 * compartments unchanged, so no `cloneInto` of a live object (and no Xray
 * wrapper) is needed for the RESULT — only for the function.
 *
 * It also lands inside `__shhDiagText()`, so the one command the popup already
 * tells the user to run now answers the cover question too.
 */
const coverAuditText = (): string => {
  try {
    // Same isolated world as the preload, so this name IS reachable from here.
    const fn = (window as Window & { __shhCoverAudit?: () => unknown })
      .__shhCoverAudit;
    if (typeof fn !== "function") {
      return (
        "cover audit UNAVAILABLE — the preload hook is missing. Either this is " +
        "not the build under test, or the preload did not run (check " +
        "`preload-ran` above)."
      );
    }
    const a = fn() as {
      error?: string;
      blankGaps?: number;
      undeterminedCount?: number;
      candidates?: number;
      coverArmed?: boolean;
      active?: boolean;
      undetermined?: Array<Record<string, unknown>>;
    };
    // An oracle that answers "?" is worse than useless — if the hook could not
    // run, SAY WHY. The first version of this returned all-`?` and cost a
    // debugging round to find out that the hook had thrown.
    if (a.error) return `cover audit FAILED inside the preload: ${a.error}`;
    const head =
      `blankGaps=${a.blankGaps ?? "?"}  undetermined=${a.undeterminedCount ?? "?"}  ` +
      `candidates=${a.candidates ?? "?"}  coverArmed=${a.coverArmed}  active=${a.active}`;
    const rows = a.undetermined ?? [];
    if (rows.length === 0) {
      return (
        head +
        "\n  VERDICT: nothing is stuck under the cover. If a blank gap is on " +
        "screen, the cover is NOT its cause — check the node's own opacity/color."
      );
    }
    const detail = rows.map(
      (u) =>
        `  ${String(u.tag)}.${String(u.cls)} opacity=${String(u.opacity)} ` +
        `display=${String(u.display)} h=${String(u.h)} w=${String(u.w)} ` +
        `text="${String(u.text)}"`
    );
    return (
      head +
      `\n  VERDICT: ${String(a.blankGaps)} node(s) are unmarked AND occupying ` +
      "space — that IS the reported bug, and the rows below name them.\n" +
      detail.join("\n")
    );
  } catch (e) {
    return "cover audit threw: " + String(e);
  }
};

const shhDiagText = (): string => {
  const d = collectDiagnostics();
  const doc: Document = document;
  const L: string[] = [];
  // The header stays FIRST: it is the paste marker a field tester looks for,
  // and the stage lines below are what answer the question a `null` report
  // could not — did the script run, and how far did it get?
  L.push("=== SHH FIELD REPORT ===");
  L.push(`stage: ${safeAttr(ATTR_STAGE) ?? "(none - never marked)"}`);
  L.push(`alive: ${safeAttr(ATTR_ALIVE) ?? "(none)"}`);
  L.push(`preload-ran: ${safeAttr("data-shh-preload-run") ? "yes" : "NO"}`);

  // â”€â”€ VERDICT: the numbers that decide the bug â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const lines: string[] = [];
  if (!d.debugMode) {
    lines.push("!! DEBUG MODE IS OFF — re-enable it (Advanced), reload, and run this again.");
  }
  if (d.effect.isSerp === false || d.effect.engineId === null) {
    lines.push(
      "!! NOT A RECOGNISED SEARCH PAGE (or a non-engine path on it) — this report " +
        "is not meaningful. Reproduce on a real results page."
    );
  }
  if (!d.effect.detectorArmed) {
    // Without this, a dead detector reads as a clean bill of health.
    lines.push(
      "!! D1 DETECTOR NOT ARMED — the content script never registered a resolver, " +
        "so visibleButBlocked below is meaningless (it will read 0)."
    );
  }
  if (d.matcher.source === "paused") {
    // MUST come before the empty-matcher verdict: a tab that loaded while
    // paused holds no list and no matcher, and the previous wording sent the
    // user to hunt "defect D5" for a page they had deliberately suspended.
    lines.push(
      "BLOCKING WAS SUSPENDED when this tab loaded (the saved cache said paused), " +
        "so the background was never asked for your list. Nothing is hidden BY " +
        "DESIGN. Un-pause in the popup and RELOAD the tab to test blocking."
    );
  } else if (!d.effect.engineActive) {
    lines.push(
      d.matcher.source === "unknown"
        ? "(engineActive=false, but init has not finished loading your prefs — " +
            "engine state is UNKNOWN. Re-run the report once the page has settled.)"
        : "BLOCKING IS SUSPENDED for this engine (paused globally, this engine " +
            "paused, or its toggle is off). Nothing is hidden BY DESIGN — not a " +
            "bug. If you did not pause it, check the popup's Blocking settings."
    );
  } else if (d.matcher.entriesEnabled === 0) {
    lines.push(
      d.matcher.source === "cache" || d.matcher.source === "defaults"
        ? `!! NO USABLE BLOCK LIST (source=${d.matcher.source}, ${d.matcher.entriesTotal} stored, ` +
          `${d.matcher.entriesEnabled} enabled). A cold background produced no list; ` +
          "nothing can be hidden until it revives. (defect D5)"
        : `!! matcher holds 0 ENABLED domains (${d.matcher.entriesTotal} stored). ` +
          "If you have blocked domains, every one of them is DISABLED — check the list's ON/OFF."
    );
  }
  // Gated: on a suspended page nothing is hidden, so every result is
  // "visible but blocked" and reporting that as a defect is pure noise.
  if (d.effect.visibleButBlocked > 0 && d.effect.detectorArmed && d.effect.engineActive) {
    lines.push(
      `!! ${d.effect.visibleButBlocked} ON-SCREEN RESULT(S) MATCH THE BLOCK LIST BUT ARE ` +
        `VISIBLE: ${d.effect.visibleButBlockedHosts.join(", ")}` +
        `${d.effect.visibleButBlockedTruncated ? " (+more, sample capped at 8)" : ""} (defect D1)`
    );
  }
  if (d.effect.stampedResult === 0 && d.matcher.entriesEnabled > 0) {
    lines.push(
      "!! block list has enabled domains but 0 results are stamped. Look at " +
        "`rejected` and `discovery` below for which guard ate them."
    );
  }
  if (d.rejected.adapterOfferedNone > 0) {
    lines.push(
      "!! THE ENGINE ADAPTER RETURNED ZERO RESULT NODES on at least one whole-page " +
        "scan. Discovery is broken for this markup — most likely a Google class " +
        "rotation. This is why nothing is being hidden."
    );
  }
  if (d.accounting.unmarkedButBlocked > 0) {
    // Stronger than `visibleButBlocked`: this walks the live DOM, so it holds
    // even when the resolver could not be registered, and it names the guard.
    lines.push(
      `!! ${d.accounting.unmarkedButBlocked} BLOCKED result(s) on the page are neither ` +
        "hidden nor given a block button. See the result-accounting block below for " +
        "the guard responsible (section / aggregate / multiCite / noUrl)."
    );
  }
  if (d.preload.raw.startsWith("(missing")) {
    lines.push("!! PRELOAD DID NOT RUN — the document_start script is not injected.");
  }
  L.push(`url: ${d.url}`);
  L.push(
    `engine: ${d.effect.engineId ?? "(not detected)"}  engineActive: ${d.effect.engineActive}  isSerp: ${d.effect.isSerp}`
  );
  L.push(
    `build: ${d.build.version ?? "?"}  stamp: ${__SHH_BUILD__}  firefox: ${d.build.firefox ?? "?"}  bfcache: ${d.build.bfcacheRestored}`
  );
  L.push(
    `detectorArmed: ${d.effect.detectorArmed}   (if false, every number below about hiding is meaningless)`
  );
  L.push(...(lines.length ? lines : ["verdict: no known failure signature detected."]), "");

  const kv = (o: Record<string, unknown>, indent = "  "): void => {
    for (const [k, v] of Object.entries(o)) {
      L.push(`${indent}${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    }
  };

  /** The content script's own timeOrigin, for the clock check. */
  const timeOriginHere = (): number | null => {
    try {
      return performance.timeOrigin ?? null;
    } catch {
      return null;
    }
  };

  L.push("-- build --");
  kv(d.build as unknown as Record<string, unknown>);
  L.push("", "-- preload (document_start) --");
  kv(d.preload as unknown as Record<string, unknown>);

  L.push("", "-- matcher (the D5 discriminator) --");
  kv(d.matcher as unknown as Record<string, unknown>);

  L.push("", "-- init timeline (ms from content script start) --");
  for (const t of d.timings) L.push(`  +${String(t.deltaMs).padStart(5)}ms  t=${String(t.tMs).padStart(6)}  ${t.label}`);

  L.push("", "-- rejected by guard: LAST BATCH (what happened on the most recent pass) --");
  kv((d.rejectedLastBatch ?? {}) as unknown as Record<string, unknown>);
  L.push("  (cumulative, since page load — inflated by re-scans on SPA pages:)",
    "");
  kv(d.rejected as unknown as Record<string, unknown>);

  L.push("", "-- effect --");
  kv(d.effect as unknown as Record<string, unknown>);

  // â”€â”€ Result accounting â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The gap that made the 2026-09-29 run unreadable: `processed=5` is the
  // adapter's OFFERED count, not the page's result count, and the guards that
  // drop nodes (section / aggregate / multi-cite) increment no `rejected`
  // counter at all. So a blocked result staying visible left no trace.
  const a = d.accounting;
  L.push(
    `  leaves=${a.leaves}  offered=${a.offered}  hidden=${a.hidden}  ` +
      `withButton=${a.withButton}  shownOnce=${a.shownOnce}  unmarked=${a.unmarked}`
  );
  L.push(`  UNMARKED-BUT-BLOCKED: ${a.unmarkedButBlocked}`);
  for (const r of a.detail) {
    L.push(
      `    ${r.why.padEnd(12)} matched=${String(r.matched).padEnd(5)} ` +
        `${(r.url ?? "(no url)").slice(0, 70)}`
    );
  }
  if (a.unmarkedButBlocked > 0) {
    L.push(
      "  !! " + a.unmarkedButBlocked + " result(s) are BLOCKED but neither hidden nor " +
        "given a block button. Each line above names the guard responsible."
    );
  }

  // â”€â”€ Shown-once visibility probe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // A "Show once" click stamps inline `opacity:1 !important` on the node the
  // adapter offered. If the preload had hidden something INSIDE it, that
  // descendant has no inline override of its own and must be exempted from the
  // Google cover some other way. When it is not, the user sees the notice bar
  // and an empty box where the result body should be — a correctly-sized blank
  // area, because opacity:0 preserves layout while display:none would collapse
  // it. Observed in the field on 2026-09-29; `showOnce` now exempts the
  // descendants, and this block proves whether it worked.
  const shownBoxes = Array.from(
    doc.querySelectorAll<Element>(".shh-shown-result")
  );
  L.push("", "-- shown-once visibility probe --");
  if (!shownBoxes.length) L.push("  (no result is currently in shown-once state)");
  let blankDescendants = 0;
  for (const box of shownBoxes) {
    const tag = box.tagName.toLowerCase() + "." +
      String(box.className || "").trim().split(/\s+/).slice(0, 2).join(".");
    const boxCS = getComputedStyle(box);
    L.push(
      `  ${tag}  boxOpacity=${boxCS.opacity}  h=${Math.round(box.getBoundingClientRect().height)}px  ` +
        `inlineOpacity="${(box as HTMLElement).style.opacity}"`
    );
    for (const el of [box as Element, ...Array.from(box.querySelectorAll<Element>("*"))]) {
      const cs = getComputedStyle(el);
      const invisible = cs.opacity === "0" || cs.display === "none" || cs.visibility === "hidden";
      if (!invisible) continue;
      blankDescendants++;
      if (blankDescendants > 12) break;
      L.push(
        `    BLANK ${el.tagName.toLowerCase()}.${String(el.className || "").trim().split(/\s+/)[0]}  ` +
          `opacity=${cs.opacity} display=${cs.display} visibility=${cs.visibility}  ` +
          `ok=${el.hasAttribute("data-shh-ok")} preloaded=${el.hasAttribute("data-shh-preloaded")}  ` +
          `inlineOpacity="${(el as HTMLElement).style.opacity}"  ` +
          `h=${Math.round(el.getBoundingClientRect().height)}px`
      );
    }
  }
  if (blankDescendants) {
    L.push(
      `  !! ${blankDescendants} descendant(s) of a shown-once result are invisible. ` +
        "If `ok=false` and `preloaded=false`, the Google cover is still matching them."
    );
  }

  L.push("", "-- discovery (B1/B2 evidence; needs debug mode) --");
  kv(d.discovery as unknown as Record<string, unknown>);

  L.push("", "-- results --");
  kv(d.results as unknown as Record<string, unknown>);

  L.push("", "-- link encoding --");
  kv(d.linkEncoding as unknown as Record<string, unknown>);

  L.push("", "-- dom counts --");
  kv(d.counts);

  L.push("", "-- preload timeline + cover (document_start) --");
  const pd = (window as Window & { __shhPreloadDiag?: () => Record<string, unknown> })
    .__shhPreloadDiag?.() as
    | {
        marks?: { label: string; t: number }[];
        contentMarks?: { tMs: number; label: string }[];
        hasRulesBuilt?: number;
        coverAttached?: boolean;
        adoptedSheetCount?: number;
        coversAnyNode?: number;
        preloadSkipReason?: string;
        timeOrigin?: number;
        errors?: string[];
      }
    | undefined;
  if (pd?.marks) {
    for (const m of pd.marks) L.push(`  t=${String(m.t).padStart(6)}  ${m.label}`);
  } else {
    L.push("  (preload did not install its diagnostic — did the script run?)");
  }
  // Errors the PRELOAD swallowed into its own record. These are the ones the
  // console could not explain: minified position, no stack, no context. The
  // 2026-09-29 run produced dozens of "H is not a function" lines that way.
  if (pd?.errors?.length) {
    L.push(`  !! ${pd.errors.length} UNCAUGHT ERROR(S) inside the preload:`);
    for (const e of pd.errors) L.push(`     ${e}`);
  }
  if (pd) {
    L.push(
      `  hasRulesBuilt=${pd.hasRulesBuilt}  coverAttached=${pd.coverAttached}  ` +
        `adoptedSheets=${pd.adoptedSheetCount}  coversAnyNode=${pd.coversAnyNode}  ` +
        `skipReason=${pd.preloadSkipReason ?? "(none)"}`
    );
    // The entire preload-vs-content comparison rests on the two scripts sharing
    // one clock. Nothing printed it, so the user could not check the assumption
    // the NOTE below asks them to act on.
    L.push(`  timeOrigin: preload=${pd.timeOrigin ?? "?"}  content=${timeOriginHere()}`);
    L.push(
      `  clock check: ${pd.timeOrigin != null && pd.timeOrigin === timeOriginHere() ? "SAME origin - comparison is valid" : "DIFFERENT origin - the t= values below are NOT comparable"}`
    );
  }
  L.push(
    "  NOTE: compare the preload's 'google-cover-reveal:2s-safety-net' t= against the " +
      "content script's 'first-processResults-done' t= above. If the 2s mark is " +
      "ABSENT, the timer never fired and the ordering question is moot. The other " +
      "reveal:* labels are triggered by the content script itself and are expected " +
      "to be later."
  );

  // ── THE COVER INVARIANT, MEASURED ────────────────────────────────────────
  // The one question nothing else in this report answers: is anything stuck
  // under the anti-flicker cover? `blankGaps > 0` IS the reported symptom
  // ("results are not visible on the screen but there space for that result"),
  // named and counted, with the offending nodes listed.
  L.push("", "-- cover audit: is anything invisible but still occupying space? --");
  L.push(coverAuditText());

  L.push("", "-- lifecycle log --");
  L.push(d.lifecycle.shhDiag);
  L.push("=== END ===");
  return L.join("\n");
};

// Publish to BOTH worlds. The local copy is what the extension's own code and
// a content-script context would use; the bridged copy is a convenience.
(window as Window & { __shhDiagText?: () => string }).__shhDiagText = shhDiagText;
installPageBridge(shhDiagText, "__shhDiagText");
installPageBridge(() => JSON.stringify(collectDiagnostics(), null, 2), "__shhDiag");
// The cover audit needs its own bridge for the same reason __shhDiagText does:/n// the function lives in the isolated world and the console does not.
installPageBridge(coverAuditText, "__shhCoverAuditText");

// ============================================================================
// THE REPORT CACHE — the mechanism that actually works from the page console
// ============================================================================
//
// A second field run returned:
//
//     Uncaught Error: Permission denied to access object
//
// from `copy(__shhDiagText())`. The bridge had installed — the ReferenceError
// was gone — but Firefox refused to CALL a content-script function from the
// page compartment. That needs `cloneInto`/`exportFunction`, and the previous
// test suite modelled the two worlds with a plain property assignment, so it
// could not possibly have caught it: jsdom has no compartments. A test that
// cannot fail on the mechanism it names is worse than no test.
//
// So the primary channel is now one that crosses no boundary at all: a plain
// attribute on <html>. The DOM is shared between the worlds, and
// `document.documentElement.getAttribute(...)` from the page console is an
// ordinary same-realm call that cannot be denied.
//
//   copy(document.documentElement.getAttribute("data-shh-report"))
//
// The report is refreshed on a debounce whenever results are processed, so it
// is current without the user having to trigger anything.
const ATTR_REPORT = "data-shh-report";
const REPORT_MAX = 40000;
let reportTimer: ReturnType<typeof setTimeout> | null = null;

function refreshDiagReport(): void {
  try {
    document.documentElement.setAttribute(ATTR_REPORT, shhDiagText().slice(0, REPORT_MAX));
  } catch {
    /* A diagnostic that throws into the page is worse than a missing one. */
  }
}

// â”€â”€ Stage marker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// A field run returned `null` for the report, which was this instrumentation's
// own blind spot: `refreshDiagReport()` was only called AFTER
// `first-processResults-done`, i.e. only on the success path. A tab that bailed
// early — the exact state being reported as "the extension is not there" —
// published nothing at all, so the one thing we needed to look at was the one
// thing we could not see.
//
// These two attributes answer "did the content script run, and how far did it
// get" with a DOM read, and they are written on EVERY path including the ones
// that return early. `data-shh-stage` is the last stage entered; the first
// stage not reached is the one that failed.
const ATTR_ALIVE = "data-shh-alive";
const ATTR_STAGE = "data-shh-stage";

function markStage(stage: string): void {
  try {
    document.documentElement.setAttribute(ATTR_STAGE, stage);
  } catch { /* detached document — the report is unavailable anyway */ }
}

/** Read an attribute without assuming the document still exists. */
function safeAttr(name: string): string | null {
  try {
    return document.documentElement?.getAttribute(name) ?? null;
  } catch {
    return null;
  }
}

function markAlive(): void {
  try {
    document.documentElement.setAttribute(ATTR_ALIVE, __SHH_BUILD__);
    // Publish an initial report immediately, before any async work, so a
    // script that dies during init still leaves something behind.
    refreshDiagReport();
  } catch { /* ignore */ }
}

/** Debounced so a hydration burst of processResults calls does one pass. */
function scheduleDiagReportRefresh(): void {
  if (!isDebugMode()) return;
  if (reportTimer !== null) clearTimeout(reportTimer);
  reportTimer = setTimeout(() => {
    reportTimer = null;
    refreshDiagReport();
  }, 800);
}

const currentUrl = new URL(location.href);
const engine = detectEngine(currentUrl);

// FIRST THING the content script does, before any async work and before
// anything that can throw. If this attribute is missing, the script did not
// run at all — injection failure, or the module threw at import time. That
// distinction is the whole point, and it was unavailable until this existed.
markStage("module-evaluated");
markAlive();
if (!engine) markStage("no-engine");

// â”€â”€ Message listener â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Registered at MODULE SCOPE, not at the end of init().
//
// init() has three early returns (`:228` no-cache-paused, `:238` no prefs,
// `:245` engine inactive) and the listener used to be the last statement
// before them — so a tab that loaded while paused or with the engine disabled
// had NO listener at all. Unpausing could therefore never reach it, and the
// user had to reload. That is the reported "unpause doesn't work".
//
// A message that lands before init finishes is not dropped: it is recorded and
// drained by finishInit() on every exit path, including the early returns.
//
// TWO independent flags, not one slot. A single `pendingRefresh` looked tidier
// but silently swallowed the second kind: `prefs` overwrote `list`, so a
// PREFS_UPDATED followed by a LIST_UPDATED during init's (seconds-wide) await
// ran only refreshPrefs() — and refreshPrefs never re-reads the list. The newly
// blocked domain then stayed visible.
let initComplete = false;
const refreshQueue = new RefreshQueue();

/** Route a refresh through one place so both call sites get a `.catch`. */
function runRefresh(kind: RefreshKind): void {
  const p = kind === "prefs" ? refreshPrefs() : refreshEntries();
  // `.catch` is not optional: getPrefs()/getList() reject whenever the
  // background is cold, and an unhandled rejection here is noise in the exact
  // console channel (__shhDiag) that field diagnosis relies on.
  void p.catch((err) => shhLog("refresh failed", err));
}

function finishInit(): void {
  initComplete = true;
  // Drain whatever arrived while init() was running — or bailed out early.
  for (const kind of refreshQueue.finish()) runRefresh(kind);
}

if (engine) {
  browser.runtime.onMessage.addListener((msg: unknown) => {
    if (!msg || typeof msg !== "object" || !("type" in msg)) return;
    const m = msg as { type: string };
    if (m.type === "PREFS_UPDATED" || m.type === "LIST_UPDATED") {
      const kind: RefreshKind = m.type === "PREFS_UPDATED" ? "prefs" : "list";
      const now = refreshQueue.offer(kind);
      if (now) runRefresh(now);
    }
  });
}

if (!engine) {
  // Page not recognized — do nothing
} else {
  // `.finally` so the drain survives a throw inside init(). The catch keeps the
  // rejection out of the console: shhLog is the diagnostic channel this whole
  // investigation reads, and noise there costs real debugging time.
  void init()
    .catch((err) => shhLog("init failed", err))
    .finally(finishInit);
}

async function init(): Promise<void> {
  if (!engine) return;
  markStage("init-start");
  diagMark("init-start");

  // â”€â”€ DOM readiness gate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // THE FIX FOR "it does nothing until I open the extension", and the reason the
  // field log reads `t=54242ms init start` on a Google results page.
  //
  // The content script used to be registered at `document_idle`, which Firefox
  // fires after the window `load` event. Google hangs on subresources for tens of
  // seconds, so `load` — and therefore this entire content script — was deferred
  // by the same amount. A field capture measured 54.2 s, and this repo's own plan
  // doc recorded 102.5 s on Startpage. Opening the popup changed nothing: the
  // injection simply landed while the user was busy clicking. Every layer of
  // investigation downstream (state loading, messaging timeouts, the background
  // being "cold") was measuring the consequences of a script that had not run.
  //
  // `document_end` fires at DOMContentLoaded, which does not wait on
  // subresources. The wait below is belt-and-braces: `document.body` must exist
  // for the hover class, `detectPageColors` and the result queries. Bounded,
  // because a DOMContentLoaded that never arrives must not hang the tab in the
  // same way `load` did — past the timeout we proceed anyway, and the observer
  // plus the rescans pick results up whenever they do appear.
  if (!document.body) {
    await Promise.race([
      new Promise<void>((r) =>
        document.addEventListener("DOMContentLoaded", () => r(), { once: true })
      ),
      sleep(2000),
    ]);
    // shhLog, not diagMark: diagMark is gated on `marksEnabled` (debug mode /
    // tests) and would otherwise record nothing on a normal page — and this line
    // is exactly what a field report needs to see, because it is the evidence the
    // 54-second injection delay is gone. `data-shh-diag` is always on.
    shhLog(`dom gate released (${document.body ? "body-ready" : "body-missing-timeout"})`);
  }
  // â”€â”€ Class-based CSS protection (adoptedStyleSheets) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Inject display:none rules for the shh-hidden and shh-pban classes via a
  // Constructable StyleSheet (not a DOM element).  This means even if Google's
  // deferred scripts reset inline `style` attributes on result nodes after
  // processResults() runs, the class + CSS rule still keeps them hidden.
  // Called before earlyHideFromCache() so the protection is in place before
  // any DOM changes are made.
  injectHidingStyles();

  // â”€â”€ Synchronous early hide (before any async round-trip) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The preload (document_start) hides results via localStorage cache + CSS
  // rule.  However, Google's JS framework can replace result DOM nodes between
  // document_start and document_idle — new nodes have no preload marker and are
  // therefore visible.  This function re-reads the same localStorage cache and
  // hides any still-visible blocked results SYNCHRONOUSLY, before the storage
  // await below, closing that timing gap without any async delay.
  earlyHideFromCache();
  shhLog(`init start ${__SHH_BUILD__}`);
  diagMark("earlyHideFromCache-done");

  // â”€â”€ PRIME FROM THE CACHE — protect the page BEFORE the first await â”€â”€â”€â”€â”€â”€â”€â”€
  // The cache already carries a copy of the block list AND the prefs
  // (`buildCache` writes both). Using it here means the matcher, the observer,
  // the placeholders and the block buttons all come up in the same tick, and
  // the authoritative read below only has to REFINE what is already working.
  //
  // Before this, the page sat unprotected for as long as the state load took —
  // up to 2.5 s plus two 400 ms+2500 ms retries, i.e. 5.8 s on a cold event
  // page. During that window results were visible with no placeholder and no
  // Unblock control, which is exactly "the extension is not even there". And
  // opening the extension only appeared to fix it, because the user had spent
  // that long elsewhere by the time init finished. Nothing about opening it
  // changed the page.
  //
  // Only an AUTHORITATIVE cache is trusted. A non-authoritative one means we
  // hold no list merely because the read failed, and priming from it would hide
  // nothing while claiming the page is protected.
  const primed = recoverStateFromCache();
  if (primed?.authoritative && isGoogleOrPrimes(engine)) {
    entries = primed.entries;
    prefs = primed.prefs;
    setDebugMode(prefs.debugMode);
    engineActive = isEngineActive(prefs, engine.id);
    if (engineActive) {
      markStage("priming-from-cache");
      pagePrimed = true;
      protectPage(true);
    }
  }

  // â”€â”€ Tier 1: read storage DIRECTLY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The field symptom this replaces: "the extension is not responsive until I
  // open it once after every page load." That was a cold MV3 event page — the
  // first `sendMessage` has to wake the suspended background, routinely blows
  // the 2500 ms budget, burns the whole retry ladder (up to 5.8 s) and lands in
  // a degraded cache start. Opening the popup reads storage, which wakes the
  // worker, which is why that "fixed" the next load.
  //
  // The content script holds the `storage` permission and reads the same keys
  // the background does, so this needs no background at all.
  //
  // THE TWO READS ARE DELIBERATELY NOT `Promise.all` OVER ONE BUDGET.
  // `loadEntries()` is `storage.local` — purely local, ~1 ms. `loadPrefs()` is
  // `storage.sync`, which in Firefox talks to a REMOTE SERVER when the user is
  // signed in and can hang for seconds on a bad connection. A single combined
  // deadline means one slow sync takes the BLOCK LIST down with it, which drops
  // straight back into the messaging path this tier exists to avoid. The list
  // is the critical data; prefs can arrive a moment later.
  let gotState = false;
  try {
    entries = await withTimeout(getListDirect(), 500);
    gotState = true;
    diagMark("storage-list-ok");
  } catch {
    diagMark("storage-list-failed");
  }
  if (gotState) {
    // Non-fatal, and NOT a reason to skip Tier 2 for the other half. An
    // earlier revision gated the whole message-bus tier on `gotState`, so a
    // slow `storage.sync` meant prefs were never even attempted over messaging
    // — and `prefs` stayed null, which is the "extension does nothing at all"
    // state this whole tier exists to prevent.
    try {
      prefs = await withTimeout(getPrefsDirect(), 2500);
      setDebugMode(prefs.debugMode);
      diagMark("storage-prefs-ok");
    } catch {
      diagMark("storage-prefs-failed");
    }
    setDiagMatcherInfo({ source: "storage" });
    markStage("storage-list-ok");
  }

  // â”€â”€ Tier 2: the message bus, with the original retry ladder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Runs when EITHER half of tier 1 is missing. The `!prefs` half is a
  // correctness improvement, NOT a load-bearing one: mutation H3 shows the
  // healer already covers the gap it closes, because a skipped tier 2 leaves
  // `prefs` null, `recoverStateFromCache` supplies defaults, and the first
  // healer poll then reads the real prefs from storage. It recovers sooner
  // this way; it is not the difference between working and inert.
  if (!gotState || !prefs) {
  try {
    const [e2, p2] = await withTimeout(Promise.all([getList(), getPrefs()]), 2500);
    entries = e2;
    prefs = p2;
    if (prefs) setDebugMode(prefs.debugMode);
    diagMark("messaging-ok");
    setDiagMatcherInfo({ source: "background" });
  } catch {
    // A cold MV3 event page can HANG the first response for seconds (a hang,
    // not a rejection — retries do not help). Race-bounded retries cover fast
    // rejections (listener not ready); if messaging stays slow, continue in
    // degraded mode from the preload cache / defaults and self-heal later.
    let recoveredMsg = false;
    for (let i = 0; i < 2 && !recoveredMsg; i++) {
      await sleep(400);
      try {
        [entries, prefs] = await withTimeout(Promise.all([getList(), getPrefs()]), 2500);
        if (prefs) setDebugMode(prefs.debugMode);
        recoveredMsg = true;
        diagMark("messaging-ok-after-retry");
        setDiagMatcherInfo({ source: "background" });
      } catch { /* keep retrying */ }
    }
    if (!recoveredMsg) {
      // Degraded mode: blocking from the cache (or empty on fresh installs —
      // block buttons still work) until reviveFromBackground() swaps in the
      // real state. A cache that explicitly says paused means do nothing.
      const fromCache = recoverStateFromCache();
      shhLog("messaging timeout — degraded start", fromCache ? "cache/defaults" : "paused, idle");
      if (!fromCache) {
        // Cache says PAUSED for this engine. We hold no list and no prefs, so
        // the state is definitionally non-authoritative — say so BEFORE the
        // return. Leaving `stateAuthoritative` at its `true` default here is
        // what let a later resume publish `{"domains":[],"paused":false}` over
        // a good cache (D5, step 4). This path is newly reachable because
        // SET_PREFS now broadcasts PREFS_UPDATED, so the tab WILL be resumed.
        stateAuthoritative = false;
        // `paused`, NOT `cache`. The old label made the report print
        // "MATCHER EMPTY from the _shh_cache ... (defect D5)" for the single
        // most likely field paste — a page the user had deliberately paused —
        // sending them to hunt a bug that does not exist.
        setDiagMatcherInfo({ source: "paused", degradedStart: false });
        // Still publish: a report that says "detector not armed" is better than
        // one that silently describes a stale matcher.
        markStage("bail-cache-says-paused");
        syncDiag();
        refreshDiagReport();
        diagMark("cache-says-paused-return");
        return;
      }
      entries = fromCache.entries;
      prefs = fromCache.prefs;
      setDebugMode(prefs.debugMode);
      degradedStart = true;
      // D5: only a real cache payload is authoritative. With no cache at all we
      // hold an empty list purely because messaging failed — publishing that
      // would wipe pre-paint hiding for this origin permanently.
      stateAuthoritative = fromCache.authoritative;
      if (!stateAuthoritative) {
        shhLog("degraded start with NO cache — cache writes suppressed until revive");
      }
      setDiagMatcherInfo({
        source: fromCache.authoritative ? "cache" : "defaults",
      });
      diagMark("degraded-start");
    } else {
      shhLog(`state loaded (entries=${entries.length})`);
    }
  }
  } // end Tier 2 (message bus + retry ladder)

  if (!prefs) {
    // Reachable ONLY when `recoverStateFromCache()` returned null, which it
    // does for exactly one reason: the saved cache says the user PAUSED this
    // engine. So this is not an inert-by-accident path — it is the correct
    // "do nothing, the user asked for it" exit.
    //
    // A revive here would be wrong: it would re-read prefs, still see paused,
    // and do nothing, while implying the tab is trying to recover. An earlier
    // revision added one and the mutation suite showed it changed nothing.
    markStage("bail-paused-no-prefs");
    syncDiag();
    refreshDiagReport();
    return;
  }

  // Check if this engine is disabled or extension is paused.  When inactive,
  // do NOT hide anything — there would be no placeholder or Show/Unblock
  // controls (those only come from processResults, which never runs).
  markStage("prefs-loaded");
  engineActive = isEngineActive(prefs, engine.id);
  // Publish BEFORE the `!engineActive` return below. A suspended tab is the
  // case the report most needs to describe correctly, and it never reaches
  // refreshMatcher() — so without this its engineActive would read stale and
  // the verdict would name D5 for a deliberately paused page.
  syncDiag();
  shhLog(`engine=${engine.id} active=${engineActive} pausedGlobally=${prefs.pausedGlobally} toggle=${prefs.engineToggles[engine.id]} hover=${prefs.showOnHover} entries=${entries.length}`);

  // D2 (cache half). This write MUST happen above the inactive return.
  // earlyHideFromCache() and the preload both consult ONLY `_shh_cache`, so a
  // tab that loads while paused and never writes the cache leaves the previous
  // tab's `paused:false` payload in place — and the next load's preload then
  // pre-hides results for a user who has blocking suspended, with no
  // placeholder and no Show control, because processResults never runs on a
  // paused page to place one. buildCache() derives `paused` from prefs itself,
  // so it is safe to call here.
  updateCache();

  if (!engineActive) {
    markStage("bail-engine-inactive");
    refreshDiagReport();
    return;
  }

  // Observer FIRST, and deliberately BEFORE the sleep below: background tabs
  // clamp timers (that 400 ms can take a minute there) and Startpage hydrates
  // when the tab wakes, so the observer has to already be listening. It is also
  // deliberately NOT inside protectPage(): it branches on
  // `prefs.mutationObserver`, and the cache prime's prefs are DEFAULT_PREFS for
  // that key, so priming it would latch the wrong answer for the whole session.
  // Same for infinite scroll, which reads four prefs.
  startResultObserver();
  tryStartInfiniteScroll();

  // Brave Search is a Svelte SPA and Startpage renders results late
  // (POST-based search + React hydration, per the userscript's 300ms delayed
  // init) — both need a beat after document idle before scanning. Google does
  // not, and this delay is exactly what the cache prime must not inherit.
  if (engine.id === "brave" || engine.id === "startpage") {
    await sleep(400);
  }

  protectPage(false);

  // Degraded start (cold background): poll until messaging recovers, then swap in
  // the real list/prefs and re-process the page.
  //
  // HERE, not inside wireTabOnce(). It is an init-path decision gated on
  // `degradedStart`, which is only set at the end of the tier-2 ladder — AFTER
  // the cache prime has already run wireTabOnce() and closed its latch. Latched
  // in there, a primed tab whose authoritative read then failed never started
  // the healer at all. `reviveFromBackground` is the only re-read of the
  // authoritative list, so losing it loses recovery entirely.
  if (degradedStart) void reviveFromBackground();
}

/**
 * Google and friends render results at `document_idle`, so the cache snapshot
 * is immediately usable. Brave and Startpage are client-rendered SPAs whose
 * results do not exist yet — priming them would build a matcher and start an
 * observer against an empty document, which is worse than waiting.
 */
function isGoogleOrPrimes(e: EngineAdapter): boolean {
  return e.id === "google" || e.id === "bing" || e.id === "duckduckgo" || e.id === "yandex";
}

// â”€â”€ protectPage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Everything that makes blocking VISIBLE on the page: matcher, observer,
// placeholders, block buttons, Unblock controls.
//
// EXTRACTED so it can run twice. The field symptom it fixes: "the extension
// has no effect on the page, as if it isn't there" — and the reason was that
// NONE of this ran until the async state load finished. `earlyHideFromCache()`
// set inline `display:none`, but placeholders, buttons and the observer all
// waited behind up to 2.5 s + 2 retries of messaging, i.e. as much as 5.8 s on
// a cold event page. For that whole window the page showed unhidden results
// with no controls — indistinguishable from the extension being absent — and
// "opening the extension" only appeared to fix it because the user had spent
// that long clicking something else by the time init finished.
//
// So the page is protected from the CACHE, synchronously, and the authoritative
// read then refines it. Protection first, correctness immediately after.
//
// THE TWO HALVES MATTER. `pageWired` guards the ONE-TIME wiring (styles, engine
// init, observer, infinite scroll) and is genuinely a latch — running them twice
// would double-register listeners. `applyStateToPage` is the REPEATABLE half and
// deliberately is not latched: after a cache prime the authoritative read lands
// with a different list, and if that half were skipped the live matcher would
// keep the cache's entries forever. A result the stale matcher hid would stay
// hidden with no Unblock control — the 2026-08-30 "it removed other search
// results" regression, reintroduced through the back door by the prime itself.
// THE LATCH IS DELIBERATELY NARROW. Only two things are one-time: injecting the
// stylesheet and initialising the engine adapter. Everything else runs on EVERY
// call, because almost all of it is a function of `prefs` or `entries`, and the
// cache prime's prefs are DEFAULT_PREFS for every key except `subdomainWildcard`
// and `debugMode`. Latching any of it would freeze a guess for the whole page
// session. Three bugs came out of the wider latch this replaced, all found by
// review rather than by a failing test:
//
//   * the authoritative path stopped doing a FULL SCAN and reconciled only, so
//     unblocked results never got a block button and preload-hidden results were
//     never revealed. On Baidu — which the prime skips — no result on the page
//     got a button at all.
//   * `reviveFromBackground` sat behind wireTabOnce()'s latch, so a primed tab
//     whose authoritative read then failed never started the healer.
//   * the hover class was applied once from the prime's default `false`.
//
// (`pageWired`, `pagePrimed` and `tabWired` are declared near the top of this
// module — see the note there about init()'s synchronous prefix running before
// later initialisers.)
function protectPage(fromCache: boolean): void {
  if (!prefs || !engine) return;

  if (!pageWired) {
    // Inject styles
    injectBaseStyles();

    // Initialize engine adapter
    engine.onInit?.(document);

    pageWired = true;
  }

  // Hover-mode class. NOT latched and NOT a one-shot `if (prefs.showOnHover)
  // add()`: the prime's prefs default this to false, so a one-shot would drop the
  // class for the whole session. toggle() is idempotent and self-correcting.
  document.documentElement.classList.toggle("shh-hover-mode", !!prefs.showOnHover);

  // Build matcher. refreshMatcher() (not a direct construction) so the
  // diagnostics can never drift from the live matcher again.  Runs EVERY time,
  // including after a cache prime, so the authoritative list always wins.
  refreshMatcher();

  // Sync :has() rules with the confirmed list (removes any stale preload rules
  // for domains that have since been unblocked, adds any new ones).
  updateHasRules();

  // FULL SCAN, every time. Not redundant with the reconcile below, and not
  // replaceable by it: processResults is the only place an UNBLOCKED result gets
  // its block button, and the only place preload hiding is lifted for a result
  // that is not blocked. reconcileAgainstBlockList only forwards nodes that ARE
  // blocked, so it structurally cannot do either.
  processResults(getCachedResultNodes());
  diagMark(fromCache ? "cache-processResults-done" : "first-processResults-done");

  // Only needed to UNDO a prime. The full scan above cannot do it: the nodes the
  // stale cache matcher hid are already stamped, and processResults skips
  // stamped nodes. So a domain the user unblocked in another tab stays hidden
  // with no Unblock — the 2026-08-30 regression, which is why the prime needs
  // this and why it must not be latched.
  if (pagePrimed && !fromCache) {
    // `.catch` is not optional: same rule as the sibling messaging calls. An
    // unhandled rejection is noise in the exact console channel (__shhDiag) that
    // field diagnosis depends on, and it would leave the page half-reconciled.
    void reconcilePageInPlace().catch((err) => shhLog("reconcile failed", err));
  }

  markStage(fromCache ? "protected-from-cache" : "init-complete");
  // Publish the report immediately, not after the 800ms debounce: if the user
  // reproduces and pastes straight away, the attribute must already be there.
  refreshDiagReport();

  wireTabOnce();
}

/**
 * Bring the CURRENTLY VISIBLE dom in line with the CURRENT list, without a full
 * re-scan. Extracted from refreshEntries() so the post-prime path can reuse it.
 *
 * Both node sets matter. The stamped set is the one the old code walked, and on
 * its own it is not enough: a result that is currently VISIBLE carries no
 * data-shh-result, so a domain blocked while this tab was open never reached it
 * and kept showing until a reload.
 */
async function reconcilePageInPlace(): Promise<void> {
  if (!matcher || !engine) return;

  // Import once before any DOM changes to avoid yield points mid-loop.
  const { restoreResult } = await import("./blocking/hider");

  const { toRestore, toRestamp } = reconcileAgainstBlockList(
    getHiddenNodes(),
    getCachedResultNodes(),
    (url) => matcher!.match(url).matched,
    (node) => engine!.getResultUrl(node)
  );
  shhLog(
    `reconciled: restamp=${toRestamp.length} restore=${toRestore.length} ` +
      `entries=${entries.length}`
  );
  diagMark("reconciled");

  // Domains that were removed from the list: restore immediate (show them).
  for (const node of toRestore) {
    restoreResult(node);
  }

  // Domains still blocked — or newly blocked and still on screen: clear the
  // processed stamp and remove the old placeholder so processResults() can
  // re-stamp and rebuild the placeholder (handles mode changes: block â†’ pban
  // etc.) WITHOUT ever removing the display:none — no visible flash at any
  // point.
  const clearedNodes: Element[] = [];
  for (const node of toRestamp) {
    const prev = node.previousElementSibling;
    if (prev?.getAttribute("data-shh-placeholder")) prev.remove();
    node.removeAttribute("data-shh-result");
    node.removeAttribute("data-shh-mode");
    clearedNodes.push(node);
  }

  processResults(clearedNodes);
}

/**
 * One-time per-tab wiring: the reveal, the visibility/rescan hooks, the healer
 * and the Startpage insurance timers. Extracted from the old inline block in
 * init() so that `protectPage` can be called a second time after a cache prime
 * without re-registering any of it.
 */

function wireTabOnce(): void {
  if (tabWired) return;
  tabWired = true;

  // Google-specific: the preload keeps ALL div.g containers visibility:hidden
  // until they are confirmed safe (data-shh-ok) or blocked (data-shh-preloaded).
  // Now that processResults() has stamped every blocked result, any remaining
  // uncovered container is safe — reveal them all.
  (window as Window & { __shhRevealGoogle?: () => void }).__shhRevealGoogle?.();
  diagMark("google-reveal-done");

  shhLog(`init done: processed=${getCachedResultNodes().length} observer=${!!observer} infScroll=${!!infiniteScrollManager}`);

  // Background tabs freeze/thaw — Startpage hydrates when the tab becomes
  // visible, so re-process on every visibility change (idempotent: stamped
  // nodes are skipped, the observer no-ops if already running).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!shouldReScan({
      engineActive,
      matcherReady: !!matcher,
      prefsReady: !!prefs,
      engineKnown: !!engine,
    })) return;
    invalidateNodeCache();
    processResults(getCachedResultNodes());
    if (!observer) startResultObserver();
    tryStartInfiniteScroll();
  });

  // Degraded start is handled in init(), NOT here: `degradedStart` is only set at
  // the end of the tier-2 ladder, which is AFTER the cache prime has already run
  // this function and closed the latch. Starting the healer from in here meant a
  // primed tab whose authoritative read then failed never healed at all — it
  // stayed frozen on the cache snapshot until reload.

  // Startpage insurance: results hydrate client-side on a page whose events
  // (load, sometimes DOMContentLoaded) stall behind hanging resources — if
  // the MutationObserver ever misses the hydration window, these rescans
  // and the URL watcher below still pick the results up.
  // `engine?.id`, not `engine.id`: the narrowing from protectPage()'s guard does
  // not carry into this function, and the check is equivalent — wireTabOnce() is
  // only ever called after that guard has established a non-null engine.
  if (engine?.id === "startpage") {
    for (const delay of [1000, 2000, 4000, 8000]) {
      setTimeout(() => {
        if (matcher && prefs) {
          invalidateNodeCache();
          processResults(getCachedResultNodes());
        }
      }, delay);
    }
  }
}

// Last-search URL — used by the SPA-navigation watcher to detect soft
// navigations (no page load â†’ no fresh injection; the resident script must
// re-process results itself).
let lastSeenUrl = location.href;
setInterval(() => {
  if (location.href === lastSeenUrl) return;
  lastSeenUrl = location.href;
  if (shouldReScan({
    engineActive,
    matcherReady: !!matcher,
    prefsReady: !!prefs,
    engineKnown: !!engine,
  })) {
    invalidateNodeCache();
    processResults(getCachedResultNodes());
  }
}, 1500);

// â”€â”€ withTimeout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Rejects after `ms` — used to bound first-load messaging because a cold
// event page HANGS rather than rejects, which would stall init indefinitely.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("shh-messaging-timeout")), ms)
  );
  // the losing promise rejects later — swallow it to avoid unhandled-rejection noise
  timer.catch(() => {});
  return Promise.race([p, timer]);
}

// â”€â”€ reviveFromBackground â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Healer for a tab that could not get its state on the first pass. Polls, then
// replaces whatever it has with the real list/prefs and re-processes results.
//
// IT TRIES DIRECT STORAGE BEFORE MESSAGING, and that ordering is the whole
// point. The original version polled only `sendMessage`, so when the tab was
// inert *because* the event page was cold, the healer kept asking the one
// component that was unable to answer — for sixty seconds. It is now a healer
// in the case that actually occurs: storage answers in ~1 ms regardless of
// whether the background is awake, and messaging remains the fallback for
// environments where storage is unavailable.
async function reviveFromBackground(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(attempt === 0 ? 300 : 1500);
    let got = false;
    try {
      entries = await withTimeout(getListDirect(), 800);
      got = true;
    } catch { /* storage.local unavailable — fall through to messaging */ }
    if (got) {
      try {
        prefs = await withTimeout(getPrefsDirect(), 2500);
      } catch { /* keep the existing prefs; the list is the critical half */ }
    }
    if (!got || !prefs) {
      try {
        const [e2, p2] = await withTimeout(Promise.all([getList(), getPrefs()]), 3000);
        entries = e2;
        prefs = p2;
        got = true;
      } catch { /* background still cold — keep polling */ }
    }
    if (!got || !prefs) continue;

    setDebugMode(prefs.debugMode);
    refreshMatcher();
    // Flip provenance BEFORE the cache write, not after. The order matters:
    // `updateCache` consults `stateAuthoritative`, so writing while it is
    // still false means the D5 guard refuses the very payload this function
    // exists to publish, and a now-authoritative empty list is then never
    // recorded for the rest of the session.
    degradedStart = false;
    stateAuthoritative = true;
    invalidateNodeCache();
    updateCache();
    updateHasRules();
    // Publish the flipped provenance. `degradedStart`/`stateAuthoritative` reach
    // the report only via syncDiag(), so without this the report keeps describing
    // a degraded tab forever — a stale diagnostic that points the reader at a
    // defect that is already fixed, the same class as the dead D1 detector.
    syncDiag();
    if (prefs && engine) {
      markStage("prefs-loaded");
      engineActive = isEngineActive(prefs, engine.id);
      if (engineActive) {
        processResults(getCachedResultNodes());
        // AND reconcile. The full scan above cannot undo a stale hide: the nodes
        // the cache prime hid are already stamped, and processResults skips
        // stamped nodes. Without this, a primed tab that healed kept the cache's
        // verdict forever — a domain the user had since unblocked stayed hidden
        // with no Unblock control. Same reason the post-prime path reconciles.
        await reconcilePageInPlace();
        (window as Window & { __shhRevealGoogle?: () => void }).__shhRevealGoogle?.();
      }
    }
    shhLog(`revived (entries=${entries.length}, attempt=${attempt + 1})`);
    // Republish. Without this the report still says `degradedStart: true` after a
    // successful heal, sending the reader hunting a bug that is already fixed.
    refreshDiagReport();
    return;
  }
  shhLog("revive gave up after 60 attempts — tab stays inert");
}

function getCachedResultNodes(): Element[] {
  if (!cachedResultNodes) {
    const nodes = engine!.getResultNodes(document);
    // Never cache an empty snapshot: on late-hydrating engines (Startpage
    // renders results client-side) an empty list would stick forever and
    // starve every later re-processing pass.
    if (nodes.length > 0) cachedResultNodes = nodes;
    return nodes;
  }
  return cachedResultNodes;
}

// â”€â”€ tryStartInfiniteScroll â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Creates the manager when a results container exists; retries briefly when
// the container hasn't been built yet (client-rendered engines at
// document_start). Idempotent — safe against double invocation.
function tryStartInfiniteScroll(retriesLeft = 25): void {
  if (!prefs || !engine || infiniteScrollManager) return;
  if (!prefs.infiniteScroll) return;
  if (!(engine.getNextPageUrl || engine.triggerNextPage || engine.getNextPageRequest)) return;
  const container = findInfiniteScrollContainer();
  if (container) {
    infiniteScrollManager = new InfiniteScrollManager(
      engine,
      container,
      (nodes) => processResults(nodes),
      {
        threshold: prefs.infiniteScrollThreshold,
        maxPages: prefs.infiniteScrollMaxPages,
        persist: prefs.infiniteScrollPersist,
        freshnessMinutes: 30,
        // Anti-bot sleep before each fetch, per engine (Â±50% jitter on top):
        // Startpage is captcha-prone and keeps the cautious 1500ms; the
        // other engines tolerate ~600ms without tripping detection.
        fetchDelay: engine.id === "startpage" ? 1500 : 600,
        debugMode: prefs.debugMode,
        // Startpage's fetched SSR markup uses class names the live
        // client-rendered stylesheet never defines.
        portFetchedStyles: engine.id === "startpage",
        // Third-party icon service OFF: it would disclose every auto-loaded
        // destination to icons.duckduckgo.com via the URL path, violating
        // README "zero external network requests", privacy-policy.md, and
        // the AMO data_collection:none declaration. Startpage — the engine
        // that needs favicons most — is force-off regardless (its CSP
        // blocks the request); other engines fall back to monograms, which
        // 1.6.2 shipped happily. Revisit only with a user-facing toggle.
        allowThirdPartyIcons: false,
      }
    );
    infiniteScrollManager.init();
    return;
  }
  if (retriesLeft > 0) {
    setTimeout(() => tryStartInfiniteScroll(retriesLeft - 1), 600);
  }
}

// â”€â”€ recoverStateFromCache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Rebuilds entries + prefs from the preload's localStorage cache when the
// background is unreachable (cold event page). Degraded mode: blocking and
// placeholders work; actions needing messaging may fail until the reviver
// swaps in real state. Returns null ONLY when the cache explicitly says
// this engine is paused — otherwise always proceeds (fresh installs get
// empty entries + defaults, so block buttons work on the very first load).
function recoverStateFromCache(): { entries: BlockEntry[]; prefs: Prefs; authoritative: boolean } | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(CACHE_KEY);
  } catch { /* localStorage unavailable — fall through to defaults */ }

  const cache = parseCache(raw);
  if (!cache) {
    // No cache, or unparseable. This is "we have no idea", which is NOT the
    // same as "the user has no blocks" — the distinction is what D5 turns on.
    return { entries: [], prefs: { ...DEFAULT_PREFS }, authoritative: false };
  }
  if (cache.paused) return null; // explicitly paused for this engine
  // A real payload is authoritative: an empty `domains` here genuinely means
  // the user has nothing blocked.
  return {
    entries: entriesFromCache(cache),
    prefs: prefsFromCache(cache),
    authoritative: true,
  };
}

// â”€â”€ startResultObserver â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Watches for dynamically added results. Extracted from init() so that
// refreshPrefs() can start it when blocking is resumed mid-session.
function startResultObserver(): void {
  if (observer || !prefs?.mutationObserver || !engine) return;
  const IGNORE = [".shh-placeholder", ".shh-dialog", ".shh-toast", "[data-shh-btn]"];
  // Batch mutations via queueMicrotask to avoid redundant processResults calls
  let pendingNodes: Element[] = [];
  let microtaskScheduled = false;

  observer = new ResultObserver((newNodes) => {
    pendingNodes.push(...newNodes);
    if (!microtaskScheduled) {
      microtaskScheduled = true;
      queueMicrotask(() => {
        const batch = pendingNodes.splice(0);
        microtaskScheduled = false;
        if (batch.length === 0) return;
        // Deduplicate by reference
        const seen = new Set<Element>();
        const unique: Element[] = [];
        for (const n of batch) {
          if (!seen.has(n)) {
            seen.add(n);
            unique.push(n);
          }
        }
        processResultNodes(unique);
      });
    }
  }, IGNORE);

  // document_start safety: <body> may not exist yet — observe from the root.
  observer.start(document.body ?? document.documentElement, engine.observerOptions?.());
}

function invalidateNodeCache(): void {
  cachedResultNodes = null;
}

function processResultNodes(nodes: Element[]): void {
  const resultNodes: Element[] = [];
  let skippedContainers = 0;
  for (const node of nodes) {
    const engineNodes = engine!.getResultNodes(node);
    if (engineNodes.length > 0) {
      resultNodes.push(...engineNodes);
      continue;
    }

    // â”€â”€ Fallback: the added node is itself one result â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Reached when the adapter found no results INSIDE the node. On Google
    // that is the normal case for any container the page adds, because the
    // stream is resolved by ID and an ID can never be matched from inside a
    // subtree — including the `<div data-inf-page="N">` wrapper infinite
    // scroll appends as a single operation.
    //
    // Unguarded, that wrapper was pushed in as a second result: it resolves to
    // the same <h3> as the first real result inside it, so the heading got two
    // block buttons, and hideResult() on it added a second placeholder box.
    // Both symptoms were reported 2026-08-30, Google only.
    if (overlapsProcessed(node) || looksLikeResultList(node)) {
      skippedContainers++;
      // Counted: this guard EATS results without stamping them, so it is a
      // direct producer of "blocked result stayed visible". Leaving it
      // uncounted meant the report's own instruction — "check `rejected` for
      // which guard ate them" — pointed at a table guaranteed to be 0.
      bumpRejection("skippedContainer");
      continue;
    }

    const url = engine!.getResultUrl(node);
    if (url) resultNodes.push(node);
  }
  // Field-verifiable: confirms the guard is doing the work. Run
  // copy(__shhDiag()) and check effect.buttons / effect.headingsWithTwoButtons.
  if (skippedContainers > 0 && isDebugMode()) {
    // eslint-disable-next-line no-console
    console.log(
      `[SHH] duplicate-UI guard: skipped ${skippedContainers} container node(s) ` +
        `from ${nodes.length} added node(s)`
    );
  }
  if (resultNodes.length > 0) {
    processResults(resultNodes);
  }
}

function processResults(nodes: Element[]): void {
  if (!matcher || !prefs || !engine) {
    // A silent full-skip. Every result on the page stays visible, yet the
    // report showed a clean `rejected` table and the verdict told the user to
    // go read it. Counted so the "which guard ate them" instruction is followable.
    bumpRejection("noMatcher", nodes.length);
    return;
  }
  // Start the per-batch delta. See `beginRejectionBatch` for why the
  // cumulative table alone misleads across SPA navigations.
  beginRejectionBatch();
  // Keep the page-readable report current. Debounced, so a hydration burst
  // costs one collection rather than one per batch.
  scheduleDiagReportRefresh();

  for (const node of nodes) {
    // Per-node isolation (A1 finding 8, 2026-09-06 review): one throwing
    // node (adapter bug, hostile markup edge) must not abandon the rest of
    // the batch — the observer hands nodes in microtask batches, and
    // without this a throw surfaced as an unhandled rejection while
    // nodes N+1..end silently lost their buttons until the next mutation.
    // Mirrors the preload observer's per-node try/catch.
    try {
    // Skip nodes we have already stamped
    if (node.getAttribute("data-shh-result")) { bumpRejection("alreadyStamped"); continue; }

    // *** CONTAINER GUARD ***
    // A node that WRAPS results we have already handled is a container, not a
    // result. Processing it stacks a second block button on the first result
    // inside it and a second placeholder box beside the ones already there.
    // Checked on every path into processResults(), not just the observer's, so
    // a container can never reach hideResult() however it got here.
    if (containsProcessed(node)) { bumpRejection("containsProcessed"); continue; }

    // *** ANCESTOR GUARD (2026-09-06 "click Show twice" field bug) ***
    // The mirror image of the container guard: a node that sits INSIDE an
    // already-stamped result must not be stamped again. Google makes this
    // reachable: the append path extracts whole-document results at MjjYud
    // level, while the observer's subtree pass (which cannot resolve the
    // stream by ID) falls back to legacy selectors and offers the inner
    // tF2Cxc section of the SAME result. Self and descendant checks both
    // pass — only the ancestor walk was missing. Result: the inner node got
    // its own placeholder box INSIDE the hidden outer one, so revealing the
    // outer box exposed a second "hidden" box on the same result (the
    // double-collapse report). Hidden since it only surfaces once pages
    // are VISIBLE (the opacity-cover bug masked it until 1.8.8).
    // Live in dedupe.ts as isInsideProcessedTerritory so tests bind to the
    // SHIPPED guard, not a mirror (A5 R1: the mirror-only test survived a
    // full revert of this guard with 514/514 green).
    if (isInsideProcessedTerritory(node)) { bumpRejection("insideProcessed"); continue; }

    const url = engine.getResultUrl(node);

    // Skip nodes where no external URL can be found — the button would
    // do nothing when clicked, so injecting it would confuse the user.
    if (!url) { bumpRejection("noUrl"); continue; }

    // Mark cache as stale since we're processing new nodes
    invalidateNodeCache();

    const matchResult = matcher.match(url);

    if (matchResult.matched) {
      const actions = new ResultActions(node, matchResult.domain, url, matchResult, prefs, engine, refreshMatcher);
      hideResult(node, matchResult, url, prefs.showNotices, actions.doShowOnce, actions.doUnblock, actions.doPermaban);
    } else {
      // The preload may have hidden this result based on a stale cache (the
      // domain has since been unblocked), so clear the hiding layers before
      // injecting the button — otherwise the button lands inside a hidden
      // subtree and the result looks blank with no control (audit D3).
      //
      // revealPreloadHiding re-tests every DESCENDANT against the matcher. That
      // guard is not optional: an unmatched wrapper can still contain a
      // genuinely blocked result, because the preload and the adapters resolve
      // a destination with different selectors and different fallback scopes,
      // and `data-shh-preloaded` is deliberately absent from
      // SELECTOR_PROCESSED. Clearing blindly would trade "blocked result hidden
      // with a trapped button" for "blocked result VISIBLE".
      if (hasPreloadHiding(node)) {
        revealPreloadHiding(node, (el) => {
          const u = engine.getResultUrl(el);
          return !!u && matcher!.match(u).matched;
        });
      }
      injectButtonForResult(node, url);
    }
    } catch (err) {
      // One bad node must not stop the rest of the batch — that was the intent,
      // and it is correct. But silence meant a node that was neither stamped
      // nor counted: invisible diagnostic data loss in the one place a field
      // report depends on. Count it, and log the reason once.
      bumpRejection("nodeThrew");
      if (isDebugMode()) shhLog("processResults: node threw", err);
    }
  }
}

function injectButtonForResult(node: Element, url: string): void {
  if (!prefs || !engine) return;

  let target = engine.getButtonTarget(node);
  if (!target) return;

  // Brave: a.l1 is a full-width flex row. Appending the button inside it
  // causes the flex layout to push the button to the far right. Instead,
  // wrap the anchor in a tight flex row and prepend the button to the wrapper
  // (before the anchor) so it sits to the left of the favicon.
  let insertPosition: "after" | "before" = "after";
  if (engine.id === "brave" && target.tagName.toLowerCase() === "a") {
    const wrapper = document.createElement("span");
    wrapper.style.cssText =
      "display:inline-flex;align-items:center;gap:6px;width:fit-content;max-width:100%;";
    target.replaceWith(wrapper);
    wrapper.appendChild(target);
    target = wrapper;
    insertPosition = "before";
  }

  // Append inside headings (h2/h3/h4) rather than inserting after cite.
  // The cite row on Google is a flex container that also holds the three-dot
  // feedback button — adding our button there as a flex item makes it overlap.
  // Appending inside the heading keeps it in the title area and outside the
  // cite-row flex flow entirely. This mirrors the Jefferson Scher userscript
  // behaviour (lines 1480-1487).
  const tagName = target.tagName.toLowerCase();
  const useAppend = tagName === "h3" || tagName === "h2" || tagName === "h4";

  if (useAppend && engine.id !== "brave") {
    // Let the button overflow the heading without clipping
    (target as HTMLElement).style.overflow = "visible";
  }

  const btn = injectBlockButton(
    node,
    target,
    useAppend ? "append" : insertPosition,
    prefs.buttonStyle,
    (e) => {
      const clickedBtn = e.currentTarget as HTMLElement;
      if (prefs!.oneClick) {
        void handleBlock(url, prefs!.oneClickTarget, node);
      } else {
        showBlockDialog(
          url,
          clickedBtn,
          (domain, mode) => { void handleBlock(url, mode, node, domain); },
          prefs!.domainChoiceMode
        );
      }
    }
  );

  // Mirror the userscript v2.3.4 flex-layout fix (March 2025):
  // Pull the button out of the normal flow so it doesn't crowd or overlap
  // other page elements. We set position:relative on the parent and
  // position:absolute on the button, then offset it to the right.
  //
  // Google: button is appended inside the h3; its parent (h3's container div)
  //   is a flex row. top:4.25em clears the title + source rows and lands in
  //   the cite/feedback row area — matching the userscript reference.
  //
  // Brave: no special positioning — let the button flow naturally after
  //   the title anchor (a.l1). Brave's result-content is a flex column,
  //   so the button appears on its own line below the title.
  if (btn?.parentElement) {
    if (engine.id === "google") {
      const pStyle = window.getComputedStyle(btn.parentElement);
      if (pStyle.display === "flex" || pStyle.display === "inline-flex") {
        (btn.parentElement as HTMLElement).style.position = "relative";
        btn.style.cssText =
          btn.style.cssText + ";position:absolute;right:0;top:4.25em;margin:0;";
      }
    }
  }
}

async function handleBlock(
  url: string,
  mode: import("../shared/types").BlockMode,
  node: Element,
  explicitDomain?: string
): Promise<void> {
  if (!prefs || !matcher) return;

  let domain = explicitDomain;
  if (!domain) {
    try {
      domain = new URL(url).hostname;
    } catch {
      return;
    }
  }

  const result = await addEntry(domain, mode);
  if (result.duplicate) {
    showToast(`${domain} already blocked`, () => {}, "", 2500);
    return;
  }

  if (result.entry) {
    entries = [...entries, result.entry];
    refreshMatcher();
    updateCache();
    // Add the :has() rule for the newly blocked domain so future node
    // replacements by Google's JS are hidden without any JS marking step.
    updateHasRules();
    // Re-process page to catch any other results from the same domain
    processResults(getCachedResultNodes());
    showToast(
      `${mode === "pban" ? "Perma-banned" : "Blocked"}: ${domain}`,
      async () => {
        const restored = await undoLast();
        if (restored) {
          await removeEntry(domain!);
          entries = entries.filter((e) => e.domain !== domain);
          refreshMatcher();
          restoreByDomain(domain!);
          // Remove the :has() rule so the just-unblocked results become visible.
          updateHasRules();
        }
      }
    );
  }
}

async function refreshPrefs(): Promise<void> {
  const prevInfiniteScroll = prefs?.infiniteScroll ?? true;
  const wasActive = engineActive;
  prefs = await getPrefs();
  if (!prefs || !engine) return;
  // Debug mode may have been toggled while this page was open.
  setDebugMode(prefs.debugMode);

  if (prefs.showOnHover) {
    document.documentElement.classList.add("shh-hover-mode");
  } else {
    document.documentElement.classList.remove("shh-hover-mode");
  }

  // â”€â”€ Live pause / engine-toggle transitions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  markStage("prefs-loaded");
  engineActive = isEngineActive(prefs, engine.id);
  const transition = classifyPrefsTransition(wasActive, engineActive);

  if (transition === "suspend") {
    // Suspended mid-session. `runSuspendTeardown` owns the ORDER and the
    // COMPLETENESS of the list; this block only supplies the real side effects.
    // An earlier revision inlined the eight steps and separately exported a
    // `SUSPEND_HANDLERS` map of empty arrows that nothing imported — so
    // deleting any step, or the whole block, left the suite green.
    const { ran, failed } = runSuspendTeardown({
      // revealHiddenNodes — every hidden result becomes visible again.
      revealHiddenNodes: () => {
        for (const node of document.querySelectorAll(
          "[data-shh-result], [data-shh-preloaded], .shh-hidden, .shh-pban"
        )) {
          restoreResult(node);
        }
      },
      // clearHasRules — requires preload.ts to honour an empty list (C3). The
      // updater also re-binds the preload's own `lc`/`wildcard` closure vars, so
      // the CSS layer AND the preload's JS `tryHide` layer stand down together.
      // Updating only the sheet would leave them disagreeing, and a paused page
      // whose observer is stopped would pre-hide new nodes with no Show control.
      clearHasRules: () => {
        (window as Window & { __shhUpdateHas?: (d: string[], w: boolean) => void })
          .__shhUpdateHas?.([], prefs!.subdomainWildcard);
      },
      // revealGoogleCover — without this, anything the preload cover left at
      // opacity:0 stays invisible AND unclickable (pointer-events:none) for a
      // user who has just paused. The resume branch already had this call; the
      // suspend branch did not.
      revealGoogleCover: () => {
        (window as Window & { __shhRevealGoogle?: () => void }).__shhRevealGoogle?.();
      },
      // disarmStaticCover — two layers, and only the preload can do one of them.
      // `data-shh-active` gates the static preload.css rule; the PRIMARY Google
      // cover is an adopted stylesheet whose handle lives in the preload closure,
      // so it must be detached via the hook the preload exposes. Removing the
      // attribute alone left results rendered after a pause invisible AND
      // unclickable (opacity:0 + pointer-events:none) with the observer stopped.
      disarmStaticCover: () => {
        (window as Window & { __shhDisarmCover?: () => void }).__shhDisarmCover?.();
        document.documentElement.removeAttribute("data-shh-active");
      },
      // stopObserver — necessary but NOT sufficient. The two real re-entry
      // points are the visibilitychange handler and the 1.5s SPA URL watcher,
      // neither of which is the ResultObserver; both are gated on `engineActive`
      // via shouldReScan. Stopping the observer here is still correct — it stops
      // NEW nodes from being hidden.
      stopObserver: () => {
        observer?.stop();
        observer = null;
      },
      // destroyScrollManager — appended pages would keep arriving and be
      // re-hidden by the manager's own onNewNodes â†’ processResults path. The
      // resume branch rebuilds it, so a pause cycle is symmetric.
      destroyScrollManager: () => {
        infiniteScrollManager?.destroy();
        infiniteScrollManager = null;
      },
      // writeCache — publish the paused payload so the next load's preload
      // stands down instead of pre-hiding for a suspended user.
      writeCache: () => { updateCache(); },
    });
    diagMark("suspend-teardown");
    shhLog(`suspend teardown: ran=${ran.length} failed=${failed.join(",") || "none"}`);
    if (failed.length) shhLog("suspend teardown failures", failed);
  } else if (transition === "resume") {
    // A tab that started degraded — or started while PAUSED, so it never
    // reached the background at all — holds an empty `entries` because we never
    // got the real list, NOT because the user has nothing blocked. Re-read it
    // before building a matcher from it. This closes two holes at once:
    //   D5: without the re-read, updateCache() below would publish
    //       `{"domains":[],"paused":false}` over a good cache.
    //   correctness: without it the resume builds a matcher from [] and hides
    //       nothing, so unpausing appears to do nothing at all.
    // The background is reachable here by definition — the user just changed a
    // pref, which is what delivered this message.
    if (!stateAuthoritative) {
      entries = await getList();
      stateAuthoritative = true;
      shhLog(`resume re-read list (entries=${entries.length})`);
    }
    // Resumed mid-session: run the page processing init() skipped.  This also
    // lifts any preload hiding from before the resume.
    matcher = new DomainMatcher(entries, prefs.subdomainWildcard);
    injectBaseStyles();
    // Re-arm the preload layers suspend tore down. Skipping this left infinite
    // scroll dead for the whole page session (suspend destroys the manager, and
    // the pref-diff below only rebuilds it when `infiniteScroll` itself
    // changed — a pause/unpause cycle does not), and left the engine un-
    // initialised: GoogleAdapter.onInit derives isImages/isNews from the URL, so
    // a tab that loaded paused on tbm=isch would resume down the web path and
    // find nothing.
    (window as Window & { __shhRearmCover?: () => void }).__shhRearmCover?.();
    engine.onInit?.(document);
    invalidateNodeCache();
    updateCache();
    updateHasRules();
    processResults(getCachedResultNodes());
    startResultObserver();
    tryStartInfiniteScroll();
    (window as Window & { __shhRevealGoogle?: () => void }).__shhRevealGoogle?.();
  } else {
    // No active/inactive transition — a pref change that does not cross the
    // active boundary (button style, one-click, notices, theme, wildcard…).
    //
    // `subdomainWildcard` is NOT cosmetic: it is an argument to the
    // DomainMatcher constructor and to the preload's `:has()` sheet. Toggling it
    // in the popup emits PREFS_UPDATED, `classifyPrefsTransition` says "none"
    // (it only reads the pause/toggle fields), and this branch used to do nothing
    // but refresh the cache — so the LIVE matcher and the LIVE `:has()` sheet kept
    // the old value for the life of the page. Turning it OFF left subdomains
    // hidden with no placeholder and no Unblock; turning it ON left them visible.
    // Either way the user had to reload to see their own change.
    //
    // refreshMatcher() rather than a direct construction, so the diagnostics
    // cannot drift from the live matcher again; updateHasRules() for the sheet.
    refreshMatcher();
    updateHasRules();
    // AND reconcile the DOM. Rebuilding the matcher alone is not enough: a result
    // the OLD matcher hid is already stamped, and processResults skips stamped
    // nodes, so nothing would ever release it. reconcileAgainstBlockList puts a
    // stamped-but-no-longer-blocked node in toRestore, and restamps the ones
    // still blocked — which is also what makes turning the setting ON hide the
    // subdomains that were previously let through.
    if (engineActive) void reconcilePageInPlace().catch((err) => shhLog("prefs reconcile failed", err));
    // Skipped while degraded: a non-authoritative tab must not republish its
    // empty list over a good cache on every pref keystroke (D5).
    if (!degradedStart) updateCache();
  }

  // Toggle infinite scroll without requiring page reload
  if (prevInfiniteScroll !== prefs.infiniteScroll) {
    if (!prefs.infiniteScroll && infiniteScrollManager) {
      infiniteScrollManager.destroy();
      infiniteScrollManager = null;
    } else if (prefs.infiniteScroll && !infiniteScrollManager && (engine?.getNextPageUrl || engine?.triggerNextPage || engine?.getNextPageRequest)) {
      const container = findInfiniteScrollContainer();
      if (container) {
        infiniteScrollManager = new InfiniteScrollManager(
          engine,
          container,
          (nodes) => processResults(nodes),
          {
            threshold: prefs.infiniteScrollThreshold,
            maxPages: prefs.infiniteScrollMaxPages,
            persist: prefs.infiniteScrollPersist,
            freshnessMinutes: 30,
            // See tryStartInfiniteScroll: per-engine anti-bot delay.
            fetchDelay: engine.id === "startpage" ? 1500 : 600,
            debugMode: prefs.debugMode,
            // Startpage's fetched SSR markup uses class names the live
            // client-rendered stylesheet never defines.
            portFetchedStyles: engine.id === "startpage",
            // See tryStartInfiniteScroll: third-party tier stays off to
            // honor the zero-external-requests privacy promise.
            allowThirdPartyIcons: false,
          }
        );
        infiniteScrollManager.init();
      }
    }
  }
}

async function refreshEntries(): Promise<void> {
  entries = await getList();
  refreshMatcher();
  updateCache();

  // The reconcile body lives in reconcilePageInPlace() so the post-cache-prime
  // path can share it verbatim rather than growing a second, subtly different
  // copy of the restore/restamp rules.
  await reconcilePageInPlace();
  // Keep :has() rules in sync with the updated list.
  updateHasRules();
}

/**
 * Rebuild the matcher from the current list + prefs, then publish the state to
 * the diagnostics. Every site that changes `entries`, `prefs`, `engineActive` or
 * the provenance flags calls this.
 */
function refreshMatcher(): void {
  if (prefs) {
    matcher = new DomainMatcher(entries, prefs.subdomainWildcard);
  }
  syncDiag();
}

/**
 * THE ONLY place matcher state reaches the diagnostics.
 *
 * This function exists because the previous arrangement failed in the worst
 * possible way: `setDiagMatcher` was called from inside `refreshMatcher`, and
 * `init()` — which builds the matcher directly, at its own line — NEVER called
 * `refreshMatcher`. So on a normal page load the D1 detector's loop was skipped
 * entirely and the report printed `visibleButBlocked: 0` plus "no known failure
 * signature detected" on exactly the page a user would paste it from. The unit
 * test passed because it called the setter by hand; the wiring from index.ts to
 * the detector was untested and broken.
 *
 * Hence: a single publisher, called from every mutation site, so the report
 * cannot describe a matcher that is not the live one.
 */
function syncDiag(): void {
  // The resolver wraps the ENGINE'S OWN discovery and URL resolution. A
  // diagnostic that re-derives these measures a different system: the previous
  // revision iterated a hard-coded list of Google class names (whose section
  // wrappers counted one blocked result up to four times) and parsed `<cite>`
  // text (which misses breadcrumbs, so real blocked results were invisible to
  // it). See `DiagResolver` in debug.ts.
  setDiagResolver(
    engine
      ? {
          resultNodes: () => {
            try {
              return engine!.getResultNodes(document);
            } catch {
              bumpRejection("adapterOfferedNone");
              return [];
            }
          },
          resultUrl: (n) => {
            try {
              return engine!.getResultUrl(n);
            } catch {
              return null;
            }
          },
          isBlocked: (u) => {
            try {
              return matcher?.match(u).matched === true;
            } catch {
              return false;
            }
          },
          engineActive,
          engineId: engine.id,
          // Measured, not assumed. On google.com/maps this is false, and the
          // report says so instead of confidently describing a non-SERP.
          isSerp: safeResultNodeCount() > 0,
        }
      : null
  );

  setDiagMatcherInfo({
    entriesTotal: entries.length,
    // `size` is what the matcher ACTUALLY holds: `rebuild()` skips disabled
    // entries, so `entries.length` counts domains that can never match. A list
    // of 5 with 4 switched off must not read as "5 rules available".
    entriesEnabled: matcher ? matcher.size : 0,
    wildcard: prefs?.subdomainWildcard ?? true,
    degradedStart,
    stateAuthoritative,
  });
}

/** `getResultNodes` can throw on exotic markup; a diagnostic must not. */
function safeResultNodeCount(): number {
  try {
    return engine ? engine.getResultNodes(document).length : 0;
  } catch {
    return 0;
  }
}

// â”€â”€ updateHasRules â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Calls the updater function exposed by the preload on window.__shhUpdateHas
// so the :has() adoptedStyleSheets rules stay in sync with the current block
// list.  Both scripts share the same isolated-world window object.
// Safe no-op on Firefox < 121 (where __shhUpdateHas is never set) or when
// prefs/entries are not yet loaded.
function updateHasRules(): void {
  const fn = (window as Window & { __shhUpdateHas?: (d: string[], w: boolean) => void })
    .__shhUpdateHas;
  if (typeof fn !== "function" || !prefs) return;
  const blocked = entries.filter(e => e.enabled).map(e => e.domain);
  fn(blocked, prefs.subdomainWildcard);
}

// â”€â”€ injectHidingStyles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Injects display:none rules for .shh-hidden and .shh-pban via an
// adoptedStyleSheet (a JS-owned stylesheet object, not a DOM element).
// This protects nodes that hideResult() has stamped with those classes even
// if Google's deferred scripts later reset the nodes' inline style attributes.
function injectHidingStyles(): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.insertRule(`.shh-hidden{display:none!important}`, 0);
    sheet.insertRule(`.shh-pban{display:none!important}`, 1);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch { /* adoptedStyleSheets unavailable — inline style remains the fallback */ }
}

// â”€â”€ earlyHideFromCache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Reads the same localStorage cache the preload uses and immediately hides
// any result nodes that are still visible (no data-shh-preloaded marker)
// because Google's JS replaced them between document_start and document_idle.
// Called SYNCHRONOUSLY at the start of init(), before the first await, so
// there is no rendering window between this call and the actual DOM changes.
function earlyHideFromCache(): void {
  if (!engine) return;
  try {
    // parseCache + entriesFromCache, NOT an inline re-parse. This function
    // used to do its own `JSON.parse` + `Array.isArray(domains)` + a hand-built
    // `{domain, mode:"block", enabled:true, createdAt:0}` projection, and read
    // the raw `"_shh_cache"` literal instead of the CACHE_KEY constant — a
    // third copy of the same rules. The copies had already drifted: the shared
    // parser returns `null` for a malformed `domains` field (so a corrupt cache
    // means "no idea, hide nothing") while this one coerced it to `[]` and
    // carried on. One implementation, one key, one set of rules.
    const cache = parseCache(localStorage.getItem(CACHE_KEY));
    if (!cache) return;
    // Blocking suspended for this engine — hiding here would leave results
    // invisible with no placeholder and no way to show them.
    if (cache.paused) return;
    if (cache.domains.length === 0) return;

    const cacheMatcher = new DomainMatcher(entriesFromCache(cache), cache.wildcard);

    for (const node of engine.getResultNodes(document)) {
      // Skip nodes the preload already marked or the content script stamped.
      if (node.getAttribute("data-shh-preloaded") || node.getAttribute("data-shh-result")) continue;

      const url = engine.getResultUrl(node);
      if (!url) continue;
      if (cacheMatcher.match(url).matched) {
        // Three-layer protection so the result stays hidden even if Google's
        // JS resets inline styles or attributes before processResults() runs:
        //   1. Attribute  â†’ matched by [data-shh-preloaded]{display:none!important}
        //      (adoptedStyleSheet from preload — never a DOM node, page JS can't
        //      remove it).
        //   2. Class      â†’ matched by .shh-hidden{display:none!important}
        //      (adoptedStyleSheet from injectHidingStyles(), already active because
        //      injectHidingStyles() is called before earlyHideFromCache()).
        //      Survives Google resetting the inline `style` attribute.
        //   3. Inline style â†’ last resort if both sheets are somehow bypassed.
        node.setAttribute("data-shh-preloaded", "true");
        node.classList.add("shh-hidden");
        (node as HTMLElement).style.setProperty("display", "none", "important");
      }
    }
  } catch { /* localStorage unavailable or JSON corrupt — safe to ignore */ }
}

// â”€â”€ Infinite scroll container â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Find a suitable container to append new results into.  Uses unstamped nodes
// when available (before processResults), and falls back to known CSS selectors
// when all nodes are already stamped (mid-session toggle).
function findInfiniteScrollContainer(): Element | null {
  if (engine?.getResultsContainer) {
    const c = engine.getResultsContainer(document);
    if (c) return c;
  }
  if (engine) {
    const results = engine.getResultNodes(document);
    if (results.length > 0) return results[0]?.parentElement ?? null;
  }
  const stamped = document.querySelector('[data-shh-result]');
  if (stamped?.parentElement) return stamped.parentElement;
  return null;
}

// Write the current block list to localStorage so the preload script can
// read it synchronously on the next page load and hide blocked results
// before they are ever painted.
// Only ENABLED entries are written — disabled ones must not be pre-hidden,
// because the main content script will not re-hide them (they are not
// matched) and the preload hiding would cause a visible "unblock" flash.
// The paused flag is written whenever blocking is suspended for this engine
// so the preload and earlyHide both stand down on the next load.
function updateCache(): void {
  if (!prefs || !engine) return;
  const cache = buildCache(entries, prefs, engine.id);

  // D5 guard. A degraded start holds an empty list because messaging failed,
  // NOT because the user has no blocks. Publishing that would overwrite a good
  // cache with `{"domains":[]}`, and since the preload cannot tell the two
  // apart, pre-paint hiding would stay dead on this origin for good — long
  // after the background woke up. See content/cache-state.ts.
  if (!canPublishCache(cache, stateAuthoritative)) {
    shhLog("cache write skipped — non-authoritative empty state (degraded)");
    return;
  }

  try {
    // Persisted so the NEXT page load can seed the debug gate synchronously,
    // before the async prefs round-trip resolves.
    localStorage.setItem(CACHE_KEY, serializeCache(cache));
  } catch (err) {
    // Silent until now, which made a blocked-storage environment
    // indistinguishable from an empty block list: the preload logs
    // `domains=0` in both cases. Surfaced under Debug mode so the two can
    // be told apart from a console paste.
    if (isDebugMode()) {
      console.warn("[SHH] could not write _shh_cache — pre-paint hiding will be inert", err);
    }
    /* localStorage may be unavailable in some browser configs */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
