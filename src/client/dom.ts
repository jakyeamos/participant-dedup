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

export function button(label: string, action: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", "dd-button", label);
  node.type = "button";
  node.setAttribute("data-action", action);
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
  return append(section, el("h2", "dd-heading", heading));
}

/** A short human phrase for a SCREAMING_CASE code, so the UI reads as prose. */
export function humanize(code: string): string {
  const lower = code.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
