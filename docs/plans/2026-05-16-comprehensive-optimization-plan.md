# Comprehensive Optimization Plan - Search Hit Hider

**Date:** 2026-05-16
**Status:** Validated and approved
**Confidence:** 95%

## Goals
- Reduce bundle size by ~445 KB (from ~563 KB to ~118 KB)
- Improve runtime performance for 2000+ entry block lists
- Eliminate memory leaks and unbounded growth
- Optimize popup UI for large block lists
- Maintain Firefox 115+ compatibility
- Full test coverage for all optimized code paths

---

## Phase 1: Quick Wins (High Impact, Low Effort)

### 1.1 Fix asset copying in build.js
**File:** `build.js:38-41`
**Problem:** Copies ALL icon files including source files (icon-source.png: 172KB, icon-source-nobg.png: 115KB)
**Fix:** Only copy manifest-required icon sizes (16, 32, 48, 96, 128)
**Savings:** ~289 KB
**Risk:** None - source files never needed at runtime

### 1.2 Replace tldts with lightweight domain parser
**File:** `src/shared/domain-utils.ts`
**Problem:** tldts bundles full Public Suffix List trie (143.6 KB), 94% of content bundle
**Fix:** 
- Implement simple root domain extraction (last 2 parts of hostname)
- Handle common TLDs (.co.uk, .com.au, etc.) with small inline list (~100 entries)
- Remove tldts dependency from package.json
**Savings:** ~140 KB
**Risk:** Low - covers 95%+ cases; users can manually select domain level for edge cases
**Edge cases handled:**
- `.co.uk`, `.com.au`, `.org.nz` etc. via inline suffix list
- IP addresses (no domain extraction needed)
- IDN domains (punycode conversion preserved)
- Single-level domains (localhost) - return as-is

### 1.3 Remove event listener leaks
**Files:** 
- `src/content/index.ts:153` - runtime.onMessage listener never removed
- `src/content/infinite-scroll/manager.ts:396-398` - scroll/beforeunload/pagehide listeners not removed in destroy()

**Fix:**
- Store listener reference, remove on page navigation
- Add listener removal to InfiniteScrollManager.destroy()
**Risk:** None - proper cleanup

---

## Phase 2: Runtime Performance Optimizations

### 2.1 Debounce MutationObserver callbacks
**File:** `src/content/index.ts:134-146`
**Problem:** Callback fires on every DOM mutation, causing hundreds of redundant processResults() calls
**Fix:** Use `queueMicrotask` to collect mutations and process in single batch
**Implementation:**
```typescript
let pendingNodes: Element[] = [];
let microtaskScheduled = false;

observer = new ResultObserver((newNodes) => {
  pendingNodes.push(...newNodes);
  if (!microtaskScheduled) {
    microtaskScheduled = true;
    queueMicrotask(() => {
      const nodes = pendingNodes.splice(0);
      microtaskScheduled = false;
      processResultNodes(nodes);
    });
  }
}, IGNORE);
```
**Impact:** HIGH - reduces DOM processing by 10-100x during rapid mutations
**Edge cases:** 
- Microtask runs before next paint, so no visible delay
- Empty batch handled gracefully
- Node deduplication via Set before processing

### 2.2 Optimize DomainMatcher for 2000+ entries
**File:** `src/content/blocking/matcher.ts`
**Problems:**
- `toASCIIDomain()` creates `new URL()` per hierarchy level (5+ URL constructions per match)
- `getRootDomain()` calls `tldts.parse()` on every match

**Fix:**
- Cache ASCII conversion: call once on full hostname, derive subdomain variants by string slicing
- Only call `getRootDomain()` as absolute last resort (already is, but optimize the path)
- Add hostname cache: `Map<string, MatchResult>` for seen hostnames
- Cache size limit: 1000 entries with LRU eviction

**Impact:** HIGH - reduces URL constructions from 500+ to <50 per page load
**Edge cases:**
- Cache invalidation on entries change (clear cache when block list updates)
- Memory bound prevents unbounded growth
- Cache miss falls through to full matching logic

