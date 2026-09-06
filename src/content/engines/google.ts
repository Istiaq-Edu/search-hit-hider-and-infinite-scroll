import type { EngineAdapter } from "./base";
import type { EngineId } from "../../shared/types";
import { isDebugMode } from "../debug";
import { containsProcessed } from "../blocking/dedupe";
import {
  collectGoogleResults,
  isGoogleNonResult,
  resolveGoogleStream,
  googleDisplayDomain,
  GOOGLE_LEGACY_RESULT_SELECTORS,
} from "./google-dom";

// ============================================================
// Google adapter
// Button placement mirrors the "Google Hit Hider by Domain" userscript
// by Jefferson Scher (v2.3.4, March 2025):
//   • Prefer the h3/h2 title heading as the button target and APPEND inside it.
//   • This keeps the button out of the cite-row flex container that contains
//     Google's three-dot feedback button, eliminating overlap.
//   • A secondary flex-detection pass in content/index.ts further repositions
//     the button absolutely if its parent is still a flex container.
// ============================================================

export class GoogleAdapter implements EngineAdapter {
  readonly id: EngineId = "google";
  readonly name = "Google";

  private isImages = false;
  private isNews = false;

  matches(url: URL): boolean {
    const h = url.hostname;
    return (
      h === "www.google.com" ||
      h.startsWith("www.google.") ||
      h.startsWith("google.co") ||
      h === "news.google.com" ||
      h.startsWith("news.google.") ||
      h === "encrypted.google.com"
    );
  }

  onInit(doc: Document): void {
    const search = doc.location?.search ?? "";
    this.isImages = search.includes("tbm=isch") || search.includes("udm=2");
    this.isNews = search.includes("tbm=nws");
  }

  getResultNodes(doc: Document | Element): Element[] {
    if (this.isImages) return this.getImageNodes(doc);
    if (this.isNews) return this.getNewsNodes(doc);
    return this.getWebNodes(doc);
  }

  // ── Web results ──────────────────────────────────────────────
  private getWebNodes(doc: Document | Element): Element[] {
    // ORDER MATTERS: structural discovery FIRST, rotating class names LAST.
    //
    // The old ladder led with `div.g` / `div.tF2Cxc` and only fell back to
    // `#rso > div`. Because Google rotates those class names, the ladder could
    // degrade straight to [] while the results were plainly on screen — which is
    // exactly what took the engine down (see
    // docs/plans/2026-08-30-google-failure-diagnosis.md).
    //
    //  1. Structural: resolve the results stream by id, walk its top-level
    //     children, descending into nodes that wrap several results. Immune to
    //     class-name rotation and to the results container being renamed.
    //  2. Legacy class anchors: only reached when structural discovery finds
    //     nothing, so they can never shadow a working structural match.
    const structural = collectGoogleResults(doc, (n) => this.isValidResult(n));
    if (structural.length > 0) return structural;

    for (const sel of GOOGLE_LEGACY_RESULT_SELECTORS) {
      try {
        const nodes = Array.from(doc.querySelectorAll(sel)) as Element[];
        const filtered = nodes.filter((n) => this.isValidResult(n));
        if (filtered.length > 0) return filtered;
      } catch { /* invalid selector in this document — try the next */ }
    }

    this.reportZeroResults(doc);
    return [];
  }

