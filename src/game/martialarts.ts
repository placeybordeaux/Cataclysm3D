import type { GameData } from '../data/types';
import { warnOnce } from '../data/warn';
import { MELEE_SCALE } from '../core/time';
import type { Character } from './character';
import type { Item } from './item';

// CDDA martial arts (martialarts.cpp): styles (misc.martial_art) with their inline buffs,
// requirement checks shared with techniques (ma_requirements::is_valid_character), and the
// per-character state (known styles, the selected style, active buffs with stacks, and the
// per-turn dodge/block allowance).
//
// Time: CDDA counts buffs and dodges in turns. Combat here runs at MELEE_SCALE turns per real
// second (one swing of a speed-100 zombie), so a "combat turn" is 1/MELEE_SCALE real seconds.
// State is attached to a Character through a WeakMap (`maOf(c)`) so NPCs get it for free and
// character.ts stays untouched.

/** Real seconds per CDDA turn for combat bookkeeping (buff durations, dodge/block refresh). */
export const COMBAT_TURN = 1 / MELEE_SCALE;

export interface BonusEntry {
  stat: string;
  type?: string;
  'scaling-stat'?: string;
  scale: number;
}

/** ma_requirements fields (shared by techniques and buffs). */
export interface MaRequirements {
  unarmed_allowed?: boolean;
  melee_allowed?: boolean;
  strictly_unarmed?: boolean;
  wall_adjacent?: boolean;
  weapon_categories_allowed?: string | string[];
  skill_requirements?: { name: string; level: number }[];
  weapon_damage_requirements?: { type: string; min: number }[];
  required_buffs_all?: string[];
  required_buffs_any?: string[];
  forbidden_buffs_all?: string[];
  forbidden_buffs_any?: string[];
  req_flags?: string[];
  required_char_flags?: string[];
  required_char_flags_all?: string[];
  forbidden_char_flags?: string[];
}

export interface MaBuffDef extends MaRequirements {
  id: string;
  name: string;
  description?: string;
  /** Turns; CDDA default 1. */
  buff_duration?: number;
  max_stacks?: number;
  bonus_dodges?: number;
  bonus_blocks?: number;
  free_dodges?: number;
  persists?: boolean;
  quiet?: boolean;
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
  arm_block?: number;
  leg_block?: number;
  nonstandard_block?: number;
  allow_all_weapons?: boolean;
  strictly_unarmed?: boolean;
  strictly_melee?: boolean;
  force_unarmed?: boolean;
  prevent_weapon_blocking?: boolean;
  weapons?: string[];
  weapon_category?: string[];
  techniques?: string[];
  autolearn?: [string, number][];
  teachable?: boolean;
  primary_skill?: string;
  [k: string]: unknown;
}

export interface ActiveBuff {
  def: MaBuffDef;
  /** Real seconds left. */
  left: number;
  stacks: number;
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
  dodgesLeft = 1;
  blocksLeft = 1;
  freeDodgesLeft = 0;
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

/** All inline buffs of all styles, by id (required_buffs_* refer to them by id). */
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
  // Fixture data without martial arts: behave like CDDA's "No style".
  return { id: 'style_none', name: 'No style', arm_block: 1, leg_block: 99, allow_all_weapons: true };
}

// ------------------------------------------------------------------ requirement checks

/** Stat or skill value named by a bonus's "scaling-stat" (bonuses.cpp scaling_stat_map). */
export function scalingStatValue(c: Character, stat: string): number {
  switch (stat) {
    case 'str': return c.str;
    case 'dex': return c.dex;
    case 'int': return c.int;
    case 'per': return c.per;
    case 'bash': return c.getSkill('bashing');
    case 'cut': return c.getSkill('cutting');
    case 'stab': return c.getSkill('stabbing');
    case 'athletics': return c.getSkill('swimming');
    case 'marksmanship': return c.getSkill('gun');
    default: return c.getSkill(stat);
  }
}

/** effect_scaling::get: scale × the scaling stat (or just the scale). */
export function bonusValue(c: Character, b: BonusEntry): number {
  const s = b['scaling-stat'];
  return s ? b.scale * scalingStatValue(c, s) : b.scale;
}

