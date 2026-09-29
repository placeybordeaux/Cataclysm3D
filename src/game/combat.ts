import type { DamageUnit, MonsterDef } from '../data/types';
import type { Rng } from '../core/rng';
import { ACTION_SCALE, MELEE_SCALE } from '../core/time';
import { ALL_PARTS, BODY_PARTS, type BodyPartId } from './bodyparts';
import { MAX_RECOIL, type Character, type DamageResult } from './character';
import { asArray, type Item } from './item';
import { buffFlat, buffMult, currentStyle, isUnarmedWeapon, maOf, requirementsMet, triggerBuffs } from './martialarts';
import { covers } from './inventory';
import { defenseOf, sidestepDodgeRoll } from './combatfeel';
import { aimLevel, isJammed, modSum, rollMalfunction, shotSpreadMultiplier, sightDispersion, type AimLevel } from './gunmods';
import {
  applyTechnique, blockHit, defensiveTechnique, glassShatter, handleMeleeWear, pickTechnique, techniqueMessage,
  type BlockResult, type ShatterResult, type TargetInfo, type TechniqueDef, type TechniqueOutcome, type WearResult,
} from './techniques';

// Combat math, ported from CDDA melee.cpp / ranged.cpp / monster.cpp (melee: Bright Nights
// melee.cpp, see the melee section). Pure functions over a
// Character, Items and plain target stats; they take an Rng so results are reproducible.
// Applying damage to monsters and spawning projectiles is the world-combat layer's job.

/** Damage after rolling, before the target's armor. */
export interface RolledDamage {
  type: string;
  amount: number;
  armor_penetration: number;
  /** Fraction of armor that still applies (crits lower it). */
  armor_multiplier: number;
  /**
   * BN damage_unit::damage_multiplier (skill, crit, buff and technique multipliers). Already
   * folded into `amount`; armor comes off before it, so mitigation scales with it. Default 1.
   */
  multiplier?: number;
}

/** CDDA normal_roll(mean, stddev) (Box-Muller). */
export function normalRoll(rng: Rng, mean: number, stddev: number): number {
  const u = Math.max(rng.next(), 1e-12), v = rng.next();
  return mean + stddev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** P(normal(mean, sd) >= x), for UI hit-chance displays. */
export function normalAtLeast(mean: number, sd: number, x: number): number {
  const z = (x - mean) / (sd * Math.SQRT2);
  // Abramowitz-Stegun erf approximation, plenty for a percentage readout.
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 - erf);
}

// ---------------------------------------------------------------- melee (player)
//
// Bright Nights melee.cpp. Differences from the DDA 0.F port this replaced:
//   - to-hit = dex/4 + weapon skill/3 + melee/2 + to_hit + martial-arts hit, times
//     max(0.25, 1 − torso encumbrance/100) (DDA subtracted enc/10); Hyperopic −2. Effect
//     HIT mods don't touch melee accuracy (BN only uses Creature::get_hit for monsters).
//   - weapon skill: highest physical damage type, UNARMED_WEAPON → unarmed, and nothing for
//     bare hands or items without real melee damage (item::melee_skill).
//   - attack cost: dex (not dex/2) off, torso + hand encumbrance on, heavy one-handable
//     weapons swung two-handed get cost^0.975, mutation attackcost_modifier.
//   - damage: armed bash multiplier 0.7 + 0.04 × bashing; bare hands add the unarmed skill;
//     mutation claws/fangs per empty hand; the skill multiplier applies *after* armor
//     (damage_unit::damage_multiplier), low stamina and broken arms scale damage down.
//   - stamina cost: (weight/16 g + 2 × arm encumbrance + 50) × max(0.667, (30 − melee)/30) ×
//     (0.75 + 1/(2 + str/4)), at least 50.

/** Physical types and the skill each trains (skill_by_dt). */
const PHYS_SKILL: Record<string, string> = { bash: 'bashing', cut: 'cutting', stab: 'stabbing' };

/**
 * item::melee_skill for the used weapon: null for bare hands and for items that aren't melee
 * weapons (no damage type above 1), 'unarmed' for UNARMED_WEAPON items, else the skill of
 * the highest physical damage (bash wins ties over cut, cut over stab).
 */
export function weaponSkill(weapon: Item | null): string | null {
  if (!weapon) return null;
  const dmg = weapon.def.melee_damage as Record<string, number> | undefined;
  const types = new Set(['bash', 'cut', 'stab', ...Object.keys(dmg ?? {})]);
  if (![...types].some((t) => weapon.meleeDamage(t) > 1)) return null;
  if (weapon.hasFlag('UNARMED_WEAPON')) return 'unarmed';
  let hi = 0, res: string | null = null;
  for (const t of ['bash', 'cut', 'stab']) {
    const v = weapon.meleeDamage(t);
    if (v > hi) (hi = v), (res = PHYS_SKILL[t]);
  }
  return res;
}

function skillLevel(c: Character, skill: string | null): number {
  return skill ? Math.trunc(c.getSkill(skill)) : 0;
}

/** Product of a numeric mutation field over the character's traits (mutation_value). */
function mutationProduct(c: Character, field: string): number {
  let r = 1;
  for (const t of c.traits) {
    const v = (c.traitDef(t) as Record<string, unknown> | undefined)?.[field];
    if (typeof v === 'number') r *= v;
  }
  return r;
}

/** Character::get_melee_hit (without the roll). */
export function meleeHitBase(c: Character, weapon: Item | null): number {
  let hit = c.dex / 4 + skillLevel(c, weaponSkill(weapon)) / 3 + c.getSkill('melee') / 2 + (weapon?.toHit() ?? 0) + buffFlat(c, 'hit');
  // "You can't hit reliably due to your farsightedness."
  if (c.hasTrait('HYPEROPIC') && !c.inv.worn.some((w) => w.hasFlag('FIX_FARSIGHT')) && !c.hasEffect('contacts')) hit -= 2;
  // "Your torso encumbrance throws you off-balance."
  hit *= Math.max(0.25, 1 - c.inv.encumbrance('torso') / 100);
  return hit;
}

