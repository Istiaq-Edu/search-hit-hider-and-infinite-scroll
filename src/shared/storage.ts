import type { BlockEntry, Prefs, PrefsPatch } from "./types";
import {
  DEFAULT_PREFS,
  STORAGE_KEY_LIST,
  STORAGE_KEY_PREFS,
  STORAGE_KEY_PREFS_LOCAL,
  STORAGE_KEY_UNDO,
} from "./types";

// ============================================================
// storage.local — block list
//
// Firefox gives storage.local a bounded quota (a few MB) unless the extension
// asks for `unlimitedStorage`. A domain list is orders of magnitude smaller
// than that, so no extra permission is justified — but the write is still
// awaited and errors are propagated: claiming success before the data is
// durable is how a mutation gets lost on a busy or full profile.
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
  let syncRaw: unknown = null;
  let localRaw: unknown = null;

  try {
    const result = await browser.storage.sync.get(STORAGE_KEY_PREFS);
    syncRaw = result[STORAGE_KEY_PREFS];
  } catch {
    // storage.sync may be unavailable in some environments
  }
  // Mirror written on every save. Read it even when sync succeeded: a failed
  // sync.set() leaves the mirror NEWER than the synced copy.
  try {
    const local = await browser.storage.local.get(STORAGE_KEY_PREFS_LOCAL);
    localRaw = local[STORAGE_KEY_PREFS_LOCAL];
  } catch { /* local also unavailable — use sync/defaults */ }

  // Prefer the newer snapshot. Without this comparison a transient sync
  // failure was silently reverted on the next background start: savePrefs
  // had written the local mirror, but loadPrefs unconditionally preferred
  // whatever stale payload still sat in storage.sync. Legacy payloads carry
  // no stamp (0); the sync-first tie-break preserves the old behaviour for
  // them, and also lets a genuine cross-device sync win.
  const syncTs = storedAt(syncRaw);
  const localTs = storedAt(localRaw);
  const chosen =
    localRaw && typeof localRaw === "object" && localTs > syncTs
      ? localRaw
      : (syncRaw && typeof syncRaw === "object" ? syncRaw : localRaw);

  if (chosen && typeof chosen === "object") {
    const payload = { ...(chosen as Record<string, unknown>) };
    delete payload.__shhSavedAt;
    return deepMerge(DEFAULT_PREFS, payload as Partial<Prefs>);
  }
  return { ...DEFAULT_PREFS };
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  const savedAt = Date.now();
  const payload = { ...prefs, __shhSavedAt: savedAt };
  // Mirror to local on EVERY save, not only when sync throws. The mirror is
  // the fallback loadPrefs() reads after a transient sync failure; if it is
  // only written on failure it can hold an arbitrarily old snapshot, and a
  // one-off sync hiccup silently reverts every preference set since.
  //
  // The mirror is BEST-EFFORT: storage.local also holds the block list and the
  // undo map, so a quota/availability failure there must not prevent a healthy
  // storage.sync from saving the user's settings.
  let mirrored = false;
  try {
    await browser.storage.local.set({ [STORAGE_KEY_PREFS_LOCAL]: payload });
    mirrored = true;
  } catch { /* mirror unavailable; sync below is authoritative */ }
  try {
    await browser.storage.sync.set({ [STORAGE_KEY_PREFS]: payload });
  } catch {
    // Sync unavailable: the local mirror just written is authoritative, and
    // its newer timestamp makes loadPrefs() choose it over stale sync data.
    // If the mirror ALSO failed, nothing is durable — say so instead of
    // reporting a save that never happened.
    if (!mirrored) throw new Error("Could not save preferences: no storage area accepted the write");
  }
}

function storedAt(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  const t = (raw as { __shhSavedAt?: unknown }).__shhSavedAt;
  return typeof t === "number" && Number.isFinite(t) ? t : 0;
}

export async function patchPrefs(patch: PrefsPatch): Promise<Prefs> {
  const current = await loadPrefs();
  // deepMerge merges nested records per key, which is what makes a minimal
  // `engineToggles: { [id]: value }` patch safe against concurrent writers.
  const updated = deepMerge(current, patch as Partial<Prefs>);
  await savePrefs(updated);
  return updated;
}

// ============================================================
// Undo records — one per domain, keyed so a toast can only undo ITS change
//
// The previous single global slot meant a toast's Undo button could revert a
// completely different domain's block/removal if anything else mutated the
// list in between (two quick blocks, a popup edit, another tab).
// ============================================================

export interface UndoRecord {
  action: "add" | "remove";
  entry: BlockEntry;
}

type UndoMap = Record<string, UndoRecord>;
const UNDO_MAP_MAX = 50;

async function loadUndoMap(): Promise<UndoMap> {
  const result = await browser.storage.local.get(STORAGE_KEY_UNDO);
  const raw = result[STORAGE_KEY_UNDO];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  // Legacy payload from the single-slot implementation is a BARE BlockEntry —
  // also a non-array object, so it can never reach the guard above. Detect it
  // on the valid-object path instead. A real map can have a domain literally
  // named "domain", but its value is an UndoRecord object, never a string.
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.domain === "string") {
    const legacy = raw as unknown as BlockEntry;
    return { [legacy.domain]: { action: "remove", entry: legacy } };
  }
  return raw as UndoMap;
}

export async function saveUndoEntry(
  entry: BlockEntry,
  action: "add" | "remove"
): Promise<void> {
  const map = await loadUndoMap();
  map[entry.domain] = { action, entry };
  const keys = Object.keys(map);
  if (keys.length > UNDO_MAP_MAX) {
    // Re-insertion order is not guaranteed in an object, so drop the oldest
    // createdAt rather than pretending insertion order is meaningful.
    keys
      .sort((a, b) => (map[a]?.entry.createdAt ?? 0) - (map[b]?.entry.createdAt ?? 0))
      .slice(0, keys.length - UNDO_MAP_MAX)
      .forEach((k) => { delete map[k]; });
  }
  await browser.storage.local.set({ [STORAGE_KEY_UNDO]: map });
}

/**
 * Pop the undo record for `domain`, or the newest record when omitted.
 * The record is removed so a second click cannot replay it.
 */
export async function popUndoEntry(domain?: string): Promise<UndoRecord | null> {
  const map = await loadUndoMap();
  let key: string;
  if (domain !== undefined) {
    // SCOPED call: no record for this domain means there is nothing safe to
    // undo. Falling back to the newest record here replayed a DIFFERENT
    // domain's add/remove — the toast added on top of the map-shaped undo
    // store reintroduced exactly the cross-domain bug the map was meant to
    // fix. Undo is only allowed when the caller names a domain that has one.
    if (!Object.prototype.hasOwnProperty.call(map, domain)) return null;
    key = domain;
  } else {
    const keys = Object.keys(map);
    if (keys.length === 0) return null;
    key = keys.sort(
      (a, b) => (map[b]?.entry.createdAt ?? 0) - (map[a]?.entry.createdAt ?? 0)
    )[0]!;
  }
  const record = map[key];
  if (!record) return null;
  delete map[key];
  if (Object.keys(map).length === 0) {
    await browser.storage.local.remove(STORAGE_KEY_UNDO);
  } else {
    await browser.storage.local.set({ [STORAGE_KEY_UNDO]: map });
  }
  return record;
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
