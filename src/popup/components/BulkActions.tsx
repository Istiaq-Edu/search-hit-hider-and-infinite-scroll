import type { BulkOperation } from "../../shared/types";

interface Props {
  selectedCount: number;
  onSelectAll: () => void;
  onClear: () => void;
  onBulk: (op: BulkOperation) => Promise<void>;
  mode: "block" | "pban";
}

export function BulkActions({ selectedCount, onSelectAll, onClear, onBulk, mode }: Props) {
  async function confirm(op: BulkOperation, label: string) {
    if (op === "delete") {
      if (!window.confirm(`Delete ${selectedCount} entries? This cannot be undone.`)) return;
    }
    await onBulk(op);
  }

  const btnStyle = (color: string, bg: string) => ({
    background: bg,
    color: color,
    border: "1px solid rgba(0,0,0,0.12)",
    borderRadius: "var(--radius-sm)",
    padding: "3px 7px",
    cursor: "pointer",
    fontSize: "11px",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  });

  return (
    <div style={{
      padding: "6px 10px",
      background: "rgba(74,144,226,0.07)",
      borderBottom: "1px solid var(--border)",
      display: "flex",
      flexWrap: "wrap",
      gap: "4px",
      alignItems: "center",
    }}>
      <span style={{ fontSize: "11px", color: "var(--text-2)", marginRight: "2px" }}>
        {selectedCount} selected:
      </span>
      <button onClick={onSelectAll} style={btnStyle("var(--text-2)", "var(--bg-3)")}>All</button>
      <button onClick={onClear} style={btnStyle("var(--text-2)", "var(--bg-3)")}>None</button>
      <button onClick={() => void confirm("delete", "Delete")} style={btnStyle("#fff", "var(--danger)")}>Delete</button>
      <button onClick={() => void onBulk("disable")} style={btnStyle("var(--text)", "var(--bg-3)")}>Disable</button>
      <button onClick={() => void onBulk("enable")} style={btnStyle("#fff", "var(--success)")}>Enable</button>
      {mode === "block" && (
        <button onClick={() => void onBulk("to_pban")} style={btnStyle("#fff", "#e24a4a")}>→ Perma-ban</button>
      )}
      {mode === "pban" && (
        <button onClick={() => void onBulk("to_block")} style={btnStyle("#fff", "var(--accent)")}>→ Regular</button>
      )}
      <button onClick={() => void onBulk("normalize_www")} style={btnStyle("var(--text)", "var(--bg-3)")}>Un-www</button>
      <button onClick={() => void onBulk("dedup")} style={btnStyle("var(--text)", "var(--bg-3)")}>Dedup</button>
    </div>
  );
}
