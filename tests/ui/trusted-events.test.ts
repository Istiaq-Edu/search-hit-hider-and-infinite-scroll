// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  injectBlockButton,
  removeAllBlockButtons,
  ATTR_HAS_BTN,
} from "../../src/content/ui/block-button";
import { showToast, dismissToast } from "../../src/content/ui/toast";
import { Sentinel } from "../../src/content/infinite-scroll/sentinel";
import { hideResult, showOnce } from "../../src/content/blocking/hider";

// ============================================================
// Page-script click forgery guards
//
// Content scripts share the DOM with the page. A page script can find our
// injected controls and dispatch synthetic clicks on them; dispatching an
// event does NOT make it trusted. Every control that mutates the blocklist or
// changes hiding state must ignore those events. These drive the shipped
// handlers with real dispatchEvent() calls, so removing `if (!e.isTrusted)
// return` fails here.
//
// Runs under happy-dom because jsdom defines `isTrusted` as a non-configurable
// own getter on every Event, which makes the trusted half untestable. Verified
// happy-dom exposes it as an ordinary configurable property.
// ============================================================

function click(el: Element, trusted: boolean): MouseEvent {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  if (trusted) {
    Object.defineProperty(ev, "isTrusted", { configurable: true, value: true });
  }
  el.dispatchEvent(ev);
  return ev;
}

afterEach(() => {
  dismissToast();
  document.body.innerHTML = "";
});

