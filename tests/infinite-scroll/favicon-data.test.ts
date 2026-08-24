import { describe, it, expect, vi } from "vitest";
import { extractFaviconData } from "../../src/content/infinite-scroll/favicon-data";
import { InfiniteScrollManager } from "../../src/content/infinite-scroll/manager";
import type { EngineAdapter } from "../../src/content/engines/base";

function parseHTML(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/** Minimal replica of Startpage's SSR JSON state (verified vs Jan 2026 archive). */
const SSR_BLOB = JSON.stringify({
  results: [
    {
      title: "Test – Wikipedia",
      url: "https://de.wikipedia.org/wiki/Test",
      sourceIndex: 0,
      siteLinks: [],
      faviconData: "data:image/png;base64,WIKI",
    },
    {
      title: "test.de",
      url: "https://www.test.de/",
      sourceIndex: 1,
      siteLinks: [],
      faviconData: "data:image/png;base64,TESTDE",
    },
  ],
});

describe("extractFaviconData", () => {
  it("extracts host -> dataURL pairs from the SSR state blob", () => {
    const map = extractFaviconData(SSR_BLOB);
    expect(map.size).toBe(2);
    expect(map.get("de.wikipedia.org")).toBe("data:image/png;base64,WIKI");
    // www. is normalized away to match result-host resolution elsewhere.
    expect(map.get("test.de")).toBe("data:image/png;base64,TESTDE");
  });

  it("maps each record to ITS OWN url — not a neighboring record's", () => {
    // Deliberately adversarial ordering: the LAST url before each record's
    // sourceIndex must win even across record boundaries.
    const map = extractFaviconData(SSR_BLOB);
    expect(map.get("de.wikipedia.org")).not.toBe("data:image/png;base64,TESTDE");
    expect(map.get("test.de")).not.toBe("data:image/png;base64,WIKI");
  });

  it("does NOT let populated siteLinks poison the host mapping", () => {
    // siteLinks entries sit AFTER their record's own url+faviconData, so
    // the "nearest preceding url" rule already skips them; this fixture
    // mirrors that ordering (verified vs the Jan 2026 archive capture).
    const blob =
      '{"results":[{"url":"https://real.example/a","sourceIndex":0,' +
      '"faviconData":"data:image/png;base64,REAL"},' +
      '{"url":"https://sub.example/b","sourceIndex":1,' +
      '"faviconData":"data:image/gif;base64,SUB"}]}';
    const map = extractFaviconData(blob);
    expect(map.get("real.example")).toBe("data:image/png;base64,REAL");
    expect(map.get("sub.example")).toBe("data:image/gif;base64,SUB");
  });

  it("drops non-data faviconData values (external URLs are CSP-blocked anyway)", () => {
    const blob =
      '{"results":[{"url":"https://a.example/","sourceIndex":0,' +
      '"faviconData":"https://cdn.a.example/icon.png"}]}';
    expect(extractFaviconData(blob).size).toBe(0);
  });

  it("returns an EMPTY map (never throws) on garbage / empty input", () => {
    expect(extractFaviconData("").size).toBe(0);
    expect(extractFaviconData("not json at all").size).toBe(0);
    expect(extractFaviconData('{"faviconData":"data:image/png;base64,ORPHAN"}').size).toBe(0);
    expect(extractFaviconData('{"url":"https://x.example/","faviconData":123}').size).toBe(0);
  });

  it("strips web.archive.org wrappers (archived snapshots stay usable)", () => {
    const blob =
      '{"results":[{"url":"http://web.archive.org/web/20250429215101/https://www.test.de/",' +
      '"sourceIndex":0,"faviconData":"data:image/png;base64,ARC"}]}';
    expect(extractFaviconData(blob).get("test.de")).toBe("data:image/png;base64,ARC");
  });
});

describe("manager integration: tier-0 inline art paints clone chips", () => {
  function startpageEngine(urls: Record<string, string>): EngineAdapter {
    return {
      id: "startpage",
      name: "Startpage",
      matches: () => true,
      getResultNodes: () => [],
      getResultUrl: (n: Element) =>
        urls[n.getAttribute("data-k") ?? ""] ?? null,
      getButtonTarget: () => null,
      getInsertionAnchor: () => null,
    } as unknown as EngineAdapter;
  }

  it("paints chips from the FETCHED page's own inline blob (page-2 hosts, no network)", () => {
    const doc = parseHTML('<div id="results"></div>');
    const container = doc.querySelector("#results")!;
    const manager = new InfiniteScrollManager(
      startpageEngine({ a: "https://de.wikipedia.org/wiki/Test", b: "https://www.test.de/" }),
      container, () => {}, { maxPages: 5, portFetchedStyles: true }
    );

    // Fetched snapshot: chip markup ships an EMPTY icon div (hydration's
    // job) + the SSR state script carrying the real art as data: URLs.
    // Hosts in the blob match the result URLs — art flows to its own chip.
    const fetched = parseHTML(
      "<html><head></head><body>" +
        '<div class="result" data-k="a">' +
        '<a class="favicon-link" href="https://de.wikipedia.org/wiki/Test">' +
        '<span class="favicon-container css-17lvy5f"><div class="favicon css-srotke"></div></span></a>' +
        "</div>" +
        '<div class="result" data-k="b">' +
        '<a class="favicon-link" href="https://www.test.de/">' +
        '<span class="favicon-container css-17lvy5f"><div class="favicon css-srotke"></div></span></a>' +
        "</div>" +
        "<script>" + SSR_BLOB.replace(/<\//g, "<\\/") + "</script>" +
        "</body></html>"
    );
    const nodes = Array.from(fetched.querySelectorAll("div.result"));
    (manager as unknown as { appendNodes(n: Element[], d?: Document): void })
      .appendNodes(nodes, fetched);

    try {
      const page = container.querySelector("[data-inf-page]") as HTMLElement;
      const icons = Array.from(
        page.querySelectorAll<HTMLElement>(".result .favicon-container > .favicon")
      );
      expect(icons.length).toBe(2);
      // Exact first-party art, ON the innermost layer, single paint.
      expect(icons[0]!.style.backgroundImage).toContain("data:image/png;base64,WIKI");
      expect(icons[1]!.style.backgroundImage).toContain("data:image/png;base64,TESTDE");
    } finally {
      container.remove();
    }
  });

  it("first snapshot wins: a later page cannot overwrite earlier art for a known host", () => {
    const doc = parseHTML('<div id="results"></div>');
    const container = doc.querySelector("#results")!;
    const urls = { a: "https://dup.example/p1" };
    const manager = new InfiniteScrollManager(
      startpageEngine(urls),
      container, () => {}, { maxPages: 5, portFetchedStyles: true }
    );

    const mkFetch = (icon: string) =>
      parseHTML(
        "<html><head></head><body>" +
          '<div class="result" data-k="a">' +
          '<a class="favicon-link" href="https://dup.example/x">' +
          '<span class="favicon-container"><div class="favicon"></div></span></a>' +
          "</div>" +
          "<script>{\"results\":[{\"url\":\"https://dup.example/\"," +
          '"sourceIndex":0,"faviconData":"' + icon + '"}]}</script>' +
          "</body></html>"
      );

    const p1 = mkFetch("data:image/png;base64,FIRST");
    (manager as unknown as { appendNodes(n: Element[], d?: Document): void })
      .appendNodes(Array.from(p1.querySelectorAll("div.result")), p1);
    const p2 = mkFetch("data:image/png;base64,SECOND");
    (manager as unknown as { appendNodes(n: Element[], d?: Document): void })
      .appendNodes(Array.from(p2.querySelectorAll("div.result")), p2);

    try {
      const pages = container.querySelectorAll("[data-inf-page] .result .favicon");
      expect(pages.length).toBe(2);
      expect((pages[0] as HTMLElement).style.backgroundImage).toContain("FIRST");
      expect((pages[1] as HTMLElement).style.backgroundImage).toContain("FIRST");
    } finally {
      container.remove();
    }
  });

  it("placeholder chip backgrounds are NOT counted as painted (outcome-counter lie, Aug 24 logs)", () => {
    const doc = parseHTML('<div id="results"></div>');
    const container = doc.querySelector("#results")!;
    // Live anatomy: fetched chips ship with an emotion rule painting the
    // search page's OWN url as their background. Inline style mirrors what
    // the preserved stylesheet computes to.
    const manager = new InfiniteScrollManager(
      startpageEngine({ a: "https://de.wikipedia.org/wiki/Test" }),
      container, () => {}, { maxPages: 5, portFetchedStyles: true }
    );
    vi.spyOn(
      manager as unknown as { learnLiveFaviconPattern(): string | null },
      "learnLiveFaviconPattern"
    ).mockReturnValue(null);
    const fetched = parseHTML(
      "<html><head></head><body>" +
        '<div class="result" data-k="a">' +
        '<a class="favicon-link" href="https://de.wikipedia.org/wiki/Test">' +
        '<span class="favicon-container"><div class="favicon" style="background-image:url(\'https://www.startpage.com/sp/search?query=test\')"></div></span></a>' +
        "</div>" +
        "<script>" + SSR_BLOB.replace(/<\//g, "<\\/") + "</script>" +
        "</body></html>"
    );
    (manager as unknown as { appendNodes(n: Element[], d?: Document): void })
      .appendNodes(Array.from(fetched.querySelectorAll("div.result")), fetched);

    try {
      const page = container.querySelector("[data-inf-page]") as HTMLElement;
      const icon = page.querySelector(".result .favicon") as HTMLElement;
      // The placeholder must be REPLACED by the record's real art — not
      // honored as "already painted".
      expect(icon.style.backgroundImage).toContain("data:image/png;base64,WIKI");
    } finally {
      container.remove();
    }
  });
});
