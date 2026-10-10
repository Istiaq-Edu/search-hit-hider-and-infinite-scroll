import {
  resolveGoogleStream,
  isGoogleNonResult,
  looksLikeGoogleSection,
  looksLikeGoogleAggregate,
  googleDisplayDomain,
} from "./engines/google-dom";
import {
  isOwnEchoRecord,
  GOOGLE_COVER_SELECTOR,
  GOOGLE_COVER_CANDIDATE_SELECTOR,
  revealCoverCandidate,
} from "./markers";

// ============================================================
// Anti-FOUC preload — registered at document_start.
//
// Strategy:
//   1. Read the block list from localStorage synchronously.
//      The main content script writes this cache after every
//      entries change, so it is always up-to-date.
//   2. Use a MutationObserver to watch for result elements
//      being inserted into the DOM as the page renders.
//   3. Hide ONLY individual result elements whose URL matches
//      a blocked domain — containers are never touched.
//
// KEY SAFETY RULE: before hiding any element, we verify it does
// NOT contain other result-matched children.  If it does, it is
// a container (e.g. Google's #rso > div that wraps ALL results)
// and must be skipped — hiding it would hide every result on the
// page.  Only leaf result nodes are ever hidden.
//
// BFCACHE / REFRESH FLICKER — ROOT CAUSE AND FIX:
//   When the browser restores a page from its back/forward cache
//   (bfcache), content scripts do NOT re-run.  The DOM is thawed
//   exactly as it was — including data-shh-preloaded attributes
//   set by the previous preload run — but the adoptedStyleSheets
//   that the preload JS injected are lost (they lived in the frozen
//   JS execution context).  Without those sheets, blocked results
//   have no CSS making them display:none, so they flash visible
//   before the content script re-hides them.
//
//   Fix — three layers working together:
//     A) preload.css (static manifest CSS file):
//        Applied by the browser engine at stylesheet-cascade level,
//        before ANY JS runs and AUTOMATICALLY re-applied on every
//        bfcache restoration.  Keeps [data-shh-preloaded] hidden
//        and activates the div.g cover when html[data-shh-active].
//        See preload.css for full documentation.
//
//     B) html[data-shh-active] attribute:
//        Set synchronously here — before any body elements are
//        parsed — when the block list is non-empty.  Survives
//        bfcache, so the static CSS cover is armed on restoration.
//
//     C) pageshow handler (bfcache hook):
//        Re-injects adoptedStyleSheets CSS and re-evaluates all
//        result nodes on bfcache restoration in case any result
//        URLs changed between the time the page was frozen and the
//        time it is thawed (e.g. Google soft-navigation before
//        pressing Back).
//
// WHY YANDEX DOES NOT FLICKER (and the Google fix):
//   Yandex inserts result nodes COMPLETE — the title link with its
//   direct href is already in the node at insertion time.  The
//   MutationObserver fires once on the complete node and tryHide()
//   immediately finds the link.
//
//   Google uses a TWO-STEP hydration pattern:
//     Step 1 — insert the div.g shell (no links yet)
//     Step 2 — populate it with <a href="..."> links via JS
//
//   The original code only checked el.matches(SELS) and
//   el.querySelectorAll(SELS) in the MutationObserver callback.
//   A link element matches neither, so when Step 2 fired the
//   observer for the newly added <a>, the parent div.g was never
//   re-checked.  The fix: also call el.closest(SELS) to walk UP
//   and re-check the parent container whenever any child is added.
//
//   Additionally, Google sometimes sets the href attribute on an
//   existing <a> via JS (setAttribute) rather than inserting a new
//   element.  We now watch attribute mutations on href so those
//   cases are also caught.
//
//   Furthermore, Google's client-side navigation REUSES div.g nodes
//   across searches (instead of replacing them).  A node previously
//   confirmed safe (data-shh-ok) may now contain a blocked link.
//   The MutationObserver Cases C & D clear data-shh-ok before
//   re-calling tryHide() so the cover CSS re-applies instantly and
//   tryHide() re-evaluates the node from scratch.
// ============================================================

