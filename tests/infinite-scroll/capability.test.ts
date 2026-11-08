import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InfiniteScrollManager } from "../../src/content/infinite-scroll/manager";
import {
  findNativeAdvanceControl,
  findNextPageLink,
  visibleResultCount,
} from "../../src/content/infinite-scroll/native-advance";
import type { EngineAdapter } from "../../src/content/engines/base";

// ============================================================
// Capability, not engine names.
//
// "Can this page advance itself?" is a property of the DOM. These tests pin
// the ONE shared detector that every engine uses, plus the manager path that
// delegates without any adapter-specific paging code.
// ============================================================

class FakeIntersectionObserver {
  constructor(_cb: IntersectionObserverCallback, _opts?: IntersectionObserverInit) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

const RESULT = (host: string): string =>
  `<li class="serp-item"><h2><a href="https://${host}/x">${host}</a></h2></li>`;

function parseHTML(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function nodesOf(doc: Document | Element): Element[] {
  return Array.from(doc.querySelectorAll("li.serp-item"));
}

let managers: InfiniteScrollManager[] = [];

function stubEngine(overrides: Record<string, unknown> = {}): EngineAdapter {
  return {
    id: "stub",
    name: "Stub",
    matches: () => true,
    getResultNodes: (doc: Document | Element) => nodesOf(doc),
    getResultUrl: (node: Element) =>
      node.querySelector("a")?.getAttribute("href") ?? null,
    getButtonTarget: () => null,
    ...overrides,
  } as unknown as EngineAdapter;
}

function makeManager(
  engine: EngineAdapter,
  container: Element,
  onNewNodes: (nodes: Element[]) => void
): InfiniteScrollManager {
  const manager = new InfiniteScrollManager(engine, container, onNewNodes, {
    fetchDelay: 0,
    maxPages: 10,
    persist: false,
  } as ConstructorParameters<typeof InfiniteScrollManager>[3]);
  managers.push(manager);
  return manager;
}

const priv = (m: InfiniteScrollManager): Record<string, unknown> =>
  m as unknown as Record<string, unknown>;

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  document.body.innerHTML = "";
});

