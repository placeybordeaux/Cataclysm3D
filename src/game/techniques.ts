import type { GameData } from '../data/types';
import type { Rng } from '../core/rng';
import { warnOnce } from '../data/warn';
import type { Character } from './character';
import type { Item } from './item';
import { consumeItem, L, moveItem } from './moves';
import { BODY_PARTS, type BodyPartId } from './bodyparts';
import { blockAttemptChance, defenseOf, guardScoreBonus } from './combatfeel';
import {
  buffFlat, currentStyle, flatBonus, isUnarmedWeapon, maOf, multBonus, requirementsMet, triggerBuffs,
  type BonusEntry, type MaRequirements,
} from './martialarts';

// Weapon/martial-arts techniques, blocking and melee wear (Bright Nights melee.cpp): which
// technique a swing uses (Character::get_valid_techniques / pick_technique), how it changes
// damage and move cost (perform_technique), block_hit with a weapon or limb, and
// handle_melee_wear / glass shattering. Pure functions over Characters and Items; the world
// layer (playercombat.ts, npcai.ts) applies the resulting monster effects (stun, downed,
// knockback, AoE).
//
// BN vs DDA: techniques have no dialogue `condition`s, tech_effects or repeat counts. Target
// gating is the fixed booleans downed_target / stunned_target / human_target, techniques that
// down (down_dur) skip an already-downed target, disarms / take_weapon need an armed target,
// and everything else is ma_requirements (martialarts.ts requirementsMet). A technique's flat
// damage only adds to damage types the blow already has.

export interface TechniqueDef extends MaRequirements {
  id: string;
  name: string;
  description?: string;
  messages?: [string, string];
  dummy?: boolean;
  defensive?: boolean;
  crit_tec?: boolean;
  crit_ok?: boolean;
  dodge_counter?: boolean;
  block_counter?: boolean;
  miss_recovery?: boolean;
  grab_break?: boolean;
  /** Only against a downed / stunned / HUMAN-species target. */
  downed_target?: boolean;
  stunned_target?: boolean;
  human_target?: boolean;
  /** The blow is a kick/punch even with a weapon in hand (damage rolls unarmed). */
  force_unarmed?: boolean;
  weighting?: number;
  stun_dur?: number;
  down_dur?: number;
  knockback_dist?: number;
  knockback_spread?: number;
  knockback_follow?: boolean;
  powerful_knockback?: boolean;
  controlled_knockback?: boolean;
  side_switch?: boolean;
  disarms?: boolean;
  take_weapon?: boolean;
  aoe?: string;
  flags?: string[];
  flat_bonuses?: BonusEntry[];
  mult_bonuses?: BonusEntry[];
}

/** What the attacker knows about its target for technique gating. */
export interface TargetInfo {
  /** creature_size 1 (tiny) .. 5 (huge); humans are 3. */
  size: number;
  bodytype?: string;
  species?: string[];
  flags?: string[];
  hasEffect?: (id: string) => boolean;
  isMonster: boolean;
  /** An NPC holds a weapon / a monster has a monster_weapon that isn't knocked away. */
  hasWeapon?: boolean;
  volumeMl?: number;
  grabStrength?: number;
}

export function techniqueDef(data: GameData, id: string): TechniqueDef | undefined {
  const t = (data.misc?.technique as Record<string, TechniqueDef> | undefined)?.[id];
  if (!t) warnOnce('technique', id);
  return t;
}

