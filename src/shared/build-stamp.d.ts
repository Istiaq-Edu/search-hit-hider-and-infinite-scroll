/// <reference types="vite/client" />

// Injected by build.js via esbuild `define`. A unique-per-source-state stamp
// ("v1.8.20+a1b2c3d-dirty") printed at startup and in the field report, so a
// report names the exact build that produced it. Added 2026-09-29 after a field
// report cited `preload.js:2:1870` and no artifact on disk could be shown to
// be the one that produced it.
declare const __SHH_BUILD__: string;
