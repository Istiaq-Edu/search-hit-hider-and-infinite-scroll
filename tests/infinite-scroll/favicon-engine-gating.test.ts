import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { InfiniteScrollManager } from "../../src/content/infinite-scroll/manager";
import type { EngineAdapter } from "../../src/content/engines/base";

// ============================================================
// Engine gating of the favicon <img> re-point (A2 F1, 2026-09-06
// deep review): Brave's chips are ALSO favicon-classed <img>
// elements (imgs.search.brave.com srcs). The Google s2 fallback
// was gated only on tagName — on Brave, every page-2+ destination
// absent from page-1 intel got img.src = google.com/s2/favicons
// (destination disclosed to Google; CSP-blocked = blank chip).
// Non-Google <img> chips must keep the engine's own URL verbatim.
// ============================================================

function braveSerpDom(): JSDOM {
  return new JSDOM(
    `<!DOCTYPE html><html><body><div id="results">
      <div class="snippet" data-type="web">
        <a class="l1" href="https://a.com/x"><h3>a</h3></a>
        <div class="site-name-wrapper">
          <img class="favicon-background" src="https://imgs.search.brave.com/abc123/rs:fit:32:32:1:0/g:ce/aHR0cHM6Ly9hLmNvbQ" alt="">
        </div>
      </div>
      <div class="snippet" data-type="web">
        <a class="l1" href="https://fresh-p2-host.com/y"><h3>b</h3></a>
        <div class="site-name-wrapper">
          <img class="favicon-background" src="about:blank" alt="">
        </div>
      </div>
    </div></body></html>`,
    { url: "https://search.brave.com/search?q=test" }
  );
}

function braveEngine(container: Element | null): EngineAdapter {
  return {
    id: "brave",
    name: "Brave",
    matches: () => true,
    getResultNodes: (root) => Array.from((root as ParentNode).querySelectorAll(".snippet")),
    getResultUrl: (node) => node.querySelector("a.l1")?.getAttribute("href") ?? null,
    getButtonTarget: () => null,
    getInsertionAnchor: () => container,
  } as EngineAdapter;
}

describe("favicon <img> re-point is Google-only (A2 F1)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("a Brave favicon-classed <img> keeps the engine's own URL (no google.com s2 leak)", () => {
    const dom = braveSerpDom();
    const liveDoc = dom.window.document;
    const container = liveDoc.querySelector("#results")!;
    const manager = new InfiniteScrollManager(
      braveEngine(container), container, () => {}, { maxPages: 5 }
    );
    const nodes = Array.from(liveDoc.querySelectorAll(".snippet"));
    (manager as unknown as { appendNodes(n: Element[], d?: Document): void })
      .appendNodes(nodes, liveDoc);

    const page = container.querySelector("[data-inf-page]") as HTMLElement;
    const imgs = Array.from(page.querySelectorAll<HTMLImageElement>("img.favicon-background"));
    expect(imgs.length).toBe(2);

    // Live Brave art URL: preserved verbatim.
    const withArt = imgs.find((i) => i.src.includes("imgs.search.brave.com"))!;
    expect(withArt.src).toContain("imgs.search.brave.com");
    expect(withArt.src).not.toContain("google.com");

    // Blank chip (page-2 host, no intel): must NOT become google.com/s2 —
    // that discloses the destination to a third party (A2 F1's core case).
    const blank = imgs.find((i) => !i.src.includes("imgs.search.brave.com"))!;
    expect(blank.src).not.toContain("google.com");
    expect(blank.src).not.toContain("gstatic.com");
  });

  it("a GOOGLE blank <img> chip still gets the first-party s2 re-point", () => {
    // The Google behavior must survive the gating fix (regression pin for
    // the original favicon fix).
    document.body.innerHTML = `<div id="rso"><div class="MjjYud">p1</div></div>`;
    const container = document.querySelector("#rso")!;
    const engine: EngineAdapter = {
      id: "google",
      name: "Google",
      matches: () => true,
      getResultNodes: (root) => Array.from((root as ParentNode).querySelectorAll(".kb0PBd")),
      getResultUrl: (node) => node.querySelector("cite")?.textContent
        ? `https://${node.querySelector("cite")!.textContent}` : null,
      getButtonTarget: () => null,
      getInsertionAnchor: () => null,
    } as EngineAdapter;
    const manager = new InfiniteScrollManager(engine, container, () => {}, { maxPages: 5 });
    const fetched = new JSDOM(
      `<!DOCTYPE html><html><body><div id="rso">
        <div class="kb0PBd"><img class="XNo5Ab" src="about:blank"><cite>x.com</cite></div>
      </div></body></html>`,
      { url: "https://www.google.com/search?q=t" }
    ).window.document;
    (manager as unknown as { appendNodes(n: Element[], d?: Document): void })
      .appendNodes(Array.from(fetched.querySelectorAll(".kb0PBd")), fetched);

    const img = container.querySelector<HTMLImageElement>("[data-inf-page] img");
    expect(img).not.toBeNull();
    expect(img!.src).toBe("https://www.google.com/s2/favicons?domain=x.com&sz=32");
  });
});
