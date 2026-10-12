import type { GameData, MonsterDef } from '../data/types';
import type { Character } from './character';
import type { Item } from './item';
import { applyFlatArmor, attackSpeedMoves, maxDispersionMoa, meleeHitChance, rollMeleeDamage, weaponDispersionSources } from './combat';
import { modSum } from './gunmods';
import { strDrawRangeMod } from './rangedfeel';
import type { NpcRules } from './npcrules';

// The arithmetic BN's NPC AI uses to apply the follower rules (npcmove.cpp assess_danger,
// method_of_attack, confident_*_range; npc.cpp follow_distance, emergency): who is "too close",
// how far an NPC trusts its gun, how dangerous a creature is. Pure functions so the rules can be
// tested without a world; src/game/npcai.ts wires them into the real-time AI.
//
// Distances are BN rl_dist: square (Chebyshev) distance between tiles.

/** npcmove.cpp NPC_DANGER_VERY_LOW / NPC_DANGER_MAX. */
export const NPC_DANGER_VERY_LOW = 5;
export const NPC_DANGER_MAX = 150;

export function rlDist(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(Math.floor(ax) - Math.floor(bx)), Math.abs(Math.floor(ay) - Math.floor(by)));
}

/**
 * npc::follow_distance (npc.cpp): 1 while the survivor stands on stairs (the "stair hack"),
 * 2 with follow_distance_2 or when the NPC can't see the survivor, otherwise 4.
 */
export function followDistance(rules: NpcRules, o: { walkingWith: boolean; playerOnStairs: boolean; seesPlayer: boolean }): number {
  if (o.walkingWith && o.playerOnStairs) return 1;
  if (rules.hasFlag('follow_distance_2')) return 2;
  if (!o.seesPlayer) return 2;
  return 4;
}

/**
 * npc::emergency(danger) (npc.cpp): out of stamina (below 20 % + danger − bravery), or the
 * danger outweighs bravery × 3 scaled by health.
 */
export function emergency(c: Character, bravery: number, danger: number): boolean {
  const staminaPercent = Math.trunc((c.stamina / Math.max(1, c.staminaMax())) * 100);
  if (20 + Math.max(danger, 0) > staminaPercent + bravery) return true;
  return danger > (bravery * 3 * c.hpPercent()) / 100;
}

/** npc::confidence_mult (npcmove.cpp): how much an ally trusts a shot under its aim rule. */
export function confidenceMult(aim: string, isAlly: boolean, inEmergency: boolean): number {
  if (!isAlly) return 1;
  switch (aim) {
    case 'AIM_WHEN_CONVENIENT': return inEmergency ? 1.5 : 1;
    case 'AIM_SPRAY': return 2;
    case 'AIM_PRECISE': return inEmergency ? 1 : 0.75;
    case 'AIM_STRICTLY_PRECISE': return 0.5;
  }
  return 1;
}

/**
 * BN data/json/hit_range.json "even_good" (Creature::dispersion_for_even_chance_of_good_hit,
 * extracted into misc.hit_range.default): MOA at which a shot has an even chance of a good hit,
 * by range. Falls back to creature.cpp's built-in table when the data lacks it.
 */
const DEFAULT_EVEN_GOOD = [
  1731, 859, 573, 421, 341, 286, 245, 214, 191, 175, 151, 143, 129, 118, 114, 107, 101, 94, 90, 78,
  78, 78, 74, 71, 68, 66, 62, 61, 59, 57, 46, 46, 46, 46, 46, 46, 45, 45, 44, 42,
  41, 41, 39, 39, 38, 37, 36, 35, 34, 34, 33, 33, 32, 30, 30, 30, 30, 29, 28,
];
export function evenGoodTable(data: GameData): number[] {
  const t = (data.misc?.hit_range?.default as { even_good?: unknown } | undefined)?.even_good;
  return Array.isArray(t) && t.every((v) => typeof v === 'number') ? (t as number[]) : DEFAULT_EVEN_GOOD;
}

/** ranged.cpp range_with_even_chance_of_good_hit. */
export function rangeWithEvenChance(table: number[], dispersion: number): number {
  let r = 0;
  while (r < table.length && dispersion < table[r]) r++;
  return r;
}

/**
 * npc::confident_gun_mode_range (npcmove.cpp): the range at which the NPC expects an even chance
 * of a good hit with `gun` at `recoil` MOA, scaled by confidence_mult, at least 1. Single-shot
 * modes only (the port has no NPC bursts), so there is no burst penalty.
 */
