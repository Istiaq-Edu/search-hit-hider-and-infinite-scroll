import type { Prefs, EngineId } from "../../shared/types";
import { ALL_ENGINE_IDS } from "../../shared/types";

interface Props {
  prefs: Prefs;
  onUpdatePrefs: (patch: Partial<Prefs>) => Promise<void>;
}

const ENGINE_LABELS: Record<EngineId, string> = {
  google: "Google",
  duckduckgo: "DuckDuckGo",
  bing: "Bing",
  yandex: "Yandex",
  baidu: "Baidu",
  brave: "Brave Search",
};

export function EngineSettings({ prefs, onUpdatePrefs }: Props) {
  async function toggle(id: EngineId) {
    const updated = {
      ...prefs.engineToggles,
      [id]: !prefs.engineToggles[id],
    };
    await onUpdatePrefs({ engineToggles: updated });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div style={{ fontSize: "11px", color: "var(--text-3)", marginBottom: "4px" }}>
        Disable engines to skip blocking on those search pages.
      </div>
      {ALL_ENGINE_IDS.map((id) => {
        const enabled = prefs.engineToggles[id] ?? true;
        return (
          <label
            key={id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              cursor: "pointer",
              padding: "3px 0",
            }}
          >
            <input
              type="checkbox"
              checked={enabled}
              onChange={() => void toggle(id)}
              style={{ width: "14px", height: "14px", accentColor: "var(--accent)", cursor: "pointer" }}
            />
            <span style={{ fontSize: "12px", color: "var(--text)" }}>
              {ENGINE_LABELS[id]}
            </span>
            {!enabled && (
              <span style={{ fontSize: "10px", color: "var(--text-3)", marginLeft: "auto" }}>
                disabled
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}
