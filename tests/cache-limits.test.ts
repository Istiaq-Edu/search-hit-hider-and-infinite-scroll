import { describe, it, expect } from "vitest";
import {
  MAX_CACHE_DOMAINS,
  MAX_CACHE_RAW_LENGTH,
  MAX_DOMAIN_LENGTH,
  readCachePayload,
  sanitizeCacheDomains,
  toCacheDomain,
} from "../src/content/cache-limits";
import { buildCache, parseCache } from "../src/content/cache-state";
import { DEFAULT_PREFS, type BlockEntry, type Prefs } from "../src/shared/types";

// ============================================================
// `_shh_cache` is UNTRUSTED input
//
// It lives in localStorage on the page's origin. Any script that ran on a
// search engine can write it, and the preload reads it synchronously at
// document_start — before extension storage can validate anything. These tests
// pin the three properties that make that safe:
//
//   1. bounded  — parse size, entry count, and CSS selector count
//   2. sanitized — entries must be ASCII hostnames, not CSS fragments
//   3. consistent — the content script's parser and the preload's sanitizer
//      agree on what an entry means (www handling in particular)
// ============================================================

function entry(domain: string, enabled = true): BlockEntry {
  return { domain, mode: "block", enabled, createdAt: 1 };
}

function prefs(over: Partial<Prefs> = {}): Prefs {
  return {
    ...DEFAULT_PREFS,
    engineToggles: { ...DEFAULT_PREFS.engineToggles },
    pausedEngines: [...DEFAULT_PREFS.pausedEngines],
    ...over,
  };
}

describe("readCachePayload — bounded parse", () => {
  it("returns null for absent or corrupt input", () => {
    expect(readCachePayload(null)).toBeNull();
    expect(readCachePayload("")).toBeNull();
    expect(readCachePayload("{not json")).toBeNull();
  });

  it("returns null for payloads that are not objects", () => {
    expect(readCachePayload("null")).toBeNull();
    expect(readCachePayload("42")).toBeNull();
    expect(readCachePayload('"a string"')).toBeNull();
    expect(readCachePayload("[]")).toBeNull();
  });

  it("REFUSES an oversized payload before parsing it", () => {
    // A page can write a multi-megabyte value. Parsing it at document_start is
    // the cost this cap exists to avoid — and the value is refused outright,
    // not truncated into a half-valid payload.
    const huge = '{"domains":["a.com"]}' + " ".repeat(MAX_CACHE_RAW_LENGTH);
    expect(huge.length).toBeGreaterThan(MAX_CACHE_RAW_LENGTH);
    expect(readCachePayload(huge)).toBeNull();
  });

  it("accepts a normal payload", () => {
    expect(readCachePayload('{"domains":["a.com"]}')).toEqual({ domains: ["a.com"] });
  });
});

describe("toCacheDomain — hostname or nothing", () => {
  it("lowercases, trims and punycodes", () => {
    expect(toCacheDomain("  EXAMPLE.com  ", true)).toBe("example.com");
    expect(toCacheDomain("bücher.de", true)).toBe("xn--bcher-kva.de");
  });

  it("strips a trailing root-zone dot", () => {
    expect(toCacheDomain("example.com.", true)).toBe("example.com");
  });

  it("strips www ONLY when the preference says so", () => {
    // The preload used to strip unconditionally. With strip-www OFF an entry
    // for www.example.com therefore became example.com, and the preload hid
    // the bare host that the content script considers unblocked — while the
    // actual www host was never pre-hidden.
    expect(toCacheDomain("www.example.com", true)).toBe("example.com");
    expect(toCacheDomain("www.example.com", false)).toBe("www.example.com");
  });

  it("rejects anything that is not a hostname", () => {
    expect(toCacheDomain({}, true)).toBeNull();
    expect(toCacheDomain(42, true)).toBeNull();
    expect(toCacheDomain(null, true)).toBeNull();
    expect(toCacheDomain("", true)).toBeNull();
    expect(toCacheDomain("exa mple.com", true)).toBeNull();
    expect(toCacheDomain('example.com"', true)).toBeNull();
    expect(toCacheDomain("example.com}", true)).toBeNull();
    expect(toCacheDomain("javascript:alert(1)", true)).toBeNull();
  });

  it("rejects URL-shaped input — cache entries are stored as bare hosts", () => {
    // Same outcome as the shipped preload's `new URL("https://" + d)` attempt:
    // the scheme-prefixed string fails to parse and the slash/colon fail the
    // hostname gate. Entries are written normalized, so a URL here is junk.
    expect(toCacheDomain("https://example.com/path", true)).toBeNull();
  });

  it("rejects DOTLESS entries — with wildcard on they would hide a whole TLD", () => {
    // A poisoned cache containing "com" + wildcard:true used to hide every
    // .com result on the page.
    expect(toCacheDomain("com", true)).toBeNull();
    expect(toCacheDomain("localhost", true)).toBeNull();
  });

  it("rejects labels longer than 63 and hosts longer than 253", () => {
    expect(toCacheDomain(`${"a".repeat(64)}.com`, true)).toBeNull();
    const tooLong = Array.from({ length: 5 }, () => "a".repeat(60)).join(".") + ".com";
    expect(tooLong.length).toBeGreaterThan(MAX_DOMAIN_LENGTH);
    expect(toCacheDomain(tooLong, true)).toBeNull();
    // A legal host still passes.
    expect(toCacheDomain(`${"a".repeat(50)}.${"b".repeat(50)}.com`, true)).not.toBeNull();
    expect(MAX_DOMAIN_LENGTH).toBe(253);
  });

  it("rejects empty labels (doubled dots)", () => {
    expect(toCacheDomain("a..b.com", true)).toBeNull();
    expect(toCacheDomain(".example.com", true)).toBeNull();
  });
});

