// ============================================================
// Yandex native-paging REAL GECKO harness.
//
// jsdom cannot answer the questions this change depends on:
//   * does an Xray-wrapped .click() fire the PAGE's listener?
//   * is event.isTrusted false (and is that accepted)?
//   * does a content-script MutationObserver see page-realm DOM writes?
//   * does the shipped bundle actually inject at document_end on a
//     yandex host, with the real manifest permissions?
//   * does the fail-open link really navigate?
//
// This boots the SHIPPED dist as a TEMPORARY ADD-ON in Firefox Developer
// Edition (web-ext run), maps www.yandex.com to a local server via DNS
// override, and drives six scenarios in one tab. Every observation is
// POSTed back by the page, INCLUDING page-world errors and the extension's
// own UI markers (proof the content script really executed).
//
// Usage:  node reports/showhide-audit/yandex-native-firefox.mjs
//         SHH_FIREFOX="C:/path/to/firefox.exe" node ...
//         SHH_VERBOSE=1 node ...   (print web-ext / Firefox output)
// ============================================================

import { createServer } from "node:http";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const FF = process.env.SHH_FIREFOX ??
  (process.platform === "win32"
    ? "C:/Program Files/Firefox Developer Edition/firefox.exe"
    : "firefox");
const WEBEXT = resolve(REPO, "node_modules/web-ext/bin/web-ext.js");
const PROFILE = resolve(tmpdir(), `shh-yx-native-${process.pid}-${Date.now()}`);
const VERBOSE = process.env.SHH_VERBOSE === "1";

const CASES = ["native", "observe", "nopager", "afterNav", "blocked", "late"];
const NEXT = {
  native: "observe",
  observe: "nopager",
  nopager: null, // navigates by CLICKING the fail-open link
  afterNav: "blocked",
  blocked: "late",
  late: null,
};
const RUN_MS = {
  native: 5200,
  observe: 4200,
  nopager: 2600,
  afterNav: 1800,
  blocked: 17000,
  late: 6500,
};

const RESULT = (i) => `
  <li class="serp-item"><div class="Organic">
    <h2><a class="OrganicTitle-Link" href="https://site${i}.com/x">Result ${i}</a></h2>
    <div class="Path"><span class="Path-Item">site${i}.com</span></div>
    <div class="OrganicText">snippet ${i}</div>
  </div></li>`;

