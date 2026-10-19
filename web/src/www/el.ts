type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> | null;

/**
 * Create an element. Text goes in as text nodes, never as HTML, so cluster data cannot inject
 * markup. Props: `class`, `on<event>` handlers, anything else as a property or attribute.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v as EventListener);
    else if (k in node) (node as unknown as Record<string, unknown>)[k] = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  node.append(...flat(children));
  return node;
}

function flat(children: Child[]): Array<Node | string> {
  return children.flatMap(c =>
    Array.isArray(c) ? flat(c) : c === null || c === undefined || c === false ? [] : [typeof c === 'number' ? String(c) : c]
  );
}
