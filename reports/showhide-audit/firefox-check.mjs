import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
const OUT = ".tmp-ff/report.txt";
writeFileSync(OUT, "");
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div id="rso">
  <div class="MjjYud"><div class="g"><a href="https://safe.com/p"><h3>safe result</h3></a><cite>safe.com</cite></div></div>
  <div class="MjjYud"><div class="g"><a href="https://blocked.com/p"><h3>blocked result</h3></a><cite>blocked.com</cite></div></div>
  <div class="MjjYud"><div class="tF2Cxc"><div class="kb0PBd">linkless shell</div></div></div>
</div>
<pre id="out">waiting</pre>
<script>
function collect() {
  var attr = document.documentElement.getAttribute("data-shh-report");
  var pre = document.documentElement.getAttribute("data-shh-preload-run");
  return {
    href: location.href,
    pageWorld: {
      __shhDiagText: typeof window.__shhDiagText,
      __shhCoverAuditText: typeof window.__shhCoverAuditText,
      __shhDiag: typeof window.__shhDiag,
      __shhRevealGoogle: typeof window.__shhRevealGoogle
    },
    preloadRunAttr: pre,
    reportAttrPresent: attr !== null,
    reportLen: attr ? attr.length : 0,
    coverAuditLine: attr ? (attr.match(/blankGaps=[^\\n]*/) || ["(absent)"])[0] : "(no attr)",
    coverVerdict: attr ? ((attr.match(/VERDICT:[^\\n]*/) || ["(absent)"])[0]) : "",
    reportHead: attr ? attr.split(String.fromCharCode(10)).slice(0, 8).join(' ~ ') : '(no attr)',
    reportHead: attr ? attr.split(String.fromCharCode(10)).slice(0, 8).join(' ~ ') : '(no attr)',
    coverArmedLine: attr ? ((attr.match(/coverArmed=[^\\n]*/) || ["(absent)"])[0]) : "",
    resultOpacities: Array.prototype.map.call(document.querySelectorAll("#rso [class*=g], #rso .tF2Cxc"), function (e) {
      var c = getComputedStyle(e);
      return e.className.split(" ")[0] + ":op=" + c.opacity + ",disp=" + c.display;
    })
  };
}
function send(tag) {
  try { fetch("/report", { method: "POST", body: JSON.stringify({ tag: tag, data: collect() }) }); } catch (e) {}
}
setTimeout(function(){ send("t=1200"); }, 1200);
setTimeout(function(){ send("t=3000"); }, 3000);
setTimeout(function(){ send("t=5000"); }, 5000);
</script></body></html>`;
createServer((req, res) => {
  if (req.method === "POST" && req.url === "/report") {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { appendFileSync(OUT, b + "\n"); res.writeHead(204); res.end(); });
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
}).listen(8765, "127.0.0.1", () => console.log("server on 8765"));
