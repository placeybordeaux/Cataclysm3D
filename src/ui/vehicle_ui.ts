import { isRunoverMode, RUNOVER_MODES, type RunoverMode } from '../game/runoverFling';
import * as THREE from 'three';
import type { DebugApi } from '../debug';
import type { Game } from '../game/game';
import { Item } from '../game/item';
import { has, MPH_PER_MS, type Vehicle, type VehiclePart } from '../game/vehicle';
import { loadVehicleData } from '../game/vehicle_data';
import { installRefuel } from '../game/refuel';
import { installTowing } from '../towing';
import { adoptVehicle, queueVehicleWork, startVehicleWork, type VehicleWorkOrder } from '../game/vehicleWork';
import { cancelChassis, chassisReasons, chassisSitePlan, continueChassis, startChassis, type ChassisPlan } from '../game/vehicleChassis';
import { openVehicleChassisPanel } from '../screens/vehicleChassis';
import { rechargeVehicleCargo } from '../game/recharging';
import { pointInBody } from '../game/vehicleShape';
import { cellAtPoint, chassisBodyRect, chassisOf, chassisSeats } from '../game/chassis';
import { ChassisOverlay } from '../render/chassisDebug';
import { composeCreatureHooks, monsterCreatureHooks, npcCreatureHooks, registerVehicleSave, VehicleSystem, type DriveMode } from '../game/vehicles';
import { registerOption } from './options';
import { CRASH_MODELS, HANDLING_MODES, isCrashModel, isHandlingMode, motionOf, type CrashModel, type HandlingMode } from '../game/vehicleImpact';
import { isVehWalkMode, VEHWALK_DESC, VEHWALK_MODES, type VehWalkMode } from '../game/vehwalk';
import type { MonsterSystem } from '../game/monai';
import { interactOverrides } from '../game/interact';
import type { Renderer } from '../render/renderer';
import { VEHICLE_LOOKS, VehicleRenderer } from '../render/vehicleMesh';
import { riderSlot } from '../render/vehicleRider';
import { VEHICLE_WIDTHS } from '../render/vehicleLayout';
import { LEVEL_HEIGHT } from '../world/coords';
import type { UiContext } from './context';
import { c, cssColor, getUiRoot, openMenu, openWindow, type MenuEntry } from './framework';
import { hud } from './hud';
import { installStationPanel } from './stationPanel';
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

/**
 * The vehicle screens, replaceable: installScreens (src/screens/install.ts) swaps in the ui2
 * vehicle panel and driving HUD; these curses menus are the default.
 */
export const vehicleScreens = {
  /** `e` on a part that isn't a door (and `e` at the wheel: the whole vehicle). */
  partMenu: (game: Game, v: Vehicle, mx: number, my: number): void => openPartMenu(game, v, mx, my),
  info: (game: Game, v: Vehicle): void => showVehicleInfo(game, v),
  /** `^` while driving. */
  controls: (game: Game): void => controlsMenu(game),
  /** The CDDA dashboard line while driving; off when a replacement HUD is installed. */
  legacyDashboard: true,
};

