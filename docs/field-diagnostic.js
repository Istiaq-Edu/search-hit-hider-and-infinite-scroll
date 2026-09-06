// ============================================================
// SHH field diagnostic — paste into the console on a Google results page
//
// PREFERRED ALTERNATIVE (v1.8.3+): the diagnostic is built into the
// extension. Turn on Debug mode (SHH → Advanced), reload, then run:
//
//     copy(__shhDiag())
//
// That needs no file transfer, which matters because field testing happens
// on a different machine. Use THIS script only when you cannot install a
// build — e.g. diagnosing someone else's already-installed copy.
//
// One paste answers everything needed to debug a "nothing is hidden" report:
//   • which build is actually loaded        (data-shh-preload-run v=…)
//   • whether the block list has entries    (domains=N)
//   • how many results the extension found  ([data-shh-result])
//   • how result links are encoded          (opaque /goto?url= vs /url?q= vs direct)
//   • whether the display URL (<cite>) lives inside the result node
//
// NOTES
//   • This runs in the PAGE context, not the content-script context, so
//     `browser` is undefined here. Version comes from <html data-shh-preload-run>,
//     which preload.ts writes synchronously at document_start.
//   • Run it AFTER the page has fully loaded (a second or two), then paste
//     the JSON output back.
// ============================================================
(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const html = document.documentElement;

  // ── Which build is loaded, and what did it see? ─────────────────────────
  // Format written by preload.ts:
  //   v=1.8.2;host=www.google.com;domains=71;paused=false
  const preloadRun = html.getAttribute("data-shh-preload-run") || "";
  const field = (name) => new RegExp(`(?:^|;)\\s*${name}=([^;]*)`).exec(preloadRun)?.[1] ?? null;

  const preload = {
    raw: preloadRun || "(missing — preload script did not run)",
    version: field("v"),
    host: field("host"),
    domains: field("domains"),
    paused: field("paused"),
    // Set only when the block list is non-empty AND the host is Google;
    // arms the static anti-flicker CSS cover.
    activeAttribute: html.getAttribute("data-shh-active"),
  };

  // ── What did the main content script do? ────────────────────────────────
  // shhLog() mirrors every [SHH] console line into <html data-shh-diag>.
  const diag = html.getAttribute("data-shh-diag") || "";
  const processed = /init done: processed=(\d+)/.exec(diag)?.[1] ?? null;

  // ── Link encoding — the thing that broke everything on 2026-08-30 ───────
  const links = qa("#rso a[href]");
  let opaqueGoto = 0, urlRedirect = 0, direct = 0, internal = 0;
  const samples = { opaqueGoto: [], urlRedirect: [], direct: [] };
  const push = (bucket, v) => { if (samples[bucket].length < 2) samples[bucket].push(v.slice(0, 90)); };

  for (const a of links) {
    const raw = a.getAttribute("href") || "";
    if (raw.includes("/goto?url=")) { opaqueGoto++; push("opaqueGoto", raw); }
    else if (raw.startsWith("/url?") || raw.includes("google.com/url")) { urlRedirect++; push("urlRedirect", raw); }
    else if (/^https?:/i.test(a.href)) { direct++; push("direct", a.href); }
    else internal++;
  }

  // ── Structure: where do results live, and is <cite> inside them? ────────
  // Ordered most-specific first: div.kb0PBd is the field-captured 2026
  // per-result node; the others are sections or legacy containers.
  const CANDIDATES = ["div.kb0PBd", "div.N54PNb", "div.g", "div.tF2Cxc", "div.MjjYud"];
  const found = CANDIDATES
    .map((sel) => ({ sel, n: qa(sel).length }))
    .filter((r) => r.n > 0);

  const first = found.length ? q(found[0].sel) : null;

  const chain = [];
  for (let el = first; el; el = el.parentElement) {
    chain.unshift(
      el.tagName.toLowerCase() +
        (el.id ? "#" + el.id : "") +
        (el.className ? "." + String(el.className).split(" ")[0] : "")
    );
    if (el.id === "rso") break;
  }

  // ── Proof of effect: did anything actually get hidden? ──────────────────
  const stampedResult = qa("[data-shh-result]").length;
  const hidden        = qa("[data-shh-preloaded]").length;
  const clearedOk     = qa("[data-shh-ok]").length;
  const placeholders  = qa(".shh-placeholder").length;

  const out = {
    url: location.href,
    preload,
    lifecycle: {
      shhDiag: diag.slice(0, 800) || "(empty — main content script did not run)",
      processed,
    },
    effect: {
      // stampedResult should equal the number of visible results we kept.
      // hidden > 0 is the only real proof that blocking fired.
      stampedResult, hidden, clearedOk, placeholders,
    },
    results: {
      resolvedBy: found[0]?.sel ?? null,
      count: found[0]?.n ?? 0,
      allCandidateCounts: found.reduce((a, r) => ((a[r.sel] = r.n), a), {}),
      pathFromRso: chain.join(" > ") || null,
      // THE open question: is the display URL inside the per-result node?
      citeInsideResult: first ? !!first.querySelector("cite") : null,
      citeText: first?.querySelector("cite")?.textContent?.trim() ?? null,
      firstResultHTML: first?.outerHTML.slice(0, 1500) ?? null,
    },
    linkEncoding: { opaqueGoto, urlRedirect, direct, internal, total: links.length, samples },
    counts: {
      "#rso": qa("#rso").length,
      "#search": qa("#search").length,
      "#center_col": qa("#center_col").length,
      "div.MjjYud": qa("div.MjjYud").length,
      "div.tF2Cxc": qa("div.tF2Cxc").length,
      "div.N54PNb": qa("div.N54PNb").length,
      "div.kb0PBd": qa("div.kb0PBd").length,
      "div.g": qa("div.g").length,
      h3: qa("h3").length,
      cite: qa("cite").length,
      "#pnnext": qa("#pnnext").length,
    },
  };

  console.log("[SHH-FIELD]", JSON.stringify(out, null, 2));
  return out;
})();
