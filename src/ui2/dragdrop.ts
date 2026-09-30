// Drag & drop for items between any registered drop targets (container panels, equipment
// slots, the hotbar, the world). While dragging, the target under the pointer is asked for a
// DropVerdict every time the pointer or the amount changes, and both the target and the ghost
// show it: green = fits, amber = only part fits, red = no (with the reason on the ghost).
//
// Amount: the whole stack by default. Mouse wheel while dragging changes it (Ctrl = by 1);
// Shift at the start or the drop asks for an exact number. Esc or a right-click cancels.
// Releasing over nothing calls the source's onDropNowhere (hotbar: unbind) or snaps back.

import { h, ui2Layers } from './dom';
import { pushKeys } from './host';
import { iconEl } from './icons';
import { isAccepted, wheelCount, type DropVerdict } from './logic/dnd';
import type { ItemView } from './logic/items';
import { countPrompt } from './modal';
import { suppressTooltips } from './tooltip';

export interface DragPayload {
  item: ItemView;
  /** How many are being dragged (≤ item.count). */
  count: number;
  /** Id of the place it comes from (the source's drop-target id, e.g. 'in:k12', 'hotbar:3'). */
  from: string;
  /** Source-specific data (hotbar slot index…). */
  meta?: unknown;
}

export interface DropTarget {
  el: HTMLElement;
  id: string;
  check(p: DragPayload, count: number): DropVerdict;
  drop(p: DragPayload, count: number, verdict: DropVerdict): void | Promise<void>;
  /** What dropping here means, shown on the ghost: "Wear", "Put in backpack", "Drop". */
  label?(p: DragPayload): string;
}

export interface DraggableOpts {
  payload: () => DragPayload | null;
  /** A left click that didn't turn into a drag (modifiers on the event). */
  onClick?: (e: PointerEvent) => void;
  onDoubleClick?: (e: MouseEvent) => void;
  onContext?: (e: MouseEvent) => void;
  /** Released over no target. Default: nothing (the item stays where it was). */
  onDropNowhere?: (p: DragPayload, at: { x: number; y: number }) => void;
}

const targets = new WeakMap<Element, DropTarget>();
const DRAG_START_PX = 5;

export function registerDropTarget(t: DropTarget): () => void {
  targets.set(t.el, t);
  return () => {
    if (targets.get(t.el) === t) targets.delete(t.el);
  };
}

/** Innermost registered target at a screen point (a bag's cell inside a list beats the list). */
export function targetAt(x: number, y: number): DropTarget | null {
  for (const el of document.elementsFromPoint(x, y)) {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const t = targets.get(e);
      if (t) return t;
    }
  }
  return null;
}

interface DragState {
  payload: DragPayload;
  count: number;
  ghost: HTMLElement;
  countEl: HTMLElement;
  noteEl: HTMLElement;
  hover: DropTarget | null;
  verdict: DropVerdict | null;
  source: HTMLElement;
  opts: DraggableOpts;
  x: number;
  y: number;
  askCount: boolean;
  cleanup: () => void;
}

let drag: DragState | null = null;

export function dragging(): boolean {
  return drag !== null;
}

export function makeDraggable(el: HTMLElement, opts: DraggableOpts): void {
  el.classList.add('ui2-draggable');
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    const sx = e.clientX, sy = e.clientY;
    const shiftAtStart = e.shiftKey;
    let started = false;
    const move = (ev: PointerEvent) => {
      if (started) return;
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_START_PX) return;
      const p = opts.payload();
      if (!p) return;
      started = true;
      stop();
      beginDrag(p, el, opts, ev, shiftAtStart);
    };
    const up = (ev: PointerEvent) => {
      stop();
      if (!started && ev.button === 0) opts.onClick?.(ev);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  if (opts.onDoubleClick) el.addEventListener('dblclick', (e) => opts.onDoubleClick!(e));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!drag) opts.onContext?.(e);
  });
}

function beginDrag(payload: DragPayload, source: HTMLElement, opts: DraggableOpts, ev: PointerEvent, shiftAtStart: boolean): void {
  const countEl = h('span', { class: 'ui2-ghost-count' });
  const noteEl = h('div', { class: 'ui2-ghost-note' });
  const ghost = h('div', { class: 'ui2-ghost' }, h('div', { class: 'ui2-ghost-cell' }, iconEl(payload.item.icon, 'grid'), countEl), noteEl);
  ui2Layers().drag.appendChild(ghost);
  source.classList.add('drag-source');
  document.body.classList.add('ui2-dragging');
  const unsuppress = suppressTooltips();
  const move = (e: PointerEvent) => update(e.clientX, e.clientY);
  const up = (e: PointerEvent) => {
    if (e.button === 0) void finish(e.shiftKey);
  };
  const down = (e: PointerEvent) => {
    // Right (or middle) button while dragging = cancel, like most games.
    if (e.button !== 0) {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };
  const ctx = (e: MouseEvent) => e.preventDefault();
  const wheel = (e: WheelEvent) => {
    if (!drag || drag.payload.item.count < 2) return;
    e.preventDefault();
    drag.count = wheelCount(drag.count, drag.payload.item.count, e.deltaY < 0 ? 1 : -1, e.ctrlKey);
    refresh();
  };
  const removeKeys = pushKeys((e) => {
    if (e.key === 'Escape') cancel();
    // Everything else is swallowed: no window shortcuts mid-drag.
    return true;
  }, { overlay: true });
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('contextmenu', ctx, true);
  window.addEventListener('wheel', wheel, { passive: false, capture: true });
  window.addEventListener('blur', cancel);
  drag = {
    payload, count: payload.count, ghost, countEl, noteEl, hover: null, verdict: null, source, opts, x: ev.clientX, y: ev.clientY,
    askCount: shiftAtStart,
    cleanup() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('wheel', wheel, true);
      window.removeEventListener('blur', cancel);
      // The contextmenu event of a cancelling right-click comes after pointerdown: eat it too.
      setTimeout(() => window.removeEventListener('contextmenu', ctx, true), 300);
      removeKeys();
      unsuppress();
      setHover(null);
      source.classList.remove('drag-source');
      document.body.classList.remove('ui2-dragging');
      ghost.remove();
      drag = null;
    },
  };
  update(ev.clientX, ev.clientY);
}

