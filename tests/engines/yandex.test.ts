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

    // ── Pager-vs-card discrimination (field 2026-09-08) ─────────────────────
    // A "next"-labelled link inside the AI/answer card used to hijack the
    // anchor: the walk-up landed on the CARD's li, so auto-loaded pages and
    // the spinner were inserted directly after the FIRST result.
    describe("pager-next discrimination", () => {
      const CARD_WITH_NEXT = `
        <ul id="search-result" class="serp-list serp-list_left_yes">
          <li class="serp-item serp-item__futuris-snippet serp-item_card">
            <div class="FuturisSearchCard">
              <ol class="FuturisGPTMessage-Sources"><li>src</li></ol>
              <a class="pager__next" aria-label="Next" href="#src-2">next source</a>
            </div>
          </li>
          <li class="serp-item serp-item_card">
            <h2><a class="OrganicTitle-Link" href="https://example.com/1">One</a></h2>
          </li>
          <li class="serp-item serp-item_card">
            <h2><a class="OrganicTitle-Link" href="https://example.com/2">Two</a></h2>
          </li>
        </ul>`;
      const CARD_PLUS_PAGER = CARD_WITH_NEXT.replace(
        "</ul>",
        `<div class="pager"><a class="Pager-Item Pager-Item_type_next" href="/search/?text=q&amp;lr=87&amp;p=1">next</a></div>
        </ul>`
      );

      it("ignores an in-card next control that is not a /search?&p= link", () => {
        const doc = parseHTML(CARD_WITH_NEXT);
        const container = doc.querySelector("ul#search-result")!;
        // Anchor must NOT resolve to the AI card's li (child index 0).
        expect(adapter.getInsertionAnchor(container)).toBeNull();
      });

      it("still finds the real pager when an in-card next control coexists", () => {
        const doc = parseHTML(CARD_PLUS_PAGER);
        const container = doc.querySelector("ul#search-result")!;
        const anchor = adapter.getInsertionAnchor(container);
        expect(anchor).not.toBeNull();
        expect(anchor!.className).toBe("pager");
        expect(anchor!.parentElement).toBe(container);
      });

      it("getNextPageUrl ignores the in-card anchor href", () => {
        const doc = parseHTML(CARD_WITH_NEXT);
        expect(adapter.getNextPageUrl(doc)).toBeNull();
      });

      it("getNextPageUrl returns the pager's paginated search URL", () => {
        const doc = parseHTML(CARD_PLUS_PAGER);
        const url = adapter.getNextPageUrl(doc);
        expect(url).toContain("/search");
        expect(url).toContain("p=1");
      });

      it("a related-query link (no p=) is not a pager next", () => {
        const doc = parseHTML(`
          <ul id="search-result" class="serp-list serp-list_left_yes">
            <li class="serp-item serp-item_card"><a class="OrganicTitle-Link" href="https://example.com/1">One</a></li>
            <div class="pager"><a aria-label="Next" href="/search/?text=related+query">more like this</a></div>
          </ul>`);
        const container = doc.querySelector("ul#search-result")!;
        expect(adapter.getInsertionAnchor(container)).toBeNull();
      });

      // ── Position verification (field 2026-09-08, round 2) ────────────────────
      // The cee continuous-scroll variant renders REAL /search?&p= load-more
      // controls BETWEEN results. They pass the href-shape filter — only the
      // position check rejects them: a pager must sit AFTER the last result.
      const LIST_WITH_INLINE_CHUNK = `
        <ul id="search-result" class="serp-list serp-list_left_yes">
          <li class="serp-item serp-item_card">
            <h2><a class="OrganicTitle-Link" href="https://example.com/1">One</a></h2>
          </li>
          <div class="serp-more-chunk">
            <a class="Pager-Item Pager-Item_type_next" aria-label="Next page" href="/search/?text=q&amp;lr=10466&amp;cee=1&amp;p=1">load more</a>
          </div>
          <li class="serp-item serp-item_card">
            <h2><a class="OrganicTitle-Link" href="https://example.com/2">Two</a></h2>
          </li>
        </ul>`;

      it("rejects a real /search?&p= link that sits BETWEEN results (cee inline chunk)", () => {
        const doc = parseHTML(LIST_WITH_INLINE_CHUNK);
        const container = doc.querySelector("ul#search-result")!;
        expect(adapter.getInsertionAnchor(container)).toBeNull();
      });

      it("getNextPageUrl still extracts the inline chunk's URL for fetching", () => {
        // The URL itself is a legitimate next page — only the ANCHOR is wrong.
        const doc = parseHTML(LIST_WITH_INLINE_CHUNK);
        const url = adapter.getNextPageUrl(doc);
        expect(url).toContain("p=1");
      });
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

    it("prefers ul#search-result even when another serp-list precedes it in document order", () => {
      // 2026 anatomy: the right column (aside) ships a serp-list_right_yes
      // BEFORE the organic left list in document order on some layouts; a
      // single comma-list querySelector would return the first DOM match.
      const doc = parseHTML(`
        <div class="content">
          <div class="content__right"><ul class="serp-list serp-list_right_yes"></ul></div>
          <div class="content__left"><ul id="search-result" class="serp-list serp-list_left_yes"></ul></div>
        </div>`);
      const el = adapter.getResultsContainer(doc);
      expect(el?.id).toBe("search-result");
    });

    // ── Result-anchored resolution (field 2026-09-08, cee variant) ───────────
    // Live continuous-scroll DOM: ul#search-result ABSENT, and the first
    // .serp-list in document order is the AI-answer card's OWN list. The
    // container resolved to it → every appended page landed INSIDE the first
    // result card (receipt: index=2/3, zero organic results in container).
    it("resolves to the list that CONTAINS the results when ul#search-result is absent", () => {
      const doc = parseHTML(`
        <div class="content__left">
          <div class="Root FuturisSearchOuter">
            <ul class="serp-list serp-list_left_yes"><li>AI sources…</li></ul>
          </div>
          <ul class="serp-list serp-list_left_yes" data-region="organic">
            <li class="serp-item serp-item_card"><h2><a class="OrganicTitle-Link" href="https://a.com/1">r1</a></h2></li>
            <li class="serp-item serp-item_card"><h2><a class="OrganicTitle-Link" href="https://b.com/2">r2</a></h2></li>
          </ul>
          <nav class="Pager"><a class="Pager-Item_type_next" href="/search/?text=test&amp;p=1">next</a></nav>
        </div>`);
      const el = adapter.getResultsContainer(doc);
      expect(el?.getAttribute("data-region")).toBe("organic");
      const results = adapter.getResultNodes(doc);
      expect(results.filter((r) => el!.contains(r)).length).toBe(results.length);
    });

    it("getFetchWrapper is result-anchored too (AI-card list must not win)", () => {
      const doc = parseHTML(`
        <div class="content__left">
          <div class="Root FuturisSearchOuter">
            <ul class="serp-list serp-list_left_yes"><li>AI sources…</li></ul>
          </div>
          <ul class="serp-list serp-list_left_yes" data-region="organic">
            <li class="serp-item serp-item_card"><h2><a class="OrganicTitle-Link" href="https://a.com/1">r1</a></h2></li>
          </ul>
        </div>`);
      const w = adapter.getFetchWrapper(doc);
      expect(w?.getAttribute("data-region")).toBe("organic");
    });
  });

  describe("getFetchWrapper", () => {
    it("returns the organic results list from a fetched doc", () => {
      const doc = parseHTML(`
        <div class="content">
          <ul class="serp-list serp-list_right_yes"></ul>
          <ul id="search-result" class="serp-list serp-list_left_yes">
            <li class="serp-item serp-item_card"><h2><a class="OrganicTitle-Link" href="https://a.com/1">a</a></h2></li>
          </ul>
        </div>`);
      const w = adapter.getFetchWrapper(doc);
      expect(w?.id).toBe("search-result");
      expect(w?.classList.contains("serp-list_left_yes")).toBe(true);
    });

    it("returns null when the fetched doc has no results list", () => {
      const doc = parseHTML("<div>captcha page</div>");
      expect(adapter.getFetchWrapper(doc)).toBeNull();
    });
  });
});
