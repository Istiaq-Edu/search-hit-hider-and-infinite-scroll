import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

// ============================================================
// A live PREFS_UPDATED must reach the LIVE matcher and the LIVE
// :has() sheet — not just the module variable and the cache
// ============================================================
//
// Found by an adversarial sweep of the "new state arrives, a latch swallows the
// re-apply" class, and confirmed by reading `refreshPrefs`.
//
// `subdomainWildcard` looks cosmetic next to the pause/toggle fields, and
// `classifyPrefsTransition` agrees: a wildcard toggle produces "none", so it
// fell into the branch that only refreshed the cache. But it is an argument to
// `new DomainMatcher(entries, subdomainWildcard)` AND to the preload's
// `:has()` rule sheet, so the open page kept matching subdomains after the user
// turned the setting off — and kept NOT matching after they turned it on. The
// user had to reload to see their own change.
//
// This drives the real bundle, because the defect is in the wiring from a
// runtime message to the matcher, which a unit test of `classifyPrefsTransition`
// cannot reach.
const BUNDLE = readFileSync(resolve(process.cwd(), "dist", "content", "index.js"), "utf8");

const ENTRIES = [{ domain: "example.com", mode: "block", enabled: true, createdAt: 0 }];
const PREFS = {
  debugMode: true, subdomainWildcard: true, pausedGlobally: false,
  pausedEngines: [], engineToggles: { google: true },
  showNotices: true, showOnHover: false, infiniteScroll: false,
};

const flush = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A page with a WILDCARD-ONLY subdomain result. With `subdomainWildcard: true`
 * the matcher must block it; with it false the matcher must let it through, so
 * the same DOM distinguishes the two states unambiguously.
 */
function boot() {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><div id="rso">
      <div class="MjjYud"><div class="tF2Cxc">
        <div class="kb0PBd"><a href="/url?q=https://sub.example.com/x"><h3>Sub</h3></a>
        <cite>sub.example.com</cite></div>
      </div></div>
    </div></body></html>`,
    { url: "https://www.google.com/search?q=t", runScripts: "outside-only", pretendToBeVisual: true }
  );
  const w: any = dom.window;
  const d = w.document;
  w.localStorage.clear();
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

  // Captured so a test can flip prefs the way the background does, and can read
  // what the page told the preload's `:has()` sheet.
  //
  // `refreshPrefs` re-reads prefs with `getPrefs()` — the MESSAGE bus. The first
  // version of this harness overrode `storage.sync.get` instead, on the theory
  // that either path would work; it could not distinguish them, so a mutation
  // re-routing `refreshPrefs` to read `storage.sync` directly would have kept this
  // test green. Both are wired to the SAME variable here, which is honest about
  // what is proven: the toggle reaching the live matcher and the `:has()` sheet.
  // It does NOT prove which transport carried it. Contrast
  // `storage-direct.test.ts`, which DOES discriminate by asserting `sent` stays
  // empty.
  let listeners: ((msg: unknown) => void)[] = [];
  let hasArgs: unknown[] = [];
  let prefsNow: Record<string, unknown> = { ...PREFS };
  (w as any).__shhUpdateHas = (list: unknown, wildcard: unknown) => { hasArgs = [list, wildcard]; };
  w.browser = {
    runtime: {
      getManifest: () => ({ version: "1.8.20" }),
      id: "t",
      onMessage: { addListener: (fn: (msg: unknown) => void) => { listeners.push(fn); } },
      sendMessage: async (m: any) =>
        m.type === "GET_LIST" ? { entries: ENTRIES } : { prefs: prefsNow },
    },
    storage: {
      local: { get: async () => ({ shh_entries: ENTRIES }), set: async () => {} },
      sync: { get: async () => ({ shh_prefs: prefsNow }), set: async () => {} },
    },
  };
  if (!w.chrome) w.chrome = w.browser;
  w.eval(BUNDLE);

  return {
    d,
    /**
     * Deliver a PREFS_UPDATED the way the background broadcasts one: the popup
     * writes prefs, the background broadcasts unconditionally on SET_PREFS, and
     * the content script re-reads them over the message bus.
     */
    async pushPrefs(prefs: Record<string, unknown>) {
      prefsNow = { ...PREFS, ...prefs };
      for (const fn of listeners) fn({ type: "PREFS_UPDATED" });
      await flush(400);
    },
    hasArgs: () => hasArgs,
  };
}

describe("a wildcard toggle reaches the live matcher", () => {
  it("stops matching subdomains immediately, without a reload", async () => {
    const { d, pushPrefs, hasArgs } = boot();
    // Baseline: wildcard ON, so the subdomain result IS blocked.
    await flush(500);
    expect(d.querySelectorAll("[data-shh-result]").length).toBe(1);

    // The user turns the setting off in the popup. The background broadcasts
    // PREFS_UPDATED unconditionally on SET_PREFS.
    await pushPrefs({ subdomainWildcard: false });
    await flush(300);

    // The subdomain must be released: not stamped, no placeholder.
    expect(d.querySelectorAll("[data-shh-result]").length).toBe(0);
    expect(d.querySelectorAll(".shh-placeholder").length).toBe(0);
    expect(d.body.innerHTML).toMatch(/sub\.example\.com/);
    // And the preload's `:has()` sheet must have been told, or pre-paint hiding
    // on the NEXT load still uses the old rule.
    expect(hasArgs()[1]).toBe(false);
  }, 25000);

  it("starts matching subdomains immediately when turned back on", async () => {
    // The reverse direction is the one that leaves results VISIBLE that the user
    // expects hidden, so it gets its own test rather than riding on the first.
    const { d, pushPrefs, hasArgs } = boot();
    await flush(500);
    expect(d.querySelectorAll("[data-shh-result]").length).toBe(1);
    await pushPrefs({ subdomainWildcard: false });
    await flush(300);
    expect(d.querySelectorAll("[data-shh-result]").length).toBe(0);
    await pushPrefs({ subdomainWildcard: true });
    await flush(300);
    expect(d.querySelectorAll("[data-shh-result]").length).toBe(1);
    expect(hasArgs()[1]).toBe(true);
  }, 25000);
});
