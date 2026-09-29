import * as THREE from 'three';
import type { DebugApi } from '../debug';
import type { Game } from '../game/game';
import type { Item } from '../game/item';
import { has, MPH_PER_MS, type Vehicle, type VehiclePart } from '../game/vehicle';
import { loadVehicleData } from '../game/vehicle_data';
import { composeCreatureHooks, monsterCreatureHooks, npcCreatureHooks, registerVehicleSave, VehicleSystem, type DriveMode } from '../game/vehicles';
import { registerOption } from './options';
import type { MonsterSystem } from '../game/monai';
import { interactOverrides } from '../game/interact';
import type { Renderer } from '../render/renderer';
import { VehicleRenderer } from '../render/vehicleMesh';
import { LEVEL_HEIGHT } from '../world/coords';
import type { UiContext } from './context';
import { c, cssColor, getUiRoot, openMenu, openWindow, type MenuEntry } from './framework';
import { hud } from './hud';
import { carriedEntries, openMultiSelect, stackEntries, type InvEntry, type MultiRow } from './inventory_ui';
import { isAt, L, moveItem } from '../game/moves';

// Vehicle UI: examining parts (doors, cargo, controls, hotwiring), the '^' controls menu,
// driving keys, a CDDA-style dashboard line while driving, and window.cdda helpers.
//
// Keys (src/ui/keys.ts): '^' take controls / controls menu, 'k' engine, 'h' headlights,
// 'n' horn; WASD drive (direct throttle, the default: W accelerate, release to coast, S
// brake/reverse, 'c' cruise control locks the speed; CDDA cruise option: W/S step the target
// speed), A/D steer, Space handbrake.
// 'e' on a vehicle part: examineVehicle() — the world-interaction handler for 'e' should
// call it first (it returns false when the crosshair isn't on a vehicle).

export interface VehicleTarget {
  v: Vehicle;
  mx: number;
  my: number;
  x: number;
  y: number;
  z: number;
}

let rendererRef: Renderer | null = null;

/** Vehicle part under the crosshair within reach (~2 m), or the tile ahead in top-down view. */
export function targetVehicle(game: Game, renderer: Renderer | null = rendererRef): VehicleTarget | null {
  const vs = game.vehicles;
  if (!vs) return null;
  const p = game.player;
  const base = p.z * LEVEL_HEIGHT;
  const hit = (x: number, y: number, h: number): VehicleTarget | null => {
    const tx = Math.floor(x), ty = Math.floor(y);
    const o = vs.at(tx, ty, p.z);
    if (!o || h < base + 0.1 || h > base + 2.0) return null;
    return { v: o.v, mx: o.mx, my: o.my, x: tx, y: ty, z: p.z };
  };
  if (!renderer || renderer.cameraMode === 'top') {
    // Top-down: the tile in front of you (like CDDA's direction prompt), else your own.
    const fx = p.x + Math.sin(p.yaw) * 0.9, fy = p.y - Math.cos(p.yaw) * 0.9;
    return hit(fx, fy, base + 1) ?? hit(p.x, p.y, base + 1);
  }
  const cam = renderer.camera;
  const dir = cam.getWorldDirection(tmpDir);
  const o = cam.position;
  for (let t = 0.05; t < 6; t += 0.05) {
    const x = o.x + dir.x * t, h = o.y + dir.y * t, y = o.z + dir.z * t;
    if (Math.hypot(x - p.x, y - p.y) > 2.3) break;
    const r = hit(x, y, h);
    if (r) return r;
    // Walls/furniture that aren't vehicles stop the ray.
    const tx = Math.floor(x), ty = Math.floor(y);
    if (!vs.at(tx, ty, p.z) && game.map.opaque(tx, ty, p.z) && !(tx === p.tileX && ty === p.tileY)) break;
    if (h < base) break;
  }
  return null;
}
const tmpDir = new THREE.Vector3();

const hpColor = (p: VehiclePart) => {
  if (p.hp <= 0) return 'c_dark_gray';
  const f = p.hp / p.def.durability;
  return f >= 0.8 ? 'c_light_green' : f >= 0.5 ? 'c_yellow' : f >= 0.25 ? 'c_light_red' : 'c_red';
};

function partLine(p: VehiclePart): string {
  const extra: string[] = [];
  if (p.fuelType && p.def.capacity) extra.push(`${Math.round((100 * p.charges) / p.def.capacity)}% ${p.fuelType}`);
  if (has(p, 'OPENABLE')) extra.push(p.open ? 'open' : 'closed');
  if (p.items.length) extra.push(`${p.items.length} items`);
  const name = p.hp <= 0 ? `${p.def.name} (broken)` : p.def.name;
  return `${c(hpColor(p), name)}${extra.length ? c('c_light_gray', ` (${extra.join(', ')})`) : ''}`;
}

