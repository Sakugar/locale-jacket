// Tiny DOM helpers for the extension pages (no framework). Text is always set via
// textContent, so rule values and hostnames can never inject markup.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, ...children);
  return el;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function $(selector: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
}

export function toggleSwitch(checked: boolean, onChange: (v: boolean) => void, label: string): HTMLLabelElement {
  const input = h('input', { type: 'checkbox', 'aria-label': label });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch', title: label }, input, h('span'));
}

export function chip(text: string, kind: 'ok' | 'warn' | 'bad' | 'off' | 'accent'): HTMLSpanElement {
  return h('span', { class: `chip ${kind}` }, text);
}

/**
 * Run `render`, which rebuilds the contents of `root`, and put keyboard focus back on the
 * new element with the same `data-focus` key (if focus was on such an element inside `root`).
 */
export function preserveFocus(root: Element, render: () => void): void {
  const active = document.activeElement;
  const key = active instanceof HTMLElement && root.contains(active) ? active.dataset['focus'] : undefined;
  render();
  if (!key) return;
  const next = root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`);
  if (next && next !== document.activeElement) next.focus({ preventScroll: true });
}

/**
 * Keep the values typed into text fields (and selects) of `root` across a rebuild. Fields are
 * matched by `data-keep`; only fields the user changed since they were built are restored.
 */
export function preserveInputs(root: Element, render: () => void): void {
  const saved = new Map<string, string>();
  for (const el of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-keep]')) {
    if (el.dataset['dirty'] === '1') saved.set(el.dataset['keep']!, el.value);
  }
  preserveFocus(root, render);
  for (const el of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-keep]')) {
    const value = saved.get(el.dataset['keep']!);
    if (value === undefined || value === el.value) continue;
    if (el instanceof HTMLSelectElement && ![...el.options].some((o) => o.value === value)) continue;
    el.value = value;
    el.dataset['dirty'] = '1';
    // Let listeners (validation, enabling buttons) see the restored value.
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  }
}

/** Mark a field so preserveInputs() keeps what the user types into it. */
export function keep<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(el: T, key: string): T {
  el.dataset['keep'] = key;
  el.dataset['focus'] = key;
  const mark = () => (el.dataset['dirty'] = '1');
  el.addEventListener('input', mark);
  el.addEventListener('change', mark);
  return el;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
