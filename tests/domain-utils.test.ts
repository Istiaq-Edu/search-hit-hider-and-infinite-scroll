import { describe, it, expect } from "vitest";
import {
  normalizeDomain,
  getRootDomain,
  getDomainLevels,
  getHostname,
  domainMatches,
  stripWww,
  isIPv4,
  toASCIIDomain,
} from "../src/shared/domain-utils";

// ============================================================
// normalizeDomain
// ============================================================
describe("normalizeDomain", () => {
  it("lowercases input", () => {
    expect(normalizeDomain("EXAMPLE.COM")).toBe("example.com");
    expect(normalizeDomain("Example.Com")).toBe("example.com");
  });

  it("strips www. by default", () => {
    expect(normalizeDomain("www.example.com")).toBe("example.com");
  });

  it("does not strip www. when stripWww=false", () => {
    expect(normalizeDomain("www.example.com", false)).toBe("www.example.com");
  });

  it("does not strip non-www subdomains", () => {
    expect(normalizeDomain("blog.example.com")).toBe("blog.example.com");
    expect(normalizeDomain("news.example.com")).toBe("news.example.com");
  });

  it("extracts hostname from https URL", () => {
    expect(normalizeDomain("https://www.example.com/path?q=1#section")).toBe("example.com");
  });

  it("extracts hostname from http URL", () => {
    expect(normalizeDomain("http://sub.example.co.uk/")).toBe("sub.example.co.uk");
  });

  it("strips path from bare domain+path string", () => {
    expect(normalizeDomain("example.com/some/path")).toBe("example.com");
  });

  it("strips query string from bare domain+query", () => {
    expect(normalizeDomain("example.com?q=test")).toBe("example.com");
  });

  it("strips hash from bare domain+hash", () => {
    expect(normalizeDomain("example.com#section")).toBe("example.com");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeDomain("  example.com  ")).toBe("example.com");
    expect(normalizeDomain("\t example.com \n")).toBe("example.com");
  });

  it("lowercases after extracting from URL", () => {
    expect(normalizeDomain("https://WWW.EXAMPLE.COM/")).toBe("example.com");
  });

  it("handles already-normalized domain", () => {
    expect(normalizeDomain("example.com")).toBe("example.com");
  });

  it("preserves valid subdomain structure", () => {
    expect(normalizeDomain("a.b.c.example.com")).toBe("a.b.c.example.com");
  });
});

// ============================================================
// getRootDomain
// ============================================================
describe("getRootDomain", () => {
  it("extracts root domain from single subdomain", () => {
    expect(getRootDomain("blog.example.com")).toBe("example.com");
  });

  it("extracts root domain from deep subdomain", () => {
    expect(getRootDomain("a.b.c.example.com")).toBe("example.com");
  });

  it("handles co.uk compound TLD correctly", () => {
    expect(getRootDomain("sub.example.co.uk")).toBe("example.co.uk");
    expect(getRootDomain("deep.sub.example.co.uk")).toBe("example.co.uk");
  });

  it("handles com.au compound TLD", () => {
    expect(getRootDomain("www.example.com.au")).toBe("example.com.au");
  });

  it("returns domain itself when already root", () => {
    expect(getRootDomain("example.com")).toBe("example.com");
    expect(getRootDomain("example.co.uk")).toBe("example.co.uk");
  });

  it("does not return bare TLD", () => {
    const result = getRootDomain("example.com");
    expect(result).not.toBe("com");
  });

  it("handles google.com subdomain correctly", () => {
    expect(getRootDomain("www.google.com")).toBe("google.com");
    expect(getRootDomain("mail.google.com")).toBe("google.com");
  });
});

// ============================================================
// getDomainLevels
// ============================================================
describe("getDomainLevels", () => {
  it("returns most-specific first, root last", () => {
    const levels = getDomainLevels("blog.sub.example.com");
    expect(levels[0]).toBe("blog.sub.example.com");
    expect(levels[levels.length - 1]).toBe("example.com");
  });

  it("has correct count for 3-part domain", () => {
    const levels = getDomainLevels("blog.example.com");
    expect(levels).toHaveLength(2);
    expect(levels).toContain("blog.example.com");
    expect(levels).toContain("example.com");
  });

  it("returns single item for root domain", () => {
    const levels = getDomainLevels("example.com");
    expect(levels).toHaveLength(1);
    expect(levels[0]).toBe("example.com");
  });

  it("never includes bare TLD", () => {
    const levels = getDomainLevels("example.co.uk");
    expect(levels).not.toContain("co.uk");
    expect(levels).not.toContain("uk");
  });

  it("handles co.uk compound TLD — root is correct", () => {
    const levels = getDomainLevels("blog.example.co.uk");
    expect(levels).toContain("example.co.uk");
    expect(levels).not.toContain("co.uk");
    expect(levels[0]).toBe("blog.example.co.uk");
  });

  it("strips www before computing levels", () => {
    const levels = getDomainLevels("www.example.com");
    expect(levels).toContain("example.com");
    expect(levels).not.toContain("www.example.com");
  });

  it("contains no duplicates", () => {
    const levels = getDomainLevels("a.b.example.com");
    const unique = new Set(levels);
    expect(unique.size).toBe(levels.length);
  });
});

