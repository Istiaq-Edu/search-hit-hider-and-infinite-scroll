import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

// ============================================================
// Tests for the Google search flicker fix.
//
// The root cause was that the preload's :has() CSS rules used
// ^= (starts-with) selectors which never matched Google's
// redirect-style href attributes:
//   href="/url?q=https://example.com/path&sa=U&ved=..."
//
// The fix switches to *= (contains) selectors using "://domain/"
// which appears as a substring in BOTH direct and redirect hrefs.
//
// These tests verify, AGAINST THE BUILT BUNDLE:
//   1. resolveHost  — correctly extracts the destination hostname
//      from both direct and Google /url?q= redirect hrefs.
//   2. hrefContains — the *=  matching logic that drives :has() CSS
//      rules, confirming it matches what ^= used to miss.
//   3. No false positives — lookalike domains are not incorrectly matched.
//
// WHY THE BUNDLE: `preload.ts` is a top-level IIFE that reads `document` and
// `localStorage` at module scope, so it cannot be imported. An earlier version
// of this file inlined copies of `resolveHost` / `hrefContainsDomain` and
// asserted against the copies — a mirror that kept passing while the shipped
// code drifted (it still had no `/goto?url=` branch, still took two strings,
// and still missed the Startpage proxy forms). Everything below drives the
// artifact in `dist/content/preload.js` instead. That mirror is deleted.
//
// WHAT CANNOT BE ASSERTED, AND WHY: jsdom has no `:has()` engine, so we cannot
// prove the emitted rule matches a node by asking `document.querySelector`.
// What we assert instead is what the preload actually DOES:
//   • the rules `buildHasRules` emits for a domain list, read back out of the
//     CSSStyleSheet the shipped code writes into;
//   • that those emitted selectors match real hrefs under jsdom's own CSS
//     engine (nwsapi handles `:is()` and `[attr*=]` — only `:has()` is absent,
//     and `:has()` is the one layer we take on trust);
//   • that a node whose link resolves to a blocked host is hidden and stamped.
// ============================================================

const BUNDLE = readFileSync(resolve(process.cwd(), "dist", "content", "preload.js"), "utf8");

/**
 * The surface these tests actually drive. Deliberately NOT the DOM lib's
 * `Window` — jsdom's DOMWindow is not assignable to it and claiming otherwise
 * produces a type error that says nothing about the code under test.
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
  __shhCoverAudit: () => {
    coverArmed: boolean; active: boolean; candidates: number;
    undeterminedCount: number; blankGaps: number;
    undetermined: Array<Record<string, unknown>>;
  };
  __shhPreloadDiag: () => Record<string, any>;
  [key: string]: any;
}

interface Booted {
  w: TestWindow;
  uncaught: string[];
  /** Every CSS text the shipped :has() layer wrote, in order. */
  css: string[];
}

