import type { DedupConfig } from "@/shared/config";
import type {
  CellValue,
  NormalizedParticipant,
  SourceSchema,
} from "@/server/types";
import type { CanonicalField } from "@/shared/constants";
import { normalizeName } from "./normalizeName";
import { normalizeDob } from "./normalizeDob";
import { normalizeZip } from "./normalizeZip";
import { normalizeAddress } from "./normalizeAddress";
import {
  normalizeCity,
  normalizeCounty,
  normalizeState,
} from "./normalizeLocation";
import { normalizeText } from "./normalizeText";

/**
 * §13 Row assembler. Resolves each canonical field to its source header via the
 * schema mapping, dispatches to the matching field normalizer, and collects the
 * remaining columns as normalized extras. ZIP intentionally reads the display
 * value so leading zeros survive.
 */
export function normalizeParticipant(
  valuesByHeader: Record<string, CellValue>,
  displayByHeader: Record<string, string>,
  schema: SourceSchema,
  tz: string,
  cfg: DedupConfig,
): NormalizedParticipant {
  const headerFor = (field: CanonicalField): string | null => {
    const idx = schema.columnByCanonicalField[field];
    if (idx === undefined) return null;
    return schema.headers[idx] ?? null;
  };

  const rawOf = (field: CanonicalField): CellValue => {
    const header = headerFor(field);
    if (header === null) return null;
    return valuesByHeader[header] ?? null;
  };

  const displayOf = (field: CanonicalField): string => {
    const header = headerFor(field);
    if (header === null) return "";
    return displayByHeader[header] ?? "";
  };

  const extras: Record<string, string | null> = {};
  for (const col of schema.extraColumns) {
    extras[col.header] = normalizeText(valuesByHeader[col.header] ?? null, cfg);
  }

  return {
    name: normalizeName(rawOf("first"), rawOf("middle"), rawOf("last"), cfg),
    dob: normalizeDob(rawOf("dob"), tz, cfg),
    zip: normalizeZip(displayOf("zip")),
    address: normalizeAddress(rawOf("address1"), cfg),
    city: normalizeCity(rawOf("city"), cfg),
    state: normalizeState(rawOf("state"), cfg),
    county: normalizeCounty(rawOf("county"), cfg),
    extras,
  };
}
