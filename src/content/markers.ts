/**
 * Shared marker-attribute helpers used by BOTH the preload observer
 * (document_start, isolated world) and the content script.
 *
 * Extracted 2026-09-07 from preload.ts Case D after the 1.8.10 crash field
 * report: the observer watches data-shh-ok / data-shh-preloaded to self-heal
 * Google's attribute strips — but reacting to our OWN setAttribute echoes
 * (remove ok → tryHide → re-stamp ok → new record → …) is an unbounded
 * microtask loop that starves the event loop and crashes the tab. The
 * predicate below is the discriminator; it lives in its own module so tests
 * bind to SHIPPED code instead of a mirror (A5-R1 lesson).
 */

/**
 * True when an attribute-mutation record for `el` is our OWN SET echoing
 * back — i.e. the watched marker attribute is still PRESENT on the element.
 *
 * The actionable case is the opposite: Google's DOM reconciliation STRIPS
 * our markers, which leaves the attribute ABSENT. Only absent-marker
 * records should trigger the self-heal walk-up; present-marker records are
 * self-echoes and must be ignored.
 *
 * data-shh-preloaded happened to be loop-safe without this predicate (its
 * writes are idempotent — tryHide early-returns on an already-stamped
 * node); data-shh-ok is NOT (Case D removes it before re-evaluating, so
 * every re-stamp armed the next removal).
 */
export function isOwnEchoRecord(
  attributeName: string | null,
  el: Element
): boolean {
  if (!attributeName) return false;
  if (
    attributeName !== "data-shh-ok" &&
    attributeName !== "data-shh-preloaded"
  ) {
    return false;
  }
  return el.hasAttribute(attributeName);
}

// ============================================================
// The Google anti-flicker cover
// ============================================================
// preload.css carries the rule that makes an un-evaluated Google result
// invisible, and preload.ts re-queries the same set to stamp `data-shh-ok` on
// the ones it has cleared. Those two MUST agree exactly, or a node can be
// excluded from the reveal while still matching the cover — which is the
// blank-result bug this selector's single definition prevents.
//
// A third consumer appeared in 2026-09: `showOnce` has to exempt a revealed
// result's INNER div.g, because it can no longer rely on the inline
// `opacity:1` it sets on the outer node. `opacity` does not cascade as an
// override — a descendant with its own `opacity:0 !important` stays invisible
// no matter what the parent says. The only way to lift the cover on a
// descendant is the marker the cover already respects: `data-shh-ok`.
//
// Lives here because preload.ts and blocking/hider.ts are bundled as SEPARATE
// entry points but share this isolated world, and a third copy of this string
// is how the two drifted into disagreeing in the first place.
export const GOOGLE_COVER_SELECTOR = [
  // Classic div.g (pre-2025) and div.tF2Cxc (2025 per-result card).
  // The `:not(.g .g)` / `:not(.tF2Cxc .tF2Cxc)` guards target only the OUTERMOST
  // node of each class, so a nested result is never covered twice.
  "div.g:not(.g .g):not([data-shh-ok]):not([data-shh-preloaded])",
  "div.tF2Cxc:not(.tF2Cxc .tF2Cxc):not([data-shh-ok]):not([data-shh-preloaded])",
].join(",");

// ============================================================
// "Show once" — the ONE state every hide layer must respect
// ============================================================
// Field report 2026-11-05: on a single SERP, clicking Show revealed SOME
// blocked results and left others blank. The differing factor is DOM SHAPE, not
// timing: when the preload hid an INNER div.g/div.tF2Cxc but the adapter
// stamped the OUTER wrapper, three independent layers still hide that inner
// node after showOnce() has done its work:
//
//   1. the marker-free `:has()` adopted sheet (display:none !important);
//   2. the preload MutationObserver's Case D self-heal, which reads showOnce's
//      deliberate `data-shh-preloaded` REMOVAL as "the page stripped our
//      marker" and re-hides the node in the post-click microtask;
//   3. the preload.css `[data-shh-preloaded]` rule, re-armed by (2).
//
// All three are lifted by ONE authoritative marker on the result the user
// explicitly asked to see. Lives here because preload.ts and blocking/hider.ts
// are separate bundles that must agree on the string (the cover selector's
// three-copy drift is documented above).
export const ATTR_SHH_MODE = "data-shh-mode";
export const SHOWN_ONCE = "shown-once";
export const SHOWN_ONCE_SELECTOR = `[${ATTR_SHH_MODE}="${SHOWN_ONCE}"]`;
/**
 * The visual class showOnce() puts on the revealed result. The preload's
 * self-heal keys on it (mode stripped + class present ⇒ re-stamp), so the two
 * bundles MUST share one string — a rename in hider.ts alone silently kills
 * the heal with every mirror-free test still green.
 */
export const SHOWN_ONCE_CLASS = "shh-shown-result";

/**
 * Append to a hiding rule's SUBJECT. Exempts the revealed result itself AND
 * everything inside it — `display` does not inherit, so an inner node with its
 * own `display:none !important` stays hidden no matter what the parent sets.
 *
 * Only ever used on a `:has()` rule that ALREADY requires Firefox 121+; complex
 * selectors in `:not()` ship in Firefox 84, so this adds no new version floor.
 * Verified against Firefox Developer Edition via CSS.supports().
 */
