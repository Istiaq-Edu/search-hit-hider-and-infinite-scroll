import type { BlockEntry, BlockMode, BulkOperation } from "./types";
import { normalizeDomain, stripWww } from "./domain-utils";

// ============================================================
// List manipulation utilities
// ============================================================

/**
 * Add a new entry to the list. Returns updated list and whether it was a duplicate.
 */
export function addEntry(
  entries: BlockEntry[],
  domain: string,
  mode: BlockMode,
  position: "end" | "top" | "sort" = "end"
): { entries: BlockEntry[]; added: BlockEntry | null; duplicate: boolean } {
  const normalized = normalizeDomain(domain);
  if (!normalized || normalized.length < 2) {
    return { entries, added: null, duplicate: false };
  }

  const existing = entries.find((e) => e.domain === normalized);
  if (existing) {
    return { entries, added: null, duplicate: true };
  }

  const newEntry: BlockEntry = {
    domain: normalized,
    mode,
    enabled: true,
    createdAt: Date.now(),
  };

  let updated: BlockEntry[];
  if (position === "top") {
    updated = [newEntry, ...entries];
  } else if (position === "sort") {
    updated = [...entries, newEntry].sort((a, b) =>
      a.domain.localeCompare(b.domain)
    );
  } else {
    updated = [...entries, newEntry];
  }

  return { entries: updated, added: newEntry, duplicate: false };
}

/**
 * Remove an entry by domain. Returns updated list and the removed entry (for undo).
 */
export function removeEntry(
  entries: BlockEntry[],
  domain: string
): { entries: BlockEntry[]; removed: BlockEntry | null } {
  const idx = entries.findIndex((e) => e.domain === domain);
  if (idx === -1) return { entries, removed: null };
  const removed = entries[idx] ?? null;
  const updated = [...entries.slice(0, idx), ...entries.slice(idx + 1)];
  return { entries: updated, removed };
}

/**
 * Update an entry's mode or enabled state.
 */
export function updateEntry(
  entries: BlockEntry[],
  domain: string,
  patch: Partial<Pick<BlockEntry, "mode" | "enabled">>
): BlockEntry[] {
  return entries.map((e) =>
    e.domain === domain ? { ...e, ...patch } : e
  );
}

/**
 * Apply a bulk operation to a set of domains (or all entries).
 */
export function applyBulkOp(
  entries: BlockEntry[],
  op: BulkOperation,
  domains?: string[]
): BlockEntry[] {
  const targets = new Set(domains ?? entries.map((e) => e.domain));

  switch (op) {
    case "delete":
      return entries.filter((e) => !targets.has(e.domain));

    case "disable":
      return entries.map((e) =>
        targets.has(e.domain) ? { ...e, enabled: false } : e
      );

    case "enable":
      return entries.map((e) =>
        targets.has(e.domain) ? { ...e, enabled: true } : e
      );

    case "to_pban":
      return entries.map((e) =>
        targets.has(e.domain) ? { ...e, mode: "pban" } : e
      );

    case "to_block":
      return entries.map((e) =>
        targets.has(e.domain) ? { ...e, mode: "block" } : e
      );

    case "normalize_www":
      return deduplicateEntries(
        entries.map((e) =>
          targets.has(e.domain)
            ? { ...e, domain: stripWww(e.domain) }
            : e
        )
      );

    case "dedup":
      return deduplicateEntries(entries);

    case "sort_date":
      return [...entries].sort((a, b) => b.createdAt - a.createdAt);

    default:
      return entries;
  }
}

/**
 * Remove duplicate domains, keeping the first occurrence.
 */
export function deduplicateEntries(entries: BlockEntry[]): BlockEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (seen.has(e.domain)) return false;
    seen.add(e.domain);
    return true;
  });
}

/**
 * Sort entries by various criteria.
 */
export function sortEntries(
  entries: BlockEntry[],
  by: "date_desc" | "date_asc" | "alpha_asc" | "alpha_desc"
): BlockEntry[] {
  return [...entries].sort((a, b) => {
    switch (by) {
      case "date_desc": return b.createdAt - a.createdAt;
      case "date_asc": return a.createdAt - b.createdAt;
      case "alpha_asc": return a.domain.localeCompare(b.domain);
      case "alpha_desc": return b.domain.localeCompare(a.domain);
    }
  });
}

/**
 * Filter entries by search query (case-insensitive substring match).
 */
export function filterEntries(entries: BlockEntry[], query: string): BlockEntry[] {
  if (!query.trim()) return entries;
  const q = query.trim().toLowerCase();
  return entries.filter((e) => e.domain.toLowerCase().includes(q));
}
