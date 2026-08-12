import type { QueueItem, QueuePage } from "@/server/review/queue";
import type { ClusterStatus, Confidence } from "@/shared/constants";
import { CLUSTER_STATUSES, CONFIDENCE_LEVELS } from "@/shared/constants";
import {
  append,
  button,
  checkbox,
  checkedValues,
  el,
  humanize,
  setTaskState,
  view,
} from "@/client/dom";

/** §21.4 What the reviewer has narrowed the queue down to. */
export interface QueueFilters {
  confidence: Confidence[];
  statuses: ClusterStatus[];
}

export interface QueueHandlers {
  onOpenFilters(): void;
  onOpenCluster(clusterId: string): void;
  onLoadMore(): void;
  onReviewSummary(): void;
  /** Optional — starts a fresh scan without leaving the sidebar. */
  onRescan?(): void;
}

export interface FilterHandlers {
  onSave(filters: QueueFilters): void;
  onBack(): void;
}

/**
 * §21.4 The filter form. Lives on its own screen (and the Deduplication menu),
 * not inline on the queue — the queue needs the vertical space for comparison.
 */
export function renderQueueFilters(filters: QueueFilters): HTMLFormElement {
  const form = el("form", "dd-filters");
  const confidence = new Set<string>(filters.confidence);
  const statuses = new Set<string>(filters.statuses);

  const byConfidence = el("fieldset", "dd-filter-group");
  append(byConfidence, el("legend", "dd-filter-legend", "Confidence"));
  for (const level of CONFIDENCE_LEVELS) {
    append(byConfidence, checkbox("confidence", level, humanize(level), confidence.has(level)));
  }
  append(form, byConfidence);

  const byStatus = el("fieldset", "dd-filter-group");
  append(byStatus, el("legend", "dd-filter-legend", "Status"));
  for (const status of CLUSTER_STATUSES) {
    append(byStatus, checkbox("status", status, humanize(status), statuses.has(status)));
  }
  append(form, byStatus);

  return form;
}

/** The filters the form is showing right now, in the order they are listed. */
export function readQueueFilters(root: ParentNode): QueueFilters {
  return {
    confidence: checkedValues(root, "confidence") as Confidence[],
    statuses: checkedValues(root, "status") as ClusterStatus[],
  };
}

/** One-line summary for the queue header (filters live elsewhere). */
export function summarizeFilters(filters: QueueFilters): string {
  const confidence =
    filters.confidence.length === 0
      ? "no confidence"
      : filters.confidence.map(humanize).join(", ");
  const statuses =
    filters.statuses.length === 0 ? "no status" : filters.statuses.map(humanize).join(", ");
  return `${confidence} · ${statuses}`;
}

/**
 * Dedicated filter screen — opened from the Deduplication menu or the queue's
 * "Change filters" control.
 */
export function renderFilterSettings(
  filters: QueueFilters,
  handlers: FilterHandlers,
): HTMLElement {
  const section = view("QUEUE_FILTERS", "Queue filters");
  setTaskState(section, "filters_ready");
  append(
    section,
    el(
      "p",
      "dd-hint",
      "These controls which groups appear in the review sidebar. They do not change the sheet.",
    ),
  );

  const form = renderQueueFilters(filters);
  form.addEventListener("change", () => {
    setTaskState(section, "filters_configured");
  });
  append(section, form);

  append(
    section,
    button("Save filters", "save-filters", () => {
      handlers.onSave(readQueueFilters(form));
    }),
  );
  append(section, button("Back", "back", handlers.onBack));
  return section;
}

/**
 * One row. The whole row is the button: a reviewer scanning a narrow sidebar
 * should not have to find a link inside it, and one control per cluster keeps
 * `data-cluster-id` unambiguous.
 */
function queueRow(item: QueueItem, onOpen: (clusterId: string) => void): HTMLElement {
  const row = el("button", "dd-queue-row");
  row.type = "button";
  row.setAttribute("data-cluster-id", item.clusterId);
  row.addEventListener("click", () => {
    onOpen(item.clusterId);
  });

  append(row, el("span", "dd-queue-label", item.label));

  const meta = el("span", "dd-queue-meta");
  const members =
    item.suggestedCount > 0
      ? `${item.memberCount} records +${item.suggestedCount} suggested`
      : `${item.memberCount} records`;
  append(
    meta,
    el("span", `dd-badge dd-confidence-${item.confidence.toLowerCase()}`, humanize(item.confidence)),
    el("span", "dd-queue-count", members),
    el("span", "dd-queue-row-number", `Row ${item.firstSourceRow}`),
  );
  append(row, meta);

  const trailer = el("span", "dd-queue-meta");
  append(trailer, el("span", "dd-queue-status", humanize(item.status)));
  if (item.warnings.length > 0) {
    append(trailer, el("span", "dd-queue-warnings", item.warnings.map(humanize).join(", ")));
  }
  append(row, trailer);

  return row;
}

export function renderQueue(
  page: QueuePage,
  filters: QueueFilters,
  handlers: QueueHandlers,
): HTMLElement {
  const section = view("QUEUE", "Possible duplicates");
  setTaskState(section, "queue_ready");

  const filterBar = el("div", "dd-filter-summary");
  append(filterBar, el("p", "dd-hint", `Showing: ${summarizeFilters(filters)}`));
  append(filterBar, button("Change filters", "open-filters", handlers.onOpenFilters));
  append(section, filterBar);

  append(
    section,
    el(
      "p",
      "dd-message",
      `${page.filteredCount} of ${page.counts.total} groups match. ` +
        `${page.counts.readyToApply} ready to apply.`,
    ),
  );

  if (page.items.length === 0) {
    append(section, el("p", "dd-hint", "No groups match these filters."));
  } else {
    const list = el("div", "dd-queue");
    for (const item of page.items) append(list, queueRow(item, handlers.onOpenCluster));
    append(section, list);
  }

  if (page.nextCursor !== null) {
    append(section, button("Load more", "load-more", handlers.onLoadMore));
  }
  append(section, button("Review summary", "review-summary", handlers.onReviewSummary));
  if (handlers.onRescan) {
    append(section, button("Scan again", "rescan", handlers.onRescan));
  }
  return section;
}
