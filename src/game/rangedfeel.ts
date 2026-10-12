import type { Rng } from '../core/rng';
import type { ItemDef } from '../data/types';
import { ACTION_SCALE } from '../core/time';
import type { CreatureSize } from './combat';
import { asArray, type Item } from './item';

// The ranged side of the feel layer: what kind of launcher the survivor holds (so a longbow
// doesn't flash, kick and bang like a pistol), Bright Nights' strength rules for bows
// (STR_DRAW / STR_RELOAD), what happens to an arrow after the shot (BN drop_or_embed_projectile:
// break, drop or stick in the target), the flight arc of a visible projectile, and *why* a shot
// missed, in words for the crosshair.
//
// Pure (no DOM, no three.js), unit-tested in tests/rangedfeel.test.ts. The hit math itself stays
// BN's (combat.ts dispersion, projectile.ts deal_projectile_attack); this module never changes
// whether a shot hits, only how it looks, sounds and explains itself, plus the BN rules that
// the port was missing (strength to draw, ammo recovery).

/**
 * How a ranged weapon works, from BN data (skill, ammo types, weapon_category, flags):
 *  - firearm: powder and a bullet (flash, bang, brass, kick)
 *  - bow: arrows drawn by hand (BOWS / ammo arrow)
 *  - crossbow: bolts, a trigger and a crank (CROSSBOW / *_XBOWS / bolt ammo; spearguns too)
 *  - sling: stones (SLINGS / SLINGSHOTS / skill throw / pebble and rock ammo)
 *  - launcher: grenade/rocket/flame/spray launchers (skill launcher)
 *  - energy: lasers, plasma, coilguns (ENERGY_WEAPONS / MAGNETIC / LASER|PLASMA|LIGHTNING)
 *  - air: pneumatic guns (PNEUMATIC)
 *  - thrown: anything that isn't a gun (throwing it by hand)
 */
export type RangedClass = 'firearm' | 'bow' | 'crossbow' | 'sling' | 'thrown' | 'launcher' | 'energy' | 'air';

/** How the trigger works: bows and slingshots are drawn (hold), slings whirled, the rest fire on click. */
export type DrawStyle = 'draw' | 'whirl' | 'trigger';

export interface ClassifiableItem {
  def: ItemDef;
  isGun(): boolean;
  hasFlag(f: string): boolean;
  ammoTypes(): string[];
  ammoData?(): ItemDef | undefined;
}

export function rangedClass(it: ClassifiableItem): RangedClass {
  if (!it.isGun()) return 'thrown';
  const cats = new Set(asArray(it.def.weapon_category as string[] | string | undefined));
  const ammo = new Set(it.ammoTypes());
  const skill = String(it.def.skill ?? '');
  const fx = new Set([...asArray(it.def.ammo_effects as string[] | undefined), ...asArray(it.ammoData?.()?.effects as string[] | undefined)]);
  if (cats.has('ENERGY_WEAPONS') || cats.has('MAGNETIC') || fx.has('LASER') || fx.has('PLASMA') || fx.has('LIGHTNING')) return 'energy';
  if (it.hasFlag('CROSSBOW') || cats.has('M_XBOWS') || cats.has('S_XBOWS') || cats.has('H_XBOWS') || ammo.has('bolt') || ammo.has('bolt_heavy') || ammo.has('bolt_ballista') || ammo.has('fishspear'))
    return 'crossbow';
  if (cats.has('BOWS') || ammo.has('arrow') || ammo.has('strange_arrow')) return 'bow';
  if (cats.has('SLINGS') || cats.has('SLINGSHOTS') || skill === 'throw' || ammo.has('pebble') || ammo.has('rock') || ammo.has('atlatl')) return 'sling';
  if (cats.has('PNEUMATIC')) return 'air';
  if (skill === 'launcher' || ['GRENADE_LAUNCHERS', 'ROCKET_LAUNCHERS', 'FLAMETHROWERS', 'SPRAY_GUNS', 'WATER_CANNONS'].some((c) => cats.has(c))) return 'launcher';
  return 'firearm';
}

/** Burning powder: a muzzle flash and its light. Bows, slings, crossbows, air and energy guns have none. */
export function hasMuzzleFlash(cls: RangedClass): boolean {
  return cls === 'firearm' || cls === 'launcher';
}

/** Spent brass flies out (only cartridge firearms). */
export function ejectsBrass(cls: RangedClass): boolean {
  return cls === 'firearm';
}

