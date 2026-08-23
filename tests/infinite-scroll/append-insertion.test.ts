import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
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

describe("InfiniteScrollManager fetched-style porting", () => {
  // portStyles appends scoped sheets to the GLOBAL document.head — clean up
  // between tests so leftovers cannot masquerade as fresh ports.
  afterEach(() => {
    document.querySelectorAll("style[data-shh-fetched-style]").forEach((s) => s.remove());
  });

  /** Split flat CSS text into "selector{decls}" pairs. */
  function rules(cssText: string): string[] {
    return cssText
      .split("}")
      .map((chunk) => chunk.trim())
      .filter(Boolean);
  }

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

  it("scopes EVERY ported selector under [data-inf-page] so original results are unreachable", () => {
    const doc = parseHTML('<div id="results"><div class="r">r</div></div>');
    const container = doc.querySelector("#results")!;
    const manager = new InfiniteScrollManager(
      stubEngine(null), container, () => {}, { maxPages: 5, portFetchedStyles: true }
    );
    // Mirrors a real Startpage fetched build: theme tokens on body/:root,
    // emotion class rules mixing palette + layout, AND structural/element
    // rules (.w-gl, img, svg) that historically leaked onto page 1.
    const fetched = parseHTML(
      '<html><head><style>body{--text-color:#333}.css-abc{color:red;padding:4px}</style>' +
      '<style>:root{--x:1}.w-gl .result{margin:0;background:#fff}img{max-width:none}svg{display:inline}</style></head></html>'
    );
    const n = doc.createElement("div");
    callAppend(manager, [n], fetched);

    // Sheets land in <head>, not inside the page container.
    const page = container.querySelector("[data-inf-page]") as HTMLElement;
    expect(page.querySelectorAll("style[data-shh-fetched-style]").length).toBe(0);
    const headStyles = [...document.head.querySelectorAll("style[data-shh-fetched-style]")];
    expect(headStyles.length).toBe(2);

    const allPorted = headStyles.map((s) => s.textContent ?? "").join("\n");
    // Document-level rules are DROPPED entirely: they carry the fetched
    // build's server-default palette (light), which fights the user's live
    // theme (dark) applied client-side.
    expect(allPorted).not.toContain("--text-color");
    expect(allPorted).not.toContain("{--x:");
    expect(allPorted).not.toContain("body{");
    // …class and ELEMENT rules are prefixed…
    expect(allPorted).toContain("[data-inf-page] .css-abc");
    expect(allPorted).toContain("[data-inf-page] img");
    expect(allPorted).toContain("[data-inf-page] svg");
    expect(allPorted).toContain("[data-inf-page] .w-gl .result");
    // …PALETTE declarations are stripped from ported rules (layout survives):
    // fetched class rules encode the server-default light theme, which must
    // never recolor appended results' site links or favicon chips.
    expect(allPorted).not.toMatch(/(^|;|\{)color:/i);
    expect(allPorted).not.toContain("background");
    for (const rule of rules(allPorted)) {
      const decls = rule.slice(rule.indexOf("{") + 1);
      // every surviving rule still carries layout, and…
      expect(decls).toMatch(/margin|display|width|padding/);
      // …NOTHING is emitted unscoped: every selector starts with the scope.
      const sel = (rule.split("{")[0] ?? "").trim();
      expect(sel.startsWith("[data-inf-page]")).toBe(true);
    }
  });

  it("keeps sheets alive across page-container removal and dedupes by content", () => {
    const doc = parseHTML('<div id="results"><div class="r">r</div></div>');
    const container = doc.querySelector("#results")!;
    const manager = new InfiniteScrollManager(
      stubEngine(null), container, () => {}, { maxPages: 5, portFetchedStyles: true }
    );
    const sheetA = "<style>.css-a{color:red;display:flex}</style>";
    const fetched1 = parseHTML(`<html><head>${sheetA}</head></html>`);
    callAppend(manager, [doc.createElement("div")], fetched1);
    expect(document.head.querySelectorAll("style[data-shh-fetched-style]").length).toBe(1);

    // discardOldPages() removes whole page containers — the ported sheets
    // must not die with them.
    container.querySelector("[data-inf-page]")?.remove();
    expect(document.head.querySelectorAll("style[data-shh-fetched-style]").length).toBe(1);

    // Page 2 of the SAME search repeats sheet A (skipped) and adds sheet B.
    const fetched2 = parseHTML(`<html><head>${sheetA}<style>.css-b{margin:2px}</style></head></html>`);
    callAppend(manager, [doc.createElement("div")], fetched2);
    const texts = [...document.head.querySelectorAll("style[data-shh-fetched-style]")]
      .map((s) => s.textContent ?? "");
    expect(texts.length).toBe(2); // A once, B once
    expect(texts.filter((t) => t?.includes(".css-a")).length).toBe(1);
    expect(texts.some((t) => t?.includes(".css-b"))).toBe(true);
  });

  it("drops unparsable sheets instead of porting them unscoped", () => {
    const doc = parseHTML('<div id="results"><div class="r">r</div></div>');
    const container = doc.querySelector("#results")!;
    const manager = new InfiniteScrollManager(
      stubEngine(null), container, () => {}, { maxPages: 5, portFetchedStyles: true }
    );
    const fetched = parseHTML('<html><head><style>@import "https://evil.test/x.css";</style></head></html>');
    const spy = vi.spyOn(manager as unknown as { scopeCss: unknown }, "scopeCss", "get")
      .mockImplementation(() => { throw new Error("parse boom"); });
    try {
      callAppend(manager, [doc.createElement("div")], fetched);
    } finally {
      spy.mockRestore();
    }
    // The catch path must swallow it WITHOUT emitting raw CSS anywhere.
    expect(document.querySelectorAll("style[data-shh-fetched-style]").length).toBe(0);
  });

  it("strips inline <style> tags from fetched nodes and HARVESTS their layout onto matched elements inline", () => {
    const doc = parseHTML('<div id="results"></div>');
    const container = doc.querySelector("#results")!;
    const manager = new InfiniteScrollManager(
      stubEngine(null), container, () => {}, { maxPages: 5 }
    );
    const node = doc.createElement("div");
    node.innerHTML =
      '<style>.css-x{color:#202945;padding:4px}</style>' +
      '<a href="https://example.com/">title</a>' +
      '<span class="css-x">snippet</span>';
    callAppend(manager, [node]);

    const page = container.querySelector("[data-inf-page]") as HTMLElement;
    // No fetched <style> may enter the live document…
    expect(page.querySelectorAll("style").length).toBe(0);
    // …but its LAYOUT survives, stamped inline on the matched element…
    const span = page.querySelector("span.css-x") as HTMLElement;
    expect(span.style.padding).toBe("4px");
    // …while its PALETTE is dropped (live-theme re-skin owns colors).
    expect(span.style.color).toBe("");
    // content survives
    expect(page.textContent).toContain("title");
    expect(page.textContent).toContain("snippet");
  });

  it("preserves background-image on favicon elements (it IS the icon) but drops their chip paint", () => {
    const doc = parseHTML('<div id="results"></div>');
    const container = doc.querySelector("#results")!;
    const manager = new InfiniteScrollManager(
      stubEngine(null), container, () => {}, { maxPages: 5 }
    );
    const node = doc.createElement("div");
    // Mirrors real Startpage markup: white circular chip class + per-result
    // icon class painting the favicon via background-image.
    node.innerHTML =
      '<style>.chip{background-color:#ffffff;width:28px;height:28px;border-radius:50%}</style>' +
      '<style>.icon{background-image:url(https://www.startpage.com/sp/ico.png)}</style>' +
      '<span class="favicon-container chip"><span class="icon"></span></span>';
    callAppend(manager, [node]);

    const page = container.querySelector("[data-inf-page]") as HTMLElement;
    expect(page.querySelectorAll("style").length).toBe(0);
    const chip = page.querySelector(".chip") as HTMLElement;
    const icon = page.querySelector(".icon") as HTMLElement;
    // The ICON survives…
    expect(icon.style.backgroundImage).toContain("ico.png");
    // …while the light-theme chip paint (white fill) is stripped…
    expect(chip.style.backgroundColor).toBe("");
    // …and chip geometry (circle) is kept.
    expect(chip.style.borderRadius).toBe("50%");
    expect(chip.style.width).toBe("28px");
  });

  it("re-skins appended clones with the LIVE page's text colors when portFetchedStyles is on", () => {
    // Live results must exist in the REAL jsdom document — production
    // measures them with window.getComputedStyle (foreign-document nodes
    // are deliberately skipped by the implementation).
    const container = document.createElement("div");
    document.body.appendChild(container);
    const liveResult = document.createElement("div");
    liveResult.innerHTML =
      '<a class="result-title" href="https://live.test/1">t</a><p class="description">s</p>';
    // jsdom's getComputedStyle has no UA color defaults — give the live
    // fixture explicit "theme" colors to measure.
    (liveResult.querySelector("a") as HTMLElement).style.color = "rgb(18, 52, 86)";
    (liveResult.querySelector("p") as HTMLElement).style.color = "rgb(120, 120, 128)";
    document.body.appendChild(liveResult);

    try {
      const engine = {
        ...stubEngine(null),
        getFetchWrapper: () => null,
      } as unknown as EngineAdapter;
      const manager = new InfiniteScrollManager(
        engine, container, () => {}, { maxPages: 5, portFetchedStyles: true }
      );

      // jsdom returns rgb(0, 0, 0) for unstyled elements — that IS our
      // "measured live theme" reference for this test.
      const fetched = parseHTML(
        '<html><head></head><body><div class="result">' +
        '<a class="result-title" href="https://a.com/2">fetched title</a>' +
        '<p class="description">fetched snippet</p>' +
        '</div></body></html>'
      );
      const nodes = Array.from(fetched.querySelectorAll("div.result"));
      // sourceDoc must be passed — the re-skin only runs for fetched pages.
      callAppend(manager, nodes, fetched);

      const page = container.querySelector("[data-inf-page]") as HTMLElement;
      const title = page.querySelector("a.result-title") as HTMLElement;
      expect(title.style.color).toBe("rgb(18, 52, 86)"); // measured from live page-1
      const snippet = page.querySelector("p.description") as HTMLElement;
      expect(snippet.style.color).toBe("rgb(120, 120, 128)");
    } finally {
      container.remove();
      liveResult.remove();
    }
  });

  it("tints the title's styled CHILD (h2.wgl-title) — 2026 Startpage anatomy", () => {
    // 2026 anatomy: a.result-title > h2.wgl-title carries the visible text
    // AND its own emotion color rule; the anchor's inline color cannot
    // reach it (child rule beats inheritance). The :visited purple variant
    // (css-1bggj8v:visited h2) must likewise be overridden inline.
    const container = document.createElement("div");
    document.body.appendChild(container);
    const liveResult = document.createElement("div");
    liveResult.innerHTML =
      '<a class="result-title" href="https://live.test/1"><h2 class="wgl-title">L</h2></a>';
    // Production measures the ANCHOR (2026 anatomy: .css-1bggj8v sets the
    // literal color ON a.result-title); the h2 carries it visually too.
    (liveResult.querySelector("a") as HTMLElement).style.color = "rgb(167, 177, 252)";
    (liveResult.querySelector("h2") as HTMLElement).style.color = "rgb(167, 177, 252)";
    document.body.appendChild(liveResult);

    try {
      const engine = {
        ...stubEngine(null),
        getFetchWrapper: () => null,
      } as unknown as EngineAdapter;
      const manager = new InfiniteScrollManager(
        engine, container, () => {}, { maxPages: 5, portFetchedStyles: true }
      );
      const node = container.ownerDocument.createElement("div");
      node.innerHTML =
        '<a class="result-title result-link css-1bggj8v" href="https://visited.example/x">' +
        '<h2 class="wgl-title css-i3irj7">Fetched title</h2></a>';
      callAppend(manager, [node], parseHTML("<html><head></head></html>"));

      const page = container.querySelector("[data-inf-page]") as HTMLElement;
      const h2 = page.querySelector("h2.wgl-title") as HTMLElement;
      // Inline color ON the h2 — beats its class rule and :visited variant.
      expect(h2.style.color).toBe("rgb(167, 177, 252)");
      const anchor = page.querySelector("a.result-title") as HTMLElement;
      expect(anchor.style.color).toBe("rgb(167, 177, 252)");
    } finally {
      container.remove();
      liveResult.remove();
    }
  });

  it("assigns favicons to clone chips: live-pattern substitution, DDG fallback, skips painted chips", async () => {
    const doc = parseHTML('<div id="results"></div>');
    const container = doc.querySelector("#results")!;
    // Stub the live-pattern learner — no global stylesheet injection
    // (jsdom applies document.head styles across tests and poisons them).
    const mkEngine = () => {
      const e = { ...stubEngine(null) } as unknown as EngineAdapter & { urlMap: Record<string, string> };
      (e as unknown as { urlMap: Record<string, string> }).urlMap = {};
      e.getResultUrl = (n: Element) =>
        ((e as unknown as { urlMap: Record<string, string> }).urlMap[n.getAttribute("data-k") ?? ""]) ?? null;
      return e;
    };
    const engine = mkEngine();
    const manager2 = new InfiniteScrollManager(
      engine, container, () => {}, { maxPages: 5, portFetchedStyles: true }
    );
    const learn2 = vi.spyOn(
      manager2 as unknown as { learnLiveFaviconPattern(): string | null },
      "learnLiveFaviconPattern"
    ).mockReturnValue("https://www.startpage.com/sp/cdn/favicons/favicon?h={domain}");

    const fetched = parseHTML(
      '<html><head></head><body>' +
      '<div class="result" data-k="a"><span class="favicon-container"></span><a href="https://x.example/">t</a></div>' +
      '<div class="result" data-k="b"><span class="favicon-container"></span><a href="https://y.example/">t</a></div>' +
      '<div class="result" data-k="c"><span class="favicon-container" style="background-image:url(https://z.cdn/i.png)"></span><a href="https://z.example/">t</a></div>' +
      '</body></html>'
    );
    const nodes = Array.from(fetched.querySelectorAll("div.result"));
    const urls: Record<string, string> = { a: "https://aaa.example.com/", b: "https://bbb.example.com/", c: "https://ccc.example.com/" };
    for (const n of nodes) {
      const k = n.getAttribute("data-k") ?? "";
      (engine as unknown as { urlMap: Record<string, string> }).urlMap[k] = urls[k] ?? "";
    }
    callAppend(manager2, nodes, fetched);

    try {
      const page = container.querySelector("[data-inf-page]") as HTMLElement;
      const chips = Array.from(page.querySelectorAll<HTMLElement>(".favicon-container"));
      expect(chips.length).toBe(3);
      // Painted immediately, ON the chip (single layer — no child span).
      expect(chips[0]!.style.backgroundImage).toContain("aaa.example.com");
      expect(chips[0]!.style.backgroundImage).toContain("startpage.com");
      expect(chips[1]!.style.backgroundImage).toContain("bbb.example.com");
      // Already-painted chip untouched.
      expect(chips[2]!.style.backgroundImage).toContain("z.cdn/i.png");
    } finally {
      learn2.mockRestore();
    }
  });

  it("clears letter-avatar content before painting (no doubled icons)", () => {
    const doc = parseHTML('<div id="results"></div>');
    const container = doc.querySelector("#results")!;
    const manager = new InfiniteScrollManager(
      {
        ...stubEngine(null),
        getResultUrl: () => "https://somesite.example/page",
      } as unknown as EngineAdapter,
      container, () => {}, { maxPages: 5, portFetchedStyles: true, allowThirdPartyIcons: true }
    );
    vi.spyOn(
      manager as unknown as { learnLiveFaviconPattern(): string | null },
      "learnLiveFaviconPattern"
    ).mockReturnValue(null);
    // Real chips carry letter-avatar text ("D", "EF") — that content is
    // what earlier builds painted BESIDE, producing doubles.
    const node = doc.createElement("div");
    node.innerHTML =
      '<span class="favicon-container">D</span><a href="https://somesite.example/page">t</a>';
    callAppend(manager, [node], parseHTML("<html><head></head></html>"));

    try {
      const page = container.querySelector("[data-inf-page]") as HTMLElement;
      const chip = page.querySelector(".favicon-container") as HTMLElement;
      expect(chip.textContent).toBe("");            // avatar gone…
      expect(chip.style.backgroundImage).toContain("icons.duckduckgo.com"); // …icon on
      expect(chip.querySelectorAll("*").length).toBe(0); // no extra layers
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("falls back to DuckDuckGo icon service when no live pattern is learnable", () => {
    const doc = parseHTML('<div id="results"></div>');
    const container = doc.querySelector("#results")!;
    const manager = new InfiniteScrollManager(
      {
        ...stubEngine(null),
        getResultUrl: () => "https://somesite.example/page",
      } as unknown as EngineAdapter,
      container, () => {}, { maxPages: 5, portFetchedStyles: true, allowThirdPartyIcons: true }
    );
    // No live chip → learner returns null in this environment naturally;
    // pin it explicitly so the test is deterministic.
    const learn = vi.spyOn(
      manager as unknown as { learnLiveFaviconPattern(): string | null },
      "learnLiveFaviconPattern"
    ).mockReturnValue(null);
    const node = doc.createElement("div");
    node.innerHTML = '<span class="favicon-container"></span><a href="https://somesite.example/page">t</a>';
    callAppend(manager, [node], parseHTML("<html><head></head></html>"));

    try {
      const page = container.querySelector("[data-inf-page]") as HTMLElement;
      const chip = page.querySelector(".favicon-container") as HTMLElement;
      expect(chip.style.backgroundImage).toContain("icons.duckduckgo.com/ip3/somesite.example.ico");
    } finally {
      learn.mockRestore();
    }
  });

  it("DDG fallback is OPT-IN: without allowThirdPartyIcons no icon URL is painted", () => {
    const doc = parseHTML('<div id="results"></div>');
    const container = doc.querySelector("#results")!;
    const manager = new InfiniteScrollManager(
      {
        ...stubEngine(null),
        getResultUrl: () => "https://somesite.example/page",
      } as unknown as EngineAdapter,
      container, () => {}, { maxPages: 5, portFetchedStyles: true } // NO opt-in
    );
    vi.spyOn(
      manager as unknown as { learnLiveFaviconPattern(): string | null },
      "learnLiveFaviconPattern"
    ).mockReturnValue(null);
    const node = doc.createElement("div");
    node.innerHTML =
      '<span class="favicon-container">S</span><a href="https://somesite.example/page">t</a>';
    callAppend(manager, [node], parseHTML("<html><head></head></html>"));

    try {
      const page = container.querySelector("[data-inf-page]") as HTMLElement;
      const chip = page.querySelector(".favicon-container") as HTMLElement;
      // No third-party consent -> no paint at all; SSR letter avatar kept.
      expect(chip.style.backgroundImage).toBe("");
      expect(chip.textContent).toBe("S");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("recaptures page-1 favicon intel when the first snapshot was EMPTY (late hydration)", () => {
    const doc = parseHTML('<div id="results"></div>');
    const container = doc.querySelector("#results")!;
    const engine = {
      ...stubEngine(null),
      getResultUrl: (n: Element) =>
        n.getAttribute("data-k") === "a" ? "https://livesite.example/" : null,
    } as unknown as EngineAdapter;
    const manager = new InfiniteScrollManager(
      engine, container, () => {}, { maxPages: 5, portFetchedStyles: true }
    );

    // Append #1: page-1 has NO painted chips yet (hydration hasn't run).
    const early = doc.createElement("div");
    early.setAttribute("data-k", "a");
    early.innerHTML =
      '<span class="favicon-container">L</span><a href="https://livesite.example/">t</a>';
    callAppend(manager, [early], parseHTML("<html><head></head></html>"));
    const page1 = container.querySelector("[data-inf-page]") as HTMLElement;
    const earlyChip = page1.querySelector(".favicon-container") as HTMLElement;
    // Empty intel must NOT be frozen into a broken paint...
    expect(earlyChip.style.backgroundImage).toBe("");

    // ...hydration then paints page-1 (first-party endpoint).
    const live = document.createElement("div");
    live.innerHTML =
      '<span class="favicon-container" style="background-image:url(https://www.startpage.com/sp/cdn/favicons/favicon?h=livesite.example)"></span>' +
      '<a href="https://livesite.example/">t</a>';
    document.body.appendChild(live);

    // Append #2: empty snapshot must be RETRIED and the domain stolen.
    const later = doc.createElement("div");
    later.setAttribute("data-k", "a");
    later.innerHTML =
      '<span class="favicon-container">L</span><a href="https://livesite.example/">t</a>';
    callAppend(manager, [later], parseHTML("<html><head></head></html>"));

    try {
      const pages = container.querySelectorAll("[data-inf-page]");
      const laterChip = pages[1]!.querySelector(".favicon-container") as HTMLElement;
      // Same-domain page-1 artwork stolen — the frozen-empty bug left this blank.
      expect(laterChip.style.backgroundImage).toContain("startpage.com");
      expect(laterChip.style.backgroundImage).toContain("livesite.example");
    } finally {
      live.remove();
    }
  });

  it("paints ONLY the innermost favicon layer — never wipes nested chip markup", () => {
    const doc = parseHTML('<div id="results"></div>');
    const container = doc.querySelector("#results")!;
    const manager = new InfiniteScrollManager(
      {
        ...stubEngine(null),
        getResultUrl: () => "https://somesite.example/page",
      } as unknown as EngineAdapter,
      container, () => {}, { maxPages: 5, portFetchedStyles: true, allowThirdPartyIcons: true }
    );
    vi.spyOn(
      manager as unknown as { learnLiveFaviconPattern(): string | null },
      "learnLiveFaviconPattern"
    ).mockReturnValue(null);
    // Real archived-SERP anatomy: a.favicon-link > .favicon-container > .favicon.
    // An earlier build matched all three and cleared the ANCHOR's content,
    // deleting the whole chip subtree off the page.
    const node = doc.createElement("div");
    node.innerHTML =
      '<a class="favicon-link"><span class="link-text"></span>' +
      '<div class="favicon-container css-chip"><div class="favicon css-icon"></div></div></a>' +
      '<a href="https://somesite.example/page">t</a>';
    callAppend(manager, [node], parseHTML("<html><head></head></html>"));

    try {
      const page = container.querySelector("[data-inf-page]") as HTMLElement;
      const anchor = page.querySelector("a.favicon-link") as HTMLElement;
      const cont = anchor.querySelector(".favicon-container") as HTMLElement | null;
      // Chip subtree SURVIVED inside its anchor…
      expect(cont).not.toBeNull();
      expect(anchor.querySelectorAll("*").length).toBeGreaterThanOrEqual(3);
      // …the INNERMOST layer got the paint, wrappers stayed clean.
      const icon = page.querySelector("div.favicon.css-icon") as HTMLElement;
      expect(icon.style.backgroundImage).toContain("icons.duckduckgo.com");
      expect(cont!.style.backgroundImage).toBe("");
      expect(anchor.style.backgroundImage).toBe("");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("strips palette from INLINE style attributes but keeps favicon icon backgrounds", () => {
    const doc = parseHTML('<div id="results"></div>');
    const container = doc.querySelector("#results")!;
    const manager = new InfiniteScrollManager(
      stubEngine(null), container, () => {}, { maxPages: 5, portFetchedStyles: true }
    );
    const fetched = parseHTML(
      '<html><head></head><body>' +
      '<div class="result" style="color:#202945;margin-top:4px">' +
      '<span class="favicon-container css-chip" style="background-color:#ffffff;background-image:url(https://www.startpage.com/sp/cdn/i/icon.png);border-radius:50%">' +
      '<div class="favicon css-icon" style="width:16px;height:16px"></div></span>' +
      '<a class="wgl-site-title" href="https://x.example/" style="color:#202945;display:inline-block">T</a>' +
      '</div></body></html>'
    );
    const nodes = Array.from(fetched.querySelectorAll("div.result"));
    callAppend(manager, nodes, fetched);

    try {
      const page = container.querySelector("[data-inf-page]") as HTMLElement;
      const result = page.querySelector("div.result") as HTMLElement;
      // Layout survives, palette does not…
      expect(result.getAttribute("style")).toContain("margin-top:4px");
      expect(result.getAttribute("style")).not.toContain("#202945");
      // …icon background inside the favicon subtree survives, chip paint goes,
      // geometry (border-radius) stays.
      const chip = page.querySelector(".favicon-container") as HTMLElement;
      expect(chip.getAttribute("style")).toContain("background-image:url(https://www.startpage.com/sp/cdn/i/icon.png)");
      expect(chip.getAttribute("style")).not.toContain("background-color");
      expect(chip.getAttribute("style")).toContain("border-radius:50%");
      const title = page.querySelector("a.wgl-site-title") as HTMLElement;
      expect(title.getAttribute("style")).toBe("display:inline-block");
    } finally {
      container.remove();
    }
  });

  it("fills the URL-line slot from aria-label and tints it with the live theme color", () => {
    // Live page-1 references (outside any [data-inf-page]).
    const liveResult = document.createElement("div");
    liveResult.innerHTML =
      '<a class="result-title" style="color:rgb(18,52,86)">L</a>' +
      '<p class="description" style="color:rgb(120,120,128)">S</p>' +
      '<a class="wgl-display-url" href="https://l.example/" aria-label="https://l.example/" ' +
      'style="color:rgb(90,90,100)"><span class="link-text"></span></a>';
    document.body.appendChild(liveResult);
    const doc = parseHTML('<div id="results"></div>');
    const container = doc.querySelector("#results")!;
    const manager = new InfiniteScrollManager(
      stubEngine(null), container, () => {}, { maxPages: 5, portFetchedStyles: true }
    );
    try {
      // Clone ships the URL-line slot EMPTY (hydration normally fills it)
      // plus the mobile-variant span that carries navy via its class rule.
      const node = doc.createElement("div");
      node.innerHTML =
        '<a class="wgl-site-title" href="https://c.example/">Title</a>' +
        '<a class="wgl-display-url" href="https://c.example/" aria-label="https://c.example/">' +
        '<span class="link-text"></span>' +
        '<span class="link-text default-link-text css-1h1cbur">#202C46</span></a>';
      callAppend(manager, [node], parseHTML("<html><head></head></html>"));

      const page = container.querySelector("[data-inf-page]") as HTMLElement;
      const a = page.querySelector("a.wgl-display-url") as HTMLElement;
      const spans = Array.from(a.querySelectorAll<HTMLElement>("span[class*='link-text' i]"));
      const slot = spans[0]!;
      const mobileVariant = spans[1]!;
      expect(slot.textContent).toBe("https://c.example/");   // hydration fill
      expect(mobileVariant.style.display).toBe("none");       // navy variant hidden
      // Tint landed ON the visible span, in the live theme color.
      expect(slot.style.color).toBe("rgb(90, 90, 100)");
      const siteTitle = page.querySelector("a.wgl-site-title") as HTMLElement;
      expect(siteTitle.style.color).toBe("rgb(18, 52, 86)");
    } finally {
      liveResult.remove();
      container.remove();
    }
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
    expect(document.querySelectorAll("style[data-shh-fetched-style]").length).toBe(0);
  });
});

describe("InfiniteScrollManager scroll restoration", () => {
  const KEY = "shh_infscroll_state";
  const docSH = Object.getOwnPropertyDescriptor(Document.prototype, "scrollHeight");
  const winIH = Object.getOwnPropertyDescriptor(Window.prototype, "innerHeight");

  function seedState(scrollY: number, loadedPages: number): void {
    localStorage.setItem(KEY, JSON.stringify({
      url: window.location.href, scrollY, loadedUrls: [], loadedPages,
      timestamp: Date.now(),
    }));
  }

  function mockNavType(type: string): void {
    vi.spyOn(performance, "getEntriesByType").mockImplementation(((t: string) =>
      t === "navigation" ? [{ type }] : []
    ) as unknown as typeof performance.getEntriesByType);
  }

  function mockDocMetrics(scrollHeight: number, innerHeight: number): void {
    Object.defineProperty(document, "documentElement", {
      value: Object.assign(document.createElement("html"), {}) , configurable: true,
    });
    // jsdom has no layout engine — scrollHeight/innerHeight are stubbed so
    // the clamp-guard can be exercised deterministically.
    Object.defineProperty(document.documentElement, "scrollHeight", {
      get: () => scrollHeight, configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      get: () => innerHeight, configurable: true,
    });
  }

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    if (docSH) Object.defineProperty(document, "documentElement", { ...docSH, configurable: true });
    if (winIH) Object.defineProperty(window, "innerHeight", { ...winIH, configurable: true });
  });

  it("does NOT restore on a fresh navigation — re-searching opens at the TOP", async () => {
    seedState(5000, 3); // deep offset from an earlier session on this URL
    mockNavType("navigate");
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const manager = new InfiniteScrollManager(stubEngine(null), document.body, () => {}, {});
    (manager as unknown as { tryRestoreScroll(): void }).tryRestoreScroll();
    await new Promise((r) => setTimeout(r, 40));
    expect(scrollTo).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeNull(); // one-shot state consumed
  });

  it("still restores on reload when extra pages were loaded and content is tall enough", async () => {
    mockDocMetrics(30000, 800);
    seedState(500, 2);
    mockNavType("reload");
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const manager = new InfiniteScrollManager(stubEngine(null), document.body, () => {}, {});
    (manager as unknown as { tryRestoreScroll(): void }).tryRestoreScroll();
    await new Promise((r) => setTimeout(r, 40));
    expect(scrollTo).toHaveBeenCalledWith(0, 500);
  });

  it("refuses to clamp-jump when the saved offset exceeds the current document", async () => {
    mockDocMetrics(3000, 800); // only page 1's worth of content exists now
    seedState(25000, 4); // deep-scroll position from pages that are NOT re-fetched on load
    mockNavType("back_forward");
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const manager = new InfiniteScrollManager(stubEngine(null), document.body, () => {}, {});
    (manager as unknown as { tryRestoreScroll(): void }).tryRestoreScroll();
    await new Promise((r) => setTimeout(r, 40));
    expect(scrollTo).not.toHaveBeenCalled(); // browser would clamp this to bottom-of-page-1
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
