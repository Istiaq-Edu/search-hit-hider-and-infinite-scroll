import { describe, it, expect, beforeEach } from "vitest";
import { BingAdapter } from "../../src/content/engines/bing";

function parseHTML(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

// Mirrors Bing's real layout: #b_content is a broad WRAPPER around
// ol#b_results, and the pager (li.b_pag) is the last child of the ol.
const REAL_SERP = `
  <div id="b_content">
    <ol id="b_results">
      <li class="b_algo"><h2><a href="https://example.com/1">r1</a></h2></li>
      <li class="b_algo"><h2><a href="https://example.com/2">r2</a></h2></li>
      <li class="b_pag"><nav role="navigation" aria-label="More results"><ul><li><a class="sb_pagN" href="/search?q=test&first=11">Next</a></li></ul></nav></li>
    </ol>
  </div>
`;

describe("BingAdapter", () => {
  let adapter: BingAdapter;

  beforeEach(() => {
    adapter = new BingAdapter();
  });

  describe("matches", () => {
    it("matches www.bing.com", () => {
      expect(adapter.matches(new URL("https://www.bing.com/search?q=test"))).toBe(true);
    });

    it("does not match other hosts", () => {
      expect(adapter.matches(new URL("https://bing.example.com/search?q=test"))).toBe(false);
    });
  });

  describe("getPaginationSelectors", () => {
    it("returns [] — pagination stays visible as a manual fallback", () => {
      // Regression guard: hiding li.b_pag left users with no manual paging
      // when automatic fetching breaks (unlike Yandex/Brave which keep it).
      expect(adapter.getPaginationSelectors!()).toEqual([]);
    });
  });

  describe("getResultsContainer", () => {
    it("returns #b_results, not the broad #b_content wrapper", () => {
      const doc = parseHTML(REAL_SERP);
      const el = adapter.getResultsContainer(doc);
      expect(el?.id).toBe("b_results");
    });

    it("falls back to #b_content when the list is absent", () => {
      const doc = parseHTML('<div id="b_content"><div>no list</div></div>');
      const el = adapter.getResultsContainer(doc);
      expect(el?.id).toBe("b_content");
    });
  });

  describe("getInsertionAnchor", () => {
    it("returns the b_pag row using the real nested structure", () => {
      const doc = parseHTML(REAL_SERP);
      const container = adapter.getResultsContainer(doc)!;
      const anchor = adapter.getInsertionAnchor!(container);
      expect(anchor).not.toBeNull();
      expect(anchor!.classList.contains("b_pag")).toBe(true);
      expect(anchor!.parentElement).toBe(container);
    });

    it("never anchors on the results list itself when the container is #b_content", () => {
      // The bug this guards against: walking up from the Next link inside
      // #b_content reaches ol#b_results (its parent IS the container) —
      // anchoring there would insert pages ABOVE the whole results list.
      const doc = parseHTML(REAL_SERP);
      const wrapper = doc.querySelector("#b_content")!;
      expect(adapter.getInsertionAnchor!(wrapper)).toBeNull();
    });

    it("returns null when no pager exists inside the container", () => {
      const doc = parseHTML('<ol id="b_results"><li class="b_algo">r1</li></ol>');
      const container = doc.querySelector("#b_results")!;
      expect(adapter.getInsertionAnchor!(container)).toBeNull();
    });

    it("returns null when the pager lives outside the container", () => {
      const doc = parseHTML(`
        <ol id="b_results"><li class="b_algo">r1</li></ol>
        <div class="b_pag-outer"><a class="sb_pagN" href="/search?q=test&first=11">Next</a></div>
      `);
      const container = doc.querySelector("#b_results")!;
      expect(adapter.getInsertionAnchor!(container)).toBeNull();
    });
  });
});