function page(caseName, port) {
  const cfg = {
    case: caseName,
    next: NEXT[caseName],
    runMs: RUN_MS[caseName],
    port,
  };
  const CFG = JSON.stringify(cfg);

  // ── Markup per scenario ──────────────────────────────────────────────
  const continuous = caseName === "observe"
    ? `<div data-bem='{"infinite":{}}' id="continuous">`
    : "<div id=\"continuous\">";
  const pager = (caseName === "native" || caseName === "blocked")
    ? `<div class="pager"><a class="Pager-Item Pager-Item_type_next" ` +
      `href="/search/?text=cats&amp;p=1&amp;case=${caseName}">Next</a></div>`
    : "";
  const more = caseName === "native"
    ? `<button id="more" data-bem='{"b-more":{}}'>Показать ещё</button>`
    : "";

  // ── Page-realm behaviour per scenario ────────────────────────────────
  const behaviour = {
    native: `
      var more = document.getElementById("more");
      more.addEventListener("click", function (e) {
        window.__moreClicks++;
        window.__lastClickTrusted = e.isTrusted;
        var li = document.createElement("li");
        li.className = "serp-item";
        li.setAttribute("data-engine-node", "1");
        li.innerHTML = '<div class="Organic"><h2><a class="OrganicTitle-Link" href="https://site9.com/x">Engine result</a></h2></div>';
        // Async, like a real AJAX batch. A fixed-sleep loader would miss it.
        setTimeout(function () {
          document.getElementById("search-result").appendChild(li);
          more.remove();
          window.__appendedAt = Date.now();
        }, 40);
      });`,
    observe: `
      // The ENGINE already paginates itself on scroll. No button.
      setTimeout(function () {
        var li = document.createElement("li");
        li.className = "serp-item";
        li.setAttribute("data-engine-node", "1");
        li.innerHTML = '<div class="Organic"><h2><a class="OrganicTitle-Link" href="https://site8.com/x">Auto result</a></h2></div>';
        document.getElementById("search-result").appendChild(li);
        window.__appendedAt = Date.now();
      }, 1200);`,
    nopager: `
      // No native control, no pager. Auto-loading cannot even start;
      // the extension MUST still expose a real next-page link.
      // ONE click only: the destination page is itself a valid SERP with
      // its own fail-open link, so without this guard the scenario chains
      // p=1 -> p=2 -> p=3 ... forever.
      setTimeout(function () {
        if (sessionStorage.getItem("shh-yx-clicked")) return;
        var a = document.getElementById("is-manual-next");
        window.__manualFoundAtClick = !!a;
        // Post the final snapshot BEFORE navigating: the click leaves this
        // document, so the scheduled final timer would never fire here.
        snap("final");
        if (a) {
          sessionStorage.setItem("shh-yx-clicked", "1");
          a.click();  // real navigation, exercised below
        }
      }, 1500);`,
    afterNav: ``,
    blocked: ``,
    late: `
      // The "show more" control hydrates AFTER document_end.
      setTimeout(function () {
        var b = document.createElement("button");
        b.id = "more";
        b.setAttribute("data-bem", '{"b-more":{}}');
        b.textContent = "Показать ещё";
        document.body.appendChild(b);
        window.__hydratedAt = Date.now();
        b.addEventListener("click", function (e) {
          window.__moreClicks++;
          window.__lastClickTrusted = e.isTrusted;
          var li = document.createElement("li");
          li.className = "serp-item";
          li.setAttribute("data-engine-node", "1");
          li.innerHTML = '<div class="Organic"><h2><a class="OrganicTitle-Link" href="https://site7.com/x">Late result</a></h2></div>';
          setTimeout(function () {
            document.getElementById("search-result").appendChild(li);
            b.remove();
          }, 40);
        });
      }, 1300);`,
  }[caseName] ?? "";

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>yandex ${caseName}</title>
<style>body{font:14px Arial;margin:0}li.serp-item{list-style:none;margin:8px 0;padding:8px;border:1px solid #ccc}</style>
</head><body>
${continuous}
<ul id="search-result" class="serp-list serp-list_left_yes">
${RESULT(1)}${RESULT(2)}
</ul></div>
${pager}
${more}
<div id="tail" style="height:40px"></div>
<script>
(function () {
  var CFG = ${CFG};
  window.__errors = [];
  window.__moreClicks = 0;
  window.__lastClickTrusted = null;
  window.__appendedAt = null;
  window.__hydratedAt = null;
  window.addEventListener("error", function (e) {
    window.__errors.push(String(e.message) + " @" + String(e.filename) + ":" + e.lineno);
  });
  window.addEventListener("unhandledrejection", function (e) {
    window.__errors.push("rejection: " + String(e.reason));
  });

  function snap(tag) {
    var list = document.getElementById("search-result");
    var sent = document.getElementById("is-sentinel");
    var manual = document.getElementById("is-manual-next");
    var pagerLink = document.querySelector(".Pager-Item_type_next");
    var engine = document.querySelector('[data-engine-node="1"]');
    var payload = {
      tag: tag, case: CFG.case, href: location.href,
      results: list ? list.querySelectorAll("li.serp-item").length : -1,
      sentinelExists: !!sent,
      sentinelInList: list ? !!list.querySelector("#is-sentinel") : false,
      sentinelParent: sent ? (sent.parentElement.id || sent.parentElement.tagName) : null,
      sentinelText: sent ? sent.textContent.replace(/\\s+/g, " ").trim() : null,
      wrappersInList: list ? list.querySelectorAll("[data-inf-page]").length : 0,
      manualHref: manual ? manual.getAttribute("href") : null,
      manualProtocol: manual ? new URL(manual.href).protocol : null,
      pagerVisible: pagerLink
        ? (getComputedStyle(pagerLink).display !== "none" && !!pagerLink.offsetParent)
        : null,
      engineNode: !!engine,
      engineNodeButtons: engine ? engine.querySelectorAll(".shh-block-btn").length : 0,
      blockButtons: document.querySelectorAll(".shh-block-btn").length,
      stampedNodes: document.querySelectorAll("[data-shh-result]").length,
      moreClicks: window.__moreClicks,
      lastClickTrusted: window.__lastClickTrusted,
      appendedAt: window.__appendedAt,
      hydratedAt: window.__hydratedAt,
      manualFoundAtClick: window.__manualFoundAtClick,
      errors: window.__errors.slice()
    };
    var body = JSON.stringify(payload);
    try {
      // sendBeacon survives navigation. A plain fetch() posted immediately
      // before a.click() is CANCELLED by the unload, which silently loses
      // the very snapshot that proves the fail-open link existed.
      if (navigator.sendBeacon && navigator.sendBeacon("/report", body)) return;
      fetch("/report", { method: "POST", headers: {"content-type":"application/json"},
        body: body });
    } catch (e) {}
  }
  window.__snap = snap;
  ${behaviour}
  setTimeout(function () { snap("early"); }, 700);
  setTimeout(function () { snap("mid"); }, Math.max(900, Math.round(CFG.runMs * 0.55)));
  setTimeout(function () {
    snap("final");
    if (CFG.next) {
      setTimeout(function () {
        location.href = "/search/?text=cats&case=" + CFG.next;
      }, 500);
    }
  }, CFG.runMs);
})();
</script></body></html>`;
}

const SOFT_BLOCK = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<p>Please enable JavaScript to continue. If you are not redirected within a few seconds, click here.</p>
<script>location.href="/sorry/";</script></body></html>`;

// --render <case>: print the generated page for a JS syntax check without
// launching a browser. Catches a broken inline script before a 60s round trip.
const renderIdx = process.argv.indexOf("--render");
if (renderIdx !== -1) {
  process.stdout.write(page(process.argv[renderIdx + 1] ?? "native", 8791));
  process.exit(0);
}

const reports = [];
const requests = [];
let server;
let ff;
let extLog = "";

function serve(req, res) {
  const u = new URL(req.url, "http://www.yandex.com");
  if (req.method === "POST" && u.pathname === "/report") {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { reports.push(JSON.parse(b)); } catch { /* malformed */ }
      res.writeHead(204); res.end();
    });
    return;
  }
  const dest = req.headers["sec-fetch-dest"] ?? "(none)";
  const hasP = u.searchParams.has("p");
  const explicitCase = u.searchParams.get("case");
  // Firefox headless here sends NO Sec-Fetch-* headers and Firefox's default
  // document Accept is byte-identical to fetchPage()'s custom Accept, so
  // headers CANNOT distinguish a fetch from a navigation. Classify by the
  // deterministic route instead: only the `blocked` fixture's pager URL is
  // ever fetched by the extension; every other p= URL is a link navigation.
  const isFetch = hasP && explicitCase === "blocked";
  requests.push({
    method: req.method,
    url: req.url,
    dest,
    accept: req.headers.accept ?? "",
    headers: req.headers,
    kind: isFetch ? "content-script-fetch" : "navigation",
  });
  const navWithP = hasP && explicitCase === "nopager";
  const caseName = navWithP ? "afterNav" : (explicitCase ?? "native");
  if (isFetch) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(SOFT_BLOCK);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page(caseName, server.address().port));
}

