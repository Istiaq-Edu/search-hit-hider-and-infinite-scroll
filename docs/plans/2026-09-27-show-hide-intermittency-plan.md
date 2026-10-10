# Show/hide intermittency — remediation plan v2 (v1.8.19)

> **Supersedes v1 of this document.** v1's central diagnosis was **wrong** and its
> primary fix was a **no-op**. Three adversarial reviews (fix-correctness,
> verification-strategy, regression-risk-against-field-history) refuted it; two
> did so independently. Section 6 records exactly what was wrong and how, because
> the failure mode matters more than the fix.
>
> **Read D8 before D6.** D6 shipped a real fix for a real defect and was still
> wrong about the cause of the field symptom: it fixed a **secondary** effect of
> a content script that had **not run at all**. D8 identifies the primary cause —
> the content script registered at `document_idle`, which Firefox defers behind a
> hanging `load` event — corrects the passages below that now contradict it, and
> records why four rounds of work never reached it.

## Evidence tags — read these before trusting any claim

| Tag | Meaning |
|-----|---------|
| `[code]` | I read the source line-by-line. Says what the code *says*. **Does not** establish that a browser ever reaches that line. |
| `[repro]` | Demonstrated by executing code (the audit harness or the suite). |
| `[field]` | Documented real user report in this repo's history — prose **or** a captured console/diagnostic paste. **The strongest tag in this document**, and the only one that can establish *reachability*. A `[code]` argument about what a script would do, however airtight, is worth less than one line of a real paste. D8 is the case where that difference cost five weeks. |
| `[unverified]` | Reasoning only. **No capture, no repro.** Treat as a hypothesis. |

v1 used one `[V]` for all four. That conflation is the root of its central error:
reading a file correctly and concluding a *runtime* behaviour are different acts.

## Environment

Firefox, `www.google.com`, v1.8.18. Other engines out of scope. Gates: `tsc
--noEmit` clean, `vitest run` **544/544** (29 files) — green *before* any fix.

> **Scope correction, made in D8.** "Other engines out of scope" is how a
> per-engine manifest entry became a whole-extension field bug for five weeks.
> The defect was in one line of `manifest.json`, and the fix touches six entries
> on six engines. Keep the scope statement, but not the assumption behind it: an
> engine not being *tested* is not an engine that cannot be *broken*.

---

## 1. Confirmed defects

### D1 — a domain blocked while the tab is open is never applied `[code]` ✅ FIXED

**This was the literal reported symptom and the top-ranked defect of the
evidence base.** `refreshEntries` categorised `getHiddenNodes()` —
`[data-shh-result]` only (`hider.ts:199-201`) — and passed only those to
`processResults`. Results that are currently **visible** carry no such stamp, so
they were never re-matched against a list that had since changed.

Block from the popup, or from a second tab, while a search is open → that tab
kept showing the newly blocked domain until reload. **No timing flakiness
required.** The user blocked it, and the tab they were looking at did not hear.

**Fix:** reconciliation now considers both sets. Extracted to
`src/content/blocking/reconcile.ts` because `index.ts` is side-effecting and
cannot be unit-tested — the same move the repo made for
`dedupe.isInsideProcessedTerritory` (A5-R1). `refreshEntries` passes
`getHiddenNodes()` **and** `getCachedResultNodes()`.

Preserved deliberately: a stamped node's URL still comes from `data-shh-url`,
never re-derived from the engine, so a node whose extraction has since failed
is not spuriously revealed. Nodes in both sets are treated as stamped.

`tests/blocking/reconcile.test.ts` — 9 tests, mutation-verified: deleting the
`visibleNodes` loop (i.e. restoring the D1 bug) turns 2 RED, and the failures
name the shipped function. M1–M4 satisfied.

### D2 — a paused tab has no listener and a poisoned cache `[code]` `[field]`

`init()` returns at `index.ts:222` (`if (!engineActive) return`) — *before*
`updateCache()` (`:251`) and *before* `browser.runtime.onMessage.addListener`
(`:295`). A tab that loaded while paused therefore (a) never writes
`_shh_cache`, so it keeps `paused:false` forever, and (b) has no listener, so
unpausing can never reach it. This is audit finding **D2**, rated critical, and
it reproduces as a byte-identical two-load trap.

### D3 — un-hiding clears only the offered node, stranding inner marks `[code]` ✅ FIXED

The preload and the adapter routinely pick **different DOM levels** for the same
result: the preload stamps the inner `div.g` (its selector list is class-based),
while the adapter's structural walk offers the wrapping `tF2Cxc`/`MjjYud`.

`processResults`' reveal branch tested `node.getAttribute("data-shh-preloaded")`
— **self only**. In the level-mismatch case that is false, so:

1. the inner node kept `display:none !important` + the attribute + `shh-hidden`
2. `injectButtonForResult` put the block button **inside the heading**, which is
   inside that hidden inner node

Result: a blank gap where the result should be, with an invisible, unclickable
button trapped inside it. No placeholder, no Show, no Unblock.

**Fix:** `clearPreloadHiding(node)` + `hasPreloadHiding(node)` in `hider.ts`,
covering self and every marked descendant. `restoreResult` now delegates to it,
so the subtree walk exists once (it was already there for A2 F2a).

**Deliberately NOT `restoreResult`.** Its `findPlaceholder()` removes
`node.previousElementSibling` when that carries a placeholder. Calling it from
the reveal branch would strip the control off a *different* result that is still
blocked — turning one hidden node into two. `clearPreloadHiding` touches no
placeholder and no `data-shh-result`; the latter is safe because reaching the
reveal branch means `containsProcessed()` already found no stamped descendant.

`tests/blocking/preload-hiding.test.ts` — 12 tests, two mutants:
- subtree walk removed (the D3 bug) → **4 RED**, including the pre-existing A2 F2a pin
- `clearPreloadHiding` made to strip a sibling placeholder → **1 RED**

**A vacuous test caught by the second mutant, worth recording:** the first
version of the sibling-placeholder test appended `placeholder, blocked, outer`,
so `outer.previousElementSibling` was `blocked` and a mutation deleting that
sibling was a no-op — the test passed against the very bug it was written to
catch. The fixture now puts the placeholder immediately before `outer` and
asserts that adjacency, so the guard is genuinely pinned. This is the second
time in this plan that a mutation run caught a *test* rather than the code.

### D4 — `overlapsProcessed` dis-matches the ancestor it is protecting `[code]`

Audit finding **D1** (results.md:304-339) reports `refreshEntries` "re-processes
only `getHiddenNodes()`". Same code as D-1 above; listed once, tracked under
D1. Not a second defect.

### D5 — a degraded tab permanently poisons the cache for everyone `[code]` ✅ FIXED

`recoverStateFromCache` returned `{entries: [], prefs: DEFAULT}` for **both**
"there is no cache" and "the cache says you have nothing blocked". Those are
different situations and the conflation is destructive:

1. A load starts with a cold event page. Messaging times out.
2. `recoverStateFromCache` finds no cache → `entries = []`.
3. The degraded path proceeds (the return is truthy) with an **empty matcher** —
   nothing can be hidden.
4. `updateCache()` writes `{"domains":[]}` from that empty state.
5. The next load's preload cannot distinguish it from an authoritative empty
   list, so pre-paint hiding stays dead on that origin — long after the
   background woke up.

A transient hiccup became a **permanent** loss of pre-paint hiding.

**Fix:** provenance. Extracted to `src/content/cache-state.ts` (index.ts is
side-effecting, so this was untestable in place — the A5-R1 pattern).
`recoverStateFromCache` now reports `authoritative`; `updateCache` consults
`canPublishCache` and refuses to overwrite a good cache with an empty list
derived from a non-authoritative state. `stateAuthoritative` flips back to true
in `reviveFromBackground`, so the first good payload lands as soon as the
background returns.

Two details the tests forced out, both now pinned:
- **A pause is publishable even when degraded.** The first version of the guard
  refused it, which meant a degraded tab could never record a pause — the next
  load would keep pre-hiding results the user had suspended. The payload's own
  `paused` flag is the discriminator, not the caller's provenance.
- **`parseCache` must not manufacture `domains: []`** from a payload whose
  `domains` is not an array, or D5 is re-entered at the parser.

`tests/cache-state.test.ts` — 20 tests, mutation-verified (removing the guard
turns 2 RED, naming the shipped function). M1–M4 satisfied.

**Hazard found while writing it:** `DEFAULT_PREFS.engineToggles` is a single
shared object built by `Object.fromEntries` (`types.ts:61-63`). A shallow spread
of `DEFAULT_PREFS` hands out that reference, so writing
`prefs.engineToggles[id] = false` mutates the module-level defaults for the
whole process. A test helper did exactly that and silently poisoned every
subsequent test in the file. Grepped `src/` — no product code mutates it
today — but any future shallow copy of `DEFAULT_PREFS` carries the same trap.

### D6 — a SECONDARY effect: the page is unprotected until the state load finishes `[code]` `[field]` ✅ FIXED — **not the field bug**

Field report, 2026-09-30, in the user's words: *"the extension is not responsive
until I open it once after every page load"*, and *"it has no working effects on
the page, like it's not even there."* Two complaints — one about latency, one
about the extension looking absent — and **one** cause.

> **⚠️ Corrected by D8.** Everything in this section is true, and the fix is
> worth keeping. It was still **not** the cause of the reported symptom. The
> content script was not running slowly on a page it had failed to protect; it
> had **not run at all**, and had not for as long as the page had been open —
> measured at 54.2 s. The 5.8 s window below is a real hole, closed for real, but
> it sits *downstream* of an injection that in the field took the better part of
> a minute to arrive. Read this section as "what was wrong once the script
> finally executed". **D8 is the primary cause.**

**Two hypotheses were investigated first. One is a dead end. The other was
correct, and was written off for a reason that turns out to support it — see
D8.**

| Hypothesis | What was read, and what refuted it | Status |
|---|---|---|
| The content script is not running at all — private window, injection failure, `document_idle` never firing | Four markers were read on the live page: `data-shh-alive`, `data-shh-stage`, `data-shh-report`, `data-shh-preload-run`. **All null.** The row was scored as evidence *against* the hypothesis, on the grounds that three of the four do not exist at HEAD (`git show HEAD:src/content/index.ts` contains no such string) and so "carry no information". | **CONFIRMED — and this row's own reading is what buried it.** Read carefully, the null reading is not neutral: **all null is precisely what an unexecuted script looks like**, which is what this row hypothesised. The markers were never a discriminator, because they are written by the very script whose absence was in question, in a build the user was not running. The theory was rejected on reasoning that, examined properly, supports it. Its third clause — `document_idle` never firing — was also misread: the event did fire, **tens of seconds late**. A very late event and a missing event look identical when the only available evidence predates the instrumentation. **This is D8.** |
| "Opening the extension wakes the background event page, and that is why the next load works" | `[code]` The popup only **reads**: `App.tsx:25-27` is a single `useEffect(..., [])` calling `loadData()`, and its one other listener is `browser.storage.onChanged`, which refreshes the popup. The background's **only** `tabs.*` listener in all of `src/` is `tabs.onRemoved` (`service-worker.ts:126`) — there is no `onUpdated` and no `onActivated`. Waking the worker therefore pushes nothing to any tab, and a tab waiting on `LIST_UPDATED` is exactly as stuck afterwards. | **REFUTED by reading the code, and still correct.** Opening the extension did not fix the page. It only *looked* causal, because the real cause was a timer the popup happened to outlast — see D8. Refuting a mechanism is not the same as refuting the observation. |

