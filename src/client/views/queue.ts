import type { QueueItem, QueuePage } from "@/server/review/queue";
import type { ClusterStatus, Confidence } from "@/shared/constants";
import { CLUSTER_STATUSES, CONFIDENCE_LEVELS } from "@/shared/constants";
import { append, checkbox, checkedValues, el, button, humanize, view } from "@/client/dom";

/** §21.4 What the reviewer has narrowed the queue down to. */
export interface QueueFilters {
  confidence: Confidence[];
  statuses: ClusterStatus[];
}

export interface QueueHandlers {
  onFiltersChange(filters: QueueFilters): void;
  onOpenCluster(clusterId: string): void;
  onLoadMore(): void;
  onReviewSummary(): void;
}

/**
 * §21.4 The filter form. The defaults live with the caller, not here: the
 * controller is what knows whether this is a fresh queue (High and Medium,
 * unreviewed) or a queue the reviewer has already narrowed.
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

  const form = renderQueueFilters(filters);
  form.addEventListener("change", () => {
    handlers.onFiltersChange(readQueueFilters(form));
  });
  append(section, form);

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
  return section;
}
