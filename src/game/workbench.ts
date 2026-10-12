import type { GameData } from '../data/types';
import type { GameMap } from '../world/map';
import type { Item } from './item';
import type { PlayerAvatar } from './player';
import type { VehicleSystem } from './vehicles';
import { has, type Vehicle, type VehiclePart } from './vehicle';
import { vehicleFacilityReason } from './vehicleFacilities';
import { CRAFT_RANGE } from './crafting_inv';

// Crafting workbenches after BN crafting.cpp (find_best_bench, crafting::best_bench_here,
// workbench_crafting_speed_multiplier) and activity_speed_adapters.cpp (lerped_multiplier).
// A bench multiplies crafting speed; a craft heavier or bulkier than the bench allows slows
// linearly to 25% at 1000 kg / 1000 L. Holding the craft uses f_fake_bench_hands, working on
// the ground f_ground_crafting_spot. Furniture "workbench" and vehicle WORKBENCH parts nearby
// compete. Reach is the crafting inventory's CRAFT_RANGE square (BN floods PICKUP_RANGE),
// and vehicle benches use the v3 facility access rule (driver's seat, or parked and near).

export interface WorkbenchInfo {
  multiplier: number;
  /** grams the bench takes before slowing down */
  mass: number;
  /** ml the bench takes before slowing down */
  volume: number;
}

export type BenchType = 'hands' | 'ground' | 'furniture' | 'vehicle';

export interface Bench {
  type: BenchType;
  info: WorkbenchInfo;
  /** Speed multiplier for the craft it was chosen for (bench multiplier × mass/volume slowdown). */
  multiplier: number;
  name: string;
  x: number;
  y: number;
  z: number;
  vehicle?: Vehicle;
  part?: VehiclePart;
}

export interface BenchHost {
  data: GameData;
  map: GameMap;
  player: PlayerAvatar;
  vehicles?: VehicleSystem | null;
}

/** What the bench is weighed against: an in-progress craft, or a recipe result for previews. */
export interface CraftBulk {
  mass: number;
  volume: number;
}

/** BN lerps the slowdown up to these (1000_kilogram, 1000_liter). */
const MAX_MASS = 1_000_000, MAX_VOLUME = 1_000_000;

/** activity_speed_adapters.cpp lerped_multiplier. */
export function lerpedMultiplier(value: number, low: number, high: number): number {
  if (value < low) return 1;
  if (value > high) return 0.25;
  // value == low == high (the ground spot's 1000 kg) would divide by zero; BN gets 1 there.
  if (high <= low) return 1;
  return 1 + ((value - low) * (0.25 - 1)) / (high - low);
}

/** workbench_crafting_speed_multiplier for a bench's info. */
export function benchSpeed(bulk: CraftBulk, info: WorkbenchInfo): number {
  return info.multiplier * lerpedMultiplier(bulk.mass, info.mass, MAX_MASS) * lerpedMultiplier(bulk.volume, info.volume, MAX_VOLUME);
}

/** furn_workbench_info: defaults are multiplier 1 and unlimited mass/volume (mapdata.cpp). */
export function furnitureWorkbench(f: object | undefined): WorkbenchInfo | null {
  const wb = (f as { workbench?: unknown } | undefined)?.workbench as { multiplier?: number; mass?: number; volume?: number } | undefined;
  if (!wb || typeof wb !== 'object') return null;
  return { multiplier: wb.multiplier ?? 1, mass: wb.mass ?? Infinity, volume: wb.volume ?? Infinity };
}

function fakeBench(data: GameData, id: string): WorkbenchInfo {
  const info = furnitureWorkbench(data.furniture[id]);
  if (!info) throw new Error(`workbench: ${id} has no workbench data`);
  return info;
}

/** Intact WORKBENCH part with workbench data that the player can use right now. */
function usableVehicleBench(host: BenchHost, v: Vehicle, part: VehiclePart): WorkbenchInfo | null {
  if (!has(part, 'WORKBENCH') || part.hp <= 0) return null;
  if (!part.def.workbench) throw new Error(`workbench: vehicle part ${part.def.id} has WORKBENCH but no workbench data`);
  return vehicleFacilityReason(host, v, part, 'WORKBENCH') ? null : part.def.workbench;
}

