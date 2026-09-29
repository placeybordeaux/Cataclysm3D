// Vehicle screens (replace the curses part menu, info window, controls menu and dashboard):
//
// - The vehicle panel: a top-down parts diagram (front up, BN's display z-order, each square
//   coloured by its part health), status (condition, speed, engine, lock/alarm), fuel and
//   battery gauges, the controls, and the square you examined with its parts and what you
//   can do there (open/close a door, open the cargo, take the controls, hotwire).
// - A cargo panel (your inventory ↔ the trunk, drag & drop through the moves API) used unless
//   the inventory screens provide one (`cargoPanel.open`).
// - The driving HUD, bottom right: speed against safe/top speed, cruise target, engine,
//   fuel and battery bars, lights, and the keys.

import type { Game } from '../game/game';
import { cargoVolume, has, MPH_PER_MS, type Vehicle, type VehiclePart } from '../game/vehicle';
import { L, isAt, moveItem } from '../game/moves';
import { verdict } from '../game/inventory_view';
import type { Item } from '../game/item';
import {
  attachTooltip, button, capacityBar, flashNote, fmtVolume, h, iconEl, itemTooltip, makeDraggable, openPanel, registerDropTarget, ui2Layers,
  type DragPayload, type Panel,
} from '../ui2';
import { centreFirstTime, chip, itemView, meter, section } from './common';
import { conditionWord, driveReadout, fuelGauges, healthTone, listOrder, partHealth, vehicleDiagram } from './logic/vehicle';
import { hotwire, takeControls } from '../ui/vehicle_ui';

/**
 * Hook for the inventory screens: open their cargo panel for a vehicle's CARGO part. When
 * unset, the vehicle panel opens its own simple one (openCargoPanel below).
 */
export const cargoPanel = { open: null as null | ((game: Game, v: Vehicle, part: VehiclePart) => void) };

export interface VehiclePanelHandle {
  panel: Panel;
  select(mx: number, my: number): void;
}

let current: { v: Vehicle; handle: VehiclePanelHandle } | null = null;