afterEach(() => {
  for (const m of managers) m.destroy();
  managers = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("findNativeAdvanceControl", () => {
  it("finds an engine's own more-results button after the results", () => {
    const doc = parseHTML(
      `<ul>${RESULT("a.com")}${RESULT("b.com")}</ul>` +
        `<button data-testid="more-results">More results</button>`
    );
    expect(findNativeAdvanceControl(doc, nodesOf(doc))?.textContent).toContain(
      "More results"
    );
  });

  it("accepts an in-page anchor with no destination", () => {
    const doc = parseHTML(
      `<ul>${RESULT("a.com")}</ul><a href="#">Show more</a>`
    );
    expect(findNativeAdvanceControl(doc, nodesOf(doc))?.textContent).toBe("Show more");
  });

  it("rejects an anchor that would NAVIGATE", () => {
    const doc = parseHTML(
      `<ul>${RESULT("a.com")}</ul><a href="/page/2">Show more</a>`
    );
    expect(findNativeAdvanceControl(doc, nodesOf(doc))).toBeNull();
  });

  it("rejects a control that sits BEFORE the results (header menus)", () => {
    const doc = parseHTML(
      `<header><button aria-label="More">More</button></header>` +
        `<ul>${RESULT("a.com")}${RESULT("b.com")}</ul>`
    );
    expect(findNativeAdvanceControl(doc, nodesOf(doc))).toBeNull();
  });

  it("rejects a control inside a result card", () => {
    const doc = parseHTML(
      `<ul><li class="serp-item"><h2><a href="https://a.com/x">a</a></h2>` +
        `<button aria-label="More results">More results</button></li></ul>`
    );
    expect(findNativeAdvanceControl(doc, nodesOf(doc))).toBeNull();
  });

  it("rejects hidden, disabled and javascript: controls", () => {
    for (const html of [
      `<button data-testid="more-results" hidden>More results</button>`,
      `<button data-testid="more-results" disabled>More results</button>`,
      `<a data-testid="more-results" href="javascript:void(0)">More results</a>`,
    ]) {
      const doc = parseHTML(`<ul>${RESULT("a.com")}</ul>${html}`);
      expect(findNativeAdvanceControl(doc, nodesOf(doc))).toBeNull();
    }
  });

  it("rejects download links and controls inside credential forms", () => {
    for (const html of [
      `<a data-testid="more-results" download>More results</a>`,
      `<form><input type="password"><button data-testid="more-results">More results</button></form>`,
    ]) {
      const doc = parseHTML(`<ul>${RESULT("a.com")}</ul>${html}`);
      expect(findNativeAdvanceControl(doc, nodesOf(doc))).toBeNull();
    }
  });

  it("returns null when the page has no such control", () => {
    const doc = parseHTML(`<ul>${RESULT("a.com")}</ul><nav><a href="/2">2</a></nav>`);
    expect(findNativeAdvanceControl(doc, nodesOf(doc))).toBeNull();
  });
});

describe("findNextPageLink", () => {
  it("prefers rel=next and resolves it against the document", () => {
    const doc = parseHTML(`<a rel="next" href="/search?p=2">2</a>`);
    Object.defineProperty(doc, "URL", {
      value: "https://example.com/search?p=1",
      configurable: true,
    });
    expect(findNextPageLink(doc)).toBe("https://example.com/search?p=2");
  });

  it("understands aria-label and short 'Next' text", () => {
    for (const html of [
      `<a aria-label="Next page" href="/p2">›</a>`,
      `<a href="/p2">Next</a>`,
    ]) {
      const doc = parseHTML(html);
      Object.defineProperty(doc, "URL", {
        value: "https://example.com/",
        configurable: true,
      });
      expect(findNextPageLink(doc)).toBe("https://example.com/p2");
    }
  });

  it("ignores numeric pager links and script URLs", () => {
    const doc = parseHTML(`<a href="/p2">2</a><a href="javascript:void(0)">Next</a>`);
    expect(findNextPageLink(doc)).toBeNull();
  });

  it("rejects a 'next' link to a different origin", () => {
    // Otherwise a hostile result/footer anchor labelled "next" becomes an
    // extension-branded link to an attacker's origin.
    const doc = parseHTML(`<a rel="next" href="https://evil.example/steal">Next</a>`);
    Object.defineProperty(doc, "URL", {
      value: "https://yandex.com/search/?text=cats",
      configurable: true,
    });
    expect(findNextPageLink(doc)).toBeNull();
  });

  it("accepts a subdomain of the document host", () => {
    const doc = parseHTML(
      `<a rel="next" href="https://www.yandex.com/search?p=1">Next</a>`
    );
    Object.defineProperty(doc, "URL", {
      value: "https://yandex.com/search/?text=cats",
      configurable: true,
    });
    expect(findNextPageLink(doc)).toContain("www.yandex.com");
  });

  it("last match wins (bottom pager)", () => {
    const doc = parseHTML(
      `<a rel="next" href="/top">Next</a><a rel="next" href="/bottom">Next</a>`
    );
    Object.defineProperty(doc, "URL", {
      value: "https://example.com/",
      configurable: true,
    });
    expect(findNextPageLink(doc)).toBe("https://example.com/bottom");
  });
});

describe("visibleResultCount", () => {
  it("ignores results the engine has pre-rendered but not revealed", () => {
    const doc = parseHTML(
      `<ul>${RESULT("a.com")}<li class="serp-item" hidden>h</li>` +
        `<li class="serp-item" aria-hidden="true">a</li>` +
        `<li class="serp-item" style="display:none">s</li></ul>`
    );
    expect(visibleResultCount(nodesOf(doc))).toBe(1);
  });
});

describe("manager: generic delegation without adapter paging code", () => {
  it("delegates to the engine's own control and never fetches", async () => {
    document.body.innerHTML =
      `<ul id="results">${RESULT("a.com")}${RESULT("b.com")}</ul>` +
      `<button id="more" data-testid="more-results">More results</button>`;
    const container = document.querySelector("#results")!;
    const more = document.querySelector("#more") as HTMLButtonElement;

    let engineNode: Element | null = null;
    more.addEventListener("click", () => {
      engineNode = document.createElement("li");
      engineNode.className = "serp-item";
      engineNode.innerHTML =
        '<h2><a href="https://c.com/x">c</a></h2>';
      setTimeout(() => container.appendChild(engineNode!), 10);
    });

    const seen: Element[] = [];
    const manager = makeManager(stubEngine(), container, (n) => seen.push(...n));
    manager.init();

    expect(priv(manager).strategy).toBe("native");
    expect(container.querySelector("#is-sentinel")).toBeNull();

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await (priv(manager).fetchNextPage as () => Promise<void>).call(manager);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(engineNode);
  });

  it("honours an explicit fetch declaration even when a control exists", () => {
    // Yandex returns "fetch" on a classic pager SERP after its own detector
    // declined. Overriding that would call triggerNextPage on a page it
    // already rejected: it throws, burns three strikes, and never fetches.
    document.body.innerHTML =
      `<ul id="results">${RESULT("a.com")}</ul>` +
      `<button data-testid="more-results">More results</button>`;
    const manager = makeManager(
      stubEngine({
        getPagingStrategy: () => "fetch",
        getNextPageUrl: () => "https://example.com/search?p=2",
      }),
      document.querySelector("#results")!,
      () => {}
    );
    manager.init();
    expect(priv(manager).strategy).toBe("fetch");
  });

  it("seeds the deduper for native too, so replaced nodes are not re-emitted", async () => {
    document.body.innerHTML =
      `<ul id="results">${RESULT("a.com")}</ul>` +
      `<button id="more" data-testid="more-results">More results</button>`;
    const container = document.querySelector("#results")!;
    (document.querySelector("#more") as HTMLButtonElement).addEventListener("click", () => {
      // Engine REPLACES its nodes: page 1 comes back as a fresh element with
      // the same URL, plus one genuinely new result.
      container.innerHTML = RESULT("a.com") + RESULT("b.com");
    });
    const seen: Element[] = [];
    const manager = makeManager(stubEngine(), container, (n) => seen.push(...n));
    manager.init();
    await (priv(manager).fetchNextPage as () => Promise<void>).call(manager);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.querySelector("a")?.getAttribute("href")).toContain("b.com");
  });

  it("honours an explicit observe strategy even when a control exists", () => {
    document.body.innerHTML =
      `<ul id="results">${RESULT("a.com")}</ul>` +
      `<button data-testid="more-results">More results</button>`;
    const manager = makeManager(
      stubEngine({ getPagingStrategy: () => "observe" }),
      document.querySelector("#results")!,
      () => {}
    );
    manager.init();
    expect(priv(manager).strategy).toBe("observe");
    // Observe means: do not touch the list, do not press anything.
    expect(document.querySelector("#is-sentinel")).toBeNull();
  });

  it("falls back to fetch when the page has no native control", () => {
    document.body.innerHTML =
      `<ul id="results">${RESULT("a.com")}</ul>` +
      `<nav><a id="pnnext" href="https://example.com/search?p=2">Next</a></nav>`;
    const manager = makeManager(
      stubEngine({
        getNextPageUrl: () => "https://example.com/search?p=2",
      }),
      document.querySelector("#results")!,
      () => {}
    );
    manager.init();
    expect(priv(manager).strategy).toBe("fetch");
  });

  it("does not add a redundant fallback link when the page has its own", () => {
    document.body.innerHTML =
      `<ul id="results">${RESULT("a.com")}</ul>` +
      `<a rel="next" href="https://example.com/search?p=2">Next</a>`;
    const manager = makeManager(
      stubEngine(),
      document.querySelector("#results")!,
      () => {}
    );
    manager.init();
    expect(document.querySelector("#is-sentinel")).toBeNull();
  });

  it("finds a pager nested in a container child and inserts above it", () => {
    // Google's broad #center_col fallback: #navcnt lives inside #botstuff.
    // Now that the pager stays VISIBLE, an appended page must not land below it.
    document.body.innerHTML =
      `<div id="center_col">` +
      `<div id="rso"><div class="MjjYud"><a href="https://a.com/x"><h3>A</h3></a></div></div>` +
      `<div id="botstuff"><div id="navcnt"><a id="pnnext" href="/search?q=x&amp;start=10">Next</a></div></div>` +
      `</div>`;
    const container = document.querySelector("#center_col")!;
    const manager = makeManager(
      stubEngine({ getPaginationInterceptSelectors: () => ["#navcnt"] }),
      container,
      () => {}
    );
    expect(
      (priv(manager).findPagerInContainer as () => Element | null)()?.id
    ).toBe("botstuff");

    const page = document.createElement("div");
    page.textContent = "page2";
    (priv(manager).appendNodes as (n: Element[]) => void).call(manager, [page]);
    const wrapped = container.querySelector("[data-inf-page]") as HTMLElement;
    expect(wrapped).not.toBeNull();
    expect(wrapped.nextElementSibling?.id).toBe("botstuff");
  });

  it("drops pager nodes from fetched results via the INTERCEPT selectors", () => {
    document.body.innerHTML = `<ul id="results">${RESULT("a.com")}</ul>`;
    const manager = makeManager(
      stubEngine({
        getPaginationSelectors: () => [],
        getPaginationInterceptSelectors: () => [".pager"],
      }),
      document.querySelector("#results")!,
      () => {}
    );
    const doc = parseHTML(
      `<div class="pager">pager</div><li class="serp-item"><h2><a href="https://x.com/">x</a></h2></li>`
    );
    const filtered = (
      priv(manager).filterResults as (n: Element[]) => Element[]
    ).call(manager, Array.from(doc.body.children));
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.className).toBe("serp-item");
  });
});
