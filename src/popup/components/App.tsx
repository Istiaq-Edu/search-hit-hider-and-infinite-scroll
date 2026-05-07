import { useState, useEffect } from "preact/hooks";
import type { BlockEntry, Prefs } from "../../shared/types";
import { DEFAULT_PREFS } from "../../shared/types";
import { QuickControls } from "./QuickControls";
import { BlockList } from "./BlockList";
import { PermabanList } from "./PermabanList";
import { SettingsTab } from "./SettingsTab";
import { About } from "./About";

type Tab = "blocked" | "pban" | "settings" | "about";

const TAB_LABELS: { id: Tab; label: string }[] = [
  { id: "blocked", label: "Blocked" },
  { id: "pban", label: "Perma-ban" },
  { id: "settings", label: "Settings" },
  { id: "about", label: "About" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("blocked");
  const [entries, setEntries] = useState<BlockEntry[]>([]);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void loadData();
  }, []);

  // Auto-refresh entries when the import/export page writes to storage
  useEffect(() => {
    function onStorageChanged(
      changes: Record<string, browser.storage.StorageChange>,
      area: string,
    ) {
      if (area === "local" && "shh_entries" in changes) {
        void refreshEntries();
      }
    }
    browser.storage.onChanged.addListener(onStorageChanged);
    return () => browser.storage.onChanged.removeListener(onStorageChanged);
  }, []);

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute(
      "data-theme",
      prefs.theme === "system" ? "" : prefs.theme
    );
  }, [prefs.theme]);

  async function loadData() {
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

  async function updatePrefs(patch: Partial<Prefs>) {
    const res = await browser.runtime.sendMessage({ type: "SET_PREFS", patch }) as { prefs: Prefs };
    setPrefs(res.prefs);
  }

  async function refreshEntries() {
    const res = await browser.runtime.sendMessage({ type: "GET_LIST" }) as { entries: BlockEntry[] };
    setEntries(res.entries);
  }

  if (loading) {
    return (
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        color: "var(--text-3)",
      }}>
        Loading…
      </div>
    );
  }

  const blockedEntries = entries.filter((e) => e.mode === "block");
  const pbanEntries    = entries.filter((e) => e.mode === "pban");

  return (
    <div id="app" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{
        background: "var(--accent)",
        color: "#fff",
        padding: "10px 14px 0",
        flexShrink: 0,
      }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "6px",
        }}>
          <span style={{ fontWeight: 700, fontSize: "14px", letterSpacing: "0.3px" }}>
            🔍 Search-Hit-Hider
          </span>
          <QuickControls prefs={prefs} onUpdatePrefs={updatePrefs} />
        </div>

        {/* Stats */}
        <div style={{ fontSize: "11px", opacity: 0.85, marginBottom: "6px" }}>
          {blockedEntries.length} blocked · {pbanEntries.length} perma-banned · {entries.length} total
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: "2px" }}>
          {TAB_LABELS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{
                background: tab === id ? "var(--bg)" : "transparent",
                color: tab === id ? "var(--accent)" : "rgba(255,255,255,0.85)",
                border: "none",
                borderRadius: "var(--radius-sm) var(--radius-sm) 0 0",
                padding: "5px 10px",
                cursor: "pointer",
                fontWeight: tab === id ? 600 : 400,
                fontSize: "12px",
                transition: "background 0.12s",
                whiteSpace: "nowrap",
              }}
            >
              {label}
              {id === "blocked" && blockedEntries.length > 0 && (
                <span style={{
                  background: "rgba(255,255,255,0.25)",
                  borderRadius: "10px",
                  padding: "1px 5px",
                  marginLeft: "4px",
                  fontSize: "10px",
                }}>
                  {blockedEntries.length}
                </span>
              )}
              {id === "pban" && pbanEntries.length > 0 && (
                <span style={{
                  background: "rgba(255,255,255,0.25)",
                  borderRadius: "10px",
                  padding: "1px 5px",
                  marginLeft: "4px",
                  fontSize: "10px",
                }}>
                  {pbanEntries.length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab body — flex: 1 fills all remaining space; overflow: hidden so
          each tab manages its own internal scrolling */}
      <div style={{
        flex: 1,
        minHeight: 0,          /* critical: allows flex child to shrink below content size */
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
      }}>
        {tab === "blocked"  && <BlockList   entries={entries} prefs={prefs} onRefresh={refreshEntries} />}
        {tab === "pban"     && <PermabanList entries={entries} prefs={prefs} onRefresh={refreshEntries} />}
        {tab === "settings" && <SettingsTab  prefs={prefs}    onUpdatePrefs={updatePrefs} />}
        {tab === "about"    && <About />}
      </div>
    </div>
  );
}
