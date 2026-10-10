# Show/Hide Audit — "the blocked URL's show/hide — some time blocked urls shows some time doesnt"

**Target:** `search-hit-hider-and-infinite-scroll` v1.8.18 (MV3, Firefox + Chrome)
**Question:** is the "sometimes the blocked result shows, sometimes it doesn't" nondeterminism
reproducible, and if so what causes it?
**Answer:** yes. It is reproduced below, 3 runs × 4 timings × 8 scenarios on Google plus
3 runs × 3 timings × 4 scenarios on DuckDuckGo, driving the **shipped** `preload.ts` and
`content/index.ts` unmodified. Five Google scenarios and three DuckDuckGo scenarios end in
**two different user-visible states purely as a function of how long the background takes to
answer `runtime.sendMessage`.**

---

## 1. Baseline (STEP 1)

```
$ npx vitest run
```

```
 Test Files  2 failed | 27 passed (29)
      Tests  7 failed | 537 passed (544)
   Duration  6.84s
```

All 7 failures are one environment defect, not 7 defects:

| # | Test | Error |
|---|---|---|
| 1 | `tests/debug.test.ts > seedDebugFromCache > turns debug on when the cached flag is true` | `TypeError: localStorage.setItem is not a function` |
| 2 | `tests/debug.test.ts > seedDebugFromCache > leaves debug off when the cached flag is false` | same |
| 3 | `tests/debug.test.ts > seedDebugFromCache > survives a corrupt cache without throwing` | same |
| 4 | `tests/debug.test.ts > seedDebugFromCache > ignores a non-boolean debug field` | same |
| 5 | `tests/infinite-scroll/append-insertion.test.ts > InfiniteScrollManager scroll restoration > does NOT restore on a fresh navigation` | `TypeError: localStorage.clear is not a function` |
| 6 | `… > still restores on reload when extra pages were loaded and content is tall enough` | same |
| 7 | `… > refuses to clamp-jump when the saved offset exceeds the current document` | same |

**No skips. Nothing was fixed.**

### F1 (environment, but load-bearing) — `localStorage` is inert in this repo's test env

A scratch probe printed the shape of the global under `environment: "jsdom"`:

```
typeof localStorage = object
ctor   = undefined
keys   = []
getItem = undefined   setItem = undefined   clear = undefined
```

Node here is **v25.2.1**, which ships its own `globalThis.localStorage` as an own, configurable
accessor. Node's warning (`--localstorage-file was provided without a valid path`) fires on
every run. vitest 1.6's jsdom environment skips keys that already exist on `globalThis`, so
jsdom's working `Storage` is never installed and the global stays Node's method-less stub.

This is not only a test annoyance. `preload.ts:96` and `index.ts:441`/`:919` do
`localStorage.getItem("_shh_cache")` inside `try { … } catch { /* ignore */ }`. With
`getItem === undefined` the call **throws a `TypeError` that the catch swallows**, so under
test the entire pre-paint cache layer silently does nothing and no test can notice. The
`_shh_cache` mechanism — the thing this whole audit is about — has **zero test coverage**.

The harness installs a spec-compliant in-memory `Storage` (`harness/jsdom-env.ts`). That is the
*only* reason the numbers below are obtainable; it is a harness patch, not a product change.

### F2 (environment) — `document.adoptedStyleSheets` is `undefined` in jsdom 29

`injectHidingStyles()` (`index.ts:901-908`) does `[...document.adoptedStyleSheets, sheet]`
inside a `try/catch`. It throws, and the `.shh-hidden{display:none!important}` sheet is silently
never created. `preload.ts:178` `injectBlockingCSS()` falls through to its Layer-B `<style>`
fallback instead. `harness/jsdom-env.ts` gives each document a real backing array so the
production sheets install and the visibility model can read the real rule text back out.

---

## 2. The harness (STEP 3)

