import type { Game } from './game';
import type { MonsterSystem } from './monai';
import type { Monster } from './monster';
import type { Character } from './character';
import type { CreatureSize } from './combat';
import { applyFlatArmor } from './combat';
import type { BodyPartId } from './bodyparts';
import { addField, findField } from './fields';
import { bash } from './bash';
import { emitSound } from './sound';
import { asArray } from './item';
import { moveWithCollision } from './physics';
import { turnsToSeconds } from './monster';
import { damageVehicleMount, type FuelBlast } from './vehicleDamage';
import { warnOnce } from '../data/warn';

// The one explosion implementation (BN explosion.cpp ExplosionProcess, the default "new"
// explosions; OLD_EXPLOSIONS is off by default). Every blast goes through `detonate`: enemy
// grenades and launcher rounds (monguns.ts, npcai.ts via roundEndsAt), the survivor's and the
// turrets' explosive ammo and CUSTOM_EXPLOSION rounds (playercombat.ts ammoEffectsAt via the
// `blast` hook), land mines and booby traps (traps.ts), EXPLODE death functions (mondeath.ts) and
// vehicle fuel tanks that go up (vehicleDamage.ts explode_fuel).
//
// The rules, all from Cataclysm-BN src/explosion.cpp:
//  - data (load_explosion_data): new style `damage` + `radius` (tiles) + optional `fragment`
//    {impact, range}; legacy `power` → damage = power × 2/15 (power_to_dmg_mult), radius =
//    (power × 2/15)^¼ × ln 0.75 / ln distance_factor (blast_radius_from_legacy), and a legacy
//    `shrapnel` → a fragment of `damage` bullet ×3 armor out to 2 × radius (shrapnel_from_legacy).
//    ExplosionProcess takes damage and radius as ints: the radius is truncated (1.9 → 1).
//  - the affected block (fill_maps): z-levels within max(radius, fragment range) / 4
//    (Z_LEVEL_DIST); a tile is in the blast when lround(trig distance (3D) + 3 × |dz|) ≤ radius,
//    so only a blast of radius ≥ 4 reaches the level above or below (through its floor: BN's
//    is_occluded only looks for impassable tiles on the 3D line, floors don't stop it).
//  - fragments first (project_shrapnel, same level only, lround(distance) ≤ range, not occluded):
//    a creature there takes the impact, no roll (the survivor on every main part, others once;
//    fragment_effect `onfire` sets flammable or, one in `odds`, fleshy targets alight). An
//    impassable tile there is hit by impact × 0.25 (SHRAPNEL_OBSTACLE_REDUCTION): a vehicle part
//    through vehicle::damage, terrain and furniture as a bash (windows break).
//  - then the blast wave, nearest tile first (blast_tile), each tile skipped if occluded *at that
//    moment* (an impassable tile on the line before it: a wall the wave already broke no longer
//    shields what's behind it). A creature there takes damage × critter_blast_percentage (×1 within
//    half the radius, ×0.5 out to it, × size: tiny 0.5, small 0.8, medium 1, large 1.5, huge 2) at
//    the int-truncated distance: monsters and NPCs on the torso as bash with 0.4 armour
//    penetration, the survivor on six parts, rng(dmg × lo, dmg × hi) bash at an armour multiplier
//    (torso/head 0.5–1.0 ×0.5, limbs 0.75–1.25 ×0.4) — "You're caught in the explosion!".
//    Occupants of a vehicle are creatures on its tiles like any other: its closed doors and
//    boards are impassable, so they shield the people inside until the blast breaks them.
//  - flinging: a creature still alive after the blast gets velocity (radius − distance) × damage
//    × 40750 / (weight g × 100) tiles (MOB_FLING_FACTOR, EXPLOSION_CALIBRATION_POWER; over 30 it's
//    rng 30–50); at ≥ 1 it flies on the angle from the centre (±0.95 tile jitter), stopping at an
//    impassable tile or another creature, where it turns back with 0.3 of the speed it had left
//    (RESTITUTION_COEFF). No damage from the landing (BN's TODO).
//  - terrain and vehicles (multibash): starting at damage × obstacle_blast_percentage (1 / 0.5),
//    each tile is bashed again and again at a force falling by damage / 5 (MULTIBASH_COUNT 5,
//    VEHICLE_DAMAGE_MULT 2) until it reaches 0: up to five bashes. Each one hits the vehicle part
//    there (map::bash_vehicle → vehicle::damage(strength, bash): vehicleDamage.ts) and the terrain
//    and furniture (floors only when the tile below is open: bash_floor).
//  - fields: passable tiles within half the radius keep thin smoke (BN removes the outer half's
//    smoke after a delay); a `fire` blast leaves fire of 1 + (damage > 10) + (damage > 30).
//  - noise (explosion_funcs::regular): min(max(damage, fragment damage) + (fire ? 70 : 90), 191):
//    "a huge explosion!" from 180, "an explosion!" from 120, else "a loud pop!". After the blast,
//    "You are hit by the explosion/shrapnel, taking N damage." for each creature you see.
//  - explosions set off by an explosion (a fuel tank) wait in the queue until this one is done
//    (explosion_queue).
// Not modelled: items on blasted tiles (smash_items, item flinging), traps set off by the blast,
// fields removed after their delay (the end state is placed at once), obstructed_by_vehicle_rotation.

