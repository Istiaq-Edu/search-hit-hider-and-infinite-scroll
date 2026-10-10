import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { showOnce, restoreResult } from "../../src/content/blocking/hider";

// ============================================================
// showOnce and the Google anti-flicker cover
//
// Field capture 2026-09-29: after clicking "Show once" on three blocked
// results, one rendered its content and two showed a correctly-sized EMPTY
// box. Not a placeholder bug — `buildPlaceholder` has no content path at all;
// these were Google's own result DOM with the cover still on an inner node.
//
// The mechanism, confirmed in code: `showOnce` strips `data-shh-preloaded`
// from the node AND its descendants, then sets inline `opacity:1 !important`
// on the node only. The cover is
//   div.g:not(.g .g):not([data-shh-ok]):not([data-shh-preloaded])
//     { opacity:0!important; pointer-events:none!important }
// so a descendant that had its preload marker removed is now neither
// `data-shh-ok` nor `data-shh-preloaded` — it MATCHES the cover. And
// `opacity` does not cascade as an override: a child with its own
// `opacity:0 !important` stays invisible however the parent is set.
// ============================================================

const SERP = "https://www.google.com/search?q=t";

/**
 * The 2026 nesting the repo's own fixtures model:
 *   #rso > MjjYud > tF2Cxc (what the adapter offers) > N54PNb > div.g (what the
 *   preload hides) > kb0PBd (the content).
 */
function serpWithHiddenInner(innerPreloaded: boolean): Document {
  const html = `<!DOCTYPE html><html><body><div id="rso">
    <div class="MjjYud"><div class="tF2Cxc" data-shh-result="block">
      <div class="N54PNb">
        <div class="g"${innerPreloaded ? ' data-shh-preloaded="true" style="display:none !important;"' : ""}>
          <div class="kb0PBd"><h3>Blocked result</h3><cite>blocked.com</cite>
            <div class="VwiC3b">the snippet body</div>
          </div>
        </div>
      </div>
    </div></div>
  </div></body></html>`;
  return new JSDOM(html, { url: SERP }).window.document;
}

describe("showOnce — lifting the Google cover on revealed results", () => {
  let doc: Document;

  beforeEach(() => {
    doc = serpWithHiddenInner(true);
    const outer = doc.querySelector("div.tF2Cxc")!;
    outer.classList.add("shh-hidden");
    showOnce(outer, "blocked.com", () => {}, () => {});
  });

  it("exempts the revealed node from the cover", () => {
    // The inline opacity:1 covers the node's own box and the notice bar.
    const outer = doc.querySelector<HTMLElement>("div.tF2Cxc")!;
    expect(outer.style.getPropertyValue("opacity")).toBe("1");
    expect(outer.style.getPropertyPriority("opacity")).toBe("important");
    // ...and data-shh-ok means it no longer matches the cover either.
    expect(outer.hasAttribute("data-shh-ok")).toBe(true);
  });

  it("exempts the INNER node the preload had hidden — the actual fix", () => {
    // Before the fix this node had its data-shh-preloaded stripped and NO
    // data-shh-ok, so it matched the cover and took opacity:0 !important.
    const inner = doc.querySelector("div.g")!;
    expect(inner.hasAttribute("data-shh-preloaded")).toBe(false);
    expect(inner.hasAttribute("data-shh-ok")).toBe(true);
  });

  it("leaves nothing inside the revealed node matching the cover", () => {
    // The invariant that matters, stated as the cover itself sees it. This is
    // the assertion that fails on the pre-fix code.
    const COVER =
      "div.g:not(.g .g):not([data-shh-ok]):not([data-shh-preloaded])," +
      "div.tF2Cxc:not(.tF2Cxc .tF2Cxc):not([data-shh-ok]):not([data-shh-preloaded])";
    const outer = doc.querySelector("div.tF2Cxc")!;
    const stillCovered = [outer, ...Array.from(outer.querySelectorAll("*"))].filter((el) =>
      el.matches(COVER)
    );
    expect(stillCovered.map((e) => e.className)).toEqual([]);
  });

  it("still marks the result as shown-once so Hide Again still works", () => {
    const outer = doc.querySelector("div.tF2Cxc")!;
    expect(outer.classList.contains("shh-shown-result")).toBe(true);
    expect(outer.classList.contains("shh-hidden")).toBe(false);
    expect(outer.getAttribute("data-shh-mode")).toBe("shown-once");
  });

  it("inserts the notice bar with working controls", () => {
    const bar = doc.querySelector(".shh-shown-notice");
    expect(bar).not.toBeNull();
    const labels = Array.from(bar!.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels.join(" ")).toMatch(/Hide Again/i);
    expect(labels.join(" ")).toMatch(/Unblock/i);
  });
});

