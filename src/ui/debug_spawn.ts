import { button, closeGroup, h, scrollList, tabs, toast, type Panel } from '../ui2';
import type { UiContext } from './context';
import { openScreen } from './screen2';

// Debug spawn menu (Esc > Debug spawn, dev builds or ?debugmenu=1): put things next to you for
// testing. Everything goes through the same `cdda.*` helpers the test scripts use, so what you
// spawn here is what a scenario would get:
//   Quick     — a working car ahead of you (undamaged, full tanks and battery, unlocked; or
//               straight into its driver's seat), time of day, weather, god mode, clear zombies
//   Vehicles  — any vehicle prototype, in the same working state
//   Monsters / Items / NPCs — filter by name or id, Enter or double-click spawns
// The tactical pause holds while it is open; spawned things appear when you close it.

type Cdda = Record<string, any>;

function cdda(): Cdda {
  const c = (window as unknown as { cdda?: Cdda }).cdda;
  if (!c) throw new Error('debug spawn: window.cdda (the debug API) is not installed');
  return c;
}

interface Row {
  id: string;
  name: string;
}

/** Ahead of the player along the view direction (yaw: 0 = north, i.e. -y). */
function ahead(p: { x: number; y: number; yaw: number }, dist: number, side = 0): [number, number] {
  const fx = Math.sin(p.yaw), fy = -Math.cos(p.yaw);
  return [p.x + fx * dist - fy * side, p.y + fy * dist + fx * side];
}

/**
 * A vehicle in working order in front of the player, facing the way they look: undamaged
 * (BN init_state status 2: key in it, engine sound), every tank and battery full, unlocked.
 * Tries spots 5-14 m ahead and a lane either side; null when nothing fits there.
 */
export function spawnWorkingVehicle(protoId: string, enter: boolean): { uid: number; name: string } | null {
  const c = cdda();
  const vs = c.vehicleSystem;
  const p = c.game.player;
  const facing = ((Math.atan2(-Math.cos(p.yaw), Math.sin(p.yaw)) * 180) / Math.PI + 360) % 360;
  for (const dist of [6, 8, 10, 12, 14, 5])
    for (const side of [0, 3.5, -3.5]) {
      const [x, y] = ahead(p, dist, side);
      const v = vs.spawn(protoId, Math.floor(x), Math.floor(y), p.z, facing, { fuel: 100, status: 2 });
      if (!v) continue;
      v.locked = false;
      if (enter) c.enterVehicle(v.uid);
      return { uid: v.uid, name: v.name ?? protoId };
    }
  return null;
}

const TAB_IDS = ['quick', 'vehicles', 'monsters', 'items', 'npcs'] as const;
const TAB_LABEL: Record<(typeof TAB_IDS)[number], string> = { quick: 'Quick', vehicles: 'Vehicles', monsters: 'Monsters', items: 'Items', npcs: 'NPCs' };

