import type { BlockEntry, Prefs } from "../shared/types";
import { detectEngine } from "./engines/registry";
import { DomainMatcher } from "./blocking/matcher";
import { hideResult, showOnce, rehideResult, restoreByDomain, getHiddenNodes, convertHiddenToPermaban, restoreResult } from "./blocking/hider";
import { ResultObserver } from "./blocking/observer";
import { injectBaseStyles } from "./ui/styles";
import { injectBlockButton } from "./ui/block-button";
import { showBlockDialog } from "./ui/block-dialog";
import { showToast } from "./ui/toast";
import { getList, getPrefs, addEntry, removeEntry, updateEntry, undoLast } from "./messaging";
import { InfiniteScrollManager } from "./infinite-scroll/manager";

// ============================================================
// Content script entry point
// ============================================================

let entries: BlockEntry[] = [];
let prefs: Prefs | null = null;
let matcher: DomainMatcher | null = null;
let observer: ResultObserver | null = null;
let infiniteScrollManager: InfiniteScrollManager | null = null;

const currentUrl = new URL(location.href);
const engine = detectEngine(currentUrl);

if (!engine) {
  // Page not recognized — do nothing
} else {
  void init();
}

async function init(): Promise<void> {
  if (!engine) return;

  // ── Class-based CSS protection (adoptedStyleSheets) ───────────────────────
  // Inject display:none rules for the shh-hidden and shh-pban classes via a
  // Constructable StyleSheet (not a DOM element).  This means even if Google's
  // deferred scripts reset inline `style` attributes on result nodes after
  // processResults() runs, the class + CSS rule still keeps them hidden.
  // Called before earlyHideFromCache() so the protection is in place before
  // any DOM changes are made.
  injectHidingStyles();

  // ── Synchronous early hide (before any async round-trip) ──────────────────
  // The preload (document_start) hides results via localStorage cache + CSS
  // rule.  However, Google's JS framework can replace result DOM nodes between
  // document_start and document_idle — new nodes have no preload marker and are
  // therefore visible.  This function re-reads the same localStorage cache and
  // hides any still-visible blocked results SYNCHRONOUSLY, before the storage
  // await below, closing that timing gap without any async delay.
  earlyHideFromCache();

  try {
    [entries, prefs] = await Promise.all([getList(), getPrefs()]);
  } catch {
    // Extension context may not be ready yet — retry once
    await sleep(500);
    try {
      [entries, prefs] = await Promise.all([getList(), getPrefs()]);
    } catch {
      return;
    }
  }

  if (!prefs) return;

  // Check if this engine is disabled or extension is paused
  if (prefs.pausedGlobally) return;
  if (prefs.pausedEngines.includes(engine.id)) return;
  if (!prefs.engineToggles[engine.id]) return;

  // Inject styles
  injectBaseStyles();

  // Apply hover-mode class on the document root
  if (prefs.showOnHover) {
    document.documentElement.classList.add("shh-hover-mode");
  }

  // Initialize engine adapter
  engine.onInit?.(document);

  // Build matcher
  matcher = new DomainMatcher(entries, prefs.subdomainWildcard);

  // Brave Search is a Svelte SPA — results render slightly after document idle
  if (engine.id === "brave") {
    await sleep(400);
  }

  // Write the cache so the preload can use it on the NEXT page load.
  updateCache();
  // Sync :has() rules with the confirmed list (removes any stale preload rules
  // for domains that have since been unblocked, adds any new ones).
  updateHasRules();

  // ── Infinite scroll ─────────────────────────────────────────────────
  // Must be initialized BEFORE processResults() so getResultNodes() still
  // returns unstamped nodes (processResults stamps with data-shh-result).
  // The sentinel is placed after the container, which is fine since results
  // are already in the DOM at this point.
  if (prefs.infiniteScroll && (engine.getNextPageUrl || engine.triggerNextPage)) {
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
          fetchDelay: 1500,
          debugMode: prefs.debugMode,
        }
      );
      infiniteScrollManager.init();
    }
  }

  // Process existing results.
  processResults(engine.getResultNodes(document));

  // Google-specific: the preload keeps ALL div.g containers visibility:hidden
  // until they are confirmed safe (data-shh-ok) or blocked (data-shh-preloaded).
  // Now that processResults() has stamped every blocked result, any remaining
  // uncovered container is safe — reveal them all.
  (window as Window & { __shhRevealGoogle?: () => void }).__shhRevealGoogle?.();

  // Watch for dynamic results (infinite scroll, AJAX pagination, etc.)
  if (prefs.mutationObserver) {
    const IGNORE = [".shh-placeholder", ".shh-dialog", ".shh-toast", "[data-shh-btn]"];
    observer = new ResultObserver((newNodes) => {
      const resultNodes: Element[] = [];
      for (const node of newNodes) {
        const engineNodes = engine.getResultNodes(node as unknown as Document);
        if (engineNodes.length > 0) {
          resultNodes.push(...engineNodes);
        } else {
          // The mutated node itself might be a result
          const url = engine.getResultUrl(node);
          if (url) resultNodes.push(node);
        }
      }
      processResults(resultNodes);
    }, IGNORE);

    observer.start(document.body, engine.observerOptions?.());
  }

  // Listen for messages from popup (prefs/list updates)
  browser.runtime.onMessage.addListener((msg: unknown) => {
    if (msg && typeof msg === "object" && "type" in msg) {
      const m = msg as { type: string };
      if (m.type === "PREFS_UPDATED") void refreshPrefs();
      if (m.type === "LIST_UPDATED")  void refreshEntries();
    }
  });
}

