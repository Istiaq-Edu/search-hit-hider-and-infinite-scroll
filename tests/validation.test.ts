import { describe, it, expect } from "vitest";
import { isValidDomain, normalizeDomain } from "../src/shared/domain-utils";
import { addEntry, deduplicateEntries } from "../src/shared/list-utils";
import { parsePlainList, parseUserscriptFormat, parseJSONBackup } from "../src/shared/migration";
import { DomainMatcher } from "../src/content/blocking/matcher";

// ============================================================
// Robustness sweep tests: junk-domain rejection (CSS-injection guard),
// trailing-dot normalization, case-insensitive dedup, and IDN punycode
// matching in the matcher.
// ============================================================

describe("isValidDomain", () => {
  it("accepts normal domains", () => {
    for (const d of ["example.com", "sub.example.co.uk", "a-b.io", "xn--mnchen-3ya.de", "münchen.de", "localhost8.dev"]) {
      expect(isValidDomain(d)).toBe(true);
    }
  });

  it("rejects CSS-breaking and junk strings", () => {
    for (const d of ['evil.com"}', "hello world", "<script>alert(1)<", "!!!", ".", "com", "", "a;b.com", "a(b).com", "back\\slash.com"]) {
      expect(isValidDomain(d)).toBe(false);
    }
  });
});

describe("normalizeDomain trailing dot", () => {
  it("strips trailing root-zone dots", () => {
    expect(normalizeDomain("example.com.")).toBe("example.com");
    expect(normalizeDomain("example.com..")).toBe("example.com");
    expect(normalizeDomain("example.com")).toBe("example.com");
  });
});

describe("addEntry rejects junk", () => {
  it("does not store strings that cannot be hostnames", () => {
    const before: Parameters<typeof addEntry>[0] = [];
    const r = addEntry(before, 'evil.com"}', "block");
    expect(r.added).toBeNull();
    expect(r.entries).toHaveLength(0);

    const r2 = addEntry(before, "hello world", "pban");
    expect(r2.added).toBeNull();
  });

  it("still accepts valid domains", () => {
    const r = addEntry([], "good.com", "block");
    expect(r.added?.domain).toBe("good.com");
  });
});

describe("parsers reject junk entries", () => {
  it("parsePlainList skips junk lines but keeps valid ones", () => {
    const out = parsePlainList('evil.com"}\nhello world\n<svg onload=alert(1)>\ngood.com\n');
    expect(out.map((e) => e.domain)).toEqual(["good.com"]);
  });

  it("parseUserscriptFormat skips junk entries", () => {
    const out = parseUserscriptFormat('|evil.com"}:t|good.com:t|');
    expect(out.map((e) => e.domain)).toEqual(["good.com"]);
  });

  it("parseJSONBackup drops entries with junk domains", () => {
    const raw = JSON.stringify([
      { domain: 'evil.com"}', mode: "pban" },
      { domain: "good.com", mode: "block" },
    ]);
    const out = parseJSONBackup(raw);
    expect(out.map((e) => e.domain)).toEqual(["good.com"]);
  });
});

describe("deduplicateEntries is case/www insensitive", () => {
  it("collapses X.com / x.com / www.x.com into one", () => {
    const out = deduplicateEntries([
      { domain: "X.com", mode: "block", enabled: true, createdAt: 1 },
      { domain: "x.com", mode: "block", enabled: true, createdAt: 2 },
      { domain: "www.x.com", mode: "block", enabled: true, createdAt: 3 },
      { domain: "y.com", mode: "block", enabled: true, createdAt: 4 },
    ]);
    expect(out.map((e) => e.domain)).toEqual(["X.com", "y.com"]);
  });
});

describe("DomainMatcher punycode keys (IDN fix)", () => {
  it("unicode entry matches punycode hostname from a URL", () => {
    const matcher = new DomainMatcher(
      [{ domain: "münchen.de", mode: "block", enabled: true, createdAt: 1 }],
      false
    );
    // URL parsing always yields the ASCII form
    expect(matcher.match("https://xn--mnchen-3ya.example.de/").matched).toBe(false);
    expect(matcher.match("https://münchen.de/").matched).toBe(true);
    expect(matcher.match("https://xn--mnchen-3ya.de/").matched).toBe(true);
  });
});

// ============================================================
// Preload sanitizeDomains — inline replication of the logic in
// src/content/preload.ts (the preload IIFE is not importable).
// ============================================================
const HOSTNAME_SAFE = /^[a-z0-9.-]+$/;
function sanitizeDomains(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    let d = raw.trim().toLowerCase();
    if (d.startsWith("www.")) d = d.slice(4);
    try {
      d = new URL("https://" + d).hostname;
    } catch { /* unparseable — the safety check below rejects it */ }
    if (!d || !HOSTNAME_SAFE.test(d) || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
}

describe("preload sanitizeDomains", () => {
  it("converts unicode to punycode and strips www", () => {
    expect(sanitizeDomains(["www.Example.com", "münchen.de"])).toEqual([
      "example.com",
      "xn--mnchen-3ya.de",
    ]);
  });

  it("drops CSS-breaking and unparseable entries instead of interpolating them", () => {
    expect(sanitizeDomains(['evil.com"}', "hello world", "a;b.com", "good.com"])).toEqual(["good.com"]);
  });

  it("deduplicates after conversion", () => {
    expect(sanitizeDomains(["münchen.de", "xn--mnchen-3ya.de", "example.com"])).toEqual([
      "xn--mnchen-3ya.de",
      "example.com",
    ]);
  });
});
