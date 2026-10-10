import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

// ============================================================
// The cover audit must not print an all-clear it cannot support
//
// FIELD REPORT 2026-10-10. The audit returned
//
//   blankGaps=0  undetermined=0  candidates=37  coverArmed=false  active=false
//   VERDICT: nothing is stuck under the cover. If a blank gap is on screen,
//            the cover is NOT its cause — check the node's own opacity/color.
//
// Every number was true and the conclusion was still misleading, because the
// cover had never been ARMED: the preload's `_shh_cache` held ZERO domains while
// storage held six (`skipReason=no blocked domains in cache (hooks installed,
// observer not started)`). With no cover there is nothing to strand, so
// `blankGaps=0` is trivially true — it answers a question that was never asked.
//
// A false all-clear is the worst possible output for the one tool built to
// avoid them. These tests pin the refusal, and pin the diagnostic
// (`preloadDomains`) that makes the situation visible at all.
// ============================================================

const PRELOAD = readFileSync(resolve(process.cwd(), "dist", "content", "preload.js"), "utf8");
const INDEX = readFileSync(resolve(process.cwd(), "dist", "content", "index.js"), "utf8");

const pageGlobal: Record<string, unknown> = {};

/** Boot both bundles with a chosen `_shh_cache` payload. */
function boot(cacheDomains: string[]): Record<string, unknown> {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="rso"></div></body></html>`, {
    url: "https://www.google.com/search?q=t",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window as unknown as Record<string, unknown> & {
    localStorage: Storage;
    CSSStyleSheet: { prototype: Record<string, unknown> };
    document: Document;
  };
  w.localStorage.setItem(
    "_shh_cache",
    JSON.stringify({ domains: cacheDomains, wildcard: true, paused: false })
  );
  w.CSSStyleSheet.prototype.replaceSync = function () {};
  w.CSSStyleSheet.prototype.insertRule = function () { return 0; };
  Object.defineProperty(w, "wrappedJSObject", { get: () => pageGlobal, configurable: true });
  w.browser = {
    runtime: {
      getManifest: () => ({ version: "test" }),
      id: "t",
      onMessage: { addListener() {} },
      sendMessage: async () => ({ entries: [] }),
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };
  (w as unknown as { eval: (s: string) => void }).eval(PRELOAD);
  (w as unknown as { eval: (s: string) => void }).eval(INDEX);
  return w;
}

describe("cover audit verdict — no unsupported all-clear", () => {
  it("REFUSES the all-clear when the cover was never armed (the field case)", () => {
    // Empty cache == the preload's real-world state in the field report.
    boot([]);
    const text = String((pageGlobal.__shhCoverAuditText as () => string)());

    expect(text).toContain("preloadDomains=0");
    expect(text).toContain("THE COVER WAS NOT ARMED");
    // The specific sentence that misled the field report must NOT appear.
    expect(text).not.toContain("nothing is stuck under the cover");
    // ...and it must point at the mechanism that WAS visible in the field.
    expect(text).toContain("visibility:hidden");
  });

  it("reports preloadDomains so an inert document_start pass is visible", () => {
    boot([]);
    const audit = (pageGlobal.__shhCoverAuditText as () => string)();
    expect(String(audit)).toContain("preloadDomains=0");
  });

  it("gives the normal verdict when the cover IS armed and clear", () => {
    boot(["blocked.com"]);
    const text = String((pageGlobal.__shhCoverAuditText as () => string)());
    expect(text).toContain("preloadDomains=1");
    expect(text).not.toContain("THE COVER WAS NOT ARMED");
    expect(text).toContain("the cover WAS armed, and nothing is stuck under it");
  });
});
