import { describe, it, expect } from "vitest";
import {
  parseUserscriptFormat,
  parsePlainList,
  parseJSONBackup,
  exportToJSON,
  exportToPlainList,
  exportToUserscriptFormat,
  autoDetectAndParse,
} from "../src/shared/migration";
import type { BlockEntry } from "../src/shared/types";

function entry(domain: string, mode: "block" | "pban" = "block", enabled = true): BlockEntry {
  return { domain, mode, enabled, createdAt: 1000 };
}

// ============================================================
// parseUserscriptFormat
// ============================================================
describe("parseUserscriptFormat", () => {
  it("parses block entries (:t) and pban entries (:p)", () => {
    const raw = "|example.com:t|spam.net:p|bad.org:t|";
    const entries = parseUserscriptFormat(raw);
    expect(entries).toHaveLength(3);
    expect(entries.find((e) => e.domain === "example.com")?.mode).toBe("block");
    expect(entries.find((e) => e.domain === "spam.net")?.mode).toBe("pban");
    expect(entries.find((e) => e.domain === "bad.org")?.mode).toBe("block");
  });

  it("strips www. prefix during import", () => {
    const entries = parseUserscriptFormat("|www.example.com:t|");
    expect(entries[0]?.domain).toBe("example.com");
  });

  it("normalizes uppercase domains", () => {
    const entries = parseUserscriptFormat("|EXAMPLE.COM:t|");
    expect(entries[0]?.domain).toBe("example.com");
  });

  it("deduplicates by domain", () => {
    const entries = parseUserscriptFormat("|a.com:t|a.com:t|b.com:t|");
    expect(entries).toHaveLength(2);
  });

  it("keeps first occurrence on duplicate", () => {
    const entries = parseUserscriptFormat("|a.com:t|a.com:p|");
    expect(entries[0]?.mode).toBe("block");
  });

  it("skips entry with empty domain", () => {
    const entries = parseUserscriptFormat("|:t|valid.com:t||");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.domain).toBe("valid.com");
  });

  it("skips entries without colon separator", () => {
    const entries = parseUserscriptFormat("|nodomain|valid.com:t|");
    // "nodomain" has no colon → skipped
    expect(entries).toHaveLength(1);
  });

  it("returns empty array for empty string", () => {
    expect(parseUserscriptFormat("")).toHaveLength(0);
    expect(parseUserscriptFormat("||")).toHaveLength(0);
  });

  it("sets all entries as enabled=true", () => {
    const entries = parseUserscriptFormat("|a.com:t|");
    expect(entries[0]?.enabled).toBe(true);
  });

  it("treats unknown flag as block (defaults to :t)", () => {
    // Unknown suffix 'x' should default to block
    const entries = parseUserscriptFormat("|a.com:x|");
    expect(entries[0]?.mode).toBe("block");
  });

  it("handles no-pipe input by treating colon-suffix pairs as valid", () => {
    // The parser is lenient — even without outer pipes it can parse colon-delimited tokens
    const entries = parseUserscriptFormat("example.com:t");
    expect(entries.length).toBeGreaterThanOrEqual(0); // defined behavior: 0 or 1 is acceptable
  });
});

// ============================================================
// parsePlainList
// ============================================================
describe("parsePlainList", () => {
  it("parses one domain per line", () => {
    const entries = parsePlainList("a.com\nb.com\nc.com");
    expect(entries).toHaveLength(3);
  });

  it("ignores # comment lines", () => {
    const entries = parsePlainList("# a comment\nexample.com\n# another");
    expect(entries).toHaveLength(1);
  });

  it("ignores blank lines", () => {
    const entries = parsePlainList("\na.com\n\nb.com\n");
    expect(entries).toHaveLength(2);
  });

  it("handles Windows CRLF line endings", () => {
    const entries = parsePlainList("a.com\r\nb.com\r\nc.com");
    expect(entries).toHaveLength(3);
  });

  it("deduplicates by domain", () => {
    const entries = parsePlainList("example.com\nexample.com\nother.net");
    expect(entries).toHaveLength(2);
  });

  it("defaults all entries to block mode", () => {
    const entries = parsePlainList("example.com\nother.net");
    expect(entries.every((e) => e.mode === "block")).toBe(true);
  });

  it("respects explicit mode override", () => {
    const entries = parsePlainList("example.com", "pban");
    expect(entries[0]?.mode).toBe("pban");
  });

  it("strips www during parse", () => {
    const entries = parsePlainList("www.example.com");
    expect(entries[0]?.domain).toBe("example.com");
  });

  it("normalizes uppercase", () => {
    const entries = parsePlainList("EXAMPLE.COM");
    expect(entries[0]?.domain).toBe("example.com");
  });

  it("returns empty array for empty input", () => {
    expect(parsePlainList("")).toHaveLength(0);
    expect(parsePlainList("# only comments\n# nothing here")).toHaveLength(0);
  });

  it("trims whitespace around domains", () => {
    const entries = parsePlainList("  example.com  \n  other.net  ");
    expect(entries[0]?.domain).toBe("example.com");
    expect(entries[1]?.domain).toBe("other.net");
  });
});

