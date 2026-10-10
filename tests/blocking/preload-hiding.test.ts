import { describe, it, expect, beforeEach } from "vitest";
import { clearPreloadHiding, hasPreloadHiding, restoreResult, hideResult, preloadHiddenDescendants, revealPreloadHiding } from "../../src/content/blocking/hider";
import { reconcileAgainstBlockList } from "../../src/content/blocking/reconcile";
import { injectBlockButton } from "../../src/content/ui/block-button";

// ============================================================
// Preload-hide clearing — audit D3
//
// Field symptom: "the show/hide control sometimes shows and sometimes doesn't."
//
// The preload and the adapter routinely pick DIFFERENT DOM levels for the same
// result. The preload stamps the inner `div.g` (its selector list is
// class-based); the adapter's structural walk offers the wrapping
// `tF2Cxc`/`MjjYud`. So the mark is on a DESCENDANT of the node the adapter
// offers.
//
// processResults' reveal branch used to test `node.getAttribute("data-shh-
// preloaded")` — SELF only. In the level-mismatch case that is false, so:
//   1. the inner node kept `display:none !important` + the attribute + the
//      `shh-hidden` class, and
//   2. `injectButtonForResult` put the block button INSIDE the heading, which
//      is inside that hidden inner node.
//
// Result: a blank gap where the result should be, with an invisible and
// unclickable button trapped inside it. No placeholder, no Show, no Unblock.
//
// Binds to the SHIPPED functions (google-ancestor-guard.test.ts:24-28 — a
// mirror copy survives a full revert of the real code, so tests import it).
// ============================================================

/** Outer node as the adapter offers it; inner node as the preload hid it. */
function levelMismatch(): { outer: HTMLElement; inner: HTMLElement } {
  const outer = document.createElement("div");
  outer.className = "tF2Cxc";
  const inner = document.createElement("div");
  inner.className = "g";
  inner.innerHTML = `<div class="yuRUbf"><a href="/goto?url=X"><h3>title</h3></a></div><cite>safe.com</cite>`;
  // The preload's three hiding layers.
  inner.setAttribute("data-shh-preloaded", "true");
  inner.classList.add("shh-hidden");
  inner.style.setProperty("display", "none", "important");
  outer.appendChild(inner);
  document.body.appendChild(outer);
  return { outer, inner };
}

describe("hasPreloadHiding", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("detects a mark on SELF", () => {
    const el = document.createElement("div");
    el.setAttribute("data-shh-preloaded", "true");
    expect(hasPreloadHiding(el)).toBe(true);
  });

  it("detects a mark on a DESCENDANT — the D3 case", () => {
    const { outer } = levelMismatch();
    expect(hasPreloadHiding(outer)).toBe(true);
  });

  it("reports false for an untouched node", () => {
    const el = document.createElement("div");
    el.innerHTML = "<div><span>plain</span></div>";
    expect(hasPreloadHiding(el)).toBe(false);
  });
});