export interface BlastUnit {
  type: string;
  amount: number;
  armor_penetration: number;
  armor_multiplier: number;
}

export interface BlastData {
  /** Blast damage at the centre (BN explosion_data::damage). 0 for a fragment-only charge. */
  damage: number;
  /** Blast radius in tiles (float, as BN keeps it in explosion_data; the process truncates it). */
  radius: number;
  fire: boolean;
  fragment?: { impact: BlastUnit[]; range: number };
  /** BN fragment_effect: effects a fragment hit may set off ({effect, odds, min/max turns}). */
  fragmentEffect?: { effect: string; odds: number; minTurns: number; maxTurns: number }[];
}

/** explosion.cpp power_to_dmg_mult. */
export const POWER_TO_DMG = 2 / 15;

/** explosion.cpp ExplosionConstants. */
export const Z_LEVEL_DIST = 4;
export const SHRAPNEL_OBSTACLE_REDUCTION = 0.25;
export const MULTIBASH_COUNT = 5;
export const VEHICLE_DAMAGE_MULT = 2;
export const MOB_FLING_FACTOR = 40750;
export const EXPLOSION_CALIBRATION_POWER = 100;
export const FLING_THRESHOLD = 30;
export const FLING_MAX_RANGE = 50;
export const RESTITUTION_COEFF = 0.3;

type Json = Record<string, unknown>;

function units(raw: unknown): BlastUnit[] {
  return asArray(raw as Json | Json[] | undefined).map((u) => ({
    type: String(u.damage_type ?? 'bullet'),
    amount: Number(u.amount) || 0,
    armor_penetration: Number(u.armor_penetration) || 0,
    armor_multiplier: u.armor_multiplier === undefined ? 1 : Number(u.armor_multiplier),
  }));
}

/** load_explosion_data: a BN `explosion` object (new or legacy format) → BlastData; null if it has neither. */
export function blastFromJson(raw: unknown): BlastData | null {
  if (!raw || typeof raw !== 'object') return null;
  const jo = raw as Json;
  const fire = jo.fire === true;
  const fragmentEffect = asArray(jo.fragment_effect as Json | Json[] | undefined)
    .map((f) => ({ effect: String(f.effect ?? ''), odds: Number(f.odds) || 0, minTurns: Number(f.min_turns) || 0, maxTurns: Number(f.max_turns) || 0 }))
    .filter((f) => f.effect !== '' && f.odds > 0 && f.maxTurns > 0);
  const fx = fragmentEffect.length ? { fragmentEffect } : {};
  if (typeof jo.damage === 'number' || (jo.fragment && typeof jo.fragment === 'object')) {
    const fr = jo.fragment as Json | undefined;
    return {
      damage: typeof jo.damage === 'number' ? jo.damage : 0,
      radius: typeof jo.radius === 'number' ? jo.radius : 0,
      fire,
      fragment: fr ? { impact: units((fr.impact as Json | undefined) ?? fr.damage), range: Number(fr.range) || 0 } : undefined,
      ...fx,
    };
  }
  if (typeof jo.power !== 'number') return null;
  const power = jo.power;
  const factor = typeof jo.distance_factor === 'number' ? jo.distance_factor : 0.8;
  // explosion_data::damage is an int: the float product is truncated on assignment.
  const damage = Math.trunc(power * POWER_TO_DMG);
  const radius = blastRadiusFromLegacy(power, factor);
  const legacyShrapnel = typeof jo.shrapnel === 'number' || (jo.shrapnel && typeof jo.shrapnel === 'object');
  return {
    damage, radius, fire,
    fragment: legacyShrapnel ? shrapnelFromLegacy(power, radius) : undefined,
    ...fx,
  };
}

/** blast_radius_from_legacy (power is an int parameter there). */
export function blastRadiusFromLegacy(power: number, factor: number): number {
  return Math.pow(Math.trunc(power) * POWER_TO_DMG, 0.25) * (Math.log(0.75) / Math.log(factor));
}

/** shrapnel_from_legacy: bullet damage ≈ the blast's centre damage, ×3 armour, out to 2 × radius. */
export function shrapnelFromLegacy(power: number, radius: number): { impact: BlastUnit[]; range: number } {
  return { impact: [{ type: 'bullet', amount: Math.trunc(Math.trunc(power) * POWER_TO_DMG), armor_penetration: 0, armor_multiplier: 3 }], range: Math.trunc(2 * radius) };
}

/**
 * explosion_handler::explosion(p, source, power, factor, fire, casing_mass): the legacy call
 * (mondeath explode, vehicle fuel tanks) as BlastData. factor defaults to 0.8 (explosion.h).
 */
export function legacyBlast(power: number, factor = 0.8, fire = false, casingMass = 0): BlastData {
  if (factor >= 1) throw new Error(`legacyBlast: distance factor ${factor} >= 1 is an infinite blast`);
  const radius = blastRadiusFromLegacy(power, factor);
  return { damage: Math.trunc(power * POWER_TO_DMG), radius, fire, fragment: casingMass > 0 ? shrapnelFromLegacy(power, radius) : undefined };
}

/**
 * The blasts a round's ammo effects carry (BN apply_ammo_effects: every effect with an
 * `explosion`) plus its own `explosion` when it has CUSTOM_EXPLOSION (ballistics.cpp
 * get_custom_explosion). `table` is misc.ammo_effect.
 */
