import type { Game } from './game';
import type { Rng } from '../core/rng';
import { has, type Vehicle, type VehiclePart } from './vehicle';

// What a blast or a fragment does to a vehicle part: Cataclysm-BN src/vehicle/vehicle.cpp
// `vehicle::damage`, `damage_direct` and `explode_fuel`, as explosion.cpp calls them
// (map::bash_vehicle → damage(part, strength, DT_BASH, aimed = true, random_part = true) once per
// multibash step; project_shrapnel → damage(part, impact × 0.25) on an impassable tile).
//
//  - damage: a random part on the struck mount takes it (a closed door shields a DOOR_MOTOR). If
//    the mount has an intact ARMOR part, the armour takes the full hit and the struck part the hit
//    less the armour's damage_reduction for that type (parts on the roof aren't covered).
//    Not aimed (unused by blasts): a mount with no closed OBSTACLE lets the hit fly through.
//  - damage_direct: a hit under min(20, durability / 10) does nothing; the part's own
//    damage_reduction comes off, the rest is HP (the port's VehicleSystem.damagePart, which also
//    stalls a dead engine, spills a destroyed tank and drops its cargo). A damaged fuel store may
//    explode (explode_fuel): one in `chance_cold` (bash) or `chance_hot` (heat) for its fuel's
//    explosion_data, power 120 × (1 − e^(factor / −5000 × charges × size_factor)) at distance
//    factor 0.7 (legacy explosion), and the tank is destroyed.
// Not modelled: break_off (an already broken part being torn off into pieces), so a broken part
// soaks the hit.

/** BN damage_type names as the port's damage units spell them (blasts bash; rounds stab or heat). */
export type VehDamageType = 'bash' | 'cut' | 'stab' | 'bullet' | 'heat';

/** BN resistances: the type's own value, else `physical`, else `all` (damage.cpp load_damage_map). */
export function partResist(part: VehiclePart, type: VehDamageType): number {
  const dr = part.def.damage_reduction;
  if (!dr) return 0;
  const physical = type !== 'heat';
  return dr[type] ?? (physical ? dr.physical : dr.non_physical) ?? dr.all ?? 0;
}

/** A fuel explosion for the caller to set off (legacy power, explosion.cpp explosion(p, power, 0.7, fire)). */
export interface FuelBlast {
  x: number;
  y: number;
  z: number;
  power: number;
  fire: boolean;
}

export interface VehicleHitOpts {
  /** BN `aimed` (default true): false lets the hit through a mount without a closed obstacle. */
  aimed?: boolean;
  /** BN `random_part` (default true): a random part on the mount takes the hit, else the first. */
  randomPart?: boolean;
  /** Fuel tanks that blew up (explode_fuel), for the caller's explosion queue. */
  fuelBlasts?: FuelBlast[];
}

/**
 * vehicle::damage on the mount (mx, my) of `v`: `dmg` of `type`. Returns the damage that got
 * through (BN's return value: what the armour or part didn't stop), `dmg` when nothing was hit.
 */
export function damageVehicleMount(game: Game, v: Vehicle, mx: number, my: number, dmg: number, type: VehDamageType, rng: Rng, o: VehicleHitOpts = {}): number {
  if (dmg < 1) return dmg;
  const pl = v.partsAt(mx, my);
  if (!pl.length) return dmg;
  if (o.aimed === false) {
    const obstacle = pl.some((p) => has(p, 'OBSTACLE') && (!has(p, 'OPENABLE') || !p.open));
    if (!obstacle) return dmg;
  }
  // vpart_position::part_index is the mount's first part (its frame, as BN lists them).
  const first = pl[0];
  let target = o.randomPart === false ? first : rng.pick(pl);
  if (has(target, 'DOOR_MOTOR')) {
    let best: VehiclePart | null = null;
    for (const p of pl) if (has(p, 'OPENABLE') && !p.open && (!best || p.def.durability > best.def.durability)) best = p;
    if (best) target = best;
  }
  const armor = pl.find((p) => has(p, 'ARMOR') && p.hp > 0);
  if (!armor) return damageDirect(game, v, target, dmg, type, rng, o.fuelBlasts);
  const protection = partResist(armor, type);
  const overhead = has(target, 'ROOF') || target.def.location === 'on_roof';
  damageDirect(game, v, target, overhead ? dmg : dmg - protection, type, rng, o.fuelBlasts);
  return damageDirect(game, v, armor, dmg, type, rng, o.fuelBlasts);
}