describe("clearPreloadHiding — must lift the whole subtree", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("clears an INNER node's three hiding layers (the D3 regression)", () => {
    const { outer, inner } = levelMismatch();

    clearPreloadHiding(outer);

    expect(inner.hasAttribute("data-shh-preloaded")).toBe(false);
    expect(inner.classList.contains("shh-hidden")).toBe(false);
    expect(inner.style.getPropertyValue("display")).toBe("");
  });

  it("leaves the outer node's button target reachable", () => {
    // The practical consequence: the heading must no longer sit inside a
    // display:none subtree, or the injected button is invisible and dead.
    const { outer, inner } = levelMismatch();
    clearPreloadHiding(outer);
    expect(inner.querySelector("h3")).not.toBeNull();
    expect(inner.style.getPropertyValue("display")).toBe("");
  });

  it("clears a mark on self", () => {
    const el = document.createElement("div");
    el.setAttribute("data-shh-preloaded", "true");
    el.classList.add("shh-hidden");
    el.style.setProperty("display", "none", "important");

    clearPreloadHiding(el);

    expect(el.hasAttribute("data-shh-preloaded")).toBe(false);
    expect(el.classList.contains("shh-hidden")).toBe(false);
    expect(el.style.getPropertyValue("display")).toBe("");
  });

  it("clears every marked descendant, not just the first", () => {
    const outer = document.createElement("div");
    for (const cls of ["g", "tF2Cxc", "kb0PBd"]) {
      const inner = document.createElement("div");
      inner.className = cls;
      inner.setAttribute("data-shh-preloaded", "true");
      inner.classList.add("shh-hidden");
      inner.style.setProperty("display", "none", "important");
      outer.appendChild(inner);
    }
    document.body.appendChild(outer);

    clearPreloadHiding(outer);

    expect(outer.querySelectorAll("[data-shh-preloaded]")).toHaveLength(0);
    expect(outer.querySelectorAll(".shh-hidden")).toHaveLength(0);
  });

  it("does NOT touch a previous sibling's placeholder", () => {
    // The reason this is not restoreResult(): a placeholder is the PREVIOUS
    // SIBLING of the result it belongs to, so a restoreResult()-style
    // findPlaceholder() here would strip the control off a DIFFERENT result
    // that is still legitimately blocked — turning one hidden node into two.
    //
    // The placeholder MUST be the node's immediate previous sibling for this to
    // mean anything. A first attempt at this test put another element between
    // them, which made the assertion vacuous: a mutation that deletes
    // node.previousElementSibling was a no-op and the test still passed. The
    // mutation run is what caught that, which is the only reason this fixture
    // is shaped the way it is.
    const placeholder = document.createElement("div");
    placeholder.setAttribute("data-shh-placeholder", "true");
    placeholder.className = "shh-placeholder";
    document.body.appendChild(placeholder);

    const outer = document.createElement("div");
    outer.className = "tF2Cxc";
    const inner = document.createElement("div");
    inner.className = "g";
    inner.setAttribute("data-shh-preloaded", "true");
    inner.style.setProperty("display", "none", "important");
    outer.appendChild(inner);
    // Immediately after the placeholder — no element in between.
    document.body.appendChild(outer);
    expect(outer.previousElementSibling).toBe(placeholder);

    clearPreloadHiding(outer);

    expect(placeholder.isConnected).toBe(true);
    expect(placeholder.getAttribute("data-shh-placeholder")).toBe("true");
  });

  it("does NOT clear data-shh-result on the node", () => {
    // Defensive: callers only reach this when containsProcessed() found no
    // stamped descendant, so there is nothing legitimate to clear — and if
    // that ever changes, silently un-hiding a blocked result is the failure.
    const el = document.createElement("div");
    el.setAttribute("data-shh-preloaded", "true");
    el.setAttribute("data-shh-result", "block");
    document.body.appendChild(el);

    clearPreloadHiding(el);

    expect(el.getAttribute("data-shh-result")).toBe("block");
  });

  // NOTE: the "still-blocked descendant" case lives in the revealPreloadHiding
  // describe below. It used to sit here, but it re-implemented the loop in this
  // file and asserted its own `continue` — a test-local copy of the traversal
  // that survives a full revert of the shipped function (review A5-R1). It is
  // pinned there, against the shipped call.
  it("preloadHiddenDescendants excludes the node itself", () => {
    const el = document.createElement("div");
    el.setAttribute("data-shh-preloaded", "true");
    document.body.appendChild(el);
    expect(preloadHiddenDescendants(el)).toEqual([]);
  });
});