export function confidentGunRange(data: GameData, c: Character, gun: Item, recoil: number, mult: number): number {
  let max = maxDispersionMoa(weaponDispersionSources(c, gun, recoil));
  // BN adds the loaded ammo's raw dispersion on top of get_weapon_dispersion here.
  max += Number(gun.ammoData()?.dispersion) || 0;
  const even = rangeWithEvenChance(evenGoodTable(data), Math.trunc(max));
  return Math.max(Math.trunc(even * mult), 1);
}

/** item::gun_range(true): ammo + gun + gunmod range, shortened for an under-drawn bow. */
export function gunRange(c: Character, gun: Item): number {
  const ammo = gun.ammoData();
  return Math.max(0, ((Number(ammo?.range) || 0) + (gun.def.range ?? 0) + modSum(gun, 'range_modifier')) * strDrawRangeMod(gun, c));
}

/** item::is_silent: gun noise under 50 (a suppressed gun, a bow, an air rifle). */
export function isSilentGun(gun: Item): boolean {
  return gun.gunNoise().volume < 50;
}

/**
 * Character::throw_range (character.cpp): what strength can throw how far. Too heavy = 0;
 * lightest throws best around 150 g; capped at 3 × str + throwing skill.
 */
export function throwRange(c: Character, it: Item): number {
  const w = it.weight() / Math.max(1, it.countByCharges ? it.count() : 1);
  const str = c.str;
  const maxThrowWeight = str * 15 + Math.max(0, str - 8) * 5;
  if (Math.floor(w / 100) > maxThrowWeight) return 0;
  const divisor = w >= 150 ? Math.floor(w / 100) : 10 - Math.floor(w / 15);
  let ret = Math.trunc((str * 10) / Math.max(1, divisor));
  ret -= Math.floor(it.volume() / Math.max(1, it.countByCharges ? it.count() : 1) / 1000);
  if (ret < 1) return 1;
  return Math.min(ret, str * 3 + Math.trunc(c.getSkill('throw')));
}

/**
 * npc::confident_throw_range. BN divides the target's size by half its throwing dispersion;
 * the port's throws use playercombat.ts's angular spread instead (0.25 rad, tightened by
 * throwing skill and dexterity), so a "good hit" is half a tile at half that spread.
 * Port approximation.
 */
export function confidentThrowRange(c: Character, it: Item, mult: number): number {
  const spread = Math.max(0.01, 0.25 - c.getSkill('throw') * 0.02 - (c.dex - 8) * 0.01);
  return Math.min(throwRange(c, it), Math.trunc((0.5 / (spread / 2)) * mult));
}

/** BN item.cpp dps_comp_monsters used by item::average_dps: debug_mon{,_agile,_armored,_mixed}. */
const DPS_TARGETS: { dodge: number; armor: Record<string, number> }[] = [
  { dodge: 0, armor: {} },
  { dodge: 5, armor: {} },
  { dodge: 0, armor: { bash: 25, cut: 25, stab: 20, bullet: 25, acid: 12 } },
  { dodge: 5, armor: { bash: 25, cut: 25, stab: 20, bullet: 25, acid: 12 } },
];

/**
 * npc_ai::melee_value (melee.cpp) = item::average_dps over BN's four reference monsters,
 * valued up for reach and down for polearms. npc::average_damage_dealt is this for the wielded
 * weapon. Port approximation: expected (non-critical) damage past each target's armor × hit
 * chance per 100 moves; BN also counts critical hits.
 */
export function meleeValue(c: Character, weapon: Item | null): number {
  const units = rollMeleeDamage(c, weapon, false, c.rng, true);
  const moves = attackSpeedMoves(c, weapon);
  let sum = 0;
  for (const t of DPS_TARGETS) {
    const dealt = applyFlatArmor(units.map((u) => ({ ...u })), t.armor).reduce((s, d) => s + d.amount, 0);
    sum += (meleeHitChance(c, weapon, t.dodge) * dealt * 100) / moves;
  }
  let value = sum / DPS_TARGETS.length;
  const reach = weapon?.hasFlag('REACH_ATTACK') ? (weapon.hasFlag('REACH3') ? 3 : 2) : 1;
  if (reach > 1) value *= 1 + 0.5 * (Math.sqrt(reach) - 1);
  if (weapon?.hasFlag('POLEARM')) value *= 0.8;
  return value;
}

