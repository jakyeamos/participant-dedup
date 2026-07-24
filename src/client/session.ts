/**
 * §21.3 The typed-in reviewer name, for accounts whose email Apps Script will
 * not disclose. It lives in `sessionStorage` and nowhere else: the name is an
 * audit attribution, and leaving it in `localStorage` would attribute the next
 * person to sit at this browser to whoever typed it last.
 */

const KEY = "dedup.fallbackName";

/** §21.3 Long enough to identify a person, short enough not to become a note. */
const MAX_LENGTH = 60;

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
