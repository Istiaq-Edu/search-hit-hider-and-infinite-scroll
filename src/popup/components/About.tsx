export function About() {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "16px" }}>
      {/* Logo / title */}
      <div style={{ textAlign: "center", marginBottom: "16px" }}>
        <img
          src="../assets/icons/icon-48.png"
          width={48}
          height={48}
          alt="Search-Hit-Hider icon"
          style={{ borderRadius: "10px", marginBottom: "8px" }}
        />
        <div style={{ fontWeight: 700, fontSize: "15px", color: "var(--text)" }}>
          Search-Hit-Hider
        </div>
        <div style={{ fontSize: "11px", color: "var(--text-3)", marginTop: "3px" }}>
          Version {browser.runtime.getManifest().version}
        </div>
      </div>

      {/* Pitch */}
      <div style={{
        padding: "10px 12px",
        background: "var(--bg-2)",
        borderRadius: "var(--radius)",
        fontSize: "12px",
        color: "var(--text-2)",
        lineHeight: "1.5",
        marginBottom: "14px",
      }}>
        A Firefox extension that lets you hide unwanted domains from search results with one click.
        Supports Google, DuckDuckGo, Yandex, Bing, and more.
      </div>

      {/* Privacy */}
      <div style={{ marginBottom: "14px" }}>
        <div style={{
          fontWeight: 600, fontSize: "11px", color: "var(--text-3)",
          textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "6px",
        }}>
          Privacy
        </div>
        <div style={{
          padding: "8px 10px",
          background: "rgba(92,184,92,0.08)",
          border: "1px solid rgba(92,184,92,0.25)",
          borderRadius: "var(--radius-sm)",
          fontSize: "11px",
          color: "var(--text-2)",
          lineHeight: "1.6",
        }}>
          ✓ No data ever leaves your browser.<br />
          ✓ No telemetry, no analytics, no external server contact.<br />
          ✓ Block lists stored locally. Settings synced via Firefox Sync.<br />
          ✓ No remote code execution.
        </div>
      </div>

      {/* Links */}
      <div style={{ marginBottom: "14px" }}>
        <div style={{
          fontWeight: 600, fontSize: "11px", color: "var(--text-3)",
          textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "6px",
        }}>
          Links
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          {[
            { label: "GitHub — Source code & issues", url: "https://github.com/Istiaq-Edu/Search-Hit-Hider" },
            { label: "Firefox Add-ons (AMO)", url: "https://addons.mozilla.org/" },
          ].map(({ label, url }) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: "12px", color: "var(--accent)", textDecoration: "none" }}
            >
              🔗 {label}
            </a>
          ))}
        </div>
      </div>

      {/* License + credits */}
      <div>
        <div style={{
          fontWeight: 600, fontSize: "11px", color: "var(--text-3)",
          textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "6px",
        }}>
          License & Credits
        </div>
        <div style={{ fontSize: "11px", color: "var(--text-2)", lineHeight: "1.6" }}>
          <strong>MIT</strong> © 2026 Istiaq-Edu<br /><br />
          Built upon <em>Google Hit Hider by Domain</em> by Jefferson Scher,
          published on{" "}
          <a
            href="https://greasyfork.org/en/scripts/1682-google-hit-hider-by-domain-search-filter-block-sites"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--accent)" }}
          >
            Greasy Fork
          </a>
          . Upstream copyright notice retained as attribution.
        </div>
      </div>
    </div>
  );
}
