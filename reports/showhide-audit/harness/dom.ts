// ============================================================
// dom.ts — fake SERPs, shaped like the real ones.
//
// Fixtures follow the shape the repo's own engine tests use
// (tests/engines/google.test.ts:18-52): #rso > div.MjjYud > div.g for Google,
// ol.react-results--main > li[data-layout=organic] for DuckDuckGo.
// ============================================================

export interface FakeResult {
  host: string;
  title?: string;
}

const PAGE_CHROME = (inner: string): string =>
  `<div id="main"><div id="cnt"><div id="rcnt">
     <div id="center_col">${inner}</div>
     <div id="rhs"><div class="kp-wholepage"><h3>Knowledge panel</h3></div></div>
   </div></div></div>
   <div id="botstuff"><div id="navcnt"><a id="pnnext" href="/search?q=test&amp;start=10">Next</a></div></div>
   <div id="foot"><a href="/search?q=test&amp;start=0">Footer link</a></div>`;

/** Google skeleton as it exists at document_start: stream present, results NOT. */
export function googleSkeleton(): string {
  return (
    `<div id="res"><div id="rso"></div></div>` + PAGE_CHROME("")
  );
}

/** One hydrated Google organic result (classic 2024/25 div.g shape). */
export function googleResult(r: FakeResult): string {
  return (
    `<div class="MjjYud" data-ved="ved-${r.host}">` +
      `<div class="g">` +
        `<div class="hlcw0c">` +
          `<a href="https://${r.host}/page"><h3 class="LC20lb">${r.title ?? r.host}</h3></a>` +
          `<cite>${r.host}</cite>` +
          `<div class="VwiC3b">snippet for ${r.host}</div>` +
        `</div>` +
      `</div>` +
    `</div>`
  );
}

/** DuckDuckGo skeleton — a "simple" engine: no :has() cover, no opacity cover. */
export function ddgSkeleton(): string {
  return `<div id="react-results"><ol class="react-results--main"></ol></div>`;
}

export function ddgResult(r: FakeResult): string {
  return (
    `<li data-layout="organic" class="b_algo">` +
      `<div class="b_title">` +
        `<a class="result__a" href="https://${r.host}/page"><h2 class="result__title">${r.title ?? r.host}</h2></a>` +
      `</div>` +
      `<div class="b_caption"><a class="result__url" href="https://${r.host}/page">${r.host}</a></div>` +
    `</li>`
  );
}

/** Reset the document to a bare skeleton for a fresh "page load". */
export function resetDocument(skeletonBody: string): void {
  const doc = document;
  doc.documentElement.removeAttribute("data-shh-active");
  doc.documentElement.removeAttribute("data-shh-preload-run");
  doc.documentElement.removeAttribute("data-shh-diag");
  doc.documentElement.className = "";
  doc.head.innerHTML = "";
  doc.body.innerHTML = skeletonBody;
}

/**
 * Simulate the page's own JS inserting results (Google's hydration burst,
 * DDG's React commit). This runs in its own task, AFTER both content scripts
 * have already executed at document_start — which is exactly the real ordering
 * and exactly the window the pre-paint layers exist to cover.
 */
export function hydrateResults(engine: "google" | "ddg", results: FakeResult[]): Element[] {
  const wrap = (r: FakeResult) =>
    engine === "google" ? googleResult(r) : ddgResult(r);
  const host =
    engine === "google"
      ? document.querySelector("#rso")
      : document.querySelector("ol.react-results--main");
  if (!host) throw new Error("hydrateResults: no results stream in the skeleton");
  const tpl = document.createElement("template");
  tpl.innerHTML = results.map(wrap).join("");
  const nodes = Array.from(tpl.content.children) as HTMLElement[];
  for (const n of nodes) host.appendChild(n);
  return nodes;
}
