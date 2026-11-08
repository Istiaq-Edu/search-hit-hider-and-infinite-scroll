import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InfiniteScrollManager } from "../../src/content/infinite-scroll/manager";
import { YandexAdapter } from "../../src/content/engines/yandex";
import { Sentinel } from "../../src/content/infinite-scroll/sentinel";
import {
  awaitNewResults,
  pressNativeControl,
  NativeAdvanceTimeoutError,
} from "../../src/content/infinite-scroll/native-advance";
import type { EngineAdapter } from "../../src/content/engines/base";

// ============================================================
// The guest invariant.
//
// A content script is a guest in a document owned by the engine's JS
// runtime. It must never RENDER results (that requires hydration, session
// tokens and stylesheet lineage it does not have) and it must never make
// the engine's own navigation LESS usable when its enhancement fails.
//
// These tests are the ones that would have killed the fetch -> DOMParser
// -> clone -> port CSS -> paint favicons design on day one.
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
  `<li class="serp-item"><h2><a class="OrganicTitle-Link" href="https://${host}/x">${host}</a></h2></li>`;

function continuousSerp(): string {
  return (
    `<ul id="search-result" class="serp-list serp-list_left_yes">${RESULT("a.com")}</ul>` +
    `<div class="pager"><a class="Pager-Item Pager-Item_type_next" ` +
    `href="/search/?text=cats&amp;p=1">Next</a></div>` +
    `<button id="more" data-bem='{"b-more":{}}'>Показать ещё</button>`
  );
}

function parseHTML(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

let managers: InfiniteScrollManager[] = [];

function makeManager(
  engine: EngineAdapter,
  container: Element,
  onNewNodes: (nodes: Element[]) => void,
  prefs: Record<string, unknown> = {}
): InfiniteScrollManager {
  const manager = new InfiniteScrollManager(engine, container, onNewNodes, {
    fetchDelay: 0,
    maxPages: 10,
    persist: false,
    ...prefs,
  } as ConstructorParameters<typeof InfiniteScrollManager>[3]);
  managers.push(manager);
  return manager;
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  document.body.innerHTML = "";
});