function processResults(nodes: Element[]): void {
  if (!matcher || !prefs || !engine) return;

  for (const node of nodes) {
    // Skip nodes we have already stamped
    if (node.getAttribute("data-shh-result")) continue;

    const url = engine.getResultUrl(node);

    // Skip nodes where no external URL can be found — the button would
    // do nothing when clicked, so injecting it would confuse the user.
    if (!url) continue;

    const matchResult = matcher.match(url);

    if (matchResult.matched) {
      const domain = matchResult.domain;

      const doUnblock = async (d: string) => {
        // 1. Restore result immediately — eliminates flicker.
        //    Collect which nodes were actually restored so we can handle
        //    them separately below (edge-case: a parent/wildcard domain
        //    like "wikipedia.org" may still be in the block list after
        //    removing a subdomain entry like "en.wikipedia.org"; without
        //    this guard the re-run of processResults would immediately
        //    re-hide the just-released nodes under the parent domain).
        const releasedNodes = restoreByDomain(d);
        const releasedSet = new Set(releasedNodes);

        // 2. Drop from in-memory entries BEFORE refreshMatcher so the new
        //    matcher no longer has this domain blocked.
        entries = entries.filter((e) => e.domain !== d);
        refreshMatcher();
        updateCache();
        // Remove the :has() rule for this domain so restored nodes don't
        // stay hidden by the persistent CSS rule after restoreByDomain().
        updateHasRules();

        // 3. Re-process only nodes that were NOT just explicitly released
        //    by the user. This prevents a parent/wildcard entry from
        //    immediately re-hiding the unblocked result.
        const allNodes = engine!.getResultNodes(document);
        processResults(allNodes.filter((n) => !releasedSet.has(n)));

        // 4. For the released nodes: inject block buttons so the user can
        //    re-block if they want, but do NOT pass them through the matcher
        //    (they were deliberately shown by an explicit user action).
        for (const node of releasedNodes) {
          const nodeUrl = engine!.getResultUrl(node);
          if (nodeUrl) injectButtonForResult(node, nodeUrl);
        }

        // 5. Persist to storage (UI is already consistent).
        await removeEntry(d);
        showToast(`Unblocked ${d}`, async () => {
          const restored = await undoLast();
          if (restored) {
            entries = [...entries, restored];
            refreshMatcher();
            updateCache();
            processResults(engine!.getResultNodes(document));
            // Re-add the :has() rule for the re-blocked domain.
            updateHasRules();
          }
        });
      };

      // Mutual closures mirror the userscript's reshow ↔ rehide flow:
      //   doShowOnce — makes the result visible, inserts a notice bar with
      //                "Hide Again" and "Unblock" buttons at the top.
      //   doRehide   — removes the notice bar, re-hides, re-inserts placeholder.
      const doShowOnce = (n: Element) => {
        showOnce(n, domain, () => doRehide(n), doUnblock);
      };

      const doPermaban = async (d: string, n: Element) => {
        entries = entries.map((entry) =>
          entry.domain === d ? { ...entry, mode: "pban", enabled: true } : entry
        );
        refreshMatcher();
        updateCache();
        updateHasRules();
        convertHiddenToPermaban(n);
        await updateEntry(d, { mode: "pban", enabled: true });
        showToast(`Perma-banned ${d}`, async () => {
          entries = entries.map((entry) =>
            entry.domain === d ? { ...entry, mode: "block", enabled: true } : entry
          );
          refreshMatcher();
          updateCache();
          updateHasRules();
          restoreResult(n);
          hideResult(
            n,
            { matched: true, domain: d, mode: "block" },
            url,
            prefs!.showNotices,
            doShowOnce,
            doUnblock,
            doPermaban
          );
          await updateEntry(d, { mode: "block", enabled: true });
        });
      };

      const doRehide = (n: Element) => {
        rehideResult(n, matchResult, url, prefs!.showNotices, doShowOnce, doUnblock, doPermaban);
      };

      // Always call hideResult — regardless of showNotices or mode.
      // hideResult handles both pban (no placeholder) and block (with or
      // without placeholder based on showNotices). The previous guard
      // `if (prefs.showNotices || mode === "pban")` was wrong: it caused
      // blocked results to never receive data-shh-result when showNotices
      // was false, so they were only hidden by the preload's localStorage
      // cache and would flash visible if that cache was stale.
      hideResult(node, matchResult, url, prefs.showNotices, doShowOnce, doUnblock, doPermaban);
    } else {
      // If the preload hid this node based on a stale cache (domain was since
      // unblocked), clear ALL hiding layers before injecting the button.
      // Must remove: inline style, data-shh-preloaded attribute, AND the
      // shh-hidden class (earlyHideFromCache now adds it as a second layer).
      if (node.getAttribute("data-shh-preloaded")) {
        (node as HTMLElement).style.removeProperty("display");
        node.removeAttribute("data-shh-preloaded");
        node.classList.remove("shh-hidden");
      }
      injectButtonForResult(node, url);
    }
  }
}

