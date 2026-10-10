// ============================================================
// visibility.ts — "is this result on screen?" from the REAL hiding layers.
//
// jsdom has no CSS cascade and no layout, so this module implements the
// narrow slice of the cascade the show/hide pipeline actually depends on:
// `display` and `opacity`, with inline `!important` beating every stylesheet
// rule. That is exactly the set of properties the shipped code writes:
//
//   preload.css:48  [data-shh-preloaded="true"]        -> display:none !important
//   preload.css:61  html[data-shh-active] div.g/…     -> opacity:0   !important
//   preload.ts:179  [data-shh-preloaded="true"]        -> display:none !important
//   preload.ts:249  GOOGLE_COVER_SEL                   -> opacity:0   !important
//   preload.ts:513  :is(SELS):has(:is(a[href*=…]))     -> display:none !important
//   index.ts:904    .shh-hidden                         -> display:none !important
//   index.ts:905    .shh-pban                           -> display:none !important
//   hider.ts:44,53  inline style.setProperty("display","none","important")
//   hider.ts:108    inline style.setProperty("display","block","important")   <- Show
//   hider.ts:128    inline style.setProperty("opacity","1","important")      <- Show
//
// The rule text is NOT hand-written here: it is read back out of the very
// CSSStyleSheet objects the production code constructed, plus the static
// preload.css file the browser would apply. If the product changes a selector,
// this model follows automatically; only the cascade arithmetic is ours.
// ============================================================

import { readFileSync } from "node:fs";
import path from "node:path";

const PRELOAD_CSS = path.resolve(__dirname, "../../../src/content/preload.css");

export interface DeclaredRule {
  selector: string;
  display: string | null;
  opacity: string | null;
  origin: string;
}

/**
 * Strip the `!important` flag off a declared value.
 *
 * jsdom's `getPropertyValue()` keeps the literal "!important" in the returned
 * string instead of exposing it via `getPropertyPriority()`, and this
 * module's own regex capture of preload.css does the same. Comparing
 * `"none !important" === "none"` silently fails, which once made this model
 * report a Google result VISIBLE while three separate hiding rules matched
 * it. Every comparison in here is against the bare value, so normalise once.
 */
function bare(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.replace(/\s*!important\s*$/i, "").trim();
  return s || null;
}

/** Rules declared in a constructed sheet, skipping @media print blocks. */
function readSheet(sheet: CSSStyleSheet, origin: string, out: DeclaredRule[]): void {
  const walk = (rules: CSSRuleList): void => {
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i] as CSSRule & {
        cssRules?: CSSRuleList;
        selectorText?: string;
        style?: CSSStyleDeclaration;
        media?: MediaList;
        conditionText?: string;
      };
      if (r.media) {
        // `@media print` never applies to the on-screen document.
        if ((r.media.mediaText || "").includes("print")) continue;
        if (r.cssRules) walk(r.cssRules);
        continue;
      }
      if (r.selectorText && r.style) {
        const d = bare(r.style.getPropertyValue("display"));
        const o = bare(r.style.getPropertyValue("opacity"));
        if (d || o) {
          out.push({ selector: r.selectorText, display: d, opacity: o, origin });
        }
      }
    }
  };
  try { walk(sheet.cssRules); } catch { /* detached sheet */ }
}

/**
 * Parse the static preload.css. The browser applies this at cascade level
 * before ANY JavaScript runs — including on bfcache restore — so the model
 * must include it even though no JS object holds it.
 */
export function readStaticPreloadCss(): DeclaredRule[] {
  let text: string;
  try {
    text = readFileSync(PRELOAD_CSS, "utf8");
  } catch {
    return [];
  }
  text = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: DeclaredRule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const selector = m[1].trim().replace(/\s+/g, " ");
    const body = m[2];
    const d = bare(/(?:^|;)\s*display\s*:\s*([^;]+)/.exec(body)?.[1]);
    const o = bare(/(?:^|;)\s*opacity\s*:\s*([^;]+)/.exec(body)?.[1]);
    if (d || o) {
      out.push({ selector, display: d, opacity: o, origin: "preload.css" });
    }
  }
  return out;
}

