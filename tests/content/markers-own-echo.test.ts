import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { isOwnEchoRecord } from "../../src/content/markers";

// ============================================================
// 1.8.10 crash regression (2026-09-07 field report): "browser
// crashed on every search after load".
//
// Root cause: 1.8.10 added data-shh-ok to the preload observer's
// attributeFilter (A1-2 self-heal), but Case D REACTS to ok records
// by REMOVING ok and re-running tryHide — which re-stamps ok. Every
// stamp therefore armed the next removal: remove → re-stamp → new
// record → remove → … an unbounded microtask loop, event-loop
// starvation, tab freeze, browser crash.
//
// The gate (markers.ts isOwnEchoRecord) discriminates by PRESENCE:
//   PRESENT  = our own SET echoing back  → ignore (nothing to heal)
//   ABSENT   = Google STRIPPED our marker → heal (walk up + tryHide)
//
// This test binds to the SHIPPED predicate (A5-R1 lesson: no
// mirror-copies) and pins the direction, not the implementation.
// ============================================================

function doc(): Document {
  return new JSDOM(
    `<!DOCTYPE html><html><body><div id="rso">
      <div class="g" data-shh-ok="true"></div>
      <div class="g"></div>
    </div></body></html>`,
    { url: "https://www.google.com/search?q=t" }
  ).window.document;
}

describe("isOwnEchoRecord (1.8.10 crash gate)", () => {
  it("our own SET of data-shh-ok echoes as own-echo → observer must ignore", () => {
    const d = doc();
    const stamped = d.querySelector("div.g[data-shh-ok]")!;
    // The record our tryHide()/reveal pass generates on every stamp:
    expect(isOwnEchoRecord("data-shh-ok", stamped)).toBe(true);
  });

  it("Google STRIPPING data-shh-ok is NOT an own-echo → observer must heal", () => {
    const d = doc();
    const stripped = d.querySelector("div.g:not([data-shh-ok])")!;
    // Attribute record with the attribute now absent (oldValue "true").
    expect(isOwnEchoRecord("data-shh-ok", stripped)).toBe(false);
  });

  it("same semantics for data-shh-preloaded", () => {
    const d = doc();
    const el = d.querySelector("div.g:not([data-shh-ok])")!;
    el.setAttribute("data-shh-preloaded", "true");
    expect(isOwnEchoRecord("data-shh-preloaded", el)).toBe(true); // our SET
    el.removeAttribute("data-shh-preloaded");
    expect(isOwnEchoRecord("data-shh-preloaded", el)).toBe(false); // strip
  });

  it("non-marker attributes (href) never count as own-echo", () => {
    const d = doc();
    const a = d.createElement("a");
    a.setAttribute("href", "https://example.com/");
    expect(isOwnEchoRecord("href", a)).toBe(false);
    expect(isOwnEchoRecord(null, a)).toBe(false);
  });
});
