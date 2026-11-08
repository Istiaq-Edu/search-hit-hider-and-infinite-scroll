// ============================================================
// Native advance — the whole "produce page N+1" operation when the
// engine itself does the rendering.
//
// A content script is a GUEST in a document owned by the engine's JS
// runtime. A document obtained with fetch() is a second, dead document:
// no hydration, no session tokens, no stylesheet lineage, no event
// handlers. Cloning its nodes into the live page means reimplementing the
// engine's renderer — the fetch strategy needs thousands of lines of CSS
// archaeology and still breaks on every markup rotation.
//
// There is exactly one correct operation available to a guest: press the
// engine's OWN control and then observe what the engine produced. This
// module is that operation. It renders nothing, clones nothing, and never
// writes into a framework-owned results list.
// ============================================================

export class NativeAdvanceTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeAdvanceTimeoutError";
  }
}

/** Minimal, engine-agnostic shape of an "advance" wait. */
export interface AwaitResultsOptions {
  /** Result count BEFORE the control was pressed. */
  baseline: number;
  /** Re-evaluated on every mutation; must read the LIVE document. */
  count: () => number;
  /** Subtree to watch. Defaults to the whole document. */
  root?: Node;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Bounded safety-net poll for engines that swap a container wholesale. */
  pollMs?: number;
}

/**
 * Resolve with the number of NEW results, but only after they actually exist
 * in the live DOM. A fixed sleep is not a valid substitute: on a cold cache
 * an engine can take 4 s, and on a fast one 40 ms, and guessing either way
 * yields either duplicate advances or a permanently stuck loader.
 */
export function awaitNewResults(opts: AwaitResultsOptions): Promise<number> {
  const {
    baseline,
    count,
    root = typeof document !== "undefined" ? document.documentElement : undefined,
    timeoutMs = 10_000,
    signal,
    pollMs = 120,
  } = opts;

  return new Promise<number>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    let settled = false;
    let observer: MutationObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    function onAbort(): void {
      fail(new DOMException("Aborted", "AbortError"));
    }

    function cleanup(): void {
      observer?.disconnect();
      if (timer !== null) clearTimeout(timer);
      if (poll !== null) clearInterval(poll);
      signal?.removeEventListener("abort", onAbort);
    }

    function succeed(added: number): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(added);
    }

    function fail(err: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    function check(): void {
      let n: number;
      try {
        n = count();
      } catch {
        return; // a transient unreadable DOM is not a terminal failure
      }
      if (n > baseline) succeed(n - baseline);
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => fail(new NativeAdvanceTimeoutError(`No new results after ${timeoutMs}ms`)),
      timeoutMs
    );

    if (root) {
      try {
        observer = new MutationObserver(check);
        // Some engines pre-render the next batch and only flip hidden/aria/
        // style on reveal — no childList mutation at all. Watch those
        // attributes too, or the advance waits out the full timeout and
        // burns a strike on a perfectly healthy batch.
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["hidden", "aria-hidden", "style", "class"],
        });
      } catch {
        // No MutationObserver in this realm — the poll below still works.
      }
    }
    poll = setInterval(check, pollMs);
    check(); // an engine may append synchronously inside the click handler
  });
}

/**
 * Press the engine's own control.
 *
 * Firefox content scripts see page DOM through an Xray wrapper. Calling the
 * NATIVE `.click()` on that wrapper dispatches a real DOM event into the page
 * compartment — page listeners fire — without reading any page-overridable
 * property. `wrappedJSObject` waives Xray: waivers are transitive and the page
 * may have replaced `click` with arbitrary script, so it is only a fallback
 * when the safe path throws.
 *
 * We never fake `isTrusted`. Engines that hard-require a user gesture fall
 * through to the fail-open path (their own control stays visible for a real
 * click). The return value is a diagnostic used by the Firefox harness.
 */
export function pressNativeControl(control: Element): "xray" | "page" | "none" {
  try {
    const click = (control as HTMLElement).click;
    if (typeof click === "function") {
      click.call(control);
      return "xray";
    }
  } catch {
    // Fall through to the page-realm object.
  }
  try {
    const pageControl = (
      control as Element & { wrappedJSObject?: { click?: () => void } }
    ).wrappedJSObject;
    if (pageControl && typeof pageControl.click === "function") {
      pageControl.click();
      return "page";
    }
  } catch {
    // No safe way left to press this control.
  }
  return "none";
}
