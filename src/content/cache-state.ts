import type { BlockEntry, Prefs, EngineId } from "../shared/types";
import { DEFAULT_PREFS } from "../shared/types";
import { isEngineActive } from "./prefs-transition";

// ============================================================
// The `_shh_cache` pre-paint cache — pure logic
//
// WHY THIS FILE EXISTS
// --------------------
// The preload (document_start) reads `_shh_cache` synchronously to hide
// blocked results before the first paint. The content script writes it. That
// write and read lived entirely inside `index.ts`, which is a side-effecting
// module — importing it runs `init()` — so neither could be unit-tested. The
// whole pre-paint layer therefore had ZERO coverage, which is how D5 shipped.
//
// This is the same extraction the repo already performed for
// `dedupe.isInsideProcessedTerritory` (review finding A5-R1, 2026-09-06):
// pull the decision out so a test can bind to the SHIPPED function instead of
// a mirror copy that would survive a full revert.
//
// D5 — THE DEFECT THIS MAKES FIXABLE
// ---------------------------------
// `recoverStateFromCache` used to return `{ entries: [], prefs }` for BOTH
// "there is no cache" and "the cache says the user has zero blocks". Those are
// completely different situations, and the conflation is destructive:
//
//   1. A load starts with a cold event page. Messaging times out.
//   2. recoverStateFromCache finds no cache → entries = [].
//   3. The degraded path proceeds (the return is truthy), and the page runs
//      with an EMPTY matcher — nothing can be hidden.
//   4. updateCache() then writes `{"domains":[]}` from that empty state.
//   5. That write is indistinguishable from an authoritative "you have no
//      blocks", so the NEXT load's preload also hides nothing — even though
//      the user has 50 blocked domains and the background is warm again.
//
// A transient background hiccup thus converts into a PERMANENT loss of
// pre-paint hiding for that origin. The fix is provenance: know whether the
// state we hold is authoritative, and refuse to publish an empty list derived
// from a non-authoritative one.
// ============================================================

export const CACHE_KEY = "_shh_cache";

export interface ShhCache {
  domains: string[];
  wildcard: boolean;
  paused: boolean;
  debug: boolean;
}

/**
 * Parse a raw `_shh_cache` payload.
 *
 * Returns null for absent or unparseable input — the caller must treat that as
 * "no idea", never as "the user has no blocks".
 */
export function parseCache(raw: string | null): ShhCache | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupt JSON — same as absent
  }
  if (!parsed || typeof parsed !== "object") return null;
  const c = parsed as Record<string, unknown>;

  // A payload whose `domains` is absent or not an array is MALFORMED, and
  // malformed must mean "no idea" — never "the user has nothing blocked".
  // Returning `{domains: []}` here re-entered D5 through the front door:
  // recoverStateFromCache() treats any non-null cache as authoritative, so a
  // corrupt payload became an authoritative empty list, and updateCache() then
  // published it over a perfectly good cache — permanently disabling pre-paint
  // hiding for that origin.
  //
  // A legitimately empty list IS representable and must survive: `domains: []`
  // is an array, so it parses. That is the distinction this check exists for.
  if (!Array.isArray(c.domains)) return null;

  return {
    domains: c.domains.filter((d): d is string => typeof d === "string"),
    wildcard: c.wildcard !== false,
    paused: c.paused === true,
    debug: c.debug === true,
  };
}

export function serializeCache(cache: ShhCache): string {
  return JSON.stringify({
    domains: cache.domains,
    wildcard: cache.wildcard,
    paused: cache.paused,
    debug: cache.debug,
  });
}

/**
 * Build the payload to publish.
 *
 * Only ENABLED entries are written — a disabled one must not be pre-hidden,
 * because the content script will not re-hide it and the preload hiding would
 * produce a visible "unblock" flash.
 */
export function buildCache(entries: BlockEntry[], prefs: Prefs, engineId: EngineId): ShhCache {
  // `isEngineActive` (prefs-transition.ts) is the single source of truth for
  // this predicate. An earlier revision of this file exported a second,
  // behaviourally identical copy (`isBlockingActive`) — which is exactly the
  // triplication the consolidation was meant to remove, reintroduced 600 lines
  // away. If you need this check, import the one.
  const active = isEngineActive(prefs, engineId);
  return {
    domains: active ? entries.filter((e) => e.enabled).map((e) => e.domain) : [],
    wildcard: prefs.subdomainWildcard,
    paused: !active,
    debug: prefs.debugMode,
  };
}

/**
 * D5 GUARD — may this payload be published?
 *
 * Refuses to overwrite a good cache with an empty one derived from a
 * non-authoritative (degraded) state. Everything else is allowed: a genuinely
 * empty list from a warm load, a pause transition, and any non-empty list.
 */
export function canPublishCache(cache: ShhCache, stateIsAuthoritative: boolean): boolean {
  if (stateIsAuthoritative) return true;
  // A pause is a POSITIVE instruction, not an absence of information, so it is
  // always safe to publish — even from a degraded state. The payload's own
  // `paused` flag is the discriminator here, not the caller's provenance flag.
  if (cache.paused) return true;
  // Degraded state that nonetheless has domains is still worth publishing — it
  // is the best information available and can only help the next load.
  return cache.domains.length > 0;
}

/** Rebuild entries from a cache. Mode is always "block": the cache stores no mode. */
export function entriesFromCache(cache: ShhCache): BlockEntry[] {
  return cache.domains.map((domain) => ({
    domain,
    mode: "block" as const,
    enabled: true,
    createdAt: 0,
  }));
}

/**
 * Rebuild prefs from a cache, layering over the defaults.
 *
 * The two nested containers are CLONED, not shared. `DEFAULT_PREFS.engineToggles`
 * is built by `Object.fromEntries` and `DEFAULT_PREFS.pausedEngines` is a
 * module-level array, so a shallow spread would hand out the live references —
 * and the result of this function becomes the module-level `prefs` in
 * `content/index.ts`. Any future write through it (`prefs.engineToggles[x] =
 * false`) would then poison the defaults process-wide, silently re-enabling or
 * disabling engines in every other consumer.
 */
export function prefsFromCache(cache: ShhCache): Prefs {
  return {
    ...DEFAULT_PREFS,
    engineToggles: { ...DEFAULT_PREFS.engineToggles },
    pausedEngines: [...DEFAULT_PREFS.pausedEngines],
    subdomainWildcard: cache.wildcard,
    // Without this, a cold-start (degraded) load would silently turn Debug
    // mode off even though the user enabled it — and a cold start is one of
    // the situations most worth diagnosing.
    debugMode: cache.debug,
  };
}
