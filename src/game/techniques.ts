import type { GameData } from '../data/types';
import type { Rng } from '../core/rng';
import { warnOnce } from '../data/warn';
import { evalMathArray, type MathHost } from './talkmath';
import type { Character } from './character';
import type { Item } from './item';
import { BODY_PARTS, type BodyPartId } from './bodyparts';
import { blockAttemptChance, defenseOf, guardScoreBonus } from './combatfeel';
import {
  buffFlat, charHasFlag, currentStyle, flatBonus, maOf, multBonus, requirementsMet, triggerBuffs,
  type BonusEntry, type MaRequirements,
} from './martialarts';

// Weapon/martial-arts techniques, blocking and melee wear (CDDA melee.cpp): which technique a
// swing uses (Character::pick_technique / evaluate_technique), how it changes damage and move
// cost (perform_technique), block_hit with a weapon or limb, and handle_melee_wear / glass
// shattering. Pure functions over Characters and Items; the world layer (playercombat.ts,
// npcai.ts) applies the resulting monster effects (stun, downed, knockback, AoE).

export interface TechEffectData {
  id: string;
  chance?: number;
  duration?: number;
  on_damage?: boolean;
  permanent?: boolean;
  message?: string;
  condition?: unknown;
}

export interface TechniqueDef extends MaRequirements {
  id: string;
  name: string;
  description?: string;
  messages?: [string, string];
  dummy?: boolean;
  defensive?: boolean;
  crit_tec?: boolean;
  crit_ok?: boolean;
  reach_ok?: boolean;
  reach_tec?: boolean;
  dodge_counter?: boolean;
  block_counter?: boolean;
  miss_recovery?: boolean;
  grab_break?: boolean;
  weighting?: number;
  needs_ammo?: boolean;
  stun_dur?: number;
  down_dur?: number;
  knockback_dist?: number;
  knockback_spread?: number;
  knockback_follow?: boolean;
  side_switch?: boolean;
  disarms?: boolean;
  take_weapon?: boolean;
  aoe?: string;
  repeat_min?: number;
  repeat_max?: number;
  condition?: unknown;
  tech_effects?: TechEffectData[];
  flat_bonuses?: BonusEntry[];
  mult_bonuses?: BonusEntry[];
}

/** What the attacker knows about its target for technique conditions. */
export interface TargetInfo {
  /** creature_size 1 (tiny) .. 5 (huge); humans are 3. */
  size: number;
  bodytype?: string;
  species?: string[];
  flags?: string[];
  hasEffect?: (id: string) => boolean;
  isMonster: boolean;
  hasWeapon?: boolean;
  volumeMl?: number;
  grabStrength?: number;
  /** Throw resistance (monsters: 0 unless they have the effect); downed only applies at 0. */
  immobile?: boolean;
}

export function techniqueDef(data: GameData, id: string): TechniqueDef | undefined {
  const t = (data.misc?.technique as Record<string, TechniqueDef> | undefined)?.[id];
  if (!t) warnOnce('technique', id);
  return t;
}

