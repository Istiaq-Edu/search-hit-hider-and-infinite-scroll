import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ============================================================
// Sourcemaps must be LINKED, not merely present
// ============================================================
//
// A field report can only cite a minified frame — `preload.js:2:1870` — which is
// useless unless the map is actually wired to the bundle.
//
// The subtle part, verified empirically rather than assumed: esbuild's
// `sourcemap: "external"` WROTE the .map files but emitted no
// `//# sourceMappingURL=` comment. DevTools does not auto-discover a map sitting
// next to a bundle, so every shipped .map was orphaned and every field frame
// stayed unactionable. The build comment even claimed "Firefox DevTools picks
// these up automatically", which was simply false. `sourcemap: "linked"` writes
// the same external map AND the comment, which is the difference.
//
// So the assertions below check the LINK, not the file's existence — a test that
// only asserted `.map` files exist would have passed on the broken build.
// ============================================================

const root = process.cwd();

function bundleFor(rel: string): string {
  return readFileSync(resolve(root, "dist", rel), "utf8");
}

const ENTRIES = [
  "content/index.js",
  "content/preload.js",
  "background/service-worker.js",
];

describe("release sourcemaps are linked to their bundles", () => {
  for (const entry of ENTRIES) {
    it(`${entry} carries a sourceMappingURL comment`, () => {
      // The whole defect. `sourcemap: "external"` passes the file check below and
      // fails this one.
      const js = bundleFor(entry);
      const m = js.match(/^\/\/# sourceMappingURL=(.+)$/m);
      expect(m, `${entry} has no //# sourceMappingURL comment — its map is orphaned`).not.toBeNull();
      // Relative to the BUNDLE's own directory, so just the basename. Asserting a
      // repo-root-relative path here would be asserting esbuild's cwd, not the
      // link's correctness — and a map written next to the bundle is exactly what
      // DevTools resolves.
      expect(m![1]).toBe(entry.split("/").pop()!.replace(/\.js$/, ".js.map"));
    });
  }

  it("the map each bundle points at actually exists", () => {
    for (const entry of ENTRIES) {
      const js = bundleFor(entry);
      const m = js.match(/^\/\/# sourceMappingURL=(.+)$/m);
      expect(m).not.toBeNull();
      const mapName = m![1] as string;
      const mapPath = resolve(root, "dist", entry, "..", mapName);
      expect(existsSync(mapPath), `missing map ${mapName}`).toBe(true);
      // and it parses, and lists real sources rather than an empty index
      const map = JSON.parse(readFileSync(mapPath, "utf8"));
      expect(map.sources.length).toBeGreaterThan(0);
      expect(map.mappings.length).toBeGreaterThan(0);
    }
  });

  it("resolves a real field frame back to a TypeScript source line", () => {
    // The end-to-end property: a frame the user would actually paste must land on
    // the source line that emitted it. Without this, a map can be present, valid,
    // and still useless (e.g. pointing at a stale or wrong offset).
    const js = bundleFor("content/index.js");
    // An ASCII literal that survives minification because identifiers are mangled
    // but string constants are not.
    const needle = "data-shh-alive";
    const at = js.indexOf(needle);
    expect(at).toBeGreaterThan(-1);

    let line = 1, col = 0;
    for (let i = 0; i < at; i++) {
      if (js[i] === "\n") { line++; col = 0; } else { col++; }
    }

    const mapPath = resolve(root, "dist/content/index.js.map");
    const map = JSON.parse(readFileSync(mapPath, "utf8"));

    // Minimal VLQ decode — enough to walk the segment list.
    const CH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const decodeVLQ = (s: string): number[] => {
      const out: number[] = [];
      let shift = 0, value = 0;
      for (const ch of s) {
        const d = CH.indexOf(ch);
        if (d < 0) throw new Error("bad vlq char");
        value += (d & 31) << shift;
        if (d & 32) { shift += 5; } else {
          const neg = value & 1;
          value >>= 1;
          out.push(neg ? -value : value);
          value = 0; shift = 0;
        }
      }
      return out;
    };

    let genLine = 0, genCol = 0, sIdx = 0, sLine = 0, sCol = 0;
    let best: { src: string; line: number } | null = null;
    for (const ml of map.mappings.split(";")) {
      genCol = 0;
      for (const seg of ml.split(",")) {
        if (!seg) continue;
        const f = decodeVLQ(seg);
        genCol += f[0] ?? 0;
        if (f.length >= 4) {
          // `noUncheckedIndexedAccess` is on, so each field is `number | undefined`.
          // A segment with 4+ fields always has all four; assert rather than
          // silence, because a segment short of that would silently mis-map.
          if (f[1] === undefined || f[2] === undefined || f[3] === undefined) {
            throw new Error("malformed sourcemap segment");
          }
          sIdx += f[1]; sLine += f[2]; sCol += f[3];
        }
        if (genLine + 1 === line && genCol <= col) {
          best = { src: map.sources[sIdx], line: sLine + 1 };
        }
      }
      genLine++;
    }
    expect(best, "no mapping covered the frame").not.toBeNull();

    // Map sources are relative to the map file's directory (dist/content).
    const srcPath = resolve(root, "dist/content", best!.src);
    expect(existsSync(srcPath), `map points at a source that does not exist: ${best!.src}`).toBe(true);

    const srcLines = readFileSync(srcPath, "utf8").split("\n");
    const text = (srcLines[best!.line - 1] ?? "").trim();
    expect(text, `frame ${needle} resolved to a line without the literal`).toContain(needle);
  }, 30000);
});
