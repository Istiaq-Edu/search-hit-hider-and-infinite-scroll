import { describe, it, expect, afterEach, vi } from "vitest";
import { InfiniteScrollManager } from "../../src/content/infinite-scroll/manager";
import type { EngineAdapter } from "../../src/content/engines/base";

function parseHTML(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function stubEngine(anchor: Element | null): EngineAdapter {
  return {
    id: "yandex",
    name: "Yandex",
    matches: () => true,
    getResultNodes: () => [],
    getResultUrl: () => null,
    getButtonTarget: () => null,
    getInsertionAnchor: () => anchor,
  } as EngineAdapter;
}

/**
 * appendNodes is TypeScript-private; exercised directly (without init(),
 * which would require IntersectionObserver/ResizeObserver mocks) because the
 * insertion point is the behavior under test.
 */
function callAppend(manager: InfiniteScrollManager, nodes: Element[], sourceDoc?: Document): void {
  (manager as unknown as { appendNodes(n: Element[], d?: Document): void }).appendNodes(nodes, sourceDoc);
}

describe("InfiniteScrollManager.appendNodes insertion", () => {
  it("inserts fetched pages BEFORE the engine-provided anchor", () => {
    const doc = parseHTML(`
      <div id="search-results">
        <li class="serp-item">r1</li>
        <div class="pager"><a href="/search?p=2">next</a></div>
      </div>
    `);
    const container = doc.querySelector("#search-results")!;
    const pager = doc.querySelector(".pager")!;
    const manager = new InfiniteScrollManager(
      stubEngine(pager), container, () => {}, { maxPages: 5 }
    );
    const node = doc.createElement("li");
    node.className = "serp-item";
    node.textContent = "fetched";
    callAppend(manager, [node]);

    const page = container.querySelector("[data-inf-page]") as HTMLElement;
    expect(page).not.toBeNull();
    expect(page.textContent).toContain("fetched");
    // page sits between the original results and the pager
    expect(page.nextElementSibling).toBe(pager);
    expect(page.previousElementSibling?.textContent).toBe("r1");
  });

  it("falls back to append-at-end when the engine returns no anchor", () => {
    const doc = parseHTML(`
      <div id="search-results">
        <li class="serp-item">r1</li>
      </div>
    `);
    const container = doc.querySelector("#search-results")!;
    const manager = new InfiniteScrollManager(
      stubEngine(null), container, () => {}, { maxPages: 5 }
    );
    const node = doc.createElement("li");
    node.textContent = "fetched";
    callAppend(manager, [node]);

    const page = container.querySelector("[data-inf-page]") as HTMLElement;
    expect(page).not.toBeNull();
    expect(page.nextElementSibling).toBeNull(); // last child
  });

  it("falls back to append-at-end when the anchor is not a child of the container", () => {
    const doc = parseHTML(`
      <div id="search-results"><li class="serp-item">r1</li></div>
      <div id="stray-pager"><a href="/search?p=2">next</a></div>
    `);
    const container = doc.querySelector("#search-results")!;
    const strayAnchor = doc.querySelector("#stray-pager")!; // belongs to another parent
    const manager = new InfiniteScrollManager(
      stubEngine(strayAnchor), container, () => {}, { maxPages: 5 }
    );
    const node = doc.createElement("li");
    node.textContent = "fetched";
    callAppend(manager, [node]);

    // must not throw, and the page must land inside the container, not beside the stray anchor
    const page = container.querySelector("[data-inf-page]") as HTMLElement;
    expect(page).not.toBeNull();
    expect(page.parentElement).toBe(container);
    expect(page.nextElementSibling).toBeNull();
  });

  it("notifies with the appended clones so the blocking pipeline processes them", () => {
    const doc = parseHTML('<div id="search-results"></div>');
    const container = doc.querySelector("#search-results")!;
    let received: Element[] = [];
    const manager = new InfiniteScrollManager(
      stubEngine(null), container, (nodes) => { received = nodes; }, { maxPages: 5 }
    );
    const node = doc.createElement("li");
    node.textContent = "fetched";
    callAppend(manager, [node]);
    expect(received).toHaveLength(1);
    expect(received[0]?.textContent).toBe("fetched");
    expect(received[0]?.parentElement).toBe(container.querySelector("[data-inf-page]"));
  });

  it("strips <script> elements and inline event handlers from fetched nodes", () => {
    const doc = parseHTML('<div id="search-results"></div>');
    const container = doc.querySelector("#search-results")!;
    const manager = new InfiniteScrollManager(
      stubEngine(null), container, () => {}, { maxPages: 5 }
    );
    const node = doc.createElement("li");
    node.innerHTML =
      '<span onclick="alert(1)">text</span>' +
      '<script>window.__pwned = true;<\/script>' +
      '<a href="https://example.com/" onmouseover="track()">link</a>';
    callAppend(manager, [node]);

    const page = container.querySelector("[data-inf-page]") as HTMLElement;
    expect(page.querySelector("script")).toBeNull();
    expect(page.querySelector("[onclick]")).toBeNull();
    expect(page.querySelector("[onmouseover]")).toBeNull();
    // content itself survives
    expect(page.textContent).toContain("text");
    expect(page.querySelector("a")?.getAttribute("href")).toBe("https://example.com/");
  });
});

describe("InfiniteScrollManager POST page chain", () => {  afterEach(() => { vi.unstubAllGlobals(); });

  it("requests consecutive pages (2, then 3) — no off-by-one re-fetch", async () => {
    const doc = parseHTML(`
      <div id="results"><div class="r"><a href="https://a.com/1">r1</a></div></div>
    `);
    const container = doc.querySelector("#results")!;

    const postEngine = {
      ...stubEngine(null),
      getNextPageUrl: undefined,
      triggerNextPage: undefined,
      getResultNodes: (d: Document) => Array.from(d.querySelectorAll(".r")),
      getPaginationSelectors: () => [],
      // POST-paginated engine: page N+1 requires the sc token of page N.
      getNextPageRequest: (d: Document, pageNo: number) => ({
        url: "https://x.test/sp/search",
        method: "POST" as const,
        body: { page: String(pageNo), sc: (d.querySelector("input[name='sc']") as HTMLInputElement | null)?.value ?? "t" },
      }),
    } as unknown as EngineAdapter;

    const manager = new InfiniteScrollManager(postEngine, container, () => {}, { fetchDelay: 0, maxPages: 10 });
    const m = manager as unknown as {
      nextPageRequest: { url: string; init: RequestInit } | null;
      nextUrl: string | null; hasMore: boolean;
      buildNextPageRequest: (d: Document) => { url: string; init: RequestInit } | null;
      fetchNextPage: () => Promise<void>;
    };
    // Seed state exactly as init() would for a POST engine (init itself
    // needs IntersectionObserver, unavailable in jsdom).
    m.nextPageRequest = m.buildNextPageRequest(doc);
    m.nextUrl = m.nextPageRequest!.url;
    m.hasMore = true;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, url: "https://x.test/sp/search",
      text: async () =>
        '<html><body><input name="sc" value="tok2"><div class="r"><a href="https://a.com/2">r2</a></div></body></html>',
    });
    vi.stubGlobal("fetch", fetchMock);

    await m.fetchNextPage();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstBody = String(fetchMock.mock.calls[0]![1]!.body);
    expect(firstBody).toContain("page=2");

    await m.fetchNextPage();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = String(fetchMock.mock.calls[1]![1]!.body);
    // Regression: the second request must advance to page 3, not re-send 2,
    // and must carry the sc token from the page just fetched.
    expect(secondBody).toContain("page=3");
    expect(secondBody).toContain("sc=tok2");
  });
});