export function ammoBlasts(table: Record<string, { explosion?: unknown }> | undefined, effects: readonly string[], custom?: unknown): BlastData[] {
  const out: BlastData[] = [];
  for (const id of effects) {
    const b = blastFromJson(table?.[id]?.explosion);
    if (b) out.push(b);
  }
  if (effects.includes('CUSTOM_EXPLOSION')) {
    const b = blastFromJson(custom);
    if (b) out.push(b);
  }
  return out;
}

/** critter_blast_percentage: radius falloff × creature size. */
export function critterBlastPct(size: CreatureSize | string, radius: number, distance: number): number {
  const fall = distance > radius ? 0 : distance > radius / 2 ? 0.5 : 1;
  const bySize: Record<string, number> = { tiny: 0.5, small: 0.8, medium: 1, large: 1.5, huge: 2 };
  return (bySize[size] ?? 1) * fall;
}

/** obstacle_blast_percentage. */
export function obstacleBlastPct(radius: number, distance: number): number {
  return distance > radius ? 0 : distance > radius / 2 ? 0.5 : 1;
}

/**
 * The forces a blasted tile is bashed with (blast_tile's multibash): damage × obstacle percentage,
 * then down by damage × (VEHICLE_DAMAGE_MULT − 1) / MULTIBASH_COUNT while above 0, each truncated
 * to an int as bash_params::strength.
 */
export function multibashForces(damage: number, radius: number, distance: number): number[] {
  const decay = ((VEHICLE_DAMAGE_MULT - 1) * damage) / MULTIBASH_COUNT;
  const out: number[] = [];
  if (decay <= 0) return out;
  for (let f = damage * obstacleBlastPct(radius, distance); f > 0; f -= decay) out.push(Math.trunc(f));
  return out;
}

/**
 * Fling velocity (tiles) of a creature of `weightG` grams struck `distance` tiles from the centre
 * of a blast of `damage` and int `radius` (blast_tile "Fling creatures"). Over FLING_THRESHOLD it
 * rolls 30–50; under 1 it isn't flung.
 */
export function flingVelocity(damage: number, radius: number, distance: number, weightG: number, rng?: { next(): number }): number {
  const push = (radius - distance) * damage;
  const v = (MOB_FLING_FACTOR * push) / (Math.max(Math.trunc(weightG), 1) * EXPLOSION_CALIBRATION_POWER);
  if (v > FLING_THRESHOLD) return FLING_THRESHOLD + (rng ? rng.next() : 0) * (FLING_MAX_RANGE - FLING_THRESHOLD);
  return v;
}

/** The survivor's blast parts (blast_tile blast_parts): low / high damage multiplier, armor multiplier. */
export const BLAST_PARTS: readonly [BodyPartId, number, number, number][] = [
  ['torso', 0.5, 1, 0.5], ['head', 0.5, 1, 0.5],
  ['leg_l', 0.75, 1.25, 0.4], ['leg_r', 0.75, 1.25, 0.4], ['arm_l', 0.75, 1.25, 0.4], ['arm_r', 0.75, 1.25, 0.4],
];
const MAIN_PARTS: readonly BodyPartId[] = ['torso', 'head', 'arm_l', 'arm_r', 'leg_l', 'leg_r'];

/** explosion_funcs::regular noise and description. */
export function blastNoise(e: BlastData): { volume: number; text: string; variant: string } {
  const frag = e.fragment ? e.fragment.impact.reduce((s, u) => s + u.amount, 0) : 0;
  const base = e.fragment ? Math.max(e.damage, frag) : e.damage;
  const volume = Math.min(Math.trunc(base) + (e.fire ? 70 : 90), 191);
  if (volume >= 180) return { volume, text: 'a huge explosion!', variant: 'huge' };
  if (volume >= 120) return { volume, text: 'an explosion!', variant: 'default' };
  return { volume, text: 'a loud pop!', variant: 'small' };
}

/**
 * line_to (line.cpp bresenham with t = t2 = 0) from `a` to `b`, not including `a`: the tiles a
 * blast, a fragment or a flung body crosses. 2D lines stay on their level.
 */
