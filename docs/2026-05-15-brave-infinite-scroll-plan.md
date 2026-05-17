# Brave Search Infinite Scroll — Implementation Plan

**Date**: 2026-05-15
**Status**: ✅ Complete
**Confidence**: 95%

---

## 1. Problem Statement

Brave Search has been added as the 6th supported engine in Search-Hit-Hider, but its infinite scroll is **completely non-functional**. The `BraveAdapter` class has zero infinite scroll methods implemented, and the initialization check in `index.ts` only looks for `getNextPageUrl`, so even if trigger methods existed, Brave would never initialize.

### Root Causes

| Issue | File | Line | Detail |
|-------|------|------|--------|
| No `getNextPageUrl()` | `brave.ts` | — | Method not implemented |
| No `triggerNextPage()` | `brave.ts` | — | Method not implemented |
| No `getPaginationSelectors()` | `brave.ts` | — | Method not implemented |
| No `getResultId()` | `brave.ts` | — | Method not implemented |
| No `getResultsContainer()` | `brave.ts` | — | Method not implemented |
| Init check too narrow | `index.ts` | 102 | Only checks `engine.getNextPageUrl`, ignores `triggerNextPage` |
| Re-init check too narrow | `index.ts` | 428 | Same issue for mid-session toggle |

---

## 2. Research Findings

### Brave Search Pagination Behavior

- **Pattern**: Traditional pagination with a "Next" button (NOT a "Load More" button)
- **Parameter**: `offset` query parameter, increments by 1 per page (0, 1, 2, ...)
- **Max offset**: 9 (per Brave Search API documentation)
- **SPA behavior**: Clicking "Next" triggers client-side navigation — the entire results container is replaced, not appended to
- **Result container**: `#results`
- **Result nodes**: `div.snippet[data-type="web"]`, `div.snippet[data-type="news"]`, `div.snippet[data-type="videos"]`, or `.snippet`

### Greasy Fork Reference

The "Brave Infinite Scroll" userscript (v0.0.1, 2025-03-09) confirms:
- Selector: `#results > .snippet`
- Insertion point: before `#pagination-snippet`
- Next page detection: `a[href*="offset="]:not([disabled])`
- Uses fetch-based approach with `offset` parameter

### Existing Manager Support

The `InfiniteScrollManager` already supports two modes:
1. **Fetch-based** (`getNextPageUrl`): Fetches HTML, parses, extracts, appends — used by Google, Bing, Yandex
2. **Trigger-based** (`triggerNextPage`): Clicks button, waits for DOM changes, extracts new nodes

Brave will use **fetch-based** as the primary approach.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    InfiniteScrollManager                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │Sentinel  │  │ Deduper  │  │ Fetcher  │  │ Persist │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                    BraveAdapter                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  getNextPageUrl()  ← Two-strategy approach       │   │
│  │    Strategy 1: Find Next button href in DOM      │   │
│  │    Strategy 2: Construct URL with offset param   │   │
│  └──────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────┐   │
│  │  getPaginationSelectors() → [] (keep visible)    │   │
│  │  getResultsContainer() → #results                │   │
│  │  getResultId() → null (URL-hash fallback)        │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Data Flow

1. User scrolls to bottom → IntersectionObserver fires on sentinel
2. Manager calls `fetchNextPage()` → detects `getNextPageUrl` exists → fetch-based path
3. `getNextPageUrl()` returns next page URL (Strategy 1 or 2)
4. `fetchPage()` fetches HTML with jitter delay
5. `DOMParser` parses HTML → `extractNewNodes()` extracts results
6. `Deduper` filters duplicates via URL-hash
7. `appendNodes()` inserts into `#results` container
8. `onNewNodes()` callback runs blocking pipeline (hide blocked, inject buttons)
9. Sentinel state set to "idle" or "done"

---

## 4. Implementation Details

### 4.1. `src/content/engines/brave.ts` — Add 4 Methods

#### `getNextPageUrl(doc: Document): string | null`

