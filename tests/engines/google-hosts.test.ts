import { describe, it, expect } from "vitest";
import { isGoogleSearchHost } from "../../src/content/engines/google-hosts";

// The replay gate (infinite-scroll/manager.ts isReplayableRequest) trusts
// GoogleAdapter.matches(), which delegates here. A lookalike host must never
// pass: the replay list lives in page-origin localStorage and is untrusted.
describe("isGoogleSearchHost", () => {
  it("accepts portals and their news subdomains on real Google hosts", () => {
    expect(isGoogleSearchHost("google.com")).toBe(true);
    expect(isGoogleSearchHost("www.google.co.uk")).toBe(true);
    expect(isGoogleSearchHost("news.google.com")).toBe(true);
    expect(isGoogleSearchHost("news.google.co.uk")).toBe(true);
    expect(isGoogleSearchHost("news.google.de")).toBe(true);
    expect(isGoogleSearchHost("encrypted.google.com")).toBe(true);
  });

  it("rejects hosts that merely start with news.google.", () => {
    expect(isGoogleSearchHost("news.google.com.attacker.tld")).toBe(false);
    expect(isGoogleSearchHost("news.google.evil.com")).toBe(false);
    expect(isGoogleSearchHost("news.google.co.uk.attacker.tld")).toBe(false);
  });

  it("rejects unrelated lookalikes", () => {
    expect(isGoogleSearchHost("google.com.attacker.tld")).toBe(false);
    expect(isGoogleSearchHost("notgoogle.com")).toBe(false);
  });
});
