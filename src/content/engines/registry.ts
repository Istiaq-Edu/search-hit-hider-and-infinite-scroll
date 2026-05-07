import type { EngineAdapter } from "./base";
import { GoogleAdapter } from "./google";
import { DuckDuckGoAdapter } from "./duckduckgo";
import { YandexAdapter } from "./yandex";
import { BingAdapter } from "./bing";
import { BaiduAdapter } from "./baidu";
import { BraveAdapter } from "./brave";

// ============================================================
// Engine registry — detects the active engine from the URL
// ============================================================

const ALL_ADAPTERS: EngineAdapter[] = [
  new GoogleAdapter(),
  new DuckDuckGoAdapter(),
  new YandexAdapter(),
  new BingAdapter(),
  new BaiduAdapter(),
  new BraveAdapter(),
];

/**
 * Return the matching adapter for the current page URL.
 * Returns null if no engine is recognized.
 */
export function detectEngine(url: URL): EngineAdapter | null {
  for (const adapter of ALL_ADAPTERS) {
    if (adapter.matches(url)) return adapter;
  }
  return null;
}

export { ALL_ADAPTERS };