export function bnLine(ax: number, ay: number, az: number, bx: number, by: number, bz: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
  const Ax = Math.abs(dx) * 2, Ay = Math.abs(dy) * 2, Az = Math.abs(dz) * 2;
  let x = ax, y = ay, z = az, t = 0, t2 = 0;
  const push = () => out.push([x, y, z]);
  if (Ax === 0 && Ay === 0 && Az === 0) return out;
  if (Az === 0) {
    if (Ax === Ay) while (x !== bx) { y += sy; x += sx; push(); }
    else if (Ax > Ay) while (x !== bx) { if (t > 0) { y += sy; t -= Ax; } x += sx; t += Ay; push(); }
    else while (y !== by) { if (t > 0) { x += sx; t -= Ay; } y += sy; t += Ax; push(); }
    return out;
  }
  if (Ax === Ay && Ay === Az) while (x !== bx) { z += sz; y += sy; x += sx; push(); }
  else if (Az > Ax && Az > Ay) while (z !== bz) { if (t > 0) { x += sx; t -= Az; } if (t2 > 0) { y += sy; t2 -= Az; } z += sz; t += Ax; t2 += Ay; push(); }
  else if (Ax > Ay && Ax > Az) while (x !== bx) { if (t > 0) { y += sy; t -= Ax; } if (t2 > 0) { z += sz; t2 -= Ax; } x += sx; t += Ay; t2 += Az; push(); }
  else if (Ay > Az && Ay > Ax) while (y !== by) { if (t > 0) { z += sz; t -= Ay; } if (t2 > 0) { x += sx; t2 -= Ay; } y += sy; t += Az; t2 += Ax; push(); }
  else if (Ax === Ay) while (x !== bx) { if (t > 0) { z += sz; t -= Ax; } y += sy; x += sx; t += Az; push(); }
  else if (Ax === Az) while (x !== bx) { if (t > 0) { y += sy; t -= Ax; } z += sz; x += sx; t += Ay; push(); }
  else if (Ay === Az) while (y !== by) { if (t > 0) { x += sx; t -= Az; } y += sy; z += sz; t += Ax; push(); }
  else if (Ax > Ay) while (x !== bx) { if (t > 0) { y += sy; t -= Ax; } if (t2 > 0) { z += sz; t2 -= Ax; } x += sx; t += Ay; t2 += Az; push(); }
  else while (y !== by) { if (t > 0) { x += sx; t -= Ay; } if (t2 > 0) { z += sz; t2 -= Ay; } y += sy; t += Ax; t2 += Az; push(); }
  return out;
}

/**
 * ExplosionProcess::is_occluded: an impassable tile on BN's line from the centre (the centre
 * included) before `to`. Vehicles count through the map's vehicle overlay (closed doors, boards).
 */
export function blastOccluded(game: Game, fx: number, fy: number, tx: number, ty: number, z: number, tz = z): boolean {
  if (fx === tx && fy === ty && z === tz) return false;
  if (!game.map.passable(fx, fy, z)) return true;
  for (const [x, y, zz] of bnLine(fx, fy, z, tx, ty, tz)) {
    if (x === tx && y === ty && zz === tz) return false;
    if (!game.map.passable(x, y, zz)) return true;
  }
  return false;
}

/** Who set it off: damage credit (monster kills, NPC grudges) and the source of the survivor's hurt. */
export type BlastSource = 'player' | Monster | { npc: Character } | null;

export interface BlastResult {
  /** Damage dealt per creature (blast + fragments), the survivor under the key 'player'. */
  damaged: Map<unknown, number>;
  noise: number;
  /** Creatures flung, with the tiles they flew (final position minus start). */
  flung: Map<unknown, { dx: number; dy: number }>;
  /** The tile the blast was centred on (after backing off a wall the round stopped in). */
  center: { x: number; y: number; z: number };
}

interface NpcSystemish {
  npcs: Character[];
  afterHit(n: unknown, dmg: number, from: unknown): void;
}

/** World seams for things detonate can't reach from the game alone (set by combatdepth.ts). */
export const blastHooks: {
  /** Slide the survivor `dx, dy` tiles (a blast's fling); absent = moved at once. */
  flingPlayer?: (dx: number, dy: number) => void;
} = {};

type Pos = { x: number; y: number; z: number; dead?: boolean };
type Who = { kind: 'monster'; m: Monster } | { kind: 'npc'; n: Character & Pos } | { kind: 'player' };

/** BN's explosion queue: blasts set off while one is running wait for it to finish. */
const queue: { game: Game; sys: MonsterSystem | null; x: number; y: number; z: number; e: BlastData; source: BlastSource }[] = [];
let running = false;

/**
 * explosion_handler::explosion at (x, y, z) (tile coordinates; the blast is centred on the tile).
 * A point inside an impassable tile (a round stopped on a wall or a car door) is backed off to the
 * passable neighbour nearest it, as ballistics.cpp moves a stopped projectile to its previous
 * tile. `sys` may be null (no monsters hurt). Returns what it hurt.
 */
export function detonate(game: Game, sys: MonsterSystem | null, x: number, y: number, z: number, e: BlastData, source: BlastSource = null): BlastResult {
  if (running) {
    queue.push({ game, sys, x, y, z, e, source });
    return { damaged: new Map(), noise: 0, flung: new Map(), center: { x: Math.floor(x), y: Math.floor(y), z } };
  }
  running = true;
  try {
    const res = runBlast(game, sys, x, y, z, e, source);
    while (queue.length) {
      const q = queue.shift()!;
      runBlast(q.game, q.sys, q.x, q.y, q.z, q.e, q.source);
    }
    return res;
  } finally {
    running = false;
    queue.length = 0;
  }
}

/** The tile a blast at float (x, y) is centred on: its own, or the nearest passable neighbour. */
export function blastCenter(game: Game, x: number, y: number, z: number): { x: number; y: number } {
  const cx = Math.floor(x), cy = Math.floor(y);
  if (game.map.passable(cx, cy, z)) return { x: cx, y: cy };
  let best: { x: number; y: number } | null = null, bestD = Infinity;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const tx = cx + dx, ty = cy + dy;
      if (!game.map.passable(tx, ty, z)) continue;
      const d = Math.hypot(tx + 0.5 - x, ty + 0.5 - y);
      if (d < bestD) {
        bestD = d;
        best = { x: tx, y: ty };
      }
    }
  return best ?? { x: cx, y: cy };
}

