import { describe, it, expect } from "vitest";
import { runLoad, type LoadHooks, type CheckpointName } from "./harness/run-load";
import { serverStore, shhCache, type MessagingProfile } from "./harness/fake-browser";
import { probeVisibility, type VisibilityReport } from "./harness/visibility";

// ============================================================
// H-a .. H-e, one verdict each, all through the SHIPPED modules.
//
// A scenario is a full page load. `LAT.fast` = the background answers inside
// the 2500ms withTimeout budget; `LAT.dead` = it never answers, which is what
// drives init() into recoverStateFromCache() degraded mode
// (index.ts:196-206) after 2500 + 400 + 2500 ms.
// ============================================================

const BLOCKED = "blocked.com";
const SAFE = "safe.com";

const LAT: Record<string, MessagingProfile> = {
  fast: { latency: 25, failFirstRounds: 0, seed: 1, jitterMs: 0 },
  slow: { latency: 600, failFirstRounds: 0, seed: 1, jitterMs: 0 },
  dead: { latency: "never", failFirstRounds: Infinity, seed: 1, jitterMs: 0 },
  cold1: { latency: 3000, failFirstRounds: 1, seed: 1, jitterMs: 0 },
};

const trace: string[] = [];

function report(title: string, body: string): void {
  trace.push(`\n===== ${title} =====\n${body}`);
}

/** Each test's per-checkpoint dump is buffered locally, then appended once. */
let local: string[] = [];
const dump = (name: CheckpointName, t: number, node: Element, rep: VisibilityReport): void => {
  const g = node.querySelector(".g") as HTMLElement | null;
  local.push(
    `  @${name} t=${t}ms visible=${rep.visible} at=${rep.hiddenAt}:${rep.hiddenOn} ` +
      `mode=${rep.hasDataShhResult ?? "-"} preloadedAt=${rep.preloadedAt} ` +
      `show=${rep.hasShowControl} box=${rep.hasPlaceholder} trapped=${rep.trappedHidden}\n` +
      `      node  class="${node.className}" result=${node.getAttribute("data-shh-result")} ` +
      `preloaded=${node.getAttribute("data-shh-preloaded")} style="${node.getAttribute("style")}"\n` +
      `      div.g class="${g?.className}" preloaded=${g?.getAttribute("data-shh-preloaded")} ` +
      `style="${g?.getAttribute("style")}"\n` +
      `      prevSibling=${node.previousElementSibling?.className ?? "none"}`
  );
};
const flush = (): string => local.join("\n");

