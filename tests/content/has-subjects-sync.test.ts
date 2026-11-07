import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { detectEngine, ALL_ADAPTERS } from "../../src/content/engines/registry";
import {
  hasSubjectsFor,
  CSS_SUBJECTS_BY_ENGINE,
} from "../../src/content/markers";

// ============================================================
// The :has() layer's per-engine subjects must cover the engine's own results
//
// WHY THIS TEST EXISTS
// --------------------
// Field report 2026-11-07: Yandex searches made the browser slow, scaling with
// block-list size. The `:has()` hiding sheet used the FULL cross-engine
// selector list (SELS, ~30 subjects for 11 engines) on every site, and the
// style engine re-evaluates those rules on DOM mutations — so a Yandex page
// paid invalidation work for Bing/DDG/Qwant/... subjects that can never match
// there. The fix scopes subjects per host (markers.ts hasSubjectsFor).
//
// Scoping is only safe if the scoped list still covers everything the engine's
// OWN adapter resolves as a result. This test pins exactly that, against the
// SHIPPED adapters: for every engine, every node the adapter offers must
// either match the scoped subjects or CONTAIN a node that does — which is the
// visual guarantee of the pre-paint hide (a `:has()` match on a descendant
// collapses the whole subtree).
//
// The subject strings may drift from the adapters' selectors; this test is the
// tripwire (same role as cover-selector-sync.test.ts for the cover).
//
// KNOWN LIMIT, stated honestly: the per-engine fixtures use each adapter's
// FIRST-choice markup, so a layout rotation that pushes an adapter onto a
// FALLBACK selector whose shape the CSS subjects do not cover would pass the
// per-engine assertion below. Two tripwires bound that risk: (1) every subject
// must appear VERBATIM in the preload's SELS (asserted here against the
// source), so the scoped list can never invent coverage the full list lacked —
// scoping is never worse than the unscoped sheet it replaced; (2) the JS-side
// SELS path still hides anything CSS misses, at the cost of a post-paint
// flicker rather than a permanent miss.
// ============================================================

/** Inner card body — enough link/cite fallbacks for every adapter's
 *  getResultUrl to resolve a destination. */
const BODY = `<a class="OrganicTitle-Link" href="https://example.com/p"><h2>Title</h2></a>
  <cite>example.com</cite><div class="OrganicText">snippet</div>`;

/** The preload's full SELS, extracted from SOURCE so the subset assertion
 *  cannot pass while the shipped list has moved. Handles both TS quote styles
 *  (SELS mixes them: `div.g`-style entries are double-quoted, Brave's
 *  `data-type="web"` entries are single-quoted with doubles inside). */
function preloadSelsParts(): string[] {
  const src = readFileSync(
    resolve(process.cwd(), "src", "content", "preload.ts"),
    "utf8"
  );
  const block = src.match(/const SELS = \[([\s\S]*?)\]\.join/);
  if (!block) throw new Error("SELS block not found in preload.ts");
  return Array.from(
    block[1]!.matchAll(/'([^']+)'|"([^"]+)"/g),
    (m) => (m[1] ?? m[2])!
  );
}

const FIXTURES: Array<{ id: string; url: string; html: string }> = [
  {
    id: "google",
    url: "https://www.google.com/search?q=t",
    html: `<div id="rso"><div class="MjjYud"><div class="tF2Cxc">${BODY}</div></div></div>`,
  },
  {
    id: "duckduckgo",
    url: "https://duckduckgo.com/?q=t",
    html: `<ol class="react-results--main"><li data-layout="organic">${BODY}</li></ol>`,
  },
  {
    id: "yandex",
    url: "https://yandex.ru/search/?q=t",
    html: `<ul id="search-result" class="serp-list"><li class="serp-item"><div class="Organic">${BODY}</div></li></ul>`,
  },
  {
    id: "bing",
    url: "https://www.bing.com/search?q=t",
    html: `<div id="b_content"><ol id="b_results"><li class="b_algo">${BODY}</li></ol></div>`,
  },
  {
    id: "baidu",
    url: "https://www.baidu.com/s?wd=t",
    html: `<div id="content_left"><div class="result c-container">${BODY}</div></div>`,
  },
  {
    id: "brave",
    url: "https://search.brave.com/search?q=t",
    // Brave resolves URLs via a.l1 / .result-content a / cite.snippet-url.
    html: `<div id="results"><div class="snippet" data-type="web">
      <a class="l1" href="https://example.com/p"><h2>Title</h2></a>
      <div class="result-content"><cite class="snippet-url">example.com</cite></div>
    </div></div>`,
  },
  {
    id: "startpage",
    url: "https://www.startpage.com/sp/search",
    html: `<section id="main"><div class="w-gl"><div class="result">${BODY}</div></div></section>`,
  },
];

describe("the :has() subject scope covers each engine's own results", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.id}: every adapter-resolved result is reachable by the scoped subjects`, () => {
      const url = new URL(fixture.url);
      const engine = detectEngine(url);
      expect(engine?.id).toBe(fixture.id);

      const subjects = hasSubjectsFor(url.hostname);
      expect(subjects).toBeTruthy();
      expect(subjects).toBe(CSS_SUBJECTS_BY_ENGINE[fixture.id]);

      const doc = new JSDOM(`<!DOCTYPE html><html><body>${fixture.html}</body></html>`, {
        url: fixture.url,
      }).window.document;
      const nodes = engine!.getResultNodes(doc);
      expect(nodes.length).toBeGreaterThan(0);

      for (const node of nodes) {
        const covered =
          node.matches(subjects!) || node.querySelector(subjects!) !== null;
        expect(covered).toBe(true);
      }
    });
  }

  it("every adapter has a subject entry and every entry has an adapter", () => {
    const adapterIds = new Set(ALL_ADAPTERS.map((a) => a.id));
    for (const id of adapterIds) {
      expect(CSS_SUBJECTS_BY_ENGINE[id]).toBeTruthy();
    }
    for (const id of Object.keys(CSS_SUBJECTS_BY_ENGINE)) {
      expect(adapterIds.has(id as never)).toBe(true);
    }
  });

  it("every scoped subject is a verbatim part of the preload's full SELS", () => {
    // Scoping is only safe as a SUBSET operation: the scoped list must never
    // lose a selector the unscoped sheet had. SELS is quoted source text, so
    // this parses the shipped file rather than re-typing the list.
    const sels = new Set(preloadSelsParts());
    expect(sels.size).toBeGreaterThan(20); // the extraction found the real list
    for (const [id, joined] of Object.entries(CSS_SUBJECTS_BY_ENGINE)) {
      for (const part of joined.split(",")) {
        expect(sels.has(part)).toBe(true);
      }
    }
  });

  it("unknown hosts keep the full fallback (null, not a scoped list)", () => {
    // SearXNG / Ecosia / Qwant have selectors in SELS but no adapter: scoping
    // them away would silently disable pre-paint hiding there.
    expect(hasSubjectsFor("searx.example")).toBeNull();
    expect(hasSubjectsFor("www.ecosia.org")).toBeNull();
  });

  it("hosts the ADAPTER rejects resolve to no scope either", () => {
    // us-browse.startpage.com is explicitly excluded by StartpageAdapter.
    expect(hasSubjectsFor("us-browse.startpage.com")).toBeNull();
  });
});
