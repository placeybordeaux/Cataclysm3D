import type { Game } from './game';
import type { Character } from './character';
import type { GameData } from '../data/types';
import { ACTION_SCALE } from '../core/time';
import { LEVEL_HEIGHT } from '../world/coords';
import { has, turretGun, VMIPH_PER_MS, type Vehicle, type VehiclePart } from './vehicle';
import { ammoRequired, currentMode, upsDrain } from './gunmods';
import { bodyLocs, L, moveItem, transaction, type Loc } from './moves';
import type { Item } from './item';
import type { Vec3 } from './aimmodel';
import { gunRecoil } from './combat';

// Vehicle turrets (BN src/vehicle/turret.cpp, avatar_action.cpp fire_turret_manual / reload,
// vehicle_functions.cpp, ranged.cpp fire_gun). A TURRET part's base item is a real gun (BN
// vehicle_part::base, here VehiclePart.gun) flagged VEHICLE: it holds its own rounds or belt,
// ignores NO_RELOAD, and draws ups_charges from the vehicle's batteries instead of a carried UPS.
//
// What BN does, and what this port keeps:
//  - turret_data::query: ready / no_ammo / no_power (USE_TANKS turrets feed from the vehicle's
//    tanks). Kept as `turretStatus`.
//  - Manual fire (handle_action.cpp fire(): unarmed, standing on the turret's tile): the
//    *survivor* shoots it with their own skills (fire_turret_manual -> turret.fire(you)), with
//    their recoil zeroed for the shot and restored after (prepare_fire / post_fire: "turrets are
//    subject only to recoil_vehicle()", |velocity in vmiph| * 3 / 100 MOA). Here: at a gunner
//    station (a seat on a turret's cell, vehwalk.ts) `e` mans the gun; it becomes the active
//    weapon (bionicguns.ts activeWeapon) and the ordinary free-aim pipeline fires it from the
//    muzzle. The station is the turret's tile, so any gun can be manned from its seat.
//  - At the controls (CONTROLS on your tile and a TURRET on the vehicle) BN `f` aims every
//    turret in manual targeting mode that isn't a MANUAL mount at one target, each fired by a
//    fake targeting NPC (gun skill 10, marksmanship 5, Per 15, Dex 10, Str 20). `volley` below.
//  - Reload (avatar_action.cpp reload(): standing on a turret that can_reload): any ammo or
//    magazine the gun takes from what you carry or within 1 tile (character_funcs::
//    find_ammo_items_or_mags with range 1: here the vehicle's cargo within one cell of the
//    turret), at Character::item_reload_cost. BN asks which round; here `r` loads the preferred
//    round type (`fire_mode` at a single-mode gun picks it, BN turret_data::ammo_select).
//  - Autoloaders (vehicle_funcs::try_autoload_turret) and automatic targeting aren't modelled.
// Real time: reload moves become seconds like the hand-held reload (feel.ts), and the turret
// traverses toward where you look at its own rate (the shot waits for the barrel to come round).

export type TurretStatus = 'ready' | 'no_ammo' | 'no_power' | 'invalid';

/** BN vehicle::is_manual_turret: a MANUAL part (simple turret mount) on the turret's cell. */
export function isManualTurret(v: Vehicle, p: VehiclePart): boolean {
  return v.partsAt(p.mx, p.my).some((q) => has(q, 'MANUAL'));
}

/** The intact turrets of a vehicle (BN vehicle::turrets(): not broken, base is a gun). */
export function turretsOf(v: Vehicle): VehiclePart[] {
  return v.parts.filter((p) => has(p, 'TURRET') && p.hp > 0);
}

/** The turret on a cell (heaviest first, as vehwalk's gunAt). */
export function turretAt(v: Vehicle, mx: number, my: number): VehiclePart | null {
  return v.partsAt(mx, my).filter((p) => has(p, 'TURRET') && p.hp > 0).sort((a, b) => b.def.weight - a.def.weight)[0] ?? null;
}

