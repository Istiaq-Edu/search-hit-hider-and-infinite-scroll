# Google edge-case audit — Search Hit Hider 1.8.1

Audit of "have all the edge cases been handled?" for the Google engine, run after the
fix pass described in
[`2026-08-30-google-failure-diagnosis.md`](./2026-08-30-google-failure-diagnosis.md).

## Method and its limits

Every claim below is pinned by a test in this repo (`447 tests / 19 files`, all passing).
What I could **not** do is verify against live Google: this IP is bot-gated and gets the
JS-redirect interstitial for every request (HTTP 200, ~92 KB, zero result markup — that is
the exact failure mode from the diagnosis, reproduced independently three times with
different UA / param combinations, consent cookies and `gbv=1`).

So discovery was validated by **differential replay**: feed synthetic SERP shapes to the
real adapter / walker and assert which ones return results. That proves the logic is no
longer pinned to a class name, but it cannot prove the shape matches what Google ships
*today*.

**That caveat mattered more than I expected.** A field capture arrived the same day and
invalidated the central assumption of §3 — see the addendum below, which supersedes §3 and
amends §1.

---

## ⚠ Addendum — field capture 2026-08-30 (supersedes §3, amends §1)

A real Firefox console log changed the diagnosis. Two findings, both invisible to
synthetic replay:

### 1. Google no longer uses `/url?q=` — links are opaque

```html
<a jsname="UWckNb" class="zReHs" href="/goto?url=CAESUQHrOzAVzBTZa…">
```

`CAESUQ…` is a protobuf wrapper (field 1 = 1, field 4 = an 81-byte opaque payload). The
destination **cannot be recovered from the href**. Every "is this link external?" check in
the codebase tested for `/url?q=`, found nothing, and rejected every link — so
`isValidResult()` failed for every result. That is the whole of `processed=0`.

Consequence: **§3 is reversed.** The `<cite>` display URL is no longer a last-resort
fallback, it is the *only* place the domain exists, and discovery now depends on it. My
earlier reasoning (AMP / translated / cached results can display a domain the link does not
point at) is still true, but it is a far smaller risk than the extension being inert.

Second consequence: the **`:has()` CSS layer is dead on this layout**. It matches
`a[href*="://domain/"]`, and the domain is not in the href. `document_start` blocking now
rides entirely on the preload's JS path, which is why the display-URL fallback was added
there too.

### 2. The real nesting is deeper than the walker allowed

```
#rso > div.MjjYud > div.A6K0A > div.tF2Cxc > div.N54PNb > div.kb0PBd
```

`div.tF2Cxc` is the **"Web results" section** here (it holds `<h2>Web results</h2>` plus
every result), not a per-result card. `MAX_DESCENT_DEPTH` was 3, so the walk stopped there
and, failing to descend, offered `div.N54PNb` — the element wrapping **every result** — as
a single match. Had it been accepted, one blocked domain would have hidden the entire page.

Fixed by raising the cap to 6 **and** by adding a rule that is stronger than any depth
value: *a node that still wraps several headings is never accepted as one result, even when
descending failed.*

### Also observed

- `domains=0` / `entries=0` — the block list was empty, so nothing would have been hidden
  regardless. Loading as a **Temporary Add-on** mints a new extension ID, so
  `browser.storage.local` starts empty every time: **re-add your domains after installing.**
- The `Content-Security-Policy`, `OpaqueResponseBlocking`, CORS, `getElementById()` and
  keyframe warnings are all Google's own page code (plus Magic Userscript+). Not ours.

### Regression tests

`tests/engines/google.test.ts` → *"field-captured 2026 layout (opaque /goto?url= links)"*,
built from the verbatim markup. Before the fix: `expected [] to have a length of 3 but got
+0` — the field failure reproduced exactly. After: 3 results, correct domains, per-result
granularity.

---

## 1. Result discovery — the class-name rotation surface

| # | Shape | Status | Pinned by |
|---|-------|--------|-----------|
| A | Classic `#rso > div.MjjYud > div.g` | covered | `A. classic layout … still resolves` |
| B | 2026 layout `#rso > div.MjjYud` with **no** `div.g` | covered | `B. 2026 layout … resolves at whole-result granularity` |
| C | Results outside `#rso` (`#center_col > div#search`) | covered | `C. results outside #rso … resolve` |
| D | Results container **renamed** entirely | covered | `D. renamed results container …` |
| E | Custom-element wrappers (`<g-card>`) | covered | `E. custom-element result wrappers …` |
| F | Stale-but-present `#rso` shadowing a working stream | covered | `F. a stale but present #rso shell …` |
| G | Legacy class anchors, when structure finds nothing | covered | `G. legacy class anchors are still used …` |
| H | **AI Mode (`udm=50`)** | **gap — fails open** | none — see §3 |

