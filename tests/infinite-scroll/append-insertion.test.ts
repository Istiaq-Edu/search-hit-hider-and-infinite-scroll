import { describe, it, expect } from "vitest";
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
function callAppend(manager: InfiniteScrollManager, nodes: Element[]): void {
  (manager as unknown as { appendNodes(n: Element[]): void }).appendNodes(nodes);
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
