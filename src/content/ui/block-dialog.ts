import type { BlockMode } from "../../shared/types";
import { getDomainLevels, normalizeDomain } from "../../shared/domain-utils";

// ============================================================
// Block dialog — domain choice popover
// ============================================================

type DialogCallback = (domain: string, mode: BlockMode) => void;

let activeDialog: HTMLElement | null = null;
// The element that had focus when the dialog opened. Restoring it on close is
// what keeps keyboard interaction from dropping back to <body>.
let previousFocus: HTMLElement | null = null;
let dialogSeq = 0;
// Arming is delayed so the click that OPENED the dialog cannot immediately
// close it. That timer used to be fire-and-forget: a dialog dismissed inside
// the 50 ms window still attached a document-level listener afterwards, and
// the `{ once: true }` listener outlived its dialog. Track both and tear them
// down in dismissDialog().
let outsideArmTimer: number | null = null;

export function showBlockDialog(
  url: string,
  anchor: HTMLElement,
  onConfirm: DialogCallback,
  domainChoiceMode: "exact" | "root" | "ask" = "ask",
  stripWww = true
): void {
  const trigger =
    document.activeElement instanceof HTMLElement ? document.activeElement : anchor;
  dismissDialog();
  previousFocus = trigger;

  const hostname = extractHostname(url);
  if (!hostname) {
    previousFocus = null;
    return;
  }

  const normalized = normalizeDomain(hostname, stripWww);
  const levels = getDomainLevels(normalized, stripWww);

  if (domainChoiceMode === "exact" || levels.length <= 1) {
    // No dialog needed — use the most specific level
    showModeDialog(normalized, anchor, onConfirm);
    return;
  }

  if (domainChoiceMode === "root") {
    const root = levels[levels.length - 1] ?? normalized;
    showModeDialog(root, anchor, onConfirm);
    return;
  }

  // "ask" — show domain choice first, then mode choice.
  // Default selection is the most specific level (subdomain / full hostname),
  // i.e. levels[0]. User can pick a broader level if they want.
  showDomainChoiceDialog(levels, anchor, (chosen) => {
    showModeDialog(chosen, anchor, onConfirm);
  });
}

function showDomainChoiceDialog(
  levels: string[],
  anchor: HTMLElement,
  onChosen: (domain: string) => void
): void {
  const dialog = createDialog();
  const title = appendTitle(dialog, "Choose domain level to block:");

  const group = document.createElement("div");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-labelledby", title.id);

  // Default to the most specific (subdomain / full hostname) — levels[0].
  // The user can broaden to the root domain by selecting a lower option.
  let selected = levels[0] ?? "";

  for (const level of levels) {
    const label = document.createElement("label");
    label.className = "shh-dialog-option";

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "shh-domain-level";
    radio.value = level;
    radio.checked = level === selected;
    radio.addEventListener("change", () => { selected = level; });

    const span = document.createElement("span");
    span.textContent = level;

    label.append(radio, span);
    group.appendChild(label);
  }
  dialog.appendChild(group);

  const actions = document.createElement("div");
  actions.className = "shh-dialog-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "shh-dialog-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    dismissDialog();
  });

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "shh-dialog-block";
  nextBtn.textContent = "Next →";
  nextBtn.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    // Capture current selection before dismissing
    const chosen = selected;
    dismissDialog();
    // Defer past the current click-bubble so outsideClickHandler fires while
    // activeDialog is null (from dismissDialog above) and doesn't immediately
    // close the mode dialog that showModeDialog is about to create.
    setTimeout(() => onChosen(chosen), 0);
  });

  actions.append(cancelBtn, nextBtn);
  dialog.appendChild(actions);

  mountDialog(dialog, anchor);
}

function showModeDialog(
  domain: string,
  anchor: HTMLElement,
  onConfirm: DialogCallback
): void {
  const dialog = createDialog();
  appendTitle(dialog, `Block "${domain}"`);

  const actions = document.createElement("div");
  actions.className = "shh-dialog-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "shh-dialog-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    dismissDialog();
  });

  const blockBtn = document.createElement("button");
  blockBtn.type = "button";
  blockBtn.className = "shh-dialog-block";
  blockBtn.textContent = "Block";
  blockBtn.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    dismissDialog();
    onConfirm(domain, "block");
  });

  const pbanBtn = document.createElement("button");
  pbanBtn.type = "button";
  pbanBtn.className = "shh-dialog-pban";
  pbanBtn.textContent = "Perma-ban";
  pbanBtn.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    dismissDialog();
    onConfirm(domain, "pban");
  });

  actions.append(cancelBtn, blockBtn, pbanBtn);
  dialog.appendChild(actions);

  mountDialog(dialog, anchor);
}