/** Every display/opacity rule currently in force for the document. */
export function collectRules(): { rules: DeclaredRule[]; unparsable: string[] } {
  const rules: DeclaredRule[] = readStaticPreloadCss();
  const unparsable: string[] = [];

  const doc = document as Document & { __shhAuditSheets?: CSSStyleSheet[] };
  const adopted = doc.__shhAuditSheets ?? [];
  adopted.forEach((s, i) => readSheet(s, `adopted[${i}]`, rules));

  // <style> ELEMENTS ARE DELIBERATELY NOT PARSED.
  //
  // injectBaseStyles() (ui/styles.ts) writes the extension's own UI chrome —
  // block buttons, the placeholder box, the dialog, the toast — and its only
  // display:none rule is inside an `@media print` block that never applies to
  // the screen. Nothing in it can hide or show a RESULT node, so parsing it
  // would only add false positives. (A naive text parse of that stylesheet
  // does in fact yield junk selectors, because it is full of /* comments */
  // and @keyframes blocks whose inner `from`/`to` rules are not selectors.)
  // preload.ts's Layer-B fallback <style> is the one <style> that can hide a
  // result, and its rule text is identical to the preload's adoptedStyleSheet,
  // so it is already covered by the layers above.

  // Sanity: can jsdom's selector engine actually evaluate the rule text the
  // product produced? Report anything it chokes on rather than pretending.
  for (const r of rules) {
    try { document.createDocumentFragment().querySelector(r.selector); }
    catch { unparsable.push(r.selector.slice(0, 80)); }
  }
  return { rules, unparsable };
}

export interface LayerHit {
  origin: string;
  selector: string;
  property: "display" | "opacity";
  value: string;
}

/** Cascade for ONE property on ONE element. Inline !important wins. */
function resolveProperty(
  el: Element,
  prop: "display" | "opacity",
  rules: DeclaredRule[]
): { value: string; via: LayerHit | null } {
  // 1. Inline style. Every inline write in the shipped code carries !important,
  //    which outranks any author !important rule.
  const inlineVal = el.style.getPropertyValue(prop);
  if (inlineVal) {
    return { value: inlineVal, via: { origin: "inline", selector: "style", property: prop, value: inlineVal } };
  }
  // 2. Author stylesheets + static preload.css.
  for (const r of rules) {
    const declared = r[prop];
    if (!declared) continue;
    let matches = false;
    try { matches = el.matches(r.selector); } catch { matches = false; }
    if (matches) {
      return { value: declared, via: { origin: r.origin, selector: r.selector.slice(0, 90), property: prop, value: declared } };
    }
  }
  return { value: prop === "display" ? "" : "1", via: null };
}

export type HideSite =
  | "none"
  /** The result node the adapter offered carries the hide (hideResult). */
  | "self"
  /** An ancestor of it carries the hide. */
  | "ancestor"
  /**
   * A DESCENDANT carries the hide. This is the pre-paint layers' normal mode:
   * the `:has()` rules (preload.ts:513) and the opacity cover
   * (preload.ts:249 / preload.css:61) both target `div.g` / `div.tF2Cxc`,
   * which sit INSIDE the `div.MjjYud` the adapter later hands to hideResult().
   */
  | "descendant";

export interface VisibilityReport {
  /** The user can see this result's title. */
  visible: boolean;
  /** Every hiding layer currently acting anywhere in the result's box. */
  hits: LayerHit[];
  /** Where the winning hiding layer sits, relative to the probe node. */
  hiddenAt: HideSite;
  /** Human name of the node that carries the winning layer. */
  hiddenOn: string | null;

  // ── the raw state, for the report ──
  inlineDisplay: string;
  hasShhHidden: boolean;
  hasShhPban: boolean;
  hasDataShhResult: string | null;
  /** data-shh-preloaded sits on the node itself, or on a descendant. */
  preloadedAt: HideSite;
  hasDataShhOk: boolean;

  // ── is the user able to undo it? ──
  /** A .shh-placeholder box sits immediately before the result. */
  hasPlaceholder: boolean;
  /** ...and it carries the "Show" button. */
  hasShowControl: boolean;
  hasUnblockControl: boolean;
  /** Hidden with no way back = the unrecoverable state of H-b. */
  trappedHidden: boolean;
}

