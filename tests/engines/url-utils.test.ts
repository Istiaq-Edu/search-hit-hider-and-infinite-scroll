import { describe, it, expect } from "vitest";
import { isHostWithin, parseHttpUrl } from "../../src/content/engines/url-utils";

describe("isHostWithin", () => {
  it("matches the domain and its subdomains", () => {
    expect(isHostWithin("bing.com", "bing.com")).toBe(true);
    expect(isHostWithin("www.bing.com", "bing.com")).toBe(true);
    expect(isHostWithin("BING.COM", "bing.com")).toBe(true);
  });

  it("never matches a lookalike suffix", () => {
    expect(isHostWithin("bing.com.attacker.tld", "bing.com")).toBe(false);
    expect(isHostWithin("notbing.com", "bing.com")).toBe(false);
  });

  it("treats a root-zone trailing dot as the same host", () => {
    // URL.hostname keeps the trailing dot, so a link such as
    // https://www.bing.com./x must still be recognised as engine-internal.
    expect(isHostWithin("www.bing.com.", "bing.com")).toBe(true);
    expect(isHostWithin("bing.com.", "bing.com")).toBe(true);
  });
});

describe("parseHttpUrl", () => {
  it("rejects non-http(s) schemes", () => {
    expect(parseHttpUrl("javascript:alert(1)")).toBeNull();
    expect(parseHttpUrl("data:text/html,x")).toBeNull();
  });

  it("resolves relative hrefs against the supplied base", () => {
    const url = parseHttpUrl("/search?q=x", "https://www.bing.com");
    expect(url?.href).toBe("https://www.bing.com/search?q=x");
  });
});
