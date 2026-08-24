# Privacy Policy — Search-Hit-Hider

**Last updated:** May 2026

## Summary

Search-Hit-Hider does not collect, transmit, or share any personal data. Everything stays in your browser.

## Data Storage

- **Block lists** are stored locally in your browser using `storage.local`. They never leave your device unless you explicitly export them.
- **Settings and preferences** are stored using `storage.sync`, which means Firefox may sync them to other devices signed into the same Firefox Account — this is handled entirely by Firefox/Mozilla, not by this extension.

## Data Transmission

- This extension makes **no requests to any server operated by us** and has **no telemetry, analytics, error reporting, or update checks** beyond Firefox's standard extension update mechanism.
- No remote code is ever fetched or executed.
- **Favicon images**: on some search engines (e.g. Yandex), automatically loaded results may display site icons fetched from that search engine's **own first-party icon service** (`favicon.yandex.net`). These are the exact same requests the search engine itself makes when rendering page 1 — the extension adds no third-party requests and discloses nothing to anyone the engine doesn't already see. On engines without a first-party service, icons fall back to locally generated letter monograms; no image requests leave the engine's ecosystem.

## Permissions

- `storage` — required to save your block list and settings locally/via Firefox Sync.
- Host permissions (Google, DuckDuckGo, Bing, etc.) — required to inject the block button into search result pages. The extension reads page content only to identify result containers and inject UI controls. No page content is transmitted anywhere.

## Third Parties

None. The extension never communicates with any party other than the search engine whose page you are browsing — and only via that engine's own existing endpoints.

## Contact

For questions or concerns, please open an issue at:
https://github.com/Istiaq-Edu/Search-Hit-Hider/issues
