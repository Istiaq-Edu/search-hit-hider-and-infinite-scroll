import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchPage } from "../../src/content/infinite-scroll/fetcher";

// ============================================================
// fetchPage hardening: CAPTCHA / "sorry" interstitials arrive with
// HTTP 200 and must be treated as failures (null) so the infinite
// scroll manager backs off instead of parsing them as results.
// ============================================================

const SIGNAL = new AbortController().signal;

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

describe("fetchPage", () => {
  it("returns a parsed document for a normal results page", async () => {
    vi.stubGlobal("fetch", stubFetch({
      body: '<html><body><div id="rso"><div class="g">result</div></div></body></html>',
    }));
    const res = await fetchPage("https://www.google.com/search?q=test&start=10", SIGNAL, 0);
    expect(res).not.toBeNull();
    expect(res!.doc.querySelector(".g")).not.toBeNull();
  });

  it("returns null on non-2xx (e.g. 429)", async () => {
    vi.stubGlobal("fetch", stubFetch({ ok: false, status: 429, body: "" }));
    expect(await fetchPage("https://x/", SIGNAL, 0)).toBeNull();
  });

  it("returns null for a /sorry/ redirect URL (Google CAPTCHA)", async () => {
    vi.stubGlobal("fetch", stubFetch({
      url: "https://www.google.com/sorry/index?continue=/search%3Fq%3Dtest",
      body: "<html><body>unusual traffic</body></html>",
    }));
    expect(await fetchPage("https://www.google.com/search?q=test&start=10", SIGNAL, 0)).toBeNull();
  });

  it("returns null when the page contains a captcha form element", async () => {
    vi.stubGlobal("fetch", stubFetch({
      body: '<html><body><form action="/sorry/sorry" id="captcha-form"><input></form></body></html>',
    }));
    expect(await fetchPage("https://www.google.com/search?q=test&start=10", SIGNAL, 0)).toBeNull();
  });

  it("returns null when the page contains .g-recaptcha", async () => {
    vi.stubGlobal("fetch", stubFetch({
      body: '<html><body><div class="g-recaptcha"></div></body></html>',
    }));
    expect(await fetchPage("https://www.bing.com/search?q=test&first=11", SIGNAL, 0)).toBeNull();
  });

  it("returns null for a Startpage /sp/captcha redirect", async () => {
    vi.stubGlobal("fetch", stubFetch({
      url: "https://www.startpage.com/sp/captcha?continue=/sp/search",
      body: "<html><body>are you human</body></html>",
    }));
    expect(await fetchPage("https://www.startpage.com/sp/search", SIGNAL, 0)).toBeNull();
  });

  it("sends POST bodies for POST-paginated engines (Startpage)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://www.startpage.com/sp/search",
      text: async () => '<html><body><input name="sc" value="next"></body></html>',
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchPage(
      "https://www.startpage.com/sp/search",
      SIGNAL,
      0,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "query=test&page=2&sc=tok",
      }
    );
    expect(res).not.toBeNull();
    const call = fetchMock.mock.calls[0]!;
    expect(call[1]!.method).toBe("POST");
    expect(call[1]!.body).toBe("query=test&page=2&sc=tok");
    expect((call[1]!.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(call[1]!.credentials).toBe("include");
  });
});
