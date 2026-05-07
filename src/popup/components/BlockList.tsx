import { useState, useMemo, useRef } from "preact/hooks";
import type { BlockEntry, Prefs, BulkOperation } from "../../shared/types";
import { sortEntries, filterEntries } from "../../shared/list-utils";
import { normalizeDomain } from "../../shared/domain-utils";
import { ListEntry } from "./ListEntry";
import { BulkActions } from "./BulkActions";
import { ImportExport } from "./ImportExport";

interface Props {
  entries: BlockEntry[];
  prefs: Prefs;
  onRefresh: () => Promise<void>;
}

type SortKey = "date_desc" | "date_asc" | "alpha_asc" | "alpha_desc";

export function BlockList({ entries, prefs, onRefresh }: Props) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("date_desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addDomain, setAddDomain] = useState("");
  const [showImportExport, setShowImportExport] = useState(false);
  const [feedback, setFeedback] = useState("");
  const addInputRef = useRef<HTMLInputElement>(null);

  const blockEntries = entries.filter((e) => e.mode === "block");
  const filtered = useMemo(
    () => sortEntries(filterEntries(blockEntries, query), sort),
    [blockEntries, query, sort]
  );

  function flash(msg: string) {
    setFeedback(msg);
    setTimeout(() => setFeedback(""), 2500);
  }

  async function handleAdd() {
    const domain = normalizeDomain(addDomain.trim());
    if (!domain) return;
    const res = await browser.runtime.sendMessage({
      type: "ADD_ENTRY", domain, mode: "block",
    }) as { duplicate: boolean };
    if (res.duplicate) {
      flash(`"${domain}" is already in the list`);
    } else {
      flash(`Added: ${domain}`);
      setAddDomain("");
    }
    await onRefresh();
  }

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

      {/* ── Toolbar (fixed, never scrolls) ── */}
      <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        {/* Search + sort */}
        <div style={{ display: "flex", gap: "6px", marginBottom: "6px" }}>
          <input
            type="search"
            placeholder="Search domains…"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            style={{
              flex: 1, minWidth: 0,
              padding: "5px 8px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-2)",
              color: "var(--text)",
              fontSize: "12px",
            }}
          />
          <select
            value={sort}
            onChange={(e) => setSort((e.target as HTMLSelectElement).value as SortKey)}
            style={{
              padding: "4px 4px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-2)",
              color: "var(--text)",
              fontSize: "11px",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <option value="date_desc">Newest</option>
            <option value="date_asc">Oldest</option>
            <option value="alpha_asc">A → Z</option>
            <option value="alpha_desc">Z → A</option>
          </select>
        </div>

        {/* Add domain */}
        <div style={{ display: "flex", gap: "6px" }}>
          <input
            ref={addInputRef}
            type="text"
            placeholder="Add domain to block…"
            value={addDomain}
            onInput={(e) => setAddDomain((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleAdd(); }}
            style={{
              flex: 1, minWidth: 0,
              padding: "5px 8px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-2)",
              color: "var(--text)",
              fontSize: "12px",
            }}
          />
          <button
            onClick={() => void handleAdd()}
            style={{
              background: "var(--accent)",
              color: "#fff",
              border: "none",
              borderRadius: "var(--radius-sm)",
              padding: "5px 10px",
              cursor: "pointer",
              fontSize: "12px",
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            + Block
          </button>
        </div>

        {feedback && (
          <div style={{ marginTop: "4px", fontSize: "11px", color: "var(--text-2)" }}>
            {feedback}
          </div>
        )}
      </div>

      {/* ── Bulk actions bar (fixed, shows when rows selected) ── */}
      {selected.size > 0 && (
        <BulkActions
          selectedCount={selected.size}
          onSelectAll={() => setSelected(new Set(filtered.map((e) => e.domain)))}
          onClear={() => setSelected(new Set())}
          onBulk={handleBulk}
          mode="block"
        />
      )}

      {/* ── Scrollable area: list + Import/Export panel ── */}
      {/* This single scrollable div contains everything that can grow,
          so ImportExport is always reachable by scrolling — it never
          gets clipped by the parent overflow:hidden. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {filtered.length === 0 ? (
          <div style={{
            padding: "24px",
            textAlign: "center",
            color: "var(--text-3)",
            fontSize: "12px",
          }}>
            {query
              ? `No results for "${query}"`
              : "No blocked domains yet. Browse a search engine and click the block button next to a result."}
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

        {/* Import/Export lives inside the scroll area so it's always accessible */}
        {showImportExport && (
          <ImportExport entries={entries} onRefresh={onRefresh} />
        )}
      </div>

      {/* ── Footer (fixed) ── */}
      <div style={{
        borderTop: "1px solid var(--border)",
        padding: "5px 10px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexShrink: 0,
        background: "var(--bg-2)",
      }}>
        <span style={{ fontSize: "11px", color: "var(--text-3)" }}>
          {filtered.length} of {blockEntries.length}
        </span>
        <button
          onClick={() => setShowImportExport((v) => !v)}
          style={{
            background: "none",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            padding: "3px 8px",
            cursor: "pointer",
            fontSize: "11px",
            color: "var(--text-2)",
          }}
        >
          {showImportExport ? "▲ Hide" : "▼ Import / Export"}
        </button>
      </div>
    </div>
  );
}