  /**
   * One-shot diagnostic when the Google SERP yields no result nodes at all.
   *
   * Without this, a selector rotation is completely invisible: the extension logs
   * a healthy boot and simply does nothing. Emits the resolved stream container,
   * its child tags and a markup sample — enough to write the next fix from a bug
   * report alone.
   *
   * GATED: the full report is Debug-mode only (see the isDebugMode() early
   * return below). With the toggle off this logs a three-field summary and a
   * hint, so a failure is never silent but the console stays clean.
   */
  private zeroReportDone = false;
  private reportZeroResults(doc: Document | Element): void {
    // Subtree scans (the observer hands us an added ELEMENT, not a Document)
    // are the NORMAL zero-result case — Google's own hydration skeletons,
    // our own UI, unrelated containers all flow through here. Burning the
    // one-shot diagnostic on them (a) floods the console with all-null
    // docShapes mislabelled "(fetched document)", and (b) silences the
    // report for the case it exists for: a whole-page scan or a fetched
    // page that genuinely found nothing. Field log 2026-09-06: the one-shot
    // was consumed by an observer subtree at t≈1434ms, and the REAL fetched
    // page failure an hour later logged nothing.
    if (doc.nodeType !== 9) return;
    if (this.zeroReportDone) return;
    this.zeroReportDone = true;
    const asDoc = doc.nodeType === 9 ? (doc as Document) : null;
    try {
      // ── Debug mode OFF: cheap summary only ─────────────────────────────
      //
      // The full report walks every element under the stream to find the
      // deepest heading path and slices 2x2500 chars of markup. That is a
      // lot of work to do on every broken load for a user who is not
      // debugging. Returning early also keeps ~5KB of third-party page
      // markup out of a console the user did not ask to fill.
      //
      // The summary still says something — a silent failure is worse than
      // a short one — and points at the switch that produces the detail.
      if (!isDebugMode()) {
        const s = resolveGoogleStream(doc);
        // eslint-disable-next-line no-console
        console.log("[SHH] Google: no result nodes found", {
          stream: s ? s.id || s.tagName : null,
          counts: {
            h3: doc.querySelectorAll("h3").length,
            cite: doc.querySelectorAll("cite").length,
          },
          hint:
            "Enable Debug mode (SHH → Advanced), reload, then run copy(__shhDiag()) " +
            "for the full report.",
        });
        return;
      }

      const stream = resolveGoogleStream(doc);
      const children = stream
        ? Array.from(stream.children)
            .slice(0, 6)
            .map((c) => c.tagName.toLowerCase() + (c.className ? "." + String(c.className).slice(0, 40) : ""))
        : null;

      // How are result links encoded? This is the single most diagnostic
      // question and the one that took three rounds to answer. On 2026-08-30
      // Google switched to opaque /goto?url= tokens, which silently defeated
      // every "is this link external?" check in the codebase.
      const allLinks = Array.from(doc.querySelectorAll("a[href]")) as HTMLAnchorElement[];
      let opaque = 0;
      let redirect = 0;
      let external = 0;
      for (const a of allLinks) {
        const raw = a.getAttribute("href") ?? "";
        if (raw.includes("/goto?url=")) opaque++;
        else if (raw.startsWith("/url?") || raw.includes("google.com/url")) redirect++;
        else if (/^https?:/i.test(a.href)) external++;
      }

      // Path from the stream down to the first element carrying a heading —
      // shows the real nesting depth so MAX_DESCENT_DEPTH can be set from
      // evidence instead of guessed.
      let deepest: Element | null = null;
      let path: string[] = [];
      if (stream) {
        for (const el of Array.from(stream.querySelectorAll("*"))) {
          if (!el.querySelector("h3, h2, [role='heading']")) continue;
          const chain: string[] = [];
          let cur: Element | null = el;
          while (cur && cur !== stream.parentElement) {
            chain.unshift(cur.tagName.toLowerCase() + (cur.className ? "." + String(cur.className).split(" ")[0] : ""));
            cur = cur.parentElement;
          }
          if (chain.length > path.length) {
            path = chain;
            deepest = el;
          }
        }
      }

      // What IS this document? When every stream selector misses — the
      // infinite-scroll case, where `stream` came back null on a fetched
      // page — the counts above are all zero and say nothing. This
      // fingerprint distinguishes the three real possibilities at a glance:
      //   • consent / "sorry" interstitial → title + a form, little text
      //   • JS-gated shell                → near-empty body, no results
      //   • a real SERP with new markup   → plenty of text, unfamiliar tags
      const bodyText = asDoc?.body?.textContent?.trim() ?? "";
      const docShape = {
        title: asDoc?.title?.slice(0, 200) ?? null,
        textLength: bodyText.length,
        forms: doc.querySelectorAll("form").length,
        scripts: doc.querySelectorAll("script").length,
        bodyHead: asDoc?.body?.innerHTML.slice(0, 600) ?? null,
        textHead: bodyText.slice(0, 300) || null,
      };

      // Emitted as FLAT STRINGS as well as in the object above.
      //
      // DevTools collapses nested objects when you copy a log entry, so the
      // `docShape` field came back as `{…}` twice in a row and told us
      // nothing — while it is precisely the field needed to explain why every
      // stream selector missed. Primitives in the message text survive the
      // round trip through a paste.
      //
      // eslint-disable-next-line no-console
      console.log(
        "[SHH] fetched-doc shape: " +
          `title=${JSON.stringify(docShape.title)} ` +
          `textLen=${docShape.textLength} ` +
          `forms=${docShape.forms} scripts=${docShape.scripts} ` +
          `h3=${doc.querySelectorAll("h3").length} cite=${doc.querySelectorAll("cite").length}`
      );
      // eslint-disable-next-line no-console
      console.log("[SHH] fetched-doc body head: " + (docShape.bodyHead ?? "(none)"));
      // eslint-disable-next-line no-console
      console.log("[SHH] fetched-doc text head: " + (docShape.textHead ?? "(empty)"));

      // eslint-disable-next-line no-console
      console.log("[SHH] Google: no result nodes found", {
        url: asDoc?.location?.href ?? "(fetched document)",
        docShape,
        stream: stream ? (stream.id || stream.tagName) : null,
        streamChildren: children,
        counts: {
          "div.g": doc.querySelectorAll("div.g").length,
          "div.tF2Cxc": doc.querySelectorAll(".tF2Cxc").length,
          "div.MjjYud": doc.querySelectorAll(".MjjYud").length,
          h3: doc.querySelectorAll("h3").length,
          cite: doc.querySelectorAll("cite").length,
          pnnext: doc.querySelectorAll("#pnnext").length,
        },
        linkEncoding: { opaqueGoto: opaque, urlRedirect: redirect, external, total: allLinks.length },
        deepestHeadingPath: path.length ? path.join(" > ") : null,
        deepestSample: deepest?.outerHTML.slice(0, 2500) ?? null,
        firstChildSample: stream?.firstElementChild?.outerHTML.slice(0, 2500) ?? null,
      });
    } catch { /* diagnostics must never break discovery */ }
  }

