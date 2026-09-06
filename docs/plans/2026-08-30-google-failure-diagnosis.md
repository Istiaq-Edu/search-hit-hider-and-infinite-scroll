# Google failure diagnosis — v1.8.0

Date: 2026-08-30 · Evidence: user console log (Firefox, MV3 WebExtension v1.8.0, `www.google.com/search`)

## TL;DR

**One root cause explains every symptom.** `GoogleAdapter.getResultNodes()` returns `[]` on the
user's SERP. Every Google feature — hiding, placeholders, block buttons, and infinite-scroll
page extraction — routes through that single method, so when it returns nothing the whole engine
is inert while the boot sequence still logs as healthy.

Node discovery is anchored on Google's **rotating, obfuscated class names** (`div.g`,
`div.tF2Cxc`) plus a `#rso`-only structural fallback. Those same two stale anchors are hardcoded
in two more places (preload `:has()` rules and the Google cover CSS), so there is no independent
layer left to fall back on. Google is the only engine in the codebase built this way — every other
engine's selectors are attribute- or id-based.

## 1. What the log proves

| Log line | What it rules in / out |
|---|---|
| `[SHH-preload v1.8.0] host=www.google.com domains=71 paused=false` | Preload runs at `document_start`, block list loaded, **not paused**. Injection is fine. |
| `engine=google active=true pausedGlobally=false toggle=true entries=71` | Engine detected, enabled, 71 rules loaded. **Config/messaging is fine.** |
| `[InfiniteScroll] Initialized …` + a next-page URL was found (`#pnnext`) | A real SERP with pagination; `getResultsContainer()` resolved. |
| **`init done: processed=0`** | **The failure.** `processed` = `getCachedResultNodes().length` = `GoogleAdapter.getResultNodes(document)`. It returned **zero** nodes. |
| **`[InfiniteScroll] Fetched page yielded no result nodes` ×2** | `fetchPage()` succeeded (parsed a document), then `extractNewNodes()` → `getResultNodes(fetchedDoc)` → **zero** again. After 2 empties `hasMore=false` → infinite scroll is dead for the session. |

**Both symptoms share one cause.** Verified in code: `init()` calls `startResultObserver()` *after*
the only `await` for non-SPA engines, and Google has no `await sleep()` — so between
`startResultObserver()` (index.ts:221) and `processResults()` (index.ts:243) there is **no task
boundary**. The MutationObserver cannot have fired and stamped anything. Therefore `processed=0`
is a genuine zero-match, not "already processed".

Corroboration: unmatched results are *not* stamped. `injectBlockButton()` only sets
`data-shh-btn`, never `data-shh-result`, and `isValidResult()` only skips `data-shh-result`.
So a page with any visible, unblocked result would report `processed > 0`.

## 2. Root cause 1 (primary) — selector ladder is anchored on rotating class names

`src/content/engines/google.ts:56-68`:

```
div.g:not(.g .g)  →  div.tF2Cxc:not(.tF2Cxc .tF2Cxc)  →  #rso > div > div  →  #rso > div
```

- **First-non-empty-wins**, filtered by `isValidResult()`.
- The first two entries are Google **build-generated, rotation-prone class names**. `tF2Cxc` is
  exactly the hash-shaped class Google retires; `div.g` is being dropped in newer layouts.
  The project's own bundled upstream userscript documents this drift in its header:
  `// 1-22-2026 div#center_col > div > div#search > div > div#rso > div` — and keeps a far wider
  net (`#res #rso div.g`, `#center_col>div>#search>div>#rso>div`,
  `[data-async-context^="query:"] div.g`, `g-card`, …).
- The only class-agnostic fallbacks (`#rso > div > div`, `#rso > div`) **both require `#rso`**.
  If the results container id changed, or its children are not plain `div`s, the ladder returns
  `[]` and there is no escape hatch.

The same anchors are duplicated in two more places, so nothing covers for the adapter:

- `src/content/preload.ts:325-331` — `SELS` (drives the `:has()` CSS blocking layer)
- `src/content/preload.ts:227-230` — `GOOGLE_COVER_SEL` (drives the anti-flicker cover)

That is why the failure is **total on Google and nowhere else**: on Google, all three layers
depend on the same two class names.

### Evidence — replaying the ladder against candidate DOM shapes

`GoogleAdapter.getWebNodes()`/`isValidResult()` logic ported verbatim and run under jsdom:

| DOM shape | Matched by | Valid nodes | Result |
|---|---|---|---|
| A. classic `#rso > div.MjjYud > div.g` | `div.g:not(.g .g)` | 1 | works |
| B. 2025-26 `#rso > div.MjjYud` (no `div.g`) | `#rso > div > div` | 3 | **partial** (see §4) |
| C. results outside `#rso` (`#center_col > div#search > div`) | — | **0** | **broken** |
| D. `#rso` renamed | — | **0** | **broken** |
| E. `#rso` children are custom elements (`g-card`) | — | **0** | **broken** |
| F. result has no `h3` and no external href | — | **0** | **broken** |

The user's page is in the C/D/E/F class. §6 gives a one-liner to determine which.

## 3. Root cause 2 — infinite scroll: fetched Google HTML carries no results

`fetchPage()` (`src/content/infinite-scroll/fetcher.ts`) validates only:

```js
if (!response.ok) return null;
// captcha heuristic: /sorry/ · /sp/captcha · #captcha · form[action*='/sorry'] · .g-recaptcha
```

It **never asserts that the parsed document actually contains results**, and its captcha
heuristic does not cover Google's modern **JS-gated interstitial** — which returns
`HTTP 200`, a full ~92 KB document, zero result markup, and none of those markers.

Verified live today (2026-08-30), three different UA/param combinations:

