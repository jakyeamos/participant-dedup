import type { DedupConfig } from "@/shared/config";
import type { CellValue, NormalizedAddress } from "@/server/types";
import { ADDRESS_ABBREVIATIONS } from "@/shared/constants";
import { normalizeText } from "./normalizeText";

/**
 * §13.5 Address normalization. Pure and deterministic; performs no geocoding
 * and makes no external calls. Extracts a leading house number, a unit value,
 * and the remaining canonicalized street tokens.
 */
export function normalizeAddress(
  v: CellValue,
  cfg: DedupConfig,
): NormalizedAddress | null {
  if (v === null) return null;

  // Expand "#" to an explicit unit marker before normalizeText discards it.
  const raw = (typeof v === "string" ? v : String(v)).replace(/#/g, " unit ");

  const norm = normalizeText(raw, cfg);
  if (norm === null) return null;

  const tokens = norm
    .split(/[\s-]+/)
    .filter((t) => t.length > 0)
    .map((t) => ADDRESS_ABBREVIATIONS[t] ?? t);
  if (tokens.length === 0) return null;

  let houseNumber: string | null = null;
  const rest = [...tokens];
  if (rest.length > 0 && /^\d+$/.test(rest[0]!)) {
    houseNumber = rest.shift()!;
  }

  let unit: string | null = null;
  const streetTokens: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "unit" && i + 1 < rest.length) {
      unit = rest[i + 1]!;
      i += 1;
      continue;
    }
    streetTokens.push(rest[i]!);
  }

  const full = tokens.join(" ");
  return { full, houseNumber, streetTokens, unit };
}