/**
 * Height of the vehicle column in a tile for crosshair raycasts: bodywork (OBSTACLE / ROOF
 * parts) is car height, open frames, seats and wheels are waist height. 0 = no vehicle.
 */
export function vehicleSolidHeight(game: Game, x: number, y: number, z: number): number {
  const o = game.vehicles?.at(x, y, z);
  if (!o) return 0;
  const parts = o.v.partsAt(o.mx, o.my);
  if (!parts.length) return 0;
  return parts.some((p) => p.hp > 0 && (has(p, 'OBSTACLE') || has(p, 'ROOF'))) ? 1.6 : 1.0;
}

/**
 * Look-mode lines for the vehicle in a tile (CDDA look around: vehicle name, the parts at
 * that spot with their condition, overall damage), or null when there is none.
 */
export function describeVehicleAt(game: Game, x: number, y: number, z: number): string | null {
  const o = game.vehicles?.at(x, y, z);
  if (!o) return null;
  const v = o.v;
  const broken = v.parts.filter((p) => p.hp <= 0).length;
  const hp = v.parts.reduce((s, p) => s + Math.max(0, p.hp), 0), max = v.parts.reduce((s, p) => s + p.def.durability, 0);
  const pct = max > 0 ? Math.round((100 * hp) / max) : 100;
  const cond = pct >= 95 ? c('c_green', 'undamaged') : pct >= 70 ? c('c_light_green', 'lightly damaged') : pct >= 40 ? c('c_yellow', 'damaged') : c('c_light_red', 'badly damaged');
  const L = [`${c('c_light_gray', 'Vehicle:')} ${c('c_white', v.name)}  ${cond}${broken ? c('c_dark_gray', `  (${broken} broken part${broken === 1 ? '' : 's'})`) : ''}`];
  if (v.engineOn) L.push(c('c_light_green', 'The engine is running.'));
  for (const p of v.partsAt(o.mx, o.my)) L.push(`  ${partLine(p)}`);
  return L.join('\n');
}

function fuelSummary(v: Vehicle): string {
  const lines: string[] = [];
  const types = new Set(v.parts.filter((p) => p.fuelType && p.def.capacity).map((p) => p.fuelType!));
  for (const t of types) {
    const cap = v.fuelCapacity(t);
    if (!cap) continue;
    const pct = Math.round((100 * v.fuelLeft(t)) / cap);
    const name = t === 'battery' ? 'Battery' : v.vdata.fuels[t]?.name ?? t;
    const col = pct > 50 ? 'c_light_green' : pct > 15 ? 'c_yellow' : 'c_red';
    const amount = t === 'battery' ? `${Math.round(v.fuelLeft(t))} kJ` : `${(v.fuelLeft(t) / 1000).toFixed(1)} L`;
    lines.push(`${name}: ${c(col, `${pct}%`)} ${c('c_light_gray', amount)}`);
  }
  return lines.join('<br>');
}

function ctxOf(game: Game): UiContext {
  // The inventory widgets only need game + renderer (sprites) from the UI context.
  return { game, renderer: rendererRef!, worldgen: null, data: undefined as never };
}

/**
 * Examine the vehicle part at tile (x, y, z): doors toggle at once (like opening a door),
 * anything else opens the CDDA-style part menu. Returns false if there's no vehicle there.
 */
export function examineVehicle(game: Game, x: number, y: number, z: number): boolean {
  const vs = game.vehicles;
  const o = vs?.at(x, y, z);
  if (!vs || !o) return false;
  const door = o.v.partsAt(o.mx, o.my).find((p) => has(p, 'OPENABLE'));
  if (door) {
    const msg = vs.toggleDoor(o.v, o.mx, o.my);
    if (msg) game.message(msg);
    return true;
  }
  openPartMenu(game, o.v, o.mx, o.my);
  return true;
}

/** Prompt text for the HUD (null when not looking at a vehicle, '' = no prompt while driving). */
export function vehicleInteractPrompt(game: Game): string | null {
  const vs = game.vehicles;
  if (!vs) return null;
  if (vs.driving) return '';
  const t = targetVehicle(game);
  if (!t) return null;
  const parts = t.v.partsAt(t.mx, t.my);
  const door = parts.find((p) => has(p, 'OPENABLE'));
  const key = game.keys.keyFor('interact');
  if (door) return `[${key}] ${door.open ? 'Close' : 'Open'} the ${t.v.name}'s ${door.def.name}`;
  const ctrl = parts.find((p) => has(p, 'CONTROLS'));
  if (ctrl && vs.reachableControls() === t.v) return `[${game.keys.keyFor('control_vehicle')}] Take the controls of the ${t.v.name}  [${key}] Examine`;
  const shown = parts.find((p) => has(p, 'SEAT')) ?? parts.find((p) => has(p, 'CARGO')) ?? parts.find((p) => has(p, 'OBSTACLE')) ?? parts[0];
  return `[${key}] Examine the ${t.v.name}'s ${shown.def.name}`;
}

