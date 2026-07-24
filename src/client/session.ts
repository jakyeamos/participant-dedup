import type { ClusterStatus, Confidence } from "@/shared/constants";
import { CLUSTER_STATUSES, CONFIDENCE_LEVELS } from "@/shared/constants";
import type { QueueFilters } from "@/client/views/queue";

/**
 * §21.3 The typed-in reviewer name, for accounts whose email Apps Script will
 * not disclose. It lives in `sessionStorage` and nowhere else: the name is an
 * audit attribution, and leaving it in `localStorage` would attribute the next
 * person to sit at this browser to whoever typed it last.
 *
 * Queue filters live here too (§21.4): they are reviewer preference for this
 * sidebar session, not document state, and must not bleed into the next person
 * at the same browser via `localStorage`.
 */

const KEY = "dedup.fallbackName";
const FILTERS_KEY = "dedup.queueFilters";

/** §21.3 Long enough to identify a person, short enough not to become a note. */
const MAX_LENGTH = 60;

const CONFIDENCE_SET = new Set<string>(CONFIDENCE_LEVELS);
const STATUS_SET = new Set<string>(CLUSTER_STATUSES);

/**
 * Control characters are removed rather than escaped: the name is written into
 * the audit sheet, and a newline there splits one attribution across two lines.
 */
export function sanitizeFallbackName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LENGTH);
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    // A browser with storage disabled still has to run: the name is then held
    // only for as long as the sidebar stays open.
    return null;
  }
}

export function readFallbackName(): string {
  return storage()?.getItem(KEY) ?? "";
}

export function writeFallbackName(name: string): void {
  const clean = sanitizeFallbackName(name);
  if (clean === "") {
    clearFallbackName();
    return;
  }
  storage()?.setItem(KEY, clean);
}

export function clearFallbackName(): void {
  storage()?.removeItem(KEY);
}

/** Returns null when nothing was saved this session — callers use bootstrap defaults. */
export function readStoredQueueFilters(): QueueFilters | null {
  const raw = storage()?.getItem(FILTERS_KEY);
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as { confidence?: unknown; statuses?: unknown };
    const confidence = Array.isArray(parsed.confidence)
      ? (parsed.confidence.filter((c): c is Confidence => typeof c === "string" && CONFIDENCE_SET.has(c)))
      : [];
    const statuses = Array.isArray(parsed.statuses)
      ? (parsed.statuses.filter((s): s is ClusterStatus => typeof s === "string" && STATUS_SET.has(s)))
      : [];
    if (confidence.length === 0 && statuses.length === 0) return null;
    return { confidence, statuses };
  } catch {
    return null;
  }
}

export function writeStoredQueueFilters(filters: QueueFilters): void {
  storage()?.setItem(
    FILTERS_KEY,
    JSON.stringify({
      confidence: filters.confidence.filter((c) => CONFIDENCE_SET.has(c)),
      statuses: filters.statuses.filter((s) => STATUS_SET.has(s)),
    }),
  );
}

export function clearStoredQueueFilters(): void {
  storage()?.removeItem(FILTERS_KEY);
}