/** Share of the gun's recoil kick the camera and hands show (a bow barely moves on release). */
export function kickScale(cls: RangedClass): number {
  return { firearm: 1, launcher: 1, energy: 0.3, air: 0.4, crossbow: 0.35, bow: 0.12, sling: 0.1, thrown: 0.2 }[cls];
}

/** Does the shot fly as a visible projectile with travel time (instead of an instant hitscan line)? */
export function fliesVisibly(cls: RangedClass): boolean {
  return cls === 'bow' || cls === 'crossbow' || cls === 'sling';
}

export function drawStyle(it: ClassifiableItem): DrawStyle {
  const cls = rangedClass(it);
  if (cls === 'bow') return 'draw';
  if (cls === 'sling') return asArray(it.def.weapon_category as string[] | string | undefined).includes('SLINGSHOTS') ? 'draw' : 'whirl';
  return 'trigger';
}

/**
 * Flight speed (m/s, one tile = one metre) of a visible projectile. BN's ammo `speed` (arrows
 * and bolts 100, pebbles 36, rocks 20) only feeds the dodge roll; this is the on-screen speed:
 * fast enough that a shot at 20 m arrives in under half a second, slow enough to watch.
 */
export function flightSpeed(cls: RangedClass, ammoSpeed = 100): number {
  const base = Math.max(22, Math.min(55, ammoSpeed * 0.5));
  return cls === 'crossbow' ? base * 1.4 : cls === 'sling' ? Math.max(24, base) : base;
}

// ------------------------------------------------------------------ strength (BN ranged.cpp)

interface Archer {
  str: number;
  getSkill(id: string): number;
}

/** min_strength of a STR_DRAW weapon (0 = no requirement). */
export function strNeeded(it: ClassifiableItem): number {
  return it.hasFlag('STR_DRAW') ? Math.max(0, Number(it.def.min_strength) || 0) : 0;
}

/** Skill lowers the strength needed: 1 at skill 4, 2 at 8, 3 at 10 (get_str_draw_penalty). */
function strAdjust(it: ClassifiableItem, c: Archer): number {
  const s = c.getSkill(String(it.def.skill ?? 'gun'));
  return s >= 10 ? 3 : s >= 8 ? 2 : s >= 4 ? 1 : 0;
}

/** ranged::get_str_draw_penalty: archer strength / required strength, 1 when strong enough. */
export function strDrawPenalty(it: ClassifiableItem, c: Archer): number {
  const need = strNeeded(it);
  const adj = strAdjust(it, c);
  if (need <= 1 || c.str + adj >= need) return 1;
  return Math.max(1, c.str + adj) / need;
}

/** BN: below half the strength the bow can't be fired at all. */
export function canDraw(it: ClassifiableItem, c: Archer): boolean {
  return strDrawPenalty(it, c) >= 0.5;
}

/** str_draw_damage_modifier and str_draw_range_modifier (the same bands). */
export function strDrawDamageMod(it: ClassifiableItem, c: Archer): number {
  const p = strDrawPenalty(it, c);
  return p < 0.75 ? 0.5 : p < 1 ? 0.75 : 1;
}
export const strDrawRangeMod = strDrawDamageMod;

/** str_draw_dispersion_modifier, as the multiplier BN applies to dispersion (1 / modifier). */
export function strDrawDispersionMul(it: ClassifiableItem, c: Archer): number {
  return strDrawPenalty(it, c) < 0.75 ? 2 : 1;
}

/**
 * The item-info line for a STR_DRAW weapon (item::info BASE_REQUIREMENTS), colour-tagged:
 * "strength 10 (Damage/Range 0.75x)". Null when the weapon has no strength requirement.
 */
export function strRequirementLine(it: ClassifiableItem, c: Archer): { text: string; color: string } | null {
  const need = strNeeded(it);
  if (need <= 0) return null;
  const p = strDrawPenalty(it, c);
  if (p >= 1) return { text: `Strength ${need} to draw (you have ${c.str})`, color: 'c_light_gray' };
  if (p < 0.5) return { text: `Strength ${need} to draw: you can't use it (you have ${c.str})`, color: 'c_magenta' };
  if (p < 0.75) return { text: `Strength ${need} to draw: damage and range 0.5x, spread 2x (you have ${c.str})`, color: 'c_red' };
  return { text: `Strength ${need} to draw: damage and range 0.75x (you have ${c.str})`, color: 'c_yellow' };
}