/** Weapon techniques (unless the style forces unarmed) + the style's techniques. */
export function availableTechniques(c: Character, weapon: Item | null = c.inv.wielded): TechniqueDef[] {
  const style = currentStyle(c);
  const ids: string[] = [];
  if (weapon && !style.force_unarmed) ids.push(...((weapon.def.techniques as string[] | undefined) ?? []));
  ids.push(...(style.techniques ?? []));
  const out: TechniqueDef[] = [];
  for (const id of ids) {
    const t = techniqueDef(c.data, id);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

// ------------------------------------------------------------------ conditions

/** Size rank of a Character for `u_val('size')` (CDDA creature_size::medium = 3). */
export const HUMAN_SIZE = 3;

/**
 * The subset of CDDA dialogue conditions technique data uses (u = attacker, npc = target):
 * and/or/not, math on u_val/n_val('size') and volumes, npc_has_effect/flag/species/bodytype,
 * u_has_effect/flag/trait, npc_is_monster/character, roll_contested. Anything else warns
 * once and counts as false, so an unsupported technique is never used by accident.
 */
export function techConditionMet(cond: unknown, u: Character, t: TargetInfo, rng: Rng): boolean {
  if (cond === undefined || cond === null) return true;
  if (typeof cond === 'string') {
    if (cond === 'npc_is_monster') return t.isMonster;
    if (cond === 'npc_is_character') return !t.isMonster;
    if (cond === 'u_is_character') return true;
    warnOnce('tec_condition', cond);
    return false;
  }
  if (Array.isArray(cond)) return cond.every((c) => techConditionMet(c, u, t, rng));
  const o = cond as Record<string, any>;
  if ('and' in o) return (o.and as unknown[]).every((c) => techConditionMet(c, u, t, rng));
  if ('or' in o) return (o.or as unknown[]).some((c) => techConditionMet(c, u, t, rng));
  if ('not' in o) return !techConditionMet(o.not, u, t, rng);
  if ('math' in o) return evalMathArray(o.math, mathHost(u, t)) !== 0;
  if ('npc_has_effect' in o) return !!t.hasEffect?.(String(o.npc_has_effect));
  if ('npc_has_flag' in o) return (t.flags ?? []).includes(String(o.npc_has_flag));
  if ('npc_has_species' in o) return (t.species ?? []).includes(String(o.npc_has_species));
  if ('npc_bodytype' in o) return (t.bodytype ?? (t.isMonster ? '' : 'human')) === String(o.npc_bodytype);
  if ('u_has_effect' in o) return u.hasEffect(String(o.u_has_effect), o.bodypart as BodyPartId | undefined);
  if ('u_has_flag' in o) {
    const f = String(o.u_has_flag);
    // GRAB is the flag of the "grabbed" effect.
    if (f === 'GRAB') return u.hasEffect('grabbed');
    return charHasFlag(u, f);
  }
  if ('u_has_trait' in o) return u.hasTrait(String(o.u_has_trait));
  if ('u_has_any_trait' in o) return (o.u_has_any_trait as string[]).some((tr) => u.hasTrait(tr));
  if ('roll_contested' in o) {
    const h = mathHost(u, t);
    const val = Array.isArray(o.roll_contested?.math) ? evalMathArray(o.roll_contested.math, h) : Number(o.roll_contested) || 0;
    const diff = Array.isArray(o.difficulty?.math) ? evalMathArray(o.difficulty.math, h) : Number(o.difficulty) || 0;
    return rng.int(1, Number(o.die_size) || 20) + val > diff;
  }
  warnOnce('tec_condition', Object.keys(o)[0] ?? '?');
  return false;
}

function mathHost(u: Character, t: TargetInfo): MathHost {
  const uVal = (k: string): number => {
    switch (k) {
      case 'size': return HUMAN_SIZE;
      case 'strength': return u.str;
      case 'dexterity': return u.dex;
      case 'intelligence': return u.int;
      case 'perception': return u.per;
      default: warnOnce('tec_u_val', k); return 0;
    }
  };
  const nVal = (k: string): number => {
    switch (k) {
      case 'size': return t.size;
      case 'grab_strength': return t.grabStrength ?? 0;
      default: warnOnce('tec_n_val', k); return 0;
    }
  };
  return {
    getVar: () => undefined,
    setVar: () => {},
    call(name, args) {
      if (name === 'u_val') return uVal(String(args[0]));
      if (name === 'n_val') return nVal(String(args[0]));
      if (name === 'u_volume') return u.bodyweightKg() * 1000; // ~1 L per kg of body
      if (name === 'n_volume') return t.volumeMl ?? t.size * 25000;
      return undefined;
    },
  };
}

// ------------------------------------------------------------------ technique choice

export interface PickOpts {
  crit: boolean;
  dodgeCounter?: boolean;
  blockCounter?: boolean;
  reachAttack?: boolean;
  /** Number of extra AoE victims for an aoe kind ("wide", "spin", "impale"). */
  aoeTargets?: (aoe: string) => number;
  wallAdjacent?: boolean;
}

/** Character::evaluate_technique for one candidate. */
export function techniqueUsable(c: Character, tec: TechniqueDef, target: TargetInfo, weapon: Item | null, o: PickOpts, rng: Rng): boolean {
  if (tec.dummy || tec.defensive) return false;
  if ((tec.wall_adjacent) && !o.wallAdjacent) return false;
  if (!(tec.reach_ok || tec.reach_tec) && o.reachAttack) return false;
  if (tec.reach_tec && !o.reachAttack) return false;
  if (!!o.dodgeCounter !== !!tec.dodge_counter) return false;
  if (!!o.blockCounter !== !!tec.block_counter) return false;
  if (!tec.crit_ok && o.crit !== !!tec.crit_tec) return false;
  if (tec.needs_ammo && !(weapon && weapon.ammoRemaining() > 0)) return false;
  if (tec.disarms && !target.hasWeapon) return false;
  if (tec.take_weapon && (weapon || !target.hasWeapon)) return false;
  if (tec.aoe && (o.aoeTargets?.(tec.aoe) ?? 0) <= 0) return false;
  // Conditions can roll dice (roll_contested), so they go after the cheap checks.
  if (tec.condition !== undefined && !techConditionMet(tec.condition, c, target, rng)) return false;
  if ((tec.weighting ?? 1) < 0 && !rng.oneIn(Math.abs(tec.weighting!))) return false;
  return requirementsMet(c, tec, weapon);
}

/** Character::pick_technique: every valid technique `weighting` times, one at random. */
export function pickTechnique(c: Character, target: TargetInfo, weapon: Item | null, o: PickOpts, rng: Rng): TechniqueDef | null {
  const pool: TechniqueDef[] = [];
  for (const tec of availableTechniques(c, weapon)) {
    if (!techniqueUsable(c, tec, target, weapon, o, rng)) continue;
    for (let i = 0; i < Math.max(1, tec.weighting ?? 1); i++) pool.push(tec);
  }
  return pool.length ? rng.pick(pool) : null;
}

/** The first valid miss-recovery / grab-break technique (get_valid_technique). */
export function defensiveTechnique(c: Character, kind: 'miss_recovery' | 'grab_break'): TechniqueDef | null {
  for (const t of availableTechniques(c)) if (t[kind] && requirementsMet(c, t)) return t;
  return null;
}

export interface DamageUnitLike {
  type: string;
  amount: number;
  armor_penetration: number;
  armor_multiplier: number;
}

export interface TechniqueOutcome {
  /** Repeats (repeat_min..max): effects apply once per repeat. */
  repeats: number;
  stunTurns: number;
  downTurns: number;
  knockback: number;
  knockbackSpread: number;
  aoe?: string;
  disarms: boolean;
  sideSwitch: boolean;
  effects: TechEffectData[];
}

/**
 * perform_technique's damage/move part: multiply per-type damage, add flat damage and armor
 * penetration (per repeat), scale the move cost. Returns the new move cost and the effects
 * the world layer must apply. `targetDownable` = throw resistance 0 (downed adds +3 bash).
 */
export function applyTechnique(c: Character, tec: TechniqueDef, units: DamageUnitLike[], moves: number, rng: Rng, targetDownable = true): { moves: number; outcome: TechniqueOutcome } {
  const rep = rng.int(tec.repeat_min ?? 1, tec.repeat_max ?? 1);
  const types = new Set([...units.map((u) => u.type), ...(tec.flat_bonuses ?? []).filter((b) => b.stat === 'damage' && b.type).map((b) => b.type!)]);
  for (const dt of types) {
    const mult = multBonus(c, tec.mult_bonuses, 'damage', dt);
    const flat = flatBonus(c, tec.flat_bonuses?.filter((b) => b.type === dt), 'damage', dt);
    const arpen = flatBonus(c, tec.flat_bonuses?.filter((b) => b.type === dt), 'arpen', dt);
    let u = units.find((x) => x.type === dt);
    if (u && mult !== 1) u.amount *= mult;
    if (flat !== 0 || arpen !== 0) {
      if (!u) units.push((u = { type: dt, amount: 0, armor_penetration: 0, armor_multiplier: 1 }));
      u.amount += flat * rep;
      u.armor_penetration += arpen * rep;
    }
  }
  let m = moves * multBonus(c, tec.mult_bonuses, 'movecost');
  m += flatBonus(c, tec.flat_bonuses, 'movecost') * rep;
  const outcome: TechniqueOutcome = {
    repeats: rep, stunTurns: 0, downTurns: 0, knockback: 0, knockbackSpread: tec.knockback_spread ?? 0, aoe: tec.aoe,
    disarms: !!tec.disarms, sideSwitch: !!tec.side_switch, effects: [],
  };
  const total = () => units.reduce((s, u) => s + u.amount, 0);
  for (let i = 0; i < rep; i++) {
    for (const e of tec.tech_effects ?? []) if (rng.int(1, 100) <= (e.chance ?? 100) && (total() !== 0 || !e.on_damage)) outcome.effects.push(e);
    if ((tec.down_dur ?? 0) > 0 && targetDownable) {
      outcome.downTurns = Math.max(outcome.downTurns, rng.int(1, tec.down_dur!));
      const bash = units.find((u) => u.type === 'bash' && u.amount > 0);
      if (bash) bash.amount += 3;
    }
    if ((tec.stun_dur ?? 0) > 0) outcome.stunTurns = Math.max(outcome.stunTurns, rng.int(1, tec.stun_dur!));
  }
  if ((tec.knockback_dist ?? 0) > 0) outcome.knockback = rng.int(1, tec.knockback_dist!);
  return { moves: Math.max(0, m), outcome };
}

/** "You sweep %s" → "You sweep the zombie" (npc form for NPC attackers). */
export function techniqueMessage(tec: TechniqueDef, targetName: string, npcName?: string): string | null {
  const m = tec.messages?.[npcName ? 1 : 0];
  if (!m) return null;
  return m.replace('<npcname>', npcName ?? '').replace('%s', targetName);
}

// ------------------------------------------------------------------ blocking

/** melee::blocking_ability: WBLOCK_3 10, WBLOCK_2 6, WBLOCK_1 4, BLOCK_WHILE_WORN 2. */
export function blockingAbility(it: Item | null): number {
  if (!it) return 0;
  const t = (it.def.techniques as string[] | undefined) ?? [];
  if (t.includes('WBLOCK_3')) return 10;
  if (t.includes('WBLOCK_2')) return 6;
  if (t.includes('WBLOCK_1')) return 4;
  if (it.hasFlag('BLOCK_WHILE_WORN')) return 2;
  return 0;
}

/** Character::best_shield: the wielded blocking weapon, or a better worn BLOCK_WHILE_WORN item. */
export function bestShield(c: Character): Item | null {
  const w = c.inv.wielded;
  let best = blockingAbility(w);
  if (best === 2) best = 0; // BLOCK_WHILE_WORN only counts when worn
  let item: Item | null = best > 0 ? w : null;
  for (const it of c.inv.worn) {
    if (!it.hasFlag('BLOCK_WHILE_WORN')) continue;
    const v = blockingAbility(it);
    if (v >= best) {
      best = v;
      item = it;
    }
  }
  return item;
}

/** cata_utility logarithmic_range: 1 at min falling to 0 at max along a logistic curve. */
export function logarithmicRange(min: number, max: number, pos: number): number {
  const CUT = 4;
  const logi = (t: number) => 1 / (1 + Math.exp(-t));
  const lo = logi(-CUT), hi = logi(CUT);
  if (pos <= min) return 1;
  if (pos >= max) return 0;
  const unit = (pos - min) / (max - min);
  return (logi(CUT - 2 * CUT * unit) - lo) / (hi - lo);
}

/** Physical melee damage types that blocking reduces normally (damage_type physical && melee_only). */
const PHYSICAL = new Set(['bash', 'cut', 'stab']);

export interface BlockResult {
  blocked: boolean;
  /** Thing blocked with ("baseball bat", "left arm"). */
  with?: string;
  /** Body part hit after a limb block (arm/leg); unchanged for weapon blocks. */
  bp: BodyPartId;
  /** "all" .. "none" of the damage. */
  description?: string;
  message?: string;
  weaponDamaged?: WearResult;
  /** Blocked with a freshly raised guard (combatfeel.ts parry window). */
  parry?: boolean;
}

/** Hooks the world layer sets (viewmodel block pose, spilled items). */
export const combatHooks: {
  onBlock: ((c: Character, withWhat: string) => void) | null;
  onWeaponBroken: ((c: Character, item: Item, spilled: Item[]) => void) | null;
} = { onBlock: null, onWeaponBroken: null };

/**
 * Character::block_hit against a melee attack: needs a block left this turn, stamina >= 2000,
 * an attacker at most one size larger, and a melee-skill reaction roll (x_in_y(melee*20, 100)). Weapon blocks use
 * str + WBLOCK bonus + melee skill; limb blocks (style arm_block/leg_block vs unarmed skill)
 * use str + unarmed skill and move the hit to that limb. The block score maps through
 * logarithmic_range(0, 40) to the fraction of physical damage that gets through; martial-arts
 * "block" buffs absorb flat damage first. Mutates `units`. While the survivor holds a guard
 * (combatfeel.ts) the reaction roll is skipped, blocks don't run out, the score gets the guard
 * bonus (more for a parry) and bare hands block with the arms.
 */
export function blockHit(c: Character, units: { type: string; amount: number }[], bp: BodyPartId, attackerSize: number, rng: Rng, opts: { silent?: boolean } = {}): BlockResult {
  const none: BlockResult = { blocked: false, bp };
  if (c.isAsleep() || c.effects.has('winded')) return none;
  triggerBuffs(c, 'ongethit');
  const ma = maOf(c);
  // A raised guard (combatfeel.ts) is the survivor choosing to block: BN's rule (no reaction
  // roll, blocks don't run out; each still costs stamina) plus a block-score bonus.
  const guarding = defenseOf(c).guarding;
  const guard = guardScoreBonus(defenseOf(c));
  if (ma.blocksLeft < 1 && !guarding) return none;
  // CDDA refuses to block below 2000 stamina (of ~8500 at default cardio).
  if (c.stamina < 2000) {
    if (!opts.silent) c.msg("You're close to exhaustion and cannot block effectively.", 'c_yellow');
    return none;
  }
  if (HUMAN_SIZE + 1 < attackerSize) return none;
  const melee = c.getSkill('melee');
  if (!guarding && !(rng.next() < blockAttemptChance(melee, false))) return none;
  if (ma.blocksLeft > 0) ma.blocksLeft--;

  let flatBlock = buffFlat(c, 'block');
  const style = currentStyle(c);
  const shield = bestShield(c);
  const wornShield = !!shield && shield.hasFlag('BLOCK_WHILE_WORN') && shield !== c.inv.wielded;
  const unarmed = !c.inv.wielded;
  const forceUnarmed = !!style.force_unarmed;
  const allowWeaponBlocking = !style.prevent_weapon_blocking;
  const armedBodyBlock = !!c.inv.wielded?.hasFlag('ALLOWS_BODY_BLOCK');
  const unarmedSkill = Math.round(c.getSkill('unarmed'));
  let score: number;
  let withWhat: string;
  let hitBp = bp;
  let wear: WearResult | undefined;
  if (unarmed || forceUnarmed || wornShield || armedBodyBlock || (shield && !allowWeaponBlocking)) {
    // Guarding bare-handed means arms up: a limb block even without a style that teaches it.
    const arm = (guarding || unarmedSkill >= (style.arm_block ?? 99)) && !c.isLimbBroken('arm_l') && !c.isLimbBroken('arm_r');
    const leg = unarmedSkill >= (style.leg_block ?? 99);
    if (!arm && !leg) return { ...none };
    score = c.str + unarmedSkill;
    // select_blocking_part: arms preferred, a random side.
    hitBp = arm ? (rng.oneIn(2) ? 'arm_l' : 'arm_r') : rng.oneIn(2) ? 'leg_l' : 'leg_r';
    if (wornShield && shield) {
      score += blockingAbility(shield);
      withWhat = shield.baseName();
    } else withWhat = BODY_PARTS[hitBp].name;
  } else if (shield) {
    score = c.str + blockingAbility(shield) + melee;
    withWhat = shield.baseName();
    wear = handleMeleeWear(c, shield, 1, rng, opts.silent);
  } else return { ...none };
  score += buffFlat(c, 'block_effectiveness') + guard.bonus;

  const through = logarithmicRange(0, 40, score);
  let total = 0, blocked = 0;
  for (const u of units) {
    total += u.amount;
    if (PHYSICAL.has(u.type)) {
      const flat = Math.min(flatBlock, u.amount);
      flatBlock -= flat;
      u.amount -= flat;
      blocked += flat;
      if (u.amount <= 1e-6) continue;
      const prev = u.amount;
      u.amount *= through;
      blocked += prev - u.amount;
    } else if (!unarmed && u.type !== 'electric') {
      const prev = u.amount;
      u.amount /= 5;
      blocked += prev - u.amount;
    }
  }
  const ratio = total > 1e-6 ? (total - blocked) / total : 0;
  const description = ratio < 1e-6 ? 'all' : ratio < 0.2 ? 'nearly all' : ratio < 0.4 ? 'most' : ratio < 0.6 ? 'a lot' : ratio < 0.8 ? 'some' : ratio > 1e-6 ? 'a little' : 'none';
  const message = guard.parry ? `You parry, and block ${description} of the damage with your ${withWhat}!` : `You block ${description} of the damage with your ${withWhat}!`;
  if (!opts.silent) c.msg(message);
  // Blocking costs stamina: base burn 15 × 6 × (20 − melee)/20 on CDDA's scale.
  c.modStamina(-Math.round(15 * 6 * ((20 - melee) / 20)));
  triggerBuffs(c, 'onblock');
  combatHooks.onBlock?.(c, withWhat);
  return { blocked: true, with: withWhat, bp: hitBp, description, message, weaponDamaged: wear, parry: guard.parry };
}

// ------------------------------------------------------------------ weapon wear

/** item::chip_resistance (best material, weighted by portion). */
export function chipResistance(it: Item): number {
  const mats = it.def.material ?? [];
  if (!mats.length) return 2;
  const portions = (it.def.material_portions as Record<string, number> | undefined) ?? {};
  const total = mats.reduce((s, m) => s + (portions[m] ?? 1), 0) || 1;
  let best = -Infinity;
  for (const m of mats) {
    const chip = (it.data.misc?.material?.[m] as { chip_resist?: number } | undefined)?.chip_resist ?? 0;
    best = Math.max(best, Math.trunc((chip * (portions[m] ?? 1)) / total));
  }
  return best === -Infinity ? 2 : best;
}

export interface WearResult {
  damaged: boolean;
  destroyed: boolean;
  message?: string;
  /** Contents spilled when destroyed. */
  spilled?: Item[];
}

/** Remove a destroyed weapon from wherever it is (wielded or worn), spilling its contents. */
function destroyItem(c: Character, it: Item): Item[] {
  const spilled = it.pockets.flatMap((p) => p.contents.splice(0));
  if (c.inv.wielded === it) c.inv.wielded = null;
  else c.inv.remove(it);
  combatHooks.onWeaponBroken?.(c, it, spilled);
  return spilled;
}

/**
 * Character::handle_melee_wear: chance 1 in (dex/2 + melee + 64/max(str,4)) × chip_resistance
 * (÷6 for FRAGILE_MELEE, ×4 for DURABLE_MELEE/STURDY) / wear_multiplier; a hit adds one damage
 * level (1000). UNBREAKABLE(_MELEE) items never wear.
 */
export function handleMeleeWear(c: Character, it: Item | null, wearMult: number, rng: Rng, silent = false): WearResult {
  const no: WearResult = { damaged: false, destroyed: false };
  if (!it || wearMult <= 0 || it.hasFlag('UNBREAKABLE_MELEE') || it.hasFlag('UNBREAKABLE')) return no;
  const statFactor = c.dex / 2 + c.getSkill('melee') + 64 / Math.max(c.str, 4);
  const material = it.hasFlag('FRAGILE_MELEE') ? chipResistance(it) / 6 : chipResistance(it);
  let chance = Math.trunc((statFactor * material) / wearMult);
  if (it.hasFlag('DURABLE_MELEE') || it.hasFlag('STURDY')) chance *= 4;
  if (chance > 0 && !rng.oneIn(chance)) return no;
  const name = it.name();
  if (!it.mod_damage(1000)) {
    const message = `Your ${name} is damaged by the force of the blow!`;
    if (!silent) c.msg(message, 'c_red');
    return { damaged: true, destroyed: false, message };
  }
  const spilled = destroyItem(c, it);
  const message = `Your ${name} is destroyed by the blow!`;
  if (!silent) c.msg(message, 'c_red');
  return { damaged: true, destroyed: true, message, spilled };
}

export interface ShatterResult {
  shattered: boolean;
  /** Extra cut damage dealt to the target. */
  extraCut: number;
  message?: string;
  spilled?: Item[];
}

/**
 * melee_special_effects glass weapons: vol = weapon volume × glass fraction / 250 ml; shatters
 * when rng_float(0, vol + 8) < vol + str. Cuts the wielder's arm (up to 7) and adds rng(0,
 * 5 + vol×1.5) cut to the blow.
 */
export function glassShatter(c: Character, it: Item | null, rng: Rng, silent = false): ShatterResult {
  const no: ShatterResult = { shattered: false, extraCut: 0 };
  if (!it) return no;
  const mats = it.def.material ?? [];
  if (!mats.includes('glass')) return no;
  const portions = (it.def.material_portions as Record<string, number> | undefined) ?? {};
  const total = mats.reduce((s, m) => s + (portions[m] ?? 1), 0) || 1;
  const frac = Math.min(1, (portions.glass ?? 1) / total);
  const vol = Math.trunc((it.volume() * frac) / 250);
  if (!(rng.next() * (vol + 8) < vol + c.str)) return no;
  const message = `Your ${it.name()} shatters!`;
  if (!silent) c.msg(message, 'c_red');
  const spilled = destroyItem(c, it);
  const cut = Math.min(7, Math.max(0, rng.int(0, vol * 2)));
  if (cut > 0) c.takeHit('arm_r', [{ type: 'cut', amount: cut }]);
  return { shattered: true, extraCut: rng.int(0, 5 + Math.trunc(vol * 1.5)), message, spilled };
}
