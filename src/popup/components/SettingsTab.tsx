import type { Prefs } from "../../shared/types";
import { ALL_ENGINE_IDS } from "../../shared/types";
import { EngineSettings } from "./EngineSettings";
import { BlockingSettings } from "./BlockingSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { AdvancedSettings } from "./AdvancedSettings";
import { InfiniteScrollSettings } from "./InfiniteScrollSettings";

interface Props {
  prefs: Prefs;
  onUpdatePrefs: (patch: Partial<Prefs>) => Promise<void>;
}

function Section({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <div style={{
        padding: "8px 12px",
        fontWeight: 700,
        fontSize: "11px",
        textTransform: "uppercase",
        letterSpacing: "0.6px",
        color: "var(--text-3)",
        background: "var(--bg-2)",
      }}>
        {title}
      </div>
      <div style={{ padding: "10px 12px" }}>
        {children}
      </div>
    </div>
  );
}

export function SettingsTab({ prefs, onUpdatePrefs }: Props) {
  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
      <Section title="Blocking">
        <BlockingSettings prefs={prefs} onUpdatePrefs={onUpdatePrefs} />
      </Section>
      <Section title="Search Engines">
        <EngineSettings prefs={prefs} onUpdatePrefs={onUpdatePrefs} />
      </Section>
      <Section title="Infinite Scroll">
        <InfiniteScrollSettings prefs={prefs} onUpdatePrefs={onUpdatePrefs} />
      </Section>
      <Section title="Appearance">
        <AppearanceSettings prefs={prefs} onUpdatePrefs={onUpdatePrefs} />
      </Section>
      <Section title="Advanced">
        <AdvancedSettings prefs={prefs} onUpdatePrefs={onUpdatePrefs} />
      </Section>
    </div>
  );
}
