# Privacy Policy — Search-Hit-Hider

**Last updated:** May 2026

## Summary

Search-Hit-Hider does not collect, transmit, or share any personal data. Everything stays in your browser.

## Data Storage

- **Block lists** are stored locally in your browser using `storage.local`. They never leave your device unless you explicitly export them.
- **Settings and preferences** are stored using `storage.sync`, which means Firefox may sync them to other devices signed into the same Firefox Account — this is handled entirely by Firefox/Mozilla, not by this extension.

## Data Transmission

- This extension **never contacts any external server**.
- There is **no telemetry**, no analytics, no error reporting, no update checks beyond Firefox's standard extension update mechanism.
- No remote code is ever fetched or executed.

## Permissions

- `storage` — required to save your block list and settings locally/via Firefox Sync.
- Host permissions (Google, DuckDuckGo, Bing, etc.) — required to inject the block button into search result pages. The extension reads page content only to identify result containers and inject UI controls. No page content is transmitted anywhere.

## Third Parties

None. This extension has no third-party dependencies at runtime that communicate externally.

## Contact

For questions or concerns, please open an issue at:
https://github.com/Istiaq-Edu/Search-Hit-Hider/issues
