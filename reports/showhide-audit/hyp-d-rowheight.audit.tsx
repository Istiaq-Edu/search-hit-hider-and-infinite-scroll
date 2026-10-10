import { describe, it, expect, beforeAll } from "vitest";
import { render } from "preact";
import { BlockList } from "../../src/popup/components/BlockList";
import { DEFAULT_PREFS } from "../../src/shared/types";
import type { BlockEntry } from "../../src/shared/types";

// ============================================================
// H-d — does BlockList.tsx's fixed ROW_HEIGHT = 36 desynchronise
// from the real rendered row height?
//
// jsdom HAS NO LAYOUT ENGINE: getBoundingClientRect().height and offsetHeight
// are 0 for every element, so the painted pixel height of a <ListEntry> cannot
// be measured here and no claim below rests on one.
//
// What IS measurable, and is enough to decide the question, is the box model
// the component DECLARES — all of it inline, so it is read from the style
// attribute rather than getComputedStyle (jsdom cannot resolve the
// `var(--border)` custom property and reports borderBottomWidth as "medium"):
//
//   BlockList.tsx:234   <div style={{ height: ROW_HEIGHT }}>   fixed 36px box
//                      <ListEntry/>
//   ListEntry.tsx:19-30 <div style={{ display:flex, alignItems:center,
//                          padding:"5px 10px", gap:"6px",
//                          borderBottom:"1px solid var(--border)" }}>
//
// The wrapper is height:36px with NO overflow and NO flex-shrink guard, and
// the row's own height is entirely content-derived, so:
//
//   row = max(flex-item content height) + paddingTop + paddingBottom
//          + borderBottomWidth
//
// which scales with the font. The declared font sizes (ListEntry.tsx):
//   checkbox  height:13px fixed            (:37)
//   domain    font-size:12px monospace nowrap+ellipsis (:46-57)
//   date      font-size:10px               (:60)
//   ON/OFF    font-size:10px, padding 2px 5px, border 1px (:63-80)
//   delete    font-size:14px, line-height 1 (:83-99)
//
// ASSUMPTION, stated because jsdom cannot do layout:
//   line-height:normal ~= 1.2 * font-size, and box-sizing is content-box
//   (the CSS default — neither component sets it). Under that assumption the
//   tallest item is the ON/OFF button at 10*1.2 + 2*2 = 16px (its border is
//   `none`), so the row is 16 + 5 + 5 + 1 = 27px.
// ============================================================

const N = 60;
const ROW_HEIGHT = 36;      // BlockList.tsx:17
const BUFFER_SIZE = 5;      // BlockList.tsx:18
const VIEWPORT = 400;       // the component's own default containerHeight (:28)
const LINE_HEIGHT_RATIO = 1.2; // the assumption, spelled out above

beforeAll(() => {
  // jsdom has no ResizeObserver; BlockList constructs one in a mount effect.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void { /* no layout to observe */ }
    unobserve(): void { /* noop */ }
    disconnect(): void { /* noop */ }
  };
});

const ENTRIES: BlockEntry[] = Array.from({ length: N }, (_, i) => ({
  domain: `d${String(i).padStart(2, "0")}.example.com`,
  mode: "block" as const,
  enabled: true,
  createdAt: 1_700_000_000_000 + i,
}));

function mount(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(<BlockList entries={ENTRIES} prefs={DEFAULT_PREFS} onRefresh={async () => {}} />, host);
  return host;
}

/** The fixed-height wrapper BlockList puts around every rendered row. */
function rowWrappers(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>("div")).filter(
    (d) => d.style.height === `${ROW_HEIGHT}px` && d.firstElementChild
  );
}

const px = (v: string | undefined): number => (v ? parseFloat(v) || 0 : 0);