### 2.3 Fix CSS rule building for large block lists
**File:** `src/content/preload.ts:341-377`
**Problem:** For 2000 domains, generates ~12,000 CSS rules via individual `insertRule()` calls, each triggering style recalculation
**Fix:**
- Build full CSS text as single string
- Use `sheet.replaceSync()` (Firefox 115+ supports this)
- Combine domains into fewer `:has()` selectors using `:is()`
- Example: `:is(div.g):has(:is(a[href*="://domain1.com/"], a[href*="://domain2.com/"], ...))`

**Implementation:**
```typescript
function buildHasRules(curLc: string[], curWild: boolean): void {
  const BATCH_SIZE = 50; // domains per :is() group
  const rules: string[] = [];
  
  for (let i = 0; i < curLc.length; i += BATCH_SIZE) {
    const batch = curLc.slice(i, i + BATCH_SIZE);
    const hrefs = batch.flatMap(d => [
      `a[href*="://${d}/"]`,
      `a[href*="://${d}?"]`,
      `a[href*="://${d}&"]`,
      `a[href*="://www.${d}/"]`,
      `a[href*="://www.${d}?"]`,
      `a[href*="://www.${d}&"]`,
    ]);
    if (curWild) {
      hrefs.push(...batch.flatMap(d => [
        `a[href*=".${d}/"]`,
        `a[href*=".${d}?"]`,
        `a[href*=".${d}&"]`,
      ]));
    }
    rules.push(`:is(${SELS}):has(:is(${hrefs.join(",") })){display:none!important}`);
  }
  
  // Use replaceSync for batch replacement
  if (!hasSheet) {
    hasSheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, hasSheet];
  }
  hasSheet.replaceSync(rules.join("\n"));
}
```
**Impact:** HIGH - reduces style recalculation from 12,000 triggers to ~40
**Edge cases:**
- Firefox < 121 lacks :has() support - rules silently ignored, MutationObserver fallback works
- `replaceSync()` unavailable - fall back to individual `insertRule()` with document fragment
- Selector length limits - batch size prevents exceeding browser limits

### 2.4 Reduce redundant DOM scans
**Files:** `src/content/index.ts:203, 404, 502, 472-502`
**Problems:**
- `handleBlock()` re-scans entire DOM after every block/unblock
- `refreshEntries()` does two full DOM passes
- Multiple `engine.getResultNodes(document)` calls with full `querySelectorAll`

**Fix:**
- Cache result node list: `let cachedNodes: Element[] | null = null`
- Invalidate cache only on DOM mutations (ResultObserver already detects new nodes)
- `refreshEntries()` - merge two passes: process cleared nodes directly instead of re-scanning
- `handleBlock()` - only process nodes that might be affected by the domain change

**Implementation for refreshEntries():**
```typescript
// Instead of:
// 1. getHiddenNodes() -> categorize
// 2. processResults(getResultNodes(document))

// Do:
// 1. getHiddenNodes() -> categorize
// 2. Clear stamps on stillBlocked nodes
// 3. Re-process ONLY cleared nodes + new nodes from ResultObserver
const clearedNodes = stillBlocked.filter(n => !n.getAttribute("data-shh-result"));
processResults(clearedNodes);
```
**Impact:** HIGH - reduces DOM scans from 3-4 per action to 1
**Edge cases:**
- Cache invalidation on dynamic content (infinite scroll adds new nodes)
- Cache must be refreshed when page navigation occurs
- Stale cache handled by fallback to full scan

### 2.5 Optimize earlyHideFromCache
**File:** `src/content/index.ts:547-588`
**Problem:** `lc.some()` iterates all blocked domains O(n) per node. With 2000 domains and 50 results = 100,000 string comparisons
**Fix:** 
- Build a Set from cache domains for O(1) exact match
- For wildcard: build a trie or use suffix matching with Set
- Reuse DomainMatcher instance instead of duplicating logic

