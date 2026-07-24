import type { ClusterDetail, ClusterDetailRecord } from "@/server/review/clusterDetail";
import type { MergePlan } from "@/server/review/mergePlan";
import type { ClusterDecision, FieldChoice } from "@/server/types";
import { append, button, checkedValues, clear, el, humanize, radio, view } from "@/client/dom";

/**
 * §21.6 The review screen. Everything a reviewer needs to judge one group of
 * records, and nothing that would judge it for them: no mode is preselected, no
 * record is marked for deletion, and `Save decision` stays disabled until the
 * reviewer has made a choice the server can act on.
 */

export interface ClusterHandlers {
  onSave(decision: ClusterDecision): void;
  onFocusRow(dedupId: string): void;
  onBack(): void;
}

type DecisionMode = ClusterDecision["mode"];

const MODE_LABELS: Array<[DecisionMode, string, string]> = [
  ["KEEP_ALL", "Keep all records", "These are different people. Stop offering this group."],
  ["SELECT_RECORDS", "Choose records to keep", "Delete the records you do not tick."],
  ["UNRESOLVED", "Leave unresolved", "Come back to this one later. Nothing is deleted."],
];

function valueOf(record: ClusterDetailRecord, headerIndex: number): string {
  const value = record.values[headerIndex];
  return value === undefined || value === "" ? "" : value;
}

function checkedMode(root: ParentNode): DecisionMode | null {
  const input = root.querySelector<HTMLInputElement>('input[name="mode"]:checked');
  return input ? (input.value as DecisionMode) : null;
}

function retainInputs(root: ParentNode): HTMLInputElement[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>('input[name="retain"]'));
}

/**
 * The records this decision has to account for. §22.2 requires every core
 * member to be kept or assigned; a suggested member (§18.2) may be left out of
 * the decision entirely, and is only touched if the reviewer ticks it.
 */
function coreIds(detail: ClusterDetail): string[] {
  return detail.records.filter((r) => r.role === "CORE").map((r) => r.dedupId);
}

function recordCard(
  detail: ClusterDetail,
  record: ClusterDetailRecord,
  handlers: ClusterHandlers,
): HTMLElement {
  const card = el("div", "dd-record");
  card.setAttribute("data-dedup-id", record.dedupId);

  const head = el("div", "dd-record-head");
  append(head, el("span", "dd-record-label", record.label));
  if (record.role === "SUGGESTED") {
    append(head, el("span", "dd-badge dd-suggested", "Suggested"));
  }
  append(head, el("span", "dd-record-row", `Row ${record.sourceRow}`));
  append(card, head);

  const fields = el("dl", "dd-record-fields");
  const differing = new Set(detail.differingHeaders);
  detail.headers.forEach((header, index) => {
    const value = valueOf(record, index);
    const term = el("dt", differing.has(header) ? "dd-field-name dd-differs" : "dd-field-name");
    term.textContent = header;
    const definition = el(
      "dd",
      value === "" ? "dd-field-value dd-blank" : "dd-field-value",
      value === "" ? "(blank)" : value,
    );
    append(fields, term, definition);
  });
  append(card, fields);

  const retain = el("label", "dd-choice dd-retain");
  const box = el("input");
  box.type = "checkbox";
  box.name = "retain";
  box.value = record.dedupId;
  box.disabled = true;
  retain.hidden = true;
  append(retain, box, el("span", "dd-choice-label", "Keep this record"));
  append(card, retain);

  const focus = button("Open source row", "focus-row", () => {
    handlers.onFocusRow(record.dedupId);
  });
  focus.setAttribute("data-dedup-id", record.dedupId);
  append(card, focus);

  return card;
}

/**
 * §22.5 The candidate values behind one conflict. The server reports a
 * conflict's distinct values but not which record each came from, so the source
 * is recovered here the same way the server grouped them: the records being
 * deleted into this target, in order, first value of each distinct one wins.
 */
