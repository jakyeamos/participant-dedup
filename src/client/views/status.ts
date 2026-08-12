import type { RpcError } from "@/server/rpc/envelope";
import type { ScanState } from "@/server/scan/scanStateMachine";
import { append, button, el, humanize, setTaskState, stat, view } from "@/client/dom";
import { sanitizeFallbackName } from "@/client/session";

/**
 * §21.1 The screens that are about the tool rather than about the data: loading,
 * an error, a request for the reviewer's name, a running scan, and the idle
 * bootstrap screen the menu lands on when there is nothing to resume.
 */

/** Shown immediately on open so the sidebar is never a blank panel while RPCs run. */
export function renderLoading(message = "Loading…"): HTMLElement {
  const section = view("LOADING", "Participant Deduplication");
  setTaskState(section, "loading");
  const body = el("div", "dd-loading");
  append(body, progressBar(null));
  append(body, el("p", "dd-message", message));
  append(section, body);
  return section;
}

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
  setTaskState(section, "task_failed");
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
  setTaskState(section, "permission_required");
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

export interface ScanProgressTiming {
  elapsedMs: number;
}

const PHASE_WEIGHTS: Record<string, { start: number; end: number }> = {
  SNAPSHOTTING: { start: 5, end: 35 },
  GENERATING_CANDIDATES: { start: 35, end: 55 },
  SCORING: { start: 55, end: 88 },
  CLUSTERING: { start: 88, end: 96 },
  READY: { start: 100, end: 100 },
};

function phasePercent(state: ScanState): number {
  const band = PHASE_WEIGHTS[state.phase] ?? PHASE_WEIGHTS[state.status] ?? { start: 8, end: 12 };
  if (state.phase === "SNAPSHOTTING" || state.status === "SNAPSHOTTING") {
    const total = Math.max(1, state.metrics.sourceRows);
    const done = Math.min(total, state.metrics.records);
    const t = done / total;
    return Math.max(5, Math.min(95, Math.round(band.start + (band.end - band.start) * t)));
  }
  if (state.phase === "SCORING" || state.status === "SCORING") {
    const total = Math.max(1, state.metrics.candidates);
    // qualifiedEdges grows during scoring only after cluster finalize — use
    // candidates as the ceiling and leave mid-band until clustering.
    return Math.max(band.start, Math.min(band.end - 1, band.start + 8));
  }
  return Math.max(5, Math.min(95, band.start));
}

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function etaText(percent: number, elapsedMs: number): string {
  if (elapsedMs < 1000 || percent <= 5) return "Estimating time remaining…";
  const remaining = (elapsedMs / percent) * (100 - percent);
  return `About ${formatDuration(remaining)} remaining · ${formatDuration(elapsedMs)} elapsed`;
}

function progressBar(percent: number | null): HTMLElement {
  const bar = el("div", percent === null ? "dd-progress dd-progress-indeterminate" : "dd-progress");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  if (percent !== null) {
    bar.setAttribute("aria-valuenow", String(percent));
  }
  const fill = el("div", "dd-progress-fill");
  if (percent !== null) fill.style.width = `${percent}%`;
  append(bar, fill);
  return bar;
}

/** §21.2 Estimated phase progress plus real counters from the scan state. */
export function renderScanProgress(
  state: ScanState,
  handlers: ScanHandlers,
  timing: ScanProgressTiming = { elapsedMs: 0 },
): HTMLElement {
  const section = view("SCAN_PROGRESS", "Scanning for duplicates");
  setTaskState(section, "scan_running");
  const percent = phasePercent(state);
  append(section, el("p", "dd-message", `${humanize(state.phase)} · ${percent}%`));
  append(section, progressBar(percent));
  append(section, el("p", "dd-hint", etaText(percent, timing.elapsedMs)));

  const stats = el("div", "dd-stats");
  append(
    stats,
    stat("records", "Records read", state.metrics.records),
    stat("candidates", "Candidate pairs", state.metrics.candidates),
    stat("qualifiedEdges", "Matches found", state.metrics.qualifiedEdges),
    stat("clusters", "Groups formed", state.metrics.clusters),
  );
  append(section, stats);

  if (state.warnings.length > 0) {
    for (const warning of state.warnings) {
      const text =
        warning === "CANDIDATE_TRUNCATION"
          ? "Candidate pairs were capped to keep the scan reliable. Some weak matches may be missing."
          : warning === "HIGH_CANDIDATE_VOLUME"
            ? "This sheet produced a large number of candidate pairs. Review may take longer."
            : humanize(warning);
      append(section, el("p", "dd-hint", text));
    }
  }

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
  setTaskState(section, "ready");
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
