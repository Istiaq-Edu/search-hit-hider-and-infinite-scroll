import type { BlockEntry, Prefs } from "./types";
import { DEFAULT_PREFS, STORAGE_KEY_LIST, STORAGE_KEY_PREFS, STORAGE_KEY_UNDO } from "./types";

// ============================================================
// storage.local — block list (no quota limit)
// ============================================================

export async function loadEntries(): Promise<BlockEntry[]> {
  const result = await browser.storage.local.get(STORAGE_KEY_LIST);
  const raw = result[STORAGE_KEY_LIST];
  if (Array.isArray(raw)) return raw as BlockEntry[];
  return [];
}

export async function saveEntries(entries: BlockEntry[]): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY_LIST]: entries });
}

// ============================================================
// storage.sync — preferences only
// ============================================================

export async function loadPrefs(): Promise<Prefs> {
  try {
    const result = await browser.storage.sync.get(STORAGE_KEY_PREFS);
    const raw = result[STORAGE_KEY_PREFS];
    if (raw && typeof raw === "object") {
      return deepMerge(DEFAULT_PREFS, raw as Partial<Prefs>);
    }
  } catch {
    // storage.sync may be unavailable in some environments
  }
  return { ...DEFAULT_PREFS };
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  try {
    await browser.storage.sync.set({ [STORAGE_KEY_PREFS]: prefs });
  } catch {
    // Fallback to local if sync unavailable
    await browser.storage.local.set({ [STORAGE_KEY_PREFS + "_local"]: prefs });
  }
}

export async function patchPrefs(patch: Partial<Prefs>): Promise<Prefs> {
  const current = await loadPrefs();
  const updated = deepMerge(current, patch);
  await savePrefs(updated);
  return updated;
}

// ============================================================
// Undo stack — last removed entry for quick undo
// ============================================================

export async function saveUndoEntry(entry: BlockEntry): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY_UNDO]: entry });
}

export async function popUndoEntry(): Promise<BlockEntry | null> {
  const result = await browser.storage.local.get(STORAGE_KEY_UNDO);
  const entry = result[STORAGE_KEY_UNDO];
  if (entry) {
    await browser.storage.local.remove(STORAGE_KEY_UNDO);
    return entry as BlockEntry;
  }
  return null;
}

// ============================================================
// Helpers
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
        result[key] = deepMerge(
          result[key] as object,
          val as object
        ) as T[keyof T];
      } else {
        result[key] = val as T[keyof T];
      }
    }
  }
  return result;
}
