import type { Item } from './item';
import type { PlayerAvatar } from './player';
import type { VehicleSystem } from './vehicles';
import { has, type Vehicle, type VehiclePart } from './vehicle';

// Sleeping in a vehicle, after BN character_functions.cpp base_comfort_value (vehicle branch),
// avatar_functions.cpp try_to_sleep (vehicle messages) and Character::floor_bedding_warmth /
// floor_item_warmth. BN rates the tile you lie on: the comfort of its first intact BOARDABLE
// part (bed 4, reclining seat 3, seat 2, aisle 0), or minus the tile's move cost when nothing
// there is boardable. Vehicles v3 ("facilities from your seat") lets you use any of the
// vehicle's beds and seats from where you are, as if you'd walked there, so the spot is the
// most comfortable SEAT/BED mount of the vehicle you're in; you don't physically move.
// Nobody else can drive, so you have to stop before lying down.

/** Faster than this (m/s) the vehicle counts as moving (vehicleFacilityReason uses the same). */
export const SLEEP_MOVING_EPS = 0.05;

export interface VehicleSleepSpot {
  v: Vehicle;
  mx: number;
  my: number;
  /** BN comfort sum for the mount (raw, like comfortAt's furniture comfort). */
  comfort: number;
  /** The first intact BOARDABLE part, which supplies comfort and bedding warmth. */
  board: VehiclePart | null;
  /** An intact SEAT or BED is there: BN's "This is a comfortable place to sleep." */
  comfortable: boolean;
  /** "bed in the pickup truck" */
  on: string;
  /** The vehicle is moving: you can't lie down, and a sleeper is woken. */
  moving: boolean;
}

interface Host {
  player: PlayerAvatar;
  vehicles?: VehicleSystem | null;
}

/** The vehicle you're in: at its controls, or standing/sitting on one of its mounts. */
export function vehicleYouAreIn(game: Host): { v: Vehicle; mx: number; my: number } | null {
  const vs = game.vehicles;
  if (!vs) return null;
  const p = game.player;
  const on = vs.occupantAt(p.x, p.y, p.z);
  if (vs.driving && vs.list.includes(vs.driving)) {
    if (on && on.v === vs.driving) return on;
    const s = vs.driving.driverSeat();
    if (s) return { v: vs.driving, mx: s.mx, my: s.my };
  }
  return on;
}

/** base_comfort_value for lying on mount (mx, my) of `v`. */
export function vehicleMountSpot(v: Vehicle, mx: number, my: number, moving = Math.abs(v.velocity) > SLEEP_MOVING_EPS): VehicleSleepSpot {
  const parts = v.partsAt(mx, my);
  const board = parts.find((q) => q.hp > 0 && has(q, 'BOARDABLE')) ?? null;
  const comfort = board ? board.def.comfort ?? 0 : -v.moveCostAt(mx, my);
  const comfortable = parts.some((q) => q.hp > 0 && (has(q, 'SEAT') || has(q, 'BED')));
  const named = parts.find((q) => q.hp > 0 && (has(q, 'BED') || has(q, 'SEAT'))) ?? parts.find((q) => q.hp > 0 && has(q, 'AISLE')) ?? board;
  return { v, mx, my, comfort, board, comfortable, on: named ? `${named.def.name} in the ${v.name}` : `the ${v.name}`, moving };
}

/**
 * The spot you'd sleep on in the vehicle you're in, or null when you're not in one: the most
 * comfortable mount with an intact seat or bed, else where you are. Ties keep your own mount,
 * then beds before seats.
 */
export function vehicleSleepSpot(game: Host): VehicleSleepSpot | null {
  const here = vehicleYouAreIn(game);
  if (!here) return null;
  const { v } = here;
  let best = vehicleMountSpot(v, here.mx, here.my);
  const bed = (s: VehicleSleepSpot) => v.partsAt(s.mx, s.my).some((q) => q.hp > 0 && has(q, 'BED'));
  const seen = new Set<string>([`${here.mx},${here.my}`]);
  for (const q of v.parts) {
    const k = `${q.mx},${q.my}`;
    if (seen.has(k) || q.hp <= 0 || !(has(q, 'SEAT') || has(q, 'BED'))) continue;
    seen.add(k);
    const s = vehicleMountSpot(v, q.mx, q.my);
    const better = !best.comfortable || s.comfort > best.comfort || (s.comfort === best.comfort && bed(s) && !bed(best));
    if (better) best = s;
  }
  return best;
}

/**
 * try_to_sleep's vehicle messages. BN returns before lying down on a vehicle tile with no seat,
 * bed or aisle ("It's hard to get to sleep in %s."): `refuse` carries that.
 */
export function vehicleSleepMessage(s: VehicleSleepSpot): { text: string; good: boolean; refuse: boolean } {
  if (s.comfortable) return { text: 'This is a comfortable place to sleep.', good: true, refuse: false };
  const aisle = s.v.partsAt(s.mx, s.my).find((q) => q.hp > 0 && has(q, 'AISLE'));
  if (aisle) return { text: `It's a little hard to get to sleep on this ${aisle.def.name} in the ${s.v.name}.`, good: false, refuse: false };
  return { text: `It's hard to get to sleep in the ${s.v.name}.`, good: false, refuse: true };
}

/** Character::floor_item_warmth's per-item rule (big torso/leg armor items keep you warm), °C. */
export function itemsFloorWarmth(items: Iterable<Item>): number {
  let w = 0;
  for (const it of items) {
    const vol = it.def.volume ?? 0;
    const covers = (it.def.armor ?? []).some((a) => (a.covers ?? []).some((c: string) => c === 'torso' || c === 'leg_l' || c === 'leg_r'));
    if (vol > 250 && covers) w += 0.12 * (it.def.warmth ?? 0) * (vol / 2500);
  }
  return w;
}

/**
 * floor_bedding_warmth for the boardable part (legacy units, 500 = 1 °C; −4 °C with nothing
 * boardable) and floor_item_warmth from the mount's cargo, in °C.
 */
export function vehicleBedding(s: VehicleSleepSpot): { bedding: number; items: number } {
  const bedding = s.board ? (s.board.def.floor_bedding_warmth ?? 0) / 500 : -4;
  const cargo = s.v.partsAt(s.mx, s.my).find((q) => has(q, 'CARGO'));
  return { bedding, items: cargo ? itemsFloorWarmth(cargo.items) : 0 };
}