function conflictSources(
  detail: ClusterDetail,
  retainedId: string,
  header: string,
): Array<{ sourceId: string; label: string; value: string }> {
  const headerIndex = detail.headers.indexOf(header);
  if (headerIndex < 0) return [];
  const assignments = detail.decision?.deleteAssignments ?? {};
  const seen = new Set<string>();
  const out: Array<{ sourceId: string; label: string; value: string }> = [];

  for (const record of detail.records) {
    if (assignments[record.dedupId] !== retainedId) continue;
    const value = valueOf(record, headerIndex);
    if (value.trim() === "") continue;
    const key = value.trim().replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sourceId: record.dedupId, label: record.label, value });
  }
  return out;
}

function labelOf(detail: ClusterDetail, dedupId: string): string {
  return detail.records.find((r) => r.dedupId === dedupId)?.label ?? dedupId;
}

/**
 * §22.5 What the saved decision implies, as recomputed by the server. It exists
 * only after a decision has been saved, which is why opening a cluster shows no
 * proposed deletions at all.
 */
function planRegion(detail: ClusterDetail, plan: MergePlan): HTMLElement {
  const region = el("section", "dd-plan");
  region.setAttribute("data-region", "plan");
  append(region, el("h3", "dd-subheading", "What applying this would do"));

  if (plan.deletions.length === 0) {
    append(region, el("p", "dd-hint", "Nothing would be deleted."));
  } else {
    const list = el("ul", "dd-plan-list");
    for (const deletion of plan.deletions) {
      append(
        list,
        el(
          "li",
          "dd-plan-deletion",
          `Delete ${labelOf(detail, deletion.deletedId)} and keep ${labelOf(detail, deletion.retainedId)}`,
        ),
      );
    }
    append(region, list);
  }

  if (plan.fills.length > 0) {
    append(region, el("h4", "dd-subheading", "Blank fields that would be filled"));
    const list = el("ul", "dd-plan-list");
    for (const fill of plan.fills) {
      const line = el("li", "dd-plan-fill");
      append(
        line,
        el("span", "dd-field-name", fill.header),
        el("span", "dd-field-value", fill.value),
        el("span", "dd-plan-source", `from ${labelOf(detail, fill.sourceId)}`),
      );
      append(list, line);
    }
    append(region, list);
  }

  plan.conflicts.forEach((conflict, index) => {
    const block = el("fieldset", "dd-conflict");
    block.setAttribute("data-conflict", String(index));
    block.setAttribute("data-retained-id", conflict.retainedId);
    block.setAttribute("data-header", conflict.header);
    append(
      block,
      el(
        "legend",
        "dd-conflict-head",
        `${conflict.header} — pick one for ${labelOf(detail, conflict.retainedId)}`,
      ),
    );

    const name = `choice:${index}`;
    const chosen = detail.decision?.fieldChoices?.[conflict.retainedId]?.[conflict.header];
    for (const source of conflictSources(detail, conflict.retainedId, conflict.header)) {
      const picked = chosen?.mode === "SOURCE" && chosen.sourceId === source.sourceId;
      const choice = radio(name, `SOURCE:${source.sourceId}`, "", picked);
      const text = choice.querySelector<HTMLElement>(".dd-choice-label");
      if (text) {
        append(
          text,
          el("span", "dd-field-value", source.value),
          el("span", "dd-plan-source", `from ${source.label}`),
        );
      }
      append(block, choice);
    }
    append(block, radio(name, "LEAVE_BLANK", "Leave blank", chosen?.mode === "LEAVE_BLANK"));
    append(region, block);
  });

  if (plan.issues.length > 0) {
    const list = el("ul", "dd-plan-issues");
    for (const issue of plan.issues) append(list, el("li", "dd-warning", humanize(issue)));
    append(region, el("h4", "dd-subheading", "Still needed before this can be applied"));
    append(region, list);
  }
  return region;
}

