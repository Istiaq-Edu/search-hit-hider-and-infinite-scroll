import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { GoogleAdapter } from "../../src/content/engines/google";
import { collectGoogleResults } from "../../src/content/engines/google-dom";
import {
  overlapsProcessed,
  containsProcessed,
  isInsideProcessedTerritory,
  looksLikeResultList,
} from "../../src/content/blocking/dedupe";
import { injectBlockButton } from "../../src/content/ui/block-button";

// ============================================================
// Duplicate block buttons / duplicate placeholder boxes on Google
//
// Field report 2026-08-30 (v1.8.5 live): "there is an issue with double
// block buttons and when there is a blocked result ... [the box] shows also
// double — issue only there for Google."
//
// MECHANISM (reproduced end to end in the last three tests)
//
//   1. Infinite scroll appends page N as ONE wrapper:
//        <div id="shh-inf-page-2" data-inf-page="2"> …results… </div>
//      inserted into #rso in a single operation (manager.ts appendNodes).
//   2. The MutationObserver therefore reports exactly ONE added node: the
//      page WRAPPER. The individual results were appended while the wrapper
//      was still detached, so they never appear as mutations.
//   3. processResultNodes() asks the adapter for results inside that node.
//      GoogleAdapter resolves the results stream by ID (#rso, #center_col …)
//      and an ID can never be found from inside a subtree, so it returns [].
//      (Characterised by the first test below.)
//   4. processResultNodes() then falls back to "the added node is itself one
//      result" and pushes the WRAPPER into the blocking pipeline.
//   5. The wrapper resolves to the same <h3> as the first real result inside
//      it → a SECOND block button lands in that heading. And when the
//      wrapper's single display domain is on the block list, hideResult()
//      runs on the wrapper too → a SECOND placeholder box.
//
// Only Google is affected: every other engine discovers results with
// DESCENDANT class selectors, which work fine from inside a subtree, so their
// getResultNodes(wrapper) returns the real results and the fallback never
// fires.
// ============================================================

const SERP_URL = "https://www.google.com/search?q=test";
const GOTO = "/goto?url=CAESUQHrOzAVzBTZa";

function docOf(centerCol: string): Document {
  const html = `<!DOCTYPE html><html><body>
    <div id="main"><div id="cnt"><div id="rcnt">
      <div id="center_col">${centerCol}</div>
    </div></div></div>
  </body></html>`;
  return new JSDOM(html, { url: SERP_URL }).window.document;
}

/** One organic result, 2026 layout, opaque title link. */
function organic(host: string, withCite = true): string {
  const cite = withCite ? `<div class="VwiC3b"><cite>${host}</cite></div>` : "";
  return `<div class="MjjYud">
      <div class="kb0PBd">
        <div class="yuRUbf"><a href="${GOTO}${host}"><h3>${host}</h3></a></div>
        ${cite}
      </div>
    </div>`;
}

function adapterFor(doc: Document): GoogleAdapter {
  const a = new GoogleAdapter();
  a.onInit(doc);
  return a;
}

// ── 1. Characterise the failing precondition ──────────────────────────────

describe("GoogleAdapter.getResultNodes on a subtree", () => {
  it("returns nothing for a detached page wrapper — the observer's node", () => {
    const doc = docOf(`<div id="rso">${organic("a.com")}</div>`);
    const adapter = adapterFor(doc);

    // Exactly what manager.appendNodes builds and inserts as ONE operation.
    const wrapper = doc.createElement("div");
    wrapper.id = "shh-inf-page-2";
    wrapper.setAttribute("data-inf-page", "2");
    wrapper.innerHTML = organic("c.com") + organic("d.com") + organic("e.com");

    // #rso is OUTSIDE the subtree, so no id-based stream selector can match.
    // This is why the caller has to fall back at all — and why the fallback
    // needs guards.
    expect(adapter.getResultNodes(wrapper)).toEqual([]);
    expect(collectGoogleResults(wrapper, () => true)).toEqual([]);
  });

  it("still resolves every result from the document", () => {
    const doc = docOf(
      `<div id="rso">${organic("a.com")}${organic("b.com")}</div>`
    );
    expect(adapterFor(doc).getResultNodes(doc).length).toBe(2);
  });
});

// ── 2. Overlap guards ─────────────────────────────────────────────────────