describe("showOnce — non-Google hosts are untouched", () => {
  it("does not stamp data-shh-ok on a Bing result", () => {
    // The cover is Google-only. Stamping the marker elsewhere would be
    // harmless today but couples hider.ts to a Google implementation detail
    // for no reason, and would start mattering if another engine grew a cover.
    const html = `<!DOCTYPE html><html><body>
      <div class="b_algo" data-shh-result="block">
        <h3>Blocked</h3><div class="g" data-shh-preloaded="true"></div>
      </div></body></html>`;
    const doc = new JSDOM(html, { url: "https://www.bing.com/search?q=t" }).window.document;
    const el = doc.querySelector("div.b_algo")!;
    showOnce(el, "blocked.com", () => {}, () => {});
    expect(el.hasAttribute("data-shh-ok")).toBe(false);
    expect(doc.querySelector("div.g")!.hasAttribute("data-shh-ok")).toBe(false);
  });
});

// ============================================================
// restoreResult and the cover — the OTHER path that re-arms it
//
// `showOnce` above had to add a `data-shh-ok` stamp because stripping
// `data-shh-preloaded` makes a node MATCH the cover again. `restoreResult` —
// the "Unblock" path — performs the identical removal via
// `clearPreloadHiding()` and had none of the mitigation.
//
// Consequence, entirely deterministic and user-initiated: the user clicks
// "Unblock" on a result and the result turns into a full-height blank gap.
// Same reported symptom ("results are not visible but there space for them"),
// reached by a different route. These tests pin the stamp on both the node and
// its cover-matching descendants, because `opacity` does not cascade as an
// override — a stamped parent cannot rescue a child carrying its own
// `opacity:0 !important`.
// ============================================================
describe("restoreResult — unblocking must lift the cover, not re-arm it", () => {
  it("stamps the restored node AND its cover-matching descendant safe", () => {
    const doc = serpWithHiddenInner(true);
    const outer = doc.querySelector<HTMLElement>("div.tF2Cxc")!;
    const inner = doc.querySelector<HTMLElement>("div.g")!;
    outer.classList.add("shh-hidden");

    restoreResult(outer);

    // Un-hiding means the preload marker is gone...
    expect(outer.hasAttribute("data-shh-preloaded")).toBe(false);
    expect(inner.hasAttribute("data-shh-preloaded")).toBe(false);
    // ...which is exactly why the cover must be lifted on BOTH nodes.
    expect(outer.getAttribute("data-shh-ok")).toBe("true");
    expect(inner.getAttribute("data-shh-ok")).toBe("true");
  });

  it("still refuses to mark a nested result the content script is hiding", () => {
    // The safety property, exercised through the subtree walk: a descendant
    // that carries `data-shh-result` is a genuinely blocked result, so the
    // sweep must not stamp it safe however safe its ancestors are.
    const doc = serpWithHiddenInner(false);
    const outer = doc.querySelector<HTMLElement>("div.tF2Cxc")!;
    const inner = doc.querySelector<HTMLElement>("div.g")!;
    inner.setAttribute("data-shh-result", "block");
    inner.style.setProperty("display", "none", "important");

    restoreResult(outer);

    expect(outer.getAttribute("data-shh-ok")).toBe("true");
    expect(inner.hasAttribute("data-shh-ok")).toBe(false);
    expect(inner.style.getPropertyValue("display")).toBe("none");
  });
});
