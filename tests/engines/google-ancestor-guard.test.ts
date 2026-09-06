import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { GoogleAdapter } from "../../src/content/engines/google";

// ============================================================
// Ancestor guard — "click Show twice" double-collapse
// (field report 2026-09-06, v1.8.8)
//
// Flow, reproduced with the REAL adapter:
//   1. Append path: getResultNodes(fetchedDoc) → MjjYud-level nodes
//      (whole-document pass; each MjjYud has 1 heading) → hideResult
//      stamps data-shh-result + inserts placeholder box #1.
//   2. Observer subtree pass: getResultNodes(addedElement) cannot
//      resolve the stream by ID from inside a subtree → legacy
//      selectors → offers the inner div.tF2Cxc of the SAME result.
//      Self-check (data-shh-result on tF2Cxc): false.
//      containsProcessed (descendants): false — the stamped MjjYud
//      is an ANCESTOR, not a descendant.
//   3. Without the ancestor guard: hideResult(tF2Cxc) → placeholder
//      box #2 INSIDE the hidden outer result → user must click Show
//      twice to see the content.
//
// The fix: processResults skips any node with a stamped ancestor
// (data-shh-result or data-shh-preloaded) — the mirror of the
// existing container guard.
// ============================================================

const SERP = `<!DOCTYPE html><html><body><div id="rso">
  <div class="MjjYud"><div class="A6K0A"><div class="tF2Cxc Ww4FFb">
    <div class="kb0PBd"><div class="yuRUbf"><a href="/goto?url=X"><h3>r1</h3></a></div><cite>blocked.com</cite></div>
    <div class="kb0PBd"><div class="yuRUbf"><a href="/goto?url=Y"><h3>r2</h3></a></div><cite>blocked.com</cite></div>
  </div></div></div>
</div></body></html>`;

/** Mirror of processResults' guard chain (self → container → ancestor). */
function guardsPass(node: Element): boolean {
  if (node.getAttribute("data-shh-result")) return false;
  // container guard (descendants)
  if (node.querySelector('[data-shh-result], [data-shh-btn], [data-shh-placeholder], [data-shh-preloaded]')) return false;
  // ancestor guard (the fix)
  for (let a: Element | null = node.parentElement; a; a = a.parentElement) {
    if (a.hasAttribute("data-shh-result") || a.hasAttribute("data-shh-preloaded")) return false;
  }
  return true;
}

describe("ancestor guard — no second stamp inside a stamped result", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("the inner tF2Cxc of a stamped MjjYud is rejected by the guard chain", () => {
    // Step 1: append-path extraction on the fetched doc (real adapter).
    const fetched = new JSDOM(SERP, { url: "https://www.google.com/search?q=x" }).window.document;
    const adapter = new GoogleAdapter();
    adapter.onInit(fetched);
    const extracted = adapter.getResultNodes(fetched);
    expect(extracted.length).toBeGreaterThan(0);
    // The append path stamps them (mirrors hideResult).
    for (const n of extracted) n.setAttribute("data-shh-result", "block");

    // Step 2: observer subtree pass over the live (stamped) copy — real adapter.
    const live = new JSDOM(SERP, { url: "https://www.google.com/search?q=x" }).window.document;
    const stamped = live.querySelectorAll(".MjjYud");
    for (const n of Array.from(stamped)) n.setAttribute("data-shh-result", "block");

    const subtreeNodes = adapter.getResultNodes(live.querySelector("#rso")!);
    // The subtree pass offers the inner tF2Cxc (the double-stamp trigger).
    expect(subtreeNodes.length).toBeGreaterThan(0);

    for (const offered of subtreeNodes) {
      const cls = String(offered.className);
      if (cls.includes("tF2Cxc") || cls.includes("kb0PBd")) {
        // THE ASSERTION: the guard chain must reject it — no second stamp.
        expect(guardsPass(offered)).toBe(false);
      }
    }
  });

  it("a genuinely fresh result (no stamped ancestor) still passes the guards", () => {
    const live = new JSDOM(SERP, { url: "https://www.google.com/search?q=x" }).window.document;
    // No stamps anywhere — the initial page-1 pass.
    const adapter = new GoogleAdapter();
    adapter.onInit(live);
    const nodes = adapter.getResultNodes(live);
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      expect(guardsPass(n)).toBe(true);
    }
  });
});