/** ranged.cpp npc_ai::gun_value's dispersion thresholds (multi_lerp). */
const GUN_DISPERSION_FACTOR: [number, number][] = [[0, 2], [100, 1.8], [200, 1.6], [300, 1.45], [450, 1.3], [700, 1.15], [1000, 1], [2000, 0.1]];
function multiLerp(points: [number, number][], x: number): number {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i][0]) {
      const [x0, y0] = points[i - 1], [x1, y1] = points[i];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}

/**
 * npc_ai::gun_value: ranged dps × a factor for the best-aimed dispersion. Port approximation of
 * ideal_ranged_dps: one shot's damage per 100 moves (the port's NPCs fire single shots).
 */
export function gunValue(c: Character, gun: Item): number {
  if (!gun.isGun()) return 0;
  const disp = maxDispersionMoa(weaponDispersionSources(c, gun, 0)) + (Number(gun.ammoData()?.dispersion) || 0);
  const dps = gun.gunDamage().reduce((s, d) => s + d.amount, 0);
  return dps * multiLerp(GUN_DISPERSION_FACTOR, disp);
}

/** npc_ai::weapon_value: the better of gun and melee value plus half the other. */
export function weaponValue(c: Character, w: Item | null): number {
  const g = w?.isGun() ? gunValue(c, w) : 0;
  const m = meleeValue(c, w);
  return Math.max(g, m) + Math.min(g, m) / 2;
}

/**
 * mtype difficulty (monstergenerator.cpp mtype::set_strategy... `difficulty = …`): melee and
 * dodge/armor terms plus diff + special attacks + 8 per emitted field, scaled by hp, speed,
 * attack cost, morale, aggression and vision. BN stores it in an int, so it truncates twice.
 */
const DIFFICULTY_IGNORED_SPECIALS = new Set(['PARROT', 'PARROT_AT_DANGER', 'EAT_CROP', 'EAT_FOOD']);
export function monsterDifficulty(def: MonsterDef): number {
  const cut = (def.melee_damage ?? []).filter((u) => u.damage_type === 'cut').reduce((s, u) => s + u.amount, 0);
  const specials = (def.special_attacks ?? []).filter((a) => !DIFFICULTY_IGNORED_SPECIALS.has(String(a.id ?? a.type ?? ''))).length;
  const emits = Array.isArray(def.emit_fields) ? def.emit_fields.length : 0;
  const armorBash = def.armor?.bash ?? 0, armorCut = def.armor?.cut ?? 0;
  let d = Math.trunc(
    (def.melee_skill + 1) * def.melee_dice * (cut + def.melee_dice_sides) * 0.04 +
    (def.dodge + 1) * (3 + armorBash + armorCut) * 0.04 +
    ((def.diff ?? 0) + specials + 8 * emits),
  );
  d = Math.trunc(d * ((def.hp + def.speed - def.attack_cost + (def.morale + def.aggression) * 0.1) * 0.01 + (def.vision_day + 2 * def.vision_night) * 0.01));
  return d;
}

/** monster::speed_rating: speed / 100, +0.5 for leapers. */
export function speedRating(def: MonsterDef, speed = def.speed): number {
  const leaps = (def.special_attacks ?? []).some((a) => (a.id ?? a.type) === 'leap');
  return speed / 100 + (leaps ? 0.5 : 0);
}

/**
 * npc::character_danger (npcmove.cpp): the foe's weapon value (×1.5 if they have a gun and we
 * don't), our torso health over our own weapon value, their dodge (halved against our gun),
 * scaled by their speed.
 */
export function characterDanger(me: Character, foe: Character): number {
  const uGun = !!foe.inv.wielded?.isGun();
  const myGun = !!me.inv.wielded?.isGun();
  let uVal = weaponValue(foe, foe.inv.wielded);
  if (uGun && !myGun) uVal *= 1.5;
  let ret = uVal;
  ret += (me.hpPercent() * me.hp.torso.max) / 100 / Math.max(0.1, weaponValue(me, me.inv.wielded));
  ret += myGun ? foe.dodge() / 2 : foe.dodge();
  ret *= Math.max(0.5, foe.speed / 100);
  return ret;
}

/**
 * The ally-only part of npc::assess_danger: may this ally pick `target` given the engagement
 * rule? BN ok_by_rules plus the "too close" exception (a creature within def_radius of the NPC,
 * or of a friend unless only defending itself, is always fair game).
 */
