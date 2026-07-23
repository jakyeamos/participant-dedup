/**
 * §15.1 Jaro-Winkler similarity in [0, 1]. Pure and dependency-free.
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0 || lenB === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(lenA, lenB) / 2) - 1);
  const aMatched = new Array<boolean>(lenA).fill(false);
  const bMatched = new Array<boolean>(lenB).fill(false);

  let matches = 0;
  for (let i = 0; i < lenA; i += 1) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, lenB);
    for (let j = start; j < end; j += 1) {
      if (bMatched[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }

  if (matches === 0) return 0;

  // Count transpositions.
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < lenA; i += 1) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  transpositions /= 2;

  const m = matches;
  const jaro = (m / lenA + m / lenB + (m - transpositions) / m) / 3;

  // Winkler bonus for a common prefix up to 4 characters.
  let prefix = 0;
  const maxPrefix = Math.min(4, lenA, lenB);
  for (let i = 0; i < maxPrefix; i += 1) {
    if (a[i] === b[i]) prefix += 1;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}
