import type { DedupConfig } from "@/shared/config";
import type { CellValue } from "@/server/types";

const APOSTROPHES = /[‘’ʼ`´]/g;
const DASHES = /[‐‑‒–—―−]/g;
const NON_TEXT = /[^\p{L}\p{N}'\- ]+/gu;

/**
 * §13.1 General text normalization. Pure and deterministic; never mutates the
 * source. Returns null for null-like values and configured missing labels.
 */
export function normalizeText(v: CellValue, cfg: DedupConfig): string | null {
  if (v === null) return null;
  const raw = typeof v === "string" ? v : String(v);
  const probe = raw.trim().toLowerCase();
  for (const label of cfg.missingLabels) {
    if (probe === label.toLowerCase()) return null;
  }

  let s = raw.normalize("NFKD").replace(/\p{Diacritic}/gu, "");
  s = s.toLowerCase();
  s = s.replace(APOSTROPHES, "'").replace(DASHES, "-");
  s = s.replace(NON_TEXT, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s.length === 0 ? null : s;
}
