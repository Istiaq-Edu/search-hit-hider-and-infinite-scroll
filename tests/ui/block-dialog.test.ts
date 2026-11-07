// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { showBlockDialog, dismissDialog } from "../../src/content/ui/block-dialog";

// ============================================================
// Block dialog — accessibility and trust wiring
//
// The dialog is injected into a page whose scripts share the DOM, so it has
// two jobs that are easy to regress without noticing:
//   1. be a real modal for keyboard/AT users (labeled, focus-trapped, Escape,
//      focus restored to the trigger), and
//   2. never let synthetic page events activate it or dismiss it.
// These drive the shipped module with real dispatched events.
//
// happy-dom, not jsdom: jsdom's Event.isTrusted is a non-configurable own
// getter, so the trusted half of every guard is untestable there.
// ============================================================

function click(el: Element, trusted: boolean): MouseEvent {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  if (trusted) {
    Object.defineProperty(ev, "isTrusted", { configurable: true, value: true });
  }
  el.dispatchEvent(ev);
  return ev;
}

function press(el: Element, key: string, trusted: boolean, shiftKey = false): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  if (trusted) {
    Object.defineProperty(ev, "isTrusted", { configurable: true, value: true });
  }
  el.dispatchEvent(ev);
  return ev;
}

function makeTrigger(): HTMLButtonElement {
  const trigger = document.createElement("button");
  trigger.textContent = "block";
  document.body.appendChild(trigger);
  trigger.focus();
  return trigger;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  dismissDialog();
  document.body.innerHTML = "";
});

describe("showBlockDialog — dialog semantics", () => {
  it("renders an aria-modal dialog whose title labels both dialog and radiogroup", () => {
    const trigger = makeTrigger();
    showBlockDialog("https://blog.example.com/page", trigger, () => {}, "ask", true);

    const dialog = document.querySelector<HTMLElement>(".shh-dialog")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    const titleId = dialog.getAttribute("aria-labelledby")!;
    const title = document.getElementById(titleId)!;
    expect(title.textContent).toBe("Choose domain level to block:");

    const group = dialog.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-labelledby")).toBe(titleId);
  });

  it("defaults to the most specific level and focuses it", () => {
    const trigger = makeTrigger();
    showBlockDialog("https://blog.example.com/page", trigger, () => {}, "ask", true);

    const radios = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="radio"]')
    );
    expect(radios.map((r) => r.value)).toEqual(["blog.example.com", "example.com"]);
    expect(radios[0]!.checked).toBe(true);
    // Least-destructive control first: Enter on open cannot block anything.
    expect(document.activeElement).toBe(radios[0]);
  });

  it("skips the domain step when there is only one level", () => {
    const trigger = makeTrigger();
    showBlockDialog("https://example.com/page", trigger, () => {}, "ask", true);

    expect(document.querySelector(".shh-dialog")?.textContent).toContain('Block "example.com"');
    expect(document.querySelector('[role="radiogroup"]')).toBeNull();
    expect(document.activeElement).toBe(document.querySelector(".shh-dialog-cancel"));
  });

  it("honours root mode without asking", () => {
    const trigger = makeTrigger();
    showBlockDialog("https://blog.example.com/page", trigger, () => {}, "root", true);
    expect(document.querySelector(".shh-dialog")?.textContent).toContain('Block "example.com"');
  });

  it("opens the mode dialog directly in exact mode", () => {
    const trigger = makeTrigger();
    showBlockDialog("https://blog.example.com/page", trigger, () => {}, "exact", true);

    const dialog = document.querySelector<HTMLElement>(".shh-dialog")!;
    expect(dialog.textContent).toContain('Block "blog.example.com"');
    expect(dialog.querySelector('[role="radiogroup"]')).toBeNull();
    expect(document.activeElement).toBe(dialog.querySelector(".shh-dialog-cancel"));
  });

  it("does nothing for a URL with no hostname", () => {
    const trigger = makeTrigger();
    showBlockDialog("not a url", trigger, () => {}, "ask", true);
    expect(document.querySelector(".shh-dialog")).toBeNull();
  });
});

