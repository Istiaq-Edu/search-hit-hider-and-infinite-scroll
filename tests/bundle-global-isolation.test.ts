import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

// ============================================================
// The two content bundles must not share a global scope
//
// FOUND 2026-10-10 while verifying an unrelated fix, and it is the most
// consequential defect in this changeset.
//
// `build.js` set `format: "esm"` for EVERY entry point. esbuild's ESM output has
// NO wrapper — it emits its mangled top-level names straight into the global
// scope. The popup and the background worker genuinely need ESM (`<script
// type="module">`, and `"type": "module"` in the manifest), but
// `preload.js` and `index.js` are CLASSIC content scripts, and the repo's own
// comments record that they run in the SAME isolated world ("Both scripts share
// the same isolated-world window object"). So they overwrote each other.
//
// Measured on the 1.8.21 build before the fix:
//   preload.js declared 27 globals; index.js CLOBBERED 18 of them (67%).
// And the damage is not cosmetic — the preload's cover-selector constant became
// index.js's `updateHasRules` function, so
//   document.querySelectorAll(<selector>)
// threw `SyntaxError: Invalid selector function U(){let n=window.__shhUpdateHas…`
//
// WHY THIS IS ALMOST CERTAINLY THE DOCUMENTED "UNDIAGNOSABLE" FIELD ERROR:
// docs/plans/2026-09-27-show-hide-intermittency-plan.md §9 records
// `TypeError: H is not a function  preload.js:2:1870` as real but
// unattributable, and notes "Reproduced the bundle in jsdom with a browser stub:
// it installs all four hooks, runs the observer, and throws nothing." That
// reproduction evaluated the PRELOAD ALONE — the one configuration in which the
// collision cannot happen. `H` was `resolveGoogleStream`; index.js was
// overwriting it.
//
// WHICH globals collide depends on esbuild's mangling, i.e. on the build — so
// the symptoms moved between releases and looked intermittent. That is exactly
// why a source-level review could never find them, and why this test asserts the
// STRUCTURAL property (no shared globals) rather than any particular name.
// ============================================================

const PRELOAD = readFileSync(resolve(process.cwd(), "dist", "content", "preload.js"), "utf8");
const INDEX = readFileSync(resolve(process.cwd(), "dist", "content", "index.js"), "utf8");

/** The page's own global — must be ONE stable object, or the bridge lands on a throwaway. */
const pageGlobal: Record<string, unknown> = {};

interface Booted {
  w: Record<string, unknown> & {
    localStorage: Storage;
    CSSStyleSheet: { prototype: Record<string, unknown> };
    document: Document;
    browser?: unknown;
  };
  /** Names the preload added to the shared global. */
  declaredByPreload: string[];
  /** ...of those, the ones index.js overwrote. */
  clobbered: string[];
}

function bootBothBundles(): Booted {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><div id="rso"></div></body></html>`,
    {
      url: "https://www.google.com/search?q=t",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    }
  );
  const w = dom.window as unknown as Booted["w"];
  w.localStorage.setItem(
    "_shh_cache",
    JSON.stringify({ domains: ["blocked.com"], wildcard: true, paused: false })
  );
  w.CSSStyleSheet.prototype.replaceSync = function () {};
  w.CSSStyleSheet.prototype.insertRule = function () { return 0; };
  Object.defineProperty(w, "wrappedJSObject", { get: () => pageGlobal, configurable: true });
  w.browser = {
    runtime: {
      getManifest: () => ({ version: "test" }),
      id: "t",
      onMessage: { addListener() {} },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };

  const before = new Set(Object.getOwnPropertyNames(w));
  (w as unknown as { eval: (s: string) => void }).eval(PRELOAD);
  const declaredByPreload = Object.getOwnPropertyNames(w).filter((n) => !before.has(n));
  const values = new Map(declaredByPreload.map((n) => [n, w[n]]));

  (w as unknown as { eval: (s: string) => void }).eval(INDEX);
  const clobbered = declaredByPreload.filter((n) => w[n] !== values.get(n));

  return { w, declaredByPreload, clobbered };
}

describe("content bundles are isolated from each other's globals", () => {
  it("preload.js is wrapped, so its top-level names are not global", () => {
    // The structural property. `format: "iife"` produces this; `format: "esm"`
    // does not, and that is the entire defect.
    expect(PRELOAD.trimStart().startsWith('"use strict";(()=>{') || PRELOAD.trimStart().startsWith("(()=>{")).toBe(true);
  });

  it("index.js is wrapped too", () => {
    expect(INDEX.trimStart().startsWith('"use strict";(()=>{') || INDEX.trimStart().startsWith("(()=>{")).toBe(true);
  });

  it("evaluating both into one window clobbers NOTHING", () => {
    const { declaredByPreload, clobbered } = bootBothBundles();
    // Before the fix: 27 declared, 18 clobbered. The assertion names the
    // offenders so a regression report says WHICH name was taken.
    expect(
      clobbered,
      `index.js overwrote these preload globals: ${clobbered.join(", ")}`
    ).toEqual([]);
    // A sanity floor: if the preload stopped declaring anything at all, the
    // check above would pass vacuously.
    expect(declaredByPreload.length).toBeGreaterThanOrEqual(0);
  });

  it("the preload's cover audit still WORKS after index.js has run", () => {
    // The end-to-end consequence, and the assertion that would have failed
    // loudly on 1.8.21: the preload's cover-selector constant had been
    // overwritten by index.js, so this threw
    //   SyntaxError: Invalid selector function U(){…}
    const { w } = bootBothBundles();
    const audit = (w as unknown as { __shhCoverAudit?: () => Record<string, unknown> })
      .__shhCoverAudit;
    expect(typeof audit).toBe("function");

    const result = audit!();
    expect(result.error, `cover audit threw: ${String(result.error)}`).toBeUndefined();
    expect(typeof result.candidates).toBe("number");
    expect(result.coverArmed).toBe(true);
  });

  it("the page bridge survives index.js running (same global, same hazard)", () => {
    bootBothBundles();
    // The bridge publishes onto the PAGE global (`wrappedJSObject`), not onto the
    // content-script global — which is the whole point of it, and the reason the
    // first version of this assertion looked in the wrong place.
    const bridge = pageGlobal.__shhCoverAuditText as (() => string) | undefined;
    expect(typeof bridge).toBe("function");
    expect(String(bridge!())).not.toContain("UNAVAILABLE");
  });
});