function injectButtonForResult(node: Element, url: string): void {
  if (!prefs || !engine) return;

  const target = engine.getButtonTarget(node);
  if (!target) return;

  // Append inside headings (h2/h3/h4) rather than inserting after cite.
  // The cite row on Google is a flex container that also holds the three-dot
  // feedback button — adding our button there as a flex item makes it overlap.
  // Appending inside the heading keeps it in the title area and outside the
  // cite-row flex flow entirely. This mirrors the Jefferson Scher userscript
  // behaviour (lines 1480-1487).
  const tagName = target.tagName.toLowerCase();
  const useAppend = tagName === "h3" || tagName === "h2" || tagName === "h4";

  if (useAppend) {
    // Let the button overflow the heading without clipping
    (target as HTMLElement).style.overflow = "visible";
  }

  const btn = injectBlockButton(
    node,
    target,
    useAppend ? "append" : "after",
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
  // Brave: button is inserted after a.l1 (title anchor). Brave's result-content
  //   is a flex column, so the button naturally flows below the title. We wrap
  //   the title + button in a row container so they sit side-by-side.
  if (btn?.parentElement) {
    if (engine.id === "google") {
      const pStyle = window.getComputedStyle(btn.parentElement);
      if (pStyle.display === "flex" || pStyle.display === "inline-flex") {
        (btn.parentElement as HTMLElement).style.position = "relative";
        btn.style.cssText =
          btn.style.cssText + ";position:absolute;right:0;top:4.25em;margin:0;";
      }
    } else if (engine.id === "brave") {
      // Brave's a.l1 is inside a flex column. Create a wrapper row around
      // the title anchor and button so they sit side-by-side on the same line.
      const titleAnchor = btn.previousElementSibling;
      if (titleAnchor) {
        const wrapper = document.createElement("span");
        wrapper.style.cssText = "display:inline-flex;align-items:center;gap:8px;";
        titleAnchor.replaceWith(wrapper);
        wrapper.appendChild(titleAnchor);
        wrapper.appendChild(btn);
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
    processResults(engine!.getResultNodes(document));
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
  prefs = await getPrefs();

  if (prefs.showOnHover) {
    document.documentElement.classList.add("shh-hover-mode");
  } else {
    document.documentElement.classList.remove("shh-hover-mode");
  }

  // Toggle infinite scroll without requiring page reload
  if (prevInfiniteScroll !== prefs.infiniteScroll) {
    if (!prefs.infiniteScroll && infiniteScrollManager) {
      infiniteScrollManager.destroy();
      infiniteScrollManager = null;
    } else if (prefs.infiniteScroll && !infiniteScrollManager && (engine?.getNextPageUrl || engine?.triggerNextPage)) {
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
            fetchDelay: 1500,
            debugMode: prefs.debugMode,
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

  if (!matcher || !engine) return;

  // Import once before any DOM changes to avoid yield points mid-loop.
  const { restoreResult } = await import("./blocking/hider");

  // Categorise currently hidden nodes without touching the DOM yet.
  const stillBlocked: Element[] = [];
  const unblocked: Element[] = [];
  for (const node of getHiddenNodes()) {
    if (!(node instanceof Element)) continue;
    const url = node.getAttribute("data-shh-url") ?? "";
    const hit = url ? matcher.match(url) : { matched: false };
    if (hit.matched) {
      stillBlocked.push(node);
    } else {
      unblocked.push(node);
    }
  }

  // Domains that were removed from the list: restore immediately (show them).
  for (const node of unblocked) {
    restoreResult(node);
  }

  // Domains still blocked: clear the processed stamp and remove the old
  // placeholder so processResults() can re-stamp and rebuild the placeholder
  // (handles mode changes: block → pban etc.) WITHOUT ever removing the
  // display:none — no visible flash at any point.
  for (const node of stillBlocked) {
    const prev = node.previousElementSibling;
    if (prev?.getAttribute("data-shh-placeholder")) prev.remove();
    node.removeAttribute("data-shh-result");
    node.removeAttribute("data-shh-mode");
    // display:none is intentionally left in place — no repaint until
    // processResults() stamps the node again below.
  }

  // Re-process: re-hides the cleared nodes and catches any new nodes.
  processResults(engine.getResultNodes(document));
  // Keep :has() rules in sync with the updated list.
  updateHasRules();
}

function refreshMatcher(): void {
  if (prefs) {
    matcher = new DomainMatcher(entries, prefs.subdomainWildcard);
  }
}

// ── updateHasRules ─────────────────────────────────────────────────────────
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

// ── injectHidingStyles ────────────────────────────────────────────────────
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

// ── earlyHideFromCache ─────────────────────────────────────────────────────
// Reads the same localStorage cache the preload uses and immediately hides
// any result nodes that are still visible (no data-shh-preloaded marker)
// because Google's JS replaced them between document_start and document_idle.
// Called SYNCHRONOUSLY at the start of init(), before the first await, so
// there is no rendering window between this call and the actual DOM changes.
function earlyHideFromCache(): void {
  if (!engine) return;
  try {
    const raw = localStorage.getItem("_shh_cache");
    if (!raw) return;
    const cache = JSON.parse(raw) as { domains?: string[]; wildcard?: boolean };
    const domains = Array.isArray(cache.domains) ? cache.domains : [];
    const wildcard = cache.wildcard !== false;
    if (domains.length === 0) return;

    const lc = domains.map((d) => d.toLowerCase().replace(/^www\./, ""));

    for (const node of engine.getResultNodes(document)) {
      // Skip nodes the preload already marked or the content script stamped.
      if (node.getAttribute("data-shh-preloaded") || node.getAttribute("data-shh-result")) continue;

      const url = engine.getResultUrl(node);
      if (!url) continue;
      try {
        const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
        const blocked = lc.some(
          (d) => host === d || (wildcard && host.endsWith("." + d))
        );
        if (blocked) {
          // Three-layer protection so the result stays hidden even if Google's
          // JS resets inline styles or attributes before processResults() runs:
          //   1. Attribute  → matched by [data-shh-preloaded]{display:none!important}
          //      (adoptedStyleSheet from preload — never a DOM node, page JS can't
          //      remove it).
          //   2. Class      → matched by .shh-hidden{display:none!important}
          //      (adoptedStyleSheet from injectHidingStyles(), already active because
          //      injectHidingStyles() is called before earlyHideFromCache()).
          //      Survives Google resetting the inline `style` attribute.
          //   3. Inline style → last resort if both sheets are somehow bypassed.
          node.setAttribute("data-shh-preloaded", "true");
          node.classList.add("shh-hidden");
          (node as HTMLElement).style.setProperty("display", "none", "important");
        }
      } catch { /* skip invalid URL */ }
    }
  } catch { /* localStorage unavailable or JSON corrupt — safe to ignore */ }
}

// ── Infinite scroll container ──────────────────────────────────────────────
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
function updateCache(): void {
  if (!prefs) return;
  try {
    localStorage.setItem("_shh_cache", JSON.stringify({
      domains: entries.filter((e) => e.enabled).map((e) => e.domain),
      wildcard: prefs.subdomainWildcard,
    }));
  } catch { /* localStorage may be unavailable in some browser configs */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