const HEADING_SEL = 'h3, h2, [role="heading"]';

function describe(el: Element): string {
  const cls = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/)[0]}` : "";
  return `${el.tagName.toLowerCase()}${cls}${el.id ? `#${el.id}` : ""}`;
}

/** Is `el` (or anything from it up to `stopAt`, inclusive) hidden? */
function hidingChain(
  el: Element,
  stopAt: Element,
  rules: DeclaredRule[],
  hits: LayerHit[]
): { hidden: boolean; on: Element | null } {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const d = resolveProperty(cur, "display", rules);
    const o = resolveProperty(cur, "opacity", rules);
    if (d.via) hits.push(d.via);
    if (o.via) hits.push(o.via);
    if (d.value === "none" || o.value === "0") return { hidden: true, on: cur };
    if (cur === stopAt) break;
  }
  return { hidden: false, on: null };
}

export function probeVisibility(node: Element): VisibilityReport {
  const rules = collectRules().rules;
  const hits: LayerHit[] = [];

  // 1. Self + ancestors.
  let hiddenAt: HideSite = "none";
  let hiddenOn: Element | null = null;
  const up = hidingChain(node, node, rules, hits);
  if (up.hidden) {
    hiddenAt = up.on === node ? "self" : "ancestor";
    hiddenOn = up.on;
  }

  // 2. The result's TITLE, and everything between it and the node. The
  //    pre-paint layers hide the inner div.g, so a self/ancestor-only probe
  //    would report the blocked result as visible on the very first frame.
  if (!up.hidden) {
    const heading = node.matches(HEADING_SEL) ? node : node.querySelector(HEADING_SEL);
    if (heading) {
      const inner = hidingChain(heading, node, rules, hits);
      if (inner.hidden && inner.on !== node) {
        hiddenAt = inner.on && node.contains(inner.on) ? "descendant" : "self";
        hiddenOn = inner.on;
      }
    }
  }

  // 3. data-shh-preloaded / data-shh-ok may sit on a descendant too.
  const preSelf = node.hasAttribute("data-shh-preloaded");
  const preDesc = !preSelf && !!node.querySelector("[data-shh-preloaded]");
  const preloadedAt: HideSite = preSelf ? "self" : preDesc ? "descendant" : "none";

  const placeholder = node.previousElementSibling?.classList.contains("shh-placeholder")
    ? (node.previousElementSibling as HTMLElement)
    : null;

  const hasShhHidden = node.classList.contains("shh-hidden");
  const hasShhPban = node.classList.contains("shh-pban");
  const dataShhResult = node.getAttribute("data-shh-result");

  const hasShowControl = !!placeholder?.querySelector(".shh-btn-show");
  const hasUnblockControl = !!placeholder?.querySelector(".shh-btn-unblock");

  return {
    visible: hiddenAt === "none",
    hits,
    hiddenAt,
    hiddenOn: hiddenOn ? describe(hiddenOn) : null,
    inlineDisplay: node.style.getPropertyValue("display"),
    hasShhHidden,
    hasShhPban,
    hasDataShhResult: dataShhResult,
    preloadedAt,
    hasDataShhOk: node.hasAttribute("data-shh-ok") || !!node.querySelector("[data-shh-ok]"),
    hasPlaceholder: !!placeholder,
    hasShowControl,
    hasUnblockControl,
    trappedHidden: hiddenAt !== "none" && !hasShowControl && !hasUnblockControl,
  };
}

/** One-line human summary used in the scenario tables. */
export function summarise(r: VisibilityReport): string {
  if (r.visible) return "VISIBLE";
  const hit = r.hits.find((h) => h.property === "display" || h.property === "opacity");
  const layer = hit ? `${hit.origin}:${hit.property}` : "?";
  const mode = r.hasDataShhResult ?? (r.preloadedAt !== "none" ? "preload" : "-");
  const ctl = r.hasShowControl ? "+Show" : r.hasPlaceholder ? "(box,noShow)" : "NO-CONTROLS";
  return `hidden[${mode}] ${r.hiddenAt}:${r.hiddenOn} by ${layer} ${ctl}`;
}
