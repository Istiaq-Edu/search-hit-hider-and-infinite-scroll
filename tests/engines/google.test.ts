import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { GoogleAdapter } from "../../src/content/engines/google";

// ============================================================
// Google adapter — structural result discovery
//
// Regression suite for the failure documented in
// docs/plans/2026-08-30-google-failure-diagnosis.md: pinning result discovery
// to Google's rotating class names (div.g / div.tF2Cxc) plus an #rso-only
// fallback made the whole engine return zero results on newer layouts.
//
// Every shape below that returned 0 under the old ladder now returns results.
// ============================================================

const SERP_URL = "https://www.google.com/search?q=test";

function serp(centerCol: string, url = SERP_URL): Document {
  const html = `<!DOCTYPE html><html><body>
    <div id="main"><div id="cnt"><div id="rcnt">
      <div id="center_col">${centerCol}</div>
      <div id="rhs"><div class="kp-wholepage"><h3>Knowledge panel</h3></div></div>
    </div></div></div>
    <div id="botstuff">
      <div id="navcnt"><a id="pnnext" href="/search?q=test&amp;start=10">Next</a></div>
    </div>
    <div id="foot"><a href="/search?q=test&amp;start=0">Footer link</a></div>
  </body></html>`;
  return new JSDOM(html, { url }).window.document;
}

/** One organic result. `wrapper` lets us build div.g / div.MjjYud variants. */
function result(host: string, wrapper = "div.MjjYud"): string {
  const cls = wrapper.startsWith("div.") ? wrapper.slice(4) : "";
  const tag = wrapper.split(".")[0] || "div";
  return `<${tag} class="${cls}">
      <div class="hlcw0c">
        <a href="https://${host}/page" data-ved="ved-${host}"><h3 class="LC20lb">${host}</h3></a>
        <cite>${host}</cite>
        <div class="VwiC3b">snippet</div>
      </div>
    </${tag}>`;
}

/** Redirect-wrapped href, as it appears in Google's raw (un-hydrated) HTML. */
function resultRedirect(host: string): string {
  return `<div class="MjjYud">
      <div class="hlcw0c">
        <a href="/url?q=https%3A%2F%2F${host}%2Fpage&amp;sa=U&amp;ved=ved-${host}"><h3>${host}</h3></a>
        <cite>${host}</cite>
      </div>
    </div>`;
}

function classesOf(nodes: Element[]): string[] {
  return nodes.map((n) => n.className || n.tagName.toLowerCase());
}

describe("GoogleAdapter.getResultNodes — layout shapes", () => {
  let adapter: GoogleAdapter;

  beforeEach(() => {
    adapter = new GoogleAdapter();
  });

  it("A. classic layout (#rso > div.MjjYud > div.g) still resolves", () => {
    const doc = serp(
      `<div id="res"><div id="rso">
         <div class="MjjYud"><div class="g">${result("a.com")}</div></div>
         <div class="MjjYud"><div class="g">${result("b.com")}</div></div>
       </div></div>`
    );
    adapter.onInit?.(doc);
    const nodes = adapter.getResultNodes(doc);
    expect(nodes).toHaveLength(2);
    // Hides the OUTER result block, not an inner column.
    expect(classesOf(nodes)).toEqual(["MjjYud", "MjjYud"]);
  });

  it("B. 2026 layout (#rso > div.MjjYud, no div.g) resolves at whole-result granularity", () => {
    const doc = serp(
      `<div id="res"><div id="rso">
         ${result("a.com")}${result("b.com")}${result("c.com")}
       </div></div>`
    );
    adapter.onInit?.(doc);
    const nodes = adapter.getResultNodes(doc);
    expect(nodes).toHaveLength(3);
    // Regression: the old ladder matched `#rso > div > div` and returned the
    // inner .hlcw0c column, leaving the rest of the result rendered.
    expect(classesOf(nodes).every((c) => c === "MjjYud")).toBe(true);
  });

  it("C. results outside #rso (2026 #center_col > div#search layout) resolve", () => {
    const doc = serp(
      `<div><div id="search"><div>
         ${result("a.com")}${result("b.com")}${result("c.com")}
       </div></div></div>`
    );
    adapter.onInit?.(doc);
    expect(adapter.getResultNodes(doc)).toHaveLength(3);
  });

  it("D. renamed results container still resolves via the stream candidate list", () => {
    const doc = serp(`<div id="rsoNew">${result("a.com")}${result("b.com")}</div>`);
    adapter.onInit?.(doc);
    expect(adapter.getResultNodes(doc)).toHaveLength(2);
  });

  it("E. custom-element result wrappers (g-card) resolve", () => {
    const doc = serp(
      `<div id="rso">
         <g-card>${result("a.com")}</g-card>
         <g-card>${result("b.com")}</g-card>
       </div>`
    );
    adapter.onInit?.(doc);
    expect(adapter.getResultNodes(doc)).toHaveLength(2);
  });

  it("F. a stale but present #rso shell does not shadow a working stream below it", () => {
    // #rso exists and is empty; the real results live under #search.
    const doc = serp(
      `<div><div id="search"><div>
         <div id="rso"></div>
         ${result("a.com")}${result("b.com")}${result("c.com")}
       </div></div></div>`
    );
    adapter.onInit?.(doc);
    expect(adapter.getResultNodes(doc)).toHaveLength(3);
  });

  it("G. legacy class anchors are still used when structure yields nothing", () => {
    // Results nested where no stream container is resolvable.
    const html = `<!DOCTYPE html><html><body>
      <div class="MjjYud"><div class="g"><a href="https://a.com/x"><h3>a</h3></a></div></div>
      <div class="MjjYud"><div class="g"><a href="https://b.com/x"><h3>b</h3></a></div></div>
    </body></html>`;
    const doc = new JSDOM(html, { url: SERP_URL }).window.document;
    adapter.onInit?.(doc);
    expect(adapter.getResultNodes(doc).length).toBeGreaterThan(0);
  });
});

