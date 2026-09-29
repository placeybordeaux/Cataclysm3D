// Context menus: right-click anything (item, slot, world object) for what you can do with it,
// with the time each action takes. Keyboard: ↑/↓ move, Enter/Space choose, → opens a
// submenu, ← / Esc go back, letters jump to their accelerator. Disabled entries stay visible
// with the reason ("Need: a cutting tool") — the player learns what's possible.

import { h, ui2Layers, viewport } from './dom';
import { acquireSurface, pushKeys } from './host';
import { iconEl } from './icons';
import { fmtDuration, type IconRef } from './logic/items';
import { placePopup, type Rect } from './logic/layout';
import { suppressTooltips } from './tooltip';

export type MenuItem =
  | {
      label: string;
      icon?: IconRef;
      /** Seconds of game time the action takes (shown right-aligned). */
      time?: number;
      /** Accelerator letter inside this menu ("E" for Eat); also shown. */
      key?: string;
      /** true, or the reason it can't be done now. */
      disabled?: boolean | string;
      /** Destructive (drop into fire, disassemble): red label. */
      danger?: boolean;
      /** The action left/double-click does: shown bold. */
      primary?: boolean;
      submenu?: MenuItem[] | (() => MenuItem[]);
      action?: () => void;
    }
  | { separator: true }
  | { header: string };

type Entry = Extract<MenuItem, { label: string }>;
const isEntry = (m: MenuItem): m is Entry => 'label' in m;

interface Level {
  el: HTMLElement;
  items: MenuItem[];
  rows: (HTMLElement | null)[];
  sel: number;
  child: Level | null;
  parent: Level | null;
}

let root: { level: Level; close: () => void } | null = null;

export function menuOpen(): boolean {
  return root !== null;
}

export function closeMenu(): void {
  root?.close();
}

/**
 * Open a context menu at a screen point. `title` shows as a header (the object's name).
 * Returns a close function. Only one context menu exists at a time.
 */
export function openContextMenu(at: { x: number; y: number }, items: MenuItem[], opts: { title?: string; onClose?: () => void } = {}): () => void {
  closeMenu();
  const release = acquireSurface();
  const unsuppress = suppressTooltips();
  const all = opts.title ? [{ header: opts.title } as MenuItem, ...items] : items;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    let l: Level | null = level;
    while (l) (l.el.remove(), (l = l.child));
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('blur', close);
    removeKeys();
    unsuppress();
    root = null;
    opts.onClose?.();
    release();
  };
  const level = buildLevel(all, null, { x: at.x, y: at.y, w: 0, h: 0 }, 'below', close);
  root = { level, close };
  const outside = (e: PointerEvent) => {
    if (!(e.target as Element).closest?.('.ui2-menu')) {
      close();
      // A right-click elsewhere reopens there (the owner's contextmenu handler runs next).
    }
  };
  // Next tick: the right-click that opened us is still propagating.
  setTimeout(() => !closed && document.addEventListener('pointerdown', outside, true), 0);
  window.addEventListener('blur', close);
  const removeKeys = pushKeys((e) => menuKey(e, close), { overlay: true });
  return close;
}

function deepest(): Level | null {
  let l = root?.level ?? null;
  while (l?.child) l = l.child;
  return l;
}

function menuKey(e: KeyboardEvent, close: () => void): boolean {
  const l = deepest();
  if (!l) return false;
  const move = (d: number) => {
    const n = l.items.length;
    for (let k = 1; k <= n; k++) {
      const i = (l.sel + d * k + n * 10) % n;
      if (isEntry(l.items[i])) return select(l, i);
    }
  };
  if (e.key === 'ArrowDown') move(1);
  else if (e.key === 'ArrowUp') move(-1);
  else if (e.key === 'ArrowRight') openSub(l, l.sel, true);
  else if (e.key === 'ArrowLeft' || e.key === 'Escape' || e.key === 'Backspace') {
    if (e.repeat) return true;
    if (l.parent) closeSub(l.parent);
    else close();
  } else if (e.key === 'Enter' || e.key === ' ') {
    if (!e.repeat) activate(l, l.sel, close);
  } else if (e.key.length === 1 && !e.repeat) {
    const i = l.items.findIndex((m) => isEntry(m) && m.key?.toLowerCase() === e.key.toLowerCase());
    if (i >= 0) activate(l, i, close);
  }
  // A menu is modal for the keyboard: nothing leaks to the window or the game behind it.
  return true;
}

