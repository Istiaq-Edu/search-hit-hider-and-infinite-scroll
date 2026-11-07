/** A fetched page request, serialized so a reload can replay it. */
export interface SavedPageRequest {
  url: string;
  /** Only POST engines (Startpage) need this; absent for GET. */
  method?: string;
  body?: string;
}

export interface ScrollState {
  url: string;
  scrollY: number;
  loadedUrls: string[];
  loadedPages: number;
  timestamp: number;
  /**
   * Replayable requests for the auto-loaded pages. Without these a deep
   * saved offset cannot be reached on reload (the pages are gone), so the
   * restore path used to clear the state instead of restoring anything.
   */
  loadedRequests?: SavedPageRequest[];
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
    // A partial record (e.g. loadedPages missing) would otherwise pass the
    // url/scrollY gate and make `saved.loadedPages <= 1` compare undefined.
    if (
      parsed &&
      typeof parsed.url === "string" &&
      typeof parsed.scrollY === "number" &&
      typeof parsed.loadedPages === "number" &&
      typeof parsed.timestamp === "number"
    ) {
      // Sanitize the optional replay list rather than reject the whole state:
      // one corrupt entry must not discard an otherwise valid scroll offset.
      const requests = Array.isArray(parsed.loadedRequests)
        ? parsed.loadedRequests.filter(isSavedPageRequest)
        : [];
      return { ...parsed, loadedUrls: Array.isArray(parsed.loadedUrls) ? parsed.loadedUrls : [], loadedRequests: requests };
    }
    return null;
  } catch {
    return null;
  }
}

function isSavedPageRequest(value: unknown): value is SavedPageRequest {
  if (!value || typeof value !== "object") return false;
  const r = value as SavedPageRequest;
  return (
    typeof r.url === "string" &&
    (r.method === undefined || typeof r.method === "string") &&
    (r.body === undefined || typeof r.body === "string")
  );
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
