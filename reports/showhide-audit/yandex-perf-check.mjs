// Yandex slowness investigation — A/B measurement in real Firefox.
//
// Modes (via ?mode=):
//   base          no extension scripts — pure page churn
//   observer-only shipped preload.js with an EMPTY block list
//                 (observer + selector work, no :has() rules, nothing hidden)
//   full          shipped preload.js with a realistic block list
//                 (+ :has() adopted sheet + inline hides)
//
// Metrics per mode:
//   - selector-API call counts / ms (querySelectorAll/matches/closest wrapped)
//   - rAF frame deltas: p50 / p95 / max, frames over 50 ms (main-thread jank)
//   - long tasks (PerformanceObserver, if the engine reports them)
//   - final DOM/hide/UI counts
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const PORT = 8768;
const FF = process.env.SHH_FIREFOX ??
  (process.platform === "win32"
    ? "C:/Program Files/Firefox Developer Edition/firefox.exe"
    : "firefox");
const PROFILE = resolve(tmpdir(), `shh-yx-${process.pid}-${Date.now()}`);
const MODES = ["base", "observer-only", "full"];
// Exposed to the page so it can chain modes.
const MODES_JS = JSON.stringify(MODES);
// Scale knobs (env): RESULTS, DOMAINS, CHURN_MS, RUN_MS.
const N_RESULTS = Number(process.env.RESULTS ?? 40);
const N_DOMAINS = Number(process.env.DOMAINS ?? 10);
const CHURN_MS = Number(process.env.CHURN_MS ?? 200);
const RUN_MS = Number(process.env.RUN_MS ?? 10000);
const PRELOAD_JS = readFileSync(resolve(REPO, "dist/content/preload.js"), "utf8");
const INDEX_JS = readFileSync(resolve(REPO, "dist/content/index.js"), "utf8");
const CSS = readFileSync(resolve(REPO, "src/content/preload.css"), "utf8");

const RESULTS = N_RESULTS;
const li = (i) => `
  <li class="serp-item" data-i="${i}"><div class="Organic">
    <a class="OrganicTitle-Link" href="https://site${i}.com/page${i}"><h2>Result ${i}</h2></a>
    <div class="Path"><span class="Path-Item">site${i}.com</span></div>
    <div class="OrganicText">snippet text for result ${i} with some length to it</div>
  </div></li>`;

const page = (mode) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/preload.css"></head><body>
<div id="serp"><ul id="search-result" class="serp-list serp-list_left_yes">
${Array.from({ length: RESULTS }, (_, i) => li(i)).join("")}
</ul></div><pre id="out">waiting</pre>
<script>
// ── selector instrumentation FIRST ──────────────────────────────────
const MODES = ${MODES_JS};
window.__sel = { calls: 0, ms: 0, byApi: {} };
function wrap(obj, name) {
  const orig = obj[name];
  if (!orig) return;
  obj[name] = function (...args) {
    const t0 = performance.now();
    try { return orig.apply(this, args); }
    finally {
      const dt = performance.now() - t0;
      window.__sel.calls++; window.__sel.ms += dt;
      window.__sel.byApi[name] = (window.__sel.byApi[name] || 0) + 1;
    }
  };
}
wrap(Document.prototype, "querySelectorAll");
wrap(Document.prototype, "querySelector");
wrap(Element.prototype, "querySelectorAll");
wrap(Element.prototype, "querySelector");
wrap(Element.prototype, "matches");
wrap(Element.prototype, "closest");

