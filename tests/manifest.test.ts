import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Read rather than import: the manifest sits outside tsconfig's `include`
// (["src/**/*", "tests/**/*"]), so a JSON import would sit outside the tsc gate
// and `resolveJsonModule` may not be on.
const here = dirname(fileURLToPath(import.meta.url));
const distManifestPath = resolve(here, "..", "dist", "manifest.json");
const manifest = JSON.parse(
  readFileSync(resolve(here, "..", "manifest.json"), "utf8")
) as {
  version: string;
  manifest_version: number;
  background: { service_worker?: string; scripts: string[]; type: string };
  content_scripts: Array<{ matches: string[]; js: string[]; run_at?: string }>;
};

// ============================================================
// manifest wiring
//
// E1: `manifest.json` declared `background.scripts` with NO `service_worker`
// key. That is valid for Firefox MV3 (an event page) but Chrome MV3 REQUIRES
// `background.service_worker` and ignores `background.scripts` — so on Chrome
// the extension loads with no background context at all. Every sendMessage then
// rejects, getList()/getPrefs() fail, and the popup reports an empty block list
// while storage is full.
//
// Both keys are now present: Firefox uses `scripts`, Chrome uses
// `service_worker`.
// ============================================================

describe("manifest background wiring (E1)", () => {
  it("declares service_worker for Chrome MV3", () => {
    expect(manifest.background).toHaveProperty("service_worker");
    expect(manifest.background.service_worker).toBe("background/service-worker.js");
  });

  it("keeps scripts for Firefox MV3", () => {
    expect(manifest.background.scripts).toContain("background/service-worker.js");
  });

  it("points both at the same file", () => {
    const bg = manifest.background as { service_worker: string; scripts: string[] };
    expect(bg.scripts).toContain(bg.service_worker);
  });

  it("is a module background in both dialects", () => {
    expect(manifest.background.type).toBe("module");
  });

  it("build.js copies manifest.json into dist/ verbatim", () => {
    // The source file IS the artifact only as long as the copy step exists.
    // Nothing else in the repo would notice if that line were deleted, and the
    // extension would then ship a stale manifest — the exact failure E1 was.
    const build = readFileSync(resolve(here, "..", "build.js"), "utf8");
    expect(build).toMatch(
      /copyFileSync\(\s*["']manifest\.json["']\s*,\s*["']dist[/\\]manifest\.json["']\s*\)/
    );
  });

  // The artifact, when it has been built.
  //
  // Previously `it.skipIf(!existsSync(distManifestPath))`, which meant this
  // NEVER RAN: `dist/` is gitignored, the only workflow is `workflow_dispatch`,
  // and the release job runs `npm test` BEFORE `npm run build` — so at test
  // time `dist/` never existed. A test that cannot fail is not a test. The
  // `pretest` script now builds first (0.35s), so this executes on every
  // `npm test`, and the guard is kept only as a safety net for a direct
  // `npx vitest run`.
  it.skipIf(!existsSync(distManifestPath))(
    "dist/ manifest resolves BOTH background keys to real bundled files",
    () => {
      const d = JSON.parse(readFileSync(distManifestPath, "utf8")) as {
        background: { service_worker?: string; scripts: string[] };
      };
      // `scripts` is what FIREFOX loads (this is a Firefox-only extension:
      // `browser.*`, no chrome polyfill, target firefox109). `service_worker`
      // is the Chrome spelling; `web-ext lint` reports it as
      // MANIFEST_FIELD_UNSUPPORTED — a WARNING, i.e. Firefox ignores it, which
      // is why declaring both is safe. Both are asserted so neither can
      // silently start pointing at a file the build does not emit.
      expect(d.background.scripts).toEqual(["background/service-worker.js"]);
      expect(d.background.service_worker).toBe("background/service-worker.js");
      expect(
        existsSync(resolve(here, "..", "dist", "background", "service-worker.js"))
      ).toBe(true);
    }
  );
});

describe("manifest content-script run_at", () => {
  // The race the whole show/hide investigation turned on: the preload runs at
  // document_start, the content script must run EARLY ENOUGH to matter.
  //
  // It used to be `document_idle`, which Firefox fires after the window `load`
  // event. That is the whole field bug: a Google results page hangs on
  // subresources, so `load` — and therefore this entire content script — was
  // deferred by the same amount. Measured at 54.2 s on Google in the field, and
  // 102.5 s on Startpage per this repo's own plan doc. The extension was inert
  // for that entire window and appeared to "start working" when the popup was
  // opened, which is when the deferred injection happened to land.
  //
  // `document_end` fires at DOMContentLoaded, which does not wait on
  // subresources. `document_start` would be worse for the SERVER-RENDERED
  // engines: the body does not exist yet, so result discovery and
  // `documentElement.classList` work have nothing to act on.
  //
  // Startpage is the deliberate exception and is pinned separately below — see
  // "runs Startpage at document_start, on purpose". It was already on
  // `document_start` before this change, and an audit found it was pinned NOWHERE.
  const blocks = manifest.content_scripts;

  const isPreload = (b: any) => b.js.some((f: string) => f.includes("preload"));
  const isMain = (b: any) => b.js.some((f: string) => f.includes("index.js"));
  const isStartpage = (b: any) => b.matches.some((m: string) => m.includes("startpage.com"));

  it("runs every preload at document_start", () => {
    const preloads = blocks.filter(isPreload);
    expect(preloads.length).toBeGreaterThan(0);
    for (const b of preloads) {
      expect(b.run_at).toBe("document_start");
    }
  });

  it("runs the main content script at document_end on Google", () => {
    const google = blocks.find(
      (b) => b.matches.some((m) => m.includes("google.com")) && isMain(b)
    );
    expect(google).toBeDefined();
    expect(google!.run_at).toBe("document_end");
  });

  it("runs EVERY main content script at document_end, not just Google", () => {
    // The gap an audit found: only Google was pinned, so any other engine could
    // silently regress to something else while the suite stayed green.
    //
    // Startpage is expected to fail this and is covered by its own assertion
    // below, so it is excluded here and accounted for there — not ignored.
    const others = blocks.filter((b) => isMain(b) && !isStartpage(b));
    expect(others.length, "no non-Startpage main content scripts found").toBeGreaterThan(0);
    for (const b of others) {
      expect(b.run_at).toBe("document_end");
    }
  });

  it("runs Startpage at document_start, on purpose", () => {
    // NOT an oversight, and this assertion exists so nobody "fixes" it.
    //
    // Startpage renders results client-side after a POST-based search, and its
    // `load`-bound injection was the 102.5 s case recorded in
    // docs/plans/2026-08-23-startpage-support.md. Running at `document_start`
    // is strictly earlier still, and the DOM-readiness gate in init() plus the
    // preload's own observer are what make a body-less start work there. It has
    // been on `document_start` since before this change.
    const sp = blocks.find(
      (b) => b.matches.some((m) => m.includes("startpage.com")) && isMain(b)
    );
    expect(sp).toBeDefined();
    expect(sp!.run_at).toBe("document_start");
  });

  it("runs NO content script at document_idle, on ANY engine", () => {
    // The single highest-value assertion in this file. One engine left on
    // document_idle reintroduces the entire field bug on that engine only, which
    // is exactly the kind of regression that survives a suite that only checks
    // Google.
    for (const b of blocks) {
      expect(b.run_at).not.toBe("document_idle");
    }
  });

  it("gives every engine a main content script, not just a preload", () => {
    // A previous version asserted only that the concatenated match-strings
    // contained each host. Because the preload block already matched every
    // engine, that passed even if every per-engine `index.js` block were deleted
    // — it proved host substrings exist somewhere, not that each engine has a
    // working content script. This pins the actual requirement.
    for (const host of ["google.com", "bing.com", "duckduckgo.com", "yandex", "baidu.com", "brave.com", "startpage.com"]) {
      const main = blocks.find(
        (b) => b.matches.some((m) => m.includes(host)) && isMain(b)
      );
      expect(main, `no main content script for ${host}`).toBeDefined();
    }
  });
});