A–G are the rotation surface that took the engine down. The fix is ordering: **structural
discovery runs first, class names are a last resort** (`google.ts: getWebNodes`). Class
anchors can therefore never shadow a working structural match again — under the old ladder
they did, and `div.g` rotating away degraded everything to `[]`.

Shape F deserves a note: the old code took the *first* container that existed. A Google
layout that leaves an empty `#rso` in the DOM while rendering into `#search` returned zero
forever. Now each candidate must actually **yield results** to win.

## 2. Exclusions — what must never be hidden

| Case | Status | Pinned by |
|------|--------|-----------|
| Ad containers (`#tads`, `.uEierd`, PLA units) | covered | `ignores ad containers` |
| Pagination & page furniture | covered | `ignores pagination and page furniture` |
| Our own placeholders / sentinel | covered | `ignores our own injected placeholders …` |
| Multi-result section → descend, don't hide the block | covered | `descends into a multi-result section …` |
| Appended infinite-scroll page wrapper | covered | `descends through an appended infinite-scroll page wrapper` |
| **AI Overview / any many-domain aggregate** | **new — covered** | `never hides an AI Overview because ONE of its many cited domains is blocked` |
| Single result with 4+ same-domain sitelinks | covered | `still treats a result with many same-domain sitelinks as one result` |
| Knowledge panel (`#rhs`) | covered | excluded via `GOOGLE_AD_SELECTORS` |
| Consent / `/sorry/` / non-results page | covered | `returns [] without throwing on a non-results page` |

The AI Overview row was a **real gap found by this audit**, and it is the nastiest kind:
silent, and destructive. An AI Overview is one block at the top of `#rso` that cites a dozen
sources and carries no per-result markup. Nothing distinguished it from a single organic
result, so a block list containing *any one* of its cited domains hid the **entire answer**.
It now triggers `looksLikeGoogleAggregate()` (a node citing ≥ 4 distinct hosts), which is
skipped in both the adapter walker and the preload. The guard counts **hosts, not links**,
so a rich result with five sitelinks is still one result — that regression is pinned too.

## 3. URL extraction

| Case | Status | Pinned by |
|------|--------|-----------|
| Direct external `href` | covered | `prefers a direct external href over cite breadcrumbs` |
| `/url?q=` redirect (pre-hydration raw HTML) | covered | `unwraps /url?q= redirect links`, `accepts /url?q= redirect hrefs …` |
| Cite fallback, breadcrumbs stripped | covered (defensive) | `falls back to the cite domain, stripped of breadcrumbs` |
| Internal-link-only node is **not** a result | covered (deliberate) | `does not treat an internal-link-only node as a result` |

Worth being explicit, because it looks like a bug and is not: the cite fallback is
**unreachable through `getResultNodes()`**. `<cite>` is Google's *display* URL, and AMP,
translated and cached results all display a domain the link does not point at. Blocking on
cite text alone could hide an innocent domain, so discovery requires a resolvable outbound
destination. The fallback stays as a last resort for nodes handed in by other code paths
(and has a test), but the engine deliberately will not act on it.

## 4. Pagination & verticals

| Case | Status | Pinned by |
|------|--------|-----------|
| `#pnnext` preferred | covered | `prefers #pnnext` |
| Footer `start=` link not mistaken for next page | covered | `does not mistake a footer start= link for the next page` |
| Hides only the pager, not Google's whole footer | covered | `hides only the pager, not Google's whole footer` |
| Results container resolvable without `#rso` | covered | `resolves a results container even when #rso is absent` |
| Images (`tbm=isch` / `udm=2`) | covered | `switches to image nodes for tbm=isch` |
| News (`tbm=nws`) | covered | `switches to news nodes for tbm=nws` |
| Videos / books / other `tbm=` | **partial** — falls through to the web path | none |
| **AI Mode (`udm=50`)** | **gap** | none |

Two fixes here, both from the audit:

- `getNextPageUrl()` had an unscoped fallback `a[href*="/search?"][href*="start="]:last-of-type`
  that matched unrelated footer/nav links. It is now scoped to the pager (`#navcnt`, `#botstuff`).
