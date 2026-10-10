#!/usr/bin/env node
// esbuild build script for Search-Hit-Hider Firefox extension

import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, statSync, existsSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

// ============================================================
// BUILD STAMP
// ------------------------------------------------------------
// Every field log so far has been un-attributable. A report said
// "preload.js:2:1870 — TypeError: H is not a function", and there is no way
// to tell WHICH build produced it: minified identifiers are single letters,
// and two consecutive builds can both plausibly match a line:column. Every
// attempt to match the report against the artifact on disk was inconclusive
// for exactly that reason.
//
// So: stamp an identifier into the bundle, print it at startup, and a report
// names its own build.
//
// HASH THE SOURCE, NOT HEAD. A first attempt used `git rev-parse --short HEAD`
// plus a `-dirty` flag, and that is broken: `-dirty` encodes only *that*
// something is uncommitted, never *what*. Two genuinely different source states
// both stamped `v1.8.20+56f9ebf-dirty` while differing by four bytes — so the
// stamp could not separate the very builds a report needs to distinguish, and
// the minified name at a given column differed between them (`H` was
// `injectCoverCSS` in one and `buildHasRules` in the other). Hashing the actual
// bytes that go into the bundle is the only thing that cannot collide.
function hashSources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|css|html|json)$/.test(entry.name)) files.push(p);
    }
  };
  if (existsSync("src")) walk("src");
  // manifest.json ships in the artifact, so it is part of the build's identity.
  if (existsSync("manifest.json")) files.push("manifest.json");
  // build.js too, and this is not pedantry. It was discovered the hard way:
  // switching `sourcemap` from `external` to `linked` changed the shipped
  // artefact materially — every .map became reachable instead of orphaned — and
  // produced the SAME stamp, because the hash covered `src/**` and
  // `manifest.json` only. Two builds with genuinely different output were
  // indistinguishable by their identity string, which is exactly what the stamp
  // exists to prevent.
  if (existsSync("build.js")) files.push("build.js");
  files.sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f.replace(/\\/g, "/"));
    h.update(readFileSync(f));
  }
  return h.digest("hex").slice(0, 8);
}

const version = (() => {
  try {
    return JSON.parse(readFileSync("manifest.json", "utf8")).version ?? "0";
  } catch {
    return "0";
  }
})();

// v<version>+<sha256 of every source byte in the build>
const BUILD_STAMP = `v${version}+${hashSources()}`;

const sharedConfig = {
  bundle: true,
  format: "esm",
  target: ["firefox109"],
  minify: !watch,
  // Sourcemaps in release builds too. Without them a field report can only cite
  // a minified `preload.js:2:1870`, which is unactionable: the whole point of
  // collecting a report from a user's machine is to be able to locate the line.
  //
  // "linked", NOT "external". esbuild's `external` writes the .map but emits no
  // `//# sourceMappingURL=` comment, which leaves every map orphaned — DevTools
  // does NOT auto-discover a map file next to a bundle. That was verified
  // empirically: the shipped artefacts had five .map files and zero link
  // comments, so every field frame stayed unactionable. `linked` writes the same
  // external map AND the comment, which is what actually makes it load.
  // Inline for watch mode so the dev bundle is self-contained.
  sourcemap: watch ? "inline" : "linked",
  // Preserves Function.name through minification, so a stack frame reads
  // `resolveGoogleStream` rather than `H` in anything that consults it.
  keepNames: true,
  jsxFactory: "h",
  jsxFragment: "Fragment",
  jsxImportSource: "preact",
  define: {
    "process.env.NODE_ENV": watch ? '"development"' : '"production"',
    __SHH_BUILD__: JSON.stringify(BUILD_STAMP),
  },
  alias: {
    "~shared": "./src/shared",
  },
};

async function build() {
  mkdirSync("dist/background", { recursive: true });
  mkdirSync("dist/content", { recursive: true });
  mkdirSync("dist/popup", { recursive: true });
  mkdirSync("dist/assets/icons", { recursive: true });

  copyFileSync("manifest.json", "dist/manifest.json");

  const iconsDir = "src/assets/icons";
  const REQUIRED_ICONS = ["icon-16.png", "icon-32.png", "icon-48.png", "icon-96.png", "icon-128.png"];
  if (existsSync(iconsDir)) {
    for (const f of readdirSync(iconsDir)) {
      if (REQUIRED_ICONS.includes(f)) {
        copyFileSync(join(iconsDir, f), join("dist/assets/icons", f));
      }
    }
  }

  copyFileSync("src/popup/index.html",   "dist/popup/index.html");
  copyFileSync("src/popup/options.html", "dist/popup/options.html");
  copyFileSync("src/content/preload.css", "dist/content/preload.css");

  const buildTargets = [
    {
      entryPoints: ["src/background/service-worker.ts"],
      outfile: "dist/background/service-worker.js",
    },
    // ── format: "iife" IS LOAD-BEARING HERE. DO NOT REMOVE. ──────────────
    //
    // `sharedConfig.format` is "esm", and esbuild's ESM output has NO wrapper:
    // it emits its mangled top-level names straight into the global scope. The
    // popup and the background worker genuinely need ESM (their HTML uses
    // <script type="module"> and the manifest sets "type": "module"), but these
    // two are CLASSIC content scripts, and they run in the SAME isolated world —
    // so with ESM output they overwrite each other's globals.
    //
    // Measured on the 1.8.21 build, evaluating both bundles into one window:
    // preload.js declared 27 globals, and index.js CLOBBERED 18 of them (67%).
    // The damage is not cosmetic — it made the preload's cover-selector
    // constant become index.js's `updateHasRules` function, so
    // `querySelectorAll()` threw
    //   SyntaxError: Invalid selector function U(){let n=window.__shhUpdateHas…
    //
    // This is almost certainly the true origin of the field error the plan
    // document filed as undiagnosable — `TypeError: H is not a function
    // preload.js:2:1870` (docs/plans/2026-09-27-show-hide-intermittency-plan.md
    // §9). That investigation evaled the preload bundle ALONE, which is the one
    // configuration where the collision cannot occur; `H` was
    // `resolveGoogleStream`, and index.js was overwriting it.
    //
    // Which globals collide, and therefore which symptoms appear, depends on
    // esbuild's mangling — i.e. on the build. That is why the failures looked
    // intermittent and why no source-level review could find them.
    //
    // `tests/bundle-global-isolation.test.ts` pins this.
    {
      entryPoints: ["src/content/preload.ts"],
      outfile: "dist/content/preload.js",
      format: "iife",
    },
    {
      entryPoints: ["src/content/index.ts"],
      outfile: "dist/content/index.js",
      format: "iife",
    },
    {
      entryPoints: ["src/popup/index.tsx"],
      outfile: "dist/popup/index.js",
    },
    {
      entryPoints: ["src/popup/options-entry.tsx"],
      outfile: "dist/popup/options.js",
    },
  ];

  if (watch) {
    const contexts = await Promise.all(
      buildTargets.map((t) => esbuild.context({ ...sharedConfig, ...t }))
    );
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("[watch] Watching for changes...");
  } else {
    await Promise.all(
      buildTargets.map((t) => esbuild.build({ ...sharedConfig, ...t }))
    );
    console.log(`[build] Done.  stamp=${BUILD_STAMP}`);
  }
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