/** bonus_container::get_flat for one stat (and damage type where relevant). */
export function flatBonus(c: Character, list: BonusEntry[] | undefined, stat: string, type?: string): number {
  let r = 0;
  for (const b of list ?? []) if (b.stat === stat && (type === undefined || b.type === undefined || b.type === type)) r += bonusValue(c, b);
  return r;
}

/** bonus_container::get_mult: product, clamped at 0. */
export function multBonus(c: Character, list: BonusEntry[] | undefined, stat: string, type?: string): number {
  let r = 1;
  for (const b of list ?? []) if (b.stat === stat && (type === undefined || b.type === undefined || b.type === type)) r *= bonusValue(c, b);
  return Math.max(0, r);
}

export function weaponCategories(w: Item | null): string[] {
  return (w?.def.weapon_category as string[] | undefined) ?? [];
}

/** martialart::has_weapon: listed item id or one of its weapon categories. */
export function styleHasWeapon(style: MartialArtDef, w: Item | null): boolean {
  if (!w) return false;
  if (style.weapons?.includes(w.typeId)) return true;
  return weaponCategories(w).some((cat) => style.weapon_category?.includes(cat));
}

/** martialart::weapon_valid (the style's buffs/techniques can be used with this weapon). */
export function styleWeaponValid(style: MartialArtDef, w: Item | null): boolean {
  if (style.allow_all_weapons) return true;
  if (!w && !style.strictly_melee) return true;
  return !!w && styleHasWeapon(style, w);
}

export function hasBuff(c: Character, id: string): boolean {
  return maOf(c).buffs.has(id);
}

/**
 * ma_requirements::is_valid_character. Weapon rules: a technique/buff works unarmed when it
 * allows unarmed and the style isn't strictly melee, or with a weapon when it allows melee,
 * the weapon satisfies req_flags/min damage, and the style allows the weapon (or all weapons).
 */
export function requirementsMet(c: Character, req: MaRequirements, weapon: Item | null = c.inv.wielded): boolean {
  const any = (ids: string[] | undefined) => (ids ?? []).some((id) => hasBuff(c, id));
  const all = (ids: string[] | undefined) => (ids ?? []).every((id) => hasBuff(c, id));
  if (any(req.forbidden_buffs_any)) return false;
  if (req.forbidden_buffs_all?.length && all(req.forbidden_buffs_all)) return false;
  if (!all(req.required_buffs_all)) return false;
  if (req.required_buffs_any?.length && !any(req.required_buffs_any)) return false;

  const style = currentStyle(c);
  const armed = !!weapon;
  const weaponOk =
    !!req.melee_allowed && !!weapon &&
    (req.req_flags ?? []).every((f) => weapon.hasFlag(f)) &&
    (req.weapon_damage_requirements ?? []).every((d) => weapon.meleeDamage(d.type) >= d.min);
  const meleeOk = weaponOk && (styleHasWeapon(style, weapon) || !!style.allow_all_weapons);
  const validUnarmed = !style.strictly_melee && !!req.unarmed_allowed && !armed;
  const validMelee = !req.strictly_unarmed && (!!style.force_unarmed || meleeOk);
  if (!validUnarmed && !validMelee) return false;

  for (const s of req.skill_requirements ?? []) if (c.getSkill(s.name) < s.level) return false;
  // Character flags come from traits/bionics; only trait flags are visible here.
  if (req.required_char_flags?.length && !req.required_char_flags.some((f) => charHasFlag(c, f))) return false;
  if ((req.required_char_flags_all ?? []).some((f) => !charHasFlag(c, f))) return false;
  if ((req.forbidden_char_flags ?? []).some((f) => charHasFlag(c, f))) return false;
  const cats = req.weapon_categories_allowed;
  if (cats && (Array.isArray(cats) ? cats.length : true)) {
    const list = Array.isArray(cats) ? cats : [cats];
    if (!list.some((cat) => weaponCategories(weapon).includes(cat))) return false;
  }
  return true;
}

