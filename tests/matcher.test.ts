import { describe, it, expect } from "vitest";
import { DomainMatcher } from "../src/content/blocking/matcher";
import type { BlockEntry } from "../src/shared/types";

function entry(
  domain: string,
  mode: "block" | "pban" = "block",
  enabled = true
): BlockEntry {
  return { domain, mode, enabled, createdAt: Date.now() };
}

// ============================================================
// Basic matching
// ============================================================
describe("DomainMatcher — basic matching", () => {
  it("matches an exact domain", () => {
    const m = new DomainMatcher([entry("example.com")]);
    const r = m.match("https://example.com/path");
    expect(r.matched).toBe(true);
    expect(r.mode).toBe("block");
    expect(r.domain).toBe("example.com");
  });

  it("returns unmatched for unknown domain", () => {
    const m = new DomainMatcher([entry("example.com")]);
    expect(m.match("https://other.com/").matched).toBe(false);
  });

  it("returns matched=false with default mode for no-match", () => {
    const m = new DomainMatcher([]);
    const r = m.match("https://example.com/");
    expect(r.matched).toBe(false);
    expect(r.domain).toBe("");
  });

  it("handles empty entry list", () => {
    const m = new DomainMatcher([]);
    expect(m.match("https://anything.com/").matched).toBe(false);
    expect(m.size).toBe(0);
  });

  it("matches URL with path, query, and fragment", () => {
    const m = new DomainMatcher([entry("example.com")]);
    expect(m.match("https://example.com/some/path?q=test#anchor").matched).toBe(true);
  });
});

// ============================================================
// www stripping
// ============================================================
describe("DomainMatcher — www handling", () => {
  it("matches www variant when blocked domain has no www", () => {
    const m = new DomainMatcher([entry("example.com")]);
    expect(m.match("https://www.example.com/").matched).toBe(true);
  });

  it("matches blocked www.example.com against www.example.com URL", () => {
    const m = new DomainMatcher([entry("www.example.com")]);
    // www.example.com normalises to example.com in the matcher
    expect(m.match("https://www.example.com/").matched).toBe(true);
  });
});

// ============================================================
// Subdomain wildcard
// ============================================================
describe("DomainMatcher — subdomain wildcard", () => {
  it("matches direct subdomain with wildcard=true", () => {
    const m = new DomainMatcher([entry("example.com")], true);
    expect(m.match("https://sub.example.com/").matched).toBe(true);
  });

  it("matches deep nested subdomain with wildcard=true", () => {
    const m = new DomainMatcher([entry("example.com")], true);
    expect(m.match("https://a.b.c.example.com/").matched).toBe(true);
  });

  it("does not match subdomain with wildcard=false", () => {
    const m = new DomainMatcher([entry("example.com")], false);
    expect(m.match("https://sub.example.com/").matched).toBe(false);
  });

  it("does not match a lookalike domain with wildcard=true", () => {
    const m = new DomainMatcher([entry("example.com")], true);
    expect(m.match("https://notexample.com/").matched).toBe(false);
  });

  it("does not match superstring domain (example.com.evil.com)", () => {
    const m = new DomainMatcher([entry("example.com")], true);
    expect(m.match("https://example.com.evil.com/").matched).toBe(false);
  });
});

// ============================================================
// Block vs perma-ban priority
// ============================================================
describe("DomainMatcher — mode priority", () => {
  it("prioritizes pban over block for same domain", () => {
    const m = new DomainMatcher([
      entry("example.com", "block"),
      entry("example.com", "pban"),
    ]);
    expect(m.match("https://example.com/").mode).toBe("pban");
  });

  it("returns block mode for block-only entry", () => {
    const m = new DomainMatcher([entry("example.com", "block")]);
    expect(m.match("https://example.com/").mode).toBe("block");
  });

  it("returns pban mode for pban-only entry", () => {
    const m = new DomainMatcher([entry("example.com", "pban")]);
    expect(m.match("https://example.com/").mode).toBe("pban");
  });

  it("pban subdomain match (wildcard=true)", () => {
    const m = new DomainMatcher([entry("example.com", "pban")], true);
    const r = m.match("https://sub.example.com/");
    expect(r.matched).toBe(true);
    expect(r.mode).toBe("pban");
  });
});

