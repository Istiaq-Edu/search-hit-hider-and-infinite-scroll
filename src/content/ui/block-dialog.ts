import type { BlockMode } from "../../shared/types";
import { getDomainLevels, normalizeDomain } from "../../shared/domain-utils";

// ============================================================
// Block dialog — domain choice popover
// ============================================================

type DialogCallback = (domain: string, mode: BlockMode) => void;

let activeDialog: HTMLElement | null = null;

export function showBlockDialog(
  url: string,
  anchor: HTMLElement,
  onConfirm: DialogCallback,
  domainChoiceMode: "exact" | "root" | "ask" = "ask"
): void {
  dismissDialog();

  const hostname = extractHostname(url);
  if (!hostname) return;

  const normalized = normalizeDomain(hostname);
  const levels = getDomainLevels(normalized);

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

  const title = document.createElement("h4");
  title.textContent = "Choose domain level to block:";
  dialog.appendChild(title);

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
    dialog.appendChild(label);
  }

  const actions = document.createElement("div");
  actions.className = "shh-dialog-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "shh-dialog-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => dismissDialog());

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "shh-dialog-block";
  nextBtn.textContent = "Next →";
  nextBtn.addEventListener("click", () => {
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

  positionDialog(dialog, anchor);
  document.body.appendChild(dialog);
  activeDialog = dialog;

  // Close on outside click
  setTimeout(() => {
    document.addEventListener("click", outsideClickHandler, { once: true });
  }, 50);
}

function showModeDialog(
  domain: string,
  anchor: HTMLElement,
  onConfirm: DialogCallback
): void {
  const dialog = createDialog();

  const title = document.createElement("h4");
  title.textContent = `Block "${domain}"`;
  dialog.appendChild(title);

  const actions = document.createElement("div");
  actions.className = "shh-dialog-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "shh-dialog-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => dismissDialog());

  const blockBtn = document.createElement("button");
  blockBtn.type = "button";
  blockBtn.className = "shh-dialog-block";
  blockBtn.textContent = "Block";
  blockBtn.addEventListener("click", () => {
    dismissDialog();
    onConfirm(domain, "block");
  });

  const pbanBtn = document.createElement("button");
  pbanBtn.type = "button";
  pbanBtn.className = "shh-dialog-pban";
  pbanBtn.textContent = "Perma-ban";
  pbanBtn.addEventListener("click", () => {
    dismissDialog();
    onConfirm(domain, "pban");
  });

  actions.append(cancelBtn, blockBtn, pbanBtn);
  dialog.appendChild(actions);

  positionDialog(dialog, anchor);
  document.body.appendChild(dialog);
  activeDialog = dialog;

  setTimeout(() => {
    document.addEventListener("click", outsideClickHandler, { once: true });
  }, 50);
}

function createDialog(): HTMLElement {
  const div = document.createElement("div");
  div.className = "shh-dialog";
  div.setAttribute("role", "dialog");
  return div;
}

function positionDialog(dialog: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const top = rect.bottom + window.scrollY + 4;
  const left = Math.min(rect.left + window.scrollX, window.innerWidth - 360);
  dialog.style.cssText = `position:absolute;top:${top}px;left:${left}px`;
}

function outsideClickHandler(e: MouseEvent): void {
  if (activeDialog && !activeDialog.contains(e.target as Node)) {
    dismissDialog();
  }
}

export function dismissDialog(): void {
  activeDialog?.remove();
  activeDialog = null;
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    const m = url.match(/^(?:https?|ftp):\/\/([^/?#]+)/i);
    return m?.[1]?.split(":")?.[0] ?? "";
  }
}
