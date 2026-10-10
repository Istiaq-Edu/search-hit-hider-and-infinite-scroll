import { describe, it, expect, afterEach } from "vitest";
import { containsProcessed, overlapsProcessed } from "../../src/content/blocking/dedupe";
import { injectBlockButton } from "../../src/content/ui/block-button";

// ============================================================
// A1 CLOSURE — "a result's own block button permanently disqualifies it"
//
// This closes a claim that was asserted as the verified root cause of the
// show/hide intermittency, and which turned out to be IMPOSSIBLE as stated.
//
// The claim was: the injected block button lands inside the result's <h3> as
// a descendant, carries `data-shh-btn`, and therefore makes
// `containsProcessed(node)` true — so the node is never offered again and
// stays visible for the life of the page.
//
// Three facts refute it:
//   1. block-button.ts:51 — `container.setAttribute(ATTR_HAS_BTN, "1")`.
//      `container` is the RESULT NODE (passed as `injectBlockButton(node, …)`
//      from index.ts:653). The <button> gets `class="shh-block-btn"` (:60)
//      and no data-shh-* attribute at all.
//   2. styles.ts:99-100 — the repo says so: "data-shh-btn is set on the
//      result card node. The button is a descendant."
//   3. containsProcessed is `el.querySelector(...)` (dedupe.ts:60-66).
//      querySelector matches DESCENDANTS ONLY — it can never return `el`.
//
// Binds to the SHIPPED functions, per the convention established by
// google-ancestor-guard.test.ts: "an earlier version mirrored the guard chain
// inline; a reviewer proved that mirror survives a full revert of the shipped
// guard (514/514 green) — this file exists so that can never happen again."
// Here we go further and use the REAL injector, not a hand-built attribute.
// ============================================================

function makeResult(host: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "kb0PBd";
  node.innerHTML =
    `<div class="yuRUbf"><a href="/goto?url=X"><h3>title</h3></a></div>` +
    `<cite>${host}</cite>`;
  document.body.appendChild(node);
  return node;
}

describe("A1 closure — the shipped container guard vs. a result's own block button", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("stamps data-shh-btn on the RESULT NODE, not on the button", () => {
    // Guards against the exact misreading that produced the false root cause.
    const node = makeResult("blocked.com");
    const heading = node.querySelector("h3") as HTMLElement;
    const btn = injectBlockButton(
      node,
      heading,
      "append",
      "text",
      () => { /* noop */ }
    );

    expect(btn).not.toBeNull();
    // DOM RELATIONSHIP, not the return value. An earlier version of this test
    // asserted only on `btn`, which is the return of injectBlockButton — a
    // mutation that returns the button WITHOUT attaching it satisfied every
    // assertion here, because the whole A1 thesis is about the button being a
    // DESCENDANT of the result.
    expect(btn!.isConnected).toBe(true);
    expect(node.contains(btn)).toBe(true);
    expect(heading.contains(btn)).toBe(true);
    expect(node.getAttribute("data-shh-btn")).toBe("1"); // on the card…
    expect(btn!.hasAttribute("data-shh-btn")).toBe(false); // …NOT on the button
    expect(btn!.classList.contains("shh-block-btn")).toBe(true);
  });

  it("a result carrying its OWN data-shh-btn is NOT rejected by containsProcessed", () => {
    // This is the assertion the false root cause required. It is expected to
    // PASS, and that pass is the finding: the claimed mechanism cannot occur.
    const node = makeResult("blocked.com");
    injectBlockButton(node, node.querySelector("h3") as HTMLElement, "append", "text", () => {});

    expect(node.hasAttribute("data-shh-btn")).toBe(true);
    expect(containsProcessed(node)).toBe(false);
  });

  it("an ANCESTOR of a stamped node IS rejected — the real, inverted variant", () => {
    // The mirror image of the false claim, and the only shape that genuinely
    // disqualifies a node: an INNER node's self-marker sits in the OUTER
    // node's subtree, so the outer node reads as a container.
    //
    // This is characterised, not endorsed. Whether it is reachable on a live
    // SERP is UNVERIFIED — it needs both DOM levels to be offered in one load.
    // It is pinned here so that any future change to this behaviour has to be
    // deliberate rather than incidental.
    const outer = document.createElement("div");
    outer.className = "MjjYud";
    outer.innerHTML = `<h3>section</h3>`;
    const inner = document.createElement("div");
    inner.className = "kb0PBd";
    inner.innerHTML = `<h3>inner</h3>`;
    outer.appendChild(inner);
    document.body.appendChild(outer);

    injectBlockButton(inner, inner.querySelector("h3") as HTMLElement, "append", "text", () => {});

    expect(outer.hasAttribute("data-shh-btn")).toBe(false);
    expect(containsProcessed(outer)).toBe(true); // the ancestor IS rejected
  });

  it("overlapsProcessed still treats a self-marked node as already-handled", () => {
    // overlapsProcessed uses `closest`, which DOES match self — so unlike
    // containsProcessed, a node's own marker legitimately disqualifies it.
    // That behaviour is correct and idempotent (the node was already
    // processed and correctly left visible), and is pinned so it is not
    // "fixed" by someone reading the false root cause.
    const node = makeResult("blocked.com");
    injectBlockButton(node, node.querySelector("h3") as HTMLElement, "append", "text", () => {});

    expect(overlapsProcessed(node)).toBe(true);
  });
});