/** Warning when wielding a bow you can't draw properly (null when fine). */
export function drawWarning(it: ClassifiableItem & { baseName?(): string }, c: Archer): string | null {
  const need = strNeeded(it);
  const p = strDrawPenalty(it, c);
  if (p >= 1) return null;
  const name = it.baseName?.() ?? String(it.def.name ?? it.def.id);
  if (p < 0.5) return `You're too weak to draw the ${name} (Str ${need} needed, you have ${c.str}).`;
  return `The ${name} is a hard pull for you (Str ${need} needed, you have ${c.str}): ${p < 0.75 ? 'half damage and range, double spread' : 'less damage and range'}.`;
}

/**
 * Seconds to nock and draw (RELOAD_AND_SHOOT: BN charges the reload with the shot) or to crank a
 * crossbow: Character::item_reload_cost — the weapon's reload moves, faster with skill, scaled by
 * strength (STR_DRAW: min_strength / str; STR_RELOAD: 10 / str, down to 25%), at least 25 moves.
 */
export function drawSeconds(it: ClassifiableItem, c: Archer, floor = 0.45): number {
  const base = typeof it.def.reload === 'number' ? it.def.reload : 100;
  let mv = base / (1 + Math.min(c.getSkill(String(it.def.skill ?? 'gun')) * 0.1, 1));
  const need = Number(it.def.min_strength) || 0;
  if (it.hasFlag('STR_RELOAD')) mv *= Math.max(10 / Math.max(10, c.str), 0.25);
  else if (it.hasFlag('STR_DRAW') && need > 1) mv *= Math.max(need / Math.max(1, c.str), 0.25);
  return Math.max(floor, Math.max(25, mv) / 100 / ACTION_SCALE);
}

// ------------------------------------------------------------------ after the shot (BN ballistics.cpp)

/**
 * Does the fired round survive to be picked up again? BN: `!one_in(ammo.dont_recover_one_in)`
 * (default 1: never), never with NO_RECOVER_AMMO or ammo that burns or explodes.
 */
export function rollRecovery(ammo: ItemDef | undefined, gun: ClassifiableItem | null, rng: Rng): boolean {
  if (!ammo) return false;
  const n = Number(ammo.dont_recover_one_in) || 1;
  if (n <= 1) return false;
  if (gun?.hasFlag('NO_RECOVER_AMMO')) return false;
  const fx = new Set(asArray(ammo.effects as string[] | undefined));
  if (['IGNITE', 'EXPLOSIVE', 'EXPLOSIVE_SMALL', 'NAPALM', 'INCENDIARY', 'FLARE', 'SHATTER_SELF', 'BURST'].some((e) => fx.has(e))) return false;
  return !rng.oneIn(n);
}

/**
 * drop_or_embed_projectile: a surviving round sticks in a living monster if it is big enough for
 * it (not tiny unless under 250 ml, not small unless under 500 ml) and the cutting part of the
 * blow beats the bashing part plus the round's bulk: cut/2 + stab > bash + vol*3/250ml + rng(0,5).
 */
export function embedsIn(size: CreatureSize, volumeMl: number, dealt: { cut: number; stab: number; bash: number }, rng: Rng, ammoFx: readonly string[] = []): boolean {
  if (ammoFx.includes('NO_EMBED') || ammoFx.includes('TANGLE')) return false;
  if (size === 'tiny' && volumeMl >= 250) return false;
  if ((size === 'tiny' || size === 'small') && volumeMl >= 500) return false;
  return dealt.cut / 2 + dealt.stab > dealt.bash + Math.floor((volumeMl * 3) / 250) + rng.int(0, 5);
}

// ------------------------------------------------------------------ flight arc

export const GRAVITY = 9.8;
/** A bow is loosed a little under the eye (anchor at the chin). */
export const LAUNCH_DROP = 0.25;

/**
 * Height (m above the floor) of a visible projectile `s` metres along its flight. It leaves a
 * little under the eye, rises on a gravity arc and meets the crosshair's line of sight exactly at
 * `aimDist` (the archer compensated for drop at the distance they aimed at); past that it keeps
 * falling and reaches the ground. `slope` = tan(view pitch).
 */
export function arcHeight(s: number, a: { eye: number; slope: number; aimDist: number; speed: number }): number {
  const D = Math.max(0.5, a.aimDist);
  const line = a.eye + a.slope * s;
  const toLine = -LAUNCH_DROP * Math.max(0, 1 - s / D);
  const hump = (GRAVITY / (2 * a.speed * a.speed)) * s * (D - s);
  return line + toLine + hump;
}

/**
 * The gravity part of `arcHeight` alone: how far (m) a projectile flying at `speed` m/s sits above
 * the straight line from its launch point to the point it was aimed at `aimDist` m away, `s` m
 * along. Zero at both ends, negative past the aim point (it keeps falling). Enemy rounds
 * (enemyfire.ts) add it to their straight line so their arrows drop like the survivor's.
 */
