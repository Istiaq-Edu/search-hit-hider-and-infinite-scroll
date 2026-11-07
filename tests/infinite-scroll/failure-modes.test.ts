import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { InfiniteScrollManager } from "../../src/content/infinite-scroll/manager";
import { fetchPage } from "../../src/content/infinite-scroll/fetcher";
import type { EngineAdapter } from "../../src/content/engines/base";

// ============================================================
// Infinite-scroll failure modes:
//  • terminal fetch failures must hand the native pager back;
//  • pager interception must stay scoped to numeric pagination links and
//    must not clone anchors (which destroyed the engine's own handlers);
//  • teardown must remove ported style tags;
//  • a persisted deep offset must replay the recorded pages before
//    restoring, instead of silently clearing the state.
// ============================================================

class FakeIntersectionObserver {
  constructor(_cb: IntersectionObserverCallback, _opts?: IntersectionObserverInit) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

const NEXT_URL = "https://www.google.com/search?q=test&start=10";
const KEY = "shh_infscroll_state";

function makeEngine(opts: { pagination?: string[] } = {}): EngineAdapter {
  return {
    id: "google",
    name: "Google",
    matches: () => true,
    getResultNodes: (doc) => Array.from((doc as ParentNode).querySelectorAll(".kb0PBd")),
    getResultUrl: (node) => node.querySelector("a")?.getAttribute("href") ?? null,
    getButtonTarget: () => null,
    getInsertionAnchor: () => null,
    getNextPageUrl: (doc) => doc.querySelector<HTMLAnchorElement>("#pnnext")?.href ?? null,
    getPaginationSelectors: () => opts.pagination ?? [],
  } as EngineAdapter;
}

function pageMarkup(): string {
  return (
    `<div id="rso"><div class="kb0PBd"><a href="https://a.com/x">a</a></div></div>` +
    `<nav id="pager"><a id="pnnext" href="${NEXT_URL}">Next</a></nav>`
  );
}

let managers: InfiniteScrollManager[] = [];
let restoreMetrics: Array<() => void> = [];

function stubMetrics(scrollHeight: number, innerHeight: number): void {
  const prevSH = Object.getOwnPropertyDescriptor(document.documentElement, "scrollHeight");
  const prevIH = Object.getOwnPropertyDescriptor(window, "innerHeight");
  Object.defineProperty(document.documentElement, "scrollHeight", {
    get: () => scrollHeight,
    configurable: true,
  });
  Object.defineProperty(window, "innerHeight", {
    get: () => innerHeight,
    configurable: true,
  });
  restoreMetrics.push(() => {
    if (prevSH) Object.defineProperty(document.documentElement, "scrollHeight", prevSH);
    else delete (document.documentElement as unknown as Record<string, unknown>).scrollHeight;
    if (prevIH) Object.defineProperty(window, "innerHeight", prevIH);
    else delete (window as unknown as Record<string, unknown>).innerHeight;
  });
}

function mockNavType(type: string): void {
  vi.spyOn(performance, "getEntriesByType").mockImplementation(((t: string) =>
    t === "navigation" ? [{ type }] : []
  ) as unknown as typeof performance.getEntriesByType);
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  document.body.innerHTML = pageMarkup();
});

afterEach(() => {
  for (const m of managers) m.destroy();
  managers = [];
  for (const restore of restoreMetrics) restore();
  restoreMetrics = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView;
  document.body.innerHTML = "";
  localStorage.clear();
  history.replaceState({}, "", "/");
});

describe("terminal failures restore the native pager", () => {
  it("un-hides the pager after the 3-strike fetch budget is exhausted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, url: NEXT_URL, redirected: false, text: async () => "" }))
    );
    const manager = new InfiniteScrollManager(
      makeEngine({ pagination: ["#pager"] }),
      document.querySelector("#rso")!,
      () => {},
      { fetchDelay: 0, maxPages: 10 }
    );
    managers.push(manager);
    manager.init();

    const pager = document.querySelector<HTMLElement>("#pager")!;
    expect(pager.style.display).toBe("none");

    const fetchNext = (manager as unknown as { fetchNextPage(): Promise<void> }).fetchNextPage;
    await fetchNext.call(manager);
    await fetchNext.call(manager);
    await fetchNext.call(manager);

    expect((manager as unknown as { hasMore: boolean }).hasMore).toBe(false);
    expect(pager.style.display).toBe("");
  });
});