function runBlast(game: Game, sys: MonsterSystem | null, x: number, y: number, z: number, e: BlastData, source: BlastSource): BlastResult {
  const rng = game.player.rng;
  const { x: cx, y: cy } = blastCenter(game, x, y, z);
  const P = Math.trunc(e.damage);
  const R = Math.trunc(e.radius);
  const fr = e.fragment && e.fragment.range > 0 && e.fragment.impact.length ? { ...e.fragment, range: Math.trunc(e.fragment.range) } : undefined;
  const blasted = new Map<unknown, number>();
  const shredded = new Map<unknown, number>();
  const noise = blastNoise(e);
  emitSound(game, { x: cx, y: cy, z }, noise.volume, noise.text, { category: 'combat', sfxId: 'explosion', sfxVariant: noise.variant });

  const p = game.player;
  const npcSys = (game as unknown as { npcs?: NpcSystemish }).npcs;
  const npcFrom = source === 'player' ? { kind: 'player', stray: true } : source && 'npc' in (source as object) ? { kind: 'npc', n: (source as { npc: Character }).npc } : source ? { kind: 'monster', m: source } : { kind: 'player', stray: true };
  const monsterCredit: 'player' | Monster | null = source === 'player' ? 'player' : source && !('npc' in (source as object)) ? (source as Monster) : null;
  const fuelBlasts: FuelBlast[] = [];

  // fill_maps: the affected block.
  const aoe = Math.max(R, fr?.range ?? 0);
  const zLevels = Math.trunc(aoe / Z_LEVEL_DIST);
  const blastTiles: { d: number; x: number; y: number; z: number }[] = [];
  const shrapTiles: { d: number; x: number; y: number }[] = [];
  for (let dz = -zLevels; dz <= zLevels; dz++)
    for (let dy = -aoe; dy <= aoe; dy++)
      for (let dx = -aoe; dx <= aoe; dx++) {
        const dist = Math.hypot(dx, dy, dz);
        const zAware = dist + (Z_LEVEL_DIST - 1) * Math.abs(dz);
        if (R > 0 && Math.round(zAware) <= R) blastTiles.push({ d: zAware, x: cx + dx, y: cy + dy, z: z + dz });
        if (fr && dz === 0 && Math.round(dist) <= fr.range && !blastOccluded(game, cx, cy, cx + dx, cy + dy, z)) shrapTiles.push({ d: dist, x: cx + dx, y: cy + dy });
      }
  blastTiles.sort((a, b) => a.d - b.d);
  shrapTiles.sort((a, b) => a.d - b.d);

  // Who stands where (live: a creature that dies drops out; nobody moves until the flinging).
  const whoAt = (tx: number, ty: number, tz: number): Who[] => {
    const out: Who[] = [];
    for (const m of sys?.monstersNear(tx + 0.5, ty + 0.5, tz, 1.5) ?? []) if (!m.dead && m.tileX === tx && m.tileY === ty) out.push({ kind: 'monster', m });
    for (const n of npcSys?.npcs ?? []) {
      const c = n as Character & Pos;
      if (!c.dead && c.z === tz && Math.floor(c.x) === tx && Math.floor(c.y) === ty) out.push({ kind: 'npc', n: c });
    }
    if (!p.dead && p.z === tz && Math.floor(p.x) === tx && Math.floor(p.y) === ty) out.push({ kind: 'player' });
    return out;
  };
  const keyOf = (w: Who): unknown => (w.kind === 'monster' ? w.m : w.kind === 'npc' ? w.n : 'player');

  // project_shrapnel, nearest first.
  if (fr) {
    const impactTotal = fr.impact.reduce((s, u) => s + u.amount, 0);
    for (const t of shrapTiles) {
      if (blastOccluded(game, cx, cy, t.x, t.y, z)) continue;
      for (const w of whoAt(t.x, t.y, z)) {
        let dmg = 0;
        if (w.kind === 'monster') {
          dmg = Math.max(0, Math.floor(applyFlatArmor(fr.impact, w.m.type.armor).reduce((s, u) => s + u.amount, 0)));
          if (dmg > 0) sys!.hurt(w.m, dmg, monsterCredit);
          if (!w.m.dead) fragmentEffects(w.m, e, rng);
        } else if (w.kind === 'npc') {
          dmg = hitCharacter(w.n, 'torso', fr.impact, rng);
          npcSys!.afterHit(w.n, dmg, npcFrom);
        } else {
          for (const bp of MAIN_PARTS) dmg += hitCharacter(p, bp, fr.impact, rng);
          if (dmg > 0) hurtPlayer(game, sys, dmg, source);
        }
        shredded.set(keyOf(w), dmg);
      }
      if (!game.map.passable(t.x, t.y, z)) {
        const dmg = Math.trunc(impactTotal * SHRAPNEL_OBSTACLE_REDUCTION);
        const veh = game.vehicles?.at(t.x, t.y, z);
        if (veh) damageVehicleMount(game, veh.v, veh.mx, veh.my, dmg, 'bash', rng, { fuelBlasts });
        else if (dmg > 0) bash(game, t.x, t.y, z, dmg, { source: 'explosion', silent: true });
      }
    }
  }

  // blast_tile, nearest first.
  const flingQueue: { w: Who; tx: number; ty: number; tz: number; angle: number; velocity: number }[] = [];
  const flungSet = new Set<unknown>();
  const field = e.fire ? 'fd_fire' : 'fd_smoke';
  for (const t of blastTiles) {
    const rl = Math.trunc(t.d);
    if (blastOccluded(game, cx, cy, t.x, t.y, z, t.z)) continue;
    if (P) {
      for (const w of whoAt(t.x, t.y, t.z)) {
        const k = keyOf(w);
        if (blasted.has(k)) continue;
        if (w.kind === 'monster') {
          const blast = Math.trunc(P * critterBlastPct(w.m.size, R, rl));
          const dmg = Math.max(0, Math.floor(applyFlatArmor([{ type: 'bash', amount: blast, armor_penetration: 0.4, armor_multiplier: 1 }], w.m.type.armor)[0].amount));
          if (dmg > 0) sys!.hurt(w.m, dmg, monsterCredit);
          // BN records the shockwave's damage before armour for monsters and NPCs.
          blasted.set(k, blast);
        } else if (w.kind === 'npc') {
          const blast = Math.trunc(P * critterBlastPct('medium', R, rl));
          const dmg = hitCharacter(w.n, 'torso', [{ type: 'bash', amount: blast, armor_penetration: 0.4, armor_multiplier: 1 }], rng);
          npcSys!.afterHit(w.n, dmg, npcFrom);
          blasted.set(k, blast);
        } else {
          const blast = Math.trunc(P * critterBlastPct('medium', R, rl));
          game.message(`You're caught in the explosion!`, 'c_red');
          let total = 0;
          for (const [bp, lo, hi, arm] of BLAST_PARTS) {
            const part = rng.int(Math.trunc(blast * lo), Math.trunc(blast * hi));
            total += hitCharacter(p, bp, [{ type: 'bash', amount: part, armor_penetration: 0, armor_multiplier: arm }], rng);
          }
          if (total > 0) hurtPlayer(game, sys, total, source);
          blasted.set(k, total);
        }
      }
      // Fling the survivors of the blast on this tile.
      for (const w of whoAt(t.x, t.y, t.z)) {
        const k = keyOf(w);
        if (flungSet.has(k) || !flingable(game, w)) continue;
        const v = flingVelocity(P, R, rl, weightOf(game, w), rng);
        if (v < 1) continue;
        flungSet.add(k);
        const angle = t.x !== cx || t.y !== cy ? Math.atan2(t.y - cy + (rng.next() * 1.9 - 0.95), t.x - cx + (rng.next() * 1.9 - 0.95)) : rng.next() * 2 * Math.PI - Math.PI;
        flingQueue.push({ w, tx: t.x, ty: t.y, tz: t.z, angle, velocity: v });
      }
      // Multibash: vehicle part, then terrain/furniture, at falling force.
      const bashFloor = game.map.passable(t.x, t.y, t.z - 1);
      for (const force of multibashForces(P, R, rl)) {
        const veh = game.vehicles?.at(t.x, t.y, t.z);
        if (veh) damageVehicleMount(game, veh.v, veh.mx, veh.my, force, 'bash', rng, { fuelBlasts });
        if (force > 0) bash(game, t.x, t.y, t.z, force, { source: 'explosion', silent: true, bashFloor });
      }
    }
    // Fields: smoke stays within half the radius; fire blasts leave fire.
    if (game.map.passable(t.x, t.y, t.z)) {
      const pct = R > 0 ? rl / R : 0;
      try {
        if (e.fire) addField(game, t.x, t.y, t.z, 'fd_fire', 1 + (P > 10 ? 1 : 0) + (P > 30 ? 1 : 0));
        else if (2 * pct - 1 <= 0 && !findField(game, t.x, t.y, t.z, 'fd_smoke')) addField(game, t.x, t.y, t.z, 'fd_smoke', 1);
      } catch {
        warnOnce('field', field);
      }
    }
  }

  const flung = new Map<unknown, { dx: number; dy: number }>();
  for (const f of flingQueue) {
    const to = flingPath(game, keyOf(f.w), f.tx, f.ty, f.tz, f.angle, f.velocity, (ox, oy, oz, self) => whoAt(ox, oy, oz).some((o) => keyOf(o) !== self));
    if (to.x === f.tx && to.y === f.ty) continue;
    flung.set(keyOf(f.w), { dx: to.x - f.tx, dy: to.y - f.ty });
    moveFlung(game, f.w, to.x + 0.5, to.y + 0.5);
  }

  // The summary BN prints after an explosion (explosion_funcs::regular print_damage).
  const damaged = new Map<unknown, number>();
  for (const [k, n] of blasted) damaged.set(k, (damaged.get(k) ?? 0) + n);
  for (const [k, n] of shredded) damaged.set(k, (damaged.get(k) ?? 0) + n);
  const cause = (k: unknown) => (blasted.has(k) && shredded.has(k) ? 'the explosion and shrapnel' : blasted.has(k) ? 'the explosion' : 'the shrapnel');
  const taking = (n: number) => (n > 0 ? `taking ${n} damage` : 'but takes no damage');
  for (const [k, n] of damaged) {
    if (k === 'player' || !(k as { type?: unknown }).type || !sys?.playerSees(k as Monster)) continue;
    const m = k as Monster;
    game.message(`${m.TheName()} is hit by ${cause(k)}, ${taking(n)}.`);
  }
  for (const [k, n] of damaged) {
    if (k === 'player' || (k as { type?: unknown }).type) continue;
    const c = k as Character & Pos;
    if (c.z === p.z && Math.hypot(c.x - p.x, c.y - p.y) <= 60) game.message(`${(c as { name?: string }).name ?? 'Someone'} is hit by ${cause(k)}, ${taking(n)}.`);
  }
  // (BN prints "but takes no damage" for you too; the port says it in the second person.)
  if (damaged.has('player')) game.message(`You are hit by ${cause('player')}, ${damaged.get('player')! > 0 ? `taking ${damaged.get('player')} damage` : 'but take no damage'}.`, 'c_red');

  game.events.emit('explosion', { x: cx + 0.5, y: cy + 0.5, z, radius: Math.max(1, Math.min(8, R || 1)), fire: e.fire });
  for (const fb of fuelBlasts) detonate(game, sys, fb.x + 0.5, fb.y + 0.5, fb.z, legacyBlast(fb.power, 0.7, fb.fire), null);
  return { damaged, noise: noise.volume, flung, center: { x: cx, y: cy, z } };
}

