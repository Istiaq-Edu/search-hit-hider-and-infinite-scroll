import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import {
  setDebugMode,
  isDebugMode,
  seedDebugFromCache,
  collectDiagnostics,
} from "../src/content/debug";
import { GoogleAdapter } from "../src/content/engines/google";

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