function buildLevel(items: MenuItem[], parent: Level | null, anchor: Rect, side: 'below' | 'right', close: () => void): Level {
  const el = h('div', { class: 'ui2-menu', attrs: { role: 'menu' } });
  const level: Level = { el, items, rows: [], sel: -1, child: null, parent };
  items.forEach((m, i) => {
    if ('separator' in m) return (el.append(h('div', { class: 'ui2-menu-sep' })), level.rows.push(null));
    if ('header' in m) return (el.append(h('div', { class: 'ui2-menu-header', text: m.header })), level.rows.push(null));
    const reason = typeof m.disabled === 'string' ? m.disabled : null;
    const row = h(
      'div',
      { class: `ui2-menu-row${m.disabled ? ' disabled' : ''}${m.danger ? ' danger' : ''}${m.primary ? ' primary' : ''}`, attrs: { role: 'menuitem' } },
      m.icon ? iconEl(m.icon, 'row') : h('span', { class: 'ui2-menu-noicon' }),
      h('span', { class: 'ui2-menu-label' }, h('span', { text: m.label }), reason ? h('span', { class: 'ui2-menu-reason', text: reason }) : null),
      h('span', { class: 'ui2-menu-time', text: m.time !== undefined ? fmtDuration(m.time) : '' }),
      h('span', { class: 'ui2-menu-key', text: m.key ?? '' }),
      h('span', { class: 'ui2-menu-arrow', text: m.submenu ? '▸' : '' }),
    );
    let hoverTimer: ReturnType<typeof setTimeout> | 0 = 0;
    row.addEventListener('pointermove', (ev) => {
      if (ev.movementX === 0 && ev.movementY === 0) return;
      if (level.sel !== i) select(level, i);
      if (m.submenu && !level.child) {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => level.sel === i && openSub(level, i, false), 140);
      }
    });
    row.addEventListener('click', () => activate(level, i, close));
    row.addEventListener('contextmenu', (ev) => ev.preventDefault());
    el.append(row);
    level.rows.push(row);
  });
  ui2Layers().popups.appendChild(el);
  const r = el.getBoundingClientRect();
  const p = placePopup(anchor, { w: r.width, h: r.height }, viewport(), side);
  el.style.left = `${p.x}px`;
  el.style.top = `${p.y}px`;
  el.addEventListener('contextmenu', (ev) => ev.preventDefault());
  return level;
}

function select(l: Level, i: number): void {
  l.sel = i;
  l.rows.forEach((r, j) => r?.classList.toggle('sel', j === i));
  if (l.child && l.child !== null) closeSub(l);
}

function closeSub(l: Level): void {
  let c = l.child;
  while (c) (c.el.remove(), (c = c.child));
  l.child = null;
}

function openSub(l: Level, i: number, focusFirst: boolean): void {
  const m = l.items[i];
  if (!m || !isEntry(m) || !m.submenu || m.disabled) return;
  if (l.child) closeSub(l);
  const items = typeof m.submenu === 'function' ? m.submenu() : m.submenu;
  const row = l.rows[i]!;
  const rr = row.getBoundingClientRect();
  l.child = buildLevel(items, l, { x: rr.left, y: rr.top, w: rr.width, h: rr.height }, 'right', () => root?.close());
  if (focusFirst) {
    const first = items.findIndex(isEntry);
    if (first >= 0) select(l.child, first);
  }
}

function activate(l: Level, i: number, close: () => void): void {
  const m = l.items[i];
  if (!m || !isEntry(m)) return;
  if (m.submenu) return openSub(l, i, true);
  if (m.disabled) {
    const row = l.rows[i];
    row?.classList.remove('shake');
    void row?.offsetWidth;
    row?.classList.add('shake');
    return;
  }
  close();
  m.action?.();
}