describe("GoogleAdapter.getResultNodes — exclusions", () => {
  let adapter: GoogleAdapter;

  beforeEach(() => {
    adapter = new GoogleAdapter();
  });

  it("ignores ad containers", () => {
    const doc = serp(
      `<div id="res"><div id="rso">
         <div id="tads"><div class="uEierd"><a href="https://ad.com/x"><h3>Sponsored</h3></a></div></div>
         ${result("a.com")}
         <div class="commercial-unit-desktop-top"><a href="https://shop.com/p"><h3>Product</h3></a></div>
         <div id="bottomads"><a href="https://ad2.com/x"><h3>Sponsored 2</h3></a></div>
       </div></div>`
    );
    adapter.onInit?.(doc);
    const nodes = adapter.getResultNodes(doc);
    expect(nodes).toHaveLength(1);
    expect(adapter.getResultUrl(nodes[0]!)).toContain("a.com");
  });

  it("ignores pagination and page furniture", () => {
    const doc = serp(
      `<div id="center_col"><div id="res"><div id="rso">${result("a.com")}${result("b.com")}</div></div>
       <div id="botstuff"><div id="navcnt"><a href="/search?q=t&amp;start=10"><h3>Next page</h3></a></div></div></div>`
    );
    adapter.onInit?.(doc);
    const nodes = adapter.getResultNodes(doc);
    expect(nodes).toHaveLength(2);
    expect(classesOf(nodes)).toEqual(["MjjYud", "MjjYud"]);
  });

  it("ignores our own injected placeholders and the sentinel", () => {
    const doc = serp(
      `<div id="res"><div id="rso">
         <div class="shh-placeholder" data-shh-placeholder="true"><a href="https://a.com"><h3>a.com hidden</h3></a></div>
         ${result("a.com")}
         <div id="is-sentinel"><a href="https://b.com"><h3>loading</h3></a></div>
       </div></div>`
    );
    adapter.onInit?.(doc);
    const nodes = adapter.getResultNodes(doc);
    expect(nodes).toHaveLength(1);
    expect(classesOf(nodes)).toEqual(["MjjYud"]);
  });

  it("descends into a multi-result section instead of hiding the whole block", () => {
    const doc = serp(
      `<div id="res"><div id="rso">
         <div class="section-block">
           <h2>Discussions</h2>
           ${result("a.com")}${result("b.com")}${result("c.com")}
         </div>
       </div></div>`
    );
    adapter.onInit?.(doc);
    const nodes = adapter.getResultNodes(doc);
    // Each result is returned individually — never the 3-result wrapper.
    expect(nodes).toHaveLength(3);
    expect(classesOf(nodes).every((c) => c === "MjjYud")).toBe(true);
  });

  it("descends through an appended infinite-scroll page wrapper", () => {
    const doc = serp(
      `<div id="res"><div id="rso">
         ${result("a.com")}
         <div data-is-page="2">${result("b.com")}${result("c.com")}</div>
       </div></div>`
    );
    adapter.onInit?.(doc);
    expect(adapter.getResultNodes(doc)).toHaveLength(3);
  });

  it("never hides an AI Overview because ONE of its many cited domains is blocked", () => {
    // The AI Overview is a single block at the top of #rso that cites a dozen
    // sources and carries no per-result markup. Treat it as one result and the
    // whole answer vanishes as soon as any cited domain is on the block list —
    // content the user never asked to filter. It must be skipped instead.
    const citations = ["a.com", "b.com", "c.com", "d.com"]
      .map((h) => `<a href="https://${h}/x">${h}</a>`)
      .join("");
    const doc = serp(
      `<div id="res"><div id="rso">
         <div class="ai-overview">
           <h3>AI Overview</h3>
           <div>Some synthesized answer. ${citations}</div>
         </div>
         ${result("e.com")}${result("f.com")}
       </div></div>`
    );
    adapter.onInit?.(doc);
    const nodes = adapter.getResultNodes(doc);
    // The AI Overview is excluded; the two real results are still found.
    expect(nodes).toHaveLength(2);
    expect(classesOf(nodes)).toEqual(["MjjYud", "MjjYud"]);
  });

  it("still treats a result with many same-domain sitelinks as one result", () => {
    // Regression guard for the aggregate rule: it counts HOSTS, not links.
    // A single organic result routinely carries 4+ sitelinks, all one domain.
    const sitelinks = [1, 2, 3, 4, 5]
      .map((i) => `<a href="https://a.com/page${i}">sitelink ${i}</a>`)
      .join("");
    const doc = serp(
      `<div id="res"><div id="rso">
         <div class="MjjYud">
           <div class="hlcw0c">
             <a href="https://a.com/"><h3>a.com</h3></a>
             <cite>a.com</cite>
             <div class="sitelinks">${sitelinks}</div>
           </div>
         </div>
       </div></div>`
    );
    adapter.onInit?.(doc);
    expect(adapter.getResultNodes(doc)).toHaveLength(1);
  });

  it("returns [] without throwing on a non-results page (consent / /sorry/)", () => {
    const doc = new JSDOM(
      `<!DOCTYPE html><html><body><form action="/sorry/index"><div id="captcha"></div></form></body></html>`,
      { url: "https://www.google.com/sorry/index" }
    ).window.document;
    adapter.onInit?.(doc);
    expect(() => adapter.getResultNodes(doc)).not.toThrow();
    expect(adapter.getResultNodes(doc)).toHaveLength(0);
  });
});

