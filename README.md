# Search Hit Hider and Infinite Scroll

> A Firefox extension that hides unwanted domains from search results — one click to block, one click to undo — with automatic infinite scroll to load more results as you scroll.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Firefox](https://img.shields.io/badge/Firefox-112%2B-orange)](https://www.mozilla.org/firefox/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json)
[![Version](https://img.shields.io/badge/version-1.6.1-informational)](https://github.com/Istiaq-Edu/Search-Hit-Hider/releases)

[![Get it on Firefox Add-ons](https://img.shields.io/badge/Get%20it%20on-Firefox%20Add--ons-FF7139?style=for-the-badge&logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/en-US/firefox/addon/search-hit-hider/)

---

## What it does

When you search on Google, DuckDuckGo, Bing, Yandex, Baidu, or Brave Search, a small **block** button appears next to each result. Click it to hide that domain from all future searches. Blocked results are replaced with a quiet placeholder that lets you show or unblock them any time. Scroll to the bottom and more results load automatically — no pagination clicks needed.

No accounts. No servers. No tracking. Everything lives in your browser.

---

## Showcase

### Block list management

![Search-Hit-Hider popup showing blocked domain management](showcase/demo-1.png)

### Collapsed and temporarily shown results

![Search results with hidden placeholders, Show, Unblock, and Perma actions](showcase/demo-2.PNG)

---

## Features

### Blocking
- **One-click block** — click the button, choose a domain level, done
- **Two blocking modes**
  - *Regular block* — hides the result, shows a placeholder with Show / Unblock actions
  - *Perma-ban* — result disappears entirely, no placeholder, no trace
- **Block dialog** — choose to block the exact subdomain, root domain, or let the extension decide
- **Undo toast** — 4-second window to undo any block action
- **Subdomain wildcard** — blocking `example.com` automatically hides `news.example.com`, `shop.example.com`, etc.
- **PSL-aware parsing** — correctly handles `co.uk`, `com.au`, and other compound TLDs

### List Management
- Full-featured popup (440 × 620 px) with **Blocked** and **Perma-ban** tabs
- Search, sort (alphabetical or by date), and bulk-select entries
- Bulk actions: delete, enable/disable, convert between modes, sort, deduplicate, strip www.
- Add entries manually by typing a domain

### Import / Export
- **JSON** — full round-trip backup with mode and timestamp preserved
- **Plain domain list** — one domain per line; `# perma-ban` annotation preserves ban mode on re-import
- **Userscript format** — compatible with the original Google Hit Hider by Domain userscript

### Appearance
- **Theme** — System / Light / Dark (popup)
- **Block button style** — Text (`block`), Icon (`✕`), or Icon + Text (`✕ block`)
- **Show button on hover only** — button stays hidden until you hover over a result
- Page-injected styles adapt to each search engine's background color in real time

### Reliability
- **MutationObserver** — catches results added by infinite scroll and AJAX pagination
- **Preload script** — hides known domains before the first paint (zero flicker)
- **Firefox Sync** — preferences sync across devices; block lists stay local
- **No telemetry** — zero external requests, zero data collection

### Infinite Scroll
- **Auto-load more results** — scroll to the bottom and the next page loads automatically
- **Configurable** — adjust scroll threshold, max pages, and scroll persistence in settings
- **Linked to blocking** — works together with hit-hider; when most results are blocked, infinite scroll keeps feeding new pages
- **Supported engines** — Google (fetch), Bing (fetch), DuckDuckGo (native), Yandex (fetch, pagination kept visible), Brave Search (fetch with container wrapping)
- **Dedup** — prevents duplicate results across pages (attribute-based + URL hash fallback)
- **Smart pagination** — clicking a page number scrolls to already-fetched content instead of reloading
- **Fetch jitter** — randomized delays to avoid detection patterns
- **DOM management** — automatically discards old pages above the viewport to keep memory lean
- **Container wrapping** — each fetched page wrapped in a styled container for consistent rendering with the original results

---

## Supported Search Engines

| Engine | URL | Coverage |
|---|---|---|
| Google | google.com (40+ regional domains) | Web results |
| DuckDuckGo | duckduckgo.com | Web (React SPA + legacy) |
| Bing | bing.com | Web results |
| Yandex | yandex.com / yandex.ru (+ 6 regional) | Web (organic, ad-filtered) |
| Baidu | baidu.com | Web results |
| Brave Search | search.brave.com | Web results |

---

## Installation

### From Firefox Add-ons (AMO)
Install Search Hit Hider and Infinite Scroll from [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/search-hit-hider/).

### Manual (from a release zip)
1. Download the latest `search-hit-hider-vX.X.X.zip` from [Releases](https://github.com/Istiaq-Edu/Search-Hit-Hider/releases)
2. Open Firefox → `about:addons` → gear icon → **Install Add-on From File…**
3. Select the downloaded `.zip`

### Temporary install (for testing)
1. Open Firefox → `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
2. Select `dist/manifest.json` from the built output

---

## Development

### Prerequisites
- Node.js 18+
- The build script uses only Node.js built-ins + bundled `esbuild` — no global installs needed

### Build

```bash
npm install          # install dependencies
npm run build        # build → dist/
```

The build script compiles TypeScript via `esbuild`, copies assets, and writes everything to `dist/`.

### Package for submission

Uses the GitHub workflow (`.github/workflows/manual-package.yml`) to create extension and source zips. Trigger it from the Actions tab with the desired version number.

### Project structure

```
./
├── src/
│   ├── background/        # Service worker (storage, messaging)
│   ├── content/           # Content script injected into search pages
│   │   ├── blocking/       # Domain matching, result hiding, observer
│   │   ├── engines/        # Per-engine adapters (Google, DDG, Bing, …)
│   │   ├── infinite-scroll/ # Infinite scroll (manager, fetcher, deduper, sentinel, persist)
│   │   └── ui/             # Block button, dialog, toast, styles
│   ├── popup/             # Preact popup UI
│   │   └── components/    # Tab components, lists, settings, import/export
│   └── shared/            # Types, storage, domain utils, migration
├── assets/                # Icons
├── build.js               # Build script (esbuild + asset copy)
└── manifest.json          # WebExtension MV3 manifest
```

### Linting & type-checking

```bash
npm run lint:ts      # TypeScript type check (tsc --noEmit)
npm run webext:lint   # AMO linter (addons-linter)
```

---

## Settings reference

| Setting | Location | Description |
|---|---|---|
| Theme | Appearance | System / Light / Dark popup theme |
| Block button style | Appearance | Text / Icon / Icon+Text |
| Show button on hover | Appearance | Button hidden until you hover a result |
| One-click block | Blocking | Skip the dialog; block immediately |
| Domain choice | Blocking | Ask / Always root / Always exact |
| Show block notices | Blocking | Show placeholder bar for hidden results |
| Subdomain wildcard | Blocking | Blocking root also hides all subdomains |
| MutationObserver | Advanced | Auto-hide results from infinite scroll / AJAX |
| Aggressive domain mode | Advanced | Strip subdomains on block |
| Debug mode | Advanced | Log engine-detection diagnostics to DevTools |
| Pause globally | Blocking | Temporarily suspend all blocking |
| Infinite scroll | Infinite Scroll | Enable/disable auto-loading next page on scroll |
| Scroll threshold | Infinite Scroll | How close to the bottom before loading (px) |
| Max pages | Infinite Scroll | Maximum pages to auto-load |
| Persist scroll | Infinite Scroll | Restore scroll position after reload |

---

## Privacy

- Block list stored in `browser.storage.local` (device-local, never synced)
- Preferences stored in `browser.storage.sync` (synced via Firefox Sync if enabled)
- Zero external network requests at runtime
- No analytics, no crash reporting, no telemetry of any kind
- Source is fully auditable — no minified blobs, no remote scripts

See [privacy-policy.md](privacy-policy.md) for the full policy text.

---

## Contributing

Bug reports and pull requests are welcome. Please open an issue first for any significant changes so we can discuss the approach.

---

## Credits & License

**MIT © 2026 Istiaq-Edu**

Built upon [Google Hit Hider by Domain](https://greasyfork.org/en/scripts/1682-google-hit-hider-by-domain-search-filter-block-sites) by Jefferson Scher, published on Greasy Fork. Upstream copyright notice retained as attribution.

See [LICENSE](LICENSE) for the full MIT license text.