/** Vehicle part under the crosshair within reach (~2 m), or the tile ahead in top-down view. */
export function targetVehicle(game: Game, renderer: Renderer | null = rendererRef): VehicleTarget | null {
  const vs = game.vehicles;
  if (!vs) return null;
  const p = game.player;
  const base = p.z * LEVEL_HEIGHT;
  const hit = (x: number, y: number, h: number, shaped = true): VehicleTarget | null => {
    const tx = Math.floor(x), ty = Math.floor(y);
    const o = vs.at(tx, ty, p.z);
    if (!o || h < base + 0.1 || h > base + 2.0) return null;
    // Modelled bodies are narrower than their tiles: the crosshair has to reach the paint.
    const b = shaped ? vs.bodyRect(o.v) : null;
    if (b && !pointInBody(o.v, b, x, y, 0.03)) return null;
    // On a shaped body the part is the one under the crosshair (its cell), not the one at the
    // tile's centre: they differ on a turned vehicle.
    const [mx, my] = b ? cellAtPoint(o.v, ...o.v.worldToMount(x, y)) : [o.mx, o.my];
    return { v: o.v, mx, my, x: tx, y: ty, z: p.z };
  };
  if (!renderer || renderer.cameraMode === 'top') {
    // Top-down: the tile in front of you (like CDDA's direction prompt), else your own.
    const fx = p.x + Math.sin(p.yaw) * 0.9, fy = p.y - Math.cos(p.yaw) * 0.9;
    return hit(fx, fy, base + 1, false) ?? hit(p.x, p.y, base + 1, false);
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
  vehicleScreens.partMenu(game, o.v, o.mx, o.my);
  return true;
}

/** Prompt text for the HUD (null when not looking at a vehicle, '' = no prompt while driving). */
export function vehicleInteractPrompt(game: Game): string | null {
  const vs = game.vehicles;
  if (!vs) return null;
  if (vs.driving) return '';
  const here = vs.stations.prompt(game.keys.keyFor('interact'));
  if (here !== null) {
    // the crosshair's own action still works where the station has none ('o' More… always)
    const more = game.keys.has('world_menu') ? `  [${game.keys.keyFor('world_menu')}] More…` : '';
    return here + more;
  }
  const t = targetVehicle(game);
  if (!t) return null;
  const parts = t.v.partsAt(t.mx, t.my);
  const door = parts.find((p) => has(p, 'OPENABLE'));
  const key = game.keys.keyFor('interact');
  if (vs.driveOffer(t.v, t.mx, t.my)) {
    // The door, the cargo and the parts panel are one key away (the crosshair's context menu).
    const more = game.keys.has('world_menu') ? `  [${game.keys.keyFor('world_menu')}] More…` : '';
    return `[${key}] ${t.v.locked ? 'Get in' : 'Drive'} the ${t.v.name}${more}`;
  }
  if (door) return `[${key}] ${door.open ? 'Close' : 'Open'} the ${t.v.name}'s ${door.def.name}`;
  const ctrl = parts.find((p) => has(p, 'CONTROLS'));
  if (ctrl && vs.getInReason(t.v) === null) return `[${game.keys.keyFor('control_vehicle')}] Take the controls of the ${t.v.name}  [${key}] Examine`;
  const shown = parts.find((p) => has(p, 'SEAT')) ?? parts.find((p) => has(p, 'CARGO')) ?? parts.find((p) => has(p, 'OBSTACLE')) ?? parts[0];
  return `[${key}] Examine the ${t.v.name}'s ${shown.def.name}`;
}

function openPartMenu(game: Game, v: Vehicle, mx: number, my: number): void {
  const vs = game.vehicles!;
  const parts = v.partsAt(mx, my);
  type Act = () => void;
  const entries: MenuEntry<Act>[] = [];
  const door = parts.find((p) => has(p, 'OPENABLE'));
  for (const charger of parts.filter(p => has(p, 'RECHARGE') && p.hp > 0)) {
    entries.push({ label: `${charger.enabled ? 'Turn off' : 'Turn on'} the ${charger.def.name} (${charger.def.bonus ?? 0} W)`, hotkey: 'r', disabled: v.locked, value: () => {
      charger.enabled = !charger.enabled;
      game.message(`You ${charger.enabled ? 'enable' : 'disable'} the ${charger.def.name}. Put rechargeable items in this mount's cargo to charge them.`);
    } });
  }
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
    const reach = vs.getInReason(v) === null;
    entries.push({ label: `Take the controls`, hotkey: '^', disabled: !reach, value: () => takeControls(game, v) });
    if (v.locked) entries.push({ label: 'Hotwire', hotkey: 'h', disabled: !reach || !game.player.inv.hasQuality('SCREW', 1), value: () => hotwire(game, v) });
  }
  for (const extra of vehiclePartMenuExtras) entries.push(...extra(game, v, mx, my));
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
  // Governed figures (VehicleSystem.speedLimits): a tank's tracks top out near 45 mph, not CDDA's 150.
  const lim = vs.speedLimits(v);
  const safe = lim.safe * MPH_PER_MS, top = lim.top * MPH_PER_MS;
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

/** The ui2 inventory takes over "Get/Put items" when it can (src/ui2/bn/install.ts); false = use the v1 list. */
/** Extra entries for a vehicle part's `e` menu from other systems (src/grab.ts: grab it). */
export const vehiclePartMenuExtras: ((game: Game, v: Vehicle, mx: number, my: number) => { label: string; hotkey: string; value: () => void }[])[] = [];

export const cargoUi: { open?: (v: Vehicle, cargo: VehiclePart) => boolean } = {};

function getItemsMenu(game: Game, v: Vehicle, cargo: VehiclePart): void {
  if (cargoUi.open?.(v, cargo)) return;
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
  if (cargoUi.open?.(v, cargo)) return;
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

export function takeControls(game: Game, v: Vehicle): void {
  const vs = game.vehicles!;
  const why = vs.getInReason(v);
  if (why) {
    game.message(why, 'c_light_gray');
    return;
  }
  // From beside the vehicle: open the driver's door on the way in (takeControls seats you).
  if (vs.reachableControls() !== v) {
    const door = vs.openDriverDoor(v);
    if (door) game.message(door);
  }
  const r = vs.takeControls(v);
  game.message(r.msg, r.ok ? undefined : 'c_light_red');
}

export function hotwire(game: Game, v: Vehicle): void {
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
    const v = game.player.dead || !vehicleScreens.legacyDashboard ? null : game.vehicles?.driving;
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
  // Governed figures (VehicleSystem.speedLimits), not CDDA's drag maths alone.
  const lim = game.vehicles?.speedLimits(v) ?? { safe: v.maxVelocity(true), top: v.maxVelocity() };
  const safe = v.engineOn ? Math.round(lim.safe * MPH_PER_MS) : 0;
  // CDDA vehicle::strain colouring: blue under the safe speed, then yellow / light red / red.
  const safeMs = lim.safe, maxMs = Math.max(safeMs + 0.01, lim.top);
  const strain = Math.abs(v.velocity) < safeMs ? 0 : (Math.abs(v.velocity) - safeMs) / (maxMs - safeMs);
  const speedCol = !v.engineOn ? 'c_light_blue' : strain <= 0 ? 'c_light_blue' : strain <= 0.2 ? 'c_yellow' : strain <= 0.4 ? 'c_light_red' : 'c_red';
  const cruising = game.vehicles?.driveMode === 'cruise' || !!game.vehicles?.cruiseOn;
  const target = Math.round(v.cruiseVelocity / 100);
  // CDDA's dashboard: "Target: 20 mph Current: 12 mph"; direct throttle has no target.
  const speed = cruising
    ? `${c('c_light_gray', 'Target:')} ${c('c_light_green', String(target))} ${c('c_light_gray', 'Current:')} ${c(speedCol, `${v.velocity < -0.05 ? '-' : ''}${mph}`)} ${c('c_light_gray', `mph (safe ${safe})`)}`
    : `${c(speedCol, `${v.velocity < -0.05 ? 'R ' : ''}${mph}`)}${c('c_light_gray', `/${safe} mph`)}`;
  const fuels = v.runningFuels().filter((f) => f !== 'muscle' && f !== 'battery');
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

const VEHWALK_KEY = 'cdda3d.vehwalk';
/** `?vehwalk=` (wins), else the stored option, else 'stations'. A bad URL value fails loudly. */
function initialVehWalk(): VehWalkMode {
  const q = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('vehwalk');
  if (q !== null) {
    if (!isVehWalkMode(q)) throw new Error(`?vehwalk=${q}: expected ${VEHWALK_MODES.join('|')}`);
    return q;
  }
  try {
    const s = localStorage.getItem(VEHWALK_KEY);
    if (isVehWalkMode(s)) return s;
  } catch {
    // storage blocked
  }
  return 'stations';
}
function setVehWalk(vs: VehicleSystem, m: VehWalkMode, persist = false): VehWalkMode {
  if (!isVehWalkMode(m)) throw new Error(`vehWalk: expected ${VEHWALK_MODES.join('|')}, not ${String(m)}`);
  vs.stations.mode = m;
  if (persist)
    try {
      localStorage.setItem(VEHWALK_KEY, m);
    } catch {
      // not persisted
    }
  return m;
}

const DRIVE_MODE_KEY = 'cdda3d.driveMode';

/**
 * A vehicle physics setting: `?param=` wins (a bad value fails loudly), else the stored
 * option, else the default.
 */
function initialSetting<T extends string>(param: string, key: string, all: readonly T[], def: T): T {
  const q = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get(param);
  if (q !== null) {
    if (!(all as readonly string[]).includes(q)) throw new Error(`?${param}=${q}: expected ${all.join('|')}`);
    return q as T;
  }
  try {
    const s = localStorage.getItem(key);
    if (s !== null && (all as readonly string[]).includes(s)) return s as T;
  } catch {
    // storage blocked
  }
  return def;
}
function storeSetting(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    // not persisted
  }
}
const CRASH_MODEL_KEY = 'cdda3d.vehicleCrashModel';
const HANDLING_KEY = 'cdda3d.vehicleHandling';
const RUNOVER_KEY = 'cdda3d.runoverBodies';
const RUNOVER_LABEL: Record<RunoverMode, string> = { ragdoll: 'rag doll (stiff)', loose: 'rag doll (loose)', fall: 'simple fall (old)' };
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
  installRefuel(game, vs);
  // Tow cables: the item's use action, vehicle-screen actions, the cable drawn (src/towing.ts).
  installTowing(game, renderer, api, () => targetVehicle(game));
  // Run-overs hit real monsters (the monster system is installed before us in main.ts) and
  // NPCs (installed after us: the NPC hooks look game.npcs up on each call).
  const ms = (game as unknown as { monsters?: MonsterSystem }).monsters;
  vs.creatureHooks = composeCreatureHooks([...(ms ? [monsterCreatureHooks(ms)] : []), npcCreatureHooks(game, vs)]);
  const vr = new VehicleRenderer(renderer, game, vs);
  registerOption({
    category: 'World',
    name: 'Vehicle look',
    value: () => (vr.look === 'model' ? 'modelled bodies' : 'part blocks'),
    change: () => {
      vr.look = VEHICLE_LOOKS[(VEHICLE_LOOKS.indexOf(vr.look) + 1) % VEHICLE_LOOKS.length];
    },
    desc: 'Modelled bodies (default): every car, truck, bus and bike is drawn as one shaped vehicle. Part blocks: the older look, one block per vehicle part (the grid Cataclysm uses). Also ?vehicles=model|parts.',
  });
  registerOption({
    category: 'World',
    name: 'Vehicle width',
    value: () => (vr.width === 'real' ? 'true to life' : 'fill the tiles'),
    change: () => {
      vr.width = VEHICLE_WIDTHS[(VEHICLE_WIDTHS.indexOf(vr.width) + 1) % VEHICLE_WIDTHS.length];
    },
    desc: 'Modelled bodies only. True to life (default): cars are drawn car-shaped, narrower than the tiles Cataclysm gives them. Fill the tiles: bodies widen to nearly the whole footprint; chunkier. Either way you collide with the body you see (its chassis template). Also ?vehiclewidth=real|fill.',
  });
  if (api) {
    /** Body width mode for the model look ('real' | 'fill'); no argument = current. */
    api.vehicleWidth = (w?: 'real' | 'fill') => {
      if (w) vr.width = w;
      return vr.width;
    };
    /** Chassis template debug overlay (body = collision outline, sockets, seats, overflow): true / false. */
    let overlay: ChassisOverlay | null = null;
    api.chassisOverlay = (on = true) => {
      overlay ??= new ChassisOverlay(renderer, game);
      overlay.setEnabled(!!on);
      return overlay.enabled;
    };
    /** Switch the vehicle renderer ('model' | 'parts'); no argument = current. */
    api.vehicleLook = (look?: 'model' | 'parts') => {
      if (look) vr.look = look;
      return vr.look;
    };
  }

  const needDriving = (fn: (v: Vehicle) => void) => () => {
    const v = vs.driving;
    if (!v) {
      game.message("You're not at the controls of a vehicle.", 'c_light_gray');
      return;
    }
    fn(v);
  };
  game.keys.register('control_vehicle', 'Control vehicle', () => {
    if (vs.driving) return vehicleScreens.controls(game);
    const v = vs.enterableControls();
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
      // At the wheel, 'e' lets go of the controls — the one obvious way out of driving mode
      // (the vehicle panel on '^' still has info and every control). Letting go while moving
      // is allowed, as in CDDA; releaseControls() warns about it.
      // Stopped, 'e' also climbs out through the nearest door (what "e get out" promises).
      if (vs.driving) {
        const v = vs.driving;
        const released = vs.releaseControls();
        // RVs, buses, tanks (src/game/vehwalk.ts): you stay inside, in the driver's seat, and
        // walk to a door / hatch (or another station) from there. Cars: straight out.
        if (vs.stations.cabin(v) && vs.stations.cabin(v) !== 'wheel' && vs.stations.seatDriver(v)) {
          g.message(`${released} W/A/S/D move to another seat; get out at a door or hatch.`);
          return true;
        }
        g.message(vs.climbOut(v) ?? released);
        return true;
      }
      // At a station inside a vehicle: its action (drive, get out, later the turret), else the
      // crosshair as usual (a seat's cargo from the aisle).
      const act = vs.stations.action();
      if (act) {
        const msg = act.run();
        if (msg) g.message(msg);
        return true;
      }
      const t = targetVehicle(g, renderer);
      if (t && vs.driveOffer(t.v, t.mx, t.my)) {
        takeControls(g, t.v);
        return true;
      }
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
  vs.stations.mode = initialVehWalk();
  registerOption({
    category: 'Controls',
    name: 'Inside vehicles',
    value: () => vs.stations.mode,
    change: (d) => {
      const i = VEHWALK_MODES.indexOf(vs.stations.mode);
      setVehWalk(vs, VEHWALK_MODES[(i + d + VEHWALK_MODES.length) % VEHWALK_MODES.length], true);
    },
    desc: 'How you move around inside a vehicle you are not driving (?vehwalk= wins over this).\n' + VEHWALK_MODES.map((m) => `${m}: ${VEHWALK_DESC[m]}`).join('\n'),
  });
  vs.crashModel = initialSetting('vehcrash', CRASH_MODEL_KEY, CRASH_MODELS, 'momentum');
  registerOption({
    category: 'Gameplay',
    name: 'Vehicle crashes',
    value: () => (vs.crashModel === 'momentum' ? 'momentum (arcade)' : 'immovable (old)'),
    change: () => {
      vs.crashModel = vs.crashModel === 'momentum' ? 'immovable' : 'momentum';
      storeSetting(CRASH_MODEL_KEY, vs.crashModel);
    },
    desc: 'Momentum (default): vehicles that collide push and spin each other by their masses. A tank shoves a car aside and barely slows; a car that hits a tank stops hard. You feel your own vehicle\'s jolt, and you slide along walls instead of sticking. Immovable: the older model, where another vehicle stops you like a wall (light ones are knocked aside). Also ?vehcrash=momentum|immovable.',
  });
  vs.handlingMode = initialSetting('vehheft', HANDLING_KEY, HANDLING_MODES, 'weighty');
  registerOption({
    category: 'Gameplay',
    name: 'Heavy vehicles',
    value: () => (vs.handlingMode === 'weighty' ? 'weighty' : 'light (old)'),
    change: () => {
      vs.handlingMode = vs.handlingMode === 'weighty' ? 'light' : 'weighty';
      storeSetting(HANDLING_KEY, vs.handlingMode);
    },
    desc: 'Weighty (default): heavy and tracked vehicles take their time to get moving, steer and pivot slowly, and are governed to their real top speeds (an M1 about 45 mph). Taken from each vehicle\'s mass, power and tracks; cars are unchanged. Light: everything handles like a car (the older feel). Also ?vehheft=weighty|light.',
  });
  vs.runoverMode = initialSetting('runover', RUNOVER_KEY, RUNOVER_MODES, 'loose');
  registerOption({
    category: 'Gameplay',
    name: 'Run-over bodies',
    value: () => RUNOVER_LABEL[vs.runoverMode],
    change: (d) => {
      const i = RUNOVER_MODES.indexOf(vs.runoverMode);
      vs.runoverMode = RUNOVER_MODES[(i + (d < 0 ? -1 : 1) + RUNOVER_MODES.length) % RUNOVER_MODES.length];
      storeSetting(RUNOVER_KEY, vs.runoverMode);
    },
    desc: 'What a vehicle does to a creature it runs over. Rag doll: it is thrown along your path with a kick up and a spin, over the bonnet and roof at speed, tumbles, bounces off walls and skids to rest where its corpse lies; a survivor gets up where it lands. Loose limbs (default) flop and flail; stiff ones keep the body\'s shape. A body hit hard enough to be gibbed comes apart instead (Gibbed bodies). Simple fall: the older look, where the body is put down a few tiles ahead (BN\'s fling) and a corpse drops where it was hit. Also ?runover=ragdoll|loose|fall.',
  });
  vs.driveMode = storedDriveMode();
  registerOption({
    category: 'Controls',
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
  installStationPanel(game, renderer);

  if (api) installVehicleDebug(api, game, vs);
  return vs;
}

function summary(game: Game, v: Vehicle) {
  const p = game.player;
  const gas = v.runningFuels().filter((f) => f !== 'battery' && f !== 'muscle')[0];
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
  /** How being inside a vehicle works: no argument = current mode and where you are. */
  api.vehWalk = (mode?: VehWalkMode) => {
    if (mode !== undefined) setVehWalk(vs, mode);
    const at = vs.stations.view();
    return { mode: vs.stations.mode, at: at ? { uid: at.v.uid, cabin: at.cabin, kind: at.station.kind, cell: [at.station.mx, at.station.my], hop: +at.t.toFixed(2) } : null };
  };
  api.vehicleStations = (uid?: number) => {
    const v = byUid(uid);
    return v ? { cabin: vs.stations.cabin(v), stations: vs.stations.stations(v).map((s) => ({ kind: s.kind, posture: s.posture, cell: [s.mx, s.my], at: [+s.x.toFixed(2), +s.y.toFixed(2)], turret: s.turret })) } : null;
  };
  api.vehicleWork = (uid?: number) => {
    const v = byUid(uid);
    return v ? { adopted: v.adopted, orders: v.workOrders.map(j => ({ ...j })) } : null;
  };
  api.adoptVehicle = (uid?: number) => { const v = byUid(uid); return v ? adoptVehicle(game, v) : null; };
  api.queueVehicleWork = (uid: number, order: Omit<VehicleWorkOrder, 'elapsed'>) => { const v = byUid(uid); return v ? queueVehicleWork(game, v, order) : null; };
  api.resumeVehicleWork = (uid?: number) => { const v = byUid(uid); return v ? startVehicleWork(game, v) : false; };
  api.openVehicleChassis = () => openVehicleChassisPanel(game);
  api.vehicleChassis = (plan: ChassisPlan, x = p().tileX + 2, y = p().tileY, z = p().z) => ({ reasons: chassisReasons(game,plan,x,y,z),
    sites: game.map.itemsAt(x,y,z).filter((i): i is Item => i instanceof Item && !!chassisSitePlan(i)).map(i=>({plan:chassisSitePlan(i),item:i.toJSON()})) });
  api.startVehicleChassis = (plan: ChassisPlan, x = p().tileX + 2, y = p().tileY, z = p().z) => startChassis(game,plan,x,y,z)?.toJSON() ?? null;
  const chassisAt = (x:number,y:number,z:number) => game.map.itemsAt(x,y,z).find((i): i is Item=>i instanceof Item && !!chassisSitePlan(i));
  api.resumeVehicleChassis = (x:number,y:number,z=p().z) => { const site=chassisAt(x,y,z);return site ? continueChassis(game,site,x,y,z):false; };
  api.cancelVehicleChassis = (x:number,y:number,z=p().z) => { const site=chassisAt(x,y,z);return site ? cancelChassis(game,site,x,y,z):false; };
  /** Inspect/toggle chargers; optional seconds advances only charging for automation. */
  api.vehicleCharging = (uid?: number, enabled?: boolean, seconds = 0) => {
    const v = byUid(uid);
    if (!v) return null;
    if (enabled !== undefined) for (const p of v.withFlag('RECHARGE', true)) p.enabled = enabled;
    const transferred = rechargeVehicleCargo(v, seconds);
    return { transferred, batteryKj: v.fuelLeft('battery'), chargers: v.withFlag('RECHARGE').map(p => ({ id: p.def.id, mx: p.mx, my: p.my, enabled: p.enabled, watts: p.def.bonus ?? 0, broken: p.hp <= 0 })), cargo: v.withFlag('CARGO').map(p => ({ mx: p.mx, my: p.my, items: p.items.map(it => it.toJSON()) })) };
  };
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
  /** Driving crashes against the drawn body ('body', default) or CDDA's whole tiles ('tiles'); no argument = current. */
  /** Vehicle-vs-vehicle crash model: 'momentum' (default) or 'immovable' (the old one); no argument = current. */
  api.vehicleCrashModel = (mode?: CrashModel) => {
    if (mode !== undefined && !isCrashModel(mode)) throw new Error(`vehicleCrashModel: ${CRASH_MODELS.join(' or ')}, not ${String(mode)}`);
    if (mode) vs.crashModel = mode;
    return vs.crashModel;
  };
  /** Run-over bodies: 'ragdoll' (default, stiff), 'loose' or 'fall' (the old teleport + simple fall); no argument = current. */
  api.runoverBodies = (mode?: RunoverMode) => {
    if (mode !== undefined && !isRunoverMode(mode)) throw new Error(`runoverBodies: ${RUNOVER_MODES.join(' or ')}, not ${String(mode)}`);
    if (mode) vs.runoverMode = mode;
    return vs.runoverMode;
  };
  /** Heavy-vehicle handling: 'weighty' (default) or 'light' (the old car tuning for everything); no argument = current. */
  api.vehicleHandling = (mode?: HandlingMode) => {
    if (mode !== undefined && !isHandlingMode(mode)) throw new Error(`vehicleHandling: ${HANDLING_MODES.join(' or ')}, not ${String(mode)}`);
    if (mode) vs.handlingMode = mode;
    return vs.handlingMode;
  };
  /** Crash slide / spin / pivot of a vehicle (vehicleImpact.ts Motion); no uid = the one you drive or the nearest. */
  api.vehicleMotion = (uid?: number) => {
    const v = uid !== undefined ? vs.list.find((q) => q.uid === uid) : vs.driving ?? nearest();
    if (!v) return null;
    const m = motionOf(v);
    return { uid: v.uid, mph: +(v.velocity * MPH_PER_MS).toFixed(1), slideMph: +(Math.hypot(m.sx, m.sy) * MPH_PER_MS).toFixed(1), spin: +m.spin.toFixed(1), pivot: +m.pivot.toFixed(1), heft: +vs.handling(v).heft.toFixed(2) };
  };
  api.vehicleCrashes = (mode?: 'body' | 'tiles') => {
    if (mode !== undefined && mode !== 'body' && mode !== 'tiles') throw new Error(`vehicleCrashes: 'body' or 'tiles', not ${String(mode)}`);
    if (mode) vs.crashGeometry = mode;
    return vs.crashGeometry;
  };
  api.vehiclesJSON = () => vs.toJSON();
  /**
   * Chassis template of a vehicle (vehicles v3): template, why it was chosen, sockets by kind,
   * seats and overflow. No uid = the one you're in / driving / nearest.
   */
  api.chassis = (uid?: number) => {
    const v = uid !== undefined ? vs.list.find((q) => q.uid === uid) : vs.driving ?? vs.playerOn()?.v ?? [...vs.list].sort((a, b) => Math.hypot(a.x - p().x, a.y - p().y) - Math.hypot(b.x - p().x, b.y - p().y))[0];
    if (!v) return null;
    const ch = chassisOf(v);
    const kinds: Record<string, number> = {};
    for (const s of ch.sockets) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
    return {
      uid: v.uid, proto: v.protoId, template: ch.template, why: ch.why, body: chassisBodyRect(v), sockets: kinds,
      seats: chassisSeats(v).map((s) => ({ part: s.part.def.id, mount: [s.mx, s.my], at: [+s.x.toFixed(3), +s.y.toFixed(3)], h: +s.h.toFixed(3), driver: s.driver })),
      overflow: ch.overflow.map((o) => `${o.part.def.id} @ ${o.part.mx},${o.part.my}: ${o.reason}`),
    };
  };
  /** Templates of every vehicle in the world: { template: count }, plus the overflow total. */
  api.chassisCensus = () => {
    const out: Record<string, number> = {};
    let overflow = 0;
    for (const v of vs.list) {
      const ch = chassisOf(v);
      out[ch.template] = (out[ch.template] ?? 0) + 1;
      overflow += ch.overflow.length;
    }
    return { templates: out, overflow, migrated: vs.migrated };
  };
  /**
   * Your body seated at the wheel in the chase / top-down cameras (3D characters; default on).
   * Off = the old look: the survivor hidden while driving. No argument = current.
   */
  api.vehicleRiders = (on?: boolean) => {
    if (on !== undefined && typeof on !== 'boolean') throw new Error(`vehicleRiders: true or false, not ${String(on)}`);
    if (!rendererRef) throw new Error('vehicleRiders: no renderer (installVehicles not run)');
    const slot = riderSlot(rendererRef);
    if (on !== undefined) slot.enabled = on;
    return slot.enabled;
  };
}

/** 'gasoline' -> 'Gasoline' (a clipped 'gaso' read like a typo on the dashboard). */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