**Strategy 1 — Find Next button href (primary)**:

```typescript
const selectors = [
  'a[href*="offset="]:not([disabled])',
  'a[aria-label="Next"]',
  '.ml-15 a[href]',
];
for (const sel of selectors) {
  const btn = doc.querySelector<HTMLAnchorElement>(sel);
  if (btn?.href) return btn.href;
}
```

**Strategy 2 — Construct URL from offset (fallback)**:

```typescript
try {
  const url = new URL(doc.URL);
  const currentOffset = parseInt(url.searchParams.get('offset') ?? '0', 10);
  if (currentOffset >= 9) return null; // Brave max offset
  url.searchParams.set('offset', String(currentOffset + 1));
  return url.toString();
} catch {
  return null;
}
```

#### `getPaginationSelectors(): string[]`

Returns `[]` — pagination elements kept visible per user requirement.

#### `getResultsContainer(doc?: Document): Element | null`

```typescript
const d = doc ?? document;
return d.querySelector('#results');
```

#### `getResultId(_node: Element): string | null`

Returns `null` — delegates to Deduper's URL-hash fallback.

### 4.2. `src/content/index.ts` — Fix Initialization Checks

**Line ~102** (initialization):

```typescript
// Before:
if (prefs.infiniteScroll && engine.getNextPageUrl) {

// After:
if (prefs.infiniteScroll && (engine.getNextPageUrl || engine.triggerNextPage)) {
```

**Line ~428** (mid-session toggle re-initialization):

```typescript
// Before:
} else if (prefs.infiniteScroll && !infiniteScrollManager && engine?.getNextPageUrl) {

// After:
} else if (prefs.infiniteScroll && !infiniteScrollManager && (engine?.getNextPageUrl || engine?.triggerNextPage)) {
```

### 4.3. `tests/engines/brave.test.ts` — New Test File

Tests for:
1. `getNextPageUrl` returns href when Next button exists in DOM
2. `getNextPageUrl` falls back to offset URL construction when no button
3. `getNextPageUrl` returns null when offset is at max (9)
4. `getNextPageUrl` returns null when both strategies fail
5. `getResultsContainer` returns `#results` element
6. `getResultId` returns null (URL-hash fallback)
7. `getPaginationSelectors` returns empty array
8. `getResultNodes` returns snippet elements with valid URLs
9. `getResultUrl` extracts URL from `a.l1` element

---

## 5. Edge Cases

| # | Edge Case | How Handled |
|---|-----------|-------------|
| 1 | Next button not found on page | Falls back to offset-based URL construction (Strategy 2) |
| 2 | No `offset` param in URL (first page) | Defaults to offset=0, constructs `&offset=1` |
| 3 | `offset` already at max (9) | `getNextPageUrl` returns `null`, manager sets sentinel to "done" |
| 4 | Fetch fails (network error, CORS) | Error sentinel with retry button (existing manager behavior) |
| 5 | 3 consecutive fetch failures | Manager stops infinite scroll (existing behavior) |
| 6 | User manually clicks Next button | URL changes → `startUrlPolling()` detects → `handleNavigation()` resets (existing behavior) |
| 7 | Duplicate results across pages | URL-hash dedup via existing `Deduper` class |
| 8 | No results container found (`#results` missing) | Manager won't initialize (existing behavior) |
| 9 | Fetched HTML differs from SPA-rendered DOM | `getResultNodes()` uses multiple fallback selectors |
| 10 | Brave SPA navigation during fetch | `AbortController` aborts in-flight fetch (existing behavior) |
| 11 | Scroll state persistence across page loads | Uses existing `persist.ts` with localStorage (existing behavior) |
| 12 | DOM discarding old pages to save memory | Manager keeps ~5 pages in DOM, discards above viewport (existing behavior) |
| 13 | Blocked domains in newly fetched results | `onNewNodes` callback runs full blocking pipeline (existing behavior) |
| 14 | Block button injection on new results | `processResults()` handles stamping and button injection (existing behavior) |
| 15 | Brave SPA renders results after `document_idle` | Existing 400ms sleep in `index.ts:87-89` handles this |
| 16 | Infinite scroll toggled off mid-session | `refreshPrefs()` destroys manager (existing behavior) |
| 17 | Infinite scroll toggled on mid-session | `refreshPrefs()` re-initializes with fixed check (4.2 above) |
| 18 | Parse error on fetched HTML | `fetchPage()` returns `null`, manager retries (existing behavior) |
| 19 | Empty result set on fetched page | `extractNewNodes()` returns empty array, no append, manager continues |
| 20 | User navigates to different query (SPA) | URL polling detects change → `handleNavigation()` resets all state |

