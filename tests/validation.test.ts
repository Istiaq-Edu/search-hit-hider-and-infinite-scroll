import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { isValidDomain, normalizeDomain } from "../src/shared/domain-utils";
import { addEntry, deduplicateEntries } from "../src/shared/list-utils";
import { parsePlainList, parseUserscriptFormat, parseJSONBackup } from "../src/shared/migration";
import { DomainMatcher } from "../src/content/blocking/matcher";

// ============================================================
// Robustness sweep tests: junk-domain rejection (CSS-injection guard),
// trailing-dot normalization, case-insensitive dedup, and IDN punycode
// matching in the matcher.
// ============================================================

describe("isValidDomain", () => {
  it("accepts normal domains", () => {
    for (const d of ["example.com", "sub.example.co.uk", "a-b.io", "xn--mnchen-3ya.de", "münchen.de", "localhost8.dev"]) {
      expect(isValidDomain(d)).toBe(true);
    }
  });

  it("rejects CSS-breaking and junk strings", () => {
    for (const d of ['evil.com"}', "hello world", "<script>alert(1)<", "!!!", ".", "com", "", "a;b.com", "a(b).com", "back\\slash.com"]) {
      expect(isValidDomain(d)).toBe(false);
    }
  });
});

describe("normalizeDomain trailing dot", () => {
  it("strips trailing root-zone dots", () => {
    expect(normalizeDomain("example.com.")).toBe("example.com");
    expect(normalizeDomain("example.com..")).toBe("example.com");
    expect(normalizeDomain("example.com")).toBe("example.com");
  });
});

describe("addEntry rejects junk", () => {
  it("does not store strings that cannot be hostnames", () => {
    const before: Parameters<typeof addEntry>[0] = [];
    const r = addEntry(before, 'evil.com"}', "block");
    expect(r.added).toBeNull();
    expect(r.entries).toHaveLength(0);

    const r2 = addEntry(before, "hello world", "pban");
    expect(r2.added).toBeNull();
  });

  it("still accepts valid domains", () => {
    const r = addEntry([], "good.com", "block");
    expect(r.added?.domain).toBe("good.com");
  });
});

describe("parsers reject junk entries", () => {
  it("parsePlainList skips junk lines but keeps valid ones", () => {
    const out = parsePlainList('evil.com"}\nhello world\n<svg onload=alert(1)>\ngood.com\n');
    expect(out.map((e) => e.domain)).toEqual(["good.com"]);
  });

  it("parseUserscriptFormat skips junk entries", () => {
    const out = parseUserscriptFormat('|evil.com"}:t|good.com:t|');
    expect(out.map((e) => e.domain)).toEqual(["good.com"]);
  });

  it("parseJSONBackup drops entries with junk domains", () => {
    const raw = JSON.stringify([
      { domain: 'evil.com"}', mode: "pban" },
      { domain: "good.com", mode: "block" },
    ]);
    const out = parseJSONBackup(raw);
    expect(out.map((e) => e.domain)).toEqual(["good.com"]);
  });
});

describe("deduplicateEntries is case/www insensitive", () => {
  it("collapses X.com / x.com / www.x.com into one", () => {
    const out = deduplicateEntries([
      { domain: "X.com", mode: "block", enabled: true, createdAt: 1 },
      { domain: "x.com", mode: "block", enabled: true, createdAt: 2 },
      { domain: "www.x.com", mode: "block", enabled: true, createdAt: 3 },
      { domain: "y.com", mode: "block", enabled: true, createdAt: 4 },
    ]);
    expect(out.map((e) => e.domain)).toEqual(["X.com", "y.com"]);
  });
});

describe("DomainMatcher punycode keys (IDN fix)", () => {
  it("unicode entry matches punycode hostname from a URL", () => {
    const matcher = new DomainMatcher(
      [{ domain: "münchen.de", mode: "block", enabled: true, createdAt: 1 }],
      false
    );
    // URL parsing always yields the ASCII form
    expect(matcher.match("https://xn--mnchen-3ya.example.de/").matched).toBe(false);
    expect(matcher.match("https://münchen.de/").matched).toBe(true);
    expect(matcher.match("https://xn--mnchen-3ya.de/").matched).toBe(true);
  });
});

// ============================================================
// Preload sanitizeDomains — bound to the BUILT BUNDLE.
//
// This block used to inline a copy of `sanitizeDomains` and assert against the
// copy. The copy was already stale: the shipped function guards the CONTAINER
// (`if (!Array.isArray(list)) return out;`) as well as the elements, and the
// copy had no container guard at all — a mirror cannot notice that, which is
// exactly the A5-R1 failure mode this repo documents. The mirror is deleted.
//
// `sanitizeDomains` is internal to the preload IIFE and is not exported, so it
// is driven through `window.__shhUpdateHas` — the hook the content script uses
// to push a new block list into the preload. That hook assigns
// `lc = sanitizeDomains(list)` and immediately rebuilds the :has() sheet from
// it, so the sanitised list is observable twice over: in the CSS text the
// shipped `buildHasRules` writes, and in whether the resulting selector still
// parses and matches real hrefs.
// ============================================================

const PRELOAD_BUNDLE = readFileSync(
  resolve(process.cwd(), "dist", "content", "preload.js"),
  "utf8"
);