function boot(cache: Record<string, unknown> = { domains: ["blocked.com"], wildcard: true, paused: false }): Booted {
  const css: string[] = [];
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><div id="rso"></div></body></html>`,
    {
      url: "https://www.google.com/search?q=t",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    }
  );
  const w = dom.window as unknown as TestWindow;
  w.localStorage.setItem("_shh_cache", JSON.stringify(cache));
  // jsdom's CSSStyleSheet parses `:has()` rules by throwing, which would push
  // the shipped code down its insertRule fallback. Record what the shipped
  // code asks for instead of dropping it — the recorded text IS the shipped
  // output under test.
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

  const uncaught: string[] = [];
  w.addEventListener("error", (e: Event) => uncaught.push((e as ErrorEvent).message));
  w.eval(BUNDLE);
  return { w, uncaught, css };
}

/**
 * Long enough for jsdom to deliver the MutationObserver's queued callbacks.
 * 250 ms is the value `preload-guards.test.ts` already settled on for the same
 * delivery; a shorter wait risks a green run that merely observed too early.
 */
const settle = () => new Promise((r) => setTimeout(r, 250));

/**
 * Drive the shipped `__shhUpdateHas` hook and return the `:has()` CSS text it
 * built for `domains`. This is the same entry point the content script uses
 * (`updateHasRules`), so it is the real thing rather than a copy of it.
 */
function hasCssFor(b: Booted, domains: unknown, wildcard = true): string {
  b.css.length = 0;
  b.w.__shhUpdateHas(domains, wildcard);
  if (b.css.length === 0) throw new Error("shipped buildHasRules wrote no CSS for this list");
  return b.css.join("\n");
}

/** `:has(:is(<payload>)){<decl>}` — one rule per 50-domain batch. */
const HAS_RULE = /:has\(:is\(([^()]*)\)\)\{([^}]*)\}/;

/**
 * The attribute-selector payload the shipped rule tests each result against,
 * as a standalone selector. `:has()` itself is the only part jsdom cannot
 * evaluate; everything inside it is ordinary CSS it evaluates fine.
 */
function hrefSelector(css: string): string {
  const m = HAS_RULE.exec(css);
  if (!m) throw new Error(`no :has() href rule in shipped CSS: ${css.slice(0, 300)}`);
  return `:is(${m[1]})`;
}

/** An anchor carrying the RAW attribute value a browser would present to CSS. */
function anchor(w: TestWindow, rawHref: string): HTMLAnchorElement {
  const a = w.document.createElement("a");
  a.setAttribute("href", rawHref);
  return a;
}

/**
 * Append one Google-shaped result card into `#rso` and let the shipped
 * MutationObserver judge it. The card has a single heading and a single link,
 * so it is neither a multi-result section nor an aggregate and reaches
 * `resolveHost` instead of being skipped.
 */
async function judge(b: Booted, linkHtml: string): Promise<HTMLElement> {
  const el = b.w.document.createElement("div");
  el.className = "kb0PBd";
  el.innerHTML = linkHtml;
  b.w.document.getElementById("rso")!.appendChild(el);
  await settle();
  return el as HTMLElement;
}

// ============================================================
// resolveHost — Google redirect URL unwrapping
// ============================================================
describe("resolveHost — Google redirect URL unwrapping", () => {
  // Each of these drives the SHIPPED resolveHost through the shipped
  // tryHide: a card whose only link unwraps to a blocked host is hidden and
  // stamped `data-shh-preloaded`, and is never given the safe stamp. Delete
  // resolveHost, or its /url?q= branch, and these go red.
  it("hides a result whose direct https link resolves to a blocked host", async () => {
    const b = boot();
    b.w.__shhUpdateHas(["reddit.com"], true);
    const el = await judge(b, '<a href="https://reddit.com/r/programming"><h3>R</h3></a>');
    expect(el.getAttribute("data-shh-preloaded")).toBe("true");
    expect(el.getAttribute("data-shh-ok")).toBeNull();
  });

  it("hides a result behind a Google /url?q= relative redirect", async () => {
    // The href value ^= 'https://reddit.com/' MISSED, which is the flicker.
    const b = boot();
    b.w.__shhUpdateHas(["reddit.com"], true);
    const el = await judge(
      b,
      '<a href="/url?q=https://reddit.com/r/programming&sa=U&ved=abc"><h3>R</h3></a>'
    );
    expect(el.getAttribute("data-shh-preloaded")).toBe("true");
    expect(el.getAttribute("data-shh-ok")).toBeNull();
    expect(el.style.getPropertyValue("display")).toBe("none");
    expect(b.uncaught).toEqual([]);
  });

  it("hides a result behind a /url?q= redirect to a www-prefixed destination", async () => {
    const b = boot();
    b.w.__shhUpdateHas(["bbc.co.uk"], true);
    const el = await judge(
      b,
      '<a href="/url?q=https://www.bbc.co.uk/news/article&sa=U"><h3>R</h3></a>'
    );
    expect(el.getAttribute("data-shh-preloaded")).toBe("true");
  });

  it("hides a result behind an absolute google.com/url redirect", async () => {
    const b = boot();
    b.w.__shhUpdateHas(["stackoverflow.com"], true);
    const el = await judge(
      b,
      '<a href="https://www.google.com/url?q=https://stackoverflow.com/q/123"><h3>R</h3></a>'
    );
    expect(el.getAttribute("data-shh-preloaded")).toBe("true");
  });

  it("falls back to the resolved href when there is no /url? pattern", async () => {
    const b = boot();
    b.w.__shhUpdateHas(["example.com"], true);
    const el = await judge(b, '<a href="https://example.com/some/path"><h3>R</h3></a>');
    expect(el.getAttribute("data-shh-preloaded")).toBe("true");
  });

  it("decodes a percent-encoded q parameter", async () => {
    const encoded = encodeURIComponent("https://news.ycombinator.com/item?id=99");
    const b = boot();
    b.w.__shhUpdateHas(["news.ycombinator.com"], true);
    const el = await judge(b, `<a href="/url?q=${encoded}&sa=U"><h3>R</h3></a>`);
    expect(el.getAttribute("data-shh-preloaded")).toBe("true");
  });

  // REPLACES the old `resolveHost("not-a-url","not-a-url") === ""`: the shipped
  // resolveHost takes an ANCHOR and unwraps `a.href`, which the browser always
  // resolves against the document URL, so "a completely invalid URL" is not a
  // reachable input. What is reachable, and what matters, is that a card whose
  // href yields no recoverable blocked host is left alone and marked safe.
  it("does not hide a result whose href yields no recoverable blocked host", async () => {
    const b = boot();
    b.w.__shhUpdateHas(["reddit.com"], true);
    const el = await judge(b, '<a href="not-a-url"><h3>R</h3></a>');
    expect(el.getAttribute("data-shh-preloaded")).toBeNull();
    expect(el.getAttribute("data-shh-ok")).toBe("true");
  });

  // Shipped-only behaviour the mirror never had: an opaque `/goto?url=` token
  // carries no destination, so resolveHost returns "" and the preload must fall
  // back to the display URL. Without that fallback, document_start blocking is
  // inert on Google's current layout.
  it("falls back to the display URL when the href is an opaque /goto?url= token", async () => {
    const b = boot();
    b.w.__shhUpdateHas(["reddit.com"], true);
    const el = await judge(
      b,
      '<a href="/goto?url=CAESUQHrOzAVzBTZaRRFm"><h3>R</h3></a><cite>www.reddit.com</cite>'
    );
    expect(el.getAttribute("data-shh-preloaded")).toBe("true");
  });

  it("leaves an opaque /goto?url= card visible when its display URL is not blocked", async () => {
    const b = boot();
    b.w.__shhUpdateHas(["reddit.com"], true);
    const el = await judge(
      b,
      '<a href="/goto?url=CAESUQHrOzAVzBTZaRRFm"><h3>R</h3></a><cite>https://safe.example.org</cite>'
    );
    expect(el.getAttribute("data-shh-preloaded")).toBeNull();
    expect(el.getAttribute("data-shh-ok")).toBe("true");
  });

  // WHY the early return exists: an opaque token says nothing about where the
  // link goes, so the host that CARRIES it must never be used to judge it.
  // Block the carrier and leave the destination unblocked — with the early
  // return the card is judged by its display URL and stays visible; without it
  // `a.href` resolves to www.google.com and the card is hidden for the wrong
  // reason.
  it("does not judge an opaque /goto?url= card by the host that carries it", async () => {
    const b = boot();
    b.w.__shhUpdateHas(["google.com"], true);
    const el = await judge(
      b,
      '<a href="/goto?url=CAESUQHrOzAVzBTZaRRFm"><h3>R</h3></a><cite>https://reddit.com/r/x</cite>'
    );
    expect(el.getAttribute("data-shh-preloaded")).toBeNull();
    expect(el.getAttribute("data-shh-ok")).toBe("true");
  });

  // Shipped-only behaviour the mirror never had: Startpage's anonymous-view
  // proxy carries the destination in a `u=` param rather than `q=`.
  it("unwraps a Startpage anonymous-view proxy href", async () => {
    const u = encodeURIComponent("https://reddit.com/r/programming");
    const b = boot();
    b.w.__shhUpdateHas(["reddit.com"], true);
    const el = await judge(
      b,
      `<a href="https://www.startpage.com/av/proxy?u=${u}"><h3>R</h3></a>`
    );
    expect(el.getAttribute("data-shh-preloaded")).toBe("true");
  });

  it("unwraps an ixquick-proxy highlight href", async () => {
    const u = encodeURIComponent("https://reddit.com/r/programming");
    const b = boot();
    b.w.__shhUpdateHas(["reddit.com"], true);
    const el = await judge(
      b,
      `<a href="https://ixquick-proxy.com/do/spg/highlight.pl?u=${u}"><h3>R</h3></a>`
    );
    expect(el.getAttribute("data-shh-preloaded")).toBe("true");
  });
});

// ============================================================
// hrefContainsDomain — *= CSS selector logic
// This is the core of the flicker fix: verify that the *=
// (contains) pattern matches both direct and redirect hrefs.
//
// Asserted against the selector the SHIPPED buildHasRules emits, evaluated by
// jsdom's own CSS engine. If the shipped code switched back to ^=, the emitted
// selector would be `a[href^=...]` and every redirect assertion below would
// fail, because the redirect href does not START with the scheme+host.
// ============================================================
describe("hrefContainsDomain — direct links (previously worked with ^=)", () => {
  const matches = (b: Booted, rawHref: string, domain: string, wildcard = true): boolean =>
    anchor(b.w, rawHref).matches(hrefSelector(hasCssFor(b, [domain], wildcard)));

  it("matches a plain https direct link", () => {
    const b = boot();
    expect(matches(b, "https://reddit.com/r/programming", "reddit.com")).toBe(true);
  });

  it("matches a plain http direct link", () => {
    const b = boot();
    expect(matches(b, "http://reddit.com/r/programming", "reddit.com")).toBe(true);
  });

  it("matches a www-prefixed direct link", () => {
    const b = boot();
    expect(matches(b, "https://www.reddit.com/r/programming", "reddit.com")).toBe(true);
  });

  it("matches a direct link with query string and fragment", () => {
    const b = boot();
    expect(matches(b, "https://example.com/page?foo=bar#section", "example.com")).toBe(true);
  });
});

describe("hrefContainsDomain — Google redirect links (the flicker bug)", () => {
  const matches = (b: Booted, rawHref: string, domain: string, wildcard = true): boolean =>
    anchor(b.w, rawHref).matches(hrefSelector(hasCssFor(b, [domain], wildcard)));

  it("matches a Google /url?q= redirect to a plain domain", () => {
    // This is the href value that ^= 'https://reddit.com/' MISSED.
    const b = boot();
    expect(matches(b, "/url?q=https://reddit.com/r/programming&sa=U&ved=abc", "reddit.com")).toBe(true);
  });

  it("matches a Google /url?q= redirect to a www-prefixed domain", () => {
    const b = boot();
    expect(matches(b, "/url?q=https://www.reddit.com/r/news&sa=U&ved=xyz", "reddit.com")).toBe(true);
  });

  it("matches a redirect with http destination", () => {
    const b = boot();
    expect(matches(b, "/url?q=http://example.com/old-page&sa=U", "example.com")).toBe(true);
  });

  it("matches an absolute google.com/url redirect", () => {
    const b = boot();
    expect(matches(b, "https://www.google.com/url?q=https://stackoverflow.com/q/123", "stackoverflow.com")).toBe(true);
  });

  it("emits the bare-domain ? and & variants for redirects with no trailing slash", () => {
    // Not in the original file, and the reason the `?` and `&` variants exist:
    // a redirect whose destination ends at the host has no slash to match.
    //
    // The `?` form is checked with jsdom's own CSS engine. The `&` form cannot
    // be: nwsapi here matches NO attribute value whose needle contains `&`
    // (`[title*="a&b"]` fails against title="a&b"), which is an engine
    // limitation, not shipped behaviour — so that variant is pinned on the
    // emitted CSS text instead of being silently dropped.
    const b = boot();
    const css = hasCssFor(b, ["reddit.com"], true);
    expect(css).toContain('a[href*="://reddit.com?"]');
    expect(css).toContain('a[href*="://reddit.com&"]');
    expect(
      anchor(b.w, "/url?q=https://reddit.com?auth=1&sa=U").matches(hrefSelector(css))
    ).toBe(true);
  });

  it("matches redirect with URL-encoded destination once the browser decodes it", () => {
    // Browsers present the decoded attribute value to CSS — that decoded form
    // is what the selector is matched against here.
    const b = boot();
    const decoded = "/url?q=https://news.ycombinator.com/item?id=99&sa=U";
    expect(matches(b, decoded, "news.ycombinator.com")).toBe(true);
  });
});

describe("hrefContainsDomain — wildcard subdomain matching", () => {
  const matches = (b: Booted, rawHref: string, domain: string, wildcard: boolean): boolean =>
    anchor(b.w, rawHref).matches(hrefSelector(hasCssFor(b, [domain], wildcard)));

  it("matches a subdomain direct link with wildcard=true", () => {
    const b = boot();
    expect(matches(b, "https://sub.example.com/page", "example.com", true)).toBe(true);
  });

  it("matches a subdomain inside a Google redirect with wildcard=true", () => {
    const b = boot();
    expect(matches(b, "/url?q=https://sub.example.com/page&sa=U", "example.com", true)).toBe(true);
  });

  it("does NOT match a subdomain without wildcard", () => {
    const b = boot();
    expect(matches(b, "https://sub.example.com/page", "example.com", false)).toBe(false);
  });

  it("does NOT match a Google redirect to a subdomain without wildcard", () => {
    const b = boot();
    expect(matches(b, "/url?q=https://sub.example.com/page&sa=U", "example.com", false)).toBe(false);
  });

  it("emits the .domain/ wildcard patterns only when wildcard is on", () => {
    // The selector-level assertions above would also pass if the wildcard
    // patterns were emitted unconditionally and merely unused, so pin the
    // emitted text too.
    const b = boot();
    const on = hasCssFor(b, ["example.com"], true);
    const off = hasCssFor(b, ["example.com"], false);
    expect(on).toContain('a[href*=".example.com/"]');
    expect(off).not.toContain('a[href*=".example.com/"]');
  });
});

describe("hrefContainsDomain — no false positives", () => {
  const matches = (b: Booted, rawHref: string, domain: string, wildcard = true): boolean =>
    anchor(b.w, rawHref).matches(hrefSelector(hasCssFor(b, [domain], wildcard)));

  it("does NOT match a different domain", () => {
    const b = boot();
    expect(matches(b, "https://notreddit.com/page", "reddit.com")).toBe(false);
  });

  it("does NOT match a domain that contains the blocked one as a suffix", () => {
    // e.g. blocking 'reddit.com' must not match 'myreddit.com'
    const b = boot();
    expect(matches(b, "https://myreddit.com/page", "reddit.com")).toBe(false);
  });

  it("does NOT match a Google redirect to a different domain", () => {
    const b = boot();
    expect(matches(b, "/url?q=https://notexample.com/page&sa=U", "example.com")).toBe(false);
  });

  it("does NOT match a hash-only href", () => {
    const b = boot();
    expect(matches(b, "#section", "example.com")).toBe(false);
  });

  it("does NOT match a javascript: URI", () => {
    const b = boot();
    expect(matches(b, "javascript:void(0)", "example.com")).toBe(false);
  });

  it("does NOT match a Google-internal navigation link as a blocked result", () => {
    // A link like /search?q=... does not contain ://example.com/
    const b = boot();
    expect(matches(b, "/search?q=example", "example.com")).toBe(false);
  });

  it("does NOT match blocked domain as a query param value in unrelated redirect", () => {
    // /url?q=https://safe.com/?ref=reddit.com — the blocked string appears
    // after a different domain's path; "://reddit.com/" must not match
    // because the slash after 'reddit.com' is not present in this URL.
    const b = boot();
    expect(matches(b, "/url?q=https://safe.com/?ref=reddit.com&sa=U", "reddit.com")).toBe(false);
  });
});

// ============================================================
// Regression: the shipped selector must stay *= (contains).
// The old ^= logic could not be tested once it was deleted; what CAN be
// pinned is the shipped selector's own shape, and that it still matches the
// redirect href ^= missed.
// ============================================================
describe("regression — the shipped :has() selector is *= (contains), not ^=", () => {
  it("emits *= attribute selectors and no ^= selector", () => {
    const b = boot();
    const css = hasCssFor(b, ["reddit.com"], true);
    expect(css).toContain('a[href*="://reddit.com/"]');
    expect(css).not.toContain("^=");
  });

  it("still FIXES the redirect link ^= missed", () => {
    const b = boot();
    const redirectHref = "/url?q=https://reddit.com/r/programming&sa=U&ved=abc";
    expect(
      anchor(b.w, redirectHref).matches(hrefSelector(hasCssFor(b, ["reddit.com"], true)))
    ).toBe(true);
  });

  it("covers every host in the list, one batch per 50 domains", () => {
    const b = boot();
    const css = hasCssFor(b, ["a.com", "b.com"], true);
    expect(css).toContain('a[href*="://a.com/"]');
    expect(css).toContain('a[href*="://b.com/"]');
    expect(b.w.__shhPreloadDiag().hasRulesBuilt).toBe(1);

    const many = Array.from({ length: 120 }, (_, i) => `d${i}.com`);
    const batched = hasCssFor(b, many, true);
    expect(b.w.__shhPreloadDiag().hasRulesBuilt).toBe(3);
    expect(batched).toContain('a[href*="://d0.com/"]');
    expect(batched).toContain('a[href*="://d119.com/"]');
  });
});

// ============================================================
// The cover must never be left UNDETERMINED (field report 2026-10-10)
//
// Reported symptom: "results are not visible on the screen but there is space
// for that result". `opacity:0` preserves layout, so a node the anti-flicker
// cover is holding renders as a correctly-sized blank gap — the exact shape of
// the report, and the exact shape a `display:none` bug could NOT produce.
//
// The cover (preload.css) matches EVERY `div.g` / `div.tF2Cxc` in the document
// and is lifted only by a positive marker. `tryHide()` has three deliberate
// FAIL-OPEN guards — container, section, aggregate — which decline to hide the
// node because hiding it would take several unrelated results with it. That is
// correct for HIDING and was wrong for the COVER: the node was left with no
// marker at all, which the cover renders as invisible.
//
// A node arriving after the last reveal pass (`revealRemainingGoogle`'s 2 s
// safety net, the post-`processResults` call, the bfcache handler, the
// infinite-scroll append net) therefore stayed invisible forever: the adapter
// refuses to offer it (`walkResults`' own section/aggregate guards), the
// content script's `processResults` never sees it, and the preload's observer
// had already declined to touch it.
//
// These tests drive the SHIPPED bundle: they append the card and let the real
// MutationObserver judge it. Delete the `revealCoverCandidate` call from any
// one of the three guards and the corresponding test goes red.
// ============================================================
describe("cover is never left undetermined — every fail-open guard reveals", () => {
  /** Append `html` into #rso and let the shipped observer process it. */
  async function judgeHtml(b: Booted, html: string): Promise<Element> {
    const tpl = b.w.document.createElement("template");
    tpl.innerHTML = html;
    const node = tpl.content.firstElementChild as Element;
    b.w.document.getElementById("rso")!.appendChild(node);
    await settle();
    return node;
  }

  it("SECTION guard: a multi-result card is revealed, not left at opacity:0", async () => {
    const b = boot();
    b.w.__shhUpdateHas(["blocked.com"], true);
    b.w.document.documentElement.setAttribute("data-shh-active", "true");

    // Two headings => looksLikeGoogleSection() => tryHide declines to hide it.
    const node = await judgeHtml(
      b,
      `<div class="tF2Cxc">
         <div class="kb0PBd"><a href="https://a.com/p"><h3>a</h3></a><cite>a.com</cite></div>
         <div class="kb0PBd"><a href="https://b.com/p"><h3>b</h3></a><cite>b.com</cite></div>
       </div>`
    );

    expect(node.getAttribute("data-shh-ok")).toBe("true");
    expect(node.getAttribute("data-shh-preloaded")).toBeNull();
  });

  it("CONTAINER guard: a wrapper holding results is revealed", async () => {
    const b = boot();
    b.w.__shhUpdateHas(["blocked.com"], true);
    b.w.document.documentElement.setAttribute("data-shh-active", "true");

    // The outer div.g CONTAINS class-matched result cards, so the container
    // guard fires before the section guard does.
    const wrap = await judgeHtml(
      b,
      `<div class="g">
         <div class="tF2Cxc"><a href="https://blocked.com/p"><h3>x</h3></a><cite>blocked.com</cite></div>
         <div class="tF2Cxc"><a href="https://safe.com/p"><h3>y</h3></a><cite>safe.com</cite></div>
       </div>`
    );

    // The wrapper is shown...
    expect(wrap.getAttribute("data-shh-ok")).toBe("true");
    // ...and the blocked result INSIDE it stays hidden. Marking a container
    // safe must never be a way to reveal a blocked result.
    const blocked = wrap.querySelector("[data-shh-preloaded]") as Element;
    expect(blocked).not.toBeNull();
    expect(blocked.hasAttribute("data-shh-ok")).toBe(false);
  });

  it("AGGREGATE guard: a many-cite block is revealed, not left at opacity:0", async () => {
    const b = boot();
    b.w.__shhUpdateHas(["blocked.com"], true);
    b.w.document.documentElement.setAttribute("data-shh-active", "true");

    // ONE heading (so it is not a section) but FOUR distinct cited hosts, which
    // is what looksLikeGoogleAggregate() keys on.
    const node = await judgeHtml(
      b,
      `<div class="tF2Cxc">
         <h3>AI overview</h3>
         <a href="https://a1.com/x">1</a><a href="https://a2.com/x">2</a>
         <a href="https://a3.com/x">3</a><a href="https://a4.com/x">4</a>
       </div>`
    );

    expect(node.getAttribute("data-shh-ok")).toBe("true");
    expect(node.getAttribute("data-shh-preloaded")).toBeNull();
  });

  it("does NOT reveal a node it positively decided to hide", async () => {
    const b = boot();
    b.w.__shhUpdateHas(["blocked.com"], true);
    b.w.document.documentElement.setAttribute("data-shh-active", "true");

    // A plain single result on a blocked host must still be hidden.
    const node = await judgeHtml(
      b,
      `<div class="tF2Cxc"><a href="https://blocked.com/p"><h3>x</h3></a><cite>blocked.com</cite></div>`
    );

    expect(node.getAttribute("data-shh-preloaded")).toBe("true");
    expect(node.hasAttribute("data-shh-ok")).toBe(false);
  });
});

// ============================================================
// The nodes tryHide cannot judge YET must not be forgotten
//
// The three guard fixes above cover the nodes tryHide POSITIVELY evaluated and
// declined. There is a fourth exit that is different in kind: a node with no
// usable external link. That is Google's two-step hydration — the card shell
// lands first, its anchor arrives a task later — so the node is not "safe" and
// not "blocked", it is NOT YET KNOWABLE.
//
// Stamping it safe on the spot would re-introduce exactly the flicker the cover
// exists to prevent: the empty shell would paint, then vanish when it is
// populated with a blocked link. Leaving it covered is correct — but only while
// something will re-examine it. `data-shh-ok` is absent, so the cover holds it
// at `opacity:0`: full height, nothing painted, the reported symptom, until the
// next mutation. A shell that arrives after the last discrete reveal window
// (2 s net / post-processResults / bfcache / append) and is NEVER populated —
// a card Google inserted and then failed to hydrate, which the 2026-10-10 field
// run's ~100 page-origin TypeErrors make plausible — stayed invisible forever.
//
// Both halves of the contract are asserted here, because a fix that only
// satisfies one of them is worse than the bug:
//   immediate  -> still covered   (anti-flicker preserved)
//   after 1200ms -> revealed      (no permanent blank gap)
// ============================================================
describe("a node that cannot be judged yet is swept, not forgotten", () => {
  it("leaves a linkless shell covered at first, then sweeps it once the DOM goes quiet", async () => {
    const b = boot();
    b.w.__shhUpdateHas(["blocked.com"], true);
    b.w.document.documentElement.setAttribute("data-shh-active", "true");

    // A shell with no anchor and no heading: the only tryHide exit it can take
    // is the no-external-link return.
    const tpl = b.w.document.createElement("template");
    tpl.innerHTML = `<div class="tF2Cxc"><div class="kb0PBd">Loading…</div></div>`;
    const node = tpl.content.firstElementChild as Element;
    b.w.document.getElementById("rso")!.appendChild(node);
    await settle();

    // Half one: NOT stamped safe. Stamping here is the flicker regression.
    expect(node.hasAttribute("data-shh-ok")).toBe(false);
    expect(node.hasAttribute("data-shh-preloaded")).toBe(false);

    // Half two: the trailing sweep must eventually determine it.
    await new Promise((r) => setTimeout(r, 1400));
    expect(node.getAttribute("data-shh-ok")).toBe("true");
  }, 20_000);

  it("still hides a linkless shell's blocked link once it finally arrives", async () => {
    // The safety property for the trailing sweep: stamping a node safe must not
    // make a blocked result that arrives LATER permanently visible. The
    // observer's Case C/D clears `data-shh-ok` when a link is inserted and
    // re-runs tryHide, so the sweep self-heals.
    const b = boot();
    b.w.__shhUpdateHas(["blocked.com"], true);
    b.w.document.documentElement.setAttribute("data-shh-active", "true");

    const tpl = b.w.document.createElement("template");
    tpl.innerHTML = `<div class="tF2Cxc"><div class="kb0PBd">Loading…</div></div>`;
    const node = tpl.content.firstElementChild as Element;
    b.w.document.getElementById("rso")!.appendChild(node);
    await settle();
    await new Promise((r) => setTimeout(r, 1400));
    expect(node.getAttribute("data-shh-ok")).toBe("true");

    // Now hydrate it with a BLOCKED destination, as Google would.
    const inner = node.querySelector(".kb0PBd")!;
    const a = b.w.document.createElement("a");
    a.setAttribute("href", "https://blocked.com/p");
    const h3 = b.w.document.createElement("h3");
    h3.textContent = "blocked";
    a.appendChild(h3);
    inner.appendChild(a);
    await settle();

    expect(node.getAttribute("data-shh-preloaded")).toBe("true");
  }, 20_000);
});

// ============================================================
// __shhCoverAudit — the invariant, measured on demand
//
// A field paste cannot currently answer "is anything stuck under the cover?":
// the console logs a healthy boot and healthy appends, and NOTHING in it reports
// per-node visibility. The one existing signal — `favicon paint outcome …
// visible=false` — is ambiguous, because it is also false for a BLOCKED result
// (display:none, correct) and it samples only the first appended node.
//
// So the invariant gets an oracle. These tests bind to the shipped hook through
// the shipped bundle: delete the reveal at the section guard and the first test
// goes red, because `undeterminedCount` becomes 1.
// ============================================================
describe("__shhCoverAudit — nothing may be left undetermined", () => {
  async function append(b: Booted, html: string): Promise<Element> {
    const tpl = b.w.document.createElement("template");
    tpl.innerHTML = html;
    const node = tpl.content.firstElementChild as Element;
    b.w.document.getElementById("rso")!.appendChild(node);
    await settle();
    return node;
  }

  it("reports ZERO undetermined nodes after a section has been revealed", async () => {
    const b = boot();
    b.w.__shhUpdateHas(["blocked.com"], true);
    b.w.document.documentElement.setAttribute("data-shh-active", "true");

    await append(
      b,
      `<div class="tF2Cxc">
         <div class="kb0PBd"><a href="https://a.com/p"><h3>a</h3></a><cite>a.com</cite></div>
         <div class="kb0PBd"><a href="https://b.com/p"><h3>b</h3></a><cite>b.com</cite></div>
       </div>`
    );

    const audit = b.w.__shhCoverAudit();
    expect(audit.active).toBe(true);
    expect(audit.undeterminedCount).toBe(0);
    expect(audit.blankGaps).toBe(0);
  });

  it("NAMES the node when one is still undetermined — the bug made readable", async () => {
    const b = boot();
    b.w.__shhUpdateHas(["blocked.com"], true);
    b.w.document.documentElement.setAttribute("data-shh-active", "true");

    // A linkless shell: correctly left undetermined until the trailing sweep.
    await append(b, `<div class="tF2Cxc"><div class="kb0PBd">Loading</div></div>`);

    const audit = b.w.__shhCoverAudit();
    expect(audit.undeterminedCount).toBe(1);
    expect(String(audit.undetermined[0]?.cls)).toContain("tF2Cxc");
    // jsdom has no layout, so nothing can be proven to occupy space here — the
    // hook reports the marker state, and `blankGaps` needs a real engine.
    expect(audit.blankGaps).toBe(0);
  });

  it("counts only nodes the cover can actually match", async () => {
    const b = boot();
    b.w.__shhUpdateHas(["blocked.com"], true);
    b.w.document.documentElement.setAttribute("data-shh-active", "true");

    // div.MjjYud is not a cover candidate, so it must not appear at all.
    await append(b, `<div class="MjjYud"><h3>not a card</h3></div>`);

    const audit = b.w.__shhCoverAudit();
    expect(audit.candidates).toBe(0);
    expect(audit.undeterminedCount).toBe(0);
  });
});
