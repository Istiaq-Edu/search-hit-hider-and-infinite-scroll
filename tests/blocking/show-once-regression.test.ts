import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import {
  SHOWN_ONCE_EXEMPTION,
  SHOWN_ONCE_SELECTOR,
} from "../../src/content/markers";
import {
  showOnce,
  revealPreloadHiding,
  rehideResult,
  restoreResult,
} from "../../src/content/blocking/hider";

// ============================================================
// "Show works on SOME results in the same batch" — 2026-11-05
//
// Reproduced in Firefox Developer Edition against the SHIPPED preload.js +
// preload.css. Two results in one #rso batch:
//
//   flat   (adapter stamps the div.g itself)      -> Show -> display:block
//   nested (adapter stamps div.tF2Cxc, preload
//           hid the INNER div.g)                 -> Show -> display:none
//
// Three independent layers keep the inner node hidden, and none of them is
// touched by an inline `display:block !important` on the outer wrapper:
//
//   1. the marker-free `:has()` adopted sheet (display:none !important)
//   2. the preload observer's Case D, which reads showOnce's deliberate
//      `data-shh-preloaded` REMOVAL as "the page stripped our marker" and
//      re-hides the node in the post-click microtask
//   3. the preload.css `[data-shh-preloaded]` rule, re-armed by (2)
//
// These tests bind to the BUILT preload bundle (a mirror of the logic would
// have stayed green through a full revert — the repo's A5-R1 lesson) and to the
// shipped hider helpers. The CSS cascade itself is verified separately in the
// real-browser harness, because jsdom has no cascade.
// ============================================================

const PRELOAD_BUNDLE = readFileSync(
  resolve(process.cwd(), "dist", "content", "preload.js"),
  "utf8"
);
const INDEX_BUNDLE = readFileSync(
  resolve(process.cwd(), "dist", "content", "index.js"),
  "utf8"
);
const BLOCKED = "blocked.com";
const GOOGLE = "https://www.google.com/search?q=t";
// Literal expectations, so a mutation check against the unfixed bundle fails
// because the RULE is wrong, not because a newly-added constant is missing.
const EXPECTED_ATTR = "data-shh-mode";
const EXPECTED_SELECTOR = `[${EXPECTED_ATTR}="shown-once"]`;
const EXPECTED_EXEMPTION =
  `:not(${EXPECTED_SELECTOR}):not(${EXPECTED_SELECTOR} *)`;

// Read the raw attribute, NOT isShownOnce() from hider.ts. A test that failed
// pre-fix only because the helper did not exist yet would pass the mutation
// check for the wrong reason. The behavioral assertions must discriminate.
const modeIsShown = (el: Element): boolean =>
  el.getAttribute("data-shh-mode") === "shown-once";

const flush = (ms = 120) => new Promise((r) => setTimeout(r, ms));

interface Booted {
  d: Document;
  w: any;
  capturedRules: string[];
  listeners: ((msg: unknown) => void)[];
}

