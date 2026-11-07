import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { GOOGLE_HOSTS } from "../src/content/engines/google-hosts";
import { YANDEX_HOSTS } from "../src/content/engines/yandex";

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
  host_permissions: string[];
};

// ============================================================
// manifest background wiring
//
// This is a Firefox-only extension: it uses the `browser.*` namespace with no
// Chrome polyfill, and ships through AMO/web-ext. Firefox MV3 uses an event
// page declared via `background.scripts`. `background.service_worker` is the
// Chrome spelling; Firefox reports it as MANIFEST_FIELD_UNSUPPORTED.
//
// Worse than a warning: before Firefox 120, a manifest that declared
// `service_worker` caused Firefox NOT to start the background context at all.
// The previous revision declared both "for Chrome compatibility" and a test
// comment asserted Firefox ignored the extra key. MDN documents the opposite,
// and `web-ext lint` flags it. Declaring an unsupported key provided no
// benefit (the code cannot run on Chrome anyway) and broke the stated 112+
// floor.
// ============================================================

describe("manifest background wiring (Firefox MV3)", () => {
  it("declares background.scripts", () => {
    expect(manifest.background.scripts).toContain("background/service-worker.js");
  });

  it("does not declare the Chrome-only service_worker key", () => {
    expect(manifest.background).not.toHaveProperty("service_worker");
  });

  it("is a module background", () => {
    expect(manifest.background.type).toBe("module");
  });

  it("declares a Firefox version floor that supports its required features", () => {
    const manifestWithGecko = JSON.parse(
      readFileSync(resolve(here, "..", "manifest.json"), "utf8")
    ) as {
      browser_specific_settings?: { gecko?: { strict_min_version?: string } };
    };
    const floor = manifestWithGecko.browser_specific_settings?.gecko?.strict_min_version;
    expect(floor).toBeDefined();
    // :has() ships enabled-by-default in Firefox 121. The pre-paint CSS layer
    // depends on it; older versions fall back to JS but flicker.
    expect(Number.parseInt(floor!, 10)).toBeGreaterThanOrEqual(121);
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
    "dist/ manifest resolves the Firefox background file",
    () => {
      const d = JSON.parse(readFileSync(distManifestPath, "utf8")) as {
        background: { service_worker?: string; scripts: string[] };
      };
      expect(d.background.scripts).toEqual(["background/service-worker.js"]);
      expect(d.background).not.toHaveProperty("service_worker");
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

describe("manifest engine-host alignment", () => {
  const blocks = manifest.content_scripts;
  const preload = blocks.find((b) => b.js.some((f) => f.includes("preload")))!;
  const mainFor = (needle: string) =>
    blocks.find(
      (b) => b.js.some((f) => f.includes("index.js")) && b.matches.some((m) => m.includes(needle))
    )!;
  const googleMain = mainFor("google.");
  const yandexMain = mainFor("yandex.");

  const pattern = (host: string) => `*://*.${host}/*`;

  it("preload coverage equals the union of every main script's coverage", () => {
    // Drift here splits the two halves of the extension: the preload hides a
    // result at document_start but no index.js ever runs to place a button,
    // or index.js runs with preload CSS absent (flicker). Neither failure is
    // visible on any other test.
    const preloadSet = new Set(preload.matches);
    const mainUnion = new Set(blocks.filter((b) => b !== preload).flatMap((b) => b.matches));
    expect([...mainUnion].filter((m) => !preloadSet.has(m))).toEqual([]);
    expect([...preloadSet].filter((m) => !mainUnion.has(m))).toEqual([]);
  });

  it("covers every Google host the adapter recognizes, in both scripts", () => {
    for (const host of GOOGLE_HOSTS) {
      expect(preload.matches, `preload missing ${host}`).toContain(pattern(host));
      expect(googleMain.matches, `Google main script missing ${host}`).toContain(pattern(host));
    }
  });

  it("covers every Yandex host the adapter recognizes, in both scripts", () => {
    // Yandex's adapter list used to be more than twice the manifest list, so
    // detection claimed support for portals where no content script ever ran.
    for (const host of YANDEX_HOSTS) {
      expect(preload.matches, `preload missing ${host}`).toContain(pattern(host));
      expect(yandexMain.matches, `Yandex main script missing ${host}`).toContain(pattern(host));
    }
  });
});

describe("release version consistency", () => {
  it("keeps manifest, package.json and package-lock.json in step", () => {
    // The release workflow bumps all three together, but a manual bump (or a
    // failed lock update) can leave AMO, npm and the source zip disagreeing.
    // The lockfile's root entry is what `npm ci` reports and what reviewers
    // compare against manifest.json.
    const root = resolve(here, "..");
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      version: string;
    };
    const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8")) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };

    expect(pkg.version).toBe(manifest.version);
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages[""]?.version).toBe(manifest.version);
  });
});

describe("host permission parity", () => {
  it("grants host_permissions for exactly the preload match list", () => {
    // BEFORE the host-list expansion these two arrays were byte-for-byte the
    // same 60 patterns. Expanding content_scripts.matches without
    // regenerating host_permissions leaves ~169 origins injected but
    // unprivileged for any extension-origin operation, and keeps 9 orphaned
    // bare-host Yandex patterns nobody needs. Pin the invariant here so the
    // next host addition cannot drift silently again.
    const preload = manifest.content_scripts.find((b) =>
      b.js.some((f) => f.includes("preload"))
    )!;
    const missing = preload.matches.filter((m) => !manifest.host_permissions.includes(m));
    const orphaned = manifest.host_permissions.filter((m) => !preload.matches.includes(m));
    expect(missing).toEqual([]);
    expect(orphaned).toEqual([]);
  });
});
