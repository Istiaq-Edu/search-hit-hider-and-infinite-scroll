import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { fetchPage } from "../../src/content/infinite-scroll/fetcher";
import { InfiniteScrollManager } from "../../src/content/infinite-scroll/manager";
import type { EngineAdapter } from "../../src/content/engines/base";

// ============================================================
// Lifecycle guards (audit B1/B2/B3):
//
// B1 — a stale fetch continuation (its jitter sleep ignored destroy()'s
//      abort) cleared the CURRENT fetch's isLoading guard; the next trigger
//      then aborted the legitimate in-flight fetch.
// B2 — consecutiveErrors leaked across SPA re-search: two soft blocks on
//      SERP A + one transient null on SERP B ended the new session with no
//      retry button.
// B3 — a manager initialized on a pager-less SERP returned from init()
//      before arming navigation detection, so an SPA navigation to a
//      multi-page SERP could never wake it.
// ============================================================

class FakeIntersectionObserver {
  constructor(_cb: IntersectionObserverCallback, _opts?: IntersectionObserverInit) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

const NEXT_URL = "https://www.google.com/search?q=test&start=10";

function makeEngine(): EngineAdapter {
  return {
    id: "google",
    name: "Google",
    matches: () => true,
    getResultNodes: (doc) => Array.from((doc as ParentNode).querySelectorAll(".kb0PBd")),
    getResultUrl: (node) => node.querySelector("a")?.getAttribute("href") ?? null,
    getButtonTarget: () => null,
    getInsertionAnchor: () => null,
    getNextPageUrl: (doc) => doc.querySelector<HTMLAnchorElement>("#pnnext")?.href ?? null,
  } as EngineAdapter;
}

function pagerMarkup(): string {
  return `<a id="pnnext" href="${NEXT_URL}">Next</a>`;
}

function resultsMarkup(): string {
  return `<div id="rso"><div class="kb0PBd"><a href="https://a.com/x">a</a></div></div>`;
}

describe("B1 — stale fetch continuation cannot release a newer fetch's guard", () => {
  let managers: InfiniteScrollManager[] = [];

  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    document.body.innerHTML = resultsMarkup() + pagerMarkup();
  });

  afterEach(() => {
    for (const m of managers) m.destroy();
    managers = [];
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    localStorage.clear();
    history.replaceState({}, "", "/");
  });

  it("aborts fetchPage during the jitter sleep without issuing the request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pending = fetchPage(NEXT_URL, controller.signal, 5000);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a destroyed fetch's completion does not clear the re-initialized fetch's isLoading", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((resolve) => resolvers.push(resolve)))
    );

    const manager = new InfiniteScrollManager(
      makeEngine(),
      document.querySelector("#rso")!,
      () => {},
      { fetchDelay: 0, maxPages: 10 }
    );
    managers.push(manager);
    manager.init();

    const trigger = (manager as unknown as { fetchNextPage(): Promise<void> });
    void trigger.fetchNextPage(); // fetch A — held by the stub
    expect(resolvers).toHaveLength(1);

    // SPA re-search while A is still in flight.
    history.pushState({}, "", "/search?q=other");
    manager.handleNavigation();
    const fetchB = trigger.fetchNextPage(); // the legitimate current fetch
    expect(resolvers).toHaveLength(2);

    // A completes now (its abort was swallowed by the non-fetching window).
    // Empty body → fetchPage returns null; the stale continuation must return
    // before its finally — which may NOT clear B's isLoading.
    resolvers[0]!({ ok: true, status: 200, url: NEXT_URL, text: async () => "" });
    // Let the stale continuation run to completion. (B's fetch is still held.)
    await new Promise((r) => setTimeout(r, 0));
    expect((manager as unknown as { isLoading: boolean }).isLoading).toBe(true);

    resolvers[1]!({
      ok: true,
      status: 200,
      url: NEXT_URL,
      text: async () => resultsMarkup(),
    });
    await fetchB;
    expect((manager as unknown as { isLoading: boolean }).isLoading).toBe(false);
  });
});

describe("B2 — consecutiveErrors does not leak across an SPA re-search", () => {
  let managers: InfiniteScrollManager[] = [];

  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    document.body.innerHTML = resultsMarkup() + pagerMarkup();
  });

  afterEach(() => {
    for (const m of managers) m.destroy();
    managers = [];
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    localStorage.clear();
    history.replaceState({}, "", "/");
  });

  it("handleNavigation resets the strike budget and the backoff it drives", () => {
    const manager = new InfiniteScrollManager(
      makeEngine(),
      document.querySelector("#rso")!,
      () => {},
      { fetchDelay: 600, maxPages: 10 }
    );
    managers.push(manager);
    manager.init();

    const m = manager as unknown as { consecutiveErrors: number };
    m.consecutiveErrors = 2;

    history.pushState({}, "", "/search?q=other");
    manager.handleNavigation();

    expect(m.consecutiveErrors).toBe(0);
  });
});

describe("B3 — pager-less init still hears SPA navigation", () => {
  let managers: InfiniteScrollManager[] = [];

  afterEach(() => {
    for (const m of managers) m.destroy();
    managers = [];
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    localStorage.clear();
    history.replaceState({}, "", "/");
  });

  it("re-initializes with the new pager instead of staying dormant forever", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    // A last page: results, no pager.
    document.body.innerHTML = resultsMarkup();

    const manager = new InfiniteScrollManager(
      makeEngine(),
      document.querySelector("#rso")!,
      () => {},
      { maxPages: 10 }
    );
    managers.push(manager);
    manager.init();

    const m = manager as unknown as { hasMore: boolean; nextUrl: string | null };
    expect(m.hasMore).toBe(false);

    // SPA-navigate to a multi-page SERP: new URL, new DOM with a pager.
    history.pushState({}, "", "/search?q=other");
    document.querySelector("#rso")!.insertAdjacentHTML("beforeend", pagerMarkup());
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(m.nextUrl).toBe(NEXT_URL);
    expect(m.hasMore).toBe(true);
  });
});
