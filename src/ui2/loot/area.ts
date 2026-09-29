// Area loot (Project Zomboid / BN "AIM" style): one window listing everything within reach —
// the floor around you, every shelf and locker, bodies, an open trunk — merged and grouped by
// item type, with where each thing lies as small badges. "Take all" (smart: the best value per
// room first, never past your weight limit), "Take all of this type" (click a row), and
// category filters. It opens with one key and stays open while you walk (WASD; hold the right
// mouse button on the world to look around): the list follows you, so you sweep a room.

import type { Game } from '../../game/game';
import type { Item } from '../../game/item';
import { LOOT_CATEGORIES, LOOT_CATEGORY_NAMES, lootCategory, lootValue, type LootCategory, type LootMemory } from '../../game/loot';
import { h } from '../dom';
import { flashNote } from '../dragdrop';
import { iconEl } from '../icons';
import { fmtVolume, fmtWeight, type IconRef, type ItemView } from '../logic/items';
import { openContextMenu, type MenuItem } from '../menu';
import { toast } from '../toast';
import { attachTooltip, itemTooltip } from '../tooltip';
import { button, capacityBar } from '../widgets';
import { findPanel, openPanel } from '../window';
import type { BnInventoryModel, TakeAllResult } from '../bn/model';
import { summaryTitle } from './summary';

export const AREA_ID = 'loot.area';

export interface AreaGroup {
  typeId: string;
  name: string;
  count: number;
  /** grams / ml, all of it */
  weight: number;
  volume: number;
  icon: IconRef | undefined;
  category: LootCategory;
  value: number;
  /** Where it lies: a place key, its label, the item view there and how many. */
  sources: { key: string; label: string; id: string; count: number }[];
  view: ItemView;
}

/**
 * Everything within reach merged by item type, best category first, then by what it's worth.
 * `places` is the model's nearby list (ground tiles, furniture, cargo), minus the shop.
 */
export function areaGroups(model: BnInventoryModel, filter: LootCategory | null = null): AreaGroup[] {
  const by = new Map<string, AreaGroup>();
  for (const p of model.nearby()) {
    if (p.key === 'stock') continue;
    for (const v of model.contents(p.key)) {
      const it = model.itemOf(v.id);
      if (!it) continue;
      const cat = lootCategory(it);
      if (filter && cat !== filter) continue;
      let g = by.get(v.typeId);
      if (!g) by.set(v.typeId, (g = { typeId: v.typeId, name: v.name, count: 0, weight: 0, volume: 0, icon: v.icon, category: cat, value: 0, sources: [], view: v }));
      g.count += v.count;
      g.weight += v.weight * v.count;
      g.volume += v.volume * v.count;
      g.value += valueOf(model, v, it);
      g.sources.push({ key: p.key, label: p.label, id: v.id, count: v.count });
    }
  }
  for (const g of by.values()) if (g.sources.length > 1) g.name = pluralName(model, g);
  const rank = (c: LootCategory) => LOOT_CATEGORIES.indexOf(c);
  return [...by.values()].sort((a, b) => rank(a.category) - rank(b.category) || b.value - a.value || a.name.localeCompare(b.name));
}

function valueOf(model: BnInventoryModel, v: ItemView, it: Item): number {
  // Separate identical items shown as one view: the first one's value × how many.
  const e = model.entry(v.id);
  return e ? e.items.reduce((a, x) => a + lootValue(x), 0) : lootValue(it) * v.count;
}

function pluralName(model: BnInventoryModel, g: AreaGroup): string {
  const it = model.itemOf(g.sources[0].id);
  return it ? (it.countByCharges ? it.baseName(Math.max(1, g.count)) : it.name(g.count)) : g.name;
}

export interface AreaEnv {
  game: Game;
  model: BnInventoryModel;
  memory: () => LootMemory;
  /** Run a timed action (instant when the difficulty pauses in menus). */
  run(label: string, moves: number, fn: () => void): void;
  /** Keys (e.key) that take all / close the window: the player's own bindings. */
  keys: { takeAll: () => string[]; close: () => string[]; takeAllLabel: () => string; closeLabel: () => string };
  openInventory(focus?: string): void;
  canvas: HTMLElement;
  /** Tiles beyond the reach ring to include (the locker you pressed `e` on from a step away). */
  setExtra(tiles: { x: number; y: number; z: number }[]): void;
}