function openPartMenu(game: Game, v: Vehicle, mx: number, my: number): void {
  const vs = game.vehicles!;
  const parts = v.partsAt(mx, my);
  type Act = () => void;
  const entries: MenuEntry<Act>[] = [];
  const door = parts.find((p) => has(p, 'OPENABLE'));
  if (door) entries.push({ label: `${door.open ? 'Close' : 'Open'} the ${door.def.name}`, hotkey: door.open ? 'c' : 'o', value: () => game.message(vs.toggleDoor(v, mx, my) ?? '') });
  for (const cargo of parts.filter((p) => has(p, 'CARGO'))) {
    // Closed trunk lids / locked cargo keep their contents in (CDDA LOCKABLE_CARGO + door).
    const covered = parts.some((p) => has(p, 'OPENABLE') && !p.open) && !has(cargo, 'CARGO_PASSABLE');
    entries.push({
      label: `Get items from the ${cargo.def.name} (${cargo.items.length})`, hotkey: 'g', disabled: !cargo.items.length || covered,
      value: () => getItemsMenu(game, v, cargo),
    });
    entries.push({ label: `Put items into the ${cargo.def.name}`, hotkey: 'p', disabled: covered, value: () => putItemsMenu(game, v, cargo) });
  }
  const ctrl = parts.find((p) => has(p, 'CONTROLS'));
  if (ctrl) {
    const reach = vs.reachableControls() === v;
    entries.push({ label: `Take the controls`, hotkey: '^', disabled: !reach, value: () => takeControls(game, v) });
    if (v.locked) entries.push({ label: 'Hotwire', hotkey: 'h', disabled: !reach || !game.player.inv.hasQuality('SCREW', 1), value: () => hotwire(game, v) });
  }
  entries.push({ label: 'Examine the vehicle', hotkey: 'x', value: () => showVehicleInfo(game, v) });
  const header = `<div>${parts.map(partLine).join('<br>')}</div><div style="margin-top:6px">${fuelSummary(v)}</div>`;
  const m = openMenu<Act>({ title: `${v.name}`, width: 'min(70ch, 92vw)', entries, onSelect: (fn) => void setTimeout(fn, 0) });
  m.body.insertAdjacentHTML('afterbegin', `<div style="margin-bottom:8px">${header}</div>`);
}

function showVehicleInfo(game: Game, v: Vehicle): void {
  const [x0, y0, x1, y1] = v.bounds();
  const vs = game.vehicles!;
  const lines: string[] = [];
  lines.push(`${c('c_white', v.name)}  ${c('c_light_gray', `${x1 - x0 + 1}x${y1 - y0 + 1} tiles, ${Math.round(v.mass())} kg`)}`);
  const engines = v.engines;
  const wasOn = v.engineOn;
  v.engineOn = true;
  const safe = v.maxVelocity(true) * MPH_PER_MS, top = v.maxVelocity() * MPH_PER_MS;
  v.engineOn = wasOn;
  if (engines.length) lines.push(`Safe/top speed: ${c('c_light_blue', `${Math.round(safe)}/${Math.round(top)} mph`)}   Engine: ${v.engineOn ? c('c_light_green', 'running') : c('c_light_gray', 'off')}${v.locked ? '  ' + c('c_red', 'LOCKED') : ''}${v.alarmOn ? '  ' + c('c_red', 'ALARM') : ''}`);
  if (!v.validWheelConfig()) lines.push(c('c_red', 'Not enough intact wheels to move.'));
  lines.push(fuelSummary(v));
  lines.push('');
  for (let mx = x1; mx >= x0; mx--)
    for (let my = y0; my <= y1; my++) {
      const ps = v.partsAt(mx, my);
      if (!ps.length) continue;
      lines.push(`${c('c_dark_gray', `(${mx},${my})`)} ${ps.map(partLine).join(', ')}`);
    }
  void vs;
  const w = openWindow({ title: 'Vehicle', width: 'min(110ch, 96vw)', height: '80vh' });
  w.body.style.whiteSpace = 'normal';
  w.body.innerHTML = lines.join('<br>');
}

