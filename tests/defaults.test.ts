import { describe, it, expect } from "vitest";
import {
  DEFAULT_PREFS,
  ALL_ENGINE_IDS,
  type EngineId,
} from "../src/shared/types";

// ============================================================
// DEFAULT_PREFS shape and sanity checks
// ============================================================
describe("DEFAULT_PREFS", () => {
  it("has engineToggles for every engine in ALL_ENGINE_IDS", () => {
    for (const id of ALL_ENGINE_IDS) {
      expect(id in DEFAULT_PREFS.engineToggles).toBe(true);
    }
  });

  it("has all engine toggles set to true by default", () => {
    for (const id of ALL_ENGINE_IDS) {
      expect(DEFAULT_PREFS.engineToggles[id]).toBe(true);
    }
  });

  it("has no extra engine IDs beyond ALL_ENGINE_IDS", () => {
    const keys = Object.keys(DEFAULT_PREFS.engineToggles) as EngineId[];
    expect(keys.length).toBe(ALL_ENGINE_IDS.length);
    for (const key of keys) {
      expect(ALL_ENGINE_IDS).toContain(key);
    }
  });

  it("showNotices is true by default", () => {
    expect(DEFAULT_PREFS.showNotices).toBe(true);
  });

  it("oneClick is false by default", () => {
    expect(DEFAULT_PREFS.oneClick).toBe(false);
  });

  it("oneClickTarget is 'block' by default", () => {
    expect(DEFAULT_PREFS.oneClickTarget).toBe("block");
  });

  it("domainChoiceMode is 'ask' by default", () => {
    expect(DEFAULT_PREFS.domainChoiceMode).toBe("ask");
  });

  it("stripWww is true by default", () => {
    expect(DEFAULT_PREFS.stripWww).toBe(true);
  });

  it("addPosition is 'end' by default", () => {
    expect(DEFAULT_PREFS.addPosition).toBe("end");
  });

  it("subdomainWildcard is true by default", () => {
    expect(DEFAULT_PREFS.subdomainWildcard).toBe(true);
  });

  it("mutationObserver is true by default", () => {
    expect(DEFAULT_PREFS.mutationObserver).toBe(true);
  });

  it("debugMode is false by default", () => {
    expect(DEFAULT_PREFS.debugMode).toBe(false);
  });

  it("pausedGlobally is false by default", () => {
    expect(DEFAULT_PREFS.pausedGlobally).toBe(false);
  });

  it("pausedEngines is an empty array by default", () => {
    expect(DEFAULT_PREFS.pausedEngines).toEqual([]);
  });

  it("theme is 'system' by default", () => {
    expect(DEFAULT_PREFS.theme).toBe("system");
  });

  it("aggressiveBlock is 'none' by default", () => {
    expect(DEFAULT_PREFS.aggressiveBlock).toBe("none");
  });

  it("buttonStyle is 'text' by default", () => {
    expect(DEFAULT_PREFS.buttonStyle).toBe("text");
  });

  it("showOnHover is false by default", () => {
    expect(DEFAULT_PREFS.showOnHover).toBe(false);
  });
});

// ============================================================
// ALL_ENGINE_IDS
// ============================================================
describe("ALL_ENGINE_IDS", () => {
  const EXPECTED_ENGINES: EngineId[] = [
    "google",
    "duckduckgo",
    "bing",
    "yandex",
    "baidu",
    "brave",
  ];

  it("contains exactly 6 engines", () => {
    expect(ALL_ENGINE_IDS).toHaveLength(6);
  });

  it("contains all expected engine IDs", () => {
    for (const id of EXPECTED_ENGINES) {
      expect(ALL_ENGINE_IDS).toContain(id);
    }
  });

  it("has no duplicate engine IDs", () => {
    const unique = new Set(ALL_ENGINE_IDS);
    expect(unique.size).toBe(ALL_ENGINE_IDS.length);
  });
});