export function areaOpen(): boolean {
  return !!findPanel(AREA_ID);
}

let api: { focus(key: string | null): void } | null = null;

/** Open the area loot window (or bring it forward, highlighting `focus`'s items). */
export function openArea(env: AreaEnv, focus: string | null = null): void {
  if (areaOpen()) {
    api?.focus(focus);
    findPanel(AREA_ID)!.front();
    return;
  }
  const { game, model } = env;
  const t = focus && /^ground:(-?\d+),(-?\d+),(-?\d+)$/.exec(focus);
  env.setExtra(t ? [{ x: +t[1], y: +t[2], z: +t[3] }] : []);
  const origin = { x: game.player.tileX, y: game.player.tileY };
  let filter: LootCategory | null = null;
  let sel = 0;
  let groups: AreaGroup[] = [];
  let last: TakeAllResult | null = null;
  let hi: string | null = focus;
  const own: (() => void)[] = [];

  const summary = h('div', { class: 'ui2-small ui2-dim' });
  const chips = h('div', { class: 'la-chips' });
  const takeAll = button('Take all', () => doTakeAll(), { small: true, key: env.keys.takeAllLabel() });
  const invBtn = button('Inventory', () => env.openInventory(hi ?? undefined), { small: true, key: game.keys.label('inventory2') });
  const list = h('div', { class: 'la-list', attrs: { 'data-testid': 'area-list' } });
  const result = h('div', { class: 'la-result' });
  const vol = capacityBar('Volume', fmtVolume);
  const wt = capacityBar('Weight', fmtWeight);
  const foot = h('div', { class: 'la-foot' });
  foot.innerHTML = `<kbd>WASD</kbd> walk · hold <kbd>right mouse</kbd> on the world to look · click a row: take that kind · <kbd>${env.keys.takeAllLabel()}</kbd> take all · <kbd>${env.keys.closeLabel()}</kbd>/<kbd>Esc</kbd> close`;

  const vw = innerWidth;
  const p = openPanel({
    id: AREA_ID, title: 'Loot nearby', group: 'loot', pauses: false,
    width: 'min(calc(var(--fs) * 26 + var(--row-icon) * 2), 44vw)',
    x: Math.round(vw - Math.min(vw * 0.44, 560) - 24), y: Math.round(innerHeight * 0.08),
    onKey: (e) => onKey(e),
    onClose: () => {
      own.splice(0).forEach((f) => f());
      game.input.menuWalk = Math.max(0, game.input.menuWalk - 1);
      env.setExtra([]);
      api = null;
    },
  });
  p.body.append(h('div', { class: 'la' }, summary, chips, h('div', { class: 'la-actions' }, takeAll, invBtn), list, result, vol.el, wt.el, foot));
  game.input.menuWalk++;

  // --- sweeping: the list follows you; storage furniture listed within reach counts as searched
  const rebuild = () => {
    model.refresh();
    const mem = env.memory();
    const places = model.nearby().filter((q) => q.key !== 'stock');
    for (const q of places) {
      const l = q.loc;
      if (l.kind === 'ground' && q.fill) mem.mark(l.x, l.y, l.z, q.items.length);
    }
    // Walked away from the locker `e` added: back to what's in reach from here.
    const pl = game.player;
    if (Math.max(Math.abs(pl.tileX - origin.x), Math.abs(pl.tileY - origin.y)) > 0) env.setExtra([]);
    const all = areaGroups(model, null);
    const cats = new Map<LootCategory, number>();
    for (const g of all) cats.set(g.category, (cats.get(g.category) ?? 0) + 1);
    if (filter && !cats.has(filter)) filter = null;
    groups = filter ? all.filter((g) => g.category === filter) : all;
    sel = Math.max(0, Math.min(sel, groups.length - 1));
    const withItems = places.filter((q) => q.items.length).length;
    // A stack of 40 rounds is one thing to pick up; three cans of beans are three.
    const things = all.reduce((a, g) => a + g.sources.reduce((b, s) => b + (model.itemOf(s.id)?.countByCharges ? 1 : s.count), 0), 0);
    summary.textContent = all.length ? `${things} thing${things === 1 ? '' : 's'} in ${withItems} place${withItems === 1 ? '' : 's'} within reach` : '';
    chips.style.display = all.length ? '' : 'none';
    chips.replaceChildren(
      chip(`All ${all.length}`, filter === null, () => { filter = null; render(); }),
      ...LOOT_CATEGORIES.filter((c) => cats.has(c)).map((c) => chip(`${LOOT_CATEGORY_NAMES[c]} ${cats.get(c)}`, filter === c, () => { filter = c; sel = 0; render(); })),
    );
    takeAll.querySelector('span')!.textContent = filter ? `Take all ${LOOT_CATEGORY_NAMES[filter].toLowerCase()}` : 'Take all';
    takeAll.disabled = !groups.length;
    const t = model.view.totals;
    vol.set(t.volume[0], t.volume[1]);
    wt.set(t.weight[0], t.weight[1]);
    renderList();
  };
  const render = () => rebuild();
  let listSig = '';
  const renderList = () => {
    const sig = JSON.stringify([groups.map((g) => [g.typeId, g.count, g.sources.map((s) => s.key)]), sel, hi]);
    if (sig === listSig) return;
    listSig = sig;
    if (!groups.length) {
      list.replaceChildren(h('div', { class: 'la-empty', text: filter ? `No ${LOOT_CATEGORY_NAMES[filter].toLowerCase()} within reach.` : 'Nothing within reach. Walk up to shelves, lockers, piles and bodies: this list follows you.' }));
      return;
    }
    const rows: HTMLElement[] = [];
    let cat: LootCategory | null = null;
    groups.forEach((g, i) => {
      if (g.category !== cat && !filter) {
        cat = g.category;
        rows.push(h('div', { class: 'bn-cat', text: LOOT_CATEGORY_NAMES[cat] }));
      }
      const row = h('div', { class: `la-row${i === sel ? ' sel' : ''}`, attrs: { 'data-type': g.typeId, 'data-item': g.view.id } },
        iconEl(g.icon, 'row'),
        h('div', { class: 'la-main' },
          h('span', { class: 'la-name', text: g.name }),
          h('div', { class: 'la-src' }, ...g.sources.map((s) => h('span', { class: s.key === hi ? 'tone-accent' : '', text: `${s.label}${g.sources.length > 1 && s.count > 1 ? ` ×${s.count}` : ''}` })))),
        g.count > 1 ? h('span', { class: 'la-count', text: `×${g.count}` }) : null,
        h('span', { class: 'la-wt', text: fmtWeight(g.weight) }));
      row.addEventListener('click', (e) => {
        sel = i;
        takeGroup(g, { x: e.clientX, y: e.clientY });
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        sel = i;
        openContextMenu({ x: e.clientX, y: e.clientY }, groupMenu(g, { x: e.clientX, y: e.clientY }), { title: g.count > 1 ? `${g.name} ×${g.count}` : g.name });
      });
      attachTooltip(row, () => itemTooltip({ ...g.view, count: g.count }, { where: g.sources.map((s) => s.label).join(', '), hints: ['Click: take all of these', 'Right-click: take from one place, examine'] }));
      rows.push(row);
    });
    list.replaceChildren(...rows);
    list.querySelector('.la-row.sel')?.scrollIntoView({ block: 'nearest' });
  };

  const show = (r: TakeAllResult, at?: { x: number; y: number }) => {
    last = r;
    result.replaceChildren(
      h('div', { class: r.taken.length ? 'tone-good' : 'ui2-dim', text: summaryTitle(r) }),
      ...r.left.map((l) => h('div', { class: 'tone-warn', text: `Left ${l.count > 1 ? l.count + ' × ' : ''}${l.name}: ${l.reason}` })),
    );
    if (at && !r.taken.length && r.left.length) flashNote(at.x, at.y, r.left[0].reason, 'bad');
    rebuild();
  };
  const takeGroup = (g: AreaGroup, at?: { x: number; y: number }, only?: string) => {
    const keys = only ? [only] : g.sources.map((s) => s.key);
    const f = (it: Item) => it.typeId === g.typeId;
    env.run(`Taking ${g.name}`, model.takeCost(keys, f), () => show(model.take(keys, f), at));
  };
  const doTakeAll = () => {
    const keys = model.nearby().filter((q) => q.key !== 'stock' && q.items.length).map((q) => q.key);
    if (!keys.length) return;
    const cat = filter;
    const f = cat ? (it: Item) => lootCategory(it) === cat : undefined;
    env.run('Taking everything', model.takeCost(keys, f), () => {
      const r = model.take(keys, f);
      show(r);
      toast({ category: r.left.length ? 'warning' : 'info', title: summaryTitle(r).replace(/:$/, '.'), body: r.left.length ? r.left.map((l) => `${l.count > 1 ? l.count + ' ' : ''}${l.name}: ${l.reason}`).join(' · ') : undefined });
    });
  };
  const groupMenu = (g: AreaGroup, at: { x: number; y: number }): MenuItem[] => {
    const out: MenuItem[] = [{ label: g.sources.length > 1 ? `Take all ${g.count} (${g.sources.length} places)` : `Take${g.count > 1 ? ` all ${g.count}` : ''}`, key: 'T', primary: true, action: () => takeGroup(g, at) }];
    if (g.sources.length > 1) for (const s of g.sources) out.push({ label: `Take from ${s.label} (${s.count})`, action: () => takeGroup(g, at, s.key) });
    const first = g.sources[0];
    const acts = model.actions(model.entry(first.id)?.view ?? g.view, first.key).filter((m) => 'label' in m && /^(Take some|Examine|Wear|Wield|Eat|Drink)/.test(m.label));
    if (acts.length) out.push({ separator: true }, ...acts);
    return out;
  };
  const chip = (text: string, on: boolean, click: () => void) => h('button', { class: `la-chip${on ? ' on' : ''}`, text, on: { click } });

  const onKey = (e: KeyboardEvent): boolean => {
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      sel = Math.max(0, Math.min(groups.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
      renderList();
      return true;
    }
    if (e.key === 'Enter' && groups[sel]) {
      takeGroup(groups[sel]);
      return true;
    }
    if (e.repeat) return false;
    if (env.keys.takeAll().includes(e.key)) {
      doTakeAll();
      return true;
    }
    if (env.keys.close().includes(e.key)) {
      p.close();
      return true;
    }
    if (game.keys.keysFor('inventory2').includes(e.key) || game.keys.keysFor('inventory').includes(e.key)) {
      env.openInventory(hi ?? undefined);
      return true;
    }
    return false;
  };

  // --- looking around with the cursor free: hold the right mouse button on the world
  // The world's right-click menu is kept for a click that didn't drag: on Linux the browser
  // fires `contextmenu` on the button *press*, so it's held back here and replayed on release.
  let look: { moved: number; held?: boolean } | null = null;
  const replayed = new WeakSet<Event>();
  const down = (e: PointerEvent) => {
    if (e.button !== 2) return;
    look = { moved: 0 };
  };
  const move = (e: PointerEvent) => {
    if (!look) return;
    if (!(e.buttons & 2)) return void (look = null);
    const pl = game.player;
    look.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    pl.yaw += e.movementX * game.mouseSensitivity;
    pl.pitch = Math.max(-1.5, Math.min(1.5, pl.pitch - e.movementY * game.mouseSensitivity));
  };
  const up = (e: PointerEvent) => {
    if (e.button !== 2 || !look) return;
    const click = look.moved <= 3 && look.held;
    look = null;
    if (click) {
      // Unless the browser sends its own on release (Windows, macOS) right after this.
      pending = setTimeout(() => {
        const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, button: 2 });
        replayed.add(ev);
        env.canvas.dispatchEvent(ev);
      }, 40);
    }
  };
  let pending: ReturnType<typeof setTimeout> | undefined;
  const ctx = (e: MouseEvent) => {
    if (replayed.has(e) || e.target !== env.canvas) return;
    if (look) {
      // Pressed, not released yet (Linux): wait to see whether it's a drag.
      look.held = true;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    clearTimeout(pending);
  };
  env.canvas.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('contextmenu', ctx, true);
  own.push(() => {
    env.canvas.removeEventListener('pointerdown', down);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('contextmenu', ctx, true);
  });

  const poll = setInterval(rebuild, 250);
  own.push(() => clearInterval(poll));
  api = {
    focus(key) {
      hi = key;
      if (key) {
        const m = /^ground:(-?\d+),(-?\d+),(-?\d+)$/.exec(key);
        if (m) env.setExtra([{ x: +m[1], y: +m[2], z: +m[3] }]);
        const i = groups.findIndex((g) => g.sources.some((s) => s.key === key));
        if (i >= 0) sel = i;
      }
      listSig = '';
      rebuild();
    },
  };
  void last;
  rebuild();
  const first = groups.findIndex((g) => g.sources.some((s) => s.key === hi));
  if (first >= 0) {
    sel = first;
    listSig = '';
    renderList();
  }
}
