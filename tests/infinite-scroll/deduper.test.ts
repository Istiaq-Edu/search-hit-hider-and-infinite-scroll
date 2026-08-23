import { describe, it, expect, beforeEach } from "vitest";
import { Deduper } from "../../src/content/infinite-scroll/deduper";
import type { EngineAdapter } from "../../src/content/engines/base";

function makeMockEngine(getResultId?: (node: Element) => string | null): EngineAdapter {
  return {
    id: "google",
    name: "Google",
    matches: () => true,
    getResultNodes: () => [],
    getResultUrl: () => null,
    getButtonTarget: () => null,
    getResultId,
  } as EngineAdapter;
}

function makeElement(href?: string, ved?: string): Element {
  const div = document.createElement("div");
  if (ved) div.setAttribute("data-ved", ved);
  if (href) {
    const a = document.createElement("a");
    a.href = href;
    div.appendChild(a);
  }
  return div;
}

describe("Deduper", () => {
  let deduper: Deduper;

  beforeEach(() => {
    deduper = new Deduper();
  });

  it("returns false for a new node with engine getResultId", () => {
    const engine = makeMockEngine(() => "abc123");
    const node = makeElement();
    expect(deduper.isDuplicate(node, engine)).toBe(false);
  });

  it("returns true for a duplicate node with same engine getResultId", () => {
    const engine = makeMockEngine(() => "abc123");
    const node1 = makeElement();
    const node2 = makeElement();
    deduper.isDuplicate(node1, engine);
    expect(deduper.isDuplicate(node2, engine)).toBe(true);
  });

  it("falls back to URL hash when engine getResultId returns null", () => {
    const engine = makeMockEngine(() => null);
    const node = makeElement("https://example.com/page1");
    expect(deduper.isDuplicate(node, engine)).toBe(false);
  });

  it("detects duplicate URL hash", () => {
    const engine = makeMockEngine(() => null);
    const node1 = makeElement("https://example.com/page1");
    const node2 = makeElement("https://example.com/page1");
    deduper.isDuplicate(node1, engine);
    expect(deduper.isDuplicate(node2, engine)).toBe(true);
  });

  it("allows different URLs", () => {
    const engine = makeMockEngine(() => null);
    const node1 = makeElement("https://example.com/page1");
    const node2 = makeElement("https://example.com/page2");
    deduper.isDuplicate(node1, engine);
    expect(deduper.isDuplicate(node2, engine)).toBe(false);
  });

  it("uses attribute ID over URL hash", () => {
    const engine = makeMockEngine(() => "attr-id");
    const node1 = makeElement("https://example.com/page1");
    const node2 = makeElement("https://example.com/page2");
    deduper.isDuplicate(node1, engine);
    // Both have same attr ID, so node2 is duplicate despite different URL
    expect(deduper.isDuplicate(node2, engine)).toBe(true);
  });

  it("reset() clears all seen IDs", () => {
    const engine = makeMockEngine(() => "abc");
    const node = makeElement();
    deduper.isDuplicate(node, engine);
    expect(deduper.size).toBe(1);
    deduper.reset();
    expect(deduper.size).toBe(0);
    expect(deduper.isDuplicate(node, engine)).toBe(false);
  });

  it("returns false for node with no link and no attribute", () => {
    const engine = makeMockEngine(() => null);
    const node = document.createElement("div"); // no link, no attr
    expect(deduper.isDuplicate(node, engine)).toBe(false);
  });

  it("tracks size correctly", () => {
    const engine = makeMockEngine(() => null);
    deduper.isDuplicate(makeElement("https://a.com"), engine);
    deduper.isDuplicate(makeElement("https://b.com"), engine);
    deduper.isDuplicate(makeElement("https://c.com"), engine);
    expect(deduper.size).toBe(3);
  });

  it("collapses Startpage proxy-wrapped duplicates to one identity", () => {
    const engine = makeMockEngine(() => null);
    // Same destination behind two different per-request proxy links
    // (params differ; hydration may also rewrite the anchor).
    const proxy1 = makeElement(
      "https://ixquick-proxy.com/do/spg/highlight.pl?l=eu&c=bbb&u=https%3A%2F%2Fwww.efset.org%2F"
    );
    const proxy2 = makeElement(
      "https://ixquick-proxy.com/do/spg/highlight.pl?l=eu&c=ccc&u=https%3A%2F%2Fefset.org%2F"
    );
    expect(deduper.isDuplicate(proxy1, engine)).toBe(false);
    // Different proxy params + www-stripped destination must still collide.
    expect(deduper.isDuplicate(proxy2, engine)).toBe(true);
  });

  it("strips tracking params so hydration rewrites cannot dodge the hash", () => {
    const engine = makeMockEngine(() => null);
    const clean = makeElement("https://example.com/page?a=1");
    const tracked = makeElement("https://example.com/page?a=1&utm_source=x");
    deduper.isDuplicate(clean, engine);
    expect(deduper.isDuplicate(tracked, engine)).toBe(true);
  });

  it("keeps destination query params on proxy-unwrapped identities (no over-stripping)", () => {
    const engine = makeMockEngine(() => null);
    const en = makeElement(
      "https://ixquick-proxy.com/do/spg/highlight.pl?sc=tok&u=https%3A%2F%2Fdocs.example.org%2Fapi%3Flanguage%3Den"
    );
    const fr = makeElement(
      "https://ixquick-proxy.com/do/spg/highlight.pl?sc=other&u=https%3A%2F%2Fdocs.example.org%2Fapi%3Flanguage%3Dfr"
    );
    expect(deduper.isDuplicate(en, engine)).toBe(false);
    // Distinct destinations differing ONLY in a param that used to be
    // stripped must stay distinct — the strip collapsed them silently.
    expect(deduper.isDuplicate(fr, engine)).toBe(false);
  });

  it("direct-link stripping: exact-name tracking params only (reference=/refresh= survive)", () => {
    const engine = makeMockEngine(() => null);
    const clean = makeElement("https://example.com/page?section=1");
    const tracked = makeElement("https://example.com/page?section=1&utm_source=rss&ref=hn");
    deduper.isDuplicate(clean, engine);
    expect(deduper.isDuplicate(tracked, engine)).toBe(true);
    // Site params that merely PREFIX-match tracking names must survive.
    const variant = makeElement("https://example.com/page?reference=abc&refresh=5");
    expect(deduper.isDuplicate(variant, engine)).toBe(false);
  });
});
