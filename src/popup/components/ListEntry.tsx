import type { BlockEntry } from "../../shared/types";

interface Props {
  entry: BlockEntry;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onToggle: (enabled: boolean) => void;
}

export function ListEntry({ entry, selected, onSelect, onRemove, onToggle }: Props) {
  const date = new Date(entry.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "2-digit",
  });

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "5px 10px",
        gap: "6px",
        borderBottom: "1px solid var(--border)",
        background: selected ? "rgba(74,144,226,0.08)" : entry.enabled ? "transparent" : "var(--bg-2)",
        opacity: entry.enabled ? 1 : 0.55,
        transition: "background 0.1s",
      }}
    >
      {/* Checkbox */}
      <input
        type="checkbox"
        checked={selected}
        onChange={onSelect}
        style={{ width: "13px", height: "13px", cursor: "pointer", accentColor: "var(--accent)", flexShrink: 0 }}
      />

      {/* Domain */}
      <span
        title={entry.domain}
        style={{
          flex: 1,
          fontSize: "12px",
          fontFamily: "monospace",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: entry.enabled ? "var(--text)" : "var(--text-3)",
          textDecoration: entry.enabled ? "none" : "line-through",
        }}
      >
        {entry.domain}
      </span>

      {/* Date */}
      <span style={{ fontSize: "10px", color: "var(--text-3)", flexShrink: 0 }}>
        {date}
      </span>

      {/* Enable/disable toggle */}
      <button
        onClick={() => onToggle(!entry.enabled)}
        title={entry.enabled ? "Disable (keep but don't block)" : "Enable"}
        style={{
          background: entry.enabled ? "var(--success)" : "var(--bg-3)",
          color: entry.enabled ? "#fff" : "var(--text-3)",
          border: "none",
          borderRadius: "3px",
          padding: "2px 5px",
          cursor: "pointer",
          fontSize: "10px",
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {entry.enabled ? "ON" : "OFF"}
      </button>

      {/* Delete */}
      <button
        onClick={onRemove}
        title="Remove from block list"
        style={{
          background: "none",
          border: "none",
          color: "var(--text-3)",
          cursor: "pointer",
          fontSize: "14px",
          padding: "0 2px",
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        ✕
      </button>
    </div>
  );
}
