// The inventory screen on the BN item model: three windows in one group.
//
//   Equipment — paper doll by body part (layers, encumbrance), what you wield, the worn list
//               (with holsters/sheaths openable), carried weight and volume bars.
//   Inventory — BN's flat carried inventory by category, containers expandable in place,
//               volume/weight bars with overflow.
//   Nearby    — one tab per place within reach (the ground under you and around, lockers,
//               fridges, a vehicle's trunk), each with its fill bar and "Take all".
//
// Everything is a drag & drop target; Shift-click moves between your inventory and the
// nearby tab that's open. Opened from `e` on a locker/corpse/trunk, the Nearby window starts
// on that place.

import { h, viewport } from '../dom';
import { registerDropTarget } from '../dragdrop';
import { arrangeRow } from '../logic/layout';
import { fmtVolume, fmtWeight } from '../logic/items';
import { capacityBar, button } from '../widgets';
import { closeGroup, findPanel, openPanel, rememberedPosition, type Panel } from '../window';
import { pushKeys, settings } from '../host';
import { toast } from '../toast';
import type { Hotbar } from '../hotbar';
import { doMove, itemList, type ItemList, type ListEnv } from './lists';
import { bnDoll } from './doll';
import type { TakeAllResult } from './model';
import './inventory.css';

export const BN_GROUP = 'inventory';

export interface ScreenOpts {
  /** Nearby place to show first ("ground:x,y,z", "cargo:0"). */
  focus?: string;
  /** Element that stands for the 3D world: dropping there drops at your feet. */
  worldEl?: HTMLElement;
  hotbar?: Hotbar;
  /** Keys that close the screen again (the game's inventory key). */
  closeKeys?: string[];
  onClose?(): void;
}

export function bnInventoryOpen(): boolean {
  return !!findPanel('inv.equip');
}

let activeSource: string | null = null;

export function openBnInventory(env: ListEnv, o: ScreenOpts = {}): void {
  const m = env.model;
  if (bnInventoryOpen()) {
    if (o.focus) focusSource(o.focus);
    findPanel('inv.equip')!.front();
    return;
  }
  m.refresh(true);
  const base = { group: BN_GROUP, pauses: true };
  const cleanups: (() => void)[] = [];
  const panels: Panel[] = [];

  // --- Equipment
  const doll = bnDoll(env);
  const hands = itemList(env, 'hands', { empty: 'Empty hands — drop a weapon or tool here' });
  hands.el.dataset.hands = '1';
  const worn = itemList(env, 'worn', { empty: 'Wearing nothing', verb: 'Wear' });
  const weight = capacityBar('Weight', fmtWeight);
  const vol = capacityBar('Volume', fmtVolume);
  const burden = h('div', { class: 'ui2-small' });
  const refreshBars = () => {
    const t = m.view.totals;
    weight.set(t.weight[0], t.weight[1]);
    vol.set(t.volume[0], t.volume[1]);
    const over = t.weight[0] > t.weight[1];
    burden.className = `ui2-small ${over ? 'tone-bad' : 'ui2-dim'}`;
    burden.textContent = over ? `Overburdened: ${fmtWeight(t.weight[0] - t.weight[1])} over — you move slower and tire fast.` : `Can carry ${fmtWeight(t.weight[1] - t.weight[0])} more before you slow down.`;
  };
  refreshBars();
  cleanups.push(m.onChange(refreshBars));
  const pauseNote = h('div', { class: 'ui2-dim ui2-small', text: settings.pauseInInventory ? '⏸ Time is paused while the inventory is open' : '▶ Time keeps running: actions take their time (Classic)' });
  const equip = openPanel({
    ...base,
    id: 'inv.equip',
    title: 'Equipment',
    // Wider on ultrawide screens (names stop truncating), the 1080p size as the floor.
    width: 'calc(var(--cell) * 3 + var(--gap) * 2 + var(--row-icon) + clamp(var(--fs) * 18, 22vw - var(--cell) * 3, var(--fs) * 26))',
    footer: pauseNote,
    onClose: () => {
      for (const c of cleanups.splice(0)) c();
      doll.destroy();
      worn.destroy();
      hands.destroy();
      closeGroup(BN_GROUP);
      o.onClose?.();
    },
  });
  equip.body.append(h('div', { class: 'bn-equip-top' }, doll.el, h('div', { class: 'bn-worn' }, h('div', { class: 'ui2-section', text: 'In your hands' }), hands.el, h('div', { class: 'ui2-section', text: 'Worn, innermost first' }), worn.el)), weight.el, vol.el, burden);
  panels.push(equip);

  // --- Inventory
  const inv = itemList(env, 'inv', { grouped: true, empty: 'Nothing carried. Pick things up by dragging them here.' });
  const invVol = capacityBar('Volume', fmtVolume);
  const invWt = capacityBar('Weight', fmtWeight);
  const refreshInv = () => {
    const t = m.view.totals;
    invVol.set(t.volume[0], t.volume[1]);
    invWt.set(t.weight[0], t.weight[1]);
  };
  refreshInv();
  cleanups.push(m.onChange(refreshInv));
  const storageNote = h('div', { class: 'ui2-dim ui2-small' });
  const refreshStorage = () => {
    const st = m.view.worn.filter((w) => w.storage).map((w) => w.node.name);
    storageNote.textContent = st.length ? `Room from: ${st.join(', ')}` : 'No bag or pockets: wear something with storage to carry more.';
  };
  refreshStorage();
  cleanups.push(m.onChange(refreshStorage));
  const invP = openPanel({ ...base, id: 'inv.carried', title: 'Inventory', width: 'calc(clamp(var(--fs) * 21, 18vw, var(--fs) * 30) + var(--row-icon) * 2)', onClose: () => inv.destroy() });
  invP.body.append(invVol.el, invWt.el, storageNote, inv.el);
  panels.push(invP);

  // --- Nearby
  panels.push(openNearby(env, o.focus ?? null));

  // Drop on the world = drop at your feet.
  if (o.worldEl) {
    const el = o.worldEl;
    const under = () => {
      const g = m.who.inv.groundHere();
      return g && g.kind === 'ground' ? `ground:${g.x},${g.y},${g.z}` : null;
    };
    cleanups.push(registerDropTarget({
      el,
      id: 'world',
      check: (p, n) => {
        const to = under();
        if (p.from.startsWith('hotbar:') || !to) return { kind: 'noop' };
        return m.check(p.item.id, to, n);
      },
      drop: (p, n) => {
        const to = under();
        if (to) void doMove(env, p.item.id, to, n, { x: innerWidth / 2, y: innerHeight / 2 });
      },
      label: (p) => (m.isLiquid(p.item.id) ? 'Spill on the ground' : 'Drop at your feet'),
    }));
  }
  // Screen keys: 1…0 hotbar, A take all, the inventory key closes (i opens and closes it).
  cleanups.push(pushKeys((e) => {
    if (o.hotbar?.handleKey(e)) return true;
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    if (e.key === 'a' || e.key === 'A') {
      nearbyApi?.takeAll();
      return true;
    }
    if (o.closeKeys?.includes(e.key) && !e.repeat) {
      closeGroup(BN_GROUP);
      return true;
    }
    return false;
  }));

  // Classic time: the world keeps changing under an open inventory (and a pause can be off).
  const poll = setInterval(() => m.refresh(), 400);
  cleanups.push(() => clearInterval(poll));

  // Any window without a remembered spot (first time, or one the player never moved): lay the
  // screen out as a row again rather than cascading the new one over the others.
  if (panels.some((p) => !rememberedPosition(p.id))) layoutPanels(panels);
  equip.front();
}

