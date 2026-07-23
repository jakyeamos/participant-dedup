import { DedupError } from "@/server/errors";
import type { SheetsGateway } from "@/server/sheets/SheetsGateway";

export interface Reviewer {
  email: string | null;
  display: string;
}

/** Strip angle brackets and control chars, collapse whitespace, cap length. */
function sanitizeName(raw: string): string {
  return raw
    .replace(/[<>]/g, "")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim()
    .slice(0, 100);
}

/**
 * Resolve the acting reviewer (§21.3). Prefer the account email; otherwise fall
 * back to a sanitized client-supplied name, or fail closed.
 */
export function resolveReviewer(gateway: SheetsGateway, fallbackName?: string): Reviewer {
  const email = gateway.getActiveUserEmail();
  if (email && email.trim() !== "") {
    return { email, display: email };
  }
  const fallback = fallbackName ? sanitizeName(fallbackName) : "";
  if (fallback === "") throw new DedupError("MISSING_REVIEWER_IDENTITY");
  return { email: null, display: fallback };
}