  /**
   * The host this result points at, or null if we cannot tell.
   *
   * Tries, in order of trustworthiness:
   *   1. A direct external href.
   *   2. A /url?q= redirect whose destination is external.
   *   3. The DISPLAY URL — the <cite> line the user reads on screen.
   *
   * Step 3 is not a courtesy any more, it is the primary path. Since
   * 2026-08-30 Google serves title links as `/goto?url=<opaque blob>`; the
   * destination is not recoverable from the href (the token is a protobuf
   * wrapper around an encrypted payload), so the display URL is the only place
   * the domain exists. Earlier revisions deliberately refused to trust <cite>
   * because AMP / translated / cached results can display a domain the link
   * does not point at — a real risk, but a far smaller one than the extension
   * being completely inert.
   */
  private resultHost(n: Element): string | null {
    const links = Array.from(n.querySelectorAll("a[href]")) as HTMLAnchorElement[];

    for (const a of links) {
      if (this.isExternalHref(a.href)) {
        try {
          return new URL(a.href).hostname.replace(/^www\./, "");
        } catch { /* fall through to the next source */ }
      }
    }

    // Unwrap /url?q= redirects. These appear in raw HTML before Google's
    // hydration JS replaces them, and they still carry a readable destination.
    for (const a of links) {
      const raw = a.getAttribute("href") ?? "";
      if (raw.startsWith("/url?") || raw.includes("google.com/url")) {
        const host = this.redirectTarget(raw);
        if (host) return host;
      }
    }

    return googleDisplayDomain(n);
  }

