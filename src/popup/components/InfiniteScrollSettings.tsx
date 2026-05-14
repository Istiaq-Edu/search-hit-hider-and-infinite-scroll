import type { Prefs } from "../../shared/types";

interface Props {
  prefs: Prefs;
  onUpdatePrefs: (patch: Partial<Prefs>) => Promise<void>;
}

const THRESHOLD_LABELS: Record<number, string> = {
  200: "Very early",
  400: "Early",
  600: "Normal",
  800: "Normal",
  1200: "Late",
  2000: "Very late",
};

const MAX_PAGES_OPTIONS = [
  { value: 5, label: "5 pages" },
  { value: 10, label: "10 pages" },
  { value: 20, label: "20 pages" },
  { value: 50, label: "50 pages" },
  { value: -1, label: "Unlimited" },
];

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

export function InfiniteScrollSettings({ prefs, onUpdatePrefs }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <Row
        label="Enable infinite scroll"
        hint="Auto-load next page when scrolling to the bottom"
      >
        <Toggle
          checked={prefs.infiniteScroll}
          onChange={() => void onUpdatePrefs({ infiniteScroll: !prefs.infiniteScroll })}
        />
      </Row>

      {prefs.infiniteScroll && (
        <>
          <Row
            label="Load threshold"
            hint={`${prefs.infiniteScrollThreshold}px from bottom — ${THRESHOLD_LABELS[prefs.infiniteScrollThreshold] ?? "Custom"}`}
          >
            <input
              type="range"
              min="200"
              max="2000"
              step="200"
              value={prefs.infiniteScrollThreshold}
              onInput={(e) => void onUpdatePrefs({
                infiniteScrollThreshold: parseInt((e.target as HTMLInputElement).value, 10)
              })}
              style={{ width: "80px", accentColor: "var(--accent)" }}
            />
          </Row>

          <Row label="Max pages">
            <select
              value={prefs.infiniteScrollMaxPages}
              onChange={(e) => void onUpdatePrefs({
                infiniteScrollMaxPages: parseInt((e.target as HTMLSelectElement).value, 10)
              })}
              style={{
                padding: "3px 6px", border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)", background: "var(--bg-2)",
                color: "var(--text)", fontSize: "11px",
              }}
            >
              {MAX_PAGES_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </Row>

          <Row
            label="Restore scroll position"
            hint="Pick up where you left off after page reload"
          >
            <Toggle
              checked={prefs.infiniteScrollPersist}
              onChange={() => void onUpdatePrefs({ infiniteScrollPersist: !prefs.infiniteScrollPersist })}
            />
          </Row>
        </>
      )}
    </div>
  );
}
