import { describe, it, expect } from "vitest";
import { runLoad, type ScenarioSpec } from "./harness/run-load";
import { serverStore, shhCache, lcg, type MessagingProfile } from "./harness/fake-browser";
import { summarise, type VisibilityReport } from "./harness/visibility";

// ============================================================
// The deliverable: scenario x timing -> final visibility.
//
// Every row is a REAL page load through the SHIPPED preload.ts and
// content/index.ts. The only variable down a column is how long the
// background takes to answer runtime.sendMessage — which is exactly the
// thing a real MV3 event page decides for you, load to load.
// ============================================================

const BLOCKED = "blocked.com";
const SAFE = "safe.com";

/** Reproducible per-run latency. Same seed ⇒ same numbers, every machine. */
function jittered(base: number | "never", seed: number, run: number, spread: number): number | "never" {
  if (base === "never") return "never";
  const r = lcg(seed * 7919 + run * 104729)();
  return base + Math.floor(r * (spread + 1));
}

interface Timings {
  id: string;
  label: string;
  base: number | "never";
  failFirstRounds: number;
  spread: number;
}

const TIMINGS: Timings[] = [
  // A warm MV3 event page answers in single-digit-to-tens of ms. Kept
  // non-zero so checkpoint 2 (after init's first await) is distinguishable
  // from checkpoint 3 (messaging resolved).
  { id: "T1", label: "warm BG (25ms)", base: 25, failFirstRounds: 0, spread: 20 },
  { id: "T2", label: "slow BG (600ms)", base: 600, failFirstRounds: 0, spread: 400 },
  // 3000ms > the 2500ms withTimeout, so round 1 is lost by construction.
  { id: "T3", label: "cold BG (3000ms, round 1 lost)", base: 3000, failFirstRounds: 1, spread: 200 },
  { id: "T4", label: "dead BG (never answers)", base: "never", failFirstRounds: Infinity, spread: 0 },
];

interface Scenario {
  id: string;
  label: string;
  make: () => Omit<ScenarioSpec, "profile" | "id" | "label">;
}

const SCENARIOS: Scenario[] = [
  {
    id: "S1",
    label: "S1 warm cache · blocked.com = block · not paused",
    make: () => ({
      engine: "google",
      results: [{ host: BLOCKED }, { host: SAFE }],
      probeHost: BLOCKED,
      server: serverStore([[BLOCKED, "block"]]),
      cache: shhCache([BLOCKED]),
      domContentLoadedAtMs: 40,
      styleResetAtMs: null,
      settleMs: 60,
    }),
  },
  {
    id: "S2",
    label: "S2 COLD cache · blocked.com = block · not paused",
    make: () => ({
      engine: "google",
      results: [{ host: BLOCKED }, { host: SAFE }],
      probeHost: BLOCKED,
      server: serverStore([[BLOCKED, "block"]]),
      cache: shhCache([]),
      domContentLoadedAtMs: 40,
      styleResetAtMs: null,
      settleMs: 60,
    }),
  },
  {
    id: "S3",
    label: "S3 warm cache · blocked.com = PBAN · not paused",
    make: () => ({
      engine: "google",
      results: [{ host: BLOCKED }, { host: SAFE }],
      probeHost: BLOCKED,
      server: serverStore([[BLOCKED, "pban"]]),
      cache: shhCache([BLOCKED]),
      domContentLoadedAtMs: 40,
      styleResetAtMs: null,
      settleMs: 60,
    }),
  },
  {
    id: "S4",
    label: "S4 STALE cache (has blocked.com) · list no longer has it",
    make: () => ({
      engine: "google",
      results: [{ host: BLOCKED }, { host: SAFE }],
      probeHost: BLOCKED,
      server: serverStore([]),
      cache: shhCache([BLOCKED]),
      domContentLoadedAtMs: 40,
      styleResetAtMs: null,
      settleMs: 60,
    }),
  },
  {
    id: "S5",
    label: "S5 STALE cache (paused:false) · prefs say pausedGlobally",
    make: () => ({
      engine: "google",
      results: [{ host: BLOCKED }, { host: SAFE }],
      probeHost: BLOCKED,
      server: serverStore([[BLOCKED, "block"]], { pausedGlobally: true }),
      cache: shhCache([BLOCKED]),
      domContentLoadedAtMs: 40,
      styleResetAtMs: null,
      settleMs: 60,
    }),
  },
  {
    id: "S6",
    label: "S6 cache MISSING blocked.com · list has it · not paused",
    make: () => ({
      engine: "google",
      results: [{ host: BLOCKED }, { host: SAFE }],
      probeHost: BLOCKED,
      server: serverStore([[BLOCKED, "block"]]),
      cache: shhCache(["something-else.com"]),
      domContentLoadedAtMs: 40,
      styleResetAtMs: null,
      settleMs: 60,
    }),
  },
  {
    id: "S7",
    label: "S7 warm cache · page JS drops our inline style at t=400ms",
    make: () => ({
      engine: "google",
      results: [{ host: BLOCKED }, { host: SAFE }],
      probeHost: BLOCKED,
      server: serverStore([[BLOCKED, "block"]]),
      cache: shhCache([BLOCKED]),
      domContentLoadedAtMs: 40,
      styleResetAtMs: 400,
      settleMs: 60,
    }),
  },
  {
    id: "S8",
    label: "S8 warm cache · user pauses from the popup mid-session",
    make: () => {
      const server = serverStore([[BLOCKED, "block"]]);
      return {
        engine: "google" as const,
        results: [{ host: BLOCKED }, { host: SAFE }],
        probeHost: BLOCKED,
        server,
        cache: shhCache([BLOCKED]),
        domContentLoadedAtMs: 40,
        styleResetAtMs: null,
        settleMs: 60,
        actions: async (h) => {
          // The popup writes the pref, then tells the tab. refreshPrefs()
          // takes the !wasActive && engineActive... no: wasActive=true here,
          // so it takes the `wasActive && !engineActive` reveal branch.
          server.prefs.pausedGlobally = true;
          h.emit("PREFS_UPDATED");
          await h.settle(2000);
        },
      };
    },
  },
];

