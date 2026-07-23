import type { DedupConfig } from "@/shared/config";
import type { CellValue, NormalizedName } from "@/server/types";
import { TITLE_TOKENS } from "@/shared/constants";
import { normalizeText } from "./normalizeText";

const TITLES = new Set<string>(TITLE_TOKENS);

interface FieldTokens {
  tokens: string[];
  aliasTokens: string[];
}

/** Split a raw name field into core tokens plus parenthetical alias tokens. */
function splitField(raw: CellValue, cfg: DedupConfig): FieldTokens {
  if (raw === null) return { tokens: [], aliasTokens: [] };
  const s = typeof raw === "string" ? raw : String(raw);

  const aliasRaw: string[] = [];
  const withoutParens = s.replace(/\(([^)]*)\)/g, (_m, inner: string) => {
    aliasRaw.push(inner);
    return " ";
  });

  const tokens = tokenize(withoutParens, cfg);
  const aliasTokens = aliasRaw.flatMap((a) => tokenize(a, cfg));
  return { tokens, aliasTokens };
}

function tokenize(value: string, cfg: DedupConfig): string[] {
  const norm = normalizeText(value, cfg);
  if (norm === null) return [];
  return norm.split(/[\s-]+/).filter((t) => t.length > 0);
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * §13.2 Name normalization. Pure and deterministic. Produces the multiple
 * representations the similarity functions consume: direct/reversed strings, a
 * sorted signature for blocking, alias tokens, and an initials set.
 */
export function normalizeName(
  first: CellValue,
  middle: CellValue,
  last: CellValue,
  cfg: DedupConfig,
): NormalizedName {
  const f = splitField(first, cfg);
  const m = splitField(middle, cfg);
  const l = splitField(last, cfg);

  // Strip leading standalone titles from the first-name tokens only.
  const firstTokens = [...f.tokens];
  while (firstTokens.length > 0 && TITLES.has(firstTokens[0]!)) {
    firstTokens.shift();
  }
  const middleTokens = m.tokens;
  const lastTokens = l.tokens;

  const coreTokens = [...firstTokens, ...lastTokens];
  const aliasTokens = uniq([...f.aliasTokens, ...m.aliasTokens, ...l.aliasTokens]);

  const orderedNoMiddle = coreTokens.join(" ");
  const reversedNoMiddle = [...lastTokens, ...firstTokens].join(" ");
  const sortedTokenSignature = [...coreTokens].sort().join(" ");

  const initials = uniq(
    [...coreTokens, ...middleTokens].map((t) => t[0]!).filter(Boolean),
  );

  const missingCoreComponent =
    firstTokens.length === 0 || lastTokens.length === 0;

  return {
    firstTokens,
    middleTokens,
    lastTokens,
    aliasTokens,
    coreTokens,
    orderedNoMiddle,
    reversedNoMiddle,
    sortedTokenSignature,
    initials,
    missingCoreComponent,
  };
}
