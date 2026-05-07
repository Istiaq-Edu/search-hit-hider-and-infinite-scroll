#!/usr/bin/env node
// Resizes icon-source.png to all required Firefox extension icon sizes using sharp.
// Run: node generate-icons.mjs

import { createRequire } from "module";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SIZES = [16, 32, 48, 96, 128];
const OUT_DIR = join(__dirname, "src/assets/icons");
const SOURCE = join(OUT_DIR, "icon-source.png");

async function generateIcons() {
  if (!existsSync(SOURCE)) {
    console.error("icon-source.png not found at", SOURCE);
    process.exit(1);
  }

  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    console.error("sharp not installed. Run: npm install --save-dev sharp");
    process.exit(1);
  }

  for (const size of SIZES) {
    const outPath = join(OUT_DIR, `icon-${size}.png`);
    await sharp(SOURCE)
      .resize(size, size, { fit: "cover", position: "centre" })
      .png()
      .toFile(outPath);
    console.log(`✓ icon-${size}.png`);
  }

  console.log("All icons generated from icon-source.png.");
}

generateIcons().catch((err) => {
  console.error("Icon generation failed:", err);
  process.exit(1);
});