  /** Destination host of a /url?q= redirect, or null. */
  private redirectTarget(raw: string): string | null {
    try {
      const qs = raw.slice(raw.indexOf("?") + 1);
      const q = new URLSearchParams(qs).get("q");
      if (q && q.startsWith("http")) {
        const u = new URL(q);
        if (
          !u.hostname.includes("google.") &&
          !u.hostname.includes("gstatic.") &&
          !u.hostname.includes("googleapis.")
        ) {
          return u.hostname.replace(/^www\./, "");
        }
      }
    } catch { /* malformed URL */ }
    return null;
  }

  /**
   * A node is a valid organic result if:
   *  - it has a heading/title element
   *  - we can work out which domain it points at
   *  - it hasn't already been processed by us
   */
  private isValidResult(n: Element): boolean {
    if (n.getAttribute("data-shh-result")) return false;
    // A node wrapping results we have already handled is a container, not a
    // result — offering it would stack a second block button and a second
    // placeholder box on top of the first result inside it.
    if (containsProcessed(n)) return false;
    // Ads, the pager, our own placeholders and Google's furniture are never
    // results — regardless of which code path reached this check.
    if (isGoogleNonResult(n)) return false;
    if (!n.querySelector("h3, h2, [role='heading']")) return false;
    return this.resultHost(n) !== null;
  }