/** Boot the real preload bundle and capture every rule it pushes into a sheet. */
function bootPreload(extraHtml = ""): Booted {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><div id="rso">${extraHtml}</div></body></html>`,
    { url: GOOGLE, runScripts: "outside-only", pretendToBeVisual: true }
  );
  const w = dom.window as any;
  w.localStorage.setItem(
    "_shh_cache",
    JSON.stringify({ domains: [BLOCKED], wildcard: true, paused: false })
  );
  const capturedRules: string[] = [];
  w.CSSStyleSheet.prototype.replaceSync = function (text: string) {
    capturedRules.push(text);
  };
  w.CSSStyleSheet.prototype.insertRule = function (rule: string) {
    capturedRules.push(rule);
    return 0;
  };
  if (!("adoptedStyleSheets" in dom.window.document)) {
    const sheets: unknown[] = [];
    Object.defineProperty(dom.window.document, "adoptedStyleSheets", {
      get: () => sheets.slice(),
      set: (v: unknown[]) => { sheets.length = 0; sheets.push(...v); },
      configurable: true,
    });
  }
  const listeners: ((msg: unknown) => void)[] = [];
  w.browser = {
    runtime: {
      getManifest: () => ({ version: "test" }),
      id: "t",
      onMessage: { addListener: (fn: (msg: unknown) => void) => listeners.push(fn) },
      sendMessage: async () => ({}),
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };
  w.chrome = w.browser;
  w.eval(PRELOAD_BUNDLE);
  return { d: dom.window.document, w, capturedRules, listeners };
}

/** One result whose preload hide landed on an INNER div.g, not the stamped node. */
const NESTED = `
  <div class="MjjYud"><div class="tF2Cxc" data-case="outer">
    <div class="N54PNb"><div class="g" data-case="inner">
      <a href="https://${BLOCKED}/p"><h3>Blocked</h3></a>
      <cite>${BLOCKED}</cite><div class="VwiC3b">snippet</div>
    </div></div>
  </div></div>`;

describe("the generated :has() rule must not hide a shown-once result", () => {
  it("puts the shared exemption on the rule SUBJECT, before :has()", () => {
    const { capturedRules } = bootPreload();
    const hasRule = capturedRules.find((r) => r.includes(":has("));
    expect(hasRule).toBeDefined();
    // The exemption is on the subject, not on each href selector: appending it
    // 450 times would blow the selector-length limit and drop the whole batch.
    expect(hasRule!.indexOf(EXPECTED_EXEMPTION)).toBeLessThan(hasRule!.indexOf(":has("));
    expect(hasRule!.split(EXPECTED_EXEMPTION).length - 1).toBe(1);
    expect(hasRule).toContain(`a[href*="://${BLOCKED}/"]`);
    // ...and the shared constant the source builds it from has not drifted.
    expect(SHOWN_ONCE_EXEMPTION).toBe(EXPECTED_EXEMPTION);
    expect(SHOWN_ONCE_SELECTOR).toBe(EXPECTED_SELECTOR);
  });

  it("leaves the static marker-based hide rule alone (Design B, not Design A)", () => {
    // Keeping showOnce's marker removal means preload.css's rule still stops
    // matching on its own. Only the marker-free :has() rule needs an exemption.
    const css = readFileSync(resolve(process.cwd(), "src", "content", "preload.css"), "utf8");
    expect(css).toContain('[data-shh-preloaded="true"]');
    expect(css).not.toContain("data-shh-mode");
  });
});

describe("the preload observer must not re-hide a result the user revealed", () => {
  it("ignores a data-shh-preloaded REMOVAL inside a shown-once subtree", async () => {
    const { d } = bootPreload(NESTED);
    const outer = d.querySelector('[data-case="outer"]')!;
    const inner = d.querySelector('[data-case="inner"]')! as HTMLElement;
    await flush();

    // showOnce() order: strip the marker on self + descendants, stamp ok, then
    // (last) set the shown-once marker the observer checks in its microtask.
    inner.removeAttribute("data-shh-preloaded");
    inner.style.removeProperty("display");
    inner.setAttribute("data-shh-ok", "true");
    outer.setAttribute("data-shh-mode", "shown-once");
    outer.classList.add("shh-shown-result");
    await flush();

    expect(inner.hasAttribute("data-shh-preloaded")).toBe(false);
    expect(inner.style.getPropertyValue("display")).toBe("");
    expect(modeIsShown(outer)).toBe(true);
  });

  it("NEGATIVE CONTROL: still self-heals when the page strips a real marker", async () => {
    // Narrowness matters. A blanket "ignore all marker removals" fix would also
    // disable the self-heal that keeps blocking alive across Google's DOM
    // reconciliation. Same DOM, only the shown-once marker is absent.
    const { d } = bootPreload(NESTED);
    const inner = d.querySelector('[data-case="inner"]')! as HTMLElement;
    await flush();
    expect(inner.getAttribute("data-shh-preloaded")).toBe("true");

    inner.removeAttribute("data-shh-preloaded");
    inner.style.removeProperty("display");
    await flush();

    expect(inner.getAttribute("data-shh-preloaded")).toBe("true");
    expect(inner.style.getPropertyValue("display")).toBe("none");
  });

  it("re-stamps data-shh-mode if the page strips it while the visual state remains", async () => {
    const { d } = bootPreload(NESTED);
    const outer = d.querySelector('[data-case="outer"]')!;
    outer.setAttribute("data-shh-mode", "shown-once");
    outer.classList.add("shh-shown-result");
    await flush();

    outer.removeAttribute("data-shh-mode");
    await flush();
    expect(modeIsShown(outer)).toBe(true);
  });

  it("does NOT resurrect shown-once after Hide Again dropped the state class", async () => {
    const { d } = bootPreload(NESTED);
    const outer = d.querySelector('[data-case="outer"]')!;
    outer.setAttribute("data-shh-mode", "shown-once");
    outer.classList.add("shh-shown-result");
    await flush();

    outer.classList.remove("shh-shown-result");
    outer.removeAttribute("data-shh-mode");
    await flush();
    expect(modeIsShown(outer)).toBe(false);
  });
});

describe("shown-once state helpers", () => {
  it("the shown-once marker matches the shared CSS selector", () => {
    const el = document.createElement("div");
    expect(modeIsShown(el)).toBe(false);
    el.setAttribute("data-shh-mode", "shown-once");
    expect(modeIsShown(el)).toBe(true);
    expect(el.matches(EXPECTED_SELECTOR)).toBe(true);
  });

  it("rehideResult and restoreResult both clear the exemption", () => {
    for (const clear of [
      (el: Element) => rehideResult(el as Element, { matched: true, domain: BLOCKED, mode: "block" },
        `https://${BLOCKED}/p`, false, () => {}, () => {}, () => {}),
      (el: Element) => restoreResult(el),
    ]) {
      const el = document.createElement("div");
      el.setAttribute("data-shh-result", "block");
      document.body.appendChild(el);
      showOnce(el, BLOCKED, () => {}, () => {});
      expect(modeIsShown(el)).toBe(true);
      clear(el);
      expect(modeIsShown(el)).toBe(false);
      el.remove();
    }
  });
});

