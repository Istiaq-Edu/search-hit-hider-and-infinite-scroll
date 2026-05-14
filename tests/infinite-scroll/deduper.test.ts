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
});
