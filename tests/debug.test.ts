import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import {
  setDebugMode,
  isDebugMode,
  seedDebugFromCache,
  collectDiagnostics,
  bumpRejection,
  rejectionSnapshot,
  resetRejections,
  diagMark,
  enableTimings,
  disableTimings,
  timingSnapshot,
  setDiagResolver,
  setDiagMatcherInfo,
  beginRejectionBatch,
  isBfcacheRestore,
  type RejectionReason,
} from "../src/content/debug";
import { GoogleAdapter } from "../src/content/engines/google";

/** The shipped union, so a test can assert every reported row is real. */
const PRODUCTION_REASONS: RejectionReason[] = [
  "alreadyStamped",
  "containsProcessed",
  "insideProcessed",
  "noUrl",
  "noMatcher",
  "adapterOfferedNone",
  "skippedContainer",
  "nodeThrew",
];

// ============================================================
// Debug gate + built-in field diagnostics
//
// The verbose instrumentation added while chasing the Google outage must
// stay in the build (it is how the next breakage gets diagnosed) but must
// be silent unless the user turns Debug mode on. These tests pin both
// halves: gated when off, complete when on.
// ============================================================

const SERP_URL = "https://www.google.com/search?q=test";

// Field-captured 2026 layout: opaque /goto?url= hrefs, per-result node is
// div.kb0PBd, display URL lives in <cite> inside the result.
const GOTO = "/goto?url=CAESUQHrOzAVzBTZa";

function fieldSerp(hosts: string[], stamped = false): Document {
  const results = hosts
    .map(
      (h, i) => `
    <div class="kb0PBd"${stamped ? ' data-shh-result="true"' : ""}>
      <div class="yuRUbf"><a href="${GOTO}${i}"><h3>Result ${i}</h3></a></div>
      <div class="VwiC3b"><cite>${h}</cite></div>
    </div>`
    )
    .join("");

  const html = `<!DOCTYPE html>
    <html data-shh-preload-run="v=1.8.3;host=www.google.com;domains=71;paused=false"
          data-shh-active="true"
          data-shh-diag="t=120ms init done: processed=3">
    <body><div id="center_col"><div id="search"><div id="rso">
      <div class="MjjYud"><div class="A6K0A"><div class="tF2Cxc">
        <h2>Web results</h2>
        <div class="N54PNb">${results}</div>
      </div></div></div>
    </div></div></div></body></html>`;
  return new JSDOM(html, { url: SERP_URL }).window.document;
}

/** A SERP with a results container but nothing recognisable inside it. */
function emptySerp(): Document {
  const html = `<!DOCTYPE html>
    <html data-shh-preload-run="v=1.8.3;host=www.google.com;domains=71;paused=false">
    <body><div id="center_col"></div></body></html>`;
  return new JSDOM(html, { url: SERP_URL }).window.document;
}

beforeEach(() => {
  setDebugMode(false);
  try {
    localStorage.clear();
  } catch {
    /* jsdom without an origin — nothing to clear */
  }
});

afterEach(() => {
  setDebugMode(false);
  vi.restoreAllMocks();
});

// ── The flag itself ────────────────────────────────────────────────────

describe("debug mode flag", () => {
  it("defaults to off", () => {
    expect(isDebugMode()).toBe(false);
  });

  it("round-trips through setDebugMode", () => {
    setDebugMode(true);
    expect(isDebugMode()).toBe(true);
    setDebugMode(false);
    expect(isDebugMode()).toBe(false);
  });

  it("coerces truthy/falsy input to a strict boolean", () => {
    setDebugMode("yes" as unknown as boolean);
    expect(isDebugMode()).toBe(false);
    setDebugMode(1 as unknown as boolean);
    expect(isDebugMode()).toBe(false);
  });
});

// ── Seeding from the preload cache ─────────────────────────────────────
//
// This is what makes Debug mode work on the FIRST scan of a page, before
// the async prefs round-trip resolves. Without it, enabling the toggle
// would take effect one page load late — silencing the load under test.

describe("seedDebugFromCache", () => {
  it("turns debug on when the cached flag is true", () => {
    localStorage.setItem("_shh_cache", JSON.stringify({ domains: [], debug: true }));
    seedDebugFromCache();
    expect(isDebugMode()).toBe(true);
  });

  it("leaves debug off when the cached flag is false", () => {
    localStorage.setItem("_shh_cache", JSON.stringify({ domains: [], debug: false }));
    seedDebugFromCache();
    expect(isDebugMode()).toBe(false);
  });

  it("leaves debug off when there is no cache", () => {
    seedDebugFromCache();
    expect(isDebugMode()).toBe(false);
  });

  it("survives a corrupt cache without throwing", () => {
    localStorage.setItem("_shh_cache", "{not json");
    expect(() => seedDebugFromCache()).not.toThrow();
    expect(isDebugMode()).toBe(false);
  });

  it("ignores a non-boolean debug field", () => {
    localStorage.setItem("_shh_cache", JSON.stringify({ debug: "true" }));
    seedDebugFromCache();
    expect(isDebugMode()).toBe(false);
  });
});