describe("pager interception", () => {
  it("only intercepts numeric page links and survives teardown without cloning", () => {
    const scrollSpy = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: scrollSpy,
      configurable: true,
      writable: true,
    });
    const container = document.querySelector<HTMLElement>("#rso")!;
    container.insertAdjacentHTML(
      "beforeend",
      `<div data-inf-page="2"></div><div data-inf-page="10"></div>`
    );
    document.querySelector("#pager")!.insertAdjacentHTML(
      "beforeend",
      `<a id="p2" href="/search?q=test&start=10">2</a>` +
        `<a id="p10" href="/search?q=test&start=90">10 best VPNs</a>`
    );
    let engineClicks = 0;
    document.querySelector("#p2")!.addEventListener("click", (e) => {
      engineClicks++;
      e.preventDefault();
    });

    const manager = new InfiniteScrollManager(
      makeEngine({ pagination: ["#pager"] }),
      container,
      () => {},
      { fetchDelay: 0, maxPages: 10 }
    );
    managers.push(manager);
    manager.init();
    (manager as unknown as { restorePagination(): void }).restorePagination();

    const p2 = document.querySelector<HTMLAnchorElement>("#p2")!;
    const p10 = document.querySelector<HTMLAnchorElement>("#p10")!;
    expect(p2.hasAttribute("data-inf-intercept")).toBe(true);
    // parseInt("10 best VPNs") === 10, but a result title is not a page link.
    expect(p10.hasAttribute("data-inf-intercept")).toBe(false);

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    p2.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });

    manager.destroy();
    expect(p2.hasAttribute("data-inf-intercept")).toBe(false);
    // The engine's own listener must still exist after teardown.
    p2.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(engineClicks).toBe(2);
  });
});

describe("teardown cleanup", () => {
  it("removes ported fetched-page styles", () => {
    const manager = new InfiniteScrollManager(
      makeEngine(),
      document.querySelector("#rso")!,
      () => {},
      { portFetchedStyles: true }
    );
    managers.push(manager);
    const fetched = new DOMParser().parseFromString(
      "<html><head><style>.fetched-only{display:flex}</style></head><body></body></html>",
      "text/html"
    );
    (manager as unknown as { portStyles(doc: Document): void }).portStyles(fetched);
    expect(document.querySelectorAll("style[data-shh-fetched-style]").length).toBe(1);

    manager.destroy();
    expect(document.querySelectorAll("style[data-shh-fetched-style]").length).toBe(0);
  });
});