describe("InfiniteScrollManager sentinel + style porting", () => {
  it("places the spinner BEFORE the pager anchor when one exists", () => {
    const doc = parseHTML(`
      <div id="results">
        <div class="r"><a href="https://a.com/1">r1</a></div>
        <div class="pager"><button type="submit">Next</button></div>
      </div>
    `);
    const container = doc.querySelector("#results")!;
    const pager = doc.querySelector(".pager")!;
    const engine = {
      ...stubEngine(pager),
    } as unknown as EngineAdapter;
    const manager = new InfiniteScrollManager(engine, container, () => {}, { maxPages: 5 });
    (manager as unknown as { createSentinel: () => void }).createSentinel();
    const sentinel = container.querySelector("#is-sentinel") as HTMLElement | null;
    expect(sentinel).not.toBeNull();
    // directly under the results, above the pager
    expect(sentinel!.nextElementSibling).toBe(pager);
  });

  it("ports fetched styles into the page container and dedupes across pages", () => {
    const doc = parseHTML('<div id="results"><div class="r">r</div></div>');
    const container = doc.querySelector("#results")!;
    const manager = new InfiniteScrollManager(
      stubEngine(null), container, () => {}, { maxPages: 5, portFetchedStyles: true }
    );
    const fetched = parseHTML(
      '<html><head><style>body{--text-color:#333}.css-abc{color:red}</style><style>:root{--x:1}.css-def{color:blue}</style></head></html>'
    );
    const n1 = doc.createElement("div");
    callAppend(manager, [n1], fetched);
    let page = container.querySelector("[data-inf-page]") as HTMLElement;
    let styles = page.querySelectorAll("style[data-shh-fetched-style]");
    expect(styles.length).toBe(2);
    // document-level theme rules are dropped so a fetched light-theme build
    // cannot recolor the live page; class rules survive
    const allPorted = [...styles].map((s) => s.textContent).join(" ");
    expect(allPorted).toContain(".css-abc");
    expect(allPorted).toContain(".css-def");
    expect(allPorted).not.toContain("body{");
    expect(allPorted).not.toContain(":root");

    // second fetch: same styles must not be injected again, a new one is
    // page 2 repeats page 1's exact combined tag (dedupe) plus one new rule
    const fetched2 = parseHTML(
      '<html><head><style>body{--text-color:#333}.css-abc{color:red}</style><style>.css-ghi{color:green}</style></head></html>'
    );
    const n2 = doc.createElement("div");
    callAppend(manager, [n2], fetched2);
    const pages = container.querySelectorAll("[data-inf-page]");
    const page2 = pages[pages.length - 1] as HTMLElement;
    const styles2 = page2.querySelectorAll("style[data-shh-fetched-style]");
    expect(styles2.length).toBe(1); // only .css-ghi; css-abc already ported
  });

  it("does not port styles when the engine does not opt in", () => {
    const doc = parseHTML('<div id="results"><div class="r">r</div></div>');
    const container = doc.querySelector("#results")!;
    const manager = new InfiniteScrollManager(
      stubEngine(null), container, () => {}, { maxPages: 5 } // no portFetchedStyles
    );
    const fetched = parseHTML('<html><head><style>.x{color:red}</style></head></html>');
    const n = doc.createElement("div");
    callAppend(manager, [n], fetched);
    const page = container.querySelector("[data-inf-page]") as HTMLElement;
    expect(page.querySelectorAll("style[data-shh-fetched-style]").length).toBe(0);
  });
});
