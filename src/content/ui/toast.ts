// ============================================================
// Undo toast — bottom-center, 4s, with Undo button
// ============================================================

let activeToast: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(
  message: string,
  onUndo: () => void,
  undoLabel = "Undo",
  durationMs = 4000
): void {
  // Remove any existing toast
  dismissToast();

  const toast = document.createElement("div");
  toast.className = "shh-toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");

  const text = document.createElement("span");
  text.textContent = message;

  const undoBtn = document.createElement("button");
  undoBtn.type = "button";
  undoBtn.className = "shh-toast-undo";
  undoBtn.textContent = undoLabel;
  undoBtn.addEventListener("click", () => {
    dismissToast();
    onUndo();
  });

  toast.append(text, undoBtn);
  document.body.appendChild(toast);
  activeToast = toast;

  toastTimer = setTimeout(() => {
    dismissToast();
  }, durationMs);
}

export function dismissToast(): void {
  if (toastTimer !== null) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  activeToast?.remove();
  activeToast = null;
}
