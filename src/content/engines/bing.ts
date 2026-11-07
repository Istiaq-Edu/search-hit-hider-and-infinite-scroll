import type { EngineAdapter } from "./base";
import type { EngineId } from "../../shared/types";
import { isHostWithin, parseHttpUrl } from "./url-utils";

// ============================================================
// Bing adapter
// ============================================================

/**
 * Resolve a Bing result href to its destination.
 *
 * Bing wraps outbound links in /ck/a redirects; many carry the destination as
 * `u=a1<base64url(url)>`. The old code discarded every such link because it
 * could not see the destination — even when it was plainly decodable.
 * Opaque tokens (no `a1` marker, malformed base64) still resolve to null:
 * guessing would target bing.com itself.
 */
function resolveBingHref(url: URL): URL | null {
  if (!isHostWithin(url.hostname, "bing.com")) return url;
  if (!url.pathname.startsWith("/ck/a")) return null;
  const u = url.searchParams.get("u");
  if (!u || !u.startsWith("a1")) return null;
  const token = u.slice(2);
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const target = parseHttpUrl(atob(padded));
    if (!target || isHostWithin(target.hostname, "bing.com")) return null;
    return target;
  } catch {
    return null;
  }
}

export class BingAdapter implements EngineAdapter {
  readonly id: EngineId = "bing";
  readonly name = "Bing";

  matches(url: URL): boolean {
    return url.hostname === "www.bing.com";
  }

  getResultNodes(doc: Document | Element): Element[] {
    return Array.from(
      doc.querySelectorAll("#b_content ol#b_results > li.b_algo")
    );
  }

  getResultUrl(node: Element): string | null {
    // Real URL from the attribution cite (more reliable than href, which is a
    // bing.com/ck/a redirect). The old selector required a NESTED li.b_algo
    // inside the result, so it could never match and every Bing result fell
    // through to the redirect href.
    const cite = node.querySelector("div.b_attribution cite") ?? node.querySelector("cite");
    if (cite?.textContent) {
      const text = cite.textContent.trim().split(/[\s›»]/)[0] ?? "";
      if (text.includes(".")) {
        const url = parseHttpUrl(text.startsWith("http") ? text : "https://" + text);
        // A cite naming bing.com describes Bing's own property, not a
        // destination distinct from the engine; never target the engine.
        if (url && !isHostWithin(url.hostname, "bing.com")) return url.toString();
      }
    }
    // The href fallback is usually a bing.com/ck/a redirect. Decode it when
    // possible; an opaque token names no destination and returns null.
    const a = node.querySelector("h2 > a[href]");
    const url = parseHttpUrl(a?.getAttribute("href") ?? "", "https://www.bing.com");
    const target = url ? resolveBingHref(url) : null;
    return target ? target.toString() : null;
  }

  getButtonTarget(node: Element): Element | null {
    return node.querySelector("h2 > a") ?? node.querySelector("h2");
  }

  // ── Infinite scroll ──────────────────────────────────────────────────

  getNextPageUrl(doc: Document): string | null {
    const selectors = [
      'a.sb_pagN',
      'a[title="Next page"]',
      'a[title="Next"]',
      'a.sb_pagN_bp',
    ];
    for (const sel of selectors) {
      const btn = doc.querySelector<HTMLAnchorElement>(sel);
      if (btn?.href) return btn.href;
    }
    return null;
  }

  getPaginationSelectors(): string[] {
    // Keep pagination visible as a manual fallback (consistent with Yandex
    // and Brave): if automatic fetching breaks (rate limit, markup change),
    // users can still page through results manually. Auto-loaded pages are
    // inserted above the pager via getInsertionAnchor().
    return [];
  }

  /**
   * Anchor for infinite scroll insertion: Bing's pager stays visible, so
   * fetched pages must be inserted BEFORE it. Located by walking up from
   * the "Next" link to the element whose parent is the results container —
   * resilient to Bing restructuring the pager's inner markup.
   */
  getInsertionAnchor(container: Element): Element | null {
    const next = container.querySelector(
      'a.sb_pagN, a.sb_pagN_bp, a[title="Next page"], a[title="Next"]'
    );
    if (!next) return null;
    let el: Element = next;
    while (el.parentElement && el.parentElement !== container) {
      el = el.parentElement;
    }
    if (el.parentElement !== container) return null;
    // Never anchor on an element that itself contains the results list.
    // When the container is the broad #b_content wrapper, the walk from the
    // Next link reaches ol#b_results (whose parent IS #b_content) — using it
    // as the anchor would insert pages ABOVE the whole results list.
    if (el.id === "b_results" || el.querySelector("#b_results, li.b_algo")) return null;
    return el;
  }

  getResultId(_node: Element): string | null {
    return null;
  }

  getResultsContainer(doc?: Document): Element | null {
    const d = doc ?? document;
    // Prefer the results list itself. querySelector returns the first match
    // in DOCUMENT order, so listing #b_content first resolves to the broad
    // wrapper (it CONTAINS #b_results) — which misplaces both the sentinel
    // and the page-insertion anchor.
    return d.querySelector("#b_results") ?? d.querySelector("#b_content");
  }
}
