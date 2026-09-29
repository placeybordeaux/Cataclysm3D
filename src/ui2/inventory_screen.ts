// The placeholder main inventory (Tab in game, and the heart of ?debug=ui2): a *screen* made
// of several windows in one group — Equipment (paper doll + carried weight), Backpack,
// Pockets, Ground — over mock data. It exists to prove the toolkit and the interaction model;
// the inventory agent rebuilds it on the BN item model with the same pieces:
//   InventoryModel adapter → containerPanel / containerView / paperDollView → one group.

import { h, viewport } from './dom';
import { registerDropTarget, type DropTarget } from './dragdrop';
import { containerView, capacityBars, sectionLabel } from './containers';
import { fmtWeight } from './logic/items';
import { arrangeRow } from './logic/layout';
import { paperDollView } from './paperdoll';
import { capacityBar } from './widgets';
import { closeGroup, findPanel, openPanel, rememberedPosition, type Panel } from './window';
import { DOLL_SLOTS } from './mock/data';
import { MOCK_CARRY_LIMIT, type MockInventoryModel } from './mock/model';
import { insideOf } from './mock/store';
import { containerPanel } from './containers';
import type { Hotbar } from './hotbar';
import { pushKeys, settings } from './host';

export const INVENTORY_GROUP = 'inventory';

export interface InventoryScreenOpts {
  /** Element that stands for the 3D world: dropping there drops on the ground. */
  worldEl?: HTMLElement;
  hotbar?: Hotbar;
  /** Extra line in the Equipment footer (e.g. "UI2 PREVIEW — mock data"). */
  note?: string;
}

export function inventoryOpen(): boolean {
  return !!findPanel('inv.equip');
}

export function toggleInventoryScreen(model: MockInventoryModel, o: InventoryScreenOpts = {}): void {
  if (inventoryOpen()) closeGroup(INVENTORY_GROUP);
  else openInventoryScreen(model, o);
}

export function openInventoryScreen(model: MockInventoryModel, o: InventoryScreenOpts = {}): void {
  if (inventoryOpen()) return void findPanel('inv.equip')!.front();
  const cleanups: (() => void)[] = [];
  const base = { group: INVENTORY_GROUP, pauses: true };
  const panels: Panel[] = [];

  // --- Equipment: doll + carried weight
  const doll = paperDollView(model, DOLL_SLOTS.map((s) => ({ ...s, loc: model.kit.slot(s.id), verb: s.id === 'wield' ? 'Wield' : 'Wear' })));
  const carry = capacityBar('Carried', fmtWeight);
  const refreshCarry = () => carry.set(model.carried(), MOCK_CARRY_LIMIT);
  cleanups.push(model.onChange(refreshCarry));
  refreshCarry();
  const pauseNote = h('div', { class: 'ui2-dim ui2-small' });
  const refreshPause = () => (pauseNote.textContent = settings.pauseInInventory ? '⏸ Time is paused while the inventory is open' : '▶ Time keeps running (Classic)');
  refreshPause();
  const equip = openPanel({
    ...base,
    id: 'inv.equip',
    title: 'Equipment',
    footer: h('div', null, pauseNote, o.note ? h('div', { class: 'ui2-small tone-warn', text: o.note }) : null),
    onClose: () => {
      for (const c of cleanups.splice(0)) c();
      doll.destroy();
      o.hotbar?.unmount();
      // Closing the Equipment window closes the screen.
      closeGroup(INVENTORY_GROUP);
    },
  });
  equip.body.append(doll.el, carry.el);
  panels.push(equip);

  // --- Backpack (whatever is on the back slot)
  const back = model.contents(model.kit.slot('back'))[0];
  if (back?.capacity) panels.push(containerPanel(model, insideOf(back.id), { ...base, id: 'inv.back', title: back.name, icon: back.icon, width: 'calc(var(--cell) * 6 + var(--gap) * 5 + var(--u) * 18)', mode: 'grid' }));

  // --- Pockets: every other worn container, one section each
  const pockets = model.carriedContainers().filter((c) => c.id !== back?.id);
  if (pockets.length) {
    const own: (() => void)[] = [];
    const p = openPanel({ ...base, id: 'inv.pockets', title: 'Pockets', width: 'calc(var(--cell) * 4 + var(--gap) * 3 + var(--u) * 18)', onClose: () => own.splice(0).forEach((c) => c()) });
    for (const c of pockets) {
      const view = containerView(model, insideOf(c.id), { mode: 'grid', empty: 'Empty' });
      const caps = capacityBars(model, insideOf(c.id));
      own.push(model.onChange(caps.refresh), () => view.destroy());
      p.body.append(sectionLabel(c.name, c), caps.el, view.el);
    }
    panels.push(p);
  }

  // --- Ground
  panels.push(containerPanel(model, 'ground', { ...base, id: 'inv.ground', title: 'Ground', mode: window.innerHeight >= 800 ? 'row' : 'grid', width: 'calc(var(--fs) * 17 + var(--row-icon) * 2)' }));

  // Drop on the world = drop on the ground (at your feet for now).
  if (o.worldEl) {
    const t: DropTarget = {
      el: o.worldEl,
      id: 'world',
      check: (p, n) => (p.from.startsWith('hotbar:') ? { kind: 'noop' } : p.from === 'ground' ? { kind: 'noop' } : { kind: 'ok', count: n }),
      drop: (p, n, _v) => void model.dropToWorld(p.item.id, n),
      label: () => 'Drop on the ground',
    };
    cleanups.push(registerDropTarget(t));
  }
  if (o.hotbar) {
    o.hotbar.mount();
    // 1…0 use hotbar slots while the screen is open (above the windows' own keys).
    cleanups.push(pushKeys((e) => o.hotbar!.handleKey(e)));
  }

  // First time: lay the screen out as a centred row; afterwards everyone keeps their spot.
  const fresh = panels.filter((p) => !rememberedPosition(p.id));
  if (fresh.length === panels.length) {
    const sizes = panels.map((p) => {
      const r = p.el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    const m = 12;
    arrangeRow(sizes, viewport(), m, m).forEach((pos, i) => panels[i].moveTo(pos.x, pos.y));
  }
  equip.front();
}