/** Character::hit_roll -> melee::melee_hit_range: normal_roll(hit * 5, 25). */
export function meleeHitRoll(c: Character, weapon: Item | null, rng: Rng): number {
  return normalRoll(rng, meleeHitBase(c, weapon) * 5, 25);
}

/** Chance (0..1) to land a hit on a target with the given dodge (dodge_roll = dodge*5). */
export function meleeHitChance(c: Character, weapon: Item | null, targetDodge: number): number {
  return normalAtLeast(meleeHitBase(c, weapon) * 5, 25, targetDodge * 5);
}

/** item::is_two_handed: ALWAYS_TWOHAND, or heavier than 4 × str (2 × for ALWAYS_TWOHAND) × 113 g. */
export function isTwoHanded(c: Character, weapon: Item): boolean {
  if (weapon.hasFlag('ALWAYS_TWOHAND')) return true;
  return Math.floor(weapon.weight() / 113) > c.str * 4;
}

/**
 * Character::attack_cost (BN melee.cpp): moves per attack. base = attack_cost/2; torso and
 * hand encumbrance add, exhaustion (stamina below 25%) scales those up to ×2; melee skill adds
 * base × (15 − skill)/15; dex subtracts; martial arts scale then offset; min 25.
 */
export function attackSpeedMoves(c: Character, weapon: Item | null): number {
  // Bare hands: the null item has no volume/weight -> attack_cost 65.
  const attackCost = weapon ? weapon.attackTime() : 65;
  const base = Math.trunc(attackCost / 2);
  const melee = Math.trunc(c.getSkill('melee'));
  const skillCost = Math.trunc((base * (15 - melee)) / 15);
  const enc = Math.trunc(c.inv.encumbrance('torso') + Math.trunc((c.inv.encumbrance('hand_l') + c.inv.encumbrance('hand_r')) / 2));
  const staminaRatio = c.stamina / c.staminaMax();
  const staminaPenalty = 1 + Math.max((0.25 - staminaRatio) * 4, 0);
  let cost = base + enc;
  cost = Math.trunc(cost * staminaPenalty);
  cost += skillCost;
  cost -= Math.trunc(c.dex);
  // Strong enough to swing it one-handed but using both hands: easier (heavy weapons only).
  if (weapon && attackCost > 100 && !isTwoHanded(c, weapon) && c.brokenArms() === 0) cost = Math.trunc(Math.pow(Math.max(0, cost), 0.975));
  cost = Math.trunc(cost * buffMult(c, 'movecost'));
  cost = Math.trunc(cost + buffFlat(c, 'movecost'));
  cost = Math.trunc(cost * mutationProduct(c, 'attackcost_modifier'));
  return Math.max(25, cost);
}

/** Real-time cooldown between swings: moves / 100 turns / MELEE_SCALE turns per second. */
export function attackCooldownSeconds(c: Character, weapon: Item | null): number {
  return attackSpeedMoves(c, weapon) / 100 / MELEE_SCALE;
}

/**
 * How a weapon's swing speed reads in real time, for the HUD and the wield warning.
 * Bands are moves per attack (fists ≈ 56, pipe ≈ 72, sledgehammer ≈ 146 for an untrained
 * 8-dex survivor).
 */
export function swingSpeedRating(moves: number): { label: 'fast' | 'normal' | 'slow' | 'very slow'; color: string } {
  if (moves <= 80) return { label: 'fast', color: 'c_light_green' };
  if (moves <= 130) return { label: 'normal', color: 'c_white' };
  if (moves <= 180) return { label: 'slow', color: 'c_yellow' };
  return { label: 'very slow', color: 'c_light_red' };
}

/** The warning shown when wielding something awkward to swing, or null. */
export function unwieldyWarning(c: Character, it: Item): string | null {
  if (it.isGun()) return null;
  const r = swingSpeedRating(attackSpeedMoves(c, it));
  const name = it.baseName();
  if (r.label === 'very slow') return `The ${name} is very unwieldy, attacks will be slow.`;
  if (r.label === 'slow') return `The ${name} is unwieldy, attacks will be a bit slow.`;
  return null;
}

/** melee.cpp stumble(): extra moves lost on a miss with heavy/bulky weapons (none if Deft). */
export function stumbleMoves(c: Character, weapon: Item | null): number {
  if (!weapon || c.hasTrait('DEFT')) return 0;
  return Math.floor(weapon.volume() / 125 + weapon.weight() / (c.str * 10 + 13));
}

/** Character::get_melee_stamina_cost (positive; the swing spends at least 50). */
export function meleeStaminaCost(c: Character, weapon: Item | null): number {
  const melee = Math.trunc(c.getSkill('melee'));
  const weightCost = Math.floor((weapon?.weight() ?? 0) / 16);
  const encCost = Math.round((c.inv.encumbrance('arm_l') + c.inv.encumbrance('arm_r')) * 2);
  const deft = c.hasTrait('DEFT') ? 50 : 0;
  const strBonus = 1 / (2 + c.str * 0.25);
  const skillCost = Math.max(0.667, (30 - melee) / 30);
  const cost = Math.trunc((weightCost + encCost - deft + 50) * skillCost * (0.75 + strBonus));
  return Math.max(50, cost);
}

/** Character::crit_chance (melee.cpp). */
export function critChance(c: Character, weapon: Item | null, rollHit: number, targetDodge: number): number {
  const lim = (p: number) => Math.max(0, Math.min(1, p));
  let weaponCrit = 0.5;
  if (isUnarmedWeapon(weapon)) weaponCrit = 0.5 + 0.05 * Math.trunc(c.getSkill('unarmed'));
  const th = weapon?.toHit() ?? 0;
  if (th > 0) weaponCrit = Math.max(weaponCrit, 0.5 + 0.1 * th);
  else if (th < 0) weaponCrit += 0.1 * th;
  weaponCrit = lim(weaponCrit);
  const statCrit = lim(0.25 + 0.01 * c.dex + 0.02 * c.per);
  // `int sk`: the melee share is truncated with it.
  const sk = Math.trunc(skillLevel(c, weaponSkill(weapon)) + c.getSkill('melee') / 2.5);
  const skillCrit = lim(0.25 + sk * 0.025);
  const triple = weaponCrit * statCrit * skillCrit;
  if (rollHit > (targetDodge * 3) / 2) {
    const double = 0.5 * (weaponCrit * statCrit + statCrit * skillCrit + weaponCrit * skillCrit - 3 * triple);
    return triple + double;
  }
  return triple;
}

