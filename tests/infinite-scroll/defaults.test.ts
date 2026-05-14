import { describe, it, expect } from "vitest";
import { DEFAULT_PREFS } from "../../src/shared/types";

describe("DEFAULT_PREFS infinite scroll fields", () => {
  it("has infiniteScroll defaulting to true", () => {
    expect(DEFAULT_PREFS.infiniteScroll).toBe(true);
  });

  it("has infiniteScrollThreshold defaulting to 800", () => {
    expect(DEFAULT_PREFS.infiniteScrollThreshold).toBe(800);
  });

  it("has infiniteScrollMaxPages defaulting to 20", () => {
    expect(DEFAULT_PREFS.infiniteScrollMaxPages).toBe(20);
  });

  it("has infiniteScrollPersist defaulting to true", () => {
    expect(DEFAULT_PREFS.infiniteScrollPersist).toBe(true);
  });
});
