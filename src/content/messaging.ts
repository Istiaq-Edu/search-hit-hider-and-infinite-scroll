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

async function send<T>(msg: ExtMessage): Promise<T> {
  return browser.runtime.sendMessage(msg) as Promise<T>;
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