/** Character::natural_attack_restricted_on: something worn over the hand blocks claws. */
function naturalAttackRestricted(c: Character, bp: 'hand_l' | 'hand_r'): boolean {
  return c.inv.worn.some((w) => covers(w, bp) && !w.hasFlag('ALLOWS_NATURAL_ATTACKS') && !w.hasFlag('SEMITANGIBLE') && !w.hasFlag('PERSONAL') && !w.hasFlag('AURA'));
}

/** Hooks other systems fill (mutation activation lives in src/game/mutations.ts). */
export const meleeHooks: { mutationActive: ((c: Character, id: string) => boolean) | null; hasBionic: ((c: Character, id: string) => boolean) | null } = {
  mutationActive: null,
  hasBionic: null,
};

/**
 * Per-hand unarmed bonus from mutations (bash/cut_dmg_bonus, rand_*_bonus, pierce_dmg_bonus,
 * UNARMED_BONUS adds min(unarmed/2, 4)) and bionic razors, counted once per free hand
 * (roll_bash/cut/stab_damage). The right hand only counts when nothing is wielded.
 */
function unarmedHandBonus(c: Character, weapon: Item | null, dt: 'bash' | 'cut' | 'stab', rng: Rng, average: boolean): number {
  const leftEmpty = !naturalAttackRestricted(c, 'hand_l');
  const rightEmpty = !naturalAttackRestricted(c, 'hand_r') && !weapon;
  if (!leftEmpty && !rightEmpty) return 0;
  const unarmedBonus = Math.min(Math.trunc(c.getSkill('unarmed') / 2), 4);
  let perHand = 0;
  for (const t of c.traits) {
    const d = c.traitDef(t) as Record<string, unknown> | undefined;
    if (!d) continue;
    const flags = (d.flags as string[] | undefined) ?? [];
    if (dt !== 'stab' && flags.includes('NEED_ACTIVE_TO_MELEE') && !meleeHooks.mutationActive?.(c, t)) continue;
    const flat = Number(d[dt === 'bash' ? 'bash_dmg_bonus' : dt === 'cut' ? 'cut_dmg_bonus' : 'pierce_dmg_bonus'] ?? 0);
    perHand += flat + (flags.includes('UNARMED_BONUS') && flat > 0 ? unarmedBonus : 0);
    const rand = dt === 'stab' ? undefined : (d[dt === 'bash' ? 'rand_bash_bonus' : 'rand_cut_bonus'] as { min: number; max: number } | undefined);
    if (rand) perHand += average ? (rand.min + rand.max) / 2 : rng.int(rand.min, rand.max);
  }
  if (dt !== 'bash' && meleeHooks.hasBionic?.(c, 'bio_razors')) perHand += 2;
  return leftEmpty && rightEmpty ? perHand * 2 : perHand;
}

/**
 * melee::roll_all_damage: bash/cut/stab with skill multipliers and crit effects, other types
 * flat. `multiplier` is BN's damage_multiplier: already included in `amount`, but armor
 * applies before it (applyFlatArmor scales the mitigation by it). `average` gives expected
 * values (item info).
 */
export function rollMeleeDamage(c: Character, weapon: Item | null, crit: boolean, rng: Rng, average = false): RolledDamage[] {
  const out: RolledDamage[] = [];
  const unarmed = isUnarmedWeapon(weapon);
  const push = (type: string, amount: number, arpen: number, armorMult: number, mul: number) => {
    out.push({ type, amount: amount * mul, armor_penetration: arpen, armor_multiplier: armorMult * buffMult(c, 'target_armor_multiplier', type), multiplier: mul });
  };
  // Bash: strength and the bash cap.
  {
    const skill = Math.trunc(c.getSkill(unarmed ? 'unarmed' : 'bashing'));
    const str = c.str;
    let bash = unarmed ? unarmedHandBonus(c, weapon, 'bash', rng, average) : 0;
    const statBonus = (average ? str * 0.75 : str / 2 + rng.next() * (str / 2)) + buffFlat(c, 'damage', 'bash');
    let weapDam = (weapon?.meleeDamage('bash') ?? 0) + statBonus;
    if (unarmed) weapDam += skill;
    const cap = 2 * str + 2 * skill;
    let mul = unarmed ? (skill < 5 ? 0.8 + 0.08 * skill : 0.96 + 0.04 * skill) : 0.7 + 0.04 * skill;
    if (cap < weapDam && weapon) mul *= (1 + cap / weapDam) / 2;
    const lowCap = Math.min(1, str / 20);
    const min = lowCap * weapDam;
    weapDam = average ? (min + weapDam) * 0.5 : min + rng.next() * (weapDam - min);
    bash += weapDam;
    mul *= buffMult(c, 'damage', 'bash');
    let armorMult = 1;
    if (crit) {
      mul *= 1.5;
      armorMult *= 0.5;
    }
    push('bash', bash, buffFlat(c, 'arpen', 'bash'), armorMult, mul);
  }
  // Cut: no strength.
  {
    let cut = buffFlat(c, 'damage', 'cut') + (weapon?.meleeDamage('cut') ?? 0);
    if (unarmed) cut += unarmedHandBonus(c, weapon, 'cut', rng, average);
    if (cut > 0) {
      const skill = Math.trunc(c.getSkill('cutting'));
      let mul = skill < 5 ? 0.8 + 0.08 * skill : 0.96 + 0.04 * skill;
      let arpen = buffFlat(c, 'arpen', 'cut');
      let armorMult = 1;
      mul *= buffMult(c, 'damage', 'cut');
      if (crit) {
        mul *= 1.25;
        arpen += 5;
        armorMult = 0.75;
      }
      push('cut', cut, arpen, armorMult, mul);
    }
  }
  // Stab: crits scale with the skill.
  {
    let stab = buffFlat(c, 'damage', 'stab') + (weapon?.meleeDamage('stab') ?? 0);
    if (unarmed) stab += unarmedHandBonus(c, weapon, 'stab', rng, average);
    if (stab > 0) {
      const skill = Math.trunc(c.getSkill('stabbing'));
      let mul = skill <= 5 ? 0.66 + 0.1 * skill : 0.86 + 0.06 * skill;
      mul *= buffMult(c, 'damage', 'stab');
      let armorMult = 1;
      if (crit) {
        mul *= 1 + skill / 10;
        armorMult *= 0.66;
      }
      push('stab', stab, buffFlat(c, 'arpen', 'stab'), armorMult, mul);
    }
  }
  // Everything else (heat, electric, …) flat.
  const others = new Set([...Object.keys(weapon?.def.melee_damage ?? {}), ...buffDamageTypes(c)]);
  for (const dt of others) {
    if (dt in PHYS_SKILL) continue;
    const dmg = buffFlat(c, 'damage', dt) + (weapon?.meleeDamage(dt) ?? 0);
    if (dmg <= 0) continue;
    push(dt, dmg, buffFlat(c, 'arpen', dt), 1, buffMult(c, 'damage', dt) * (crit ? 1.5 : 1));
  }
  return out;
}