describe("GoogleAdapter — fetched (un-hydrated) documents", () => {
  it("accepts /url?q= redirect hrefs that only exist before hydration", () => {
    const doc = serp(`<div id="res"><div id="rso">${resultRedirect("a.com")}${resultRedirect("b.com")}</div></div>`);
    const adapter = new GoogleAdapter();
    adapter.onInit?.(doc);
    const nodes = adapter.getResultNodes(doc);
    expect(nodes).toHaveLength(2);
    expect(adapter.getResultUrl(nodes[0]!)).toContain("a.com");
  });
});

describe("GoogleAdapter — URL extraction", () => {
  const adapter = new GoogleAdapter();

  it("prefers a direct external href over cite breadcrumbs", () => {
    const doc = serp(
      `<div id="rso"><div class="MjjYud"><div class="hlcw0c">
         <a href="https://a.com/deep/path"><h3>t</h3></a>
         <cite>a.com › category › page</cite>
       </div></div></div>`
    );
    const node = adapter.getResultNodes(doc)[0]!;
    expect(adapter.getResultUrl(node)).toBe("https://a.com/deep/path");
  });

  it("unwraps /url?q= redirect links", () => {
    const doc = serp(
      `<div id="rso"><div class="MjjYud"><div class="hlcw0c">
         <a href="/url?q=https%3A%2F%2Fb.com%2Fx&amp;sa=U"><h3>t</h3></a>
       </div></div></div>`
    );
    const node = adapter.getResultNodes(doc)[0]!;
    expect(adapter.getResultUrl(node)).toBe("https://b.com/x");
  });

  it("falls back to the cite domain, stripped of breadcrumbs", () => {
    const doc = serp(
      `<div id="rso"><div class="MjjYud"><div class="hlcw0c">
         <a href="/search?q=internal"><h3>t</h3></a>
         <cite>c.com › docs › intro</cite>
       </div></div></div>`
    );
    adapter.onInit?.(doc);
    // REVERSED 2026-08-30 by field evidence. This used to assert that a node
    // whose links stay on Google is NOT a result, on the reasoning that <cite>
    // is only a display URL and might not match the destination (AMP,
    // translated, cached results). Then Google switched title links to
    // /goto?url=<opaque blob> — the destination is not in the href at all, so
    // the display URL is the ONLY place the domain exists and refusing to trust
    // it made the extension completely inert. It is now a first-class source.
    const nodes = adapter.getResultNodes(doc);
    expect(nodes).toHaveLength(1);
    expect(adapter.getResultUrl(nodes[0]!)).toBe("https://c.com");
  });

  it("still ignores a node with no domain anywhere in it", () => {
    // The display-URL fallback must not turn arbitrary furniture into results:
    // a heading plus a Google-internal link and no cite is still nothing.
    const doc = serp(
      `<div id="rso"><div class="MjjYud"><div class="hlcw0c">
         <a href="/search?q=internal"><h3>t</h3></a>
       </div></div></div>`
    );
    adapter.onInit?.(doc);
    expect(adapter.getResultNodes(doc)).toHaveLength(0);
  });
});

