/** Just enough DOM to build components with, and no more.
 *
 * A value may be a signal. If it is, the one attribute or text node it feeds
 * is updated when it changes, rather than the element being rebuilt. That is
 * the whole point of the reactive core: the smallest possible thing changes.
 */
import { effect, type Signal } from "./reactive.js";

/** A value, a signal holding one, or a function returning one.
 *
 * The third form is what makes `disabled: () => selected().length === 0` work
 * without wrapping it in `computed`. It is unambiguous for the value types
 * components accept, none of which are themselves functions. */
export type Reactive<T> = T | Signal<T> | (() => T);

export const isSignal = <T>(v: Reactive<T>): v is Signal<T> =>
  typeof v === "function" && "peek" in (v as object);

export const read = <T>(v: Reactive<T>): T =>
  typeof v === "function" ? (v as () => T)() : v;

export interface Props {
  [key: string]: unknown;
}

export type Child = Node | string | number | null | undefined | false | Child[];

/** Create an element. Attributes starting with `on` are listeners. */
/** An id no other instance of the same component will mint.
 *
 * A component that hard-codes the id it points `aria-labelledby` at works
 * alone and stops working the moment a view holds two of them: the second
 * one's name resolves to the first one's heading, so it announces somebody
 * else's title while showing its own. A dashboard is many of everything, so
 * every id a component mints for its own use goes through here. */
let sequence = 0;
export const uid = (prefix: string): string => `${prefix}-${++sequence}`;

export function h(tag: string, props: Props = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;

    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      continue;
    }
    if (key === "text") {
      if (typeof value === "function") {
        effect(() => { el.textContent = String(read(value as Reactive<unknown>)); });
      } else {
        el.textContent = String(value);
      }
      continue;
    }
    if (key === "style" && typeof value === "object") {
      Object.assign(el.style, value as Partial<CSSStyleDeclaration>);
      continue;
    }
    if (typeof value === "function") {
      effect(() => setAttribute(el, key, read(value as Reactive<unknown>)));
      continue;
    }
    setAttribute(el, key, value);
  }

  append(el, children);
  return el;
}

function setAttribute(el: HTMLElement, key: string, value: unknown): void {
  const name = key === "className" ? "class" : key;
  if (value === false || value === null || value === undefined) {
    el.removeAttribute(name);
    return;
  }
  if (value === true) { el.setAttribute(name, ""); return; }
  el.setAttribute(name, String(value));
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children.flat(Infinity as 1) as Child[]) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Render a list that changes, replacing only when the list itself changes. */
export function list<T>(
  items: Reactive<readonly T[]>,
  render: (item: T, index: number) => Node,
): DocumentFragment {
  const anchor = document.createComment("list");
  const fragment = document.createDocumentFragment();
  fragment.appendChild(anchor);
  let rendered: Node[] = [];
  effect(() => {
    const next = read(items);
    const parent = anchor.parentNode;
    if (!parent) return;
    for (const node of rendered) node.parentNode?.removeChild(node);
    rendered = next.map((item, i) => render(item, i));
    for (const node of rendered) parent.insertBefore(node, anchor);
  });
  return fragment;
}
