// ============================================================
// env-shim.ts — vitest setupFile for the audit harness.
//
// Delegates to harness/jsdom-env.ts, which documents exactly what it patches
// and why. Called once at file setup so every scratch test file starts with a
// working localStorage and document.adoptedStyleSheets; run-load.ts then swaps
// in a fresh window per simulated page load.
// ============================================================

import { JSDOM } from "jsdom";
import { installFreshDom, installAdoptedStyleSheets } from "./jsdom-env";

// A Google SERP by default, so the pre-paint :has()/opacity cover is armed
// (preload.ts:120-125 gates on location.hostname). SHH_AUDIT_URL selects a
// different engine — see vitest.config.ts.
const url =
  process.env.SHH_AUDIT_URL ?? "https://www.google.com/search?q=blocked+domain&num=20";

const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
  url,
  pretendToBeVisual: true,
});
const win = dom.window as unknown as Record<string, unknown>;
for (const name of [
  "document", "location", "navigator", "history", "screen",
  "Node", "Element", "HTMLElement", "HTMLAnchorElement", "HTMLDivElement",
  "HTMLStyleElement", "HTMLButtonElement", "Document", "DocumentFragment",
  "NodeList", "HTMLCollection", "DOMTokenList", "Text", "Comment",
  "MutationObserver", "ResizeObserver", "IntersectionObserver",
  "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "PageTransitionEvent",
  "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
  "CSSStyleSheet", "Range", "Selection", "getSelection",
  "localStorage",
]) {
  if (name in win && win[name] !== undefined) {
    Object.defineProperty(globalThis, name, {
      value: win[name], writable: true, configurable: true, enumerable: false,
    });
  }
}
if (win.window !== win) Object.defineProperty(win, "window", { value: win, configurable: true });
if (win.self !== win) Object.defineProperty(win, "self", { value: win, configurable: true });
Object.defineProperty(globalThis, "window", { value: win, writable: true, configurable: true });

installAdoptedStyleSheets(dom.window.document);

export { installFreshDom, installAdoptedStyleSheets };
