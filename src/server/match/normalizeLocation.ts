import type { DedupConfig } from "@/shared/config";
import type { CellValue } from "@/server/types";
import { US_STATES } from "@/shared/constants";
import { normalizeText } from "./normalizeText";

/** §13.6 Map full U.S. state names to two-letter codes; pass through codes. */
export function normalizeState(v: CellValue, cfg: DedupConfig): string | null {
  const t = normalizeText(v, cfg);
  if (t === null) return null;
  const mapped = US_STATES[t];
  if (mapped) return mapped;
  return /^[a-z]{2}$/.test(t) ? t : null;
}

/** §13.6 City normalization is plain general-text normalization. */
export function normalizeCity(v: CellValue, cfg: DedupConfig): string | null {
  return normalizeText(v, cfg);
}

/** §13.6 County normalization drops a trailing standalone "county" word. */
export function normalizeCounty(v: CellValue, cfg: DedupConfig): string | null {
  const t = normalizeText(v, cfg);
  if (t === null) return null;
  const stripped = t.replace(/\s*\bcounty\b$/, "").trim();
  return stripped.length === 0 ? null : stripped;
}
