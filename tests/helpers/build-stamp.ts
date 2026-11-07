import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// build.js stamps every bundle `v<manifest version>+<sha256 of source bytes>`
// (see build.js BUILD_STAMP). The version moves on every release, so the
// expected stamp must be DERIVED from manifest.json. Hardcoding a series
// (the old /v1\.8\.\d+/ literals) fails the release workflow the moment the
// minor version moves — three tests broke the v1.9.0 release run that way.
const here = dirname(fileURLToPath(import.meta.url));
const VERSION = (
  JSON.parse(
    readFileSync(resolve(here, "..", "..", "manifest.json"), "utf8")
  ) as { version: string }
).version;

const ESCAPED = VERSION.replace(/\./g, "\\.");

/** Matches the stamp build.js embeds, e.g. /v1\.8\.21\+[0-9a-f]{8}/. */
export const BUILD_STAMP = new RegExp(`v${ESCAPED}\\+[0-9a-f]{8}`);

/** The 7-hex `-dirty` form must never appear in a shipped bundle. */
export const DIRTY_STAMP = new RegExp(`v${ESCAPED}\\+[0-9a-f]{7}-dirty`);
