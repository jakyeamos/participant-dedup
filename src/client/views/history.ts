import type { CellValue } from "@/server/types";
import type { HistoryEvent, HistoryPage } from "@/server/history";
import { append, button, el, humanize, setTaskState, view } from "@/client/dom";

/**
 * §25 The change history. Every value on this screen came out of a participant
 * row at some point, so all of it goes through the same `textContent` helpers
 * the review screens use.
 */

export interface HistoryHandlers {
  onLoadMore(): void;
}

/** A stored cell as one line of text. Blank and absent read the same here. */
function cellText(value: CellValue): string {
  if (value === null || value === "") return "(blank)";
  return String(value);
}

function eventRow(event: HistoryEvent): HTMLElement {
  const row = el("li", "dd-event");
  row.setAttribute("data-event-id", event.eventId);

  const head = el("div", "dd-event-head");
  append(
    head,
    el("span", "dd-event-type", humanize(event.eventType)),
    el("span", "dd-event-at", event.eventAt),
  );
  append(row, head);

  const who = [event.targetDedupId, event.actorId].filter((part) => part !== "").join(" · ");
  if (who !== "") append(row, el("div", "dd-event-who", who));

  if (event.fieldName !== "") {
    const change = el("div", "dd-event-change");
    append(
      change,
      el("span", "dd-event-field", event.fieldName),
      el("span", "dd-event-before", cellText(event.beforeValue)),
      el("span", "dd-event-arrow", "→"),
      el("span", "dd-event-after", cellText(event.afterValue)),
    );
    append(row, change);
  }

  if (event.result !== "SUCCESS") {
    const detail = [humanize(event.result), event.errorMessage].filter((p) => p !== "").join(": ");
    append(row, el("div", "dd-event-error", detail));
  }
  return row;
}

export function renderHistory(page: HistoryPage, handlers: HistoryHandlers): HTMLElement {
  const section = view("AUDIT_HISTORY", "Change history");
  setTaskState(section, "history_loaded");
  append(
    section,
    el("p", "dd-message", `Showing ${page.filteredCount} of ${page.totalCount} recorded changes.`),
  );

  if (page.events.length === 0) {
    append(section, el("p", "dd-hint", "Nothing has been changed yet."));
    return section;
  }

  const list = el("ul", "dd-events");
  for (const event of page.events) append(list, eventRow(event));
  append(section, list);

  if (page.nextCursor !== null) {
    append(section, button("Load more", "load-more", handlers.onLoadMore));
  }
  return section;
}