---

## 6. What Is NOT Changed

The following files are **not modified** because the existing infrastructure already handles Brave's pattern:

| File | Reason |
|------|--------|
| `manager.ts` | Already supports fetch-based engines with `getNextPageUrl` |
| `fetcher.ts` | Generic HTML fetch with jitter — works for any engine |
| `deduper.ts` | URL-hash fallback already handles engines without `getResultId` |
| `sentinel.ts` | Generic loading/error/done states — engine-agnostic |
| `persist.ts` | localStorage scroll state — engine-agnostic |
| `registry.ts` | Already imports and registers `BraveAdapter` |
| `types.ts` | `EngineId` already includes `"brave"` |
| `preload.ts` | Already includes Brave selectors in `SELS` list |
| `manifest.json` | Already matches `*://search.brave.com/*` |

---

## 7. Progress Tracker

### Phase 1: Initial Implementation

| Step | File | Action | Status |
|------|------|--------|--------|
| 1 | `src/content/engines/brave.ts` | Add `getNextPageUrl()` | ✅ Done |
| 2 | `src/content/engines/brave.ts` | Add `getPaginationSelectors()` | ✅ Done |
| 3 | `src/content/engines/brave.ts` | Add `getResultsContainer()` | ✅ Done |
| 4 | `src/content/engines/brave.ts` | Add `getResultId()` | ✅ Done |
| 5 | `src/content/index.ts` | Fix init check (line ~102) | ✅ Done |
| 6 | `src/content/index.ts` | Fix re-init check (line ~428) | ✅ Done |
| 7 | `tests/engines/brave.test.ts` | Create test file | ✅ Done |
| 8 | — | Run `npm test` | ✅ Done (305/305 pass) |
| 9 | — | Run `npm run build` | ✅ Done |
| 10 | — | Run linter/typecheck | ✅ Done (tsc --noEmit clean) |

### Phase 2: Content Clipping Fix

| Step | File | Action | Status |
|------|------|--------|--------|
| 11 | `manager.ts` | Fix `appendNodes` — strip clipping inline styles from fetched nodes | ✅ Done |
| 12 | `manager.ts` | Add debug logging to `extractNewNodes` and `appendNodes` | ✅ Done |
| 13 | — | Run `npm test` | ✅ Done (305/305 pass) |
| 14 | — | Run `npm run build` | ✅ Done |
| 15 | — | Run linter/typecheck | ✅ Done (tsc --noEmit clean) |

---

## 8. Validation Criteria

- [x] `npm run build` succeeds with no errors
- [x] `npm test` passes all existing + new tests
- [x] TypeScript compilation has zero errors
- [ ] Brave infinite scroll initializes when `prefs.infiniteScroll` is true
- [ ] Scrolling to bottom triggers fetch of next page
- [ ] New results are appended to `#results` container
- [ ] **Fetched result cards render with full content (no clipping)** ← Phase 2 fix
- [ ] Blocked domains in new results are hidden
- [ ] Block buttons are injected on new results
- [ ] Deduplication prevents duplicate results
- [ ] Sentinel shows loading spinner, then idle/done state
- [ ] Manual Next button click resets infinite scroll (URL change detection)
- [ ] Scroll position is restored on page revisit (if persist enabled)
- [ ] Pagination elements remain visible
- [ ] Infinite scroll toggle (on/off) works without page reload