export const SHOWN_ONCE_EXEMPTION =
  `:not(${SHOWN_ONCE_SELECTOR}):not(${SHOWN_ONCE_SELECTOR} *)`;

// ============================================================
// Per-engine subjects for the :has() hiding layer
// ============================================================
// `:has()` rules are re-evaluated by the style engine whenever the DOM mutates
// anywhere they could reach, so the SUBJECT list decides how much invalidation
// work every mutation costs. The preload's JS-side SELS covers every engine's
// markup and stays engine-agnostic — but a Yandex page can never match a Bing
// subject, and carrying all ~30 subjects on every site makes the style engine
// pay for selectors that can never match (measured in Firefox Developer
// Edition on a churn-heavy Yandex-shaped page: frame p95 2× the no-extension
// baseline, scaling with block-list size; the JS selector work itself was
// ~3 ms per 10 s — the CSS breadth is the cost).
//
// The `:has()` layer only ever needs the subjects of the engine THIS PAGE is
// on. Hosts this map does not know (SearXNG instances, Ecosia, Qwant — engines
// with selectors in SELS but no adapter) keep the full list: unchanged
// behaviour where nothing is scoped.
//
// KEPT IN SYNC WITH `SELS` in preload.ts and the adapters' own selectors by
// tests/content/has-subjects-sync.test.ts, which runs each SHIPPED adapter's
// getResultNodes against these selectors.
export const CSS_SUBJECTS_BY_ENGINE: Record<string, string> = {
  google:
    "div.g:not(.g .g)," +
    "div.tF2Cxc:not(.tF2Cxc .tF2Cxc)",
  duckduckgo:
    "ol.react-results--main > li[data-layout='organic']," +
    "div#links div.results_links_deep div.links_main," +
    "div#links div.nrn-react-div," +
    "div#links > div.result",
  yandex:
    "li.serp-item," +
    "div.serp-item," +
    "div.Organic," +
    "div.organic",
  bing: "#b_content ol#b_results > li.b_algo",
  baidu:
    "#content_left > div.result.c-container," +
    "#content_left > div.result-op.c-container",
  brave:
    'div.snippet[data-type="web"],' +
    'div.snippet[data-type="news"],' +
    'div.snippet[data-type="videos"]',
  startpage:
    "#main div.w-gl > div.result," +
    "#main div.w-bg > div.result," +
    "div.w-gl > div.result," +
    "div.w-gl__result," +
    "section#main div.css-ndwlbg > div.article," +
    "[data-view='results'] li.search-result",
};

/**
 * The engine a hostname resolves to, by the SAME host rules the adapters use.
 * Returns null for anything the adapters would also reject — in which case the
 * caller must fall back to the full selector list.
 */
export function engineIdForHost(hostname: string): string | null {
  const h = hostname.toLowerCase();
  if (
    h === "www.google.com" ||
    h.startsWith("www.google.") ||
    h.startsWith("google.co") ||
    h === "news.google.com" ||
    h.startsWith("news.google.") ||
    h === "encrypted.google.com"
  ) return "google";
  if (
    h === "duckduckgo.com" ||
    h === "noai.duckduckgo.com" ||
    h === "start.duckduckgo.com" ||
    h === "safe.duckduckgo.com"
  ) return "duckduckgo";
  if (
    h === "ya.ru" ||
    h === "yandex.com" ||
    h === "www.yandex.com" ||
    h.endsWith(".yandex.com") ||
    h.endsWith(".ya.ru") ||
    /^yandex\.(ru|by|kz|ua|tr|eu|fr|de|lt|lv|ee|md|tj|uz|tm|kg|az|ge|am)$/.test(h)
  ) return "yandex";
  if (h === "www.bing.com") return "bing";
  if (h === "www.baidu.com") return "baidu";
  if (
    h === "search.brave.com" ||
    h === "search.brave4u7jddbv7cyvyptnt5corw0tamlzo53lwd5s7vm223nr3ro2ryd.onion"
  ) return "brave";
  if (
    h !== "us-browse.startpage.com" &&
    (h === "startpage.com" || h === "www.startpage.com" || h.endsWith(".startpage.com"))
  ) return "startpage";
  return null;
}

/**
 * The `:has()` subject selector for this host, or null when the host is not a
 * recognised engine and the caller must keep the full list.
 */
export function hasSubjectsFor(hostname: string): string | null {
  const id = engineIdForHost(hostname);
  return id ? CSS_SUBJECTS_BY_ENGINE[id] ?? null : null;
}

/** The same cover, WITHOUT the safety markers — i.e. "what could be covered". */
export const GOOGLE_COVER_CANDIDATE_SELECTOR = [
  "div.g:not(.g .g)",
  "div.tF2Cxc:not(.tF2Cxc .tF2Cxc)",
].join(",");

