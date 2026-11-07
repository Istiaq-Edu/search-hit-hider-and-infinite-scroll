import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import {
  showOnce,
  hideResult,
  rehideResult,
  convertHiddenToPermaban,
} from "../../src/content/blocking/hider";

// ============================================================
// C1 — `block ∧ ok` is an invalid combination.
//
// showOnce stamps data-shh-ok on the revealed node + its cover candidates,
// and preload's tryHide stamps it on positively-cleared nodes. NO hide
// transition used to remove it, so a re-hidden node kept the stamp — and
// tryHide early-returns on ok nodes (preload.ts), which means a node whose
// inline display + adopted .shh-hidden rule get reset by Google is exempt
// from cover recapture: visible, with no path back to hidden.
//
// Every hide transition (hideResult incl. its pban branch, rehideResult via
// hideResult, convertHiddenToPermaban) must drop the stamp on self AND the
// same cover-candidate scope showOnce stamps.
//
// C3-lite — an orphaned placeholder's Show button can call showOnce on a
// PERMABANNED node. shown-once would then stick forever (processResults skips
// stamped nodes, reconcile skips shown-once ones) and a permaban — which has
// no reveal path by design — becomes permanently visible. showOnce must
// refuse pban nodes outright.
// ============================================================

const SERP = "https://www.google.com/search?q=t";
const BLOCK = { matched: true, mode: "block", domain: "blocked.com" } as const;
const PBAN = { matched: true, mode: "pban", domain: "blocked.com" } as const;
const URL = "https://blocked.com/p";
const noop = () => {};

/** tF2Cxc wrapper + inner div.g — both are cover candidates showOnce stamps. */
function googlePair(): { doc: Document; outer: HTMLElement; inner: HTMLElement } {
  const doc = new JSDOM(
    `<!DOCTYPE html><html><body><div id="rso">
      <div class="tF2Cxc"><div class="g"><h3>t</h3><cite>blocked.com</cite></div></div>
    </div></body></html>`,
    { url: SERP }
  ).window.document;
  return {
    doc,
    outer: doc.querySelector<HTMLElement>("div.tF2Cxc")!,
    inner: doc.querySelector<HTMLElement>("div.g")!,
  };
}

describe("C1 — hide transitions remove the cover-safe stamp", () => {
  it("showOnce → rehideResult clears ok on self AND descendants", () => {
    const { outer, inner } = googlePair();
    showOnce(outer, "blocked.com", noop, noop);
    // Pre-state: the reveal really stamped both levels (else the post-state
    // assertions would be vacuous).
    expect(outer.getAttribute("data-shh-ok")).toBe("true");
    expect(inner.getAttribute("data-shh-ok")).toBe("true");

    rehideResult(outer, BLOCK, URL, false, noop, noop, noop);

    expect(outer.hasAttribute("data-shh-ok")).toBe(false);
    expect(inner.hasAttribute("data-shh-ok")).toBe(false);
    // ...and the node is genuinely re-hidden, not just un-stamped.
    expect(outer.style.getPropertyValue("display")).toBe("none");
    expect(outer.getAttribute("data-shh-result")).toBe("block");
    expect(outer.getAttribute("data-shh-mode")).not.toBe("shown-once");
  });

  it("hideResult (block) on a previously-ok node removes ok from self + descendants", () => {
    // The preload positively cleared this subtree earlier (ok, no result
    // stamp); the adapter now offers it as blocked. The stale ok must not
    // survive into the block state.
    const { outer, inner } = googlePair();
    outer.setAttribute("data-shh-ok", "true");
    inner.setAttribute("data-shh-ok", "true");

    hideResult(outer, BLOCK, URL, false, noop, noop, noop);

    expect(outer.hasAttribute("data-shh-ok")).toBe(false);
    expect(inner.hasAttribute("data-shh-ok")).toBe(false);
    expect(outer.getAttribute("data-shh-result")).toBe("block");
    expect(outer.style.getPropertyValue("display")).toBe("none");
  });

  it("hideResult's pban branch clears ok too — its early return must not skip it", () => {
    const { outer, inner } = googlePair();
    outer.setAttribute("data-shh-ok", "true");
    inner.setAttribute("data-shh-ok", "true");

    hideResult(outer, PBAN, URL, false, noop, noop, noop);

    expect(outer.hasAttribute("data-shh-ok")).toBe(false);
    expect(inner.hasAttribute("data-shh-ok")).toBe(false);
    expect(outer.getAttribute("data-shh-result")).toBe("pban");
    expect(outer.style.getPropertyValue("display")).toBe("none");
  });

  it("convertHiddenToPermaban clears ok on self + descendants", () => {
    const { outer, inner } = googlePair();
    // A shown-once node (ok stamped by showOnce) the user then permabans.
    showOnce(outer, "blocked.com", noop, noop);
    expect(inner.getAttribute("data-shh-ok")).toBe("true");

    convertHiddenToPermaban(outer);

    expect(outer.hasAttribute("data-shh-ok")).toBe(false);
    expect(inner.hasAttribute("data-shh-ok")).toBe(false);
    expect(outer.getAttribute("data-shh-result")).toBe("pban");
    expect(outer.classList.contains("shh-pban")).toBe(true);
    expect(outer.classList.contains("shh-shown-result")).toBe(false);
    expect(outer.style.getPropertyValue("display")).toBe("none");
  });
});

describe("C3-lite — showOnce refuses a permabanned node", () => {
  it("pban-stamped node + showOnce stays hidden, no shown-once mode", () => {
    const { doc, outer } = googlePair();
    outer.setAttribute("data-shh-result", "pban");
    outer.setAttribute("data-shh-url", URL);
    outer.classList.add("shh-pban");
    outer.style.setProperty("display", "none", "important");

    showOnce(outer, "blocked.com", noop, noop);

    // Every reveal layer showOnce would have applied is absent...
    expect(outer.style.getPropertyValue("display")).toBe("none");
    expect(outer.style.getPropertyPriority("display")).toBe("important");
    expect(outer.getAttribute("data-shh-mode")).toBeNull();
    expect(outer.classList.contains("shh-shown-result")).toBe(false);
    expect(outer.hasAttribute("data-shh-ok")).toBe(false);
    expect(doc.querySelector(".shh-shown-notice")).toBeNull();
    // ...and the permaban state is untouched.
    expect(outer.getAttribute("data-shh-result")).toBe("pban");
    expect(outer.classList.contains("shh-pban")).toBe(true);
  });

  it("a block-stamped node is still showable — the guard is pban-only", () => {
    const { outer } = googlePair();
    outer.setAttribute("data-shh-result", "block");
    outer.style.setProperty("display", "none", "important");

    showOnce(outer, "blocked.com", noop, noop);

    expect(outer.getAttribute("data-shh-mode")).toBe("shown-once");
    expect(outer.style.getPropertyValue("display")).toBe("block");
  });
});