/** USE_TANKS turrets (flamethrowers, water cannon): the tank fuel they'd fire (turret_data::ammo_current). */
export function tankAmmo(v: Vehicle, p: VehiclePart, gun: Item): string | null {
  if (!has(p, 'USE_TANKS')) return null;
  const types = new Set(gun.ammoTypes());
  const need = Math.max(1, ammoRequired(gun));
  const fuels = [...new Set(v.parts.filter((q) => q.fuelType && q.hp > 0).map((q) => q.fuelType!))];
  return fuels.find((f) => {
    const t = gun.data.items[f]?.ammo_type;
    return (Array.isArray(t) ? t : [t]).some((x) => typeof x === 'string' && types.has(x)) && v.fuelLeft(f) >= need;
  }) ?? null;
}

/** BN turret_data::query. */
export function turretStatus(v: Vehicle, p: VehiclePart, data: GameData): TurretStatus {
  const gun = p.hp > 0 ? turretGun(p, data) : null;
  if (!gun) return 'invalid';
  if (has(p, 'USE_TANKS')) {
    if (!tankAmmo(v, p, gun)) return 'no_ammo';
  } else if (ammoRequired(gun) > 0 && gun.ammoRemaining() < ammoRequired(gun)) return 'no_ammo';
  const ups = upsDrain(gun) * currentMode(gun).qty;
  if (ups > v.fuelLeft('battery')) return 'no_power';
  return 'ready';
}

/** BN ranged::recoil_vehicle: |velocity| (vmiph) * 3 / 100, in MOA. */
export function vehicleRecoilMoa(v: Vehicle): number {
  return (Math.abs(v.velocity) * VMIPH_PER_MS * 3) / 100;
}

// ------------------------------------------------------------------ geometry and aim

/** A main gun (tank gun, howitzer, autocannon) rather than a machine gun on a pintle: by mass, as vehicleTank.ts. */
export function isMainGun(p: VehiclePart): boolean {
  return p.def.weight >= 80_000;
}

/** Traverse / elevation rates (deg/s) and elevation limits (deg). An M1 turret slews ~40 deg/s; pintle MGs swing by hand. */
export function slewOf(p: VehiclePart): { traverse: number; elevate: number; minPitch: number; maxPitch: number } {
  return isMainGun(p) ? { traverse: 45, elevate: 25, minPitch: -9, maxPitch: 20 } : { traverse: 180, elevate: 120, minPitch: -15, maxPitch: 60 };
}

/** Where a turret points: world yaw (game: 0 north, clockwise, rad) and pitch (rad, up +). */
export interface TurretAim {
  yaw: number;
  pitch: number;
  /** What it's being slewed toward (null = holding). */
  want: { yaw: number; pitch: number } | null;
  /** Seconds since the last shot (the renderer's barrel recoil and flash). */
  sinceShot: number;
  shots: number;
}


/** Hull heading as a game yaw (vehicle facing 0 = east). */
export function hullYaw(v: Vehicle): number {
  return ((v.facing + 90) * Math.PI) / 180;
}