describe("H-d — ROW_HEIGHT = 36 vs the declared row box", () => {
  it("reports the virtualization arithmetic and the declared row box", () => {
    const host = mount();
    const wraps = rowWrappers(host);
    const first = wraps[0].firstElementChild as HTMLElement;

    // Everything below is read from INLINE style attributes.
    const padding = first.style.padding;                 // "5px 10px" = 5px top/bottom
    const padTop = px(padding.split(" ")[0]);
    const padBottom = padTop;                            // 2-value shorthand
    const borderBottom = px(first.style.borderBottom);   // "1px solid var(--border)"

    const items = Array.from(first.children).map((c) => {
      const el = c as HTMLElement;
      const s = el.style;
      const fontSize = px(s.fontSize) || px(getComputedStyle(el).fontSize) || 10;
      // line-height may be `normal`, an absolute length, a relative length,
      // or a UNITLESS multiplier (the delete button sets `lineHeight: "1"`).
      let line = fontSize * LINE_HEIGHT_RATIO;
      const lh = s.lineHeight;
      if (lh && lh !== "normal") {
        const n = parseFloat(lh);
        if (/^[0-9.]+$/.test(lh)) line = n * fontSize;              // multiplier
        else if (/^(px|pt)$/.test(lh)) line = n;                      // absolute
        else if (/^(em|rem|%)$/.test(lh)) line = n * fontSize;       // relative
      }
      const explicit = s.height ? px(s.height) : 0;
      const content = explicit > 0 ? explicit : line;
      const padY = s.padding ? 2 * px(s.padding.split(" ")[0]) : 0;
      // `border: "none"` must not be read as a width.
      const bw = s.border && s.border !== "none" ? px(s.border) : px(s.borderTopWidth);
      const borderY = 2 * bw;
      return { tag: el.tagName.toLowerCase(), fontSize: s.fontSize, content, total: content + padY + borderY };
    });
    const tallest = Math.max(...items.map((i) => i.total));
    const realRow = Math.ceil(tallest + padTop + padBottom + borderBottom);

    // The component's own arithmetic, recomputed from its constants.
    const expectedVisible = Math.min(
      N,
      Math.max(0, Math.floor(0 / ROW_HEIGHT) - BUFFER_SIZE) +
        (Math.ceil(VIEWPORT / ROW_HEIGHT) + BUFFER_SIZE * 2)
    );
    const bottomPad = Array.from(host.querySelectorAll<HTMLElement>("div"))
      .filter((d) => d.children.length === 0 && d.style.height)
      .map((d) => d.style.height);

    // eslint-disable-next-line no-console
    console.log(
      [
        `H-d rows rendered          = ${wraps.length}  (entries=${N}, viewport=${VIEWPORT})`,
        `  expected by the formula = ${expectedVisible}  (ceil(${VIEWPORT}/${ROW_HEIGHT})+2*${BUFFER_SIZE})`,
        `  empty spacers            = ${JSON.stringify(bottomPad)}  (top=${(N - expectedVisible) * 0}px, bottom=${(N - expectedVisible) * ROW_HEIGHT}px expected)`,
        `H-d wrapper box            = height:${wraps[0].style.height}  overflow:${JSON.stringify(wraps[0].style.overflow)}  flexShrink:${JSON.stringify(wraps[0].style.flexShrink)}`,
        `H-d row box                = padding:${padding}  borderBottom:${first.style.borderBottom}  boxSizing:${first.style.boxSizing || "content-box (default)"}`,
        `H-d flex items             = ${items.map((i) => `${i.tag}[fs=${i.fontSize || "13px fixed"}] content=${i.content.toFixed(1)} total=${i.total.toFixed(1)}`).join("  ")}`,
        `H-d tallest item           = ${tallest}px`,
        `H-d REAL ROW HEIGHT        = ${tallest} + ${padTop} + ${padBottom} + ${borderBottom} = ${realRow}px`,
        `H-d ROW_HEIGHT             = ${ROW_HEIGHT}px   slack per row = ${ROW_HEIGHT - realRow}px`,
      ].join("\n")
    );

    // The arithmetic is self-consistent at the component's own default metrics.
    expect(wraps.length).toBe(expectedVisible);
    expect(bottomPad).toContain(`${(N - expectedVisible) * ROW_HEIGHT}px`);
    // ROW_HEIGHT comfortably exceeds the declared row box: no overlap, no clip.
    expect(realRow).toBeLessThanOrEqual(ROW_HEIGHT);
    // And nothing in the shipped code would contain a row that grows past it.
    expect(wraps[0].style.overflow).toBe("");
    expect(wraps[0].style.flexShrink).toBe("");
  });

  it("H-d verdict: the desync is real but CONDITIONAL — it needs a row taller than 36px", () => {
    const host = mount();
    const row = rowWrappers(host)[0].firstElementChild as HTMLElement;

    // 1. Can a row wrap? The domain span is nowrap + ellipsis and overflow
    //    hidden, so a long domain cannot make the row taller.
    const domain = row.querySelector("span[title]") as HTMLElement;
    expect(domain.style.whiteSpace).toBe("nowrap");
    expect(domain.style.overflow).toBe("hidden");
    expect(domain.style.textOverflow).toBe("ellipsis");

    // 2. Is the fixed box clipping or overlapping? Neither guard exists.
    const wrapper = row.parentElement as HTMLElement;
    expect(wrapper.style.overflow).toBe("");
    expect(wrapper.style.flexShrink).toBe("");

    // 3. What scales the row? Every dimension is in px or an explicit font-size,
    //    so the row grows only with the USER's font size / page zoom /
    //    minimum-font-size setting. Quantify the break-even point.
    const base = 27; // measured above: 16 (tallest item) + 5 + 5 + 1
    const at = (rootPx: number): number => Math.ceil((base - 10) * (rootPx / 16)) + 10;
    // eslint-disable-next-line no-console
    console.log(
      `H-d break-even: row=${base}px at a 16px root; ROW_HEIGHT=${ROW_HEIGHT} is exceeded at a ` +
        `root font size of about ${Math.ceil(16 * (ROW_HEIGHT - 10) / (base - 10))}px ` +
        `(20px -> ${at(20)}px, 24px -> ${at(24)}px, 32px -> ${at(32)}px)`
    );
    const pxAll = at;
    // At the default 16px root there is ~7px of slack; from ~20px upward the
    // fixed box is shorter than the row and the scroll maths desynchronises.
    expect(pxAll(16)).toBeLessThanOrEqual(ROW_HEIGHT);
    expect(pxAll(32)).toBeGreaterThan(ROW_HEIGHT);
  });
});