**The actual finding `[code]`.** `earlyHideFromCache()` (`index.ts:681`) really
does run synchronously, before the first `await` — but all it does is set inline
`display:none` on cached matches (`:1880-1923`). It does **not** build the
matcher, does **not** start the `MutationObserver`, and does **not** call
`processResults()`. All of that sat behind the async state load: tier 1's direct
storage read, then tier 2's message-bus ladder at 2500 ms plus two retries of
(400 ms sleep + 2500 ms timeout) — **up to 5.8 s on a cold event page**. For that
whole window the page showed unhidden results with no placeholder, no block
button and no Unblock control: **visually indistinguishable from the extension
not being installed.**

The user's belief that "opening the extension fixed it" was an artefact, and the
artefact is exactly why this was hard to see. By the time they had clicked
through the popup, `init()` had finished **on its own**. Nothing about opening it
changed the page. Fixing the latency is what makes the belief true
*afterwards*; it was never causal.

> **Read once more against D8.** "Visually indistinguishable from the extension
> not being installed" turned out to be *literally* true, and not by coincidence:
> for 54.2 s the extension genuinely was not installed on the page, because its
> script had not executed. The window analysed just above is real, and it was
> closed for real — but it is not the window the user was living in.

**The fix.** Prime the whole pipeline from `_shh_cache` **synchronously, before
the first `await`** (`index.ts:702-712`), so the page is protected in the same
tick the content script evaluates. The authoritative read then only has to
*refine* what is already working. Two constraints, both deliberate:

- **Only an AUTHORITATIVE cache is trusted.** A non-authoritative cache means
  "we hold no list because the read failed" — the D5 distinction. Priming from it
  would claim the page is protected while hiding nothing, which is a *worse*
  failure than doing nothing.
- **Only engines that render results by `DOMContentLoaded`** —
  `isGoogleOrPrimes()`, google / bing / duckduckgo / yandex
  (`index.ts:896-898`). Brave and Startpage are client-rendered SPAs whose
  results do not exist yet; priming them would build a matcher and start an
  observer against an empty document, which is worse than waiting. (Before D8
  this read "at `document_idle`", which was the injection point and therefore
  said nothing about when the results appear. The predicate was always about
  hydration, not about the manifest.)

### D7 — the D6 fix shipped carrying three defects of its own `[code]` `[field]` ✅ FIXED

**Recorded because the D6 fix shipped carrying its own defects, and the first of
them was more dangerous than the bug it fixed.**

The first attempt at the prime guarded *all* of the extracted "protect the page"
work behind a single boolean, `pageProtected`. That produced **three separate
defects**. They are kept distinct below because each has a different shape and
each was found a different way — adversarial review found two, and the third was
invisible to both review and mutation testing until a diagnostic log was added.

#### D7a — the authoritative path lost the full scan `[code]`

The correction replaced `processResults(getCachedResultNodes())` on the
authoritative path with a reconcile. **That is not an equivalence.**
`processResults` is the only place an UNBLOCKED result gets its block button, and
the only place preload hiding is lifted for a result that is not blocked.
`reconcileAgainstBlockList` only forwards nodes that **are** blocked, so it
structurally cannot do either.

