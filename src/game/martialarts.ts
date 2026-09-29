import type { GameData } from '../data/types';
import { warnOnce } from '../data/warn';
import { MELEE_SCALE } from '../core/time';
import type { Character } from './character';
import type { Item } from './item';

// Bright Nights martial arts (martialarts.cpp, character_martial_arts.cpp): styles
// (misc.martial_art) with their inline buffs, requirement checks shared with techniques
// (ma_requirements::is_valid_character), and the per-character state (known styles, the
// selected style, active buffs with stacks, and the per-turn dodge/block allowance).
//
// BN vs DDA: requirements are the flat ma_requirements fields (req_buffs, req_flags,
// mutations_required, unarmed_weapons_allowed, weapon_categories_allowed …): no forbidden-buff
// or character-flag lists, no dialogue conditions. Styles say `allow_melee` (DDA
// allow_all_weapons) and may require a `mutation`. Buffs are effects: 2 turns by default, a
// re-trigger refreshes the duration and adds a stack, and a buff that wasn't refreshed loses a
// stack every turn. To-hit bonuses don't multiply by stacks (Character::mabuff_tohit_bonus);
// scaling stats are only str/dex/int/per. Changing style keeps running buffs.
//
// Time: BN counts buffs and dodges in turns. Combat here runs at MELEE_SCALE turns per real
// second (one swing of a speed-100 zombie), so a "combat turn" is 1/MELEE_SCALE real seconds.
// State is attached to a Character through a WeakMap (`maOf(c)`) so NPCs get it for free and
// character.ts stays untouched.

/** Real seconds per BN turn for combat bookkeeping (buff durations, dodge/block refresh). */
export const COMBAT_TURN = 1 / MELEE_SCALE;

export interface BonusEntry {
  stat: string;
  type?: string;
  'scaling-stat'?: string;
  scale: number;
}

/** BN ma_requirements fields (shared by techniques and buffs; ma_requirements::load). */
export interface MaRequirements {
  unarmed_allowed?: boolean;
  melee_allowed?: boolean;
  /** Default true: UNARMED_WEAPON items (knuckles, gloves) count as unarmed. */
  unarmed_weapons_allowed?: boolean;
  strictly_unarmed?: boolean;
  wall_adjacent?: boolean;
  weapon_categories_allowed?: string | string[];
  skill_requirements?: { name: string; level: number }[];
  weapon_damage_requirements?: { type: string; min: number }[];
  /** Every one of these buffs must be active. */
  req_buffs?: string[];
  /** Weapon flags the wielded item must all have. */
  req_flags?: string[];
  /** Any one of these traits. */
  mutations_required?: string[];
}

export interface MaBuffDef extends MaRequirements {
  id: string;
  name: string;
  description?: string;
  /** Turns; BN default 2 (ma_buff::load). */
  buff_duration?: number;
  max_stacks?: number;
  bonus_dodges?: number;
  bonus_blocks?: number;
  quiet?: boolean;
  throw_immune?: boolean;
  stealthy?: boolean;
  flat_bonuses?: BonusEntry[];
  mult_bonuses?: BonusEntry[];
}

export type BuffTrigger = 'static' | 'onmove' | 'onpause' | 'onhit' | 'onattack' | 'ondodge' | 'onblock' | 'ongethit' | 'onmiss' | 'oncrit' | 'onkill';
export const BUFF_TRIGGERS: BuffTrigger[] = ['static', 'onmove', 'onpause', 'onhit', 'onattack', 'ondodge', 'onblock', 'ongethit', 'onmiss', 'oncrit', 'onkill'];

export interface MartialArtDef {
  id: string;
  name: string;
  description?: string;
  initiate?: string[];
  /** Unarmed skill needed for arm/leg blocks (BN default 99 = never). */
  arm_block?: number;
  leg_block?: number;
  arm_block_with_bio_armor_arms?: boolean;
  leg_block_with_bio_armor_legs?: boolean;
  /** Every weapon is valid for the style's buffs and techniques. */
  allow_melee?: boolean;
  strictly_unarmed?: boolean;
  strictly_melee?: boolean;
  force_unarmed?: boolean;
  weapons?: string[];
  weapon_category?: string[];
  /** Requirements need one of these traits (martialart::mutation). */
  mutation?: string[];
  techniques?: string[];
  /** [skill, level]: BN writes the level as a string. */
  autolearn?: [string, number | string][];
  learn_difficulty?: number;
  primary_skill?: string;
  [k: string]: unknown;
}