// ── collectDiagnostics: debug OFF ─────────────────────────────────────

describe("collectDiagnostics with debug mode OFF", () => {
  it("returns a usable summary but no heavy fields", () => {
    const out = collectDiagnostics(fieldSerp(["reddit.com", "example.com"], true));

    expect(out.debugMode).toBe(false);
    // Cheap triage is still available — this is the point of the summary.
    expect(out.preload.version).toBe("1.8.3");
    expect(out.preload.domains).toBe("71");
    expect(out.lifecycle.processed).toBe("3");
    expect(out.effect.stampedResult).toBe(2);

    // Heavy fields withheld.
    expect(out.results.firstResultHTML).toBeNull();
    expect(out.results.pathFromRso).toBeNull();
    expect(out.results.citeInsideResult).toBeNull();
    expect(out.results.citeText).toBeNull();
  });

  it("explains how to get the full report", () => {
    const out = collectDiagnostics(fieldSerp(["reddit.com"]));
    expect(out.hint).toContain("Debug mode");
    expect(out.hint).toContain("__shhDiag()");
  });

  it("still counts results and link encoding (cheap, and diagnostic alone)", () => {
    const out = collectDiagnostics(fieldSerp(["reddit.com", "example.com", "a.com"]));

    expect(out.results.resolvedBy).toBe("div.kb0PBd");
    expect(out.results.count).toBe(3);
    expect(out.counts["div.kb0PBd"]).toBe(3);
    // The 2026 breakage, detectable even with debug off.
    expect(out.linkEncoding.opaqueGoto).toBe(3);
    expect(out.linkEncoding.total).toBe(3);
  });

  it("withholds href samples (they contain page content)", () => {
    const out = collectDiagnostics(fieldSerp(["reddit.com"]));
    expect(out.linkEncoding.samples.opaqueGoto).toEqual([]);
  });

  // ── Duplicate-UI counters (field report 2026-08-30) ───────────────────
  // Cheap enough to ship ungated: they are the number the user reads to
  // confirm the container guards are holding.

  it("reports zero duplicated headings on a clean page", () => {
    const doc = fieldSerp(["reddit.com", "example.com"]);
    for (const h of Array.from(doc.querySelectorAll("h3"))) {
      const btn = doc.createElement("button");
      btn.className = "shh-block-btn";
      h.appendChild(btn);
    }

    const out = collectDiagnostics(doc);
    expect(out.effect.buttons).toBe(2);
    expect(out.effect.headingsWithTwoButtons).toBe(0);
  });

  it("flags a heading carrying two block buttons", () => {
    const doc = fieldSerp(["reddit.com", "example.com"]);
    const first = doc.querySelector("h3") as Element;
    for (let i = 0; i < 2; i++) {
      const btn = doc.createElement("button");
      btn.className = "shh-block-btn";
      first.appendChild(btn);
    }
    const second = doc.querySelectorAll("h3")[1] as Element;
    const btn = doc.createElement("button");
    btn.className = "shh-block-btn";
    second.appendChild(btn);

    const out = collectDiagnostics(doc);
    expect(out.effect.buttons).toBe(3);
    expect(out.effect.headingsWithTwoButtons).toBe(1);
  });
});

// ── collectDiagnostics: debug ON ──────────────────────────────────────

describe("collectDiagnostics with debug mode ON", () => {
  beforeEach(() => setDebugMode(true));

  it("includes the DOM path from the stream to the result node", () => {
    const out = collectDiagnostics(fieldSerp(["reddit.com"]));
    expect(out.results.pathFromRso).toBe(
      "div#rso > div.MjjYud > div.A6K0A > div.tF2Cxc > div.N54PNb > div.kb0PBd"
    );
  });

  it("answers whether the display URL sits inside the result node", () => {
    const out = collectDiagnostics(fieldSerp(["reddit.com"]));
    expect(out.results.citeInsideResult).toBe(true);
    expect(out.results.citeText).toBe("reddit.com");
  });

  it("includes a markup sample of the first result", () => {
    const out = collectDiagnostics(fieldSerp(["reddit.com"]));
    expect(out.results.firstResultHTML).toContain("kb0PBd");
    expect(out.results.firstResultHTML).toContain("reddit.com");
    // Bounded, so the console is never flooded.
    expect((out.results.firstResultHTML ?? "").length).toBeLessThanOrEqual(1500);
  });

  it("includes href samples", () => {
    const out = collectDiagnostics(fieldSerp(["reddit.com", "example.com"]));
    expect(out.linkEncoding.samples.opaqueGoto.length).toBe(2);
    expect(out.linkEncoding.samples.opaqueGoto[0]).toContain("/goto?url=");
  });

  it("has no hint (nothing is withheld)", () => {
    const out = collectDiagnostics(fieldSerp(["reddit.com"]));
    expect(out.hint).toBe("");
  });
});

