// ============================================================
// Block button injection — adds a "block" button next to results
// ============================================================

const ATTR_HAS_BTN = "data-shh-btn";
const BLOCK_ICON = "✕";

export function injectBlockButton(
  container: Element,
  insertTarget: Element,
  insertPosition: "after" | "append" | "before",
  buttonStyle: "text" | "icon" | "icon+text",
  onClick: (e: MouseEvent) => void
): HTMLButtonElement | null {
  if (container.getAttribute(ATTR_HAS_BTN)) return null;
  container.setAttribute(ATTR_HAS_BTN, "1");

  const label =
    buttonStyle === "icon"      ? BLOCK_ICON :
    buttonStyle === "icon+text" ? `${BLOCK_ICON} block` :
                                  "block";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "shh-block-btn";
  btn.textContent = label;
  btn.title = "Block this domain with Search-Hit-Hider";
  btn.setAttribute("aria-label", "Block domain from search results");
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick(e);
  });

  try {
    if (insertPosition === "after") {
      insertTarget.after(btn);
    } else if (insertPosition === "before") {
      insertTarget.before(btn);
    } else {
      insertTarget.appendChild(btn);
    }
  } catch {
    // DOM insertion failed (detached node etc)
    return null;
  }

  return btn;
}

/**
 * Remove all injected block buttons from the page.
 */
export function removeAllBlockButtons(): void {
  for (const btn of document.querySelectorAll(".shh-block-btn")) {
    btn.remove();
  }
  for (const el of document.querySelectorAll(`[${ATTR_HAS_BTN}]`)) {
    el.removeAttribute(ATTR_HAS_BTN);
  }
}
