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
import { STORAGE_KEY_PREFS_LOCAL } from "../shared/types";
import { broadcastToTabs, shouldEvictTab } from "./broadcast";

// ============================================================
// Background service worker — storage coordination + messaging
// ============================================================

let cachedEntries: BlockEntry[] | null = null;
let cachedPrefs: Prefs | null = null;

// Cache generations, one per cache. Bumped on every invalidation
// (storage.onChanged) and every local commit. A cold read that was already in
// flight when its generation changed must NOT install its snapshot: the read
// may have started before the write that invalidated, and adopting it would
// resurrect a stale list/prefs — which a later handler would then write back
// over the newer state. The old `if (!cached…)` check only covered the commit
// half of the race, not the invalidation half. Separate counters so a list
// commit cannot force a (possibly slow, sync-backed) prefs read to restart.
let entriesGen = 0;
let prefsGen = 0;

// Serialize all message handling. Handlers are read-modify-write cycles over
// shared state (cold cache reads, unlocked patchPrefs in storage.ts); running
// them concurrently lets two callers load the same snapshot and last-write-
// wins the other's mutation (slider drags, double imports, cold-cache adds).
// A rejected task must not poison the chain, hence the double task/recovery.
let opQueue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = opQueue.then(task, task);
  opQueue = run.then(() => undefined, () => undefined);
  return run;
}

// Debounced storage writes to avoid sequential writes for rapid changes
let pendingSave: ReturnType<typeof setTimeout> | null = null;
let pendingEntries: BlockEntry[] | null = null;

async function getEntries(): Promise<BlockEntry[]> {
  for (;;) {
    if (cachedEntries) return cachedEntries;
    const gen = entriesGen;
    const loaded = await loadEntries();
    // Retry when a commit or invalidation landed mid-read: `loaded` may
    // predate it. A commit also sets cachedEntries, so the next iteration
    // returns immediately.
    if (gen === entriesGen) {
      cachedEntries = loaded;
      return loaded;
    }
  }
}

async function getPrefs(): Promise<Prefs> {
  for (;;) {
    if (cachedPrefs) return cachedPrefs;
    const gen = prefsGen;
    const loaded = await loadPrefs();
    if (gen === prefsGen) {
      cachedPrefs = loaded;
      return loaded;
    }
  }
}

async function persistEntries(entries: BlockEntry[]): Promise<void> {
  cachedEntries = entries;
  entriesGen++;
  scheduleSave(entries);
}

function commitPrefs(prefs: Prefs): void {
  cachedPrefs = prefs;
  prefsGen++;
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
    if (pendingSave) {
      clearTimeout(pendingSave);
      pendingSave = null;
    }
    if (pendingEntries) {
      const entries = pendingEntries;
      pendingEntries = null;
      saveEntries(entries);
    }
  });
}

// Invalidate cache when storage changes externally (e.g. other device via sync)
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "shh_entries" in changes) {
    cachedEntries = null;
    entriesGen++;
  }
  if (area === "sync" && "shh_prefs" in changes) {
    cachedPrefs = null;
    prefsGen++;
  }
  // Local mirror written when storage.sync is unavailable. Watching only the
  // sync key left a SET_PREFS fallback write invisible to a warm cache.
  if (area === "local" && STORAGE_KEY_PREFS_LOCAL in changes) {
    cachedPrefs = null;
    prefsGen++;
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
    // Serialized: handleMessage bodies are read-modify-write cycles over the
    // cache and storage (see enqueue's comment). Returning the queued promise
    // keeps the sender's response tied to its own operation completing.
    return enqueue(() => handleMessage(msg, sender.tab?.id));
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
      commitPrefs(updated);
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
  // Warm-up reads run outside the message queue, so a mutation or an
  // onChanged invalidation can land during the await. getEntries/getPrefs
  // use the cache generation: an in-flight read is discarded and retried
  // when that happens, instead of installing (or skipping) a stale snapshot
  // on a bare `if (!cached…)` check.
  await Promise.all([getEntries(), getPrefs()]);
}

void init();
