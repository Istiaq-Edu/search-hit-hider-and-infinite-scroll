import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

// ============================================================
// A tab that cannot load its state must HEAL, not die
// ============================================================
//
// Field report, 2026-09-30: "not responsive means the extension doesn't have
// any working effects on the page like it's not even there" â€” and opening the
// extension once makes it work.
//
// That named a concrete failure mode, and the code had exactly one. `init()`
// returned early when `prefs` was null, and `reviveFromBackground()` â€” the only
// thing that could recover the tab â€” was called FURTHER DOWN, so it never ran.
// The tab was inert for its entire page session, and opening the popup woke
// the background, which was the only outside event that could unstick it.
//
// Two defects were considered. ONE is the real one, and it is what the
// mutation suite pins:
//
//   * the healer polled ONLY `sendMessage` â€” so when the tab was inert
//     *because* the event page was cold, it spent sixty seconds asking the one
//     component that could not answer.
//
// Two other candidate fixes were tried and REJECTED because the mutation suite
// proved them not load-bearing, rather than kept because they felt right:
//   * starting a revive on the `!prefs` return â€” that path is reachable only
//     when the saved cache says PAUSED, so it is the correct "do nothing" exit;
//   * running tier 2 when the list succeeded but prefs failed â€” the healer's
//     first poll already recovers the prefs, so it only makes recovery faster.
// ============================================================

const BUNDLE = readFileSync(resolve(process.cwd(), "dist", "content", "index.js"), "utf8");

const ENTRIES = [{ domain: "blocked.com", mode: "block", enabled: true, createdAt: 0 }];
const PREFS = {
  debugMode: true, subdomainWildcard: true, pausedGlobally: false,
  pausedEngines: [], engineToggles: { google: true },
  showNotices: true, showOnHover: false, infiniteScroll: false,
};

interface Booted { w: any; d: Document; sent: unknown[] }