function createDialog(): HTMLElement {
  const div = document.createElement("div");
  div.className = "shh-dialog";
  div.setAttribute("role", "dialog");
  div.setAttribute("aria-modal", "true");
  return div;
}

function appendTitle(dialog: HTMLElement, text: string): HTMLElement {
  const title = document.createElement("h4");
  title.id = `shh-dialog-title-${++dialogSeq}`;
  title.textContent = text;
  dialog.setAttribute("aria-labelledby", title.id);
  dialog.appendChild(title);
  return title;
}

function mountDialog(dialog: HTMLElement, anchor: HTMLElement): void {
  // The two-step flow (domain → mode) runs through dismissDialog() between
  // dialogs, which clears previousFocus before the second dialog mounts.
  // Capture whatever focus dismissDialog just restored (the original
  // trigger), or the final close would drop focus back to <body>.
  if (!previousFocus) {
    previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  positionDialog(dialog, anchor);
  document.body.appendChild(dialog);
  activeDialog = dialog;
  // Listen on the document, not the dialog: page scripts can move focus out
  // of the dialog, and a dialog-scoped listener then stops seeing Escape and
  // Tab — leaving an aria-modal dialog that keyboard users cannot dismiss.
  document.addEventListener("keydown", onDialogKeydown, true);
  // Least-destructive control first: Cancel in the mode dialog, the default
  // radio in the domain dialog. Enter can never trigger a block by accident.
  getFocusable(dialog)[0]?.focus({ preventScroll: true });
  armOutsideClick();
}

function getFocusable(root: HTMLElement): HTMLElement[] {
  const selector =
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(selector));
}

function onDialogKeydown(e: KeyboardEvent): void {
  if (!e.isTrusted) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    dismissDialog();
    return;
  }
  if (e.key !== "Tab" || !activeDialog) return;

  const focusables = getFocusable(activeDialog);
  if (focusables.length === 0) return;
  const active = document.activeElement as HTMLElement | null;
  const index = active ? focusables.indexOf(active) : -1;
  const next = e.shiftKey
    ? index <= 0 ? focusables.length - 1 : index - 1
    : index === -1 || index === focusables.length - 1 ? 0 : index + 1;

  // Wrap inside the dialog: Tab otherwise escapes into the page behind it,
  // which aria-modal tells assistive tech is unavailable.
  e.preventDefault();
  focusables[next]?.focus();
}

function positionDialog(dialog: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const top = rect.bottom + window.scrollY + 4;
  const left = Math.min(rect.left + window.scrollX, window.innerWidth - 360);
  dialog.style.cssText = `position:absolute;top:${top}px;left:${left}px`;
}

function armOutsideClick(): void {
  if (outsideArmTimer !== null) clearTimeout(outsideArmTimer);
  outsideArmTimer = window.setTimeout(() => {
    outsideArmTimer = null;
    if (!activeDialog) return;
    document.addEventListener("click", outsideClickHandler);
  }, 50);
}

function outsideClickHandler(e: MouseEvent): void {
  // Page scripts can dispatch document-level clicks; they must not tear down
  // a dialog the user is interacting with.
  if (!e.isTrusted) return;
  if (!activeDialog) {
    document.removeEventListener("click", outsideClickHandler);
    return;
  }
  if (!activeDialog.contains(e.target as Node)) {
    dismissDialog({ preserveNewFocus: true });
  }
}

export function dismissDialog(opts: { preserveNewFocus?: boolean } = {}): void {
  if (outsideArmTimer !== null) {
    clearTimeout(outsideArmTimer);
    outsideArmTimer = null;
  }
  document.removeEventListener("click", outsideClickHandler);
  document.removeEventListener("keydown", onDialogKeydown, true);
  // Outside-click dismissal must not steal focus from the control the user
  // just clicked (the browser already focused it on mousedown). Keyboard
  // dismissal is the opposite: focus may have escaped the dialog and must be
  // reclaimed, or the user is left on an unrelated element.
  const active = document.activeElement;
  const focusInside = !!activeDialog && !!active && activeDialog.contains(active);
  const focusOnPage =
    active === null || active === document.body || active === document.documentElement;
  activeDialog?.remove();
  activeDialog = null;

  const restore = previousFocus;
  previousFocus = null;
  if (restore?.isConnected && (!opts.preserveNewFocus || focusInside || focusOnPage)) {
    restore.focus({ preventScroll: true });
  }
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    const m = url.match(/^(?:https?|ftp):\/\/([^/?#]+)/i);
    return m?.[1]?.split(":")?.[0] ?? "";
  }
}