/** Damage types some active martial-arts buff adds damage to. */
function buffDamageTypes(c: Character): string[] {
  const out: string[] = [];
  for (const b of maOf(c).buffs.values()) for (const e of b.def.flat_bonuses ?? []) if (e.stat === 'damage' && e.type) out.push(e.type);
  return out;
}

/** damage_instance::mult_damage: scale every unit (low stamina, broken arms, polearms up close). */
export function multDamage(units: RolledDamage[], f: number): void {
  for (const u of units) {
    u.amount *= f;
    u.multiplier = (u.multiplier ?? 1) * f;
  }
}

/**
 * Per-type monster armor (MonsterDef.armor) like monster::absorb_hit: resist =
 * max(armor − armor penetration, 0) × armor multiplier comes off the unit's raw amount, before
 * its damage multiplier (so the mitigation scales with it here, where amount is multiplied).
 */
export function applyFlatArmor(units: RolledDamage[], armor: Record<string, number> | undefined): { type: string; amount: number }[] {
  return units.map((u) => {
    let res = armor?.[u.type] ?? 0;
    // Monsters: stab derives from cut * 0.8 when not given (damage_types.json derived_from).
    if (u.type === 'stab' && armor?.stab === undefined && armor?.cut !== undefined) res = armor.cut * 0.8;
    const mitigation = Math.max(res - u.armor_penetration, 0) * u.armor_multiplier * (u.multiplier ?? 1);
    return { type: u.type, amount: Math.max(0, u.amount - mitigation) };
  });
}

export interface MeleeTarget {
  /** Monster sk_dodge (+ effects); 0 when downed/stunned. dodge_roll = dodge * 5. */
  dodge: number;
  armor?: Record<string, number>;
  /** Creature::size_melee_penalty (tiny +30, small +15, medium 0, large -10, huge -20). */
  sizeMeleePenalty?: number;
  /** Immobile targets (turrets): +40 hit spread. */
  immobile?: boolean;
  /** What technique requirements test; without it (legacy callers) no techniques are used. */
  info?: TargetInfo;
}

export interface MeleeOpts {
  /** melee_attack's allow_special: false for AoE follow-up swings (no techniques). */
  allowSpecial?: boolean;
  /** Use this technique (block/dodge counters, debug). */
  forceTechnique?: TechniqueDef;
  /** Extra AoE victims available for an aoe kind; AoE techniques need at least one. */
  aoeTargets?: (aoe: string) => number;
  reachAttack?: boolean;
  /** The target can be downed (not immobile / immune). Default true. */
  downable?: boolean;
}

export interface MeleeResult {
  hit: boolean;
  crit: boolean;
  hitSpread: number;
  /** Damage per type after the target's armor. */
  damage: { type: string; amount: number }[];
  total: number;
  /** Moves the swing took (includes stumble on a miss). */
  moves: number;
  cooldownSeconds: number;
  staminaCost: number;
  message: string;
  /** Technique used on a hit (or miss recovery on a miss), if any. */
  technique: TechniqueDef | null;
  /** What the technique does to the target (the world layer applies it). */
  outcome?: TechniqueOutcome;
  /** Weapon wear from this swing (handle_melee_wear). */
  wear?: WearResult;
  /** Glass weapon shattered on the blow. */
  shatter?: ShatterResult;
  /** On a miss: stumble moves the swing cost (heavy/unwieldy weapons stumble more). */
  stumble?: number;
}

/**
 * One melee swing by `c` at a target (BN Character::melee_attack): hit roll, crit, a
 * technique picked from the weapon and martial-art style (pick_technique) that scales damage
 * and move cost, glass shattering, weapon wear, martial-arts buff triggers (onattack/onhit/
 * onmiss/oncrit). Spends stamina and trains skills. Technique effects on the target (stun,
 * downed, knockback, AoE) come back in `outcome` for the world layer.
 */