- `getPaginationSelectors()` returned `#foot` and `#xjs > div:last-child`, which hide Google's
  *entire footer* — Settings, Privacy, Terms — rather than the pager. Now just `#navcnt` and
  `nav[role="navigation"]`.

## 5. Fetched pages & infinite scroll

| Case | Status | Pinned by |
|------|--------|-----------|
| CAPTCHA `/sorry/` URL | covered | `returns null for a /sorry/ redirect URL` |
| `#captcha` / `form[action*='/sorry']` / `.g-recaptcha` | covered | 3 tests in `fetcher.test.ts` |
| Startpage `/sp/captcha` redirect | covered | `returns null for a Startpage /sp/captcha redirect` |
| **Soft block — known interstitial copy** | **new** | `returns null for Google's JS-redirect soft block (verbatim field response)` |
| **Soft block — unknown copy, no SERP shape** | **new** | `returns null for an interstitial whose wording is not yet known` |
| **Genuine last page (container present, zero results)** | **new** | `accepts a genuine 'no results' page …` |
| POST page chain off-by-one | covered | `requests consecutive pages (2, then 3) …` |
| Dedup of re-served results | covered | `deduper.test.ts` |

This is where the audit changed the most, because my **first attempt was wrong** and the
tests caught it. I had gated the fetcher on "document contains no heading ⇒ soft block".
Three tests failed, and they were right to:

- A legitimate **final page** of results has no results either. Rejecting it would show
  "connection lost, retry" every time the user reaches the end of the list.
- The check was **engine-blind in the wrong direction** — it rejected any page whose result
  nodes use class names it doesn't know, even when the page plainly had outbound result links.

The replacement judges the **shape** of the page, and fails open:

> block if interstitial copy is present, **or** the document has no heading, no results
> container, **and** no link leaving the engine's own site.

A real SERP always has at least one of those; a redirect interstitial has none. The
"connection lost" error is now reserved for pages that genuinely aren't search results.

Also changed: `fetchNextPage()` used to count "fetched fine, zero results" as an empty page,
which ended pagination silently after two tries — exactly the `Fetched page yielded no result
nodes 1 / 2` pair in the original log. It now distinguishes the two cases on the same shape
test and only errors when the page isn't a SERP at all.

## 6. Lifecycle

| Case | Status | Where |
|------|--------|-------|
| Two-step hydration (shell inserted, links added later) | covered | `preload.ts` — `closest()` walk-up + `href` attribute watch |
| Google reuses `div.g` nodes across soft navigations | covered | `data-shh-ok` is cleared before re-evaluation |
| bfcache restore (content scripts don't re-run) | covered | static `preload.css` + `pageshow` re-injection |
| Google's JS strips `data-shh-preloaded` | covered | `attributeFilter` includes it; walk-up re-hides |
| Paused / engine disabled | covered | preload zeroes its domain list; content script skips |
| Background-tab freeze | covered | observer starts before any `await` |

---

## Remaining gaps (accepted, and why)

1. **AI Mode (`udm=50`) is not handled.** It has no `#rso` and no `div.g`, so discovery
   returns zero and the extension simply does nothing on that page. This fails open — no
   crash, nothing wrongly hidden — and the new zero-result diagnostic logs the shape.
   Handling it properly needs a captured AI Mode DOM (§7).
2. **`tbm=vid` and other verticals** fall through to the web path. They mostly share
   `#rso` structure, so this usually works, but it is untested.
3. **No live-Google verification** (see Method). Everything here is replay against
   synthetic shapes.
4. **The cite fallback in `getResultUrl()` is unreachable in the main flow.** Documented
   as intentional in §3, not a defect.

## 7. Closing the live-verification gap

Run this on a Google results page with the extension active and paste the output. It
identifies which of shapes A–H is live and gives everything needed to fix AI Mode without
guesswork:

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
      h3: document.querySelectorAll("h3").length,
      pnnext: document.querySelectorAll("#pnnext").length,
    },
    firstChildSample: container?.firstElementChild?.outerHTML.slice(0, 800) ?? null,
  };
  console.log("[SHH-PROBE]", JSON.stringify(out, null, 2));
  return out;
})();
```

`data-shh-diag` also carries the last 10 `[SHH]` lifecycle lines and survives console
filters, so `processed=N` is readable even if DevTools was opened late.