interface PreloadWindow {
  document: Document & Record<string, any>;
  localStorage: Storage;
  CSSStyleSheet: any;
  eval: (code: string) => void;
  addEventListener: (type: string, handler: (ev: any) => void) => void;
  browser?: any;
  chrome?: any;
  __shhUpdateHas: (domains: unknown, wildcard: boolean) => void;
  __shhPreloadDiag: () => Record<string, any>;
  [key: string]: any;
}

/** Boot the shipped preload and record every CSS text its :has() layer writes. */
function bootPreload(): { w: PreloadWindow; css: string[] } {
  const css: string[] = [];
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><div id="rso"></div></body></html>`,
    { url: "https://www.google.com/search?q=t", runScripts: "outside-only", pretendToBeVisual: true }
  );
  const w = dom.window as unknown as PreloadWindow;
  w.localStorage.setItem(
    "_shh_cache",
    JSON.stringify({ domains: ["blocked.com"], wildcard: true, paused: false })
  );
  // Record instead of dropping: the recorded text IS the shipped output.
  (w.CSSStyleSheet.prototype as any).replaceSync = function (text: string) { css.push(text); };
  (w.CSSStyleSheet.prototype as any).insertRule = function (rule: string) { css.push(rule); return 0; };
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
  w.eval(PRELOAD_BUNDLE);
  return { w, css };
}

/** Push `list` through the shipped hook and return the :has() CSS it built. */
function hasCssFor(w: PreloadWindow, css: string[], list: unknown, wildcard = true): string {
  css.length = 0;
  w.__shhUpdateHas(list, wildcard);
  if (css.length === 0) throw new Error("shipped buildHasRules wrote no CSS for this list");
  return css.join("\n");
}

const HAS_RULE = /:has\(:is\(([^()]*)\)\)\{([^}]*)\}/;

/** The attribute-selector payload of the shipped rule, as a standalone selector. */
function hrefSelector(css: string): string {
  const m = HAS_RULE.exec(css);
  if (!m) throw new Error(`no :has() href rule in shipped CSS: ${css.slice(0, 300)}`);
  return `:is(${m[1]})`;
}

describe("preload sanitizeDomains", () => {
  it("converts unicode to punycode, lowercases, and strips www", () => {
    const { w, css } = bootPreload();
    const built = hasCssFor(w, css, ["www.Example.com", "münchen.de"], true);
    // The base pattern is built from `d` itself, so `://example.com/` can only
    // be present if the entry was lowercased AND had its `www.` stripped —
    // without the strip the base pattern would read `://www.example.com/` and
    // this would not match.
    expect(built).toContain('a[href*="://example.com/"]');
    expect(built).not.toContain("://www.www.");
    expect(built).toContain('a[href*="://xn--mnchen-3ya.de/"]');
    expect(built).not.toContain("m\u00fcnchen");
    // And the result is usable CSS, not just the right text.
    const a = w.document.createElement("a");
    a.setAttribute("href", "https://www.example.com/page");
    expect(a.matches(hrefSelector(built))).toBe(true);
  });

  it("drops CSS-breaking and unparseable entries instead of interpolating them", () => {
    const { w, css } = bootPreload();
    const built = hasCssFor(w, css, ['evil.com"}', "hello world", "a;b.com", "good.com"], true);
    expect(built).toContain('a[href*="://good.com/"]');
    for (const junk of ["evil", "hello", "a;b.com"]) {
      expect(built, `junk entry ${junk} was interpolated into the CSS`).not.toContain(junk);
    }
    // The real reason the drop exists: an interpolated `evil.com"}` leaves an
    // unterminated attribute selector, so the whole :is() batch stops matching
    // anything. Prove the emitted selector still parses and still matches.
    const a = w.document.createElement("a");
    a.setAttribute("href", "/url?q=https://good.com/x");
    expect(a.matches(hrefSelector(built))).toBe(true);
  });

  it("deduplicates after conversion", () => {
    const { w, css } = bootPreload();
    // Both spellings sanitise to the same host, so the shipped rule must name
    // it once. Without the `seen` set the host is emitted twice per alias.
    const built = hasCssFor(w, css, ["münchen.de", "xn--mnchen-3ya.de", "example.com"], true);
    expect(built.split('a[href*="://xn--mnchen-3ya.de/"]').length - 1).toBe(1);
    expect(built).toContain('a[href*="://example.com/"]');
  });

  it("treats a non-array list as empty instead of throwing or keeping the old list", () => {
    // Not in the deleted mirror at all, and the guard that made it stale. The
    // shipped container guard turns a bad payload into an empty list; the
    // observable consequence is that the :has() layer is torn down rather than
    // left hiding results the content script has just unblocked.
    const { w, css } = bootPreload();
    hasCssFor(w, css, ["reddit.com"], true);
    expect(w.__shhPreloadDiag().hasRulesBuilt).toBe(1);

    hasCssFor(w, css, null, true);
    expect(w.__shhPreloadDiag().hasRulesBuilt).toBe(0);
    const marks: { label: string }[] = w.__shhPreloadDiag().marks ?? [];
    expect(marks.some((m) => m.label === "hasRules:cleared")).toBe(true);
  });
});