/**
 * §22.5 The reviewer's conflict answers, read back off the plan region. Absent
 * region means absent answers, so a screen that has never shown a conflict
 * resubmits the choices already stored rather than erasing them.
 */
function readFieldChoices(
  root: ParentNode,
  detail: ClusterDetail,
): Record<string, Record<string, FieldChoice>> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("[data-conflict]"));
  if (blocks.length === 0) return detail.decision?.fieldChoices ?? {};

  const out: Record<string, Record<string, FieldChoice>> = {};
  for (const block of blocks) {
    const picked = block.querySelector<HTMLInputElement>('input[type="radio"]:checked');
    if (!picked) continue;
    const retainedId = block.getAttribute("data-retained-id") ?? "";
    const header = block.getAttribute("data-header") ?? "";
    if (retainedId === "" || header === "") continue;
    const forRecord = out[retainedId] ?? {};
    forRecord[header] =
      picked.value === "LEAVE_BLANK"
        ? { mode: "LEAVE_BLANK" }
        : { mode: "SOURCE", sourceId: picked.value.slice("SOURCE:".length) };
    out[retainedId] = forRecord;
  }
  return out;
}

/**
 * §22.2 The reviewer's choices as the server expects them, or null when the
 * screen does not yet describe a decision. Null is the answer for an untouched
 * cluster, for `Choose records to keep` with nothing kept, and for a deletion
 * whose merge target has not been picked — all three would otherwise submit a
 * decision the reviewer never made.
 */
export function readDecision(root: ParentNode, detail: ClusterDetail): ClusterDecision | null {
  const mode = checkedMode(root);
  if (mode === null) return null;

  const notes = root.querySelector<HTMLTextAreaElement>('[data-field="notes"]')?.value ?? "";
  const everyId = detail.records.map((r) => r.dedupId);
  const base = {
    batchId: detail.batchId,
    clusterId: detail.clusterId,
    expectedRevision: detail.revision,
    notes,
  };

  if (mode === "KEEP_ALL" || mode === "UNRESOLVED") {
    return {
      ...base,
      mode,
      retainedIds: everyId,
      deleteAssignments: {},
      fieldChoices: {},
    };
  }

  const retainedIds = checkedValues(root, "retain");
  if (retainedIds.length === 0) return null;

  const retained = new Set(retainedIds);
  const deleteAssignments: Record<string, string> = {};
  for (const dedupId of coreIds(detail)) {
    if (retained.has(dedupId)) continue;
    if (retainedIds.length === 1) {
      deleteAssignments[dedupId] = retainedIds[0]!;
      continue;
    }
    const select = root.querySelector<HTMLSelectElement>(`[data-target-for="${dedupId}"]`);
    const target = select?.value ?? "";
    if (target === "") return null;
    deleteAssignments[dedupId] = target;
  }

  return {
    ...base,
    mode,
    retainedIds,
    deleteAssignments,
    fieldChoices: readFieldChoices(root, detail),
  };
}

/**
 * The merge-target pickers, rebuilt whenever the kept set changes. §21.6 asks
 * for one only when more than one record remains — with a single survivor there
 * is nothing to choose, and an empty dropdown would just be another way to get
 * the decision wrong.
 */
function renderTargets(
  region: HTMLElement,
  detail: ClusterDetail,
  retainedIds: string[],
  previous: Map<string, string>,
): void {
  clear(region);
  if (retainedIds.length < 2) return;

  const retained = new Set(retainedIds);
  const pending = coreIds(detail).filter((id) => !retained.has(id));
  if (pending.length === 0) return;

  append(region, el("h3", "dd-subheading", "Which record should each deletion merge into?"));

  for (const dedupId of pending) {
    const row = el("label", "dd-field");
    append(row, el("span", "dd-field-label", labelOf(detail, dedupId)));

    const select = el("select", "dd-select");
    select.setAttribute("data-target-for", dedupId);
    const blank = el("option", "", "Choose a record…");
    blank.value = "";
    append(select, blank);

    for (const retainedId of retainedIds) {
      const option = el("option", "", labelOf(detail, retainedId));
      option.value = retainedId;
      append(select, option);
    }
    select.value = previous.get(dedupId) ?? "";
    append(row, select);
    append(region, row);
  }
}

