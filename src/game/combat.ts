import type { DamageUnit, MonsterDef } from '../data/types';
import type { Rng } from '../core/rng';
import { ACTION_SCALE, MELEE_SCALE } from '../core/time';
import { ALL_PARTS, BODY_PARTS, type BodyPartId } from './bodyparts';
import { MAX_RECOIL, type Character, type DamageResult } from './character';
import { asArray, type Item } from './item';
import { buffFlat, buffMult, currentStyle, maOf, triggerBuffs } from './martialarts';
import { aimLevel, isJammed, modSum, rollMalfunction, shotSpreadMultiplier, sightDispersion, type AimLevel } from './gunmods';
import {
  applyTechnique, blockHit, defensiveTechnique, glassShatter, handleMeleeWear, pickTechnique, techniqueMessage,
  type BlockResult, type ShatterResult, type TargetInfo, type TechniqueDef, type TechniqueOutcome, type WearResult,
} from './techniques';

// Combat math, ported from CDDA melee.cpp / ranged.cpp / monster.cpp. Pure functions over a
// Character, Items and plain target stats; they take an Rng so results are reproducible.
// Applying damage to monsters and spawning projectiles is the world-combat layer's job.

/** Damage after rolling, before the target's armor. */
export interface RolledDamage {
  type: string;
  amount: number;
  armor_penetration: number;
  /** Fraction of armor that still applies (crits lower it). */
  armor_multiplier: number;
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

/** Skill the weapon trains/uses; unarmed when no weapon. */
export function weaponSkill(weapon: Item | null): string {
  return weapon ? weapon.meleeSkill() : 'unarmed';
}

/** Character::get_hit_weapon + get_hit_base (+ effect hit_mod, torso encumbrance). */
export function meleeHitBase(c: Character, weapon: Item | null): number {
  const skill = c.getSkill(weaponSkill(weapon));
  // Martial-arts buffs add accuracy (Character::get_hit_base + mabuff_tohit_bonus).
  let hit = c.dex / 4 + skill / 3 + c.getSkill('melee') / 2 + (weapon?.toHit() ?? 0) + c.hit_bonus + buffFlat(c, 'hit');
  // "Your torso encumbrance throws you off-balance." (get_miss_reason weight enc/10)
  hit -= c.inv.encumbrance('torso') / 10;
  if (c.effects.has('downed')) hit -= 8;
  else if (c.crouching) hit -= 2;
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

/**
 * Character::attack_speed (melee.cpp): moves per attack. base = attack_time/2, melee skill
 * adds base*(15-skill)/15, dex subtracts dex/2, low stamina up to doubles it. Min 25.
 */
export function attackSpeedMoves(c: Character, weapon: Item | null): number {
  // Unarmed: item() null reference has 0 volume/weight -> attack_time 65.
  const attackTime = weapon ? weapon.attackTime() : 65;
  const base = Math.floor(attackTime / 2);
  const skillCost = Math.trunc((base * (15 - c.getSkill('melee'))) / 15);
  const dexBonus = Math.trunc(c.dex / 2);
  const staminaRatio = c.stamina / c.staminaMax();
  const staminaPenalty = 1 + Math.max((0.25 - staminaRatio) * 4, 0);
  let cost = base * staminaPenalty + skillCost - dexBonus;
  // Martial-arts buffs scale then offset the cost (mabuff_attack_cost_mult / _penalty).
  cost = cost * buffMult(c, 'movecost') + buffFlat(c, 'movecost');
  if (c.effects.has('downed')) cost *= 4;
  else if (c.crouching) cost *= 1.5;
  return Math.max(25, Math.trunc(cost));
}

/** Real-time cooldown between swings: moves / 100 turns / MELEE_SCALE turns per second. */
export function attackCooldownSeconds(c: Character, weapon: Item | null): number {
  return attackSpeedMoves(c, weapon) / 100 / MELEE_SCALE;
}

/** melee.cpp stumble(): extra moves lost on a miss with heavy/bulky weapons. */
export function stumbleMoves(c: Character, weapon: Item | null): number {
  if (!weapon) return 0;
  return Math.floor(weapon.volume() / 125 + weapon.weight() / (c.str * 10 + 13));
}

/** Character::get_total_melee_stamina_cost (positive number of stamina spent). */
export function meleeStaminaCost(c: Character, weapon: Item | null): number {
  const base = Math.floor((weapon?.weight() ?? 0) / 16) + 50;
  return Math.max(50, base - Math.round(c.getSkill('melee')) + (c.crouching ? 20 : 0));
}

/** Character::crit_chance (melee.cpp). */
export function critChance(c: Character, weapon: Item | null, rollHit: number, targetDodge: number): number {
  const lim = (p: number) => Math.max(0, Math.min(1, p));
  let weaponCrit = 0.5;
  if (!weapon) weaponCrit = 0.5 + 0.05 * c.getSkill('unarmed');
  const th = weapon?.toHit() ?? 0;
  if (th > 0) weaponCrit = Math.max(weaponCrit, 0.5 + 0.1 * th);
  else if (th < 0) weaponCrit += 0.1 * th;
  weaponCrit = lim(weaponCrit);
  const statCrit = lim(0.25 + 0.01 * c.dex + 0.02 * c.per);
  const sk = c.getSkill(weaponSkill(weapon)) + c.getSkill('melee') / 2.5;
  const skillCrit = lim(0.25 + sk * 0.025);
  const triple = weaponCrit * statCrit * skillCrit;
  const maCrit = buffFlat(c, 'crit_chance') / 100;
  if (rollHit > (targetDodge * 3) / 2) {
    const double = 0.5 * (weaponCrit * statCrit + statCrit * skillCrit + weaponCrit * skillCrit - 3 * triple);
    return triple + double + maCrit;
  }
  return triple + maCrit;
}

/**
 * roll_melee_damage_internal for bash/cut/stab, plus other damage types flat. Strength adds
 * rng(str/2, str) bash, capped by 2*str + 2*skill; skill multiplies damage; crits add
 * damage and armor penetration per type. `average` gives expected values (item info).
 */
export function rollMeleeDamage(c: Character, weapon: Item | null, crit: boolean, rng: Rng, average = false): RolledDamage[] {
  const out: RolledDamage[] = [];
  const unarmed = !weapon;
  // Unarmed blows land with whatever covers the hand (outfit::current_unarmed_weapon): claws
  // and other integrated mutation armor add their melee damage, gloves mostly nothing.
  const fist = unarmed ? unarmedWeapon(c) : null;
  const types = new Set(['bash', 'cut', 'stab', ...Object.keys((weapon ?? fist)?.def.melee_damage ?? {})]);
  for (const dt of types) {
    let dmg = weapon ? weapon.meleeDamage(dt) : fist ? fist.meleeDamage(dt) : 0;
    // Martial-arts buffs: flat damage then a multiplier, plus armor penetration.
    const maArpen = buffFlat(c, 'arpen', dt);
    if (dt !== 'bash' && dt !== 'cut' && dt !== 'stab') {
      dmg = (dmg + buffFlat(c, 'damage', dt)) * buffMult(c, 'damage', dt);
      if (dmg > 0) out.push({ type: dt, amount: dmg, armor_penetration: maArpen, armor_multiplier: 1 });
      continue;
    }
    const skillId = unarmed ? 'unarmed' : dt === 'bash' ? 'bashing' : dt === 'cut' ? 'cutting' : 'stabbing';
    const skill = c.getSkill(skillId);
    let mul = 1;
    let arpen = maArpen;
    if (dt === 'bash') {
      const str = c.str;
      dmg += average ? str * 0.75 : str / 2 + rng.next() * (str / 2);
      const cap = 2 * str + 2 * skill;
      if (cap < dmg && weapon) mul *= (1 + cap / dmg) / 2;
      const lowCap = Math.min(1, str / 20);
      const min = lowCap * dmg;
      dmg = average ? (min + dmg) * 0.5 : min + rng.next() * (dmg - min);
    }
    dmg = (dmg + buffFlat(c, 'damage', dt)) * buffMult(c, 'damage', dt);
    if (dmg <= 0) continue;
    if (dt === 'stab') mul = skill <= 5 ? 0.66 + 0.1 * skill : 0.86 + 0.06 * skill;
    else mul *= skill < 5 ? 0.8 + 0.08 * skill : 0.96 + 0.04 * skill;
    let armorMult = 1;
    if (crit) {
      if (dt === 'stab') {
        mul *= 1 + skill / 10;
        armorMult = 1 - 0.34;
      } else if (dt === 'cut') {
        mul *= 1.25;
        arpen += 5;
        armorMult = 0.75;
      } else {
        mul *= 1.5;
        armorMult = 0.5;
      }
    }
    out.push({ type: dt, amount: dmg * mul, armor_penetration: arpen, armor_multiplier: armorMult });
  }
  return out;
}

/** Outermost worn item covering the right hand (the punching surface), or null. */
export function unarmedWeapon(c: Character): Item | null {
  const list = c.inv.wornCovering('hand_r');
  return list.find((it) => it.def.melee_damage && Object.keys(it.def.melee_damage).length) ?? null;
}

/** Flat per-type monster armor (MonsterDef.armor) applied like resistances::get_effective_resist. */
export function applyFlatArmor(units: RolledDamage[], armor: Record<string, number> | undefined): { type: string; amount: number }[] {
  return units.map((u) => {
    let res = armor?.[u.type] ?? 0;
    // Monsters: stab derives from cut * 0.8 when not given (damage_types.json derived_from).
    if (u.type === 'stab' && armor?.stab === undefined && armor?.cut !== undefined) res = armor.cut * 0.8;
    const mitigation = Math.max(res - u.armor_penetration, 0) * u.armor_multiplier;
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
  /** What technique conditions test; without it (legacy callers) no techniques are used. */
  info?: TargetInfo;
}

export interface MeleeOpts {
  /** melee_attack's allow_special: false for AoE follow-up swings (no techniques). */
  allowSpecial?: boolean;
  /** Use this technique (block counters, debug). */
  forceTechnique?: TechniqueDef;
  /** Extra AoE victims available for an aoe kind; AoE techniques need at least one. */
  aoeTargets?: (aoe: string) => number;
  reachAttack?: boolean;
  /** Target throw resistance is 0 (downed techniques apply). Default true. */
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
}

/**
 * One melee swing by `c` at a target (Character::melee_attack_abstract): hit roll, crit, a
 * technique chosen from the weapon and martial-art style (pick_technique) that scales damage and
 * move cost, glass shattering, weapon wear, martial-arts buff triggers (onattack/onhit/onmiss/
 * oncrit). Spends stamina and trains skills like CDDA. Technique effects on the target (stun,
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
  c.modStamina(-staminaCost);
  maOf(c).attacked = true;
  if (!hit) {
    const st = stumbleMoves(c, weapon);
    moves += Math.min(60, st);
    meleeTrain(c, weapon, false, rng);
    const recovery = defensiveTechnique(c, 'miss_recovery');
    let message: string;
    if (recovery) {
      moves = Math.trunc(moves / 2);
      message = techniqueMessage(recovery, targetName) ?? 'You miss.';
      if (!/[.!]$/.test(message)) message += '.';
    } else message = st >= 60 ? 'You miss and stumble with the momentum.' : st >= 10 ? 'You swing wildly and miss.' : 'You miss.';
    c.msg(message);
    triggerBuffs(c, 'onmiss');
    const wear = handleMeleeWear(c, weapon, 1, rng);
    triggerBuffs(c, 'onattack');
    return { hit, crit: false, hitSpread: spread, damage: [], total: 0, moves, cooldownSeconds: moves / 100 / MELEE_SCALE, staminaCost, message, technique: recovery, wear };
  }
  const crit = rng.next() < critChance(c, weapon, roll, target.dodge * 5);
  const units = rollMeleeDamage(c, weapon, crit, rng);
  let technique: TechniqueDef | null = null;
  let outcome: TechniqueOutcome | undefined;
  if (opts.forceTechnique) technique = opts.forceTechnique;
  else if (opts.allowSpecial !== false && target.info)
    technique = pickTechnique(c, target.info, weapon, { crit, aoeTargets: opts.aoeTargets, reachAttack: opts.reachAttack }, rng);
  if (technique) {
    const r = applyTechnique(c, technique, units, moves, rng, opts.downable !== false);
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
  meleeTrain(c, weapon, true, rng);
  if (crit) triggerBuffs(c, 'oncrit');
  // A shattered weapon is gone; otherwise it may wear from the blow.
  const wear = shatter.shattered ? undefined : handleMeleeWear(c, weapon, 1, rng);
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

/** melee.cpp melee_train: hits train (5..10), misses (2..5); melee gets half. */
export function meleeTrain(c: Character, weapon: Item | null, hit: boolean, rng: Rng): void {
  const [lo, hi] = hit ? [5, 10] : [2, 5];
  c.practice('melee', Math.ceil(rng.int(lo, hi) / 2), hi);
  c.practice(weaponSkill(weapon), rng.int(lo, hi), hi);
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
 * anatomy::select_body_part: weight by hit_size; attackers that can't reach high skip
 * LIMB_UPPER parts and triple LIMB_LOWER weights; good rolls favour hard-to-hit parts
 * (weight *= hitRoll ^ hit_difficulty).
 */
export function selectBodyPart(rng: Rng, opts: { canAttackHigh?: boolean; hitRoll?: number; minHitSize?: number } = {}): BodyPartId {
  const entries: [BodyPartId, number][] = [];
  for (const id of ALL_PARTS) {
    const bp = BODY_PARTS[id];
    let w = bp.hit_size;
    if (opts.minHitSize !== undefined && w < opts.minHitSize) continue;
    if (opts.canAttackHigh === false) {
      if (bp.upper) continue;
      if (bp.lower) w *= 3;
    }
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
    // Creature::on_dodge: dodging trains the skill, scaled by attacker skill.
    target.practice('dodge', Math.max(1, acc * 2), acc);
    triggerBuffs(target, 'ondodge');
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
 * Character dodge_roll + on_try_dodge: dodge × 5 while a dodge is left this turn (else 0).
 * Each attempt uses one up and burns stamina (base burn 15 × 6 × (20 − dodge skill)/20)
 * unless a free dodge from a martial-arts buff covers it.
 */
export function tryDodgeRoll(c: Character): number {
  const ma = maOf(c);
  const d = c.dodge();
  if (ma.dodgesLeft <= 0 || d <= 0) return 0;
  ma.dodgesLeft--;
  if (ma.freeDodgesLeft > 0) ma.freeDodgesLeft--;
  else c.modStamina(-Math.floor(15 * 6 * ((20 - c.getSkill('dodge')) / 20)));
  return d * 5;
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
