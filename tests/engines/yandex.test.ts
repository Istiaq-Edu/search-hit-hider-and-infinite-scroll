import { describe, it, expect, beforeEach } from "vitest";
import { YandexAdapter } from "../../src/content/engines/yandex";

function parseHTML(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("YandexAdapter", () => {
  let adapter: YandexAdapter;

  beforeEach(() => {
    adapter = new YandexAdapter();
  });

  describe("getInsertionAnchor", () => {
    it("returns the pager block that is a direct child of the container", () => {
      const doc = parseHTML(`
        <div id="search-results">
          <li class="serp-item">r1</li>
          <li class="serp-item">r2</li>
          <div class="pager"><a class="Pager-Item Pager-Item_type_next" href="/search?p=2">next</a></div>
        </div>
      `);
      const container = doc.querySelector("#search-results")!;
      const anchor = adapter.getInsertionAnchor(container);
      expect(anchor).not.toBeNull();
      expect(anchor!.className).toBe("pager");
      expect(anchor!.parentElement).toBe(container);
    });

    it("walks up through nested pager markup to the container child", () => {
      const doc = parseHTML(`
        <div id="search-results">
          <li class="serp-item">r1</li>
          <div class="pager-wrapper"><nav class="pager-items"><ul><li><a aria-label="Next page" href="/search?p=2">next</a></li></ul></nav></div>
        </div>
      `);
      const container = doc.querySelector("#search-results")!;
      const anchor = adapter.getInsertionAnchor(container);
      expect(anchor).not.toBeNull();
      expect(anchor!.className).toBe("pager-wrapper");
      expect(anchor!.parentElement).toBe(container);
    });

    it("returns the next link itself when it is a direct child of the container", () => {
      const doc = parseHTML(`
        <div id="search-results">
          <li class="serp-item">r1</li>
          <a class="pager__next" href="/search?p=2">next</a>
        </div>
      `);
      const container = doc.querySelector("#search-results")!;
      const anchor = adapter.getInsertionAnchor(container);
      expect(anchor).not.toBeNull();
      expect(anchor!.tagName).toBe("A");
      expect(anchor!.parentElement).toBe(container);
    });

    it("returns null when no pager link exists inside the container", () => {
      const doc = parseHTML(`
        <div id="search-results">
          <li class="serp-item">r1</li>
        </div>
      `);
      const container = doc.querySelector("#search-results")!;
      expect(adapter.getInsertionAnchor(container)).toBeNull();
    });

    it("prefers the LAST next-link when several exist (bottom pager wins)", () => {
      const doc = parseHTML(`
        <div id="search-results">
          <div class="top-pager"><a aria-label="Next" href="/search?p=2">next</a></div>
          <li class="serp-item">r1</li>
          <div class="pager"><a aria-label="Next" href="/search?p=2">next</a></div>
        </div>
      `);
      const container = doc.querySelector("#search-results")!;
      const anchor = adapter.getInsertionAnchor(container);
      expect(anchor).not.toBeNull();
      expect(anchor!.className).toBe("pager");
    });

    it("ignores a stray Next-labelled link inside a result when a real pager exists", () => {
      const doc = parseHTML(`
        <div id="search-results">
          <li class="serp-item"><a aria-label="Next" href="https://example.com/gallery/2">gallery</a></li>
          <div class="pager"><a class="Pager-Item_type_next" href="/search?p=2">next</a></div>
        </div>
      `);
      const container = doc.querySelector("#search-results")!;
      const anchor = adapter.getInsertionAnchor(container);
      expect(anchor).not.toBeNull();
      expect(anchor!.className).toBe("pager");
    });

    it("returns null when the container itself is missing (defensive)", () => {
      const doc = parseHTML("<div>empty</div>");
      const stray = doc.querySelector("div")!;
      expect(adapter.getInsertionAnchor(stray)).toBeNull();
    });
  });

  describe("getResultsContainer", () => {
    it("finds #search-results", () => {
      const doc = parseHTML('<div id="search-results"><ol class="serp-list"></ol></div>');
      const el = adapter.getResultsContainer(doc);
      expect(el?.id).toBe("search-results");
    });

    it("falls back to serp-list", () => {
      const doc = parseHTML('<ol class="serp-list"><li class="serp-item"></li></ol>');
      const el = adapter.getResultsContainer(doc);
      expect(el?.className).toBe("serp-list");
    });

    it("returns null on unrelated pages", () => {
      const doc = parseHTML("<div id='main'>nothing</div>");
      expect(adapter.getResultsContainer(doc)).toBeNull();
    });
  });
});