describe("overlap guards", () => {
  it("flags a wrapper that CONTAINS an already processed result", () => {
    const doc = docOf(`<div id="rso"></div>`);
    const wrapper = doc.createElement("div");
    wrapper.innerHTML =
      `<div data-shh-result="block"><h3>a</h3></div>` +
      `<div data-shh-btn="1"><h3>b</h3></div>`;
    doc.body.appendChild(wrapper);

    expect(containsProcessed(wrapper)).toBe(true);
    expect(overlapsProcessed(wrapper)).toBe(true);
  });

  it("flags a node that SITS INSIDE an already processed result", () => {
    const doc = docOf(`<div id="rso"></div>`);
    const outer = doc.createElement("div");
    outer.setAttribute("data-shh-result", "block");
    const inner = doc.createElement("div");
    outer.appendChild(inner);
    doc.body.appendChild(outer);

    expect(overlapsProcessed(inner)).toBe(true);
  });

  it("leaves a clean, untouched result alone", () => {
    const doc = docOf(`<div id="rso">${organic("a.com")}</div>`);
    const result = doc.querySelector(".MjjYud") as Element;

    expect(containsProcessed(result)).toBe(false);
    expect(overlapsProcessed(result)).toBe(false);
  });

  it("does NOT flag a node merely because a sibling is processed", () => {
    const doc = docOf(`<div id="rso"></div>`);
    const rso = doc.querySelector("#rso") as Element;
    const done = doc.createElement("div");
    done.setAttribute("data-shh-btn", "1");
    const fresh = doc.createElement("div");
    fresh.innerHTML = "<h3>fresh</h3>";
    rso.append(done, fresh);

    expect(overlapsProcessed(fresh)).toBe(false);
  });
});

// ── 3. Result-list probe ──────────────────────────────────────────────────

describe("looksLikeResultList", () => {
  it("recognises a wrapper holding several results as a list", () => {
    const doc = docOf(`<div id="rso"></div>`);
    const wrapper = doc.createElement("div");
    wrapper.innerHTML = organic("a.com") + organic("b.com");
    doc.body.appendChild(wrapper);

    expect(looksLikeResultList(wrapper)).toBe(true);
  });

  it("does not mistake a single result for a list", () => {
    const doc = docOf(`<div id="rso">${organic("a.com")}</div>`);
    const result = doc.querySelector(".MjjYud") as Element;

    expect(looksLikeResultList(result)).toBe(false);
  });
});

// ── 4. The block button must never be injected twice into one target ──────

describe("injectBlockButton duplicate-target guard", () => {
  it("refuses to add a second button to a target that already has one", () => {
    const doc = docOf(`<div id="rso">${organic("a.com")}</div>`);
    const heading = doc.querySelector("h3") as Element;

    // A wrapper and the real result inside it both resolve to the same <h3>.
    const outer = doc.createElement("div");
    const inner = doc.createElement("div");
    doc.body.append(outer, inner);

    const first = injectBlockButton(outer, heading, "append", "text", () => {});
    const second = injectBlockButton(inner, heading, "append", "text", () => {});

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(heading.querySelectorAll(".shh-block-btn").length).toBe(1);
  });

  it("still injects into targets that have no button yet", () => {
    const doc = docOf(`<div id="rso"></div>`);
    const a = doc.createElement("h3");
    const b = doc.createElement("h3");
    doc.body.append(a, b);

    expect(injectBlockButton(a, a, "append", "text", () => {})).not.toBeNull();
    expect(injectBlockButton(b, b, "append", "text", () => {})).not.toBeNull();
    expect(doc.querySelectorAll(".shh-block-btn").length).toBe(2);
  });
});

// ── 5. End-to-end: the reported symptom ───────────────────────────────────

/**
 * Mirror of index.ts processResultNodes() — kept structurally identical so
 * the test exercises the same decisions as production.
 */
function mirrorProcessResultNodes(engine: GoogleAdapter, nodes: Element[]): Element[] {
  const resultNodes: Element[] = [];
  for (const node of nodes) {
    const engineNodes = engine.getResultNodes(node);
    if (engineNodes.length > 0) {
      resultNodes.push(...engineNodes);
    } else if (!overlapsProcessed(node) && !looksLikeResultList(node)) {
      const url = engine.getResultUrl(node);
      if (url) resultNodes.push(node);
    }
  }
  return resultNodes;
}

/** Mirror of the unblocked half of processResults() + injectButtonForResult. */
function mirrorInjectButtons(engine: GoogleAdapter, nodes: Element[]): void {
  for (const node of nodes) {
    if (containsProcessed(node)) continue;
    const target = engine.getButtonTarget(node);
    if (!target) continue;
    injectBlockButton(node, target, "append", "text", () => {});
  }
}

