import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

// ============================================================
// Preload negative controls
//
// Four conditions an adversarial audit PROVED could throw out of preload.ts,
// each verified here against the BUILT BUNDLE — not a re-implementation, and
// not a source-level reading. `pretest` runs the build, so `dist/` always
// exists and these can never silently skip (the failure mode that made the
// earlier `skipIf` dist test worthless).
//
// Why the bundle rather than importing preload.ts: the file is a top-level
// IIFE that reads `document` and `localStorage` at module scope, so importing
// it executes the whole thing against the test runner's environment. Evaluating
// the artifact in a purpose-built jsdom is the only way to bind to shipped code
// here, and it is also the only way to drive the real thing.
// ============================================================

const BUNDLE = readFileSync(resolve(process.cwd(), "dist", "content", "preload.js"), "utf8");

/**
 * The surface these tests actually drive. Deliberately NOT the DOM lib's
 * `Window`: jsdom's DOMWindow is not assignable to it (missing ~500
 * globalThis members) nor the reverse, and claiming otherwise produced a type
 * error that said nothing about the code under test. Stating the real surface
 * is both honest and usable.
 */
interface TestWindow {
  document: Document & Record<string, any>;
  localStorage: Storage;
  CSSStyleSheet: any;
  eval: (code: string) => void;
  addEventListener: (type: string, handler: (ev: any) => void) => void;
  browser?: any;
  chrome?: any;
  __shhUpdateHas: (domains: unknown, wildcard: boolean) => void;
  __shhDisarmCover: () => void;
  __shhRevealGoogle: () => void;
  __shhPreloadDiag: () => Record<string, any>;
  [key: string]: any;
}

interface Booted {
  w: TestWindow;
  uncaught: string[];
}

function boot(): Booted {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><div id="rso"></div></body></html>`,
    {
      url: "https://www.google.com/search?q=t",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    }
  );
  const w = dom.window as unknown as TestWindow;
  w.localStorage.setItem(
    "_shh_cache",
    JSON.stringify({ domains: ["blocked.com"], wildcard: true, paused: false })
  );
  // jsdom 29 has no adoptedStyleSheets and a no-op CSSStyleSheet; the cover and
  // the :has() layer are inert without these.
  (w.CSSStyleSheet.prototype as any).replaceSync = function () {};
  (w.CSSStyleSheet.prototype as any).insertRule = function () { return 0; };
  if (!("adoptedStyleSheets" in w.document)) {
    const sheets: unknown[] = [];
    Object.defineProperty(w.document, "adoptedStyleSheets", {
      get: () => sheets.slice(),
      set: (v: unknown[]) => { sheets.length = 0; sheets.push(...v); },
      configurable: true,
    });
  }
  w.browser = {
    runtime: { getManifest: () => ({ version: "1.8.20" }), id: "t", onMessage: { addListener() {} } },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  } as never;
  if (!(w as any).chrome) (w as any).chrome = (w as any).browser;

  const uncaught: string[] = [];
  w.addEventListener("error", (e: Event) => uncaught.push((e as ErrorEvent).message));
  w.eval(BUNDLE);
  return { w, uncaught };
}

const flush = (ms = 250) => new Promise((r) => setTimeout(r, ms));

describe("preload — a non-iterable list cannot escape the hook", () => {
  // `for (const raw of list)` throws `TypeError: list is not iterable` for
  // undefined/null/number/boolean. The ELEMENT type was already guarded; the
  // CONTAINER never was, and a throw here escapes the whole IIFE — which is
  // how this class of bug once left the Google cover permanently up.
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["a boolean", true],
    ["a plain object", {}],
  ])("__shhUpdateHas(%s) does not throw", (_label, arg) => {
    const { w } = boot();
    expect(() => w.__shhUpdateHas(arg, true)).not.toThrow();
  });

  it("__shhUpdateHas with non-string ELEMENTS does not throw", () => {
    const { w } = boot();
    expect(() => w.__shhUpdateHas([{}, 1, null, undefined], true)).not.toThrow();
  });
});

describe("preload — a null documentElement cannot skip the reveal", () => {
  // A throw at `document.documentElement.removeAttribute` skipped the pmark AND
  // the reveal that follows it, so a disarmed cover left every covered node at
  // `opacity:0; pointer-events:none` with no stamp to lift it. Low reachability
  // (the only caller runs at document_idle) and a severe consequence.
  it("__shhDisarmCover survives and still reveals", () => {
    const { w } = boot();
    Object.defineProperty(w.document, "documentElement", {
      get: () => null,
      configurable: true,
    });
    // Prove the override actually took. Without this the test can pass for the
    // wrong reason — and it did: an earlier version of this file asserted only
    // that nothing threw, which is also true when the guard is never reached.
    expect(w.document.documentElement).toBeNull();
    expect(() => w.__shhDisarmCover()).not.toThrow();
    const marks: { label: string }[] = w.__shhPreloadDiag().marks ?? [];
    expect(marks.some((m) => m.label.startsWith("google-cover-reveal"))).toBe(true);
  });

  it("__shhPreloadDiag itself survives — a diagnostic that throws loses the report", () => {
    // This one was found BY the test above: the diagnostic dereferenced
    // documentElement unguarded, so the very function a field tester calls to
    // produce a paste was the thing that could destroy it.
    const { w } = boot();
    Object.defineProperty(w.document, "documentElement", {
      get: () => null,
      configurable: true,
    });
    expect(w.document.documentElement).toBeNull();
    expect(() => w.__shhPreloadDiag()).not.toThrow();
  });
});

describe("preload — a throwing .style must not silently lose blocking", () => {
  // The audit's top finding. `el.style` is undefined outside the HTML namespace,
  // and `.style.setProperty` throws on such an element. Every call site absorbed
  // that in a BARE catch, so the node was neither hidden nor marked: blocking
  // was lost for it and nothing appeared in any log. The attribute half is the
  // layer the content script reconciles on, so it must still be applied — and
  // the failure must now be recorded.
  it("still marks the node and records the error", async () => {
    const { w, uncaught } = boot();
    const el = w.document.createElement("div");
    el.className = "kb0PBd";
    el.innerHTML =
      '<a href="/url?q=https://blocked.com/z"><h3>Z</h3></a><cite>blocked.com</cite>';
    Object.defineProperty(el, "style", {
      get() { throw new TypeError("style is undefined for this element"); },
      configurable: true,
    });
    w.document.getElementById("rso")!.appendChild(el);

    await flush();

    expect(el.getAttribute("data-shh-preloaded")).toBe("true");
    const errors: string[] = w.__shhPreloadDiag().errors ?? [];
    expect(errors.some((e) => e.includes("tryHide.style"))).toBe(true);
    expect(uncaught).toEqual([]);
  });
});

describe("preload — the build stamp identifies the artifact", () => {
  // Two different source states once carried the same stamp, because `-dirty`
  // encoded only THAT something was uncommitted. The stamp now hashes the
  // source bytes, so a report can name its build — the only way a minified
  // position like `preload.js:2:1870` can ever be attributed.
  it("embeds a content hash of the source, not a git status flag", () => {
    expect(BUNDLE).toMatch(/v1\.8\.\d+\+[0-9a-f]{8}/);
    expect(BUNDLE).not.toMatch(/v1\.8\.\d+\+[0-9a-f]{7}-dirty/);
  });
});
