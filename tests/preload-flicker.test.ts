import { describe, it, expect } from "vitest";

// ============================================================
// Tests for the Google search flicker fix.
//
// The root cause was that the preload's :has() CSS rules used
// ^= (starts-with) selectors which never matched Google's
// redirect-style href attributes:
//   href="/url?q=https://example.com/path&sa=U&ved=..."
//
// The fix switches to *= (contains) selectors using "://domain/"
// which appears as a substring in BOTH direct and redirect hrefs.
//
// These tests verify:
//   1. resolveHost  — correctly extracts the destination hostname
//      from both direct and Google /url?q= redirect hrefs.
//   2. hrefContains — the *=  matching logic that drives :has() CSS
//      rules, confirming it matches what ^= used to miss.
//   3. No false positives — lookalike domains are not incorrectly matched.
// ============================================================

// ── Inline re-implementation of preload's resolveHost ─────────────────────
// The preload IIFE is not importable, so we replicate the exact logic here
// to test it in isolation.  If the logic in preload.ts ever changes, this
// test should be updated to match.
function resolveHost(href: string, absoluteHref: string): string {
  if (href.includes("/url?") || href.includes("google.com/url")) {
    try {
      const qs = href.slice(href.indexOf("?") + 1);
      const q = new URLSearchParams(qs).get("q");
      if (q && q.startsWith("http")) return new URL(q).hostname;
    } catch { /* fall through */ }
  }
  try { return new URL(absoluteHref).hostname; } catch { return ""; }
}

// ── Inline re-implementation of the *= matching logic ─────────────────────
// Mirrors what buildHasRules() in preload.ts generates.
// Returns true if the raw href attribute would be matched by any of the
// CSS rules produced for this domain.  Covers:
//   a[href*="://${d}/"]   a[href*="://${d}?"]   a[href*="://${d}&"]
//   a[href*="://www.${d}/"] ... and wildcard a[href*=".${d}/"] ...
function hrefContainsDomain(rawHref: string, domain: string, wildcard = false): boolean {
  for (const suffix of ["/", "?", "&"]) {
    if (rawHref.includes(`://${domain}${suffix}`)) return true;
    if (rawHref.includes(`://www.${domain}${suffix}`)) return true;
    if (wildcard && rawHref.includes(`.${domain}${suffix}`)) return true;
  }
  return false;
}

// ============================================================
// resolveHost — Google redirect URL unwrapping
// ============================================================
describe("resolveHost — Google redirect URL unwrapping", () => {
  it("extracts host from a direct https link", () => {
    const href = "https://reddit.com/r/programming";
    expect(resolveHost(href, href)).toBe("reddit.com");
  });

  it("extracts host from a Google /url?q= relative redirect", () => {
    const raw  = "/url?q=https://reddit.com/r/programming&sa=U&ved=abc";
    const abs  = "https://www.google.com/url?q=https://reddit.com/r/programming&sa=U&ved=abc";
    expect(resolveHost(raw, abs)).toBe("reddit.com");
  });

  it("extracts host from a Google /url?q= with www destination", () => {
    const raw = "/url?q=https://www.bbc.co.uk/news/article&sa=U";
    const abs = "https://www.google.com" + raw;
    expect(resolveHost(raw, abs)).toBe("www.bbc.co.uk");
  });

  it("extracts host from an absolute google.com/url redirect", () => {
    const raw = "https://www.google.com/url?q=https://stackoverflow.com/q/123";
    expect(resolveHost(raw, raw)).toBe("stackoverflow.com");
  });

  it("falls back to absoluteHref when no /url? pattern", () => {
    const raw = "https://example.com/some/path";
    expect(resolveHost(raw, raw)).toBe("example.com");
  });

  it("returns empty string for a completely invalid URL", () => {
    expect(resolveHost("not-a-url", "not-a-url")).toBe("");
  });

  it("handles URL-encoded q param correctly", () => {
    const encoded = encodeURIComponent("https://news.ycombinator.com/item?id=99");
    const raw = `/url?q=${encoded}&sa=U`;
    const abs = "https://www.google.com" + raw;
    expect(resolveHost(raw, abs)).toBe("news.ycombinator.com");
  });
});

// ============================================================
// hrefContainsDomain — *= CSS selector logic
// This is the core of the flicker fix: verify that the *=
// (contains) pattern matches both direct and redirect hrefs.
// ============================================================
describe("hrefContainsDomain — direct links (previously worked with ^=)", () => {
  it("matches a plain https direct link", () => {
    expect(hrefContainsDomain("https://reddit.com/r/programming", "reddit.com")).toBe(true);
  });

  it("matches a plain http direct link", () => {
    expect(hrefContainsDomain("http://reddit.com/r/programming", "reddit.com")).toBe(true);
  });

  it("matches a www-prefixed direct link", () => {
    expect(hrefContainsDomain("https://www.reddit.com/r/programming", "reddit.com")).toBe(true);
  });

  it("matches a direct link with query string and fragment", () => {
    expect(hrefContainsDomain("https://example.com/page?foo=bar#section", "example.com")).toBe(true);
  });
});