export interface ActiveBuff {
  def: MaBuffDef;
  /** Real seconds left. */
  left: number;
  /** Effect intensity. */
  stacks: number;
  /** Re-triggered since the last turn tick (a refreshed buff doesn't lose a stack). */
  refreshed?: boolean;
}

export interface MartialArtsJSON {
  known: string[];
  style: string;
  buffs?: { id: string; left: number; stacks: number }[];
}

/** Per-character martial-arts and defense state. */
export class MartialArtsState {
  readonly known = new Set<string>(['style_none']);
  style = 'style_none';
  readonly buffs = new Map<string, ActiveBuff>();
  /** Dodges left this turn; goes negative when dodging more (each costs 2 dodge). */
  dodgesLeft = 1;
  blocksLeft = 1;
  /** The last dodge roll came from a side-step window (a miss then spends no dodge). */
  sidestepDodge = false;
  /** Real-time accumulators for per-turn processing. */
  turnAcc = 0;
  /** Set by the owner's movement each tick (onmove vs onpause buffs). */
  moved = false;
  attacked = false;

  constructor(readonly c: Character) {}

  toJSON(): MartialArtsJSON {
    return {
      known: [...this.known],
      style: this.style,
      buffs: [...this.buffs.values()].map((b) => ({ id: b.def.id, left: b.left, stacks: b.stacks })),
    };
  }
  load(j: MartialArtsJSON, warn: (m: string) => void = () => {}): void {
    const data = this.c.data;
    this.known.clear();
    this.known.add('style_none');
    for (const id of j.known) {
      if (styleDef(data, id)) this.known.add(id);
      else warn(`unknown martial art ${id}`);
    }
    this.style = this.known.has(j.style) ? j.style : 'style_none';
    this.buffs.clear();
    for (const b of j.buffs ?? []) {
      const def = buffDef(data, b.id);
      if (def) this.buffs.set(b.id, { def, left: b.left, stacks: b.stacks });
    }
  }
}

const states = new WeakMap<Character, MartialArtsState>();

export function maOf(c: Character): MartialArtsState {
  let s = states.get(c);
  if (!s) states.set(c, (s = new MartialArtsState(c)));
  return s;
}

// ------------------------------------------------------------------ data access

export function styleDef(data: GameData, id: string): MartialArtDef | undefined {
  return (data.misc?.martial_art as Record<string, MartialArtDef> | undefined)?.[id];
}

const buffIndex = new WeakMap<GameData, Map<string, MaBuffDef>>();

/** All inline buffs of all styles, by id (req_buffs refer to them by id). */
export function buffDef(data: GameData, id: string): MaBuffDef | undefined {
  let idx = buffIndex.get(data);
  if (!idx) {
    idx = new Map();
    for (const st of Object.values((data.misc?.martial_art ?? {}) as Record<string, MartialArtDef>))
      for (const t of BUFF_TRIGGERS)
        for (const b of (st[`${t}_buffs`] as (MaBuffDef | string)[] | undefined) ?? []) if (typeof b === 'object') idx.set(b.id, b);
    buffIndex.set(data, idx);
  }
  return idx.get(id);
}

export function styleBuffs(data: GameData, style: MartialArtDef, trigger: BuffTrigger): MaBuffDef[] {
  const out: MaBuffDef[] = [];
  for (const b of (style[`${trigger}_buffs`] as (MaBuffDef | string)[] | undefined) ?? []) {
    const def = typeof b === 'string' ? buffDef(data, b) : b;
    if (def) out.push(def);
    else warnOnce('ma_buff', String(b));
  }
  return out;
}

export function currentStyle(c: Character): MartialArtDef {
  const data = c.data;
  const s = styleDef(data, maOf(c).style) ?? styleDef(data, 'style_none');
  if (s) return s;
  // Fixture data without martial arts: behave like BN's "No style".
  return { id: 'style_none', name: 'No style', arm_block: 1, leg_block: 99, allow_melee: true };
}

// ------------------------------------------------------------------ bonuses

/**
 * Stat value named by a bonus's "scaling-stat". bonuses.cpp scaling_stat_map only knows
 * str/dex/int/per; anything else is STAT_NULL (the bare scale).
 */