// ─────────────────────────────────────────────────────────────
describe("H-a  degraded mode downgrades a permaban to a regular block", () => {
  it("fast background ⇒ pban (no placeholder). dead background ⇒ block + visible Show/Unblock/Perma box", async () => {
    const base = {
      engine: "google" as const,
      results: [{ host: BLOCKED }, { host: SAFE }],
      probeHost: BLOCKED,
      cache: shhCache([BLOCKED]),
      domContentLoadedAtMs: 40,
      styleResetAtMs: null,
      settleMs: 60,
    };
    const fast = await runLoad({
      ...base, id: "ha-fast", label: "H-a fast",
      server: serverStore([[BLOCKED, "pban"]]),
      profile: LAT.fast,
      onCheckpoint: dump,
    });
    const fastFinal = fast.checkpoints.find((c) => c.name === "5-afterRevive")!.report!;

    trace.length = 0;
    local = [];
    const dead = await runLoad({
      ...base, id: "ha-dead", label: "H-a dead",
      server: serverStore([[BLOCKED, "pban"]]),
      profile: LAT.dead,
      onCheckpoint: dump,
    });
    const deadFinal = dead.checkpoints.find((c) => c.name === "5-afterRevive")!.report!;
    report("H-a fast background", flush());

    // Fast: a real permaban — hidden, no placeholder, no controls.
    expect(fastFinal.visible).toBe(false);
    expect(fastFinal.hasDataShhResult).toBe("pban");
    expect(fastFinal.hasShhPban).toBe(true);
    expect(fastFinal.hasPlaceholder).toBe(false);

    // Dead: degraded mode rebuilds the entry list from `_shh_cache`, which
    // stores domains only — the mode is gone.
    expect(deadFinal.visible).toBe(false);
    expect(deadFinal.hasDataShhResult).toBe("block");
    expect(deadFinal.hasShhPban).toBe(false);
    expect(deadFinal.hasPlaceholder).toBe(true);
    expect(deadFinal.hasShowControl).toBe(true);
    expect(deadFinal.hasUnblockControl).toBe(true);
    expect(dead.logs.some((l) => l.includes("degraded start"))).toBe(true);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────
describe("H-b  init() returns early while the preload has already hidden — no Show control", () => {
  it("stale cache (paused:false) + prefs say pausedGlobally + FAST background ⇒ hidden, no controls, no popup listener, cache never healed", async () => {
    const res = await runLoad({
      id: "hb", label: "H-b",
      engine: "google",
      results: [{ host: BLOCKED }, { host: SAFE }],
      probeHost: BLOCKED,
      server: serverStore([[BLOCKED, "block"]], { pausedGlobally: true }),
      cache: shhCache([BLOCKED]), // stale: says paused:false
      profile: LAT.fast,
      domContentLoadedAtMs: 40,
      styleResetAtMs: null,
      settleMs: 60,
      onCheckpoint: dump,
    });
    const final = res.checkpoints.find((c) => c.name === "5-afterRevive")!.report!;
    report("H-b fast background, prefs paused", flush());

    expect(final.visible).toBe(false);
    expect(final.hasPlaceholder).toBe(false);
    expect(final.hasShowControl).toBe(false);
    expect(final.trappedHidden).toBe(true);
    // init() bailed at index.ts:222, BEFORE the updateCache() at :251, so the
    // cache still claims paused:false — the trap repeats on every reload.
    expect(res.listenerAttached).toBe(false);
    expect(JSON.parse(res.cacheAfter ?? "{}").paused).toBe(false);
  }, 120_000);

  it("SAME user state, DEAD background ⇒ the opposite: it blocks and offers controls", async () => {
    const res = await runLoad({
      id: "hb-dead", label: "H-b dead",
      engine: "google",
      results: [{ host: BLOCKED }, { host: SAFE }],
      probeHost: BLOCKED,
      server: serverStore([[BLOCKED, "block"]], { pausedGlobally: true }),
      cache: shhCache([BLOCKED]),
      profile: LAT.dead,
      domContentLoadedAtMs: 40,
      styleResetAtMs: null,
      settleMs: 60,
      onCheckpoint: dump,
    });
    const final = res.checkpoints.find((c) => c.name === "5-afterRevive")!.report!;
    report("H-b dead background, same paused prefs", flush());

    // Degraded mode substitutes DEFAULT_PREFS, which are not paused, so the
    // user's "pause" is not honoured at all — the inverse failure.
    expect(res.logs.some((l) => l.includes("degraded start"))).toBe(true);
    expect(final.visible).toBe(false);
    expect(final.hasShowControl).toBe(true);
    expect(res.listenerAttached).toBe(true);
  }, 120_000);

  it("the trap REPEATS on every reload, because updateCache() is never reached", async () => {
    // Load 1 leaves _shh_cache untouched. Feed that exact value back in as
    // load 2's starting cache — which is literally what the browser does on
    // the next navigation — and check the state is identical.
    const make = (cache: string) => ({
      id: "hb-reload", label: "H-b reload",
      engine: "google" as const,
      results: [{ host: BLOCKED }, { host: SAFE }],
      probeHost: BLOCKED,
      server: serverStore([[BLOCKED, "block"]], { pausedGlobally: true }),
      cache,
      profile: LAT.fast,
      domContentLoadedAtMs: 40,
      styleResetAtMs: null,
      settleMs: 60,
    });

    const first = await runLoad(make(shhCache([BLOCKED])));
    const firstFinal = first.checkpoints.find((c) => c.name === "5-afterRevive")!.report!;
    const second = await runLoad(make(first.cacheAfter!));
    const secondFinal = second.checkpoints.find((c) => c.name === "5-afterRevive")!.report!;
    report(
      "H-b two consecutive loads",
      `  load 1: visible=${firstFinal.visible} controls=${firstFinal.hasShowControl} ` +
        `listener=${first.listenerAttached} cache=${first.cacheAfter}\n` +
        `  load 2: visible=${secondFinal.visible} controls=${secondFinal.hasShowControl} ` +
        `listener=${second.listenerAttached} cache=${second.cacheAfter}`
    );
    local = [];

    expect(firstFinal.trappedHidden).toBe(true);
    expect(secondFinal.trappedHidden).toBe(true);
    expect(secondFinal.visible).toBe(false);
    expect(secondFinal.hasShowControl).toBe(false);
    // Byte-identical cache, so the third load behaves the same. Forever.
    expect(second.cacheAfter).toBe(first.cacheAfter);
    expect(second.listenerAttached).toBe(false);
  }, 180_000);

  it("the other half: a COLD cache + dead background leaves the blocked result VISIBLE", async () => {
    const res = await runLoad({
      id: "hb-visible", label: "H-b inverse",
      engine: "google",
      results: [{ host: BLOCKED }, { host: SAFE }],
      probeHost: BLOCKED,
      server: serverStore([[BLOCKED, "block"]]),
      cache: shhCache([]),
      profile: LAT.dead,
      domContentLoadedAtMs: 40,
      styleResetAtMs: null,
      settleMs: 60,
      onCheckpoint: dump,
    });
    const final = res.checkpoints.find((c) => c.name === "5-afterRevive")!.report!;
    report("H-b cold cache + dead background", flush());
    expect(final.visible).toBe(true);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────
describe("H-c  stale _shh_cache", () => {
  it("cache still lists the domain, the list does not ⇒ pre-hidden, then only PARTIALLY revealed — the inner div.g stays display:none forever", async () => {
    const res = await runLoad({
      id: "hc", label: "H-c",
      engine: "google",
      results: [{ host: BLOCKED }, { host: SAFE }],
      probeHost: BLOCKED,
      server: serverStore([]),              // domain is NOT blocked any more
      cache: shhCache([BLOCKED]),           // …but the cache still says it is
      profile: LAT.fast,
      domContentLoadedAtMs: 40,
      styleResetAtMs: null,
      settleMs: 60,
      onCheckpoint: dump,
    });
    const final = res.checkpoints.find((c) => c.name === "5-afterRevive")!.report!;
    const node = document.querySelector('#rso div.MjjYud[data-ved="ved-blocked.com"]')!;
    const inner = node.querySelector(".g") as HTMLElement;
    report("H-c stale cache, domain no longer blocked",
      flush() +
        `\n  FINAL node:    ${node.outerHTML.slice(0, 130)}` +
        `\n  FINAL div.g:   preloaded=${inner.getAttribute("data-shh-preloaded")} style="${inner.getAttribute("style")}"` +
        `\n  FINAL block button inside the hidden subtree: ${!!inner.querySelector(".shh-block-btn")}` +
        `\n  FINAL _shh_cache: ${res.cacheAfter}`
    );
    local = [];

    // The wrapper WAS un-hidden (index.ts:607-611 ran)…
    expect(node.hasAttribute("data-shh-preloaded")).toBe(false);
    expect((node as HTMLElement).style.display).toBe("");
    // …but the preload's own mark, one level down, was not, and the reveal
    // code only ever looks at the node it was handed.
    expect(inner.getAttribute("data-shh-preloaded")).toBe("true");
    expect(final.visible).toBe(false);
    expect(final.hasPlaceholder).toBe(false);
    expect(final.trappedHidden).toBe(true);
    // A block button now sits inside the hidden subtree, so it is invisible too.
    expect(!!inner.querySelector(".shh-block-btn")).toBe(true);
  }, 120_000);

  it("and the same stale cache with a DEAD background leaves it blocked WITH a Show box", async () => {
    const res = await runLoad({
      id: "hc-dead", label: "H-c dead",
      engine: "google",
      results: [{ host: BLOCKED }, { host: SAFE }],
      probeHost: BLOCKED,
      server: serverStore([]),
      cache: shhCache([BLOCKED]),
      profile: LAT.dead,
      domContentLoadedAtMs: 40,
      styleResetAtMs: null,
      settleMs: 60,
      onCheckpoint: dump,
    });
    const final = res.checkpoints.find((c) => c.name === "5-afterRevive")!.report!;
    report("H-c stale cache, dead background", flush());
    local = [];
    expect(final.visible).toBe(false);
    expect(final.hasShowControl).toBe(true);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────
describe("H-e  refreshEntries() await window and missing page rescan", () => {
  it("a domain added by LIST_UPDATED is never applied to results already on screen", async () => {
    const store = serverStore([]);
    let before: VisibilityReport | null = null;
    let afterListUpdated: VisibilityReport | null = null;
    let appendedReport: VisibilityReport | null = null;
    let appendedMarks = "";
    const order: string[] = [];

    await runLoad({
      id: "he", label: "H-e",
      engine: "google",
      results: [{ host: BLOCKED }, { host: SAFE }],
      probeHost: BLOCKED,
      server: store,
      cache: shhCache([]),
      profile: LAT.fast,
      domContentLoadedAtMs: 40,
      styleResetAtMs: null,
      settleMs: 60,
      actions: async (h: LoadHooks) => {
        before = h.probe();
        // The user blocks blocked.com from the popup while the page is open.
        store.entries.push({ domain: BLOCKED, mode: "block", enabled: true, createdAt: 1 });
        h.emit("LIST_UPDATED");
        // SAME TASK: infinite scroll appends another blocked.com result, so
        // the observer's microtask batch lands while refreshEntries() is still
        // parked on `await getList()` (index.ts:827) — before refreshMatcher()
        // has run. The batch therefore stamps the node with the OLD matcher.
        const added = h.appendViaManager([{ host: BLOCKED }]);
        order.push("appended during refreshEntries' await window");
        await h.settle(400);
        appendedReport = probeVisibility(added[0]);
        appendedMarks = `class="${added[0].className}" result=${added[0].getAttribute("data-shh-result")} btn=${added[0].getAttribute("data-shh-btn")}`;
        order.push("refreshEntries settled");
        afterListUpdated = h.probe();
        await h.settle(2000);
        order.push("+2s later");
        afterListUpdated = h.probe();
      },
    });

    report(
      "H-e LIST_UPDATED adds a domain mid-flight",
      `  before:            visible=${before?.visible}\n` +
        `  appended node:     ${appendedMarks}\n` +
        `  appended visible:  ${appendedReport?.visible}\n` +
        `  first result after: visible=${afterListUpdated?.visible} ` +
        `result=${afterListUpdated?.hasDataShhResult} box=${afterListUpdated?.hasPlaceholder}\n` +
        `  order: ${order.join(" -> ")}\n` +
        `  FINAL #rso:\n${document.querySelector("#rso")?.innerHTML.replace(/></g, ">\n    <")}`
    );
    local = [];

    // The node the observer stamped got a BLOCK BUTTON, not a hide: proof it
    // was matched against the pre-LIST_UPDATED matcher.
    expect(appendedMarks).toContain('result=null');
    expect(appendedMarks).toContain('btn=1');
    // …and refreshEntries() never came back for it, 2s later or ever.
    expect(appendedReport?.visible).toBe(true);
    // The result that was on screen from the start is also still visible.
    expect(afterListUpdated?.visible).toBe(true);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────
describe("print the collected traces", () => {
  it("dumps", () => {
    // eslint-disable-next-line no-console
    console.log(trace.join("\n"));
    trace.length = 0;
  });
});
