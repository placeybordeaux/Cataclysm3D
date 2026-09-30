// Windows (panels): draggable by the title bar, closable, stacked (click brings to front),
// positions remembered per id in localStorage and kept on screen when the viewport shrinks.
// Windows can belong to a *group* (a screen made of several panels, e.g. the inventory:
// equipment + backpack + ground); the close key (Space, host.ts isCloseKey) or Esc closes the
// top window's whole group.

import { h, ui2Layers, viewport } from './dom';
import { acquireSurface, closeKeyLabel, isCloseKey, pushKeys } from './host';
import { iconEl } from './icons';
import { snapPx } from './theme';
import { clampRect, cascade } from './logic/layout';
import type { IconRef } from './logic/items';

export interface PanelOpts {
  /** Stable id: remembers the position ("inv.backpack"). Opening an open id focuses it. */
  id: string;
  title: string;
  icon?: IconRef;
  /** CSS sizes; use the metric vars so windows follow the UI scale, e.g. 'calc(var(--icon) * 6)'. */
  width?: string;
  height?: string;
  /** Initial position (px) when none is remembered; default: cascade from the top-left. */
  x?: number;
  y?: number;
  group?: string;
  /** Inventory-type: asks for the tactical pause while open (see host.ts settings); 'always' = a pause menu. */
  pauses?: boolean | 'always';
  closable?: boolean;
  /** Extra title-bar elements (buttons, a view toggle). */
  titleExtras?: HTMLElement[];
  footer?: HTMLElement | string;
  /** Keys while this is the top window; true = handled. Esc and the close key are handled after this. */
  onKey?: (e: KeyboardEvent) => boolean;
  /**
   * The close key (Space) closes this window (default). False where Space means something
   * inside it; Esc, Bksp and the opening key (screen2 / the owner's onKey) still close.
   */
  closeKey?: boolean;
  onClose?: () => void;
}

export interface Panel {
  readonly id: string;
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  readonly group?: string;
  setTitle(t: string): void;
  setFooter(f: HTMLElement | string | null): void;
  front(): void;
  /** Move (clamped to the viewport); `remember` stores it as the window's position. */
  moveTo(x: number, y: number, remember?: boolean): void;
  close(): void;
  readonly closed: boolean;
}

const POS_KEY = 'cdda3d.ui2.win';
const open: (Panel & { opts: PanelOpts })[] = [];
let positions: Record<string, { x: number; y: number }> = loadPositions();
let cascadeIndex = 0;
let removeKeys: (() => void) | null = null;

function loadPositions(): Record<string, { x: number; y: number }> {
  try {
    return JSON.parse(localStorage.getItem(POS_KEY) ?? '{}');
  } catch {
    return {};
  }
}
function savePositions(): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(positions));
  } catch {
    // not persisted
  }
}

/** Forget every remembered window position (showcase "reset layout"). */
export function resetWindowPositions(): void {
  positions = {};
  savePositions();
}

export function rememberedPosition(id: string): { x: number; y: number } | undefined {
  return positions[id];
}

export function openPanels(): readonly Panel[] {
  return open;
}

export function findPanel(id: string): Panel | undefined {
  return open.find((p) => p.id === id);
}

export function topPanel(): Panel | undefined {
  return open[open.length - 1];
}

/** Close every window of a group (or all windows). */
export function closeGroup(group?: string): void {
  for (const p of open.slice().reverse()) if (group === undefined || p.group === group) p.close();
}

