// ============================================================
// Block button injection — adds a "block" button next to results
// ============================================================

export const ATTR_HAS_BTN = "data-shh-btn";
const BLOCK_ICON = "✕";

/**
 * True when `el` already has one of our block buttons as an IMMEDIATE child.
 * Deliberately not a `querySelector` — it must not reach into a deep subtree
 * and suppress a legitimate injection somewhere further down.
 */
function hasDirectButton(el: Element | null): boolean {
  if (!el) return false;
  for (const child of Array.from(el.children)) {
    if (child.classList.contains("shh-block-btn")) return true;
  }
  return false;
}

export function injectBlockButton(
  container: Element,
  insertTarget: Element,
  insertPosition: "after" | "append" | "before",
  buttonStyle: "text" | "icon" | "icon+text",
  onClick: (e: MouseEvent) => void
): HTMLButtonElement | null {
  if (container.getAttribute(ATTR_HAS_BTN)) return null;

  // *** DUPLICATE-TARGET GUARD ***
  // Last line of defence against two buttons landing in one heading.
  //
  // Two different "result" nodes can resolve to the SAME button target — most
  // often a page wrapper and the genuine result inside it, which the observer
  // can hand us as two separate additions (see blocking/dedupe.ts). The
  // container check above stamps the node, not the target, so it cannot see
  // this: two distinct nodes, one shared <h3>.
  //
  // Before this guard the heading ended up with two identical buttons, and
  // each carried its own click handler — one click opened two dialogs, or
  // with one-click mode blocked the domain twice.
  //
  // Restricted to DIRECT children of the target and of its parent, so an
  // unrelated button further down a deep subtree can never suppress a
  // legitimate injection.
  if (hasDirectButton(insertTarget)) return null;
  if (insertPosition !== "append" && hasDirectButton(insertTarget.parentElement)) {
    return null;
  }

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
