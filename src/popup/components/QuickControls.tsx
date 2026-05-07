import type { Prefs, EngineId } from "../../shared/types";

interface Props {
  prefs: Prefs;
  onUpdatePrefs: (patch: Partial<Prefs>) => Promise<void>;
}

export function QuickControls({ prefs, onUpdatePrefs }: Props) {
  const isPaused = prefs.pausedGlobally;

  async function toggleGlobal() {
    await onUpdatePrefs({ pausedGlobally: !prefs.pausedGlobally });
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
      {isPaused && (
        <span style={{
          background: "rgba(255,200,0,0.25)",
          color: "#ffe080",
          fontSize: "10px",
          padding: "2px 6px",
          borderRadius: "10px",
          fontWeight: 600,
        }}>
          PAUSED
        </span>
      )}
      <button
        onClick={() => void toggleGlobal()}
        title={isPaused ? "Resume blocking" : "Pause blocking globally"}
        style={{
          background: isPaused ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.15)",
          color: "#fff",
          border: "1px solid rgba(255,255,255,0.3)",
          borderRadius: "var(--radius-sm)",
          padding: "3px 8px",
          cursor: "pointer",
          fontSize: "11px",
          fontWeight: 600,
        }}
      >
        {isPaused ? "▶ Resume" : "⏸ Pause"}
      </button>
    </div>
  );
}
