import type { NormalizedParticipant } from "@/server/types";

const CONTEXT_CAP = 2;

/**
 * §15.5 Context similarity. Accumulates weak support from agreeing city, state,
 * county, and exact extra-field values, capped at two points total.
 */
export function contextSimilarity(
  a: NormalizedParticipant,
  b: NormalizedParticipant,
): number {
  let points = 0;

  if (a.city !== null && a.city === b.city) points += 1;
  if (a.state !== null && a.state === b.state) points += 0.5;
  if (a.county !== null && a.county === b.county) points += 0.5;

  for (const key of Object.keys(a.extras)) {
    const av = a.extras[key];
    const bv = b.extras[key];
    if (av !== null && av !== undefined && av === bv) points += 0.5;
  }

  return Math.min(points, CONTEXT_CAP);
}
