import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchPage } from "../../src/content/infinite-scroll/fetcher";
import { InfiniteScrollManager } from "../../src/content/infinite-scroll/manager";
import { setDebugMode } from "../../src/content/debug";
import type { EngineAdapter } from "../../src/content/engines/base";

// ============================================================
// Transient-fetch hardening (field log 2026-09-06):
//
// Part 1 — Google intermittently answers page-2+ requests with an
// EMPTY body (200, len=0). That is neither a soft block nor a
// results page; fetchPage must return null (feeding the manager's
// retry budget) and never parse it as a document.
//
// Part 2 — a shaped-but-empty page (container present, zero
// results, no pager) must NOT overwrite a known-good nextUrl: one
// transient response killed the whole session (hasMore=false
// forever) in the field.
// ============================================================

const SIGNAL = new AbortController().signal;

describe("fetchPage — transient empty responses", () => {
  function stubFetch(opts: { url?: string; ok?: boolean; status?: number; body: string }) {
    return vi.fn().mockResolvedValue({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      url: opts.url ?? "https://www.google.com/search?q=test&start=10",
      text: async () => opts.body,
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null on a 200 with a completely empty body", async () => {
    vi.stubGlobal("fetch", stubFetch({ body: "" }));
    expect(await fetchPage("https://www.google.com/search?q=test&start=10", SIGNAL, 0)).toBeNull();
  });

  it("logs an empty-body receipt in debug mode (distinguishes transient from soft-block)", async () => {
    // The null return alone is already guaranteed by the shape gate; the
    // FAST PATH's load-bearing value is the debug log that names the cause.
    // Without it, the next field report cannot tell an empty 200 from a
    // soft block. Pin the log line.
    setDebugMode(true);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      vi.stubGlobal("fetch", stubFetch({ body: "  " }));
      expect(await fetchPage("https://www.google.com/search?q=test&start=10", SIGNAL, 0)).toBeNull();
      const line = spy.mock.calls.find((c) => String(c[0]).includes("fetch empty body"));
      expect(line).toBeTruthy();
      expect(String(line![0])).toContain("status=200");
    } finally {
      spy.mockRestore();
      setDebugMode(false);
    }
  });

  it("returns null on a 200 with a whitespace-only body", async () => {
    vi.stubGlobal("fetch", stubFetch({ body: "   \n\t  " }));
    expect(await fetchPage("https://www.google.com/search?q=test&start=10", SIGNAL, 0)).toBeNull();
  });

  it("returns null on 204 No Content", async () => {
    vi.stubGlobal("fetch", stubFetch({ status: 204, body: "" }));
    expect(await fetchPage("https://www.google.com/search?q=test&start=10", SIGNAL, 0)).toBeNull();
  });

  it("still returns a parsed doc for a normal results page", async () => {
    vi.stubGlobal("fetch", stubFetch({
      body: '<html><body><div id="rso"><div class="g">result</div></div></body></html>',
    }));
    const res = await fetchPage("https://www.google.com/search?q=test&start=10", SIGNAL, 0);
    expect(res).not.toBeNull();
    expect(res!.doc.querySelector(".g")).not.toBeNull();
  });
});

describe("InfiniteScrollManager — transient empty page must not end the session", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  /** Seed state as init() would (init needs IntersectionObserver, absent in jsdom). */
  function seedState(manager: InfiniteScrollManager, nextUrl: string): void {
    const m = manager as unknown as { nextUrl: string | null; hasMore: boolean };
    m.nextUrl = nextUrl;
    m.hasMore = true;
  }

  function makeEngine(pagerInFetchedDoc: boolean): EngineAdapter {
    return {
      id: "google",
      name: "Google",
      matches: () => true,
      getResultNodes: (doc) => Array.from((doc as ParentNode).querySelectorAll(".kb0PBd")),
      getResultUrl: (node) => node.querySelector("a")?.getAttribute("href") ?? null,
      getButtonTarget: () => null,
      getInsertionAnchor: () => null,
      getNextPageUrl: (doc) => {
        if (!pagerInFetchedDoc) return null;
        return doc.querySelector<HTMLAnchorElement>("#pnnext")?.href ?? null;
      },
    } as EngineAdapter;
  }

  it("keeps the previous nextUrl when an empty shaped page has no pager", async () => {
    document.body.innerHTML = `<div id="rso">
        <div class="kb0PBd"><a href="https://a.com/x">a</a></div>
      </div>`;
    const container = document.querySelector("#rso")!;
    // Engine's pager probe finds nothing in the (empty) fetched doc.
    const manager = new InfiniteScrollManager(
      makeEngine(false), container, () => {}, { maxPages: 10 }
    );
    const nextUrl = "https://www.google.com/search?q=test&start=20";
    seedState(manager, nextUrl);
    const m = manager as unknown as {
      nextUrl: string | null;
      hasMore: boolean;
      fetchNextPage(): Promise<void>;
    };

    // The transient response: 200, shaped (has #rso), zero results, no pager.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: nextUrl,
      text: async () => '<html><body><div id="rso"></div></body></html>',
    });
    vi.stubGlobal("fetch", fetchMock);
    await m.fetchNextPage();

    // Session must survive: the pre-transient nextUrl is retained.
    expect(m.nextUrl).toBe(nextUrl);
    expect(m.hasMore).toBe(true);
  });

  it("ends cleanly on a REAL last page (results, then no pager)", async () => {
    document.body.innerHTML = `<div id="rso">
        <div class="kb0PBd"><a href="https://a.com/x">a</a></div>
      </div>`;
    const container = document.querySelector("#rso")!;
    const manager = new InfiniteScrollManager(
      makeEngine(false), container, () => {}, { maxPages: 10 }
    );
    seedState(manager, "https://www.google.com/search?q=test&start=20");
    const m = manager as unknown as {
      nextUrl: string | null;
      hasMore: boolean;
      fetchNextPage(): Promise<void>;
    };

    // A genuine final page: real results, but the pager is gone.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://www.google.com/search?q=test&start=20",
      text: async () =>
        '<html><body><div id="rso">' +
        '<div class="kb0PBd"><a href="https://b.com/y">b</a></div>' +
        '<div class="kb0PBd"><a href="https://c.com/z">c</a></div>' +
        '</div></body></html>',
    });
    vi.stubGlobal("fetch", fetchMock);
    await m.fetchNextPage();

    // Genuine end: real results, no pager anywhere → stop cleanly.
    expect(m.hasMore).toBe(false);
  });
});