  private isExternalHref(href: string): boolean {
    if (!href) return false;
    try {
      const u = new URL(href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      const h = u.hostname;
      return (
        !h.includes("google.") &&
        !h.includes("gstatic.") &&
        !h.includes("googleapis.")
      );
    } catch {
      return false;
    }
  }

  // ── Image results ─────────────────────────────────────────────
  private getImageNodes(doc: Document | Element): Element[] {
    const selectors = ["div.isv-r", "div.rg_di", "g-img.mNsIhb"];
    for (const sel of selectors) {
      const nodes = Array.from(doc.querySelectorAll(sel));
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  // ── News results ──────────────────────────────────────────────
  private getNewsNodes(doc: Document | Element): Element[] {
    const selectors = [
      "#rso div[data-hveid]",
      "#rso g-card",
      "#rso .WlydOe",
    ];
    for (const sel of selectors) {
      const nodes = Array.from(doc.querySelectorAll(sel));
      const filtered = nodes.filter((n) => n.querySelector("a[href]"));
      if (filtered.length > 0) return filtered;
    }
    return [];
  }

  // ── URL extraction ─────────────────────────────────────────────
  getResultUrl(node: Element): string | null {
    if (this.isImages) return this.getImageUrl(node);

    // Prefer the actual href of any external link (most reliable, avoids
    // cite-text path components like "example.com › category › page")
    const links = Array.from(
      node.querySelectorAll("a[href]")
    ) as HTMLAnchorElement[];

    for (const a of links) {
      if (this.isExternalHref(a.href)) return a.href;
    }

    // Unwrap Google's /url?q= redirect links
    for (const a of links) {
      const raw = a.getAttribute("href") ?? "";
      if (raw.startsWith("/url?") || raw.includes("google.com/url")) {
        const qs = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw;
        const q = new URLSearchParams(qs).get("q");
        if (q && q.startsWith("http")) return q;
      }
    }

    // Opaque /goto?url= links carry no destination, so fall back to the
    // display URL — the domain the user can see. This is the normal path on
    // Google as of 2026-08-30, not a corner case.
    const display = googleDisplayDomain(node);
    return display ? "https://" + display : null;
  }

  private getImageUrl(node: Element): string | null {
    const a = node.querySelector("a[href]") as HTMLAnchorElement | null;
    const href = a?.getAttribute("href") ?? "";
    if (href.startsWith("http") && !href.includes("google.")) return href;
    return null;
  }

  // ── Button target ──────────────────────────────────────────────
  /**
   * Return the element inside which the block button will be placed.
   *
   * Priority order (mirrors the Jefferson Scher userscript v2.3.4):
   *   1. h3 / h2 title heading — button is APPENDed inside; the heading sits
   *      above the cite/source row so there is no risk of overlapping the
   *      three-dot feedback button that Google places in the cite-row flex
   *      container.
   *   2. cite element — fallback; caller inserts AFTER (exitAnchor applied).
   *   3. Domain span class fallback.
   *   4. Parent of first external link.
   */
  getButtonTarget(node: Element): Element | null {
    // Prefer h3 (or h2) — the content script will APPEND inside the heading,
    // keeping the button outside the cite-row flex container entirely.
    const heading = node.querySelector("h3") ?? node.querySelector("h2");
    if (heading) return heading;

    // Secondary: cite element (insert after, using exitAnchor)
    const cite = node.querySelector("cite");
    if (cite) return this.exitAnchor(cite, node);

    // Tertiary: span that shows the domain (class VuuXrf in some Google versions)
    const domainSpan = node.querySelector(".VuuXrf, .qzEoUe");
    if (domainSpan) return this.exitAnchor(domainSpan, node);

    // Last resort: parent of first link
    const firstLink = node.querySelector("a[href]");
    return firstLink?.parentElement ?? null;
  }

  /**
   * Walk up from `el` through any <a> ancestors until we reach
   * an element whose parent is NOT an <a> (or we hit the root node).
   * This ensures the returned element can be safely inserted after
   * without placing our button inside a link.
   */
  private exitAnchor(el: Element, root: Element): Element {
    let current: Element = el;
    while (
      current.parentElement &&
      current.parentElement !== root &&
      current.parentElement.tagName === "A"
    ) {
      current = current.parentElement;
    }
    return current;
  }

  observerOptions(): MutationObserverInit {
    return { childList: true, subtree: true };
  }

  // ── Infinite scroll ──────────────────────────────────────────────────

  getNextPageUrl(doc: Document): string | null {
    const selectors = [
      '#pnnext',
      'a[aria-label^="Next"]',
      'a[aria-label^="Next page"]',
    ];
    for (const sel of selectors) {
      const btn = doc.querySelector<HTMLAnchorElement>(sel);
      if (btn?.href) return btn.href;
    }

    // Last-resort fallback. Scoped to the pager block: the previous unscoped
    // form (`a[href*="/search?"][href*="start="]:last-of-type`) also matched
    // unrelated footer/nav links carrying a start= param, which made infinite
    // scroll chase a bogus "next page" on layouts without a pager.
    const pagerLinks = doc.querySelectorAll<HTMLAnchorElement>(
      '#navcnt a[href*="start="], #botstuff a[href*="start="]'
    );
    const last = pagerLinks[pagerLinks.length - 1];
    return last?.href ?? null;
  }

  /**
   * Elements to hide while infinite scroll is active.
   *
   * Deliberately NARROW: it used to include `#foot` (Google's whole footer) and
   * `#xjs > div:last-child`, both of which remove unrelated page furniture
   * (Settings, Privacy, Terms) rather than just the pager.
   */
  getPaginationSelectors(): string[] {
    return ['#navcnt', 'nav[role="navigation"]'];
  }

  getResultId(node: Element): string | null {
    return node.getAttribute('data-ved') ?? null;
  }

  getResultsContainer(doc?: Document): Element | null {
    const d = doc ?? document;
    // Use the same stream resolver as result discovery so fetched pages are
    // appended into the exact container the adapter reads results from.
    return resolveGoogleStream(d);
  }
}