/** json_character_flag from traits (mutation "flags"). */
export function charHasFlag(c: Character, flag: string): boolean {
  for (const t of c.traits) {
    const f = (c.traitDef(t) as { flags?: string[] } | undefined)?.flags;
    if (f?.includes(flag)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ buffs

/** ma_buff::apply_buff: add or stack (refreshing duration), CDDA effect intensity semantics. */
export function applyBuff(c: Character, def: MaBuffDef): void {
  const ma = maOf(c);
  // A hair over the nominal length so a 1-turn buff reapplied every turn (static buffs)
  // never flickers off between the expiry and the next turn's reapplication.
  const dur = Math.max(1, def.buff_duration ?? 1) * COMBAT_TURN + 0.05;
  const cur = ma.buffs.get(def.id);
  if (cur) {
    cur.stacks = Math.min(Math.max(1, def.max_stacks ?? 1), cur.stacks + 1);
    cur.left = Math.max(cur.left, dur);
  } else {
    ma.buffs.set(def.id, { def, left: dur, stacks: 1 });
  }
}

/** simultaneous_add: check every buff of a trigger first, then add the valid ones. */
export function triggerBuffs(c: Character, trigger: BuffTrigger): void {
  const style = currentStyle(c);
  const valid = styleBuffs(c.data, style, trigger).filter((b) => requirementsMet(c, b));
  for (const b of valid) applyBuff(c, b);
}

/** Sum of a flat buff bonus over active buffs, times stacks. */
export function buffFlat(c: Character, stat: string, type?: string): number {
  let r = 0;
  for (const b of maOf(c).buffs.values()) r += b.stacks * flatBonus(c, b.def.flat_bonuses, stat, type);
  return r;
}

/** Character::mabuff_damage_mult-style product: stacks × (mult − 1) + 1 per buff. */
export function buffMult(c: Character, stat: string, type?: string): number {
  let r = 1;
  for (const b of maOf(c).buffs.values()) r *= b.stacks * (multBonus(c, b.def.mult_bonuses, stat, type) - 1) + 1;
  return Math.max(0, r);
}

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

/** Start of a combat turn: dodges and blocks come back (Character::process_turn). */
export function refreshDefenses(c: Character): void {
  const ma = maOf(c);
  if (c.isAsleep()) {
    ma.dodgesLeft = ma.blocksLeft = ma.freeDodgesLeft = 0;
    return;
  }
  ma.dodgesLeft = numDodges(c);
  ma.blocksLeft = numBlocks(c);
  let free = 0;
  for (const b of ma.buffs.values()) free += b.def.free_dodges ?? 0;
  ma.freeDodgesLeft = free;
}

/**
 * Advance martial arts state by `dt` real seconds: buffs expire, and once per combat turn the
 * static buffs are reapplied, onmove/onpause buffs fire and dodges/blocks refresh.
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
  ma.moved = ma.attacked = false;
  refreshDefenses(c);
}

// ------------------------------------------------------------------ styles

/** Autolearn (Brawling at melee 1) and styles granted by traits (initial_ma_styles). */
export function autolearnStyles(c: Character): string[] {
  const ma = maOf(c);
  const learned: string[] = [];
  for (const st of Object.values((c.data.misc?.martial_art ?? {}) as Record<string, MartialArtDef>)) {
    if (!st.autolearn || ma.known.has(st.id)) continue;
    if (st.autolearn.every(([skill, lvl]) => c.getSkill(skill) >= lvl)) {
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

/** character_martial_arts::martialart_use_message + remove_all_buffs of the old style. */
export function selectStyle(c: Character, id: string, silent = false): boolean {
  const ma = maOf(c);
  const def = styleDef(c.data, id);
  if (!def || !ma.known.has(id)) return false;
  for (const [bid, b] of ma.buffs) if (!b.def.persists) ma.buffs.delete(bid);
  ma.style = id;
  if (!silent) {
    const w = c.inv.wielded;
    if (!styleWeaponValid(def, w) && w) c.msg(`${def.name} cannot be used with a ${w.baseName()}.`, 'c_yellow');
    else if (def.initiate?.[0]) c.msg(def.initiate[0]);
  }
  triggerBuffs(c, 'static');
  refreshDefenses(c);
  return true;
}

/** "Karate [Karate Stance, Karate Kata ×2]" pieces for the HUD. */
export function activeBuffSummary(c: Character): { name: string; stacks: number; left: number }[] {
  return [...maOf(c).buffs.values()].map((b) => ({ name: b.def.name, stacks: b.stacks, left: b.left }));
}