// ============================================================
// Block button
// ============================================================
describe("injected block button", () => {
  it("ignores a synthetic click and leaves the default action alone", () => {
    const container = document.createElement("div");
    const heading = document.createElement("h3");
    container.appendChild(heading);
    document.body.appendChild(container);

    const onClick = vi.fn();
    const btn = injectBlockButton(container, heading, "append", "text", onClick)!;

    const ev = click(btn, false);
    expect(onClick).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("runs the real handler for a trusted click and stops page listeners seeing it", () => {
    const container = document.createElement("div");
    const heading = document.createElement("h3");
    container.appendChild(heading);
    document.body.appendChild(container);

    const onClick = vi.fn();
    const pageListener = vi.fn();
    document.body.addEventListener("click", pageListener);
    const btn = injectBlockButton(container, heading, "append", "text", onClick)!;

    const ev = click(btn, true);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    expect(pageListener).not.toHaveBeenCalled();
    document.body.removeEventListener("click", pageListener);
  });

  it("removeAllBlockButtons also clears the container stamps", () => {
    const container = document.createElement("div");
    const heading = document.createElement("h3");
    container.appendChild(heading);
    document.body.appendChild(container);

    injectBlockButton(container, heading, "append", "text", () => {});
    expect(container.getAttribute(ATTR_HAS_BTN)).toBe("1");

    removeAllBlockButtons();
    expect(document.querySelectorAll(".shh-block-btn")).toHaveLength(0);
    expect(container.hasAttribute(ATTR_HAS_BTN)).toBe(false);
  });
});

// ============================================================
// Undo toast
// ============================================================
describe("undo toast", () => {
  it("ignores a synthetic click on Undo", () => {
    const onUndo = vi.fn();
    showToast("Blocked: example.com", onUndo);
    const undo = document.querySelector(".shh-toast-undo")!;

    click(undo, false);
    expect(onUndo).not.toHaveBeenCalled();
    expect(document.querySelector(".shh-toast")).not.toBeNull();
  });

  it("undoes a real user click and dismisses the toast first", () => {
    let toastPresentDuringUndo: boolean | null = null;
    showToast("Blocked: example.com", () => {
      toastPresentDuringUndo = document.querySelector(".shh-toast") !== null;
    });
    const undo = document.querySelector(".shh-toast-undo")!;

    click(undo, true);
    expect(toastPresentDuringUndo).toBe(false);
    expect(document.querySelector(".shh-toast")).toBeNull();
  });
});

// ============================================================
// Infinite-scroll retry
// ============================================================
describe("infinite-scroll retry", () => {
  it("ignores a synthetic click on Try Again", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const sentinel = new Sentinel(container);
    const onRetry = vi.fn();
    sentinel.setState("error", onRetry);

    click(document.getElementById("is-retry-btn")!, false);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries on a trusted click", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const sentinel = new Sentinel(container);
    const onRetry = vi.fn();
    sentinel.setState("error", onRetry);

    const ev = click(document.getElementById("is-retry-btn")!, true);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });
});

// ============================================================
// Hidden-result placeholder and shown-once notice bar
// ============================================================
const RESULT = { matched: true, mode: "block" as const, domain: "blocked.com" };

function hiddenResult() {
  document.body.innerHTML =
    '<div id="wrap"><div id="result"><h3>Blocked result</h3></div></div>';
  const node = document.getElementById("result")!;
  const callbacks = {
    show: vi.fn(),
    unblock: vi.fn(),
    perma: vi.fn(),
  };
  hideResult(
    node,
    RESULT,
    "https://blocked.com/path",
    true,
    callbacks.show,
    callbacks.unblock,
    callbacks.perma
  );
  const placeholder = node.previousElementSibling as HTMLElement;
  return { node, placeholder, callbacks };
}

describe("hidden-result placeholder", () => {
  it("ignores synthetic clicks on Show, Unblock and Perma", () => {
    const { placeholder, callbacks } = hiddenResult();

    click(placeholder.querySelector(".shh-btn-show")!, false);
    click(placeholder.querySelector(".shh-btn-unblock")!, false);
    click(placeholder.querySelector(".shh-btn-perma")!, false);

    expect(callbacks.show).not.toHaveBeenCalled();
    expect(callbacks.unblock).not.toHaveBeenCalled();
    expect(callbacks.perma).not.toHaveBeenCalled();
    expect(placeholder.isConnected).toBe(true);
  });

  it("Show removes the placeholder and calls back on a trusted click", () => {
    const { placeholder, callbacks } = hiddenResult();
    click(placeholder.querySelector(".shh-btn-show")!, true);
    expect(callbacks.show).toHaveBeenCalledTimes(1);
    expect(placeholder.isConnected).toBe(false);
  });

  it("Unblock keeps the placeholder until the restore actually succeeds", () => {
    const { placeholder, callbacks } = hiddenResult();
    click(placeholder.querySelector(".shh-btn-unblock")!, true);
    expect(callbacks.unblock).toHaveBeenCalledWith("blocked.com");
    expect(placeholder.isConnected).toBe(true);
  });

  it("Perma keeps the placeholder until the durable write succeeds", () => {
    // Same contract as Unblock: doPermaban() persists first and
    // convertHiddenToPermaban() removes the placeholder only after the write
    // succeeds. An eagerly removed placeholder leaves a failed write with no
    // control to retry.
    const { node, placeholder, callbacks } = hiddenResult();
    click(placeholder.querySelector(".shh-btn-perma")!, true);
    expect(callbacks.perma).toHaveBeenCalledWith("blocked.com", node);
    expect(placeholder.isConnected).toBe(true);
  });
});

describe("shown-once notice bar", () => {
  function shownResult() {
    document.body.innerHTML = '<div id="wrap"><div id="result"><h3>Result</h3></div></div>';
    const node = document.getElementById("result")!;
    const onHideAgain = vi.fn();
    const onUnblock = vi.fn();
    showOnce(node, "blocked.com", onHideAgain, onUnblock);
    const bar = node.querySelector(".shh-shown-notice") as HTMLElement;
    return { node, bar, onHideAgain, onUnblock };
  }

  it("ignores synthetic clicks on Hide Again and Unblock", () => {
    const { bar, onHideAgain, onUnblock } = shownResult();

    click(bar.querySelector(".shh-btn-rehide")!, false);
    click(bar.querySelector(".shh-btn-unblock")!, false);

    expect(onHideAgain).not.toHaveBeenCalled();
    expect(onUnblock).not.toHaveBeenCalled();
    expect(bar.isConnected).toBe(true);
  });

  it("Hide Again runs on a trusted click", () => {
    const { bar, onHideAgain } = shownResult();
    click(bar.querySelector(".shh-btn-rehide")!, true);
    expect(onHideAgain).toHaveBeenCalledTimes(1);
  });

  it("Unblock keeps the bar until the restore actually succeeds", () => {
    const { bar, onUnblock } = shownResult();
    click(bar.querySelector(".shh-btn-unblock")!, true);
    expect(onUnblock).toHaveBeenCalledWith("blocked.com");
    // A failed background write must leave the control available; the real
    // restore path removes the whole bar via restoreResult().
    expect(bar.isConnected).toBe(true);
  });
});
