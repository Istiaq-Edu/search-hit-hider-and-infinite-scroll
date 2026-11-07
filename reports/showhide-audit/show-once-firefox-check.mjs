// ============================================================
// show-once-firefox-check.mjs — REAL-GECKO regression check for
// "clicking Show reveals SOME blocked results in a batch, not others".
//
// WHY THIS EXISTS
// ---------------
// jsdom has no CSS cascade, no layout and no MutationObserver-driven CSS
// re-evaluation. Both halves of this bug are properties of the real cascade:
//   * a marker-free `:has(){display:none!important}` adopted-sheet rule keeps
//     hiding an INNER div.g even after showOnce() sets inline display:block on
//     the OUTER wrapper (display does not inherit);
//   * the preload's MutationObserver re-hides that inner node in the post-click
//     microtask, reading showOnce's deliberate marker removal as a page strip.
//
// This boots the SHIPPED dist/content/preload.js + src/content/preload.css in
// real Firefox, builds two result shapes from one batch, replays hideResult()/
// showOnce(), and reads getComputedStyle — the actual cascade, not a model.
//
// USAGE
//   npm run build
//   node reports/showhide-audit/show-once-firefox-check.mjs
//   SHH_FIREFOX="C:/path/to/firefox.exe" node ...   # override binary
//
// Firefox Developer Edition is the default on Windows (it is what the field
// repro was run against). A fresh temp profile is created per run so a previous
// headless process cannot hold a lock.
// ============================================================

import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

const FF = process.env.SHH_FIREFOX ??
  (process.platform === "win32"
    ? "C:/Program Files/Firefox Developer Edition/firefox.exe"
    : "firefox");
const PROFILE = resolve(tmpdir(), `shh-show-once-${process.pid}-${Date.now()}`);

const CSS = readFileSync(resolve(REPO, "src/content/preload.css"), "utf8");
const PRELOAD_JS = readFileSync(resolve(REPO, "dist/content/preload.js"), "utf8");
const BLOCKED = "blocked.com";

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/preload.css"></head><body>
<div id="rso"></div><pre id="out">waiting</pre>
<script>
localStorage.setItem("_shh_cache", JSON.stringify({domains:["${BLOCKED}"],wildcard:true,paused:false}));
window.browser = { runtime: { getManifest: () => ({version:"show-once-check"}) } };
</script>
<script src="/preload.js"></script>
<script>
const BLOCKED = "${BLOCKED}";
const rows = [];
window.addEventListener("error", e => rows.push({tag:"PAGE-ERROR", message:String(e.message)}));
function snap(tag) {
  const out = { tag };
  for (const name of ["flat", "nested"]) {
    const wrap = document.querySelector('[data-case="' + name + '"]');
    const inner = wrap.querySelector("[data-inner]") || wrap;
    const cs = getComputedStyle(inner);
    out[name] = {
      display: cs.display,
      preloaded: inner.hasAttribute("data-shh-preloaded"),
      inlineDisplay: inner.style.getPropertyValue("display")
    };
  }
  const hasRules = [];
  for (const s of document.adoptedStyleSheets) {
    try { for (const r of Array.from(s.cssRules)) if (r.cssText.indexOf(":has(") !== -1) hasRules.push(r.cssText); } catch (e) {}
  }
  out.hasRuleCount = hasRules.length;
  out.hasExemption = (hasRules[0] || "").indexOf('data-shh-mode="shown-once"') !== -1;
  out.complexNotSupported = CSS.supports("selector(div:not([data-x] *))");
  rows.push(out);
}

// Faithful replay of hideResult() + showOnce() from src/content/blocking/hider.ts.
function hideResult(node) {
  node.setAttribute("data-shh-result", "block");
  node.classList.add("shh-hidden");
  node.style.setProperty("display", "none", "important");
  const ph = document.createElement("div");
  ph.setAttribute("data-shh-placeholder", "true");
  node.parentElement.insertBefore(ph, node);
}
function showOnce(node) {
  node.style.setProperty("display", "block", "important");
  node.removeAttribute("data-shh-preloaded");
  node.querySelectorAll("[data-shh-preloaded]").forEach(function (inner) {
    inner.style.removeProperty("display");
    inner.removeAttribute("data-shh-preloaded");
    inner.classList.remove("shh-hidden");
  });
  node.classList.remove("shh-hidden");
  node.classList.add("shh-shown-result");
  node.style.setProperty("opacity", "1", "important");
  node.style.setProperty("pointer-events", "auto", "important");
  // hider.ts gates the cover stamp on isGoogleHost(node); this page is on
  // 127.0.0.1, so the shipped code would NOT stamp it here.
  node.setAttribute("data-shh-mode", "shown-once");
  const bar = document.createElement("div");
  bar.className = "shh-shown-notice";
  node.insertBefore(bar, node.firstChild);
}
function buildSerp() {
  const rso = document.getElementById("rso");
  rso.innerHTML =
    '<div class="MjjYud"><div class="g" data-case="flat">' +
      '<a href="https://' + BLOCKED + '/p"><h3>flat</h3></a><cite>' + BLOCKED + '</cite>' +
      '<div class="VwiC3b">snippet</div></div></div>' +
    '<div class="MjjYud"><div class="tF2Cxc" data-case="nested">' +
      '<div class="N54PNb"><div class="g" data-inner="1">' +
      '<a href="https://' + BLOCKED + '/p"><h3>nested</h3></a><cite>' + BLOCKED + '</cite>' +
      '<div class="VwiC3b">snippet</div></div></div></div></div>';
  return {
    flat: rso.querySelector('[data-case="flat"]'),
    nested: rso.querySelector('[data-case="nested"]')
  };
}
var sent = false;
function send() {
  if (sent) return;
  sent = true;
  fetch("/report", {method:"POST", headers:{"content-type":"text/plain"},
    body: JSON.stringify({rows})}).catch(function(){});
}
setTimeout(send, 4000);