/** BN fragment_effect on a monster struck by a fragment (only `onfire` is hardcoded specially). */
function fragmentEffects(m: Monster, e: BlastData, rng: Game['player']['rng']): void {
  for (const f of e.fragmentEffect ?? []) {
    const turns = turnsToSeconds(rng.int(f.minTurns, f.maxTurns));
    if (f.effect === 'onfire') {
      // creature.cpp: veggy or cmat_flammable always catch; cmat_flesh one in `odds`.
      const mats = m.type.material ?? [];
      const flammable = mats.some((x) => x === 'veggy' || x === 'wood' || x === 'paper' || x === 'cotton' || x === 'wool' || x === 'powder');
      const flesh = mats.some((x) => x === 'flesh' || x === 'iflesh');
      if (flammable || (flesh && rng.oneIn(f.odds))) m.addEffect('onfire', turns);
    } else {
      // Only onfire appears in BN's data; anything else is an effect the port's monsters lack.
      warnOnce('effect', `fragment_effect ${f.effect}`);
    }
  }
}

/** Can the blast move this creature? Not one inside a vehicle (its seat holds it), nor an IMMOBILE monster. */
function flingable(game: Game, w: Who): boolean {
  const pos: Pos = w.kind === 'monster' ? w.m : w.kind === 'npc' ? w.n : game.player;
  if (pos.dead) return false;
  if (w.kind === 'monster' && w.m.has('IMMOBILE')) return false;
  return !game.vehicles?.occupantAt(pos.x, pos.y, pos.z);
}

