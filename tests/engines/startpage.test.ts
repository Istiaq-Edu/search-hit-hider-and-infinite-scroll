import { describe, it, expect, beforeEach } from "vitest";
import { StartpageAdapter } from "../../src/content/engines/startpage";

function parseHTML(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

// Markup generations. LAYOUT_2026 mirrors the live SERP verified on
// 2026-08-23: <section id="main">, w-gl > div.result, a.result-title,
// div.pagination-container > nav.pagination > form with hidden POST inputs.
const LAYOUT_2026 = `
  <section id="main">
    <div class="w-gl css-1og29rd">
      <span class="w-gl-attribution">Results</span>
      <div class="result css-z73qjy">
        <a class="result-title result-link css-1ubyvt6" href="https://example.com/1"><h3>Example One</h3></a>
      </div>
      <div class="result css-z73qjy">
        <a class="result-title result-link css-1ubyvt6" href="https://other.org/2"><h3>Other Two</h3></a>
      </div>
    </div>
    <div class="pagination-container css-1kfqg5z"><nav class="pagination" aria-label="more search results">
      <form action="/sp/search" method="post">
        <input type="hidden" name="sc" value="a8mbuE7dQtoken">
        <input type="hidden" name="t" value="device">
        <input type="hidden" name="segment" value="startpage.udog">
        <input type="hidden" name="lui" value="english">
        <input type="hidden" name="language" value="english">
        <input type="hidden" name="cat" value="web">
        <input type="hidden" name="query" value="test">
        <button type="submit">Next</button>
      </form>
    </nav></div>
  </section>
`;

// 05/2024 generation: same shape but <div id="main">.
const LAYOUT_2024 = `
  <div id="main">
    <div class="w-gl">
      <div class="result">
        <a class="result-title result-link" href="https://example.com/1"><h3>Example One</h3></a>
      </div>
    </div>
  </div>
`;

const LAYOUT_2019 = `
  <section class="mainline-results__web">
    <div class="w-gl">
      <div class="w-gl__result">
        <a class="w-gl__result-title" href="https://legacy.net/a">Legacy result</a>
      </div>
    </div>
  </section>
`;

const LAYOUT_2018 = `
  <div data-view="results">
    <ol class="list-flat">
      <li class="search-result search-item"><h3 class="search-item__title"><a href="https://old.example.org/x">Old result</a></h3></li>
    </ol>
  </div>
`;

describe("StartpageAdapter", () => {
  let adapter: StartpageAdapter;

  beforeEach(() => {
    adapter = new StartpageAdapter();
  });

  describe("matches", () => {
    it("matches startpage.com and www.startpage.com", () => {
      expect(adapter.matches(new URL("https://www.startpage.com/sp/search?query=x"))).toBe(true);
      expect(adapter.matches(new URL("https://startpage.com/sp/search?query=x"))).toBe(true);
    });

    it("does not match the anonymous-view proxy host or unrelated hosts", () => {
      expect(adapter.matches(new URL("https://us-browse.startpage.com/av/proxy?u=x"))).toBe(false);
      expect(adapter.matches(new URL("https://www.google.com/search?q=x"))).toBe(false);
    });
  });

  describe("getResultNodes", () => {
    it("finds results in the live 2026 <section id=main> layout", () => {
      const nodes = adapter.getResultNodes(parseHTML(LAYOUT_2026));
      expect(nodes).toHaveLength(2);
    });

    it("still finds results in the 2024 <div id=main> layout", () => {
      const nodes = adapter.getResultNodes(parseHTML(LAYOUT_2024));
      expect(nodes).toHaveLength(1);
    });

    it("finds 2019 w-gl__result results", () => {
      const nodes = adapter.getResultNodes(parseHTML(LAYOUT_2019));
      expect(nodes).toHaveLength(1);
    });

    it("finds 2018 list-flat results", () => {
      const nodes = adapter.getResultNodes(parseHTML(LAYOUT_2018));
      expect(nodes).toHaveLength(1);
    });

    it("skips nodes with only internal links", () => {
      const doc = parseHTML(`
        <div id="main"><div class="w-gl">
          <div class="result"><a class="result-title" href="/do/ads?x=1">Ad</a></div>
          <div class="result"><a class="result-title" href="https://good.com/">Good</a></div>
        </div></div>
      `);
      const nodes = adapter.getResultNodes(doc);
      expect(nodes).toHaveLength(1);
    });
  });

  describe("getResultUrl", () => {
    it("extracts the direct href", () => {
      const doc = parseHTML(LAYOUT_2024);
      const node = adapter.getResultNodes(doc)[0]!;
      expect(adapter.getResultUrl(node)).toBe("https://example.com/1");
    });

    it("unwraps ixquick-proxy highlight links (u= param)", () => {
      const doc = parseHTML(`
        <div class="w-gl__result">
          <a class="w-gl__result-title" href="https://ixquick-proxy.com/do/spg/highlight.pl?lui=english&u=https%3A%2F%2Fexample.com%2Fpage">proxied</a>
        </div>
      `);
      const node = doc.querySelector(".w-gl__result")!;
      expect(adapter.getResultUrl(node)).toBe("https://example.com/page");
    });

    it("unwraps us-browse av/proxy links", () => {
      const doc = parseHTML(`
        <div class="w-gl__result">
          <a class="w-gl__result-title" href="https://us-browse.startpage.com/av/proxy?u=https%3A%2F%2Fexample.net%2Fdoc">proxied</a>
        </div>
      `);
      const node = doc.querySelector(".w-gl__result")!;
      expect(adapter.getResultUrl(node)).toBe("https://example.net/doc");
    });

    it("returns null for internal-only links", () => {
      const doc = parseHTML(`<div class="result"><a class="result-title" href="/sp/search?query=x">internal</a></div>`);
      expect(adapter.getResultUrl(doc.querySelector(".result")!)).toBeNull();
    });
  });

  describe("getButtonTarget", () => {
    it("returns the title anchor (button inserts after it)", () => {
      const doc = parseHTML(LAYOUT_2024);
      const node = adapter.getResultNodes(doc)[0]!;
      const target = adapter.getButtonTarget(node)!;
      expect(target.tagName).toBe("A");
      expect(target.className).toContain("result-title");
    });
  });

  describe("getNextPageRequest (POST pagination)", () => {
    it("builds a POST body from the pager form's own hidden inputs", () => {
      const doc = parseHTML(LAYOUT_2026);
      const req = adapter.getNextPageRequest!(doc, 2);
      expect(req).not.toBeNull();
      expect(req!.url).toBe("https://www.startpage.com/sp/search");
      expect(req!.method).toBe("POST");
      expect(req!.body.page).toBe("2");
      expect(req!.body.sc).toBe("a8mbuE7dQtoken");
      expect(req!.body.t).toBe("device");
      expect(req!.body.segment).toBe("startpage.udog");
      expect(req!.body.cat).toBe("web");
      expect(req!.body.lui).toBe("english");
      expect(req!.body.language).toBe("english");
    });

    it("falls back to the hydration JSON when the form input is missing", () => {
      const doc = parseHTML(`
        <div id="main"><div class="w-gl">
          <div class="result"><a class="result-title" href="https://example.com/">r</a></div>
        </div></div>
        <script>window.__X = {"sc":"jsonToken456","query":"q"}</script>
      `);
      const req = adapter.getNextPageRequest!(doc, 3);
      expect(req!.body.sc).toBe("jsonToken456");
      expect(req!.body.page).toBe("3");
    });

    it("returns null without any sc token (cannot paginate)", () => {
      const doc = parseHTML('<div id="main"><div class="result"><a href="https://x.com/">r</a></div></div>');
      expect(adapter.getNextPageRequest!(doc, 2)).toBeNull();
    });
  });

  describe("getInsertionAnchor", () => {
    it("returns the pagination block using the live container", () => {
      const doc = parseHTML(LAYOUT_2026);
      const container = adapter.getResultsContainer(doc)!;
      expect(container.id).toBe("main");
      const anchor = adapter.getInsertionAnchor!(container);
      expect(anchor).not.toBeNull();
      expect(anchor!.className).toContain("pagination-container");
      expect(anchor!.parentElement).toBe(container);
    });

    it("never anchors on an element containing results (Bing lesson)", () => {
      const doc = parseHTML(`
        <body><div id="main">
          <div class="w-gl"><div class="result"><a href="https://x.com/">r</a></div></div>
          <div class="pagination"><form action="/sp/search"><button type="submit">Next</button></form></div>
        </div></body>
      `);
      // Broad-wrapper mistake: with <body> as container, the walk-up from
      // the pager reaches #main itself — anchoring there would insert pages
      // ABOVE the results. The guard must reject it.
      const anchor = adapter.getInsertionAnchor!(doc.body);
      expect(anchor).toBeNull();
    });

    it("returns null when no pager exists", () => {
      const doc = parseHTML(LAYOUT_2019);
      const container = adapter.getResultsContainer(doc)!;
      expect(adapter.getInsertionAnchor!(container)).toBeNull();
    });
  });

  describe("getPaginationSelectors", () => {
    it("keeps pagination visible (manual fallback)", () => {
      expect(adapter.getPaginationSelectors!()).toEqual([]);
    });
  });

  describe("infinite-scroll capability gate", () => {
    it("satisfies the manager-init predicate in index.ts", () => {
      // Mirrors: `engine.getNextPageUrl || engine.triggerNextPage || engine.getNextPageRequest`
      // (index.ts init + refreshPrefs). A POST-only engine that fails this
      // predicate would never start infinite scroll — regression guard for
      // the gate forgetting an optional adapter method (Brave-plan lesson).
      const engine = adapter as unknown as import("../../src/content/engines/base").EngineAdapter;
      const capable =
        !!engine.getNextPageUrl || !!engine.triggerNextPage || !!engine.getNextPageRequest;
      expect(capable).toBe(true);
    });
  });

  describe("React-safe form value reads", () => {
    it("uses the live .value property when the attribute is stale/absent", () => {
      const doc = parseHTML(`
        <div><input type="text" name="query"><input type="hidden" name="sc" value="attrSc"></div>
      `);
      // Simulate React-controlled input: property set, attribute missing.
      const input = doc.querySelector<HTMLInputElement>("input[name='query']")!;
      input.value = "react query";
      const req = adapter.getNextPageRequest!(doc, 2);
      expect(req).not.toBeNull();
      expect(req!.body.query).toBe("react query");
      expect(req!.body.sc).toBe("attrSc");
    });
  });
});
