# Startpage.com Support — Design & Multi-Phase Implementation Plan

**Date:** 2026-08-23
**Status:** ✅ Implemented (phases below executed in order; test suite green)
**Confidence:** Blocking 95% (userscript-ported selectors across 4 markup generations) · Infinite scroll 70% (POST `sc` pagination verified against SearXNG/degoogle; live behavior must be confirmed manually)

**Goal:** Full Startpage.com engine support in Search Hit Hider — block buttons, hiding with placeholders, perma-ban, popup engine toggle, and best-effort infinite scroll — at parity with the six existing engines.

**Architecture:** A new `StartpageAdapter` implements the existing `EngineAdapter` interface. Blocking runs entirely on the rendered DOM (React hydration completes before the content script's deferred scan). Infinite scroll uses a new optional `getNextPageRequest()` adapter method because Startpage paginates via POST with a session `sc` token — not a GET URL — so the shared fetcher gained a `RequestInit` passthrough and the manager gained an empty-page guard that degrades gracefully to Startpage's own visible pagination.

**Tech Stack:** TypeScript, WebExtension content scripts, vitest + jsdom.

---

## Research findings this design is built on

1. **Pagination is POST-based.** Page 1 is `GET /sp/search?query=…`; page 2+ is `POST /sp/search` with form fields `query`, `page`, `sc` (+ `cat`, `language`, `lui` when present). Without the `sc` token Startpage treats the request as a bot. Verified against SearXNG's `startpage.py` (which also caps at page 18 and detects `/sp/captcha` redirects) and the degoogle extension ("Subsequent Requests: POST to /sp/search with sc, page, and query").
2. **The `sc` token is server-rendered** in the search form (`input[name="sc"]`) — present both on the live page and in fetched responses — and also appears inside the React hydration JSON as `"sc":"…"`.
3. **Modern result markup may be client-hydrated**: SearXNG now parses results from the hydration JSON rather than HTML nodes (legacy HTML xpaths are commented out there). Therefore a fetched page may legitimately contain zero extractable result nodes — the design must not treat that as "more pages available" (see the empty-page guard).
4. **Four result-markup generations** documented by the userscript's dated history (2018 `list-flat`, 2019 `w-gl__result`, 05/2024 `w-gl/w-bg > div.result` with `a.result-title.result-link`, 12/2024 news `css-ndwlbg > div.article`) — all ported as a priority list.
5. **Anonymous-view proxy links** (`ixquick-proxy.com/do/spg/highlight.pl?…&u=<url>` and `us-browse.startpage.com/av/proxy?…&u=<url>`) wrap destinations in a `u` param — unwrapped in the adapter and in the preload's `resolveHost()`.
6. **Userscript quirks ported:** 300 ms delayed init (results render late), button inserted *after* the title anchor (never inside it), proxy unwrapping, internal `/do/…` links are not result URLs.

## Design decisions (settled by session precedents)

- **Pagination stays visible** (`getPaginationSelectors() → []`) — same manual-fallback decision as Yandex, Bing, and Brave.
- **Insertion anchor** for fetched pages: walk up from the pager control to the container child, with a never-anchor-on-results guard (the Bing top-insertion lesson).
- **Host scope:** `www.startpage.com` + `startpage.com` only. The `us-browse.startpage.com` proxy host is deliberately NOT matched (mirrors the userscript's `@exclude`), and ad frames are covered by `all_frames: false`.
- **Infinite scroll is best-effort with graceful degradation:** 2 consecutive fetched pages yielding zero result nodes → stop cleanly ("End of results"), native pagination remains. Rationale: the hydration-HTML uncertainty (finding 3) makes a hard guarantee impossible without re-implementing Startpage's renderer, which is out of scope and fragile.

## Phase 1 — Engine registration (compile-level integration)

**Files:** `src/shared/types.ts` (EngineId union + `ALL_ENGINE_IDS`), `src/content/engines/registry.ts`, `src/popup/components/EngineSettings.tsx` (label map), `tests/defaults.test.ts` (7 engines).

- [x] Add `"startpage"` to `EngineId` and `ALL_ENGINE_IDS` (engineToggles default auto-derives)
- [x] Register `StartpageAdapter` in the registry
- [x] Add `startpage: "Startpage"` to `ENGINE_LABELS` (popup settings checkbox auto-renders from `ALL_ENGINE_IDS`)
- [x] Update `tests/defaults.test.ts` expected list + count 6→7

## Phase 2 — Blocking adapter

**Files:** `src/content/engines/startpage.ts` (new), `src/content/index.ts` (init sleep), `src/content/preload.ts` (proxy unwrap), `manifest.json`.

- [x] `matches()`: `startpage.com` / `www.startpage.com` only
- [x] `getResultNodes()`: priority selector list across 4 markup generations, filtered by extractable external URL
- [x] `getResultUrl()`: title-anchor chain + `unwrapProxy()` for both proxy hosts + reject internal paths
- [x] `getButtonTarget()`: title anchor (generic "after" insertion = userscript behavior)
- [x] Init deferral: `engine.id === "startpage"` joins Brave's 400 ms sleep (POST-render + hydration)
- [x] Preload `resolveHost()`: unwrap `u=` proxy links; `SELS` already contained the Startpage selectors (verified against userscript — kept as-is)
- [x] Manifest: preload + index content-script matches, `host_permissions`, description update

## Phase 3 — Infinite scroll (POST pagination)

**Files:** `src/content/engines/base.ts` (`getNextPageRequest` interface method), `src/content/infinite-scroll/fetcher.ts` (RequestInit passthrough + `/sp/captcha`), `src/content/infinite-scroll/manager.ts` (request descriptor + empty-page guard), `startpage.ts`.

- [x] `getNextPageRequest(doc, pageNo)`: builds `{url, method: POST, body}` — `sc` from form input with hydration-JSON fallback, `query`/`language`/`lui` carried from the form
- [x] `buildNextPageRequest()` in the manager converts to `fetch` init (form-urlencoded); GET engines untouched
- [x] Empty-page guard: 2 consecutive 200-responses with zero extractable nodes → `hasMore = false` (prevents hammering Startpage on hydrated-only responses and soft block pages)
- [x] `/sp/captcha` final-URL detection in the fetcher (joins the existing `/sorry/`, `#captcha`, `.g-recaptcha` checks)
- [x] `getInsertionAnchor()`: pager-control walk-up + never-anchor-on-results guard; `getPaginationSelectors() → []`; `getResultsContainer()`: `#main` → `section.mainline__web` → `.w-gl` parent
- [x] Removed the cargo-cult `Cache-Control: no-cache` header while rewriting the fetcher header block (non-CORS-safelisted; pointless on same-origin GET)

## Phase 4 — Tests

**Files:** `tests/engines/startpage.test.ts` (new, 18 tests), `tests/infinite-scroll/fetcher.test.ts` (+2), `tests/defaults.test.ts`.

- [x] matches (incl. proxy host NOT matched)
- [x] result nodes across all 3 fixture generations + internal-link skipping
- [x] URL extraction: direct, ixquick-proxy, us-browse proxy, internal → null
- [x] POST request building: form sc, hydration-JSON sc fallback, missing sc → null
- [x] Insertion anchor: pagination block, results-list guard, no-pager
- [x] Fetcher: POST body/method/headers/credentials, `/sp/captcha` → null

## Phase 5 — Docs, build, verification

- [x] README: prose ×2, infinite-scroll engine list, engine table row
- [x] docs/site: keywords meta, engine card + color, FAQ prose ×2
- [x] `tsc --noEmit` clean; suite 371/371; `npm run build`; addons-linter
- [ ] **Manual verification on live Startpage** (cannot be automated — bot walls):
  1. Block button appears next to results; block → placeholder; Show/Unblock/Perma work
  2. Anonymous-view (proxy) results block the real domain, not ixquick-proxy.com
  3. Scroll to bottom → spinner → page 2 appends above the pager; pager stays visible and clickable
  4. If Startpage serves hydrated-only HTML: after ≤2 attempts the sentinel shows "End of results" and the native pager still works
  5. Popup → Settings → Search Engines shows a checked "Startpage" toggle; unchecking stops blocking on reload

## Live test round 3 — ROOT CAUSE of "must open popup to activate" found via timestamped diagnostics

User-supplied diag on a cold load: `[SHH-preload]` at page start, then `init start t=102556ms` — the main content script did not EXECUTE until 102 seconds after load, coinciding with the popup being opened. Messaging was instant once started (init→done in 420 ms). Cause: the content script was registered at `run_at: document_idle`, which Firefox defers until the page's `load` event — and Startpage pages stall `load` behind a hanging resource (its sibling images visibly fail; one request blackholes for ~100 s until network timeout). The preload (document_start) was unaffected, which is why pre-hiding partially worked but buttons/placeholders never appeared.

Fix: the Startpage content-script block now runs at `document_end` (fires right after DOMContentLoaded, immune to hanging subresources). The script's existing late-hydration handling (400 ms deferral + MutationObserver) covers results that render after DOMContentLoaded. Other engines keep `document_idle` (their pages fire `load` promptly; no observed issue — revisit if the same signature ever appears).

Also in this round: ported fetched styles now drop document-level theme rules (`html`/`body`/`:root`) so a fetched default-theme build cannot recolor results against the user's live theme; diagnostics are timestamped (`t=…ms`) and mirrored into `<html data-shh-diag>`; `data-shh-preload-run` marks preload execution. Suite 378/378.

## Live test round 2 (2026-08-23) — three user reports, fixed

**Report 1 — "no effect on initial load, works after opening the extension."** Diagnosis: unauthenticated curl of the SERP returns a 10 KB shell with zero result markup (results are client-hydrated), and a cold background event page can reject the content script's first `getList`/`getPrefs`, silently aborting `init()` (one 500 ms retry wasn't enough; opening the popup warms the background so the NEXT page load works). Fixes: (a) init now retries messaging 4× with 500 ms backoff; (b) if messaging stays dead, state is rebuilt from the preload's localStorage cache (blocking/placeholders work in degraded mode — the cache is only written while the engine was active and carries the paused flag); (c) `getCachedResultNodes` no longer caches empty snapshots (a cached `[]` used to starve all later re-processing on late-hydrating engines).

**Report 2 — spinner in the wrong place.** The sentinel was always placed after the whole container (below the pager). Engines that expose an insertion anchor now get the spinner inserted BEFORE the pager — directly beneath the streaming results. No-anchor engines keep the old placement.

**Report 3 — auto-loaded results had wrong text colors.** Live result nodes are styled purely by emotion `css-*` classes (zero inline styles), and the fetched page's SSR class hashes differ from the live client-rendered ones, so clones lost their styling rules. New `portFetchedStyles` option (enabled for Startpage only): each fetched page's `<style>` rules are copied into the appended page container (tagged `data-shh-fetched-style`), deduped against the live document's styles and previously ported rules.

Suite: 378/378 (+3: anchor-aware sentinel placement, style porting + dedupe, opt-out default).

## Live-DOM verification (2026-08-23, after first user test) — 5th generation found & fixed

User reported "not working" on Startpage. Loading the live SERP (`/sp/search?query=test`) in a real browser and probing the DOM showed the cause was **not** the domain or URL — the manifest matches `/sp/search` fine. The live 2026 layout wraps results in **`<section id="main">`**, while every ported selector assumed `<div id="main">`: `div#main div.w-gl > div.result` matched 0 of 10 visible results (title anchors `a.result-title`, the `w-gl` container, and both POST inputs were all present and healthy).

Fixes:
1. Tag-agnostic `#main` selectors + an unscoped `div.w-gl > div.result` fallback (adapter + preload `SELS`) — future container-tag changes now degrade gracefully instead of breaking completely.
2. `getNextPageRequest` now ports the pager form's **own hidden inputs wholesale** (live values verified: `sc`, `t=device`, `segment=startpage.udog`, `lui`, `language`, `cat`) instead of cherry-picking three fields — Startpage adding/renaming form fields can no longer break the POST.
3. Test fixtures rebuilt from the live DOM (`section#main`, `pagination-container > nav.pagination > form`), with the 2024 `div#main` variant retained as a legacy case. Suite: 375/375.

## Post-implementation review (2026-08-23) — defects found & fixed

A deep review of this changeset found and fixed five issues before commit:

1. **Critical — infinite scroll never activated:** the manager-init gates in `index.ts` (init + refreshPrefs) checked only `getNextPageUrl || triggerNextPage`; a POST-only engine satisfies neither. Both gates now include `getNextPageRequest`, with a capability-predicate regression test (the Brave-plan lesson, repeated and now guarded).
2. **High — POST page-chain off-by-one:** `currentPage++` ran *after* the next request was built, so page 2 was requested repeatedly (masked by dedup + the empty-page guard as "load one page, then done"). Increment now runs before append/next-request; also corrects the pre-existing `data-inf-page` marker collision (appended pages are numbered 2..N). Regression test asserts page 2 → page 3 with the fresh `sc` token.
3. **Medium — React-controlled form inputs:** values were read via `getAttribute("value")` only; on the live page the first POST could go out with an empty `query`. Now property-first with attribute fallback and a URL fallback.
4. **Minor — double percent-decode** in both proxy unwraps (adapter + preload `resolveHost`) removed.
5. **Minor — weak anchor-guard test** strengthened (real broad-container case: `document.body` as container); About-tab prose updated to list all seven engines.

Verification after fixes: `tsc` clean, 374/374 tests, addons-linter 0 errors, `dist/` + zip rebuilt.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Fetched pages contain no HTML result nodes (hydration) | Empty-page guard stops after 2; native pagination remains |
| Startpage rate-limits the POST fetches | Existing jitter + 3-error backoff; `/sp/captcha` treated as failure; pagination never hidden |
| `sc` token moves out of the form | Hydration-JSON fallback; null → clean stop |
| Result markup changes again (5th generation) | Priority selector list + userscript history as the update playbook; preload `:has()` rules already carry the old generations |