/** Creature::get_weight in grams: a monster's type weight, a character's body plus what they carry. */
function weightOf(game: Game, w: Who): number {
  if (w.kind === 'monster') return w.m.type.weight;
  const c: Character = w.kind === 'npc' ? w.n : game.player;
  return c.bodyweightKg() * 1000 + c.inv.weightCarried();
}

/**
 * ExplosionProcess::move_entity for a mob, run to the end at once (BN's non-animated path: each
 * event travels its whole velocity): from the tile centre along `angle`, ceil(1.5 × distance)
 * sub-steps; an impassable tile or another creature turns it back with RESTITUTION_COEFF of the
 * speed left, until under 1 tile. Returns the tile it ends on.
 */
export function flingPath(
  game: Game, self: unknown, tx: number, ty: number, tz: number, angle: number, velocity: number,
  occupied: (x: number, y: number, z: number, self: unknown) => boolean,
): { x: number; y: number } {
  let pos = { x: tx, y: ty }, vel = velocity, a = angle;
  for (let guard = 0; vel >= 1 && guard < 64; guard++) {
    const start = pos;
    const fx = start.x + 0.5, fy = start.y + 0.5;
    const steps = Math.ceil(1.5 * vel);
    let next = start, nextVel = vel;
    for (let step = 0; step <= steps; step++) {
      const cur = vel * (step / steps);
      const nx = Math.trunc(fx + cur * Math.cos(a)), ny = Math.trunc(fy + cur * Math.sin(a));
      const moved = nx !== start.x || ny !== start.y;
      if (!game.map.passable(nx, ny, tz) || (moved && occupied(nx, ny, tz, self))) {
        a += Math.PI;
        nextVel = (vel - cur) * RESTITUTION_COEFF;
        break;
      }
      next = { x: nx, y: ny };
      nextVel = vel - cur;
    }
    pos = next;
    vel = nextVel;
  }
  return pos;
}

/** Put a flung creature on its landing tile: monsters dash there, the survivor slides, NPCs move. */
function moveFlung(game: Game, w: Who, x: number, y: number): void {
  if (w.kind === 'monster') {
    const m = w.m;
    const d = Math.hypot(x - m.x, y - m.y);
    const t = Math.max(0.12, Math.min(0.6, d / 12));
    m.dashVx = (x - m.x) / t;
    m.dashVy = (y - m.y) / t;
    m.dashTime = t;
    return;
  }
  const c: Character & Pos = w.kind === 'npc' ? w.n : (game.player as unknown as Character & Pos);
  if (w.kind === 'player' && blastHooks.flingPlayer) {
    blastHooks.flingPlayer(x - c.x, y - c.y);
    return;
  }
  [c.x, c.y] = moveWithCollision(game.map, c.x, c.y, c.z, x - c.x, y - c.y);
}

