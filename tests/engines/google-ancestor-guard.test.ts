import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { GoogleAdapter } from "../../src/content/engines/google";
import {
  isInsideProcessedTerritory,
  containsProcessed,
  overlapsProcessed,
} from "../../src/content/blocking/dedupe";

// ============================================================
// Ancestor guard — "click Show twice" double-collapse
// (field report 2026-09-06, v1.8.8)
//
// Flow, reproduced with the REAL adapter:
//   1. Append path: getResultNodes(fetchedDoc) → MjjYud-level nodes
//      (whole-document pass) → hideResult stamps data-shh-result +
//      inserts placeholder box #1.
//   2. Observer subtree pass: getResultNodes(addedElement) cannot
//      resolve the stream by ID from inside a subtree → legacy
//      selectors → offers the inner div.tF2Cxc of the SAME result.
//   3. Without the ancestor guard: hideResult(tF2Cxc) → placeholder
//      box #2 INSIDE the hidden outer result → "click Show twice".
//
// Binds to the SHIPPED guard (dedupe.isInsideProcessedTerritory —
// the exact function processResults calls). An earlier version of
// this test mirrored the guard chain inline; a fresh-eyes reviewer
// proved that mirror survives a full revert of the shipped guard
// (514/514 green) — this file exists so that can never happen again.
// ============================================================

const SERP = `<!DOCTYPE html><html><body><div id="rso">
  <div class="MjjYud"><div class="A6K0A"><div class="tF2Cxc Ww4FFb">
    <div class="kb0PBd"><div class="yuRUbf"><a href="/goto?url=X"><h3>r1</h3></a></div><cite>blocked.com</cite></div>
    <div class="kb0PBd"><div class="yuRUbf"><a href="/goto?url=Y"><h3>r2</h3></a></div><cite>blocked.com</cite></div>
  </div></div></div>
</div></body></html>`;

describe("ancestor guard — no second stamp inside a stamped result (shipped guard)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("the inner tF2Cxc the observer offers is rejected by the SHIPPED guard", () => {
    // Step 1: append-path extraction on the fetched doc (real adapter).
    const fetched = new JSDOM(SERP, { url: "https://www.google.com/search?q=x" }).window.document;
    const adapter = new GoogleAdapter();
    adapter.onInit(fetched);
    const extracted = adapter.getResultNodes(fetched);
    expect(extracted.length).toBeGreaterThan(0);
    for (const n of extracted) n.setAttribute("data-shh-result", "block");

    // Step 2: the live copy after the append path stamped its results.
    const live = new JSDOM(SERP, { url: "https://www.google.com/search?q=x" }).window.document;
    for (const n of Array.from(live.querySelectorAll(".MjjYud"))) {
      n.setAttribute("data-shh-result", "block");
    }

    // What the observer's subtree pass offers (real adapter).
    const subtreeNodes = adapter.getResultNodes(live.querySelector("#rso")!);
    expect(subtreeNodes.length).toBeGreaterThan(0);

    // THE ASSERTION: for every offered node that lives INSIDE a stamped
    // MjjYud, the shipped guard rejects it — no second stamp, no second
    // placeholder box, no "click Show twice".
    for (const offered of subtreeNodes) {
      const cls = String(offered.className);
      if (cls.includes("tF2Cxc") || cls.includes("kb0PBd")) {
        expect(isInsideProcessedTerritory(offered)).toBe(true);
      }
    }
  });

  it("a genuinely fresh result (no stamped ancestor) passes the shipped guard", () => {
    const live = new JSDOM(SERP, { url: "https://www.google.com/search?q=x" }).window.document;
    const adapter = new GoogleAdapter();
    adapter.onInit(live);
    const nodes = adapter.getResultNodes(live);
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      expect(isInsideProcessedTerritory(n)).toBe(false);
    }
  });

  it("data-shh-preloaded ancestors count too (preload-hidden wrapper guards its subtree)", () => {
    const live = new JSDOM(SERP, { url: "https://www.google.com/search?q=x" }).window.document;
    live.querySelector(".MjjYud")!.setAttribute("data-shh-preloaded", "true");
    const inner = live.querySelector(".tF2Cxc")!;
    expect(isInsideProcessedTerritory(inner)).toBe(true);
    // But the preloaded node ITSELF is not "inside" anything (self-exclusion
    // mirrors overlapsProcessed — the content script must still be able to
    // stamp/reveal it).
    expect(isInsideProcessedTerritory(live.querySelector(".MjjYud")!)).toBe(false);
  });
});
