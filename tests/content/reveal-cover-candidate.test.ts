import { describe, it, expect, beforeEach } from "vitest";
import { revealCoverCandidate } from "../../src/content/markers";

// ============================================================
// revealCoverCandidate — "we decided not to hide this, so it must not stay
// covered"
//
// Field report 2026-10-10: "results are not visible on the screen but there is
// space for that result". `opacity:0` preserves layout, so a node the cover is
// holding renders as a correctly-sized blank gap.
//
// The cover matches EVERY div.g / div.tF2Cxc in the document, and only a
// POSITIVE marker lifts it. The preload's three fail-open guards (container /
// section / aggregate) used to `return` without one, which left the node
// undetermined — invisible, with no way back. These tests pin the contract of
// the step that closes that hole. They bind to the SHIPPED function; the
// bundle-level tests in tests/preload-flicker.test.ts drive it through the real
// MutationObserver.
// ============================================================

function el(html: string): Element {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild as Element;
}

describe("revealCoverCandidate", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("stamps data-shh-ok on an undetermined div.tF2Cxc", () => {
    const node = el(`<div class="tF2Cxc"><h3>a</h3></div>`);
    document.body.appendChild(node);

    expect(revealCoverCandidate(node)).toBe(true);
    expect(node.getAttribute("data-shh-ok")).toBe("true");
  });

  it("stamps data-shh-ok on an undetermined div.g", () => {
    const node = el(`<div class="g"><h3>a</h3></div>`);
    document.body.appendChild(node);

    expect(revealCoverCandidate(node)).toBe(true);
    expect(node.getAttribute("data-shh-ok")).toBe("true");
  });

  it("is idempotent — a second call reports that it stamped nothing", () => {
    const node = el(`<div class="tF2Cxc"><h3>a</h3></div>`);
    document.body.appendChild(node);

    expect(revealCoverCandidate(node)).toBe(true);
    expect(revealCoverCandidate(node)).toBe(false);
  });

  it("refuses a node the cover could not match, so nothing else is stamped", () => {
    const node = el(`<div class="MjjYud"><h3>a</h3></div>`);
    document.body.appendChild(node);

    expect(revealCoverCandidate(node)).toBe(false);
    expect(node.hasAttribute("data-shh-ok")).toBe(false);
  });

  it("refuses a NESTED div.g — the cover's :not(.g .g) guard excludes it", () => {
    const outer = el(`<div class="g"><div class="g inner"><h3>a</h3></div></div>`);
    document.body.appendChild(outer);
    const inner = outer.querySelector(".inner")!;

    // The inner node is `.g .g`, so the cover never matched it and there is
    // nothing to lift. Stamping it would be a marker with no meaning.
    expect(revealCoverCandidate(inner)).toBe(false);
    expect(inner.hasAttribute("data-shh-ok")).toBe(false);
  });

  // ── Never override a determination that already exists ──────────────────
  //
  // Each of these is the direction that could REVEAL a blocked result, which is
  // the one outcome this function must never cause.

  it("leaves an already-safe node alone", () => {
    const node = el(`<div class="tF2Cxc" data-shh-ok="true"><h3>a</h3></div>`);
    document.body.appendChild(node);

    expect(revealCoverCandidate(node)).toBe(false);
    expect(node.getAttribute("data-shh-ok")).toBe("true");
  });

  it("leaves a preload-HIDDEN node alone and never marks it safe", () => {
    const node = el(`<div class="tF2Cxc" data-shh-preloaded="true"><h3>a</h3></div>`);
    document.body.appendChild(node);

    expect(revealCoverCandidate(node)).toBe(false);
    expect(node.hasAttribute("data-shh-ok")).toBe(false);
    expect(node.getAttribute("data-shh-preloaded")).toBe("true");
  });

  it("leaves a result the content script already handled alone", () => {
    const node = el(`<div class="tF2Cxc" data-shh-result="block"><h3>a</h3></div>`);
    document.body.appendChild(node);

    expect(revealCoverCandidate(node)).toBe(false);
    expect(node.hasAttribute("data-shh-ok")).toBe(false);
  });

  it("marks a container safe without touching a blocked result inside it", () => {
    // The safety argument for stamping a CONTAINER: a blocked result is hidden
    // by its own display:none + data-shh-preloaded, so marking the wrapper safe
    // cannot expose it.
    const wrap = el(`
      <div class="g">
        <div class="tF2Cxc" data-shh-preloaded="true" style="display:none !important"><h3>x</h3></div>
        <div class="tF2Cxc"><h3>y</h3></div>
      </div>`);
    document.body.appendChild(wrap);

    expect(revealCoverCandidate(wrap)).toBe(true);
    expect(wrap.getAttribute("data-shh-ok")).toBe("true");

    const blocked = wrap.querySelector("[data-shh-preloaded]")!;
    expect(blocked.hasAttribute("data-shh-ok")).toBe(false);
    expect((blocked as HTMLElement).style.display).toBe("none");
  });
});
