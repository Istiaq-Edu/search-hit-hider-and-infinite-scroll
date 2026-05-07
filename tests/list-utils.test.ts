import { describe, it, expect } from "vitest";
import {
  addEntry,
  removeEntry,
  updateEntry,
  applyBulkOp,
  deduplicateEntries,
  sortEntries,
  filterEntries,
} from "../src/shared/list-utils";
import type { BlockEntry } from "../src/shared/types";

function e(
  domain: string,
  mode: "block" | "pban" = "block",
  createdAt = 1000,
  enabled = true
): BlockEntry {
  return { domain, mode, enabled, createdAt };
}

// ============================================================
// addEntry
// ============================================================
describe("addEntry", () => {
  it("adds a new entry with correct fields", () => {
    const { entries, added, duplicate } = addEntry([], "example.com", "block");
    expect(duplicate).toBe(false);
    expect(added).not.toBeNull();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.domain).toBe("example.com");
    expect(entries[0]?.mode).toBe("block");
    expect(entries[0]?.enabled).toBe(true);
    expect(typeof entries[0]?.createdAt).toBe("number");
  });

  it("normalizes www. prefix on add", () => {
    const { added } = addEntry([], "www.example.com", "block");
    expect(added?.domain).toBe("example.com");
  });

  it("normalizes uppercase on add", () => {
    const { added } = addEntry([], "EXAMPLE.COM", "block");
    expect(added?.domain).toBe("example.com");
  });

  it("detects duplicate — does not add, returns duplicate=true", () => {
    const initial = [e("example.com")];
    const { duplicate, entries } = addEntry(initial, "example.com", "block");
    expect(duplicate).toBe(true);
    expect(entries).toHaveLength(1);
  });

  it("detects duplicate after normalization (www vs no-www)", () => {
    const initial = [e("example.com")];
    const { duplicate } = addEntry(initial, "www.example.com", "block");
    expect(duplicate).toBe(true);
  });

  it("adds at end by default (position=end)", () => {
    const initial = [e("a.com", "block", 1), e("b.com", "block", 2)];
    const { entries } = addEntry(initial, "c.com", "block", "end");
    expect(entries[2]?.domain).toBe("c.com");
  });

  it("adds at top when position=top", () => {
    const initial = [e("a.com"), e("b.com")];
    const { entries } = addEntry(initial, "z.com", "block", "top");
    expect(entries[0]?.domain).toBe("z.com");
    expect(entries).toHaveLength(3);
  });

  it("adds in alphabetical position when position=sort", () => {
    const initial = [e("a.com"), e("z.com")];
    const { entries } = addEntry(initial, "m.com", "block", "sort");
    const idx = entries.findIndex((x) => x.domain === "m.com");
    expect(idx).toBeGreaterThan(0);
    expect(idx).toBeLessThan(entries.length - 1);
  });

  it("rejects empty domain — returns null added", () => {
    const { added } = addEntry([], "", "block");
    expect(added).toBeNull();
  });

  it("rejects single-character domain", () => {
    const { added } = addEntry([], "x", "block");
    expect(added).toBeNull();
  });

  it("adds pban mode correctly", () => {
    const { added } = addEntry([], "spam.com", "pban");
    expect(added?.mode).toBe("pban");
  });

  it("does not mutate the original entries array", () => {
    const original = [e("a.com")];
    addEntry(original, "b.com", "block");
    expect(original).toHaveLength(1);
  });
});

// ============================================================
// removeEntry
// ============================================================
describe("removeEntry", () => {
  it("removes the matching entry and returns it", () => {
    const initial = [e("a.com"), e("b.com"), e("c.com")];
    const { entries, removed } = removeEntry(initial, "b.com");
    expect(entries).toHaveLength(2);
    expect(removed?.domain).toBe("b.com");
    expect(entries.find((x) => x.domain === "b.com")).toBeUndefined();
  });

  it("returns null removed when domain not found", () => {
    const { removed, entries } = removeEntry([e("a.com")], "x.com");
    expect(removed).toBeNull();
    expect(entries).toHaveLength(1);
  });

  it("returns empty list when removing the only entry", () => {
    const { entries } = removeEntry([e("a.com")], "a.com");
    expect(entries).toHaveLength(0);
  });

  it("does not mutate the original list", () => {
    const original = [e("a.com"), e("b.com")];
    removeEntry(original, "a.com");
    expect(original).toHaveLength(2);
  });
});

