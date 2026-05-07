#!/usr/bin/env node
// esbuild build script for Search-Hit-Hider Firefox extension

import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, statSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

const sharedConfig = {
  bundle: true,
  format: "esm",
  target: ["firefox109"],
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  jsxFactory: "h",
  jsxFragment: "Fragment",
  jsxImportSource: "preact",
  define: {
    "process.env.NODE_ENV": watch ? '"development"' : '"production"',
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
  if (existsSync(iconsDir)) {
    for (const f of readdirSync(iconsDir)) {
      copyFileSync(join(iconsDir, f), join("dist/assets/icons", f));
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
    {
      entryPoints: ["src/content/preload.ts"],
      outfile: "dist/content/preload.js",
    },
    {
      entryPoints: ["src/content/index.ts"],
      outfile: "dist/content/index.js",
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
    console.log("[build] Done.");
  }
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