export function meleeAttack(c: Character, target: MeleeTarget, rng: Rng, targetName = 'the target', opts: MeleeOpts = {}): MeleeResult {
  const style = currentStyle(c);
  // Styles that force unarmed fight with fists even while holding something (used_weapon).
  const weapon = style.force_unarmed ? null : c.inv.wielded;
  const roll = meleeHitRoll(c, weapon, rng);
  let spread = roll - target.dodge * 5 - (target.sizeMeleePenalty ?? 0);
  if (target.immobile) spread += 40;
  const hit = spread >= 0;
  let moves = attackSpeedMoves(c, weapon);
  const staminaCost = meleeStaminaCost(c, weapon);
  maOf(c).attacked = true;
  if (!hit) {
    const st = stumbleMoves(c, weapon);
    moves += Math.min(60, st);
    meleeTrain(c, weapon, false, rng);
    // BN halves the cost whenever a miss-recovery technique is on hand; its message only
    // shows when the character meets its requirements.
    const recovery = defensiveTechnique(c, 'miss_recovery', weapon);
    let message: string;
    if (recovery) moves = Math.trunc(moves / 2);
    if (recovery && requirementsMet(c, recovery, weapon)) {
      message = techniqueMessage(recovery, targetName) ?? 'You miss.';
      if (!/[.!]$/.test(message)) message += '.';
    } else message = st >= 60 ? 'You miss and stumble with the momentum.' : st >= 10 ? 'You swing wildly and miss.' : 'You miss.';
    c.msg(message);
    triggerBuffs(c, 'onmiss');
    const wear = handleMeleeWear(c, weapon, 1, rng);
    c.modStamina(-staminaCost);
    triggerBuffs(c, 'onattack');
    return { hit, crit: false, hitSpread: spread, damage: [], total: 0, moves, cooldownSeconds: moves / 100 / MELEE_SCALE, staminaCost, message, technique: recovery, wear, stumble: st };
  }
  const crit = rng.next() < critChance(c, weapon, meleeHitRoll(c, weapon, rng), target.dodge * 5);
  let technique: TechniqueDef | null = null;
  let outcome: TechniqueOutcome | undefined;
  if (opts.forceTechnique) technique = opts.forceTechnique;
  else if (opts.allowSpecial !== false && target.info)
    technique = pickTechnique(c, target.info, weapon, { crit, aoeTargets: opts.aoeTargets }, rng);
  // A force_unarmed technique (kicks) hits with the body, not the weapon.
  const useWeapon = technique?.force_unarmed ? null : weapon;
  const units = rollMeleeDamage(c, useWeapon, crit, rng);
  // Two broken arms: no martial arts and feeble blows.
  if (c.brokenArms() >= 2) {
    technique = null;
    multDamage(units, 0.1);
  }
  // Polearms (but not spears) do less damage to adjacent targets.
  if (useWeapon?.hasFlag('POLEARM') && (useWeapon.hasFlag('REACH_ATTACK') || useWeapon.hasFlag('REACH3')) && !opts.reachAttack) multDamage(units, 0.7);
  // Below 25% stamina damage falls linearly to half at 0.
  if (c.stamina < c.staminaMax() / 4) multDamage(units, 0.5 + (c.stamina / c.staminaMax()) * 2);
  if (technique) {
    const r = applyTechnique(c, technique, units, moves, rng, {
      downable: opts.downable !== false,
      flies: !!target.info?.flags?.includes('FLIES'),
    });
    moves = r.moves;
    outcome = r.outcome;
  }
  // melee_special_effects: glass weapons may shatter, cutting the target extra.
  const shatter = glassShatter(c, weapon, rng);
  if (shatter.extraCut > 0) {
    const cut = units.find((u) => u.type === 'cut');
    if (cut) cut.amount += shatter.extraCut;
    else units.push({ type: 'cut', amount: shatter.extraCut, armor_penetration: 0, armor_multiplier: 1 });
  }
  triggerBuffs(c, 'onhit');
  const damage = applyFlatArmor(units, target.armor);
  const total = Math.floor(damage.reduce((s, d) => s + d.amount, 0));
  meleeTrain(c, useWeapon, true, rng);
  if (crit) triggerBuffs(c, 'oncrit');
  // A shattered weapon is gone; otherwise it may wear from the blow.
  const wear = shatter.shattered ? undefined : handleMeleeWear(c, weapon, 1, rng);
  c.modStamina(-staminaCost);
  triggerBuffs(c, 'onattack');
  const message = `You ${crit ? 'critically ' : ''}hit ${targetName}${total > 0 ? ` for ${total} damage` : ' but do no damage'}.`;
  return {
    hit, crit, hitSpread: spread, damage, total, moves, cooldownSeconds: moves / 100 / MELEE_SCALE, staminaCost, message,
    technique, outcome, wear, shatter: shatter.shattered ? shatter : undefined,
  };
}

/**
 * CDDA player_hit_message: "<phrase> for N damage." / "… but do no damage." / "…  Critical!".
 * `phrase` is the technique message ("You sweep the zombie") or "You <verb> the zombie".
 */
export function hitMessage(phrase: string, dam: number, crit: boolean, npc = false): string {
  if (dam <= 0) return `${phrase} but ${npc ? 'does' : 'do'} no damage.`;
  if (npc) return crit ? `${phrase}.  Critical!` : `${phrase}.`;
  return crit ? `${phrase} for ${dam} damage.  Critical!` : `${phrase} for ${dam} damage.`;
}

/**
 * BN melee_train: hits train (5..10), misses (2..5); melee gets half. Weapon XP is split by
 * the weapon's bash/cut/stab share; unarmed weapons (and bare hands) train unarmed.
 */
export function meleeTrain(c: Character, weapon: Item | null, hit: boolean, rng: Rng): void {
  const [lo, hi] = hit ? [5, 10] : [2, 5];
  c.practice('melee', Math.ceil(rng.int(lo, hi) / 2), hi);
  if (isUnarmedWeapon(weapon)) {
    c.practice('unarmed', rng.int(lo, hi), hi);
    return;
  }
  const cut = Math.trunc(weapon!.meleeDamage('cut'));
  const stab = Math.trunc(weapon!.meleeDamage('stab'));
  const bash = Math.trunc(weapon!.meleeDamage('bash'));
  const total = Math.max(cut + stab + bash, 1);
  for (const [skill, v] of [['cutting', cut], ['stabbing', stab], ['bashing', bash]] as const) {
    const xp = Math.ceil((v / total) * rng.int(lo, hi));
    if (xp > 0) c.practice(skill, xp, hi);
  }
}

// ---------------------------------------------------------------- ranged

/** ranged.cpp dispersion_from_skill (MOA penalty from lacking skill). */
export function dispersionFromSkill(skill: number, weaponDispersion: number): number {
  const MAX = 10;
  if (skill >= MAX) return 0;
  const shortfall = MAX - skill;
  let pen = 10 * shortfall;
  if (skill >= 5) return pen + (weaponDispersion * shortfall * 1.25) / (MAX - 5);
  pen += weaponDispersion * (1.25 + ((5 - skill) * 10) / 5);
  return pen;
}

