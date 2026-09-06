# Deep review — Google fixes v1.8.9 (2026-09-06/07)

Protocol: addyosmani five-axis (sourced per code-review-methodology skill),
5 parallel fresh-eyes reviewers (A1 correctness/races, A2 cross-engine,
A3 performance, A4 security/privacy, A5 tests), controller pre-pass with
seeded suspects, all findings absorbed and dispositioned in one batch.
Full reviewer reports: `%LOCALAPPDATA%/Temp/shh-review/report-A{1..5}.md`
(working copies); briefs and controller findings in
`.hermes/plans/2026-09-06-v1.8.9-review-briefs.md`.

Range reviewed: 002da4d..4baebd8 (4 commits, ~4,300 added lines).
Gates at review time: tsc clean, 514/514. All fixes below re-gated at 517/517
with every fix mutation-tested (revert → RED, restore → byte-identical).

## Verdicts

| Axis | Verdict | Required findings |
|---|---|---|
| A1 Correctness & races | Request changes | 2 (both fixed) |
| A2 Cross-engine consistency | Request changes | 2 (both fixed) |
| A3 Performance | Approve | 0 (2 Consider fixed anyway) |
| A4 Security & privacy | Approve | 0 (2 Consider hardening fixed anyway) |
| A5 Tests & verification | Request changes | 1 (fixed) |

## Fixed in the absorption batch (all mutation-tested)

1. **A1-7b (Required): destroy() leaked popstate/hashchange listeners.**
   A leaked closure fired after the user toggled infinite scroll off →
   handleNavigation() on a destroyed manager → infinite scroll RESURRECTED
   against the user's pref; with a later toggle-on, two managers raced the
   DOM. Fix: listeners retained as a field, removed in destroy(), and
   startNavigationDetection() clears any prior pair (no stacking on re-init).
2. **A1-2 (Required): data-shh-ok missing from the preload attributeFilter.**
   The reveal stamp that keeps appended pages visible is exactly the
   attribute Google's reconciliation could strip (it strips
   data-shh-preloaded today). Without watching it, a stripped ok stamp =
   opacity:0 forever with no reveal net. Fix: added to attributeFilter; Case
   D's existing self-heal loop re-derives and re-stamps.
3. **A2-F1 (Required): favicon <img> re-point was not engine-gated.** Brave's
   chips are also favicon-classed <img>s — every page-2+ Brave destination
   was re-pointed at google.com/s2/favicons (privacy leak to Google; CSP
   block = blank chip). Fix: s2 fallback gated to engine.id === "google" in
   both painters; non-Google <img> chips keep the engine's own URL.
   Pinned by tests/infinite-scroll/favicon-engine-gating.test.ts (mutant G
   survived before the pin — 515/515 green under revert).
4. **A2-F2 (Required): data-shh-preloaded in SELECTOR_PROCESSED skipped
   legit results.** When the preload stamps at a different (inner) DOM level
   than the adapter offers (Yandex li.serp-item > div.Organic, legacy DDG
   div.result > .links_main, some Google layouts), the offered wrapper was
   skipped → blocked results hidden with NO placeholder, NO Show/Unblock,
   unreachable by restoreByDomain — a v1.8.9 regression from my own dedupe
   fix. Fix: SELECTOR_PROCESSED back to UI markers only
   (result/btn/placeholder); preload marks handled directionally (ancestor
   guard covers the ancestor direction). Companion: showOnce now clears
   INNER preload marks so a revealed wrapper doesn't render with holes.
   The session's own test that pinned the wrong behavior was flipped and
   re-pinned to the correct semantics (mutant H caught).
5. **A5-R1 (Required): ancestor guard had no regression net.** Fresh-eyes
   mutation run proved a full revert left 514/514 green — my earlier
   "mutation test" had mutated the test's mirror copy too, an invalid
   protocol (self-mutated-into-passing). Fix: guard extracted to exported
   dedupe.isInsideProcessedTerritory(); test rewritten to bind the shipped
   function; shipped-guard revert now goes RED (2 tests).
6. **Controller-S2 (Required): native pager never restored.** hidePagination
   had no reverse; toggle-off mid-session or reaching maxPages left the user
   unable to paginate manually until reload. Fix: hiddenPagerEls remembered;
   restorePagination() in destroy(), at maxPages end, and at session end
   (genuine end / budgets exhausted).
7. **A4-Q2 (Consider, fixed): favicon-data charset hardening.** The
   /^data:image\//i prefix check admitted values closing the url("...")
   wrapper and adding a second background layer = silent beacon. Fixed to a
   full-shape base64-image regex.
8. **A4-Q3 (Consider, fixed): url( added to PALETTE_VALUES; @font-face
   dropped from ported fetched sheets.** cursor:url(attacker) style smuggle
   and font-src fetch channel closed (favicon-subtree data: art exception
   preserved).
9. **A1-8 (Consider, fixed): per-node try/catch in processResults.** One
   throwing node no longer abandons the rest of its observer batch.
10. **A3-F2 (Consider, fixed): faviconRetryCount reset on handleNavigation.**
    Intel retry budget no longer permanently exhausted across SPA searches.
11. **A2-F6 (Nit, fixed): preload structuralResults() gated to isGoogle.**
    Same gating as the observer path; a non-Google page with a coincidental
    #search/#res id can no longer feed children to tryHide without the
    section guards.

## Filed, not fixed (with reasons)

- **A1-3b (Consider)**: preload-hidden wrapper Google later expands into a
  multi-result section strands inner results (survives even unblock — only
  [data-shh-result] nodes are walked by restore). Requires new behavior
  (re-offer section-shaped preloaded wrappers), no field report, deferred.
- **A3-F3 (Consider)**: merge the 4-5 per-append subtree walks into one
  enumeration (~half the append CPU on Startpage-heavy pages). Refactor,
  deferred; the walks are linear and per-page.
- **A3-F5 (Consider)**: cache per-element heading counts in
  looksLikeGoogleSection if it ever shows in profiles (~1,600 subtree
  probes per load worst case). Deferred until profiled.
- **A5-F3 (Consider)**: CSS-contract test tying the data-shh-ok stamp to
  preload.css's :not([data-shh-ok]) selector (jsdom cannot cascade CSS).
  Deferred: the shipped selector is stable and was field-verified twice.
- **A2-F4 (Consider)**: Brave genuine pages pass the shape gate only via
  the outbound-link probe (no headings, no shape selectors). One Brave
  change away from misfiling; suggested adding div.snippet[data-type] to
  SERP_SHAPE_SELECTORS — deferred pending a real Brave last-page capture.
- **A2-F5/F3-nit**: stale hasSearchResultsShape export comment; s2 URL
  duplicated as inline constants vs the FIRST_PARTY map (map is
  load-bearing only for the Yandex pattern learner — documented in code).
- **A4-FYI**: _shh_cache block list readable by page JS (localStorage on
  the page origin) — pre-existing sync-availability trade-off, documented
  in the privacy stance.

## Reviewer quality notes

- A5's live mutation matrix invalidated one of my own earlier claims
  (ancestor-guard pin) — the mirror-mutation protocol error is recorded in
  the skill as a lesson.
- A2 verified cross-engine claims against live SERP captures (Brave, Bing,
  DDG) where the controller had only read code; its Brave img-chip anatomy
  was load-bearing for finding F1.
- A1 traced the full three-layer state machine and proved the append-path
  ordering safe (no async gap between onNewNodes and the reveal stamp).
- A4 empirically verified <base> precedence and CSS selector injection
  immunity with hostile inputs (both clean).
