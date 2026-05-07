import type { Prefs } from "../../shared/types";

interface Props {
  prefs: Prefs;
  onUpdatePrefs: (patch: Partial<Prefs>) => Promise<void>;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: preact.ComponentChildren }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: "10px", padding: "5px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: "12px", color: "var(--text)" }}>{label}</div>
        {hint && <div style={{ fontSize: "10px", color: "var(--text-3)", marginTop: "1px" }}>{hint}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <div
      onClick={onChange}
      style={{
        width: "34px",
        height: "18px",
        background: checked ? "var(--accent)" : "var(--bg-3)",
        borderRadius: "9px",
        position: "relative",
        cursor: "pointer",
        transition: "background 0.2s",
        border: "1px solid var(--border)",
        flexShrink: 0,
      }}
    >
      <div style={{
        position: "absolute",
        top: "2px",
        left: checked ? "16px" : "2px",
        width: "12px",
        height: "12px",
        background: "#fff",
        borderRadius: "50%",
        transition: "left 0.2s",
        boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
      }} />
    </div>
  );
}

export function BlockingSettings({ prefs, onUpdatePrefs }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <Row label="One-click block" hint="Block without showing a dialog">
        <Toggle checked={prefs.oneClick} onChange={() => void onUpdatePrefs({ oneClick: !prefs.oneClick })} />
      </Row>

      {prefs.oneClick && (
        <Row label="One-click target" hint="What mode to apply on one-click">
          <select
            value={prefs.oneClickTarget}
            onChange={(e) => void onUpdatePrefs({ oneClickTarget: (e.target as HTMLSelectElement).value as "block" | "pban" })}
            style={{ padding: "3px 6px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg-2)", color: "var(--text)", fontSize: "11px" }}
          >
            <option value="block">Regular block</option>
            <option value="pban">Perma-ban</option>
          </select>
        </Row>
      )}

      <Row label="Domain choice" hint="Which domain level to block">
        <select
          value={prefs.domainChoiceMode}
          onChange={(e) => void onUpdatePrefs({ domainChoiceMode: (e.target as HTMLSelectElement).value as "exact" | "root" | "ask" })}
          style={{ padding: "3px 6px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg-2)", color: "var(--text)", fontSize: "11px" }}
        >
          <option value="ask">Ask (show dialog)</option>
          <option value="root">Always root domain</option>
          <option value="exact">Always exact hostname</option>
        </select>
      </Row>

      <Row label="Show block notices" hint="Show placeholder for hidden results">
        <Toggle checked={prefs.showNotices} onChange={() => void onUpdatePrefs({ showNotices: !prefs.showNotices })} />
      </Row>

      <Row label="Strip www." hint="Remove www. prefix when blocking">
        <Toggle checked={prefs.stripWww} onChange={() => void onUpdatePrefs({ stripWww: !prefs.stripWww })} />
      </Row>

      <Row label="Subdomain wildcard" hint="Blocking example.com also hides sub.example.com">
        <Toggle checked={prefs.subdomainWildcard} onChange={() => void onUpdatePrefs({ subdomainWildcard: !prefs.subdomainWildcard })} />
      </Row>

      <Row label="New entries added at">
        <select
          value={prefs.addPosition}
          onChange={(e) => void onUpdatePrefs({ addPosition: (e.target as HTMLSelectElement).value as "end" | "top" | "sort" })}
          style={{ padding: "3px 6px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg-2)", color: "var(--text)", fontSize: "11px" }}
        >
          <option value="end">End of list</option>
          <option value="top">Top of list</option>
          <option value="sort">Alphabetical position</option>
        </select>
      </Row>

      <Row label="Pause globally" hint="Temporarily disable all blocking">
        <Toggle checked={prefs.pausedGlobally} onChange={() => void onUpdatePrefs({ pausedGlobally: !prefs.pausedGlobally })} />
      </Row>
    </div>
  );
}