// ============================================================
// getHostname
// ============================================================
describe("getHostname", () => {
  it("extracts hostname from https URL", () => {
    expect(getHostname("https://www.example.com/path?q=1")).toBe("www.example.com");
  });

  it("extracts hostname from http URL", () => {
    expect(getHostname("http://example.com/")).toBe("example.com");
  });

  it("handles URL with port — strips port", () => {
    expect(getHostname("http://example.com:8080/path")).toBe("example.com");
  });

  it("returns lowercase hostname", () => {
    expect(getHostname("https://EXAMPLE.COM/")).toBe("example.com");
  });

  it("returns empty string for non-URL string", () => {
    expect(getHostname("not a url")).toBe("");
    expect(getHostname("example.com")).toBe(""); // no scheme
  });

  it("returns empty string for empty input", () => {
    expect(getHostname("")).toBe("");
  });

  it("handles URL with trailing slash", () => {
    expect(getHostname("https://example.com/")).toBe("example.com");
  });
});

// ============================================================
// domainMatches
// ============================================================
describe("domainMatches", () => {
  it("matches identical domains", () => {
    expect(domainMatches("example.com", "example.com", false)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(domainMatches("EXAMPLE.COM", "example.com", false)).toBe(true);
    expect(domainMatches("example.com", "EXAMPLE.COM", false)).toBe(true);
  });

  it("matches direct subdomain with wildcard=true", () => {
    expect(domainMatches("sub.example.com", "example.com", true)).toBe(true);
  });

  it("matches deep subdomain with wildcard=true", () => {
    expect(domainMatches("a.b.c.example.com", "example.com", true)).toBe(true);
  });

  it("does not match subdomain with wildcard=false", () => {
    expect(domainMatches("sub.example.com", "example.com", false)).toBe(false);
  });

  it("does not match different domain", () => {
    expect(domainMatches("other.com", "example.com", true)).toBe(false);
    expect(domainMatches("other.com", "example.com", false)).toBe(false);
  });

  it("does not match lookalike domain (notexample.com)", () => {
    expect(domainMatches("notexample.com", "example.com", true)).toBe(false);
  });

  it("does not match superstring (example.com.evil.com)", () => {
    expect(domainMatches("example.com.evil.com", "example.com", true)).toBe(false);
  });

  it("matches www variant as subdomain", () => {
    // www.example.com is a subdomain of example.com
    expect(domainMatches("www.example.com", "example.com", true)).toBe(true);
    expect(domainMatches("www.example.com", "example.com", false)).toBe(false);
  });
});

// ============================================================
// stripWww
// ============================================================
describe("stripWww", () => {
  it("strips www. prefix", () => {
    expect(stripWww("www.example.com")).toBe("example.com");
  });

  it("leaves non-www domains unchanged", () => {
    expect(stripWww("example.com")).toBe("example.com");
    expect(stripWww("blog.example.com")).toBe("blog.example.com");
    expect(stripWww("news.example.com")).toBe("news.example.com");
  });

  it("does not strip wwwX domains", () => {
    expect(stripWww("www2.example.com")).toBe("www2.example.com");
  });

  it("handles bare www.", () => {
    // Edge case: just "www." alone
    expect(stripWww("www.")).toBe("");
  });
});

// ============================================================
// isIPv4
// ============================================================
describe("isIPv4", () => {
  it("recognizes valid IPv4 addresses", () => {
    expect(isIPv4("192.168.1.1")).toBe(true);
    expect(isIPv4("8.8.8.8")).toBe(true);
    expect(isIPv4("0.0.0.0")).toBe(true);
    expect(isIPv4("255.255.255.255")).toBe(true);
  });

  it("rejects domain names", () => {
    expect(isIPv4("example.com")).toBe(false);
    expect(isIPv4("google.com")).toBe(false);
  });

  it("rejects incomplete octets", () => {
    expect(isIPv4("192.168.1")).toBe(false);
    expect(isIPv4("192.168")).toBe(false);
    expect(isIPv4("192")).toBe(false);
  });

  it("rejects IPv6-style strings", () => {
    expect(isIPv4("::1")).toBe(false);
    expect(isIPv4("2001:db8::1")).toBe(false);
  });
});

// ============================================================
// toASCIIDomain
// ============================================================
describe("toASCIIDomain", () => {
  it("returns ASCII domain unchanged", () => {
    expect(toASCIIDomain("example.com")).toBe("example.com");
    expect(toASCIIDomain("sub.example.co.uk")).toBe("sub.example.co.uk");
  });

  it("converts unicode domain to punycode", () => {
    // München → xn-- prefix in punycode
    const result = toASCIIDomain("münchen.de");
    expect(result).toMatch(/xn--/);
  });

  it("falls back to original input on failure", () => {
    // If input can't be parsed, return it as-is
    const result = toASCIIDomain("not-a-real-idn-domain");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
