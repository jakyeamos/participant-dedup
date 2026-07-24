import type { RpcError } from "@/server/rpc/envelope";
import type { ScanState } from "@/server/scan/scanStateMachine";
import { append, button, el, humanize, stat, view } from "@/client/dom";
import { sanitizeFallbackName } from "@/client/session";

/**
 * §21.1 The three screens that are about the tool rather than about the data:
 * an error, a request for the reviewer's name, and a running scan — plus the
 * idle bootstrap screen the menu lands on when there is nothing to resume.
 */

export interface ErrorHandlers {
  onRetry(): void;
}

/**
 * Only the server's own message is shown. It is one of the vetted strings from
 * the error table; anything else the client saw was already replaced with the
 * generic internal message before it reached this function.
 */
export function renderError(error: RpcError, handlers: ErrorHandlers): HTMLElement {
  const section = view("ERROR", "Something needs attention");
  append(section, el("p", "dd-message", error.message));
  append(section, el("p", "dd-code", humanize(error.code)));

  if (error.retryable) {
    append(section, button("Try again", "retry", handlers.onRetry));
  } else {
    append(
      section,
      el("p", "dd-hint", "Retrying will not help. Fix the cause, then reopen the sidebar."),
    );
  }
  return section;
}

export interface IdentityHandlers {
  onSubmit(name: string): void;
}

/**
 * §21.3 Shown only when Apps Script declines to disclose the account email.
 * The name typed here is an audit attribution, so it is trimmed to what will
 * actually read as a person's name before it leaves the screen.
 */
export function renderIdentityRequired(handlers: IdentityHandlers): HTMLElement {
  const section = view("IDENTITY_REQUIRED", "Who is reviewing?");
  append(
    section,
    el(
      "p",
      "dd-message",
      "This account does not share its email address with the script. Type the name that should " +
        "appear in the change history.",
    ),
  );

  const field = el("input", "dd-input");
  field.type = "text";
  field.setAttribute("data-field", "fallbackName");
  field.maxLength = 60;
  field.autocomplete = "off";

  const label = el("label", "dd-field");
  append(label, el("span", "dd-field-label", "Your name"), field);
  append(section, label);

  append(
    section,
    button("Continue", "use-name", () => {
      handlers.onSubmit(sanitizeFallbackName(field.value));
    }),
  );
  return section;
}

export interface ScanHandlers {
  onCancel(): void;
}

/**
 * §21.2 Counters, not a percentage. The scan does not know how many candidate
 * pairs it will generate until it has generated them, and a progress bar that
 * invents a denominator would be lying about a run that can take many slices.
 */
export function renderScanProgress(state: ScanState, handlers: ScanHandlers): HTMLElement {
  const section = view("SCAN_PROGRESS", "Scanning for duplicates");
  append(section, el("p", "dd-message", humanize(state.phase)));

  const stats = el("div", "dd-stats");
  append(
    stats,
    stat("records", "Records read", state.metrics.records),
    stat("candidates", "Candidate pairs", state.metrics.candidates),
    stat("qualifiedEdges", "Matches found", state.metrics.qualifiedEdges),
    stat("clusters", "Groups formed", state.metrics.clusters),
  );
  append(section, stats);

  append(
    section,
    el("p", "dd-hint", "Leave this sidebar open. Closing it stops the scan where it is."),
  );
  append(section, button("Cancel scan", "cancel", handlers.onCancel));
  return section;
}

export interface BootstrapHandlers {
  onStartScan(): void;
  onOpenHistory(): void;
}

/**
 * §21.1 The idle landing screen. Shown when the menu opens the sidebar without
 * auto-starting a scan and there is no ready batch to resume into the queue.
 */
export function renderBootstrap(
  info: { activeSheetName: string | null; identityDisplay: string },
  handlers: BootstrapHandlers,
): HTMLElement {
  const section = view("BOOTSTRAP", "Participant Deduplication");
  const sheet =
    info.activeSheetName && info.activeSheetName !== ""
      ? info.activeSheetName
      : "No sheet is active";
  append(section, el("p", "dd-message", `Active sheet: ${sheet}`));
  if (info.identityDisplay !== "") {
    append(section, el("p", "dd-hint", `Reviewing as ${info.identityDisplay}`));
  }
  append(
    section,
    el(
      "p",
      "dd-hint",
      "Scan finds possible duplicate groups. Nothing is deleted until you review and confirm.",
    ),
  );
  append(section, button("Scan active sheet", "start-scan", handlers.onStartScan));
  append(section, button("View change history", "open-history", handlers.onOpenHistory));
  return section;
}
