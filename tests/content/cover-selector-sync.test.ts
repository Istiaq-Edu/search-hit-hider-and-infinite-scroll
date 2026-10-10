import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GOOGLE_COVER_SELECTOR,
  GOOGLE_COVER_CANDIDATE_SELECTOR,
} from "../../src/content/markers";

// ============================================================
// The cover selector must stay identical in CSS and in JS
//
// WHY THIS TEST EXISTS
// --------------------
// The anti-flicker cover is ONE idea written down in FOUR places:
//
//   1. `src/content/preload.css`            — the static rule that actually paints
//   2. `markers.ts` GOOGLE_COVER_SELECTOR   — what `revealRemainingGoogle` stamps
//   3. `markers.ts` GOOGLE_COVER_CANDIDATE_SELECTOR — "what COULD be covered"
//   4. `preload.ts` SELS                    — the observer's own candidate list
//
// Nothing enforced that they agree. `markers.ts` already carries a comment
// recording what the last drift cost ("a third copy of this string is how the
// two drifted into disagreeing in the first place"), and the field bug this
// suite was written for is precisely the failure mode of a disagreement: the
// cover PAINTS a node that the JS never STAMPS, so the node is invisible with
// its full height reserved — a blank gap, no content.
//
// Two independent reviewers (2026-10-10) rated "no test reads preload.css" the
// most likely way for that exact bug to return. This is that test. It is cheap
// and it fails loudly on the first divergence, which is the whole point: the
// alternative is another field report.
// ============================================================

const CSS_PATH = resolve(process.cwd(), "src", "content", "preload.css");
const ACTIVE_PREFIX = "html[data-shh-active]";

interface CssRule {
  selector: string;
  body: string;
}

/** Every rule in preload.css, comments stripped. */
function rules(): CssRule[] {
  const text = readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out: CssRule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const selector = m[1]?.trim();
    if (selector) out.push({ selector, body: m[2] ?? "" });
  }
  return out;
}

/** One rule's selector, split into its comma-separated parts, normalised. */
function parts(selector: string): string[] {
  return selector
    .split(",")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

/** Drop the `html[data-shh-active] ` scoping prefix the static rule carries. */
function unscoped(part: string): string {
  return part.startsWith(ACTIVE_PREFIX + " ")
    ? part.slice(ACTIVE_PREFIX.length + 1)
    : part;
}

describe("the cover selector agrees between preload.css and markers.ts", () => {
  const all = rules();

  it("finds the cover rule and the preload-hide rule in preload.css", () => {
    expect(all.some((r) => /opacity\s*:\s*0\s*!important/.test(r.body))).toBe(true);
    expect(
      all.some((r) => /display\s*:\s*none\s*!important/.test(r.body))
    ).toBe(true);
  });

  it("the opacity rule's selectors equal GOOGLE_COVER_SELECTOR exactly", () => {
    const cover = all.find((r) => /opacity\s*:\s*0\s*!important/.test(r.body));
    expect(cover, "no opacity:0 rule in preload.css").toBeDefined();

    const cssParts = parts(cover!.selector).map(unscoped).sort();
    const jsParts = parts(GOOGLE_COVER_SELECTOR).sort();

    // A node the CSS covers but the JS never stamps is a permanent blank gap:
    // this assertion is the difference between that and a green suite.
    expect(cssParts).toEqual(jsParts);
  });

  it("every cover selector is gated on html[data-shh-active]", () => {
    // The attribute is what lets the content script arm/disarm the static rule
    // from JS (suspend/resume). A part without it would hide results on a page
    // where the user has nothing blocked and nothing could reveal them.
    const cover = all.find((r) => /opacity\s*:\s*0\s*!important/.test(r.body))!;
    for (const part of parts(cover.selector)) {
      expect(part.startsWith(ACTIVE_PREFIX)).toBe(true);
    }
  });

  it("the preload-hide rule's selector is exactly [data-shh-preloaded=\"true\"]", () => {
    const hide = all.find((r) => /display\s*:\s*none\s*!important/.test(r.body));
    expect(hide, "no display:none rule in preload.css").toBeDefined();
    expect(parts(hide!.selector)).toEqual(['[data-shh-preloaded="true"]']);
  });

  it("the candidate selector is the cover selector minus its two markers", () => {
    // GOOGLE_COVER_CANDIDATE_SELECTOR must mean "what could be covered" — i.e.
    // the cover rule with the `:not([data-shh-ok])` / `:not([data-shh-preloaded])`
    // exclusions removed. If these ever diverge, a node can be a cover
    // candidate without being coverable (harmless) or coverable without being a
    // candidate (the blank-gap bug, because nothing ever offers it to the
    // reveal paths).
    const strip = (s: string) =>
      s
        .replace(":not([data-shh-ok])", "")
        .replace(":not([data-shh-preloaded])", "");
    expect(parts(GOOGLE_COVER_CANDIDATE_SELECTOR).sort()).toEqual(
      parts(GOOGLE_COVER_SELECTOR).map(strip).sort()
    );
  });

  it("the cover excludes both safety markers", () => {
    // Both exclusions are load-bearing: without `:not([data-shh-ok])` nothing
    // could ever reveal a node; without `:not([data-shh-preloaded])` a blocked
    // result would be double-hidden and its placeholder could not un-hide it.
    for (const part of parts(GOOGLE_COVER_SELECTOR)) {
      expect(part).toContain(":not([data-shh-ok])");
      expect(part).toContain(":not([data-shh-preloaded])");
    }
  });
});