export function openDebugSpawn(ctx: UiContext): Panel {
  const { game } = ctx;
  const c = cdda();
  const say = (text: string, ok = true) => {
    game.message(text, ok ? 'c_light_green' : 'c_light_red');
    toast({ title: text, category: ok ? 'info' : 'warning' });
  };

  const vehicleRows = (): Row[] =>
    Object.entries<{ name?: string }>(c.vehicleSystem.vdata.vehicles)
      .map(([id, v]) => ({ id, name: v.name ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  const monsterRows = (): Row[] =>
    Object.entries<{ name?: string | { str?: string } }>(game.data.monsters)
      .map(([id, m]) => ({ id, name: typeof m.name === 'string' ? m.name : m.name?.str ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  const itemRows = (): Row[] =>
    Object.entries<{ name?: string | { str?: string } }>(game.data.items)
      .map(([id, it]) => ({ id, name: typeof it.name === 'string' ? it.name : it.name?.str ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  const npcRows = (): Row[] => {
    const t = c.npcSystem?.nd?.templates ?? {};
    return Object.entries<{ name?: string }>(t).map(([id, n]) => ({ id, name: n.name ? `${n.name} (${id})` : id })).sort((a, b) => a.name.localeCompare(b.name));
  };

  const spawnVehicle = (id: string, enter: boolean) => {
    const r = spawnWorkingVehicle(id, enter);
    if (r) say(`${r.name} ${enter ? 'spawned, you are at the wheel' : 'spawned in front of you'}.`);
    else say(`No room for a ${id} in front of you (try facing open road).`, false);
  };
  const spawnMonster = (id: string, n = 1) => {
    const p = game.player;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const [x, y] = ahead(p, 6 + (i % 3) * 1.5, (Math.floor(i / 3) - 1) * 1.5);
      if (c.spawnMonster(id, x - p.x, y - p.y) !== null) k++;
    }
    say(k ? `Spawned ${k} ${id}.` : `Could not place ${id} in front of you.`, k > 0);
  };
  const spawnItem = (id: string) => {
    try {
      c.giveItem(id, {});
      say(`Gave you ${id}.`);
    } catch (e) {
      say(`${id}: ${(e as Error).message}`, false);
    }
  };
  const spawnNpc = (id: string) => {
    const p = game.player;
    const [x, y] = ahead(p, 3);
    const uid = c.spawnNpc(id, x - p.x, y - p.y);
    say(uid !== null ? `Spawned NPC ${id}.` : `Could not place NPC ${id}.`, uid !== null);
  };

  /** A filtered list tab: type to filter, ↑↓ to choose, Enter or double-click to spawn. */
  const listTab = (rows: () => Row[], spawn: (id: string) => void, extra?: HTMLElement[]) => {
    const all = rows();
    let sel = 0;
    const list = scrollList<Row>({
      items: all.slice(0, 300),
      render: (r) => h('div', { class: 'ui2-row' }, h('span', { text: r.name }), h('span', { class: 'ui2-dim ui2-small', text: ` ${r.id}` })),
      onActivate: (r) => spawn(r.id),
      onSelect: (r) => void (sel = Math.max(0, shown.indexOf(r))),
      empty: 'Nothing matches.',
    });
    let shown = all.slice(0, 300);
    const field = h('input', { class: 'ui2-num', attrs: { type: 'text', placeholder: `filter ${all.length}…`, 'data-testid': 'debug-filter' } });
    field.style.textAlign = 'left';
    field.style.width = '100%';
    field.addEventListener('input', () => {
      const q = field.value.trim().toLowerCase();
      shown = (q ? all.filter((r) => r.id.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) : all).slice(0, 300);
      list.setItems(shown);
      sel = 0;
      list.select(0);
    });
    field.addEventListener('keydown', (e) => {
      // typing belongs to the field; the list's cursor and Enter work from here too
      e.stopPropagation();
      if (e.key === 'Escape') return void panel.close();
      // Tab, or ←/→ while the filter is empty, moves between tabs
      if (e.key === 'Tab' || ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && field.value === '')) {
        e.preventDefault();
        return void step(e.shiftKey || e.key === 'ArrowLeft' ? -1 : 1);
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        list.select(sel + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const r = list.selected();
        if (r) spawn(r.id);
      }
    });
    list.el.style.maxHeight = 'calc(var(--icon) * 9)';
    list.el.style.overflowY = 'auto';
    const el = h('div', { class: 'dbg-tab' }, field, ...(extra ?? []), list.el);
    return { el, focus: () => setTimeout(() => field.focus(), 0) };
  };

  // ---- quick tab
  const row = (...els: HTMLElement[]) => h('div', { class: 'dbg-row' }, ...els);
  const label = (t: string) => h('div', { class: 'ui2-dim ui2-small', text: t });
  const quick = h(
    'div',
    { class: 'dbg-tab' },
    label('Vehicles (undamaged, full tanks and battery, unlocked)'),
    row(
      button('Working car', () => spawnVehicle('car', false), { key: 'c' }),
      // closes the Esc menu too: straight back into the game, at the wheel
      button('Car, get in', () => (spawnVehicle('car', true), closeGroup('scr.esc')), { key: 'C', tone: 'accent' }),
      button('Motorcycle', () => spawnVehicle('motorcycle', false)),
      button('Pickup', () => spawnVehicle('pickup', false)),
    ),
    label('Time and weather'),
    row(
      button('Dawn', () => c.setHour(6)),
      button('Noon', () => c.setHour(12), { key: 'n' }),
      button('Dusk', () => c.setHour(19.5)),
      button('Midnight', () => c.setHour(0), { key: 'm' }),
    ),
    row(
      button('Clear', () => c.setWeather('clear')),
      button('Rain', () => c.setWeather('rain')),
      button('Storm', () => c.setWeather('storm')),
      button('Snow', () => c.setWeather('snow')),
      button('Generated', () => c.setWeather(null)),
    ),
    label('You'),
    row(
      button('God mode on', () => (c.godMode(true), say('God mode on.')), { key: 'g' }),
      button('God mode off', () => (c.godMode(false), say('God mode off.'))),
      button('Kill zombies within 60 m', () => say(`Killed ${c.killAll(60) ?? 0}.`)),
    ),
  );

  const tabEls: Record<string, { el: HTMLElement; focus?: () => void }> = {
    quick: { el: quick },
    vehicles: listTab(vehicleRows, (id) => spawnVehicle(id, false)),
    monsters: listTab(monsterRows, (id) => spawnMonster(id)),
    items: listTab(itemRows, spawnItem),
    npcs: listTab(npcRows, spawnNpc),
  };
  const body = h('div', { class: 'dbg-body' });
  const show = (id: string) => {
    body.replaceChildren(tabEls[id].el);
    tabEls[id].focus?.();
  };
  const t = tabs(
    TAB_IDS.map((id) => ({ id, label: TAB_LABEL[id] })),
    'quick',
    show,
  );
  const panel = openScreen(game, {
    id: 'scr.debugspawn',
    title: 'Debug spawn',
    group: 'scr.esc',
    pauses: 'always',
    width: 'calc(var(--icon) * 16)',
    closeLabel: 'close',
    legend: [['←→ Tab', 'tab'], ['Enter', 'spawn']],
    onKey: (e) => {
      if (e.repeat) return false;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Tab') return step(e.key === 'ArrowLeft' || e.shiftKey ? -1 : 1), true;
      if (t.active !== 'quick') return false;
      // the quick tab's letters (the list tabs type into their filter instead)
      const btn = [...quick.querySelectorAll('button')].find((b) => b.querySelector('kbd')?.textContent === e.key);
      if (btn) return btn.click(), true;
      return false;
    },
  });
  panel.body.append(t.el, body);
  function step(d: number): void {
    const i = TAB_IDS.indexOf(t.active as (typeof TAB_IDS)[number]);
    t.set(TAB_IDS[(i + d + TAB_IDS.length) % TAB_IDS.length]);
  }
  show('quick');
  return panel;
}

/** The Esc menu shows the entry in dev builds, or with ?debugmenu=1. */
export function debugMenuEnabled(): boolean {
  return import.meta.env.DEV || new URLSearchParams(location.search).get('debugmenu') === '1';
}
