import { describe, it, expect } from "vitest";

// ============================================================
// Test-environment pins.
//
// The `localStorage` pin is NOT cosmetic. Node 25 ships a global
// `localStorage` that is a bare object — its prototype chain goes
// straight to `Object.prototype`, so it has no getItem/setItem/removeItem/
// clear. vitest 1.6.1 starts its worker with `--localstorage-file`
// (passed by vitest, not by this repo), which switches Node's Web Storage
// globals on; they then shadow the jsdom implementation.
//
// Measured in this repo (vitest 1.6.1, jsdom, Node v25.2.1):
//   window === globalThis                              -> true
//   window.localStorage === globalThis.localStorage   -> true
//   typeof localStorage.getItem                        -> "undefined"
//   getPrototypeOf(localStorage) === Object.prototype  -> true
//
// Because `window === globalThis` and window.localStorage IS the stub,
// jsdom's real Storage cannot be recovered from `window` — it was never
// installed. It has to be SUPPLIED. vitest.setup.ts substitutes a
// spec-shaped in-memory Storage when the existing global lacks the WebIDL
// methods, so this stays a no-op if Node or vitest fixes it upstream.
//
// Why it mattered: every localStorage call in src/ is wrapped in a silent
// `catch {}` (index.ts:462, :959, :1003-1012; preload.ts:103). With the
// stub in place the ENTIRE `_shh_cache` pre-paint layer — the mechanism that
// hides blocked results before first paint, and the whole degraded-mode state
// machine — was silently inert under test. Ten assertions across seven tests
// were dead as a result (debug.test.ts:104,110,120,121,127 and
// append-insertion.test.ts:1379,1380,1391,1402,1403).
//
// This file exists so a Node upgrade cannot silently undo that. Reverting the
// `setupFiles` entry in vitest.config.ts must turn this file RED.
// ============================================================

describe("test environment", () => {
  it("localStorage is a working Storage, not Node's method-less stub", () => {
    expect(typeof localStorage.setItem).toBe("function");
    expect(typeof localStorage.getItem).toBe("function");
    expect(typeof localStorage.removeItem).toBe("function");
    expect(typeof localStorage.clear).toBe("function");
  });

  it("localStorage round-trips a value", () => {
    localStorage.setItem("_shh_env_probe", "v1");
    expect(localStorage.getItem("_shh_env_probe")).toBe("v1");
    localStorage.removeItem("_shh_env_probe");
    expect(localStorage.getItem("_shh_env_probe")).toBeNull();
  });

  it("localStorage.clear() removes everything", () => {
    localStorage.setItem("_shh_env_probe", "v1");
    localStorage.clear();
    expect(localStorage.getItem("_shh_env_probe")).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  // ------------------------------------------------------------
  // Second, independent jsdom gap — recorded rather than hidden.
  //
  // jsdom 29 does not implement document.adoptedStyleSheets. So
  // injectHidingStyles() (index.ts:901-908) throws into its own
  // `catch { }` and the `.shh-hidden` / `.shh-pban` layers are never
  // created. That is a second silent product-path consequence of the
  // same class as the localStorage defect.
  //
  // Deliberately NOT shimmed here. Shim it or assert around it in the
  // phase that actually needs it; do not let it ride along silently.
  // ------------------------------------------------------------
  // ------------------------------------------------------------
  // Second, independent jsdom gap — recorded as a ONE-WAY pin.
  //
  // jsdom 29 does not implement document.adoptedStyleSheets, so
  // injectHidingStyles() throws into its own `catch { }` and the
  // `.shh-hidden` / `.shh-pban` layers are never created.
  //
  // An earlier version branched on `Array.isArray(...)` and restated the
  // predicate in each arm — unfailable, and blind in both directions: if a
  // future jsdom DID ship adoptedStyleSheets, the test would keep passing and
  // nobody would notice that the class layers now need real coverage. This
  // form fails when the gap closes, which is the alarm you want.
  // ------------------------------------------------------------
  it("jsdom still lacks adoptedStyleSheets (GAP — see this file's header)", () => {
    expect(document.adoptedStyleSheets).toBeUndefined();
  });

  it("window.localStorage IS the object the tests use", () => {
    // vitest.setup.ts's shim is installed on globalThis and its correctness
    // argument depends on `window === globalThis` in the jsdom env. If a future
    // vitest stops aliasing them, the shim would land on one object and
    // `window.localStorage` would stay broken — silently, and only for code
    // that reads it that way.
    expect(window.localStorage).toBe(localStorage);
  });
});
