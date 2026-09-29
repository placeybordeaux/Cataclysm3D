// Tiny DOM helpers for ui2 (no framework: screens are small, and plain DOM keeps the bundle
// lean and Vite's hot reload instant). `h('div', {class: 'x', on: {click}}, child…)`.

type Child = Node | string | number | null | undefined | false;

export interface HProps {
  class?: string;
  style?: Partial<CSSStyleDeclaration> | Record<string, string>;
  text?: string;
  title?: string;
  html?: string;
  data?: Record<string, string>;
  attrs?: Record<string, string>;
  on?: { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: HProps | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = props.class;
    if (props.style) for (const [k, v] of Object.entries(props.style)) (el.style as unknown as Record<string, string>)[k] = v as string;
    if (props.text !== undefined) el.textContent = props.text;
    if (props.html !== undefined) el.innerHTML = props.html;
    if (props.title) el.title = props.title;
    if (props.data) for (const [k, v] of Object.entries(props.data)) el.dataset[k] = v;
    if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) el.setAttribute(k, v);
    if (props.on) for (const [k, f] of Object.entries(props.on)) el.addEventListener(k, f as EventListener);
  }
  append(el, ...children);
  return el;
}

export function append(el: HTMLElement, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- layers -----------------------------------------------------------------------------------

export interface Layers {
  root: HTMLElement;
  /** In-world overlays: progress bars, hover labels. */
  world: HTMLElement;
  /** HUD-level widgets: hotbar. */
  hud: HTMLElement;
  windows: HTMLElement;
  toasts: HTMLElement;
  /** Modal scrim + dialogs. */
  modal: HTMLElement;
  /** Context menus, tooltips. */
  popups: HTMLElement;
  /** The drag ghost, above everything. */
  drag: HTMLElement;
}

let layers: Layers | null = null;

/** The ui2 root (#ui2, above the legacy #ui) and its z-ordered layers. Created on first use. */
export function ui2Layers(): Layers {
  if (layers) return layers;
  const root = document.getElementById('ui2') ?? h('div', { attrs: { id: 'ui2' } });
  if (!root.isConnected) document.body.appendChild(root);
  const layer = (name: string) => root.appendChild(h('div', { class: `ui2-layer ui2-layer-${name}` }));
  layers = {
    root,
    world: layer('world'),
    hud: layer('hud'),
    windows: layer('windows'),
    toasts: layer('toasts'),
    modal: layer('modal'),
    popups: layer('popups'),
    drag: layer('drag'),
  };
  return layers;
}

export function viewport(): { w: number; h: number } {
  return { w: window.innerWidth, h: window.innerHeight };
}