describe("observer path: an appended page wrapper must not become a result", () => {
  it("yields no extra result node for a page wrapper (double block button)", () => {
    const doc = docOf(
      `<div id="rso">${organic("a.com")}${organic("b.com")}</div>`
    );
    const adapter = adapterFor(doc);

    // Page 1: every result gets a block button.
    const page1 = adapter.getResultNodes(doc);
    expect(page1.length).toBe(2);
    mirrorInjectButtons(adapter, page1);
    expect(doc.querySelectorAll(".shh-block-btn").length).toBe(2);

    // Infinite scroll appends page 2 holding a SINGLE new result — the shape
    // where the wrapper itself still resolves to one display domain.
    const wrapper = doc.createElement("div");
    wrapper.id = "shh-inf-page-2";
    wrapper.setAttribute("data-inf-page", "2");
    wrapper.innerHTML = organic("c.com");
    (doc.querySelector("#rso") as Element).appendChild(wrapper);

    // The manager reports the individual results and they get their buttons.
    mirrorInjectButtons(adapter, Array.from(wrapper.children));

    // The observer reports only the wrapper. It must not become a result.
    const reported = mirrorProcessResultNodes(adapter, [wrapper]);
    expect(reported).toEqual([]);

    mirrorInjectButtons(adapter, reported);
    expect(doc.querySelectorAll(".shh-block-btn").length).toBe(3);
    for (const h of Array.from(doc.querySelectorAll("h3"))) {
      expect(h.querySelectorAll(".shh-block-btn").length).toBe(1);
    }
  });

  it("yields no extra result node for a wrapper around a blocked result (double box)", () => {
    const doc = docOf(`<div id="rso">${organic("a.com")}</div>`);
    const adapter = adapterFor(doc);

    const page1 = adapter.getResultNodes(doc);
    expect(page1.length).toBe(1);

    // The manager hid page 2's result and inserted its placeholder box.
    const wrapper = doc.createElement("div");
    wrapper.id = "shh-inf-page-2";
    wrapper.innerHTML = organic("b.com");
    (doc.querySelector("#rso") as Element).appendChild(wrapper);
    const inner = wrapper.firstElementChild as Element;
    inner.setAttribute("data-shh-result", "block");
    const box = doc.createElement("div");
    box.setAttribute("data-shh-placeholder", "true");
    wrapper.insertBefore(box, inner);

    const reported = mirrorProcessResultNodes(adapter, [wrapper]);
    expect(reported).toEqual([]);
    expect(doc.querySelectorAll("[data-shh-placeholder]").length).toBe(1);
  });

  it("still reports a genuinely new single result that the observer adds", () => {
    const doc = docOf(`<div id="rso">${organic("a.com")}</div>`);
    const adapter = adapterFor(doc);
    mirrorInjectButtons(adapter, adapter.getResultNodes(doc));

    // Google inserts one fresh result block straight into #rso.
    const fresh = doc.createElement("div");
    fresh.className = "MjjYud";
    fresh.innerHTML =
      `<div class="kb0PBd"><div class="yuRUbf"><a href="${GOTO}z"><h3>new.com</h3></a></div>` +
      `<div class="VwiC3b"><cite>new.com</cite></div></div>`;
    (doc.querySelector("#rso") as Element).appendChild(fresh);

    const reported = mirrorProcessResultNodes(adapter, [fresh]);
    expect(reported.length).toBe(1);
    expect(reported[0]).toBe(fresh);

    mirrorInjectButtons(adapter, reported);
    expect(doc.querySelectorAll(".shh-block-btn").length).toBe(2);
  });

  it("a PRELOAD-hidden result is not skipped by overlapsProcessed (stale-cache reveal must work)", () => {
    // 2026-09-06 desync hole (subagent-audited): the preload hid a node
    // (data-shh-preloaded) before the content script ran. The observer then
    // hands us that node. overlapsProcessed must NOT treat the node itself
    // as processed — the content script still has to stamp it (or REVEAL it
    // when the preload acted on a stale cache). Only ANCESTOR and DESCENDANT
    // relationships count.
    //
    // REVISED after A2 F2 (2026-09-06 deep review): a wrapper around a
    // preloaded-only node must NOT be skipped EITHER. The preload's mark
    // carries no content-script UI — the wrapper is the node the adapter
    // offers, so skipping it left blocked results hidden with no box and
    // no unblock control (Yandex li.serp-item, Google MjjYud>div.g). Only
    // UI markers (result/btn/placeholder) make a wrapper a container;
    // preloaded ANCESTORS still guard inner nodes via the ancestor walk.
    const doc = docOf(`<div id="rso">${organic("a.com")}</div>`);
    const adapter = adapterFor(doc);
    const result = adapter.getResultNodes(doc)[0]!;

    // The preload's mark: hidden, but NO content-script UI on it.
    result.setAttribute("data-shh-preloaded", "true");

    // Self with preloaded mark → NOT processed (needs stamping/revealing).
    expect(overlapsProcessed(result)).toBe(false);

    // A node INSIDE the preloaded result → processed (don't double-handle).
    const inner = result.querySelector(".yuRUbf")!;
    expect(overlapsProcessed(inner)).toBe(true);

    // A WRAPPER around the preloaded result → NOT processed (A2 F2): the
    // wrapper is the result the adapter offers; it must reach hideResult
    // to gain the placeholder box and Show/Unblock controls.
    const wrapper = doc.createElement("div");
    wrapper.setAttribute("data-inf-page", "2");
    result.parentElement!.insertBefore(wrapper, result);
    wrapper.appendChild(result);
    expect(overlapsProcessed(wrapper)).toBe(false);
    expect(containsProcessed(wrapper)).toBe(false);
    // ...while the ANCESTOR guard still recognizes the preloaded subtree.
    expect(isInsideProcessedTerritory(inner)).toBe(true);
  });
});