// ============================================================
// revealPreloadHiding — the guarded reveal used by processResults
// ============================================================
describe("revealPreloadHiding — the guard that keeps blocked results hidden", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  /** outer = wrapper the adapter offers; inner = node the preload hid. */
  function pair(outerCite: string, innerCite: string) {
    const outer = document.createElement("div");
    outer.innerHTML = `<div class="yuRUbf"><a href="/goto?url=X"><h3>w</h3></a></div><cite>${outerCite}</cite>`;
    const inner = document.createElement("div");
    inner.innerHTML = `<div class="yuRUbf"><a href="/goto?url=Y"><h3>i</h3></a></div><cite>${innerCite}</cite>`;
    inner.setAttribute("data-shh-preloaded", "true");
    inner.classList.add("shh-hidden");
    inner.style.setProperty("display", "none", "important");
    outer.appendChild(inner);
    document.body.appendChild(outer);
    return { outer, inner };
  }

  const blockedHost = (el: Element): boolean =>
    (el.querySelector("cite")?.textContent ?? "") === "blocked.com";

  // THE under-block. Without the per-descendant re-test, revealing the wrapper
  // also reveals a result that is still blocked — converting "hidden with a
  // trapped button" into "blocked content visible", the symptom this change
  // set exists to remove.
  it("leaves a still-blocked descendant hidden", () => {
    const { outer, inner } = pair("safe.com", "blocked.com");
    revealPreloadHiding(outer, blockedHost);
    expect(inner.style.getPropertyValue("display")).toBe("none");
    expect(inner.hasAttribute("data-shh-preloaded")).toBe(true);
    expect(inner.classList.contains("shh-hidden")).toBe(true);
  });

  it("reveals an unblocked descendant", () => {
    const { outer, inner } = pair("safe.com", "also-safe.com");
    revealPreloadHiding(outer, blockedHost);
    expect(inner.style.getPropertyValue("display")).toBe("");
    expect(inner.hasAttribute("data-shh-preloaded")).toBe(false);
    expect(inner.classList.contains("shh-hidden")).toBe(false);
  });

  it("touches only the nodes the preload marked — the under-block, and the unrelated hide beside it", () => {
    // Both halves of the reveal pass in one call, because it is one loop over
    // one set with one decision per node:
    //   1. WHICH nodes it may touch at all, and
    //   2. which of those are safe to reveal.
    //
    // (1) is what `preloadHiddenDescendants` scopes to `[data-shh-preloaded]`.
    // Widen it to the whole subtree and "lift the preload hide" silently
    // becomes "make the subtree visible", undoing hides this extension never
    // applied — a panel Google collapsed with its own inline display:none has
    // no mark and no business being re-opened by a reveal pass.
    //
    // (2) is the under-block. `data-shh-preloaded` is deliberately absent from
    // SELECTOR_PROCESSED, so `containsProcessed` does NOT protect this case: the
    // preload and the adapter resolve a result's destination with different
    // selectors, so an unmatched wrapper can still contain a blocked result.
    // Clear it blindly and "hidden with a trapped button" becomes "blocked
    // content visible" — the symptom this change set exists to remove.
    const outer = document.createElement("div");
    outer.className = "tF2Cxc";
    outer.innerHTML = `<cite>safe.com</cite>`; // the wrapper is unmatched

    const preloaded = (cls: string, host: string): HTMLElement => {
      const d = document.createElement("div");
      d.className = cls;
      d.innerHTML = `<div class="yuRUbf"><a href="/goto?url=X"><h3>t</h3></a></div><cite>${host}</cite>`;
      d.setAttribute("data-shh-preloaded", "true");
      d.classList.add("shh-hidden");
      d.style.setProperty("display", "none", "important");
      return d;
    };

    const safe = preloaded("g", "safe.com");
    const blocked = preloaded("kb0PBd", "blocked.com");

    // Hidden by something that is NOT the preload: no mark, no shh-hidden,
    // just its own inline display:none.
    const foreign = document.createElement("div");
    foreign.className = "k8XOCe";
    foreign.innerHTML = `<div class="yuRUbf"><a href="/goto?url=X"><h3>collapsed</h3></a></div><cite>safe.com</cite>`;
    foreign.style.setProperty("display", "none", "important");

    outer.append(safe, blocked, foreign);
    document.body.appendChild(outer);

    revealPreloadHiding(outer, blockedHost);

    // The loop ran: the descendant whose host is not on the block list was
    // lifted.
    expect(safe.style.getPropertyValue("display")).toBe("");
    expect(safe.hasAttribute("data-shh-preloaded")).toBe(false);
    expect(safe.classList.contains("shh-hidden")).toBe(false);

    // ...and the still-blocked one keeps all three of its hiding layers.
    expect(blocked.style.getPropertyValue("display")).toBe("none");
    expect(blocked.hasAttribute("data-shh-preloaded")).toBe(true);
    expect(blocked.classList.contains("shh-hidden")).toBe(true);

    // ...and the hide the preload never applied is still in force, priority
    // included. These two are the assertion that dies if the traversal is
    // widened: nothing in the reveal pass ever ADDS a mark or a class, so the
    // only way to observe the intrusion is on what it takes away.
    expect(foreign.style.getPropertyValue("display")).toBe("none");
    expect(foreign.style.getPropertyPriority("display")).toBe("important");
  });

  it("clears SELF regardless of the predicate", () => {
    // The caller only reaches the reveal branch because the node's own
    // destination is unblocked, so self is always safe to clear.
    const el = document.createElement("div");
    el.setAttribute("data-shh-preloaded", "true");
    el.classList.add("shh-hidden");
    el.style.setProperty("display", "none", "important");
    document.body.appendChild(el);
    revealPreloadHiding(el, () => true); // predicate says "blocked" for all
    expect(el.hasAttribute("data-shh-preloaded")).toBe(false);
    expect(el.style.getPropertyValue("display")).toBe("");
  });

  it("is a no-op on an untouched node", () => {
    const el = document.createElement("div");
    el.innerHTML = "<div><span>plain</span></div>";
    document.body.appendChild(el);
    expect(() => revealPreloadHiding(el, () => true)).not.toThrow();
    expect(el.hasAttribute("data-shh-preloaded")).toBe(false);
  });

  it("handles several descendants with mixed states", () => {
    const outer = document.createElement("div");
    outer.innerHTML = `<cite>safe.com</cite>`;
    for (const [cls, host] of [["g", "blocked.com"], ["tF2Cxc", "ok.com"], ["kb0PBd", "blocked.com"]] as const) {
      const d = document.createElement("div");
      d.className = cls;
      d.innerHTML = `<cite>${host}</cite>`;
      d.setAttribute("data-shh-preloaded", "true");
      d.style.setProperty("display", "none", "important");
      outer.appendChild(d);
    }
    document.body.appendChild(outer);

    revealPreloadHiding(outer, blockedHost);

    const hidden = Array.from(outer.children).filter(
      (c) => (c as HTMLElement).style.getPropertyValue("display") === "none"
    );
    expect(hidden).toHaveLength(2); // the two blocked.com descendants
    expect(hidden.every((c) => c.querySelector("cite")?.textContent === "blocked.com")).toBe(true);
  });
});

