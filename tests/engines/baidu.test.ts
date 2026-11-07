import { describe, it, expect, beforeEach } from "vitest";
import { BaiduAdapter } from "../../src/content/engines/baidu";

function parseHTML(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("BaiduAdapter", () => {
  let adapter: BaiduAdapter;

  beforeEach(() => {
    adapter = new BaiduAdapter();
  });

  describe("matches", () => {
    it("matches www.baidu.com only", () => {
      expect(adapter.matches(new URL("https://www.baidu.com/s?wd=x"))).toBe(true);
      expect(adapter.matches(new URL("https://baidu.com/s?wd=x"))).toBe(false);
      expect(adapter.matches(new URL("https://example.com/s?wd=x"))).toBe(false);
    });
  });

  describe("getResultNodes", () => {
    it("returns regular result containers", () => {
      const doc = parseHTML(`
        <div id="content_left">
          <div class="result c-container" mu="https://example.com/1"></div>
          <div class="result-op c-container" mu="https://example.com/2"></div>
        </div>`);
      expect(adapter.getResultNodes(doc)).toHaveLength(2);
    });
  });

  describe("getResultUrl", () => {
    it("prefers the mu attribute", () => {
      const doc = parseHTML('<div class="result" mu="https://example.com/target"><a href="https://www.baidu.com/link?url=x">r</a></div>');
      expect(adapter.getResultUrl(doc.querySelector(".result")!)).toBe("https://example.com/target");
    });

    it("derives a URL from the display cite", () => {
      const doc = parseHTML(`
        <div class="result">
          <a class="c-showurl" href="https://www.baidu.com/link?url=x">www.example.org/doc</a>
          <h3><a href="https://www.baidu.com/link?url=x">r</a></h3>
        </div>`);
      expect(adapter.getResultUrl(doc.querySelector(".result")!)).toBe("https://www.example.org/doc");
    });

    it("returns null instead of the opaque baidu.com/link redirect", () => {
      // Regression: the redirect names no destination, so blocking it hid
      // Baidu instead of the result.
      const doc = parseHTML(`
        <div class="result">
          <h3><a href="https://www.baidu.com/link?url=opaque-token">r</a></h3>
        </div>`);
      expect(adapter.getResultUrl(doc.querySelector(".result")!)).toBeNull();
    });

    it("returns a direct external h3 href when present", () => {
      const doc = parseHTML(`
        <div class="result">
          <h3><a href="https://example.net/page">r</a></h3>
        </div>`);
      expect(adapter.getResultUrl(doc.querySelector(".result")!)).toBe("https://example.net/page");
    });

    it("rejects non-http mu values and an invalid cite", () => {
      const doc = parseHTML(`<div class="result" mu="javascript:alert(1)">r</div>`);
      expect(adapter.getResultUrl(doc.querySelector(".result")!)).toBeNull();
    });

    it("never targets Baidu from an mu attribute", () => {
      const doc = parseHTML('<div class="result" mu="https://www.baidu.com/s?wd=internal">r</div>');
      expect(adapter.getResultUrl(doc.querySelector(".result")!)).toBeNull();
    });

    it("never targets Baidu from the display cite", () => {
      const doc = parseHTML(`
        <div class="result">
          <a class="c-showurl" href="https://www.baidu.com/link?url=x">www.baidu.com</a>
          <h3><a href="https://www.baidu.com/link?url=x">r</a></h3>
        </div>`);
      expect(adapter.getResultUrl(doc.querySelector(".result")!)).toBeNull();
    });
  });
});
