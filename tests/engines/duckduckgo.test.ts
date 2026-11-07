import { describe, it, expect, beforeEach } from "vitest";
import { DuckDuckGoAdapter } from "../../src/content/engines/duckduckgo";

function parseHTML(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("DuckDuckGoAdapter", () => {
  let adapter: DuckDuckGoAdapter;

  beforeEach(() => {
    adapter = new DuckDuckGoAdapter();
  });

  describe("matches", () => {
    it("matches the four supported DDG hosts", () => {
      for (const host of ["duckduckgo.com", "noai.duckduckgo.com", "start.duckduckgo.com", "safe.duckduckgo.com"]) {
        expect(adapter.matches(new URL(`https://${host}/?q=x`))).toBe(true);
      }
    });

    it("does not match unrelated hosts or arbitrary subdomains", () => {
      expect(adapter.matches(new URL("https://example.com/?q=x"))).toBe(false);
      expect(adapter.matches(new URL("https://evil.duckduckgo.com.example/?q=x"))).toBe(false);
    });
  });

  describe("getResultUrl", () => {
    it("returns a direct external href", () => {
      const doc = parseHTML('<div><article data-testid="result"><h2><a href="https://example.com/page">r</a></h2></article></div>');
      const node = doc.querySelector("article")!;
      expect(adapter.getResultUrl(node)).toBe("https://example.com/page");
    });

    it("unwraps the /l/?uddg= redirect wrapper", () => {
      const doc = parseHTML('<div><article data-testid="result"><h2><a href="/l/?kh=-1&amp;uddg=https%3A%2F%2Fexample.org%2Fdoc">r</a></h2></article></div>');
      const node = doc.querySelector("article")!;
      expect(adapter.getResultUrl(node)).toBe("https://example.org/doc");
    });

    it("unwraps protocol-relative redirect wrappers", () => {
      const doc = parseHTML('<div><article data-testid="result"><h2><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.net%2F">r</a></h2></article></div>');
      const node = doc.querySelector("article")!;
      expect(adapter.getResultUrl(node)).toBe("https://example.net/");
    });

    it("returns null instead of a DDG-internal link with no destination", () => {
      // Regression: returning /settings (resolved against duckduckgo.com) made
      // the block button hide DuckDuckGo itself.
      const doc = parseHTML('<div><article data-testid="result"><h2><a href="/settings">r</a></h2></article></div>');
      const node = doc.querySelector("article")!;
      expect(adapter.getResultUrl(node)).toBeNull();
    });

    it("rejects a non-http uddg target", () => {
      const doc = parseHTML('<div><article data-testid="result"><h2><a href="/l/?uddg=javascript%3Aalert(1)">r</a></h2></article></div>');
      const node = doc.querySelector("article")!;
      expect(adapter.getResultUrl(node)).toBeNull();
    });

    it("rejects a uddg target that points back at DuckDuckGo", () => {
      // A wrapped internal link would otherwise make the block button hide
      // the engine instead of a result.
      const doc = parseHTML('<div><article data-testid="result"><h2><a href="/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fsettings">r</a></h2></article></div>');
      const node = doc.querySelector("article")!;
      expect(adapter.getResultUrl(node)).toBeNull();
    });

    it("prefers the React result-title link over later links", () => {
      const doc = parseHTML(`
        <article data-testid="result">
          <h2><a href="https://example.com/title">title</a></h2>
          <a href="https://example.com/sitelink">sitelink</a>
        </article>`);
      const node = doc.querySelector("article")!;
      expect(adapter.getResultUrl(node)).toBe("https://example.com/title");
    });
  });
});
