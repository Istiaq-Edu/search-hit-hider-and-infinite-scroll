// ============================================================
// jsdom-env.ts — the two jsdom gaps this harness must close, plus
// per-load isolation.
//
// 1. localStorage  — see RESULTS.md finding F1. Node 25 ships an own
//    `globalThis.localStorage` accessor holding an object with no methods, and
//    vitest's jsdom environment skips keys that already exist on globalThis,
//    so jsdom's working Storage is never installed. Every `_shh_cache` read
//    and write in preload.ts / index.ts throws a TypeError that their own
//    try/catch swallows. A spec-compliant in-memory Storage is installed here.
//
// 2. document.adoptedStyleSheets — undefined in jsdom 29, so
//    injectHidingStyles() (index.ts:901) throws inside its try/catch and the
//    `.shh-hidden{display:none!important}` sheet is silently never created.
//    Given a real backing array, the production sheets install for real and
//    the visibility model can read the real rule text back out of them.
//
// 3. Per-load isolation — a MutationObserver created by load N stays attached
//    to `document.documentElement` forever, because the harness reuses one
//    jsdom document. Load N+1's result insertion would then be seen by load
//    N's preload observer and load N's content-script ResultObserver, whose
//    closures hold load N's matcher — which silently rewrites the next load's
//    DOM at the WRONG granularity (a div.g instead of the div.MjjYud). So each
//    simulated load gets a brand-new JSDOM window, and the globals the shipped
//    code reads are re-pointed at it. The orphaned window (and its observers)
//    then collects garbage without ever being mutated again.
// ============================================================

import { JSDOM } from "jsdom";

/** Minimal spec-compliant in-memory Storage. */
class MemStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(index: number): string | null { return Array.from(this.map.keys())[index] ?? null; }
  getItem(key: string): string | null {
    return this.map.has(String(key)) ? this.map.get(String(key))! : null;
  }
  setItem(key: string, value: string): void { this.map.set(String(key), String(value)); }
  removeItem(key: string): void { this.map.delete(String(key)); }
  clear(): void { this.map.clear(); }
}

/**
 * The globals the shipped show/hide path reads off the bare global object.
 * Constructors matter: index.ts:840 does `node instanceof Element` and
 * observer.ts:26 reads `Node.ELEMENT_NODE`, so a new document is only
 * "the" document if its interface constructors are the installed ones.
 *
 * `queueMicrotask` is DELIBERATELY ABSENT. jsdom's own implementation calls
 * the global `queueMicrotask` from inside itself, so installing jsdom's
 * version over the global makes it recurse until the stack blows (observed as
 * "RangeError: Maximum call stack size exceeded at Window.js:582"). Node's
 * native queueMicrotask has identical microtask semantics, and index.ts:480
 * only needs "run this after the current task".
 */
const DOM_GLOBALS = [
  "window", "document", "location", "navigator", "history", "screen",
  "localStorage", "sessionStorage",
  "Node", "Element", "HTMLElement", "HTMLAnchorElement", "HTMLDivElement",
  "HTMLStyleElement", "HTMLButtonElement", "Document", "DocumentFragment",
  "NodeList", "HTMLCollection", "DOMTokenList", "Text", "Comment",
  "MutationObserver", "ResizeObserver", "IntersectionObserver",
  "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "PageTransitionEvent",
  "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
  "CSSStyleSheet", "Range", "Selection", "getSelection",
] as const;

function define(target: object, name: string, value: unknown): void {
  try {
    Object.defineProperty(target, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch { /* non-configurable global — leave it */ }
}

/** Install a fresh JSDOM window and point every DOM global at it. */
export function installFreshDom(url: string): Document {
  const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
    url,
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Record<string, unknown>;

  for (const name of DOM_GLOBALS) {
    if (!(name in win)) continue;
    const v = win[name];
    if (v === undefined) continue;
    define(globalThis, name, v);
  }
  // Fresh Storage per load — a load must not inherit the previous one's cache.
  define(globalThis, "localStorage", new MemStorage());
  define(win, "localStorage", globalThis.localStorage);
  if (win.window !== win) define(globalThis, "window", win);
  if (win.window !== win) define(win, "window", win);
  if (win.self !== win) define(win, "self", win);

  installAdoptedStyleSheets(dom.window.document);
  return dom.window.document;
}

/** Give a document a real `adoptedStyleSheets` array. */
export function installAdoptedStyleSheets(doc: Document): CSSStyleSheet[] {
  const d = doc as Document & { __shhAuditSheets?: CSSStyleSheet[] };
  if (d.__shhAuditSheets) return d.__shhAuditSheets;
  const sheets: CSSStyleSheet[] = [];
  Object.defineProperty(d, "__shhAuditSheets", { value: sheets, configurable: true });
  Object.defineProperty(d, "adoptedStyleSheets", {
    configurable: true,
    get: () => sheets,
    set: (next: CSSStyleSheet[]) => {
      sheets.length = 0;
      sheets.push(...next);
    },
  });
  return sheets;
}
