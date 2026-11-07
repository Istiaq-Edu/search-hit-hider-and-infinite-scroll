import type { EngineAdapter } from "./base";
import type { EngineId } from "../../shared/types";
import { isHostWithin, parseHttpUrl } from "./url-utils";

// ============================================================
// Baidu adapter
// ============================================================

export class BaiduAdapter implements EngineAdapter {
  readonly id: EngineId = "baidu";
  readonly name = "Baidu";

  matches(url: URL): boolean {
    return url.hostname === "www.baidu.com";
  }

  getResultNodes(doc: Document | Element): Element[] {
    // Regular results
    const regular = Array.from(
      doc.querySelectorAll(
        "#content_left > div.result.c-container, #content_left > div.result-op.c-container"
      )
    );
    return regular;
  }

  getResultUrl(node: Element): string | null {
    // Baidu uses redirect URLs — extract from data-mu attribute or cite
    const muUrl = parseHttpUrl(node.getAttribute("mu") ?? "");
    // An mu pointing at baidu.com describes Baidu's own property; blocking it
    // would hide the engine rather than the result.
    if (muUrl && !isHostWithin(muUrl.hostname, "baidu.com")) return muUrl.toString();

    const cite = node.querySelector("a.c-showurl[href]");
    if (cite) {
      const text = cite.textContent?.trim();
      if (text && text.includes(".")) {
        const url = parseHttpUrl(text.startsWith("http") ? text : "https://" + text);
        if (url && !isHostWithin(url.hostname, "baidu.com")) return url.toString();
      }
    }

    // h3 hrefs are usually /link?url=<opaque> redirects that name no
    // destination; blocking one would block Baidu itself.
    const a = node.querySelector("h3 > a[href]");
    const url = parseHttpUrl(a?.getAttribute("href") ?? "", "https://www.baidu.com");
    if (!url || isHostWithin(url.hostname, "baidu.com")) return null;
    return url.toString();
  }

  getButtonTarget(node: Element): Element | null {
    return (
      node.querySelector("h3 > a") ??
      node.querySelector("h3") ??
      node.querySelector("a[href]")
    );
  }

}
