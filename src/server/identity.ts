import { DedupError } from "@/server/errors";
import type { SheetsGateway } from "@/server/sheets/SheetsGateway";

export interface Reviewer {
  email: string | null;
  display: string;
}

/** §8.7 Whether the audit's actor was a verified account or a typed-in name. */
export type ActorType = "EMAIL" | "FALLBACK_NAME";

export function actorTypeOf(reviewer: Reviewer): ActorType {
  return reviewer.email === null ? "FALLBACK_NAME" : "EMAIL";
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
 * §21.3 The acting reviewer, or null when nothing identifies them. Bootstrap
 * uses this: an anonymous caller is a view to render, not a failure to report.
 */
export function tryResolveReviewer(
  gateway: SheetsGateway,
  fallbackName?: string,
): Reviewer | null {
  const email = gateway.getActiveUserEmail();
  if (email && email.trim() !== "") {
    return { email, display: email };
  }
  const fallback = fallbackName ? sanitizeName(fallbackName) : "";
  if (fallback === "") return null;
  return { email: null, display: fallback };
}

/**
 * Resolve the acting reviewer (§21.3). Prefer the account email; otherwise fall
 * back to a sanitized client-supplied name, or fail closed.
 */
export function resolveReviewer(gateway: SheetsGateway, fallbackName?: string): Reviewer {
  const reviewer = tryResolveReviewer(gateway, fallbackName);
  if (!reviewer) throw new DedupError("MISSING_REVIEWER_IDENTITY");
  return reviewer;
}

/** §8.7 The audit columns naming whoever performed a mutation. */
export interface AuditActor {
  actorId: string;
  actorType: ActorType;
  reviewerId: string;
}

/**
 * §21.3 Every write is attributed: the account email when there is one, otherwise
 * the name the client supplied. Resolve this before taking a lock so an anonymous
 * caller fails before anything reaches the sheet.
 */
export function auditActor(gateway: SheetsGateway, fallbackName?: string): AuditActor {
  const reviewer = resolveReviewer(gateway, fallbackName);
  const id = reviewer.email ?? reviewer.display;
  return { actorId: id, actorType: actorTypeOf(reviewer), reviewerId: id };
}
