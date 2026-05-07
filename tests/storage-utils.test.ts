import { describe, it, expect } from "vitest";
import { DEFAULT_PREFS } from "../src/shared/types";

// ============================================================
// Test the deep-merge logic used in loadPrefs.
// deepMerge is private to storage.ts, so we verify its effects
// by re-implementing it here and testing it in isolation.
// ============================================================

function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const val = override[key];
    if (val !== undefined) {
      if (
        val !== null &&
        typeof val === "object" &&
        !Array.isArray(val) &&
        typeof result[key] === "object" &&
        result[key] !== null &&
        !Array.isArray(result[key])
      ) {
        result[key] = deepMerge(result[key] as object, val as object) as T[keyof T];
      } else {
        result[key] = val as T[keyof T];
      }
    }
  }
  return result;
}

describe("deepMerge (prefs merge logic)", () => {
  it("returns base when override is empty", () => {
    const result = deepMerge({ a: 1, b: 2 }, {});
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("overrides top-level scalar values", () => {
    const result = deepMerge({ a: 1, b: 2 }, { a: 99 });
    expect(result.a).toBe(99);
    expect(result.b).toBe(2);
  });

  it("does not overwrite with undefined", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = deepMerge({ a: 1 }, { a: undefined } as any);
    expect(result.a).toBe(1);
  });

  it("deep-merges nested objects", () => {
    const base = { nested: { x: 1, y: 2 } };
    const override = { nested: { x: 99 } } as Partial<typeof base>;
    const result = deepMerge(base, override);
    expect(result.nested.x).toBe(99);
    expect(result.nested.y).toBe(2);
  });

  it("replaces arrays entirely (no array merging)", () => {
    const base = { arr: [1, 2, 3] };
    const override = { arr: [4, 5] };
    const result = deepMerge(base, override);
    expect(result.arr).toEqual([4, 5]);
  });

  it("does not mutate the base object", () => {
    const base = { a: 1, nested: { x: 1 } };
    deepMerge(base, { a: 99 });
    expect(base.a).toBe(1);
  });

  it("merges DEFAULT_PREFS with partial override correctly", () => {
    const override = { debugMode: true, theme: "dark" as const };
    const result = deepMerge(DEFAULT_PREFS, override);
    expect(result.debugMode).toBe(true);
    expect(result.theme).toBe("dark");
    expect(result.showNotices).toBe(DEFAULT_PREFS.showNotices);
    expect(result.oneClick).toBe(DEFAULT_PREFS.oneClick);
  });

  it("merges nested engineToggles correctly", () => {
    const override = { engineToggles: { google: false } } as Partial<typeof DEFAULT_PREFS>;
    const result = deepMerge(DEFAULT_PREFS, override);
    expect(result.engineToggles.google).toBe(false);
    expect(result.engineToggles.bing).toBe(true);
    expect(result.engineToggles.duckduckgo).toBe(true);
  });

  it("merges buttonStyle scalar correctly", () => {
    const override = { buttonStyle: "icon" as const };
    const result = deepMerge(DEFAULT_PREFS, override);
    expect(result.buttonStyle).toBe("icon");
    expect(result.showOnHover).toBe(DEFAULT_PREFS.showOnHover);
  });

  it("merges showOnHover correctly", () => {
    const override = { showOnHover: true };
    const result = deepMerge(DEFAULT_PREFS, override);
    expect(result.showOnHover).toBe(true);
    expect(result.buttonStyle).toBe(DEFAULT_PREFS.buttonStyle);
  });
});