/** item::gun_dispersion (with ammo, scaled by GUN_DISPERSION_DIVIDER = 18). */
export function gunDispersion(gun: Item): number {
  // Gunmods add their dispersion_modifier (item::gun_dispersion).
  let sum = (gun.def.dispersion ?? 0) + modSum(gun, 'dispersion_modifier') + gun.damageLevel() * 30; // DISPERSION_PER_GUN_DAMAGE = 30
  sum = Math.max(sum, 0);
  const ammo = gun.ammoData();
  if (ammo) sum += ammo.dispersion ?? 0;
  return Math.max(Math.round(sum / 18), 1);
}

export interface DispersionSources {
  /** Uniform [0, x] contributions (MOA). */
  linear: number[];
  multipliers: number[];
}

/** Character::get_weapon_dispersion + recoil (total_gun_dispersion). */
export function weaponDispersionSources(c: Character, gun: Item, recoil = c.recoil): DispersionSources {
  const linear = [gunDispersion(gun)];
  linear.push(Math.max((20 - c.dex) * 0.5, 0)); // ranged_dex_mod
  // Hand encumbrance / broken arms stand in for CDDA's manipulator limb score.
  const handEnc = (c.inv.encumbrance('hand_l') + c.inv.encumbrance('hand_r')) / 2;
  linear.push(handEnc * 2 + c.brokenArms() * 150);
  const skill = gun.def.skill ?? 'gun';
  const avg = Math.min((c.getSkill('gun') + c.getSkill(skill)) / 2, 10);
  linear.push(dispersionFromSkill(avg, (skill === 'archery' ? 450 : 300) / 18));
  linear.push(recoil);
  return { linear, multipliers: [] };
}

export function maxDispersionMoa(src: DispersionSources): number {
  let s = src.linear.reduce((a, b) => a + b, 0);
  for (const m of src.multipliers) s *= m;
  return s;
}

/** dispersion_sources::roll: sum of uniform draws, capped at 3600 MOA. */
export function rollDispersionMoa(src: DispersionSources, rng: Rng): number {
  let r = 0;
  for (const s of src.linear) r += rng.next() * s;
  for (const m of src.multipliers) r *= m;
  return Math.min(r, 3600);
}

export function moaToRadians(moa: number): number {
  return ((moa / 60) * Math.PI) / 180;
}

/** Sight floor for aiming: best sight (gun or mod, sightDispersion) plus perception penalty (ranged_per_mod). */
export function aimFloorMoa(c: Character, gun: Item): number {
  return sightDispersion(gun) + Math.max((20 - c.per) * 1.2, 0);
}

/** Aim state for the crosshair readout (Character::get_aim_types thresholds on the sight floor). */
export function aimState(c: Character, gun: Item): AimLevel {
  return aimLevel(c.recoil, aimFloorMoa(c, gun));
}

/**
 * Aim for `moves` (RMB held): recoil decays toward the sight floor. A simplification of
 * Character::aim_per_move: ~2%/move of the remaining gap, faster with skill and perception
 * and with sights that aim quickly (gunmod aim_speed_modifier, +10 ≈ 10% faster).
 */
export function aim(c: Character, gun: Item, moves: number): number {
  const floor = aimFloorMoa(c, gun);
  if (c.recoil <= floor) return c.recoil;
  const skill = c.getSkill(gun.def.skill ?? 'gun');
  const rate = 0.01 * (1 + skill / 10 + c.per / 20) * Math.max(0.5, 1 + modSum(gun, 'aim_speed_modifier') / 100);
  c.recoil = floor + (c.recoil - floor) * Math.pow(1 - rate, moves);
  return c.recoil;
}

/** item::gun_recoil: gun + ammo recoil, reduced by handling (gun + mods) and arm strength. */
export function gunRecoil(c: Character, gun: Item): number {
  const baseWeight = gun.def.weight;
  const wt = Math.min(baseWeight, c.str * 333) / 333;
  const handlingDefault = ['rifle', 'smg', 'shotgun'].includes(gun.def.skill ?? '') ? 20 : 10;
  let handling = ((gun.def.handling ?? handlingDefault) + modSum(gun, 'handling_modifier')) / 10;
  handling = Math.pow(wt, 0.8) * Math.pow(handling, 1.2);
  let qty = gun.def.recoil ?? 0;
  const ammo = gun.ammoData();
  if (ammo) qty += ammo.recoil ?? 0;
  return handling > 1 ? qty / handling : qty * (1 + Math.abs(handling));
}

export interface ShotResult {
  ok: boolean;
  message: string;
  /** Angle off the aim axis, radians, and the direction of the error around the axis. */
  spread: number;
  azimuth: number;
  /** Maximum possible spread this shot (for a crosshair cone), radians. */
  maxSpread: number;
  damage: { type: string; amount: number; armor_penetration: number }[];
  /** Tiles. */
  range: number;
  noise: { volume: number; sound: string };
  moves: number;
  cooldownSeconds: number;
  /** Projectiles per shot (shotgun pellets); 1 for bullets. */
  pellets?: number;
  /** Per-pellet angular spread (ammo shot_spread × gun multiplier), MOA. */
  shotSpreadMoa?: number;
  /** Per-pellet damage (gun + ammo shot_damage) used beyond point-blank. */
  shotDamage?: { type: string; amount: number; armor_penetration: number }[];
  /** Ammo effects (INCENDIARY, EXPLOSIVE, SHOT…) for the world layer. */
  ammoEffects?: string[];
  /** Recoil held back until the end of a burst (absorbed by skill), MOA. */
  delayedRecoil?: number;
  /** Recoil this shot added immediately, MOA. */
  addedRecoil?: number;
}

/**
 * Fire one round (Character::fire_gun's loop body): malfunction/jam roll, dispersion into a
 * cone angle, recoil (CDDA: 5 × gun_recoil × (1 − absorb) now, gun_recoil × absorb delayed to
 * the end of the burst, absorb = skill/20), ammo use, skill training. The caller raycasts
 * `spread`/`azimuth` from the view direction and applies `damage` (or `pellets` × `shotDamage`)
 * to whatever it hits. `burst` picks the burst sound ("Brrrap!").
 */
