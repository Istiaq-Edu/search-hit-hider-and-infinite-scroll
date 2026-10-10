import type { Prefs } from "../../shared/types";
import { Toggle } from "./Toggle";

interface Props {
  prefs: Prefs;
  onUpdatePrefs: (patch: Partial<Prefs>) => Promise<void>;
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
        <Toggle label="MutationObserver" checked={prefs.mutationObserver}
          onChange={() => void onUpdatePrefs({ mutationObserver: !prefs.mutationObserver })}
        />
      </Row>

      <Row
        label="Debug mode"
        hint="Verbose console diagnostics + a one-click copy(__shhDiagText()) field report"
      >
        <Toggle label="Debug mode" checked={prefs.debugMode}
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
          lineHeight: 1.5,
        }}>
          <div style={{ color: "var(--text)", marginBottom: "4px" }}>
            Debug mode ON — reload the search page, then:
          </div>
          <ol style={{ margin: "0 0 6px", paddingLeft: "16px" }}>
            <li>Reload the search page</li>
            <li>Reproduce the problem — blocked results visible that should be hidden</li>
            <li>
              Open DevTools → <b>Console</b>, run{" "}
              <code style={{ color: "var(--accent)" }}>
                copy(document.documentElement.getAttribute(&quot;data-shh-report&quot;))
              </code>{" "}
              then paste it here. The first lines are a plain-English verdict.
              The first lines are a plain-English verdict.
            </li>
          </ol>
          <div style={{ color: "var(--text-3)" }}>
            The verdict lines matter more than the tables. Read them in order:
            {" "}<b>detectorArmed</b> false means the blocked-result counter never ran and the
            report is worthless; <b>BLOCKING IS SUSPENDED</b> means you paused it and nothing is
            hidden by design; only <b>ON-SCREEN RESULT(S)…VISIBLE</b> and{" "}
            <b>BLOCKED result(s) … neither hidden nor given a block button</b> are real defects.
          </div>
          <div style={{ color: "var(--text-3)", marginTop: "4px" }}>
            The attribute above is the reliable channel: a plain DOM attribute crosses
            neither the content-script boundary nor the page one.{" "}
            <code>copy(__shhDiagText())</code> is a convenience that can be unavailable, so if
            the console says <code>__shhDiagText is not defined</code>, use the attribute
            instead. If it returns <code>null</code>, the content script did not run on this
            page. The report&apos;s <b>stamp:</b> line names the build, and its{" "}
            <b>page-bridge:</b> line says whether the console helper installed.
          </div>
        </div>
      )}

      <div style={{ marginTop: "12px", fontSize: "10px", color: "var(--text-3)" }}>
        Settings are synced across Firefox profiles via Firefox Sync. Block lists are local-only.
      </div>
    </div>
  );
}
