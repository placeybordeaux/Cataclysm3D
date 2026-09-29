// Item lists for the BN inventory screens: a place's items as rows (optionally under category
// headers), containers expandable in place (▸ / ▾, with their fill bar), every row wired for
// the ui2 interaction rules (docs/UI2.md): drag, double-click = the obvious action, right-click
// = the item's actions with their time, Shift-click = quick move (inventory ↔ open loot
// source), Ctrl-click = move some (amount prompt), hover = tooltip with compare.
//
// Drops go through `bnTarget`: the model's verdict while hovering, a confirm before spilling
// a liquid, then the move — through `env.perform` so it takes its time when time is running.

import { h } from '../dom';
import { flashNote, makeDraggable, registerDropTarget, type DragPayload, type DropTarget } from '../dragdrop';
import { itemCell } from '../itemcell';
import { fmtVolume, type ItemView } from '../logic/items';
import { openContextMenu } from '../menu';
import { confirmModal, countPrompt } from '../modal';
import { overlayOpen } from '../host';
import { attachTooltip, itemTooltip } from '../tooltip';
import { defaultSplit } from '../logic/dnd';
import type { BnInventoryModel } from './model';

export interface ListEnv {
  model: BnInventoryModel;
  /** Run a move that takes `moves` BN moves (progress bar when time runs). */
  perform(label: string, moves: number, fn: () => void, anchor?: HTMLElement | null): void;
}

/** Containers the player opened (by item id), for this session: they stay open across refreshes. */
export const expanded = new Set<string>();

const rectCenter = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

/** Move with the spill confirm and the timed action, flashing the reason when it fails. */
export async function doMove(env: ListEnv, id: string, to: string, count: number, at: { x: number; y: number }, anchor?: HTMLElement | null): Promise<void> {
  const m = env.model;
  const ask = m.confirmFor(id, to, count);
  if (ask && !(await confirmModal({ title: 'Spill it?', body: ask, ok: 'Pour it out', danger: true }))) return;
  const label = `${m.dropLabel(id, to)}: ${m.entry(id)?.view.name ?? ''}`;
  env.perform(label, m.moveCost(id, to, count), () => {
    const r = m.move(id, to, count);
    if (!r.ok) flashNote(at.x, at.y, r.reason, 'bad');
  }, anchor);
}

/** Drop target for a model place (a list, a container row, a doll slot). */
export function bnTarget(env: ListEnv, loc: string, el: HTMLElement, verb?: string): DropTarget {
  return {
    el,
    id: loc,
    check: (p, n) => (p.from.startsWith('hotbar:') ? { kind: 'noop' } : env.model.check(p.item.id, loc, n)),
    drop: (p: DragPayload, n: number) => doMove(env, p.item.id, loc, n, rectCenter(el), el),
    label: (p) => verb ?? env.model.dropLabel(p.item.id, loc),
  };
}

/** Wire one item row / cell. Returns cleanup. */
export function wireItem(env: ListEnv, loc: string, it: ItemView, el: HTMLElement, onSelect?: () => void): () => void {
  const m = env.model;
  makeDraggable(el, {
    payload: () => ({ item: it, count: it.count, from: loc }),
    onClick: (e) => {
      if (e.shiftKey) {
        const to = m.quickMoveTarget(it, loc);
        if (!to) return flashNote(e.clientX, e.clientY, 'Nowhere to move it', 'warn');
        const v = m.check(it.id, to, it.count);
        if (v.kind === 'reject') return flashNote(e.clientX, e.clientY, v.reason, 'bad');
        if (v.kind === 'noop') return;
        if (v.kind === 'partial') flashNote(e.clientX, e.clientY, v.reason, 'warn');
        void doMove(env, it.id, to, 'count' in v ? v.count : it.count, { x: e.clientX, y: e.clientY }, el);
      } else if (e.ctrlKey || e.metaKey) {
        void moveSome(env, it, loc, { x: e.clientX, y: e.clientY }, el);
      } else onSelect?.();
    },
    onDoubleClick: () => m.use(it, loc),
    onContext: (e) => openContextMenu({ x: e.clientX, y: e.clientY }, m.actions(it, loc), { title: it.count > 1 ? `${it.name} ×${it.count}` : it.name }),
  });
  attachTooltip(el, () => {
    const cur = m.entry(it.id)?.view ?? it;
    const hints = ['Drag: move', 'Double-click: ' + (primaryLabel(env, cur, loc) ?? 'use'), 'Right-click: actions', m.onBody(loc) ? 'Shift-click: drop / to loot' : 'Shift-click: take', ...(cur.count > 1 ? ['Ctrl-click: some'] : [])];
    return itemTooltip(cur, { compare: m.compareWith(cur, loc), where: m.where(loc), hints });
  });
  const inside = m.insideOf(it);
  return inside ? registerDropTarget(bnTarget(env, inside, el)) : () => {};
}

function primaryLabel(env: ListEnv, it: ItemView, loc: string): string | null {
  const p = env.model.primary(it, loc);
  return p && 'label' in p ? p.label.toLowerCase() : null;
}

/** Ctrl-click: how many to move to the quick-move target. */
export async function moveSome(env: ListEnv, it: ItemView, loc: string, at: { x: number; y: number }, el?: HTMLElement): Promise<void> {
  const m = env.model;
  const to = m.quickMoveTarget(it, loc);
  if (!to) return flashNote(at.x, at.y, 'Nowhere to move it', 'warn');
  if (it.count < 2) return void doMove(env, it.id, to, 1, at, el);
  const n = await countPrompt({ title: m.onBody(loc) ? 'Drop how many?' : 'Take how many?', subtitle: `${it.name} → ${m.name(to)}`, max: it.count, initial: defaultSplit(it.count), icon: it.icon, ok: 'Move' });
  if (n) await doMove(env, it.id, to, n, at, el);
}