// ============================================================
// Producer/consumer contract on data-shh-url
//
// `reconcileAgainstBlockList` reads `data-shh-url` to decide whether a stamped
// node is still blocked, and treats a node WITHOUT it as unblocked (restorable).
// `hideResult` is the only thing that writes it.
//
// The reconcile tests hand-build their fixtures, so the contract between the two
// was untested: deleting `node.setAttribute(ATTR_SHH_URL, url)` from
// hideResult left the whole suite green, and inverts the D1 fix into a mass
// un-hide — every blocked result restored on the next LIST_UPDATED.
//
// Both legs of the producer are covered here: the regular block branch, and the
// perma-ban branch, whose early `return` sits a line below those two
// setAttribute calls. The second is the one a refactor can quietly break, so it
// is pinned with the same real hideResult → real reconcileAgainstBlockList
// round trip as the first.
// ============================================================
describe("hideResult → reconcile: the data-shh-url contract", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("a node hidden by the SHIPPED hideResult is restamped, not restored", () => {
    const node = document.createElement("div");
    node.innerHTML = `<div class="yuRUbf"><a href="/goto?url=X"><h3>t</h3></a></div><cite>blocked.com</cite>`;
    document.body.appendChild(node);

    hideResult(
      node,
      { matched: true, mode: "block", domain: "blocked.com" },
      "https://blocked.com/page",
      true, // showNotices
      () => {},
      () => {},
      () => {}
    );

    // The producer really wrote it...
    expect(node.getAttribute("data-shh-url")).toBe("https://blocked.com/page");

    // ...and the consumer reads it back as "still blocked".
    const { toRestamp, toRestore } = reconcileAgainstBlockList(
      [node],
      [],
      (u) => u.includes("blocked.com"),
      () => null
    );
    expect(toRestamp).toEqual([node]);
    expect(toRestore).toEqual([]);
  });

  it("the pban leg writes the URL too — its early return must not skip the producer", () => {
    // The other branch of the same producer. `hideResult` short-circuits for a
    // perma-ban (no placeholder, no `shh-hidden`), so those two setAttribute
    // calls are the ONLY thing keeping a pban node reconcilable at all. Drop
    // them from that branch — or move them below the early return — and the
    // consumer reads "" , treats the node as unblocked, and restoreResult
    // un-hides a result the user explicitly permabanned. That is the D1 mass
    // un-hide, reached through the perma-ban path.
    const node = document.createElement("div");
    node.innerHTML = `<div class="yuRUbf"><a href="/goto?url=X"><h3>t</h3></a></div><cite>blocked.com</cite>`;
    document.body.appendChild(node);

    hideResult(
      node,
      { matched: true, mode: "pban", domain: "blocked.com" },
      "https://blocked.com/page",
      true, // showNotices — irrelevant here; a pban returns before the placeholder
      () => {},
      () => {},
      () => {}
    );

    // The producer wrote it on this branch too...
    expect(node.getAttribute("data-shh-url")).toBe("https://blocked.com/page");
    expect(node.getAttribute("data-shh-result")).toBe("pban");

    // ...and the consumer reads it back as "still blocked".
    const { toRestamp, toRestore } = reconcileAgainstBlockList(
      [node],
      [],
      (u) => u.includes("blocked.com"),
      () => null
    );
    expect(toRestamp).toEqual([node]);
    expect(toRestore).toEqual([]);

    // Applied the way refreshEntries applies it: nothing is restored, so the
    // permabanned result is still hidden when the pass finishes.
    for (const n of toRestore) restoreResult(n);
    expect(node.style.getPropertyValue("display")).toBe("none");
    expect(node.getAttribute("data-shh-result")).toBe("pban");
  });
});

