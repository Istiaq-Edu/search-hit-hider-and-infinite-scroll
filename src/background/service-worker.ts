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

// Debounced storage writes to avoid sequential writes for rapid changes
let pendingSave: ReturnType<typeof setTimeout> | null = null;
let pendingEntries: BlockEntry[] | null = null;

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
  scheduleSave(entries);
}

function scheduleSave(entries: BlockEntry[]): void {
  pendingEntries = entries;
  if (pendingSave) clearTimeout(pendingSave);
  pendingSave = setTimeout(() => {
    if (pendingEntries) {
      saveEntries(pendingEntries);
      pendingEntries = null;
    }
    pendingSave = null;
  }, 500);
}

// Flush pending writes on extension shutdown
if (browser.runtime.onSuspend) {
  browser.runtime.onSuspend.addListener(() => {
    if (pendingEntries) {
      saveEntries(pendingEntries);
    }
  });
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

// Track tabs with active content scripts to avoid broadcasting to all tabs
const activeTabIds = new Set<number>();

browser.runtime.onMessage.addListener(
  (
    message: unknown,
    sender: browser.runtime.MessageSender
  ): Promise<unknown> | true => {
    // Register tabs that send us messages (content scripts are active)
    if (sender.tab?.id && message && typeof message === "object" && "type" in message) {
      const msg = message as { type: string };
      if (msg.type !== "PREFS_UPDATED" && msg.type !== "LIST_UPDATED") {
        activeTabIds.add(sender.tab.id);
      }
    }
    if (!message || typeof message !== "object" || !("type" in message)) {
      return true;
    }

    const msg = message as ExtMessage;
    return handleMessage(msg);
  }
);

browser.tabs.onRemoved.addListener((tabId) => {
  activeTabIds.delete(tabId);
});

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
  if (activeTabIds.size === 0) {
    // Fallback: no registered tabs yet, query all tabs (first-run scenario)
    try {
      const tabs = await browser.tabs.query({});
      for (const tab of tabs) {
        if (tab.id !== undefined) {
          try {
            await browser.tabs.sendMessage(tab.id, message);
            activeTabIds.add(tab.id);
          } catch { /* Tab has no content script — ignore */ }
        }
      }
    } catch { /* tabs API unavailable */ }
    return;
  }

  const deadTabs: number[] = [];
  for (const tabId of activeTabIds) {
    try {
      await browser.tabs.sendMessage(tabId, message);
    } catch {
      deadTabs.push(tabId);
    }
  }
  // Clean up dead tabs
  for (const tabId of deadTabs) {
    activeTabIds.delete(tabId);
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
