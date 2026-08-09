import type { DedupConfig } from "@/shared/config";
import type { CellValue, NormalizedDob } from "@/server/types";

const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const US = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const table = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[month - 1]!;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/**
 * Parse only the explicit, unambiguous formats permitted by §13.3. Returns a
 * canonical `yyyy-MM-dd` string, or null when the value is not a recognized
 * format or fails calendar-bounds validation. Never falls back to
 * `new Date(string)`, which would silently accept ambiguous or locale-specific
 * inputs.
 */
function parseExplicit(s: string): string | null {
  let year: number;
  let month: number;
  let day: number;

  const iso = ISO.exec(s);
  const us = US.exec(s);
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (us) {
    month = Number(us[1]);
    day = Number(us[2]);
    year = Number(us[3]);
  } else {
    return null;
  }

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;

  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * §13.3 DOB normalization. Classifies the value into VALID / MISSING /
 * PLACEHOLDER / INVALID and, when parseable, returns a canonical ISO date. The
 * `tz` parameter is reserved for the gateway path where a live Date object is
 * pre-formatted before reaching this pure function; string inputs here are
 * timezone-agnostic.
 */
export function normalizeDob(
  raw: CellValue,
  _tz: string,
  cfg: DedupConfig,
): NormalizedDob {
  if (raw === null) return { value: null, state: "MISSING" };

  const s = (typeof raw === "string" ? raw : String(raw)).trim();
  if (s === "") return { value: null, state: "MISSING" };

  const lower = s.toLowerCase();
  for (const label of cfg.missingLabels) {
    if (lower === label.trim().toLowerCase()) {
      return { value: null, state: "MISSING" };
    }
  }

  const iso = parseExplicit(s);
  if (iso === null) return { value: null, state: "INVALID" };

  if (cfg.placeholderDates.includes(iso)) {
    return { value: iso, state: "PLACEHOLDER" };
  }
  if (cfg.treatJanuaryFirstAsPlaceholder && iso.endsWith("-01-01")) {
    return { value: iso, state: "PLACEHOLDER" };
  }
  return { value: iso, state: "VALID" };
}