```
[q=openai&start=10&hl=en&gl=us]  HTTP 200 size=92939 -> div.g=0 rso=0 h3=0 /url?q==0
[q=openai&start=10&gbv=1]        HTTP 200 size=92650 -> div.g=0 rso=0 h3=0 /url?q==0
visible text: "Please click here if you are not redirected within a few seconds."
```

Consequence: a soft-block page is classified as "a page with no results",
`consecutiveEmptyPages` hits 2, and `hasMore=false` — infinite scroll silently and permanently
disables itself, with no error surfaced to the user or the console.

## 4. Root cause 3 (latent) — wrong hide granularity when `div.g` is absent

The ladder is ordered `#rso > div > div` **before** `#rso > div`. In the 2025-26 shape
(`#rso > div.MjjYud` with no `div.g`), the grandchild selector matches first and returns an
**inner column**, not the whole result block. Verified:

```
#rso > div.MjjYud
  ├── div.YuVMp   ← not matched (no h3/link)
  └── div.hlcw0c  ← matched: isTopLevelResult = false
top-level result blocks: 1 (class MjjYud)
```

So once `div.g` disappears, hiding a result removes only the sub-block holding the title/link
and leaves the rest of `div.MjjYud` (site links, thumbnail, favicon column) rendered — an
empty shell where the result used to be. This is the *next* bug the user hits even if the ladder
starts matching again.

## 5. Root cause 4 — `processed=N` is not a health signal

`getResultNodes()` is used both to *find work* and to *count* (`index.ts:253`). Because
`isValidResult()` rejects any node already carrying `data-shh-result`, the counter shrinks as
results are stamped and reads `0` both for "nothing found" and for "everything already handled".
That ambiguity is precisely what made this log hard to read.

## 6. Ruled out — the console noise is not the cause

- **CSP `script-src 'nonce-…' 'strict-dynamic'` / `script-src-attr`** — Google's own inline
  handler (`_rtf(this)` in `search`). Our content script runs in the isolated world and every
  button uses `addEventListener` (`block-button.ts:29`), never an inline `on*` attribute. CSP is
  not blocking us.
- **CORS / OpaqueResponseBlocking / `data:text/plain;base64,Cg==`** — Google's own telemetry
  (`ogads-pa.clients6.google.com`, `ep1.adtrafficquality.google`) and other userscripts.
- **Font timeout, `Empty string passed to getElementById()`, `Keyframe property value ""`** —
  Google's page code.
- **Preload / bfcache / flicker layers** — all reported healthy (`domains=71 paused=false`).

## 7. Recommended fixes (priority order)

1. **Make Google node discovery structural, not class-based.** Resolve the results stream
   container through a candidate list (`#rso`, `#center_col #search`, `[data-async-context^="query:"]`,
   `#res`), then take its **top-level children** (`> *`, not just `> div`) as results, and filter
   with `isValidResult()`. Put this *first* in the ladder — before any class-name selector — so
   obfuscated-class rotation can never take the engine down. Keep `div.g` / `div.tF2Cxc` only as
   tie-breakers for nested layouts.
2. **Collapse the three duplicate selector sets into one shared constant** (`preload.ts` `SELS`,
   `GOOGLE_COVER_SEL`, adapter ladder) so one edit keeps CSS and JS in lockstep.
3. **Fix hide granularity**: always resolve a matched node up to the **top-level child of the
   results container** before hiding.
4. **Give `fetchPage()` a result assertion**: after parsing, if `engine.getResultNodes(doc).length === 0`,
   treat it as a failure (return `null`) and log the reason — instead of counting it as an empty
   page. Extend the captcha heuristic to detect Google's JS-gated redirect interstitial.
5. **Add a Google fallback that does not depend on fetched HTML**: implement
   `triggerNextPage()` (click `#pnnext` / "More results", wait for the DOM to grow) and prefer it
   over `fetch()` for Google, as already done for SPA engines.
6. **Instrument the zero case.** When `getResultNodes()` returns `[]` on an engine that matched,
   log the container probe (which candidate container resolved, its child tags, `div.g` /
   `tF2Cxc` / `h3` counts, and a 600-char sample of the first child). Without this, the next
   rotation is equally invisible.
7. **Separate "find work" from "count"** so diagnostics stay honest.

## 8. To finish the fix precisely — capture the live DOM shape

I could not fetch a real Google SERP from this environment: Google bot-gates this IP and returns
the JS-gated interstitial described in §3 for every request. Run this on a Google results page
(with the extension active) and paste the output:

```js
(() => {
  const q = (s) => document.querySelector(s);
  const rso = q("#rso");
  const container = rso || q("#center_col #search") || q("[data-async-context^='query:']") || q("#res") || q("#center_col");
  const out = {
    url: location.href,
    diag: document.documentElement.getAttribute("data-shh-diag"),
    hasRso: !!rso,
    containerResolved: container ? (container.id || container.className || container.tagName) : null,
    containerChildren: container ? [...container.children].slice(0, 6).map(c => c.tagName.toLowerCase() + (c.className ? "." + String(c.className).slice(0, 40) : "")) : null,
    counts: {
      "div.g": document.querySelectorAll("div.g").length,
      "div.tF2Cxc": document.querySelectorAll(".tF2Cxc").length,
      "div.MjjYud": document.querySelectorAll(".MjjYud").length,
      "h3": document.querySelectorAll("h3").length,
      "pnnext": document.querySelectorAll("#pnnext").length,
    },
    firstChildSample: container?.firstElementChild?.outerHTML.slice(0, 800) ?? null,
  };
  console.log("[SHH-PROBE]", JSON.stringify(out, null, 2));
  return out;
})();
```

`containerChildren` + `firstChildSample` identifies which of shapes C/D/E/F is in play and lets
fix #1 be written against the real markup instead of guesswork.