export function fireGun(c: Character, gun: Item, rng: Rng, opts: { burst?: boolean } = {}): ShotResult {
  const fail = (message: string): ShotResult => {
    c.msg(message);
    return { ok: false, message, spread: 0, azimuth: 0, maxSpread: 0, damage: [], range: 0, noise: { volume: 0, sound: '' }, moves: 0, cooldownSeconds: 0 };
  };
  if (!gun.isGun()) return fail(`You can't fire your ${gun.name()}.`);
  if (isJammed(gun)) return fail(`Your ${gun.baseName()} is jammed!`);
  if (gun.ammoRemaining() <= 0) return fail(`Your ${gun.baseName()} is empty!`);
  const malfunction = rollMalfunction(gun, rng);
  if (malfunction) return fail(malfunction);
  const ammo = gun.ammoData()!;
  const src = weaponDispersionSources(c, gun);
  const moa = rollDispersionMoa(src, rng);
  const damage = gun.gunDamage();
  const noise = gun.gunNoise(!!opts.burst);
  const pellets = Math.max(1, Number(ammo.projectile_count) || 1);
  let shotDamage: ShotResult['shotDamage'];
  if (pellets > 1) {
    const per = new Map<string, { type: string; amount: number; armor_penetration: number }>();
    for (const u of [...asArray(gun.def.ranged_damage), ...asArray(ammo.shot_damage as DamageUnit[] | undefined)]) {
      const e = per.get(u.damage_type) ?? { type: u.damage_type, amount: 0, armor_penetration: 0 };
      e.amount += u.amount;
      e.armor_penetration += u.armor_penetration ?? 0;
      per.set(u.damage_type, e);
    }
    shotDamage = [...per.values()];
  }
  gun.ammoConsume(1);
  const skill = gun.def.skill ?? 'gun';
  const absorb = Math.min(c.getSkill(skill), 10) / 20;
  const qty = gunRecoil(c, gun);
  const added = 5 * qty * (1 - absorb);
  c.recoil = Math.min(MAX_RECOIL, c.recoil + added);
  // ranged.cpp: shots train the gun skill and marksmanship a little each.
  c.practice('gun', 5);
  c.practice(skill, 10);
  const range = Math.max(0, ((ammo.range ?? 0) + (gun.def.range ?? 0) + modSum(gun, 'range_modifier')));
  // Firing takes 100 moves for semi-autos plus action time (ranged.cpp action_time).
  const moves = 100;
  return {
    ok: true,
    message: noise.sound,
    spread: moaToRadians(moa),
    azimuth: rng.next() * Math.PI * 2,
    maxSpread: moaToRadians(maxDispersionMoa(src)),
    damage,
    range,
    noise,
    moves,
    cooldownSeconds: moves / 100 / ACTION_SCALE,
    pellets,
    shotSpreadMoa: pellets > 1 ? (Number(ammo.shot_spread) || 0) * shotSpreadMultiplier(gun) : 0,
    shotDamage,
    ammoEffects: asArray(ammo.effects as string[] | undefined),
    delayedRecoil: qty * absorb,
    addedRecoil: added,
  };
}

/** Apply the recoil a burst held back (fire_gun's `delay`), capped at MAX_RECOIL. */
export function applyDelayedRecoil(c: Character, delay: number): void {
  c.recoil = Math.min(MAX_RECOIL, c.recoil + delay);
}

/**
 * Pellet deviation for one shotgun pellet (ballistics.cpp): |rng_normal(−spread, spread)|
 * (a normal with sd spread/2, clamped), capped at 30°, radians, random side.
 */
export function pelletAngle(shotSpreadMoa: number, rng: Rng): number {
  if (shotSpreadMoa <= 0) return 0;
  const s = Math.min(shotSpreadMoa, Math.max(-shotSpreadMoa, normalRoll(rng, 0, shotSpreadMoa / 2)));
  const arc = Math.min(moaToRadians(Math.abs(s)), Math.PI / 6);
  return rng.oneIn(2) ? arc : -arc;
}

// ---------------------------------------------------------------- monsters vs characters

/**
 * anatomy::select_body_part (BN): weight each part by hit_size_relative for the size
 * difference between attacker and target (index 1 + clamp(diff, -1, 1)); a smaller attacker
 * mostly hits legs and never the head (`canAttackHigh: false` = one size smaller). Good rolls
 * favour hard-to-hit parts (weight *= hitRoll ^ hit_difficulty). `minHitSize` keeps parts
 * whose plain hit_size is at least that big (grabs want limbs, not eyes).
 */
export function selectBodyPart(rng: Rng, opts: { canAttackHigh?: boolean; hitRoll?: number; minHitSize?: number; sizeDiff?: number } = {}): BodyPartId {
  const diff = opts.sizeDiff ?? (opts.canAttackHigh === false ? -1 : 0);
  const idx = 1 + Math.max(-1, Math.min(1, Math.trunc(diff)));
  const entries: [BodyPartId, number][] = [];
  for (const id of ALL_PARTS) {
    const bp = BODY_PARTS[id];
    let w = bp.hit_size_relative[idx];
    if (w <= 0) continue;
    if (opts.minHitSize !== undefined && bp.hit_size < opts.minHitSize) continue;
    if ((opts.hitRoll ?? 0) > 0) w *= Math.pow(opts.hitRoll!, bp.hit_difficulty);
    entries.push([id, w]);
  }
  return rng.weighted(entries);
}

export type CreatureSize = 'tiny' | 'small' | 'medium' | 'large' | 'huge';

/** monstergenerator.cpp volume_to_size thresholds (ml). */
export function sizeFromVolume(ml: number): CreatureSize {
  if (ml <= 7500) return 'tiny';
  if (ml <= 46250) return 'small';
  if (ml <= 77500) return 'medium';
  if (ml <= 483750) return 'large';
  return 'huge';
}

/** Creature::size_melee_penalty: small targets are harder to hit. */
export function sizeMeleePenalty(size: CreatureSize): number {
  return { tiny: 30, small: 15, medium: 0, large: -10, huge: -20 }[size];
}

/** monster::can_attack_high: medium+ monsters, flyers, ATTACK_UPPER. */
export function monsterCanAttackHigh(mon: MonsterDef): boolean {
  const size = sizeFromVolume(mon.volume);
  if (mon.flags.includes('ATTACK_LOWER')) return false;
  return !(size === 'tiny' || size === 'small') || mon.flags.includes('FLIES') || mon.flags.includes('ATTACK_UPPER');
}

