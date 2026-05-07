import type { EngineAdapter } from "./base";
import type { EngineId } from "../../shared/types";

// ============================================================
// DuckDuckGo adapter — classic + React results
// ============================================================

export class DuckDuckGoAdapter implements EngineAdapter {
  readonly id: EngineId = "duckduckgo";
  readonly name = "DuckDuckGo";

  matches(url: URL): boolean {
    const h = url.hostname;
    return (
      h === "duckduckgo.com" ||
      h === "noai.duckduckgo.com" ||
      h === "start.duckduckgo.com" ||
      h === "safe.duckduckgo.com"
    );
  }

  getResultNodes(doc: Document): Element[] {
    // React results (modern DDG)
    const reactResults = Array.from(
      doc.querySelectorAll("ol.react-results--main > li[data-layout='organic']")
    );
    if (reactResults.length > 0) return reactResults;

    // Legacy results
    const legacy = Array.from(
      doc.querySelectorAll(
        "div#links div.results_links_deep div.links_main, div#links div.nrn-react-div"
      )
    );
    if (legacy.length > 0) return legacy;

    // Fallback
    return Array.from(doc.querySelectorAll("div#links > div.result"));
  }

  getResultUrl(node: Element): string | null {
    // React DDG: data-testid result has a direct link
    const a =
      node.querySelector("article[data-testid='result'] h2 a[href]") ??
      node.querySelector("h2 a[href]") ??
      node.querySelector("a.result__a[href]") ??
      node.querySelector("a[href]");
    return a?.getAttribute("href") ?? null;
  }

  getButtonTarget(node: Element): Element | null {
    return (
      node.querySelector("h2 a") ??
      node.querySelector("h2") ??
      node.querySelector(".result__title") ??
      node.querySelector("a[href]")
    );
  }

  observerOptions(): MutationObserverInit {
    return { childList: true, subtree: true };
  }
}