function boot(opts: {
  listFails?: boolean;
  prefsFails?: boolean;
  msgHangs?: boolean;
  msgRejects?: boolean;
  /** Fail the first N storage reads, then succeed â€” the transient case. */
  storageFlakyFor?: number;
  /** The AUTHORITATIVE list storage returns. Defaults to ENTRIES. */
  storageEntries?: unknown[];
  /** Delay the authoritative list read, so the pre-authoritative state is observable. */
  listDelayMs?: number;
  /**
   * Write this to `_shh_cache` instead of clearing it. Without it the cache is
   * always empty, which is why the prime tests and the healer tests were
   * disjoint by construction: a primed tab's healer path had no coverage at all.
   */
  cachePayload?: unknown;
  /** Override a prefs field on the AUTHORITATIVE read. */
  prefsOverride?: Record<string, unknown>;
  evaluate?: boolean;
} = {}): Booted {
  const sent: unknown[] = [];
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><div id="rso">
      <div class="MjjYud"><div class="tF2Cxc">
        <div class="kb0PBd"><a href="/url?q=https://blocked.com/x"><h3>Blocked</h3></a>
        <cite>blocked.com</cite></div>
      </div></div>
    </div></body></html>`,
    { url: "https://www.google.com/search?q=t", runScripts: "outside-only", pretendToBeVisual: true }
  );
  const w: any = dom.window;
  const d = w.document;
  // No localStorage cache on purpose: `recoverStateFromCache()` must return
  // null, which is the fresh-profile case that made this path reachable.
  // `cachePayload` opts out, for the prime + heal combination.
  w.localStorage.clear();
  if (opts.cachePayload !== undefined) {
    w.localStorage.setItem("_shh_cache", JSON.stringify(opts.cachePayload));
  }
  w.CSSStyleSheet.prototype.replaceSync = function () {};
  w.CSSStyleSheet.prototype.insertRule = function () { return 0; };
  if (!("adoptedStyleSheets" in d)) {
    const sheets: unknown[] = [];
    Object.defineProperty(d, "adoptedStyleSheets", {
      get: () => sheets.slice(),
      set: (v: unknown[]) => { sheets.length = 0; sheets.push(...v); },
      configurable: true,
    });
  }
  const messageOk = async (m: any) =>
    m.type === "GET_LIST" ? { entries: ENTRIES } : { prefs: PREFS };
  let flakyLeft = opts.storageFlakyFor ?? 0;
  const flaky = () => {
    if (flakyLeft > 0) { flakyLeft--; throw new Error("storage temporarily unavailable"); }
  };
  w.browser = {
    runtime: {
      getManifest: () => ({ version: "1.8.20" }),
      id: "t",
      onMessage: { addListener() {} },
      // A cold event page HANGS; it does not reject. Modelling it as a rejection
      // would understate the bug.
      sendMessage: (m: unknown) => {
        sent.push(m);
        if (opts.msgHangs) return new Promise(() => {});
        if (opts.msgRejects) return Promise.reject(new Error("no background"));
        return messageOk(m as any);
      },
    },
    storage: {
      local: {
        get: async () => {
          flaky();
          if (opts.listFails) throw new Error("storage.local unavailable");
          if (opts.listDelayMs) {
            await new Promise((r) => setTimeout(r, opts.listDelayMs));
          }
          return { shh_entries: opts.storageEntries ?? ENTRIES };
        },
        set: async () => {},
      },
      sync: {
        get: async () => {
          flaky();
          if (opts.prefsFails) throw new Error("storage.sync unavailable");
          return { shh_prefs: { ...PREFS, ...(opts.prefsOverride ?? {}) } };
        },
        set: async () => {},
      },
    },
  };
  if (!w.chrome) w.chrome = w.browser;
  if (opts.evaluate !== false) w.eval(BUNDLE);
  return { w, d, sent };
}

describe("the report is published on the FAILURE path too", () => {
  // The blind spot a field run exposed: `data-shh-report` returned `null`,
  // because the report was only published AFTER `first-processResults-done` â€”
  // i.e. only on success. A tab that bailed early, the exact state reported as
  // "the extension is not there", published nothing, so the one thing we needed
  // to read was the one thing we could not see.
  it("publishes a report as soon as the module is evaluated", async () => {
    const { d } = boot({ msgHangs: true, evaluate: false });
    const w: any = (d as any).defaultView;
    w.eval(BUNDLE);
    // Synchronously after evaluation â€” no flush. The point is that it does not
    // depend on init reaching its end.
    const attr = d.documentElement.getAttribute("data-shh-report");
    expect(typeof attr).toBe("string");
    expect((attr as string).startsWith("=== SHH FIELD REPORT ===")).toBe(true);
  }, 25000);

  it("records that the script ran and how far it got", async () => {
    const { d } = boot({ msgHangs: true, evaluate: false });
    const w: any = (d as any).defaultView;
    w.eval(BUNDLE);
    // `alive` is the build stamp: its absence means the script did not run at
    // all, which is a completely different bug from anything below.
    expect(d.documentElement.getAttribute("data-shh-alive")).toMatch(
      /v1\.8\.\d+\+[0-9a-f]{8}/
    );
    const stage = d.documentElement.getAttribute("data-shh-stage");
    expect(stage).toBeTruthy();
    expect(["module-evaluated", "init-start", "no-engine"]).toContain(stage);
  }, 25000);

  it("protects the page from the CACHE, with the background dead", async () => {
    // THE symptom: "the extension has no effect on the page, as if it isn't
    // there." `earlyHideFromCache()` set inline display:none, but the matcher,
    // observer, placeholders and block buttons all waited behind the async
    // state load â€” up to 2.5s + two 400ms/2500ms retries, 5.8s on a cold event
    // page. In that window the page looked completely normal, and opening the
    // extension only appeared to help because the user had spent that long
    // elsewhere.
    //
    // Here BOTH storage and messaging are unavailable â€” messaging hangs
    // FOREVER, so no authoritative read can ever arrive. Only the cache can
    // protect the page.
    //
    // Both failures are needed. An earlier version of this test left `storage`
    // working, so tier 1 succeeded in about a millisecond and the prime was
    // never reached â€” which is why mutation P1 (deleting the prime) left the
    // suite green.
    const { w, d } = boot({
      msgHangs: true, listFails: true, prefsFails: true, evaluate: false,
    });
    // An AUTHORITATIVE cache, which is what a previous healthy page wrote.
    w.localStorage.setItem(
      "_shh_cache",
      JSON.stringify({ domains: ["blocked.com"], wildcard: true, paused: false })
    );
    w.eval(BUNDLE);
    await flush(500);
    expect(d.querySelectorAll("[data-shh-result]").length).toBeGreaterThan(0);
    // The controls are the part that was missing, and the part a user notices.
    expect(d.querySelectorAll(".shh-placeholder").length).toBeGreaterThan(0);
    const bar = d.querySelector(".shh-placeholder");
    expect(bar?.textContent ?? "").toMatch(/Unblock/i);
  }, 25000);

  it("does NOT prime from a non-authoritative cache", async () => {
    // A cache that exists but is not authoritative means we hold no list merely
    // because the read failed. Priming from it would claim the page is
    // protected while hiding nothing â€” a worse failure than doing nothing.
    // Both storage halves must fail here too, for the same reason as above.
    const { w, d } = boot({
      msgHangs: true, listFails: true, prefsFails: true, evaluate: false,
    });
    w.localStorage.setItem("_shh_cache", "not json at all");
    w.eval(BUNDLE);
    await flush(500);
    expect(d.documentElement.getAttribute("data-shh-stage")).not.toBe(
      "protected-from-cache"
    );
  }, 25000);

  it("lets the AUTHORITATIVE list un-hide what a stale cache hid", async () => {
    // The regression the cache prime could have introduced, and the reason
    // protectPage's two halves are not latched together.
    //
    // A previous tab left a cache saying blocked.com is on the list. The user
    // then removed it. This page primes from that cache â€” correct, instant â€” and
    // correctly hides the result. The authoritative read then arrives and says
    // the list is EMPTY.
    //
    // If the whole of protectPage were a one-shot, the second call would return
    // early: the matcher would keep the cache's entries and the result would
    // stay hidden with no Unblock, for the life of the page. That is the
    // 2026-08-30 "it removed other search results" bug, reintroduced through the
    // back door by the prime itself.
    //
    // Storage works here (tier 1 succeeds), so the authoritative read lands
    // normally â€” the prime just has to not block it from taking effect. It is
    // DELAYED so the intermediate state is observable: without the delay the
    // reconcile completes before the first assertion and the test would pass
    // vacuously, or fail for the wrong reason.
    const { w, d } = boot({
      storageEntries: [], listDelayMs: 400, evaluate: false,
    });
    w.localStorage.setItem(
      "_shh_cache",
      JSON.stringify({ domains: ["blocked.com"], wildcard: true, paused: false })
    );
    w.eval(BUNDLE);
    // While the authoritative read is still in flight, the cache prime is
    // hiding the result â€” this is the whole point of the prime.
    await flush(150);
    expect(d.querySelectorAll("[data-shh-result]").length).toBeGreaterThan(0);
    expect(d.querySelectorAll(".shh-placeholder").length).toBeGreaterThan(0);
    // Once it lands with an empty list, exactly that must be undone.
    await flush(700);
    expect(d.querySelectorAll("[data-shh-result]").length).toBe(0);
    expect(d.querySelectorAll(".shh-placeholder").length).toBe(0);
    expect(d.body.innerHTML).toMatch(/blocked\.com/);
  }, 25000);

  it("STILL heals when the cache prime ran and the authoritative read then failed", async () => {
    // The bug the review found, and the one gap in this file that let it
    // through: `boot()` used to clear `_shh_cache` unconditionally, so the
    // prime tests and the healer tests could never meet. Here they do.
    //
    // Sequence: the prime hides blocked.com from the cache. Tier 1's list read
    // then fails, the tier-2 ladder is exhausted, and the tab goes degraded on
    // the cache. At that point the authoritative list â€” which does NOT contain
    // blocked.com â€” is still unread.
    //
    // `reviveFromBackground` must run. It was the one call site inside
    // wireTabOnce(), whose latch the PRIME had already closed with
    // `degradedStart` still false â€” so a primed tab never healed at all and
    // stayed frozen on the cache snapshot until reload.
    const OTHER = [{ domain: "other.com", mode: "block", enabled: true, createdAt: 0 }];
    const { d } = boot({
      storageFlakyFor: 2,               // tier 1 fails, then storage comes back
      msgRejects: true,                 // tier 2's ladder is exhausted
      storageEntries: OTHER,            // authoritative: blocked.com is NOT on it
      cachePayload: { domains: ["blocked.com"], wildcard: true, paused: false },
    });
    // The prime did its job: hidden, before any authoritative read.
    await flush(300);
    expect(d.querySelectorAll("[data-shh-result]").length).toBeGreaterThan(0);
    // The healer runs and swaps in the real list, so the cache's verdict is undone.
    await flush(9000);
    expect(d.querySelectorAll("[data-shh-result]").length).toBe(0);
    expect(d.documentElement.getAttribute("data-shh-report")).not.toMatch(
      /degradedStart:\s*true/
    );
  }, 30000);

  it("protects the page even though the window `load` event NEVER fires", async () => {
    // THE FIELD BUG, reproduced. A field capture on Google read
    // `[SHH] t=54242ms init start` â€” the content script had not executed 54
    // seconds after navigation â€” and this repo's own plan doc recorded
    // `t=102556ms` on Startpage. `document_idle` is defined as "after the window
    // `load` event", and a Google results page hangs on subresources long enough
    // that `load` never fires promptly. So the entire extension â€” preload aside â€”
    // was unexecuted for that whole window, and opening the popup merely took
    // long enough for the deferred injection to land. Every downstream theory
    // (cold background, messaging timeouts, state loading) was measuring the
    // consequences of a script that had not run yet.
    //
    // JSDOM does not fire `load` on its own in this harness, so this is close to
    // the default path. What is asserted is the property that matters: the page
    // is protected promptly and WITHOUT waiting for `load`.
    const { d } = boot();
    await flush(400);
    // Never dispatch `load` â€” deliberately.
    expect(d.querySelectorAll("[data-shh-result]").length).toBeGreaterThan(0);
    expect(d.querySelectorAll(".shh-placeholder").length).toBeGreaterThan(0);
  }, 25000);

  it("WAITS for the body, and never waits forever", async () => {
    // The DOM readiness gate in init(). It exists because the content script used
    // to be registered at `document_idle` â€” after the window `load` event â€” which
    // a Google page defers by tens of seconds (field capture: 54.2 s). The
    // manifest now says `document_end`, so a body is guaranteed in practice; the
    // gate makes a too-early injection IMPOSSIBLE rather than merely unlikely, and
    // its bound stops it reintroducing the very hang it prevents.
    //
    // TWO EARLIER VERSIONS OF THIS TEST WERE VACUOUS, and both are worth recording:
    //
    //  1. Asserting only that the stage moved past `init-start` is true whether the
    //     gate runs or not (mutation R3 survived).
    //  2. Removing the body and asserting the page ends up protected also passed
    //     with the gate DELETED, because the Google adapter resolves results
    //     through `document.body` and finds nothing either way â€” it measured the
    //     adapter, not the gate.
    //
    // The reason neither could work: jsdom fires `DOMContentLoaded` about a
    // millisecond after `eval()`, with or without a body, so the gate's race was
    // always won immediately and there was nothing to observe. Suppressing that
    // automatic event is what makes the gate's real behaviour testable: without it
    // the wait is vacuous, and with it deleted the script runs on regardless.
    const { w, d } = boot({ evaluate: false });
    // Swallow jsdom's automatic DOMContentLoaded so only the gate's own bounded
    // timeout can release it. This is the whole point of the test.
    controlDomContentLoaded(w);

    const body = d.body!;
    d.documentElement.removeChild(body);

    w.eval(BUNDLE);
    await flush(400);
    // The gate is holding: init started, but nothing may have run against the DOM
    // yet, because there is no body to run against.
    expect(d.documentElement.getAttribute("data-shh-stage")).toBe("init-start");
    expect(d.querySelectorAll("[data-shh-result]").length).toBe(0);

    // The bounded wait must expire on its own â€” the exact hang the old
    // `load`-bound injection suffered must not be reintroduced here.
    await flush(2400);
    expect(d.documentElement.getAttribute("data-shh-stage")).not.toBe("init-start");

    // And once the body arrives, as a slow page would eventually provide it, the
    // page must actually get protected.
    d.documentElement.appendChild(body);
    await flush(700);
    expect(d.querySelectorAll("[data-shh-result]").length).toBeGreaterThan(0);
  }, 30000);

  it("releases the gate on DOMContentLoaded, without waiting out the timeout", async () => {
    // The OTHER arm of the gate's race. The test above suppresses
    // `DOMContentLoaded` entirely, so it only ever exercises the timeout â€” which is
    // why mutation R5 (make the gate ignore `DOMContentLoaded` and always wait the
    // full 2 s) survived it.
    //
    // This is the arm that runs in production: `document_end` fires at
    // DOMContentLoaded, so the gate must let go on that event promptly rather than
    // adding 2 s of dead time to every single page load. The bound is a safety net
    // for a DOMContentLoaded that never comes, not the normal path.
    const { w, d } = boot({ evaluate: false });
    // jsdom's automatic event would win the race and make this unreachable.
    const dcl = controlDomContentLoaded(w);
    const body = d.body!;
    d.documentElement.removeChild(body);

    w.eval(BUNDLE);
    await flush(150);
    // Still holding: no body, and the real event has not been dispatched.
    expect(d.documentElement.getAttribute("data-shh-stage")).toBe("init-start");

    // Now the page finishes parsing. `document_end` means this is exactly when the
    // gate is meant to release.
    d.documentElement.appendChild(body);
    dcl.allowNext();
    await flush(700);

    // Released, and released by THE RIGHT ARM.
    //
    // An earlier version asserted `expect(Date.now() - t0).toBeLessThan(1900)`.
    // That had NO discriminating power: the test only waited ~850ms after t0, so
    // the elapsed time was ~850ms whether the gate released on DOMContentLoaded
    // OR was waiting out the full 2000ms timeout â€” the assertion passed in both
    // worlds. It was also flaky, since ~1050ms of slack across two setTimeout
    // chains is not guaranteed on a loaded machine. Pure downside.
    //
    // The gate marks WHICH arm released it: `body-ready` on DOMContentLoaded,
    // `body-missing-timeout` on the timeout. That is the discriminating,
    // timing-free assertion.
    expect(d.documentElement.getAttribute("data-shh-diag")).toContain("body-ready");
    expect(d.documentElement.getAttribute("data-shh-diag")).not.toContain("body-missing-timeout");
    expect(d.documentElement.getAttribute("data-shh-stage")).not.toBe("init-start");
    expect(d.querySelectorAll("[data-shh-result]").length).toBeGreaterThan(0);
  }, 30000);

  it("honours showOnHover from the AUTHORITATIVE prefs, not the prime's default", async () => {
    // Mutation P18 survived every other test in this file, which is why this one
    // exists.
    //
    // The cache prime's prefs are DEFAULT_PREFS for every key except
    // `subdomainWildcard` and `debugMode`, so `showOnHover` reads FALSE there. If
    // the hover class were applied inside the one-time wiring latch, the prime
    // would set it once, wrongly, and the real value arriving a moment later
    // could never correct it â€” "reveal blocked results on hover" dead for the
    // whole page session. The class is therefore applied on EVERY call.
    const { w, d } = boot({ prefsOverride: { showOnHover: true }, evaluate: false });
    w.localStorage.setItem(
      "_shh_cache",
      JSON.stringify({ domains: ["blocked.com"], wildcard: true, paused: false })
    );
    w.eval(BUNDLE);
    // The prime runs first, with showOnHover=false from the cache default â€¦
    await flush(150);
    // â€¦ and the authoritative prefs, which say true, must still win.
    await flush(700);
    expect(d.documentElement.classList.contains("shh-hover-mode")).toBe(true);
  }, 25000);

  it("gives UNBLOCKED results a block button (the full scan, not just a reconcile)", async () => {
    // The other bug the review found. The authoritative path had been reduced to
    // a reconcile, and reconcileAgainstBlockList only forwards nodes that ARE
    // blocked â€” so an unblocked result never reached the one call site that
    // injects its button. Baidu is the engine that proves it: the prime skips
    // it, so reconcile was its only pass, and no result on the page got a
    // button.
    //
    // `injectButtonForResult` is called from exactly one place â€” the
    // not-matched branch of processResults â€” so this is a direct test of
    // whether the full scan still runs.
    const { d } = boot({ storageEntries: [] });
    await flush(600);
    expect(d.querySelectorAll(".shh-block-btn").length).toBeGreaterThan(0);
  }, 25000);

  it("names the bail reason when init exits early", async () => {
    // The paused-cache exit is only reachable when BOTH tiers fail, because a
    // successful `storage` read is authoritative and the cache is then never
    // consulted. An earlier version of this test left storage working and
    // expected `bail-cache-says-paused`; it got `init-complete`, and the
    // product was right â€” the same mirror-vs-store lesson as the paused test
    // above. Storage must fail here for the cache to be read at all.
    const { w, d } = boot({
      listFails: true, prefsFails: true, msgRejects: true, evaluate: false,
    });
    w.localStorage.setItem(
      "_shh_cache",
      JSON.stringify({ domains: ["blocked.com"], wildcard: true, paused: true })
    );
    w.eval(BUNDLE);
    await flush(2000);
    expect(d.documentElement.getAttribute("data-shh-stage")).toBe(
      "bail-cache-says-paused"
    );
    const attr = d.documentElement.getAttribute("data-shh-report")!;
    expect(attr).toContain("stage: bail-cache-says-paused");
  }, 25000);
});

const flush = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Take manual control of `DOMContentLoaded`.
 *
 * jsdom fires its own ~1 ms after `eval()`, which is precisely what makes the
 * readiness gate untestable: the race is always won instantly, so the gate's
 * behaviour is indistinguishable from having no gate at all. Swallowing jsdom's
 * automatic event lets each arm of the gate's `Promise.race` be driven on its own.
 *
 * `allowNext()` must be called immediately before a manual dispatch, so the
 * suppressor steps aside for that one event only â€” a blanket capture-phase
 * suppressor would block the content script's own listener too, since both sit on
 * `document` and fire in registration order at the target phase.
 */
function controlDomContentLoaded(w: any): { allowNext: () => void } {
  let swallow = true;
  w.document.addEventListener(
    "DOMContentLoaded",
    (e: Event) => {
      if (swallow) e.stopImmediatePropagation();
    },
    true
  );
  return {
    allowNext() {
      swallow = false;
      const ev = new w.Event("DOMContentLoaded", { bubbles: true, cancelable: false });
      w.document.dispatchEvent(ev);
      swallow = true;
    },
  };
}

describe("a tab that is inert heals itself", () => {
  it("recovers when storage fails FIRST and then comes back â€” the heal path", async () => {
    // This is the only test that actually exercises the healer. The earlier
    // version had storage succeed immediately, so the fast path handled it and
    // the healer never ran â€” which is why reverting the healer (mutation H1/H2)
    // left the suite green. Here the FIRST storage reads fail, the message bus
    // is dead, and the tab has no cache: the exact "extension is not there"
    // state, which must resolve on its own.
    const { d } = boot({ storageFlakyFor: 2, msgRejects: true });
    // Tier 1 fails, tier 2's ladder is exhausted, then the healer retries.
    await flush(9000);
    expect(d.querySelectorAll("[data-shh-result]").length).toBeGreaterThan(0);
  }, 30000);

  it("recovers with a DEAD background, using storage alone", async () => {
    // The fast path with a permanently-dead background. Every message hangs
    // forever, so anything that depends on the event page fails by
    // construction; the result must still end up hidden.
    const { d } = boot({ msgHangs: true });
    await flush(1500);
    expect(d.querySelectorAll("[data-shh-result]").length).toBeGreaterThan(0);
  }, 25000);

  it("recovers when storage is unavailable but the message bus works", async () => {
    // The complementary case: storage gone, so the healer must fall back.
    //
    // An earlier comment claimed this exercised "the heal path". It does NOT, and
    // an audit caught it: with `listFails` + `prefsFails` the tier-1 direct
    // storage reads throw, then tier 2's message bus SUCCEEDS, so
    // `degradedStart` never becomes true and `reviveFromBackground()` is gated off
    // entirely. This is the tier-2 recovery path, not the healer.
    //
    // The assertion is still worth having — it proves blocking comes up when
    // storage is gone and the bus works — it just proves something different from
    // what the comment claimed.
    const { d } = boot({ listFails: true, prefsFails: true });
    await flush(2000);
    expect(d.querySelectorAll("[data-shh-result]").length).toBeGreaterThan(0);
  }, 25000);

  it("is not inert at all when storage works â€” the normal case needs no healer", async () => {
    const { d } = boot();
    await flush(400);
    expect(d.querySelectorAll("[data-shh-result]").length).toBeGreaterThan(0);
  }, 25000);

  it("does NOT resurrect blocking for a user who paused it", async () => {
    // The heal must not undo a deliberate pause.
    //
    // An earlier version of this test asserted the wrong contract: it set
    // `paused: true` in `_shh_cache` while `storage.local` held the entry and
    // `storage.sync` said not-paused, then expected nothing hidden. The product
    // correctly hid the result â€” `_shh_cache` is a fast-start MIRROR, and
    // `storage` is authoritative. Honouring a stale mirror over the real store
    // would be the bug.
    //
    // The real invariant is that `prefs.pausedGlobally` is honoured, even on
    // the heal path.
    const { w, d } = boot({ msgHangs: true, evaluate: false });
    w.browser.storage.sync.get = async () => ({
      shh_prefs: { ...PREFS, pausedGlobally: true },
    });
    w.eval(BUNDLE);
    await flush(1200);
    expect(d.querySelectorAll("[data-shh-result]").length).toBe(0);
  }, 25000);
});