function cleanup() {
  try { ff?.kill(); } catch { /* already gone */ }
  try { server?.close(); } catch { /* already closed */ }
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* temp dir */ }
}

function verdict() {
  const finals = new Map();
  for (const r of reports) if (r.tag === "final") finals.set(r.case, r);
  const fetchAttempts = requests.filter((r) => r.kind === "content-script-fetch");
  const rows = [];
  const check = (name, ok, detail) => rows.push({ name, ok, detail });

  const n = finals.get("native");
  check("extension injected (block buttons present)",
    !!n && n.blockButtons > 0, `blockButtons=${n?.blockButtons ?? "?"} stamped=${n?.stampedNodes ?? "?"}`);
  check("native: Xray click fired page listener",
    !!n && n.moreClicks > 0 && n.lastClickTrusted === false,
    `clicks=${n?.moreClicks ?? "?"} isTrusted=${n?.lastClickTrusted ?? "?"}`);
  check("native: engine rendered its OWN node and it was processed",
    !!n && n.engineNode && n.engineNodeButtons > 0 && n.results >= 3,
    `results=${n?.results ?? "?"} engineNode=${n?.engineNode} blockButtonsInNode=${n?.engineNodeButtons}`);
  check("native: zero foreign nodes inside the results list",
    !!n && !n.sentinelInList && n.wrappersInList === 0,
    `sentinelInList=${n?.sentinelInList} wrappers=${n?.wrappersInList}`);
  const nativeFetches = requests.filter(
    (r) => r.url.includes("p=") &&
      (r.url.includes("case=native") || r.url.includes("case=observe"))
  );
  check("native/observe: NO content-script fetch at all", nativeFetches.length === 0,
    `p-requests on native/observe=${nativeFetches.length}`);
  check("native: genuine end says 'End of results.' with NO stale page-2 link",
    !!n && !n.manualHref && String(n.sentinelText).includes("End of results"),
    `manualHref=${n?.manualHref ?? "none"} text=${String(n?.sentinelText ?? "").slice(0, 60)}`);

  const o = finals.get("observe");
  check("observe: engine auto-load still works, we stayed out of its DOM",
    !!o && o.results >= 3 && !o.sentinelInList && o.wrappersInList === 0,
    `results=${o?.results ?? "?"} sentinelInList=${o?.sentinelInList} wrappers=${o?.wrappersInList}`);
  check("observe: fail-open link present even though we did nothing",
    !!o && !!o.manualHref && o.manualProtocol === "http:",
    `href=${o?.manualHref ?? "none"} protocol=${o?.manualProtocol ?? "?"}`);

  const p = finals.get("nopager");
  check("no-pager: manual link exists when auto-load never starts",
    !!p && !!p.manualHref && p.manualProtocol === "http:",
    `href=${p?.manualHref ?? "none"} foundAtClick=${p?.manualFoundAtClick}`);
  const a = finals.get("afterNav");
  check("manual link REALLY navigates to page 2",
    !!a && new URL(a.href).searchParams.get("p") === "1",
    `href=${a?.href ?? "none"}`);

  const b = finals.get("blocked");
  check("bot-gated fetch: fallback attempted",
    fetchAttempts.some((r) => r.url.includes("case=blocked")),
    `attempts=${fetchAttempts.filter((r) => r.url.includes("case=blocked")).length}`);
  check("bot-gated fetch: terminal failure still exposes navigation",
    !!b && !!b.manualHref && b.pagerVisible === true,
    `href=${b?.manualHref ?? "none"} pagerVisible=${b?.pagerVisible}`);
  check("bot-gated fetch: NOT reported as 'End of results.'",
    !!b && !String(b.sentinelText).includes("End of results"),
    `text=${String(b?.sentinelText ?? "").slice(0, 90)}`);

  const l = finals.get("late");
  check("late hydration: capability reprobe adopted the native control",
    !!l && l.moreClicks > 0 && l.engineNode,
    `hydrated=${!!l?.hydratedAt} clicks=${l?.moreClicks ?? "?"} engineNode=${l?.engineNode}`);
  check("late hydration: no wrappers inside the list",
    !!l && l.wrappersInList === 0, `wrappers=${l?.wrappersInList}`);

  const pageErrors = reports.flatMap((r) => (r.errors ?? []).map((e) => `${r.case}: ${e}`));
  check("no uncaught page-world errors", pageErrors.length === 0,
    pageErrors.slice(0, 4).join(" | ") || "none");
  const extErrors = extLog.split("\n").filter((l) =>
    /TypeError|ReferenceError|Uncaught|JavaScript Error|NS_ERROR/i.test(l)
  );
  check("no error lines in the real extension/browser log", extErrors.length === 0,
    `logLines=${extLog.split("\n").length} matches=${extErrors.length} ` +
    extErrors.slice(0, 2).join(" | "));

  console.log("\n=== REAL FIREFOX RESULTS ===");
  for (const r of rows) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n        ${r.detail}`);
  }
  console.log(`\nreports=${reports.length}  finals=${[...finals.keys()].join(",")}`);
  console.log(`requests=${requests.length}  content-script-fetch=${fetchAttempts.length}`);
  const failed = rows.filter((r) => !r.ok);
  console.log(`\nVERDICT: ${failed.length === 0 ? "ALL PASS" : failed.length + " FAILURE(S)"}`);
  return failed.length === 0;
}

mkdirSync(PROFILE, { recursive: true });
writeFileSync(resolve(PROFILE, "user.js"), [
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("toolkit.telemetry.enabled", false);',
  'user_pref("browser.sessionstore.resume_from_crash", false);',
  'user_pref("xpinstall.signatures.required", false);',
  'user_pref("extensions.autoDisableScopes", 0);',
  'user_pref("network.proxy.type", 0);',
  'user_pref("network.proxy.allow_hijacking_localhost", true);',
  'user_pref("dom.security.https_only_mode", false);',
  'user_pref("dom.security.https_only_mode_pbm", false);',
  'user_pref("browser.fixup.fallback-to-https", false);',
  // Ask Firefox to route content-script/chrome console output to stdout.
  // In THIS headless web-ext setup no such lines were emitted (verified with
  // SHH_VERBOSE=1), so this channel is NOT proof of "no content-script
  // errors". The proof is behavioural: every scenario asserts the concrete
  // DOM work a thrown content script would have prevented.
  'user_pref("devtools.console.stdout.content", true);',
  'user_pref("devtools.console.stdout.chrome", true);',
].join("\n"));

server = createServer(serve);
server.listen(0, "127.0.0.1", () => {
  // Build here, not at import time: --render must be able to syntax-check
  // the fixtures without six unnecessary esbuild runs.
  const built = spawnSync(process.execPath, ["build.js"], { cwd: REPO, encoding: "utf8" });
  if (built.status !== 0) {
    console.error("BUILD FAILED\n" + (built.stdout ?? "") + (built.stderr ?? ""));
    cleanup();
    process.exitCode = 1;
    return;
  }
  console.log("[setup] dist rebuilt from current sources");
  const port = server.address().port;
  const startUrl = `http://www.yandex.com:${port}/search/?text=cats&case=native`;
  console.log(`[setup] server :${port}  host=www.yandex.com  binary=${FF}`);

  ff = spawn(process.execPath, [
    WEBEXT, "run",
    "--source-dir", resolve(REPO, "dist"),
    "--firefox", FF,
    "--firefox-profile", PROFILE,
    "--keep-profile-changes", "--no-reload",
    "--pref=network.dns.localDomains=www.yandex.com",
    "--pref=network.proxy.type=0",
    "--pref=network.proxy.allow_hijacking_localhost=true",
    "--pref=extensions.autoDisableScopes=0",
    "--pref=dom.security.https_only_mode=false",
    "--pref=browser.fixup.fallback-to-https=false",
    "--start-url", startUrl,
  ], {
    cwd: REPO,
    env: { ...process.env, MOZ_HEADLESS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const onData = (d) => {
    const s = String(d);
    extLog += s;
    if (VERBOSE) process.stdout.write("[web-ext] " + s);
  };
  ff.stdout.on("data", onData);
  ff.stderr.on("data", onData);
  ff.on("error", (e) => {
    console.error("web-ext launch failed: " + e.message);
    process.exitCode = 1;
    cleanup();
  });

  writeFileSync(resolve(REPO, ".tmp-ff/yandex-native-webext.log"), "");
  const logTimer = setInterval(() => {
    try { writeFileSync(resolve(REPO, ".tmp-ff/yandex-native-webext.log"), extLog); } catch { /* tmp */ }
  }, 1000);

  const expected = CASES.length;
  const deadline = Date.now() + 150_000;
  const poll = setInterval(() => {
    const finals = new Set(reports.filter((r) => r.tag === "final").map((r) => r.case));
    const haveAll = CASES.every((c) => finals.has(c));
    if (haveAll || Date.now() > deadline) {
      clearInterval(poll);
      clearInterval(logTimer);
      if (!haveAll) {
        console.error(`TIMEOUT — finals received: ${[...finals].join(",") || "(none)"}`);
        console.error("web-ext log tail:\n" + extLog.slice(-2000));
      }
      try { writeFileSync(resolve(REPO, ".tmp-ff/yandex-native-report.json"), JSON.stringify({ reports, requests }, null, 2)); } catch { /* tmp */ }
      const ok = verdict();
      cleanup();
      process.exitCode = ok ? 0 : 1;
    }
  }, 700);
});