function layoutPanels(panels: Panel[]): void {
  const sizes = panels.map((p) => {
    const r = p.el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  const vp = viewport();
  // Sit in the upper part of the screen: the hotbar lives at the bottom.
  arrangeRow(sizes, { w: vp.w, h: vp.h * 0.86 }, 12, 12).forEach((pos, i) => panels[i].moveTo(pos.x, pos.y));
}

// ------------------------------------------------------------------ nearby

let nearbyApi: { focus(key: string): void; takeAll(): void } | null = null;

export function focusSource(key: string): void {
  nearbyApi?.focus(key);
}

function openNearby(env: ListEnv, focus: string | null): Panel {
  const m = env.model;
  const own: (() => void)[] = [];
  const p = openPanel({
    group: BN_GROUP, pauses: true, id: 'inv.nearby', title: 'Nearby',
    width: 'calc(clamp(var(--fs) * 21, 18vw, var(--fs) * 30) + var(--row-icon) * 2)',
    onClose: () => {
      own.splice(0).forEach((c) => c());
      nearbyApi = null;
      m.lootTarget = null;
    },
  });
  const tabBox = h('div', { class: 'bn-tabs' });
  const head = h('div', { class: 'bn-source-head' });
  const listBox = h('div', { class: 'bn-source-list' });
  const result = h('div', { class: 'bn-result' });
  p.body.append(tabBox, head, listBox, result);
  let list: ItemList | null = null;
  let tabKeys = '';
  const tabTargets: (() => void)[] = [];
  let last: TakeAllResult | null = null;

  const sources = () => {
    const near = m.nearby();
    const g = m.who.inv.groundHere();
    const underKey = g && g.kind === 'ground' ? `ground:${g.x},${g.y},${g.z}` : null;
    // The ground under you is always there: it's where things you drop go.
    const out = near.map((n) => ({ key: n.key, label: n.label, fill: n.fill, count: n.items.length }));
    if (underKey && !out.some((s) => s.key === underKey)) out.unshift({ key: underKey, label: 'under you', fill: null, count: 0 });
    return out;
  };
  // Opening without a focus: what's under you if anything, else where you looted last, else
  // the first place with something in it.
  let cur: string | null = focus;
  if (!cur) {
    const src = sources();
    const g = m.who.inv.groundHere();
    const under = g && g.kind === 'ground' ? src.find((s) => s.key === `ground:${g.x},${g.y},${g.z}` && s.count > 0) : undefined;
    cur = under?.key ?? src.find((s) => s.key === activeSource && s.count > 0)?.key ?? null;
  }

  const build = () => {
    const src = sources();
    if (!cur || !src.some((s) => s.key === cur)) cur = src.find((s) => s.count > 0)?.key ?? src[0]?.key ?? null;
    activeSource = cur;
    m.lootTarget = cur;
    const keys = `${cur}|` + src.map((s) => `${s.key}:${s.count}`).join('|');
    if (keys !== tabKeys) {
      tabKeys = keys;
      for (const u of tabTargets.splice(0)) u();
      // One button per place; each is also a drop target (drop on a tab = put it there).
      const strip = h('div', { class: 'ui2-tabs' });
      for (const sdef of src) {
        const key = sdef.key;
        const b = h('button', { class: `ui2-tab${key === cur ? ' on' : ''}`, on: { click: () => { if (key !== cur) { cur = key; last = null; build(); } } } },
          h('span', { text: cap(sdef.label) }), sdef.count ? h('span', { class: 'ui2-tab-badge', text: String(sdef.count) }) : null);
        tabTargets.push(registerDropTarget({ el: b, id: `tab:${key}`, check: (pl, n) => (pl.from.startsWith('hotbar:') ? { kind: 'noop' } : m.check(pl.item.id, key, n)), drop: (pl, n) => doMove(env, pl.item.id, key, n, { x: innerWidth / 2, y: innerHeight / 2 }), label: (pl) => m.dropLabel(pl.item.id, key) }));
        strip.appendChild(b);
      }
      tabBox.replaceChildren(src.length ? strip : h('div', { class: 'ui2-dim', text: 'Nothing within reach.' }));
    }
    if (!cur) {
      list?.destroy();
      list = null;
      head.replaceChildren();
      listBox.replaceChildren();
      return;
    }
    const s = src.find((x) => x.key === cur)!;
    const fill = capacityBar('Room', fmtVolume);
    if (s.fill) fill.set(s.fill.used, s.fill.max);
    const take = button('Take all', () => {
      if (!cur) return;
      last = m.takeAll(cur);
      showResult();
      toast({ category: last.left.length ? 'warning' : 'info', title: summaryTitle(last).replace(/:$/, '.'), body: last.left.length ? last.left.map((l) => `${l.count > 1 ? l.count + ' ' : ''}${l.name}: ${l.reason}`).join(' · ') : undefined });
    }, { small: true, disabled: s.count ? false : 'Nothing here', key: 'A' });
    head.replaceChildren(h('div', { class: 'bn-source-title' }, h('span', { text: `${cap(m.where(cur))}` }), take), s.fill ? fill.el : h('span'));
    if (!list || (list.el.dataset.loc !== cur)) {
      list?.destroy();
      list = itemList(env, cur, { empty: 'Nothing here — drag things here to put them down' });
      list.el.dataset.loc = cur;
      listBox.replaceChildren(list.el);
    }
    showResult();
  };
  const showResult = () => {
    if (!last) return void result.replaceChildren();
    const r = last;
    result.replaceChildren(
      h('div', { class: r.taken.length ? 'tone-good' : 'ui2-dim', text: summaryTitle(r) }),
      ...r.left.map((l) => h('div', { class: 'tone-warn ui2-small', text: `Left ${l.count > 1 ? l.count + ' × ' : ''}${l.name}: ${l.reason}` })),
    );
  };
  build();
  own.push(m.onChange(build));
  own.push(() => list?.destroy(), () => tabTargets.splice(0).forEach((u) => u()));
  nearbyApi = {
    takeAll: () => head.querySelector('button')?.click(),
    focus(key) {
      cur = key;
      last = null;
      tabKeys = '';
      build();
      p.front();
    },
  };
  return p;
}

function summaryTitle(r: TakeAllResult): string {
  const n = r.taken.reduce((a, t) => a + t.count, 0);
  if (!n) return r.left.length ? 'Nothing fit.' : 'Nothing to take.';
  const names = r.taken.map((t) => (t.count > 1 ? `${t.count} ${t.name}` : t.name));
  const list = names.length <= 4 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  return `Took ${list}.${r.left.length ? ` ${r.left.length} left behind:` : ''}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
