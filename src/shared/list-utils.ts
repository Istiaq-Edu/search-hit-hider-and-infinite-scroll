import type { BlockEntry, BlockMode, BulkOperation } from "./types";
import { isValidDomain, normalizeDomain, stripWww } from "./domain-utils";

// ============================================================
// List manipulation utilities
// ============================================================

/**
 * Add a new entry to the list. Returns updated list and whether it was a duplicate.
 * Rejects strings that cannot be real hostnames — junk entries would otherwise
 * be stored and later interpolated into CSS selectors by the preload.
 *
 * `options.stripWww` must come from the live preference. It was previously
 * hard-coded to true, so the "Strip www." setting did nothing and an exact
 * host block of www.example.com silently became example.com.
 */
export function addEntry(
  entries: BlockEntry[],
  domain: string,
  mode: BlockMode,
  position: "end" | "top" | "sort" = "end",
  options: {
    stripWww?: boolean | undefined;
    enabled?: boolean | undefined;
    createdAt?: number | undefined;
  } = {}
): { entries: BlockEntry[]; added: BlockEntry | null; duplicate: boolean } {
  const normalized = normalizeDomain(domain, options.stripWww ?? true);
  if (!isValidDomain(normalized)) {
    return { entries, added: null, duplicate: false };
  }

  const existing = entries.find((e) => e.domain === normalized);
  if (existing) {
    return { entries, added: null, duplicate: true };
  }

  const newEntry: BlockEntry = {
    domain: normalized,
    mode,
    enabled: options.enabled ?? true,
    createdAt: options.createdAt ?? Date.now(),
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
 * Merge a duplicate into the entry being kept.
 *
 * "Keep the first and drop the rest" lost user intent: an enabled perma-ban
 * behind a disabled block disappeared entirely, leaving the domain unblocked.
 * A duplicate is the same blocking target, so the merged entry must be at
 * least as strong as either input:
 *   • enabled if EITHER copy is enabled (disabling one copy must not discard
 *     the other's active block),
 *   • pban if either copy is a perma-ban (the stronger intent),
 *   • the earliest known creation time (stable, not "now").
 */
function mergeDuplicate(first: BlockEntry, other: BlockEntry): BlockEntry {
  const createdAt = Math.min(
    first.createdAt || Number.POSITIVE_INFINITY,
    other.createdAt || Number.POSITIVE_INFINITY
  );
  return {
    ...first,
    enabled: first.enabled || other.enabled,
    mode: first.mode === "pban" || other.mode === "pban" ? "pban" : "block",
    createdAt: Number.isFinite(createdAt) ? createdAt : first.createdAt,
  };
}

/**
 * Remove duplicate domains, keeping the first occurrence's position.
 * Comparison is case-insensitive but www-SENSITIVE: with "Strip www." off,
 * `example.com` and `www.example.com` are two distinct exact-host targets, and
 * the old www-insensitive key silently discarded one of them on import or on
 * the "dedup" bulk action. The explicit "Un-www" bulk action still collapses
 * www variants because it rewrites the domains BEFORE calling this.
 * Fields are merged rather than discarded — see mergeDuplicate().
 */
export function deduplicateEntries(entries: BlockEntry[]): BlockEntry[] {
  const byKey = new Map<string, number>();
  const out: BlockEntry[] = [];
  for (const entry of entries) {
    const key = normalizeDomain(entry.domain, false);
    const existingIdx = byKey.get(key);
    if (existingIdx === undefined) {
      byKey.set(key, out.length);
      out.push(entry);
    } else {
      const existing = out[existingIdx]!;
      out[existingIdx] = mergeDuplicate(existing, entry);
    }
  }
  return out;
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
