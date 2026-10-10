import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

// ============================================================
// Page-colour detection must survive the DOMContentLoaded move
// ============================================================
//
// The content script used to run at `document_idle` — after the window `load`
// event — so stylesheets were always applied when it sampled
// `getComputedStyle(body).backgroundColor`. It now runs at `document_end`
// (DOMContentLoaded), which MDN is explicit does NOT wait for stylesheets.
//
// On a light SERP with no explicit body background, the computed value at that
// moment is `rgba(0, 0, 0, 0)`. The old `isColorDark` regex captured 0,0,0,
// computed luminance 0, and returned true — so a light page was detected as
// DARK. The result was latched (`injectBaseStyles` is one-shot per page) and
// sticky for the whole session: `#2a2a2a` dialogs on a white SERP, olive
// "showing once" boxes, dark placeholders.
//
// Found by an adversarial review, not by a failing test — which is why this file
// exists.
//
// HARNESS NOTE, learned the hard way: `injectBaseStyles()` runs inside
// `protectPage`, which is reached only after `init()`'s first `await` (the
// storage read). So the style element cannot be checked synchronously after
// `w.eval(BUNDLE)` — an early version of this test did exactly that, found zero
// style elements, and briefly suspected `injectBaseStyles` of not running at all.
// A flush is required.
// ============================================================

const BUNDLE = readFileSync(
  resolve(process.cwd(), "dist", "content", "index.js"),
  "utf8"
);

const flush = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bootPage(bodyBgAtLoad: () => string | undefined): { w: any; d: Document } {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="rso"></div></body></html>`,
    { url: "https://www.google.com/search?q=t", runScripts: "outside-only", pretendToBeVisual: true }
  );
  const w: any = dom.window;
  const d = w.document;
  // jsdom finishes parsing and sets `readyState = "complete"` almost immediately,
  // which means the load-time colour re-check — gated on
  // `readyState !== "complete"` — is never registered and cannot be tested
  // through the normal path. Controlling it makes both sides observable.
  let ready = "loading";
  Object.defineProperty(d, "readyState", {
    configurable: true,
    get: () => ready,
    set: (v: string) => { ready = v; },
  });
  d.readyState = "loading";
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
  // getComputedStyle reports the background the way a pre-stylesheet DOM would.
  w.getComputedStyle = () => ({ backgroundColor: bodyBgAtLoad() });
  w.browser = {
    runtime: {
      getManifest: () => ({ version: "1.8.20" }),
      id: "t",
      onMessage: { addListener() {} },
      sendMessage: async (m: any) =>
        m.type === "GET_LIST" ? { entries: [] } : {
          prefs: {
            debugMode: false, subdomainWildcard: true, pausedGlobally: false,
            pausedEngines: [], engineToggles: { google: true },
            showNotices: true, showOnHover: false, infiniteScroll: false,
          },
        },
    },
    storage: {
      local: { get: async () => ({ shh_entries: [] }), set: async () => {} },
      sync: { get: async () => ({ shh_prefs: {} }), set: async () => {} },
    },
  };
  if (!w.chrome) w.chrome = w.browser;
  return { w, d };
}

function styleCss(d: Document): string {
  return d.getElementById("shh-base-styles")?.textContent ?? "";
}

// Unambiguous markers. `#cccccc` is deliberately in NEITHER: it is the dark
// theme's text colour AND the light theme's border colour, so including it in
// both regexes makes every theme match both — which is exactly what happened in
// an early version of this file and produced three false failures.
const DARK = /#2a2a2a|#444444/;
const LIGHT = /#f0f0f0|#555555/;

describe("page-colour detection", () => {
  it("does NOT theme a transparent-background (light) SERP as dark", async () => {
    // The exact field case: `rgba(0, 0, 0, 0)` at DOMContentLoaded because the
    // page's stylesheet has not been applied yet.
    const { w, d } = bootPage(() => "rgba(0, 0, 0, 0)");
    w.eval(BUNDLE);
    await flush(400);
    const css = styleCss(d);
    expect(css.length, "injectBaseStyles did not produce a style element").toBeGreaterThan(0);
    expect(DARK.test(css), `light page themed dark:\n${css.slice(0, 400)}`).toBe(false);
    expect(LIGHT.test(css)).toBe(true);
  }, 20000);

  it("still themes a genuinely dark SERP as dark", async () => {
    // The other direction must not be broken by the fix. A real dark background
    // is opaque black, which is dark for the right reason.
    const { w, d } = bootPage(() => "rgb(0, 0, 0)");
    w.eval(BUNDLE);
    await flush(400);
    const css = styleCss(d);
    expect(DARK.test(css), `dark page not themed dark:\n${css.slice(0, 400)}`).toBe(true);
  }, 20000);

  it("honours a light theme too, not just dark/transparent", async () => {
    // Guards the fix from over-correcting: an opaque light background must be
    // light, and an OPAQUE light value is what `load` would report.
    const { w, d } = bootPage(() => "rgb(255, 255, 255)");
    w.eval(BUNDLE);
    await flush(400);
    expect(DARK.test(styleCss(d))).toBe(false);
  }, 20000);

  it("re-checks the colour on `load`, so a late stylesheet is honoured", async () => {
    // The transparent case is caught by `isColorDark`, but a stylesheet that
    // genuinely changes the body background after DOMContentLoaded is not.
    // Started transparent (pre-stylesheet), then becomes opaque black at `load`.
    let bg = "rgba(0, 0, 0, 0)";
    const { w, d } = bootPage(() => bg);
    w.eval(BUNDLE);
    await flush(400);
    expect(DARK.test(styleCss(d)), "should start light on a transparent body").toBe(false);

    bg = "rgb(0, 0, 0)";
    (d as unknown as { readyState: string }).readyState = "interactive";
    w.dispatchEvent(new w.Event("load"));
    await flush(50);
    expect(DARK.test(styleCss(d)), "load-time dark theme not applied").toBe(true);
  }, 20000);

  it("does NOT rewrite the style when the colour is unchanged at load", async () => {
    // The re-check must be a correction, not an unconditional rewrite — an
    // unconditional one would be indistinguishable from correct behaviour here,
    // so this pins that it really compares before touching the CSS.
    let bg = "rgba(0, 0, 0, 0)";
    const { w, d } = bootPage(() => bg);
    w.eval(BUNDLE);
    await flush(400);
    const el = d.getElementById("shh-base-styles") as HTMLStyleElement;
    const before = el.textContent;
    bg = "rgba(0, 0, 0, 0)"; // genuinely unchanged
    w.dispatchEvent(new w.Event("load"));
    await flush(50);
    expect(el.textContent).toBe(before);
  }, 20000);
});
