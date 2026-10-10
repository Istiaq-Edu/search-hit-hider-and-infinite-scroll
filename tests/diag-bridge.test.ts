import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

// ============================================================
// The page-world diagnostic bridge
//
// A content script runs in an ISOLATED WORLD: same DOM, separate JavaScript
// global. A field run on 2026-09-30 typed `copy(__shhDiagText())` into the
// console and got
//
//     Uncaught ReferenceError: __shhDiagText is not defined
//
// — correctly, because `window.__shhDiagText` was only ever set in the
// content script's world. The popup had been giving that instruction since the
// function was added, and no rebuild could ever have fixed it.
//
// These tests model Firefox's two compartments and require the function to be
// reachable from the PAGE world, which is where a console evaluates.
// ============================================================

const BUNDLE = readFileSync(resolve(process.cwd(), "dist", "content", "index.js"), "utf8");
// The cover audit lives in the PRELOAD. Loading it here too makes the
// integrated path testable — otherwise every assertion below would only
// ever exercise the "hook missing" fallback.
const PRELOAD_BUNDLE = readFileSync(resolve(process.cwd(), "dist", "content", "preload.js"), "utf8");

let pageGlobal: Record<string, any> = {};
let contentWorld: any;

beforeAll(async () => {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><div id="rso"></div></body></html>`,
    { url: "https://www.google.com/search?q=t", runScripts: "outside-only", pretendToBeVisual: true }
  );
  const w: any = dom.window;
  const d = w.document;
  w.localStorage.setItem(
    "_shh_cache",
    JSON.stringify({ domains: ["blocked.com"], wildcard: true, paused: false })
  );
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
  // The page's own global. `wrappedJSObject` is how a Firefox content script
  // reaches it; the console evaluates in exactly this compartment.
  pageGlobal = {};
  Object.defineProperty(w, "wrappedJSObject", { get: () => pageGlobal, configurable: true });

  w.browser = {
    runtime: {
      getManifest: () => ({ version: "1.8.20" }),
      id: "t",
      onMessage: { addListener() {} },
      sendMessage: async (m: any) =>
        m.type === "GET_LIST"
          ? { entries: [{ domain: "blocked.com", mode: "block", enabled: true, createdAt: 0 }] }
          : { prefs: { debugMode: true, pausedGlobally: false, pausedEngines: [], engineToggles: { google: true }, showNotices: true, showOnHover: false, subdomainWildcard: true, infiniteScroll: false } },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };
  if (!w.chrome) w.chrome = w.browser;
  w.eval(PRELOAD_BUNDLE);
  w.eval(BUNDLE);
  contentWorld = w;
  await new Promise((r) => setTimeout(r, 500));
});

describe("the page-readable report attribute (the channel that cannot be denied)", () => {
  // Two field failures drove this. First `__shhDiagText is not defined`
  // (isolated world), then `Permission denied to access object` (a
  // content-script function cannot be CALLED from the page compartment without
  // `cloneInto`). A DOM attribute crosses neither boundary: the DOM is shared
  // and `getAttribute` is a same-realm call.
  //
  // jsdom has no compartments, so it cannot test the `cloneInto` path at all —
  // which is exactly why the previous suite passed a bridge that was
  // guaranteed to fail in the browser. These assertions target the mechanism
  // that does not have that problem.

  it("is present on <html> after the first processResults pass", () => {
    const attr = contentWorld.document.documentElement.getAttribute("data-shh-report");
    expect(typeof attr).toBe("string");
    expect((attr as string).length).toBeGreaterThan(400);
  });

  it("holds a real report, framed for copy-paste", () => {
    const attr: string = contentWorld.document.documentElement.getAttribute("data-shh-report")!;
    expect(attr.startsWith("=== SHH FIELD REPORT ===")).toBe(true);
    expect(attr.trimEnd().endsWith("=== END ===")).toBe(true);
  });

  it("names the build stamp", () => {
    const attr: string = contentWorld.document.documentElement.getAttribute("data-shh-report")!;
    expect(attr).toMatch(/v1\.8\.\d+\+[0-9a-f]{8}/);
  });

  it("is readable with the exact expression the popup tells users to run", () => {
    // This is the literal instruction. If the attribute name or location ever
    // changes, this fails — which is the point.
    const viaPageExpr =
      contentWorld.document.documentElement.getAttribute("data-shh-report");
    expect(typeof viaPageExpr).toBe("string");
    expect((viaPageExpr as string).length).toBeGreaterThan(400);
  });
});

describe("the diagnostic is reachable from the console a user actually has", () => {
  it("is defined on the PAGE global, not only in the content script's world", () => {
    // The single assertion that would have caught the FIRST field failure.
    expect(typeof pageGlobal.__shhDiagText).toBe("function");
  });

  it("uses cloneInto where a cross-compartment call needs it", () => {
    // What this test CAN and CANNOT prove. The first field failure was that
    // `__shhDiagText` resolved from the page console but threw on CALL — "Permission
    // denied to access object" — because a raw content-script function is visible
    // across the boundary but not callable.
    //
    // jsdom has no compartments, so it cannot reproduce that and this cannot test
    // the actual call. What it CAN do is pin that the bridge routes through
    // cloneInto at all. An earlier version asserted
    // `expect(globalThis.__cloneIntoUsed).toBeUndefined()` — a flag that is set
    // NOWHERE in the codebase, so it passed whether the bridge worked, was
    // bypassed, or had been deleted entirely. That assertion was pure noise and
    // has been removed.
    //
    // A grep for the identifier is the honest ceiling here, and it is a MEANINGFUL
    // one: clonestring survives minification because it is a feature-detected
    // property name, and deleting the cloneInto path from installPageBridge would
    // remove every hit.
    const hits = BUNDLE.match(/cloneInto/g) ?? [];
    expect(hits.length, "bundle no longer references cloneInto at all").toBeGreaterThan(0);
  });

  it("produces a real report from the content-script world", () => {
    // Called on the CONTENT-SCRIPT world, where no compartment boundary is
    // crossed. The page-world call is covered by the cloneInto test above; the
    // attribute is the guaranteed path for users.
    const txt: string = contentWorld.__shhDiagText();
    expect(txt.length).toBeGreaterThan(400);
    expect(txt.startsWith("=== SHH FIELD REPORT ===")).toBe(true);
    expect(txt.trimEnd().endsWith("=== END ===")).toBe(true);
  });

  it("carries the verdict header the user reads first", () => {
    const txt: string = contentWorld.__shhDiagText();
    expect(txt).toContain("detectorArmed:");
    expect(txt).toContain("UNMARKED-BUT-BLOCKED");
  });

  it("still leaves the content-script world's own copy working", () => {
    expect(typeof contentWorld.__shhDiagText).toBe("function");
    expect(typeof contentWorld.__shhDiagText()).toBe("string");
  });
});

// ============================================================
// The cover audit must be reachable from the page console too
//
// I added `__shhCoverAudit()` to the preload and told the user to run
// `copy(JSON.stringify(__shhCoverAudit()))` in the console — which cannot work:
// the preload runs in the ISOLATED world, so that name is undefined where the
// console evaluates. That is precisely the mistake this file already exists to
// prevent (field run 2026-09-30: `__shhDiagText is not defined`), repeated.
//
// Fixed by routing it through the same `installPageBridge`, and by folding it
// into `__shhDiagText()` so the command the popup already documents answers the
// cover question. These tests pin both halves.
// ============================================================
describe("the cover audit is reachable from the console a user actually has", () => {
  it("is defined on the PAGE global, not only in the content script's world", () => {
    expect(typeof pageGlobal.__shhCoverAuditText).toBe("function");
  });

  it("returns a STRING (primitives cross compartments without cloneInto)", () => {
    const out = pageGlobal.__shhCoverAuditText();
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("reports REAL numbers now that the preload has run in this harness", () => {
    // Before the preload bundle was loaded here this returned its "UNAVAILABLE"
    // fallback, so the assertion below could not tell a working hook from a
    // missing one. Now it exercises the integrated path.
    const out: string = pageGlobal.__shhCoverAuditText();
    expect(out).not.toContain("UNAVAILABLE");
    expect(out).toContain("blankGaps=");
    expect(out).toContain("candidates=");
  });

  it("is folded into the report the popup already tells users to run", () => {
    const attr: string =
      contentWorld.document.documentElement.getAttribute("data-shh-report")!;
    expect(attr).toContain("cover audit");
    expect(attr).toContain("blankGaps=");
    // ...and with a NUMBER, not the fallback text.
    expect(attr).toMatch(/blankGaps=\d+/);
  });
});