/** vehicle::damage_direct (no break_off): the part's threshold and resistance, then its HP. */
export function damageDirect(game: Game, v: Vehicle, part: VehiclePart, dmg: number, type: VehDamageType, rng: Rng, fuelBlasts?: FuelBlast[]): number {
  if (part.hp <= 0) return dmg;
  const tsh = Math.min(20, Math.trunc(part.def.durability / 10));
  if (dmg < tsh) {
    if (type === 'heat' && isFuelStore(part)) explodeFuel(game, v, part, type, rng, fuelBlasts);
    return 0;
  }
  const net = dmg - Math.min(dmg, partResist(part, type));
  const dres = net - part.hp;
  const vs = game.vehicles;
  if (!vs) throw new Error('damageDirect: no vehicle system');
  // damagePart takes a raw hit and subtracts the part's bash resistance itself: hand it the net
  // damage of this type plus that, so it takes exactly `net`.
  if (net > 0) vs.damagePart(v, part, net + vehicleSystemBashResist(part));
  if (isFuelStore(part)) explodeFuel(game, v, part, type, rng, fuelBlasts);
  return Math.max(dres, 0);
}

/** VehicleSystem.damagePart's own resistance (bash ?? all), added back so it takes `net` off. */
function vehicleSystemBashResist(part: VehiclePart): number {
  return part.def.damage_reduction?.bash ?? part.def.damage_reduction?.all ?? 0;
}

/** vehicle_part::is_fuel_store for what the port models: tanks and batteries with a fuel type. */
function isFuelStore(part: VehiclePart): boolean {
  return (has(part, 'FLUIDTANK') || has(part, 'BATTERY')) && !!(part.fuelType ?? part.def.fuel_type);
}

/**
 * vehicle::explode_fuel: the fuel's explosion_data (items' `fuel.explosion_data`) rolls one in
 * chance_cold for a bash (chance_hot for heat); the blast's power comes from what is still in the
 * tank (a tank the hit destroyed has already spilled: BN leaks it first, so its power is 0 and the
 * explosion is skipped here). The tank is destroyed and emptied.
 */
function explodeFuel(game: Game, v: Vehicle, part: VehiclePart, type: VehDamageType, rng: Rng, out?: FuelBlast[]): boolean {
  const fuelId = part.fuelType ?? part.def.fuel_type;
  const fuel = fuelId ? (game.data.items[fuelId] as { fuel?: { explosion_data?: FuelExplosionData } } | undefined) : undefined;
  const ed = fuel?.fuel?.explosion_data;
  if (!ed) return false;
  const chance = type === 'heat' ? ed.chance_hot : ed.chance_cold;
  if (!rng.oneIn(chance)) return true;
  const charges = part.hp > 0 ? part.charges : 0;
  const power = 120 * (1 - Math.exp((ed.factor / -5000) * (charges * ed.size_factor)));
  const [wx, wy] = v.mountToWorld(part.mx, part.my);
  if (power > 0) out?.push({ x: Math.floor(wx), y: Math.floor(wy), z: v.z, power, fire: ed.fiery });
  if (part.hp > 0) game.vehicles!.damagePart(v, part, part.hp + vehicleSystemBashResist(part));
  part.charges = 0;
  return true;
}

/** BN fuel_explosion (itype.h): explosion odds and size of a fuel. */
interface FuelExplosionData {
  chance_hot: number;
  chance_cold: number;
  factor: number;
  fiery: boolean;
  size_factor: number;
}

/**
 * How tall the vehicle on a tile is for a round flying through it (m above its level): a mount
 * with an intact obstacle or roof stands 1.6 m (doors, boards, cabins), any other 1.0 m (hoods,
 * beds, treads). The same heights look mode and the reticle ray use (ui/vehicle_ui.ts
 * vehicleSolidHeight), so a shot stops where the crosshair shows it touching the vehicle.
 * `skip` = a vehicle the shooter rides in (its own hull doesn't stop its rounds).
 */
export function vehicleHitHeight(game: Game, x: number, y: number, z: number, skip?: Vehicle | null): number {
  const o = game.vehicles?.at(x, y, z);
  if (!o || o.v === skip) return 0;
  const parts = o.v.partsAt(o.mx, o.my);
  if (!parts.length) return 0;
  return parts.some((p) => p.hp > 0 && (has(p, 'OBSTACLE') || has(p, 'ROOF'))) ? 1.6 : 1.0;
}