**Implementation:**
```typescript
function earlyHideFromCache(): void {
  if (!engine) return;
  try {
    const raw = localStorage.getItem("_shh_cache");
    if (!raw) return;
    const cache = JSON.parse(raw) as { domains?: string[]; wildcard?: boolean };
    const domains = Array.isArray(cache.domains) ? cache.domains : [];
    if (domains.length === 0) return;
    
    // Build matcher from cache (reuses optimized DomainMatcher)
    const cacheEntries: BlockEntry[] = domains.map(d => ({
      domain: d,
      mode: "block",
      enabled: true,
      createdAt: 0,
    }));
    const cacheMatcher = new DomainMatcher(cacheEntries, cache.wildcard !== false);
    
    for (const node of engine.getResultNodes(document)) {
      if (node.getAttribute("data-shh-preloaded") || node.getAttribute("data-shh-result")) continue;
      const url = engine.getResultUrl(node);
      if (!url) continue;
      if (cacheMatcher.match(url).matched) {
        node.setAttribute("data-shh-preloaded", "true");
        node.classList.add("shh-hidden");
        (node as HTMLElement).style.setProperty("display", "none", "important");
      }
    }
  } catch { /* ignore */ }
}
```
**Impact:** MEDIUM - reduces comparisons from O(n*m) to O(m) with optimized matcher
**Edge cases:**
- DomainMatcher construction cost is O(n) but only done once per page load
- Cache corrupt or unavailable - gracefully ignored
- Empty cache - early return

---

## Phase 3: Memory Optimizations

### 3.1 Cap Deduper Set size
**File:** `src/content/infinite-scroll/deduper.ts`
**Problem:** `seen` Set grows unbounded. With maxPages=20 and 10 results/page = 200 entries, but can grow across SPA navigations
**Fix:**
- Add max size cap (500 entries)
- When exceeded, convert to LRU: remove oldest 25% of entries
- Clear in `destroy()`

**Implementation:**
```typescript
private readonly MAX_SIZE = 500;
private readonly EVICT_COUNT = 125; // 25% of MAX_SIZE
private insertionOrder: string[] = []; // track insertion order for LRU

isDuplicate(node: Element, engine: EngineAdapter): boolean {
  const id = this.getNodeId(node, engine);
  if (!id) return false;
  if (this.seen.has(id)) return true;
  
  // Evict oldest entries if at capacity
  if (this.seen.size >= this.MAX_SIZE) {
    for (let i = 0; i < this.EVICT_COUNT; i++) {
      const oldest = this.insertionOrder.shift();
      if (oldest) this.seen.delete(oldest);
    }
  }
  
  this.seen.add(id);
  this.insertionOrder.push(id);
  return false;
}

reset(): void {
  this.seen.clear();
  this.insertionOrder = [];
}
```
**Impact:** MEDIUM - caps memory at ~10 KB instead of unbounded growth
**Edge cases:**
- LRU eviction may cause false negatives (duplicate not detected) - acceptable trade-off
- Memory cap prevents OOM in long sessions

### 3.2 Optimize infinite scroll DOM management
**Files:** `src/content/infinite-scroll/manager.ts`

**3.2.1 Target truncation style stripping**
- `manager.ts:358` - Replace `clone.querySelectorAll('*')` with targeted selector
- Only check elements likely to have truncation: `clone.querySelectorAll('[style*="clamp"], [style*="overflow"]')`
**Impact:** Reduces element iterations from 500+ to ~20 per page

**3.2.2 Track page containers in Map**
- `manager.ts:384-392` - Replace `querySelectorAll('[data-inf-page]')` with Map lookup
- Track: `private pageContainers = new Map<number, HTMLElement>()`
- Avoid `getBoundingClientRect()` reflows by tracking scroll position at append time
**Impact:** Eliminates forced layout reflows after every page append

**3.2.3 Replace URL polling with popstate event**
- `manager.ts:197-203` - Replace `setInterval` with `window.addEventListener('popstate', ...)`
- Also listen to `hashchange` for hash-based navigation
**Impact:** Eliminates 1-second wake-up overhead, reduces CPU usage

