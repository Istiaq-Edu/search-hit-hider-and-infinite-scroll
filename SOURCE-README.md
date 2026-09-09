# Source code — Search Hit Hider and Infinite Scroll

This archive contains the complete source for the submitted extension
version (see `manifest.json`).

## Build

Requires Node.js >= 18 and npm.

```sh
npm install
npm run build        # node build.js -> outputs dist/
npm run package      # build + web-ext build -> releases/*.zip
```

The result is structurally identical to the submitted zip: same
manifest.json, same entry points. Only embedded timestamps differ.

## Bundle mapping (esbuild)

TypeScript sources are bundled and minified by esbuild (`build.js`),
one entry point per output file:

| dist file | entry point (imports the rest) |
|---|---|
| `dist/background/service-worker.js` | `src/background/service-worker.ts` |
| `dist/content/preload.js` | `src/content/preload.ts` |
| `dist/content/index.js` | `src/content/index.ts` |
| `dist/popup/index.js` | `src/popup/index.tsx` |
| `dist/popup/options.js` | `src/popup/options-entry.tsx` |

All bundled application code originates from this repo's `src/` tree.

Bundles inline **Preact** (MIT, declared in package.json) at esbuild's
standard inlined-library position — that is bundler library inlining,
not obfuscation. All other bundled code originates from this repo's
`src/` tree.

## Tests

```sh
npm test             # vitest
npm run lint:ts      # tsc --noEmit
npx web-ext lint --source-dir=dist
```
