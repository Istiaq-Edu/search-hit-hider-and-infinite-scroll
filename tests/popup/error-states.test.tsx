// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "preact";
import type { ComponentChildren } from "preact";
import { App } from "../../src/popup/components/App";
import { BlockList } from "../../src/popup/components/BlockList";
import { PermabanList } from "../../src/popup/components/PermabanList";
import { ImportExport } from "../../src/popup/components/ImportExport";
import { OptionsPage } from "../../src/popup/OptionsPage";
import { DEFAULT_PREFS, type BlockEntry } from "../../src/shared/types";

// ============================================================
// Popup / options failure states
//
// The background page can be dead, restarting, or refusing a message. The one
// unacceptable outcome is presenting that as authoritative data: an empty
// list with "0 blocked" and no hint that nothing was read. These render the
// shipped components against a rejecting `browser.runtime.sendMessage` and
// assert the user-visible failure, plus the retry path.
// ============================================================

type SendMessage = (message: { type: string }) => Promise<unknown>;

function installBrowser(sendMessage: SendMessage) {
  const mock = {
    runtime: {
      sendMessage: vi.fn(sendMessage),
      getURL: (path: string) => `moz-extension://test/${path}`,
    },
    storage: {
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
    },
    tabs: {
      create: vi.fn(async () => ({ id: 1 })),
    },
  };
  vi.stubGlobal("browser", mock);
  return mock;
}

const dispatch = () => new Promise((r) => setTimeout(r, 30));

async function renderUi(vnode: ComponentChildren): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(vnode, container);
  await dispatch();
  return container;
}

function unmount(container: HTMLElement): void {
  render(null, container);
  container.remove();
}

const ENTRY: BlockEntry = {
  domain: "blocked.com",
  mode: "block",
  enabled: true,
  createdAt: 1_700_000_000_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("App — background unavailable", () => {
  it("replaces the empty list with a retryable alert", async () => {
    installBrowser(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });

    const container = await renderUi(<App />);
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("background is not responding");
    // No fake data shell: "0 blocked · 0 total" would misreport a list that
    // was never read, and an empty block list invites the user to re-add
    // domains that may already exist.
    expect(container.textContent).not.toContain("0 blocked");
    expect(container.querySelector('input[placeholder^="Add domain"]')).toBeNull();
    unmount(container);
  });

  it("recovers when Retry reaches a live background", async () => {
    let healthy = false;
    installBrowser(async (message) => {
      if (!healthy) {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      if (message.type === "GET_LIST") return { entries: [ENTRY] };
      if (message.type === "GET_PREFS") return { prefs: DEFAULT_PREFS };
      throw new Error(`unexpected message ${message.type}`);
    });

    const container = await renderUi(<App />);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    healthy = true;
    (container.querySelector('[role="alert"] button') as HTMLButtonElement).click();
    await dispatch();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("1 blocked");
    unmount(container);
  });
});

describe("BlockList — add failure", () => {
  it("reports an unreachable background instead of silently doing nothing", async () => {    installBrowser(async () => {
      throw new Error("no background");
    });

    const container = await renderUi(
      <BlockList entries={[]} prefs={DEFAULT_PREFS} onRefresh={async () => {}} />
    );

    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="Add domain to block…"]'
    )!;
    input.value = "example.com";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await dispatch();

    const add = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("+ Block")
    )!;
    add.click();
    await dispatch();

    expect(container.textContent).toContain("Could not reach the extension background.");
    unmount(container);
  });

  it("does not report success when the background rejects the domain", async () => {
    installBrowser(async (message) => {
      if (message.type === "ADD_ENTRY") return { entry: null, duplicate: false };
      throw new Error(`unexpected message ${message.type}`);
    });

    const container = await renderUi(
      <BlockList entries={[]} prefs={DEFAULT_PREFS} onRefresh={async () => {}} />
    );

    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="Add domain to block…"]'
    )!;
    input.value = "junk";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await dispatch();

    const add = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("+ Block")
    )!;
    add.click();
    await dispatch();

    expect(container.textContent).toContain('"junk" is not a valid domain');
    unmount(container);
  });
});

describe("BlockList — duplicate vs reactivation", () => {
  async function add(container: HTMLElement, domain: string): Promise<HTMLInputElement> {
    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="Add domain to block…"]'
    )!;
    input.value = domain;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await dispatch();
    const button = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("+ Block")
    )!;
    button.click();
    await dispatch();
    return input;
  }

  it("reports a reactivated disabled entry and clears the input", async () => {
    installBrowser(async (message) => {
      if (message.type === "ADD_ENTRY") {
        return { entry: { ...ENTRY, enabled: true }, duplicate: true };
      }
      throw new Error(`unexpected message ${message.type}`);
    });

    const container = await renderUi(
      <BlockList entries={[{ ...ENTRY, enabled: false }]} prefs={DEFAULT_PREFS} onRefresh={async () => {}} />
    );
    const input = await add(container, "blocked.com");

    // The block is now active again, so "already in the list" would be wrong.
    expect(container.textContent).toContain("Re-enabled: blocked.com");
    expect(container.textContent).not.toContain("already in the list");
    expect(input.value).toBe("");
    unmount(container);
  });

  it("keeps the duplicate message for an entry that was already enabled", async () => {
    installBrowser(async (message) => {
      if (message.type === "ADD_ENTRY") return { entry: null, duplicate: true };
      throw new Error(`unexpected message ${message.type}`);
    });

    const container = await renderUi(
      <BlockList entries={[ENTRY]} prefs={DEFAULT_PREFS} onRefresh={async () => {}} />
    );
    await add(container, "blocked.com");

    expect(container.textContent).toContain('"blocked.com" is already in the list');
    expect(container.textContent).not.toContain("Re-enabled");
    unmount(container);
  });
});

describe("PermabanList — remove failure", () => {
  it("shows the failed domain and keeps it in the list", async () => {
    installBrowser(async () => {
      throw new Error("no background");
    });

    const container = await renderUi(
      <PermabanList
        entries={[{ ...ENTRY, domain: "banned.com", mode: "pban" }]}
        prefs={DEFAULT_PREFS}
        onRefresh={async () => {}}
      />
    );

    (container.querySelector('[aria-label="Remove banned.com"]') as HTMLButtonElement).click();
    await dispatch();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Could not remove banned.com.");
    // The row must still be there: the alert text alone also contains the
    // domain, so asserting textContent would pass on a list that lost it.
    expect(container.querySelector('[aria-label="Remove banned.com"]')).not.toBeNull();
    unmount(container);
  });
});

describe("ImportExport — page-open failure", () => {
  it("flashes the failure instead of pretending the page opened", async () => {
    const mock = installBrowser(async () => {
      throw new Error("unexpected message");
    });
    mock.tabs.create.mockRejectedValue(new Error("denied"));

    const container = await renderUi(<ImportExport entries={[]} onRefresh={async () => {}} />);

    const open = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Open import page")
    )!;
    open.click();
    await dispatch();

    expect(container.textContent).toContain("Could not open the import/export page.");
    unmount(container);
  });
});

describe("OptionsPage — load failure", () => {
  it("replaces the settings UI with an error and a Retry control", async () => {
    installBrowser(async () => {
      throw new Error("Background died");
    });

    const container = await renderUi(<OptionsPage />);

    expect(container.textContent).toContain("Could not load your settings");
    expect(container.textContent).toContain("Background died");
    expect(
      Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Retry")
    ).toBe(true);
    unmount(container);
  });
});
