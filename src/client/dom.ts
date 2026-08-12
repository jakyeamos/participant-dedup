/**
 * §21.8 The client's only way to build DOM. Every helper here writes text
 * through `textContent`, and no module in `src/client` uses `innerHTML`,
 * `insertAdjacentHTML`, or `document.write` — a participant value is untrusted
 * text typed into a spreadsheet by anyone with edit access, and Phase G's static
 * gate fails the build if one of those names appears.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined && className !== "") node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function append<T extends Node>(parent: T, ...children: Node[]): T {
  for (const child of children) parent.appendChild(child);
  return parent;
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Stable task identities consumed by browser-semantic automation. These are
 * attached to the real controls and views below, so a task ID is present only
 * while its actionable surface is present.
 */
export const MAC_CONTROL_ACTION_TARGETS: Readonly<Record<string, string>> = {
  "start-scan": "participant-dedup.menu.scan",
  apply: "participant-dedup.queue.apply",
};

export const MAC_CONTROL_VIEW_TARGETS: Readonly<Record<string, string>> = {
  QUEUE: "participant-dedup.queue.review",
  QUEUE_FILTERS: "participant-dedup.queue.filters",
  AUDIT_HISTORY: "participant-dedup.history",
};

/** A machine-readable postcondition shared by the task target and sidebar root. */
export function setTaskState(node: HTMLElement, state: string): HTMLElement {
  node.setAttribute("data-task-state", state);
  return node;
}

export function button(label: string, action: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", "dd-button", label);
  node.type = "button";
  node.setAttribute("data-action", action);
  const macControlId = MAC_CONTROL_ACTION_TARGETS[action];
  if (macControlId) node.setAttribute("data-mac-control-id", macControlId);
  node.addEventListener("click", onClick);
  return node;
}

/**
 * A labelled numeric readout. The `data-stat` attribute is what the tests and
 * the CSS both key on, so the number stays addressable without a class name
 * doing double duty.
 */
export function stat(name: string, label: string, value: string | number): HTMLElement {
  const row = el("div", "dd-stat");
  append(row, el("span", "dd-stat-label", label));
  const figure = el("span", "dd-stat-value", String(value));
  figure.setAttribute("data-stat", name);
  return append(row, figure);
}

function boxed(
  type: "checkbox" | "radio",
  name: string,
  value: string,
  labelText: string,
  checked: boolean,
): HTMLLabelElement {
  const wrapper = el("label", "dd-choice");
  const input = el("input");
  input.type = type;
  input.name = name;
  input.value = value;
  input.checked = checked;
  return append(wrapper, input, el("span", "dd-choice-label", labelText));
}

export function checkbox(
  name: string,
  value: string,
  labelText: string,
  checked: boolean,
): HTMLLabelElement {
  return boxed("checkbox", name, value, labelText, checked);
}

export function radio(
  name: string,
  value: string,
  labelText: string,
  checked: boolean,
): HTMLLabelElement {
  return boxed("radio", name, value, labelText, checked);
}

export function checkedValues(root: ParentNode, name: string): string[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)).map(
    (input) => input.value,
  );
}

/** A screen with a heading, used by every view so they all frame the same way. */
export function view(name: string, heading: string): HTMLElement {
  const section = el("section", "dd-view");
  section.setAttribute("data-view", name);
  const headingNode = el("h2", "dd-heading", heading);
  const headingId = `view-${name.toLowerCase().replace(/_/g, "-")}-heading`;
  headingNode.id = headingId;
  section.setAttribute("role", "region");
  section.setAttribute("aria-labelledby", headingId);
  const macControlId = MAC_CONTROL_VIEW_TARGETS[name];
  if (macControlId) section.setAttribute("data-mac-control-id", macControlId);
  return append(section, headingNode);
}

/** A short human phrase for a SCREAMING_CASE code, so the UI reads as prose. */
export function humanize(code: string): string {
  const lower = code.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
