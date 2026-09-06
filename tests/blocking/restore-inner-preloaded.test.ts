import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { restoreResult } from "../../src/content/blocking/hider";

// ============================================================
// A2 F2a (2026-09-06 deep review, late-echo absorption): when the
// adapter offers the WRAPPER while the preload hid an INNER node
// (level mismatch), Unblock (restoreResult) cleared the wrapper's
// own preload mark but not inner ones — the result came back
// visible-but-hollow. The Show path (showOnce) got the companion
// fix in the main absorption batch; this pins the Unblock path.
// ============================================================

function stampedDoc(): Document {
  const doc = new JSDOM(
    `<!DOCTYPE html><html><body><div id="rso">
      <div class="wrapper" data-shh-result="block" data-shh-url="https://blocked.com/x" class2="x">
        <div class="inner" data-shh-preloaded="true" style="display: none;"></div>
        <span>content</span>
      </div>
    </div></body></html>`,
    { url: "https://www.google.com/search?q=t" }
  ).window.document;
  return doc;
}

describe("restoreResult clears INNER preload marks (A2 F2a)", () => {
  it("unblocking a wrapper lifts every preload hide in its subtree", () => {
    const doc = stampedDoc();
    const wrapper = doc.querySelector(".wrapper")!;
    const inner = doc.querySelector(".inner")!;

    // Pre-state: wrapper blocked, inner preloaded + inline-hidden.
    expect(wrapper.hasAttribute("data-shh-result")).toBe(true);
    expect(inner.hasAttribute("data-shh-preloaded")).toBe(true);
    expect((inner as HTMLElement).style.display).toBe("none");

    restoreResult(wrapper);

    // Post-state: every hiding layer gone from BOTH levels.
    expect(wrapper.hasAttribute("data-shh-result")).toBe(false);
    expect(wrapper.hasAttribute("data-shh-preloaded")).toBe(false);
    expect(inner.hasAttribute("data-shh-preloaded")).toBe(false);
    expect((inner as HTMLElement).style.display).toBe("");
  });
});