function setHover(t: DropTarget | null): void {
  if (!drag) return;
  if (drag.hover && drag.hover !== t) drag.hover.el.classList.remove('drop-ok', 'drop-partial', 'drop-bad');
  drag.hover = t;
}

function update(x: number, y: number): void {
  if (!drag) return;
  drag.x = x;
  drag.y = y;
  drag.ghost.style.transform = `translate(${x}px, ${y}px)`;
  setHover(targetAt(x, y));
  refresh();
}

function refresh(): void {
  if (!drag) return;
  const d = drag;
  d.countEl.textContent = d.payload.item.count > 1 ? `${d.count}${d.count < d.payload.item.count ? `/${d.payload.item.count}` : ''}` : '';
  const t = d.hover;
  d.verdict = t ? t.check(d.payload, d.count) : null;
  const v = d.verdict;
  const cls = !v || v.kind === 'noop' ? '' : v.kind === 'reject' ? 'drop-bad' : v.kind === 'partial' ? 'drop-partial' : 'drop-ok';
  if (t) {
    t.el.classList.remove('drop-ok', 'drop-partial', 'drop-bad');
    if (cls) t.el.classList.add(cls);
  }
  d.ghost.dataset.state = cls.replace('drop-', '');
  let note = '';
  if (v?.kind === 'reject' || v?.kind === 'partial') note = v.reason;
  else if (v?.kind === 'swap') note = `${t?.label?.(d.payload) ?? 'Swap'} (${v.displaced.name} goes back)`;
  else if (v?.kind === 'ok') note = t?.label?.(d.payload) ?? '';
  else if (!t && d.opts.onDropNowhere) note = '';
  if (d.payload.item.count > 1 && !note && !t) note = 'Wheel: amount · Shift: exact';
  d.noteEl.textContent = note;
  d.noteEl.style.display = note ? '' : 'none';
}

async function finish(shiftAtDrop: boolean): Promise<void> {
  if (!drag) return;
  const d = drag;
  const t = d.hover;
  const at = { x: d.x, y: d.y };
  if (!t) {
    d.cleanup();
    d.opts.onDropNowhere?.(d.payload, at);
    return;
  }
  let count = d.count;
  let verdict = d.verdict ?? t.check(d.payload, count);
  if (verdict.kind === 'noop') return d.cleanup();
  if (!isAccepted(verdict)) {
    d.cleanup();
    shake(t.el);
    flashNote(at.x, at.y, verdict.kind === 'reject' ? verdict.reason : "Can't drop there", 'bad');
    return;
  }
  d.cleanup();
  if ((d.askCount || shiftAtDrop) && d.payload.item.count > 1) {
    const max = Math.min(d.payload.item.count, verdict.kind === 'partial' ? verdict.count : d.payload.item.count);
    const n = await countPrompt({ title: `Move how many?`, subtitle: d.payload.item.name, max, initial: Math.min(count, max), icon: d.payload.item.icon, ok: 'Move' });
    if (n === null) return;
    count = n;
    verdict = t.check(d.payload, count);
    if (!isAccepted(verdict)) {
      flashNote(at.x, at.y, verdict.kind === 'reject' ? verdict.reason : 'Nothing to do', 'bad');
      return;
    }
  }
  if (verdict.kind === 'partial') flashNote(at.x, at.y, verdict.reason, 'warn');
  await t.drop({ ...d.payload, count }, verdict.count, verdict);
}

function cancel(): void {
  drag?.cleanup();
}

/** Brief floating text at a point: why a drop failed, "Only 3 fit", "Bound to 4". */
export function flashNote(x: number, y: number, text: string, tone: 'bad' | 'warn' | 'good' | 'info' = 'info'): void {
  const el = h('div', { class: `ui2-flash tone-${tone}`, text });
  el.style.left = `${Math.max(8, Math.min(innerWidth - 8, x))}px`;
  el.style.top = `${y}px`;
  // Long messages (the fire-safety warning) need reading time: ~1.6 s plus 45 ms a character.
  const ms = Math.min(7000, Math.max(1600, 1600 + (text.length - 40) * 45));
  el.style.animationDuration = `${ms}ms`;
  ui2Layers().drag.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function shake(el: HTMLElement): void {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
}