describe("GoogleAdapter — pagination", () => {
  it("prefers #pnnext", () => {
    const doc = serp(`<div id="rso">${result("a.com")}</div>`);
    expect(new GoogleAdapter().getNextPageUrl(doc)).toContain("start=10");
  });

  it("does not mistake a footer start= link for the next page", () => {
    const doc = new JSDOM(
      `<!DOCTYPE html><html><body><div id="foot"><a href="/search?q=test&amp;start=0">1</a></div></body></html>`,
      { url: SERP_URL }
    ).window.document;
    expect(new GoogleAdapter().getNextPageUrl(doc)).toBeNull();
  });

  it("hides only the pager, not Google's whole footer", () => {
    expect(new GoogleAdapter().getPaginationSelectors()).not.toContain("#foot");
    expect(new GoogleAdapter().getPaginationSelectors()).toContain("#navcnt");
  });

  it("resolves a results container even when #rso is absent", () => {
    const doc = serp(`<div><div id="search"><div>${result("a.com")}</div></div></div>`);
    expect(new GoogleAdapter().getResultsContainer(doc)?.id).toBe("search");
  });
});

// ============================================================
// FIELD-CAPTURED 2026-08-30 layout (verbatim from a live Firefox console)
//
// Two things the synthetic shapes above never reproduced:
//
//  1. Title links are OPAQUE REDIRECTS: href="/goto?url=CAESUQHrOzAVzBTZa…"
//     There is no /url?q=, and the destination is not in the href at all —
//     it is a protobuf-wrapped blob that cannot be decoded client-side. Every
//     "is this link external?" check in the codebase tested for /url?q= and
//     therefore rejected all of them — hence processed=0 in the field log.
//
//  2. Nesting is DEEPER than MAX_DESCENT_DEPTH allowed:
//       #rso > div.MjjYud > div.A6K0A > div.tF2Cxc > div.N54PNb > div.kb0PBd
//     div.tF2Cxc is the "Web results" SECTION here (it holds the
//     <h2>Web results</h2> heading plus every result), not a per-result card.
//
//     With the old depth cap of 3 the walk stopped at div.tF2Cxc and, failing
//     to descend, offered div.N54PNb — the element wrapping ALL results — as a
//     single "result". Hiding it would have wiped the entire page.
// ============================================================
const GOTO_URL = "/goto?url=CAESUQHrOzAVzBTZa";

/** One result in the field-captured 2026 shape. */
function gotoResult(host: string, opaque: string): string {
  return `<div class="kb0PBd A9Y9g jGGQ5e">
      <div class="yuRUbf"><div class="b8lM7"><span class="V9tjod">
        <a jsname="UWckNb" class="zReHs" href="${opaque}"><h3>${host} title</h3></a>
      </span></div></div>
      <cite>${host} › docs › page</cite>
    </div>`;
}

