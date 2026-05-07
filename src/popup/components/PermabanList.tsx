import { useState, useMemo } from "preact/hooks";
import type { BlockEntry, Prefs, BulkOperation } from "../../shared/types";
import { sortEntries, filterEntries } from "../../shared/list-utils";
import { ListEntry } from "./ListEntry";
import { BulkActions } from "./BulkActions";

interface Props {
  entries: BlockEntry[];
  prefs: Prefs;
  onRefresh: () => Promise<void>;
}

type SortKey = "date_desc" | "date_asc" | "alpha_asc" | "alpha_desc";

export function PermabanList({ entries, onRefresh }: Props) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("date_desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const pbanEntries = entries.filter((e) => e.mode === "pban");
  const filtered = useMemo(
    () => sortEntries(filterEntries(pbanEntries, query), sort),
    [pbanEntries, query, sort]
  );

  async function handleRemove(domain: string) {
    await browser.runtime.sendMessage({ type: "REMOVE_ENTRY", domain });
    setSelected((s) => { const n = new Set(s); n.delete(domain); return n; });
    await onRefresh();
  }

  async function handleToggle(domain: string, enabled: boolean) {
    await browser.runtime.sendMessage({ type: "UPDATE_ENTRY", domain, patch: { enabled } });
    await onRefresh();
  }

  async function handleBulk(op: BulkOperation) {
    const domains = selected.size > 0 ? Array.from(selected) : undefined;
    await browser.runtime.sendMessage({ type: "BULK_OP", op, domains });
    setSelected(new Set());
    await onRefresh();
  }

  function toggleSelect(domain: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(domain)) n.delete(domain); else n.add(domain);
      return n;
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Info banner */}
      <div style={{
        padding: "8px 12px",
        background: "rgba(226,74,74,0.08)",
        borderBottom: "1px solid var(--border)",
        fontSize: "11px",
        color: "var(--text-2)",
        flexShrink: 0,
      }}>
        Perma-banned domains are <strong>completely invisible</strong> in search results — no placeholder shown. Managed only here.
      </div>

      {/* Search + sort */}
      <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", display: "flex", gap: "6px", flexShrink: 0 }}>
        <input
          type="search"
          placeholder="Search perma-banned domains…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          style={{
            flex: 1, padding: "5px 8px", border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)", background: "var(--bg-2)", color: "var(--text)", fontSize: "12px",
          }}
        />
        <select
          value={sort}
          onChange={(e) => setSort((e.target as HTMLSelectElement).value as SortKey)}
          style={{
            padding: "4px 6px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
            background: "var(--bg-2)", color: "var(--text)", fontSize: "11px", cursor: "pointer",
          }}
        >
          <option value="date_desc">Newest first</option>
          <option value="date_asc">Oldest first</option>
          <option value="alpha_asc">A → Z</option>
          <option value="alpha_desc">Z → A</option>
        </select>
      </div>

      {/* Bulk actions */}
      {selected.size > 0 && (
        <BulkActions
          selectedCount={selected.size}
          onSelectAll={() => setSelected(new Set(filtered.map((e) => e.domain)))}
          onClear={() => setSelected(new Set())}
          onBulk={handleBulk}
          mode="pban"
        />
      )}

      {/* List */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 0" }}>
        {filtered.length === 0 ? (
          <div style={{ padding: "24px", textAlign: "center", color: "var(--text-3)", fontSize: "12px" }}>
            {query ? `No results for "${query}"` : "No perma-banned domains. Use the Perma-ban button next to a search result."}
          </div>
        ) : (
          filtered.map((entry) => (
            <ListEntry
              key={entry.domain}
              entry={entry}
              selected={selected.has(entry.domain)}
              onSelect={() => toggleSelect(entry.domain)}
              onRemove={() => void handleRemove(entry.domain)}
              onToggle={(enabled) => void handleToggle(entry.domain, enabled)}
            />
          ))
        )}
      </div>

      {/* Footer */}
      <div style={{
        borderTop: "1px solid var(--border)", padding: "6px 10px",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        flexShrink: 0, background: "var(--bg-2)",
      }}>
        <span style={{ fontSize: "11px", color: "var(--text-3)" }}>
          {filtered.length} of {pbanEntries.length} perma-banned
        </span>
      </div>
    </div>
  );
}