Baidu is the engine that proves it. The prime skips Baidu (client-rendered, see
D6's `isGoogleOrPrimes` gate), so the reconcile was the **only** pass that engine
ever got — and no result on the page got a block button at all. Found by
adversarial review, **not** by a failing test: nothing in the suite asserted
"an unblocked result has a button", because the only test that came close was
running on Google, where the prime had already done the full scan.

#### D7b — the healer was unreachable `[code]`

`if (degradedStart) void reviveFromBackground();` sat **inside** the one-time
`wireTabOnce()` latch. But the cache prime runs that latch closed *before* the
tier-2 ladder sets `degradedStart = true`. A primed tab whose authoritative read
then failed therefore never started the healer at all and stayed frozen on the
cache snapshot until reload — and `reviveFromBackground` is the **only** re-read
of the authoritative list in the module, so this loses recovery entirely. Also
found by adversarial review, not by a test.

Compounding it, the test harness cleared `_shh_cache` **unconditionally**, so the
prime tests and the healer tests were disjoint *by construction* and no test
could ever have combined them. `boot()` now takes an optional `cachePayload` that
opts out of the clear. A test whose fixture cannot reach the interaction is not
weak coverage; it is the absence of the test.

#### D7c — module-scope flags were wiped by their own initialisers `[code]`

This is the subtle one, and it is the most transferable lesson in the document.

`init()` is invoked from a top-level `if/else` in the middle of the module, and
its synchronous prefix — which includes the cache prime — therefore runs
**before** any `let` declared further down the module has been initialised. So:

- the prime set `pagePrimed = true`, and then the module's own
  `let pagePrimed = false` initialiser executed and **overwrote it back to
  false**. The post-authoritative reconcile never ran, and a result the stale
  cache matcher had hidden stayed hidden with no Unblock control.
- `tabWired` read as `undefined` on the first call and `false` on the second —
  neither is truthy in the intended direction, so the one-time per-tab hooks were
  wired **twice**.

**How it was found: a temporary diagnostic log.** It showed the first call seeing
`undefined` where the second saw `false`, which is the signature of an
initialiser running *between* two calls. Nothing else would have said that.

**Why neither of the two obvious methods could see it, stated plainly because
this is the part worth carrying to the next change:**

- **Source review cannot.** The code is correct at every line. `pagePrimed = true`
  in the prime is right; `let pagePrimed = false` in the declaration is right.
  What is wrong is *where* the two lines sit relative to the call site, and a
  line-by-line read has no way to express that.
- **Mutation testing cannot, in the normal direction.** A mutation deletes a
  *statement*. Here the wrong thing was a *declaration order*, and both latches
  were **inert in the built bundle** — so the mutation that deletes the latch
  left the suite **GREEN**, because the latch was already dead. The first
  measurement of P13 came only after the flags were moved, and it reports the
  flag reading `undefined`.

The fix is that **every flag `init()`'s synchronous prefix can touch is now
declared above the `void init()` call site**, with a comment at the declaration
explaining exactly why. `pageWired`, `pagePrimed` and `tabWired` sit together at
`index.ts:153-155`, above a comment that names the bug.

#### The design that shipped

`pageWired` is now a deliberately **narrow** latch covering only
`injectBaseStyles()` and `engine.onInit?.()`. Everything state-dependent runs on
**every** call:

| | what | why |
|---|---|---|
| `pageWired` (latched) | `injectBaseStyles()`, `engine.onInit?.()` | running these twice would re-inject the sheet and double-register adapter listeners |
| `tabWired` (latched) | the Google reveal, the `visibilitychange` listener, the Startpage insurance timers | genuinely per-tab, and lifted out of `init()` so a second `protectPage` call cannot re-register them |
| *(every call)* | `classList.toggle("shh-hover-mode", …)`, `refreshMatcher()`, `updateHasRules()`, `processResults(getCachedResultNodes())` | all four are functions of `prefs` / `entries`, and the prime's values are guesses |

Four further decisions, each forced by something specific:

1. **The hover-mode class is `classList.toggle(…)`, not a one-shot
   `if (prefs.showOnHover) add(…)`.** The prime's prefs are `DEFAULT_PREFS` for
   every key except `subdomainWildcard` and `debugMode`, so `showOnHover` reads
   **false** there. A one-shot would freeze that guess for the whole page
   session — "reveal blocked results on hover" dead until reload. `toggle` is
   idempotent and self-correcting.
2. **A post-prime `reconcilePageInPlace()` runs when a prime happened and the
   authoritative read has landed** (`index.ts:1018-1024`). It is needed because
   the full scan **cannot undo a stale hide**: the nodes the stale matcher hid are
   already stamped, and `processResults` skips stamped nodes. Without it, a
   domain the user unblocked in another tab stays hidden with no Unblock control
   — the 2026-08-30 regression, reintroduced through the back door by the fix
   meant to make the extension feel more responsive.
3. **`startResultObserver()` and `tryStartInfiniteScroll()` moved OUT of
   `protectPage` and back into `init()`, before the Brave/Startpage sleep**
   (`index.ts:908-917`). They branch on `prefs.mutationObserver` and on four
   infinite-scroll prefs, so priming them would latch a wrong answer; and the
   observer must arm **before** that sleep because background tabs clamp timers
   (that 400 ms can take a minute there) and Startpage hydrates when the tab
   wakes. This is why the latch had to be split along the prefs axis and not
   along the "is it expensive" axis.
4. **The reconcile body was extracted from `refreshEntries()` into a shared
   `reconcilePageInPlace()`** (`index.ts:1044`). The post-prime path, the heal
   path, the live-prefs path and the live-list path now share **one** copy of
   the restore / re-stamp rules. Two copies is how D1 comes back: the rule
   "a currently-visible result carries no `data-shh-result`, so it must be in
   the reconcile set" has to exist once, not four subtly different times.

Two smaller things, both because the console is a diagnostic channel:

- **The fire-and-forget reconcile calls carry `.catch`**
  (`index.ts:1023`, `:1795`), per the rule the sibling messaging calls already
  follow. An unhandled rejection is noise in the exact channel
  (`__shhDiag` / `data-shh-diag`) that field diagnosis depends on, and it would
  leave the page half-reconciled.
- **`reviveFromBackground` additionally reconciles**, and additionally calls
  `syncDiag()` + `refreshDiagReport()` (`index.ts:1225`, `:1236`, `:1247`).
  Without the `syncDiag`, the report kept saying `degradedStart: true` after a
  **successful** heal, because those flags reach the report only via
  `syncDiag()`. A stale diagnostic that points the reader at a defect that is
  already fixed is the same class as the dead D1 detector, and it is the reason
  the heal path is the one place the report had to be re-published on the
  success side.

**Note for §8's remaining gaps.** `tests/tab-heals.test.ts` and
`tests/diag-bridge.test.ts` drive the **built** `dist/content/index.js` bundle
in jsdom rather than importing `src/content/index.ts`. That reaches call-site
*ordering* inside the side-effecting module — exactly what §8 records as
unpinned — so the D6/D7 mutations finally have somewhere to bite. It is also the
only kind of harness that could ever have caught **D7c**, because a module's
declaration order only matters when the module actually evaluates. It does not
help the preload layer, which still has **no** coverage at all.

### D8 — the primary cause: on a Google results page the content script did not run for 54 seconds `[field]` `[repro]` ✅ FIXED

**This is the actual cause of the reported symptom, and it invalidates part of the
document above it.** Read it before D6.

#### The symptom

Firefox + Google, in the user's words: *"it still doesn't work until I open the
extension."* On every fresh page load the extension is **completely absent** —
results visible, no placeholders, no block buttons, no Unblock control — and
opening the popup makes it work.

The whole feature surface was missing, not part of it. That distinction was
under-weighted at the time: "the extension is slow" and "the extension has not
started" produce almost the same console, and the second one was the true one.

#### The one line that settled it

A field console paste. Nearly all of it was noise; this line was the answer:

```
[SHH] t=54242ms init start v1.8.20+d8a93a92
```

`shhLog` prefixes every line with `t=<Math.round(performance.now())}ms`, and
`performance.now()` is measured from **navigation start**. So `init()` did not
begin executing until **54.2 seconds after the page had loaded.**

The same paste carries `[SHH-preload] host=www.google.com domains=15` — the
`document_start` preload had already run, on the same page, in the same document,
and it had 15 domains of work to do.

So the extension was not slow, not blocked, not failing CSP, not waiting on the
background, not failing to recover from anything. **It had not run at all.** Every
reading that made this look like a timing problem *inside* a running script was
downstream of a script that had not been scheduled.

#### The mechanism

`manifest.json` registered the content script with `"run_at": "document_idle"`.
Firefox fires `document_idle` **after the window `load` event**. A Google results
page does not fire `load` promptly — the same paste shows repeated `Cross-Origin
Request Blocked` for `ogads-pa.clients6.google.com`,
`ep1.adtrafficquality.google`, and a `font-display` timeout.

`load` deferred → the entire content script deferred → by exactly the same
amount. The preload was unaffected, because it runs at `document_start`, which is
precisely why pre-paint hiding looked alive and nothing else did.

Opening the popup **did nothing at all.** It consumed time. By the time the user
had clicked into it and looked at a result, the deferred injection had landed,
and a causal story grew around the coincidence.

#### What every earlier round was actually measuring

| Theory | What shipped | What it was really measuring |
|---|---|---|
| cold event page → messaging times out | M1's direct `storage` reads, M2's healer-reads-storage-first | consequences of a script that had not executed |
| messaging timeouts | the tier-2 retry ladder (400 ms sleep + 2500 ms timeout, twice) | ditto |
| degraded cache start | D5's `authoritative` provenance and `canPublishCache` | ditto — and a genuine bug, fixed for real |
| unprotected while state loads | D6's synchronous cache prime | ditto — and a real improvement, on a real secondary defect |

**Three of those four were real defects and their fixes should stay.** None of
them could address a script that had not been injected, because none of them runs
before injection. That is the uncomfortable part: four rounds of correct work,
each of which improved the product, on a page whose symptom was produced upstream
of all of it.

Directly on the brief to correct any "cold event page confirmed" reading: the
direct-storage tier **did** make the state load fast, and the symptom then
survived that fix **unchanged**. The fix failing to move the symptom is what
should have ended the theory, and instead it was read as "the storage tier is not
the whole answer" rather than "the state load was never the answer".

#### This was seen before — and the miss is in this repo's own history

`docs/plans/2026-08-23-startpage-support.md:88` records, from a Startpage field
run:

> User-supplied diag on a cold load: `[SHH-preload]` at page start, then
> `init start t=102556ms` — the main content script did not EXECUTE until 102
> seconds after load, coinciding with the popup being opened.

Same signature, **102 s**, already diagnosed — correctly, as `document_idle`
deferral behind a hanging resource — and never connected to Google. Startpage's
hanging resources are *visible* (sibling images visibly fail); Google's are
console lines, and §9's classification table filed them under "not ours".

And the sentence written at the time is the origin of the defect
(`2026-08-23-startpage-support.md:90`):

> Other engines keep `document_idle` (their pages fire `load` promptly; no
> observed issue — revisit if the same signature ever appears).

The signature appeared on Google roughly six weeks later. The document predicted the
revisit, named the trigger, and the trigger was ignored, because *"no observed
issue"* was read as a property of the **engines** rather than of the **pages**
they happened to load that day. Google is not a fast-loading engine; on that
particular load it was not.

**The preload at `document_start` paired with the content script at
`document_idle` is the most important design decision in this paragraph, and it
was the defect.** It read as deliberate and defensible — hide early, then run
logic once the page is quiet — which is exactly why nobody re-examined it. It
still reads as deliberate.

#### The second confirmation in the same paste — evidence AGAINST the storage theories

The same field paste also carried, against that `domains=15` preload line:

```
entries=0
reconciled: restamp=0 restore=5
```

The extension found 5 results, hid all 5, and then **un-hid all 5**, because the
authoritative read returned an empty list.

That is the reconcile logic behaving **correctly**: a stale matcher hid 5 nodes,
the authoritative list said nothing was blocked, and the reconcile restored
exactly those 5 and stamped nothing. It is also a direct refutation of the
degraded-cache theory *as the cause* — that machinery was working, on real data,
at a moment when the page was visibly broken. Recorded here as evidence **against**
the storage theories, not for them.

#### The fix

**1. `manifest.json` — all six engine entries, `document_idle` → `document_end`.**

`document_end` fires at `DOMContentLoaded`, which does not wait on subresources.
It is the earliest point at which this code can do anything useful:

- **`document_start` was considered and rejected.** The preload already runs
  there; adding the content script there too means the body does not exist yet.
  Result discovery resolves through `document.body`, and the `documentElement`
  classList work has nothing to act on. It would trade a 54 s absence for an
  immediate failure, or for a second belt of guards that has to be maintained
  forever.
- The **`document_start` preload entry is unchanged, deliberately.** It is the
  CSS / `:has()` layer, it needs no body, and it is the one part that *was*
  working throughout the 54 s window. Moving it later would remove the only
  protection the page had.

**2. `src/content/index.ts` — a bounded DOM-readiness gate at the top of `init()`.**

With `document_end` a body is guaranteed in practice, so the gate is
**belt-and-braces**: it makes a too-early injection *impossible* rather than
merely unlikely, which is the right posture for the defect that just cost this
plan five weeks of field reports. It races `DOMContentLoaded` against
`sleep(2000)` and **proceeds after the timeout regardless**.

The bound is the load-bearing half of it. A gate that waits indefinitely for a
DOM event is the same class of bug as the one it prevents — a
`DOMContentLoaded` that never arrives must not hang the tab the way `load` did.
Past 2000 ms the script runs anyway; the observer and the rescans pick results up
whenever they appear. Both halves are pinned, separately (see below).

#### Testing — `tests/manifest.test.ts`

Two assertions gained:

- the Google entry must be `document_end`
- **no entry anywhere may be `document_idle`**

The second is the high-value one. A single engine left on `document_idle`
reintroduces the entire bug **on that engine only** — a per-engine regression,
structurally invisible to a Google-only check, and precisely the mistake
`2026-08-23-startpage-support.md:90` made.

#### Testing — `tests/tab-heals.test.ts`, and three vacuous versions of it

Two gate tests exist. One drives the **timeout** arm (no `DOMContentLoaded`; the
body arrives late and the page must still get protected). The other drives the
**event** arm — the arm that runs in production — and asserts it releases in well
under 2000 ms, so the safety net cannot silently become 2 s of dead time on
every single page load.

**Three successive versions of these tests were vacuous.** The sequence is the
most transferable thing in this document, so it is recorded rather than tidied
away:

1. **v1** asserted only that `data-shh-stage` had moved past `init-start`. That
   is true whether the gate runs, is deleted, or was never written — and the
   mutation deleting the gate survived it.
2. **v2** removed the body and asserted the page ended up protected. It also
   passed **with the gate deleted**, because the Google adapter resolves results
   through `document.body` and therefore finds nothing either way. It was
   measuring the adapter, not the gate — the "test's premise never reached the
   code it named" failure this document records four times elsewhere, and a fifth
   time here.
3. **The reason neither could ever have worked:** jsdom fires
   `DOMContentLoaded` about **1 ms after `eval()`**, *with or without a body*.
   The gate's `Promise.race` was therefore always won instantly and there was
   nothing to observe. A test that cannot fail is not weak coverage; it is
   decoration with a green tick. This was settled with a standalone jsdom probe
   rather than an argument, which is the only reason it was found at all.

The working version **suppresses jsdom's automatic event and dispatches its own**
(`controlDomContentLoaded`). Two details, both discovered by having them fail:

- The suppressor must be a **capture-phase listener registered before the
  bundle's**. jsdom fires the automatic event ~1 ms after `eval()`, so a
  suppressor installed afterwards loses the race it exists to win.
- It must **step aside** (`allowNext()`) for the manual dispatch. A blanket
  capture-phase suppressor blocks the content script's **own** listener too,
  because both sit on `document` and both fire in registration order at the
  target phase — so the first attempt at "dispatch it myself" silently re-broke
  the thing under test while looking like a working harness.

#### Measured mutation results for D8 — all four killed

| Mutation | Result |
|---|---|
| delete the DOM readiness gate | **killed** (2 failures) |
| gate timeout raised to 600 s — reintroduces the hang | **killed** (1 failure) |
| gate ignores `DOMContentLoaded` and always waits the full timeout | **killed** (1 failure) |
| all `document_end` reverted to `document_idle` | **killed** (2 failures in `tests/manifest.test.ts`) |

Rows 2 and 3 are the pair the two gate tests exist for, between them: one kills
"the bound is gone", the other kills "the event is ignored". Each survives the
other's test, which is the reason there are two tests and not one.

#### The lesson, stated plainly

Several rounds of this plan fixed real secondary defects, and **none of them
touched the primary cause** — because the primary cause was sitting in one log
line that nobody read carefully enough (`t=54242ms init start`), and because a
theory that *sounds right* (cold background, messaging timeout, degraded cache)
survives a great deal of scrutiny without ever being the thing that is happening.

The instrumentation this document is otherwise proud of — `data-shh-alive`,
`data-shh-stage`, the stamped build — could not see it either, because it did not
exist in the build the user was running. That is the second half of the lesson
and it is the uncomfortable one: **diagnostics added after a field run cannot
retroactively explain that field run.** The fix for that is not more
instrumentation. It is reading the one number in the paste that says *when*.

### A1 — a live pref change reached the cache but not the live matcher `[code]`

> **Name collision, recorded so nobody greps for the wrong thing.** §2's "A1" is
> v1's refuted central claim. This is a different finding, and the mutation set
> is `A1a` / `A1b` / `A1c`. The plan already had one dead A1; it did not need a
> second one under the same name.

Found by an adversarial sweep for the *"new state arrives, a latch swallows the
re-apply"* class — the same class as D7, arriving by a different door.

In `refreshPrefs`, the branch for "no active/inactive transition" was treated as
**cosmetic**: button style, one-click, notices, theme. It refreshed the cache and
nothing else. But `subdomainWildcard` is an argument to the `DomainMatcher`
constructor **and** to the preload's `:has()` rule sheet, and
`classifyPrefsTransition` only reads the pause/toggle fields — so a wildcard
toggle classified as `"none"` and the LIVE matcher and LIVE `:has()` sheet kept
the old value **for the life of the page**:

- turning it **off** left subdomains hidden with no placeholder and no Unblock;
- turning it **on** left them visible.

Either way the user had to **reload to see their own change**. The cache said the
new value, the module variable said the new value, and the page disagreed.

**The fix is `refreshMatcher()` + `updateHasRules()` + `reconcilePageInPlace()`
in that branch** (`index.ts:1787-1795`). `refreshMatcher()` rather than a direct
construction, so the diagnostics cannot drift from the live matcher again. The
reconcile is **required**, not belt-and-braces: rebuilding the matcher alone does
not release an already-stamped node, for exactly the reason given in D7 — the
nodes the OLD matcher hid are already stamped and `processResults` skips stamped
nodes. It is also what makes turning the setting **on** hide the subdomains that
were previously let through, so the single reconcile covers both directions.

## 2. The v1 central claim — REFUTED, do not implement

v1's "A1" asserted that a result's own block button permanently disqualifies it
via `containsProcessed`. **It cannot fire.** Three independent in-repo facts:

1. `block-button.ts:51` — `container.setAttribute(ATTR_HAS_BTN, "1")`. The
   attribute goes on the **result node** (it is passed in as `container`). The
   `<button>` gets `class="shh-block-btn"` (`:60`) and **no** `data-shh-*`
   attribute.
2. `styles.ts:99-100` — the repo says so in a comment: *"data-shh-btn is set on
   the result card node. The button is a descendant."*
3. `containsProcessed` is `el.querySelector(...)` (`dedupe.ts:60-66`).
   `querySelector` matches **descendants only** — it can never return `el`. So a
   node's own `data-shh-btn` does not make `containsProcessed(self)` true.

v1's step 5 said the button "carries `data-shh-btn` (`block-button.ts:5`)".
Line 5 is the **constant declaration**. The apply is at line 51. I grepped for
the constant, saw its name, and wrote the conclusion from the name.

v1's proposed fix (`containsNestedUI` + `data-shh-btn-self`) was inert for the
same reason: `el.hasAttribute(...)` gated a `querySelector` that could not see
`el` anyway.

### Closed executably `[repro]`

`tests/engines/google-self-button.test.ts` binds the **shipped**
`containsProcessed` / `overlapsProcessed` and the **real** `injectBlockButton`,
and asserts four things — all green:

1. `data-shh-btn` lands on the result node; the `<button>` has no
   `data-shh-*` attribute (guards against the exact misreading).
2. A result carrying its **own** `data-shh-btn` is **not** rejected —
   `containsProcessed(node) === false`. **This is the finding**: the claimed
   mechanism cannot occur.
3. An **ancestor** of a stamped node **is** rejected. This is the real,
   inverted variant — characterised, not endorsed.
4. `overlapsProcessed` still self-matches (it uses `closest`, where a node's
   own marker legitimately disqualifies it). Pinned so the false root cause is
   not "fixed" by someone reading it later.

**Structurally real variant, reachability `[unverified]`:** an *inner* node's
self-marker makes `containsProcessed(outerAncestor)` true. Requires both DOM
levels to be offered in one load. **No capture, no repro — do not implement
speculatively.** If a field capture shows it, the fix is a self-check
(`el.hasAttribute`) rather than relaxing the descendant test, so wrapper
semantics stay provably intact.

## 3. Deterministic discovery gaps `[code]`, reachability `[unverified]`

**B1 — `google-dom.ts:349`.** A section-shaped node (≥2 headings,
`SECTION_HEADING_THRESHOLD = 2` at `:85`) whose descent finds nothing is
unconditionally skipped, so a blocked result carrying a sitelink or a PAA strip
is never offered. The guard's own comment (`:343-348`) is explicit: *"Offering
it as a match would let a single blocked domain hide everything inside it (field
case: `div.N54PNb` wraps the entire result list)."* `[field]` 2026-08-30.

This is **filed finding A1-3b**, deferred for *"no field report"*
(`review-2026-09-06-google-v1.8.9.md:88-91`). Shipping it under a new name
re-opens a deferred decision. Two prerequisites before it may ship:
(a) gate it — only re-offer when the **depth budget**, not the heading probe,
was the failure; (b) fix the new section-level defect it creates, because
`restoreByDomain` (`hider.ts:210-225`) walks `[data-shh-result]` document-wide,
so unblocking one domain inside a hidden section restores **all** of them.

**B2 — `google-dom.ts:193`.** `if (domains.length > 1) return null;` means a card
citing `blocked.com` plus one foreign sitelink yields `null` → never hidden
**and never given a button**. `[field]` the guard exists because of *"it
removed other search results"* (2026-08-30, v1.8.3).

v1's fix was a **no-op**: it looked for the cite *inside* the heading. Google's
title cite is a **sibling** of the title block, never a descendant of the
`<h3>` — confirmed by every fixture in the repo
(`tests/engines/google.test.ts:391-398` field-captured, `:33-43`;
`google-opaque-guards.test.ts:92-98`; `harness/dom.ts:34-39`). So
`googleDisplayDomains(heading)` is `[]` on every realistic result. v1's version
also checked the heading *before* any host count, re-opening the ≥4-host case.

**The discriminator must be spatial, not heading-containment.** The title cite
is the one sharing a block with the title — not one nested under the heading.
A **veto**, not a promote:

> If the node's display-URL slots yield >1 distinct domain **and** ≥2 of them
> come from a subtree that itself contains ≥2 outbound `a[href]` (a sitelink
> cluster), then the cite that is a **direct child** of the node — or, failing
> that, the first cite in document order — is the title cite. If no such
> non-cluster cite exists, return `null`.

`googleDisplayDomains` already returns document order, so `domains[0]` *is* the
first cite; the work is deciding whether it is trustworthy. Needs a **field
capture** before it is pinned.

`google-opaque-guards.test.ts:101-108` passes **unchanged** under any B2 variant
(its `multiCiteBlock` puts every cite in a sibling `div.hb8CAc`, so
`headDomains === []`). It is therefore **not** evidence either way. New pin
required, against the shipped function:

| fixture | expected |
|---|---|
| `blocked.com` + 1 foreign sitelink, 1 heading | returns `blocked.com` |
| `blocked.com` + 3 foreign cites, no per-result markup | returns `null` |

`google.ts:280` (`resultHost`) and `google.ts:389` (`getResultUrl`) call
`googleDisplayDomain` with **no** aggregate check — safe only because
`walkResults:354` and `preload.ts:602` filter first. Any new caller inherits an
unguarded path; record the coupling in a comment.

**B1 and B2 must not ship together.** v1 declared them independent. They are
not: `:349` and `:193` are the *two* independent stops against a whole-page
hide, and `looksLikeGoogleAggregate` (≥4 hosts, `:91`) does not cover the
2–3-host band or a section whose cites fail to parse
(`GOOGLE_DISPLAY_URL_SELECTORS` at `:113-116` is a class list — exactly the
class-rotation surface that took the engine down in 2026-08-30).

**B3 — `google-dom.ts:311`** `if (found.length > 0) return found;` accepts a
partial stream. Defer: no capture shows it.

**B4 — dropped.** v1 proposed raising `looksLikeResultList`'s threshold
(`dedupe.ts:125`). It is the **only** path for Google DOM additions
(`google-duplicate-ui.test.ts:90` proves `getResultNodes(subtree) === []`), and
an href-based host count **disables it entirely** on Google's opaque
`/goto?url=` links (`google-dom.ts:237-243`). Deleting the guard is worse than
the bug.

## 4. Messaging

**C1 — tab eviction `[code]` ✅ FIXED**

`activeTabIds.delete()` on send failure is **removed entirely**. A content script
registers its listener as the last statement of `init()`, so "no receiver" is
the expected state for the first second of every load — evicting on that signal
made a tab permanently deaf for the rest of its page life.

`src/background/broadcast.ts` replaces the loop. Shape matters: the eviction was
a deliberate 2026-05-16 perf optimisation, so this does **not** union
`tabs.query` on every broadcast. It sweeps only when a send actually failed
(or the candidate set is empty, which is the post-worker-restart case), retries
nothing twice, and never re-sends to a tab already reached. Happy path keeps its
O(active) cost.

`tests/background/broadcast.test.ts` — 9 tests, 4 mutants RED, plus an identity
control proving the suite is green on unmutated code. Three real bugs in my
first implementation were caught by these tests: the sweep was skipped when the
candidate set was empty, already-delivered tabs were re-sent, and failures were
dropped from the returned set.

**E1 — packaging ✅ FIXED.** `manifest.json` gained
`"service_worker": "background/service-worker.js"` alongside `scripts`. Firefox
MV3 uses `scripts`; Chrome MV3 requires `service_worker` and was loading with
**no background at all**, so every `sendMessage` rejected. Pinned by
`tests/manifest.test.ts`, which also pins the injection schedule — and that half
of the file is now the **highest-value test in the plan**, because it was
written to describe a split that turned out to be the defect. It reads
`document_start` for the preload and `document_end` for the content script, and
asserts that **no** entry on **any** engine is `document_idle`. See D8; the
`document_start` / `document_idle` split this test originally pinned was the bug,
described as if it were the design.

**C2 — `PREFS_UPDATED` has zero senders `[code]` ✅ FIXED**

Verified before the fix: the only `src/` hits were `service-worker.ts:89` (the
filter) and `index.ts:291` (the receiver). `SET_PREFS` wrote and returned, so
`refreshPrefs()` was dead code. `SET_PREFS` now broadcasts, and `UNDO_LAST` does
too — undoing a block re-adds a domain, so other tabs must re-hide it.

Shipped together with C3 and the four companions, as one change.

**⚠️ C2 is the highest-risk item in this plan and is not a one-liner.**
Making it reachable activates **13** never-executed branches. P0b has now
hardened the ones that were unsafe, while the code was still dead:

| Was | Now |
|---|---|
| `engineActive` predicate written out **3×** verbatim (`:240`, `:382`, `:782`) — the resume branch is only correct if all three agree | one `isEngineActive()` in `prefs-transition.ts`, used by all three |
| decision logic untestable (side-effecting module) | `classifyPrefsTransition()` — full 2×2 truth table pinned, 2 mutants RED |
| suspend never called `__shhRevealGoogle?.()` — nodes the cover left at `opacity:0` stayed invisible **and unclickable** (`pointer-events:none`) for a user who just paused | called |
| suspend never stopped the observer — the `visibilitychange` handler (`:278`) and the 1500 ms URL watcher (`:321`) **re-hid everything suspend had just revealed**, on the next tick. Suspend undid itself | `observer.stop()` |
| suspend never destroyed the scroll manager — appended pages kept arriving and were re-hidden | `destroy()` |
| `html[data-shh-active]` was set by the preload and **never removed by anything in `src/`** | removed on suspend |
| resume's `updateCache()` on a degraded tab wrote `{"domains":[]}` | fixed by the **D5** guard (`canPublishCache`) |

`SUSPEND_OBLIGATIONS` enumerates the seven teardown steps so dropping one is a
visible edit rather than a silent regression. The DOM half of `refreshPrefs`
still needs the audit harness's page-load driver — that is the remaining part
of P0b and is called out in P5.

C2 must ship with **C3 plus four more**: move `updateCache()` and
`addListener` above every early return in `init()` (D2); add a `.catch` and an
`initComplete` guard (a broadcast inside `init()`'s await is clobbered by `:180`);
`if (degradedStart) return;` in the resume **and** else branches; and call
`__shhRevealGoogle?.()` + stop observer + destroy manager in suspend.

**The companion that mattered most — D2.** The listener used to be the last
statement of `init()`, *after* three early returns. A tab that loaded while
paused therefore had **no listener at all**, so unpausing could never reach it
and the user had to reload. The listener is now registered at **module scope**,
and a message arriving before init finishes is recorded in `pendingRefresh` and
drained by `finishInit()` on **every** exit path, including the early returns.

**C3 — the empty-`:has()`-sheet guard in `buildHasRules` ✅ FIXED `[code]`.**
`if (rules.length === 0 && !isNew) return;` returned without clearing
`hasSheet`, so every previously-built `:has(){display:none!important}` rule
survived "nothing is blocked any more" — and `processResults`' reveal branch
could not rescue those nodes, because it keys on the `data-shh-preloaded`
attribute which a `:has()`-hidden node never carries. An empty rule set is now
treated as an instruction and the sheet is cleared (with a `deleteRule` fallback
for engines where `replaceSync` throws). Coupled to C2: shipping C2 without C3
would have stranded hidden results with no Show control — the exact failure this
plan set out to remove.

> **`[code]`, NOT mutation-verified — the earlier "✅ mutation-verified" claim for
> C3 was false and is retracted.** jsdom 29 does not implement
> `document.adoptedStyleSheets` (pinned by `tests/env.test.ts`), so the preload
> IIFE cannot be imported and `buildHasRules`, `injectCoverCSS`,
> `__shhDisarmCover` and `__shhRearmCover` have **no test at all**. The logic was
> read and reasoned about; it has never been executed. Treat C3 as unverified
> code, and note that the same gap covers the whole preload layer.

### 4a. The cold event page, and the diagnosability work that made D8 visible `[code]`

Five supporting changes. None of them is the D8 fix; all of them are the reason D8
took five weeks to find rather than an afternoon.

**The "cold event page" theory was never confirmed, and the way it failed is the
useful part.** It was a plausible mechanism with a measured cost — the tier-2
ladder really did allow **up to 5.8 s** on a cold worker — and the M1 direct
reads really did make the state load fast. **The symptom then survived that fix
unchanged.** A fix that does not move the symptom is the strongest evidence
available that the symptom had a different cause, and it was read instead as "the
storage tier is not the *whole* answer". See D8.

**M1 — direct storage reads.** `getListDirect()` / `getPrefsDirect()`
(`src/content/messaging.ts:40-46`) read `storage.local` / `storage.sync`
directly. The content script already holds the `storage` permission, so the
critical path does not need the event page to be awake at all, and a direct
`storage.local.get` is a few milliseconds and cannot be stalled by a sleeping
worker. Messaging stays for **writes**, which genuinely need the background in
order to broadcast to other tabs.

**The two reads are deliberately NOT `Promise.all` under one deadline.** The list
is `storage.local` — purely local, ~1 ms, and the critical data. Prefs are
`storage.sync`, which in Firefox talks to a **remote server** when the user is
signed in and can hang for seconds on a bad connection. A single combined
deadline means one slow sync takes the **block list** down with it, dropping
straight back into the messaging path this tier exists to avoid. The list goes
first; prefs can arrive a moment later.

**M2 — the healer reads storage before messaging.** `reviveFromBackground()`
(`index.ts:1135-1155`) tries the direct reads first and falls back to the message
bus. It previously polled **only** `sendMessage`, so a tab that was inert
*because* the event page was cold spent up to **60 attempts** asking the one
component that could not answer. Storage answers regardless of whether the
background is awake.

**M3 — the page-world bridge FAILED. The DOM attribute is the channel.** A field
run typed `copy(__shhDiagText())` and got `__shhDiagText is not defined` —
correctly, because a content script runs in an isolated world and the console
evaluates in the page's. The attempted fix was `window.wrappedJSObject` +
`cloneInto(fn, g, { functions: "callable" })` (`index.ts:191-216`), and **it did
not work**: a content-script function still cannot be *called* from the page
compartment. The primary channel is therefore the DOM attribute
`data-shh-report`, which cannot fail across compartments — the DOM is shared and
`getAttribute` is a same-realm call.

> **jsdom has no compartments, so it can never test the `cloneInto` path.** A
> green suite here is not evidence that the page-world bridge works and must not
> be cited as such. `tests/diag-bridge.test.ts` says this in its own header and
> deliberately asserts the *mechanism* instead.

**M4 — the report was published only on the SUCCESS path.** The worst finding in
this block. A tab that bailed early — the exact state reported as "not there" —
published **nothing**, so the one artefact needed to diagnose the failure was
the one artefact that could not be read. It is now published at
**module-evaluation time** and on **every** early return, with `data-shh-alive`
(the build stamp, so "the script never ran" is distinguishable from "the script
ran and stopped") and `data-shh-stage` (the last stage entered) written on every
path. `bail-cache-says-paused` and its siblings are now nameable in the field.

**M5 — CSP audited SAFE. Do NOT inject an inline `<script>`.** Zero inline
handlers; all **16** popup controls bind with `addEventListener`. The two
pre-existing `UNSAFE_VAR_ASSIGNMENT` `web-ext lint` warnings (§9) come from the
preact runtime and are unreachable. (§9 attributed them to `innerHTML` /
`insertAdjacentHTML`; this audit traced them to the preact runtime in the popup
bundle. Either way they are unreachable from a search page, and neither is a
reason to inject a script.) Reaching the page world is exactly what the
DOM-attribute channel is for.

### 5b. Preload-layer defects found by the 2026-09-28 review `[code]`

These were not in the original plan. All are `[code]`-only for the same reason.

**N1 — `sanitizeDomains` threw on a non-string cache entry → BLANK SERP.**
`_shh_cache` lives in `localStorage` on the *page's* origin, so it is writable by
any script that has run there. `Array.isArray` validated the container but not the
elements, and `raw.trim()` had no type guard, so `{"domains":[{}]}` threw at
module scope and escaped the whole IIFE: `__shhRevealGoogle` was never installed,
the observer never started, and every Google result stayed at the cover's
`opacity:0 !important; pointer-events:none !important`. A blank, unclickable SERP
with no error anywhere. Fixed with a `typeof raw !== "string"` guard.

**N2 — the four window hooks were installed *after* the empty-list early return.**
`if (domains.length === 0) return;` is reached on exactly the two states these
transitions come from: a tab loaded while paused, and a fresh install with no
cache. On those pages no hook existed, so the resume branch's
`__shhUpdateHas?.()` / `__shhRearmCover?.()` were silent no-ops. The hooks and the
state they need (`lc`, `lcWildcard`, `hasSheet`) are now above the return; only
the observer and the scans stay gated.

**N3 — `__shhRearmCover` and `injectCoverCSS` were guarded on `domains`.**
`domains` is the document_start snapshot and is never rewritten, so a
paused-at-load tab had it empty *forever* and the cover could never be rebuilt —
on precisely the tab the hook exists for. Both now gate on `lc`, the live list.

**N4 — the bfcache `pageshow` handler passed the stale outer `wildcard`.**
`buildHasRules(lc, wildcard)` re-emitted the subdomain `a[href*=".domain/"]`
patterns after a `subdomainWildcard` change, hiding nodes the content script's
matcher says are *not* blocked — with no `data-shh-preloaded` attribute, so
nothing could ever reveal them. That is the A2-F2 shape ("hidden with no
placeholder, no Show, no Unblock"). Now `buildHasRules(lc, lcWildcard)`.

**N5 — the bfcache handler re-armed the cover unconditionally.** Gated on
`isGoogle` alone, so it re-armed on a page that had been *suspended* (observer
stopped, so anything rendered later stayed at `opacity:0` with no reveal net) and
on a tab with an empty block list (whose IIFE returned early, so no observer and
no 300 ms reveal existed at all — a blank SERP after Back). Now gated on a single
`coverArmed` flag that `__shhDisarmCover` clears and `__shhRearmCover` sets.

**N6 — `buildHasRules` re-attached its sheet only on the `isNew` path.** If
Firefox discards `adoptedStyleSheets` across a bfcache freeze, or any script drops
the sheet from the array, `replaceSync` repopulated a sheet in nobody's list and
the `:has()` layer was silently dead for the rest of the session. Now re-attached
whenever `includes(sheet)` is false — correct under either bfcache answer.

**N7 — `preloadDiag` fields were written but never read**, and
`preloadSkipReason` was initialised to `"ran fully"` and never reassigned, so it
reported "ran fully" for a preload that bailed at the early return. All seven
fields are now printed in the report, the skip reason is set on both paths, and
`timeOrigin` is published from both scripts so the clock assumption is *checkable*
rather than assumed.

## 5. Sequencing

```
P0  env fix + pins      ✅ DONE — mutation-verified
P1  D1                  ✅ DONE — reconcile.ts, 9 mutation-verified tests
P2a D5                  ✅ DONE — cache-state.ts, 20 mutation-verified tests
P0b refreshPrefs        ✅ DONE — prefs-transition.ts, 15 tests, 2 mutants RED
P2b D3                  ✅ DONE — clearPreloadHiding, 12 tests, 2 mutants RED
P3  C1                  ✅ DONE — broadcast.ts, 9 tests, 4 mutants RED
P4  B2 alone            ⛔ BLOCKED — needs a field capture
P5  C2 + C3 + four      ✅ DONE — all five companions shipped together
                            ⚠️ C3 is `[code]`-only; its "mutation-verified"
                            claim is retracted (see §5b)
P6  B1                  ⛔ BLOCKED — filed finding A1-3b, needs a capture
P7  E1 packaging        ✅ DONE — manifest test now actually runs (pretest build)
P8  diagnostics audit   ✅ DONE — 16/16 mutants RED after 4 test defects fixed
P9  suspend teardown    ✅ DONE — runSuspendTeardown, 7/7 mutants RED
P10 preload hardening   ✅ DONE — N1..N7, all `[code]`-only
P11 D6 cache prime      ✅ DONE — primes the pipeline before the first await
P12 D7 + A1             ✅ DONE — 12/12 mutants killed after 2 fixture defects
                            fixed; D7c needed a diagnostic log, not a mutation
P13 D8 injection timing ✅ DONE — document_end on all 6 engines + a bounded DOM
                            readiness gate; 4/4 mutants killed. THE PRIMARY
                            CAUSE. P11 fixed a secondary effect and the symptom
                            survived that fix unchanged
```

**Status: 44 test files, 750 tests, all green, 0 skipped. `tsc --noEmit` clean.
`npm run build` clean. Packaged as 1.8.20.**

Everything actionable without a live Google SERP capture is done, and the one
thing that capture was needed for has now come back. The two remaining items
(B1, B2) are both **deliberately** blocked, not skipped — each
is a deferred 2026-08-30 field decision whose guard is the only thing preventing
"one blocked domain hid the whole result list", and neither can be validated
without a real capture. The capture is `copy(__shhDiagText())` from a real
Google SERP, and `discovery.sectionShaped` / `discovery.multiCite` are the
counts that would settle them — which is why the probe was rebuilt to stop
manufacturing those numbers.

## 9. Field run 2026-09-29 — classification, and what it cost

The user ran 1.8.20 on a real Google SERP. Most of the console was noise, and
separating the two kinds of noise is the useful result.

### Classified as NOT OURS (page-origin; verified by origin, not by assumption)

| Console line | Why it is not ours |
|---|---|
| `Uncaught TypeError: can't convert undefined to object` ×~40 @ `search:40:9719` | Page origin. The stack is Firefox's `reflect` / `proxyFn` / `apply` membrane over Google script — not `index.js` or `preload.js`. |
| `Content-Security-Policy` ×5 | Google page handler vs Google's own CSP. |
| `Cross-Origin Request Blocked` (ogads-pa, adtrafficquality, `data:`) | Google ad/telemetry endpoints. **Correct by origin — and still load-bearing.** These are not noise; they are the hanging subresources that deferred `load`, and therefore the entire `document_idle` content script. The classification was right and the conclusion drawn from it was wrong. See D8. |
| `Empty string passed to getElementById(). m=X3N0Bf,attn,…` | Google's minified identifiers. |
| `Keyframe property value "" is invalid` / `MouseEvent.mozPressure deprecated` | Google's CSS and page handlers. |
| `Magic Userscript+`, font-display timeout | Other extensions / Google Fonts. |

**"Not ours" was the right answer to the wrong question.** The question was "who
emitted this?", and Google did. The question that mattered was "what is this
doing to the page's `load` event?", and it was holding `load` open for the better
part of a minute.

### Classified as OURS and HEALTHY

- `t=881ms init start` → `t=902ms engine=google active=true … entries=76` →
  `t=943ms init done: processed=5 observer=true infScroll=true`. **62 ms from
  messaging-ok to first pass.** No timing anomaly, and the D2/D5/D1 fixes all
  reported success.
  **Read again after D8:** this is the *same line* that read `t=54242ms` on the
  broken run. `init start` is stamped from navigation start, so it measures
  injection latency as well as init latency — and on this page load `load` fired
  promptly, so the injection landed at 881 ms. **The bug was never a property of
  the build; it is a property of whether that particular page load finishes.**
- `[InfiniteScroll] page appended {"nodes":10,"faviconsPainted":10}` — appending works.
- `[SHH] duplicate-UI guard: skipped 1 container node(s)` ×3 — the 2026-08-30
  "double block buttons" guard doing its job.
- Screenshot: three blocked domains each rendered a placeholder with
  **Show-once / Hide-Again / Unblock** controls. Blocking worked.

**So the run did not reproduce the reported bug.** The original symptom —
"blocked URLs sometimes show" — was not observed.

### The one REAL defect in the run, and why it could not be diagnosed

`TypeError: H is not a function  preload.js:2:1870`, dozens of times.

Investigated exhaustively and **the reported location provably cannot throw
that**:

- `H` is `resolveGoogleStream`, a hoisted `function` declaration.
- A byte-level census of the whole bundle found exactly three standalone `H`
  tokens: the declaration, and two call sites. There is no other binding that
  could shadow it.
- Brace-depth analysis puts the declaration and **both** call sites at the same
  lexical depth (2) — same scope.
- The declaration's body swallows its own errors (`try { … } catch {}` around
  every `querySelector`), so it cannot throw.
- Neither is the rest of the `MutationObserver` callback: every statement
  outside the two per-node `try` blocks is either `resolveGoogleStream` or
  `isOwnEchoRecord`, and `isOwnEchoRecord` only calls `hasAttribute`.

Checked both 1.8.19 and 1.8.20 artifacts; both have the same shape. Reproduced
the bundle in jsdom with a `browser` stub: it installs all four hooks, runs the
observer, and throws **nothing**.

Conclusion: the occurrence is real, the artifact is undiagnosable, and the
console was pointing at the enclosing callback rather than the throwing
statement. This is a **build** problem, not a logic problem.

### Fixes, in order of what they buy

1. **`sourcemap: "external"` in release builds** + `keepNames: true`.
   Verified: `preload.js:2:1870` now resolves through the shipped map to
   `src/content/preload.ts:594`, and `:2:7321` to `preconcile.ts:832` — exact
   source line and text. Cost ≈ 4% bundle size.
2. **A build stamp** (`v1.8.20+56f9ebf-dirty`, from `git rev-parse --short HEAD`
   plus a dirty flag), injected via esbuild `define` and printed by both
   scripts and included in the report header. A report now names its own build,
   so "which artifact produced this" stops being unanswerable.
3. **An in-page error trap in the preload.** `preloadDiag.errors` records
   message plus the throwing frame, capped at 25. The report prints
   `!! N UNCAUGHT ERROR(S) inside the preload:` with each one. **Verified with a
   negative control**: a deliberately thrown error is captured *with a source
   position*, and a clean batch records nothing — so the field discriminates
   rather than always being populated.
4. **Per-batch isolation** on the observer callback. Before this, a throw
   anywhere in the callback escaped to the window and aborted the remaining
   mutations in that batch *and* every batch after it — which is what turned one
   fault into dozens of identical console lines.
5. `--overwrite-dest` on the package scripts, so re-packaging the same version
   during iteration works instead of failing.

`web-ext lint` on `dist/`: **0 errors**, 3 warnings — the expected
`MANIFEST_FIELD_UNSUPPORTED` for the dual background key, plus two pre-existing
preact-runtime `UNSAFE_VAR_ASSIGNMENT` warnings. (This line previously attributed
the two to `innerHTML` / `insertAdjacentHTML`; §4a's M5 audit traced them to the
preact runtime instead. Unreachable either way, but the attribution was wrong.)

### The next field paste — this is the one that settled it

A later field paste on the same engine contained, among the usual noise:

```
[SHH] t=54242ms init start v1.8.20+d8a93a92
[SHH-preload] host=www.google.com domains=15
… entries=0
… reconciled: restamp=0 restore=5
```

plus the same three hanging subresources §9 had already filed under "not ours":
`Cross-Origin Request Blocked` for `ogads-pa.clients6.google.com` and
`ep1.adtrafficquality.google`, and the `font-display` timeout.

**That is D8, and it is the whole of D8.** The script began executing 54.2 s
after navigation; the preload had already run; and the reconcile machinery then
behaved correctly on the data it was handed. Nothing about the extension was
slow, blocked, or failing. It had not started.

Two things had to be true for this to take five weeks to see, and both are
process failures rather than code failures:

1. **The `t=` prefix was already there and already meant this.** `shhLog` had
   been stamping `performance.now()` since 2026-08-23, specifically so that
   "when" could be read off a paste. The number was in the log, in the same
   format, in the same paste as the symptom — and four rounds of work read
   around it. The instrumentation was correct and **unread**: every line was
   classified by *which system emitted it*, and the one line that said *when the
   extension started* was filed under "ours, healthy" because it was ours.
2. **The build stamp named the wrong artifact's version.** The paste says
   `v1.8.20+d8a93a92`. Every diagnostic marker this plan relies on
   (`data-shh-alive`, `data-shh-stage`, `data-shh-report`) was introduced *later*
   in this same changeset, so it was **absent from the build the user was
   running**. Their absence was read as evidence that the script had not run —
   correct conclusion — and then as evidence that the markers were the problem,
   which sent the investigation into the diagnostics layer instead of the
   manifest. **Instrumentation added after a field run cannot explain that field
   run.**

### Still outstanding

The diagnostic report (`copy(__shhDiagText())`) has still not been provided, so
B1/B2 remain blocked and the `H` error's true origin remains unknown. It is a
much smaller question than it was: the sourcemap, the error trap and the build
stamp are all shipped, so the next paste that includes the report will answer
both.


Everything below is `[code]`-reviewed but **never executed by a test**, because
jsdom 29 does not implement `document.adoptedStyleSheets` and the preload IIFE is
not importable:

- the whole preload layer — `buildHasRules`, `injectCoverCSS`,
  `__shhDisarmCover`, `__shhRearmCover`, `tryHide`, `revealRemainingGoogle`, and
  fixes N1–N7
- four call-site *orderings* inside `index.ts`, and the *declaration position* of
  the module-scope flags relative to `void init()` (see the matrix above and
  **D7c**)

The first is the one that matters: **a defect in the preload cannot be caught by
this suite at all.** The cheapest real coverage is to extract
`buildHasRules`'s rule-string construction (pure, no DOM) and the
disarm/rearm state decision into a module, as was already done for
`refresh-queue.ts` and `dedupe.ts`. That is the recommended next piece of work,
ahead of B1/B2.

### Verifying the built bundle — two traps

`build.js:16` sets `minify: !watch`, so:

1. **Identifiers are mangled.** Grepping `dist/` for `canPublishCache` or
   `isEngineActive` returns false even though the code is present. Verify with
   string literals and attribute names, which are data and survive minification.
2. **Non-ASCII is escaped.** esbuild rewrites `—` as `—` inside string
   literals, so a needle containing an em-dash never matches. Keep verification
   needles ASCII-only.

Both traps produced false "fix missing" results during this session before being
corrected. Neither indicates a build problem.

Note on scope: D1 fixes the case where the list changes **under an open tab**
(`LIST_UPDATED` reaches it). It does **not** fix the case where the broadcast
never arrives — that is C1/C2 below, and until those land, blocking from the
popup while a search is open can still silently fail to reach the tab at all.

## 6. What v1 got wrong — kept deliberately

| v1 claim | Reality | Tag |
|----------|---------|-----|
| A1 is the root cause; a node's own button disqualifies it | Attribute is on the card (`block-button.ts:51`); `querySelector` cannot match self. **Three reviews refuted it; now closed by an executable test.** | `[repro]` |
| A1 is "the only load-bearing fix" | Inverted: fixing A2/D5 *does* fix the symptom; fixing A1 alone would not have. The harness's own ranked defects contain no A1. | `[repro]` |
| `[V]` = verified | Used for reachability claims it cannot support | — |
| B2 snippet: cite inside the heading | Cite is a **sibling**; snippet is a no-op. **v2's first fix attempt repeated this error** — a heading-containment discriminator cannot work on this layout. | `[code]` |
| "Phases 1 and 2 are independent" | B1+B2 are the two stops against a `[field]` whole-page hide; the aggregate guard does not cover the 2–3-host band | `[field]` |
| B4 deferred as "not the primary path" | It is the **only** path for Google additions | `[code]` |
| Baseline "all 7 failures are `localStorage.clear`" | 4 were `setItem` in the test body; 3 were `clear` in `beforeEach`. 10 assertions were dead, plus one passing-but-vacuous test. | `[repro]` |
| Baseline 537/7, "budget for new failures" | Env fixed in P0; **zero** new failures surfaced. Suite green before any fix. | `[repro]` |
| "Assert identical final visibility" as the A1 regression | Vacuous — the harness discards `drive()`'s `found` flag and `snap()` no-ops on a missing probe, so it passes with the content script absent | `[code]` |
| Mutation criterion given as one sentence | The repo already ships 33 mirror-based tests that survive a full revert of the shipped code — the A5-R1 failure mode, live today | `[code]` |

**Two methodological lessons, kept deliberately.**

1. v1 built an elaborate timing story on a `[code]`-only reading, then used
   verification tags to launder reachability. Two of three reviews
   independently refuted the centrepiece. v2 states reachability as
   `[unverified]` unless a capture or repro exists.
2. v2's *first correction* to B2 repeated v1's error — it proposed a
   heading-containment discriminator, which a third reviewer caught by checking
   the fixtures. A fix written from a plausible-sounding story is still wrong
   until a test or a capture touches it. Hence: **close every contested claim
   with an executable assertion before implementing against it.** §2 is the
   template — four assertions, the second of which settles it.

## 7. P0 — the real gate is coverage, not a red baseline

The `localStorage` environment defect is **fixed** `[repro]`: `vitest.setup.ts`
installs a working in-memory `Storage` when the existing global lacks the WebIDL
methods (Node 25 + vitest 1.6.1 pass `--localstorage-file`, which shadows
jsdom's). Suite is 544/544, mutation-tested (neuter → RED, restore → GREEN).

That restored the *ability* to test the cache paths. It did not add tests.

**Two corrections to v1's account of the 7 failures `[repro]`:**
- They were **not** all `localStorage.clear`. Four were `setItem` **in the test
  body** (`debug.test.ts:102,108,119,125` — its `beforeEach` wraps `clear()` in
  `try/catch` at `:60-64` so it survives, and the body throws); three were
  `clear` in a bare `beforeEach` (`append-insertion.test.ts:1362`), which aborts
  the hook so the body never runs.
- **Ten dead assertions** resulted: `debug.test.ts:104,110,120,121,127` and
  `append-insertion.test.ts:1379,1380,1391,1402,1403`. All execute and pass now.
- `debug.test.ts:113-116` was passing **and vacuous** — `getItem` threw, the
  `catch` at `debug.ts:54-56` swallowed it, flag stayed at default. Right
  outcome, wrong reason. So "537 passing" was never 537 *meaningful*.

**Second, independent environment gap `[code]`:** jsdom 29 does not implement
`document.adoptedStyleSheets`, so `injectHidingStyles()` (`index.ts:901-908`)
throws into its own `catch` and the `.shh-hidden` / `.shh-pban` layers are
never created. Recorded explicitly in `tests/env.test.ts` rather than left
latent. **Not** shimmed — decide it in the phase that needs it.

P0's remaining work: tests for `updateCache`, `recoverStateFromCache`,
`earlyHideFromCache` and `refreshPrefs`, driving the **shipped** modules.

## 8. Acceptance criteria

**Gates.** `tsc --noEmit` clean; `vitest run` **44 files / 750 tests, all
passing, 0 skipped**. `npm run build` clean; `dist/manifest.json` verified —
including `run_at` on every entry. `web-ext lint` on `dist`: **0 errors**, 3
warnings — the expected `MANIFEST_FIELD_UNSUPPORTED` for the dual background key,
plus the two pre-existing preact-runtime `UNSAFE_VAR_ASSIGNMENT` warnings.

**The artifact is the tested artifact.** Build stamp `v1.8.20+61e3ba0a`,
packaged to `releases/search_hit_hider_and_infinite_scroll-1.8.20.zip`. The stamp
is generated by the same esbuild `define` at build, lint and package time and was
read back from all three, so the zip contains exactly the code the suite ran.
This is the check that makes the §4a note about minified identifiers and escaped
non-ASCII unnecessary for release questions — you compare stamps, you do not grep
`dist/`.

The field paste quoted in **D8** carries `v1.8.20+d8a93a92`, which is the
**pre-fix** artifact — the build the user was running when the symptom was
captured. It is named here so nobody reads the two stamps as a contradiction of
the paragraph above.

### Measured mutation matrix — what is actually pinned

A five-angle adversarial review of this changeset found that **`index.ts` had
zero test binding**: eight reverts (the module-scope listener, the D1 call site,
the D5 guard, the suspend teardown, the `wasActive` read) each left the suite
green. The pure helpers were pinned; the wiring that ships was not.

The fix was structural, not more assertions — the untestable decisions moved
into `refresh-queue.ts`, `revealPreloadHiding` and `shouldEvictTab`, following
the A5-R1 pattern. Re-running the same mutations:

| Mutant | Result |
|---|---|
| identity rewrite (control) | GREEN ✓ |
| refresh queue collapsed to one slot | **RED** ✓ |
| queue drains prefs before list | **RED** ✓ |
| `shouldReScan` loses `engineActive` | **RED** ✓ |
| `shouldEvictTab` → evict on 1 failure | **RED** ✓ |
| `revealPreloadHiding` reveals blindly | **RED** ✓ |
| `hideResult` stops stamping `data-shh-url` | **RED** ✓ |
| `parseCache` manufactures `[]` from a malformed payload | **RED** ✓ |
| `isEngineActive` `!== false` → `=== true` | **RED** ✓ |
| `canPublishCache` → always true | **RED** ✓ |
| **D1 call site: `refreshEntries` → stamped-only** | GREEN ⚠️ |
| **re-scan: drop the guard at the `visibilitychange` CALL SITE** | GREEN ⚠️ |
| **D5: `stateAuthoritative` left true on the paused return** | GREEN ⚠️ |
| **D2: `updateCache()` moved back below the inactive return** | GREEN ⚠️ |

**The suspend teardown is no longer in that list.** It was, and the reason it
stayed green was that `SUSPEND_HANDLERS` — a map of eight empty arrow functions
with a comment calling it "the load-bearing half" — was imported by nothing in
`src/`. A self-consistent pair of literals constrains nothing about a teardown.
Measured: deleting all eight obligations' implementation, or any single one of
`observer?.stop()`, the cover-disarm hook, or the cache write, left **673/673
green**. That is A5-R1 restated with more confidence in the comment.

`runSuspendTeardown(deps)` now owns the order and completeness of the teardown
and takes its side effects as injected dependencies, so `index.ts` supplies real
closures and a test can drive the shipped function. Re-measured, all **RED**:

| Mutant | Kills |
|---|---|
| delete the `stopObserver` step | 2 |
| delete the `disarmStaticCover` step | 2 |
| delete the `writeCache` step | 3 |
| run `writeCache` first | 4 |
| a throw aborts the rest of the teardown | 1 |
| destroy the observer before stopping it | 3 |
| `revealHiddenNodes` no longer runs first | 3 |

**The remaining gaps are call-site *ordering* and *declaration position* inside a
side-effecting module** — the presence or position of a call in `index.ts`, and
where a `let` sits relative to the call site that reads it, not the logic either
one invokes. That is a genuine, stated limitation, not an oversight: closing the
rest of it needs the audit harness's page-load driver promoted into `npm test`
(the harness already builds these scenarios but is untracked and currently red
against post-fix expectations).

**D6, D7 and A1 narrowed this gap and did not close it.** Driving the built
bundle in jsdom (`tests/tab-heals.test.ts`, `tests/diag-bridge.test.ts`,
`tests/prefs-live-matcher.test.ts`) is what makes call-site order testable at
all, and it is the only kind of harness that can see D7c, because a declaration
order only matters when the module actually evaluates. What remains is stated
plainly rather than glossed: **mutation testing deletes statements and cannot see
a declaration order**, and D7c is the proof — the delete-the-latch mutation on
`pagePrimed` was green because the latch was already dead. A hoist/reorder mutant
would be needed to close that class, and none is defined. Recorded so the next
person inherits the debt rather than rediscovering it, and so nobody reads the 12
kills below as coverage of the module's *evaluation order*.

### The D6/D7/A1 matrix — measured, 12 of 12 killed

**This table replaces the earlier "declared, NOT RERUN" block.** Those rows were
written down as a to-do; they have now been run, and the results are below. The
old block's framing is worth keeping in one respect: a declared matrix that is
mistaken for a measured one is worse than no matrix, so the honest version
shipped first and the run came second.

| Mutation | What it removes/changes | Test that kills it | Killed? |
|---|---|---|---|
| **P1** | delete the cache prime from `init()`, `isGoogleOrPrimes` gate included | `tests/tab-heals.test.ts` | **3 failures** |
| **P2** | the prime trusts a non-authoritative cache | `tests/tab-heals.test.ts` | **2 failures** |
| **P13** | `pagePrimed` declared without its initialiser, so it reads `undefined` | `tests/tab-heals.test.ts` | **1 failure** |
| **P14** | the post-prime reconcile | `tests/tab-heals.test.ts` | **1 failure** |
| **P15** | the full scan, from `protectPage` | `tests/tab-heals.test.ts` | **7 failures** |
| **P16** | the healer never starts | `tests/tab-heals.test.ts` | **2 failures** |
| **P17** | the healer does not reconcile | `tests/tab-heals.test.ts` | **1 failure** |
| **P18** | the hover class is latched to the prime's default | `tests/tab-heals.test.ts` | **1 failure** |
| **P19** | the hover class is applied from the prime only, never corrected | `tests/tab-heals.test.ts` | **1 failure** |
| **A1a** | the cosmetic-pref branch never rebuilds the matcher | `tests/prefs-live-matcher.test.ts` | **2 failures** |
| **A1b** | the cosmetic-pref branch never reconciles the DOM | `tests/prefs-live-matcher.test.ts` | **2 failures** |
| **A1c** | the `:has()` sheet is never updated | `tests/prefs-live-matcher.test.ts` | **1 failure** |

**All 12 killed.** P15's 7 failures are the sharpest number in the table: one
statement, `processResults(getCachedResultNodes())`, removed from a path the
review had already declared "covered by the reconcile" — and it broke seven
assertions. That is the measurement behind D7a, and it is why the reconcile was
described as structurally unable to stand in for the scan rather than as
"mostly equivalent".

**P13 deserves a note, because it is the one mutation in this document that
could not have been found by mutation testing.** It was only meaningful after the
flags were hoisted. Before the fix, the *delete-the-latch* mutation on
`pagePrimed` was **GREEN**, because the latch was already inert. See D7c.

**D8's four mutations are listed in D8, not here, and the reason is worth
stating.** One of them reverts `document_end` to `document_idle` — a **manifest**
decision, not a source decision, and this matrix's protocol (M1–M4) is built
around `src/**`. A whole class of real defects lives outside `src/`, and the
defect that caused this field bug lived there for six weeks. The `run_at`
assertions in `tests/manifest.test.ts` now cover it, but nothing in this
document's mutation protocol would have found it. **Extend M1 before trusting the
matrix again.**

**Two mutations in this block were REJECTED rather than shipped, and are recorded
as rejections, not as findings:**

- **H3 — run tier 2 on `gotState` alone, dropping the `|| !prefs` half.**
  **GREEN.** The healer already covers the gap it would close: a skipped tier 2
  leaves `prefs` null, `recoverStateFromCache` supplies defaults, and the
  healer's first poll reads the real prefs. Not load-bearing. It is kept in the
  code because it recovers *sooner*, and it is labelled at the call site as a
  recover-sooner change rather than a correctness one — which is the only
  honest description of it.
- **A revive on the `!prefs` return.** **GREEN.** That path is reachable only when
  the saved cache says the user **paused** this engine, so it is the correct
  "do nothing" exit; a revive there would imply a recovery attempt on a
  deliberately suspended page. Removed, with the reason at the return.

**Two test-fixture defects in this block, each of which produced a GREEN mutation
first — i.e. each was a *test* bug, not dead code, and would have been recorded
as dead code by anyone who trusted the first run:**

- **The P1 fixture left `storage` working.** Tier 1 then succeeded in about a
  millisecond, so the cache prime was never reached and deleting it changed
  nothing. It now fails **both** storage halves *and* hangs messaging forever, so
  nothing but the cache can protect the page.
- **The healer fixture let storage succeed immediately,** so the fast path
  handled the case and the healer never ran. The mutation survived. It also
  cleared `_shh_cache` unconditionally, which made the prime tests and the healer
  tests disjoint by construction — see D7b.

Both are the same failure mode as §8's vacuous tests: **a test whose premise
never reached the code it named.** The mirror-vs-store mistake in new clothes — the
test encoded a theory about which path runs instead of constructing the state
that reaches it.

**Older rows in this block, still not re-measured and therefore not claimed:**
`pageWired` latch deleted and `tabWired` latch deleted (double-registration is not
observable through DOM assertions), H1/H2 — blocked by the healer fixture defect
above — and M1/M3/M4's *ordering* claims. They are listed here only so nobody
assumes they were covered by the run above.

A third fixture defect of a different kind is not in that list because it never
produced a green mutation: the paused-cache test expected
`bail-cache-says-paused` with `storage` working and got `init-complete` — and the
**product was right**. A successful `storage.local` read is authoritative, so the
cache is never consulted; storage has to fail for that exit to be reachable at
all. It failed loudly instead of silently, which is why it is the lesser problem
than the two above, and it is documented at the test.

### The diagnostics were lying, and the tests did not catch it

The field instrumentation was reviewed adversarially on 2026-09-28 and **it would
have told the user the wrong thing on exactly the page they needed it for.** The
findings, and what closed them:

- **The D1 detector never ran.** `setDiagMatcher` was called from
  `refreshMatcher`, which `init()` does not call — it builds the matcher at its
  own line. So `liveMatcher` was null on a normal load, the loop was skipped, and
  the report printed `visibleButBlocked: 0` plus *"no known failure signature
  detected"*. A false all-clear on the broken page. The unit test passed because
  it called the setter **by hand**; the wiring was untested and broken. Fixed by
  `syncDiag()`, the single publisher called from every mutation site, and by a
  test that arms the detector through the real `GoogleAdapter` rather than a stub
  matcher — a stub cannot catch missing wiring.
- **The count was capped at 8.** The guard meant to bound the 8-host *sample*
  `continue`d the whole loop body, so it bounded the *count* too, while the popup
  claimed the number was exact.
- **It counted containers, and called hidden things visible.** The candidate list
  includes three section wrappers, so one blocked result inside
  `MjjYud > tF2Cxc > N54PNb > kb0PBd` counted up to four times; a preload-hidden
  result (no `data-shh-result`) read as `VISIBLE`, so a *correctly working*
  degraded start manufactured D1 evidence; and an AI Overview the ambiguity guard
  **deliberately** leaves visible was reported as a defect.
- **It missed breadcrumb cites.** `example.com › docs › page` is one domain to
  `domainFromDisplayText` and garbage to a raw `<cite>` read, so real blocked
  results were invisible to it — precisely the cite shape production went out of
  its way to support.
- **A paused page was reported as "defect D5".** The paused return set
  `source: "cache", entries: 0` and the verdict named D5 for the most likely
  field paste of all. Now `source: "paused"`, with `engineActive` surfaced and
  the D1 verdict gated on it.
- **Six `rejected` rows were permanently zero** and printed under the header
  "which guard ate the result" — a reader saw `adapterOfferedNone: 0` and
  concluded the adapter always offered results, the opposite of the one counter
  that diagnoses a class rotation. The probe-only reasons now live in a separate
  union, and the three uncounted production exits (`noMatcher`,
  `skippedContainer`, `nodeThrew`) are wired.
- **The discovery probe manufactured the evidence for B1/B2.** It counted
  section wrappers Google *intends* to descend into and then described the
  resulting number as "the evidence B1 would need". It ran the guards in a
  different order than `walkResults`, so `section` was unreachable for the case
  it exists for while `multiCite` shadowed it, and `aggregate`/`nonResult` were
  dead branches. It also sampled the *most specific* candidate's first match,
  which is systematically the node most likely to be offered.

Sixteen mutations were run against the diagnostics module. **The first pass killed
9 of 13.** The four survivors were all real test defects, not dead code — most
notably a "reports zero when every blocked result is already stamped" test that
passed with the stamp check deleted, because the Google adapter already filters
stamped nodes out of `getResultNodes`, so the loop never saw the node. That test
now supplies nodes explicitly. Final: **16/16 killed.**

### Four vacuous tests this review caught in my own work

Worth recording, because each passed while asserting the opposite of its stated
purpose. **D8 adds three more of the same species — one of which passed with the
gate deleted, and none of which could ever have failed.** They are written up in
full in D8; the reason this list is worth keeping is that every entry in it
looked like coverage.

- `tests/cache-state.test.ts` had a test named *"never manufactures an empty
  domain list from a malformed payload"* that asserted it **did** manufacture
  one. The code was on the wrong side of its own comment, and the consequence
  was D5 through the front door. Fixed in both directions.
- `tests/engines/google-self-button.test.ts` asserted only on `injectBlockButton`'s
  **return value**, so a mutation that built the button and never attached it
  satisfied every assertion — while the file's whole subject is the button being
  a *descendant* of the result. Now asserts `isConnected` / `node.contains(btn)`.
- `timingSnapshot`'s delta assertions were `deltaMs >= 0`, which cannot fail —
  deleting the `m.t - prev` computation entirely left the suite green. Now
  `first.deltaMs === first.tMs` and `second.deltaMs === second.tMs - first.tMs`.
- Two tests in `tests/blocking/preload-hiding.test.ts` re-implemented
  `revealPreloadHiding`'s loop **inside the test file** and asserted the test's own
  `continue`. Proof: making `preloadHiddenDescendants` return `[]` left both
  green, as did making it return every descendant unfiltered. Both now call the
  shipped function with a stubbed *parameter*. (M2's kill is a single assertion
  and is the most fragile of the five — noted so the next person does not read
  the green as stronger than it is.)

And one test that **never ran**: `manifest.test.ts`'s `dist/` assertion was
`it.skipIf(!existsSync(dist))`, but `dist/` is gitignored, the only workflow is
`workflow_dispatch`, and the release job runs `npm test` *before* `npm run build`
— so at test time `dist/` never existed and the test always skipped. Fixed by
adding `"pretest": "npm run build"` (0.35 s), so it now executes. Skipped count
went 1 → 0.

### A reviewer claim I checked and rejected

The consistency review asserted that `manifest.json`'s `background.service_worker`
"would prevent the extension loading at all in its only supported browser", on the
grounds that Firefox's `background` schema sets `additionalProperties: false`.
Measured: `web-ext lint` reports it as `MANIFEST_FIELD_UNSUPPORTED` — a
**warning**, meaning Firefox ignores the key. The extension loads. Recorded
because the claim reads as settled fact and is not, and because a test asserting
the key must be present *looks* like protection while protecting nothing on the
target platform.

### Verifying the built bundle — two traps

`build.js` sets `minify: !watch`, so:

1. **Identifiers are mangled.** Grepping `dist/` for `canPublishCache` returns
   false even though the code is present. Verify with string literals and
   attribute names, which are data and survive minification.
2. **Non-ASCII is escaped.** esbuild rewrites `—` as `—` inside string
   literals, so a needle containing an em-dash never matches. Keep needles
   ASCII-only.

Both produced false "fix missing" results before being corrected.

**Mutation protocol — applies to every fix.**

- **M1** The mutant is applied to `src/**` only. Immediately after, run
  `git diff --stat -- tests/ reports/` → must be **empty**. A non-empty diff
  invalidates the run.
- **M2** RED must be ≥1 failure in a test that **imports the shipped symbol**
  under test, and the message must name that symbol or one of its attributes.
  A `beforeEach` throw, a `drive()` timeout or a missing snapshot is **not** a
  RED.
- **M3** For any test cited as a fix's net:
  `grep -n "mirror\|Mirror\|re-implementation\|replicate" <file>`. A hit means
  the subject is locally defined — the test is a **decorator** and may not be
  cited. Known-unverified inventory, to be ported or recorded in Risks:
  `tests/preload-flicker.test.ts` (30 tests; header `:22-25` admits it mirrors
  `resolveHost` + `buildHasRules`), `tests/engines/google-duplicate-ui.test.ts`
  (2 tests; mirrors at `:207-229` — **this is the file P1 touches**),
  `tests/infinite-scroll/cover-reveal.test.ts` (1 test; mirror at `:98-107`).
  A full revert of the shipped code leaves all 33 green today.
- **M4** Record sha256 of **both** the src file and the test file. The src hash
  must equal the pre-mutation hash; the test hash must be unchanged throughout.

Model artifact: `tests/engines/google-ancestor-guard.test.ts:24-28`.

**Discriminating power.** Today the suite has zero power for B1, B2 and the
refuted A1 — those fixtures do not exist. Per fix, name the assertion that goes
red on revert. B1's primary gate is the existing
`google.test.ts:439-448` ("never offers the all-results wrapper"), over the
field-captured 5-level `kb0PBd` fixture.

**Fixtures that must be built.** "Section whose descent fails" (the only case
B1 changes — no current fixture reaches `google-dom.ts:349`); "blocked result
with one foreign sitelink" (B2, with the cite as a **sibling** of the title
block, per `google.test.ts:391-398`); and "section citing 2–3 distinct hosts"
— the band that trips neither the aggregate (≥4) nor the section guard, and
therefore the fixture that actually gates B1.

**Field confirmation is a decision table, not a paste.** `__shhDiag()` is only
partially decisive: it counts markers and **cannot attribute a rejection to a
guard**. Add three fields to `collectDiagnostics` (`debug.ts:160`), all gated
on `debugEnabled`:

1. `matcher: { entries, wildcard, source: "background"|"cache"|"defaults" }`
2. `rejected: { result, containsProcessed, insideProcessed, noUrl, nonResult, noHeading, noHost }` — counts at `index.ts:561,569,586,592` and `google.ts:309-318`
3. `effect.degradedStart: boolean` — from `index.ts:116`

| reading | verdict |
|---|---|
| `matcher.source === "cache"` and `entries === 0` | **D5** — degraded start, cold cache |
| `entries >= 1` incl. the blocked domain, and `rejected.containsProcessed + rejected.insideProcessed > 0` | the inverted-nesting variant (§2) |
| `rejected.noHost > 0` | discovery regressed — opaque-href/cite resolution |
| `stampedResult >= 1` but `placeholders === 0` | **D3** — trapped button |

**Do not use `lifecycle.processed` as a count.** `index.ts:273` reads
`getCachedResultNodes()` *after* `processResults`, so it is "still un-stamped",
not "processed" (audit D7). And `lifecycle.shhDiag` keeps only the last 10 log
lines (`index.ts:127`) truncated to 800 chars (`debug.ts:189`) — usable only for
a substring read.

**A regression test that asserts "identical final visibility" is vacuous.** The
audit harness discards `drive()`'s `found` flag and `snap()` returns silently
on a missing probe, so `bucket(null) === bucket(null)` passes with the content
script entirely absent. Any harness-derived test must assert **per-side
absolutes first** — liveness (`init done` seen, messages issued), then discovery
(adapter offered the node), then effect (exactly 1 `[data-shh-result]`, 1
`.shh-placeholder`, containing `.shh-btn-show`) — and only then compare the two
latencies. Assert **DOM state markers**, never
`harness/visibility.ts`'s modelled `visible` boolean: that model resolves
properties by first-match-in-array with no specificity, no source order and no
`!important` distinction, and fails closed toward VISIBLE — the direction that
manufactures this bug's symptom. Also re-base the harness fixture on the
field-captured shape (`google.test.ts:391-412` — `/goto?url=` opaque hrefs,
`MjjYud > A6K0A > tF2Cxc > N54PNb > kb0PBd`), not `harness/dom.ts:30-42`; with
direct `https://` hrefs `isExternalHref` succeeds and the
`googleDisplayDomain` fallback — B2's entire subject — is never exercised.
