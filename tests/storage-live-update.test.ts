import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

// ============================================================
// Storage events must refresh the LIVE page, independent of the
// message bus
// ============================================================
//
// `runtime.sendMessage` is a best-effort channel: the background fires
// PREFS_UPDATED / LIST_UPDATED with `void`, so a suspending event page, a tab
// that registered late, or a rejected send loses the notification silently.
// `browser.storage.onChanged` is delivered by the browser to every extension
// context — including content scripts — so it is the backstop for popup →
// page propagation.
//
// Two properties matter and are asserted separately:
//   * a list change hides / releases results without a reload;
//   * a pause change reveals everything and clears the preload's `:has()` rules.
//
// This drives the real bundle: the defect class here is the wiring from a
// browser event to the live matcher, which no unit test of the queue can reach.
const BUNDLE = readFileSync(resolve(process.cwd(), "dist", "content", "index.js"), "utf8");

const ENTRIES = [{ domain: "blocked.com", mode: "block", enabled: true, createdAt: 0 }];
const PREFS = {
  debugMode: true, subdomainWildcard: true, pausedGlobally: false,
  pausedEngines: [], engineToggles: { google: true },
  showNotices: true, showOnHover: false, infiniteScroll: false,
};

const flush = (ms: number) => new Promise((r) => setTimeout(r, ms));

function boot(initial: {
  entries?: unknown[];
  prefs?: Record<string, unknown>;
  cache?: string;
  msgMode?: "ok" | "fail";
  listGetFails?: boolean;
} = {}) {
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
  w.localStorage.clear();
  if (initial.cache !== undefined) w.localStorage.setItem("_shh_cache", initial.cache);
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

  const state = {
    entries: (initial.entries ?? []) as unknown[],
    prefs: { ...PREFS, ...(initial.prefs ?? {}) } as Record<string, unknown>,
    localPrefs: undefined as Record<string, unknown> | undefined,
    syncFails: false,
    msgMode: initial.msgMode ?? "ok",
    listGetFails: initial.listGetFails ?? false,
  };
  const listeners: ((changes: unknown, area: string) => void)[] = [];
  let hasArgs: unknown[] = [];
  (w as any).__shhUpdateHas = (list: unknown, wildcard: unknown) => { hasArgs = [list, wildcard]; };

  w.browser = {
    runtime: {
      getManifest: () => ({ version: "1.8.20" }),
      id: "t",
      onMessage: { addListener() {} },
      sendMessage: async (m: any) => {
        if (state.msgMode === "fail") throw new Error("background cold");
        return m.type === "GET_LIST" ? { entries: state.entries } : { prefs: state.prefs };
      },
    },
    storage: {
      local: {
        get: async () => {
          if (state.listGetFails) throw new Error("storage.local unavailable");
          return {
            shh_entries: state.entries,
            ...(state.localPrefs ? { shh_prefs_local: state.localPrefs } : {}),
          };
        },
        set: async () => {},
      },
      sync: {
        get: async () => {
          if (state.syncFails) throw new Error("sync unavailable");
          return { shh_prefs: state.prefs };
        },
        set: async () => {},
      },
      onChanged: {
        addListener: (fn: (changes: unknown, area: string) => void) => { listeners.push(fn); },
        removeListener: () => {},
      },
    },
  };
  if (!w.chrome) w.chrome = w.browser;
  w.eval(BUNDLE);

  return {
    d,
    state,
    hasArgs: () => hasArgs,
    emit(changes: Record<string, { newValue: unknown }>, area: string) {
      for (const fn of listeners) fn(changes, area);
    },
  };
}