window.__frames = [];
let last = performance.now();
function tick(t) {
  window.__frames.push(t - last); last = t;
  if (!window.__done) requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
window.__longtasks = 0;
try {
  new PerformanceObserver(function (list) { window.__longtasks += list.getEntries().length; })
    .observe({ entryTypes: ["longtask"] });
} catch (e) {}

// ── block list per mode ─────────────────────────────────────────────
const domains = ${mode === "observer-only" ? "[]" : JSON.stringify(
  Array.from({ length: N_DOMAINS }, (_, i) => "site" + (i * 3) + ".com")
)};
localStorage.setItem("_shh_cache", JSON.stringify({
  domains, wildcard: true, paused: false
}));
window.browser = {
  runtime: {
    getManifest: function () { return { version: "yx-measure" }; },
    id: "t",
    onMessage: { addListener: function () {} },
    sendMessage: async function (m) {
      if (m && m.type === "GET_LIST") return { entries: window.__entries };
      return { prefs: window.__prefs };
    }
  },
  storage: {
    local: { get: async function () { return { shh_entries: window.__entries }; }, set: async function () {} },
    sync: { get: async function () { return { shh_prefs: window.__prefs }; }, set: async function () {} }
  }
};
window.__entries = domains.map(function (d) {
  return { domain: d, mode: "block", enabled: true, createdAt: 0 };
});
window.__prefs = {
  debugMode: false, subdomainWildcard: true, pausedGlobally: false,
  pausedEngines: [], engineToggles: { yandex: true },
  showNotices: true, showOnHover: false, infiniteScroll: false
};
</script>
${mode === "base" ? "" : '<script src="/preload.js"></script>'}
${mode === "full" ? '<script src="/index.js"></script>' : ""}
<script>
// ── Yandex-like churn ───────────────────────────────────────────────
window.__cycles = 0;
function freshItem(i) {
  // Fresh markup — NOT cloneNode — so any extension UI the page's framework
  // would discard is genuinely gone and the observers must re-evaluate.
  return '<li class="serp-item"><div class="Organic">' +
    '<a class="OrganicTitle-Link" href="https://site' + i + '.com/page' + i +
    '?v=' + Math.random().toString(36).slice(2, 6) + '"><h2>Result ' + i + '</h2></a>' +
    '<div class="Path"><span class="Path-Item">site' + i + '.com</span></div>' +
    '<div class="OrganicText">snippet ' + i + '</div></div></li>';
}
function churn() {
  const list = document.getElementById("search-result");
  const items = list.querySelectorAll("li.serp-item");
  // 1. re-render random result cards (React-style: fresh elements)
  for (let k = 0; k < ${Math.max(4, Math.round(N_RESULTS / 10))}; k++) {
    const idx = Math.floor(Math.random() * items.length);
    const old = items[idx];
    const wrap = document.createElement("div");
    wrap.innerHTML = freshItem(Math.floor(Math.random() * ${N_RESULTS}));
    list.replaceChild(wrap.firstChild, old);
  }
  // 2. rewrite hrefs on 8 existing links
  const links = list.querySelectorAll("a.OrganicTitle-Link");
  for (let k = 0; k < 8; k++) {
    const a = links[Math.floor(Math.random() * links.length)];
    if (a) a.setAttribute("href", a.getAttribute("href") + "&r=" + Math.random().toString(36).slice(2, 6));
  }
  // 3. two brand-new result cards
  const n = ${RESULTS} + Math.floor(Math.random() * 1000);
  list.insertAdjacentHTML("beforeend",
    '<li class="serp-item"><div class="Organic">' +
    '<a class="OrganicTitle-Link" href="https://new' + n + '.com/x"><h2>New ' + n + '</h2></a>' +
    '<div class="Path"><span class="Path-Item">new' + n + '.com</span></div></div></li>');
  // 4. decorative non-result churn (widgets, counters)
  const w = document.createElement("div");
  w.className = "widget"; w.textContent = "w" + Math.random();
  document.getElementById("serp").appendChild(w);
  window.__cycles++;
}
const CHURN_MS = ${CHURN_MS}, RUN_MS = ${RUN_MS};
const timer = setInterval(churn, CHURN_MS);
setTimeout(function () {
  window.__done = true;
  clearInterval(timer);
  setTimeout(function () {
    const f = window.__frames.slice(2).sort(function (a, b) { return a - b; });
    const p = q => f.length ? Math.round(f[Math.floor(q * (f.length - 1))]) : -1;
    fetch("/report", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "${mode}",
        cycles: window.__cycles,
        selectorCalls: Math.round(window.__sel.calls),
        selectorMs: Math.round(window.__sel.ms),
        byApi: window.__sel.byApi,
        frames: f.length,
        jankOver50: f.filter(function (d) { return d > 50; }).length,
        p50: p(0.5), p95: p(0.95), max: f.length ? Math.round(f[f.length - 1]) : -1,
        longtasks: window.__longtasks,
        domNodes: document.getElementsByTagName("*").length,
        preloaded: document.querySelectorAll("[data-shh-preloaded]").length,
        buttons: document.querySelectorAll(".shh-block-btn").length,
        placeholders: document.querySelectorAll(".shh-placeholder").length
      })
    }).catch(function () {});
    // Chain to the next mode in the SAME browser instance.
    setTimeout(function () {
      const i = MODES.indexOf("${mode}");
      if (i >= 0 && i < MODES.length - 1) location.href = "/?mode=" + MODES[i + 1];
    }, 600);
  }, 300);
}, RUN_MS);
</script></body></html>`;

let results = [];
const server = createServer((req, res) => {
  if (process.env.YX_DEBUG) console.log("[req] " + req.method + " " + req.url);
  const u = new URL(req.url, "http://x");
  if (req.method === "POST" && u.pathname === "/report") {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      results.push(JSON.parse(b));
      console.log(JSON.stringify(results[results.length - 1]));
      res.writeHead(204); res.end();
      if (results.length === MODES.length) { ff.kill(); server.close(); summarize(); cleanup(); }
    });
    return;
  }
  if (u.pathname === "/preload.css") { res.writeHead(200, {"content-type":"text/css"}); res.end(CSS); return; }
  if (u.pathname === "/preload.js") { res.writeHead(200, {"content-type":"text/javascript"}); res.end(PRELOAD_JS); return; }
  if (u.pathname === "/index.js") { res.writeHead(200, {"content-type":"text/javascript"}); res.end(INDEX_JS); return; }
  const mode = u.searchParams.get("mode") ?? "base";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page(mode));
});

function summarize() {
  console.log("\n=== summary (lower is better) ===");
  const row = (m) => results.find((r) => r.mode === m) ?? {};
  const b = row("base"), o = row("observer-only"), f = row("full");
  console.log("jank>50ms      base=%s  observer=%s  full=%s", b.jankOver50, o.jankOver50, f.jankOver50);
  console.log("p95 frame ms   base=%s  observer=%s  full=%s", b.p95, o.p95, f.p95);
  console.log("max frame ms   base=%s  observer=%s  full=%s", b.max, o.max, f.max);
  console.log("longtasks      base=%s  observer=%s  full=%s", b.longtasks, o.longtasks, f.longtasks);
  console.log("selector calls base=%s  observer=%s  full=%s", b.selectorCalls, o.selectorCalls, f.selectorCalls);
  console.log("selector ms    base=%s  observer=%s  full=%s", b.selectorMs, o.selectorMs, f.selectorMs);
  console.log("hidden nodes   observer=%s  full=%s", o.preloaded, f.preloaded);
}

mkdirSync(PROFILE, { recursive: true });
writeFileSync(resolve(PROFILE, "user.js"), [
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("toolkit.telemetry.enabled", false);',
  'user_pref("browser.sessionstore.resume_from_crash", false);',
  // Route everything through THIS server, which answers for any host — that is
  // what makes location.hostname genuinely yandex.ru, so engine detection and
  // the scoped :has() subjects run exactly as shipped.
  'user_pref("network.proxy.type", 1);',
  'user_pref("network.proxy.http", "127.0.0.1");',
  'user_pref("network.proxy.http_port", ' + PORT + ');',
  'user_pref("network.proxy.ssl", "127.0.0.1");',
  'user_pref("network.proxy.ssl_port", ' + PORT + ');',
  'user_pref("network.proxy.allow_hijacking_localhost", true);',
  'user_pref("dom.security.https_only_mode", false);',
  'user_pref("dom.security.https_only_mode_pbm", false);',
  'user_pref("browser.fixup.fallback-to-https", false);',
].join("\n"));

// --render <mode>: print the generated page and exit (no browser) — for
// syntax-checking the inline scripts without a browser round-trip.
const renderIdx = process.argv.indexOf("--render");
if (renderIdx !== -1) {
  process.stdout.write(page(process.argv[renderIdx + 1] ?? "full"));
  process.exit(0);
}

// Port 0 = pick a free one, so parallel runs never collide. The proxy prefs
// must name the RESOLVED port, so the profile is written after listen().
mkdirSync(PROFILE, { recursive: true });
function writeProfilePrefs(port) {
  writeFileSync(resolve(PROFILE, "user.js"), [
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
    'user_pref("browser.sessionstore.resume_from_crash", false);',
    // Route everything through THIS server, which answers for any host — that is
    // what makes location.hostname genuinely yandex.ru, so engine detection and
    // the scoped :has() subjects run exactly as shipped.
    'user_pref("network.proxy.type", 1);',
    'user_pref("network.proxy.http", "127.0.0.1");',
    `user_pref("network.proxy.http_port", ${port});`,
    'user_pref("network.proxy.ssl", "127.0.0.1");',
    `user_pref("network.proxy.ssl_port", ${port});`,
    'user_pref("network.proxy.allow_hijacking_localhost", true);',
    'user_pref("dom.security.https_only_mode", false);',
    'user_pref("dom.security.https_only_mode_pbm", false);',
    'user_pref("browser.fixup.fallback-to-https", false);',
  ].join("\n"));
}

function cleanup() {
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* temp dir */ }
}

const ff = spawn(FF, [
  "--headless", "--no-remote", "--new-instance", "--profile", PROFILE,
  `http://yandex.ru/search/?q=test&mode=base`,
], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
ff.stderr.on("data", d => { if (process.env.YX_DEBUG) console.log("[ff] " + String(d).trim().slice(0, 200)); });

ff.on("error", (e) => { console.error("launch failed: " + e.message); server.close(); cleanup(); process.exitCode = 1; });

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  writeProfilePrefs(port);
  console.log(`measuring ${MODES.join(" → ")} on :${port}`);
});

setTimeout(() => {
  if (results.length < MODES.length) {
    console.error("TIMEOUT — got " + results.length + "/" + MODES.length + " reports");
    ff.kill(); server.close(); cleanup(); process.exitCode = 1;
  }
}, MODES.length * (RUN_MS + CHURN_MS + 20000) + 30000);