describe("showBlockDialog — keyboard behaviour", () => {
  it("closes on a trusted Escape and restores focus to the trigger", () => {
    const trigger = makeTrigger();
    showBlockDialog("https://example.com/page", trigger, () => {}, "exact", true);
    const dialog = document.querySelector(".shh-dialog")!;

    press(dialog, "Escape", true);
    expect(document.querySelector(".shh-dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("ignores a synthetic Escape from page script", () => {
    const trigger = makeTrigger();
    showBlockDialog("https://example.com/page", trigger, () => {}, "exact", true);
    const dialog = document.querySelector(".shh-dialog")!;

    press(dialog, "Escape", false);
    expect(document.querySelector(".shh-dialog")).toBe(dialog);
  });

  it("wraps Tab from the last control to the first", () => {
    const trigger = makeTrigger();
    showBlockDialog("https://example.com/page", trigger, () => {}, "exact", true);
    const dialog = document.querySelector<HTMLElement>(".shh-dialog")!;

    const cancel = dialog.querySelector<HTMLElement>(".shh-dialog-cancel")!;
    const perma = dialog.querySelector<HTMLElement>(".shh-dialog-pban")!;
    perma.focus();

    press(dialog, "Tab", true);
    expect(document.activeElement).toBe(cancel);
  });

  it("wraps Shift+Tab from the first control to the last", () => {
    const trigger = makeTrigger();
    showBlockDialog("https://example.com/page", trigger, () => {}, "exact", true);
    const dialog = document.querySelector<HTMLElement>(".shh-dialog")!;

    const cancel = dialog.querySelector<HTMLElement>(".shh-dialog-cancel")!;
    const perma = dialog.querySelector<HTMLElement>(".shh-dialog-pban")!;
    expect(document.activeElement).toBe(cancel);

    press(dialog, "Tab", true, true);
    expect(document.activeElement).toBe(perma);
  });

  it("closes on Escape even when page script moved focus out of the dialog", () => {
    const trigger = makeTrigger();
    showBlockDialog("https://example.com/page", trigger, () => {}, "exact", true);
    document.querySelector<HTMLElement>(".shh-dialog")!;

    // Simulate focus escaping the dialog (page script, AT, or a removed node).
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    press(document.body, "Escape", true);
    expect(document.querySelector(".shh-dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("restores focus to the trigger after the domain → mode flow", async () => {
    const trigger = makeTrigger();
    showBlockDialog("https://blog.example.com/page", trigger, () => {}, "ask", true);
    const domainDialog = document.querySelector(".shh-dialog")!;

    click(domainDialog.querySelector(".shh-dialog-block")!, true);
    await delay(10);

    const modeDialog = document.querySelector<HTMLElement>(".shh-dialog")!;
    expect(modeDialog.textContent).toContain('Block "blog.example.com"');
    press(modeDialog, "Escape", true);

    expect(document.querySelector(".shh-dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not move focus for a synthetic Tab", () => {
    const trigger = makeTrigger();
    showBlockDialog("https://example.com/page", trigger, () => {}, "exact", true);
    const dialog = document.querySelector<HTMLElement>(".shh-dialog")!;
    const cancel = dialog.querySelector<HTMLElement>(".shh-dialog-cancel")!;
    const ev = press(dialog, "Tab", false);

    expect(ev.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(cancel);
  });
});

describe("showBlockDialog — activation and dismissal guards", () => {
  it("blocks on a trusted Block click", () => {
    const trigger = makeTrigger();
    const onConfirm = vi.fn();
    showBlockDialog("https://example.com/page", trigger, onConfirm, "exact", true);
    const dialog = document.querySelector(".shh-dialog")!;

    click(dialog.querySelector(".shh-dialog-block")!, true);
    expect(onConfirm).toHaveBeenCalledWith("example.com", "block");
    expect(document.querySelector(".shh-dialog")).toBeNull();
  });

  it("perma-bans on a trusted Perma-ban click", () => {
    const trigger = makeTrigger();
    const onConfirm = vi.fn();
    showBlockDialog("https://example.com/page", trigger, onConfirm, "exact", true);
    const dialog = document.querySelector(".shh-dialog")!;

    click(dialog.querySelector(".shh-dialog-pban")!, true);
    expect(onConfirm).toHaveBeenCalledWith("example.com", "pban");
  });

  it("ignores a synthetic Block click", () => {
    const trigger = makeTrigger();
    const onConfirm = vi.fn();
    showBlockDialog("https://example.com/page", trigger, onConfirm, "exact", true);
    const dialog = document.querySelector(".shh-dialog")!;

    click(dialog.querySelector(".shh-dialog-block")!, false);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.querySelector(".shh-dialog")).toBe(dialog);
  });

  it("ignores a synthetic Cancel click", () => {
    const trigger = makeTrigger();
    showBlockDialog("https://example.com/page", trigger, () => {}, "exact", true);
    const dialog = document.querySelector(".shh-dialog")!;

    click(dialog.querySelector(".shh-dialog-cancel")!, false);
    expect(document.querySelector(".shh-dialog")).toBe(dialog);
  });

  it("advances to the mode dialog after a trusted Next click", async () => {
    const trigger = makeTrigger();
    showBlockDialog("https://blog.example.com/page", trigger, () => {}, "ask", true);
    const dialog = document.querySelector(".shh-dialog")!;

    click(dialog.querySelector(".shh-dialog-block")!, true);
    // The second dialog is created after the click task, by design.
    await delay(10);
    expect(document.querySelector(".shh-dialog")?.textContent).toContain('Block "blog.example.com"');
  });

  it("ignores a synthetic click outside, but closes on a trusted one", async () => {
    const trigger = makeTrigger();
    showBlockDialog("https://example.com/page", trigger, () => {}, "exact", true);
    const dialog = document.querySelector(".shh-dialog")!;

    const outside = document.createElement("div");
    document.body.appendChild(outside);
    // Outside-click arming is delayed past the opening click.
    await delay(70);

    click(outside, false);
    expect(document.querySelector(".shh-dialog")).toBe(dialog);

    click(outside, true);
    expect(document.querySelector(".shh-dialog")).toBeNull();
  });

  it("keeps the dialog open when a trusted click lands inside it", async () => {
    const trigger = makeTrigger();
    showBlockDialog("https://example.com/page", trigger, () => {}, "exact", true);
    const dialog = document.querySelector(".shh-dialog")!;
    await delay(70);

    click(dialog.querySelector("h4")!, true);
    expect(document.querySelector(".shh-dialog")).toBe(dialog);
  });

  it("does not steal focus from a focusable target clicked outside", async () => {
    const trigger = makeTrigger();
    showBlockDialog("https://example.com/page", trigger, () => {}, "exact", true);
    await delay(70);

    const outside = document.createElement("button");
    outside.textContent = "elsewhere";
    document.body.appendChild(outside);
    // Native mousedown focuses the clicked control before click fires.
    outside.focus();
    click(outside, true);

    expect(document.querySelector(".shh-dialog")).toBeNull();
    expect(document.activeElement).toBe(outside);
  });
});
