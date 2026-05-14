export interface ScrollState {
  url: string;
  scrollY: number;
  loadedUrls: string[];
  loadedPages: number;
  timestamp: number;
}

const STORAGE_KEY = "shh_infscroll_state";

export function saveScrollState(state: ScrollState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable
  }
}

export function loadScrollState(): ScrollState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ScrollState;
    if (parsed && typeof parsed.url === "string" && typeof parsed.scrollY === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function isStateFresh(state: ScrollState, maxAgeMinutes: number): boolean {
  return Date.now() - state.timestamp < maxAgeMinutes * 60 * 1000;
}

export function clearScrollState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
