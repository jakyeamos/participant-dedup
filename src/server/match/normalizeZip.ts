/**
 * §13.4 ZIP normalization. Operates on the display value so leading zeros are
 * preserved. Returns the first five digits, or null when fewer than five exist.
 */
export function normalizeZip(display: string): string | null {
  const digits = display.replace(/\D/g, "");
  if (digits.length < 5) return null;
  return digits.slice(0, 5);
}