describe("hrefContainsDomain — Google redirect links (the flicker bug)", () => {
  it("matches a Google /url?q= redirect to a plain domain", () => {
    // This is the href value that ^= 'https://reddit.com/' MISSED:
    const href = "/url?q=https://reddit.com/r/programming&sa=U&ved=abc";
    expect(hrefContainsDomain(href, "reddit.com")).toBe(true);
  });

  it("matches a Google /url?q= redirect to a www-prefixed domain", () => {
    const href = "/url?q=https://www.reddit.com/r/news&sa=U&ved=xyz";
    expect(hrefContainsDomain(href, "reddit.com")).toBe(true);
  });

  it("matches a redirect with http destination", () => {
    const href = "/url?q=http://example.com/old-page&sa=U";
    expect(hrefContainsDomain(href, "example.com")).toBe(true);
  });

  it("matches an absolute google.com/url redirect", () => {
    const href = "https://www.google.com/url?q=https://stackoverflow.com/q/123";
    expect(hrefContainsDomain(href, "stackoverflow.com")).toBe(true);
  });

  it("matches redirect with URL-encoded destination (decoded by browser)", () => {
    // Browsers present the decoded attribute value to CSS — simulate that.
    const decoded = "/url?q=https://news.ycombinator.com/item?id=99&sa=U";
    expect(hrefContainsDomain(decoded, "news.ycombinator.com")).toBe(true);
  });
});

describe("hrefContainsDomain — wildcard subdomain matching", () => {
  it("matches a subdomain direct link with wildcard=true", () => {
    expect(hrefContainsDomain("https://sub.example.com/page", "example.com", true)).toBe(true);
  });

  it("matches a subdomain inside a Google redirect with wildcard=true", () => {
    const href = "/url?q=https://sub.example.com/page&sa=U";
    expect(hrefContainsDomain(href, "example.com", true)).toBe(true);
  });

  it("does NOT match a subdomain without wildcard", () => {
    expect(hrefContainsDomain("https://sub.example.com/page", "example.com", false)).toBe(false);
  });

  it("does NOT match a Google redirect to a subdomain without wildcard", () => {
    const href = "/url?q=https://sub.example.com/page&sa=U";
    expect(hrefContainsDomain(href, "example.com", false)).toBe(false);
  });
});

describe("hrefContainsDomain — no false positives", () => {
  it("does NOT match a different domain", () => {
    expect(hrefContainsDomain("https://notreddit.com/page", "reddit.com")).toBe(false);
  });

  it("does NOT match a domain that contains the blocked one as a suffix", () => {
    // e.g. blocking 'reddit.com' must not match 'myreddit.com'
    expect(hrefContainsDomain("https://myreddit.com/page", "reddit.com")).toBe(false);
  });

  it("does NOT match a Google redirect to a different domain", () => {
    const href = "/url?q=https://notexample.com/page&sa=U";
    expect(hrefContainsDomain(href, "example.com")).toBe(false);
  });

  it("does NOT match a hash-only href", () => {
    expect(hrefContainsDomain("#section", "example.com")).toBe(false);
  });

  it("does NOT match a javascript: URI", () => {
    expect(hrefContainsDomain("javascript:void(0)", "example.com")).toBe(false);
  });

  it("does NOT match a Google-internal navigation link as a blocked result", () => {
    // A link like /search?q=... does not contain ://example.com/
    expect(hrefContainsDomain("/search?q=example", "example.com")).toBe(false);
  });

  it("does NOT match blocked domain as a query param value in unrelated redirect", () => {
    // /url?q=https://safe.com/?ref=reddit.com — the blocked string appears
    // after a different domain's path; "://reddit.com/" must not match
    // because the slash after 'reddit.com' is not present in this URL.
    const href = "/url?q=https://safe.com/?ref=reddit.com&sa=U";
    expect(hrefContainsDomain(href, "reddit.com")).toBe(false);
  });
});

// ============================================================
// Regression: the old ^= logic that caused the flicker bug
// These tests document exactly why the old approach was wrong.
// ============================================================
describe("regression — old ^= logic missed Google redirect links", () => {
  function oldHrefStartsWith(rawHref: string, domain: string): boolean {
    if (rawHref.startsWith(`https://${domain}/`)) return true;
    if (rawHref.startsWith(`http://${domain}/`))  return true;
    if (rawHref.startsWith(`https://www.${domain}/`)) return true;
    if (rawHref.startsWith(`http://www.${domain}/`))  return true;
    return false;
  }

  it("old ^= correctly matched direct links (baseline)", () => {
    expect(oldHrefStartsWith("https://reddit.com/r/programming", "reddit.com")).toBe(true);
  });

  it("old ^= MISSED Google redirect links (the bug)", () => {
    const redirectHref = "/url?q=https://reddit.com/r/programming&sa=U&ved=abc";
    // This was the bug — ^= returned false, so the CSS rule never fired,
    // allowing a visible frame before the JS MutationObserver ran.
    expect(oldHrefStartsWith(redirectHref, "reddit.com")).toBe(false);
  });

  it("new *= FIXES the same redirect link", () => {
    const redirectHref = "/url?q=https://reddit.com/r/programming&sa=U&ved=abc";
    expect(hrefContainsDomain(redirectHref, "reddit.com")).toBe(true);
  });
});