// ============================================================
// updateEntry
// ============================================================
describe("updateEntry", () => {
  it("updates mode from block to pban", () => {
    const updated = updateEntry([e("a.com", "block")], "a.com", { mode: "pban" });
    expect(updated[0]?.mode).toBe("pban");
  });

  it("updates mode from pban to block", () => {
    const updated = updateEntry([e("a.com", "pban")], "a.com", { mode: "block" });
    expect(updated[0]?.mode).toBe("block");
  });

  it("updates enabled to false", () => {
    const updated = updateEntry([e("a.com")], "a.com", { enabled: false });
    expect(updated[0]?.enabled).toBe(false);
  });

  it("updates enabled to true", () => {
    const list = [{ ...e("a.com"), enabled: false }];
    const updated = updateEntry(list, "a.com", { enabled: true });
    expect(updated[0]?.enabled).toBe(true);
  });

  it("updates both mode and enabled simultaneously", () => {
    const updated = updateEntry([e("a.com", "block")], "a.com", { mode: "pban", enabled: false });
    expect(updated[0]?.mode).toBe("pban");
    expect(updated[0]?.enabled).toBe(false);
  });

  it("is a no-op for missing domain — list unchanged", () => {
    const list = [e("a.com")];
    const updated = updateEntry(list, "x.com", { mode: "pban" });
    expect(updated[0]?.mode).toBe("block");
  });

  it("only updates the target domain, leaves others unchanged", () => {
    const list = [e("a.com", "block"), e("b.com", "block")];
    const updated = updateEntry(list, "a.com", { mode: "pban" });
    expect(updated[0]?.mode).toBe("pban");
    expect(updated[1]?.mode).toBe("block");
  });

  it("does not mutate the original list", () => {
    const original = [e("a.com", "block")];
    updateEntry(original, "a.com", { mode: "pban" });
    expect(original[0]?.mode).toBe("block");
  });
});

// ============================================================
// applyBulkOp
// ============================================================
describe("applyBulkOp — delete", () => {
  it("deletes only the specified domains", () => {
    const list = [e("a.com"), e("b.com"), e("c.com")];
    const result = applyBulkOp(list, "delete", ["a.com", "c.com"]);
    expect(result).toHaveLength(1);
    expect(result[0]?.domain).toBe("b.com");
  });

  it("deletes all entries when no domains specified", () => {
    const list = [e("a.com"), e("b.com")];
    const result = applyBulkOp(list, "delete");
    expect(result).toHaveLength(0);
  });

  it("is a no-op when specified domain not in list", () => {
    const list = [e("a.com")];
    const result = applyBulkOp(list, "delete", ["x.com"]);
    expect(result).toHaveLength(1);
  });
});

describe("applyBulkOp — disable / enable", () => {
  it("disables specified domains", () => {
    const list = [e("a.com"), e("b.com")];
    const result = applyBulkOp(list, "disable", ["a.com"]);
    expect(result.find((x) => x.domain === "a.com")?.enabled).toBe(false);
    expect(result.find((x) => x.domain === "b.com")?.enabled).toBe(true);
  });

  it("disables all when no domains specified", () => {
    const list = [e("a.com"), e("b.com")];
    const result = applyBulkOp(list, "disable");
    expect(result.every((x) => !x.enabled)).toBe(true);
  });

  it("enables specified disabled domain", () => {
    const list = [{ ...e("a.com"), enabled: false }];
    const result = applyBulkOp(list, "enable", ["a.com"]);
    expect(result[0]?.enabled).toBe(true);
  });

  it("enables all when no domains specified", () => {
    const list = [
      { ...e("a.com"), enabled: false },
      { ...e("b.com"), enabled: false },
    ];
    const result = applyBulkOp(list, "enable");
    expect(result.every((x) => x.enabled)).toBe(true);
  });
});

describe("applyBulkOp — mode switching", () => {
  it("moves block → pban for specified domains", () => {
    const list = [e("a.com", "block"), e("b.com", "block")];
    const result = applyBulkOp(list, "to_pban", ["a.com"]);
    expect(result.find((x) => x.domain === "a.com")?.mode).toBe("pban");
    expect(result.find((x) => x.domain === "b.com")?.mode).toBe("block");
  });

  it("moves pban → block for specified domains", () => {
    const list = [e("a.com", "pban"), e("b.com", "pban")];
    const result = applyBulkOp(list, "to_block", ["a.com"]);
    expect(result.find((x) => x.domain === "a.com")?.mode).toBe("block");
    expect(result.find((x) => x.domain === "b.com")?.mode).toBe("pban");
  });

  it("moves all to pban when no domains specified", () => {
    const list = [e("a.com", "block"), e("b.com", "block")];
    const result = applyBulkOp(list, "to_pban");
    expect(result.every((x) => x.mode === "pban")).toBe(true);
  });
});

describe("applyBulkOp — normalize_www", () => {
  it("strips www. from specified domains", () => {
    const list = [
      { ...e("a.com"), domain: "www.example.com" },
      e("b.com"),
    ];
    const result = applyBulkOp(list, "normalize_www", ["www.example.com"]);
    expect(result.find((x) => x.domain === "example.com")).toBeDefined();
  });

  it("deduplicates after www normalization", () => {
    const list = [
      { ...e("a.com"), domain: "www.example.com" },
      { ...e("a.com"), domain: "example.com" },
    ];
    const result = applyBulkOp(list, "normalize_www");
    const exampleCount = result.filter((x) => x.domain === "example.com").length;
    expect(exampleCount).toBe(1);
  });
});

