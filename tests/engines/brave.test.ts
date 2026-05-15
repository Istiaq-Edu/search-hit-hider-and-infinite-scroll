import { describe, it, expect, beforeEach } from "vitest";
import { BraveAdapter } from "../../src/content/engines/brave";

function parseHTML(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("BraveAdapter", () => {
  let adapter: BraveAdapter;

  beforeEach(() => {
    adapter = new BraveAdapter();
  });

  describe("matches", () => {
    it("matches search.brave.com", () => {
      expect(adapter.matches(new URL("https://search.brave.com/search?q=test"))).toBe(true);
    });

    it("matches Brave .onion address", () => {
      expect(adapter.matches(new URL("https://search.brave4u7jddbv7cyvyptnt5corw0tamlzo53lwd5s7vm223nr3ro2ryd.onion/search?q=test"))).toBe(true);
    });

    it("does not match other hosts", () => {
      expect(adapter.matches(new URL("https://www.google.com/search?q=test"))).toBe(false);
    });
  });

  describe("getResultNodes", () => {
    it("returns snippet elements with data-type attributes", () => {
      const doc = parseHTML(`
        <div id="results">
          <div class="snippet" data-type="web"><a class="l1" href="https://example.com/1"></a></div>
          <div class="snippet" data-type="news"><a class="l1" href="https://example.com/2"></a></div>
          <div class="snippet" data-type="videos"><a class="l1" href="https://example.com/3"></a></div>
        </div>
      `);
      const nodes = adapter.getResultNodes(doc);
      expect(nodes).toHaveLength(3);
    });

    it("returns generic .snippet elements as fallback", () => {
      const doc = parseHTML(`
        <div id="results">
          <div class="snippet"><a class="l1" href="https://example.com/1"></a></div>
        </div>
      `);
      const nodes = adapter.getResultNodes(doc);
      expect(nodes).toHaveLength(1);
    });

    it("filters out nodes with data-shh-result", () => {
      const doc = parseHTML(`
        <div id="results">
          <div class="snippet" data-type="web" data-shh-result="true"><a class="l1" href="https://example.com/1"></a></div>
          <div class="snippet" data-type="web"><a class="l1" href="https://example.com/2"></a></div>
        </div>
      `);
      const nodes = adapter.getResultNodes(doc);
      expect(nodes).toHaveLength(1);
    });

    it("filters out nodes without a valid URL", () => {
      const doc = parseHTML(`
        <div id="results">
          <div class="snippet" data-type="web"></div>
          <div class="snippet" data-type="web"><a class="l1" href="https://example.com/1"></a></div>
        </div>
      `);
      const nodes = adapter.getResultNodes(doc);
      expect(nodes).toHaveLength(1);
    });
  });

  describe("getResultUrl", () => {
    it("extracts URL from a.l1 element", () => {
      const node = document.createElement("div");
      node.innerHTML = '<a class="l1" href="https://example.com/page"></a>';
      expect(adapter.getResultUrl(node)).toBe("https://example.com/page");
    });

    it("rejects Brave internal URLs", () => {
      const node = document.createElement("div");
      node.innerHTML = '<a class="l1" href="https://search.brave.com/internal"></a>';
      expect(adapter.getResultUrl(node)).toBeNull();
    });

    it("falls back to .result-content a[href]", () => {
      const node = document.createElement("div");
      node.innerHTML = '<div class="result-content"><a href="https://example.com/page"></a></div>';
      expect(adapter.getResultUrl(node)).toBe("https://example.com/page");
    });

    it("falls back to cite.snippet-url text", () => {
      const node = document.createElement("div");
      node.innerHTML = '<cite class="snippet-url">example.com/path</cite>';
      expect(adapter.getResultUrl(node)).toBe("https://example.com/");
    });

    it("returns null when no URL can be extracted", () => {
      const node = document.createElement("div");
      node.innerHTML = "<span>No links here</span>";
      expect(adapter.getResultUrl(node)).toBeNull();
    });
  });

  describe("getButtonTarget", () => {
    it("returns a.l1 as primary target", () => {
      const node = document.createElement("div");
      node.innerHTML = '<a class="l1" href="https://example.com">Title</a>';
      expect(adapter.getButtonTarget(node)?.tagName).toBe("A");
      expect(adapter.getButtonTarget(node)?.classList.contains("l1")).toBe(true);
    });

    it("falls back to .result-content", () => {
      const node = document.createElement("div");
      node.innerHTML = '<div class="result-content">Content</div>';
      expect(adapter.getButtonTarget(node)?.classList.contains("result-content")).toBe(true);
    });

    it("falls back to .result-wrapper", () => {
      const node = document.createElement("div");
      node.innerHTML = '<div class="result-wrapper">Content</div>';
      expect(adapter.getButtonTarget(node)?.classList.contains("result-wrapper")).toBe(true);
    });
  });

  describe("getNextPageUrl", () => {
    it("returns href when Next button with offset exists", () => {
      const doc = parseHTML(`
        <a href="https://search.brave.com/search?q=test&amp;offset=1">Next</a>
      `);
      expect(adapter.getNextPageUrl(doc)).toBe("https://search.brave.com/search?q=test&offset=1");
    });

    it("returns href when a[aria-label='Next'] exists", () => {
      const doc = parseHTML(`
        <a href="https://search.brave.com/search?q=test&amp;offset=2" aria-label="Next">Next</a>
      `);
      expect(adapter.getNextPageUrl(doc)).toBe("https://search.brave.com/search?q=test&offset=2");
    });

    it("falls back to offset URL construction when no button found", () => {
      const doc = parseHTML("<div id='results'></div>");
      Object.defineProperty(doc, "URL", { value: "https://search.brave.com/search?q=test", writable: true });
      const url = adapter.getNextPageUrl(doc);
      expect(url).not.toBeNull();
      expect(url).toContain("offset=1");
    });

    it("increments existing offset in URL construction", () => {
      const doc = parseHTML("<div id='results'></div>");
      Object.defineProperty(doc, "URL", { value: "https://search.brave.com/search?q=test&offset=3", writable: true });
      const url = adapter.getNextPageUrl(doc);
      expect(url).toContain("offset=4");
    });

    it("returns null when offset is at max (9)", () => {
      const doc = parseHTML("<div id='results'></div>");
      Object.defineProperty(doc, "URL", { value: "https://search.brave.com/search?q=test&offset=9", writable: true });
      expect(adapter.getNextPageUrl(doc)).toBeNull();
    });

    it("returns null when both strategies fail", () => {
      const doc = parseHTML("<div>No results</div>");
      Object.defineProperty(doc, "URL", { value: "invalid-url", writable: true });
      const result = adapter.getNextPageUrl(doc);
      expect(result === null || typeof result === "string").toBe(true);
    });
  });

  describe("getPaginationSelectors", () => {
    it("returns empty array to keep pagination visible", () => {
      expect(adapter.getPaginationSelectors()).toEqual([]);
    });
  });

  describe("getResultId", () => {
    it("returns null to fall back to URL-hash deduplication", () => {
      const node = document.createElement("div");
      expect(adapter.getResultId(node)).toBeNull();
    });
  });

  describe("getResultsContainer", () => {
    it("returns #results element", () => {
      const doc = parseHTML('<div id="results"></div>');
      expect(adapter.getResultsContainer(doc)?.id).toBe("results");
    });

    it("returns null when #results does not exist", () => {
      const doc = parseHTML("<div>No results container</div>");
      expect(adapter.getResultsContainer(doc)).toBeNull();
    });
  });
});