afterEach(() => {
  for (const m of managers) m.destroy();
  managers = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("DAY-ONE TEST — the guest invariant", () => {
  it("lets the engine render its own results and never removes navigation when auto-load fails", async () => {
    document.body.innerHTML = continuousSerp();
    const container = document.querySelector("#search-result") as Element;
    const more = document.querySelector("#more") as HTMLButtonElement;
    const pagerLink = document.querySelector(".Pager-Item_type_next") as HTMLAnchorElement;

    // The ENGINE renders the next batch. A real click handler on the engine's
    // own control appends a hydrated, styled, interactive node. A detached
    // DOMParser document can never produce this node.
    let engineNode: Element | null = null;
    let engineHandlerCalls = 0;
    more.addEventListener("click", () => {
      engineNode = document.createElement("li");
      engineNode.className = "serp-item";
      engineNode.innerHTML =
        '<h2><a class="OrganicTitle-Link" href="https://b.com/x">b.com</a></h2>';
      engineNode.addEventListener("click", () => {
        engineHandlerCalls++;
      });
      // Deliberately asynchronous: a fixed-sleep loader would miss this.
      setTimeout(() => container.appendChild(engineNode!), 10);
    });

    const seen: Element[] = [];
    const manager = makeManager(new YandexAdapter(), container, (nodes) => seen.push(...nodes));
    manager.init();

    // (1) We never write into the framework-owned results list.
    expect(container.querySelector("#is-sentinel")).toBeNull();
    expect(container.querySelector("[data-inf-page]")).toBeNull();
    const sentinel = document.querySelector("#is-sentinel") as HTMLElement;
    expect(sentinel).not.toBeNull();
    expect(container.contains(sentinel)).toBe(false);

    // (2) Auto-advance is a TRIGGER, not a fetch. No network is involved.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await (
      manager as unknown as { fetchNextPage(): Promise<void> }
    ).fetchNextPage();
    expect(fetchSpy).not.toHaveBeenCalled();

    // (3) The new result IS the engine's own node: same identity, same live
    // handler, no clone, no wrapper, no CSS archaeology.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(engineNode);
    expect(container.contains(engineNode!)).toBe(true);
    seen[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(engineHandlerCalls).toBe(1);
    expect(container.querySelector("[data-inf-page]")).toBeNull();

    // (4) FAIL-OPEN: kill the native control, force three failed advances,
    // and verify the user can STILL reach page 2.
    more.remove();
    for (let i = 0; i < 3; i++) {
      await (
        manager as unknown as { fetchNextPage(): Promise<void> }
      ).fetchNextPage();
    }

    const manual = document.querySelector<HTMLAnchorElement>("#is-manual-next");
    expect(manual).not.toBeNull();
    expect(manual!.href).toContain("p=1");
    expect(/^https?:$/.test(new URL(manual!.href).protocol)).toBe(true);
    // The engine's own pager was never hidden and keeps its href.
    expect(pagerLink.style.display).not.toBe("none");
    expect(pagerLink.getAttribute("href")).toContain("p=1");
    // A failure must not be reported as a genuine end of results.
    expect(document.querySelector("#is-sentinel")?.textContent).not.toContain(
      "End of results"
    );
  });
});

describe("YandexAdapter paging strategy", () => {
  it("delegates when the engine exposes its own show-more control", () => {
    const doc = parseHTML(continuousSerp());
    expect(new YandexAdapter().getPagingStrategy(doc)).toBe("native");
  });

  it("falls back to fetch on a classic pager-only SERP", () => {
    const doc = parseHTML(
      `<ul id="search-result">${RESULT("a.com")}${RESULT("b.com")}</ul>` +
        `<div class="pager"><a class="Pager-Item_type_next" href="/search/?text=q&amp;p=1">next</a></div>`
    );
    expect(new YandexAdapter().getPagingStrategy(doc)).toBe("fetch");
  });

  it("stays out of the way when the engine already paginates itself", () => {
    const doc = parseHTML(
      `<div class="serp-list continuous-scroll" data-bem='{"infinite":{}}'>${RESULT("a.com")}</div>`
    );
    expect(new YandexAdapter().getPagingStrategy(doc)).toBe("observe");
  });

  it("treats a disabled show-more control as terminal, not as a fetch error", () => {
    const doc = parseHTML(
      `<ul id="search-result">${RESULT("a.com")}</ul>` +
        `<button data-testid="more-results" disabled>Показать ещё</button>`
    );
    expect(new YandexAdapter().getPagingStrategy(doc)).toBe("observe");
  });

  it("keeps the native pager visible (empty hide selectors = fail-open)", () => {
    expect(new YandexAdapter().getPaginationSelectors()).toEqual([]);
  });

  it("derives a real next-page URL on continuous SERPs with no pager link", () => {
    const doc = parseHTML(`<ul id="search-result">${RESULT("a.com")}</ul>`);
    Object.defineProperty(doc, "URL", {
      value: "https://yandex.com/search/?text=cats",
      configurable: true,
    });
    const url = new YandexAdapter().getManualNextPageUrl(doc);
    expect(url).not.toBeNull();
    expect(new URL(url!).searchParams.get("p")).toBe("1");
    expect(new URL(url!).searchParams.get("text")).toBe("cats");
  });

  it("prefers the engine's own pager href over a derived URL", () => {
    const doc = parseHTML(continuousSerp());
    Object.defineProperty(doc, "URL", {
      value: "https://yandex.com/search/?text=cats",
      configurable: true,
    });
    expect(new YandexAdapter().getManualNextPageUrl(doc)).toContain("p=1");
  });
});

describe("native-advance", () => {
  it("resolves on a mutation, not on a guessed sleep duration", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let count = 0;
    const pending = awaitNewResults({
      baseline: 0,
      count: () => count,
      root: document.documentElement,
      timeoutMs: 1000,
      pollMs: 5,
    });
    setTimeout(() => {
      count = 3;
      host.appendChild(document.createElement("span"));
    }, 25);
    await expect(pending).resolves.toBe(3);
  });

  it("rejects with a typed timeout when the engine produces nothing", async () => {
    await expect(
      awaitNewResults({
        baseline: 0,
        count: () => 0,
        timeoutMs: 20,
        pollMs: 5,
      })
    ).rejects.toBeInstanceOf(NativeAdvanceTimeoutError);
  });

  it("is abort-aware", async () => {
    const ac = new AbortController();
    const pending = awaitNewResults({
      baseline: 0,
      count: () => 0,
      timeoutMs: 5000,
      signal: ac.signal,
    });
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("prefers the safe Xray-native click and fires the page's listener", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    const listener = vi.fn();
    button.addEventListener("click", listener);
    const pageClick = vi.fn();
    Object.defineProperty(button, "wrappedJSObject", {
      value: { click: pageClick },
      configurable: true,
    });
    expect(pressNativeControl(button)).toBe("xray");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(pageClick).not.toHaveBeenCalled();
  });

  it("falls back to the page-realm method only when the wrapped click throws", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    Object.defineProperty(button, "click", {
      value: () => {
        throw new Error("denied");
      },
      configurable: true,
    });
    const pageClick = vi.fn();
    Object.defineProperty(button, "wrappedJSObject", {
      value: { click: pageClick },
      configurable: true,
    });
    expect(pressNativeControl(button)).toBe("page");
    expect(pageClick).toHaveBeenCalledTimes(1);
  });

  it("resolves on an attribute-only reveal with no new node", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const node = document.createElement("div");
    node.setAttribute("hidden", "");
    host.appendChild(node);
    const count = () => host.querySelectorAll("div:not([hidden])").length;
    const pending = awaitNewResults({
      baseline: 0,
      count,
      root: host,
      timeoutMs: 1000,
      pollMs: 5,
    });
    setTimeout(() => node.removeAttribute("hidden"), 20);
    await expect(pending).resolves.toBe(1);
  });

  it("Yandex advance sees a pre-rendered result revealed without a new node", async () => {
    document.body.innerHTML = continuousSerp();
    const container = document.querySelector("#search-result") as Element;
    const hidden = document.createElement("li");
    hidden.className = "serp-item";
    hidden.setAttribute("hidden", "");
    hidden.innerHTML =
      '<h2><a class="OrganicTitle-Link" href="https://hidden.com/x">hidden</a></h2>';
    container.appendChild(hidden);
    (document.querySelector("#more") as HTMLButtonElement).addEventListener("click", () => {
      setTimeout(() => hidden.removeAttribute("hidden"), 20);
    });
    await expect(new YandexAdapter().triggerNextPage(document)).resolves.toBeUndefined();
  });

  it("cancels an in-flight advance when the manager aborts", async () => {
    const ac = new AbortController();
    const pending = awaitNewResults({
      baseline: 0,
      count: () => 0,
      timeoutMs: 10_000,
      signal: ac.signal,
      pollMs: 5,
    });
    setTimeout(() => ac.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("manager native strategy", () => {
  it("diffs by identity so mid-list insertions are reported correctly", async () => {
    document.body.innerHTML = continuousSerp();
    const container = document.querySelector("#search-result") as Element;
    const more = document.querySelector("#more") as HTMLButtonElement;
    let inserted: Element | null = null;
    more.addEventListener("click", () => {
      inserted = document.createElement("li");
      inserted.className = "serp-item";
      inserted.innerHTML =
        '<h2><a class="OrganicTitle-Link" href="https://c.com/x">c.com</a></h2>';
      // Insert in the MIDDLE, before the existing result. A positional
      // slice(beforeCount) would have reported the OLD node instead.
      container.insertBefore(inserted, container.firstChild);
    });

    const seen: Element[] = [];
    const manager = makeManager(new YandexAdapter(), container, (nodes) => seen.push(...nodes));
    manager.init();
    await (manager as unknown as { fetchNextPage(): Promise<void> }).fetchNextPage();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(inserted);
  });

  it("offers manual navigation even when auto-loading never starts", () => {
    document.body.innerHTML = `<div id="results">${RESULT("a.com")}</div>`;
    const container = document.querySelector("#results") as Element;
    const engine = {
      id: "stub",
      name: "Stub",
      matches: () => true,
      getPagingStrategy: () => "fetch",
      getResultNodes: () => [],
      getResultUrl: () => null,
      getButtonTarget: () => null,
      getNextPageUrl: () => null, // no pager found => hasMore=false at init
      getManualNextPageUrl: () => "https://example.com/search?q=x&p=1",
    } as unknown as EngineAdapter;

    const manager = makeManager(engine, container, () => {});
    manager.init();

    expect(document.querySelector<HTMLAnchorElement>("#is-manual-next")?.href).toContain(
      "p=1"
    );
    expect(container.querySelector("#is-sentinel")).toBeNull();
  });
});

describe("review regressions (confirmed defects)", () => {
  const bareEngine = (overrides: Record<string, unknown> = {}): EngineAdapter =>
    ({
      id: "stub",
      name: "Stub",
      matches: () => true,
      getResultNodes: () => [],
      getResultUrl: () => null,
      getButtonTarget: () => null,
      getNextPageUrl: () => null,
      getInsertionAnchor: () => null,
      getPaginationSelectors: () => [],
      ...overrides,
    }) as unknown as EngineAdapter;

  const priv = (m: InfiniteScrollManager): Record<string, unknown> =>
    m as unknown as Record<string, unknown>;

  it("prefers the ACTUAL next-page URL over the stale live page-1 pager", () => {
    document.body.innerHTML = `<div id="results">${RESULT("a.com")}</div>`;
    const engine = bareEngine({
      getNextPageUrl: () => "https://example.com/search?q=x&p=1",
      getManualNextPageUrl: () => "https://example.com/search?q=x&p=1",
    });
    const manager = makeManager(engine, document.querySelector("#results")!, () => {});
    priv(manager).nextUrl = "https://example.com/search?q=x&p=5";
    expect((priv(manager).manualNextUrl as () => string | null)()).toContain("p=5");
  });

  it("reports a genuine end as 'End of results.' with no stale link", () => {
    document.body.innerHTML = `<div id="results">${RESULT("a.com")}</div>`;
    const manager = makeManager(
      bareEngine(),
      document.querySelector("#results")!,
      () => {}
    );
    (priv(manager).createPassiveSentinel as () => void).call(manager);
    (priv(manager).finishPaging as (r: string) => void).call(manager, "end");
    expect(document.querySelector("#is-manual-next")).toBeNull();
    expect(document.querySelector("#is-sentinel")?.textContent).toContain(
      "End of results"
    );
  });

  it("shows the manual link on TRANSIENT errors, not only terminal ones", () => {
    document.body.innerHTML = `<div id="results">${RESULT("a.com")}</div>`;
    const manager = makeManager(
      bareEngine(),
      document.querySelector("#results")!,
      () => {}
    );
    // No pager URL at init means init() takes the passive early-return path;
    // create the sentinel explicitly so we test the transient-error renderer.
    (priv(manager).createSentinel as () => void).call(manager);
    priv(manager).nextUrl = "https://example.com/search?q=x&p=3";
    (priv(manager).showError as () => void).call(manager);
    expect(document.querySelector<HTMLAnchorElement>("#is-manual-next")?.href).toContain(
      "p=3"
    );
  });

  it("arms the capability reprobe even when no pager URL existed at init", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<ul id="search-result">${RESULT("a.com")}</ul>`;
    let hydrated = false;
    const engine = bareEngine({
      getPagingStrategy: () => (hydrated ? "native" : "fetch"),
      triggerNextPage: async () => {},
      hasNativeNextPage: () => true,
    });
    const manager = makeManager(
      engine,
      document.querySelector("#search-result")!,
      () => {}
    );
    manager.init();
    expect(priv(manager).strategy).toBe("fetch");
    hydrated = true;
    await vi.advanceTimersByTimeAsync(900);
    expect(priv(manager).strategy).toBe("native");
    expect(priv(manager).isLoading).toBe(false);
    vi.useRealTimers();
  });

  it("destroy() clears isLoading so a reprobe cannot wedge the session", () => {
    document.body.innerHTML = `<div id="results">${RESULT("a.com")}</div>`;
    const manager = makeManager(
      bareEngine(),
      document.querySelector("#results")!,
      () => {}
    );
    priv(manager).isLoading = true;
    manager.destroy();
    expect(priv(manager).isLoading).toBe(false);
  });

  it("treats a pushState'd page number as the same search on native strategies", () => {
    document.body.innerHTML = `<div id="results">${RESULT("a.com")}</div>`;
    const manager = makeManager(
      bareEngine(),
      document.querySelector("#results")!,
      () => {}
    );
    const same = priv(manager).isSameSearch as (a: string, b: string) => boolean;
    expect(
      same.call(
        manager,
        "https://yandex.com/search/?text=cats&p=0",
        "https://yandex.com/search/?text=cats&p=2"
      )
    ).toBe(true);
    expect(
      same.call(
        manager,
        "https://yandex.com/search/?text=cats&p=1",
        "https://yandex.com/search/?text=dogs&p=1"
      )
    ).toBe(false);
  });

  it("derives a page-N+1 manual URL that tracks loaded batches", () => {
    const doc = parseHTML(`<ul id="search-result">${RESULT("a.com")}</ul>`);
    Object.defineProperty(doc, "URL", {
      value: "https://yandex.com/search/?text=cats",
      configurable: true,
    });
    const url = new YandexAdapter().getManualNextPageUrl(doc, 3);
    expect(new URL(url!).searchParams.get("p")).toBe("3");
  });

  it("forwards the manager's abort signal through the native advance", async () => {
    document.body.innerHTML = continuousSerp();
    const ac = new AbortController();
    const pending = new YandexAdapter().triggerNextPage(document, ac.signal);
    setTimeout(() => ac.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("Try Again reopens a session that finishPaging() closed", () => {
    document.body.innerHTML = `<div id="results">${RESULT("a.com")}</div>`;
    const engine = bareEngine({
      getManualNextPageUrl: () => "https://example.com/search?q=x&p=1",
    });
    const manager = makeManager(
      engine,
      document.querySelector("#results")!,
      () => {}
    );
    manager.init();
    (priv(manager).finishPaging as (r: string) => void).call(manager, "failed");
    expect(priv(manager).hasMore).toBe(false);
    (priv(manager).retryFetch as () => void).call(manager);
    expect(priv(manager).hasMore).toBe(true);
    expect(priv(manager).consecutiveErrors).toBe(0);
    expect(priv(manager).isLoading).toBe(false);
  });

  it("does not append a page when maxPages is lowered mid-advance", async () => {
    document.body.innerHTML = continuousSerp();
    const container = document.querySelector("#search-result") as Element;
    const engine = new YandexAdapter();
    // Resolve asynchronously so updateConfig lands between claim and append.
    (engine as unknown as { triggerNextPage: () => Promise<void> }).triggerNextPage =
      async () => {
        const li = document.createElement("li");
        li.className = "serp-item";
        li.innerHTML =
          '<h2><a class="OrganicTitle-Link" href="https://late.com/x">late</a></h2>';
        container.appendChild(li);
      };
    const seen: Element[] = [];
    const manager = makeManager(engine, container, (n) => seen.push(...n), {
      maxPages: 10,
    });
    manager.init();
    const pending = (priv(manager).fetchNextPage as () => Promise<void>).call(manager);
    manager.updateConfig({ maxPages: 1 });
    await pending;
    expect(seen).toHaveLength(0);
    expect(priv(manager).hasMore).toBe(false);
  });

  it("does not mistake a header 'More' link for a native paging control", () => {
    const doc = parseHTML(
      `<header><a class="more-link" href="/about">More</a></header>` +
        `<ul id="search-result">${RESULT("a.com")}${RESULT("b.com")}</ul>` +
        `<div class="pager"><a class="Pager-Item_type_next" href="/search/?text=q&amp;p=1">next</a></div>`
    );
    expect(new YandexAdapter().getPagingStrategy(doc)).toBe("fetch");
  });
});

describe("Sentinel fail-open link", () => {
  it("renders a safe http(s) link and ignores javascript: URLs", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const sentinel = new Sentinel(container);

    sentinel.setManualFallback("javascript:alert(1)");
    expect(sentinel.manualUrl).toBeNull();
    sentinel.setState("done");
    expect(document.querySelector("#is-manual-next")).toBeNull();

    sentinel.setManualFallback("https://yandex.com/search/?text=x&p=1");
    expect(sentinel.manualUrl).toContain("p=1");
    expect(document.querySelector<HTMLAnchorElement>("#is-manual-next")?.href).toContain(
      "p=1"
    );
    // A stop WITH a manual link must not claim the results have ended.
    expect(sentinel.element.textContent).not.toContain("End of results");
  });
});