// ── Robustness ────────────────────────────────────────────────────────

describe("collectDiagnostics robustness", () => {
  it("does not throw on a page with no results at all", () => {
    expect(() => collectDiagnostics(emptySerp())).not.toThrow();
  });

  it("reports a missing preload marker explicitly rather than silently", () => {
    const html = `<!DOCTYPE html><html><body><div id="center_col"></div></body></html>`;
    const doc = new JSDOM(html, { url: SERP_URL }).window.document;
    const out = collectDiagnostics(doc);

    expect(out.preload.raw).toContain("did not run");
    expect(out.preload.version).toBeNull();
    expect(out.results.resolvedBy).toBeNull();
    expect(out.results.count).toBe(0);
  });

  it("works with debug on for a page with no results", () => {
    setDebugMode(true);
    const out = collectDiagnostics(emptySerp());
    expect(out.results.firstResultHTML).toBeNull();
    expect(out.results.citeInsideResult).toBeNull();
  });
});

// ── Google zero-result report is gated ─────────────────────────────────
//
// reportZeroResults() walks every element under the stream and slices
// 2x2500 chars of third-party markup. None of that should run for a user
// who has not opted in.

describe("Google zero-result report gating", () => {
  // Typed structurally: vi's MockInstance generics differ across versions.
  const zeroArgs = (spy: { mock: { calls: unknown[][] } }): Record<string, unknown> => {
    const call = spy.mock.calls.find((c) => String(c[0]).includes("no result nodes found"));
    expect(call).toBeTruthy();
    return call?.[1] as Record<string, unknown>;
  };

  it("logs only a short summary + hint when debug mode is off", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new GoogleAdapter();

    adapter.onInit(emptySerp());
    const nodes = adapter.getResultNodes(emptySerp());

    expect(nodes).toEqual([]);
    const args = zeroArgs(spy);
    expect(args.hint).toContain("Debug mode");
    // The expensive fields must not be computed at all.
    expect(args.deepestSample).toBeUndefined();
    expect(args.linkEncoding).toBeUndefined();
    expect(args.firstChildSample).toBeUndefined();
  });

  it("logs the full report when debug mode is on", () => {
    setDebugMode(true);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new GoogleAdapter();

    adapter.onInit(emptySerp());
    adapter.getResultNodes(emptySerp());

    const args = zeroArgs(spy);
    expect(args.linkEncoding).toBeDefined();
    expect(args.deepestHeadingPath).toBeDefined();
    // No hint — the detailed report is present.
    expect(args.hint).toBeUndefined();
  });

  it("emits the fetched-doc shape as flat strings so a paste keeps them", () => {
    // DevTools collapses nested objects on copy, so `docShape:{…}` came back
    // from the field twice with no content. These lines must be primitives.
    setDebugMode(true);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new GoogleAdapter();
    adapter.onInit(emptySerp());
    adapter.getResultNodes(emptySerp());

    const flat = spy.mock.calls.find((c) => String(c[0]).includes("fetched-doc shape:"));
    expect(flat).toBeTruthy();
    const line = String(flat?.[0]);
    expect(line).toContain("textLen=");
    expect(line).toContain("forms=");

    expect(spy.mock.calls.some((c) => String(c[0]).includes("fetched-doc body head:"))).toBe(true);
    expect(spy.mock.calls.some((c) => String(c[0]).includes("fetched-doc text head:"))).toBe(true);
  });

  it("does not spam: the report fires once per adapter", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new GoogleAdapter();
    adapter.onInit(emptySerp());

    adapter.getResultNodes(emptySerp());
    adapter.getResultNodes(emptySerp());
    adapter.getResultNodes(emptySerp());

    const hits = spy.mock.calls.filter((c) => String(c[0]).includes("no result nodes found"));
    expect(hits.length).toBe(1);
  });

  it("an observer subtree scan does NOT consume the one-shot report (2026-09-06 field bug)", () => {
    // Field log: the reportZeroResults one-shot was burned by an observer
    // path — getResultNodes(<added Element>) on a container with no results
    // (Google hydration skeleton) — emitting a misleading all-null
    // "(fetched document)" dump at t≈1434ms. The REAL fetched-page failure
    // minutes later then logged nothing. Subtree (Element) scans must be
    // invisible; the next whole-Document scan still gets the report.
    setDebugMode(true);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new GoogleAdapter();

    // 1. Observer path: an added ELEMENT with no results inside.
    const dom = new JSDOM("<div id='skeleton'><span>loading…</span></div>");
    const subtree = dom.window.document.querySelector("#skeleton")!;
    expect(adapter.getResultNodes(subtree)).toEqual([]);

    // No report for the subtree scan — not even the summary.
    expect(
      spy.mock.calls.filter((c) => String(c[0]).includes("no result nodes found")).length
    ).toBe(0);

    // 2. The real whole-page failure still reports (one-shot intact).
    adapter.getResultNodes(emptySerp());
    const hits = spy.mock.calls.filter((c) => String(c[0]).includes("no result nodes found"));
    expect(hits.length).toBe(1);
    // And it is the DETAILED report (debug mode on), not the hint summary.
    const args = hits[0]![1] as Record<string, unknown>;
    expect(args.linkEncoding).toBeDefined();
  });
});