/** The turret's aim state; a fresh one points down the hull, level. */
export function turretAim(v: Vehicle, p: VehiclePart): TurretAim {
  return (p.aim ??= { yaw: hullYaw(v), pitch: 0, want: null, sinceShot: Infinity, shots: 0 });
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Slew every turret of `v` toward its `want` (the hull turning under a holding turret carries it along). */
export function slewTurrets(v: Vehicle, dt: number, hullTurn: number): void {
  for (const p of turretsOf(v)) {
    const a = p.aim;
    if (!a) continue;
    a.sinceShot += dt;
    if (!a.want) {
      a.yaw = wrap(a.yaw + hullTurn);
      continue;
    }
    const s = slewOf(p);
    const dy = wrap(a.want.yaw - a.yaw), maxY = (s.traverse * Math.PI / 180) * dt;
    a.yaw = wrap(a.yaw + Math.max(-maxY, Math.min(maxY, dy)));
    const wp = Math.max(s.minPitch, Math.min(s.maxPitch, (a.want.pitch * 180) / Math.PI)) * Math.PI / 180;
    const dp = wp - a.pitch, maxP = (s.elevate * Math.PI / 180) * dt;
    a.pitch += Math.max(-maxP, Math.min(maxP, dp));
  }
}

/** How far (rad) the barrel is from where it's wanted. */
export function aimError(a: TurretAim): number {
  if (!a.want) return 0;
  return Math.hypot(wrap(a.want.yaw - a.yaw), a.want.pitch - a.pitch);
}

/**
 * Renderer hooks (render/vehicleTank.ts + vehicleMesh.ts): the drawn muzzle and pivot heights.
 * Without a renderer (tests, the sim) the estimate below is used: the M1's turret roof is
 * 2.35 m, its gun trunnion ~1.9 m with a 5.6 m barrel; a pintle MG sits 0.4 m over the roof.
 */
export const turretHooks: {
  muzzle?: (v: Vehicle, p: VehiclePart) => Vec3 | null;
} = {};

/** World position of the muzzle (x, y tiles, h absolute metres). */
export function muzzleOf(v: Vehicle, p: VehiclePart): Vec3 {
  const hooked = turretHooks.muzzle?.(v, p);
  if (hooked) return hooked;
  const a = turretAim(v, p);
  const [x, y] = v.mountToWorld(p.mx, p.my);
  const main = isMainGun(p);
  const pivotH = main ? 1.9 : 2.75, len = main ? 5.6 : 1.1;
  const c = Math.cos(a.pitch);
  return { x: x + Math.sin(a.yaw) * len * c, y: y - Math.cos(a.yaw) * len * c, h: v.z * LEVEL_HEIGHT + pivotH + Math.sin(a.pitch) * len };
}

// ------------------------------------------------------------------ ammo and reload

/** Where ammo for a turret can come from: what you carry, then cargo within one cell of the turret (BN range 1). */
export function ammoSources(v: Vehicle, p: VehiclePart, who: Character): Loc[] {
  const out: Loc[] = bodyLocs(who);
  for (const q of v.parts) {
    if (!has(q, 'CARGO') || Math.max(Math.abs(q.mx - p.mx), Math.abs(q.my - p.my)) > 1) continue;
    out.push(L.cargo(q, v));
  }
  return out;
}

/** Every item at `locs`, with nested contents (ammo boxes, magazines in a bag). */
function walk(locs: Loc[]): { item: Item; loc: Loc; cargo: boolean }[] {
  const out: { item: Item; loc: Loc; cargo: boolean }[] = [];
  const visit = (loc: Loc, list: readonly Item[], cargo: boolean) => {
    for (const it of list) {
      out.push({ item: it, loc, cargo });
      if (it.contents.length) visit(L.in(it), it.contents, cargo);
      if (it.magazine) visit(L.mag(it), [it.magazine], cargo);
    }
  };
  for (const loc of locs) {
    switch (loc.kind) {
      case 'hands': visit(loc, loc.who.inv.wielded ? [loc.who.inv.wielded] : [], false); break;
      case 'worn': visit(loc, loc.who.inv.worn, false); break;
      case 'inv': visit(loc, loc.who.inv.items, false); break;
      case 'cargo': visit(loc, loc.part.items, true); break;
      default: break;
    }
  }
  return out;
}

/** The round types within reach that the gun takes (for the panel and `fire_mode`). */
export function ammoChoices(v: Vehicle, p: VehiclePart, gun: Item, who: Character): { id: string; name: string; count: number }[] {
  const by = new Map<string, { id: string; name: string; count: number }>();
  const host = gun.magazine ?? gun;
  for (const { item, loc } of walk(ammoSources(v, p, who))) {
    if (loc.kind === 'in' && loc.host === gun) continue;
    let id: string | null = null, n = 0;
    if (item.isAmmo() && host.acceptsAmmo(item)) (id = item.typeId), (n = item.charges);
    else if (item.isMagazine() && item !== gun.magazine && gun.acceptsMagazine(item) && item.ammoRemaining() > 0) (id = item.ammoData()?.id ?? null), (n = item.ammoRemaining());
    if (!id) continue;
    const e = by.get(id) ?? { id, name: gun.data.items[id]?.name ?? id, count: 0 };
    e.count += n;
    by.set(id, e);
  }
  return [...by.values()];
}

/** Preferred round type per turret (BN vehicle_part::ammo_pref, saved with the part). */
export function ammoPref(p: VehiclePart): string | undefined {
  return p.ammoPref;
}
export function setAmmoPref(p: VehiclePart, id: string): void {
  p.ammoPref = id;
}

export interface TurretReload {
  ok: boolean;
  msg: string;
  /** BN moves the reload costs. */
  moves: number;
  /** Real seconds before the gun can fire again. */
  seconds: number;
}

/** Character::item_reload_cost for the turret's gun (BN, character.cpp), plus obtain cost 100 from cargo. */
function reloadMoves(who: Character, gun: Item, ammo: Item, qty: number, fromCargo: boolean): number {
  let mv = Math.min(200, Math.floor((ammo.isMagazine() ? ammo.volume() : ammo.unitVolume() * qty) / 20));
  if (ammo.hasFlag('MAG_BULKY')) mv *= 1.5;
  const per = gun.def.reload ?? 100;
  const skill = String(gun.def.skill ?? 'gun');
  mv += per / (1 + Math.min(who.getSkill(skill) * 0.1, 1));
  // STR_RELOAD: Str over 10 speeds it, down to 25%.
  if (gun.hasFlag('STR_RELOAD')) mv *= Math.max(10 / Math.max(10, who.str), 0.25);
  return Math.max(25, Math.round(mv)) + (fromCargo ? 100 : 0);
}

/** Reload moves as real seconds (the hand-held reload's scale, feel.ts): a tank round takes a few seconds. */
export function reloadSeconds(moves: number): number {
  return Math.max(1, Math.min(6, (moves / 100 / ACTION_SCALE) * 2));
}

/**
 * Reload the turret `p` (BN avatar_action::reload on a turret tile): rounds into an integral
 * magazine (the 120 mm takes one), or a fuller magazine / belt into a magazine-fed gun (the old
 * one goes to your inventory, else back to the cargo it came from), else top up its belt from
 * loose rounds. Everything moves through moves.ts.
 */
export function reloadTurret(v: Vehicle, p: VehiclePart, who: Character): TurretReload {
  const data = who.data;
  const gun = turretGun(p, data);
  const no = (msg: string): TurretReload => ({ ok: false, msg, moves: 0, seconds: 0 });
  if (!gun || p.hp <= 0) return no(`The ${p.def.name} is wrecked.`);
  if (has(p, 'USE_TANKS')) return no(`The ${p.def.name} feeds from the ${v.name}'s tanks.`);
  if (ammoRequired(gun) <= 0) return no(`The ${p.def.name} runs on the ${v.name}'s batteries; it takes no ammunition.`);
  const sources = ammoSources(v, p, who);
  const all = walk(sources).filter(({ loc }) => !(loc.kind === 'in' && loc.host === gun) && !(loc.kind === 'mag' && loc.host === gun));
  const pref = ammoPref(p);
  const name = gun.baseName();
  if (gun.takesMagazines()) {
    const cur = gun.magazine;
    const mags = all.filter(({ item }) => item.isMagazine() && item !== cur && gun.acceptsMagazine(item) && item.ammoRemaining() > 0)
      .sort((a, b) => Number(b.item.ammoData()?.id === pref) - Number(a.item.ammoData()?.id === pref) || b.item.ammoRemaining() - a.item.ammoRemaining());
    const best = mags[0];
    if (best && best.item.ammoRemaining() > (cur?.ammoRemaining() ?? -1)) {
      const r = transaction(() => {
        if (cur) {
          let away = moveItem(cur, L.mag(gun), L.inv(who), { actor: who, quiet: true });
          if (!away.ok && best.loc.kind === 'cargo') away = moveItem(cur, L.mag(gun), best.loc, { actor: who, quiet: true, force: true });
          if (!away.ok) return away;
        }
        return moveItem(best.item, best.loc, L.mag(gun), { actor: who, quiet: true });
      });
      if (!r.ok) return no(r.msg || `You can't load the ${name}.`);
      const moves = reloadMoves(who, gun, best.item, 1, best.cargo);
      return { ok: true, msg: `You feed a ${best.item.baseName()} into the ${name}.`, moves, seconds: reloadSeconds(moves) };
    }
    if (cur && cur.ammoRemaining() < cur.ammoCapacity()) return fillFrom(cur, gun, all, who, name, pref);
    if (cur) return no(`The ${name} is already fully loaded!`);
    return no(`You have no ${gun.magazineCompatible().map((m) => data.items[m]?.name ?? m).join(' or ')} for the ${name} within reach.`);
  }
  if (gun.ammoRemaining() >= gun.ammoCapacity()) return no(`The ${name} is already loaded!`);
  return fillFrom(gun, gun, all, who, name, pref);
}

function fillFrom(target: Item, gun: Item, all: { item: Item; loc: Loc; cargo: boolean }[], who: Character, name: string, pref?: string): TurretReload {
  const loaded = target.ammoRemaining() > 0 ? target.ammoData()?.id : undefined;
  const rounds = all
    .filter(({ item, loc }) => item.isAmmo() && item.charges > 0 && target.acceptsAmmo(item) && !(loc.kind === 'in' && loc.host.isMagazine()))
    .filter(({ item }) => !loaded || item.typeId === loaded)
    .sort((a, b) => Number(b.item.typeId === pref) - Number(a.item.typeId === pref) || Number(a.cargo) - Number(b.cargo) || b.item.charges - a.item.charges);
  let moved = 0, moves = 0;
  let what: Item | null = null;
  for (const { item, loc, cargo } of rounds) {
    if (target.ammoRemaining() >= target.ammoCapacity()) break;
    if (what && item.typeId !== what.typeId) continue;
    const probe = item;
    const r = moveItem(item, loc, L.in(target), { partial: true, actor: who, quiet: true });
    if (!r.ok) continue;
    what ??= probe;
    moved += r.moved;
    moves += reloadMoves(who, gun, probe, r.moved, cargo);
  }
  if (!moved || !what) {
    const types = gun.ammoTypes().map((t) => gun.data.misc?.ammunition_type?.[t]?.name ?? t).join(' or ');
    return { ok: false, msg: `You have no ${types} rounds for the ${name} within reach (carried, or in the cargo next to it).`, moves: 0, seconds: 0 };
  }
  const n = moved === 1 ? `a ${what.def.name ?? what.typeId}` : `${moved} rounds of ${what.def.name ?? what.typeId}`;
  return { ok: true, msg: target === gun ? `You load ${n} into the ${name}.` : `You load ${n} into the ${name}'s ${target.baseName()}.`, moves, seconds: reloadSeconds(moves) };
}

// ------------------------------------------------------------------ manning (the gunner's session)

export interface TurretSession {
  v: Vehicle;
  part: VehiclePart;
  gun: Item;
  /** Game clock (combat time, s) until the gun is reloaded. */
  reloadLeft: number;
  reloadTotal: number;
  /** A click while the barrel was still coming round: fires when it's on target (s left to wait). */
  queued: number;
}

const sessions = new WeakMap<Game, TurretSession>();

export function turretSession(game: Game): TurretSession | null {
  return sessions.get(game) ?? null;
}

export function manTurret(game: Game, v: Vehicle, p: VehiclePart): TurretSession | null {
  const gun = turretGun(p, game.data);
  if (!gun || p.hp <= 0) return null;
  const s: TurretSession = { v, part: p, gun, reloadLeft: 0, reloadTotal: 0, queued: 0 };
  sessions.set(game, s);
  const a = turretAim(v, p);
  a.want = { yaw: game.player.yaw, pitch: game.player.pitch };
  return s;
}

export function leaveTurret(game: Game): TurretSession | null {
  const s = sessions.get(game) ?? null;
  if (!s) return null;
  sessions.delete(game);
  // An unmanned turret holds where it was left (and turns with the hull).
  turretAim(s.v, s.part).want = null;
  return s;
}

/** BN gun_recoil without the heavy-weapon check, for the view and aim kick of a mounted gun. */
export function mountedKick(p: VehiclePart, gun: Item, who: Character): { aimMoa: number; view: number } {
  // A mounted gun's recoil goes into the mount (BN zeroes the gunner's recoil): the aim jumps a
  // little, the 120 mm shakes the whole view.
  const raw = gunRecoil(who, gun);
  if (isMainGun(p)) return { aimMoa: Math.min(1500, raw), view: 1 };
  return { aimMoa: Math.min(120, raw * 0.04), view: Math.min(0.35, raw / 20000) };
}
