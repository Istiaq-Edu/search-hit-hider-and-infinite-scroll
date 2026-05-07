import type { Prefs, ButtonStyle } from "../../shared/types";

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
        flexShrink: 0,
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

const BUTTON_STYLE_OPTIONS: { value: ButtonStyle; preview: string; label: string }[] = [
  { value: "text",     preview: "block",    label: "Text" },
  { value: "icon",     preview: "✕",        label: "Icon" },
  { value: "icon+text", preview: "✕ block", label: "Both" },
];

export function AppearanceSettings({ prefs, onUpdatePrefs }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>

      {/* Theme */}
      <Row label="Theme">
        <div style={{ display: "flex", gap: "4px" }}>
          {(["system", "light", "dark"] as const).map((t) => (
            <button
              key={t}
              onClick={() => void onUpdatePrefs({ theme: t })}
              style={{
                padding: "3px 9px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                background: prefs.theme === t ? "var(--accent)" : "var(--bg-2)",
                color: prefs.theme === t ? "#fff" : "var(--text)",
                cursor: "pointer",
                fontSize: "11px",
                fontWeight: prefs.theme === t ? 600 : 400,
              }}
            >
              {t === "system" ? "System" : t === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </Row>

      {/* Block button style */}
      <Row
        label="Block button style"
        hint="How the block button looks on search results"
      >
        <div style={{ display: "flex", gap: "4px" }}>
          {BUTTON_STYLE_OPTIONS.map(({ value, preview, label }) => {
            const active = prefs.buttonStyle === value;
            return (
              <button
                key={value}
                onClick={() => void onUpdatePrefs({ buttonStyle: value })}
                title={label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: "3px",
                  padding: "4px 8px",
                  border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                  borderRadius: "var(--radius-sm)",
                  background: active ? "var(--accent-faint, rgba(74,144,226,0.1))" : "var(--bg-2)",
                  color: active ? "var(--accent)" : "var(--text)",
                  cursor: "pointer",
                  fontSize: "10px",
                  fontWeight: active ? 600 : 400,
                  minWidth: "42px",
                }}
              >
                <span style={{
                  display: "inline-block",
                  background: "#1a3a6b",
                  color: "#fff",
                  borderRadius: "10px",
                  padding: "1px 6px",
                  fontSize: "10px",
                  whiteSpace: "nowrap",
                }}>
                  {preview}
                </span>
                <span style={{ fontSize: "9px", color: active ? "var(--accent)" : "var(--text-3)" }}>
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </Row>

      {/* Show on hover */}
      <Row
        label="Show button on hover only"
        hint="Button stays hidden until you move the mouse over a result"
      >
        <Toggle
          checked={prefs.showOnHover}
          onChange={() => void onUpdatePrefs({ showOnHover: !prefs.showOnHover })}
        />
      </Row>

    </div>
  );
}
