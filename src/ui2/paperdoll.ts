// Paper doll: equipment slots arranged around a pixel figure, by body part. Each slot is a
// one-item location of the InventoryModel ('worn:head'…), so dragging onto it asks the model
// (wear rules, swap) and the slot lights green/red like any container.

import { h } from './dom';
import { registerDropTarget } from './dragdrop';
import { emptySlot, itemCell } from './itemcell';
import { paperDollLayout, type DollSlotPos } from './logic/layout';
import type { InventoryModel } from './model';
import { locationTarget, wireItemCell } from './containers';
import { palette } from './theme';

export interface DollSlot extends DollSlotPos {
  label: string;
  /** Model location of this slot. */
  loc: string;
  /** Ghost verb: "Wear", "Wield". */
  verb?: string;
}

export function paperDollView(model: InventoryModel, slots: DollSlot[]): { el: HTMLElement; destroy(): void } {
  // Validates ids (duplicates throw); the CSS places slots with calc() so they follow the scale.
  paperDollLayout(slots, 1, 0);
  const maxCol = Math.max(...slots.map((s) => s.col)), maxRow = Math.max(...slots.map((s) => s.row));
  const el = h('div', { class: 'ui2-doll' });
  // The furthest slot's offset plus one cell (slots sit at k·(cell+gap), k may be fractional).
  el.style.width = `calc(${maxCol} * (var(--cell) + var(--gap)) + var(--cell))`;
  el.style.height = `calc(${maxRow} * (var(--cell) + var(--gap)) + var(--cell))`;
  el.appendChild(figure());
  const wells = new Map<string, HTMLElement>();
  const unregs: (() => void)[] = [];
  for (const s of slots) {
    const w = h('div', { class: 'ui2-doll-slot', data: { slot: s.id } });
    w.style.left = `calc(${s.col} * (var(--cell) + var(--gap)))`;
    w.style.top = `calc(${s.row} * (var(--cell) + var(--gap)))`;
    el.appendChild(w);
    wells.set(s.id, w);
    unregs.push(registerDropTarget(locationTarget(model, s.loc, w, s.verb ?? 'Wear')));
  }
  let cellCleanups: (() => void)[] = [];
  const render = () => {
    for (const c of cellCleanups) c();
    cellCleanups = [];
    for (const s of slots) {
      const w = wells.get(s.id)!;
      const it = model.contents(s.loc)[0];
      if (!it) {
        w.replaceChildren(emptySlot(s.label));
        continue;
      }
      const cell = itemCell(it, 'grid');
      cell.appendChild(h('span', { class: 'ui2-slot-tag', text: s.label }));
      cellCleanups.push(wireItemCell(model, s.loc, it, cell));
      w.replaceChildren(cell);
    }
  };
  const off = model.onChange(render);
  render();
  return {
    el,
    destroy() {
      off();
      for (const u of unregs) u();
      for (const c of cellCleanups) c();
    },
  };
}

/** A faint 16×40 pixel survivor silhouette behind the slots (drawn, not a sprite, so it tints). */
function figure(): HTMLElement {
  const W = 16, H = 40;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = palette.bgRaised;
  const rect = (x: number, y: number, w: number, hh: number) => g.fillRect(x, y, w, hh);
  rect(6, 0, 4, 1); rect(5, 1, 6, 4); rect(6, 5, 4, 1); // head
  rect(7, 6, 2, 1); // neck
  rect(3, 7, 10, 2); rect(4, 9, 8, 10); // shoulders, torso
  rect(1, 8, 2, 11); rect(13, 8, 2, 11); // arms
  rect(1, 19, 2, 2); rect(13, 19, 2, 2); // hands
  rect(4, 19, 8, 2); // hips
  rect(4, 21, 3, 16); rect(9, 21, 3, 16); // legs
  rect(3, 37, 4, 2); rect(9, 37, 4, 2); // feet
  c.className = 'ui2-doll-figure';
  return c;
}