/** The full field-captured container, with one result per host. */
function fieldSerp(hosts: string[]): Document {
  const results = hosts.map((h, i) => gotoResult(h, `${GOTO_URL}${i}X`)).join("");
  return serp(
    `<div id="rso"><div class="MjjYud"><div class="A6K0A" data-rpos="0">
       <div jscontroller="SC7lYd" class="wHYlTd Ww4FFb tF2Cxc asEBEc vt6azd" lang="en"
            data-hveid="CB8QAA" data-ved="2ahUKEwjfoIXe7seW">
         <h2 class="bNg8Rb">Web results</h2>
         <div class="N54PNb BToiNc" data-snc="KPQ1Cb">${results}</div>
       </div>
     </div></div></div>`
  );
}

describe("GoogleAdapter — field-captured 2026 layout (opaque /goto?url= links)", () => {
  let adapter: GoogleAdapter;

  beforeEach(() => {
    adapter = new GoogleAdapter();
  });

  it("finds every result despite hrefs carrying no readable destination", () => {
    const doc = fieldSerp(["a.com", "b.com", "c.com"]);
    adapter.onInit?.(doc);
    const nodes = adapter.getResultNodes(doc);
    expect(nodes).toHaveLength(3);
    // Per-result granularity — never the div.N54PNb list that wraps them all.
    expect(classesOf(nodes).every((c) => c.includes("kb0PBd"))).toBe(true);
  });

  it("resolves the domain from the display URL the user actually sees", () => {
    const doc = fieldSerp(["a.com", "b.com", "c.com"]);
    adapter.onInit?.(doc);
    const nodes = adapter.getResultNodes(doc);
    expect(adapter.getResultUrl(nodes[0]!)).toContain("a.com");
    expect(adapter.getResultUrl(nodes[1]!)).toContain("b.com");
    expect(adapter.getResultUrl(nodes[2]!)).toContain("c.com");
  });

  it("never offers the all-results wrapper as a single result", () => {
    const doc = fieldSerp(["a.com", "b.com", "c.com"]);
    adapter.onInit?.(doc);
    const nodes = adapter.getResultNodes(doc);
    // Regression: a shallow depth cap made div.N54PNb (every result) the match,
    // so blocking one domain would have hidden the whole page.
    for (const n of nodes) {
      expect(n.querySelectorAll("h3").length).toBe(1);
    }
  });
});

describe("GoogleAdapter — engine matching and verticals", () => {
  const matches = (href: string): boolean =>
    new GoogleAdapter().matches(new URL(href));

  it("matches Google search hosts", () => {
    expect(matches("https://www.google.com/search?q=x")).toBe(true);
    expect(matches("https://www.google.co.uk/search?q=x")).toBe(true);
    expect(matches("https://encrypted.google.com/search?q=x")).toBe(true);
    expect(matches("https://news.google.com/")).toBe(true);
  });

  it("does not match other search engines", () => {
    expect(matches("https://duckduckgo.com/?q=x")).toBe(false);
    expect(matches("https://www.bing.com/search?q=x")).toBe(false);
  });

  it("switches to image nodes for tbm=isch", () => {
    const doc = new JSDOM(
      `<!DOCTYPE html><html><body><div id="rso">
         <div class="isv-r"><a href="https://a.com/x">img</a></div>
         <div class="isv-r"><a href="https://b.com/x">img</a></div>
       </div></body></html>`,
      { url: "https://www.google.com/search?q=x&tbm=isch" }
    ).window.document;
    const adapter = new GoogleAdapter();
    adapter.onInit?.(doc);
    expect(adapter.getResultNodes(doc)).toHaveLength(2);
  });

  it("switches to news nodes for tbm=nws", () => {
    const doc = new JSDOM(
      `<!DOCTYPE html><html><body><div id="rso">
         <div data-hveid="1"><a href="https://a.com/x">news</a></div>
         <div data-hveid="2"><a href="https://b.com/x">news</a></div>
       </div></body></html>`,
      { url: "https://www.google.com/search?q=x&tbm=nws" }
    ).window.document;
    const adapter = new GoogleAdapter();
    adapter.onInit?.(doc);
    expect(adapter.getResultNodes(doc)).toHaveLength(2);
  });
});
