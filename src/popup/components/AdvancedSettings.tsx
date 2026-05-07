import type { Prefs } from "../../shared/types";

interface Props {
  prefs: Prefs;
  onUpdatePrefs: (patch: Partial<Prefs>) => Promise<void>;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <div
      onClick={onChange}
      style={{
        width: "34px", height: "18px",
        background: checked ? "var(--accent)" : "var(--bg-3)",
        borderRadius: "9px", position: "relative", cursor: "pointer",
        transition: "background 0.2s", border: "1px solid var(--border)",
      }}
    >
      <div style={{
        position: "absolute", top: "2px",
        left: checked ? "16px" : "2px",
        width: "12px", height: "12px",
        background: "#fff", borderRadius: "50%",
        transition: "left 0.2s", boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
      }} />
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: preact.ComponentChildren }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: "10px", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: "12px", color: "var(--text)" }}>{label}</div>
        {hint && <div style={{ fontSize: "10px", color: "var(--text-3)", marginTop: "1px" }}>{hint}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

export function AdvancedSettings({ prefs, onUpdatePrefs }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <Row
        label="MutationObserver"
        hint="Automatically hide results added by infinite scroll / AJAX"
      >
        <Toggle
          checked={prefs.mutationObserver}
          onChange={() => void onUpdatePrefs({ mutationObserver: !prefs.mutationObserver })}
        />
      </Row>

      <Row
        label="Debug mode"
        hint="Show diagnostic info when engine detection fails"
      >
        <Toggle
          checked={prefs.debugMode}
          onChange={() => void onUpdatePrefs({ debugMode: !prefs.debugMode })}
        />
      </Row>

      <Row
        label="Aggressive domain mode"
        hint="Auto-strip subdomains when blocking"
      >
        <select
          value={prefs.aggressiveBlock}
          onChange={(e) => void onUpdatePrefs({ aggressiveBlock: (e.target as HTMLSelectElement).value as "none" | "all" | "www" })}
          style={{
            padding: "3px 6px", border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)", background: "var(--bg-2)",
            color: "var(--text)", fontSize: "11px",
          }}
        >
          <option value="none">None (use dialog)</option>
          <option value="www">Strip www. only</option>
          <option value="all">Always use root domain</option>
        </select>
      </Row>

      {prefs.debugMode && (
        <div style={{
          margin: "8px 0",
          padding: "8px",
          background: "var(--bg-2)",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--border)",
          fontSize: "11px",
          color: "var(--text-2)",
          fontFamily: "monospace",
        }}>
          Debug mode active — open browser DevTools console on a search page to see SHH diagnostics.
        </div>
      )}

      <div style={{ marginTop: "12px", fontSize: "10px", color: "var(--text-3)" }}>
        Settings are synced across Firefox profiles via Firefox Sync. Block lists are local-only.
      </div>
    </div>
  );
}