```
reports/showhide-audit/
  vitest.config.ts                     own config; include is scoped to this directory
  harness/
    jsdom-env.ts     fresh JSDOM window per load, working localStorage, adoptedStyleSheets
    env-shim.ts      setupFile wrapper around the above
    fake-browser.ts  controllable browser.runtime / storage, virtual messaging latency, LCG jitter
    dom.ts           Google (#rso > div.MjjYud > div.g) and DuckDuckGo (ol > li[data-layout=organic]) SERPs
    visibility.ts    the computed-visibility model
    run-load.ts      drives ONE page load through the real preload.ts + real index.ts
  scenario-matrix.audit.ts        the deliverable table (Google)
  scenario-matrix-simple.audit.ts the same table on DuckDuckGo
  hypotheses.audit.ts             H-a .. H-c, H-e
  hyp-d-rowheight.audit.tsx       H-d, rendering the real BlockList
```

### How to run

```bash
# the deliverable tables + all hypothesis verdicts
npx vitest run --config reports/showhide-audit/vitest.config.ts
#   -> Test Files 4 passed (4) | Tests 13 passed (13)

# the simple-engine (DuckDuckGo) table
#   (SHH_AUDIT_URL switches the jsdom document's identity, which is what
#    preload.ts:120-125 gates the Google-only :has()/opacity cover on)
SHH_AUDIT_URL="https://duckduckgo.com/?q=test" npx vitest run --config reports/showhide-audit/vitest.config.ts
#   -> Test Files 1 passed (1) | Tests 1 passed (1)

# one file at a time
npx vitest run --config reports/showhide-audit/vitest.config.ts reports/showhide-audit/hypotheses.audit.ts
```

The audit files are named `*.audit.ts(x)`, not `*.test.ts(x)`, so a plain `npx vitest run` at
the repo root never picks them up (verified: the baseline is still 544 tests / 7 failures).
`tsconfig.json:24` includes only `src/**/*` and `tests/**/*`, so this directory is outside
`npm run lint:ts` (which is clean). The harness is validated by the 13 assertions it runs, not
by a typecheck.

### What "real" means here

`run-load.ts` imports the shipped modules and lets them run:

- `await import("src/content/preload.ts")` — the real `document_start` IIFE
- `await import("src/content/index.ts")` — the real content script, which calls the real
  `init()`, `earlyHideFromCache()`, `injectHidingStyles()`, `processResults()`,
  `refreshPrefs()`, `refreshEntries()`, `reviveFromBackground()`, `updateCache()`, the real
  `DomainMatcher`, the real `hideResult`/`showOnce`/`restoreResult`, the real
  `GoogleAdapter`/`DuckDuckGoAdapter`, and the real `messaging.ts` on top of the fake `browser`.

**One mock:** `InfiniteScrollManager` (needs `IntersectionObserver`, scroll geometry and
`fetch`, none of which exist in jsdom, and is not on the show/hide path). Its `onAppend`
callback is exposed, so an appended infinite-scroll page still goes through the real
`processResults`.

**Task order mirrors `manifest.json`**, which matters:

| task | what | manifest evidence |
|---|---|---|
| A | `preload.css` + `preload.js` at `document_start`, results stream still empty | `manifest.json:101` |
| B | the page's own JS hydrates the results → **this is the pre-paint window** | — |
| C | `DOMContentLoaded` (optional per scenario) | — |
| D | `content/index.js` → `init()`; the results **are** in the DOM | `manifest.json:151` is `document_idle` (only Startpage's copy, `:224`, is `document_start`) |
| — | the virtual clock runs: messaging, the 2500 ms `withTimeout`, the 2×400 ms retries, `processResults`, `reviveFromBackground` | — |

Because `index.js` is `document_idle`, `earlyHideFromCache()` (`index.ts:916`) does have
results to hide — which is the whole point of it.

### The visibility model

jsdom has no CSS cascade, so `harness/visibility.ts` implements the narrow slice the pipeline
depends on: `display` and `opacity`, with inline `!important` beating every stylesheet rule.
That is exactly the property set the shipped code writes. Crucially, **the rule text is not
hand-written**: it is read back out of

1. the `CSSStyleSheet` objects the production code actually constructed
   (`injectHidingStyles()`, preload's `[data-shh-preloaded]` sheet, the cover sheet, the
   per-domain `:has()` sheet), and
2. the static `src/content/preload.css` file, read from disk at runtime.

A blocked result counts as **visible** only if neither it, nor any ancestor, nor the chain
from its `<h3>` up to it carries a hiding layer. That descendant walk is required: the
`:has()` rules and the opacity cover target `div.g`, which sits *inside* the `div.MjjYud` the
adapter later hands to `hideResult()`. A self+ancestor-only probe reported the blocked result
VISIBLE on the very first frame — a model artifact I found and fixed, and worth recording
because it is exactly the mistake a naive audit would make.

Every load also records, for the target node: which layer is hiding it, on which element,
`data-shh-result` mode, `data-shh-preloaded` position, and whether a `.shh-placeholder`
carrying `.shh-btn-show` exists.

Reported as three **user-visible buckets**, which is what "flipping" is measured on:

| bucket | what the user sees |
|---|---|
| `VISIBLE` | the blocked result is on screen |
| `hidden + Show control` | gone, replaced by `blocked.com · hidden [Show] [Unblock] [Perma]` |
| `hidden, NO control` | gone, with nothing clickable — unrecoverable from the page |

### Controls

| knob | how |
|---|---|
| messaging resolves fast | `latency: 25` (a warm MV3 page answers in tens of ms) |
| messaging resolves slowly | `latency: 600` (±400 ms jitter) |
| messaging loses round 1 | `latency: 3000` + `failFirstRounds: 1` — 3000 > the 2500 ms `withTimeout`, so `index.ts:180` times out and `index.ts:188-195` retries |
| messaging never answers | `latency: "never"` → degraded mode after 2500 + 400 + 2500 ms |
| jitter | deterministic 32-bit LCG, `lcg(seed*7919 + run*104729)()`; 3 runs per cell |
| `_shh_cache` present / contents | seeded directly into the `Storage` before `preload.ts` runs |
| prefs paused / engine disabled | server-side `Prefs` overrides |
| Google-like vs simple | `SHH_AUDIT_URL` — the cover and `:has()` layers are gated on `location.hostname` and Google's class names, so this cannot be toggled at runtime in jsdom |
| page JS drops our inline style | `styleResetAtMs` — models the documented threat the 3-layer defence exists for |

---

## 3. The deliverable: scenario × timing (STEP 4)

`blocked.com` is the result under audit; `safe.com` is a control.

### Google (8 scenarios × 4 timings × 3 runs = 96 page loads)

```
=== DISTINCT USER-VISIBLE FINAL OUTCOMES PER SCENARIO ===
S1: 1 distinct -> hidden + Show control
S2: 2 distinct -> hidden + Show control  ||  VISIBLE
S3: 2 distinct -> hidden, NO control  ||  hidden + Show control
S4: 2 distinct -> hidden, NO control  ||  hidden + Show control
S5: 2 distinct -> hidden, NO control  ||  hidden + Show control
S6: 2 distinct -> hidden + Show control  ||  VISIBLE
S7: 1 distinct -> hidden + Show control
S8: 1 distinct -> hidden + Show control

SCENARIOS WHOSE FINAL USER-VISIBLE STATE DEPENDS ON TIMING ALONE: S2, S3, S4, S5, S6
```

| scenario | timing | 1 prePaint | 3 afterMessaging | 4 afterProcessResults | 5 FINAL |
|---|---|---|---|---|---|
| **S1** warm cache · `block` · active | warm 25ms | hidden by preload (`div.g`) | hidden + Show | hidden + Show | **hidden + Show** (×3) |
| | slow 600ms | hidden by preload | hidden + Show | hidden + Show | **hidden + Show** (×3) |
| | cold 3000ms, r1 lost | hidden by preload | hidden + Show | hidden + Show | **hidden + Show** (×3) |
| | dead BG | hidden by preload | hidden + Show | hidden + Show | **hidden + Show** (×3) |
| **S2** **COLD cache** · `block` · active | warm 25ms | **VISIBLE** | hidden + Show | hidden + Show | **hidden + Show** (×3) |
| | slow 600ms | **VISIBLE** | hidden + Show | hidden + Show | **hidden + Show** (×3) |
| | cold 3000ms, r1 lost | **VISIBLE** | **VISIBLE** | **VISIBLE** | **VISIBLE** (×3) |
| | dead BG | **VISIBLE** | **VISIBLE** | **VISIBLE** | **VISIBLE** (×3) |
| **S3** warm cache · **`pban`** | warm 25ms | hidden by preload | hidden, NO control | hidden, NO control | **hidden, NO control** (×3) |
| | slow 600ms | hidden by preload | hidden, NO control | hidden, NO control | **hidden, NO control** (×3) |
| | cold 3000ms, r1 lost | hidden by preload | hidden + Show | hidden + Show | **hidden + Show** (×3) |
| | dead BG | hidden by preload | hidden + Show | hidden + Show | **hidden + Show** (×3) |
| **S4** **STALE cache** (has it) · list does not | warm 25ms | hidden by preload | hidden, NO control | hidden, NO control | **hidden, NO control** (×3) |
| | slow 600ms | hidden by preload | hidden, NO control | hidden, NO control | **hidden, NO control** (×3) |
| | cold 3000ms, r1 lost | hidden by preload | hidden + Show | hidden + Show | **hidden + Show** (×3) |
| | dead BG | hidden by preload | hidden + Show | hidden + Show | **hidden + Show** (×3) |
| **S5** **STALE `paused:false`** · prefs `pausedGlobally` | warm 25ms | hidden by preload | hidden, NO control | hidden, NO control | **hidden, NO control** (×3) |
| | slow 600ms | hidden by preload | hidden, NO control | hidden, NO control | **hidden, NO control** (×3) |
| | cold 3000ms, r1 lost | hidden by preload | hidden + Show | hidden + Show | **hidden + Show** (×3) |
| | dead BG | hidden by preload | hidden + Show | hidden + Show | **hidden + Show** (×3) |
| **S6** cache **missing** it · list has it | warm 25ms | **VISIBLE** | hidden + Show | hidden + Show | **hidden + Show** (×3) |
| | slow 600ms | **VISIBLE** | hidden + Show | hidden + Show | **hidden + Show** (×3) |
| | cold 3000ms, r1 lost | **VISIBLE** | **VISIBLE** | **VISIBLE** | **VISIBLE** (×3) |
| | dead BG | **VISIBLE** | **VISIBLE** | **VISIBLE** | **VISIBLE** (×3) |
| **S7** warm cache · page JS strips inline `style` @400ms | warm 25ms | hidden by preload | hidden + Show | hidden + Show | **hidden + Show** (×3) — by `preload.css`, not inline |
| | slow 600ms | hidden by preload | hidden + Show | hidden + Show | **hidden + Show** (×3) — by inline |
| | cold / dead | hidden by preload | hidden + Show | hidden + Show | **hidden + Show** (×3) |
| **S8** warm cache · user pauses from the popup mid-session | all four | hidden by preload | hidden + Show | hidden + Show | **hidden + Show** (×3) — correctly revealed by `refreshPrefs` |

**The deliverable row — S2, same user state, two outcomes:**

> User has `blocked.com` blocked. `_shh_cache` is cold (`domains: []`), which happens after a
> fresh install, after a cache write failure, or whenever the block list was changed somewhere
> no content script runs (import/export, the options page, a `storage` sync).
> * Background answers in 25 ms → `processResults` runs with the real list → **hidden + Show**.
> * Background takes > 2500 ms → `recoverStateFromCache()` builds `entries` from the *cold*
>   cache, i.e. `[]` → nothing to block → and `reviveFromBackground()` never gets an answer →
>   **the blocked result stays VISIBLE for the whole session.**

`_shh_cache` after the load confirms the two branches diverge permanently:

```
--- S2 COLD cache · blocked.com = block · not paused ---
  {"domains":["blocked.com"],...}      (warm/slow runs — healed)
  {"domains":[],...}                    (cold/dead runs — still cold, so the next load repeats it)
```

### DuckDuckGo — the same intermittency, so it is not a Google-cover artifact

```
D1: 1 distinct -> hidden + Show control
D2: 2 distinct -> hidden + Show control  ||  VISIBLE
D3: 2 distinct -> hidden, NO control  ||  hidden + Show control
D4: 2 distinct -> hidden, NO control  ||  hidden + Show control
SIMPLE-ENGINE SCENARIOS WHOSE FINAL VISIBILITY DEPENDS ON TIMING: D2, D3, D4
```

The `:has()` rules and the opacity cover are Google-only by construction
(`preload.ts:120-125`, `:236-239`, `:513`), so on DuckDuckGo the *only* pre-paint protection
is `[data-shh-preloaded]` plus the preload's MutationObserver — and the intermittency is
unchanged. **The cause is the pipeline's state machine, not the cover.**

---

## 4. Hypotheses (STEP 4)

### H-a — degraded mode renders a permaban as a regular block — **CONFIRMED**

`recoverStateFromCache()` (`index.ts:439-464`) rebuilds entries from `_shh_cache`, which
stores **domains only**. Line 450 hard-codes the mode:

```ts
entries: domains.map((d) => ({
  domain: d, mode: "block" as const, enabled: true, createdAt: 0,
})),
```

| timing | `data-shh-result` | class | placeholder |
|---|---|---|---|
| warm 25 ms | `pban` | `shh-pban` | **none** |
| cold / dead | `block` | `shh-hidden` | **yes — Show / Unblock / Perma** |

The same permabanned domain renders as a "hidden" strip with three buttons instead of
vanishing, purely because the background was slow. This is S3's flip.

Worse: `reviveFromBackground()` (`index.ts:364`) re-runs `processResults`, but
`processResults` bails at `index.ts:561` on `if (node.getAttribute("data-shh-result")) continue;`
— the node is already stamped `block`. **The permaban is never restored on that page.** The
wrong state persists until reload.

### H-b — early return after the preload already hid — **CONFIRMED, both halves, and permanent**

**Half 1 (the unrecoverable hidden state).** `init()` returns at `index.ts:222`
(`if (!engineActive) return;`) *before* `updateCache()` at `index.ts:251` and *before*
`browser.runtime.onMessage.addListener` at `index.ts:295`. Meanwhile `earlyHideFromCache()`
(`index.ts:916`) has already hidden, and it only consults `cache.paused`, never the prefs the
background just returned.

`_shh_cache` says `paused:false, domains:["blocked.com"]`; prefs say `pausedGlobally:true`:

```
@1-prePaint        t=0ms   visible=false  mode=-          show=false  trapped=true
@2-afterFirstAwait t=40ms  visible=false  mode=-          show=false  trapped=true
@3-afterMessaging  t=70ms  visible=false  mode=-          show=false  trapped=true
@5-afterRevive     t=130ms visible=false  mode=-          show=false  trapped=true
      node class="MjjYud shh-hidden" result=null preloaded=true style="display: none !important;"
      prevSibling=none
```

`listenerAttached = false`, and `_shh_cache` is still `paused:false`. A two-load test feeds
load 1's cache back in as load 2's starting cache — literally what the next navigation does:

```
load 1: visible=false controls=false listener=false cache={"domains":["blocked.com"],"wildcard":true,"paused":false,"debug":false}
load 2: visible=false controls=false listener=false cache={"domains":["blocked.com"],"wildcard":true,"paused":false,"debug":false}
```

Byte-identical. **The trap repeats on every reload, for as long as the pause stands and no
search tab is open when the cache is written.** The paused user sees results silently vanish
with no Show, no Unblock, and no block button.

**Half 2 (the inverse).** Same user state, dead background: `recoverStateFromCache()`
substitutes `DEFAULT_PREFS`, which are not paused, so the user's pause is **not honoured at
all** and the result is blocked *with* controls. This is S5's flip.

**Half 3.** A cold cache + dead background leaves the result **VISIBLE** (S2/S6).

### H-c — stale `_shh_cache` — **CONFIRMED, and worse than hypothesised**

Cache still lists `blocked.com`; the list does not.

`@3-afterMessaging` shows the wrapper *was* correctly un-hidden:

```
@3-afterMessaging t=70ms  node class="MjjYud" result=null preloaded=null style=""
                                div.g preloaded=true style="display: none !important;"
@5-afterRevive    t=130ms node class="MjjYud" result=null preloaded=null style=""
                                div.g preloaded=true style="display: none !important;"
                                prevSibling=none
FINAL block button inside the hidden subtree: true
FINAL _shh_cache: {"domains":[],...}
```

`index.ts:607-611` un-hides **only the node it was handed**:

```ts
if (node.getAttribute("data-shh-preloaded")) {
  (node as HTMLElement).style.removeProperty("display");
  node.removeAttribute("data-shh-preloaded");
  node.classList.remove("shh-hidden");
}
```

The adapter's granularity is the `div.MjjYud`; the preload's own `tryHide()` marked the inner
`div.g` (it matches `SELS`, `preload.ts:345`). So the wrapper is revealed, the content is not,
the block button that `injectButtonForResult()` then adds lands *inside* the hidden subtree and
is itself invisible, and there is no placeholder. The result is gone with nothing to click
until the next reload — and the next reload is clean, which is why it looks intermittent.

The same class of bug was already found and fixed twice for the *reveal* direction —
`showOnce` (`hider.ts:115-119`) and `restoreResult` (`hider.ts:188-192`) both clear
`node.querySelectorAll("[data-shh-preloaded]")`, pinned by
`tests/blocking/restore-inner-preloaded.test.ts` ("A2 F2a"). **`index.ts:607-611` was never
given the same treatment.**

The converse also holds and is benign: a cache that is *missing* a domain the list has (S6)
means nothing is pre-hidden, and the result shows until `processResults` (S6's other flip).

### H-d — `ROW_HEIGHT = 36` desynchronisation — **PARTIALLY CONFIRMED (real, but conditional)**

**jsdom cannot do layout.** `getBoundingClientRect().height` and `offsetHeight` are `0` for
every element, so the painted row height is not measurable here. What *is* measurable is the
box model the component declares, read from inline `style` attributes (not
`getComputedStyle`, which cannot resolve `var(--border)` and reports
`borderBottomWidth: "medium"`).

```
H-d rows rendered          = 22  (entries=60, viewport=400)
  expected by the formula = 22  (ceil(400/36)+2*5)
  empty spacers            = ["0px","1368px"]   bottom = (60-22)*36, as designed
H-d wrapper box            = height:36px  overflow:""  flexShrink:""
H-d row box                = padding:5px 10px  borderBottom:1px solid var(--border)  boxSizing:content-box
H-d flex items             = input[fs=13px fixed] total=13.0  span[fs=12px] total=14.4
                            span[fs=10px] total=12.0  button[fs=10px] total=16.0  button[fs=14px] total=14.0
H-d tallest item           = 16px
H-d REAL ROW HEIGHT        = 16 + 5 + 5 + 1 = 27px
H-d ROW_HEIGHT             = 36px   slack per row = 9px
H-d break-even: row=27px at a 16px root; ROW_HEIGHT=36 is exceeded at a root font size of
               about 25px (20px -> 32px, 24px -> 36px, 32px -> 44px)
```

**Assumption used, stated because jsdom cannot do layout:** `line-height: normal ≈ 1.2 ×
font-size`, and `box-sizing: content-box` (the CSS default; neither component sets it). Every
dimension in `ListEntry` is in `px` with an explicit `font-size`, so nothing wraps (the domain
span is `nowrap` + `ellipsis`, verified) and the row scales linearly with the user's root font
size / zoom / minimum-font-size setting.

**Verdict.** At default metrics the fixed 36 px box is 9 px *taller* than the row: nothing
overlaps, nothing clips, and `visibleStart = floor(scrollTop / 36)` maps correctly. From a
~25 px root font upward the row exceeds 36 px while both the row wrapper (`BlockList.tsx:234`)
and the top/bottom spacers (`BlockList.tsx:232`, `:245`) still assume 36. The wrapper carries
**no `overflow` and no `flex-shrink` guard** (verified: both empty), so a taller row overlaps
its neighbour instead of scrolling, and the scroll maths desynchronises permanently for that
session. Conditional, but a real accessibility bug at large text sizes, and cheap to make
robust by measuring one row with a `ResizeObserver` instead of hard-coding.

### H-e — `refreshEntries()` await window — **REFUTED as stated, but a worse sibling is CONFIRMED**

**The specific claim is not reproducible in jsdom.** `refreshEntries()`'s dynamic
`await import("./blocking/hider")` (`index.ts:834`) is preceded by `refreshMatcher()` at
`index.ts:828`, so by the time that yield happens the matcher is already fresh; and with a
warm module registry the `import()` resolves within a single microtask, so there is no
meaningful window to interleave into. I am calling this **INCONCLUSIVE rather than refuted**:
under vitest's warm module cache the window is one microtask, whereas in a real browser the
first dynamic import of a chunk still costs a task. It is very likely a real but *narrow*
window, and I have no way to widen it here.

**What I can demonstrate is much worse and lives in the same function.**
`refreshEntries()` only re-processes `getHiddenNodes()` (`index.ts:839`) — nodes that are
*already* stamped. A domain **added** by `LIST_UPDATED` is therefore never applied to results
that are already on screen:

```
before:             visible=true
appended node:      class="MjjYud" result=null btn=1
appended visible:   true
first result after: visible=true result=null box=false
order: appended during refreshEntries' await window -> refreshEntries settled -> +2s later
```

The appended node carries `data-shh-btn` and **not** `data-shh-result` — proof it was stamped
by a matcher that did not yet contain `blocked.com`. `_shh_cache` *was* updated
(`{"domains":["blocked.com"],...}`), so the next page load blocks it correctly. The page the
user is looking at keeps showing it, indefinitely, and there is no rescan to fix it
(`index.ts:871` re-processes only `clearedNodes`). Two `blocked.com` results end up on one
page, one hidden and one visible.

The same test also positively demonstrates the stale-matcher half of H-e: the observer batch
*did* land inside `refreshEntries()`'s await window, and *did* stamp with the old matcher.
The consequence survives, though, because of the missing rescan — not because of the
`import()` yield.

---

## 5. Ranked defects

| # | severity | file:line | defect | minimal fix |
|---|---|---|---|---|
| **D1** | **critical** | `src/content/index.ts:826-874` | `refreshEntries()` never rescans the page, so a domain added while a tab is open is not applied to results already on screen (H-e). Two results from the same blocked domain on one page, one visible. | After the existing re-stamp, add `processResults(getCachedResultNodes())` guarded by `invalidateNodeCache()` first — the same call `handleBlock` already makes at `index.ts:728`. Cost is one full scan per list change, which is a user-initiated event. |
| **D2** | **critical** | `src/content/index.ts:222` (with `:251`, `:295`) | `init()` returns before `updateCache()` and before the `onMessage` listener, so a paused/disabled engine leaves `_shh_cache` saying `paused:false` forever. The preload hides on every reload and the paused user gets no Show, no Unblock, no block button (H-b). Reproduced across two consecutive loads with a byte-identical cache. | Move `updateCache()` above the `engineActive` check (it already computes `paused` itself, `index.ts:990-993`), and register the `onMessage` listener before any early return. Two lines, no behaviour change on the happy path. |
| **D3** | **high** | `src/content/index.ts:607-611` | The stale-cache reveal clears only the node the adapter offered, never inner `[data-shh-preloaded]` marks, so a stale cache leaves the result permanently invisible with the block button trapped inside the hidden subtree (H-c). | Reuse the exact pattern already shipped for `showOnce`/`restoreResult` (`hider.ts:115-119`, `:188-192`): after clearing self, also `node.querySelectorAll("[data-shh-preloaded]")` and strip `display` + the attribute + `shh-hidden`. |
| **D4** | **high** | `src/content/index.ts:439-464` (line 450) | Degraded mode rebuilds every entry as `mode:"block"`, so a permaban renders as a "hidden" box with Show/Unblock/Perma (H-a) — and `reviveFromBackground` cannot fix it, because `processResults` skips the already-stamped node at `index.ts:561`. | Write `mode` into `_shh_cache` (it is already a JSON blob; `updateCache` at `index.ts:995` is the only writer) and have `recoverStateFromCache` read it. Separately, make `reviveFromBackground` call `restoreResult` + re-stamp, or reuse `refreshEntries`'s clear-then-reprocess loop at `index.ts:859-871`. |
| **D5** | **medium** | `src/content/index.ts:180`, `:196-206` | Degraded mode's only source of truth is `_shh_cache`, which stores `domains` only and is *empty* on a fresh install or after a cache-write failure. A cold cache + a slow background means the blocked result is **never hidden at all** for that session (S2, S6). | `storage.local` is already a declared permission (`manifest.json:228`) and is the real source of truth — read `shh_entries` synchronously in `recoverStateFromCache` as a second source instead of falling back to `[]`. |
| **D6** | **low** | `src/content/index.ts:208` | `shhLog("state loaded …")` sits in the `else` of the `catch`, so the healthy path logs nothing between `init start` and `engine=…`. A field report of "nothing happened" is indistinguishable from "it loaded fine" in `<html data-shh-diag>`. | Hoist the log out of the `else`, next to `shhLog("init start")` at `:177`. |
| **D7** | **low** | `src/content/index.ts:273` | `init done: processed=N` calls `getCachedResultNodes()` *after* `processResults` invalidated the cache, so `N` is "results still un-stamped", not "results processed". It reported `processed=0` on a load that processed two, and `processed=1` on a load that processed two. | Capture the count before the call: `const n = getCachedResultNodes().length; processResults(...); shhLog(\`init done: processed=${n} …\`)`. |
| **D8** | **low** | `src/popup/components/BlockList.tsx:17`, `:112-117`, `:234` | Fixed 36 px row box with no `overflow`/`flex-shrink` guard. Correct at default metrics (measured 27 px, 9 px slack) but desynchronises from a ~25 px root font upward, overlapping rows and breaking `scrollTop → index` (H-d). | Measure one rendered row with the existing `ResizeObserver` (`BlockList.tsx:101`) and store the height in state instead of the constant; add `overflow:hidden` on the wrapper as a belt-and-braces guard. |
| **D9** | **info** | `vitest.config.ts` / repo test env | `localStorage` is Node 25's method-less stub inside vitest's jsdom env, so all 7 baseline failures happen **and** the entire `_shh_cache` layer is silently inert under test (F1). | Add a `setupFiles` shim (the harness's `harness/jsdom-env.ts` is a working one) and pass `--localstorage-file` or drop the Node webstorage flag. Independently: add a `test.setupFiles` entry is the real fix; the 7 failures are the visible symptom. |

### On H-e's `import()` yield specifically

If someone wants to close the narrow window anyway, the one-line change is to hoist the import
above the first `await` in `refreshEntries` — but fix **D1** first, because D1 is what makes
the stale stamp *permanent*, and D1 is provable today.

---

## 6. What I could not test in jsdom — stated explicitly

- **Real painted row height (H-d).** No layout engine. I measured the declared box model and
  stated the `line-height` assumption; the `≈25 px root font` break-even is derived, not
  observed.
- **Whether a real paint actually occurs between the pre-paint window and
  `earlyHideFromCache()`.** `document_idle` timing relative to first paint is a browser
  scheduling fact. The harness shows the *DOM state* at each boundary; whether a frame
  reached the screen in between is not observable here. This matters for how visible the S2
  flash is, not for whether the S2 final state is wrong.
- **Google's real `div.MjjYud > div.g` markup.** Fixtures follow the repo's own
  `tests/engines/google.test.ts:18-52`. The *level mismatch* that D3 depends on is real by
  construction (the adapter resolves the stream by ID and offers the top-level child; the
  preload's `SELS` matches `div.g`), but the exact nesting on today's live SERP may differ.
- **The `await import()` window in `refreshEntries` (H-e).** One microtask under a warm module
  registry. INCONCLUSIVE, not refuted.
- **bfcache / `pageshow` restoration.** The `preload.ts:696-740` handler needs a real
  `PageTransitionEvent` with `persisted: true` and a frozen/thawed execution context. Out of
  reach; not exercised.

## 7. Corrected results worth recording

Two conclusions I had to retract, both model bugs, both the kind a reviewer should look for:

1. **S7 initially reported the blocked result VISIBLE after the page stripped our inline
   style.** That was my visibility model, not the product: jsdom's
   `CSSStyleDeclaration.getPropertyValue()` returns `"none !important"` rather than `"none"`,
   so the comparison against `preload.css`'s rule never matched. After normalising the value,
   S7 is **hidden at every timing** and the 3-layer defence in `index.ts:944-956` /
   `hider.ts:44` **works as designed**. The `:has()` sheet, `[data-shh-preloaded]` and
   `.shh-hidden` all hold with the inline style gone.
2. **My first probe measured the `div.MjjYud` only** and therefore reported the pre-paint
   `:has()`/cover hides as failures. The pre-paint layers act on the inner `div.g`; a
   self+ancestor-only visibility probe cannot see them. Fixed by walking the `<h3>`-to-node
   chain, and the reason D3 was found at all.

I also initially imported the content script at `document_start`, before hydrating the
results, which made `earlyHideFromCache()` a no-op and the whole pre-paint question invisible.
`manifest.json:151` (`run_at: document_idle`) is the correction.