describe("sanitizeCacheDomains — bounded, deduplicated list", () => {
  it("returns [] for anything that is not an array", () => {
    for (const junk of [undefined, null, 42, true, {}, "a.com"]) {
      expect(sanitizeCacheDomains(junk, true)).toEqual([]);
    }
  });

  it("drops non-string entries and deduplicates after normalization", () => {
    expect(
      sanitizeCacheDomains(["EXAMPLE.com", {}, 7, "example.com", "www.example.com", null], true)
    ).toEqual(["example.com"]);
  });

  it("caps the list at MAX_CACHE_DOMAINS", () => {
    const many = Array.from({ length: MAX_CACHE_DOMAINS + 25 }, (_, i) => `d${i}.com`);
    const out = sanitizeCacheDomains(many, true);
    expect(out).toHaveLength(MAX_CACHE_DOMAINS);
    expect(out[0]).toBe("d0.com");
    expect(out).not.toContain(`d${MAX_CACHE_DOMAINS}.com`);
  });

  it("preserves order — the CSS cap takes the first entries", () => {
    expect(sanitizeCacheDomains(["b.com", "a.com"], true)).toEqual(["b.com", "a.com"]);
  });
});

describe("cache-state uses the same boundary", () => {
  it("parseCache refuses an oversized payload", () => {
    const huge = '{"domains":["a.com"]}' + " ".repeat(MAX_CACHE_RAW_LENGTH);
    expect(parseCache(huge)).toBeNull();
  });

  it("parseCache filters poisoned entries (dotless TLD, CSS fragments)", () => {
    const c = parseCache(
      JSON.stringify({ domains: ["com", 'a"b', "ok.com", "com"], wildcard: true })
    );
    expect(c!.domains).toEqual(["ok.com"]);
  });

  it("parseCache caps the list", () => {
    const many = Array.from({ length: MAX_CACHE_DOMAINS + 10 }, (_, i) => `d${i}.com`);
    const c = parseCache(JSON.stringify({ domains: many }));
    expect(c!.domains).toHaveLength(MAX_CACHE_DOMAINS);
  });

  it("parseCache keeps www when stripWww is off", () => {
    const c = parseCache(JSON.stringify({ domains: ["www.example.com"], stripWww: false }));
    expect(c!.domains).toEqual(["www.example.com"]);
  });

  it("buildCache truncates on the write side too", () => {
    // Otherwise a very large imported list would produce a payload the reader
    // rejects entirely, making pre-paint hiding silently inert.
    const entries = Array.from({ length: MAX_CACHE_DOMAINS + 5 }, (_, i) =>
      entry(`d${i}.com`)
    );
    const c = buildCache(entries, prefs(), "google");
    expect(c.domains).toHaveLength(MAX_CACHE_DOMAINS);
    expect(parseCache(JSON.stringify(c))).not.toBeNull();
  });
});