describe("storage events keep the live page in sync", () => {
  it("hides a newly blocked result when the list changes, without a reload", async () => {
    const { d, state, emit } = boot({ entries: [] });
    await flush(500);
    expect(d.querySelectorAll("[data-shh-result]").length).toBe(0);
    expect(d.querySelectorAll(".shh-block-btn").length).toBeGreaterThan(0);

    state.entries = ENTRIES;
    emit({ shh_entries: { newValue: ENTRIES } }, "local");
    await flush(600);

    expect(d.querySelectorAll("[data-shh-result]").length).toBe(1);
    expect(d.querySelectorAll(".shh-placeholder").length).toBe(1);
  }, 25000);

  it("releases a result when its domain is removed from the list", async () => {
    const { d, state, emit } = boot({ entries: ENTRIES });
    await flush(500);
    expect(d.querySelectorAll("[data-shh-result]").length).toBe(1);

    state.entries = [];
    emit({ shh_entries: { newValue: [] } }, "local");
    await flush(600);

    expect(d.querySelectorAll("[data-shh-result]").length).toBe(0);
    expect(d.querySelectorAll(".shh-placeholder").length).toBe(0);
    expect(d.body.innerHTML).toMatch(/blocked\.com/);
  }, 25000);

  it("suspends the page on a sync prefs event", async () => {
    const { d, state, emit, hasArgs } = boot({ entries: ENTRIES });
    await flush(500);
    expect(d.querySelectorAll("[data-shh-result]").length).toBe(1);

    state.prefs = { ...PREFS, pausedGlobally: true };
    emit({ shh_prefs: { newValue: state.prefs } }, "sync");
    await flush(600);

    expect(d.querySelectorAll("[data-shh-result]").length).toBe(0);
    expect(d.querySelectorAll(".shh-placeholder").length).toBe(0);
    // The suspend teardown must clear the preload's :has() rules too; without
    // it the CSS layer keeps hiding nodes the observer no longer manages.
    expect(hasArgs()[0]).toEqual([]);
  }, 25000);

  it("honours a local prefs-mirror event when sync is unavailable", async () => {
    const { d, state, emit } = boot({ entries: ENTRIES });
    await flush(500);
    expect(d.querySelectorAll("[data-shh-result]").length).toBe(1);

    // The popup's SET_PREFS falls back to the local mirror when sync throws.
    state.syncFails = true;
    state.localPrefs = { ...PREFS, pausedGlobally: true };
    emit({ shh_prefs_local: { newValue: state.localPrefs } }, "local");
    await flush(600);

    expect(d.querySelectorAll("[data-shh-result]").length).toBe(0);
    expect(d.querySelectorAll(".shh-placeholder").length).toBe(0);
  }, 25000);

  // ── Resume re-read: direct storage, failure-containing ────────────────────
  //
  // A paused-at-load tab returns from init at `bail-cache-says-paused` with no
  // prefs and a non-authoritative empty list. The unpause that resumes it can
  // arrive via storage.onChanged alone — the background may still be cold.
  // The re-read MUST therefore prefer direct storage; a resume that awaits the
  // message bus (no timeout) either stalls or aborts, leaving `engineActive`
  // true with no matcher, no observer and nothing hidden.

  it("resumes a paused-at-load tab from direct storage when the message bus is cold", async () => {
    const pausedCache = JSON.stringify({
      domains: ["blocked.com"], wildcard: true, paused: true, debug: false,
    });
    const { d, state, emit } = boot({
      cache: pausedCache, listGetFails: true, msgMode: "fail",
    });
    await flush(1300); // tier-1 throw + two rejected message retries
    expect(d.querySelectorAll("[data-shh-result]").length).toBe(0);

    state.listGetFails = false;
    state.entries = ENTRIES;
    state.prefs = { ...PREFS, pausedGlobally: false };
    emit({ shh_prefs: { newValue: state.prefs } }, "sync");
    await flush(800);

    expect(d.querySelectorAll("[data-shh-result]").length).toBe(1);
    expect(d.querySelectorAll(".shh-placeholder").length).toBe(1);
  }, 25000);

  it("finishes wiring the resume when the list re-read fails, so later results are handled", async () => {
    const pausedCache = JSON.stringify({
      domains: ["blocked.com"], wildcard: true, paused: true, debug: false,
    });
    const { d, state, emit } = boot({
      cache: pausedCache, listGetFails: true, msgMode: "fail",
    });
    await flush(1300);

    // Unpause while EVERY list transport is down. The re-read failure may cost
    // us the list, but it must not abort the rest of the resume (matcher,
    // observer, tab wiring).
    state.prefs = { ...PREFS, pausedGlobally: false };
    emit({ shh_prefs: { newValue: state.prefs } }, "sync");
    await flush(600);

    // Storage recovers; the list arrives through its own event.
    state.listGetFails = false;
    state.entries = ENTRIES;
    emit({ shh_entries: { newValue: ENTRIES } }, "local");
    await flush(600);
    expect(d.querySelectorAll("[data-shh-result]").length).toBe(1);

    // A result rendered AFTER the resume must be caught by the observer the
    // resume started. An aborted continuation never starts one.
    const wrapper = d.createElement("div");
    wrapper.className = "MjjYud";
    wrapper.innerHTML =
      '<div class="tF2Cxc"><div class="kb0PBd"><a href="/url?q=https://blocked.com/y"><h3>Blocked 2</h3></a><cite>blocked.com</cite></div></div>';
    d.getElementById("rso")!.appendChild(wrapper);
    await flush(500);

    expect(d.querySelectorAll("[data-shh-result]").length).toBe(2);
    expect(d.querySelectorAll(".shh-placeholder").length).toBe(2);
  }, 25000);
});