function getItemsMenu(game: Game, v: Vehicle, cargo: VehiclePart): void {
  const ctx = ctxOf(game);
  const loc = L.cargo(cargo, v);
  const entries: InvEntry[] = cargo.items.map((item) => ({ item, where: 'ground', loc, depth: 0, dir: cargo.def.name }));
  const rows: MultiRow[] = stackEntries(entries).map((entry) => ({ entry, max: entry.stack ? entry.stack.length : entry.item.countByCharges ? entry.item.charges : 1, count: 0 }));
  openMultiSelect(ctx, `Get items from the ${v.name}'s ${cargo.def.name}`, rows, 'get', (chosen) => {
    const inv = game.player.inv;
    for (const r of chosen) {
      const items: Item[] = r.entry.stack ? r.entry.stack.slice(0, r.count) : [r.entry.item];
      for (const it of items) {
        if (!isAt(it, loc)) continue;
        const count = !r.entry.stack && it.countByCharges ? Math.min(r.count, it.charges) : undefined;
        const res = inv.pickUp(it, loc, count);
        if (!res.ok) return;
      }
    }
  });
}

function putItemsMenu(game: Game, v: Vehicle, cargo: VehiclePart): void {
  const ctx = ctxOf(game);
  const rows: MultiRow[] = stackEntries(carriedEntries(ctx).filter((e) => e.where === 'carried' && e.depth === 0))
    .map((entry) => ({ entry, max: entry.stack ? entry.stack.length : entry.item.countByCharges ? entry.item.charges : 1, count: 0 }));
  if (!rows.length) {
    game.message('You have nothing to put there.', 'c_light_gray');
    return;
  }
  openMultiSelect(ctx, `Put items into the ${v.name}'s ${cargo.def.name}`, rows, 'store', (chosen) => {
    const p = game.player;
    const to = L.cargo(cargo, v);
    let any = false;
    for (const r of chosen) {
      const items = r.entry.stack ? r.entry.stack.slice(0, r.count) : [r.entry.item];
      for (const it of items) {
        if (!isAt(it, r.entry.loc)) continue;
        const count = !r.entry.stack && it.countByCharges ? Math.min(r.count, it.charges) : undefined;
        const res = moveItem(it, r.entry.loc, to, { count, actor: p, quiet: true });
        if (!res.ok) {
          game.message(res.msg, 'c_light_red');
          if (any) game.message(`You put items into the ${v.name}'s ${cargo.def.name}.`);
          return;
        }
        any = true;
      }
    }
    if (any) game.message(`You put items into the ${v.name}'s ${cargo.def.name}.`);
  });
}

function takeControls(game: Game, v: Vehicle): void {
  const vs = game.vehicles!;
  if (vs.reachableControls() !== v) {
    game.message(`You can't reach the controls of the ${v.name} from here.`, 'c_light_gray');
    return;
  }
  const r = vs.takeControls(v);
  game.message(r.msg, r.ok ? undefined : 'c_light_red');
}

function hotwire(game: Game, v: Vehicle): void {
  const vs = game.vehicles!;
  const mech = game.player.getSkill('mechanics');
  const t = vs.hotwireTime(mech);
  game.activities.start({
    name: `hotwiring the ${v.name}`,
    duration: t,
    onComplete: () => game.message(vs.finishHotwire(v, mech), v.locked ? 'c_light_red' : 'c_light_green'),
  });
}

function controlsMenu(game: Game): void {
  const vs = game.vehicles!;
  const v = vs.driving;
  if (!v) return;
  type Act = () => void;
  const say = (m: string, col?: string) => game.message(m, col);
  const entries: MenuEntry<Act>[] = [];
  if (v.locked) entries.push({ label: 'Hotwire', hotkey: 'h', disabled: !game.player.inv.hasQuality('SCREW', 1), value: () => hotwire(game, v) });
  entries.push({ label: v.engineOn ? 'Turn off the engine' : 'Turn on the engine', hotkey: 's', disabled: v.locked && !v.engineOn, value: () => { const r = vs.toggleEngine(v); say(r.msg, r.ok ? undefined : 'c_light_red'); } });
  if (!v.locked && v.withFlag('CONE_LIGHT').length) entries.push({ label: v.lightsOn ? 'Turn off headlights' : 'Turn on headlights', hotkey: 'h', value: () => say(vs.toggleHeadlights(v)) });
  if (v.withFlag('HORN').length) entries.push({ label: 'Sound horn', hotkey: 'n', value: () => say(vs.honk(v)) });
  if (v.alarmOn && !v.locked) entries.push({ label: 'Disable the alarm', hotkey: 'z', value: () => { v.alarmOn = false; say('You disable the alarm.'); } });
  entries.push({ label: 'Examine vehicle', hotkey: 'e', value: () => showVehicleInfo(game, v) });
  entries.push({ label: 'Let go of controls', hotkey: 'l', value: () => say(vs.releaseControls()) });
  openMenu<Act>({ title: `${v.name} controls`, width: 'min(50ch, 90vw)', entries, onSelect: (fn) => void setTimeout(fn, 0) });
}