type Cell = {
  timing: string;
  /** Coarse, user-visible bucket — this is what "flipping" is measured on. */
  bucket: string;
  /** The same state, with the exact hiding layer named. */
  final: string;
  prePaint: string;
  messaging: string;
  processed: string;
  listener: boolean;
  cacheAfter: string | null;
};

/**
 * The three states a user can actually tell apart on screen:
 *   VISIBLE            the blocked result is on screen
 *   hidden + Show      gone, replaced by a "blocked.com · hidden [Show][Unblock][Perma]" box
 *   hidden, no control gone with nothing to click — unrecoverable from the page
 */
function bucket(v: VisibilityReport | null): string {
  if (!v) return "node-absent";
  if (v.visible) return "VISIBLE";
  return v.hasShowControl || v.hasUnblockControl ? "hidden + Show control" : "hidden, NO control";
}

function cell(v: VisibilityReport | null): string {
  if (!v) return "node-absent";
  return v.visible ? "VISIBLE" : summarise(v);
}

async function runMatrix(): Promise<Map<string, Cell[]>> {
  const out = new Map<string, Cell[]>();
  for (const sc of SCENARIOS) {
    const rows: Cell[] = [];
    for (const tm of TIMINGS) {
      // 3 runs per (scenario, timing), with a jitter seed that varies per run
      // so the same logical timing is not one lucky sample.
      for (let run = 0; run < 3; run++) {
        const base = jittered(tm.base, 7 + run, run, tm.spread);
        const profile: MessagingProfile = {
          latency: base,
          failFirstRounds: tm.failFirstRounds,
          seed: 1000 + run,
          jitterMs: 0,
        };
        const spec: ScenarioSpec = { id: `${sc.id}/${tm.id}/r${run}`, label: sc.label, profile, ...sc.make() };
        const r = await runLoad(spec);
        const pick = (n: string): VisibilityReport | null =>
          r.checkpoints.find((c) => c.name === n)?.report ?? null;
        const finalReport = pick("5-afterRevive");
        rows.push({
          timing: tm.label,
          bucket: bucket(finalReport),
          final: cell(finalReport),
          prePaint: cell(pick("1-prePaint")),
          messaging: cell(pick("3-afterMessaging")),
          processed: cell(pick("4-afterProcessResults")),
          listener: r.listenerAttached,
          cacheAfter: r.cacheAfter,
        });
      }
    }
    out.set(sc.id, rows);
  }
  return out;
}

function renderTable(matrix: Map<string, Cell[]>): string {
  const lines: string[] = [];
  lines.push("| scenario | run | timing | 1 prePaint | 3 afterMessaging | 4 afterProcessResults | 5 FINAL (detail) | 5 FINAL (bucket) | popup listener |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const sc of SCENARIOS) {
    const rows = matrix.get(sc.id)!;
    rows.forEach((r, i) => {
      lines.push(
        `| ${sc.id} | ${i + 1} | ${r.timing} | ${r.prePaint} | ${r.messaging} | ${r.processed} | ${r.final} | **${r.bucket}** | ${r.listener ? "yes" : "NO"} |`
      );
    });
  }
  return lines.join("\n");
}

describe("SCENARIO x TIMING matrix (the deliverable)", () => {
  it("prints the matrix and finds at least one scenario whose outcome flips with timing alone", async () => {
    const matrix = await runMatrix();
    // eslint-disable-next-line no-console
    console.log("\n=== SCENARIO x TIMING MATRIX ===\n" + renderTable(matrix));

    // Collapse each scenario to the SET of distinct USER-VISIBLE outcomes.
    const outcomes = new Map<string, Set<string>>();
    for (const sc of SCENARIOS) {
      outcomes.set(sc.id, new Set((matrix.get(sc.id) ?? []).map((r) => r.bucket)));
    }
    // eslint-disable-next-line no-console
    console.log(
      "\n=== DISTINCT USER-VISIBLE FINAL OUTCOMES PER SCENARIO ===\n" +
        Array.from(outcomes.entries())
          .map(([k, v]) => `${k}: ${v.size} distinct -> ${Array.from(v).join("  ||  ")}`)
          .join("\n")
    );

    const flipping = Array.from(outcomes.entries()).filter(([, v]) => v.size > 1);
    // eslint-disable-next-line no-console
    console.log(
      "\nSCENARIOS WHOSE FINAL USER-VISIBLE STATE DEPENDS ON TIMING ALONE: " +
        (flipping.map(([k]) => k).join(", ") || "none")
    );
    expect(flipping.length).toBeGreaterThan(0);

    for (const sc of SCENARIOS) {
      const rows = matrix.get(sc.id)!;
      // eslint-disable-next-line no-console
      console.log(
        `\n--- ${sc.label} --- _shh_cache after the load: ` +
          Array.from(new Set(rows.map((r) => r.cacheAfter))).join("  ;  ")
      );
    }
  }, 300_000);
});