/** BN find_best_bench's can_lift: can wield it and carry its weight. */
export function canLiftCraft(host: BenchHost, item: Item): boolean {
  return host.player.inv.canWield(item).ok && host.player.inv.weightCapacity() >= item.weight();
}

/**
 * find_best_bench: best_bench_here at your feet compares each bench's speed for this craft;
 * benches in reach then win on their raw multiplier alone, as in BN. The returned multiplier
 * is the chosen bench's speed for this craft (workbench_crafting_speed_multiplier).
 */
export function findBestBench(host: BenchHost, bulk: CraftBulk, canLift: boolean): Bench {
  const p = host.player;
  const tx = Math.floor(p.x), ty = Math.floor(p.y), z = p.z;
  const make = (type: BenchType, info: WorkbenchInfo, name: string, x: number, y: number, extra: Partial<Bench> = {}): Bench =>
    ({ type, info, multiplier: benchSpeed(bulk, info), name, x, y, z, ...extra });

  let best = make('ground', fakeBench(host.data, 'f_ground_crafting_spot'), 'the ground', tx, ty);
  if (canLift) {
    const hands = make('hands', fakeBench(host.data, 'f_fake_bench_hands'), 'your hands', tx, ty);
    if (hands.multiplier > best.multiplier) best = hands;
  }
  const furnHere = host.map.furnAt(tx, ty, z);
  const furnHereInfo = furnitureWorkbench(furnHere);
  if (furnHereInfo) {
    const b = make('furniture', furnHereInfo, furnHere.name, tx, ty);
    if (b.multiplier > best.multiplier) best = b;
  }
  const on = host.vehicles?.occupantAt(p.x, p.y, z);
  if (on) {
    for (const part of on.v.partsAt(on.mx, on.my)) {
      const info = usableVehicleBench(host, on.v, part);
      if (!info) continue;
      const b = make('vehicle', info, `${part.def.name} (${on.v.name})`, tx, ty, { vehicle: on.v, part });
      if (b.multiplier > best.multiplier) best = b;
      break;
    }
  }

  // Benches in reach: BN compares their raw multiplier with the best speed found at your feet.
  let bestRaw = best.multiplier;
  for (let dy = -CRAFT_RANGE; dy <= CRAFT_RANGE; dy++)
    for (let dx = -CRAFT_RANGE; dx <= CRAFT_RANGE; dx++) {
      const f = host.map.furnAt(tx + dx, ty + dy, z);
      const info = furnitureWorkbench(f);
      if (info && info.multiplier > bestRaw) {
        best = make('furniture', info, f.name, tx + dx, ty + dy);
        bestRaw = info.multiplier;
      }
    }
  for (const v of host.vehicles?.list ?? []) {
    if (v.z !== z) continue;
    for (const part of v.parts) {
      const info = has(part, 'WORKBENCH') ? usableVehicleBench(host, v, part) : null;
      if (!info || info.multiplier <= bestRaw) continue;
      const [wx, wy] = v.mountToWorld(part.mx, part.my);
      best = make('vehicle', info, `${part.def.name} (${v.name})`, Math.floor(wx), Math.floor(wy), { vehicle: v, part });
      bestRaw = info.multiplier;
    }
  }
  return best;
}

/** The bench for an in-progress craft item (its components' mass and volume). */
export function craftBench(host: BenchHost, craft: Item): Bench {
  return findBestBench(host, { mass: craft.weight(), volume: craft.volume() }, canLiftCraft(host, craft));
}

/**
 * crafting_speed_multiplier's bench refusal: a bench speed of 10% or less, or of a third or
 * less when the whole speed is 20% or less, means the craft is too big to work on.
 */
export function benchTooSlow(benchMultiplier: number, totalMultiplier: number): boolean {
  return benchMultiplier <= 0.1 || (benchMultiplier <= 0.33 && totalMultiplier <= 0.2);
}