export function scalingStatValue(c: Character, stat: string): number | null {
  switch (stat) {
    case 'str': return c.str;
    case 'dex': return c.dex;
    case 'int': return c.int;
    case 'per': return c.per;
    default: warnOnce('ma_scaling_stat', stat); return null;
  }
}

/** effect_scaling::get: scale × the scaling stat (or just the scale). */
export function bonusValue(c: Character, b: BonusEntry): number {
  const s = b['scaling-stat'];
  const v = s ? scalingStatValue(c, s) : null;
  return v === null ? b.scale : b.scale * v;
}

/** Stats whose bonuses carry a damage type (bonuses.cpp needs_damage_type). */
const TYPED_STATS = new Set(['damage', 'armor', 'arpen', 'target_armor_multiplier']);

/** affected_type equality: typed stats match their damage type exactly, others ignore it. */
function bonusMatches(b: BonusEntry, stat: string, type?: string): boolean {
  if (b.stat !== stat) return false;
  return !TYPED_STATS.has(stat) || b.type === type;
}

/** bonus_container::get_flat for one stat (and damage type for typed stats). */
export function flatBonus(c: Character, list: BonusEntry[] | undefined, stat: string, type?: string): number {
  let r = 0;
  for (const b of list ?? []) if (bonusMatches(b, stat, type)) r += bonusValue(c, b);
  return r;
}

/** bonus_container::get_mult: product, clamped at 0. */
export function multBonus(c: Character, list: BonusEntry[] | undefined, stat: string, type?: string): number {
  let r = 1;
  for (const b of list ?? []) if (bonusMatches(b, stat, type)) r *= bonusValue(c, b);
  return Math.max(0, r);
}

// ------------------------------------------------------------------ requirement checks

export function weaponCategories(w: Item | null): string[] {
  return (w?.def.weapon_category as string[] | undefined) ?? [];
}

/** martialart::has_weapon: listed item id or one of its weapon categories. */
export function styleHasWeapon(style: MartialArtDef, w: Item | null): boolean {
  if (!w) return false;
  if (style.weapons?.includes(w.typeId)) return true;
  return weaponCategories(w).some((cat) => style.weapon_category?.includes(cat));
}

/** item::is_unarmed_weapon: bare hands, or an UNARMED_WEAPON (brass knuckles, gloves). */
export function isUnarmedWeapon(w: Item | null): boolean {
  return !w || w.hasFlag('UNARMED_WEAPON');
}

/** martialart::weapon_valid (the style's buffs/techniques can be used with this weapon). */
export function styleWeaponValid(style: MartialArtDef, w: Item | null): boolean {
  if (style.allow_melee) return true;
  if (!w && !style.strictly_melee) return true;
  if (styleHasWeapon(style, w)) return true;
  return !style.strictly_unarmed && !style.strictly_melee && !!w && w.hasFlag('UNARMED_WEAPON');
}

export function hasBuff(c: Character, id: string): boolean {
  return maOf(c).buffs.has(id);
}

/** World hook: is the character next to a wall (wall_adjacent techniques and buffs)? */
export const maWorld: { wallAdjacent: ((c: Character) => boolean) | null } = { wallAdjacent: null };

/**
 * ma_requirements::is_valid_character (+ is_valid_weapon). Four kinds of "armedness": truly
 * unarmed, an UNARMED_WEAPON (counts as unarmed while unarmed_weapons_allowed), a weapon the
 * style lists, any weapon (style allow_melee). A force-unarmed style lets melee requirements
 * pass with anything in hand (the blow is a punch). Weapon categories only restrict armed use.
 */