/**
 * Dashboard while driving, in the bottom-right corner: across the middle of the screen it hid
 * the road ahead, and the message log owns the bottom-left.
 */
function dashboard(game: Game): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;right:.5em;bottom:.5em;max-width:43vw;background:rgba(0,0,0,.72);padding:3px 10px;' +
    `font-family:var(--ui-font);font-size:var(--ui-size);color:${cssColor('c_light_gray')};pointer-events:none;text-align:right;z-index:5;display:none`;
  getUiRoot().appendChild(el);
  let last = '';
  // The needle: speed eased over ~0.1 s so the number doesn't flicker between two values.
  let shown = 0;
  const update = (dt = 1 / 60) => {
    // Not over the death screen (dying at the wheel left the dashboard on the tombstone).
    const v = game.player.dead ? null : game.vehicles?.driving;
    if (v) shown += (v.velocity * MPH_PER_MS - shown) * Math.min(1, dt * 10);
    else shown = 0;
    const html = v ? dashHtml(game, v, shown) : '';
    if (html !== last) {
      el.innerHTML = html;
      el.style.display = html ? '' : 'none';
      last = html;
    }
  };
  return Object.assign(el, { update });
}

function dashHtml(game: Game, v: Vehicle, shownMph = v.velocity * MPH_PER_MS): string {
  const mph = Math.round(Math.abs(shownMph));
  const safe = v.engineOn ? Math.round(v.maxVelocity(true) * MPH_PER_MS) : 0;
  // CDDA vehicle::strain colouring: blue under the safe speed, then yellow / light red / red.
  const safeMs = v.maxVelocity(true), maxMs = Math.max(safeMs + 0.01, v.maxVelocity());
  const strain = Math.abs(v.velocity) < safeMs ? 0 : (Math.abs(v.velocity) - safeMs) / (maxMs - safeMs);
  const speedCol = !v.engineOn ? 'c_light_blue' : strain <= 0 ? 'c_light_blue' : strain <= 0.2 ? 'c_yellow' : strain <= 0.4 ? 'c_light_red' : 'c_red';
  const cruising = game.vehicles?.driveMode === 'cruise' || !!game.vehicles?.cruiseOn;
  const target = Math.round(v.cruiseVelocity / 100);
  // CDDA's dashboard: "Target: 20 mph Current: 12 mph"; direct throttle has no target.
  const speed = cruising
    ? `${c('c_light_gray', 'Target:')} ${c('c_light_green', String(target))} ${c('c_light_gray', 'Current:')} ${c(speedCol, `${v.velocity < -0.05 ? '-' : ''}${mph}`)} ${c('c_light_gray', `mph (safe ${safe})`)}`
    : `${c(speedCol, `${v.velocity < -0.05 ? 'R ' : ''}${mph}`)}${c('c_light_gray', `/${safe} mph`)}`;
  const fuels = v.engineFuels().filter((f) => f !== 'muscle' && f !== 'battery');
  const gauge = (t: string) => {
    const cap = v.fuelCapacity(t);
    const pct = cap ? Math.round((100 * v.fuelLeft(t)) / cap) : 0;
    const bars = Math.round(pct / 20);
    const col = pct > 50 ? 'c_light_green' : pct > 15 ? 'c_yellow' : 'c_red';
    return `${c('c_light_gray', t === 'battery' ? 'Bat' : capitalize(v.vdata.fuels[t]?.name ?? t))} ${c(col, '|'.repeat(bars) + '.'.repeat(5 - bars))}`;
  };
  const parts = [
    c('c_white', v.name),
    speed,
    v.engineOn ? c('c_light_green', 'engine') : v.locked ? c('c_red', 'LOCKED') : c('c_dark_gray', 'engine off'),
    ...fuels.map(gauge),
    v.fuelCapacity('battery') ? gauge('battery') : '',
    v.lightsOn ? c('c_yellow', 'lights') : '',
    v.validWheelConfig() ? '' : c('c_red', 'WHEELS'),
    c('c_dark_gray', `${game.vehicles?.driveMode === 'cruise' ? `[${game.keys.movementKeys()[0]}/${game.keys.movementKeys()[2]}]±4 mph [Space]stop ` : `[${game.keys.keyFor('crouch')}]cruise `}[${game.keys.keyFor('vehicle_engine')}]engine [${game.keys.keyFor('vehicle_headlights')}]lights [${game.keys.keyFor('vehicle_horn')}]horn [${game.keys.keyFor('control_vehicle')}]menu`),
  ].filter(Boolean);
  return parts.join('  ');
}

