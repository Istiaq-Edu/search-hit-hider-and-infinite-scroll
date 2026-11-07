import { describe, it, expect } from "vitest";
import { prepareButtonTarget } from "../../src/content/ui/block-button";

// ============================================================
// Brave single-wrap guard
//
// Brave's a.l1 is a full-width flex row, so the button target is wrapped in
// span.shh-btn-row. The wrap runs again on every re-scan, reconcile and
// restored node. Without the "already wrapped" step-out, each pass nests
// another flex row and drifts the button further left. This binds to the
// SHIPPED helper, so deleting the guard fails here.
// ============================================================

function braveAnchor(): { doc: Document; anchor: HTMLAnchorElement } {
  document.body.innerHTML = "";
  const doc = document;
  const container = doc.createElement("div");
  container.className = "result-content";
  const anchor = doc.createElement("a");
  anchor.className = "l1";
  anchor.href = "https://example.com/";
  anchor.textContent = "Example";
  container.appendChild(anchor);
  doc.body.appendChild(container);
  return { doc, anchor };
}

describe("prepareButtonTarget — Brave", () => {
  it("wraps the title anchor once and inserts before it", () => {
    const { doc, anchor } = braveAnchor();
    const prepared = prepareButtonTarget(anchor, "brave");

    expect(prepared.insertPosition).toBe("before");
    expect(prepared.target.classList.contains("shh-btn-row")).toBe(true);
    expect(prepared.target.tagName.toLowerCase()).toBe("span");
    expect(prepared.target.firstElementChild).toBe(anchor);
    expect(prepared.target.parentElement?.className).toBe("result-content");
    expect(doc.querySelectorAll(".shh-btn-row")).toHaveLength(1);
  });

  it("steps out to the existing wrapper instead of nesting a second one", () => {
    const { doc, anchor } = braveAnchor();
    const first = prepareButtonTarget(anchor, "brave");
    const second = prepareButtonTarget(anchor, "brave");
    const third = prepareButtonTarget(anchor, "brave");

    expect(second.target).toBe(first.target);
    expect(third.target).toBe(first.target);
    expect(second.insertPosition).toBe("before");
    expect(doc.querySelectorAll(".shh-btn-row")).toHaveLength(1);
    // The anchor must not have been moved out of the wrapper.
    expect(first.target.contains(anchor)).toBe(true);
  });

  it("gives the wrapper the flex layout that keeps the button beside the favicon", () => {
    const { anchor } = braveAnchor();
    const { target } = prepareButtonTarget(anchor, "brave");
    expect((target as HTMLElement).style.display).toBe("inline-flex");
    expect((target as HTMLElement).style.gap).toBe("6px");
  });
});

describe("prepareButtonTarget — other engines and fallbacks", () => {
  it("leaves the target and position untouched on non-Brave engines", () => {
    const { doc, anchor } = braveAnchor();
    const prepared = prepareButtonTarget(anchor, "google");

    expect(prepared.target).toBe(anchor);
    expect(prepared.insertPosition).toBe("after");
    expect(doc.querySelector(".shh-btn-row")).toBeNull();
  });

  it("does not wrap a Brave fallback target that is not an anchor", () => {
    const { doc } = braveAnchor();
    const fallback = doc.createElement("div");
    fallback.className = "result-content";
    doc.body.appendChild(fallback);

    const prepared = prepareButtonTarget(fallback, "brave");
    expect(prepared.target).toBe(fallback);
    expect(prepared.insertPosition).toBe("after");
    expect(doc.querySelector(".shh-btn-row")).toBeNull();
  });
});
