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
  // Fallback: prefs previously saved locally when sync was unavailable
  // (savePrefs writes here when sync throws). Without this read the
  // fallback key is write-only and those prefs are silently lost.
  try {
    const local = await browser.storage.local.get(STORAGE_KEY_PREFS + "_local");
    const raw = local[STORAGE_KEY_PREFS + "_local"];
    if (raw && typeof raw === "object") {
      return deepMerge(DEFAULT_PREFS, raw as Partial<Prefs>);
    }
  } catch { /* local also unavailable — defaults */ }
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
    // null / undefined: keep the default. A corrupted sync payload containing
    // nulls (e.g. engineToggles: null) must not null out required fields —
    // that would crash every consumer that reads prefs.engineToggles[...].
    if (val === undefined || val === null) continue;
    const current = result[key];
    // Type-mismatch guard: only accept an override when its shape matches the
    // default's shape (object←object, array←array, scalar←scalar). A
    // non-array over an array (or an object over a scalar) is corruption.
    if (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof current === "object" &&
      current !== null &&
      !Array.isArray(current)
    ) {
      result[key] = deepMerge(
        current as object,
        val as object
      ) as T[keyof T];
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