const DRIVE_MODE_KEY = 'cdda3d.driveMode';
function storedDriveMode(): DriveMode {
  try {
    return localStorage.getItem(DRIVE_MODE_KEY) === 'cruise' ? 'cruise' : 'direct';
  } catch {
    return 'direct';
  }
}

/**
 * Create the vehicle system, renderer and UI. Call once from main.ts after the debug API
 * exists (before the main loop starts, so the headlight is part of the light setup).
 */
export async function installVehicles(game: Game, renderer: Renderer, api?: DebugApi): Promise<VehicleSystem> {
  const vdata = await loadVehicleData();
  const vs = new VehicleSystem(game, vdata);
  rendererRef = renderer;
  game.vehicles = vs;
  game.systems.push(vs);
  registerVehicleSave(game, vs);
  // Run-overs hit real monsters (the monster system is installed before us in main.ts) and
  // NPCs (installed after us: the NPC hooks look game.npcs up on each call).
  const ms = (game as unknown as { monsters?: MonsterSystem }).monsters;
  vs.creatureHooks = composeCreatureHooks([...(ms ? [monsterCreatureHooks(ms)] : []), npcCreatureHooks(game, vs)]);
  new VehicleRenderer(renderer, game, vs);

  const needDriving = (fn: (v: Vehicle) => void) => () => {
    const v = vs.driving;
    if (!v) {
      game.message("You're not at the controls of a vehicle.", 'c_light_gray');
      return;
    }
    fn(v);
  };
  game.keys.register('control_vehicle', 'Control vehicle', () => {
    if (vs.driving) return controlsMenu(game);
    const v = vs.reachableControls();
    if (!v) {
      game.message('No vehicle controls in reach.', 'c_light_gray');
      return;
    }
    takeControls(game, v);
  });
  game.keys.register('vehicle_engine', 'Start/stop the engine (driving)', needDriving((v) => {
    const r = vs.toggleEngine(v);
    game.message(r.msg, r.ok ? undefined : 'c_light_red');
  }));
  game.keys.register('vehicle_headlights', 'Toggle headlights (driving)', needDriving((v) => game.message(vs.toggleHeadlights(v))));
  game.keys.register('vehicle_horn', 'Sound horn (driving)', needDriving((v) => game.message(vs.honk(v))));
  // C: crouch on foot, cruise control at the wheel (crouching in a driver's seat means nothing).
  const crouch = game.keys.action('crouch');
  game.keys.register('crouch', crouch ? `${crouch.name} / cruise control (driving)` : 'Cruise control (driving)', () => {
    if (vs.driving) game.message(vs.toggleCruise(), 'c_light_gray');
    else crouch?.handler();
  });
  // 'e' belongs to world interaction (src/game/interact.ts); vehicles get the first go at
  // it. Without that system (tests, stripped builds) 'e' examines vehicles directly.
  interactOverrides.push({
    interact: (g) => {
      // At the wheel, 'e' examines the vehicle you're driving (CDDA EXAMINE_VEHICLE).
      if (vs.driving) {
        showVehicleInfo(g, vs.driving);
        return true;
      }
      const t = targetVehicle(g, renderer);
      return t ? examineVehicle(g, t.x, t.y, t.z) : false;
    },
    prompt: vehicleInteractPrompt,
  });
  if (!game.keys.has('interact')) {
    game.keys.register('interact', 'Examine / interact', () => {
      const t = targetVehicle(game, renderer);
      if (t) examineVehicle(game, t.x, t.y, t.z);
    });
    hud.addPromptProvider(vehicleInteractPrompt);
  }
  vs.driveMode = storedDriveMode();
  registerOption({
    name: 'Driving controls',
    value: () => (vs.driveMode === 'cruise' ? 'cruise control' : 'direct throttle'),
    change: () => {
      vs.driveMode = vs.driveMode === 'cruise' ? 'direct' : 'cruise';
      try {
        localStorage.setItem(DRIVE_MODE_KEY, vs.driveMode);
      } catch {
        // not persisted
      }
    },
    desc: "Direct throttle (default): W accelerates while held, releasing it coasts, S brakes then reverses, Space is the handbrake, C locks the current speed (cruise control). Cruise control (CDDA): W/S raise or lower the target speed 4 mph per press and the engine holds it; Space zeroes it.",
  });
  const dash = dashboard(game) as HTMLElement & { update: (dt?: number) => void };
  renderer.beforeRender.push((dt) => dash.update(dt));

  if (api) installVehicleDebug(api, game, vs);
  return vs;
}

