// ============================================================
// Core data types for Search-Hit-Hider Firefox Extension
// ============================================================

export type BlockMode = "block" | "pban";

export type EngineId =
  | "google"
  | "duckduckgo"
  | "bing"
  | "yandex"
  | "baidu"
  | "brave";

export type ButtonStyle = "text" | "icon" | "icon+text";

export interface BlockEntry {
  domain: string;
  mode: BlockMode;
  enabled: boolean;
  createdAt: number;
}

export interface Prefs {
  engineToggles: Record<EngineId, boolean>;
  showNotices: boolean;
  oneClick: boolean;
  oneClickTarget: BlockMode;
  domainChoiceMode: "exact" | "root" | "ask";
  stripWww: boolean;
  addPosition: "end" | "top" | "sort";
  buttonStyle: ButtonStyle;
  showOnHover: boolean;
  aggressiveBlock: "none" | "all" | "www";
  mutationObserver: boolean;
  debugMode: boolean;
  pausedGlobally: boolean;
  pausedEngines: EngineId[];
  subdomainWildcard: boolean;
  theme: "system" | "light" | "dark";

  // ── Infinite scroll ──
  infiniteScroll: boolean;
  infiniteScrollThreshold: number;
  infiniteScrollMaxPages: number;
  infiniteScrollPersist: boolean;
}

export const ALL_ENGINE_IDS: EngineId[] = [
  "google",
  "duckduckgo",
  "bing",
  "yandex",
  "baidu",
  "brave",
];

export const DEFAULT_PREFS: Prefs = {
  engineToggles: Object.fromEntries(
    ALL_ENGINE_IDS.map((id) => [id, true])
  ) as Record<EngineId, boolean>,
  showNotices: true,
  oneClick: false,
  oneClickTarget: "block",
  domainChoiceMode: "ask",
  stripWww: true,
  addPosition: "end",
  buttonStyle: "text",
  showOnHover: false,
  aggressiveBlock: "none",
  mutationObserver: true,
  debugMode: false,
  pausedGlobally: false,
  pausedEngines: [],
  subdomainWildcard: true,
  theme: "system",
  infiniteScroll: true,
  infiniteScrollThreshold: 800,
  infiniteScrollMaxPages: 20,
  infiniteScrollPersist: true,
};

// ============================================================
// Messaging types (content <-> background)
// ============================================================

export type MessageType =
  | "GET_LIST"
  | "ADD_ENTRY"
  | "REMOVE_ENTRY"
  | "UPDATE_ENTRY"
  | "BULK_OP"
  | "BULK_IMPORT"
  | "GET_PREFS"
  | "SET_PREFS"
  | "GET_PAGE_STATS"
  | "UNDO_LAST";

export interface GetListMsg {
  type: "GET_LIST";
}
export interface GetListResponse {
  entries: BlockEntry[];
}

export interface AddEntryMsg {
  type: "ADD_ENTRY";
  domain: string;
  mode: BlockMode;
}
export interface AddEntryResponse {
  entry: BlockEntry | null;
  duplicate: boolean;
}

export interface RemoveEntryMsg {
  type: "REMOVE_ENTRY";
  domain: string;
}

export interface UpdateEntryMsg {
  type: "UPDATE_ENTRY";
  domain: string;
  patch: Partial<Pick<BlockEntry, "mode" | "enabled">>;
}

export type BulkOperation =
  | "delete"
  | "disable"
  | "enable"
  | "to_pban"
  | "to_block"
  | "normalize_www"
  | "dedup"
  | "sort_date";

export interface BulkOpMsg {
  type: "BULK_OP";
  op: BulkOperation;
  domains?: string[];
}

export interface BulkImportMsg {
  type: "BULK_IMPORT";
  entries: Array<{ domain: string; mode: BlockMode }>;
}
export interface BulkImportResponse {
  added: number;
  duplicates: number;
  invalid: number;
}

export interface GetPrefsMsg {
  type: "GET_PREFS";
}
export interface GetPrefsResponse {
  prefs: Prefs;
}

export interface SetPrefsMsg {
  type: "SET_PREFS";
  patch: Partial<Prefs>;
}

export interface UndoLastMsg {
  type: "UNDO_LAST";
}

export type ExtMessage =
  | GetListMsg
  | AddEntryMsg
  | RemoveEntryMsg
  | UpdateEntryMsg
  | BulkOpMsg
  | BulkImportMsg
  | GetPrefsMsg
  | SetPrefsMsg
  | UndoLastMsg;

// ============================================================
// Storage keys
// ============================================================
export const STORAGE_KEY_LIST = "shh_entries";
export const STORAGE_KEY_PREFS = "shh_prefs";
export const STORAGE_KEY_UNDO = "shh_undo";
