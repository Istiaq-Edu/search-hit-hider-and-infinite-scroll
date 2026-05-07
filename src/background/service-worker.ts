import type {
  ExtMessage,
  BlockEntry,
  Prefs,
  BulkImportResponse,
} from "../shared/types";
import {
  loadEntries,
  saveEntries,
  loadPrefs,
  patchPrefs,
  saveUndoEntry,
  popUndoEntry,
} from "../shared/storage";
import { addEntry, removeEntry, updateEntry, applyBulkOp } from "../shared/list-utils";

// ============================================================
// Background service worker — storage coordination + messaging
// ============================================================

let cachedEntries: BlockEntry[] | null = null;
let cachedPrefs: Prefs | null = null;

async function getEntries(): Promise<BlockEntry[]> {
  if (!cachedEntries) cachedEntries = await loadEntries();
  return cachedEntries;
}

async function getPrefs(): Promise<Prefs> {
  if (!cachedPrefs) cachedPrefs = await loadPrefs();
  return cachedPrefs;
}

async function persistEntries(entries: BlockEntry[]): Promise<void> {
  cachedEntries = entries;
  await saveEntries(entries);
}

// Invalidate cache when storage changes externally (e.g. other device via sync)
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "shh_entries" in changes) {
    cachedEntries = null;
  }
  if (area === "sync" && "shh_prefs" in changes) {
    cachedPrefs = null;
  }
});

// ============================================================
// Message handler
// ============================================================

browser.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender: browser.runtime.MessageSender
  ): Promise<unknown> | true => {
    if (!message || typeof message !== "object" || !("type" in message)) {
      return true;
    }

    const msg = message as ExtMessage;
    return handleMessage(msg);
  }
);

async function handleMessage(msg: ExtMessage): Promise<unknown> {
  switch (msg.type) {
    case "GET_LIST": {
      const entries = await getEntries();
      return { entries };
    }

    case "ADD_ENTRY": {
      const prefs = await getPrefs();
      const entries = await getEntries();
      const result = addEntry(entries, msg.domain, msg.mode, prefs.addPosition);
      if (result.added) {
        await persistEntries(result.entries);
        if (result.added) await saveUndoEntry(result.added);
      }
      return { entry: result.added, duplicate: result.duplicate };
    }

    case "REMOVE_ENTRY": {
      const entries = await getEntries();
      const result = removeEntry(entries, msg.domain);
      if (result.removed) {
        await persistEntries(result.entries);
        await saveUndoEntry(result.removed);
      }
      return { removed: result.removed };
    }

    case "UPDATE_ENTRY": {
      const entries = await getEntries();
      const updated = updateEntry(entries, msg.domain, msg.patch);
      await persistEntries(updated);
      return { ok: true };
    }

    case "BULK_OP": {
      const entries = await getEntries();
      const updated = applyBulkOp(entries, msg.op, msg.domains);
      await persistEntries(updated);
      void broadcastToContentScripts({ type: "LIST_UPDATED" });
      return { count: updated.length };
    }

    case "BULK_IMPORT": {
      const prefs = await getPrefs();
      let current = await getEntries();
      let added = 0;
      let duplicates = 0;
      let invalid = 0;

      for (const item of msg.entries) {
        const result = addEntry(current, item.domain, item.mode, prefs.addPosition);
        if (result.added) {
          current = result.entries;
          added++;
        } else if (result.duplicate) {
          duplicates++;
        } else {
          invalid++;
        }
      }

      if (added > 0) {
        await persistEntries(current);
        cachedEntries = current;
        void broadcastToContentScripts({ type: "LIST_UPDATED" });
      }

      const resp: BulkImportResponse = { added, duplicates, invalid };
      return resp;
    }

    case "GET_PREFS": {
      const prefs = await getPrefs();
      return { prefs };
    }

    case "SET_PREFS": {
      const updated = await patchPrefs(msg.patch);
      cachedPrefs = updated;
      return { prefs: updated };
    }

    case "UNDO_LAST": {
      const entry = await popUndoEntry();
      if (!entry) return { restored: null };
      // Re-add the entry
      const entries = await getEntries();
      const result = addEntry(entries, entry.domain, entry.mode);
      await persistEntries(result.entries);
      return { restored: entry };
    }

    default:
      return { error: "Unknown message type" };
  }
}

// ============================================================
// Broadcast to all tabs that have the content script running
// ============================================================

async function broadcastToContentScripts(message: object): Promise<void> {
  try {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (tab.id !== undefined) {
        try {
          await browser.tabs.sendMessage(tab.id, message);
        } catch {
          // Tab has no content script — ignore
        }
      }
    }
  } catch {
    // tabs API unavailable in this context — ignore
  }
}

// ============================================================
// Startup: warm up caches
// ============================================================

async function init(): Promise<void> {
  cachedEntries = await loadEntries();
  cachedPrefs = await loadPrefs();
}

void init();