window.addEventListener("load", function () {
  const nodes = buildSerp();
  setTimeout(function () {
    snap("after-preload");
    hideResult(nodes.flat); hideResult(nodes.nested);
    snap("hidden");
    showOnce(nodes.flat); showOnce(nodes.nested);
    snap("show-immediately");
    setTimeout(function () {
      snap("show-after-observer");
      // Isolate the marker-free :has() layer: clear markers + inline style,
      // then force a synchronous style recalc BEFORE the observer's microtask.
      const inner = document.querySelector("[data-inner]");
      inner.removeAttribute("data-shh-preloaded");
      inner.style.removeProperty("display");
      rows.push({tag:"has-layer-isolated", displayNoMarkers: getComputedStyle(inner).display});
      // Hide Again / Unblock / Perma drop the marker: hiding must re-arm.
      nodes.nested.removeAttribute("data-shh-mode");
      nodes.nested.classList.remove("shh-shown-result");
      rows.push({tag:"hide-again-rearms", display: getComputedStyle(inner).display});
      setTimeout(send, 60);
    }, 120);
  }, 120);
});
</script></body></html>`;

mkdirSync(PROFILE, { recursive: true });
writeFileSync(resolve(PROFILE, "user.js"), [
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("browser.startup.homepage", "about:blank");',
  'user_pref("toolkit.telemetry.enabled", false);',
  'user_pref("browser.sessionstore.resume_from_crash", false);',
].join("\n"));

// Port 0 = pick a free port so parallel runs never collide; spawn Firefox only
// once the resolved port is known.
let ff = null;
let received = false;

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/report") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      res.writeHead(204); res.end();
      ff?.kill();
      server.close();
      report(JSON.parse(body).rows);
    });
    return;
  }
  if (req.url === "/preload.css") { res.writeHead(200, {"content-type":"text/css"}); res.end(CSS); return; }
  if (req.url === "/preload.js") { res.writeHead(200, {"content-type":"text/javascript"}); res.end(PRELOAD_JS); return; }
  res.writeHead(200, {"content-type":"text/html; charset=utf-8"});
  res.end(PAGE);
});

function report(rows) {
  received = true;
  if (!rows || rows.length === 0) {
    // The 4 s fallback fired before any probe ran — the page never got to the
    // measurement stage (slow load, script error before the handlers, …).
    // A wall of "FAIL undefined" checks would misdirect that diagnosis.
    console.error("TIMEOUT — page reported no probe rows (load or script failure)");
    process.exitCode = 1;
    cleanup();
    return;
  }
  const at = tag => rows.find(r => r.tag === tag);
  const errors = rows.filter(r => r.tag === "PAGE-ERROR");
  const checks = [
    ["no page script errors", errors.length === 0],
    ["preload hid both results before Show",
      at("after-preload")?.flat.display === "none" && at("after-preload")?.nested.display === "none"],
    ["flat result is visible after Show", at("show-immediately")?.flat.display === "block"],
    ["nested result is visible after Show (THE BUG)", at("show-immediately")?.nested.display === "block"],
    ["observer did NOT re-hide the nested result",
      at("show-after-observer")?.nested.display === "block" &&
      at("show-after-observer")?.nested.preloaded === false],
    ["marker-free :has() layer is lifted", at("has-layer-isolated")?.displayNoMarkers === "block"],
    ["Hide Again re-arms the hide", at("hide-again-rearms")?.display === "none"],
    [":has() rule was built and carries the shown-once exemption",
      at("show-immediately")?.hasRuleCount === 1 && at("show-immediately")?.hasExemption === true],
    ["Firefox supports complex :not()", at("show-immediately")?.complexNotSupported === true],
  ];
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log((ok ? "  PASS  " : "  FAIL  ") + label);
    if (!ok) failed++;
  }
  if (errors.length) console.log("  page errors:", errors.map(e => e.message).join(" | "));
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
  cleanup();
}

// Port 0 = pick a free one, so parallel runs never collide.
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  console.log("Firefox Developer Edition: booting shipped preload on two result shapes...");
  ff = spawn(FF, [
    "--headless", "--no-remote", "--new-instance", "--profile", PROFILE,
    `http://127.0.0.1:${port}/`,
  ], { stdio: "ignore", windowsHide: true });
  ff.on("error", e => {
    console.error("Firefox launch failed: " + e.message + "\nSet SHH_FIREFOX to the firefox.exe path.");
    server.close();
    cleanup();
    process.exitCode = 1;
  });
});

function cleanup() {
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* temp dir */ }
}

// `received` is set by report(); keep a hard deadline so a broken page cannot hang CI.
setTimeout(() => {
  if (!received && process.exitCode === undefined) {
    console.error("TIMEOUT — no report received from Firefox");
    ff?.kill(); server.close(); cleanup(); process.exitCode = 1;
  }
}, 25000);
