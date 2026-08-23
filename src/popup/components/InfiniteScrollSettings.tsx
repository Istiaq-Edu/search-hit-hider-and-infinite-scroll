import type { Prefs } from "../../shared/types";
import { Toggle } from "./Toggle";

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
        <Toggle label="Enable infinite scroll" checked={prefs.infiniteScroll}
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
              aria-label="Load threshold"
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
            <Toggle label="Restore scroll position" checked={prefs.infiniteScrollPersist}
              onChange={() => void onUpdatePrefs({ infiniteScrollPersist: !prefs.infiniteScrollPersist })}
            />
          </Row>
        </>
      )}
    </div>
  );
}