describe("applyBulkOp — dedup", () => {
  it("removes exact duplicate domains", () => {
    const list = [e("a.com"), e("a.com"), e("b.com"), e("b.com"), e("c.com")];
    const result = applyBulkOp(list, "dedup");
    expect(result).toHaveLength(3);
  });

  it("keeps first occurrence on dedup", () => {
    const first  = { ...e("a.com", "block"), createdAt: 1000 };
    const second = { ...e("a.com", "pban"),  createdAt: 2000 };
    const result = applyBulkOp([first, second], "dedup");
    expect(result[0]?.mode).toBe("block");
  });
});

describe("applyBulkOp — sort_date", () => {
  it("sorts by createdAt descending (newest first)", () => {
    const list = [e("a.com", "block", 1000), e("b.com", "block", 3000), e("c.com", "block", 2000)];
    const result = applyBulkOp(list, "sort_date");
    expect(result[0]?.domain).toBe("b.com");
    expect(result[1]?.domain).toBe("c.com");
    expect(result[2]?.domain).toBe("a.com");
  });
});

// ============================================================
// deduplicateEntries
// ============================================================
describe("deduplicateEntries", () => {
  it("removes exact duplicates, keeps first", () => {
    const first  = { ...e("a.com", "block"), createdAt: 1000 };
    const second = { ...e("a.com", "pban"),  createdAt: 2000 };
    const result = deduplicateEntries([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0]?.mode).toBe("block");
  });

  it("preserves order of first occurrences", () => {
    const list = [e("b.com"), e("a.com"), e("b.com"), e("c.com")];
    const result = deduplicateEntries(list);
    expect(result.map((x) => x.domain)).toEqual(["b.com", "a.com", "c.com"]);
  });

  it("returns same list when no duplicates", () => {
    const list = [e("a.com"), e("b.com"), e("c.com")];
    expect(deduplicateEntries(list)).toHaveLength(3);
  });

  it("returns empty list for empty input", () => {
    expect(deduplicateEntries([])).toHaveLength(0);
  });
});

// ============================================================
// sortEntries
// ============================================================
describe("sortEntries", () => {
  const list = [
    e("m.com", "block", 2000),
    e("a.com", "block", 1000),
    e("z.com", "block", 3000),
  ];

  it("date_desc — newest first", () => {
    const sorted = sortEntries(list, "date_desc");
    expect(sorted[0]?.domain).toBe("z.com");
    expect(sorted[1]?.domain).toBe("m.com");
    expect(sorted[2]?.domain).toBe("a.com");
  });

  it("date_asc — oldest first", () => {
    const sorted = sortEntries(list, "date_asc");
    expect(sorted[0]?.domain).toBe("a.com");
    expect(sorted[2]?.domain).toBe("z.com");
  });

  it("alpha_asc — A to Z", () => {
    const sorted = sortEntries(list, "alpha_asc");
    expect(sorted[0]?.domain).toBe("a.com");
    expect(sorted[sorted.length - 1]?.domain).toBe("z.com");
  });

  it("alpha_desc — Z to A", () => {
    const sorted = sortEntries(list, "alpha_desc");
    expect(sorted[0]?.domain).toBe("z.com");
    expect(sorted[sorted.length - 1]?.domain).toBe("a.com");
  });

  it("does not mutate original list", () => {
    const original = [e("z.com"), e("a.com")];
    sortEntries(original, "alpha_asc");
    expect(original[0]?.domain).toBe("z.com");
  });

  it("handles single-element list", () => {
    const sorted = sortEntries([e("a.com")], "alpha_asc");
    expect(sorted).toHaveLength(1);
  });

  it("handles empty list", () => {
    expect(sortEntries([], "date_desc")).toHaveLength(0);
  });
});

// ============================================================
// filterEntries
// ============================================================
describe("filterEntries", () => {
  const list = [
    e("example.com"),
    e("example.org"),
    e("other.net"),
    e("spam.example.co.uk"),
  ];

  it("matches by substring", () => {
    expect(filterEntries(list, "example")).toHaveLength(3);
  });

  it("returns all entries for empty query", () => {
    expect(filterEntries(list, "")).toHaveLength(4);
  });

  it("returns all entries for whitespace-only query", () => {
    expect(filterEntries(list, "   ")).toHaveLength(4);
  });

  it("is case-insensitive", () => {
    expect(filterEntries([e("Example.com")], "EXAMPLE")).toHaveLength(1);
    expect(filterEntries([e("example.com")], "Example")).toHaveLength(1);
  });

  it("returns empty list when nothing matches", () => {
    expect(filterEntries(list, "zzznomatch")).toHaveLength(0);
  });

  it("matches TLD portion", () => {
    expect(filterEntries(list, ".org")).toHaveLength(1);
  });

  it("handles empty list", () => {
    expect(filterEntries([], "anything")).toHaveLength(0);
  });
});