export function renderClusterReview(
  detail: ClusterDetail,
  handlers: ClusterHandlers,
): HTMLElement {
  const section = view("CLUSTER_REVIEW", "Are these the same person?");
  section.setAttribute("data-cluster-id", detail.clusterId);

  const meta = el("div", "dd-meta");
  append(
    meta,
    el("span", `dd-badge dd-confidence-${detail.confidence.toLowerCase()}`, humanize(detail.confidence)),
    el("span", "dd-meta-score", `Score ${detail.score.toFixed(2)}`),
    el("span", "dd-meta-status", humanize(detail.status)),
  );
  append(section, meta);

  if (detail.warnings.length > 0) {
    const list = el("ul", "dd-warnings");
    for (const warning of detail.warnings) append(list, el("li", "dd-warning", humanize(warning)));
    append(section, list);
  }
  if (detail.oversized) {
    append(
      section,
      el(
        "p",
        "dd-warning",
        "This group is too large to delete from safely. Review it by hand in the sheet.",
      ),
    );
  }
  if (detail.staleReason !== "") {
    append(
      section,
      el(
        "p",
        "dd-warning",
        `The sheet changed since this group was found (${humanize(detail.staleReason)}). Rescan ` +
          "before deciding.",
      ),
    );
  }
  append(
    section,
    el(
      "p",
      "dd-message",
      detail.differingHeaders.length === 0
        ? "These records agree on every column shown."
        : `They differ on: ${detail.differingHeaders.join(", ")}`,
    ),
  );

  const records = el("div", "dd-records");
  for (const record of detail.records) append(records, recordCard(detail, record, handlers));
  append(section, records);

  const modes = el("fieldset", "dd-modes");
  append(modes, el("legend", "dd-filter-legend", "Your decision"));
  for (const [value, label, hint] of MODE_LABELS) {
    const choice = radio("mode", value, label, false);
    append(choice, el("span", "dd-choice-hint", hint));
    append(modes, choice);
  }
  append(section, modes);

  const targets = el("div", "dd-targets");
  targets.setAttribute("data-region", "targets");
  append(section, targets);

  if (detail.plan) append(section, planRegion(detail, detail.plan));

  const notes = el("textarea", "dd-notes");
  notes.setAttribute("data-field", "notes");
  notes.rows = 2;
  notes.value = detail.notes;
  const notesField = el("label", "dd-field");
  append(notesField, el("span", "dd-field-label", "Notes"), notes);
  append(section, notesField);

  const save = button("Save decision", "save", () => {
    const decision = readDecision(section, detail);
    if (decision) handlers.onSave(decision);
  });
  save.disabled = true;
  append(section, save);
  append(section, button("Back to queue", "back", handlers.onBack));

  const chosenTargets = new Map<string, string>();

  function refresh(): void {
    const mode = checkedMode(section);
    section.setAttribute("data-mode", mode ?? "");

    const selecting = mode === "SELECT_RECORDS";
    for (const input of retainInputs(section)) {
      input.disabled = !selecting;
      if (!selecting) input.checked = false;
      const wrapper = input.closest(".dd-retain");
      if (wrapper instanceof HTMLElement) wrapper.hidden = !selecting;
    }

    for (const select of Array.from(
      section.querySelectorAll<HTMLSelectElement>("[data-target-for]"),
    )) {
      const key = select.getAttribute("data-target-for");
      if (key) chosenTargets.set(key, select.value);
    }
    renderTargets(
      targets,
      detail,
      selecting ? checkedValues(section, "retain") : [],
      chosenTargets,
    );

    save.disabled = readDecision(section, detail) === null;
  }

  section.addEventListener("change", refresh);
  refresh();
  return section;
}
