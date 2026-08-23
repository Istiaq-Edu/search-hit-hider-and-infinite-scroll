import { describe, it, expect } from "vitest";
import { DEFAULT_PREFS } from "../src/shared/types";

// ============================================================
// Test the deep-merge logic used in loadPrefs.
// deepMerge is private to storage.ts, so we verify its effects
// by re-implementing it here and testing it in isolation.
// ============================================================

// Mirrors the hardened deepMerge in src/shared/storage.ts: null and
// type-mismatched values are rejected so a corrupted sync payload cannot
// null out required prefs fields or crash their consumers.
function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const val = override[key];
    if (val === undefined || val === null) continue;
    const current = result[key];
    if (
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof current === "object" &&
      current !== null &&
      !Array.isArray(current)
    ) {
      result[key] = deepMerge(current as object, val as object) as T[keyof T];
    } else if (
      Array.isArray(val) === Array.isArray(current) &&
      typeof val === typeof current
    ) {
      result[key] = val as T[keyof T];
    }
    // else: shape mismatch — keep the default value.
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

  it("keeps defaults when override values are null", () => {
    const override = { showNotices: null, engineToggles: null } as unknown as Partial<typeof DEFAULT_PREFS>;
    const result = deepMerge(DEFAULT_PREFS, override);
    expect(result.showNotices).toBe(DEFAULT_PREFS.showNotices);
    expect(result.engineToggles).toEqual(DEFAULT_PREFS.engineToggles);
  });

  it("rejects shape-mismatched values (object over array, scalar over object)", () => {
    const override = {
      pausedEngines: { google: true },
      engineToggles: "yes",
    } as unknown as Partial<typeof DEFAULT_PREFS>;
    const result = deepMerge(DEFAULT_PREFS, override);
    expect(Array.isArray(result.pausedEngines)).toBe(true);
    expect(typeof result.engineToggles).toBe("object");
  });

  it("drops unknown keys not present in defaults", () => {
    const override = { bogusKey: "EVIL" } as unknown as Partial<typeof DEFAULT_PREFS>;
    const result = deepMerge(DEFAULT_PREFS, override);
    expect((result as unknown as Record<string, unknown>)["bogusKey"]).toBeUndefined();
  });
});