export function openPanel(opts: PanelOpts): Panel {
  const existing = findPanel(opts.id);
  if (existing) {
    existing.front();
    return existing;
  }
  const L = ui2Layers();
  const titleText = h('span', { class: 'ui2-title-text', text: opts.title });
  const closeBtn = opts.closable === false ? null : h('button', { class: 'ui2-close', title: `Close (${closeKeyLabel() || 'Esc'})`, attrs: { 'aria-label': 'Close' } });
  const titlebar = h('div', { class: 'ui2-titlebar' }, opts.icon ? iconEl(opts.icon, 'row') : null, titleText, ...(opts.titleExtras ?? []), closeBtn);
  const body = h('div', { class: 'ui2-body' });
  const footer = h('div', { class: 'ui2-footer' });
  const el = h('div', { class: 'ui2-win', data: { id: opts.id } }, titlebar, body, footer);
  if (opts.width) el.style.width = opts.width;
  if (opts.height) el.style.height = opts.height;
  L.windows.appendChild(el);

  const setFooter = (f: HTMLElement | string | null) => {
    footer.replaceChildren(...(f === null ? [] : [f]));
    footer.style.display = f === null || f === '' ? 'none' : '';
  };
  setFooter(opts.footer ?? null);

  // Position: remembered > given > cascade. Clamped once laid out (size known).
  const view = viewport();
  const saved = positions[opts.id];
  const rect = el.getBoundingClientRect();
  const start = saved ?? (opts.x !== undefined && opts.y !== undefined ? { x: opts.x, y: opts.y } : cascade(cascadeIndex++, 24, { x: 40, y: 40 }, view, { w: rect.width, h: rect.height }));
  place(start.x, start.y);

  function place(x: number, y: number): void {
    const r = el.getBoundingClientRect();
    const c = clampRect({ x, y, w: r.width, h: r.height }, viewport());
    el.style.left = `${snapPx(c.x)}px`;
    el.style.top = `${snapPx(c.y)}px`;
  }

  let closed = false;
  const release = acquireSurface({ pauses: opts.pauses });
  const panel: Panel & { opts: PanelOpts } = {
    id: opts.id,
    el,
    body,
    group: opts.group,
    opts,
    setTitle: (t) => (titleText.textContent = t),
    setFooter,
    moveTo(x, y, remember = false) {
      place(x, y);
      if (remember) {
        positions[opts.id] = { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
        savePositions();
      }
    },
    front() {
      const i = open.indexOf(panel);
      if (i >= 0 && i !== open.length - 1) {
        open.splice(i, 1);
        open.push(panel);
      }
      markFront();
    },
    close() {
      if (closed) return;
      closed = true;
      const i = open.indexOf(panel);
      if (i >= 0) open.splice(i, 1);
      el.remove();
      ro.disconnect();
      markFront();
      if (!open.length && removeKeys) (removeKeys(), (removeKeys = null));
      opts.onClose?.();
      release();
    },
    get closed() {
      return closed;
    },
  };
  open.push(panel);
  markFront();
  if (!removeKeys) removeKeys = pushKeys(windowKeys);

  closeBtn?.addEventListener('click', () => panel.close());
  el.addEventListener('pointerdown', () => panel.front(), { capture: true });

  // Drag by the title bar (not its buttons).
  titlebar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, .ui2-no-drag')) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    titlebar.setPointerCapture(e.pointerId);
    el.classList.add('moving');
    const move = (ev: PointerEvent) => place(ev.clientX - dx, ev.clientY - dy);
    const up = () => {
      titlebar.removeEventListener('pointermove', move);
      titlebar.removeEventListener('pointerup', up);
      titlebar.removeEventListener('pointercancel', up);
      el.classList.remove('moving');
      positions[opts.id] = { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
      savePositions();
    };
    titlebar.addEventListener('pointermove', move);
    titlebar.addEventListener('pointerup', up);
    titlebar.addEventListener('pointercancel', up);
  });

  // Content growing (items added) or the viewport shrinking must not push the title bar off.
  const ro = new ResizeObserver(() => place(parseFloat(el.style.left), parseFloat(el.style.top)));
  ro.observe(el);
  return panel;
}

// Guarded: game modules that import ui2 are also loaded by headless unit tests (no DOM).
if (typeof window !== 'undefined') window.addEventListener('resize', () => {
  for (const p of open) {
    const r = p.el.getBoundingClientRect();
    const c = clampRect({ x: r.left, y: r.top, w: r.width, h: r.height }, viewport());
    p.el.style.left = `${c.x}px`;
    p.el.style.top = `${c.y}px`;
  }
});

function markFront(): void {
  // Stacking by z-index, not by moving elements: re-appending a window inside the pointerdown
  // that brings it forward makes Chrome drop that press's click (a button in a back window
  // needed two clicks).
  open.forEach((p, i) => {
    p.el.classList.toggle('front', i === open.length - 1);
    p.el.style.zIndex = String(i + 1);
  });
}

function windowKeys(e: KeyboardEvent): boolean {
  const top = open[open.length - 1];
  if (!top) return false;
  if (top.opts.onKey?.(e)) return true;
  if ((e.key === 'Escape' && !e.repeat) || (top.opts.closeKey !== false && isCloseKey(e))) {
    if (top.group) closeGroup(top.group);
    else top.close();
    return true;
  }
  return false;
}