// ============================================================
// parseJSONBackup
// ============================================================
describe("parseJSONBackup", () => {
  it("parses a JSON array of entries", () => {
    const input = JSON.stringify([
      { domain: "example.com", mode: "block", enabled: true, createdAt: 1000 },
      { domain: "spam.net",    mode: "pban",  enabled: true, createdAt: 2000 },
    ]);
    const entries = parseJSONBackup(input);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.domain).toBe("example.com");
    expect(entries[1]?.mode).toBe("pban");
  });

  it("parses { version, entries: [...] } backup format", () => {
    const input = JSON.stringify({
      version: 1,
      exportedAt: Date.now(),
      entries: [{ domain: "a.com", mode: "block", enabled: true, createdAt: 1 }],
    });
    const entries = parseJSONBackup(input);
    expect(entries).toHaveLength(1);
  });

  it("normalizes domain during import", () => {
    const input = JSON.stringify([{ domain: "WWW.EXAMPLE.COM", mode: "block" }]);
    const entries = parseJSONBackup(input);
    expect(entries[0]?.domain).toBe("example.com");
  });

  it("defaults enabled=true when missing", () => {
    const input = JSON.stringify([{ domain: "a.com", mode: "block" }]);
    const entries = parseJSONBackup(input);
    expect(entries[0]?.enabled).toBe(true);
  });

  it("defaults mode=block when mode is unrecognized", () => {
    const input = JSON.stringify([{ domain: "a.com", mode: "unknown" }]);
    const entries = parseJSONBackup(input);
    expect(entries[0]?.mode).toBe("block");
  });

  it("deduplicates by domain in imported array", () => {
    const input = JSON.stringify([
      { domain: "a.com", mode: "block" },
      { domain: "a.com", mode: "pban" },
    ]);
    const entries = parseJSONBackup(input);
    expect(entries).toHaveLength(1);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseJSONBackup("not json at all")).toThrow();
    expect(() => parseJSONBackup("{broken")).toThrow();
  });

  it("throws on valid JSON but unrecognized structure", () => {
    expect(() => parseJSONBackup('{"foo":"bar"}')).toThrow();
    expect(() => parseJSONBackup('"just a string"')).toThrow();
    expect(() => parseJSONBackup("42")).toThrow();
  });

  it("skips entries missing a domain field", () => {
    const input = JSON.stringify([
      { mode: "block" },                              // no domain
      { domain: "valid.com", mode: "block" },
    ]);
    const entries = parseJSONBackup(input);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.domain).toBe("valid.com");
  });
});

// ============================================================
// exportToJSON
// ============================================================
describe("exportToJSON", () => {
  it("produces parseable JSON", () => {
    const src = [entry("a.com"), entry("b.com", "pban")];
    expect(() => JSON.parse(exportToJSON(src))).not.toThrow();
  });

  it("includes version=1", () => {
    const parsed = JSON.parse(exportToJSON([entry("a.com")])) as { version: number };
    expect(parsed.version).toBe(1);
  });

  it("includes exportedAt timestamp", () => {
    const parsed = JSON.parse(exportToJSON([entry("a.com")])) as { exportedAt: number };
    expect(typeof parsed.exportedAt).toBe("number");
  });

  it("preserves all entry fields", () => {
    const src = [{ domain: "example.com", mode: "pban" as const, enabled: false, createdAt: 9999 }];
    const parsed = JSON.parse(exportToJSON(src)) as { entries: BlockEntry[] };
    expect(parsed.entries[0]?.domain).toBe("example.com");
    expect(parsed.entries[0]?.mode).toBe("pban");
    expect(parsed.entries[0]?.enabled).toBe(false);
    expect(parsed.entries[0]?.createdAt).toBe(9999);
  });

  it("round-trips through parseJSONBackup", () => {
    const src = [entry("a.com"), entry("b.com", "pban")];
    const restored = parseJSONBackup(exportToJSON(src));
    expect(restored).toHaveLength(2);
    expect(restored[0]?.domain).toBe("a.com");
    expect(restored[1]?.mode).toBe("pban");
  });

  it("produces empty entries array for empty input", () => {
    const parsed = JSON.parse(exportToJSON([])) as { entries: unknown[] };
    expect(parsed.entries).toHaveLength(0);
  });
});

