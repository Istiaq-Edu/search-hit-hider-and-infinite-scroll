import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { restoreResult, restoreByDomain } from "../../src/content/blocking/hider";

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

// ============================================================
// C2 — the guarded restore: an unblocked WRAPPER can still contain
// an inner result the preload hid for a DIFFERENT, still-blocked
// domain. The unconditional sweep revealed it. With a predicate,
// restoreResult must apply revealPreloadHiding's discipline: self
// always cleared, descendants snapshotted and re-tested one by one.
// Without a predicate the sweep stays unconditional (suspend
// teardown: blocking fully off ⇒ reveal everything) — pinned above
// and in preload-hiding.test.ts.
// ============================================================

/** Google-host doc: wrapper for domain A, inner div.g preload-hidden for B. */
function crossDomainDoc(): { doc: Document; wrapper: HTMLElement; inner: HTMLElement } {
  const doc = new JSDOM(
    `<!DOCTYPE html><html><body><div id="rso">
      <div class="tF2Cxc" data-shh-result="block" data-shh-url="https://domain-a.com/x" style="display: none !important;">
        <div class="g" data-shh-preloaded="true" data-shh-url="https://domain-b.com/y" style="display: none !important;">
          <h3>inner</h3><cite>domain-b.com</cite>
        </div>
      </div>
    </div></body></html>`,
    { url: "https://www.google.com/search?q=t" }
  ).window.document;
  return {
    doc,
    wrapper: doc.querySelector<HTMLElement>(".tF2Cxc")!,
    inner: doc.querySelector<HTMLElement>(".g")!,
  };
}

const stillB = (el: Element): boolean =>
  (el.getAttribute("data-shh-url") ?? "").includes("domain-b.com");

describe("restoreResult with isStillBlocked — the cross-domain guard (C2)", () => {
  it("keeps a still-blocked inner result hidden and refuses its ok stamp", () => {
    const { wrapper, inner } = crossDomainDoc();
    inner.classList.add("shh-hidden");

    restoreResult(wrapper, stillB);

    // Self: every layer cleared, cover lifted (it is a cover candidate).
    expect(wrapper.hasAttribute("data-shh-result")).toBe(false);
    expect(wrapper.hasAttribute("data-shh-url")).toBe(false);
    expect(wrapper.style.getPropertyValue("display")).toBe("");
    expect(wrapper.getAttribute("data-shh-ok")).toBe("true");

    // Inner: all three hiding layers intact, and NO ok stamp — an ok mark
    // would exempt it from re-evaluation while it is still blocked.
    expect(inner.hasAttribute("data-shh-preloaded")).toBe(true);
    expect(inner.style.getPropertyValue("display")).toBe("none");
    expect(inner.style.getPropertyPriority("display")).toBe("important");
    expect(inner.classList.contains("shh-hidden")).toBe(true);
    expect(inner.hasAttribute("data-shh-ok")).toBe(false);
  });

  it("reveals AND ok-stamps the inner result when the predicate says unblocked", () => {
    const { wrapper, inner } = crossDomainDoc();

    restoreResult(wrapper, () => false);

    expect(inner.hasAttribute("data-shh-preloaded")).toBe(false);
    expect(inner.style.getPropertyValue("display")).toBe("");
    // The preload mark is gone, so the cover re-arms unless the stamp lands.
    expect(inner.getAttribute("data-shh-ok")).toBe("true");
    expect(wrapper.getAttribute("data-shh-ok")).toBe("true");
  });

  it("clears SELF even when the predicate says everything is blocked", () => {
    // Self is authoritative: the caller only restores a node whose own
    // destination is unblocked. A blanket-true predicate must not strand the
    // wrapper's own inline display / preload mark.
    const { wrapper, inner } = crossDomainDoc();
    wrapper.setAttribute("data-shh-preloaded", "true");

    restoreResult(wrapper, () => true);

    expect(wrapper.hasAttribute("data-shh-preloaded")).toBe(false);
    expect(wrapper.style.getPropertyValue("display")).toBe("");
    expect(inner.hasAttribute("data-shh-preloaded")).toBe(true);
    expect(inner.style.getPropertyValue("display")).toBe("none");
  });

  it("without a predicate the sweep stays unconditional (suspend teardown)", () => {
    const { wrapper, inner } = crossDomainDoc();

    restoreResult(wrapper);

    expect(inner.hasAttribute("data-shh-preloaded")).toBe(false);
    expect(inner.style.getPropertyValue("display")).toBe("");
    expect(inner.getAttribute("data-shh-ok")).toBe("true");
  });
});

describe("restoreByDomain passes the predicate through (C2)", () => {
  it("restores domain A's wrapper but keeps domain B's inner hide", () => {
    // getHiddenNodes() reads the ambient document, so this fixture lives in
    // the test runner's jsdom body (host irrelevant: no cover assertions).
    document.body.innerHTML = "";
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-shh-result", "block");
    wrapper.setAttribute("data-shh-url", "https://domain-a.com/x");
    wrapper.style.setProperty("display", "none", "important");
    const inner = document.createElement("div");
    inner.setAttribute("data-shh-preloaded", "true");
    inner.setAttribute("data-shh-url", "https://domain-b.com/y");
    inner.style.setProperty("display", "none", "important");
    wrapper.appendChild(inner);
    document.body.appendChild(wrapper);

    const restored = restoreByDomain("domain-a.com", stillB);

    expect(restored).toEqual([wrapper]);
    expect(wrapper.hasAttribute("data-shh-result")).toBe(false);
    expect(wrapper.style.getPropertyValue("display")).toBe("");
    expect(inner.hasAttribute("data-shh-preloaded")).toBe(true);
    expect(inner.style.getPropertyValue("display")).toBe("none");
  });

  it("without a predicate still reveals the whole subtree", () => {
    document.body.innerHTML = "";
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-shh-result", "block");
    wrapper.setAttribute("data-shh-url", "https://domain-a.com/x");
    const inner = document.createElement("div");
    inner.setAttribute("data-shh-preloaded", "true");
    inner.style.setProperty("display", "none", "important");
    wrapper.appendChild(inner);
    document.body.appendChild(wrapper);

    const restored = restoreByDomain("domain-a.com");

    expect(restored).toEqual([wrapper]);
    expect(inner.hasAttribute("data-shh-preloaded")).toBe(false);
    expect(inner.style.getPropertyValue("display")).toBe("");
  });

  it("leaves the wrapper hidden while a broader entry still matches it", () => {
    // Unblocking a.example.com must not release a result that example.com
    // still blocks. Without the self-check the wrapper is revealed and never
    // re-hidden (processResults skips stamped nodes).
    document.body.innerHTML = "";
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-shh-result", "block");
    wrapper.setAttribute("data-shh-url", "https://a.example.com/x");
    wrapper.style.setProperty("display", "none", "important");
    document.body.appendChild(wrapper);

    const restored = restoreByDomain("a.example.com", () => true);

    expect(restored).toEqual([]);
    expect(wrapper.getAttribute("data-shh-result")).toBe("block");
    expect(wrapper.style.getPropertyValue("display")).toBe("none");
  });
});