export interface EngagementCtx {
  rules: NpcRules;
  /** The NPC's confident attack range (gun confident range, or melee reach). */
  maxRange: number;
  /** npc::follow_distance. */
  followDist: number;
  /** rl_dist NPC → target. */
  dist: number;
  /** BN scaled distance (dist / target speed rating, at least 1). */
  scaledDist: number;
  /** rl_dist target → survivor. */
  distToPlayer: number;
  /** rl_dist target → nearest other friend (survivor, allied NPCs, friendly monsters). */
  distToFriend: number;
  /** The target was hit by the survivor (effect_hit_by_player). */
  hitByPlayer: boolean;
  targetHp: number;
  /** npc::average_damage_dealt. */
  averageDamage: number;
  inEmergency: boolean;
}

/** npc::assess_danger's def_radius for this NPC. */
export function defenseRadius(c: Pick<EngagementCtx, 'rules' | 'maxRange' | 'followDist' | 'inEmergency'>): number {
  let r = c.rules.hasFlag('follow_close') ? c.followDist : 6;
  const e = c.rules.engagement;
  if (e === 'ENGAGE_FREE_FIRE') r = Math.max(6, c.maxRange);
  else if (e === 'ENGAGE_NO_MOVE' || e === 'ENGAGE_NONE' || c.inEmergency) r = c.maxRange;
  else if (c.rules.hasFlag('forbid_engage')) r = 1;
  return r;
}

/** self_defense_only: NO_MOVE, NONE, or an emergency. */
export function selfDefenseOnly(rules: NpcRules, inEmergency: boolean): boolean {
  return rules.engagement === 'ENGAGE_NO_MOVE' || rules.engagement === 'ENGAGE_NONE' || inEmergency;
}

/** ok_by_rules (npcmove.cpp assess_danger). */
export function okByRules(c: EngagementCtx): boolean {
  if (c.rules.hasFlag('forbid_engage')) return false;
  const def = defenseRadius(c);
  switch (c.rules.engagement) {
    case 'ENGAGE_NONE': return false;
    case 'ENGAGE_CLOSE': return (c.dist <= c.maxRange && c.scaledDist <= def * 0.5) || c.distToPlayer <= def;
    case 'ENGAGE_WEAK': return c.targetHp <= c.averageDamage;
    case 'ENGAGE_HIT': return c.hitByPlayer;
    case 'ENGAGE_NO_MOVE': case 'ENGAGE_FREE_FIRE': return c.dist <= c.maxRange;
    case 'ENGAGE_ALL': return true;
  }
  return true;
}

/** is_too_close: within def_radius of the NPC, or (unless self-defense only) of a friend. */
export function tooClose(c: EngagementCtx): boolean {
  const def = defenseRadius(c);
  if (c.dist <= def) return true;
  if (selfDefenseOnly(c.rules, c.inEmergency)) return false;
  return Math.min(c.distToPlayer, c.distToFriend) <= def;
}

/**
 * BN target priority: max(danger − 2 × (scaled distance − 1), danger if too close). A creature
 * only becomes the target above the starting priority of 1.
 */
export function targetPriority(danger: number, scaledDist: number, isTooClose: boolean): number {
  return Math.max(danger - 2 * (scaledDist - 1), isTooClose ? danger : 0);
}

/**
 * npc::wont_hit_friend (npcmove.cpp): no friend more than a tile away within 30° of the line of
 * fire (wider for friends within 3 tiles: +30° per tile closer). Adjacent friends are skipped
 * (the projectile spares them, ballistics.cpp); a target 1 tile away, or a weapon the NPC has no
 * confidence in at all, is always "safe".
 */
export function wontHitFriend(from: { x: number; y: number }, tar: { x: number; y: number }, friends: { x: number; y: number }[], confident: number): boolean {
  if (confident < 1) return true;
  if (rlDist(from.x, from.y, tar.x, tar.y) === 1) return true;
  const ang = (x: number, y: number) => (Math.atan2(Math.floor(y) - Math.floor(from.y), Math.floor(x) - Math.floor(from.x)) * 180) / Math.PI;
  const targetAngle = ang(tar.x, tar.y);
  for (const f of friends) {
    const d = rlDist(from.x, from.y, f.x, f.y);
    if (d <= 1) continue;
    let safe = 30;
    if (d < 3) safe += (3 - d) * 30;
    let diff = Math.abs(ang(f.x, f.y) - targetAngle);
    diff = Math.min(360 - diff, diff);
    if (diff < safe) return false;
  }
  return true;
}