export function arcHump(s: number, aimDist: number, speed: number): number {
  const D = Math.max(0.5, aimDist);
  return (GRAVITY / (2 * speed * speed)) * s * (D - s);
}

/** Where (m along the flight) the arc reaches the ground, searching up to `maxS`; Infinity if it doesn't. */
export function groundDistance(a: { eye: number; slope: number; aimDist: number; speed: number }, maxS: number, step = 0.25): number {
  for (let s = step; s <= maxS; s += step) if (arcHeight(s, a) <= 0.02) return s;
  return Infinity;
}

// ------------------------------------------------------------------ why it missed

/** Dispersion (MOA, the maxima BN sums uniform draws over) by source: Character::get_weapon_dispersion. */
export interface DispersionBreakdown {
  weapon: number;
  dex: number;
  hands: number;
  skill: number;
  /** Current recoil: what aiming (holding RMB) removes. */
  aim: number;
  /** Multipliers (a bow drawn without the strength doubles the spread). */
  strMul: number;
}

export function maxOf(b: DispersionBreakdown): number {
  return (b.weapon + b.dex + b.hands + b.skill + b.aim) * b.strMul;
}

/** Mean sideways error (radians) of a shot: the sum of uniform draws averages half its max, times E|cos| = 2/π. */
export function meanLateral(b: DispersionBreakdown): number {
  return (((maxOf(b) / 2) * 2) / Math.PI / 60) * (Math.PI / 180);
}

/** Distance (m) at which the typical sideways error equals the target's radius. */
export function effectiveRange(b: DispersionBreakdown, targetRadius = 0.3): number {
  const a = meanLateral(b);
  return a > 0 ? targetRadius / Math.tan(a) : Infinity;
}

export type RangedMissKind = 'wall' | 'range' | 'ground' | 'over' | 'passed' | 'dodged';

export interface RangedMissInput {
  kind: RangedMissKind;
  spread: DispersionBreakdown;
  /** Distance to the target the shot was meant for, m. */
  distance: number;
  targetRadius: number;
  /** The weapon's (skill id, level) for "archery skill too low (1)". */
  skill: string;
  skillLevel: number;
  style: DrawStyle;
  /** Range of the shot, m (for "out of range (22 m)"). */
  range: number;
  /** STR_DRAW min_strength when the draw was weak. */
  strNeeded?: number;
}

/**
 * The crosshair's one-line answer to "why did I miss?" for a shot that had a target in mind.
 * Obstacles first (cover, range, the ground), then the dodge, then for a shot that simply went
 * wide the biggest *fixable* cause: weak draw, unsteady aim (recoil left to aim away), distance
 * beyond what your spread can hold on a body, then skill / weapon / dexterity / hands; a small
 * spread that still missed was bad luck.
 */
export function rangedMissReason(o: RangedMissInput): string {
  switch (o.kind) {
    case 'wall': return 'blocked by cover';
    case 'range': return `fell short: out of range (${Math.round(o.range)} m)`;
    case 'ground': return 'low: hit the ground short of it';
    case 'over': return 'high: flew over it';
    case 'dodged': return 'dodged';
  }
  const b = o.spread;
  if (b.strMul > 1) return `wide: too weak to draw fully (Str ${o.strNeeded ?? '?'})`;
  const parts: [string, number][] = [['aim', b.aim], ['skill', b.skill], ['weapon', b.weapon], ['dex', b.dex], ['hands', b.hands]];
  parts.sort((x, y) => y[1] - x[1]);
  const top = parts[0][0];
  if (top === 'aim') return o.style === 'draw' ? 'wide: unsteady aim — hold RMB to draw and aim' : 'wide: unsteady aim — hold RMB to aim';
  const err = o.distance * Math.tan(meanLateral(b));
  if (err < o.targetRadius * 0.6) return 'wide: unlucky shot';
  const eff = effectiveRange(b, o.targetRadius);
  // Say what limits the range, so the fix is clear (get closer, or train / a better weapon).
  const cause = top === 'skill' ? `${o.skill} ${o.skillLevel}` : top === 'weapon' ? 'weapon' : top === 'dex' ? 'dexterity' : 'hands';
  if (o.distance > Math.max(3, eff * 1.15)) return `wide: past your effective range (~${Math.max(1, Math.round(eff))} m, ${cause})`;
  if (top === 'skill') return `wide: ${o.skill} skill too low (${o.skillLevel})`;
  if (top === 'weapon') return 'wide: inaccurate weapon';
  if (top === 'dex') return 'wide: low dexterity';
  return 'wide: hands encumbered';
}