### 3.3 Debounce storage writes
**File:** `src/background/service-worker.ts`
**Problem:** Each block/unblock triggers full `saveEntries()` - serializes entire array to JSON and writes to storage
**Fix:**
- Queue changes with debounce (500ms)
- Flush on: debounce timeout, tab close, extension shutdown
- Batch multiple changes into single write

**Implementation:**
```typescript
let pendingSave: ReturnType<typeof setTimeout> | null = null;
let pendingEntries: BlockEntry[] | null = null;

function scheduleSave(entries: BlockEntry[]): void {
  pendingEntries = entries;
  if (pendingSave) clearTimeout(pendingSave);
  pendingSave = setTimeout(() => {
    if (pendingEntries) {
      saveEntries(pendingEntries);
      pendingEntries = null;
    }
    pendingSave = null;
  }, 500);
}

// Flush on shutdown
browser.runtime.onSuspend.addListener(() => {
  if (pendingEntries) {
    saveEntries(pendingEntries);
  }
});
```
**Impact:** MEDIUM - reduces storage writes from N per rapid action to 1
**Edge cases:**
- Extension crash before flush - data loss acceptable (user can re-block)
- Flush on suspend prevents data loss during normal shutdown
- Immediate write for critical operations (bulk import)

### 3.4 Optimize broadcastToContentScripts
**File:** `src/background/service-worker.ts:169-184`
**Problem:** `browser.tabs.query({})` fetches ALL tabs, sends message to each (most fail)
**Fix:**
- Track active tabs: content script sends `TAB_REGISTERED` on init
- Maintain `Set<number> activeTabIds`
- Only broadcast to registered tabs
- Clean up on `tabs.onRemoved`

**Implementation:**
```typescript
const activeTabIds = new Set<number>();

browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "TAB_REGISTERED" && sender.tab?.id) {
    activeTabIds.add(sender.tab.id);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  activeTabIds.delete(tabId);
});

async function broadcastToContentScripts(message: object): Promise<void> {
  for (const tabId of activeTabIds) {
    try {
      await browser.tabs.sendMessage(tabId, message);
    } catch {
      activeTabIds.delete(tabId); // Tab closed or no content script
    }
  }
}
```
**Impact:** MEDIUM - reduces IPC from O(all tabs) to O(active search tabs)
**Edge cases:**
- Tab ID reuse by browser - handled by try/catch and cleanup
- Content script re-injection - sends TAB_REGISTERED again, Set handles duplicates
- Service worker restart - activeTabIds resets, tabs re-register on next message

### 3.5 Fix closure allocation in processResults
**File:** `src/content/index.ts:180-269`
**Problem:** Every blocked result creates 4 closures (doUnblock, doShowOnce, doPermaban, doRehide)
**Fix:** Hoist to module-level functions with explicit parameter passing

**Implementation:**
```typescript
// Module-level handler class
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
  
  doShowOnce = () => {
    showOnce(this.node, this.domain, this.doRehide, this.doUnblock);
  };
  
  doRehide = () => {
    rehideResult(this.node, this.matchResult, this.url, this.prefs.showNotices, 
      this.doShowOnce, this.doUnblock, this.doPermaban);
  };
  
  doUnblock = async () => { /* ... */ };
  doPermaban = async () => { /* ... */ };
}

// In processResults:
const actions = new ResultActions(node, domain, url, matchResult, prefs, engine, refreshMatcher);
hideResult(node, matchResult, url, prefs.showNotices, actions.doShowOnce, actions.doUnblock, actions.doPermaban);
```
**Impact:** LOW - reduces closure allocations, improves GC efficiency
**Edge cases:**
- Class instance still captures references, but more structured and easier to optimize
- Can add `dispose()` method to explicitly null references when node is removed

---

## Phase 4: Popup UI Optimizations

### 4.1 Add virtualization for large block lists
**File:** `src/popup/components/BlockList.tsx`
**Problem:** Renders ALL filtered entries as DOM nodes. With 1000+ domains = 1000+ elements
**Fix:** Implement simple windowing - render only visible rows + buffer

