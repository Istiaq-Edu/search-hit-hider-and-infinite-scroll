import { useState, useEffect } from "preact/hooks";
import type { BlockEntry, Prefs, PrefsPatch } from "../../shared/types";
import {
  DEFAULT_PREFS,
  STORAGE_KEY_LIST,
  STORAGE_KEY_PREFS,
  STORAGE_KEY_PREFS_LOCAL,
} from "../../shared/types";
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
  const [error, setError] = useState<string | null>(null);
  // Distinguishes "loaded successfully at least once" from "initial load
  // failed". The latter must not render stats/list from the empty defaults.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void loadData();
  }, []);

  // Live-view storage. The OptionsPage / import page and Firefox Sync write
  // storage directly, and GET_LIST/GET_PREFS can be served from the
  // background's cache. Reading `newValue` here is closer to the source and
  // removes the cache-ordering race. Prefs live in sync, with a local mirror
  // written when sync is unavailable — watch both.
  useEffect(() => {
    function applyPrefs(newValue: unknown) {
      if (newValue && typeof newValue === "object") {
        setPrefs((prev) => ({ ...prev, ...(newValue as Partial<Prefs>) }));
      }
    }
    function onStorageChanged(
      changes: Record<string, browser.storage.StorageChange>,
      area: string,
    ) {
      if (area === "local") {
        if (STORAGE_KEY_LIST in changes) {
          const v = changes[STORAGE_KEY_LIST].newValue;
          setEntries(Array.isArray(v) ? (v as BlockEntry[]) : []);
        }
        const prefsChange = changes[STORAGE_KEY_PREFS_LOCAL];
        if (prefsChange) applyPrefs(prefsChange.newValue);
        return;
      }
      if (area !== "sync") return;
      const prefsChange = changes[STORAGE_KEY_PREFS];
      if (prefsChange) applyPrefs(prefsChange.newValue);
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
    setLoading(true);
    try {
      const [listRes, prefsRes] = await Promise.all([
        browser.runtime.sendMessage({ type: "GET_LIST" }),
        browser.runtime.sendMessage({ type: "GET_PREFS" }),
      ]) as [{ entries: BlockEntry[] }, { prefs: Prefs }];
      setEntries(Array.isArray(listRes.entries) ? listRes.entries : []);
      setPrefs(prefsRes.prefs);
      setError(null);
      setLoaded(true);
    } catch (err) {
      // Previously `try/finally` only: a dead background rejected the
      // promise and the popup rendered a confident, empty block list with no
      // hint that nothing had been read. Never present failure as data.
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }

  function describeError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    if (/Receiving end does not exist|Could not establish connection/i.test(raw)) {
      return "The extension background is not responding. Reload the extension or this page.";
    }
    return raw || "Unexpected extension error.";
  }

  async function updatePrefs(patch: PrefsPatch) {
    try {
      const res = await browser.runtime.sendMessage({ type: "SET_PREFS", patch }) as { prefs: Prefs };
      setPrefs(res.prefs);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function refreshEntries() {
    try {
      const res = await browser.runtime.sendMessage({ type: "GET_LIST" }) as { entries: BlockEntry[] };
      setEntries(Array.isArray(res.entries) ? res.entries : []);
    } catch (err) {
      setError(describeError(err));
    }
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

  // Initial load failed: there is no data to show. Rendering the normal shell
  // would report "0 blocked · 0 total" and an empty list — both false
  // statements about the user's actual block list.
  if (error && !loaded) {
    return (
      <div id="app" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div style={{
          background: "var(--accent)",
          color: "#fff",
          padding: "10px 14px",
          fontWeight: 700,
          fontSize: "14px",
          letterSpacing: "0.3px",
          flexShrink: 0,
        }}>
          🔍 Search-Hit-Hider
        </div>
        <div role="alert" style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: "10px",
          padding: "16px 14px",
          color: "var(--danger)",
          fontSize: "12px",
        }}>
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void loadData()}
            style={{
              background: "var(--danger)",
              color: "#fff",
              border: "none",
              borderRadius: "var(--radius-sm)",
              padding: "5px 10px",
              cursor: "pointer",
              fontSize: "12px",
              fontWeight: 600,
            }}
          >
            Retry
          </button>
        </div>
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

      {/* Load / action failure — shown instead of a silently empty list */}
      {error && (
        <div role="alert" style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "6px 10px",
          background: "rgba(217,83,79,0.12)",
          borderBottom: "1px solid rgba(217,83,79,0.4)",
          color: "var(--danger)",
          fontSize: "11px",
          flexShrink: 0,
        }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button
            type="button"
            onClick={() => void loadData()}
            style={{
              background: "var(--danger)",
              color: "#fff",
              border: "none",
              borderRadius: "var(--radius-sm)",
              padding: "3px 8px",
              cursor: "pointer",
              fontSize: "11px",
              fontWeight: 600,
            }}
          >
            Retry
          </button>
        </div>
      )}

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
