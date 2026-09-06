import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { GoogleAdapter } from "../../src/content/engines/google";
import {
  googleDisplayDomain,
  looksLikeGoogleAggregate,
} from "../../src/content/engines/google-dom";

// ============================================================
// Over-hiding guards under Google's opaque /goto?url= links
//
// Field report 2026-08-30 (v1.8.3 live): "the functionality shows up but it
// removed other search results."
//
// Two guards that existed to prevent exactly that were silently killed when
// Google switched title links to opaque tokens, because both derived their
// signal from hrefs — and on the current layout EVERY href resolves to
// google.com, so no guard ever sees a non-Google host.
// ============================================================

const SERP_URL = "https://www.google.com/search?q=test";
const GOTO = "/goto?url=CAESUQHrOzAVzBTZa";

function docOf(centerCol: string): Document {
  const html = `<!DOCTYPE html><html><body>
    <div id="main"><div id="cnt"><div id="rcnt">
      <div id="center_col">${centerCol}</div>
    </div></div></div>
  </body></html>`;
  return new JSDOM(html, { url: SERP_URL }).window.document;
}

/**
 * A block that cites SEVERAL different domains but carries a single heading —
 * an AI Overview, an answer box, a "what people are saying" panel.
 * The first cited domain is `firstHost`.
 */
function multiCiteBlock(firstHost: string, others: string[]): string {
  const cites = [firstHost, ...others]
    .map((h) => `<cite>${h}</cite>`)
    .join("");
  // Every href is an opaque token — the real destination is nowhere in it.
  const links = [firstHost, ...others]
    .map((_, i) => `<a href="${GOTO}${i}">link ${i}</a>`)
    .join("");
  return `<div class="PZPZlf">
      <h2>AI Overview</h2>
      <div class="hb8SAc">${cites}${links}</div>
    </div>`;
}

/** One genuine organic result, 2026 layout. */
function organicResult(host: string): string {
  return `<div class="kb0PBd">
      <div class="yuRUbf"><a href="${GOTO}x"><h3>${host}</h3></a></div>
      <div class="VwiC3b"><cite>${host}</cite></div>
    </div>`;
}

// ── Guard 1: the aggregate detector must survive opaque links ───────────

describe("looksLikeGoogleAggregate under opaque /goto?url= links", () => {
  it("still flags a block citing many different display domains", () => {
    const doc = docOf(
      `<div id="rso">${multiCiteBlock("first.com", ["a.com", "b.com", "c.com", "d.com"])}</div>`
    );
    const block = doc.querySelector(".PZPZlf");
    expect(block).not.toBeNull();

    // With opaque hrefs every link resolves to google.com, so an href-only
    // detector sees zero non-Google hosts. The display URLs are the only
    // surviving signal, and this block cites five different domains.
    expect(looksLikeGoogleAggregate(block!)).toBe(true);
  });

  it("does not flag a single organic result", () => {
    const doc = docOf(`<div id="rso">${organicResult("example.com")}</div>`);
    const node = doc.querySelector(".kb0PBd")!;
    expect(looksLikeGoogleAggregate(node)).toBe(false);
  });
});

// ── Guard 2: an ambiguous display URL must not be trusted ───────────────

describe("googleDisplayDomain ambiguity", () => {
  it("returns the domain for a normal single-cite result", () => {
    const doc = docOf(`<div id="rso">${organicResult("example.com")}</div>`);
    expect(googleDisplayDomain(doc.querySelector(".kb0PBd")!)).toBe("example.com");
  });

  it("returns the domain when several cites agree", () => {
    // Title cite plus a sitelink cite — same host, so still unambiguous.
    const doc = docOf(
      `<div id="rso"><div class="kb0PBd">
         <h3>t</h3><cite>example.com</cite><cite>example.com/docs</cite>
       </div></div>`
    );
    expect(googleDisplayDomain(doc.querySelector(".kb0PBd")!)).toBe("example.com");
  });

  it("returns null when the node cites several DIFFERENT domains", () => {
    // This is the over-hiding mechanism: a block citing many domains used to
    // be judged by its FIRST cite, so one blocked domain hid the whole block.
    const doc = docOf(
      `<div id="rso">${multiCiteBlock("blocked.com", ["a.com", "b.com", "c.com"])}</div>`
    );
    expect(googleDisplayDomain(doc.querySelector(".PZPZlf")!)).toBeNull();
  });

  it("returns null when there is no display URL at all", () => {
    const doc = docOf(`<div id="rso"><div class="kb0PBd"><h3>t</h3></div></div>`);
    expect(googleDisplayDomain(doc.querySelector(".kb0PBd")!)).toBeNull();
  });
});

// ── End to end: a multi-cite block must never be one result ─────────────

describe("GoogleAdapter — multi-cite blocks are not results", () => {
  function resultsFor(centerCol: string): Element[] {
    const doc = docOf(centerCol);
    const adapter = new GoogleAdapter();
    adapter.onInit(doc);
    return adapter.getResultNodes(doc);
  }

  it("never offers an AI-Overview-style block as a single result", () => {
    // Even though its FIRST cited domain is present and looks blockable.
    const nodes = resultsFor(
      `<div id="rso">${multiCiteBlock("blocked.com", ["a.com", "b.com", "c.com", "d.com"])}</div>`
    );
    expect(nodes).toHaveLength(0);
  });

  it("still finds genuine organic results alongside such a block", () => {
    const nodes = resultsFor(
      `<div id="rso">
         ${multiCiteBlock("blocked.com", ["a.com", "b.com", "c.com", "d.com"])}
         <div class="MjjYud"><div class="N54PNb">
           ${organicResult("keep-one.com")}
           ${organicResult("keep-two.com")}
         </div></div>
       </div>`
    );
    expect(nodes).toHaveLength(2);
    const hosts = nodes.map((n) => googleDisplayDomain(n));
    expect(hosts).toEqual(["keep-one.com", "keep-two.com"]);
  });

  it("resolves a genuine result's URL from its display URL", () => {
    const doc = docOf(`<div id="rso">${organicResult("example.com")}</div>`);
    const adapter = new GoogleAdapter();
    adapter.onInit(doc);
    const nodes = adapter.getResultNodes(doc);
    expect(nodes).toHaveLength(1);
    expect(adapter.getResultUrl(nodes[0]!)).toBe("https://example.com");
  });
});
