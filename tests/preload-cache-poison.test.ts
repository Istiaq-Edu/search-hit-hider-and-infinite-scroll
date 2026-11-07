import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import {
  MAX_CACHE_DOMAINS,
  MAX_CACHE_RAW_LENGTH,
  MAX_CSS_DOMAINS,
} from "../src/content/cache-limits";

// ============================================================
// The preload treats `_shh_cache` as UNTRUSTED
//
// The cache is in localStorage on the page's origin. A hostile page can write
// it, and the preload reads it at document_start before anything else can
// validate it. These tests drive the BUILT BUNDLE with poisoned payloads and
// assert the three bounds a poisoned cache must never break:
//
//   1. no unbounded CSS — the :has() layer takes at most MAX_CSS_DOMAINS
//   2. no unbounded list — matching takes at most MAX_CACHE_DOMAINS
//   3. no semantic escalation — a dotless entry ("com", which with wildcard on
//      would hide every .com result) is rejected, and a junk-only payload does
//      not arm the Google cover at all
//
// Plus the consistency property that the content script and the preload must
// agree on: with strip-www OFF, an entry for www.example.com must not hide the
// bare host.
// ============================================================

const BUNDLE = readFileSync(resolve(process.cwd(), "dist", "content", "preload.js"), "utf8");

interface TestWindow {
  document: Document & Record<string, any>;
  localStorage: Storage;
  CSSStyleSheet: any;
  eval: (code: string) => void;
  addEventListener: (type: string, handler: (ev: any) => void) => void;
  browser?: any;
  chrome?: any;
  __shhPreloadDiag: () => Record<string, any>;
  [key: string]: any;
}

function boot(rawCache: string): TestWindow {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><div id="rso"></div></body></html>`,
    {
      url: "https://www.google.com/search?q=t",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    }
  );
  const w = dom.window as unknown as TestWindow;
  w.localStorage.setItem("_shh_cache", rawCache);
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
    runtime: { getManifest: () => ({ version: "1.8.21" }), id: "t", onMessage: { addListener() {} } },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  } as never;
  if (!(w as any).chrome) (w as any).chrome = (w as any).browser;
  w.eval(BUNDLE);
  return w;
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

async function judge(w: TestWindow, href: string): Promise<HTMLElement> {
  const el = w.document.createElement("div");
  el.className = "kb0PBd";
  el.innerHTML = `<a href="${href}"><h3>R</h3></a>`;
  w.document.getElementById("rso")!.appendChild(el);
  await settle();
  return el as HTMLElement;
}

const cache = (over: Record<string, unknown>) => JSON.stringify(over);

describe("preload cache bounds — entry count and CSS size", () => {
  it("caps the matcher list and the :has() layer independently", () => {
    const many = Array.from({ length: MAX_CACHE_DOMAINS + 1000 }, (_, i) => `d${i}.com`);
    const w = boot(cache({ domains: many, wildcard: true, paused: false }));
    const diag = w.__shhPreloadDiag();

    expect(diag.cacheDomainsRaw).toBe(MAX_CACHE_DOMAINS + 1000);
    expect(diag.domains).toBe(MAX_CACHE_DOMAINS);
    // CSS batches of 50; the JS matcher still covers the full capped list.
    expect(diag.hasRulesBuilt).toBe(Math.ceil(MAX_CSS_DOMAINS / 50));
    expect(diag.cacheDomainsCapped).toBe(MAX_CACHE_DOMAINS - MAX_CSS_DOMAINS);
  });

  it("refuses an oversized payload outright — no parse, no cover, no observer", () => {
    const huge = '{"domains":["a.com"],"paused":false}' + " ".repeat(MAX_CACHE_RAW_LENGTH);
    const w = boot(huge);
    const diag = w.__shhPreloadDiag();
    expect(diag.domains).toBe(0);
    expect(diag.cacheDomainsRaw).toBe(0);
    expect(diag.preloadSkipReason).toContain("no blocked domains");
    expect(w.document.documentElement.hasAttribute("data-shh-active")).toBe(false);
  });
});

describe("preload cache bounds — semantic escalation", () => {
  it("a dotless TLD entry cannot hide every result under that suffix", async () => {
    // With wildcard on, "com" used to match every .com host. A page could
    // therefore censor the entire SERP with one localStorage write.
    const w = boot(cache({ domains: ["com"], wildcard: true, paused: false }));
    expect(w.__shhPreloadDiag().domains).toBe(0);
    const el = await judge(w, "https://example.com/page");
    expect(el.getAttribute("data-shh-preloaded")).toBeNull();
    expect(el.style.getPropertyValue("display")).not.toBe("none");
  });

  it("a junk-only payload does not arm the Google cover", () => {
    // An armed cover with an empty matcher means every div.g sits at
    // opacity:0 until the rescan reveals it — a blank SERP, for a payload the
    // page wrote on purpose.
    const w = boot(cache({ domains: ["", "{}", "com", 'x"y'], wildcard: true }));
    expect(w.document.documentElement.hasAttribute("data-shh-active")).toBe(false);
    expect(w.__shhPreloadDiag().preloadSkipReason).toContain("no blocked domains");
  });
});

describe("preload cache — www semantics agree with the content script", () => {
  it("with strip-www OFF, an entry for www.example.com does NOT hide the bare host", async () => {
    // The preload stripped www unconditionally, so this exact payload pre-hid
    // https://example.com — a host the content script's matcher considers
    // unblocked — and then revealed it at idle. A flash, and the actual www
    // host never got pre-paint protection.
    const w = boot(cache({
      domains: ["www.example.com"], wildcard: false, stripWww: false, paused: false,
    }));
    const bare = await judge(w, "https://example.com/page");
    expect(bare.getAttribute("data-shh-preloaded")).toBeNull();
    expect(bare.getAttribute("data-shh-ok")).toBe("true");
  });

  it("with strip-www OFF, the www host itself IS hidden", async () => {
    const w = boot(cache({
      domains: ["www.example.com"], wildcard: false, stripWww: false, paused: false,
    }));
    const www = await judge(w, "https://www.example.com/page");
    expect(www.getAttribute("data-shh-preloaded")).toBe("true");
  });

  it("with strip-www ON (default), the www entry matches both forms", async () => {
    const w = boot(cache({ domains: ["www.example.com"], wildcard: false, paused: false }));
    const bare = await judge(w, "https://example.com/page");
    expect(bare.getAttribute("data-shh-preloaded")).toBe("true");
    const www = await judge(w, "https://www.example.com/page");
    expect(www.getAttribute("data-shh-preloaded")).toBe("true");
  });

  it("matches a link whose hostname carries a trailing root dot", async () => {
    // URL keeps "example.com." as the hostname; cache entries never do.
    // Without normalization the link was pre-hidden by neither layer.
    const w = boot(cache({ domains: ["example.com"], wildcard: false, paused: false }));
    const dotted = await judge(w, "https://example.com./page");
    expect(dotted.getAttribute("data-shh-preloaded")).toBe("true");
  });
});