describe("revealPreloadHiding must not sweep past a blocked descendant", () => {
  it("reveals a marked self WITHOUT clearing a still-blocked marked descendant", () => {
    // The self branch used to call clearPreloadHiding(node), which sweeps the
    // whole subtree unconditionally — bypassing isStillBlocked entirely and
    // revealing a genuinely blocked nested result.
    const doc = new JSDOM(
      `<!DOCTYPE html><html><body><div id="outer" data-shh-preloaded="true" style="display:none!important">
         <div id="inner" data-shh-preloaded="true" style="display:none!important"></div>
       </div></body></html>`,
      { url: GOOGLE }
    ).window.document;
    const outer = doc.getElementById("outer")! as HTMLElement;
    const inner = doc.getElementById("inner")! as HTMLElement;

    revealPreloadHiding(outer, (el) => el === inner);

    expect(outer.hasAttribute("data-shh-preloaded")).toBe(false);
    expect(outer.style.getPropertyValue("display")).toBe("");
    expect(inner.hasAttribute("data-shh-preloaded")).toBe(true);
    expect(inner.style.getPropertyValue("display")).toBe("none");
  });

  it("still reveals a descendant the predicate says is safe", () => {
    const doc = new JSDOM(
      `<!DOCTYPE html><html><body><div id="outer">
         <div id="inner" data-shh-preloaded="true" style="display:none!important"></div>
       </div></body></html>`,
      { url: GOOGLE }
    ).window.document;
    const inner = doc.getElementById("inner")! as HTMLElement;
    revealPreloadHiding(doc.getElementById("outer")!, () => false);
    expect(inner.hasAttribute("data-shh-preloaded")).toBe(false);
    expect(inner.style.getPropertyValue("display")).toBe("");
  });
});

// ============================================================
// A list / prefs change must not silently re-hide a shown result.
// Drives the BUILT index bundle: the defect is in reconcilePageInPlace's
// toRestamp loop, which no unit test of reconcileAgainstBlockList can reach.
// ============================================================
const ENTRIES = [{ domain: BLOCKED, mode: "block", enabled: true, createdAt: 0 }];
const PREFS = {
  debugMode: false, subdomainWildcard: true, pausedGlobally: false,
  pausedEngines: [], engineToggles: { google: true },
  showNotices: true, showOnHover: false, infiniteScroll: false,
};

describe("a reconcile pass preserves a result the user clicked Show on", () => {
  it("keeps it shown after PREFS_UPDATED (and still re-hides a normal hidden result)", async () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><div id="rso">
        <div class="MjjYud"><div class="tF2Cxc">
          <div class="kb0PBd"><a href="https://${BLOCKED}/p"><h3>Blocked</h3></a>
          <cite>${BLOCKED}</cite></div>
        </div></div>
      </div></body></html>`,
      { url: GOOGLE, runScripts: "outside-only", pretendToBeVisual: true }
    );
    const w = dom.window as any;
    w.localStorage.clear();
    w.CSSStyleSheet.prototype.replaceSync = function () {};
    w.CSSStyleSheet.prototype.insertRule = function () { return 0; };
    if (!("adoptedStyleSheets" in dom.window.document)) {
      const sheets: unknown[] = [];
      Object.defineProperty(dom.window.document, "adoptedStyleSheets", {
        get: () => sheets.slice(),
        set: (v: unknown[]) => { sheets.length = 0; sheets.push(...v); },
        configurable: true,
      });
    }
    const listeners: ((msg: unknown) => void)[] = [];
    w.__shhUpdateHas = () => {};
    w.browser = {
      runtime: {
        getManifest: () => ({ version: "test" }), id: "t",
        onMessage: { addListener: (fn: (msg: unknown) => void) => listeners.push(fn) },
        sendMessage: async (m: any) =>
          m.type === "GET_LIST" ? { entries: ENTRIES } : { prefs: PREFS },
      },
      storage: {
        local: { get: async () => ({ shh_entries: ENTRIES }), set: async () => {} },
        sync: { get: async () => ({ shh_prefs: PREFS }), set: async () => {} },
      },
    };
    w.chrome = w.browser;
    w.eval(INDEX_BUNDLE);
    await flush(500);

    const stamped = dom.window.document.querySelector("[data-shh-result]") as HTMLElement;
    expect(stamped).not.toBeNull();

    // Replay the Show button's click handler from buildPlaceholder().
    const placeholder = stamped.previousElementSibling;
    if (placeholder?.getAttribute("data-shh-placeholder")) placeholder.remove();
    showOnce(stamped, BLOCKED, () => {}, () => {});
    expect(modeIsShown(stamped)).toBe(true);
    expect(stamped.style.getPropertyValue("display")).toBe("block");

    for (const fn of listeners) fn({ type: "PREFS_UPDATED" });
    await flush(400);

    expect(modeIsShown(stamped)).toBe(true);
    expect(stamped.style.getPropertyValue("display")).toBe("block");
    expect(stamped.classList.contains("shh-shown-result")).toBe(true);
    // No second placeholder box may appear beside a result already shown.
    expect(dom.window.document.querySelectorAll(".shh-placeholder").length).toBe(0);
  }, 25000);
});
