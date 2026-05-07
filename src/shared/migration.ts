import type { BlockEntry, BlockMode } from "./types";
import { normalizeDomain } from "./domain-utils";
import { deduplicateEntries } from "./list-utils";

// ============================================================
// Migration: import from userscript format and other formats
// ============================================================

/**
 * Parse the userscript's pipe-delimited storage format:
 * |domain:t|domain2:p|...
 * :t = regular block, :p = perma-ban
 */
export function parseUserscriptFormat(raw: string): BlockEntry[] {
  const entries: BlockEntry[] = [];
  const parts = raw.split("|").filter(Boolean);
  const now = Date.now();

  for (const part of parts) {
    const colonIdx = part.lastIndexOf(":");
    if (colonIdx === -1) continue;
    const domain = part.slice(0, colonIdx).trim();
    const flag = part.slice(colonIdx + 1).trim().toLowerCase();

    const normalized = normalizeDomain(domain);
    if (!normalized || normalized.length < 2) continue;

    const mode: BlockMode = flag === "p" ? "pban" : "block";
    entries.push({
      domain: normalized,
      mode,
      enabled: true,
      createdAt: now,
    });
  }

  return deduplicateEntries(entries);
}

/**
 * Parse a plain domain list (one domain per line, # for comments).
 * Supports inline "# perma-ban" annotation produced by exportToPlainList.
 * All other entries use the provided default mode (default: "block").
 */
export function parsePlainList(raw: string, mode: BlockMode = "block"): BlockEntry[] {
  const entries: BlockEntry[] = [];
  const now = Date.now();
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Split domain from inline comment (e.g. "spam.com # perma-ban")
    const hashIdx = trimmed.indexOf("#");
    let domainPart: string;
    let entryMode: BlockMode = mode;

    if (hashIdx !== -1) {
      domainPart = trimmed.slice(0, hashIdx).trim();
      const comment = trimmed.slice(hashIdx + 1).trim().toLowerCase();
      if (comment === "perma-ban" || comment === "pban") {
        entryMode = "pban";
      }
    } else {
      domainPart = trimmed;
    }

    if (!domainPart) continue;
    const normalized = normalizeDomain(domainPart);
    if (!normalized || normalized.length < 2) continue;
    entries.push({ domain: normalized, mode: entryMode, enabled: true, createdAt: now });
  }

  return deduplicateEntries(entries);
}

/**
 * Parse JSON backup format (array of BlockEntry or legacy formats).
 */
export function parseJSONBackup(raw: string): BlockEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON");
  }

  if (Array.isArray(parsed)) {
    return deduplicateEntries(
      parsed
        .filter(isBlockEntryLike)
        .map((e) => normalizeImportedEntry(e))
    );
  }

  // Handle legacy object format: { entries: [...], prefs: {...} }
  if (parsed && typeof parsed === "object" && "entries" in parsed) {
    const obj = parsed as { entries: unknown };
    if (Array.isArray(obj.entries)) {
      return deduplicateEntries(
        obj.entries
          .filter(isBlockEntryLike)
          .map((e) => normalizeImportedEntry(e))
      );
    }
  }

  throw new Error("Unrecognized JSON format");
}

/**
 * Export entries to JSON backup string.
 */
export function exportToJSON(entries: BlockEntry[]): string {
  return JSON.stringify({ version: 1, exportedAt: Date.now(), entries }, null, 2);
}

/**
 * Export entries to plain domain list (one per line).
 * Mode is optionally annotated as a comment.
 */
export function exportToPlainList(entries: BlockEntry[], annotateMode = false): string {
  return entries
    .filter((e) => e.enabled)
    .map((e) => {
      if (annotateMode && e.mode === "pban") return `${e.domain} # perma-ban`;
      return e.domain;
    })
    .join("\n");
}

/**
 * Export to userscript-compatible format for migration back.
 */
export function exportToUserscriptFormat(entries: BlockEntry[]): string {
  return (
    "|" +
    entries
      .filter((e) => e.enabled)
      .map((e) => `${e.domain}:${e.mode === "pban" ? "p" : "t"}`)
      .join("|") +
    "|"
  );
}

/**
 * Auto-detect format from raw string and parse accordingly.
 */
export function autoDetectAndParse(raw: string): BlockEntry[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseJSONBackup(trimmed);
  }
  // Userscript format: pipe-delimited entries ending in ":t" or ":p"
  // Use a specific pattern instead of loose includes() to avoid false positives
  // on plain domain lists that happen to contain those character sequences.
  const USERSCRIPT_RE = /\|[^|]+:(t|p)\s*\|/;
  if (trimmed.startsWith("|") || USERSCRIPT_RE.test(trimmed)) {
    return parseUserscriptFormat(trimmed);
  }
  return parsePlainList(trimmed);
}

// ============================================================
// Helpers
// ============================================================

function isBlockEntryLike(v: unknown): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === "object" &&
    "domain" in (v as object) &&
    typeof (v as Record<string, unknown>)["domain"] === "string"
  );
}

function normalizeImportedEntry(raw: Record<string, unknown>): BlockEntry {
  const domain = normalizeDomain(String(raw["domain"] ?? ""));
  const mode: BlockMode =
    raw["mode"] === "pban" ? "pban" : "block";
  const enabled = raw["enabled"] !== false;
  const createdAt =
    typeof raw["createdAt"] === "number" ? raw["createdAt"] : Date.now();
  return { domain, mode, enabled, createdAt };
}