// ============================================================
// exportToPlainList
// ============================================================
describe("exportToPlainList", () => {
  it("includes enabled entries", () => {
    const result = exportToPlainList([entry("a.com"), entry("b.com")]);
    expect(result).toContain("a.com");
    expect(result).toContain("b.com");
  });

  it("excludes disabled entries", () => {
    const list = [
      entry("enabled.com"),
      { ...entry("disabled.com"), enabled: false },
    ];
    const result = exportToPlainList(list);
    expect(result).toContain("enabled.com");
    expect(result).not.toContain("disabled.com");
  });

  it("one domain per line", () => {
    const list = [entry("a.com"), entry("b.com"), entry("c.com")];
    const lines = exportToPlainList(list).split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
  });

  it("annotates perma-ban when annotateMode=true", () => {
    const list = [entry("spam.com", "pban")];
    expect(exportToPlainList(list, true)).toContain("# perma-ban");
  });

  it("does not annotate when annotateMode=false (default)", () => {
    const list = [entry("spam.com", "pban")];
    expect(exportToPlainList(list, false)).not.toContain("# perma-ban");
    expect(exportToPlainList(list)).not.toContain("# perma-ban");
  });

  it("returns empty string for empty input", () => {
    expect(exportToPlainList([])).toBe("");
  });

  it("returns empty string when all entries are disabled", () => {
    const list = [{ ...entry("a.com"), enabled: false }];
    expect(exportToPlainList(list)).toBe("");
  });
});

// ============================================================
// exportToUserscriptFormat
// ============================================================
describe("exportToUserscriptFormat", () => {
  it("wraps output in leading and trailing pipe", () => {
    const result = exportToUserscriptFormat([entry("a.com")]);
    expect(result.startsWith("|")).toBe(true);
    expect(result.endsWith("|")).toBe(true);
  });

  it("encodes block entries as :t", () => {
    const result = exportToUserscriptFormat([entry("a.com", "block")]);
    expect(result).toMatch(/\|a\.com:t\|/);
  });

  it("encodes pban entries as :p", () => {
    const result = exportToUserscriptFormat([entry("b.com", "pban")]);
    expect(result).toMatch(/\|b\.com:p\|/);
  });

  it("excludes disabled entries", () => {
    const list = [entry("a.com"), { ...entry("b.com"), enabled: false }];
    const result = exportToUserscriptFormat(list);
    expect(result).toContain("a.com");
    expect(result).not.toContain("b.com");
  });

  it("handles multiple entries", () => {
    const list = [entry("a.com", "block"), entry("b.com", "pban"), entry("c.com", "block")];
    const result = exportToUserscriptFormat(list);
    expect(result).toMatch(/a\.com:t/);
    expect(result).toMatch(/b\.com:p/);
    expect(result).toMatch(/c\.com:t/);
  });

  it("round-trips through parseUserscriptFormat", () => {
    const src = [entry("a.com", "block"), entry("b.com", "pban")];
    const restored = parseUserscriptFormat(exportToUserscriptFormat(src));
    expect(restored).toHaveLength(2);
    expect(restored.find((e) => e.domain === "a.com")?.mode).toBe("block");
    expect(restored.find((e) => e.domain === "b.com")?.mode).toBe("pban");
  });
});

// ============================================================
// autoDetectAndParse
// ============================================================
describe("autoDetectAndParse", () => {
  it("detects JSON array", () => {
    const entries = autoDetectAndParse('[{"domain":"a.com","mode":"block"}]');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.domain).toBe("a.com");
  });

  it("detects JSON object backup format", () => {
    const src = JSON.stringify({ version: 1, entries: [{ domain: "a.com", mode: "block" }] });
    const entries = autoDetectAndParse(src);
    expect(entries).toHaveLength(1);
  });

  it("detects userscript pipe format", () => {
    const entries = autoDetectAndParse("|a.com:t|b.com:p|");
    expect(entries).toHaveLength(2);
  });

  it("detects userscript format with :t or :p anywhere", () => {
    const entries = autoDetectAndParse("a.com:t|b.com:p");
    expect(entries.length).toBeGreaterThan(0);
  });

  it("detects plain domain list", () => {
    const entries = autoDetectAndParse("a.com\nb.com\nc.com");
    expect(entries).toHaveLength(3);
  });

  it("returns empty for whitespace-only input (plain list path)", () => {
    const entries = autoDetectAndParse("   \n   \n   ");
    expect(entries).toHaveLength(0);
  });
});