/** character_martial_arts::get_all_techniques: the weapon's techniques + the style's. */
export function availableTechniques(c: Character, weapon: Item | null = c.inv.wielded): TechniqueDef[] {
  const style = currentStyle(c);
  const ids: string[] = [];
  if (weapon) ids.push(...((weapon.def.techniques as string[] | undefined) ?? []));
  ids.push(...(style.techniques ?? []));
  const out: TechniqueDef[] = [];
  for (const id of ids) {
    const t = techniqueDef(c.data, id);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Size rank of a Character (creature_size::medium = 3). */
export const HUMAN_SIZE = 3;

// ------------------------------------------------------------------ technique choice

export interface PickOpts {
  crit: boolean;
  dodgeCounter?: boolean;
  blockCounter?: boolean;
  /** Number of extra AoE victims for an aoe kind ("wide", "spin", "impale"). */
  aoeTargets?: (aoe: string) => number;
}

/** AoE kinds and the victims they need (valid_aoe_technique: spin needs two). */
function aoeValid(aoe: string, o: PickOpts): boolean {
  const n = o.aoeTargets?.(aoe) ?? 0;
  if (aoe === 'spin') return n >= 2;
  if (aoe === 'wide' || aoe === 'impale') return n >= 1;
  warnOnce('tec_aoe', aoe);
  return false;
}

/** One candidate of Character::get_valid_techniques (weighting is applied by pickTechnique). */
export function techniqueUsable(c: Character, tec: TechniqueDef, target: TargetInfo, weapon: Item | null, o: PickOpts, rng: Rng): boolean {
  if (tec.dummy || tec.defensive) return false;
  if (!!o.dodgeCounter !== !!tec.dodge_counter) return false;
  if (!!o.blockCounter !== !!tec.block_counter) return false;
  if (!tec.crit_ok && o.crit !== !!tec.crit_tec) return false;
  const downed = !!target.hasEffect?.('downed');
  if (downed && (tec.down_dur ?? 0) > 0) return false;
  if (!downed && tec.downed_target) return false;
  if (tec.stunned_target && !target.hasEffect?.('stunned')) return false;
  if (tec.disarms && !target.hasWeapon) return false;
  if (tec.take_weapon && (weapon || !target.hasWeapon)) return false;
  if (tec.human_target && !(target.species ?? []).includes('HUMAN')) return false;
  if (tec.aoe && !aoeValid(tec.aoe, o)) return false;
  if ((tec.weighting ?? 1) < 0 && !rng.oneIn(Math.abs(tec.weighting!))) return false;
  // ma_requirements, including wall_adjacent (martialarts.ts maWorld).
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

/**
 * get_miss_recovery_tec / get_grab_break_tec: the first technique of that kind among the
 * weapon's and the style's (grab breaks look at the style only: BN checks them with no
 * weapon). Whether the character may use it is requirementsMet's call: BN halves a miss's
 * cost as soon as a miss-recovery technique exists, valid or not.
 */
export function defensiveTechnique(c: Character, kind: 'miss_recovery' | 'grab_break', weapon: Item | null = c.inv.wielded): TechniqueDef | null {
  for (const t of availableTechniques(c, kind === 'grab_break' ? null : weapon)) if (t[kind]) return t;
  return null;
}

/** Character::can_use_grab_break_tec. */
export function grabBreakTechnique(c: Character): TechniqueDef | null {
  const t = defensiveTechnique(c, 'grab_break');
  return t && requirementsMet(c, t) ? t : null;
}

export interface DamageUnitLike {
  type: string;
  amount: number;
  armor_penetration: number;
  armor_multiplier: number;
  /** BN damage_multiplier already folded into amount (combat.ts RolledDamage). */
  multiplier?: number;
}

export interface TechniqueOutcome {
  stunTurns: number;
  downTurns: number;
  knockback: number;
  knockbackSpread: number;
  aoe?: string;
  disarms: boolean;
  takeWeapon: boolean;
  sideSwitch: boolean;
  knockbackFollow: boolean;
}

/**
 * perform_technique's damage/move part and the effects it rolls: per existing damage unit
 * flat damage (before that unit's multiplier), a damage multiplier and armor penetration;
 * move cost × mult + flat; downed rng(1, down_dur) turns with +3 bash; stunned rng(1,
 * stun_dur); knockback rng(1, dist) tiles, after which a target that can fall is downed for a
 * turn three times in four. The world layer applies the outcome.
 */
export function applyTechnique(
  c: Character, tec: TechniqueDef, units: DamageUnitLike[], moves: number, rng: Rng,
  target: { downable?: boolean; flies?: boolean } = {},
): { moves: number; outcome: TechniqueOutcome } {
  for (const u of units) {
    if (u.amount <= 0) continue;
    const mulBefore = u.multiplier ?? 1;
    const flat = flatBonus(c, tec.flat_bonuses, 'damage', u.type);
    const mult = multBonus(c, tec.mult_bonuses, 'damage', u.type);
    u.amount = (u.amount + flat * mulBefore) * mult;
    u.multiplier = mulBefore * mult;
    u.armor_penetration += flatBonus(c, tec.flat_bonuses, 'arpen', u.type);
  }
  let m = Math.trunc(moves * multBonus(c, tec.mult_bonuses, 'movecost'));
  m = Math.trunc(m + flatBonus(c, tec.flat_bonuses, 'movecost'));
  const downable = target.downable !== false;
  const outcome: TechniqueOutcome = {
    stunTurns: 0, downTurns: 0, knockback: 0, knockbackSpread: tec.knockback_spread ?? 0, aoe: tec.aoe || undefined,
    disarms: !!tec.disarms, takeWeapon: !!tec.take_weapon, sideSwitch: !!tec.side_switch, knockbackFollow: !!tec.knockback_follow,
  };
  if ((tec.down_dur ?? 0) > 0) {
    if (downable) outcome.downTurns = rng.int(1, tec.down_dur!);
    const bash = units.find((u) => u.type === 'bash' && u.amount > 0);
    if (bash) bash.amount += 3 * (bash.multiplier ?? 1);
  }
  if ((tec.stun_dur ?? 0) > 0) outcome.stunTurns = rng.int(1, tec.stun_dur!);
  if ((tec.knockback_dist ?? 0) > 0) {
    outcome.knockback = rng.int(1, tec.knockback_dist!);
    if (downable && !target.flies && outcome.downTurns === 0 && !rng.oneIn(4)) outcome.downTurns = 1;
  }
  return { moves: Math.max(0, m), outcome };
}

/** "You sweep %s" → "You sweep the zombie" (npc form for NPC attackers). */
export function techniqueMessage(tec: TechniqueDef, targetName: string, npcName?: string): string | null {
  const m = tec.messages?.[npcName ? 1 : 0];
  if (!m) return null;
  return m.replace('<npcname>', npcName ?? '').replace('%s', targetName);
}

// ------------------------------------------------------------------ blocking

/** melee.cpp blocking_ability: WBLOCK_3 8, WBLOCK_2 6, WBLOCK_1 4, BLOCK_WHILE_WORN 2. */
export function blockingAbility(it: Item | null): number {
  if (!it) return 0;
  const t = (it.def.techniques as string[] | undefined) ?? [];
  if (t.includes('WBLOCK_3')) return 8;
  if (t.includes('WBLOCK_2')) return 6;
  if (t.includes('WBLOCK_1')) return 4;
  if (it.hasFlag('BLOCK_WHILE_WORN')) return 2;
  return 0;
}

/**
 * Character::best_shield: the wielded blocking weapon, or an at-least-as-good worn
 * BLOCK_WHILE_WORN item (arm guards need a working arm on their side, leg guards a leg).
 */
export function bestShield(c: Character): Item | null {
  const w = c.inv.wielded;
  let best = blockingAbility(w);
  if (best === 2) best = 0; // BLOCK_WHILE_WORN only counts when worn
  let item: Item | null = best > 0 ? w : null;
  const covers = (it: Item, bp: string) => (it.def.armor ?? []).some((p) => ((p.covers as string[] | undefined) ?? []).includes(bp));
  for (const it of c.inv.worn) {
    if (!it.hasFlag('BLOCK_WHILE_WORN') || blockingAbility(it) < best) continue;
    const armL = covers(it, 'arm_l'), armR = covers(it, 'arm_r');
    if (armL || armR) {
      if ((armL && !c.isLimbBroken('arm_l')) || (armR && !c.isLimbBroken('arm_r'))) item = it;
    } else if (covers(it, 'leg_l') || covers(it, 'leg_r')) {
      if (c.brokenLegs() < 2) item = it;
    } else item = it;
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

/** Damage types a blocking item cuts to a fifth (block_hit's "elemental" list). */
const ELEMENTAL = new Set(['heat', 'acid', 'cold', 'dark', 'light', 'psi']);

export interface BlockResult {
  blocked: boolean;
  /** Thing blocked with ("baseball bat", "left arm"). */
  with?: string;
  /** Body part hit after a limb block (arm/leg); unchanged for item blocks. */
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
  /** A weapon broke; `spilled` is what it held, already on the ground (informational). */
  onWeaponBroken: ((c: Character, item: Item, spilled: Item[]) => void) | null;
} = { onBlock: null, onWeaponBroken: null };

/** character_martial_arts::can_arm_block / can_leg_block. */
function canArmBlock(c: Character, unarmedSkill: number): boolean {
  const style = currentStyle(c);
  if (c.isLimbBroken('arm_l') && c.isLimbBroken('arm_r')) return false;
  return unarmedSkill >= (style.arm_block ?? 99) || (!!style.arm_block_with_bio_armor_arms && !!blockHooks.hasBionic?.(c, 'bio_armor_arms'));
}
function canLegBlock(c: Character, unarmedSkill: number): boolean {
  const style = currentStyle(c);
  if (c.brokenLegs() >= 2) return false;
  return unarmedSkill >= (style.leg_block ?? 99) || (!!style.leg_block_with_bio_armor_legs && !!blockHooks.hasBionic?.(c, 'bio_armor_legs'));
}

/** item::conductive: CONDUCTIVE / NONCONDUCTIVE flags, else any material with elec_resist ≤ 1. */
export function itemConductive(data: GameData, it: Item): boolean {
  if (it.hasFlag('CONDUCTIVE')) return true;
  if (it.hasFlag('NONCONDUCTIVE')) return false;
  return (it.def.material ?? []).some((m) => {
    const r = (data.misc?.material?.[m] as { elec_resist?: number } | undefined)?.elec_resist;
    return (r ?? 0) <= 1;
  });
}

/** Installed-bionic lookup for the arm/leg block bionic exceptions (set by the bionics system). */
export const blockHooks: { hasBionic: ((c: Character, id: string) => boolean) | null } = { hasBionic: null };

/**
 * Character::block_hit (BN) against a melee attack. One block per turn (martial-arts
 * bonus_blocks add more). Score: with a shield or blocking weapon str + blocking_ability +
 * melee (bare-handed with a worn shield, the better of melee and unarmed); bare hands that may
 * limb-block (style arm_block/leg_block vs unarmed skill) str + melee + unarmed; bare hands
 * that may not still get their arms up with a score of 1. The healthiest allowed limb takes a
 * limb block (legs only for styles that teach leg blocks). logarithmic_range(0, 40, score) of
 * the physical damage gets through after martial-arts "block" buffs absorb flat damage; an
 * item block cuts elemental damage to a fifth (electric too, unless the item conducts).
 *
 * The combat-feel layer (combatfeel.ts) sits on top: unguarded, a block also needs its
 * melee×20 % reaction roll, stamina ≥ 2000 and an attacker at most one size larger, and costs
 * stamina; a raised guard skips the roll, blocks don't run out and the score gets the guard
 * (parry) bonus. Mutates `units`.
 */
export function blockHit(c: Character, units: { type: string; amount: number }[], bp: BodyPartId, attackerSize: number, rng: Rng, opts: { silent?: boolean } = {}): BlockResult {
  const none: BlockResult = { blocked: false, bp };
  if (c.isAsleep() || c.effects.has('narcosis')) return none;
  // Getting hit fires these even when the blow isn't blocked.
  triggerBuffs(c, 'ongethit');
  const ma = maOf(c);
  const guarding = defenseOf(c).guarding;
  const guard = guardScoreBonus(defenseOf(c));
  if (ma.blocksLeft < 1 && !guarding) return none;
  if (c.stamina < 2000) {
    if (!opts.silent) c.msg("You're close to exhaustion and cannot block effectively.", 'c_yellow');
    return none;
  }
  if (HUMAN_SIZE + 1 < attackerSize) return none;
  const melee = Math.trunc(c.getSkill('melee'));
  if (!guarding && !(rng.next() < blockAttemptChance(melee, false))) return none;
  if (ma.blocksLeft > 0) ma.blocksLeft--;

  let flatBlock = buffFlat(c, 'block');
  const style = currentStyle(c);
  const shield = bestShield(c);
  const unarmed = isUnarmedWeapon(c.inv.wielded);
  const forceUnarmed = !!style.force_unarmed;
  const itemBlocking = !forceUnarmed && !!shield && !unarmed;
  const unarmedSkill = Math.trunc(c.getSkill('unarmed'));
  const limbOk = canArmBlock(c, unarmedSkill) || canLegBlock(c, unarmedSkill);
  let score = 1;
  if (unarmed || forceUnarmed) {
    if (limbOk) score = c.str + melee + unarmedSkill;
    else if (shield) score = c.str + blockingAbility(shield) + Math.max(melee, unarmedSkill);
  } else if (shield) score = c.str + blockingAbility(shield) + melee;
  else return none;

  let withWhat: string;
  let hitBp = bp;
  let wear: WearResult | undefined;
  if (!forceUnarmed && shield) {
    withWhat = shield.baseName();
    wear = handleMeleeWear(c, shield, 1, rng, opts.silent);
  } else {
    const parts: BodyPartId[] = [];
    if (canLegBlock(c, unarmedSkill)) parts.push('leg_l', 'leg_r');
    // No leg blocks: you can always try with your arms.
    if (canArmBlock(c, unarmedSkill) || !parts.length) parts.push('arm_l', 'arm_r');
    const alive = parts.filter((p) => c.hp[BODY_PARTS[p].main].cur > 0);
    if (!alive.length) {
      ma.blocksLeft = 0;
      return none;
    }
    // std::max_element: the first of the healthiest.
    hitBp = alive.reduce((a, b) => (c.hp[BODY_PARTS[b].main].cur > c.hp[BODY_PARTS[a].main].cur ? b : a));
    withWhat = BODY_PARTS[hitBp].name;
  }
  score += guard.bonus;

  const through = logarithmicRange(0, 40, score);
  let total = 0, blocked = 0;
  const conductive = !!shield && itemConductive(c.data, shield);
  for (const u of units) {
    total += u.amount;
    if (u.type === 'bash' || u.type === 'cut' || u.type === 'stab') {
      const flat = Math.min(flatBlock, u.amount);
      flatBlock -= flat;
      u.amount -= flat;
      blocked += flat;
      if (u.amount <= 1e-6) continue;
      const prev = u.amount;
      u.amount *= through;
      blocked += prev - u.amount;
    } else if ((ELEMENTAL.has(u.type) && itemBlocking) || (u.type === 'electric' && itemBlocking && !conductive)) {
      const prev = u.amount;
      u.amount /= 5;
      blocked += prev - u.amount;
    }
  }
  const ratio = total > 1e-6 ? (total - blocked) / total : 0;
  const description = blocked >= total ? 'all' : ratio < 0.2 ? 'nearly all' : ratio < 0.4 ? 'most' : ratio < 0.6 ? 'a lot' : ratio < 0.8 ? 'some' : ratio > 1e-6 ? 'a little' : 'none';
  const message = guard.parry ? `You parry, and block ${description} of the damage with your ${withWhat}!` : `You block ${description} of the damage with your ${withWhat}!`;
  if (!opts.silent) c.msg(message);
  // Feel layer: blocking costs stamina (base burn 15 × 6 × (20 − melee)/20).
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

/**
 * A weapon breaks: what it held falls at the wielder's feet (or stays with them when there is
 * no ground), then the weapon is gone. Returns what spilled (already placed).
 */
function destroyItem(c: Character, it: Item): Item[] {
  const loc = c.inv.locOf(it);
  if (!loc) return [];
  const away = c.inv.groundHere() ?? L.inv(c);
  const spilled: Item[] = [];
  for (const x of [...it.allContents()]) {
    const from = x === it.magazine ? L.mag(it) : it.gunmods.includes(x) ? L.mod(it) : L.in(it);
    if (moveItem(x, from, away, { force: true, quiet: true }).ok) spilled.push(x);
  }
  consumeItem(it, loc);
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