// ============================================================
// Disabled entries
// ============================================================
describe("DomainMatcher — disabled entries", () => {
  it("skips disabled block entry", () => {
    const m = new DomainMatcher([entry("example.com", "block", false)]);
    expect(m.match("https://example.com/").matched).toBe(false);
  });

  it("skips disabled pban entry", () => {
    const m = new DomainMatcher([entry("example.com", "pban", false)]);
    expect(m.match("https://example.com/").matched).toBe(false);
  });

  it("only enabled entry wins when both exist", () => {
    const m = new DomainMatcher([
      entry("example.com", "pban", false), // disabled pban
      entry("example.com", "block", true),  // enabled block
    ]);
    const r = m.match("https://example.com/");
    expect(r.matched).toBe(true);
    expect(r.mode).toBe("block");
  });
});

// ============================================================
// Multiple entries
// ============================================================
describe("DomainMatcher — multiple entries", () => {
  it("matches correct entry among many", () => {
    const m = new DomainMatcher([
      entry("a.com"),
      entry("b.com"),
      entry("c.com"),
    ]);
    const r = m.match("https://b.com/page");
    expect(r.matched).toBe(true);
    expect(r.domain).toBe("b.com");
  });

  it("does not confuse similar domains", () => {
    const m = new DomainMatcher([entry("example.com"), entry("example.org")]);
    expect(m.match("https://example.com/").matched).toBe(true);
    expect(m.match("https://example.net/").matched).toBe(false);
  });

  it("reports correct size with mixed modes", () => {
    const m = new DomainMatcher([
      entry("a.com", "block"),
      entry("b.com", "pban"),
      entry("c.com", "block"),
    ]);
    expect(m.size).toBe(3);
  });

  it("size is 0 for all-disabled entries", () => {
    const m = new DomainMatcher([
      entry("a.com", "block", false),
      entry("b.com", "pban", false),
    ]);
    expect(m.size).toBe(0);
  });
});

// ============================================================
// rebuild()
// ============================================================
describe("DomainMatcher — rebuild", () => {
  it("replaces all entries on rebuild", () => {
    const m = new DomainMatcher([entry("a.com")]);
    expect(m.match("https://a.com/").matched).toBe(true);
    m.rebuild([entry("b.com")]);
    expect(m.match("https://a.com/").matched).toBe(false);
    expect(m.match("https://b.com/").matched).toBe(true);
  });

  it("rebuild with empty list clears matcher", () => {
    const m = new DomainMatcher([entry("a.com")]);
    m.rebuild([]);
    expect(m.match("https://a.com/").matched).toBe(false);
    expect(m.size).toBe(0);
  });

  it("size updates after rebuild", () => {
    const m = new DomainMatcher([entry("a.com"), entry("b.com")]);
    expect(m.size).toBe(2);
    m.rebuild([entry("c.com")]);
    expect(m.size).toBe(1);
  });
});

// ============================================================
// Edge cases / robustness
// ============================================================
describe("DomainMatcher — edge cases", () => {
  it("handles invalid URL gracefully", () => {
    const m = new DomainMatcher([entry("example.com")]);
    expect(m.match("not a url").matched).toBe(false);
    expect(m.match("").matched).toBe(false);
    expect(m.match("javascript:void(0)").matched).toBe(false);
  });

  it("handles URL with uppercase hostname", () => {
    const m = new DomainMatcher([entry("example.com")]);
    expect(m.match("https://EXAMPLE.COM/").matched).toBe(true);
  });

  it("does not match empty blocked domain", () => {
    // Empty domain should not match anything
    const m = new DomainMatcher([entry("")]);
    expect(m.match("https://anything.com/").matched).toBe(false);
  });
});