export interface ItemListOpts {
  /** Category headers (the carried inventory). */
  grouped?: boolean;
  empty?: string;
  /** Label for dropping on the list itself. */
  verb?: string;
}

export interface ItemList {
  el: HTMLElement;
  render(): void;
  destroy(): void;
}

/** A place's items as rows, containers expandable. The list itself is a drop target for `loc`. */
export function itemList(env: ListEnv, loc: string, o: ItemListOpts = {}): ItemList {
  const el = h('div', { class: 'ui2-container row bn-list', attrs: { tabindex: '0' } });
  const unreg = registerDropTarget(bnTarget(env, loc, el, o.verb));
  let cleanups: (() => void)[] = [];
  let rows: { it: ItemView; loc: string; el: HTMLElement }[] = [];
  let sel = -1;

  const render = () => {
    for (const c of cleanups.splice(0)) c();
    rows = [];
    let items: ItemView[];
    try {
      items = env.model.contents(loc);
    } catch {
      el.replaceChildren(h('div', { class: 'ui2-empty', text: '(gone)' }));
      return;
    }
    const out: HTMLElement[] = [];
    let lastCat = '';
    const add = (it: ItemView, at: string, depth: number) => {
      if (o.grouped && depth === 0 && it.category !== lastCat) {
        lastCat = it.category ?? '';
        out.push(h('div', { class: 'bn-cat', text: lastCat }));
      }
      const row = itemRow(env, it, at, depth);
      const i = rows.length;
      rows.push({ it, loc: at, el: row });
      cleanups.push(wireItem(env, at, it, row, () => select(i)));
      out.push(row);
      const inside = env.model.insideOf(it);
      if (inside && expanded.has(it.id)) {
        let kids: ItemView[] = [];
        try {
          kids = env.model.contents(inside);
        } catch {
          kids = [];
        }
        if (!kids.length) out.push(h('div', { class: 'bn-empty-inside', style: { paddingLeft: `calc(var(--u) * ${8 + depth * 8})` }, text: 'empty — drag things onto it' }));
        for (const k of kids) add(k, inside, depth + 1);
      }
    };
    for (const it of items) add(it, loc, 0);
    if (!out.length) out.push(h('div', { class: 'ui2-empty', text: o.empty ?? 'Empty — drag items here' }));
    el.replaceChildren(...out);
    if (sel >= rows.length) sel = rows.length - 1;
    if (sel >= 0) rows[sel].el.classList.add('selected');
  };
  const select = (i: number) => {
    sel = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach((r, j) => r.el.classList.toggle('selected', j === sel));
    rows[sel]?.el.scrollIntoView({ block: 'nearest' });
  };
  el.addEventListener('keydown', (e) => {
    if (!rows.length || overlayOpen()) return;
    const r = rows[Math.max(0, sel)];
    if (e.key === 'ArrowDown') select(sel + 1);
    else if (e.key === 'ArrowUp') select(sel - 1);
    else if (e.key === 'Enter' && r) env.model.use(r.it, r.loc);
    else if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && r) {
      const b = r.el.getBoundingClientRect();
      openContextMenu({ x: b.left + 40, y: b.bottom }, env.model.actions(r.it, r.loc), { title: r.it.name });
    } else if (e.key === 'ArrowRight' && r && env.model.insideOf(r.it)) {
      expanded.add(r.it.id);
      render();
    } else if (e.key === 'ArrowLeft' && r) {
      expanded.delete(r.it.id);
      render();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  const off = env.model.onChange(render);
  render();
  return {
    el,
    render,
    destroy() {
      off();
      unreg();
      for (const c of cleanups.splice(0)) c();
    },
  };
}

/** One row: expander, the ui2 row cell, and a fill bar for containers. */
export function itemRow(env: ListEnv, it: ItemView, loc: string, depth: number): HTMLElement {
  const cell = itemCell(it, 'row');
  cell.classList.add('bn-row');
  cell.style.paddingLeft = `calc(var(--u) * ${2 + depth * 8})`;
  const inside = env.model.insideOf(it);
  if (inside) {
    const open = expanded.has(it.id);
    const tw = h('button', { class: 'bn-twisty ui2-no-drag', text: open ? '▾' : '▸', title: open ? 'Close' : 'Open: show what is inside' });
    tw.addEventListener('pointerdown', (e) => e.stopPropagation());
    tw.addEventListener('click', (e) => {
      e.stopPropagation();
      if (expanded.has(it.id)) expanded.delete(it.id);
      else expanded.add(it.id);
      env.model.refresh(true);
    });
    cell.prepend(tw);
    const cap = env.model.capacity(inside);
    if (cap && cap.volume[1] > 0) {
      const f = Math.min(1, cap.volume[0] / cap.volume[1]);
      const bar = h('div', { class: `bn-fill${f >= 1 ? ' full' : ''}`, title: `${fmtVolume(cap.volume[0])} / ${fmtVolume(cap.volume[1])}` }, h('div', { style: { width: `${Math.round(f * 100)}%` } }));
      cell.querySelector('.ui2-row-main')?.appendChild(bar);
    }
  } else cell.prepend(h('span', { class: 'bn-twisty-space' }));
  return cell;
}
