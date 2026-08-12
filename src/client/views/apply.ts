import type { ApplyResult } from "@/server/apply/applyDecisions";
import type { CreatedChallenge } from "@/server/apply/preflight";
import type { BatchSummary } from "@/server/review/summary";
import { append, button, el, setTaskState, stat, view } from "@/client/dom";

/**
 * §23–§24 The three screens either side of the only operation that deletes
 * anything: what an apply would do, the typed confirmation, and what it did.
 */

export interface SummaryHandlers {
  onApply(): void;
  onBack(): void;
}

/** §23.1 The whole batch in numbers, before anyone is asked to confirm. */
export function renderBatchSummary(summary: BatchSummary, handlers: SummaryHandlers): HTMLElement {
  const section = view("BATCH_SUMMARY", "Review summary");
  setTaskState(section, "summary_ready");
  append(section, el("p", "dd-message", `Sheet: ${summary.sourceSheetName}`));

  const stats = el("div", "dd-stats");
  append(
    stats,
    stat("totalClusters", "Groups found", summary.totalClusters),
    stat("readyToApplyClusters", "Ready to apply", summary.readyToApplyClusters),
    stat("keepAllClusters", "Kept as-is", summary.keepAllClusters),
    stat("unresolvedClusters", "Still unresolved", summary.unresolvedClusters),
    stat("staleClusters", "Out of date", summary.staleClusters),
    stat("appliedClusters", "Already applied", summary.appliedClusters),
    stat("rowsToRetain", "Rows to keep", summary.rowsToRetain),
    stat("rowsToDelete", "Rows to delete", summary.rowsToDelete),
    stat("blankFieldsToFill", "Blank fields to fill", summary.blankFieldsToFill),
    stat("manualConflictChoices", "Conflicts you chose", summary.manualConflictChoices),
  );
  append(section, stats);

  if (summary.candidateTruncation) {
    append(
      section,
      el(
        "p",
        "dd-warning",
        `Candidate generation was truncated for ${summary.candidateTruncationCount} records. ` +
          "Some duplicates may not appear in this batch.",
      ),
    );
  }
  if (summary.unresolvedClusters > 0 || summary.staleClusters > 0) {
    append(
      section,
      el(
        "p",
        "dd-hint",
        "Groups that are unresolved or out of date are skipped by an apply. They stay in the " +
          "queue.",
      ),
    );
  }

  append(section, button("Continue to confirmation", "continue", handlers.onApply));
  append(section, button("Back to queue", "back", handlers.onBack));
  return section;
}

export interface ConfirmHandlers {
  onApply(token: string): void;
  onBack(): void;
}

/**
 * §24 The typed confirmation. The token must match exactly, including case:
 * this is the last screen before rows leave the sheet permanently, and a
 * checkbox is too easy to click past. The button starts disabled and is enabled
 * only by the exact string, never by a prefix or a case-insensitive match.
 */
export function renderApplyConfirmation(
  challenge: CreatedChallenge,
  summary: BatchSummary,
  expectedText: string,
  handlers: ConfirmHandlers,
): HTMLElement {
  const section = view("APPLY_CONFIRMATION", "Confirm permanent deletion");
  setTaskState(section, "confirmation_required");
  append(section, el("p", "dd-message", `Sheet: ${summary.sourceSheetName}`));

  const stats = el("div", "dd-stats");
  append(
    stats,
    stat("clusterCount", "Groups to apply", challenge.summary.clusterCount),
    stat("retainedCount", "Rows to keep", challenge.summary.retainedCount),
    stat("deletionRowCount", "Rows to delete", challenge.summary.deletionRowCount),
    stat("fillCount", "Blank fields to fill", challenge.summary.fillCount),
  );
  append(section, stats);

  append(
    section,
    el(
      "p",
      "dd-warning",
      "Selected rows will be permanently removed from the participant sheet and no full-sheet " +
        "backup will be created.",
    ),
  );
  append(
    section,
    el("p", "dd-hint", `Type "${expectedText}" exactly, then choose Apply.`),
  );

  const field = el("input", "dd-input");
  field.type = "text";
  field.setAttribute("data-field", "confirmation");
  field.autocomplete = "off";

  const label = el("label", "dd-field");
  append(label, el("span", "dd-field-label", "Confirmation"), field);
  append(section, label);

  const apply = button("Apply and delete rows", "apply", () => {
    handlers.onApply(challenge.token);
  });
  apply.disabled = true;
  apply.classList.add("dd-danger");

  field.addEventListener("input", () => {
    apply.disabled = field.value !== expectedText;
    setTaskState(section, apply.disabled ? "confirmation_required" : "confirmation_ready");
  });

  append(section, apply);
  append(section, button("Back", "back", handlers.onBack));
  return section;
}

export interface ResultHandlers {
  onDone(): void;
}

/** §24 What actually happened, from the run's own counters. */
export function renderApplyResult(result: ApplyResult, handlers: ResultHandlers): HTMLElement {
  const section = view("APPLY_RESULT", "Changes applied");
  setTaskState(section, "changes_applied");

  const stats = el("div", "dd-stats");
  append(
    stats,
    stat("deletedRows", "Rows deleted", result.deletedRows),
    stat("filledFields", "Blank fields filled", result.filledFields),
    stat("auditWritten", "History rows written", result.auditWritten),
  );
  append(section, stats);

  append(
    section,
    el("p", "dd-hint", `Look for apply run ${result.applyBatchId} in the change history.`),
  );
  append(section, button("Done", "done", handlers.onDone));
  return section;
}