// ============================================================
// The "we decided not to hide this, so it must not stay covered" step
// ============================================================
/**
 * Lift the cover on `el` — stamp the marker the cover respects — when `el` is a
 * node the cover could be holding at `opacity:0 !important`.
 *
 * WHY THIS EXISTS (field report 2026-10-10: "results are not visible on the
 * screen but there is space for that result")
 * ---------------------------------------------------------------------------
 * `opacity:0` preserves layout, so a node left under the cover occupies its
 * full height and paints nothing — the symptom is a blank gap, not a collapse.
 *
 * The cover matches EVERY `div.g` / `div.tF2Cxc` in the document, but only two
 * things ever lift it:
 *   • `tryHide()` — when it positively evaluates the node and decides it is not
 *     blocked (preload.ts), or
 *   • a reveal pass (`revealRemainingGoogle` / `__shhRevealGoogle`) — which runs
 *     at discrete moments only (2 s after DOMContentLoaded, after
 *     `processResults`, on bfcache restore, after an infinite-scroll append).
 *
 * `tryHide()` also has three deliberate FAIL-OPEN guards — container, section,
 * aggregate — which `return` WITHOUT hiding the node because hiding it would
 * take several unrelated results down with it. That was correct for hiding and
 * wrong for the cover: the node was left in the "undetermined" state, which the
 * cover renders as invisible.
 *
 * A node that arrives AFTER the last reveal pass therefore stayed at
 * `opacity:0` forever, and nothing in the extension could ever lift it — the
 * adapter refuses to offer it (`walkResults`' own section/aggregate guards),
 * the content script's `processResults` never sees it, and the preload's
 * observer had already declined to touch it. Reproduced against the shipped
 * bundle: a section-shaped card appended after the reveal windows reported
 * `visible: false`, `hiddenAt: self`, with no `data-shh-*` marker of any kind.
 *
 * This is the missing step: every node the cover can match ends up POSITIVELY
 * determined — `data-shh-preloaded` (hidden) or `data-shh-ok` (shown) — so no
 * node can be left in the state the cover renders as a blank gap.
 *
 * SAFETY: stamping `data-shh-ok` on a container is not a way to reveal a
 * blocked result. A blocked node is hidden by its OWN `display:none !important`
 * plus `data-shh-preloaded` (which the cover selector already excludes), so it
 * stays hidden however its ancestors are marked.
 *
 * @returns true when the marker was stamped by THIS call.
 */
export function revealCoverCandidate(el: Element): boolean {
  let isCandidate = false;
  try {
    isCandidate = el.matches(GOOGLE_COVER_CANDIDATE_SELECTOR);
  } catch {
    return false; // unreadable / foreign-namespace node — nothing to lift
  }
  if (!isCandidate) return false;
  return stampCoverOk(el);
}

/**
 * Stamp the marker the cover respects, unless the node is ALREADY determined in
 * either direction.
 *
 * Split out of `revealCoverCandidate` so a caller that obtained its nodes from
 * `querySelectorAll(GOOGLE_COVER_CANDIDATE_SELECTOR)` does not have to re-run
 * the same selector through `matches()` — the query is already the gate.
 */
function stampCoverOk(el: Element): boolean {
  if (
    el.hasAttribute("data-shh-ok") ||
    el.hasAttribute("data-shh-preloaded") ||
    el.hasAttribute("data-shh-result")
  ) {
    return false;
  }
  el.setAttribute("data-shh-ok", "true");
  return true;
}

/**
 * Lift the cover on `root` AND on every cover-matching descendant.
 *
 * WHY THE SUBTREE WALK IS REQUIRED (and why it is not the same as the guards'
 * single-node stamp):
 *   `opacity` does not cascade as an override. A node at `opacity:1` cannot
 *   rescue a child that carries its own `opacity:0 !important`, so stamping the
 *   outer node alone leaves an inner cover-matching card invisible. The preload
 *   and the adapter routinely pick different DOM levels for the same result
 *   (`showOnce` documents the same trap for the same reason).
 *
 * WHERE IT IS SAFE TO USE THIS, AND WHERE IT IS NOT:
 *   - SAFE: `restoreResult` (the user explicitly unblocked this result, so
 *     nothing under it may stay hidden) and the infinite-scroll append net
 *     (its page subtree has already been through `processResults`, so blocked
 *     cards inside it carry `data-shh-result` and are refused below).
 *   - NOT SAFE in `tryHide`'s CONTAINER guard. There the observer is walking
 *     `querySelectorAll(SELS)` in document order, so the container is evaluated
 *     BEFORE its own descendants — sweeping the subtree would stamp a blocked
 *     child safe before `tryHide` ever judged it, i.e. it would REVEAL a
 *     blocked result. That call site must keep the single-node form.
 *
 * @returns how many nodes this call stamped.
 */
export function revealCoverSubtree(root: Element): number {
  let stamped = revealCoverCandidate(root) ? 1 : 0;
  let candidates: Element[];
  try {
    candidates = Array.from(
      root.querySelectorAll(GOOGLE_COVER_CANDIDATE_SELECTOR)
    );
  } catch {
    return stamped; // unreadable subtree — the root stamp still stands
  }
  for (const el of candidates) {
    if (stampCoverOk(el)) stamped++;
  }
  return stamped;
}
