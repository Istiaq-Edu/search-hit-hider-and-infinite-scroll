// The shipped content script reads `__SHH_BUILD__` as a bare identifier
// (esbuild `define` in build.js). The audit harness predates that constant, so
// without this the content script dies in its prologue and the repro would only
// exercise the preload layer.
(globalThis as unknown as Record<string, unknown>).__SHH_BUILD__ = "v0.0.0-audit";

import { describe, it, expect } from "vitest";
import { runLoad } from "./harness/run-load";
import { serverStore, shhCache } from "./harness/fake-browser";
import { probeVisibility } from "./harness/visibility";

// ============================================================
// REPRO: "results are not visible on the screen but there is space for them"
//
// Hypothesis: a result card that arrives AFTER the last cover-reveal window,
// whose node the preload's tryHide() DECLINES to hide (section / container /
// aggregate guard) and which the adapter therefore never offers to
// processResults(), stays under the anti-flicker cover
//   html[data-shh-active] div.g/div.tF2Cxc { opacity:0 !important }
// forever. opacity:0 preserves layout => blank space, no content.
// ============================================================

const BLOCKED = "blocked.com";

/** A "Web results" section wrapper: one tF2Cxc holding SEVERAL results. */
const SECTION_HTML = `
<div class="MjjYud" data-ved="ved-section">
  <div class="A6K0A" data-rpos="1">
    <div class="tF2Cxc Ww4FFb">
      <div class="kb0PBd"><div class="yuRUbf"><a href="https://section-a.com/p"><h3>a</h3></a></div><cite>section-a.com</cite></div>
      <div class="kb0PBd"><div class="yuRUbf"><a href="https://section-b.com/p"><h3>b</h3></a></div><cite>section-b.com</cite></div>
    </div>
  </div>
</div>`;

describe("REPRO — late section-wrapped result stays under the cover", () => {
  it("section arriving after the reveal windows must be VISIBLE", async () => {
    const res = await runLoad({
      id: "repro",
      label: "late section",
      engine: "google",
      results: [{ host: BLOCKED }, { host: "safe.com" }],
      probeHost: BLOCKED,
      server: serverStore([[BLOCKED, "block"]]),
      cache: shhCache([BLOCKED]),
      profile: { latency: 0, failFirstRounds: 0, seed: 1, jitterMs: 0 },
      domContentLoadedAtMs: 40,
      styleResetAtMs: null,
      settleMs: 3000,
      actions: async (h) => {
        // Append the section AFTER every reveal window has already fired.
        const tpl = document.createElement("template");
        tpl.innerHTML = SECTION_HTML;
        const section = tpl.content.firstElementChild as Element;
        document.querySelector("#rso")!.appendChild(section);
        await h.settle(600);
      },
    });

    const section = document.querySelector('[data-ved="ved-section"]') as Element;
    expect(section).not.toBeNull();
    const tF2Cxc = section.querySelector("div.tF2Cxc") as Element;
    const report = probeVisibility(tF2Cxc);

    // eslint-disable-next-line no-console
    console.log("\n=== REPRO RESULT ===");
    // eslint-disable-next-line no-console
    console.log("tF2Cxc data-shh-ok        :", tF2Cxc.hasAttribute("data-shh-ok"));
    // eslint-disable-next-line no-console
    console.log("tF2Cxc data-shh-preloaded :", tF2Cxc.hasAttribute("data-shh-preloaded"));
    // eslint-disable-next-line no-console
    console.log("tF2Cxc data-shh-result    :", tF2Cxc.getAttribute("data-shh-result"));
    // eslint-disable-next-line no-console
    console.log("visible                   :", report.visible);
    // eslint-disable-next-line no-console
    console.log("hiddenAt/hiddenOn         :", report.hiddenAt, report.hiddenOn);
    // eslint-disable-next-line no-console
    console.log("hits                      :", JSON.stringify(report.hits));
    // eslint-disable-next-line no-console
    console.log("logs                      :", res.logs.join("\n"));

    // Pin the PREMISE as well as the outcome. `probeVisibility` reports VISIBLE
    // whenever no opacity rule matches, so if the cover were ever disarmed
    // (`data-shh-active` absent — preload early-return, cache read failure) this
    // test would pass for the wrong reason and keep passing with the fix
    // reverted. Assert the cover was armed and that the node is positively
    // marked, not merely un-hidden.
    expect(document.documentElement.hasAttribute("data-shh-active")).toBe(true);
    expect(tF2Cxc.getAttribute("data-shh-ok")).toBe("true");
    expect(report.visible).toBe(true);
  }, 120_000);
});
