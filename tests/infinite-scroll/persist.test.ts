import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  saveScrollState,
  loadScrollState,
  isStateFresh,
  clearScrollState,
  type ScrollState,
} from "../../src/content/infinite-scroll/persist";

const STORAGE_KEY = "shh_infscroll_state";

// localStorage mock setup — jsdom provides localStorage but may not expose
// all methods depending on the vitest/jsdom version.
function setupLocalStorageMock(): void {
  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
    get length() { return Object.keys(store).length; },
    key: (index: number) => Object.keys(store)[index] ?? null,
  });
}

function makeState(overrides?: Partial<ScrollState>): ScrollState {
  return {
    url: "https://www.google.com/search?q=test",
    scrollY: 1500,
    loadedUrls: [],
    loadedPages: 3,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("persist", () => {
  beforeEach(() => {
    setupLocalStorageMock();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("saves and loads scroll state", () => {
    const state = makeState();
    saveScrollState(state);
    const loaded = loadScrollState();
    expect(loaded).not.toBeNull();
    expect(loaded!.url).toBe(state.url);
    expect(loaded!.scrollY).toBe(1500);
    expect(loaded!.loadedPages).toBe(3);
  });

  it("loadScrollState returns null when no state saved", () => {
    expect(loadScrollState()).toBeNull();
  });

  it("loadScrollState returns null for corrupted JSON", () => {
    localStorage.setItem(STORAGE_KEY, "not-json");
    expect(loadScrollState()).toBeNull();
  });

  it("loadScrollState returns null for incomplete state", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ foo: "bar" }));
    expect(loadScrollState()).toBeNull();
  });

  it("isStateFresh returns true for recent state", () => {
    const state = makeState({ timestamp: Date.now() - 5 * 60 * 1000 });
    expect(isStateFresh(state, 30)).toBe(true);
  });

  it("isStateFresh returns false for expired state", () => {
    const state = makeState({ timestamp: Date.now() - 60 * 60 * 1000 });
    expect(isStateFresh(state, 30)).toBe(false);
  });

  it("isStateFresh returns true just within the boundary", () => {
    const state = makeState({ timestamp: Date.now() - 30 * 60 * 1000 + 1 });
    expect(isStateFresh(state, 30)).toBe(true);
  });

  it("isStateFresh returns false just past the boundary", () => {
    const state = makeState({ timestamp: Date.now() - 30 * 60 * 1000 - 1 });
    expect(isStateFresh(state, 30)).toBe(false);
  });

  it("clearScrollState removes saved state", () => {
    saveScrollState(makeState());
    expect(loadScrollState()).not.toBeNull();
    clearScrollState();
    expect(loadScrollState()).toBeNull();
  });

  it("handles localStorage being full gracefully", () => {
    // Temporarily break localStorage.setItem
    const origSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
    expect(() => saveScrollState(makeState())).not.toThrow();
    localStorage.setItem = origSetItem;
  });
});
