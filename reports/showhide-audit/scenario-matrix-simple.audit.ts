import { describe, it } from "vitest";
import { runLoad, type ScenarioSpec } from "./harness/run-load";
import { serverStore, shhCache, lcg, type MessagingProfile } from "./harness/fake-browser";
import { summarise, type VisibilityReport } from "./harness/visibility";

// ============================================================
// The same matrix on a SIMPLE engine.
//
// The pre-paint layers are asymmetric by construction: the `:has()` rules and
// the opacity cover are both gated on Google's markup / hostname
// (preload.ts:120-125, :236-239, :513), so on DuckDuckGo the ONLY pre-paint
// protection is the [data-shh-preloaded] rule plus the preload's
// MutationObserver. This run therefore isolates how much of the intermittency
// is a Google-cover artifact and how much is the pipeline itself.
//
// RUN WITH:
//   $env:SHH_AUDIT_URL="https://duckduckgo.com/?q=test"; npx vitest run ...
// ============================================================

const BLOCKED = "blocked.com";
const SAFE = "safe.com";

const TIMINGS = [
  { label: "warm BG (25ms)", base: 25 as const, failFirstRounds: 0, spread: 20 },
  { label: "cold BG (3000ms, round 1 lost)", base: 3000 as const, failFirstRounds: 1, spread: 200 },
  { label: "dead BG (never answers)", base: "never" as const, failFirstRounds: Infinity, spread: 0 },
];

const SCENARIOS: Array<{ id: string; label: string; make: () => Omit<ScenarioSpec, "profile" | "id" | "label"> }> = [
  {
    id: "D1",
    label: "D1 warm cache · blocked.com = block",
    make: () => ({
      engine: "ddg" as const,
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
    id: "D2",
    label: "D2 COLD cache · blocked.com = block",
    make: () => ({
      engine: "ddg" as const,
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
    id: "D3",
    label: "D3 warm cache · blocked.com = PBAN",
    make: () => ({
      engine: "ddg" as const,
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
    id: "D4",
    label: "D4 STALE cache (has blocked.com) · list no longer has it",
    make: () => ({
      engine: "ddg" as const,
      results: [{ host: BLOCKED }, { host: SAFE }],
      probeHost: BLOCKED,
      server: serverStore([]),
      cache: shhCache([BLOCKED]),
      domContentLoadedAtMs: 40,
      styleResetAtMs: null,
      settleMs: 60,
    }),
  },
];

function cell(v: VisibilityReport | null): string {
  return v ? (v.visible ? "VISIBLE" : summarise(v)) : "node-absent";
}

function bucket(v: VisibilityReport | null): string {
  if (!v) return "node-absent";
  if (v.visible) return "VISIBLE";
  return v.hasShowControl || v.hasUnblockControl ? "hidden + Show control" : "hidden, NO control";
}

describe("SCENARIO x TIMING matrix — simple engine (DuckDuckGo)", () => {
  // Without SHH_AUDIT_URL the jsdom document is a Google SERP, every scenario
  // below would run against the Google adapter and print a meaningless
  // "no flips". Skip rather than report a wrong answer.
  const onDdg = location.hostname.includes("duckduckgo.com");

  it.skipIf(!onDdg)("prints the matrix", async () => {
    const lines: string[] = [
      "| scenario | run | timing | 1 prePaint | 3 afterMessaging | 4 afterProcessResults | 5 FINAL (detail) | 5 FINAL (bucket) | popup listener |",
      "|---|---|---|---|---|---|---|---|---|",
    ];
    const outcomes = new Map<string, Set<string>>();

    for (const sc of SCENARIOS) {
      const finals = new Set<string>();
      for (const tm of TIMINGS) {
        for (let run = 0; run < 3; run++) {
          const base = tm.base === "never" ? "never" : tm.base + Math.floor(lcg(7 + run * 31 + run)() * (tm.spread + 1));
          const profile: MessagingProfile = { latency: base, failFirstRounds: tm.failFirstRounds, seed: 1000 + run, jitterMs: 0 };
          const res = await runLoad({ id: `${sc.id}/${run}`, label: sc.label, profile, ...sc.make() });
          const pick = (n: string): VisibilityReport | null =>
            res.checkpoints.find((c) => c.name === n)?.report ?? null;
          const final = cell(pick("5-afterRevive"));
          finals.add(bucket(pick("5-afterRevive")));
          lines.push(
            `| ${sc.id} | ${run + 1} | ${tm.label} | ${cell(pick("1-prePaint"))} | ${cell(pick("3-afterMessaging"))} | ` +
              `${cell(pick("4-afterProcessResults"))} | ${final} | **${bucket(pick("5-afterRevive"))}** | ${res.listenerAttached ? "yes" : "NO"} |`
          );
        }
      }
      outcomes.set(sc.id, finals);
    }

    lines.push("");
    for (const [id, set] of outcomes) {
      lines.push(`${id}: ${set.size} distinct final outcome(s) -> ${Array.from(set).join("  ||  ")}`);
    }
    const flipping = Array.from(outcomes.entries()).filter(([, v]) => v.size > 1).map(([k]) => k);
    lines.push(`SIMPLE-ENGINE SCENARIOS WHOSE FINAL VISIBILITY DEPENDS ON TIMING: ${flipping.join(", ") || "none"}`);
    // eslint-disable-next-line no-console
    console.log("\n=== SIMPLE ENGINE (DuckDuckGo) MATRIX ===\n" + lines.join("\n"));
  }, 300_000);
});
