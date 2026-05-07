import { useState } from "preact/hooks";
import type { BlockEntry } from "../../shared/types";
import {
  exportToJSON,
  exportToPlainList,
  exportToUserscriptFormat,
} from "../../shared/migration";

interface Props {
  entries: BlockEntry[];
  onRefresh: () => Promise<void>;
}

type ExportScope  = "all" | "block" | "pban";
type ExportFormat = "json" | "plain" | "userscript";

export function ImportExport({ entries }: Props) {
  const [feedback, setFeedback]         = useState("");
  const [exportScope, setExportScope]   = useState<ExportScope>("all");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("json");

  function flash(msg: string) {
    setFeedback(msg);
    setTimeout(() => setFeedback(""), 4000);
  }

  function getExportEntries(): BlockEntry[] {
    if (exportScope === "block") return entries.filter((e) => e.mode === "block");
    if (exportScope === "pban")  return entries.filter((e) => e.mode === "pban");
    return entries;
  }

  function handleExport() {
    const scoped = getExportEntries();
    let content  = "";
    let filename = "search-hit-hider";
    let mime     = "text/plain";

    if (exportFormat === "json") {
      content   = exportToJSON(scoped);
      filename += ".json";
      mime      = "application/json";
    } else if (exportFormat === "plain") {
      content   = exportToPlainList(scoped, true);
      filename += ".txt";
    } else {
      content   = exportToUserscriptFormat(scoped);
      filename += "-userscript.txt";
    }

    downloadFile(content, filename, mime);
    flash(`Exported ${scoped.length} entr${scoped.length === 1 ? "y" : "ies"}`);
  }

  function openImportPage() {
    void browser.tabs.create({
      url: browser.runtime.getURL("popup/options.html"),
    });
  }

  const selectStyle: preact.JSX.CSSProperties = {
    padding: "4px 6px",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    background: "var(--bg-2)",
    color: "var(--text)",
    fontSize: "11px",
    cursor: "pointer",
  };

  const btnStyle = (bg: string, color: string, extra: preact.JSX.CSSProperties = {}): preact.JSX.CSSProperties => ({
    background: bg,
    color,
    border: "none",
    borderRadius: "var(--radius-sm)",
    padding: "5px 10px",
    cursor: "pointer",
    fontSize: "11px",
    fontWeight: 600,
    ...extra,
  });

  return (
    <div style={{
      borderTop: "1px solid var(--border)",
      padding: "10px 12px",
      background: "var(--bg-2)",
      flexShrink: 0,
    }}>

      {/* ── EXPORT ── */}
      <div style={{ fontWeight: 600, fontSize: "11px", color: "var(--text-2)", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
        Export
      </div>
      <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginBottom: "4px" }}>
        <select value={exportScope}  onChange={(e) => setExportScope((e.target as HTMLSelectElement).value as ExportScope)}   style={selectStyle}>
          <option value="all">All entries</option>
          <option value="block">Blocked only</option>
          <option value="pban">Perma-banned only</option>
        </select>
        <select value={exportFormat} onChange={(e) => setExportFormat((e.target as HTMLSelectElement).value as ExportFormat)} style={selectStyle}>
          <option value="json">JSON (full backup)</option>
          <option value="plain">Plain domain list</option>
          <option value="userscript">Userscript format</option>
        </select>
        <button onClick={handleExport} style={btnStyle("var(--accent)", "#fff")}>
          ↓ Export
        </button>
      </div>

      {/* ── IMPORT ── */}
      <div style={{ fontWeight: 600, fontSize: "11px", color: "var(--text-2)", margin: "10px 0 6px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
        Import
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <button
          onClick={openImportPage}
          style={btnStyle("var(--bg-3)", "var(--text)", { border: "1px solid var(--border)" })}
        >
          📂 Open import page
        </button>
        <span style={{ fontSize: "10px", color: "var(--text-3)", lineHeight: 1.3 }}>
          Opens a full page where<br />file import works reliably
        </span>
      </div>

      {/* ── FEEDBACK ── */}
      {feedback && (
        <div style={{ marginTop: "6px", fontSize: "11px", color: "var(--text-2)", padding: "4px 6px", background: "var(--bg-3)", borderRadius: "var(--radius-sm)" }}>
          {feedback}
        </div>
      )}
    </div>
  );
}

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
