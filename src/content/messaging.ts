import type {
  BlockEntry,
  BlockMode,
  BulkOperation,
  Prefs,
  ExtMessage,
} from "../shared/types";

// ============================================================
// Typed message bus: content script <-> background
// ============================================================

import { loadEntries, loadPrefs } from "../shared/storage";

async function send<T>(msg: ExtMessage): Promise<T> {
  return browser.runtime.sendMessage(msg) as Promise<T>;
}

// ============================================================================
// DIRECT STORAGE READS — the critical path must not depend on the event page
// ============================================================================
// A field report on 2026-09-30: "the extension is not responsive until I open
// the extension once after every page load."
//
// That is an MV3 EVENT-PAGE cold start, not a bug in the blocking code. The
// content script's first action was `sendMessage(GET_LIST)`, which has to WAKE
// the suspended background. A cold wake on a real profile regularly exceeds
// the 2500 ms budget, so init burned the whole retry ladder — 2 x (400 ms sleep
// + 2500 ms timeout), up to 5.8 s — and fell back to the localStorage cache,
// which is a degraded start by definition. Opening the popup reads storage,
// which wakes the event page: that is exactly why doing so "fixed" the next
// load.
//
// The list and prefs live in `storage.local` / `storage.sync`, and the content
// script already holds the `storage` permission. The read therefore does not
// NEED the background at all — a direct `storage.local.get` takes a few
// milliseconds and cannot be stalled by a sleeping worker. Messaging stays for
// WRITES, which genuinely need the background in order to broadcast to other
// tabs.
export async function getListDirect(): Promise<BlockEntry[]> {
  return loadEntries();
}

export async function getPrefsDirect(): Promise<Prefs> {
  return loadPrefs();
}

export async function getList(): Promise<BlockEntry[]> {
  const res = await send<{ entries: BlockEntry[] }>({ type: "GET_LIST" });
  return res.entries;
}

export async function addEntry(
  domain: string,
  mode: BlockMode
): Promise<{ entry: BlockEntry | null; duplicate: boolean }> {
  return send({ type: "ADD_ENTRY", domain, mode });
}

export async function removeEntry(domain: string): Promise<void> {
  await send({ type: "REMOVE_ENTRY", domain });
}

export async function updateEntry(
  domain: string,
  patch: Partial<Pick<BlockEntry, "mode" | "enabled">>
): Promise<void> {
  await send({ type: "UPDATE_ENTRY", domain, patch });
}

export async function bulkOp(
  op: BulkOperation,
  domains?: string[]
): Promise<void> {
  const msg = domains !== undefined
    ? { type: "BULK_OP" as const, op, domains }
    : { type: "BULK_OP" as const, op };
  await send(msg);
}

export async function getPrefs(): Promise<Prefs> {
  const res = await send<{ prefs: Prefs }>({ type: "GET_PREFS" });
  return res.prefs;
}

export async function undoLast(): Promise<BlockEntry | null> {
  const res = await send<{ restored: BlockEntry | null }>({ type: "UNDO_LAST" });
  return res.restored;
}