/** Creature::deal_damage on one part of a character: armor (with each unit's armor multiplier), then the hit. */
function hitCharacter(c: Character, bp: BodyPartId, impact: BlastUnit[], rng: Game['player']['rng']): number {
  const s = c.onMessage;
  c.onMessage = null;
  try {
    return c.takeHit(bp, c.inv.absorbHit(bp, impact.map((u) => ({ ...u })), rng)).damage;
  } finally {
    c.onMessage = s;
  }
}

function hurtPlayer(game: Game, sys: MonsterSystem | null, total: number, source: BlastSource): void {
  const src = source && source !== 'player' ? ('npc' in (source as object) ? (source as { npc: Character }).npc : source) : undefined;
  game.events.emit('playerHurt', { amount: total, bp: 'torso', source: src });
  if (sys && src && !('inv' in (src as object))) sys.onPlayerHurt(src as Monster, total, 'torso');
}

/**
 * A round's `drop` item that emits a gas (BN projectile `drop`: the 40 mm M651's armed tear gas
 * canister, `emits: emit_tear_gas_stream`): the cloud its emission makes, spread over `qty`
 * passable tiles around where it landed (map::emit_field → propagate_field) at the emit's
 * intensity. One puff: the port has no ticking item emitters, so the canister isn't left behind.
 */
export function dropCloud(game: Game, x: number, y: number, z: number, itemId: string): number {
  const def = game.data.items[itemId] as { emits?: string[] } | undefined;
  const table = (game.data.misc?.emit ?? {}) as Record<string, { field?: string; intensity?: number; qty?: number }>;
  let placed = 0;
  for (const id of asArray(def?.emits)) {
    const em = table[id];
    if (!em?.field) continue;
    const want = Math.max(1, em.qty ?? 1);
    const start = { x: Math.floor(x), y: Math.floor(y) };
    const seenTiles = new Set<string>([`${start.x},${start.y}`]);
    const queue = [start];
    let n = 0;
    while (queue.length && n < want) {
      const t = queue.shift()!;
      try {
        addField(game, t.x, t.y, z, em.field, em.intensity ?? 1);
      } catch {
        warnOnce('field', em.field);
        break;
      }
      n++;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const k = `${t.x + ox},${t.y + oy}`;
        if (seenTiles.has(k) || !game.map.passable(t.x + ox, t.y + oy, z)) continue;
        seenTiles.add(k);
        queue.push({ x: t.x + ox, y: t.y + oy });
      }
    }
    placed += n;
  }
  return placed;
}

/**
 * Everything a round's ammo effects do where it ends (BN projectile.cpp apply_ammo_effects, then
 * ballistics.cpp's custom explosion): each effect's `aoe` field (every tile within `radius` rolls
 * `chance`% for rng(intensity_min, intensity_max); sees/passable checks not modelled, as for the
 * survivor's rounds), each `explosion`, and the projectile's `drop` gas canister. Returns the
 * number of blasts set off.
 */
export function roundEndsAt(game: Game, sys: MonsterSystem | null, x: number, y: number, z: number, ammo: { effects?: unknown; explosion?: unknown; drop?: unknown } | null | undefined, extraEffects: readonly string[] = [], source: BlastSource = null): number {
  if (!ammo) return 0;
  const rng = game.player.rng;
  const effects = [...asArray(ammo.effects as string[] | undefined), ...extraEffects];
  type Aoe = { field_type?: string; intensity_min?: number; intensity_max?: number; radius?: number; chance?: number };
  const table = (game.data.misc?.ammo_effect ?? {}) as Record<string, { explosion?: unknown; aoe?: Aoe | Aoe[] }>;
  for (const id of effects)
    for (const a of asArray(table[id]?.aoe)) {
      if (!a.field_type || a.field_type === 'fd_null') continue;
      const r = Math.max(0, Math.floor(a.radius ?? 1));
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (rng.next() * 100 >= (a.chance ?? 100)) continue;
          try {
            addField(game, Math.floor(x) + dx, Math.floor(y) + dy, z, a.field_type, rng.int(a.intensity_min ?? 0, a.intensity_max ?? a.intensity_min ?? 0));
          } catch {
            warnOnce('field', a.field_type);
          }
        }
    }
  const blasts = ammoBlasts(table, effects, ammo.explosion);
  for (const b of blasts) detonate(game, sys, x, y, z, b, source);
  if (typeof ammo.drop === 'string') dropCloud(game, x, y, z, ammo.drop);
  return blasts.length;
}

/** Does this ammo do anything where it lands (a blast, a field, a gas canister)? */
export function landsWithEffect(game: Game, ammo: { effects?: unknown; explosion?: unknown; drop?: unknown } | null | undefined): boolean {
  if (!ammo) return false;
  if (typeof ammo.drop === 'string') return true;
  const table = (game.data.misc?.ammo_effect ?? {}) as Record<string, { explosion?: unknown; aoe?: unknown }>;
  const effects = asArray(ammo.effects as string[] | undefined);
  return ammoBlasts(table as Record<string, { explosion?: unknown }>, effects, ammo.explosion).length > 0 || effects.some((e) => !!table[e]?.aoe);
}
