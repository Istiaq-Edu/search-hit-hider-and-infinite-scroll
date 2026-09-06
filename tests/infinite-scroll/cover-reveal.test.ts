import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { InfiniteScrollManager } from "../../src/content/infinite-scroll/manager";
import type { EngineAdapter } from "../../src/content/engines/base";

// ============================================================
// Appended-page cover reveal (field log 2026-09-06, v1.8.7):
// "the new results doesnt visible on the screen."
//
// The failing SERP ships results inside div.tF2Cxc SECTION wrappers
// (the adapter extracts MjjYud-level nodes; tF2Cxc rides along inside
// — verified against the live-captured 1.6MB SERP). tryHide's
// fail-open section guard leaves tF2Cxc UNSTAMPED, so the preload's
// anti-flicker cover
//   html[data-shh-active] div.tF2Cxc:not(...):not([data-shh-ok]):not([data-shh-preloaded])
//   { opacity:0 !important }
// matches it. Page 1 escapes via the 2s reveal timeout +
// __shhRevealGoogle; APPENDED pages had neither → whole appended
// pages at opacity:0 forever: sized, favicon-painted, invisible.
//
// Fix: appendNodes stamps unhandled cover candidates with
// data-shh-ok AFTER onNewNodes (blocked results already carry
// data-shh-result from hideResult and are skipped).
// ============================================================

/** Field-captured shape: MjjYud > A6K0A > tF2Cxc(section) > kb0PBd(results). */
function fetchedSerpDom(): JSDOM {
  return new JSDOM(
    `<!DOCTYPE html><html><body><div id="rso">
       <div class="MjjYud"><div class="A6K0A" data-rpos="0">
         <div class="tF2Cxc Ww4FFb">
           <div class="kb0PBd"><div class="yuRUbf"><a href="/goto?url=X"><h3>r1</h3></a></div><cite>a.com</cite></div>
           <div class="kb0PBd"><div class="yuRUbf"><a href="/goto?url=Y"><h3>r2</h3></a></div><cite>b.com</cite></div>
           <div class="kb0PBd"><div class="yuRUbf"><a href="/goto?url=Z"><h3>r3</h3></a></div><cite>c.com</cite></div>
         </div>
       </div></div>
     </div></body></html>`,
    { url: "https://www.google.com/search?q=test" }
  );
}

function googleEngine(): EngineAdapter {
  return {
    id: "google",
    name: "Google",
    matches: () => true,
    getResultNodes: (root) => Array.from((root as ParentNode).querySelectorAll(".kb0PBd")),
    getResultUrl: (node) => {
      const cite = node.querySelector("cite");
      return cite?.textContent ? `https://${cite.textContent}` : null;
    },
    getButtonTarget: () => null,
    getInsertionAnchor: () => null,
  } as EngineAdapter;
}

function callAppend(manager: InfiniteScrollManager, nodes: Element[], sourceDoc: Document): void {
  (manager as unknown as { appendNodes(n: Element[], d?: Document): void }).appendNodes(nodes, sourceDoc);
}

describe("appended-page cover reveal (tF2Cxc section field shape)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-shh-active");
  });

  it("stamps the tF2Cxc cover wrapper so appended results are visible", () => {
    document.documentElement.setAttribute("data-shh-active", "true");
    document.body.innerHTML = `<div id="rso"><div class="MjjYud">page1</div></div>`;
    const container = document.querySelector("#rso")!;

    const manager = new InfiniteScrollManager(
      googleEngine(), container, () => {}, { maxPages: 20 }
    );
    const fetched = fetchedSerpDom().window.document;
    // What the adapter really extracts: MjjYud-level nodes (tF2Cxc inside).
    const nodes = Array.from(fetched.querySelectorAll(".MjjYud"));
    callAppend(manager, nodes, fetched);

    const page = container.querySelector("[data-inf-page]") as HTMLElement;
    expect(page).not.toBeNull();

    // The tF2Cxc wrapper matches the cover CSS — without the fix it stays
    // unstamped → opacity:0 → invisible results (the field bug).
    const tF2Cxc = page.querySelector("div.tF2Cxc");
    expect(tF2Cxc).not.toBeNull();
    expect(tF2Cxc!.hasAttribute("data-shh-ok")).toBe(true);
    // ...and it is NOT wrongly hidden (no preloaded/result marks).
    expect(tF2Cxc!.hasAttribute("data-shh-preloaded")).toBe(false);
    expect(tF2Cxc!.hasAttribute("data-shh-result")).toBe(false);
  });

  it("never stamps nodes the blocking pipeline handled (blocked results stay hidden)", () => {
    document.documentElement.setAttribute("data-shh-active", "true");
    document.body.innerHTML = `<div id="rso"><div class="MjjYud">page1</div></div>`;
    const container = document.querySelector("#rso")!;
    const manager = new InfiniteScrollManager(
      googleEngine(), container, (nodes) => {
        // Mirror of onNewNodes → processResults → hideResult for a blocked
        // domain: the adapter extracts the kb0PBd INSIDE the appended node,
        // hideResult stamps it with data-shh-result + inline display:none.
        const inner = nodes[0]?.querySelector(".kb0PBd");
        if (inner) {
          inner.setAttribute("data-shh-result", "block");
          (inner as HTMLElement).style.display = "none";
        }
      }, { maxPages: 20 }
    );
    const fetched = fetchedSerpDom().window.document;
    const nodes = Array.from(fetched.querySelectorAll(".MjjYud"));
    callAppend(manager, nodes, fetched);

    const page = container.querySelector("[data-inf-page]") as HTMLElement;
    // Blocked result keeps its blocking marks and was not "revealed".
    const blocked = page.querySelector(".kb0PBd");
    expect(blocked!.hasAttribute("data-shh-result")).toBe(true);
    expect(blocked!.hasAttribute("data-shh-ok")).toBe(false);
    expect((blocked as HTMLElement).style.display).toBe("none");
    // The section wrapper around it is revealed (not blocked itself).
    const tF2Cxc = page.querySelector("div.tF2Cxc");
    expect(tF2Cxc!.hasAttribute("data-shh-ok")).toBe(true);
  });
});
