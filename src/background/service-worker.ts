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
import { broadcastToTabs, shouldEvictTab } from "./broadcast";

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

// Consecutive send failures per tab. `tabs.onRemoved` prunes on close, but
// nothing prunes on NAVIGATION — so a tab that left an engine page keeps its id
// and fails every send forever, which both costs an IPC round-trip and (because
// any failure triggers the sweep) a tabs.query on every subsequent mutation.
// Evicting on the FIRST failure is what this whole module exists to undo, so
// instead we require K in a row; see shouldEvictTab.
const sendFailures = new Map<number, number>();

function noteSendResult(tabId: number, ok: boolean): void {
  if (ok) {
    sendFailures.delete(tabId);
    activeTabIds.add(tabId);
    return;
  }
  const n = (sendFailures.get(tabId) ?? 0) + 1;
  if (shouldEvictTab(n)) {
    sendFailures.delete(tabId);
    activeTabIds.delete(tabId);
  } else {
    sendFailures.set(tabId, n);
  }
}

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
    return handleMessage(msg, sender.tab?.id);
  }
);

browser.tabs.onRemoved.addListener((tabId) => {
  activeTabIds.delete(tabId);
  sendFailures.delete(tabId);
});

async function handleMessage(msg: ExtMessage, senderTabId?: number): Promise<unknown> {
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
        await saveUndoEntry(result.added);
        // Other tabs must re-process so the new domain hides there too.
        // The sender already updated its own local state.
        void broadcastToContentScripts({ type: "LIST_UPDATED" }, senderTabId);
      }
      return { entry: result.added, duplicate: result.duplicate };
    }

    case "REMOVE_ENTRY": {
      const entries = await getEntries();
      const result = removeEntry(entries, msg.domain);
      if (result.removed) {
        await persistEntries(result.entries);
        await saveUndoEntry(result.removed);
        void broadcastToContentScripts({ type: "LIST_UPDATED" }, senderTabId);
      }
      return { removed: result.removed };
    }

    case "UPDATE_ENTRY": {
      const entries = await getEntries();
      const updated = updateEntry(entries, msg.domain, msg.patch);
      await persistEntries(updated);
      void broadcastToContentScripts({ type: "LIST_UPDATED" }, senderTabId);
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
      // Broadcast. Without this, refreshPrefs() in the content script is dead
      // code: nothing ever sends PREFS_UPDATED, so pause/unpause, the
      // subdomain-wildcard setting and engine toggles never reach an open tab.
      // A tab that loaded while paused stays paused until reload — which reads
      // to the user as "unpause didn't work".
      //
      // `void`, like every sibling broadcast in this file. Awaiting it would
      // put a sequential tab fan-out — and, on the failure path, a
      // tabs.query({}) — on the popup's critical path. A threshold slider fires
      // one SET_PREFS per input event, and a broadcast failure must never read
      // as a failed pref write: patchPrefs has already succeeded by here, and
      // the storage write is the authoritative result.
      //
      // COUPLING: safe only because preload.ts now clears its :has() sheet on
      // an empty list, and the content script registers its onMessage listener
      // at module scope so a paused-at-load tab can actually receive this.
      void broadcastToContentScripts({ type: "PREFS_UPDATED" });
      return { prefs: updated };
    }

    case "UNDO_LAST": {
      const entry = await popUndoEntry();
      if (!entry) return { restored: null };
      // Re-add the entry
      const entries = await getEntries();
      const result = addEntry(entries, entry.domain, entry.mode);
      await persistEntries(result.entries);
      // Broadcast: undoing a block re-adds a domain, so other tabs must
      // re-hide it. Without this they keep showing it until reload.
      // `void` for the same reason as SET_PREFS — see the note there.
      void broadcastToContentScripts({ type: "LIST_UPDATED" });
      return { restored: entry };
    }

    default:
      return { error: "Unknown message type" };
  }
}

// ============================================================
// Broadcast to all tabs that have the content script running
// ============================================================

async function broadcastToContentScripts(
  message: object,
  exceptTabId?: number
): Promise<void> {
  const outcome = await broadcastToTabs(activeTabIds, exceptTabId, {
    send: async (tabId) => {
      try {
        await browser.tabs.sendMessage(tabId, message);
        return true;
      } catch {
        return false;
      }
    },
    queryTabIds: async () => {
      try {
        const tabs = await browser.tabs.query({});
        return tabs
          .map((t) => t.id)
          .filter((id): id is number => id !== undefined);
      } catch {
        return null; // tabs API unavailable
      }
    },
  });

  // Learn from successes and failures, but never evict on a single failure —
  // see background/broadcast.ts. `noteSendResult` handles both the add and the
  // K-consecutive-failure eviction.
  for (const tabId of outcome.delivered) noteSendResult(tabId, true);
  for (const tabId of outcome.failed) noteSendResult(tabId, false);
}

// ============================================================
// Startup: warm up caches
// ============================================================

async function init(): Promise<void> {
  cachedEntries = await loadEntries();
  cachedPrefs = await loadPrefs();
}

void init();
