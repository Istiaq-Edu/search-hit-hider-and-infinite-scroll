import { useState, useEffect, useRef } from "preact/hooks";
import type { BlockEntry, Prefs, BulkImportResponse } from "../shared/types";
import { DEFAULT_PREFS } from "../shared/types";
import {
  exportToJSON,
  exportToPlainList,
  exportToUserscriptFormat,
  autoDetectAndParse,
} from "../shared/migration";

type ExportScope  = "all" | "block" | "pban";
type ExportFormat = "json" | "plain" | "userscript";

interface Feedback { msg: string; ok: boolean }

export function OptionsPage() {
  const [entries, setEntries]         = useState<BlockEntry[]>([]);
  const [prefs, setPrefs]             = useState<Prefs>(DEFAULT_PREFS);
  const [loading, setLoading]         = useState(true);
  const [feedback, setFeedback]       = useState<Feedback | null>(null);
  const [exportScope, setExportScope] = useState<ExportScope>("all");
  const [exportFmt, setExportFmt]     = useState<ExportFormat>("json");
  const [importing, setImporting]     = useState(false);
  const [dragOver, setDragOver]       = useState(false);
  const fileRef                       = useRef<HTMLInputElement>(null);

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    document.documentElement.setAttribute(
      "data-theme",
      prefs.theme === "system" ? "" : prefs.theme,
    );
  }, [prefs.theme]);

  async function load() {
    try {
      const [listRes, prefsRes] = await Promise.all([
        browser.runtime.sendMessage({ type: "GET_LIST" }),
        browser.runtime.sendMessage({ type: "GET_PREFS" }),
      ]) as [{ entries: BlockEntry[] }, { prefs: Prefs }];
      setEntries(listRes.entries);
      setPrefs(prefsRes.prefs);
    } finally {
      setLoading(false);
    }
  }

  function flash(msg: string, ok = true) {
    setFeedback({ msg, ok });
    setTimeout(() => setFeedback(null), 6000);
  }

  // ── Export ──────────────────────────────────────────────────────────────

  function exportEntries(): BlockEntry[] {
    if (exportScope === "block") return entries.filter((e) => e.mode === "block");
    if (exportScope === "pban")  return entries.filter((e) => e.mode === "pban");
    return entries;
  }

  function handleExport() {
    const scoped = exportEntries();
    let content  = "";
    let filename = "search-hit-hider";
    let mime     = "text/plain";

    if (exportFmt === "json") {
      content   = exportToJSON(scoped);
      filename += ".json";
      mime      = "application/json";
    } else if (exportFmt === "plain") {
      content   = exportToPlainList(scoped, true);
      filename += ".txt";
    } else {
      content   = exportToUserscriptFormat(scoped);
      filename += "-userscript.txt";
    }

    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flash(`Exported ${scoped.length} entr${scoped.length === 1 ? "y" : "ies"} as ${filename}`);
  }

  // ── Import ──────────────────────────────────────────────────────────────

  async function processText(text: string) {
    const imported = autoDetectAndParse(text);
    if (imported.length === 0) {
      flash("No valid entries found — make sure the file is a JSON backup, plain domain list, or userscript format.", false);
      return;
    }

    const res = await browser.runtime.sendMessage({
      type: "BULK_IMPORT",
      entries: imported.map((e) => ({ domain: e.domain, mode: e.mode })),
    }) as BulkImportResponse | null | undefined;

    if (!res || typeof res.added !== "number") {
      flash("Import failed — no response from the extension background. Try reloading the page.", false);
      return;
    }

    // Refresh local count so the stats update immediately
    const listRes = await browser.runtime.sendMessage({ type: "GET_LIST" }) as { entries: BlockEntry[] };
    setEntries(listRes.entries);

    const parts: string[] = [`Imported ${res.added} new entr${res.added === 1 ? "y" : "ies"}`];
    if (res.duplicates > 0) parts.push(`${res.duplicates} duplicate${res.duplicates === 1 ? "" : "s"} skipped`);
    if (res.invalid > 0)    parts.push(`${res.invalid} invalid`);
    flash(parts.join(" · "));
  }

  async function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file  = input.files?.[0];
    if (!file) return;
    input.value = "";

    setImporting(true);
    try {
      await processText(await file.text());
    } catch (err) {
      flash(`Failed to read file: ${err instanceof Error ? err.message : "Unknown error"}`, false);
    } finally {
      setImporting(false);
    }
  }

  // Drag-and-drop support
  function onDragOver(e: DragEvent) { e.preventDefault(); setDragOver(true); }
  function onDragLeave()            { setDragOver(false); }
  async function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    setImporting(true);
    try {
      await processText(await file.text());
    } catch (err) {
      flash(`Failed to read file: ${err instanceof Error ? err.message : "Unknown error"}`, false);
    } finally {
      setImporting(false);
    }
  }

  // ── Styles helpers ───────────────────────────────────────────────────────

  const card: preact.JSX.CSSProperties = {
    background: "var(--bg-2)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: "20px 24px",
    marginBottom: "16px",
  };

  const label: preact.JSX.CSSProperties = {
    display: "block",
    fontSize: "11px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.6px",
    color: "var(--text-3)",
    marginBottom: "10px",
  };

  const selectSt: preact.JSX.CSSProperties = {
    padding: "7px 10px",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    background: "var(--bg)",
    color: "var(--text)",
    fontSize: "13px",
    cursor: "pointer",
  };

  const btn = (bg: string, fg: string, extra: preact.JSX.CSSProperties = {}): preact.JSX.CSSProperties => ({
    background: bg,
    color: fg,
    border: "none",
    borderRadius: "var(--radius-sm)",
    padding: "8px 16px",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 600,
    ...extra,
  });

  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--text-3)" }}>
        Loading…
      </div>
    );
  }

  const blocked = entries.filter((e) => e.mode === "block").length;
  const pbanned = entries.filter((e) => e.mode === "pban").length;

  return (
    <div>
      {/* ── Header ── */}
      <div style={{
        background: "var(--accent)",
        color: "#fff",
        padding: "20px 24px",
        marginBottom: "24px",
      }}>
        <div style={{ maxWidth: "620px", margin: "0 auto", display: "flex", alignItems: "center", gap: "14px" }}>
          <img
            src="../assets/icons/icon-48.png"
            width={40} height={40}
            alt=""
            style={{ borderRadius: "8px", flexShrink: 0 }}
          />
          <div>
            <div style={{ fontWeight: 700, fontSize: "18px" }}>Search-Hit-Hider</div>
            <div style={{ fontSize: "13px", opacity: 0.85, marginTop: "2px" }}>
              {blocked} blocked · {pbanned} perma-banned · {entries.length} total
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: "0 24px" }}>

        {/* ── Feedback banner ── */}
        {feedback && (
          <div style={{
            padding: "12px 16px",
            borderRadius: "var(--radius)",
            marginBottom: "16px",
            background: feedback.ok ? "rgba(92,184,92,0.12)" : "rgba(217,83,79,0.12)",
            border: `1px solid ${feedback.ok ? "rgba(92,184,92,0.4)" : "rgba(217,83,79,0.4)"}`,
            color: feedback.ok ? "var(--success)" : "var(--danger)",
            fontSize: "13px",
            fontWeight: 500,
          }}>
            {feedback.ok ? "✓ " : "✗ "}{feedback.msg}
          </div>
        )}

        {/* ── IMPORT card ── */}
        <div style={card}>
          <div style={label}>Import</div>

          {/* Drop zone */}
          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => !importing && fileRef.current?.click()}
            style={{
              border: `2px dashed ${dragOver ? "var(--accent)" : "var(--border)"}`,
              borderRadius: "var(--radius)",
              padding: "32px 20px",
              textAlign: "center",
              cursor: importing ? "default" : "pointer",
              background: dragOver ? "rgba(74,144,226,0.06)" : "var(--bg)",
              transition: "border-color 0.15s, background 0.15s",
              marginBottom: "12px",
            }}
          >
            <div style={{ fontSize: "32px", marginBottom: "8px", lineHeight: 1 }}>
              {importing ? "⏳" : "📂"}
            </div>
            <div style={{ fontWeight: 600, fontSize: "14px", color: "var(--text)", marginBottom: "4px" }}>
              {importing ? "Importing…" : "Click to choose a file, or drag and drop"}
            </div>
            <div style={{ fontSize: "12px", color: "var(--text-3)" }}>
              Accepts JSON backup (.json), plain domain list (.txt), or userscript format (.txt)
            </div>
          </div>

          {/* Hidden real file input — works here because this is a full page, not a popup */}
          <input
            ref={fileRef}
            type="file"
            accept=".json,.txt"
            onChange={handleFileChange}
            style={{ display: "none" }}
          />

          <div style={{ fontSize: "12px", color: "var(--text-3)", textAlign: "center" }}>
            Duplicates are automatically skipped. Existing entries are never overwritten.
          </div>
        </div>

        {/* ── EXPORT card ── */}
        <div style={card}>
          <div style={label}>Export</div>

          <div style={{ display: "flex", gap: "10px", alignItems: "flex-end", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: "12px", color: "var(--text-2)", marginBottom: "4px" }}>Entries</div>
              <select value={exportScope} onChange={(e) => setExportScope((e.target as HTMLSelectElement).value as ExportScope)} style={selectSt}>
                <option value="all">All ({entries.length})</option>
                <option value="block">Blocked only ({blocked})</option>
                <option value="pban">Perma-banned only ({pbanned})</option>
              </select>
            </div>
            <div>
              <div style={{ fontSize: "12px", color: "var(--text-2)", marginBottom: "4px" }}>Format</div>
              <select value={exportFmt} onChange={(e) => setExportFmt((e.target as HTMLSelectElement).value as ExportFormat)} style={selectSt}>
                <option value="json">JSON (full backup)</option>
                <option value="plain">Plain domain list (.txt)</option>
                <option value="userscript">Userscript format (.txt)</option>
              </select>
            </div>
            <button onClick={handleExport} style={btn("var(--accent)", "#fff")}>
              ↓ Download
            </button>
          </div>

          <div style={{ marginTop: "10px", fontSize: "12px", color: "var(--text-3)" }}>
            JSON format preserves all metadata (mode, enabled state, date added) and can be fully re-imported.
          </div>
        </div>

        {/* ── Format guide ── */}
        <div style={{ ...card, background: "transparent", border: "1px solid var(--border)" }}>
          <div style={label}>Accepted formats</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {[
              { name: "JSON backup", desc: "Exported from this extension. Preserves block mode, enabled state, and timestamps." },
              { name: "Plain domain list", desc: "One domain per line. Lines starting with # are comments. Append # perma-ban to mark a line as perma-banned." },
              { name: "Userscript format", desc: "Pipe-delimited format compatible with Google Hit Hider by Domain." },
            ].map(({ name, desc }) => (
              <div key={name} style={{ display: "flex", gap: "10px" }}>
                <div style={{
                  flexShrink: 0,
                  fontSize: "11px",
                  fontWeight: 700,
                  color: "var(--accent)",
                  background: "rgba(74,144,226,0.1)",
                  borderRadius: "var(--radius-sm)",
                  padding: "2px 7px",
                  height: "fit-content",
                  whiteSpace: "nowrap",
                }}>
                  {name}
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-2)" }}>{desc}</div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