(function shh_preload(): void {

  // ── 1. Read the synchronous cache ────────────────────────────────────────
  let domains: string[] = [];
  let wildcard = true;
  let paused = false;

  try {
    const raw = localStorage.getItem("_shh_cache");
    if (raw) {
      const c = JSON.parse(raw) as { domains?: string[]; wildcard?: boolean; paused?: boolean };
      domains = Array.isArray(c.domains) ? c.domains : [];
      wildcard = c.wildcard !== false;
      paused = c.paused === true;
    }
  } catch { /* localStorage unavailable or JSON corrupted */ }
  const buildV =
    typeof __SHH_BUILD__ !== "undefined"
      ? __SHH_BUILD__
      : (browser.runtime.getManifest?.().version ?? "?");
  // `buildV` already carries its own "v" (the stamp is "v1.8.20+<hash>"), so
  // the template must not add a second one.
  console.log(`[SHH-preload ${buildV}] host=${location.hostname} domains=${domains.length} paused=${paused}`);

  // ── Preload-side timeline ───────────────────────────────────────────────
  // Both this and the content script record against the SAME document
  // performance timeline, so their marks are directly comparable. That is the
  // measurement the whole show/hide investigation needed and never had: did the
  // 2s cover-reveal fire BEFORE or AFTER the authoritative processResults?
  const shhPreloadMarks: Array<{ label: string; t: number }> = [];
  const pmark = (label: string): void => {
    shhPreloadMarks.push({ label, t: Math.round(performance.now()) });
  };
  pmark("preload-start");

  // Whether the 2s unconditional cover-reveal actually fired, and whether the
  // CSS layers ended up live. Both were unmeasurable before.
  const preloadDiag = {
    version: buildV,
    host: location.hostname,
    domains: domains.length,
    paused,
    hasRulesBuilt: 0,
    coverAttached: false,
    adoptedSheetCount: 0,
    revealFiredAtMs: null as number | null,
    revealFired: false,
    // Not a constant. The previous revision initialised this to "ran fully" and
    // never assigned it again, so it reported "ran fully" for a preload that
    // bailed early or threw. Set at each early return below.
    preloadSkipReason: "starting",
    coversAnyNode: 0,
    // The whole preload-vs-content timing comparison assumes both scripts share
    // one clock. Publishing the value is what lets the field report CHECK that
    // assumption instead of resting on it.
    timeOrigin: typeof performance !== "undefined" ? performance.timeOrigin : null,
  };

  try {
    document.documentElement.setAttribute(
      "data-shh-preload-run",
      // `buildV` already begins with "v" (the stamp is "v1.8.20+<hash>"), so
      // this template must not prepend another - it read "v=v1.8.20+...".
      `build=${buildV};host=${location.hostname};domains=${domains.length};paused=${paused}`
    );
  } catch { /* ignore */ }

  (window as Window & { __shhPreloadDiag?: () => unknown }).__shhPreloadDiag = () => ({
    ...preloadDiag,
    marks: shhPreloadMarks,
    // Uncaught errors seen by this script, with their throwing frame. A report
    // that shows this non-empty tells us exactly what the console could not.
    errors: errors.slice(),
    // `contentMarks` reads an attribute off documentElement. Guarded, because a
    // diagnostic that throws takes the ENTIRE field report with it — and this
    // is the last thing standing between a field tester and a usable paste.
    // Verified by driving documentElement to null and requiring this to
    // survive.
    contentMarks: readContentMarks(),
  });

  // Pause / engine-disable must stop ALL preload hiding. The main content
  // script writes this flag whenever blocking is suspended for this engine;
  // without it, paused users see results vanish with no placeholder or way
  // to show them (the main script also skips processing when paused).
  if (paused) domains = [];

  // ── 2. Google detection (needed before adoptedStyleSheets setup) ──────────
  const isGoogle = (
    location.hostname === "www.google.com" ||
    location.hostname.startsWith("www.google.") ||
    location.hostname.startsWith("google.co") ||
    location.hostname === "encrypted.google.com"
  );

  // ── 3. Arm the static CSS cover (html[data-shh-active]) ──────────────────
  //
  // preload.css contains:
  //   html[data-shh-active] div.g:not(.g .g):not([data-shh-ok]):not([data-shh-preloaded])
  //     { opacity:0!important; pointer-events:none!important }
  //
  // That rule only fires when <html> carries data-shh-active.  We set it
  // synchronously here (before any body elements are parsed) when the block
  // list is non-empty.  On bfcache restoration the attribute survives in the
  // DOM, so the static CSS cover is active before any JS runs.
  //
  // WHY NOT always set it: users with an empty block list must see results
  // immediately — we must not cover div.g when there is nothing to block.
  // ── 3. Arm the static CSS cover (html[data-shh-active]) ──────────────────
  //
  // preload.css contains:
  //   html[data-shh-active] div.g:not(.g .g):not([data-shh-ok]):not([data-shh-preloaded])
  //     { opacity:0!important; pointer-events:none!important }
  //
  // That rule only fires when <html> carries data-shh-active.  We set it
  // synchronously here (before any body elements are parsed) when the block
  // list is non-empty.  On bfcache restoration the attribute survives in the
  // DOM, so the static CSS cover is active before any JS runs.
  //
  // WHY NOT always set it: users with an empty block list must see results
  // immediately — we must not cover div.g when there is nothing to block.
  //
  // `coverArmed` is the single source of truth for BOTH the attribute and the
  // adopted sheet, and the bfcache `pageshow` handler consults it rather than
  // `isGoogle`. Re-arming from `isGoogle` alone re-armed the cover on a page
  // that had been SUSPENDED (whose content observer is stopped, so anything
  // rendered later stayed at opacity:0 with no reveal net) and on a tab with an
  // empty block list (whose preload IIFE returned early, so no observer and no
  // reveal existed at all — a blank SERP after Back).
  let coverArmed = false;
  if (domains.length > 0 && isGoogle) {
    coverArmed = true;
    try {
      document.documentElement.setAttribute("data-shh-active", "true");
    } catch { /* ignore */ }
  }

  // ── 4. Inject adoptedStyleSheets CSS (belt-and-suspenders) ───────────────
  //
  // preload.css (static file, see above) is the PRIMARY mechanism.
  // These adoptedStyleSheets are a SECONDARY belt-and-suspenders layer for
  // browsers that process the static CSS after first-paint (rare), or for
  // any edge case where the static CSS is unavailable.
  //
  // They are also re-injected by the pageshow handler on bfcache restoration
  // as an extra safety net in case the static CSS alone isn't enough.
  //
  // Three-layer approach (outermost wins if inner layers fail):
  //
  // Layer A — adoptedStyleSheets (preferred):
  //   A CSSStyleSheet JS object attached to document.adoptedStyleSheets.
  //   It is NOT a DOM element, so page JS cannot remove it by removing a
  //   <style> node, clearing innerHTML, etc.  Google's framework has no
  //   reason to enumerate or clear document.adoptedStyleSheets.
  //
  // Layer B — <style> element (fallback):
  //   A DOM <style> element. Survives most page JS but can be removed if
  //   the framework resets document.head children.  Used when the
  //   Constructable StyleSheets API is unavailable (rare).
  //
  // Layer C — inline style (belt-and-suspenders):
  //   Set directly on each element in tryHide().  Survives <style> removal
  //   but can be wiped by Google's framework resetting element.style.
  //   Kept as a last resort in case both CSS layers fail.

  // Track injected sheets so re-injection (pageshow) is idempotent.
  let preloadAdoptedSheet: CSSStyleSheet | null = null;
  let coverAdoptedSheet:   CSSStyleSheet | null = null;

  function injectBlockingCSS(): void {
    const RULE = '[data-shh-preloaded="true"]{display:none!important}';
    // Layer A — Constructable StyleSheets (not a DOM node, cannot be removed
    //           by any DOM API).
    try {
      if (!preloadAdoptedSheet) {
        preloadAdoptedSheet = new CSSStyleSheet();
        preloadAdoptedSheet.insertRule(RULE, 0);
      }
      // Re-attach only if not already present (idempotent on pageshow).
      if (!document.adoptedStyleSheets.includes(preloadAdoptedSheet)) {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, preloadAdoptedSheet];
      }
      return; // Layer A succeeded — no need for the DOM fallback.
    } catch { /* API unavailable — fall through to <style> */ }
    // Layer B — <style> element fallback.
    try {
      if (!document.getElementById("shh-preload-css")) {
        const style = document.createElement("style");
        style.id = "shh-preload-css";
        style.textContent = RULE;
        // document.head may not exist yet at document_start — append to <html>.
        (document.head ?? document.documentElement).appendChild(style);
      }
    } catch { /* give up — layer C (inline style) is the last resort */ }
  }

  // ── 3c. Google-specific cover CSS (adoptedStyleSheets layer) ─────────────
  //
  // The PRIMARY cover is in preload.css (static CSS file, always applied by
  // the browser even on bfcache restoration).  This adoptedStyleSheets rule
  // is a SECONDARY layer added here for belt-and-suspenders robustness, and
  // it is re-injected by the pageshow handler on bfcache restoration.
  //
  // ROOT CAUSE OF GOOGLE FLICKER (different from all other engines):
  //   Google uses a two-step hydration pattern:
  //     Step 1 — inserts the div.g shell into the DOM (no links yet)
  //     Step 2 — a separate JS task adds <a href="..."> links inside it
  //   Between steps 1 and 2 there can be a rendered frame where the shell
  //   is visible.  No JS-based approach (MutationObserver, closest(), etc.)
  //   can prevent a render that happens between two separate tasks.
  //   CSS :has() can't help either because the shell has no links to match.
  //
  // WHY opacity:0 and NOT visibility:hidden:
  //   visibility:hidden can be overridden by children — if any descendant of
  //   div.g has an explicit `visibility:visible` rule (which Google's own
  //   stylesheets set on many inner elements), those children remain fully
  //   visible through the parent's visibility:hidden, defeating the cover.
  //   opacity:0 is absolute: when a parent has opacity:0 the ENTIRE subtree
  //   is invisible — children cannot override the parent stacking context.
  //   It also preserves layout (no reflow).
  //
  // GOOGLE-ONLY — other engines (Yandex, Bing, etc.) insert complete nodes
  //   with links already present, so :has() + MutationObserver handle them
  //   perfectly.  Applying this cover to other engines is unnecessary and
  //   could cause unwanted side-effects.
  // Cover both the classic div.g selector (pre-2025) and div.tF2Cxc which is
  // Google's 2025 per-result card replacing div.g in the updated SERP layout.
  // Defined ONCE in markers.ts: preload.css carries the same rule, preload.ts
  // re-queries it here to stamp data-shh-ok, and blocking/hider.ts has to
  // exempt the same set on show-once. Three copies of this string is how they
  // drifted into disagreeing.
  const GOOGLE_COVER_SEL = GOOGLE_COVER_SELECTOR;

  function injectCoverCSS(): void {
    // `lc`, not `domains`. `domains` is the document_start snapshot and is
    // never rewritten — a tab that loaded while paused has it empty forever, so
    // the old guard made the cover permanently unbuildable on exactly the tab
    // __shhRearmCover exists for. `lc` is the live list, so after a resume the
    // cover can actually be built. (Hoisted `let`, read at call time, so there
    // is no TDZ: every call site is below the declaration.)
    if (!isGoogle || lc.length === 0) return;
    try {
      if (!coverAdoptedSheet) {
        coverAdoptedSheet = new CSSStyleSheet();
        // opacity:0 cannot be overridden by child elements (unlike visibility:hidden).
        // pointer-events:none prevents any interaction while the cover is active.
        coverAdoptedSheet.insertRule(
          `${GOOGLE_COVER_SEL}{opacity:0!important;pointer-events:none!important}`,
          0
        );
      }
      if (!document.adoptedStyleSheets.includes(coverAdoptedSheet)) {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, coverAdoptedSheet];
      }
      preloadDiag.coverAttached = true;
      preloadDiag.adoptedSheetCount = document.adoptedStyleSheets?.length ?? 0;
    } catch { /* adoptedStyleSheets unavailable — static CSS is the primary protection */ }
  }

  // -- Uncaught-error trap --------------------------------------------------
  //
  // WHY THIS EXISTS
  // ---------------
  // The 2026-09-29 field run produced dozens of "TypeError: H is not a
  // function  preload.js:2:1870" and no actionable information whatsoever.
  // "H" is a minified identifier; 2:1870 points at a resolveGoogleStream(doc)
  // call that provably CANNOT throw -- verified: H is a hoisted function
  // declaration at the same lexical depth as both its call sites, and its
  // selector loop swallows its own errors. So the console was pointing at the
  // enclosing MutationObserver callback rather than at the statement that
  // actually threw, and nothing in the build could recover the difference.
  //
  // Three changes make the next run conclusive:
  //   1. this trap records the message AND the stack, so the report carries the
  //      real throwing frame instead of a mangled position;
  //   2. build.js now ships external sourcemaps and keepNames, so even the
  //      console line maps back to source;
  //   3. the observer callback body is wrapped, so one bad batch neither aborts
  //      the rest of that batch nor every batch after it.
  //
  // Capped ring: an error-per-mutation bug would otherwise grow this without
  // bound, which is its own memory leak in a script that runs for the life of
  // the tab.
  const errors: string[] = [];
  const recordError = (where: string, e: unknown): void => {
    // Must not be able to throw. It is called FROM the catch that is the last
    // line of defence, and it touches a value that may be a page-compartment
    // object whose `stack` getter can throw. An error handler that can throw is
    // not an error handler.
    let msg: string;
    let frame = "";
    try {
      msg = e instanceof Error ? e.name + ": " + e.message : String(e);
    } catch { msg = "(unprintable error)"; }
    try {
      if (e instanceof Error && e.stack) frame = (e.stack.split("\n")[1] ?? "").trim();
    } catch { frame = ""; }
    try {
      errors.push(where + " | " + msg + (frame ? " | " + frame : ""));
      while (errors.length > 25) errors.shift();
    } catch { /* the array is gone; nothing left to do */ }
  };
  try {
    window.addEventListener("error", (ev: Event) => {
      recordError("window.error", (ev as ErrorEvent).error ?? (ev as ErrorEvent).message);
    });
    window.addEventListener("unhandledrejection", (ev: Event) => {
      recordError("unhandledrejection", (ev as PromiseRejectionEvent).reason);
    });
  } catch { /* addEventListener unavailable - the report just shows fewer errors */ }

  /**
   * The content script's marks, mirrored onto <html>, parsed for comparison
   * against the preload's own timeline.
   *
   * `^(\d+):(.*)$` and not a plain `split(":")`: the preload's OWN writer emits
   * `hasRules:cleared`, so a label containing a colon is already in use in this
   * codebase, and a plain split silently truncated it to the text before the
   * first colon.
   *
   * Every step is guarded. This function runs inside `__shhPreloadDiag`, which
   * is what a field tester calls to produce the report — an exception here
   * destroys the whole paste, which is strictly worse than the bug it was
   * meant to explain.
   */
  function readContentMarks(): { tMs: number; label: string }[] {
    try {
      const raw = document.documentElement?.getAttribute("data-shh-diag-marks") ?? "";
      return raw.split("|").filter(Boolean).map((s) => {
        const m = s.match(/^(\d+):(.*)$/);
        return { tMs: m ? Number(m[1]) : NaN, label: m ? m[2]! : s };
      });
    } catch (e) {
      recordError("preloadDiag.contentMarks", e);
      return [];
    }
  }

  // ── 4. State the content script can drive at runtime, and the four hooks ──
  //
  // WHY THIS BLOCK IS ABOVE THE EMPTY-LIST EARLY RETURN
  // ---------------------------------------------------
  // An earlier revision installed all four window hooks *after*
  // `if (domains.length === 0) return;`. That is a hard exit, and it is
  // reached on precisely the two states these transitions come from:
  //
  //   * a tab loaded while PAUSED (`if (paused) domains = []` above), and
  //   * any fresh install with no cache yet.
  //
  // On those pages NO hook existed, so the content script's resume branch
  // called `__shhUpdateHas?.()`, `__shhRearmCover?.()` and got nothing —
  // `?.` swallowed the miss and the tab silently kept no `:has()` layer and no
  // cover for the rest of its session. `__shhRearmCover`'s own comment claimed
  // it closed "no pre-paint protection after resume" on a page where it could
  // not fire.
  //
  // The hooks are now installed unconditionally and gate themselves. Only the
  // OBSERVER and the scan stay behind the early return — those are the parts
  // that actually cost something, and with an empty list there is nothing to
  // hide anyway.
  //
  // `buildHasRules`, `sanitizeDomains`, `revealRemainingGoogle` and
  // `injectCoverCSS` are function DECLARATIONS, so hoisting makes them safe to
  // reference from here; only the `let` bindings had to move.

  // Convert every entry to ASCII (punycode) form — hostnames parsed from
  // page URLs are always ASCII, so a unicode entry would never match — and
  // drop anything that still contains characters outside the hostname-safe
  // set. Junk entries (hand-edited or imported lists) containing quotes or
  // braces would otherwise break out of the CSS attribute selectors below
  // and could invalidate an entire :is() rule batch.
  const HOSTNAME_SAFE = /^[a-z0-9.-]+$/;

  function sanitizeDomains(list: unknown): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    // The CONTAINER needs a guard too, not just the elements. `__shhUpdateHas`
    // is reachable from `index.ts` with anything the caller likes, and
    // `for (const raw of list)` throws `TypeError: list is not iterable` for
    // undefined/null/number/boolean — which, before the element guard existed,
    // escaped the whole IIFE and left the Google cover permanently up. The
    // element check below is not a substitute for this one.
    if (!Array.isArray(list)) return out;
    for (const raw of list as unknown[]) {
      // MUST be a string. `Array.isArray` on the cache payload validates the
      // container, not the elements, and `_shh_cache` lives in localStorage on
      // the PAGE's origin — writable by any script that has run there (the
      // repo's own A4-FYI records this). A payload like {"domains":[{}]} used
      // to throw `raw.trim is not a function` HERE, at module scope, which
      // escaped the whole preload IIFE: __shhRevealGoogle was never installed,
      // the observer never started, and every Google result stayed at the
      // cover's `opacity:0 !important; pointer-events:none !important`. The
      // visible result was a blank, unclickable SERP with no error anywhere.
      if (typeof raw !== "string") continue;
      let d = raw.trim().toLowerCase();
      if (d.startsWith("www.")) d = d.slice(4);
      try {
        d = new URL("https://" + d).hostname;
      } catch { /* unparseable — the safety check below rejects it */ }
      if (!d || !HOSTNAME_SAFE.test(d) || seen.has(d)) continue;
      seen.add(d);
      out.push(d);
    }
    return out;
  }

  // `let`, not `const`: __shhUpdateHas rebinds these so a runtime block-list
  // change reaches the preload's OWN JS hiding path (tryHide → hostMatches →
  // lc) as well as the :has() sheet. Updating only the sheet would leave the
  // two preload layers disagreeing for the rest of the page — and after a
  // suspend, the CSS layer empty while tryHide still hides, i.e. a paused page
  // with new nodes hidden and no placeholder, because the content observer is
  // stopped. That is the failure the 2026-08-30 diagnosis named: no
  // independent layers.
  let lc = sanitizeDomains(domains);
  let lcWildcard = wildcard;

  // The `:has()` layer's sheet handle. Declared here (not next to
  // buildHasRules) so __shhUpdateHas can exist before the early return.
  let hasSheet: CSSStyleSheet | null = null;

  // ── 6. Window hooks ──────────────────────────────────────────────────────
  // Runtime list replacement from the content script. Rebinds `lc` as well as
  // rebuilding the sheet, so the preload's own JS hiding path and the CSS layer
  // can never disagree.
  (window as Window & { __shhUpdateHas?: (d: string[], w: boolean) => void })
    .__shhUpdateHas = (newDomains: string[], newWildcard: boolean): void => {
    lc = sanitizeDomains(newDomains);
    lcWildcard = newWildcard;
    buildHasRules(lc, lcWildcard);
  };

  // ── 7. Reveal helper ──────────────────────────────────────────────────────
  // Reveal any Google result containers that are still undetermined (no links
  // found yet — skeleton nodes).  Called from timed rescans and exposed to
  // the content script so it can trigger the final reveal after processResults().
  function revealRemainingGoogle(why: string = "unspecified"): void {
    if (!isGoogle) return;
    preloadDiag.revealFired = true;
    preloadDiag.revealFiredAtMs = Math.round(performance.now());
    // Labelled by ORIGIN. There are six call sites, and the report's whole
    // point is to compare the 2s safety net against the content script's own
    // post-processResults call — impossible when they share a label.
    pmark(`google-cover-reveal:${why}`);
    try {
      // One query, one snapshot: counting and stamping from two separate
      // querySelectorAll calls let a mutation between them make the reported
      // number disagree with the effect.
      const nodes = document.querySelectorAll(GOOGLE_COVER_SEL);
      preloadDiag.coversAnyNode = nodes.length;
      nodes.forEach(el => { el.setAttribute("data-shh-ok", "true"); });
    } catch { /* ignore */ }
  }

  // Expose to the content script (same isolated-world window) so it can call
  // this after processResults() — at that point every blocked result has been
  // stamped and any remaining undetermined node is safe to show.
  (window as Window & { __shhRevealGoogle?: () => void })
    .__shhRevealGoogle = revealRemainingGoogle;

  // ── 7a. Bounded trailing sweep for nodes we could not determine YET ───────
  //
  // `tryHide` declines to judge a node it cannot evaluate — in practice a
  // Google hydration shell whose anchor has not arrived yet. Such a node must
  // NOT be stamped safe on the spot: that is precisely the two-step-hydration
  // flicker the cover exists to prevent (the shell paints empty, then vanishes
  // when it is populated with a blocked link). So it stays covered — which is
  // only safe while something will look at it again. `data-shh-ok` is absent,
  // so the cover holds it at `opacity:0`: a full-height blank gap, the reported
  // symptom, until the next mutation.
  //
  // `revealRemainingGoogle` resolves this at DISCRETE moments only (2 s after
  // DOMContentLoaded, after processResults, on bfcache restore, on an append).
  // A shell that arrives after the last of those and is never populated — a
  // card Google inserted and then failed to hydrate, which the 2026-10-10 field
  // run's ~100 page-origin TypeErrors make plausible — stays invisible forever.
  // This is the missing trailing net.
  //
  // ONE timer, not one per node: a per-node timer on a SERP with hundreds of
  // shells is unbounded allocation, and the sweep is document-wide anyway.
  // The delay is deliberately of the same order as the 2 s net, so it can never
  // fire between the two steps of Google's two-step hydration.
  const UNDETERMINED_SWEEP_MS = 1200;
  let undeterminedTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleUndeterminedSweep(): void {
    if (!isGoogle || undeterminedTimer !== null) return;
    try {
      undeterminedTimer = setTimeout(() => {
        undeterminedTimer = null;
        revealRemainingGoogle("undetermined-timeout");
      }, UNDETERMINED_SWEEP_MS);
    } catch { /* timers unavailable — the timed nets cannot run either way */ }
  }

  // ── 7a-bis. On-demand cover audit — THE INVARIANT, MEASURED ──────────────
  //
  // WHY THIS EXISTS: a field paste cannot currently answer "is anything stuck
  // under the cover?" The console logs a healthy boot, the appends log healthy
  // favicons, and NOTHING in any of it reports per-node visibility. So the one
  // question that matters is unanswerable from a paste, and two successive
  // field reports had to be argued about instead of read.
  //
  // Worse, the one existing signal is ambiguous. `favicon paint outcome` reports
  // `visible=false` for a covered ancestor (opacity:0 — the bug) AND for a
  // blocked result (display:none — correct), and it samples only the FIRST
  // appended node. It cannot discriminate.
  //
  // This hook answers the question directly, on demand, at the moment the user
  // can see the problem. It is the invariant the whole cover design rests on:
  //   "every node the cover can match carries a POSITIVE determination"
  // so the number to look at is `blankGaps` — nodes the cover matches, that no
  // marker has determined, AND that occupy vertical space. Anything above zero
  // IS the reported symptom, named and counted.
  //
  // Uses the SAME shared selector the CSS rule and the reveal paths use, so it
  // cannot drift from what is actually painted.
  (window as Window & { __shhCoverAudit?: () => unknown }).__shhCoverAudit = () => {
    try {
      const undetermined: Array<Record<string, unknown>> = [];
      let candidates = 0;
      for (const el of Array.from(
        document.querySelectorAll(GOOGLE_COVER_CANDIDATE_SELECTOR)
      )) {
        candidates++;
        if (
          el.hasAttribute("data-shh-ok") ||
          el.hasAttribute("data-shh-preloaded") ||
          el.hasAttribute("data-shh-result")
        ) {
          continue;
        }
        const cs = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        // Is this node ACTUALLY not painted? The first version of this hook
        // counted "unmarked AND has height" as a gap, which is a false positive
        // whenever the cover is disarmed: those nodes are perfectly visible.
        // Verified in real Firefox (coverArmed=false, 3 unmarked sized nodes,
        // all with opacity 1) — the metric reported blankGaps=3 for three
        // results the user could plainly see.
        const why = cs.display === "none"
          ? "display:none"
          : cs.visibility === "hidden"
            ? "visibility:hidden"
            : cs.opacity === "0"
              ? "opacity:0"
              : null;
        undetermined.push({
          tag: el.tagName.toLowerCase(),
          cls: String((el as HTMLElement).className || "").slice(0, 40),
          opacity: cs.opacity,
          display: cs.display,
          visibility: cs.visibility,
          h: Math.round(box.height),
          w: Math.round(box.width),
          invisible: why !== null,
          why,
          text: (el.textContent || "").trim().slice(0, 40),
        });
      }
      return {
        coverArmed,
        active: document.documentElement.hasAttribute("data-shh-active"),
        // The number that decides whether this audit means anything at all. The
        // preload reads its block list from `_shh_cache` at document_start; with
        // an empty cache the cover is NEVER armed, so `blankGaps=0` is trivially
        // true and proves nothing. A field report showed exactly that
        // (domains=0 while storage held 6), and the audit's verdict still said
        // "nothing is stuck under the cover" — a false all-clear from the one
        // tool built to avoid false all-clears.
        preloadDomains: lc.length,
        skipReason: preloadDiag.preloadSkipReason ?? null,
        candidates,
        undeterminedCount: undetermined.length,
        // The symptom, counted honestly: unmarked, occupying space, AND
        // actually not painted. `coverGaps` narrows that to the cover's own
        // signature (opacity:0), so a gap caused by Google's visibility:hidden
        // is never misattributed to us.
        blankGaps: undetermined.filter((u) => Number(u.h) > 0 && u.invisible === true).length,
        coverGaps: undetermined.filter((u) => Number(u.h) > 0 && u.opacity === "0").length,
        revealFiredAtMs: preloadDiag.revealFiredAtMs ?? null,
        undetermined: undetermined.slice(0, 20),
      };
    } catch (e) {
      // Surface the reason, with the stack — this hook is the field oracle for
      // the whole cover invariant, so "it did not work" must not be silent.
      return { error: String(e), stack: (e as Error)?.stack ?? null };
    }
  };

  // ── 7b. Disarm the cover entirely ─────────────────────────────────────────
  //
  // The content script's mid-session suspend needs this, and it CANNOT be done
  // from there: `coverAdoptedSheet` is a closure local, so only this script can
  // detach it.
  //
  // Removing `html[data-shh-active]` alone is NOT enough. That attribute gates
  // only the STATIC preload.css rule; the primary cover is the adopted
  // stylesheet created at document_start, which stays attached regardless. A
  // result rendered after a pause — a soft navigation, an appended infinite-
  // scroll page — matches it, gets `opacity:0 !important` and
  // `pointer-events:none !important`, and the observer has been stopped, so
  // nothing ever marks it safe. Invisible AND unclickable, for good.
  //
  // preload.ts's own comment at the top of the file states the invariant this
  // preserves: "Pause / engine-disable must stop ALL preload hiding."
  (window as Window & { __shhDisarmCover?: () => void }).__shhDisarmCover = () => {
    coverArmed = false;
    preloadDiag.coverAttached = false;
    try {
      if (coverAdoptedSheet) {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
          (s) => s !== coverAdoptedSheet
        );
      }
      preloadDiag.adoptedSheetCount = document.adoptedStyleSheets.length;
    } catch { /* adoptedStyleSheets unavailable — the attribute is the belt */ }
    // `documentElement` is null only before <html> exists, which cannot happen
    // by document_idle, but a throw HERE would skip the pmark and the reveal
    // below — leaving a disarmed cover with every covered node still at
    // `opacity:0; pointer-events:none` and no stamp to lift it. Degrade instead.
    try {
      document.documentElement?.removeAttribute("data-shh-active");
    } catch (e) { recordError("disarm.documentElement", e); }
    pmark("cover-disarmed");
    // Mark every currently-covered node safe so a rule that is mid-teardown
    // cannot strand a result the user has already been shown.
    revealRemainingGoogle("disarm");
  };

  // The mirror of the above, for a mid-session RESUME. Suspend tears the cover
  // down; without re-arming it here, a resumed tab has no pre-paint protection
  // for results that arrive before the content script's first pass.
  //
  // Gated on `lc` — the LIVE list — not on the document_start `domains` array,
  // which is never rewritten. The old `!domains.length` guard made this a
  // no-op on exactly the tab it exists for: one that loaded while PAUSED, where
  // `domains` was emptied at the top of this IIFE.
  (window as Window & { __shhRearmCover?: () => void }).__shhRearmCover = () => {
    if (!isGoogle || lc.length === 0) return;
    // `coverArmed` is set FIRST and unconditionally, so a throw below cannot
    // leave it true while the cover is down — which would make the bfcache
    // handler re-enter a branch that never attached a sheet. The attribute is
    // what the static preload.css rule keys on, so a null documentElement
    // degrades to "cover not armed" rather than an exception.
    coverArmed = false;
    try {
      document.documentElement?.setAttribute("data-shh-active", "true");
    } catch (e) { recordError("rearm.documentElement", e); }
    injectCoverCSS();
    preloadDiag.coverAttached = document
      .adoptedStyleSheets?.includes(coverAdoptedSheet!) ?? false;
    coverArmed = preloadDiag.coverAttached;
    pmark("cover-rearmed");
  };

  // Initial injection.
  injectBlockingCSS();
  injectCoverCSS();
  pmark("css-injected");

  // Nothing blocked in the cache. The hooks above are installed; the OBSERVER
  // and the scans are not, because with an empty list there is nothing to hide
  // and both cost real per-mutation work.
  if (domains.length === 0) {
    preloadDiag.preloadSkipReason = "no blocked domains in cache (hooks installed, observer not started)";
    return;
  }
  preloadDiag.preloadSkipReason = "ran fully";

  // ── 5. Build a fast in-memory matcher ────────────────────────────────────
  // (sanitizeDomains, `lc`, `lcWildcard` and the four window hooks are declared
  //  ABOVE the empty-list early return, so a paused-at-load tab can still be
  // driven. Only the observer and the scans are gated.)
  function hostMatches(host: string): boolean {
    const h = host.toLowerCase().replace(/^www\./, "");
    return lc.some(d => h === d || (lcWildcard && h.endsWith("." + d)));
  }

  // Resolve the real destination host for a link.
  // Google wraps result URLs in /url?q= redirects; Startpage's "anonymous
  // view" proxies wrap them in a u= param — unwrap both.
  //
  // Returns "" when the destination is NOT recoverable from the href. That
  // includes Google's current /goto?url=<opaque blob> form (2026-08-30): the
  // token is a protobuf wrapper around an encrypted payload, so callers must
  // fall back to the result's display URL instead of trusting this host.
  /**
   * Hide a node, tolerating a missing `CSSStyleDeclaration`.
   *
   * `el.style` is undefined for elements outside the HTML namespace — a XUL
   * element is still an `Element` and still matches a result selector, and
   * `.style.setProperty` on one throws `TypeError`. Every call site absorbed
   * that in a bare `catch`, so the node was neither hidden nor marked and
   * blocking was silently LOST for it, with nothing in any log. The attribute
   * half still applies, which is the layer the content script reconciles on,
   * so return whether the inline style was set rather than pretending all or
   * nothing happened.
   */
  function hideNode(el: Element): boolean {
    try {
      (el as HTMLElement).style?.setProperty("display", "none", "important");
      return true;
    } catch (e) {
      recordError("tryHide.style", e);
      return false;
    }
  }

  function resolveHost(a: HTMLAnchorElement): string {
    const raw = a.getAttribute("href") ?? "";
    // Opaque redirect — the destination is not in the URL at all.
    if (raw.includes("/goto?url=")) return "";
    if (raw.includes("/url?") || raw.includes("google.com/url")) {
      try {
        const qs = raw.slice(raw.indexOf("?") + 1);
        const q = new URLSearchParams(qs).get("q");
        if (q && q.startsWith("http")) return new URL(q).hostname;
      } catch { /* fall through to .href */ }
    }
    if (
      raw.includes("ixquick-proxy.com/do/spg/highlight.pl") ||
      raw.includes("startpage.com/av/proxy")
    ) {
      try {
        const q = raw.slice(raw.indexOf("?") + 1);
        // URLSearchParams.get() already percent-decodes once.
        const u = new URLSearchParams(q).get("u");
        if (u && u.startsWith("http")) return new URL(u).hostname;
      } catch { /* fall through to .href */ }
    }
    try { return new URL(a.href).hostname; } catch { return ""; }
  }

  // ── 6. Selectors — INDIVIDUAL result nodes only ───────────────────────
  //
  // IMPORTANT: do NOT include broad container selectors such as
  //   "#rso > div"  or  "#rso > div > div"
  // Those selectors exist in the main content script but are used there
  // with strict isValidResult() filtering.  Without that filter they would
  // match Google's outer wrapper that contains every result, causing a single
  // blocked domain to hide all results on the page.
  //
  // Rule: every selector here must match an individual result item, never a
  // wrapper that holds multiple results.
  const SELS = [
    // Google — individual organic result cards
    // div.g is the classic selector; div.tF2Cxc is the 2025 per-result card
    // Google introduced to replace div.g in the updated SERP layout.
    "div.g:not(.g .g)",
    "div.tF2Cxc:not(.tF2Cxc .tF2Cxc)",
    // DuckDuckGo — React (modern) and legacy
    "ol.react-results--main > li[data-layout='organic']",
    "div#links div.results_links_deep div.links_main",
    "div#links div.nrn-react-div",
    "div#links > div.result",
    // Bing
    "#b_content ol#b_results > li.b_algo",
    // Yahoo
    "div#web > ol.reg > li",
    "div#results div#web > ol > li",
    // Yandex
    "li.serp-item", "div.serp-item", "div.Organic", "div.organic",
    // Baidu
    "#content_left > div.result.c-container",
    "#content_left > div.result-op.c-container",
    // Ecosia
    "section.web__mainline div.mainline__result-wrapper",
    "div.results-wrapper div.web-result",
    // Startpage — 2026 live layout uses <section id="main"> (div#main matches
    // nothing), so keep #main tag-agnostic; unscoped fallback for resilience.
    "#main div.w-gl > div.result",
    "#main div.w-bg > div.result",
    "div.w-gl > div.result",
    "div.w-gl__result",
    "section#main div.css-ndwlbg > div.article",
    "[data-view='results'] li.search-result",
    // Searx / SearXNG
    "div#main_results > div.result",
    "div#results > div.result",
    // Qwant
    "div.results-column > div.result_fragment > div.result--web",
    "div.results-column > div.result_fragment > div.result--news",
    // Brave Search — data-type attribute is stable across Svelte rebuilds
    'div.snippet[data-type="web"]',
    'div.snippet[data-type="news"]',
    'div.snippet[data-type="videos"]',
  ].join(",");

  // ── 6a. Structural result discovery (class-name independent) ──────────────
  //
  // The class-based SELS above only work while Google keeps shipping div.g /
  // div.tF2Cxc. When it rotates them, the CSS layers below stop matching and
  // this preload silently does nothing — the user sees blocked results flash in
  // until the content script hides them at document_idle.
  //
  // These helpers resolve the results stream by id and take its top-level
  // children, so document_start hiding keeps working on new layouts. They are
  // used ONLY by the JS scan path, never by the CSS rules:
  //   • :has() rules (6b) and the cover CSS (3c) stay on per-result class
  //     selectors on purpose — a CSS rule cannot tell a single result from a
  //     multi-result section, so pointing them at `#rso > *` would let one
  //     blocked domain hide an entire section.
  //   • The JS path CAN tell, via looksLikeGoogleSection(), so it is safe here.
  function structuralResults(): Element[] {
    // Google-only (A2 F6): the Google stream IDs (#rso/#search/#res/
    // #center_col) are resolved for EVERY engine here while the observer
    // gates the same resolution by isGoogle. A non-Google page that
    // coincidentally carries one of those ids would feed its children to
    // tryHide WITHOUT the Google-only section/aggregate fail-open guards —
    // a blocked first link could hide a whole multi-result wrapper.
    if (!isGoogle) return [];
    const stream = resolveGoogleStream(document);
    if (!stream) return [];
    const out: Element[] = [];
    for (const child of Array.from(stream.children)) {
      if (isGoogleNonResult(child)) continue;
      // *** FAIL OPEN *** — never hide a node that wraps several results.
      if (looksLikeGoogleSection(child)) continue;
      out.push(child);
    }
    return out;
  }

  /** Nearest ancestor (incl. self) that is a direct child of the results stream. */
  function closestResultShell(stream: Element, el: Element): Element | null {
    let cur: Element | null = el;
    while (cur && cur !== stream) {
      if (cur.parentElement === stream) {
        if (isGoogleNonResult(cur) || looksLikeGoogleSection(cur)) return null;
        return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  /** Class-based + structural candidates, deduplicated. */
  function allResultCandidates(): Element[] {
    const out: Element[] = [];
    const seen = new Set<Element>();
    const push = (el: Element): void => {
      if (seen.has(el)) return;
      seen.add(el);
      out.push(el);
    };
    try { document.querySelectorAll(SELS).forEach(push); } catch { /* ignore */ }
    structuralResults().forEach(push);
    return out;
  }

  /**
   * Hide every structural result inside `el`. Used when a bulk insert adds a
   * node that CONTAINS the results stream (Case B) — the class-based
   * `el.querySelectorAll(SELS)` cannot see results on layouts that dropped
   * div.g / div.tF2Cxc.
   */
  function tryHideStructuralSubtree(stream: Element, el: Element): void {
    for (const child of Array.from(stream.children)) {
      if (child === el || !el.contains(child)) continue;
      if (isGoogleNonResult(child) || looksLikeGoogleSection(child)) continue;
      tryHide(child);
    }
  }

  // ── 6b. Instant CSS-level blocking via :has() ─────────────────────────────
  //
  // One CSS rule per blocked domain — hides any result that CONTAINS a link
  // to that domain.  CSS rules apply before any JS runs on newly inserted
  // nodes, so even when Google's hydration JS replaces result nodes the
  // replacements are hidden before the browser has a chance to paint them.
  // This eliminates the expand-then-collapse flicker at its source.
  //
  // WHY *= (contains) instead of ^= (starts-with):
  //   Google stores organic-result hrefs as REDIRECT LINKS in the raw HTML:
  //     href="/url?q=https://example.com/path&sa=U&ved=..."
  //   The actual destination (example.com) only appears inside the query
  //   string.  Using *= "contains ://example.com/" catches BOTH forms:
  //     • Direct links:   https://example.com/path       — contains ://example.com/ ✓
  //     • Redirect links: /url?q=https://example.com/... — contains ://example.com/ ✓
  //
  //   We also add patterns for bare-domain redirects (no trailing slash):
  //     /url?q=https://example.com&sa=U  — contains ://example.com&  ✓
  //     /url?q=https://example.com?      — contains ://example.com?  ✓
  //
  // Progressive enhancement: if the browser lacks :has() (Firefox < 121) the
  // invalid rules are silently ignored; the MutationObserver path covers those.
  //
  // `hasSheet` itself is declared ABOVE the empty-list early return, so
  // __shhUpdateHas can exist on a paused-at-load tab.
  function buildHasRules(curLc: string[], curWild: boolean): void {
    try {
      const isNew = !hasSheet;
      // Build all rules as a single string for batch replacement
      const rules: string[] = [];
      const BATCH_SIZE = 50; // domains per :is() group to avoid selector length limits

      for (let i = 0; i < curLc.length; i += BATCH_SIZE) {
        const batch = curLc.slice(i, i + BATCH_SIZE);
        const hrefs: string[] = [];
        for (const d of batch) {
          hrefs.push(
            `a[href*="://${d}/"]`,
            `a[href*="://${d}?"]`,
            `a[href*="://${d}&"]`,
            `a[href*="://www.${d}/"]`,
            `a[href*="://www.${d}?"]`,
            `a[href*="://www.${d}&"]`
          );
          if (curWild) {
            hrefs.push(
              `a[href*=".${d}/"]`,
              `a[href*=".${d}?"]`,
              `a[href*=".${d}&"]`
            );
          }
        }
        try {
          rules.push(`:is(${SELS}):has(:is(${hrefs.join(",") })){display:none!important}`);
        } catch { /* selector invalid in this browser — skip batch */ }
      }

      // An empty rule set is a legitimate INSTRUCTION ("nothing is blocked
      // any more"), not a no-op. Returning here without clearing left every
      // previously-built `:has(){display:none!important}` rule live for the
      // rest of the page session — so after unblocking the last domain, or
      // after a pause transition, later results were hidden with no
      // placeholder, no Show and no Unblock, and processResults' reveal branch
      // could not rescue them (it keys on the data-shh-preloaded attribute,
      // which a :has()-hidden node never carries).
      //
      // Reached from content/index.ts updateHasRules() with [] on unblock and on
      // the pause transition, and from refreshPrefs()'s suspend branch.
      if (rules.length === 0) {
        // Report the CLEAR, not just the build. A suspended page reads
        // hasRulesBuilt from the last non-empty count otherwise, which is the
        // exact state this field exists to describe.
        preloadDiag.hasRulesBuilt = 0;
        pmark("hasRules:cleared");
        if (!isNew && hasSheet) {
          try {
            hasSheet.replaceSync("");
          } catch {
            try {
              while (hasSheet.cssRules.length > 0) hasSheet.deleteRule(0);
            } catch { /* sheet already empty or unavailable */ }
          }
        }
        return;
      }

      const sheet = isNew ? new CSSStyleSheet() : hasSheet!;
      // Use replaceSync for batch replacement (Firefox 115+)
      try {
        sheet.replaceSync(rules.join("\n"));
      } catch {
        // Fallback: clear and insert individually
        while (sheet.cssRules.length > 0) sheet.deleteRule(0);
        for (const rule of rules) {
          try {
            sheet.insertRule(rule, sheet.cssRules.length);
          } catch { /* skip invalid */ }
        }
      }

      // Re-attach UNCONDITIONALLY when missing, not only on the `isNew` path.
      // Whether Firefox discards document.adoptedStyleSheets across a bfcache
      // freeze is unresolved, and the two possible answers fail differently:
      // if the sheets survive, `hasSheet` is non-null but a page script (or our
      // own __shhDisarmCover-style filter) may have dropped it from the array,
      // in which case replaceSync() repopulates a sheet in nobody's list and the
      // :has() layer is silently dead for the rest of the session. The
      // `includes` check is correct either way.
      if (!document.adoptedStyleSheets.includes(sheet)) {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      if (isNew) hasSheet = sheet;
      preloadDiag.hasRulesBuilt = rules.length;
      preloadDiag.adoptedSheetCount = document.adoptedStyleSheets?.length ?? 0;
      pmark(`hasRules:${rules.length}`);
    } catch { /* :has() or adoptedStyleSheets unavailable */ }
  }

  // Initial build from the preload cache domains.
  buildHasRules(lc, lcWildcard);

  // ── 8. Hide a single result element if its URL is blocked ────────────────
  function tryHide(el: Element): void {
    // Skip anything already handled.
    if (el.getAttribute("data-shh-result") || el.getAttribute("data-shh-preloaded")) return;
    // Skip nodes already confirmed safe (Google cover already lifted).
    if (el.getAttribute("data-shh-ok")) return;

    // *** CONTAINER GUARD ***
    // Skip expensive querySelector for elements that are clearly not containers
    // (result containers are always div, li, or section elements).
    const tag = el.tagName;
    if (tag === "DIV" || tag === "LI" || tag === "SECTION") {
      try {
        if (el.querySelector(SELS)) {
          // We are NOT hiding this node — it wraps results we manage. Leaving it
          // here without a marker is what stranded it under the cover at
          // `opacity:0` (blank gap, full height). See revealCoverCandidate.
          if (isGoogle) revealCoverCandidate(el);
          return;
        }
      } catch { /* ignore selector errors */ }
    }

    // *** SECTION GUARD (Google only) ***
    // A node that wraps SEVERAL results (Discussions block, an appended
    // infinite-scroll page, a video carousel) must never be hidden because one
    // result inside it matched. The old guard only caught nodes containing a
    // class-matched result; this also catches sections on layouts where those
    // class names no longer exist. Failure mode is deliberately fail-open: a
    // section is left visible and the content script resolves it properly at
    // document_idle, rather than hiding results the user did not block.
    if (isGoogle && looksLikeGoogleSection(el)) {
      // Fail-open for HIDING means "leave it alone" — but the cover does not
      // read intent, it reads markers. Without this the node stays at
      // `opacity:0` and the section renders as a correctly-sized blank gap.
      revealCoverCandidate(el);
      return;
    }

    // *** AGGREGATE GUARD (Google only) ***
    // An AI Overview is one block that cites a dozen domains. It carries no
    // per-result markup, so the heading probe above cannot distinguish it from
    // a single organic result — and tryHide() below checks the FIRST link only,
    // so a block list containing any one of those domains would hide the entire
    // answer. Fail open: leave the aggregate alone.
    if (isGoogle && looksLikeGoogleAggregate(el)) {
      // Same reasoning as the section guard above: fail-open for hiding must
      // not leave the node undetermined, or the cover renders it as a gap.
      revealCoverCandidate(el);
      return;
    }

    // Check only the first meaningful external link (most result cards have one).
    //
    // BOTH returns below leave the node UNDETERMINED, which the cover renders as
    // a full-height blank gap. That is the correct state for a hydration shell
    // (stamping it safe here would re-introduce the flicker the cover prevents),
    // but it is only correct while something will re-examine the node. Arm the
    // trailing sweep so a shell that is never populated cannot sit under the
    // cover forever. See scheduleUndeterminedSweep.
    const a = el.querySelector<HTMLAnchorElement>('a[href]:not([href^="#"]):not([href^="javascript"])');
    if (!a) {
      scheduleUndeterminedSweep();
      return;
    }
    const href = a.getAttribute("href") ?? "";
    if (!href || href.startsWith("#") || href.startsWith("javascript")) {
      scheduleUndeterminedSweep();
      return;
    }

    const host = resolveHost(a);
    if (host && hostMatches(host)) {
      // Blocked — hide with display:none and mark.
      hideNode(el);
      el.setAttribute("data-shh-preloaded", "true");
      return;
    }

    // Opaque /goto?url= redirect: the destination is not in the href, so the
    // link told us nothing. Fall back to the display URL the user can read —
    // the same source the content script uses. Without this, document_start
    // blocking is completely inert on Google's current layout.
    if (isGoogle) {
      const display = googleDisplayDomain(el);
      if (display && hostMatches(display)) {
        hideNode(el);
        el.setAttribute("data-shh-preloaded", "true");
        return;
      }
    }

    // Not blocked — reveal if Google and has external link.
    if (isGoogle) {
      el.setAttribute("data-shh-ok", "true");
    }
  }

  // ── 9. Initial scan + MutationObserver + timed rescans ───────────────────
  // Scan anything already in the DOM (rare at document_start, safe to do).
  //
  // These catches used to be BARE, which is how the 2026-09-29 field run could
  // show dozens of console errors while `preloadDiag.errors` stayed empty: the
  // batch-level `recordError` only sees throws that escape, and these absorb
  // everything first. Worse, the absorbed ones are not always harmless — a
  // foreign-namespace element (Google's XUL `<option>`-shaped nodes have been
  // observed) makes `.style.setProperty` throw, and the result is that blocking
  // is silently LOST for that node with nothing in any log. Record them.
  const scanAll = (where: string) => {
    try { allResultCandidates().forEach(tryHide); }
    catch (e) { recordError(where, e); }
  };

  scanAll("scan.initial");

  // Rescan after the DOM is fully parsed — catches results that Google's
  // inline scripts add between document_start and DOMContentLoaded.
  // Use a single requestAnimationFrame loop instead of multiple setTimeouts
  // to catch Google's deferred two-step hydration efficiently.
  let rafScanCount = 0;
  function rafRescan(): void {
    try {
      const nodes = allResultCandidates();
      let hasUnprocessed = false;
      for (const node of nodes) {
        if (!node.getAttribute("data-shh-preloaded") && !node.getAttribute("data-shh-ok")) {
          tryHide(node);
          hasUnprocessed = true;
        }
      }
      rafScanCount++;
      // Stop after 3 scans or when all nodes are processed
      if (hasUnprocessed && rafScanCount < 3) {
        requestAnimationFrame(rafRescan);
      }
    } catch { /* ignore */ }
  }

  document.addEventListener("DOMContentLoaded", () => {
    scanAll("scan.rescan");
    requestAnimationFrame(rafRescan);
    // Safety-net: after 2 s, reveal any Google results that are still covered
    // (e.g. the content script took longer than expected to run processResults).
    // The content script calls __shhRevealGoogle() itself after processResults()
    // so in normal flow this timeout fires with nothing left to reveal.
    setTimeout(() => revealRemainingGoogle("2s-safety-net"), 2000);
  }, { once: true });

  // Rescan after all resources load — catches results added by deferred /
  // async scripts that fire after DOMContentLoaded (common on Google).
  window.addEventListener("load", () => {
    scanAll("scan.rescan");
  }, { once: true });

  // ── 10. bfcache restoration handler ──────────────────────────────────────
  //
  // Content scripts do NOT re-run when a page is restored from the browser's
  // back/forward cache (bfcache).  The DOM is thawed as-is, but adoptedStyleSheets
  // from the preload JS are gone (they lived in the frozen execution context).
  //
  // The static preload.css (registered in manifest.json) is automatically
  // re-applied by the browser on bfcache restoration — that is the PRIMARY
  // protection.  This pageshow handler is the SECONDARY layer:
  //   a) Re-injects adoptedStyleSheets CSS rules (belt-and-suspenders).
  //   b) Clears stale data-shh-ok markers on Google result nodes:
  //      The previous session may have confirmed a node as safe and set
  //      data-shh-ok, but since then (before pressing Back) Google may have
  //      done a client-side navigation that put a blocked URL in that node.
  //      Clearing data-shh-ok and re-running tryHide() corrects this.
  //   c) Re-runs tryHide() on all result nodes to catch any inconsistencies.
  window.addEventListener("pageshow", (event: PageTransitionEvent) => {
    if (!event.persisted) return; // Only act on bfcache restoration.

    // Re-arm the cover ONLY if it is still supposed to be armed.
    //
    // Gating on `isGoogle` alone (the previous behaviour) re-armed it in two
    // states where it must stay down:
    //   - the page was SUSPENDED mid-session: the content observer is stopped,
    //     so anything Google rendered after the 300ms reveal stayed at
    //     opacity:0 / pointer-events:none with no reveal net (A1-2's shape).
    //   - the block list is EMPTY: the preload IIFE returned early, so there is
    //     no observer and no 300ms timer at all — Back left a blank SERP.
    if (isGoogle && coverArmed) {
      try { document.documentElement.setAttribute("data-shh-active", "true"); } catch { /* ignore */ }
      injectCoverCSS();
    }

    // Re-inject the blocking sheet regardless of cover state.
    injectBlockingCSS();
    // Rebuild :has() rules from the LIVE list.
    //
    // `lcWildcard`, not the document_start `wildcard`: __shhUpdateHas rebinds
    // the former, and a stale `true` here re-emits the subdomain href patterns,
    // which hide a node the content script's matcher says is NOT blocked — with
    // no data-shh-preloaded attribute, so nothing can ever reveal it. That is
    // the A2-F2 shape ("hidden with NO placeholder, NO Show, NO Unblock").
    buildHasRules(lc, lcWildcard);

    // Google: clear any stale data-shh-ok markers so every result is
    // re-evaluated from scratch.  This handles the case where Google did a
    // soft navigation (updating result URLs) before the user pressed Back.
    //
    // Class-agnostic since 2026-09-06: the old selector hardcoded
    // div.g / div.tF2Cxc, which the current layout no longer ships — the
    // clear silently matched nothing, and a stale-safe node that had
    // soft-navigated to a blocked domain stayed visible after Back.
    // allResultCandidates() is the same structural+legacy list tryHide()
    // itself uses, so anything that can carry data-shh-ok gets cleared.
    if (isGoogle) {
      try {
        for (const el of allResultCandidates()) {
          if (el.hasAttribute("data-shh-ok")) el.removeAttribute("data-shh-ok");
        }
      } catch { /* ignore */ }
    }

    // Re-evaluate all result nodes.
    scanAll("scan.rescan");

    // Reveal any remaining uncovered Google nodes after re-evaluation.
    // Schedule slightly deferred so Google's own bfcache restore scripts
    // (if any) have a chance to repopulate links before we reveal.
    if (isGoogle) setTimeout(() => revealRemainingGoogle("bfcache-300ms"), 300);  });

  // ── 11. MutationObserver — hide results the instant they appear ────────────
  //
  // Three cases handled for each mutation:
  //
  // Case A — added node IS a result container (Yandex pattern, simple pages):
  //   el.matches(SELS) → tryHide(el)
  //
  // Case B — added node CONTAINS result containers as descendants (bulk insert):
  //   el.querySelectorAll(SELS) → tryHide each descendant
  //
  // Case C — added node is a CHILD of a result container (Google two-step pattern):
  //   Google inserts div.g first (empty), then adds <a href="..."> children.
  //   el.closest(SELS) walks UP the DOM from the added child and re-checks
  //   the parent container — which now has its links populated.
  //   ALSO: if the parent had data-shh-ok (confirmed safe on a previous
  //   search), clear it so the cover CSS re-applies and tryHide() re-evaluates
  //   from scratch (handles Google's client-side navigation node reuse).
  //
  // Case D — href attribute SET on an existing <a> by Google's JS:
  //   Google sometimes calls element.setAttribute('href', '...') on a link
  //   that was already in the DOM.  We watch attribute mutations filtered to
  //   'href' and walk up to re-check the parent container.
  //   Same data-shh-ok clearing applies here.
  const obs = new MutationObserver((mutations) => {
   try {
    // Resolve the results stream ONCE per callback batch, not per added node:
    // resolveGoogleStream() runs up to 6 document-wide querySelectors, and a
    // Google hydration burst of N nodes used to pay that 2N times (Case B +
    // closestResultShell), with cost growing as the DOM grows.
    const stream = isGoogle ? resolveGoogleStream(document) : null;
    for (const m of mutations) {
      // ── Case D: attribute mutation (href set/changed on existing element) ──
      if (m.type === "attributes") {
        const el = m.target as Element;
        // ── Own-echo gate (2026-09-07 crash field report on 1.8.10) ────────
        // See markers.ts: reacting to our own SET echoes of data-shh-ok
        // (remove ok → tryHide → re-stamp → new record → …) is an unbounded
        // microtask loop that starves the event loop and CRASHED the
        // browser on every Google search in 1.8.10. Only ABSENT-marker
        // records (Google stripped ours) are actionable.
        if (isOwnEchoRecord(m.attributeName, el)) {
          continue; // our own SET — nothing to heal
        }
        try {
          // Walk up to the nearest result container and re-check it.
          const parent = el.closest?.(SELS);
          if (parent) {
            // Google: an href attribute changed on an existing link inside a
            // previously-safe node.  The result URL may have changed to a
            // blocked domain (client-side navigation / node reuse).
            // Clear data-shh-ok so the cover CSS re-applies and tryHide()
            // actually re-evaluates the parent instead of returning early.
            if (isGoogle && parent.hasAttribute("data-shh-ok")) {
              parent.removeAttribute("data-shh-ok");
            }
            tryHide(parent);
          }

          // Structural equivalent: an href changed inside a result that the
          // class-based selector can no longer match.
          const shell = stream ? closestResultShell(stream, el) : null;
          if (shell && shell !== parent) {
            if (isGoogle && shell.hasAttribute("data-shh-ok")) {
              shell.removeAttribute("data-shh-ok");
            }
            tryHide(shell);
          }
        } catch { /* ignore */ }
        continue;
      }

      // ── Cases A / B / C: childList mutation ────────────────────────────────
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const el = n as Element;
        try {
          // Case A — the added node itself is a result.
          if (el.matches?.(SELS)) tryHide(el);

          // Case B — the added node contains result descendants.
          el.querySelectorAll(SELS).forEach(tryHide);
          // Case B (structural) — bulk insert that contains the results stream
          // itself. Only runs when el is the stream or an ancestor, so the
          // per-mutation cost stays off the hot path.
          if (stream && (el === stream || el.contains(stream))) {
            tryHideStructuralSubtree(stream, el);
          }

          // Case C — the added node was inserted INSIDE a result container.
          // This is the Google two-step fix: when Google populates a div.g
          // shell with its link children, re-check the parent container.
          const parent = el.closest?.(SELS);
          if (parent) {
            // Google: if the parent was previously confirmed safe (data-shh-ok)
            // but new link content is being added (Google client-side navigation
            // reuses div.g nodes), clear the safe marker so tryHide() actually
            // re-evaluates the node.  Without this, tryHide() returns immediately
            // on the data-shh-ok guard, and a newly-blocked link inside the reused
            // node stays visible until the content script runs.
            // Removing data-shh-ok re-enables the cover CSS (opacity:0)
            // for that node instantly; tryHide() then either re-adds data-shh-ok
            // (safe result) or sets data-shh-preloaded (blocked result), both in
            // the same synchronous microtask — so no paint occurs between the two.
            // Only do this when the added element is (or contains) a link, to
            // avoid unnecessary re-evaluation on non-link mutations.
            if (isGoogle && parent.hasAttribute("data-shh-ok")) {
              const isLink = el.tagName === "A" || !!el.querySelector?.("a[href]");
              if (isLink) parent.removeAttribute("data-shh-ok");
            }
            tryHide(parent);
          }

          // Case C (structural) — the added node landed INSIDE a result that
          // the class-based selector cannot match. closestResultShell() walks
          // up to the nearest direct child of the results stream.
          const shell = stream ? closestResultShell(stream, el) : null;
          if (shell && shell !== parent) {
            if (isGoogle && shell.hasAttribute("data-shh-ok")) {
              const isLink = el.tagName === "A" || !!el.querySelector?.("a[href]");
              if (isLink) shell.removeAttribute("data-shh-ok");
            }
            tryHide(shell);
          }
        } catch { /* ignore */ }
      }
    }
   } catch (e) {
    // Per-BATCH isolation. Before this, a throw anywhere in the callback
    // escaped to the window and aborted the remaining mutations in the batch
    // AND left the observer running into the same failure on the next batch --
    // which is what produced an unactionable error repeating dozens of times
    // per page load. Recorded, not swallowed: it appears in the field report.
    recordError("observer.batch", e);
   }
  });

  obs.observe(document.documentElement, {
    childList: true,
    subtree: true,
    // Watch href attribute mutations so we catch Google setting href via
    // element.setAttribute('href', ...) on existing <a> elements.
    attributes: true,
    // Also watch data-shh-preloaded removals: Google's JS may strip our custom
    // attributes during DOM reconciliation or hydration.  When that happens,
    // the existing Case D code walks up to the nearest result container and
    // re-calls tryHide() — which re-evaluates the node and re-sets the
    // attribute if the domain is still blocked.
    //
    // data-shh-ok is watched for the same reason (A1 finding 2, 2026-09-06
    // review): the reveal stamp that keeps APPENDED pages visible is exactly
    // this attribute. If Google's reconciliation ever strips it from an
    // appended node, the cover CSS (opacity:0) re-applies and — without this
    // watch — no reveal net exists post-insert: the page would go invisible
    // forever. Case D's walk-up + tryHide() re-derives the domain and
    // re-stamps either ok (unblocked) or preloaded+hidden (blocked), the
    // same self-heal loop that already covers data-shh-preloaded.
    attributeFilter: ["href", "data-href", "data-shh-preloaded", "data-shh-ok"],
  });

})();
