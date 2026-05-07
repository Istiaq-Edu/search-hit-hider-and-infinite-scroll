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

  try {
    const raw = localStorage.getItem("_shh_cache");
    if (raw) {
      const c = JSON.parse(raw) as { domains?: string[]; wildcard?: boolean };
      domains = Array.isArray(c.domains) ? c.domains : [];
      wildcard = c.wildcard !== false;
    }
  } catch { /* localStorage unavailable or JSON corrupted */ }

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
  if (domains.length > 0 && isGoogle) {
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
  const GOOGLE_COVER_SEL = [
    "div.g:not(.g .g):not([data-shh-ok]):not([data-shh-preloaded])",
    "div.tF2Cxc:not(.tF2Cxc .tF2Cxc):not([data-shh-ok]):not([data-shh-preloaded])",
  ].join(",");

  function injectCoverCSS(): void {
    if (!isGoogle || domains.length === 0) return;
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
    } catch { /* adoptedStyleSheets unavailable — static CSS is the primary protection */ }
  }

  // Initial injection.
  injectBlockingCSS();
  injectCoverCSS();

  // Nothing blocked in the cache — exit the rest of the logic with zero overhead.
  // (The CSS rules above are already injected and harmless with an empty block list.)
  if (domains.length === 0) return;

  // ── 5. Build a fast in-memory matcher ────────────────────────────────────
  const lc = domains.map(d => d.toLowerCase().replace(/^www\./, ""));

  function hostMatches(host: string): boolean {
    const h = host.toLowerCase().replace(/^www\./, "");
    return lc.some(d => h === d || (wildcard && h.endsWith("." + d)));
  }

  // Resolve the real destination host for a link.
  // Google wraps result URLs in /url?q= redirects — unwrap them.
  function resolveHost(a: HTMLAnchorElement): string {
    const raw = a.getAttribute("href") ?? "";
    if (raw.includes("/url?") || raw.includes("google.com/url")) {
      try {
        const qs = raw.slice(raw.indexOf("?") + 1);
        const q = new URLSearchParams(qs).get("q");
        if (q && q.startsWith("http")) return new URL(q).hostname;
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
    // Startpage
    "div#main div.w-gl > div.result",
    "div#main div.w-bg > div.result",
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
  let hasSheet: CSSStyleSheet | null = null;

  function buildHasRules(curLc: string[], curWild: boolean): void {
    try {
      const isNew = !hasSheet;
      const sheet = isNew ? new CSSStyleSheet() : hasSheet!;
      // Clear any stale rules from a previous call.
      while (sheet.cssRules.length > 0) sheet.deleteRule(0);
      let idx = 0;
      for (const d of curLc) {
        // *= "contains" selectors match the raw href attribute value.
        // "://${d}/" appears in both direct and Google redirect URLs.
        // Also include "://${d}?" and "://${d}&" for bare-domain redirects
        // like /url?q=https://example.com&sa=U (no trailing slash).
        const hrefs = [
          `a[href*="://${d}/"]`,
          `a[href*="://${d}?"]`,
          `a[href*="://${d}&"]`,
          `a[href*="://www.${d}/"]`,
          `a[href*="://www.${d}?"]`,
          `a[href*="://www.${d}&"]`,
        ];
        // Wildcard: ".${d}/" matches any subdomain — also a substring of
        // redirect links like /url?q=https://sub.d/….
        if (curWild) hrefs.push(`a[href*=".${d}/"]`, `a[href*=".${d}?"]`, `a[href*=".${d}&"]`);
        try {
          sheet.insertRule(
            `:is(${SELS}):has(${hrefs.join(",")}){display:none!important}`,
            idx++
          );
        } catch { /* selector invalid in this browser — skip */ }
      }
      // Attach the sheet the first time we have at least one valid rule.
      if (isNew && idx > 0) {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        hasSheet = sheet;
      }
    } catch { /* :has() or adoptedStyleSheets unavailable */ }
  }

  // Initial build from the preload cache domains.
  buildHasRules(lc, wildcard);

  // Expose an updater so the content script (same isolated-world window) can
  // keep the rules in sync when the block list changes at runtime.
  (window as Window & { __shhUpdateHas?: (d: string[], w: boolean) => void })
    .__shhUpdateHas = (newDomains: string[], newWildcard: boolean): void => {
    const newLc = newDomains.map(d => d.toLowerCase().replace(/^www\./, ""));
    buildHasRules(newLc, newWildcard);
  };

  // ── 7. Reveal helper ──────────────────────────────────────────────────────
  // Reveal any Google result containers that are still undetermined (no links
  // found yet — skeleton nodes).  Called from timed rescans and exposed to
  // the content script so it can trigger the final reveal after processResults().
  function revealRemainingGoogle(): void {
    if (!isGoogle) return;
    try {
      document.querySelectorAll(GOOGLE_COVER_SEL).forEach(el => {
        el.setAttribute("data-shh-ok", "true");
      });
    } catch { /* ignore */ }
  }

  // Expose to the content script (same isolated-world window) so it can call
  // this after processResults() — at that point every blocked result has been
  // stamped and any remaining undetermined node is safe to show.
  (window as Window & { __shhRevealGoogle?: () => void })
    .__shhRevealGoogle = revealRemainingGoogle;

  // ── 8. Hide a single result element if its URL is blocked ────────────────
  function tryHide(el: Element): void {
    // Skip anything already handled.
    if (el.getAttribute("data-shh-result") || el.getAttribute("data-shh-preloaded")) return;
    // Skip nodes already confirmed safe (Google cover already lifted).
    if (el.getAttribute("data-shh-ok")) return;

    // *** CONTAINER GUARD ***
    // If this element contains other elements that also match our selectors,
    // it is a parent/container wrapping multiple results — not a result itself.
    // Hiding it would hide every result inside.  Skip it unconditionally.
    try {
      if (el.querySelector(SELS)) return;
    } catch { /* ignore selector errors */ }

    // Collect external links (skip anchors and javascript: URIs).
    let hasExternalLink = false;
    const links = el.querySelectorAll<HTMLAnchorElement>("a[href]");
    for (const a of links) {
      const href = a.getAttribute("href") ?? "";
      if (!href || href.startsWith("#") || href.startsWith("javascript")) continue;
      hasExternalLink = true;
      const host = resolveHost(a);
      if (host && hostMatches(host)) {
        // Blocked — hide with display:none and mark.
        (el as HTMLElement).style.setProperty("display", "none", "important");
        el.setAttribute("data-shh-preloaded", "true");
        return;
      }
    }

    // Not blocked.
    // Google: explicitly reveal by adding data-shh-ok so the cover CSS lifts.
    //   Only do this when we found at least one external link — if there are
    //   no links yet the node is a skeleton and we must wait for links to arrive
    //   (the MutationObserver closest() handler will re-call tryHide then).
    // Other engines: nothing to do — they were never covered.
    if (isGoogle && hasExternalLink) {
      el.setAttribute("data-shh-ok", "true");
    }
  }

  // ── 9. Initial scan + MutationObserver + timed rescans ───────────────────
  // Scan anything already in the DOM (rare at document_start, safe to do).
  try { document.querySelectorAll(SELS).forEach(tryHide); } catch { /* ignore */ }

  // Rescan after the DOM is fully parsed — catches results that Google's
  // inline scripts add between document_start and DOMContentLoaded.
  // Also schedule extra rescans at 100/300/600 ms to catch Google's deferred
  // two-step hydration (shell inserted first, links added shortly after).
  document.addEventListener("DOMContentLoaded", () => {
    try { document.querySelectorAll(SELS).forEach(tryHide); } catch { /* ignore */ }
    // Extra timed rescans: Google hydrates the page in multiple JS tasks
    // after DOMContentLoaded.  Running tryHide a few times in the first
    // 600 ms catches any result that was populated after the initial scan.
    for (const delay of [100, 300, 600]) {
      setTimeout(() => {
        try { document.querySelectorAll(SELS).forEach(tryHide); } catch { /* ignore */ }
      }, delay);
    }
    // Safety-net: after 2 s, reveal any Google results that are still covered
    // (e.g. the content script took longer than expected to run processResults).
    // The content script calls __shhRevealGoogle() itself after processResults()
    // so in normal flow this timeout fires with nothing left to reveal.
    setTimeout(revealRemainingGoogle, 2000);
  }, { once: true });

  // Rescan after all resources load — catches results added by deferred /
  // async scripts that fire after DOMContentLoaded (common on Google).
  window.addEventListener("load", () => {
    try { document.querySelectorAll(SELS).forEach(tryHide); } catch { /* ignore */ }
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

    // Re-arm html[data-shh-active] (survives bfcache, but re-set defensively).
    if (isGoogle) {
      try { document.documentElement.setAttribute("data-shh-active", "true"); } catch { /* ignore */ }
    }

    // Re-inject adoptedStyleSheets (they do NOT survive bfcache).
    injectBlockingCSS();
    injectCoverCSS();
    // Rebuild :has() rules — these live in adoptedStyleSheets which are
    // discarded when the page is frozen into bfcache.  Without them, the
    // only CSS-level protection for blocked results is data-shh-preloaded +
    // the static preload.css Rule 1.  If Google's JS strips that attribute
    // during its own bfcache restoration logic, there is no fallback.
    // Rebuilding here ensures the :has() rules are the primary protection.
    buildHasRules(lc, wildcard);

    // Google: clear any stale data-shh-ok markers so every result is
    // re-evaluated from scratch.  This handles the case where Google did a
    // soft navigation (updating result URLs) before the user pressed Back.
    if (isGoogle) {
      try {
        document.querySelectorAll(
          "div.g:not(.g .g)[data-shh-ok],div.tF2Cxc:not(.tF2Cxc .tF2Cxc)[data-shh-ok]"
        ).forEach(el => {
          el.removeAttribute("data-shh-ok");
        });
      } catch { /* ignore */ }
    }

    // Re-evaluate all result nodes.
    try { document.querySelectorAll(SELS).forEach(tryHide); } catch { /* ignore */ }

    // Reveal any remaining uncovered Google nodes after re-evaluation.
    // Schedule slightly deferred so Google's own bfcache restore scripts
    // (if any) have a chance to repopulate links before we reveal.
    if (isGoogle) setTimeout(revealRemainingGoogle, 300);
  });

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
    for (const m of mutations) {
      // ── Case D: attribute mutation (href set/changed on existing element) ──
      if (m.type === "attributes") {
        const el = m.target as Element;
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
        } catch { /* ignore */ }
      }
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
    attributeFilter: ["href", "data-href", "data-shh-preloaded"],
  });

})();
