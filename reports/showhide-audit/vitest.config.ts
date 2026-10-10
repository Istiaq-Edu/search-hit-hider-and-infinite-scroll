import { defineConfig } from "vitest/config";
import path from "node:path";

// Scratch harness config. Lives inside reports/showhide-audit/ so no existing
// repo file is touched. `root` is the repo so imports of ../../src/... resolve
// exactly as the real build sees them; `include` is scoped to this directory so
// a run can never pick up (or be confused with) the shipped suite.
//
// SHH_AUDIT_URL selects which SERP the jsdom document claims to be, because the
// pre-paint `:has()`/opacity cover is gated on `location.hostname` (preload.ts:
// 120-125) and cannot be toggled at runtime in jsdom.
//
//   Google-like  (cover + :has()) :  default
//   DuckDuckGo   (simple)         :  SHH_AUDIT_URL=https://duckduckgo.com/?q=test
const REPO = path.resolve(__dirname, "../..");

export default defineConfig({
  root: REPO,
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url:
          process.env.SHH_AUDIT_URL ??
          "https://www.google.com/search?q=blocked+domain&num=20",
      },
    },
    setupFiles: [path.resolve(__dirname, "harness/env-shim.ts")],
    // The audit files are named *.audit.ts(x), NOT *.test.ts(x), so a plain
    // `npx vitest run` at the repo root (which uses the default include glob
    // and no setupFiles) never picks them up. Without this the baseline suite
    // would grow from 544 to 556 tests and 6 of the new ones would fail on the
    // very localStorage gap this audit documents.
    include: process.env.SHH_AUDIT_URL
      ? // Simple-engine run: the hypothesis suites and the popup-row measurement
        // are Google-shaped, so only the DuckDuckGo matrix is meaningful here.
        ["reports/showhide-audit/scenario-matrix-simple.audit.ts"]
      : ["reports/showhide-audit/**/*.audit.ts", "reports/showhide-audit/**/*.audit.tsx"],
    // The harness drives its own virtual clock.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // One file at a time: fake timers + module registry are global state.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