**Implementation:**
```typescript
const ROW_HEIGHT = 36;
const BUFFER_SIZE = 5;

function BlockList({ entries, ... }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(400);
  
  const visibleStart = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleEnd = Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT);
  const start = Math.max(0, visibleStart - BUFFER_SIZE);
  const end = Math.min(entries.length, visibleEnd + BUFFER_SIZE);
  
  const visibleEntries = entries.slice(start, end);
  const topPadding = start * ROW_HEIGHT;
  const bottomPadding = (entries.length - end) * ROW_HEIGHT;
  
  return (
    <div ref={containerRef} onScroll={e => setScrollTop(e.currentTarget.scrollTop)}>
      <div style={{ height: entries.length * ROW_HEIGHT, position: 'relative' }}>
        <div style={{ transform: `translateY(${topPadding}px)` }}>
          {visibleEntries.map(entry => <ListEntry key={entry.domain} entry={entry} />)}
        </div>
      </div>
    </div>
  );
}
```
**Impact:** MEDIUM - 95% reduction in DOM nodes for large lists (1000+ -> ~20)
**Edge cases:**
- Variable row heights - use fixed height for simplicity (acceptable for this UI)
- Search/filter changes - reset scroll position
- Keyboard navigation - scroll into view programmatically

### 4.2 Memoize filtered arrays
**File:** `src/popup/components/App.tsx`, `BlockList.tsx`
**Fix:** Use `useMemo` for filtered arrays
```typescript
const blockedEntries = useMemo(() => 
  entries.filter(e => e.mode === "block"), 
  [entries]
);
```
**Impact:** LOW - reduces transient garbage collection

### 4.3 Fix timer cleanup
**File:** `src/popup/components/BlockList.tsx:33`
**Fix:** Store timer ID and clear in useEffect cleanup
```typescript
useEffect(() => {
  const timer = setTimeout(() => setFeedback(""), 2500);
  return () => clearTimeout(timer);
}, [feedback]);
```
**Impact:** LOW - prevents dangling timers

---

## Phase 5: Preload Optimizations

### 5.1 Optimize tryHide()
**File:** `src/content/preload.ts`

**5.1.1 Cache container check**
- `preload.ts:421` - `el.querySelector(SELS)` runs full selector engine
- Fix: Check by tag name first - if element is not a known result container tag (div, li, section), skip query
- Cache result: add `data-shh-container-checked` attribute

**5.1.2 Check only first meaningful link**
- `preload.ts:426` - `el.querySelectorAll("a[href]")` enumerates all links
- Fix: Use `el.querySelector('a[href]:not([href^="#"]):not([href^="javascript"])')` to get first external link
- Most result cards have exactly one external link

**Impact:** MEDIUM - reduces selector evaluations and URL constructions by 5-10x

### 5.2 Reduce timed rescans
**File:** `src/content/preload.ts:453-479`
**Problem:** 7 full `querySelectorAll(SELS)` sweeps (initial, DOMContentLoaded, 3 setTimeouts, load, pageshow)
**Fix:**
- Keep initial scan (line 453)
- Keep DOMContentLoaded scan (line 460)
- Replace 3 setTimeouts with single `requestAnimationFrame` loop that only checks unprocessed nodes
- Keep load event scan (line 479) - catches deferred scripts
- Keep pageshow handler (line 498) - bfcache restoration

**Implementation:**
```typescript
// Replace setTimeout rescans with single rAF loop
let rafId: number | null = null;
let scanCount = 0;

function scanUnprocessed(): void {
  const nodes = document.querySelectorAll(SELS);
  let foundUnprocessed = false;
  for (const node of nodes) {
    if (!node.getAttribute("data-shh-preloaded") && !node.getAttribute("data-shh-ok")) {
      tryHide(node);
      foundUnprocessed = true;
    }
  }
  scanCount++;
  if (foundUnprocessed && scanCount < 3) {
    rafId = requestAnimationFrame(scanUnprocessed);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  try { document.querySelectorAll(SELS).forEach(tryHide); } catch { /* ignore */ }
  rafId = requestAnimationFrame(scanUnprocessed);
}, { once: true });
```
**Impact:** MEDIUM - reduces redundant full DOM scans, uses rAF for better timing
**Edge cases:**
- rAF may not fire if tab is backgrounded - MutationObserver handles dynamic nodes
- scanCount limit prevents infinite loops
- foundUnprocessed check stops early if all nodes processed

