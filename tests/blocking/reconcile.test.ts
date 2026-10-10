import { describe, it, expect, beforeEach } from "vitest";
import { reconcileAgainstBlockList } from "../../src/content/blocking/reconcile";

// ============================================================
// Block-list reconciliation — D1
//
// Field symptom: "some time blocked urls shows some time doesnt."
//
// The mechanism, stated precisely: `refreshEntries` (index.ts) used to
// reconcile the page by walking `getHiddenNodes()` — `[data-shh-result]` —
// and nothing else. A result that is currently VISIBLE carries no such stamp,
// so it was never reconsidered when the block list changed underneath an open
// tab. Block a domain from the popup (or a second tab) while a search is on
// screen and that tab keeps showing it until a reload.
//
// No timing flakiness is involved. It depends only on whether the page was
// loaded before or after the domain was added.
//
// Binds to the SHIPPED `reconcileAgainstBlockList`, per the convention in
// google-ancestor-guard.test.ts:24-28 — a mirror copy survives a full revert
// of the shipped function, so tests must import it.
// ============================================================

const BLOCKED = "blocked.com";
const SAFE = "safe.com";

function stamped(host: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-shh-result", "block");
  el.setAttribute("data-shh-url", `https://${host}/page`);
  el.style.setProperty("display", "none", "important");
  document.body.appendChild(el);
  return el;
}

/** A stamped node that is blocked only for as long as `on` returns true. */
function gated(url: string, on: () => boolean): (u: string) => boolean {
  return (u: string) => (u === url ? on() : u.includes(BLOCKED));
}

function visible(host: string | null): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = host
    ? `<div class="yuRUbf"><a href="/goto?url=X"><h3>t</h3></a></div><cite>${host}</cite>`
    : `<h3>no destination</h3>`;
  document.body.appendChild(el);
  return el;
}

// Mirrors the shipped caller: stamped nodes resolve via data-shh-url, visible
// nodes via the engine's extractor.
const isBlocked = (url: string) => url.includes(BLOCKED);
const urlOfVisible = (node: Element) => {
  const cite = node.querySelector("cite");
  return cite ? `https://${cite.textContent}/page` : null;
};

describe("reconcileAgainstBlockList — a domain blocked while the tab is open", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  // ── The regression. Under the old stamped-only walk this node was invisible
  //    to the reconciliation, so it stayed on screen despite being blocked.
  it("restamps a VISIBLE result whose domain is now blocked", () => {
    const shown = visible(BLOCKED);

    const { toRestamp, toRestore } = reconcileAgainstBlockList(
      [], // nothing stamped yet
      [shown],
      isBlocked,
      urlOfVisible
    );

    expect(toRestore).toEqual([]);
    expect(toRestamp).toEqual([shown]);
  });

  it("leaves a visible result alone when its domain is not blocked", () => {
    const shown = visible(SAFE);

    const { toRestamp, toRestore } = reconcileAgainstBlockList(
      [],
      [shown],
      isBlocked,
      urlOfVisible
    );

    expect(toRestamp).toEqual([]);
    expect(toRestore).toEqual([]);
  });

  it("leaves a visible result with no resolvable URL alone", () => {
    // processResults skips these anyway (index.ts `if (!url) continue`).
    // Handing them back would only risk a pointless re-walk.
    const orphan = visible(null);

    const { toRestamp, toRestore } = reconcileAgainstBlockList(
      [],
      [orphan],
      isBlocked,
      urlOfVisible
    );

    expect(toRestamp).toEqual([]);
    expect(toRestore).toEqual([]);
  });

  // ── The pre-existing behaviour, pinned so the fix cannot regress it.
  it("restamps a still-blocked STAMPED node (mode change block → pban)", () => {
    const node = stamped(BLOCKED);

    const { toRestamp, toRestore } = reconcileAgainstBlockList(
      [node],
      [],
      isBlocked,
      urlOfVisible
    );

    expect(toRestore).toEqual([]);
    expect(toRestamp).toEqual([node]);
  });

  it("restores a STAMPED node whose domain was unblocked", () => {
    const node = stamped(BLOCKED);

    const { toRestamp, toRestore } = reconcileAgainstBlockList(
      [node],
      [],
      () => false, // domain removed from the list
      urlOfVisible
    );

    expect(toRestamp).toEqual([]);
    expect(toRestore).toEqual([node]);
  });

  it("does not re-derive a stamped node's URL from the engine", () => {
    // If the engine can no longer resolve the destination, the node must NOT be
    // treated as unblocked — that would reveal a result the user still wants
    // hidden. Stamped nodes therefore use data-shh-url, full stop.
    const node = stamped(BLOCKED);
    // Engine extraction now fails for this node.
    const failingUrlOf = () => null;

    const { toRestore } = reconcileAgainstBlockList(
      [node],
      [],
      isBlocked,
      failingUrlOf
    );

    expect(toRestore).toEqual([]); // still blocked, not restored
  });

  // ── Mixed page: the realistic case.
  it("splits a mixed page correctly", () => {
    // Two stamped nodes, distinguishable only by URL: one still blocked, one
    // unblocked. Plus two visible ones: one newly blocked, one untouched.
    const stillBlocked = stamped(BLOCKED);
    const nowUnblocked = stamped(`${BLOCKED}/gone`);
    const shownNowBlocked = visible(BLOCKED);
    const shownStillFine = visible(SAFE);

    const { toRestamp, toRestore } = reconcileAgainstBlockList(
      [stillBlocked, nowUnblocked],
      [shownNowBlocked, shownStillFine],
      gated(nowUnblocked.getAttribute("data-shh-url")!, () => false),
      urlOfVisible
    );

    expect(toRestamp).toEqual([stillBlocked, shownNowBlocked]);
    expect(toRestore).toEqual([nowUnblocked]);
  });

  it("treats a node present in both sets as stamped, not visible", () => {
    // A full snapshot can contain an already-stamped node. It must not be
    // double-handled: its hide state has to be cleared deliberately, and
    // restoreResult must not run on something we are about to re-hide.
    const node = stamped(BLOCKED);

    const { toRestamp, toRestore } = reconcileAgainstBlockList(
      [node],
      [node],
      isBlocked,
      urlOfVisible
    );

    expect(toRestore).toEqual([]);
    expect(toRestamp).toEqual([node]);
  });

  it("restores a stamped node with no recorded URL rather than keeping it hidden forever", () => {
    // No data-shh-url means we cannot prove it is still blocked. The old code
    // treated a falsy url as `matched: false` → restore, so preserve that.
    const node = document.createElement("div");
    node.setAttribute("data-shh-result", "block");
    document.body.appendChild(node);

    const { toRestore } = reconcileAgainstBlockList([node], [], isBlocked, urlOfVisible);

    expect(toRestore).toEqual([node]);
  });
});
