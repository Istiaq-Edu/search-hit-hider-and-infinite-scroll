// ============================================================
// real-browser-check.mjs — run the SHIPPED preload against the SHIPPED CSS in a
// real browser engine, on a hostname that makes the extension believe it is on
// Google.
//
// WHY THIS EXISTS
// ---------------
// Every other verification in this repo runs in jsdom, which has NO CSS cascade,
// no layout and no paint. The audit harness (`reports/showhide-audit/harness/
// visibility.ts`) SIMULATES display/opacity with a hand-written model — and that
// model is known to be imperfect (inline importance not modelled; first-match
// instead of specificity; a `hidingChain(node,node)` step that checks only self
// while its docstring claims "self + ancestors"). So "the fix works" rested on a
// model of the cascade rather than on the cascade itself.
//
// This closes that: a real engine computes the real cascade for the real
// `preload.css`, and the real `dist/content/preload.js` runs against a fake
// Google SERP. `--host-resolver-rules` maps www.google.com onto a local server
// so `location.hostname` really is `www.google.com` — the preload's `isGoogle`
// gate, the switch the entire cover hangs off, is genuinely ON.
//
// Chrome is launched THROUGH A SHELL on purpose: spawning the exe directly from
// Node fails with EBUSY on this machine (measured), while the identical command
// line from a shell works.
//
// USAGE
//   node reports/showhide-audit/real-browser-check.mjs <preload.js> [label]
// ============================================================

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

const PRELOAD = resolve(process.argv[2] ?? resolve(REPO, "dist/content/preload.js"));
const LABEL = process.argv[3] ?? "fixed";
const CSS = readFileSync(resolve(REPO, "src/content/preload.css"), "utf8");
const PRELOAD_JS = readFileSync(PRELOAD, "utf8");
// Resolved at run time so this file carries no machine-specific path. Override
// with SHH_CHROME when Chrome lives somewhere unusual.
const CHROME =
  process.env.SHH_CHROME ??
  (process.platform === "win32"
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
    : process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "google-chrome");

const BLOCKED = "blocked.com";

/** A fake Google SERP covering every shape the fix has to handle. */
const SERP = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/preload.css">
</head><body>
<div id="rso">
  <div class="MjjYud"><div class="g" data-case="safe">
    <a href="https://safe.com/p"><h3>safe</h3></a><cite>safe.com</cite></div></div>

  <div class="MjjYud"><div class="g" data-case="blocked">
    <a href="https://${BLOCKED}/p"><h3>blocked</h3></a><cite>${BLOCKED}</cite></div></div>

  <div class="MjjYud"><div class="tF2Cxc" data-case="section">
    <div class="kb0PBd"><a href="https://sec-a.com/p"><h3>a</h3></a></div>
    <div class="kb0PBd"><a href="https://sec-b.com/p"><h3>b</h3></a></div></div></div>

  <div class="MjjYud"><div class="tF2Cxc" data-case="shell">
    <div class="kb0PBd">Loading</div></div></div>
</div>
<pre id="report">PENDING</pre>

<script>
localStorage.setItem("_shh_cache", JSON.stringify({
  domains: ["${BLOCKED}"], wildcard: true, paused: false, debug: false
}));
window.browser = { runtime: { getManifest: () => ({ version: "real-browser-check" }) } };
</script>
<script src="/preload.js"></script>
<script>
const lines = [];
function probe() {
  const out = [];
  for (const el of document.querySelectorAll("[data-case]")) {
    const cs = getComputedStyle(el);
    out.push(
      el.getAttribute("data-case").padEnd(8) +
      " opacity=" + cs.opacity +
      " display=" + cs.display +
      " ok=" + (el.hasAttribute("data-shh-ok") ? "Y" : "n") +
      " pre=" + (el.hasAttribute("data-shh-preloaded") ? "Y" : "n") +
      " active=" + (document.documentElement.hasAttribute("data-shh-active") ? "Y" : "n")
    );
  }
  return out.join("\\n");
}
function say(tag) { lines.push("--- " + tag + " ---"); lines.push(probe()); }

// t=400: right after the synchronous preload pass.
setTimeout(() => say("t=400  immediate"), 400);
// t=2200: past the PRE-EXISTING 2s safety net (revealRemainingGoogle). This row
// is NOT discriminating for the trailing sweep — the 2s net is a blanket sweep
// that stamps everything. Kept because it shows the 2s net doing its job.
setTimeout(() => say("t=2200 after the pre-existing 2s safety net"), 2200);

// t=3000: inject a node AFTER every discrete reveal pass has already fired.
// This is the ONLY situation in which the new trailing sweep has unique value,
// and therefore the only row that can distinguish it from the 2s net.
setTimeout(() => {
  const w = document.createElement("div");
  // MUST be a LINKLESS SHELL, not a section. A section-shaped late node is
  // revealed instantly by the section guard, which makes the row useless for
  // isolating the trailing sweep (measured: the first version of this fixture
  // was a section and the sweep looked redundant). A shell with no anchor takes
  // the no-external-link exit — the only path the sweep exists for.
  w.innerHTML = '<div class="MjjYud"><div class="tF2Cxc" data-case="late">' +
    '<div class="kb0PBd">Loading</div></div></div>';
  document.getElementById("rso").appendChild(w.firstElementChild);
}, 3000);
setTimeout(() => say("t=3300 late node, immediately after insertion"), 3300);
setTimeout(() => {
  say("t=4700 late node, after the 1200ms trailing sweep");
  lines.push("END");
  document.getElementById("report").textContent = lines.join("\\n");
}, 4700);
</script>
</body></html>`;

// ── This script only GENERATES the site. ─────────────────────────────────
// It deliberately does not launch the browser: on this machine Node cannot
// spawn an .exe at all (spawnSync -> EBUSY, and execSync -> cmd.exe EBUSY), so
// the browser and the HTTP server are driven from `real-browser-check.sh`
// instead. Keeping the two apart also makes this file re-runnable by hand.
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = resolve(process.argv[4] ?? resolve(REPO, ".tmp-cascade/site"));
mkdirSync(OUT, { recursive: true });
// Report FIRST in the body so it is visible in a screenshot.
const FF = SERP.replace('<div id="rso">', '<img src="/slow" alt="">\n<div id="rso">')
              .replace('<pre id="report">', '<pre id="report" style="font:20px/1.5 monospace">');
writeFileSync(resolve(OUT, "index.html"), SERP);
writeFileSync(resolve(OUT, "ff.html"), FF);
writeFileSync(resolve(OUT, "preload.css"), CSS);
writeFileSync(resolve(OUT, "preload.js"), PRELOAD_JS);

console.log(`[generate] ${OUT}  label=${LABEL}`);
console.log(`[generate] index.html=${SERP.length}B preload.css=${CSS.length}B preload.js=${PRELOAD_JS.length}B`);