export function requirementsMet(c: Character, req: MaRequirements, weapon: Item | null = c.inv.wielded): boolean {
  for (const id of req.req_buffs ?? []) if (!hasBuff(c, id)) return false;

  const style = currentStyle(c);
  const armed = !!weapon;
  const unarmedWeapon = !!weapon && weapon.hasFlag('UNARMED_WEAPON');
  const weaponOk = !!weapon &&
    (req.req_flags ?? []).every((f) => weapon.hasFlag(f)) &&
    (req.weapon_damage_requirements ?? []).every((d) => weapon.meleeDamage(d.type) >= d.min);
  const unarmedOk = !armed || (unarmedWeapon && req.unarmed_weapons_allowed !== false);
  const meleeOk = !!req.melee_allowed && weaponOk && (styleHasWeapon(style, weapon) || !!style.allow_melee);
  const validUnarmed = !style.strictly_melee && !!req.unarmed_allowed && unarmedOk;
  const validMelee = !req.strictly_unarmed && (!!style.force_unarmed || meleeOk);
  if (!validUnarmed && !validMelee) return false;

  if (style.mutation?.length && !style.mutation.some((m) => c.hasTrait(m))) return false;
  if (req.wall_adjacent && !maWorld.wallAdjacent?.(c)) return false;
  for (const s of req.skill_requirements ?? []) if (c.getSkill(s.name) < s.level) return false;
  const cats = req.weapon_categories_allowed;
  const catList = cats === undefined ? [] : Array.isArray(cats) ? cats : [cats];
  if (catList.length && armed && !catList.some((cat) => weaponCategories(weapon).includes(cat))) return false;
  if (req.mutations_required?.length && !req.mutations_required.some((m) => c.hasTrait(m))) return false;
  return true;
}

// ------------------------------------------------------------------ buffs

/** Buff duration in real seconds. */
function buffSeconds(def: MaBuffDef): number {
  // A hair over the nominal length so a 1-turn buff reapplied every turn (static buffs)
  // never flickers off between the expiry and the next turn's reapplication.
  return Math.max(1, def.buff_duration ?? 2) * COMBAT_TURN + 0.05;
}

/**
 * ma_buff::apply_buff = add_effect on the buff's effect type (ma_buff_effect_type): the
 * duration adds up but never past buff_duration, and each application adds a stack up to
 * max_stacks.
 */
export function applyBuff(c: Character, def: MaBuffDef): void {
  const ma = maOf(c);
  const dur = buffSeconds(def);
  const cur = ma.buffs.get(def.id);
  if (cur) {
    cur.stacks = Math.min(Math.max(1, def.max_stacks ?? 1), cur.stacks + 1);
    cur.left = Math.min(dur, cur.left + dur);
    cur.refreshed = true;
  } else {
    ma.buffs.set(def.id, { def, left: dur, stacks: 1, refreshed: true });
  }
}

/** simultaneous_add: check every buff of a trigger first, then add the valid ones. */
export function triggerBuffs(c: Character, trigger: BuffTrigger): void {
  const style = currentStyle(c);
  const valid = styleBuffs(c.data, style, trigger).filter((b) => requirementsMet(c, b));
  for (const b of valid) applyBuff(c, b);
}

/**
 * Sum of a flat buff bonus over active buffs. Stacks multiply every bonus except to-hit:
 * Character::mabuff_tohit_bonus is the one accumulator that ignores the effect intensity.
 */
export function buffFlat(c: Character, stat: string, type?: string): number {
  let r = 0;
  for (const b of maOf(c).buffs.values()) r += (stat === 'hit' ? 1 : b.stacks) * flatBonus(c, b.def.flat_bonuses, stat, type);
  return r;
}

/** Character::mabuff_damage_mult-style product: stacks × (mult − 1) + 1 per buff. */
export function buffMult(c: Character, stat: string, type?: string): number {
  let r = 1;
  for (const b of maOf(c).buffs.values()) r *= b.stacks * (multBonus(c, b.def.mult_bonuses, stat, type) - 1) + 1;
  return Math.max(0, r);
}

/** Character::get_num_dodges: 1 + buff bonus_dodges (not per stack). */
export function numDodges(c: Character): number {
  let n = 1;
  for (const b of maOf(c).buffs.values()) n += b.def.bonus_dodges ?? 0;
  return n;
}
export function numBlocks(c: Character): number {
  let n = 1;
  for (const b of maOf(c).buffs.values()) n += b.def.bonus_blocks ?? 0;
  return n;
}

/** A martial-arts buff makes the character immune to being thrown/downed (throw_immune). */
export function isThrowImmune(c: Character): boolean {
  for (const b of maOf(c).buffs.values()) if (b.def.throw_immune) return true;
  return false;
}

/** Start of a combat turn: dodges and blocks come back (Character::process_turn). */
export function refreshDefenses(c: Character): void {
  const ma = maOf(c);
  if (c.isAsleep()) {
    ma.dodgesLeft = ma.blocksLeft = 0;
    return;
  }
  ma.dodgesLeft = numDodges(c);
  ma.blocksLeft = numBlocks(c);
}

