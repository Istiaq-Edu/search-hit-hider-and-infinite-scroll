# Infinite Scroll — Implementation Plan

> **Status:** Phase 1 Complete ✅ — Awaiting Manual Testing
> **Target Extension:** Search-Hit-Hider v1.1.0+
> **Engine Support:** Google (Phase 1), Bing, DuckDuckGo, Yandex, Baidu, Brave (Phases 2–3)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Engine Pagination Research](#3-engine-pagination-research)
4. [Implementation Phases](#4-implementation-phases)
5. [Files to Create / Modify](#5-files-to-create--modify)
6. [Detailed Specifications](#6-detailed-specifications)
7. [Settings & UI](#7-settings--ui)
8. [Edge Cases](#8-edge-cases)
9. [Test Plan](#9-test-plan)
10. [Progress Tracker](#10-progress-tracker)

---

## 1. Overview

### What

Add infinite scroll (auto-load next page on scroll) to all 6 supported search engines. When the user scrolls near the bottom of search results, the next page is fetched automatically and appended inline — no pagination clicks needed.

### Why

When users block 90%+ of results via Search-Hit-Hider, they exhaust page 1 quickly and must manually paginate through many pages. Infinite scroll makes this seamless: results are streamed in as the user scrolls, blocked results are filtered by the existing hider system, and the user gets a continuous experience.

### Key Design Decisions (from requirements)

| Decision | Choice |
|----------|--------|
| **Extension type** | Firefox MV3 (existing) |
| **Distribution** | Published via AMO |
| **Engine detection** | Single content script, engine-agnostic adapter pattern |
| **Settings scope** | Global (apply to all engines) |
| **Infinite scroll ↔ Hider linkage** | **Linked** — disabling hider on an engine also disables infinite scroll (v1); can be decoupled later |
| **Scroll position** | Persist across reloads with freshness timeout (configurable) |
| **Non-organic results** | Include them (faithful layout) |
| **Max pages** | Configurable (default 20, unlimited option) |
| **DOM management** | Auto-discard pages above viewport (keep ~5 pages, post-v1 refinement) |
| **Dedup strategy** | Attribute first (e.g. `data-ved`), URL hash fallback |
| **Fetch** | Direct content-script `fetch()` (same origin, cookies auto-sent) |
| **Phased release** | v1: Google, v2+: Remaining engines |

---

## 2. Architecture

### 2.1 New Module: `src/content/infinite-scroll/`

```
src/content/infinite-scroll/
├── manager.ts          # InfiniteScrollManager — lifecycle, state machine, orchestration
├── sentinel.ts         # Sentinel element creation & state management (loading/error/done/idle)
├── fetcher.ts          # Fetch next page, parse HTML, extract container & next URL
├── deduper.ts          # Result deduplication (attribute-based + URL hash fallback)
└── persist.ts          # Scroll position save/restore with freshness checking
```

### 2.2 Extended EngineAdapter Interface

Add optional infinite-scroll methods to `EngineAdapter` (`src/content/engines/base.ts`):

```ts
export interface EngineAdapter {
  // …existing methods…

  // ── Infinite scroll (optional) ──────────────────────────
  /** Return the URL for the next page of results, or null if none. */
  getNextPageUrl?(doc: Document): string | null;

  /** CSS selectors for pagination elements to hide when infinite scroll is active. */
  getPaginationSelectors?(): string[];

  /** Return a unique identifier for a result node (for dedup). Falls back to URL hash. */
  getResultId?(node: Element): string | null;
}
```

Engines that don't implement these methods simply won't activate infinite scroll — safe fallback.

### 2.3 InfiniteScrollManager Lifecycle

```
init()
  ├── check prefs (infiniteScroll enabled? engine supports it?)
  ├── hidePagination() — hide native pagination UI
  ├── createSentinel() — inject sentinel element
  ├── observeSentinel() — IntersectionObserver on sentinel
  ├── tryRestoreScroll() — persist.ts: restore saved scroll position if fresh
  └── log("InfiniteScroll initialized")

[IntersectionObserver fires → sentinel visible]
  └── fetchNextPage()
        ├── if isLoading || !hasMore || !nextUrl → return
        ├── updateSentinel("loading")
        ├── fetcher.fetch(url)
        │     ├── fetch() with AbortController
        │     ├── DOMParser.parseFromString()
        │     ├── extract container via engine.getResultContainer()
        │     ├── extract nextUrl via engine.getNextPageUrl()
        │     └── return { doc, nextUrl } or null
        ├── deduper.filterNew(nodes) — skip seen IDs
        ├── appendNodes(fragment) — append to container
        ├── callback(newNodes) → content script processResults()
        ├── updateSentinel(hasMore ? "idle" : "done")
        ├── saveScrollState() — persist.ts debounced
        └── isLoading = false

[popstate / URL change detected]
  ├── destroy()
  │     ├── observer.disconnect()
  │     ├── removeSentinel()
  │     ├── abortController.abort()
  │     └── saveScrollState()
  └── init() — re-init for new page

[pageshow (bfcache)]
  └── cleanup stale sentinel + re-evaluate
```

### 2.4 Integration into Existing Content Script

In `src/content/index.ts`, after the existing prefs + engine checks:

```ts
// ── Infinite scroll init ──────────────────────────────────
let infiniteScrollManager: InfiniteScrollManager | null = null;

if (prefs.infiniteScroll && engine.getNextPageUrl) {
  const container = findInfiniteScrollContainer(engine);
  if (container) {
    infiniteScrollManager = new InfiniteScrollManager(
      engine,
      container,
      // Callback: new nodes → pass through existing hider
      (newNodes) => processResults(newNodes),
      {
        threshold: prefs.infiniteScrollThreshold,
        maxPages: prefs.infiniteScrollMaxPages,
        persist: prefs.infiniteScrollPersist,
        freshnessMinutes: 30,
        fetchDelay: 1500,
      }
    );
    infiniteScrollManager.init();
  }
}
```

The callback feeds new nodes into the existing `processResults()` pipeline, which applies domain matching, hiding, and button injection. No changes needed to the hider system.

The `MutationObserver` (ResultObserver) already watches for DOM changes, so if the engine adds results via its own AJAX/SPA mechanism (not via our fetcher), the observer still catches them.

### 2.5 State Machine

```
         ┌──────────┐
         │   IDLE   │ ◄────────┐
         └────┬─────┘          │
              │ sentinel       │
              │ visible        │ retry button clicked
              ▼                │
         ┌──────────┐ ────────┘
         │ LOADING  │
         └────┬─────┘
              │
        ┌─────┴──────┐
        ▼            ▼
   ┌────────┐  ┌──────────┐
   │  DONE  │  │  ERROR   │── retry ──► IDLE
   └────────┘  └──────────┘
```

---

## 3. Engine Pagination Research

Research conducted May 2026. Selectors may need adjustment as engines update their markup.

### 3.1 Google

| Property | Value |
|----------|-------|
| **Result container** | `#rso`, `#center_col`, `#res` |
| **Result nodes** | `div.g:not(.g .g)`, `div.tF2Cxc:not(.tF2Cxc .tF2Cxc)` |
| **Next page URL** | `#pnnext` href, `a[aria-label^="Next"]` href, `a[href*="/search?"][href*="start="]:last-of-type` |
| **Page param** | `start=N` (increments by 10, e.g. `start=10`, `start=20`) |
| **Pagination hiding** | `#foot`, `#navcnt`, `#xjs > div:last-child` |
| **Result ID** | `data-ved` attribute on result or child |
| **Status** | ✅ Working in userscript snippet (proven) |

### 3.2 Bing

| Property | Value |
|----------|-------|
| **Result container** | `#b_content` |
| **Result nodes** | `#b_content ol#b_results > li.b_algo` |
| **Next page URL** | `a.sb_pagN` (next page button), `a[title="Next page"]`, `a.sb_pagN_bp.b_widePag` |
| **Page param** | `&first=N` (1-based, increments by 10: `first=11`, `first=21`) |
| **Pagination hiding** | `li.b_pag`, `nav[role="navigation"]`, `#b_results li.b_pag` |
| **Result ID** | URL hash (no stable attribute; use `h2 > a[href]` hash) |
| **Status** | 🔍 Ready for implementation |

### 3.3 DuckDuckGo

| Property | Value |
|----------|-------|
| **Result container** | `#links` (legacy), `.react-results--main` (React) |
| **Result nodes** | `ol.react-results--main > li[data-layout='organic']` (React), `div#links div.results_links_deep` (legacy) |
| **Next page URL** | No simple anchor — DDG uses form POST. Requires extracting `vqd` token + `s`/`dc` params from page. The "More results" button is `.result--more__link` |
| **Page param** | `s=N` (offset, increments by 30) + `dc=N+1` + `vqd=<session_token>` |
| **Pagination hiding** | `.results--footer`, `#footer`, `div.result--more` |
| **Result ID** | `data-id` attribute or URL hash |
| **Note** | DDG is notorious for CAPTCHA challenges under automation. The `vqd` token must be extracted fresh from each page. |
| **Status** | ⚠️ Higher complexity — deferred to Phase 2 |

### 3.4 Yandex

| Property | Value |
|----------|-------|
| **Result container** | SERP area around `li.serp-item` / `div.Organic` |
| **Result nodes** | `li.serp-item`, `div.serp-item`, `div.Organic` |
| **Next page URL** | `a.Pager-Item_type_next`, `a[aria-label="Next page"]`, or link with class containing `Pager` |
| **Page param** | `&page=N` (0-based) |
| **Pagination hiding** | `.Pager`, `nav.Pager`, `div.Pager` |
| **Result ID** | `data-cid` attribute or URL hash |
| **Status** | 🔍 Ready for Phase 2 |

### 3.5 Baidu

| Property | Value |
|----------|-------|
| **Result container** | `#content_left` |
| **Result nodes** | `#content_left > div.result.c-container`, `#content_left > div.result-op.c-container` |
| **Next page URL** | `#page a.n` (next page button), analyze href for `&pn=` param |
| **Page param** | `&pn=N` (0-based, increments by 10: `pn=0`, `pn=10`, `pn=20`) |
| **Pagination hiding** | `#page`, `#page-wrap` |
| **Result ID** | URL hash |
| **Status** | 🔍 Ready for Phase 2 |

### 3.6 Brave Search

| Property | Value |
|----------|-------|
| **Result container** | `#results` |
| **Result nodes** | `div.snippet[data-type="web"]`, `div.snippet[data-type="news"]`, `div.snippet[data-type="videos"]` |
| **Next page URL** | `a[href*="offset="]:not([disabled])` |
| **Page param** | `&offset=N` (increments by result count per page) |
| **Pagination hiding** | `#pagination-snippet` |
| **Result ID** | URL hash |
| **Note** | Brave is a Svelte SPA but still uses URL‑based pagination with `offset` param |
| **Status** | 🔍 Ready for Phase 2 |

### 3.7 Pagination Selectors Summary Table

| Engine | Next URL Selectors | Page Param | Pagination Hide Selectors |
|--------|-------------------|------------|--------------------------|
| Google | `#pnnext`, `a[aria-label^="Next"]`, `a[href*="/search?"][href*="start="]:last-of-type` | `start=N` (×10) | `#foot`, `#navcnt`, `#xjs > div:last-child` |
| Bing | `a.sb_pagN`, `a[title="Next page"]`, `a.sb_pagN_bp` | `first=N` (1-based ×10) | `li.b_pag`, `nav[role="navigation"]` |
| DuckDuckGo | `form result--more` (needs `vqd` extraction) | `s=N` (×30) + `vqd` | `.results--footer`, `#footer` |
| Yandex | `a.Pager-Item_type_next`, `a[aria-label="Next page"]` | `page=N` | `.Pager` |
| Baidu | `#page a.n` | `pn=N` (×10) | `#page`, `#page-wrap` |
| Brave | `a[href*="offset="]:not([disabled])` | `offset=N` | `#pagination-snippet` |

---

## 4. Implementation Phases

### Phase 1 — Core Framework + Google (v1)

**Goal:** Working infinite scroll on Google Search with all integration points wired.

**Deliverables:**
- [ ] All 5 new files in `src/content/infinite-scroll/`
- [ ] `EngineAdapter` extended with optional methods
- [ ] Google adapter implements infinite scroll methods
- [ ] Wiring in `src/content/index.ts`
- [ ] `Prefs` type extended with infinite scroll settings
- [ ] Settings UI in popup (Infinite Scroll section)
- [ ] Scroll position persistence
- [ ] Tests for deduper, state management, persist

**Estimated scope:** ~600-800 lines of new TypeScript, ~50 lines of changes to existing files.

### Phase 2 — Bing + DuckDuckGo

**Deliverables:**
- [ ] Bing adapter implements infinite scroll methods
- [ ] DuckDuckGo adapter implements infinite scroll (+ `vqd` extraction logic)
- [ ] Integration tests for both

### Phase 3 — Yandex + Baidu + Brave

**Deliverables:**
- [ ] Yandex adapter implements infinite scroll methods
- [ ] Baidu adapter implements infinite scroll methods
- [ ] Brave adapter implements infinite scroll methods

### Phase 4 — Polish & Performance

- [ ] DOM page discarding (keep ~5 pages in DOM, remove oldest above viewport)
- [ ] Fetch delay randomization (avoid detection)
- [ ] Error rate monitoring (console-based, no telemetry)
- [ } Performance profiling for large result sets

---

## 5. Files to Create / Modify

### New Files (5)

| File | Purpose |
|------|---------|
| `src/content/infinite-scroll/manager.ts` | Core lifecycle, state machine, IntersectionObserver |
| `src/content/infinite-scroll/sentinel.ts` | Sentinel element DOM creation + state transitions |
| `src/content/infinite-scroll/fetcher.ts` | HTTP fetch + HTML parse + next-URL extraction |
| `src/content/infinite-scroll/deduper.ts` | Two-layer dedup (attribute → URL hash) |
| `src/content/infinite-scroll/persist.ts` | Scroll position localStorage save/restore |

### Modified Files (10)

| File | Change |
|------|--------|
| `src/shared/types.ts` | Add `InfiniteScrollPrefs` fields to `Prefs` + defaults |
| `src/shared/storage.ts` | No changes needed (already handles arbitrary prefs) |
| `src/content/engines/base.ts` | Add optional infinite scroll methods to `EngineAdapter` |
| `src/content/engines/google.ts` | Implement `getNextPageUrl`, `getPaginationSelectors`, `getResultId` |
| `src/content/engines/bing.ts` | Implement infinite scroll methods (Phase 2) |
| `src/content/engines/duckduckgo.ts` | Implement infinite scroll methods (Phase 2) |
| `src/content/engines/yandex.ts` | Implement infinite scroll methods (Phase 3) |
| `src/content/engines/baidu.ts` | Implement infinite scroll methods (Phase 3) |
| `src/content/engines/brave.ts` | Implement infinite scroll methods (Phase 3) |
| `src/content/index.ts` | Wire `InfiniteScrollManager` into init flow |
| `src/popup/components/SettingsTab.tsx` | Add "Infinite Scroll" section |

---

## 6. Detailed Specifications

### 6.1 InfiniteScrollManager (`manager.ts`)

```ts
interface InfiniteScrollConfig {
  threshold: number;         // px from bottom before loading (default: 800)
  maxPages: number;          // max pages to load, -1 = unlimited (default: 20)
  persist: boolean;          // save/restore scroll position (default: true)
  freshnessMinutes: number;  // discard saved state older than N min (default: 30)
  fetchDelay: number;        // ms pause between fetches (default: 1500)
  debugMode: boolean;        // log diagnostics (default: false)
}

class InfiniteScrollManager {
  private state: {
    isLoading: boolean;
    currentPage: number;
    nextUrl: string | null;
    hasMore: boolean;
    error: Error | null;
    currentUrl: string;
  };

  private sentinel: Sentinel;
  private observer: IntersectionObserver;
  private abortController: AbortController | null;
  private urlCheckInterval: number | undefined;

  constructor(
    private engine: EngineAdapter,
    private container: Element,
    private onNewNodes: (nodes: Element[]) => void,
    private config: InfiniteScrollConfig
  ) {}

  init(): void;
  destroy(): void;
  handleNavigation(): void;  // reset on URL change
  resetState(): void;

  private hidePagination(): void;
  private createSentinel(): void;
  private observeSentinel(): void;

  private async fetchNextPage(): Promise<void>;
  private async doFetch(url: string): Promise<{ nextUrl: string | null; nodes: Element[] } | null>;
  private extractResultNodes(doc: Document): Element[];
  private appendNodes(nodes: Element[]): void;
  private isDuplicate(node: Element): boolean;

  private onScrollStateChange(): void;  // debounced persist save
}
```

### 6.2 Sentinel (`sentinel.ts`)

```ts
type SentinelState = 'idle' | 'loading' | 'error' | 'done';

class Sentinel {
  readonly element: HTMLElement;

  constructor(container: Element);
  setState(state: SentinelState, onRetry?: () => void): void;
  remove(): void;
}
```

Visual design:

| State | Appearance |
|-------|-----------|
| **idle** | Hidden / empty (0 height) |
| **loading** | Centered text "Loading more results…" + blue spinning circle (CSS animation) |
| **error** | Red text "Connection lost or blocked." + blue "Try Again" button |
| **done** | Muted text "End of results." |

Styled with inline styles (no external CSS dependency), consistent with the rest of the extension's injected UI.

### 6.3 Fetcher (`fetcher.ts`)

```ts
async function fetchPage(
  url: string,
  signal: AbortSignal,
  fetchDelay: number
): Promise<{ html: string; nextUrl: string | null } | null>;
```

- Uses `window.fetch()` — same origin, cookies sent automatically
- AbortController support for navigation teardown
- Configurable delay before fetch (avoids rate limiting)
- On non-2xx: return null (sentinel shows error)
- On network error: return null (sentinel shows error)
- On success: parse HTML with DOMParser, extract next URL via engine.getNextPageUrl()

### 6.4 Deduper (`deduper.ts`)

```ts
class Deduper {
  private seen: Set<string>;

  constructor();

  /** Check if a node has been seen. If not, mark it as seen and return false. */
  isDuplicate(node: Element, engine: EngineAdapter): boolean;

  /** Get unique ID for a node: try engine.getResultId() first, fall back to URL hash. */
  private getNodeId(node: Element, engine: EngineAdapter): string;

  /** Clear seen set (on navigation reset). */
  reset(): void;
}
```

ID resolution:
1. Try `engine.getResultId(node)` → e.g. `data-ved` for Google
2. Fall back to URL hash of the first external link found in the node (MD5 or simple FNV-1a hash of href string)
3. If no URL either, fall back to a position-based ID: `page-${page}-index-${index}`

### 6.5 Persist (`persist.ts`)

```ts
interface ScrollState {
  url: string;              // window.location.href
  scrollY: number;          // window.scrollY
  loadedUrls: string[];     // URLs of pages fetched so far
  loadedPages: number;      // number of pages loaded
  timestamp: number;        // Date.now()
}

const STORAGE_KEY = 'shh_infscroll_state';

function saveScrollState(state: ScrollState): void;
function loadScrollState(): ScrollState | null;
function isStateFresh(state: ScrollState, maxAgeMinutes: number): boolean;
function clearScrollState(): void;
```

Storage: `browser.storage.local` (key: `shh_infscroll_state`).

Save triggers:
- Debounced scroll handler (every 1s)
- On `pagehide` / `beforeunload`
- On navigation (before destroy)

Restore triggers:
- On `init()`, if URL matches + state is fresh
- Restore scroll Y and re-fetch any pages that were previously loaded to fill the gap above viewport

---

## 7. Settings & UI

### 7.1 Type Additions (`src/shared/types.ts`)

```ts
export interface Prefs {
  // …existing fields…

  // ── Infinite scroll ──
  infiniteScroll: boolean;           // master toggle (default: true)
  infiniteScrollThreshold: number;   // px from bottom (200-2000, default: 800)
  infiniteScrollMaxPages: number;    // max pages (-1=unlimited, default: 20)
  infiniteScrollPersist: boolean;    // persist scroll (default: true)
}
```

Default values:

```ts
export const DEFAULT_PREFS: Prefs = {
  // …existing defaults…
  infiniteScroll: true,
  infiniteScrollThreshold: 800,
  infiniteScrollMaxPages: 20,
  infiniteScrollPersist: true,
};
```

### 7.2 Settings UI

New section in the existing SettingsTab, between "Search Engines" and "Appearance":

```
┌─ Infinite Scroll ──────────────────────────┐
│                                             │
│  ☑ Enable infinite scroll                   │
│  Load results automatically as you scroll   │
│                                             │
│  Load threshold: ◄────●────────────►        │
│  Load sooner                    Load later   │
│  (800px from bottom)                        │
│                                             │
│  Max pages to load: [20  ▼]                 │
│  (5, 10, 20, 50, Unlimited)                │
│                                             │
│  ☑ Restore scroll position after reload     │
│  Picks up where you left off (30 min)       │
└─────────────────────────────────────────────┘
```

### 7.3 Linked Behavior

When **infinite scroll** is enabled but **hit-hider** is disabled/paused for an engine:
- Infinite scroll still works (loads more results)
- But the loaded results are NOT passed through `processResults()` for blocking
- The callback becomes a no-op (or better: just injects block buttons without hiding)

This is what "linked" means in our architecture: the callback (`onNewNodes`) is only connected to `processResults()` when hit-hider is active for that engine. If hit-hider is disabled, the callback appends results but skips processing.

---

## 8. Edge Cases

| Case | Handling |
|------|----------|
| **Empty search results** | No result container found → infinite scroll never activates |
| **Single page of results** | No `nextUrl` found → infinite scroll activates but immediately shows "End" sentinel |
| **Network failure mid-fetch** | Fetch aborts → sentinel shows error with retry button |
| **Rate limiting (429/503)** | Response not ok → sentinel shows error; configurable fetch delay helps prevent |
| **Soft navigation / SPA URL change** | URL polling detects change → destroy + re-init |
| **bfcache (back/forward cache)** | `pageshow` handler cleans up stale sentinel → re-init if needed |
| **Rapid scroll past sentinel** | IntersectionObserver fires once; `isLoading` flag prevents concurrent fetches |
| **User navigates away mid-fetch** | AbortController aborts in-flight request |
| **DOM node limit** | Not a concern for typical use (even 20 pages × 10 results ≈ 200 nodes) |
| **Memory with 50 pages** | Post-v1: rolling window discards pages above viewport, keeping ~5 loaded |
| **DDG CAPTCHA / bot challenge** | Fetch fails → sentinel shows error; user can retry manually or disable infinite scroll for DDG |
| **Custom search (site:example.com)** | Works the same — no special handling needed |
| **Image / News / Shopping tabs** | Currently skipped (web search priority); engine adapter can detect tab and decline |
| **Multiple tabs with same search** | Each tab has its own content script instance; no cross-tab interference |
| **Extension updates mid-session** | Content script re-runs on page reload; old sentinel is cleaned up |
| **Private browsing** | `storage.local` works normally; no special handling needed |

---

## 9. Test Plan

### 9.1 Automated Unit Tests (`vitest`)

| Test Suite | File | Tests |
|------------|------|-------|
| **Deduper** | `tests/infinite-scroll/deduper.test.ts` | `isDuplicate` with attribute IDs, URL hash fallback, empty nodes, position fallback, `reset()` |
| **Persist** | `tests/infinite-scroll/persist.test.ts` | Save/load, freshness check (within/outside timeout), clear, stale state rejection |
| **State machine** | `tests/infinite-scroll/manager.test.ts` | State transitions (idle→loading→done, idle→loading→error→idle), isLoading guard, hasMore guard |
| **Fetcher** | `tests/infinite-scroll/fetcher.test.ts` | URL construction, AbortController abort, timeout handling |
| **Google adapter** | `tests/engines/google-infinite.test.ts` | `getNextPageUrl` finds correct anchor, `getPaginationSelectors` returns correct list, `getResultId` extracts `data-ved` |

### 9.2 Manual Integration Tests

To be performed physically by user:

| Test | Steps | Expected |
|------|-------|----------|
| **Google basic scroll** | Search on Google, scroll to bottom | Next page loads, results appear, sentinel shows "Loading…" then "End" |
| **Blocked results** | Block `example.com`, scroll to page 2+ | Results from `example.com` are hidden even on loaded pages |
| **Scroll position restore** | Load 3 pages, scroll down, reload page | Scroll position restored, previously loaded results visible, new pages re-fetched as needed |
| **Error handling** | Disconnect network, scroll to bottom | Error sentinel appears with retry button; retry works when network is back |
| **Max pages** | Set max pages to 3 | After 3 pages, sentinel shows "End" |
| **Navigation** | Search, scroll, then do a new search | State resets, fresh infinite scroll starts |
| **Back/Forward** | Search, scroll, navigate away, press Back | Sentinels cleaned up, scroll position restored |
| **All engines** | Repeat above for Google, Bing, DDG, Yandex, Baidu, Brave | Works consistently across engines (some may show "End" immediately if pagination detection fails) |

### 9.3 Build Verification

```bash
npm run lint:ts           # TypeScript type check — must pass
npm run build             # esbuild — must build without errors
npm run webext:lint       # AMO linter — must pass
npm test                  # vitest — all unit tests pass
```

---

## 10. Progress Tracker

### Phase 1 — Core + Google  ✅

| Task | Status | Notes |
|------|--------|-------|
| `shared/types.ts` — add InfiniteScrollPrefs | ✅ Done | 4 new fields added to `Prefs`, defaults set |
| `engines/base.ts` — extend EngineAdapter | ✅ Done | Added 3 optional methods: `getNextPageUrl`, `getPaginationSelectors`, `getResultId` |
| `engines/google.ts` — implement infinite scroll methods | ✅ Done | All 3 methods implemented for Google |
| `infinite-scroll/deduper.ts` | ✅ Done | Two-layer dedup (attribute → URL hash) |
| `infinite-scroll/sentinel.ts` | ✅ Done | 4 states: idle/loading/error/done |
| `infinite-scroll/fetcher.ts` | ✅ Done | Fetch + parse with AbortController support |
| `infinite-scroll/persist.ts` | ✅ Done | localStorage save/restore with freshness |
| `infinite-scroll/manager.ts` | ✅ Done | Full lifecycle, state machine, IntersectionObserver |
| `content/index.ts` — wire manager into init() | ✅ Done | Initialization + refreshPrefs toggle + NAV reset |
| `popup/SettingsTab.tsx` — add Infinite Scroll section | ✅ Done | New `InfiniteScrollSettings` component added between "Search Engines" and "Appearance" |
| Write unit tests | ✅ Done | 23 new tests: deduper (9), persist (10), defaults (4) |
| Manual test on Google | ⬜ Pending | Requires user to load extension and test |
| `npm run build && npm run lint:ts` | ✅ Done | Build passes, TypeScript type check passes, all 280 tests pass |

### Phase 2 — Bing + DuckDuckGo  ✅

| Task | Status | Notes |
|------|--------|-------|
| `engines/bing.ts` — implement methods | ✅ Done | `getNextPageUrl`, `getPaginationSelectors`, `getResultId`, `getResultsContainer` |
| `engines/duckduckgo.ts` — implement methods | ✅ Done | Same methods; handles form-based pagination with `s`/`dc` params, React DDG |
| Manual test on Bing | ⬜ Pending | User needs to test |
| Manual test on DuckDuckGo | ⬜ Pending | User needs to test |

### Phase 3 — Yandex + Baidu + Brave

| Task | Status | Notes |
|------|--------|-------|
| `engines/yandex.ts` — implement methods | ⬜ Pending | |
| `engines/baidu.ts` — implement methods | ⬜ Pending | |
| `engines/brave.ts` — implement methods | ⬜ Pending | |
| Integration tests | ⬜ Pending | |

### Phase 4 — Polish

| Task | Status | Notes |
|------|--------|-------|
| DOM page discarding | ⬜ Pending | Post-v1 |
| Fetch delay randomization | ⬜ Pending | |
| Performance profiling | ⬜ Pending | |

---

## Appendix A: Reference — Google Infinite Scroll (Original Snippet)

The userscript snippet provided by the user lives at `search-hit-hider.user.js` and serves as the reference implementation for Google. Key behaviors to preserve:

- **Container detection**: try `#rso`, `#center_col`, `#res` in order
- **Next button**: `#pnnext`, `a[aria-label^="Next"]`, `a[href*="/search?"][href*="start="]:last-of-type`
- **Result dedup**: `data-ved` attribute on results
- **Pagination hiding**: `#foot`, `#navcnt`, `#xjs > div:last-child`
- **Abort previous request** on new fetch via `AbortController`
- **Error handling**: Show error in sentinel with retry button
- **Navigation**: `popstate` + URL polling (1000ms)

## Appendix B: Key Dependencies

| Dependency | Used By | Purpose |
|-----------|---------|---------|
| `IntersectionObserver` | manager.ts | Detect sentinel visibility (native, FF 55+) |
| `AbortController` | fetcher.ts | Cancel in-flight fetches on navigation (native, FF 57+) |
| `DOMParser` | fetcher.ts | Parse fetched HTML (native, FF 48+) |
| `CSSStyleSheet` (optional) | sentinel.ts (future) | Adopt spinner animation (native, FF 113+) |
| `browser.storage.local` | persist.ts | Save/restore scroll state (WebExtension API) |
| `browser.runtime.sendMessage` | background → content | Broadcast pref changes (existing) |

No new npm dependencies required.