export interface MonsterAttackResult {
  hit: boolean;
  dodged: boolean;
  bp?: BodyPartId;
  /** Damage units before armor. */
  raw: { type: string; amount: number }[];
  /** After armor. */
  absorbed: { type: string; amount: number }[];
  result?: DamageResult;
  message: string;
  /** The survivor blocked part of it (block_hit). */
  block?: BlockResult;
}

/**
 * monster::melee_attack against a Character: hit roll normal(melee_skill*5, 25) vs the
 * character's dodge*5; body part by anatomy weights; damage = melee_damage units plus
 * bash dice(melee_dice, melee_dice_sides); worn armor absorbs; pain via takeHit.
 * `damage` overrides the default roll (monster_attack damage_max_instance etc.).
 */
export function monsterMeleeAttack(
  mon: MonsterDef,
  target: Character,
  rng: Rng,
  opts: { accuracy?: number; damage?: DamageUnit[]; bp?: BodyPartId; name?: string; dodgeable?: boolean } = {},
): MonsterAttackResult {
  const name = opts.name ?? `The ${typeof mon.name === 'string' ? mon.name : (mon.name as { str: string }).str}`;
  const acc = opts.accuracy ?? mon.melee_skill;
  const hitRoll = normalRoll(rng, acc * 5, 25);
  const dodgeRoll = opts.dodgeable === false ? 0 : tryDodgeRoll(target);
  const spread = hitRoll - dodgeRoll;
  if (spread < 0) {
    if (opts.dodgeable !== false) onDodged(target, acc);
    const message = `${name} misses you.`;
    target.msg(message);
    return { hit: false, dodged: true, raw: [], absorbed: [], message };
  }
  let bp = opts.bp ?? selectBodyPart(rng, { canAttackHigh: monsterCanAttackHigh(mon), hitRoll: spread });
  const raw: { type: string; amount: number; armor_penetration?: number; armor_multiplier?: number }[] = [];
  for (const u of asArray(opts.damage ?? mon.melee_damage)) {
    if (u.amount > 0) raw.push({ type: u.damage_type, amount: u.amount, armor_penetration: u.armor_penetration, armor_multiplier: u.armor_multiplier });
  }
  if (!opts.damage && mon.melee_dice > 0) {
    const bash = rng.dice(mon.melee_dice, mon.melee_dice_sides);
    const e = raw.find((r) => r.type === 'bash');
    if (e) e.amount += bash;
    else raw.push({ type: 'bash', amount: bash });
  }
  const rawCopy = raw.map((r) => ({ type: r.type, amount: r.amount }));
  // Creature::deal_melee_hit -> block_hit before armor; a limb block moves the hit to that limb.
  const block = blockHit(target, raw, bp, sizeRank(sizeFromVolume(mon.volume)), rng);
  bp = block.bp;
  const absorbed = target.inv.absorbHit(bp, maArmor(target, raw), rng);
  const result = target.takeHit(bp, absorbed);
  const partName = BODY_PARTS[bp].name;
  const message = result.damage > 0 ? `${name} hits your ${partName}.` : `${name} hits your ${partName}, but your armor protects you.`;
  target.msg(message, result.damage > 0 ? 'c_red' : undefined);
  return { hit: true, dodged: false, bp, raw: rawCopy, absorbed, result, message, block: block.blocked ? block : undefined };
}

/** creature_size rank (tiny 1 .. huge 5) for technique conditions and block size checks. */
export function sizeRank(size: CreatureSize): number {
  return { tiny: 1, small: 2, medium: 3, large: 4, huge: 5 }[size];
}

/**
 * Character::dodge_roll (BN): get_dodge × 5, where every dodge already used up this turn
 * costs the equivalent of 2 dodge skill (dodges_left ≤ 0 → + dodges_left × 2 − 2). The roll
 * itself spends nothing: a dodge is only used up when the attack misses (onDodged). During a
 * side-step (combatfeel.ts) the step already paid for it: the roll gets the side-step bonus
 * and a miss spends no dodge.
 */
export function tryDodgeRoll(c: Character): number {
  const ma = maOf(c);
  const d = c.dodge();
  const step = c.effects.has('downed') ? null : sidestepDodgeRoll(d, defenseOf(c));
  ma.sidestepDodge = step !== null;
  if (step !== null) return step;
  if (d <= 0) return 0;
  const penalty = ma.dodgesLeft <= 0 ? ma.dodgesLeft * 2 - 2 : 0;
  return Math.max(0, d + penalty) * 5;
}

/**
 * Character::on_dodge: the attack missed. Uses up a dodge (unless a side-step covered it),
 * trains dodge by the attacker's skill and fires the ondodge martial-arts buffs.
 */
export function onDodged(c: Character, attackerSkill: number): void {
  const ma = maOf(c);
  if (!ma.sidestepDodge) ma.dodgesLeft--;
  ma.sidestepDodge = false;
  const diff = Math.max(0, Math.trunc(attackerSkill));
  c.practice('dodge', diff * 2, diff);
  triggerBuffs(c, 'ondodge');
}

/** Martial-arts "armor" buffs reduce incoming damage per type (mabuff_armor_bonus). */
export function maArmor<T extends { type: string; amount: number }>(c: Character, units: T[]): T[] {
  for (const u of units) {
    const a = buffFlat(c, 'armor', u.type);
    if (a > 0) u.amount = Math.max(0, u.amount - a);
  }
  return units;
}

/** A character hit in melee by another character (NPC fights): block, then armor. */
export function characterDefend(target: Character, units: { type: string; amount: number; armor_penetration?: number }[], bp: BodyPartId, rng: Rng, silent = false): { bp: BodyPartId; block: BlockResult } {
  const block = blockHit(target, units, bp, 3, rng, { silent });
  maArmor(target, units);
  return { bp: block.bp, block };
}

/** monster::melee_attack cost: 100 moves per attack at the monster's speed, in seconds. */
export function monsterAttackCooldownSeconds(mon: MonsterDef, moveCost = 100): number {
  return moveCost / Math.max(1, mon.speed) / MELEE_SCALE;
}