describe("scroll-state replay", () => {
  it("re-fetches recorded pages, then restores the saved offset", async () => {
    stubMetrics(5_000, 800);
    mockNavType("reload");
    localStorage.setItem(
      KEY,
      JSON.stringify({
        url: window.location.href,
        scrollY: 20_000,
        loadedPages: 2,
        loadedUrls: [NEXT_URL],
        loadedRequests: [{ url: NEXT_URL }],
        timestamp: Date.now(),
      })
    );
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      url: NEXT_URL,
      redirected: false,
      text: async () =>
        `<div id="rso"><div class="kb0PBd"><a href="https://b.com/y">b</a></div></div>` +
        `<a id="pnnext" href="https://www.google.com/search?q=test&start=20">Next</a>`,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const scrollSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    const manager = new InfiniteScrollManager(
      makeEngine(),
      document.querySelector("#rso")!,
      () => {},
      { fetchDelay: 0, maxPages: 10, persist: true }
    );
    managers.push(manager);
    (manager as unknown as { tryRestoreScroll(): void }).tryRestoreScroll();

    await new Promise((r) => setTimeout(r, 80));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-inf-page="2"]')).not.toBeNull();
    expect(scrollSpy).toHaveBeenCalledWith(0, 4_200);
    expect((manager as unknown as { isLoading: boolean }).isLoading).toBe(false);
  });

  it("never fetches a saved request this engine would not have issued", async () => {
    stubMetrics(5_000, 800);
    mockNavType("reload");
    localStorage.setItem(
      KEY,
      JSON.stringify({
        url: window.location.href,
        scrollY: 20_000,
        loadedPages: 2,
        loadedUrls: ["https://evil.example/x"],
        loadedRequests: [{ url: "https://evil.example/x" }],
        timestamp: Date.now(),
      })
    );
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      url: NEXT_URL,
      redirected: false,
      text: async () => pageMarkup(),
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    const engine = makeEngine();
    engine.matches = (url: URL) => url.hostname === "www.google.com";
    const manager = new InfiniteScrollManager(
      engine,
      document.querySelector("#rso")!,
      () => {},
      { fetchDelay: 0, maxPages: 10, persist: true }
    );
    managers.push(manager);
    (manager as unknown as { tryRestoreScroll(): void }).tryRestoreScroll();

    await new Promise((r) => setTimeout(r, 60));

    expect(fetchMock).not.toHaveBeenCalled();
    expect((manager as unknown as { isReplaying: boolean }).isReplaying).toBe(false);
    expect((manager as unknown as { isLoading: boolean }).isLoading).toBe(false);
  });

  it("releases isLoading and the sentinel when applying a replayed page throws", async () => {
    stubMetrics(5_000, 800);
    mockNavType("reload");
    localStorage.setItem(
      KEY,
      JSON.stringify({
        url: window.location.href,
        scrollY: 20_000,
        loadedPages: 2,
        loadedUrls: [NEXT_URL],
        loadedRequests: [{ url: NEXT_URL }],
        timestamp: Date.now(),
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        url: NEXT_URL,
        redirected: false,
        text: async () => pageMarkup(),
      }))
    );
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    const engine = makeEngine();
    engine.getResultNodes = (doc) => {
      if (doc !== document) throw new Error("markup drift");
      return Array.from((doc as ParentNode).querySelectorAll(".kb0PBd"));
    };
    const manager = new InfiniteScrollManager(
      engine,
      document.querySelector("#rso")!,
      () => {},
      { fetchDelay: 0, maxPages: 10, persist: true }
    );
    managers.push(manager);
    manager.init();

    await new Promise((r) => setTimeout(r, 80));

    expect((manager as unknown as { isLoading: boolean }).isLoading).toBe(false);
    expect((manager as unknown as { isReplaying: boolean }).isReplaying).toBe(false);
    expect(document.querySelector("#is-sentinel")?.innerHTML).not.toContain(
      "Loading more results"
    );
  });

  it("does not overwrite the saved record with the in-progress replay", async () => {
    stubMetrics(5_000, 800);
    mockNavType("reload");
    localStorage.setItem(
      KEY,
      JSON.stringify({
        url: window.location.href,
        scrollY: 20_000,
        loadedPages: 2,
        loadedUrls: [NEXT_URL],
        loadedRequests: [{ url: NEXT_URL }],
        timestamp: Date.now(),
      })
    );
    let resolveFetch!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          })
      )
    );
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    const manager = new InfiniteScrollManager(
      makeEngine(),
      document.querySelector("#rso")!,
      () => {},
      { fetchDelay: 0, maxPages: 10, persist: true }
    );
    managers.push(manager);
    manager.init();

    await new Promise((r) => setTimeout(r, 20));
    expect((manager as unknown as { isReplaying: boolean }).isReplaying).toBe(true);

    (manager as unknown as { saveScrollStateInternal(): void }).saveScrollStateInternal();
    const during = JSON.parse(localStorage.getItem(KEY)!) as {
      loadedRequests: unknown[];
      loadedPages: number;
    };
    expect(during.loadedPages).toBe(2);
    expect(during.loadedRequests).toHaveLength(1);

    resolveFetch({
      ok: true,
      status: 200,
      url: NEXT_URL,
      redirected: false,
      text: async () => pageMarkup(),
    });
    await new Promise((r) => setTimeout(r, 60));
    expect((manager as unknown as { isReplaying: boolean }).isReplaying).toBe(false);
  });

  it("does not append an in-flight page after maxPages is lowered", async () => {
    stubMetrics(5_000, 800);
    let resolveFetch!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          })
      )
    );

    const manager = new InfiniteScrollManager(
      makeEngine(),
      document.querySelector("#rso")!,
      () => {},
      { fetchDelay: 0, maxPages: 10, persist: false }
    );
    managers.push(manager);
    manager.init();

    const pending = (manager as unknown as { fetchNextPage(): Promise<void> }).fetchNextPage();
    await new Promise((r) => setTimeout(r, 20));
    manager.updateConfig({ maxPages: 1 });
    resolveFetch({
      ok: true,
      status: 200,
      url: NEXT_URL,
      redirected: false,
      text: async () =>
        `<div id="rso"><div class="kb0PBd"><a href="https://b.com/y">b</a></div></div>` +
        `<a id="pnnext" href="https://www.google.com/search?q=test&start=20">Next</a>`,
    });
    await pending;

    expect(document.querySelector('[data-inf-page="2"]')).toBeNull();
    expect((manager as unknown as { isLoading: boolean }).isLoading).toBe(false);
    expect((manager as unknown as { hasMore: boolean }).hasMore).toBe(false);
  });

  it("clears legacy state that has no replayable requests instead of clamp-jumping", () => {
    stubMetrics(3_000, 800);
    mockNavType("back_forward");
    localStorage.setItem(
      KEY,
      JSON.stringify({
        url: window.location.href,
        scrollY: 25_000,
        loadedPages: 4,
        loadedUrls: [],
        timestamp: Date.now(),
      })
    );
    const scrollSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const manager = new InfiniteScrollManager(
      makeEngine(),
      document.querySelector("#rso")!,
      () => {},
      { persist: true }
    );
    managers.push(manager);
    (manager as unknown as { tryRestoreScroll(): void }).tryRestoreScroll();

    expect(scrollSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe("fetch timeout", () => {
  function hangingFetch(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError"))
        );
      }))
    );
  }

  it("returns null when the request stalls (the manager can then retry/back off)", async () => {
    vi.useFakeTimers();
    hangingFetch();
    const page = fetchPage(
      "https://www.google.com/search?q=test",
      new AbortController().signal,
      0
    );
    await vi.advanceTimersByTimeAsync(15_001);
    await expect(page).resolves.toBeNull();
  });

  it("still rejects with AbortError when the caller aborts", async () => {
    hangingFetch();
    const controller = new AbortController();
    const page = fetchPage(
      "https://www.google.com/search?q=test",
      controller.signal,
      0
    );
    controller.abort();
    await expect(page).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("teardown during a replay", () => {
  it("releases isReplaying so scroll persistence survives an SPA navigation", async () => {
    stubMetrics(5_000, 800);
    mockNavType("reload");
    localStorage.setItem(
      KEY,
      JSON.stringify({
        url: window.location.href,
        scrollY: 20_000,
        loadedPages: 2,
        loadedUrls: [NEXT_URL],
        loadedRequests: [{ url: NEXT_URL }],
        timestamp: Date.now(),
      })
    );
    let resolveFetch!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          })
      )
    );
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    const manager = new InfiniteScrollManager(
      makeEngine(),
      document.querySelector("#rso")!,
      () => {},
      { fetchDelay: 0, maxPages: 10, persist: true }
    );
    managers.push(manager);
    manager.init();

    await new Promise((r) => setTimeout(r, 20));
    expect((manager as unknown as { isReplaying: boolean }).isReplaying).toBe(true);

    // A SPA re-search tears the manager down while the replay fetch is
    // outstanding. The replay's finally is epoch-gated and returns early, so
    // only destroy()/init() can release the flag.
    manager.destroy();
    expect((manager as unknown as { isReplaying: boolean }).isReplaying).toBe(false);

    resolveFetch({
      ok: true,
      status: 200,
      url: NEXT_URL,
      redirected: false,
      text: async () => pageMarkup(),
    });
    await new Promise((r) => setTimeout(r, 60));
    expect((manager as unknown as { isReplaying: boolean }).isReplaying).toBe(false);

    // The whole point: writeScrollState no longer bails forever, so the next
    // scroll can be persisted (loadedPages drops back to page 1).
    (manager as unknown as { saveScrollStateInternal(): void }).saveScrollStateInternal();
    const saved = JSON.parse(localStorage.getItem(KEY)!) as { loadedPages: number };
    expect(saved.loadedPages).toBe(1);
  });
});