---

## Testing Strategy

### Existing tests to update:
- `tests/matcher.test.ts` - Add tests for hostname cache
- `tests/domain-utils.test.ts` - Update for new root domain extraction (no tldts)
- `tests/infinite-scroll/deduper.test.ts` - Add tests for LRU eviction

### New tests to add:
- `tests/early-hide-cache.test.ts` - Test earlyHideFromCache with Set-based lookup
- `tests/css-rule-building.test.ts` - Test batched :has() rule generation
- `tests/storage-debounce.test.ts` - Test debounced storage writes
- `tests/tab-tracking.test.ts` - Test active tab tracking in service worker
- `tests/mutation-debounce.test.ts` - Test microtask-batched MutationObserver
- `tests/popup-virtualization.test.ts` - Test virtualized list rendering

### Test coverage target:
- All optimized code paths covered
- Edge cases tested (empty lists, corrupt cache, unavailable APIs)
- Performance regression tests (optional, via benchmark assertions)

---

## Implementation Order

1. **Phase 1** (Quick wins) - 1-2 hours
   - 1.1 Fix asset copying (5 min)
   - 1.2 Replace tldts (1-2 hrs)
   - 1.3 Fix listener leaks (15 min)

2. **Phase 2** (Runtime performance) - 3-4 hours
   - 2.1 Debounce MutationObserver (30 min)
   - 2.2 Optimize DomainMatcher (1 hr)
   - 2.3 Fix CSS rule building (45 min)
   - 2.4 Reduce DOM scans (45 min)
   - 2.5 Optimize earlyHideFromCache (30 min)

3. **Phase 3** (Memory optimizations) - 2-3 hours
   - 3.1 Cap Deduper Set (20 min)
   - 3.2 Optimize infinite scroll (1 hr)
   - 3.3 Debounce storage writes (30 min)
   - 3.4 Optimize broadcast (30 min)
   - 3.5 Fix closure allocation (30 min)

4. **Phase 4** (Popup UI) - 2-3 hours
   - 4.1 Add virtualization (1.5 hrs)
   - 4.2 Memoize arrays (15 min)
   - 4.3 Fix timer cleanup (10 min)

5. **Phase 5** (Preload optimizations) - 1-2 hours
   - 5.1 Optimize tryHide (45 min)
   - 5.2 Reduce timed rescans (30 min)

6. **Testing** - 2-3 hours
   - Update existing tests (1 hr)
   - Add new tests (1-2 hrs)

**Total estimated time: 11-17 hours**

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| tldts replacement misses edge cases | Low | Medium | Inline suffix list covers 99% of cases; user can manually select domain |
| CSS replaceSync() unavailable | Low | Low | Fall back to individual insertRule() |
| Virtualization breaks keyboard nav | Medium | Low | Test with keyboard, add scrollIntoView |
| Storage debounce causes data loss | Low | Low | Flush on suspend, immediate write for bulk ops |
| MutationObserver debounce delays hiding | Low | Medium | Microtask runs before next paint, no visible delay |
| Tab tracking misses tabs | Low | Low | Fallback to full query if activeTabIds empty |

---

## Success Metrics

- Bundle size: <120 KB (from ~563 KB)
- Content script bundle: <15 KB (from ~152 KB)
- Memory growth: Capped (no unbounded collections)
- DOM scans per action: 1 (from 3-4)
- Storage writes per rapid action: 1 (from N)
- Popup DOM nodes for 1000 entries: ~20 (from 1000+)
- All tests passing
- No regression in blocking accuracy