/**
 * Advance martial arts state by `dt` real seconds: buffs expire, and once per combat turn a
 * buff that wasn't re-triggered loses a stack (effect::decay, int_decay_step -1), the static
 * buffs are reapplied, onmove/onpause buffs fire and dodges/blocks refresh.
 */
export function tickMartialArts(c: Character, dt: number): void {
  const ma = maOf(c);
  for (const [id, b] of ma.buffs) if ((b.left -= dt) <= 0) ma.buffs.delete(id);
  ma.turnAcc += dt;
  if (ma.turnAcc < COMBAT_TURN) return;
  ma.turnAcc %= COMBAT_TURN;
  triggerBuffs(c, 'static');
  if (ma.moved) triggerBuffs(c, 'onmove');
  else if (!ma.attacked) triggerBuffs(c, 'onpause');
  // Effect processing after this turn's triggers: whatever wasn't applied since the last
  // turn loses a stack.
  for (const b of ma.buffs.values()) {
    if (!b.refreshed && b.stacks > 1) b.stacks--;
    b.refreshed = false;
  }
  ma.moved = ma.attacked = false;
  refreshDefenses(c);
}

// ------------------------------------------------------------------ styles

/** Autolearn (can_autolearn_martial_art, e.g. Brawling at melee 1). */
export function autolearnStyles(c: Character): string[] {
  const ma = maOf(c);
  const learned: string[] = [];
  for (const st of Object.values((c.data.misc?.martial_art ?? {}) as Record<string, MartialArtDef>)) {
    if (!st.autolearn?.length || ma.known.has(st.id)) continue;
    if (st.autolearn.every(([skill, lvl]) => c.getSkill(skill) >= Number(lvl))) {
      ma.known.add(st.id);
      learned.push(st.id);
    }
  }
  return learned;
}

/** Styles a trait lets the character pick from (profession martial arts training). */
export function traitStyleChoices(c: Character): string[] {
  const out: string[] = [];
  for (const t of c.traits) {
    const list = (c.traitDef(t) as { initial_ma_styles?: string[] } | undefined)?.initial_ma_styles;
    if (list && !list.some((id) => maOf(c).known.has(id))) out.push(...list.filter((id) => !out.includes(id)));
  }
  return out;
}

export function learnStyle(c: Character, id: string, silent = false): boolean {
  const def = styleDef(c.data, id);
  if (!def) {
    warnOnce('martial_art', id);
    return false;
  }
  const ma = maOf(c);
  if (ma.known.has(id)) {
    if (!silent) c.msg(`You already know ${def.name}.`);
    return false;
  }
  ma.known.add(id);
  // character_martial_arts::learn_style messages.
  if (!silent) {
    c.msg(`You learn the essential elements of the style.`, 'c_green');
    c.msg(`You learned ${def.name}.`, 'c_green');
  }
  return true;
}

/** character_martial_arts::set_style + martialart_use_message. Running buffs just expire. */
export function selectStyle(c: Character, id: string, silent = false): boolean {
  const ma = maOf(c);
  const def = styleDef(c.data, id);
  if (!def || !ma.known.has(id)) return false;
  ma.style = id;
  if (!silent) {
    const w = c.inv.wielded;
    if (def.force_unarmed || styleWeaponValid(def, w)) {
      if (def.initiate?.[0]) c.msg(def.initiate[0]);
    } else if (def.strictly_melee && !w) c.msg(`${def.name} cannot be used unarmed.`, 'c_light_red');
    else if (def.strictly_unarmed && w) c.msg(`${def.name} cannot be used with weapons.`, 'c_light_red');
    else if (w) c.msg(`The ${w.baseName()} is not a valid ${def.name} weapon.`, 'c_light_red');
  }
  triggerBuffs(c, 'static');
  refreshDefenses(c);
  return true;
}

/** "Karate [Karate Stance, Karate Kata ×2]" pieces for the HUD. */
export function activeBuffSummary(c: Character): { name: string; stacks: number; left: number }[] {
  return [...maOf(c).buffs.values()].map((b) => ({ name: b.def.name, stacks: b.stacks, left: b.left }));
}
