import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { InfiniteScrollManager } from "../../src/content/infinite-scroll/manager";
import type { EngineAdapter } from "../../src/content/engines/base";

// ============================================================
// Google favicon provisioning (field log 2026-09-06):
// "favicon intel captured: 0 hosts … chip: none … faviconsPainted:0".
// Root cause: the whole favicon pipeline keyed on
// [class*="favicon" i] — Startpage anatomy. Google's 2026 SERP
// ships favicons as <img> elements (gstatic s2/favicons URLs or
// inline data: art) under rotating hash classes. These tests pin
// the engine-aware discovery + the first-party s2 fallback, bound
// to the real manager (appendNodes drives the same code the live
// append path runs).
// ============================================================

function googleSerpDom(resultsHtml: string): JSDOM {
  return new JSDOM(
    `<!DOCTYPE html><html><body><div id="rso"><div class="MjjYud"><div class="N54PNb">
       ${resultsHtml}
     </div></div></div></body></html>`,
    { url: "https://www.google.com/search?q=test" }
  );
}

/** One Google 2026 result: hash classes, favicon <img>, opaque /goto?url= link. */
function googleResult(host: string, imgSrc: string): string {
  return `<div class="kb0PBd A9Y9g jGGQ5e">
      <div class="yuRUbf">
        <img class="XNo5Ab" src="${imgSrc}" alt="" width="26" height="26">
        <div class="b8lM7"><span class="V9tjod">
          <a jsname="UWckNb" class="zReHs" href="/goto?url=CAESUQ${host}"><h3>${host} title</h3></a>
        </span></div>
      </div>
      <cite>${host} › docs</cite>
    </div>`;
}

/** Google-shaped engine adapter: resolves destinations from the display URL. */
function googleLikeEngine(container: Element | null): EngineAdapter {
  return {
    id: "google",
    name: "Google",
    matches: () => true,
    getResultNodes: (root) =>
      Array.from((root as ParentNode).querySelectorAll(".kb0PBd")),
    getResultUrl: (node) => {
      const cite = node.querySelector("cite");
      const host = (cite?.textContent ?? "").split(/[ ›]/)[0]?.trim() ?? "";
      return host ? `https://${host}` : null;
    },
    getButtonTarget: () => null,
    getInsertionAnchor: () => container,
  } as EngineAdapter;
}

function callAppend(manager: InfiniteScrollManager, nodes: Element[], sourceDoc?: Document): void {
  (manager as unknown as { appendNodes(n: Element[], d?: Document): void }).appendNodes(nodes, sourceDoc);
}

describe("InfiniteScrollManager — Google favicon provisioning", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("re-points a dead clone <img> at Google's first-party s2 endpoint", () => {
    const dom = googleSerpDom(googleResult("a.com", "about:blank"));
    const liveDoc = dom.window.document;
    const container = liveDoc.querySelector("#rso")!;
    const manager = new InfiniteScrollManager(
      googleLikeEngine(container), container, () => {}, { maxPages: 5 }
    );
    const node = liveDoc.querySelector(".kb0PBd")!;
    callAppend(manager, [node]);

    // appendNodes deep-clones into the live document — assert on the CLONE.
    const img = container.querySelector<HTMLImageElement>("[data-inf-page] img.XNo5Ab");
    expect(img).not.toBeNull();
    expect(img!.src).toBe("https://www.google.com/s2/favicons?domain=a.com&sz=32");
    expect(new URL(img!.src).hostname).toBe("www.google.com");
  });

  it("keeps inline data: art as-is (already painted)", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    const dom = googleSerpDom(googleResult("a.com", dataUrl));
    const liveDoc = dom.window.document;
    const container = liveDoc.querySelector("#rso")!;
    const manager = new InfiniteScrollManager(
      googleLikeEngine(container), container, () => {}, { maxPages: 5 }
    );
    const node = liveDoc.querySelector(".kb0PBd")!;
    callAppend(manager, [node]);

    const img = container.querySelector<HTMLImageElement>("[data-inf-page] img.XNo5Ab");
    expect(img!.src).toBe(dataUrl);
  });

  it("keeps Google's own gstatic s2 URL (no churn on already-good art)", () => {
    const liveS2 = "https://www.gstatic.com/s2/favicons?domain=a.com&sz=64&chl=abc";
    const dom = googleSerpDom(googleResult("a.com", liveS2));
    const liveDoc = dom.window.document;
    const container = liveDoc.querySelector("#rso")!;
    const manager = new InfiniteScrollManager(
      googleLikeEngine(container), container, () => {}, { maxPages: 5 }
    );
    const node = liveDoc.querySelector(".kb0PBd")!;
    callAppend(manager, [node]);

    const img = container.querySelector<HTMLImageElement>("[data-inf-page] img.XNo5Ab");
    expect(img!.src).toBe(liveS2);
  });
});