// ============================================================
// Field-test instrumentation
//
// These are the fields the field test on another machine depends on. They were
// added because `collectDiagnostics` could count markers but could not answer:
//   - is the matcher empty because the USER has no blocks, or because the
//     background was cold?  (matcher.source � the D5 discriminator)
//   - which guard rejected a result?                      (rejected counters)
//   - did the preload's 2s cover-reveal beat processResults? (timings, shared
//     performance timeline)
//   - how many on-screen results does the user's OWN list say are blocked?
//     (effect.visibleButBlocked � the D1 detector)
// ============================================================

describe("field-test instrumentation", () => {
  beforeEach(() => {
    resetRejections();
    enableTimings();
    setDiagResolver(null);
    setDiagMatcherInfo({
      entriesTotal: 0,
      entriesEnabled: 0,
      source: "unknown",
      wildcard: true,
      degradedStart: false,
      stateAuthoritative: true,
    });
  });

  afterEach(() => {
    disableTimings();
    setDiagResolver(null);
  });

  /**
   * Arm the detector through the ENGINE'S OWN discovery and URL resolution.
   *
   * An earlier revision of this suite installed a bare
   * `setDiagMatcher((url) => ({matched: url.includes("blocked.com")}))`, which
   * pinned only the counting loop and left the wiring from `index.ts` to the
   * detector completely untested — and it WAS untested and broken: `init()`
   * never registered a matcher, so on a normal page load the loop never ran and
   * the report printed a clean `0`. A stub matcher cannot catch that; a
   * resolver built on the real adapter can.
   */
  function armOn(
    doc: Document,
    blockedHosts: string[],
    opts: { engineActive?: boolean; isSerp?: boolean; nodes?: Element[] } = {}
  ): void {
    const engine = new GoogleAdapter();
    setDiagResolver({
      resultNodes: () => opts.nodes ?? engine.getResultNodes(doc),
      resultUrl: (n) => engine.getResultUrl(n),
      isBlocked: (u) => blockedHosts.some((h) => u.includes(h)),
      engineActive: opts.engineActive ?? true,
      engineId: "google",
      isSerp: opts.isSerp ?? true,
    });
  }

  it("counts guard rejections by reason", () => {
    bumpRejection("noUrl");
    bumpRejection("noUrl");
    bumpRejection("containsProcessed");
    const snap = rejectionSnapshot();
    expect(snap.noUrl).toBe(2);
    expect(snap.containsProcessed).toBe(1);
    expect(snap.insideProcessed).toBe(0);
  });

  it("resetRejections clears every counter", () => {
    bumpRejection("adapterOfferedNone", 5);
    resetRejections();
    const snap = rejectionSnapshot();
    expect(Object.values(snap).every((v) => v === 0)).toBe(true);
  });

  it("returns a COPY, so a caller cannot mutate the counters", () => {
    bumpRejection("noMatcher", 1);
    const snap = rejectionSnapshot();
    snap.noMatcher = 999;
    expect(rejectionSnapshot().noMatcher).toBe(1);
  });

  // The previous assertions here were `deltaMs >= 0`, which cannot fail —
  // deleting the `m.t - prev` computation entirely left the suite green. These
  // pin the actual arithmetic.
  it("records timings with deltas against the previous mark", () => {
    const t0 = performance.now();
    diagMark("first");
    diagMark("second");
    const rows = timingSnapshot();
    expect(rows.map((r) => r.label)).toEqual(["first", "second"]);
    const first = rows[0]!;
    const second = rows[1]!;
    // deltaMs is measured from the PREVIOUS row, not from 0 and not from now.
    expect(first.deltaMs).toBe(first.tMs);
    expect(second.deltaMs).toBe(second.tMs - first.tMs);
    expect(first.tMs).toBeGreaterThanOrEqual(Math.round(t0) - 5);
  });

  it("mirrors marks onto <html> so the preload diagnostic can read them", () => {
    diagMark("processResults-done");
    const raw = document.documentElement.getAttribute("data-shh-diag-marks");
    expect(raw).toContain("processResults-done");
    expect(raw).toMatch(/^\d+:/);
  });

  it("disables recording when timings are off", () => {
    disableTimings();
    const before = timingSnapshot().length;
    diagMark("ignored");
    expect(timingSnapshot().length).toBe(before);
  });

  // ── The D1 detector ──────────────────────────────────────────────────────

  it("detects an on-screen result that the block list says is blocked", () => {
    const doc = fieldSerp(["safe.com", "blocked.com", "alsosafe.com"]);
    armOn(doc, ["blocked.com"]);
    const d = collectDiagnostics(doc);
    expect(d.effect.visibleButBlocked).toBe(1);
    expect(d.effect.visibleButBlockedHosts.join()).toContain("blocked.com");
  });

  it("reports the TRUE count past 8 matches, not a capped sample", () => {
    // The previous loop `continue`d before the increment once the 8-host
    // SAMPLE was full, so a page with 12 visible blocked results reported 8 —
    // and the popup told the user the number was exact.
    const many = Array.from({ length: 12 }, (_, i) => `blocked${i}.com`);
    const doc = fieldSerp(many);
    armOn(doc, ["blocked"]);
    const d = collectDiagnostics(doc);
    expect(d.effect.visibleButBlocked).toBe(12);
    expect(d.effect.visibleButBlockedHosts).toHaveLength(8);
    expect(d.effect.visibleButBlockedTruncated).toBe(true);
  });

  it("reports zero when every blocked result is already stamped", () => {
    // The nodes are supplied EXPLICITLY rather than via the adapter, because
    // the Google adapter already filters stamped nodes out of getResultNodes.
    // Going through the adapter made this test pass for the wrong reason: with
    // the detector's own `data-shh-result` skip removed entirely, it was still
    // green, because the loop never saw the node. A test that cannot fail on
    // the code it names is a mirror.
    const doc = fieldSerp(["blocked.com", "safe.com"], true);
    armOn(doc, ["blocked.com"], { nodes: Array.from(doc.querySelectorAll("div.kb0PBd")) });
    const d = collectDiagnostics(doc);
    expect(d.effect.stampedResult).toBe(2);
    expect(d.effect.visibleButBlocked).toBe(0);
  });

  it("does NOT count a result the PRELOAD hidden as 'visible'", () => {
    // A working preload sets data-shh-preloaded and no data-shh-result. The
    // old probe had no skip for it, so a correctly-working degraded start
    // manufactured D1 evidence — the exact scenario the report exists for.
    const doc = fieldSerp(["blocked.com", "safe.com"]);
    const target = doc.querySelector("div.kb0PBd")!;
    target.setAttribute("data-shh-preloaded", "true");
    armOn(doc, ["blocked.com"]);
    expect(collectDiagnostics(doc).effect.visibleButBlocked).toBe(0);
  });

  it("counts a breadcrumb-cited result, which the <cite>-text probe missed", () => {
    // `example.com > docs > page` is ONE domain. `domainFromDisplayText`
    // splits it in production; the old probe did not, so real blocked results
    // were invisible to it.
    const doc = fieldSerp(["blocked.com"]);
    const cite = doc.querySelector("cite")!;
    cite.textContent = "blocked.com \u203a docs \u203a page";
    armOn(doc, ["blocked.com"]);
    expect(collectDiagnostics(doc).effect.visibleButBlocked).toBe(1);
  });

  it("says the detector is NOT ARMED rather than reporting a clean 0", () => {
    // The load-bearing regression: with no resolver, `visibleButBlocked` is
    // 0, and the old report printed that as "no known failure signature
    // detected" — a false all-clear on the page you paste from.
    const doc = fieldSerp(["blocked.com"]);
    setDiagResolver(null);
    const d = collectDiagnostics(doc);
    expect(d.effect.visibleButBlocked).toBe(0);
    expect(d.effect.detectorArmed).toBe(false);
  });

  it("surfaces engineActive so a PAUSED page is not reported as a defect", () => {
    const doc = fieldSerp(["blocked.com"]);
    armOn(doc, ["blocked.com"], { engineActive: false });
    const d = collectDiagnostics(doc);
    // The number is still measured — the VERDICT is what gates on this.
    expect(d.effect.engineActive).toBe(false);
    expect(d.effect.detectorArmed).toBe(true);
  });

  it("measures isSerp rather than assuming the page is a SERP", () => {
    const doc = fieldSerp(["a.com"]);
    armOn(doc, [], { isSerp: false });
    expect(collectDiagnostics(doc).effect.isSerp).toBe(false);
  });

  it("surfaces matcher provenance — the D5 discriminator", () => {
    setDiagMatcherInfo({ entriesTotal: 0, entriesEnabled: 0, source: "cache" });
    const d = collectDiagnostics(fieldSerp(["a.com"]));
    expect(d.matcher.source).toBe("cache");
    expect(d.matcher.entriesEnabled).toBe(0);
  });

  it("distinguishes a disabled entry from a missing one", () => {
    // `entries.length` counts entries the matcher SKIPS (rebuild() drops
    // !enabled), so a 5-item list with 4 switched off read as 5.
    setDiagMatcherInfo({ entriesTotal: 5, entriesEnabled: 1, source: "background" });
    const d = collectDiagnostics(fieldSerp(["a.com"]));
    expect(d.matcher.entriesTotal).toBe(5);
    expect(d.matcher.entriesEnabled).toBe(1);
  });

  it("exposes rejection counters inside the report", () => {
    bumpRejection("insideProcessed", 3);
    expect(collectDiagnostics(fieldSerp(["a.com"])).rejected.insideProcessed).toBe(3);
  });

  it("separates the last batch from the cumulative total", () => {
    // Google paginates without a reload, so the cumulative table counts every
    // re-scan. The delta is what answers "what happened on the last pass".
    bumpRejection("alreadyStamped", 2);
    beginRejectionBatch();
    bumpRejection("alreadyStamped", 1);
    bumpRejection("noUrl", 4);
    const d = collectDiagnostics(fieldSerp(["a.com"]));
    expect(d.rejected.alreadyStamped).toBe(3);
    expect(d.rejectedLastBatch!.alreadyStamped).toBe(1);
    expect(d.rejectedLastBatch!.noUrl).toBe(4);
  });

  // ── Result accounting ───────────────────────────────────────────────────
  // The gap the 2026-09-29 field run exposed: `processed=5` is the adapter's
  // OFFERED count, not the page's result count, and the section / aggregate /
  // multi-cite guards drop nodes entirely WITHOUT incrementing any `rejected`
  // counter. So the most likely reason a blocked result stays visible left no
  // trace at all.

  it("classifies every result leaf as hidden, button, or unmarked", () => {
    const doc = fieldSerp(["a.com", "b.com"]);
    // Stamp one as hidden, leave the other for the matcher to pass.
    doc.querySelectorAll("div.kb0PBd")[0]!.setAttribute("data-shh-result", "block");
    armOn(doc, ["nothing-matches-this.com"]);
    const a = collectDiagnostics(doc).accounting;
    expect(a.leaves).toBe(2);
    expect(a.hidden).toBe(1);
    expect(a.unmarked).toBe(1);
    expect(a.unmarkedButBlocked).toBe(0);
  });

  it("recognises a result that carries a block button, on the node or below it", () => {
    // Regression: the first version of this check looked only at DESCENDANTS
    // for `data-shh-btn`, but `injectBlockButton` stamps that attribute on the
    // container it is handed — the result node itself. withButton came out 0 on
    // a page that plainly had two buttons on it, which made every
    // button-bearing result look `unmarked`.
    const doc = fieldSerp(["a.com", "b.com"]);
    const [first, second] = Array.from(doc.querySelectorAll("div.kb0PBd"));
    // Case 1: attribute on the result node itself.
    first!.setAttribute("data-shh-btn", "1");
    // Case 2: the button element lives deeper (injected into the heading).
    second!.querySelector("h3")!.classList.add("shh-block-btn");
    armOn(doc, []);

    const a = collectDiagnostics(doc).accounting;
    expect(a.withButton).toBe(2);
    expect(a.unmarked).toBe(0);
  });

  it("counts a blocked-but-unmarked leaf — the defect this whole block exists for", () => {
    // The leaf is blocked, still on the page, and neither hidden nor given a
    // button. Under the old report this produced NO signal whatsoever.
    const doc = fieldSerp(["blocked.com"]);
    armOn(doc, ["blocked.com"], { nodes: [] }); // adapter offered nothing
    const a = collectDiagnostics(doc).accounting;
    expect(a.unmarked).toBe(1);
    expect(a.unmarkedButBlocked).toBe(1);
    expect(a.detail[0]!.matched).toBe(true);
    expect(a.detail[0]!.why).toBe("unknown");
  });

  it("excludes section wrappers from the leaf count", () => {
    // MjjYud > tF2Cxc > N54PNb > 3x kb0PBd. Counting the wrappers as leaves
    // would report 6 results where the page has 3 — the same class of error as
    // the multiCite overcount.
    armOn(fieldSerp(["a.com", "b.com", "c.com"]), []);
    expect(collectDiagnostics(fieldSerp(["a.com", "b.com", "c.com"])).accounting.leaves).toBe(3);
  });

  it("names 'noUrl' when the production resolver cannot resolve a destination", () => {
    // A result-shaped node with a heading but no display URL. The adapter
    // offers it, getResultUrl returns null, and nothing can be matched — which
    // is a different problem from "not blocked" and needs its own label.
    const html = `<!DOCTYPE html><html><body>
      <div class="kb0PBd"><h3>No link here</h3><div class="VwiC3b">orphan</div></div>
    </body></html>`;
    const doc = new JSDOM(html, { url: SERP_URL }).window.document;
    armOn(doc, ["blocked.com"]);
    const a = collectDiagnostics(doc).accounting;
    expect(a.unmarked).toBe(1);
    expect(a.detail[0]!.url).toBeNull();
    expect(a.detail[0]!.why).toBe("noUrl");
  });

  it("says 'noMatcher' rather than guessing when no resolver is registered", () => {
    setDiagResolver(null);
    const a = collectDiagnostics(fieldSerp(["a.com"])).accounting;
    expect(a.detail[0]!.why).toBe("noMatcher");
    expect(a.detail[0]!.matched).toBeNull();
  });

  it("never leaves a rejected counter permanently unreachable", () => {
    // Six rows in the previous table were only ever assigned by the probe and
    // were therefore always 0 under the header "which guard ate the result".
    setDebugMode(true);
    const d = collectDiagnostics(fieldSerp(["a.com"]));
    // Every production reason must be a real member of the shipped union.
    for (const k of Object.keys(d.rejected)) {
      expect(PRODUCTION_REASONS).toContain(k);
    }
  });

  it("does not manufacture section evidence from section WRAPPERS", () => {
    // The field SERP is MjjYud > tF2Cxc > N54PNb > 3x kb0PBd. Counting
    // wrappers as "section shaped" made a healthy page read sectionShaped=3,
    // and the comment then called that "the evidence B1 would need".
    setDebugMode(true);
    const d = collectDiagnostics(fieldSerp(["a.com", "b.com", "c.com"]));
    expect(d.discovery.sectionShaped).toBe(0);
  });

  it("counts multiCite on LEAF results only — a wrapper is not a multi-cite card", () => {
    // Caught by end-to-end replay of a real 2026 SERP: a page with exactly ONE
    // genuine multi-cite card (an AI Overview citing two domains) measured
    // `multiCite: 6`. The other five were section wrappers, each of which
    // trivially spans several domains because it CONTAINS several results.
    //
    // This number is the stated evidence for shipping B2, so a 6x overcount
    // would push someone into implementing a deliberately-withheld change
    // against a measurement that was mostly counting <div class="MjjYud">.
    setDebugMode(true);
    const one = `one.com`;
    const two = `two.com`;
    const html = `<!DOCTYPE html><html><body>
      <div class="MjjYud"><div class="tF2Cxc">
        <h2>Web results</h2>
        <div class="N54PNb">
          ${["a.com", "b.com", "c.com", "d.com"]
            .map((h) => `<div class="kb0PBd"><h3>${h}</h3><cite>${h}</cite></div>`)
            .join("")}
        </div>
      </div></div>
      <div class="MjjYud"><div class="tF2Cxc">
        <h2>AI Overview</h2>
        <div class="kb0PBd"><h3>Overview</h3><cite>${one}</cite><cite>${two}</cite></div>
      </div></div>
    </body></html>`;
    const d = collectDiagnostics(new JSDOM(html, { url: SERP_URL }).window.document);
    // Exactly one leaf cites more than one domain. Not 6.
    expect(d.discovery.multiCite).toBe(1);
    // And the wrappers that hold four results must not register at all.
    expect(d.discovery.sectionShaped).toBe(0);
  });

  it("counts multi-cite by RESOLVED domain, not raw cite text", () => {
    // `example.com > a` and `example.com > b` are one domain. Comparing raw
    // text called them two and inflated multiCite on healthy pages.
    setDebugMode(true);
    const html = `<!DOCTYPE html><html><body>
      <div class="kb0PBd"><h3>a</h3>
        <cite>example.com \u203a alpha</cite><cite>example.com \u203a beta</cite>
      </div>
    </body></html>`;
    const d = collectDiagnostics(new JSDOM(html, { url: SERP_URL }).window.document);
    expect(d.discovery.multiCite).toBe(0);
  });

  it("names the guard that rejected a section-shaped node, never a bare null", () => {
    // `null` used to mean both "it WAS offered" and "not offered by a guard the
    // probe does not check", so a reader took the second as the first.
    setDebugMode(true);
    const html = `<!DOCTYPE html><html><body>
      <div class="kb0PBd"><h2>Section</h2><h3>Item</h3><cite>one.com</cite></div>
    </body></html>`;
    const d = collectDiagnostics(new JSDOM(html, { url: SERP_URL }).window.document);
    expect(d.discovery.probeSelector).toBe("div.kb0PBd");
    expect(d.discovery.probeRejectedBy).toBe("section");
  });

  it("says NOT REJECTED, not null, for a section walkResults would DESCEND into", () => {
    // tF2Cxc holds two headings (so looksLikeGoogleSection is true) but also a
    // result-shaped descendant, so production descends and finds results. It
    // must not be reported as the section-skip guard discarding it.
    //
    // The SECTION node must itself be the sampled candidate: the probe walks
    // RESULT_CANDIDATES in order and `div.kb0PBd` is first, so a fixture whose
    // section wrapper is `div.tF2Cxc` gets the INNER result sampled instead
    // and the descend branch is never reached (verified by mutation).
    setDebugMode(true);
    const html = `<!DOCTYPE html><html><body>
      <div class="kb0PBd"><h2>Web</h2>
        <div class="N54PNb"><h3>Only result</h3><cite>one.com</cite></div>
      </div>
    </body></html>`;
    const d = collectDiagnostics(new JSDOM(html, { url: SERP_URL }).window.document);
    expect(d.discovery.probeSelector).toBe("div.kb0PBd");
    expect(d.discovery.probeRejectedBy).toBe("notRejected");
  });

  it("says NOT REJECTED for a plain, well-formed result node", () => {
    setDebugMode(true);
    const html = `<!DOCTYPE html><html><body>
      <div class="kb0PBd"><h3>Title</h3><cite>one.com</cite></div>
    </body></html>`;
    const d = collectDiagnostics(new JSDOM(html, { url: SERP_URL }).window.document);
    expect(d.discovery.probeRejectedBy).toBe("notRejected");
  });

  it("keeps the TAIL of the lifecycle log and says it truncated", () => {
    // `slice(0, 4000)` kept the OLDEST lines of a ring buffer and silently
    // dropped the newest — which are the interesting ones. A long session
    // therefore showed a stale head and read as if nothing had happened.
    const html = `<!DOCTYPE html><html data-shh-diag="${"A".repeat(5000)}|FINAL-MARKER-xyz"></html>`;
    const doc = new JSDOM(html, { url: SERP_URL }).window.document;
    const d = collectDiagnostics(doc);
    expect(d.lifecycle.shhDiag).toContain("FINAL-MARKER-xyz");
    expect(d.lifecycle.shhDiag).toContain("truncated");
  });

  it("only runs the discovery probe in debug mode", () => {
    setDebugMode(false);
    const d = collectDiagnostics(fieldSerp(["a.com", "b.com"]));
    expect(d.discovery.sectionShaped).toBe(0);
    expect(d.discovery.multiCite).toBe(0);
  });

  it("reports build identity and the Firefox major version", () => {
    const d = collectDiagnostics(fieldSerp(["a.com"]));
    expect(d.build.version).toBe("1.8.3"); // from data-shh-preload-run
    expect(d.build.userAgent).toBeTruthy();
  });
});

// The bfcache decision is a pure predicate so it is testable at all: jsdom does
// not implement performance.getEntriesByType, which is why the field was
// hard-coded false before.
describe("isBfcacheRestore", () => {
  it("is true only for a back_forward navigation", () => {
    expect(isBfcacheRestore("back_forward")).toBe(true);
    expect(isBfcacheRestore("navigate")).toBe(false);
    expect(isBfcacheRestore("reload")).toBe(false);
    expect(isBfcacheRestore("prerender")).toBe(false);
  });

  it("is false when the API is missing (jsdom) rather than guessing true", () => {
    expect(isBfcacheRestore(null)).toBe(false);
    expect(isBfcacheRestore(undefined)).toBe(false);
  });
});