function summary(game: Game, v: Vehicle) {
  const p = game.player;
  const gas = v.engineFuels().filter((f) => f !== 'battery' && f !== 'muscle')[0];
  return {
    uid: v.uid, proto: v.protoId, name: v.name, x: +v.x.toFixed(2), y: +v.y.toFixed(2), z: v.z, facing: +v.facing.toFixed(1),
    mph: +(v.velocity * MPH_PER_MS).toFixed(1), cruiseMph: v.cruiseVelocity / 100, engineOn: v.engineOn, lightsOn: v.lightsOn, locked: v.locked,
    fuel: gas ? Math.round((100 * v.fuelLeft(gas)) / Math.max(1, v.fuelCapacity(gas))) : null,
    battery: v.fuelCapacity('battery') ? Math.round((100 * v.fuelLeft('battery')) / v.fuelCapacity('battery')) : null,
    brokenParts: v.parts.filter((q) => q.hp <= 0).length, dist: +Math.hypot(v.x - p.x, v.y - p.y).toFixed(1),
    driving: game.vehicles?.driving === v,
  };
}

function installVehicleDebug(api: DebugApi, game: Game, vs: VehicleSystem): void {
  const p = () => game.player;
  const nearest = () => [...vs.list].sort((a, b) => Math.hypot(a.x - p().x, a.y - p().y) - Math.hypot(b.x - p().x, b.y - p().y))[0] ?? null;
  const byUid = (uid?: number) => (uid === undefined ? nearest() : vs.list.find((v) => v.uid === uid) ?? null);
  /** Spawn a vehicle prototype with mount (0,0) at (dx, dy) tiles from the player. */
  api.spawnVehicle = (protoId: string, dx = 0, dy = -4, facingDeg = 0, opts: { fuel?: number; status?: number; force?: boolean } = {}) => {
    const v = vs.spawn(protoId, p().tileX + dx, p().tileY + dy, p().z, facingDeg, { fuel: opts.fuel ?? 100, status: opts.status ?? 0, force: opts.force });
    if (!v) return null;
    v.locked = false;
    return summary(game, v);
  };
  /** Vehicles within `radius` tiles (default 60), nearest first. */
  api.vehicles = (radius = 60) => vs.list.map((v) => summary(game, v)).filter((s) => s.dist <= radius).sort((a, b) => a.dist - b.dist);
  /** Sit at the controls of a vehicle (nearest by default): unlocks it, closes doors if asked. */
  api.enterVehicle = (uid?: number, opts: { start?: boolean; closeDoors?: boolean } = {}) => {
    const v = byUid(uid);
    if (!v) return null;
    v.locked = false;
    const s = v.driverSeat();
    if (!s) return null;
    const [wx, wy] = v.mountToWorld(s.mx, s.my);
    Object.assign(p(), { x: wx, y: wy, z: v.z, yaw: ((v.facing + 90) * Math.PI) / 180, pitch: 0 });
    vs.takeControls(v);
    if (opts.closeDoors !== false) for (const q of v.parts) if (has(q, 'OPENABLE')) q.open = false;
    v.version++;
    if (opts.start !== false) {
      const r = vs.startEngine(v);
      if (!r.ok) {
        // Debug entry: fix whatever keeps it from starting.
        for (const e of v.engines) {
          e.hp = e.def.durability;
          e.fault = false;
        }
        for (const w of v.wheels) w.hp = w.def.durability;
        for (const t of v.engineFuels()) v.addFuel(t, 1e9);
        v.addFuel('battery', 1e9);
        vs.startEngine(v);
      }
    }
    return summary(game, v);
  };
  /** Drive for `seconds` (simulated at 30 Hz) with throttle/steer in -1..1. */
  api.drive = (throttle: number, steer = 0, seconds = 1, brake = false) => {
    const v = vs.driving;
    if (!v) throw new Error('not driving: call cdda.enterVehicle() first');
    vs.scriptedInput = true;
    vs.input = { throttle, steer, brake };
    try {
      api.step(seconds);
    } finally {
      vs.input = { throttle: 0, steer: 0, brake: false };
      vs.scriptedInput = false;
    }
    return summary(game, v);
  };
  /** Driving model: 'cruise' (CDDA default) or 'direct' throttle; no argument = current. */
  api.driveMode = (mode?: DriveMode) => {
    if (mode) vs.driveMode = mode;
    return vs.driveMode;
  };
  /** Set the cruise target in mph (like pressing W/S until it reads that), then drive `seconds`. */
  api.cruise = (mph: number, seconds = 0, steer = 0) => {
    const v = vs.driving;
    if (!v) throw new Error('not driving: call cdda.enterVehicle() first');
    v.cruiseVelocity = Math.round(mph * 100);
    return seconds > 0 ? api.drive(0, steer, seconds) : summary(game, v);
  };
  api.exitVehicle = () => vs.releaseControls();
  /**
   * Put a fresh vehicle on a straight north-south road: finds an OMT column of `len`
   * road_ns tiles within `radius` OMTs, spawns `protoId` in its right lane facing north and
   * seats the player at the controls (engine running). Needs the world generator.
   */
  api.roadTrip = (protoId = 'car', len = 4, radius = 40) => {
    if (typeof api.omtAt !== 'function') throw new Error('roadTrip needs gen=world');
    const pomx = Math.floor(p().x / 24), pomy = Math.floor(p().y / 24);
    for (let r = 0; r <= radius; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = pomx + dx, y = pomy + dy;
          let ok = true;
          for (let k = 0; k < len && ok; k++) ok = /^road_ns/.test(api.omtAt(x, y - k).id);
          if (!ok) continue;
          p().x = x * 24 + 12.5;
          p().y = y * 24 + 20.5;
          const v = vs.spawn(protoId, x * 24 + 13, y * 24 + 18, p().z, 270, { fuel: 100, status: 0, force: true });
          if (!v) return null;
          return { omt: [x, y], ...api.enterVehicle(v.uid) };
        }
    return null;
  };
  /**
   * Generate the OMTs within `radius` of the player, then stand `dist` tiles off the side of
   * the nearest vehicle whose prototype id matches `filter` (regex), looking at it.
   */
  api.gotoVehicle = (filter = 'car|suv|van|truck|bus|police|wagon|rv', opts: { radius?: number; dist?: number; angle?: number; skip?: number } = {}) => {
    const r = opts.radius ?? 8;
    const cx = Math.floor(p().x / 24), cy = Math.floor(p().y / 24);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) game.map.chunk(cx + dx, cy + dy, p().z);
    vs.flushPending();
    const re = new RegExp(filter);
    const v = [...vs.list].filter((q) => re.test(q.protoId) && q.z === p().z)
      .sort((a, b) => Math.hypot(a.x - p().x, a.y - p().y) - Math.hypot(b.x - p().x, b.y - p().y))[opts.skip ?? 0];
    if (!v) return null;
    // Stand `dist` m outside the body at `angle` deg from the vehicle's nose (90 = right side).
    const [x0, y0, x1, y1] = v.bounds();
    const [ccx, ccy] = v.mountToWorld((x0 + x1) / 2, (y0 + y1) / 2);
    const a = ((v.facing + (opts.angle ?? 90)) * Math.PI) / 180;
    const reach = Math.max(x1 - x0, y1 - y0) / 2 + (opts.dist ?? 3);
    const wx = ccx + Math.cos(a) * reach, wy = ccy + Math.sin(a) * reach;
    const yaw = Math.atan2(ccx - wx, -(ccy - wy));
    Object.assign(p(), { x: wx, y: wy, yaw, pitch: -0.12 });
    return summary(game, v);
  };
  api.vehicleLights = (on = true, uid?: number) => {
    const v = byUid(uid);
    if (v && v.lightsOn !== on) {
      v.addFuel('battery', 1e9);
      vs.toggleHeadlights(v);
    }
    return v ? summary(game, v) : null;
  };
  /** Vehicle part list at (dx, dy) from the player. */
  api.vehicleAt = (dx = 0, dy = 0) => {
    const o = vs.at(p().tileX + dx, p().tileY + dy, p().z);
    return o ? { ...summary(game, o.v), mount: [o.mx, o.my], parts: o.v.partsAt(o.mx, o.my).map((q) => `${q.def.id} ${q.hp}/${q.def.durability}${q.open ? ' open' : ''}`) } : null;
  };
  api.vehicleTarget = () => {
    const t = targetVehicle(game);
    return t ? { uid: t.v.uid, mount: [t.mx, t.my], x: t.x, y: t.y } : null;
  };
  api.examineVehicle = (dx: number, dy: number) => examineVehicle(game, p().tileX + dx, p().tileY + dy, p().z);
  api.vehicleSystem = vs;
  api.vehiclesJSON = () => vs.toJSON();
}

/** 'gasoline' -> 'Gasoline' (a clipped 'gaso' read like a typo on the dashboard). */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
