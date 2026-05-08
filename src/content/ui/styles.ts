// ============================================================
// CSS injection — scoped, page-color-aware, dark/light adaptive
// ============================================================

const STYLE_ID = "shh-base-styles";

/**
 * Detect the search page's background and text color from the root element.
 * Returns CSS variable overrides to match the page's color scheme.
 */
function detectPageColors(): { bg: string; text: string; border: string; isDark: boolean } {
  const body = document.body;
  const computed = window.getComputedStyle(body);
  const bgColor = computed.backgroundColor || "#ffffff";

  const isDark = isColorDark(bgColor);

  return {
    bg: isDark ? "#2a2a2a" : "#f0f0f0",
    text: isDark ? "#cccccc" : "#555555",
    border: isDark ? "#444444" : "#cccccc",
    isDark,
  };
}

function isColorDark(color: string): boolean {
  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match?.[1] || !match[2] || !match[3]) return false;
  const r = parseInt(match[1]);
  const g = parseInt(match[2]);
  const b = parseInt(match[3]);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5;
}

export function injectBaseStyles(): void {
  if (document.getElementById(STYLE_ID)) return;

  const colors = detectPageColors();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = getBaseCSS(colors);
  document.head.appendChild(style);
}

function getBaseCSS(colors: {
  bg: string;
  text: string;
  border: string;
  isDark: boolean;
}): string {
  const mutedText   = colors.isDark ? "#999" : "#888";
  const accentFaded = colors.isDark ? "rgba(26,58,107,0.35)" : "rgba(26,58,107,0.22)";

  return `
/* Search-Hit-Hider injected styles */

/* ── Block button (solid navy pill) ─────────────────────────── */
.shh-block-btn {
  display: inline-flex;
  align-items: center;
  font-size: 0.75em;
  font-family: Arial, sans-serif;
  color: #fff !important;
  background: #1a3a6b !important;
  border: none !important;
  border-radius: 20px;
  padding: 2px 9px;
  margin: 0 4px;
  cursor: pointer;
  line-height: 1.4;
  vertical-align: middle;
  white-space: nowrap;
  transition: background 0.12s, opacity 0.15s;
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
}
.shh-block-btn:hover {
  background: #0d2244 !important;
  color: #fff !important;
}

/* ── Show on hover mode ──────────────────────────────────────── */
/* data-shh-btn is set on the result card node (see block-button.ts).
   The button is a descendant, so :hover on the card reveals it. */
.shh-hover-mode [data-shh-btn] .shh-block-btn {
  opacity: 0;
  pointer-events: none;
}
.shh-hover-mode [data-shh-btn]:hover .shh-block-btn {
  opacity: 1;
  pointer-events: auto;
}

/* ── Placeholder (balanced — noticeable but not distracting) ─── */
/* "example.com · hidden  [show] [unblock] [perma]"
   Light background strip with a faint navy left accent.
   Readable but calm — sits between invisible and eye-catching. */
.shh-placeholder {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 4px 8px;
  margin: 2px 0;
  background: ${colors.isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)"};
  border-left: 2px solid ${accentFaded};
  border-radius: 0 3px 3px 0;
  font-size: 0.79em;
  font-family: Arial, sans-serif;
  color: ${mutedText};
  line-height: 1.5;
}
.shh-placeholder-domain {
  font-weight: 600;
  color: ${colors.isDark ? "#aaa" : "#666"};
  letter-spacing: 0.01em;
}
.shh-placeholder-sep {
  color: ${mutedText};
  opacity: 0.5;
}
.shh-placeholder-label {
  color: ${mutedText};
  margin-right: 3px;
}

/* ── Shared action buttons ───────────────────────────────────── */
/* Text-link style — no box, no background. Subtle underline on hover. */
.shh-btn {
  font-size: 0.85em;
  font-family: Arial, sans-serif;
  border: none;
  background: transparent;
  padding: 0 3px;
  cursor: pointer;
  color: ${mutedText};
  line-height: 1.5;
  transition: color 0.1s;
}
.shh-btn:hover {
  color: ${colors.isDark ? "#bbb" : "#666"};
  text-decoration: underline;
}
/* "Show Hit" — slightly warmer tint to hint it does something */
.shh-btn-show {
  color: ${colors.isDark ? "#887755" : "#997733"};
}
.shh-btn-show:hover {
  color: ${colors.isDark ? "#bbaa66" : "#775500"};
}
/* "Unblock" — subtle green tint */
.shh-btn-unblock {
  color: ${colors.isDark ? "#557755" : "#448844"};
}
.shh-btn-unblock:hover {
  color: ${colors.isDark ? "#77bb77" : "#226622"};
}
/* "Perma" — muted red to signal the stronger hide mode */
.shh-btn-perma {
  color: ${colors.isDark ? "#8a5a5a" : "#9a4a4a"};
}
.shh-btn-perma:hover {
  color: ${colors.isDark ? "#c87878" : "#7a2222"};
}
/* "Hide Again" — neutral */
.shh-btn-rehide {
  color: ${mutedText};
}
.shh-btn-rehide:hover {
  color: ${colors.isDark ? "#bbb" : "#555"};
}

/* ── Shown-result wrapper box ────────────────────────────────── */
/* Applied to the result node itself when temporarily visible.
   Wraps the entire result content (notice strip + title + snippet + …)
   in a unified container so it reads as one coherent "shown" block. */
.shh-shown-result {
  border: 1px solid ${colors.isDark ? "#555533" : "#d4c460"} !important;
  border-left: 3px solid ${colors.isDark ? "#998833" : "#c8a800"} !important;
  border-radius: 4px !important;
  background: ${colors.isDark ? "rgba(60,55,0,0.18)" : "rgba(255,250,210,0.35)"} !important;
  padding: 6px 10px 6px 10px !important;
  margin: 2px 0 !important;
  box-sizing: border-box !important;
}

/* ── Shown-notice strip (header of the wrapper box) ─────────── */
/* A single quiet line at the top of the result:
   "example.com · showing once  [Hide Again]  [Unblock]"
   Separated from the result content by a fine bottom border. */
.shh-shown-notice {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 0 0 4px 0;
  margin: 0 0 6px 0;
  border-bottom: 1px solid ${colors.isDark ? "#554400" : "#ddd0a0"};
  font-size: 0.76em;
  font-family: Arial, sans-serif;
  color: ${mutedText};
  line-height: 1.5;
}
.shh-shown-domain {
  font-weight: 600;
  color: ${colors.isDark ? "#998833" : "#776600"};
  white-space: nowrap;
}
.shh-shown-sep {
  opacity: 0.5;
}
.shh-shown-label {
  opacity: 0.7;
  margin-right: 2px;
}

/* ── Block dialog popover ───────────────────────────────────── */
.shh-dialog {
  position: fixed;
  z-index: 999999;
  background: ${colors.isDark ? "#2b2b2b" : "#fff"};
  border: 1px solid ${colors.border};
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,${colors.isDark ? "0.6" : "0.18"});
  padding: 14px 18px;
  font-family: sans-serif;
  font-size: 13px;
  color: ${colors.isDark ? "#ddd" : "#222"};
  min-width: 240px;
  max-width: 340px;
}
.shh-dialog h4 {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
}
.shh-dialog-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 4px;
  border-radius: 4px;
  cursor: pointer;
}
.shh-dialog-option:hover {
  background: ${colors.isDark ? "#383838" : "#f0f0f0"};
}
.shh-dialog-option input[type="radio"] {
  accent-color: #4a90e2;
}
.shh-dialog-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  justify-content: flex-end;
}
.shh-dialog-cancel {
  background: ${colors.isDark ? "#444" : "#eee"};
  color: ${colors.isDark ? "#ccc" : "#333"};
  border: 1px solid ${colors.border};
  border-radius: 4px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 12px;
}
.shh-dialog-block {
  background: #4a90e2;
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
.shh-dialog-pban {
  background: #e24a4a;
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}

/* ── Undo toast ─────────────────────────────────────────────── */
.shh-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: ${colors.isDark ? "#333" : "#222"};
  color: #fff;
  padding: 10px 18px;
  border-radius: 6px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.35);
  font-family: sans-serif;
  font-size: 13px;
  z-index: 999998;
  display: flex;
  align-items: center;
  gap: 12px;
  animation: shh-toast-in 0.2s ease;
}
.shh-toast-undo {
  background: #5cb85c;
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 3px 10px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
@keyframes shh-toast-in {
  from { opacity: 0; transform: translateX(-50%) translateY(10px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}

@media print {
  .shh-block-btn, .shh-toast, .shh-dialog { display: none !important; }
}
`;
}