describe("restoreResult still clears inner preload marks (A2 F2a)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("lifts inner marks via the shared helper", () => {
    // Pre-existing behaviour that must survive the refactor of restoreResult
    // onto clearPreloadHiding (pinned by restore-inner-preloaded.test.ts).
    const { outer, inner } = levelMismatch();
    restoreResult(outer);
    expect(inner.hasAttribute("data-shh-preloaded")).toBe(false);
    expect(inner.classList.contains("shh-hidden")).toBe(false);
  });

  it("still removes its OWN placeholder and markers", () => {
    const placeholder = document.createElement("div");
    placeholder.setAttribute("data-shh-placeholder", "true");
    const el = document.createElement("div");
    el.setAttribute("data-shh-result", "block");
    el.setAttribute("data-shh-url", "https://blocked.com/");
    document.body.append(placeholder, el);

    restoreResult(el);

    expect(placeholder.isConnected).toBe(false);
    expect(el.getAttribute("data-shh-result")).toBeNull();
    expect(el.getAttribute("data-shh-url")).toBeNull();
  });

  it("still clears the pban and shown-result classes from self", () => {
    const el = document.createElement("div");
    el.classList.add("shh-pban", "shh-shown-result");
    document.body.appendChild(el);

    restoreResult(el);

    expect(el.classList.contains("shh-pban")).toBe(false);
    expect(el.classList.contains("shh-shown-result")).toBe(false);
  });
});
