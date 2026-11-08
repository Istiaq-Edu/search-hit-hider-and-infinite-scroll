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

// ============================================================
// Engine-agnostic capability discovery.
//
// The decision "can this page advance itself?" must not live inside each
// adapter as a hardcoded selector list. It is a property of the DOM, so one
// conservative detector serves every engine. An adapter only needs to say
// how to COUNT its results; everything else is structural.
// ============================================================

const GENERIC_MORE_TEXT =
  /^(?:show more|load more|more results|more|показать ещ[её]|ещ[её] результаты|显示更多|加载更多)$/i;
const GENERIC_MORE_MARKER = /(?:more[-_]?results|load[-_]?more|show[-_]?more|ещ[её])/i;
const GENERIC_NEXT_TEXT =
  /^(?:next|next page|следующая|дальше|下一页|下一頁|›|»|→)$/i;
const DOC_POS_FOLLOWING = 4;

/**
 * Count results that are actually visible. A continuous SERP can ship the
 * next batch hidden in the DOM and reveal it with an attribute flip; a raw
 * node count would never change and the advance would time out.
 */
export function visibleResultCount(nodes: Element[]): number {
  return nodes.filter(
    (n) =>
      !n.hasAttribute("hidden") &&
      n.getAttribute("aria-hidden") !== "true" &&
      !/display\s*:\s*none/i.test(n.getAttribute("style") ?? "")
  ).length;
}

/**
 * Find a control that appends the next batch INSIDE the current document.
 *
 * Deliberately conservative: a false positive would press something that
 * navigates away or submits a form. Every guard below is a rejection, so an
 * unfamiliar layout falls back to the existing fetch path instead of being
 * "helpfully" delegated.
 */
export function findNativeAdvanceControl(
  doc: Document,
  resultNodes: Element[] = []
): HTMLElement | null {
  const root = doc.body ?? doc.documentElement;
  if (!root) return null;
  // "Load more" only means something when results exist. Without this, the
  // position guard below is vacuous and a header "More" menu on a results-less
  // page (homepage, maps) would qualify as a paging control.
  if (resultNodes.length === 0) return null;
  const last = resultNodes[resultNodes.length - 1]!;

  // Ancestor-walk membership, not `results.some(r => r.contains(el))`.
  // The nested form is O(anchors × results × depth): measured 48 ms of a
  // 67 ms probe on a 200-result / 1500-anchor SERP. This is O(anchors × depth).
  const resultSet = new WeakSet<Element>();
  for (const r of resultNodes) resultSet.add(r);
  const insideResult = (el: Element): boolean => {
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (resultSet.has(cur)) return true;
    }
    return false;
  };

  let best: HTMLElement | null = null;
  for (const el of Array.from(
    root.querySelectorAll<HTMLElement>("button, [role='button'], a")
  )) {
    // ── cheap rejects first ──────────────────────────────────────────
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") continue;
    if (el.getAttribute("aria-disabled") === "true") continue;
    if ((el as HTMLButtonElement).disabled === true) continue;
    if (/display\s*:\s*none/i.test(el.getAttribute("style") ?? "")) continue;
    if (el.hasAttribute("download") || el.hasAttribute("formaction")) continue;

    const href = el.getAttribute("href") ?? "";
    // An anchor with a real destination NAVIGATES. Only in-page controls
    // (no href, or #) are safe to press on an engine we have not modelled.
    if (href && !href.startsWith("#")) continue;
    if (/^\s*(?:javascript|data|vbscript):/i.test(href)) continue;

    const strong = [
      el.getAttribute("data-testid"),
      el.getAttribute("data-bem"),
      el.getAttribute("data-state"),
      el.getAttribute("aria-label"),
    ]
      .filter(Boolean)
      .join(" ");
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    const byMarker = GENERIC_MORE_MARKER.test(strong);
    const byText =
      text.length > 0 && text.length <= 40 && GENERIC_MORE_TEXT.test(text);
    if (!byMarker && !byText) continue;
    if (/^\d+$/.test(text)) continue;

    // ── structural rejects ──────────────────────────────────────────
    // Never our own UI.
    if (el.closest("#is-sentinel, [data-inf-page], [data-shh-result]")) continue;
    // Never a control inside a result card (galleries, "more from this site").
    if (insideResult(el)) continue;
    // Never a credential/upload form: pressing its submit is destructive.
    const form = el.closest("form");
    if (form?.querySelector('input[type="password"], input[type="file"]')) continue;
    // A genuine load-more control sits AFTER the results.
    if (last && !(last.compareDocumentPosition(el) & DOC_POS_FOLLOWING)) continue;

    // Later wins on ties: the bottom-of-list control is the real one.
    best = el;
  }
  return best;
}

/** Press a discovered control and wait for the ENGINE to render new results. */
export async function delegateNextPage(opts: {
  doc: Document;
  control: HTMLElement;
  count: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  const baseline = opts.count();
  pressNativeControl(opts.control);
  await awaitNewResults({
    baseline,
    count: opts.count,
    root: opts.doc.documentElement,
    timeoutMs: opts.timeoutMs ?? 10_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

/**
 * A real, engine-owned "next page" URL for fail-open navigation, found by
 * SEMANTICS (rel / aria-label / short label) rather than by rotated class
 * names. Returns an absolute http(s) URL or null.
 */
export function findNextPageLink(doc: Document, resultNodes: Element[] = []): string | null {
  const candidates = Array.from(
    doc.querySelectorAll<HTMLAnchorElement>('a[rel~="next"], a[aria-label], a[href]')
  );

  let base: URL | null = null;
  try {
    base = new URL(
      doc.URL && /^https?:/i.test(doc.URL) ? doc.URL : window.location.href
    );
  } catch {
    base = null;
  }

  const resultSet = new WeakSet<Element>();
  for (const r of resultNodes) resultSet.add(r);
  const insideResult = (el: Element): boolean => {
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (resultSet.has(cur)) return true;
    }
    return false;
  };

  let found: string | null = null;
  for (const a of candidates) {
    // Cheap semantic tests first.
    const rel = (a.getAttribute("rel") ?? "").toLowerCase();
    const label = (a.getAttribute("aria-label") ?? "").trim();
    const text = (a.textContent ?? "").replace(/\s+/g, " ").trim();
    const isNext =
      rel.split(/\s+/).includes("next") ||
      /next|следующ|下一页|下一頁/i.test(label) ||
      (text.length > 0 && text.length <= 20 && GENERIC_NEXT_TEXT.test(text));
    if (!isNext) continue;

    const href = a.getAttribute("href") ?? "";
    if (!href || /^\s*(?:javascript|data|vbscript):/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, base ?? undefined);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    // A "next page" of a search always lives on the search engine's own
    // host. Without this, a hostile result/footer anchor labelled "next"
    // would become an extension-branded link to an attacker's origin.
    if (base && !sameHost(url.hostname, base.hostname)) continue;

    if (a.closest("#is-sentinel, [data-inf-page]")) continue;
    if (insideResult(a)) continue;

    found = url.toString(); // last match wins: bottom pager
  }
  return found;
}

/** Same host or one is a subdomain of the other. */
function sameHost(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.endsWith("." + y) || y.endsWith("." + x);
}