export function openVehiclePanel(game: Game, v: Vehicle, focus?: { mx: number; my: number }): VehiclePanelHandle {
  if (current && !current.handle.panel.closed) {
    if (current.v === v) {
      if (focus) current.handle.select(focus.mx, focus.my);
      current.handle.panel.front();
      return current.handle;
    }
    current.handle.panel.close();
  }
  const vs = game.vehicles!;
  let sel = focus ?? v.driverSeat() ?? { mx: 0, my: 0 };
  const panel = openPanel({
    id: 'vehicle',
    title: v.name,
    group: 'vehicle',
    pauses: true,
    width: 'min(calc(var(--fs) * 58), 95vw)',
    // Height follows the content (a bicycle is small), capped by the CSS max-height.
    footer: 'Click a square to inspect it · arrows move · Enter: its main action · Esc close',
    onKey,
    onClose: () => {
      clearInterval(timer);
      if (current?.v === v) current = null;
    },
  });
  panel.el.classList.add('ix-veh-win');
  centreFirstTime(panel);
  const diagram = h('div', { class: 'ix-veh-diagram', attrs: { 'data-testid': 'vehicle-diagram' } });
  const legend = h('div', { class: 'ix-veh-legend' }, chip('intact', 'good'), chip('worn', 'warn'), chip('damaged', 'bad'), chip('broken', 'dim'));
  const side = h('div', { class: 'ix-veh-side' });
  panel.body.append(h('div', { class: 'ix-veh' }, h('div', { class: 'ix-veh-left' }, h('div', { class: 'ix-veh-front', text: '▲ front' }), diagram, legend), side));
  panel.body.classList.add('ix-veh-body');
  // Fuel burns and doors swing while it's open (time may run): keep it current.
  const timer = setInterval(() => !panel.closed && draw(), 500);

  let actions: { label: string; run: () => void; disabled?: string }[] = [];

  function say(msg: string | null | undefined, color?: string): void {
    if (msg) game.message(msg, color);
  }

  function draw(): void {
    const d = vehicleDiagram(v);
    diagram.style.setProperty('--cols', String(d.cols));
    diagram.style.setProperty('--rows', String(d.rows));
    diagram.replaceChildren(
      ...d.cells.map((c) => {
        const cell = h(
          'button',
          {
            class: `ix-vcell tone-${c.tone}${c.mx === sel.mx && c.my === sel.my ? ' selected' : ''}${c.worst < 1 && c.tone === 'good' ? ' scuffed' : ''}`,
            style: { gridRow: String(c.row + 1), gridColumn: String(c.col + 1) },
            data: { mx: String(c.mx), my: String(c.my) },
          },
          h('span', { class: 'ix-vglyph', text: c.glyph }),
          c.flags.broken ? h('span', { class: 'ix-vmark bad', text: '!' }) : c.flags.cargo ? h('span', { class: 'ix-vmark', text: String(c.flags.cargo) }) : null,
        );
        attachTooltip(cell, () => listOrder(v.partsAt(c.mx, c.my)).map((p) => `${p.def.name}: ${p.hp <= 0 ? 'broken' : `${Math.round(partHealth(p) * 100)}%`}${has(p, 'OPENABLE') ? (p.open ? ' (open)' : ' (closed)') : ''}`).join('\n'));
        cell.addEventListener('click', () => select(c.mx, c.my));
        cell.addEventListener('dblclick', () => actions.find((a) => !a.disabled)?.run());
        return cell;
      }),
    );
    drawSide();
  }

  function drawSide(): void {
    const cond = conditionWord(v);
    const driving = vs.driving === v;
    const wasOn = v.engineOn;
    // Speeds with the engine running, the way BN's vehicle info reads them.
    v.engineOn = true;
    const safe = Math.round(v.maxVelocity(true) * MPH_PER_MS), top = Math.round(v.maxVelocity() * MPH_PER_MS);
    v.engineOn = wasOn;
    const status = h('div', { class: 'ix-veh-status' },
      chip(`${cond.word} (${cond.pct}%)`, cond.tone),
      v.engines.length ? chip(v.engineOn ? 'Engine running' : 'Engine off', v.engineOn ? 'good' : 'dim') : chip('No engine', 'dim'),
      v.locked ? chip('Locked', 'bad', 'The ignition is locked: hotwire it with a screwdriver') : null,
      v.alarmOn ? chip('Alarm!', 'bad') : null,
      !v.validWheelConfig() ? chip("Can't move: wheels", 'bad') : null,
      driving ? chip('You are driving', 'accent') : null,
    );
    const facts = h('div', { class: 'ix-veh-facts ui2-small' },
      h('span', { text: `${Math.round(v.mass())} kg` }),
      v.engines.length ? h('span', { text: `Safe ${safe} mph · top ${top} mph` }) : null,
      h('span', { text: `${v.parts.length} parts, ${v.parts.filter((p) => p.hp <= 0).length} broken` }));
    const gauges = fuelGauges(v).map((g) => meter(g.label, g.frac, g.text, g.tone));

    // Controls: what the driver's seat offers.
    const controls: HTMLElement[] = [];
    if (driving) {
      controls.push(
        button(v.engineOn ? 'Stop engine' : 'Start engine', () => (say(vs.toggleEngine(v).msg), draw()), { small: true, key: game.keys.keyFor('vehicle_engine'), disabled: v.locked && !v.engineOn ? 'Locked: hotwire it first' : undefined }),
        v.withFlag('CONE_LIGHT').length ? button(v.lightsOn ? 'Lights off' : 'Lights on', () => (say(vs.toggleHeadlights(v)), draw()), { small: true, key: game.keys.keyFor('vehicle_headlights') }) : h('span'),
        v.withFlag('HORN').length ? button('Horn', () => say(vs.honk(v)), { small: true, key: game.keys.keyFor('vehicle_horn') }) : h('span'),
        v.alarmOn && !v.locked ? button('Disable alarm', () => ((v.alarmOn = false), say('You disable the alarm.'), draw()), { small: true }) : h('span'),
        button(vs.driveMode === 'cruise' ? 'Mode: cruise control' : 'Mode: direct throttle', () => ((vs.driveMode = vs.driveMode === 'cruise' ? 'direct' : 'cruise'), draw()), { small: true, title: 'Cruise: W/S set a target speed. Direct: W accelerates while held.' }),
        button('Let go of the controls', () => (say(vs.releaseControls()), panel.close()), { small: true, tone: 'accent' }),
      );
    } else if (v.controls()) {
      const reach = vs.reachableControls() === v;
      controls.push(button('Take the controls', () => (takeControls(game, v), panel.close()), { small: true, tone: 'accent', key: game.keys.keyFor('control_vehicle'), disabled: reach ? undefined : 'Sit in the driver\'s seat first (walk into the vehicle)' }));
      if (v.locked) controls.push(button('Hotwire', () => (hotwire(game, v), panel.close()), { small: true, disabled: !reach ? 'Sit in the driver\'s seat first' : !game.player.inv.hasQuality('SCREW', 1) ? 'Need: a screwdriver (screw 1)' : undefined }));
    }

    // The selected square: its parts and what you can do there.
    const parts = listOrder(v.partsAt(sel.mx, sel.my));
    actions = [];
    const door = parts.find((p) => has(p, 'OPENABLE'));
    if (door) actions.push({ label: `${door.open ? 'Close' : 'Open'} the ${door.def.name}`, run: () => (say(vs.toggleDoor(v, sel.mx, sel.my)), draw()) });
    for (const cargo of parts.filter((p) => has(p, 'CARGO'))) {
      const covered = parts.some((p) => has(p, 'OPENABLE') && !p.open) && !has(cargo, 'CARGO_PASSABLE');
      actions.push({ label: `Open the ${cargo.def.name} (${cargo.items.length} item${cargo.items.length === 1 ? '' : 's'})`, run: () => (cargoPanel.open ?? openCargoPanel)(game, v, cargo), disabled: covered ? `The ${door?.def.name ?? 'lid'} is closed` : undefined });
    }
    const partRows = parts.map((p) => {
      const f = partHealth(p);
      const extra = p.fuelType && p.def.capacity ? ` · ${Math.round((100 * p.charges) / p.def.capacity)}% ${p.fuelType}` : has(p, 'CARGO') ? ` · ${fmtVolume(cargoVolume(p)[0])} / ${fmtVolume(cargoVolume(p)[1])}` : '';
      return meter(p.def.name + extra, f, p.hp <= 0 ? 'broken' : `${Math.round(f * 100)}%`, p.hp <= 0 ? 'dim' : healthTone(f), { cls: 'ix-part-row' });
    });
    const kids: (HTMLElement | null)[] = [
      status,
      facts,
      gauges.length ? section('Fuel & power') : null,
      ...gauges,
      controls.length ? section(driving ? 'Controls' : 'Driver\'s seat') : null,
      controls.length ? h('div', { class: 'ix-veh-controls' }, ...controls) : null,
      section(`Square ${sel.mx},${sel.my}${parts[0] ? `: ${parts.map((p) => p.def.name).slice(-1)[0]}` : ''}`),
      ...partRows,
      actions.length ? h('div', { class: 'ix-veh-actions', attrs: { 'data-testid': 'vehicle-actions' } }, ...actions.map((a, i) => button(a.label, a.run, { small: true, tone: i === 0 ? 'accent' : undefined, disabled: a.disabled, key: i === 0 ? 'Enter' : undefined }))) : null,
    ];
    side.replaceChildren(...kids.filter((x): x is HTMLElement => !!x));
  }

  function select(mx: number, my: number): void {
    if (!v.partsAt(mx, my).length) return;
    sel = { mx, my };
    draw();
  }

  function onKey(e: KeyboardEvent): boolean {
    // Front is up: ↑ is +x (forward), → is +y (the vehicle's right).
    const step: Record<string, [number, number]> = { ArrowUp: [1, 0], ArrowDown: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const s = step[e.key];
    if (s) {
      // Skip holes in odd shapes: keep going in that direction until a square has parts.
      const [x0, y0, x1, y1] = v.bounds();
      for (let k = 1; k < 16; k++) {
        const mx = sel.mx + s[0] * k, my = sel.my + s[1] * k;
        if (mx < x0 || mx > x1 || my < y0 || my > y1) break;
        if (v.partsAt(mx, my).length) return select(mx, my), true;
      }
      return true;
    }
    if (e.key === 'Enter') {
      const a = actions.find((x) => !x.disabled);
      if (a) a.run();
      return true;
    }
    if (e.key === game.keys.keyFor('control_vehicle') && vs.driving === v) return panel.close(), true;
    return false;
  }

  draw();
  const handle: VehiclePanelHandle = { panel, select };
  current = { v, handle };
  return handle;
}

// ------------------------------------------------------------------ cargo

/** Your inventory ↔ a cargo part. Every move is a moves-API move with the survivor as actor. */
export function openCargoPanel(game: Game, v: Vehicle, part: VehiclePart): Panel {
  const p = game.player;
  const cargoLoc = L.cargo(part, v);
  const invLoc = L.inv(p);
  const unregs: (() => void)[] = [];
  const panel = openPanel({
    id: 'vehicle.cargo',
    title: `${v.name}: ${part.def.name}`,
    group: 'vehicle',
    pauses: true,
    width: 'min(calc(var(--fs) * 46), 94vw)',
    height: 'min(76vh, calc(var(--fs) * 28))',
    footer: 'Drag between the lists · click moves the whole stack · wheel while dragging: amount · Esc close',
    onClose: () => unregs.forEach((u) => u()),
  });
  centreFirstTime(panel);
  const cap = capacityBar('Volume', fmtVolume);
  const cargoList = h('div', { class: 'ix-tlist', attrs: { 'data-testid': 'cargo-list' } });
  const invList = h('div', { class: 'ix-tlist', attrs: { 'data-testid': 'cargo-inv' } });
  panel.body.append(h('div', { class: 'ix-cargo' },
    h('div', { class: 'ix-tcol' }, h('div', { class: 'ix-zone-title', text: part.def.name }), cap.el, cargoList),
    h('div', { class: 'ix-tcol' }, h('div', { class: 'ix-zone-title', text: 'You carry' }), invList)));
  panel.body.classList.add('ix-trade-body');

  const move = (it: Item, from: typeof cargoLoc, to: typeof cargoLoc, count?: number): void => {
    if (!isAt(it, from)) return draw();
    // Taking out is a pick-up (BN: into the inventory, else into your hands); putting in is a move.
    const r = to.kind === 'inv' ? p.inv.pickUp(it, from, count) : moveItem(it, from, to, { count, actor: p });
    if (!r.ok) {
      const b = panel.el.getBoundingClientRect();
      flashNote(b.left + b.width / 2, b.top + 40, r.msg, 'bad');
    }
    draw();
  };
  const target = (el: HTMLElement, to: typeof cargoLoc, word: string) =>
    registerDropTarget({
      el, id: `cargo:${to.kind}`,
      check: (pl: DragPayload, n: number) => {
        const m = pl.meta as { item: Item; from: typeof cargoLoc };
        if (m.from.kind === to.kind) return { kind: 'noop' };
        const vd = verdict(p, m.item, m.from, to, m.item.countByCharges ? n : undefined);
        return vd.kind === 'ok' ? { kind: 'ok', count: n } : vd.kind === 'partial' ? { kind: 'partial', count: vd.count, reason: vd.reason ?? '' } : vd.kind === 'noop' ? { kind: 'noop' } : { kind: 'reject', reason: vd.reason };
      },
      drop: (pl: DragPayload, n: number) => {
        const m = pl.meta as { item: Item; from: typeof cargoLoc };
        move(m.item, m.from, to, m.item.countByCharges ? n : undefined);
      },
      label: () => word,
    });
  unregs.push(target(cargoList, cargoLoc, `Put in the ${part.def.name}`), target(invList, invLoc, 'Take'));

  function rows(items: readonly Item[], from: typeof cargoLoc): HTMLElement[] {
    if (!items.length) return [h('div', { class: 'ui2-empty', text: from.kind === 'cargo' ? 'Empty. Drag things here to store them.' : 'You carry nothing loose.' })];
    return items.map((it, i) => {
      const view = itemView(game, it, `${from.kind}:${i}`);
      const el = h('div', { class: 'ix-trow' }, iconEl(view.icon, 'row'), h('span', { class: 'ix-trow-name', text: it.name() }), h('span', { class: 'ui2-row-num', text: fmtVolume(it.volume()) }));
      makeDraggable(el, {
        payload: () => ({ item: view, count: view.count, from: `cargo:${from.kind}`, meta: { item: it, from } }),
        onClick: () => move(it, from, from.kind === 'cargo' ? invLoc : cargoLoc),
      });
      attachTooltip(el, () => itemTooltip(view, { where: from.kind === 'cargo' ? part.def.name : 'Carried', hints: ['Click: move all', 'Drag: move (wheel: amount)'] }));
      return el;
    });
  }

  function draw(): void {
    const [used, max] = cargoVolume(part);
    cap.set(used, max);
    cargoList.replaceChildren(...rows(part.items, cargoLoc));
    invList.replaceChildren(...rows(p.inv.carried(), invLoc));
  }
  draw();
  return panel;
}

// ------------------------------------------------------------------ driving HUD

/** The driving HUD in the ui2 HUD layer; call update() every frame (cheap when unchanged). */
export function driveHud(game: Game): { el: HTMLElement; update(): void } {
  const el = h('div', { class: 'ix-drivehud', attrs: { 'data-testid': 'drive-hud' } });
  el.style.display = 'none';
  ui2Layers().hud.appendChild(el);
  let last = '';
  const update = () => {
    const vs = game.vehicles;
    const v = game.player.dead ? null : vs?.driving ?? null;
    if (!v || !vs) {
      if (last !== '') (el.style.display = 'none'), (last = '');
      return;
    }
    const r = driveReadout(v, vs.driveMode === 'cruise');
    const gauges = fuelGauges(v);
    const key = JSON.stringify([v.uid, r, gauges.map((g) => [g.id, Math.round(g.frac * 40)]), v.engineOn, v.lightsOn, v.locked, v.validWheelConfig(), vs.driveMode]);
    if (key === last) return;
    last = key;
    el.style.display = '';
    // Speed bar: 0..top speed; the safe speed is a tick, the cruise target a marker above.
    const top = Math.max(r.topMph, r.safeMph, r.mph, 10);
    const pct = (mph: number) => `${Math.min(100, (mph / top) * 100)}%`;
    const k = (id: string) => game.keys.keyFor(id);
    const mv = game.keys.movementKeys();
    el.replaceChildren(
      h('div', { class: 'ix-dh-top' },
        h('span', { class: 'ix-dh-name', text: v.name }),
        v.engineOn ? chip('ENGINE', 'good') : v.locked ? chip('LOCKED', 'bad') : chip('ENGINE OFF', 'dim'),
        v.lightsOn ? chip('LIGHTS', 'warn') : null,
        !v.validWheelConfig() ? chip('WHEELS', 'bad') : null),
      h('div', { class: 'ix-dh-speed' },
        h('span', { class: `ix-dh-mph tone-${r.tone}`, text: `${r.reverse ? 'R ' : ''}${r.mph}` }),
        h('span', { class: 'ix-dh-unit', text: 'mph' }),
        r.cruiseMph !== null ? h('span', { class: 'ix-dh-cruise', text: `cruise ${r.cruiseMph}` }) : h('span', { class: 'ix-dh-cruise', text: 'direct throttle' })),
      h('div', { class: 'ix-dh-bar' },
        h('div', { class: `ix-dh-fill fill-${r.tone}`, style: { width: pct(r.mph) } }),
        r.safeMph ? h('div', { class: 'ix-dh-safe', style: { left: pct(r.safeMph) }, title: `safe ${r.safeMph} mph` }) : null,
        r.cruiseMph !== null ? h('div', { class: 'ix-dh-target', style: { left: pct(Math.abs(r.cruiseMph)) } }) : null),
      h('div', { class: 'ix-dh-scale ui2-dim' }, h('span', { text: '0' }), h('span', { text: `safe ${r.safeMph}` }), h('span', { text: `${r.topMph}` })),
      ...gauges.map((g) => meter(g.label, g.frac, `${Math.round(g.frac * 100)}%`, g.tone, { cls: 'ix-dh-gauge' })),
      h('div', { class: 'ix-dh-keys' },
        r.cruiseMph !== null ? `${mv[0]}/${mv[2]} ±4 mph · Space stop` : `${mv[0]} gas · ${mv[2]} brake`,
        ` · ${k('vehicle_engine')} engine · ${k('vehicle_headlights')} lights · ${k('vehicle_horn')} horn · ${k('control_vehicle')} vehicle`),
    );
  };
  return { el, update };
}
