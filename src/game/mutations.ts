import type { GameData, MutationDef } from '../data/types';
import { ACTION_SCALE, CLOCK_SCALE } from '../core/time';
import { isBodyPart, type BodyPartId } from './bodyparts';
import type { Character } from './character';
import { covers } from './inventory';
import { asArray, type Item } from './item';
import { cddaText } from './units';

// Cataclysm: Bright Nights mutations (mutation.cpp, mutation_data.cpp, iuse_actor.cpp
// mutagen_actor / mutagen_iv_actor, iuse.cpp purifiers, character.cpp set_highest_cat_level).
//
// How BN mutates (unlike DDA's vitamin-driven primers/catalysts, which BN never had):
//   - Mutagen items carry a use_action {"type": "mutagen", "mutation_category", "is_weak",
//     "is_strong"} (drinks) or {"type": "mutagen_iv", "mutation_category", "tier"} (serums,
//     need a syringe). Drinking mutates towards the category right away (mutate_category),
//     costs the category's mutagen_hunger/thirst/fatigue per mutation and may knock you down.
//   - Category-less ("ANY") mutagen under BALANCED_MUTATIONS (a BN game_balance option, on by
//     default) feeds the `accumulated_mutagen` effect (+2 days per dose, permanent, max 22 d,
//     3 d per unit). Character::mutate spends one unit per mutation, picking by
//     mutation_chances(): a gaussian around a "genetic score" target, weighted by category
//     strength. A new character starts with 27 days of it (game.cpp start_game).
//   - Category strength (mutation_category_level) is rebuilt after every change: each
//     mutation and its prerequisite/replacement tree give 8 / 2^distance to its categories.
//   - Thresholds: categories list threshold_muts (index = tier; index 0 is a null tier). IV
//     serums test_crossing_threshold before and after mutating: the category must be the
//     primary one (strictly highest level) with level > 50, then x_in_y(level (+50 URSINE /
//     ALPHA), sum of all levels) crosses. Post-threshold mutations need their category's
//     threshold of `threshold_tier` (default 1 when `threshreq` is set).
//   - Purifier (PURIFIER / PURIFY_IV / PURIFY_SMART use actions) removes 1..4 (4..8 IV, one
//     chosen for smart) random non-innate mutations; nothing below the crossed threshold's
//     tier in its category.
//   - Gear: restricts_gear pushes worn items off (no DDA destroys_gear / integrated armor);
//     natural armor is the mutation's `armor` resistances.
//
// Everything here is per Character (MutationState), UI-free and deterministic on the
// character's Rng so it can be unit tested against the real data.

/** The mutation fields this module reads (BN JSON key names). */
export interface MutData extends MutationDef {
  category?: string[];
  prereqs?: string[];
  prereqs2?: string[];
  /** BN "changes_to" (mutation_branch::replacements). */
  changes_to?: string[];
  /** BN "leads_to" (mutation_branch::additions). */
  leads_to?: string[];
  cancels?: string[];
  prevents?: string[];
  types?: string[];
  threshreq?: string[] | string;
  threshold?: boolean;
  threshold_tier?: number;
  valid?: boolean;
  purifiable?: boolean;
  profession?: boolean;
  debug?: boolean;
  player_display?: boolean;
  mixed_effect?: boolean;
  visibility?: number;
  ugliness?: number;
  restricts_gear?: string[];
  allowed_items?: string[];
  allowed_items_only?: boolean;
  allow_soft_gear?: boolean;
  allowed_category?: string[];
  encumbrance_always?: [string, number][];
  encumbrance_covered?: [string, number][];
  armor?: { parts?: string[] | string; [dtype: string]: unknown }[];
  night_vision_range?: number;
  mutagen_target_modifier?: number;
  active?: boolean;
  starts_active?: boolean;
  cost?: number;
  /** BN "time": the activation cooldown in turns (mutation_branch::cooldown). */
  time?: number;
  hunger?: boolean;
  thirst?: boolean;
  fatigue?: boolean;
  transform?: { target: string; msg_transform?: string; active?: boolean; moves?: number };
  flags?: string[];
}

export interface MutationCategory {
  id: string;
  name?: string;
  threshold_mut?: string;
  threshold_muts?: string[];
  mutagen_message?: string;
  mutagen_hunger?: number;
  mutagen_thirst?: number;
  mutagen_pain?: number;
  mutagen_fatigue?: number;
  mutagen_morale?: number;
  iv_message?: string;
  iv_min_mutations?: number;
  iv_additional_mutations?: number;
  iv_additional_mutations_chance?: number;
  iv_hunger?: number;
  iv_thirst?: number;
  iv_pain?: number;
  iv_fatigue?: number;
  iv_morale?: number;
  iv_morale_max?: number;
  iv_sound?: boolean;
  iv_sound_message?: string;
  iv_noise?: number;
  iv_sleep?: boolean;
  iv_sleep_message?: string;
  iv_sleep_dur?: number;
  junkie_message?: string;
  memorial_message?: string;
}

/** mutation_category_trait defaults (mutation_data.cpp load). */
const CATEGORY_DEFAULTS = {
  mutagen_hunger: 10, mutagen_thirst: 10, mutagen_pain: 0, mutagen_fatigue: 5,
  iv_min_mutations: 1, iv_additional_mutations: 2, iv_additional_mutations_chance: 3,
  iv_hunger: 10, iv_thirst: 10, iv_pain: 2, iv_fatigue: 5, iv_morale: 0, iv_morale_max: 0,
  iv_noise: 0, iv_sleep_dur: 0,
} as const;

/** The use_action of a mutagen consumable (iuse_actor.cpp mutagen_actor / mutagen_iv_actor). */
export interface MutagenAction {
  type: 'mutagen' | 'mutagen_iv';
  mutation_category?: string;
  is_weak?: boolean;
  is_strong?: boolean;
  tier?: number;
}

/** BN item use actions this module handles when a comestible is consumed. */
export const PURIFIER_ACTIONS = ['PURIFIER', 'PURIFY_IV', 'PURIFY_SMART'] as const;

const ANY = 'ANY';
/** accumulated_mutagen: one unit (int_dur_factor) = 3 days. */
const MUTAGEN_UNIT = 3 * 86400;
/** Turns → game seconds for effects the survivor lives through in real time (monster.ts). */
const turnsToEffectSeconds = (turns: number) => (turns * CLOCK_SCALE) / ACTION_SCALE;

/** Data indices built once per GameData. */
export class MutationIndex {
  readonly defs = new Map<string, MutData>();
  readonly categories = new Map<string, MutationCategory>();
  /** BN mutations_category: category → trait ids. */
  readonly byCategory = new Map<string, string[]>();
  /** mutation_type → trait ids (get_mutations_in_types). */
  readonly byType = new Map<string, string[]>();
  /** body_part / sub_body_part id → main body part id we model (hand_l, head …). */
  readonly subParent = new Map<string, string>();
  /** BN game_balance EXTERNAL_OPTIONs this module reads. */
  readonly balanced: boolean;

  constructor(readonly data: GameData) {
    const misc = data.misc ?? {};
    for (const m of Object.values((misc.mutation ?? {}) as Record<string, MutData>)) this.defs.set(m.id, m);
    for (const c of Object.values((misc.mutation_category ?? {}) as Record<string, MutationCategory>)) this.categories.set(c.id, c);
    for (const m of this.defs.values()) {
      for (const cat of m.category ?? []) {
        if (!this.byCategory.has(cat)) this.byCategory.set(cat, []);
        this.byCategory.get(cat)!.push(m.id);
      }
      for (const t of m.types ?? []) {
        if (!this.byType.has(t)) this.byType.set(t, []);
        this.byType.get(t)!.push(m.id);
      }
    }
    for (const s of Object.values((misc.sub_body_part ?? {}) as Record<string, { id: string; parent: string }>)) this.subParent.set(s.id, s.parent);
    const opt = (misc.external_option as Record<string, { value?: unknown }> | undefined)?.BALANCED_MUTATIONS;
    this.balanced = opt ? opt.value === true : true;
  }

  def(id: string): MutData | undefined {
    return this.defs.get(id);
  }
  valid(id: string): boolean {
    return this.defs.get(id)?.valid !== false;
  }
  purifiable(id: string): boolean {
    return this.defs.get(id)?.purifiable !== false;
  }
  visible(id: string): boolean {
    return this.defs.get(id)?.player_display !== false;
  }
  points(id: string): number {
    return this.defs.get(id)?.points ?? 0;
  }
  inCategory(id: string, cat: string): boolean {
    return (this.defs.get(id)?.category ?? []).includes(cat);
  }
  /** mutation_category_trait::threshold_muts: index = tier, index 0 is the null tier. */
  thresholdMuts(cat: string): (string | null)[] {
    const c = this.categories.get(cat);
    if (!c) return [null];
    if (c.threshold_muts) return c.threshold_muts.map((t) => t || null);
    return [null, c.threshold_mut || null];
  }
  /** mutation_branch::threshold_tier (default 1 when threshreq is non-empty). */
  thresholdTier(id: string): number {
    const d = this.defs.get(id);
    if (!d) return 0;
    if (d.threshold_tier !== undefined) return d.threshold_tier;
    return asArray(d.threshreq as string | string[] | undefined).filter(Boolean).length ? 1 : 0;
  }
  /** get_mutations_in_types */
  inTypes(types: string[] | undefined): string[] {
    const out = new Set<string>();
    for (const t of types ?? []) for (const id of this.byType.get(t) ?? []) out.add(id);
    return [...out];
  }
  /** All transitive prerequisites (get_all_mutation_prereqs). */
  allPrereqs(id: string, seen = new Set<string>()): string[] {
    const d = this.defs.get(id);
    for (const p of [...(d?.prereqs ?? []), ...(d?.prereqs2 ?? [])]) {
      if (seen.has(p)) continue;
      seen.add(p);
      this.allPrereqs(p, seen);
    }
    return [...seen];
  }
  /** Map a BN body part / sub part id to one of ours (sole → foot, crown → head …). */
  mainPart(id: string): BodyPartId | null {
    if (isBodyPart(id)) return id;
    const parent = this.subParent.get(id);
    return parent && isBodyPart(parent) ? parent : null;
  }
}

const indices = new WeakMap<GameData, MutationIndex>();
export function mutationIndex(data: GameData): MutationIndex {
  let i = indices.get(data);
  if (!i) indices.set(data, (i = new MutationIndex(data)));
  return i;
}

export interface MutationStateJSON {
  powered: string[];
  base: string[];
  /** Character::thresh_tier / thresh_category */
  threshTier?: number;
  threshCategory?: string | null;
  /** char_trait_data::charge per powered mutation (cooldown turns left). */
  charge?: Record<string, number>;
  time?: number;
}

/** Outcome of a mutagen/purifier use, for the consume hook. */
export interface MutagenUse {
  ok: boolean;
  msg?: string;
}

/**
 * One character's mutation state: powered (activated) mutations, which traits are innate
 * ("base" traits, BN my_traits), the crossed threshold tier/category. The trait set itself
 * lives on Character.traits so the existing enchantment code applies mutation effects.
 */
export class MutationState {
  readonly idx: MutationIndex;
  readonly powered = new Set<string>();
  /** char_trait_data::charge: turns until a powered mutation pays its cost again. */
  readonly charge = new Map<string, number>();
  /** Starting traits (BN my_traits): mutagen and purifiers leave them alone. */
  readonly base = new Set<string>();
  threshTier = 0;
  threshCategory: string | null = null;
  /** Game seconds processed (active mutation upkeep). */
  time = 0;
  /** Items pushed off by a new mutation go here (the installer drops them on the map). */
  onDropItem: ((it: Item) => void) | null = null;
  /** Called after any gain/loss so views (sprite overlays) can refresh. */
  onChanged: (() => void) | null = null;
  /** Called when a threshold is crossed (memorial / stats hook). */
  onThreshold: ((cat: string, memorial: string) => void) | null = null;
  /** IV mutagen noise (iv_sound): the installer turns it into a world sound. */
  onNoise: ((volume: number, description: string) => void) | null = null;
  /** PURIFY_SMART: the UI picks which mutation to purify (default: the first). */
  choosePurify: ((ids: string[]) => string | null) | null = null;
  /** Mutations gained/lost through this system; everything else on the character is innate. */
  private gained = new Set<string>();
  private acc = 0;

  constructor(readonly c: Character) {
    this.idx = mutationIndex(c.data);
    for (const t of c.traits) this.base.add(t);
  }

  private get rng() {
    return this.c.rng;
  }
  private msg(text: string, color?: string): void {
    this.c.msg(text, color);
  }

  // ------------------------------------------------------------------ queries
  has(id: string): boolean {
    return this.c.traits.has(id);
  }
  mutations(): string[] {
    return [...this.c.traits];
  }
  /** Innate traits are base traits that haven't been gained by mutation. */
  isBase(id: string): boolean {
    return this.base.has(id);
  }
  /** Keep `base` in step with traits added from outside (character creation, NPC templates). */
  syncBase(): void {
    for (const t of this.c.traits) if (!this.gained.has(t)) this.base.add(t);
  }
  /** Character::crossed_threshold */
  crossedThreshold(): boolean {
    if (this.threshCategory) return true;
    for (const t of this.c.traits) if (this.idx.def(t)?.threshold) return true;
    return false;
  }
  thresholdCategory(): string | null {
    if (this.threshCategory) return this.threshCategory;
    for (const t of this.c.traits) {
      if (!this.idx.def(t)?.threshold) continue;
      for (const cat of this.idx.categories.keys()) if (this.idx.thresholdMuts(cat).includes(t)) return cat;
    }
    return null;
  }

  /**
   * Character::set_highest_cat_level: every mutation and its prerequisite/replacement tree
   * (nearest distance, innate traits skipped) add 8 / 2^distance to each of their
   * categories, NON_THRESH ones excepted.
   */
  categoryLevels(): Map<string, number> {
    const out = new Map<string, number>();
    for (const mut of this.c.traits) {
      const dist = new Map<string, number>();
      const walk = (id: string, d: number) => {
        if (this.isBase(id)) return;
        const seen = dist.get(id);
        if (seen !== undefined && seen <= d) return;
        dist.set(id, d);
        const md = this.idx.def(id);
        for (const p of [...(md?.prereqs ?? []), ...(md?.prereqs2 ?? []), ...(md?.changes_to ?? [])]) walk(p, d + 1);
      };
      walk(mut, 0);
      for (const [id, d] of dist) {
        const md = this.idx.def(id);
        if (!md || (md.flags ?? []).includes('NON_THRESH')) continue;
        // int division like the C++: 8 / 2^d is 0 from distance 4 on.
        const add = Math.trunc(8 / 2 ** d);
        for (const cat of md.category ?? []) out.set(cat, (out.get(cat) ?? 0) + add);
      }
    }
    return out;
  }

  /** Character::get_highest_category: strictly highest level, none on ties. */
  highestCategory(levels = this.categoryLevels()): string | null {
    let best = 0;
    let cat: string | null = null;
    for (const [c, l] of levels) {
      if (l > best) {
        best = l;
        cat = c;
      } else if (l === best) cat = null;
    }
    return cat;
  }

  /** Character::is_category_allowed: a mutation with allowed_category restricts the rest. */
  categoryAllowed(cats: string[]): boolean {
    let restricted = false;
    for (const id of this.c.traits) {
      const allowed = this.idx.def(id)?.allowed_category ?? [];
      if (!allowed.length) continue;
      restricted = true;
      if (cats.some((c) => allowed.includes(c))) return true;
    }
    return !restricted;
  }

  /** has_child_flag: something that replaces `id` (transitively) is present. */
  hasChildFlag(id: string, depth = 0): boolean {
    if (depth > 30) return false;
    for (const r of this.idx.def(id)?.changes_to ?? []) if (this.has(r) || this.hasChildFlag(r, depth + 1)) return true;
    return false;
  }
  private removeChildFlag(id: string, depth = 0): void {
    if (depth > 30) return;
    for (const r of this.idx.def(id)?.changes_to ?? []) {
      if (this.has(r)) return void this.removeMutation(r);
      if (this.hasChildFlag(r)) return void this.removeChildFlag(r, depth + 1);
    }
  }

  /**
   * Bionic conflicts (bionic canceled_mutations, mutation_ok), set by the bionics system:
   * true = this mutation is blocked.
   */
  readonly bionicBlockers: ((mutation: string) => boolean)[] = [];

  /** Character::mutation_ok */
  mutationOk(id: string, forceGood: boolean, forceBad: boolean): boolean {
    const d = this.idx.def(id);
    if (!d) return false;
    if (!this.categoryAllowed(d.category ?? [])) return false;
    const flags = d.flags ?? [];
    if (this.c.male ? flags.includes('FEMALE_EXCLUSIVE') || flags.includes('FEMALE_PREFERRED') : flags.includes('MALE_EXCLUSIVE') || flags.includes('MALE_PREFERRED')) return false;
    if (this.has(id) || this.hasChildFlag(id)) return false;
    for (const t of this.c.traits) if ((this.idx.def(t)?.prevents ?? []).includes(id)) return false;
    if (this.bionicBlockers.some((b) => b(id))) return false;
    const pts = d.points ?? 0;
    if (forceBad && pts > 0) return false;
    if (forceGood && pts < 0) return false;
    return true;
  }

  // ------------------------------------------------------------------ gain / loss
  /** set_mutation + mutation_effect: pushed-off gear, starts_active. */
  setMutation(id: string): void {
    if (this.has(id)) return;
    this.c.addTrait(id);
    this.gained.add(id);
    const d = this.idx.def(id);
    if (!d) return;
    if (d.starts_active) this.powered.add(id);
    const inv = this.c.inv;
    // Clothing the new body part can't take is pushed off (mutation_effect).
    for (const it of [...inv.worn]) {
      if (!conflictsWithItem(this.c.data, d, it)) continue;
      inv.worn.splice(inv.worn.indexOf(it), 1);
      this.msg(`Your ${it.name()} is pushed off!`, 'c_red');
      this.onDropItem?.(it);
    }
    this.onChanged?.();
  }

  /** unset_mutation + mutation_loss_effect */
  unsetMutation(id: string): void {
    if (!this.has(id)) return;
    this.c.removeTrait(id);
    this.powered.delete(id);
    this.charge.delete(id);
    this.gained.delete(id);
    this.onChanged?.();
  }

  /** Reason the character can't wear `it` because of a mutation (Character::can_wear). */
  wearBlocker(it: Item): string | null {
    for (const id of this.c.traits) {
      const d = this.idx.def(id);
      if (d && conflictsWithItem(this.c.data, d, it)) return `Your ${this.name(id)} mutation prevents you from wearing your ${it.name()}.`;
    }
    return null;
  }

  name(id: string): string {
    return cddaText(this.idx.def(id)?.name) || this.c.traitName(id);
  }

  /** Message colour for a mutation change (m_good / m_bad / m_mixed / m_neutral). */
  private rating(to: MutData | undefined, from: MutData | undefined, gaining: boolean): string {
    if (to?.mixed_effect || from?.mixed_effect) return 'c_pink';
    const diff = (to?.points ?? 0) - (from?.points ?? 0);
    const good = gaining ? diff > 0 : diff < 0;
    return diff === 0 ? 'c_white' : good ? 'c_light_green' : 'c_light_red';
  }

  /** Character::remove_mutation: shrink back into a prerequisite or a canceled base trait. */
  removeMutation(id: string, silent = false): void {
    const d = this.idx.def(id);
    const shrinkTo = (list: string[] | undefined) => {
      for (const pre of list ?? []) if ((this.idx.def(pre)?.changes_to ?? []).includes(id)) return pre;
      return undefined;
    };
    let replacing = shrinkTo(d?.prereqs);
    let replacing2 = shrinkTo(d?.prereqs2);
    // A base trait this mutation had canceled comes back at the bottom of the trait line.
    const baseCanceling = (skip?: string) => {
      for (const b of this.base) if (!this.has(b) && b !== skip && (this.idx.def(b)?.cancels ?? []).includes(id)) return b;
      return undefined;
    };
    replacing ??= baseCanceling();
    replacing2 ??= baseCanceling(replacing);
    if (replacing === replacing2) replacing2 = undefined;
    const lost = this.name(id);
    this.unsetMutation(id);
    let replaced = false;
    for (const r of [replacing, replacing2]) {
      if (!r) continue;
      if (!silent) this.msg(`Your ${lost} mutation turns into ${this.name(r)}.`, this.rating(this.idx.def(r), d, true));
      this.setMutation(r);
      replaced = true;
    }
    if (!replaced && !silent) {
      const pts = d?.points ?? 0;
      this.msg(`You lose your ${lost} mutation.`, d?.mixed_effect ? 'c_pink' : pts > 0 ? 'c_light_red' : pts < 0 ? 'c_light_green' : 'c_white');
    }
  }

  // ------------------------------------------------------------------ mutating
  /** Character::mutate: BALANCED_MUTATIONS spends accumulated mutagen, else old_mutate. */
  mutate(): boolean {
    if (!this.idx.balanced) {
      const r = this.oldMutate();
      this.c.removeEffect('accumulated_mutagen');
      return r;
    }
    const e = this.c.effects.get('accumulated_mutagen');
    if (!e) return false;
    let power = e.duration / MUTAGEN_UNIT;
    let any = false;
    while (power > 1 || this.c.rollRemainder(power) > 0) {
      const chances = [...this.mutationChances()];
      if (chances.length) {
        const picked = this.rng.weighted(chances);
        if (this.has(picked)) this.removeMutation(picked);
        else this.mutateTowards(picked);
        any = true;
      }
      e.modDuration(-MUTAGEN_UNIT);
      power -= 1;
    }
    if (e.duration <= 0) this.c.effects.remove('accumulated_mutagen');
    return any;
  }

  /** Sum of the `mutagen_target_modifier` of present mutations (Character::mutation_value). */
  private mutationValue(field: 'mutagen_target_modifier'): number {
    let n = 0;
    for (const t of this.c.traits) n += (this.idx.def(t)?.[field] as number | undefined) ?? 0;
    return n;
  }

  /**
   * Character::mutation_chances (BALANCED_MUTATIONS): every possible addition, upgrade and
   * removal, each weighted by a gaussian (sigma 5) of how far it moves the genetic score
   * (38 + Σ mutation `cost`, as the C++ reads it) from the target 46, times category weights
   * favouring (for additions) or disfavouring (removals) the strongest categories.
   */
  mutationChances(): Map<string, number> {
    const forceBad = this.has('CHAOTIC_BAD');
    const forceGood = false;
    let costSum = 0;
    for (const t of this.c.traits) costSum += this.idx.def(t)?.cost ?? 0;
    const direction = 4 * 10 + 6 - (38 + costSum) + this.mutationValue('mutagen_target_modifier');
    const potential: { from: string | null; to: string | null }[] = [];
    for (const [id, d] of this.idx.defs) {
      if (this.has(id)) {
        for (const m of d.changes_to ?? []) if (this.idx.valid(m) && this.mutationOk(m, forceGood, forceBad)) potential.push({ from: id, to: m });
        for (const m of d.leads_to ?? []) if (this.idx.valid(m) && this.mutationOk(m, forceGood, forceBad)) potential.push({ from: null, to: m });
        if (!d.threshold && !d.profession && d.purifiable !== false) potential.push({ from: id, to: null });
      } else if (d.valid !== false && this.mutationOk(id, forceGood, forceBad)) potential.push({ from: null, to: id });
    }
    const levels = this.categoryLevels();
    for (const d of this.idx.defs.values()) for (const cat of d.category ?? []) if (!levels.has(cat)) levels.set(cat, 0);
    const add = categoryWeights(levels, true);
    const rem = categoryWeights(levels, false);
    const chances = new Map<string, number>();
    const cost = (id: string | null) => (id ? this.idx.def(id)?.cost ?? 0 : 0);
    for (const pm of potential) {
      const diff = cost(pm.to) - cost(pm.from);
      if (pm.to) {
        let mod = 0;
        for (const cat of this.idx.def(pm.to)?.category ?? []) mod = Math.max(mod, add.get(cat) ?? 0);
        chances.set(pm.to, (chances.get(pm.to) ?? 0) + gaussian(direction + diff) * mod);
      } else if (pm.from) {
        // std::min starting from 0 (the C++ accumulate seed): category-less removals get 0.
        let mod = 0;
        for (const cat of this.idx.def(pm.from)?.category ?? []) mod = Math.min(mod, rem.get(cat) ?? 0);
        chances.set(pm.from, (chances.get(pm.from) ?? 0) + gaussian(direction - diff) * mod);
      }
    }
    let sum = 0;
    for (const v of chances.values()) sum += v;
    const out = new Map<string, number>();
    if (sum > 0) for (const [k, v] of chances) if (v > 0) out.set(k, v / sum);
    return out;
  }

  /** Character::old_mutate (BALANCED_MUTATIONS off). */
  oldMutate(): boolean {
    let forceBad = this.rng.oneIn(3);
    let forceGood = false;
    if (this.has('ROBUST') && forceBad) {
      forceBad = false;
      forceGood = true;
    }
    if (this.has('CHAOTIC_BAD')) {
      forceBad = true;
      forceGood = false;
    }
    let cat = this.highestCategory();
    if (cat && !this.categoryAllowed([cat])) cat = null;
    const upgrades: string[] = [];
    const downgrades: string[] = [];
    for (const [id, d] of this.idx.defs) {
      if (!this.has(id)) continue;
      for (const m of [...(d.changes_to ?? []), ...(d.leads_to ?? [])]) if (this.mutationOk(m, forceGood, forceBad) && this.idx.valid(m)) upgrades.push(m);
      if (!this.isBase(id)) {
        const inCat = !!cat && (this.idx.byCategory.get(cat) ?? []).includes(id);
        if (!inCat && !d.threshold && !d.profession && d.purifiable !== false && this.rng.oneIn(4)) downgrades.push(id);
      }
    }
    if (this.rng.oneIn(2)) {
      if (upgrades.length) {
        const roll = this.rng.int(0, upgrades.length + 4);
        if (roll < upgrades.length) return this.mutateTowards(upgrades[roll]);
      }
    } else if (downgrades.length && cat) {
      const roll = this.rng.int(0, downgrades.length + 4);
      if (roll < downgrades.length) {
        this.removeMutation(downgrades[roll]);
        return true;
      }
    }
    let valid: string[] = [];
    let first = true;
    do {
      if (!first || this.has('CHAOTIC_BAD')) cat = null;
      valid = cat ? [...(this.idx.byCategory.get(cat) ?? [])] : [...this.idx.defs.values()].filter((d) => d.valid !== false && this.categoryAllowed(d.category ?? [])).map((d) => d.id);
      valid = valid.filter((id) => this.mutationOk(id, forceGood, forceBad) && this.idx.valid(id));
      if (!valid.length) first = false;
    } while (!valid.length && cat);
    if (!valid.length) return false;
    return this.mutateTowards(this.rng.pick(valid)) || this.mutateTowards(this.rng.pick(valid));
  }

  /** Character::mutate_category */
  mutateCategory(cat: string): boolean {
    if (cat === ANY) return this.mutate();
    let forceBad = this.rng.oneIn(3) && !this.idx.balanced;
    let forceGood = false;
    if (this.has('ROBUST') && forceBad) {
      forceBad = false;
      forceGood = true;
    }
    if (this.has('CHAOTIC_BAD')) {
      forceBad = true;
      forceGood = false;
    }
    const valid = (this.idx.byCategory.get(cat) ?? []).filter((id) => this.mutationOk(id, forceGood, forceBad));
    return this.mutateTowardsList(valid, 2);
  }

  /** Character::mutate_towards(vector, num_tries) */
  mutateTowardsList(muts: string[], tries: number): boolean {
    const list = [...muts];
    while (list.length && tries > 0) {
      const i = this.rng.int(0, list.length - 1);
      if (this.mutateTowards(list[i])) return true;
      list.splice(i, 1);
      tries--;
    }
    return false;
  }

  /** Character::mutate_towards(trait) */
  mutateTowards(id: string, depth = 0): boolean {
    if (depth > 40) return false;
    if (this.hasChildFlag(id)) {
      this.removeChildFlag(id);
      return true;
    }
    const d = this.idx.def(id);
    if (!d) {
      console.warn(`mutateTowards: unknown mutation "${id}"`);
      return false;
    }
    const allPre = this.idx.allPrereqs(id);
    const cancel = [...(d.cancels ?? [])];
    for (const t of this.idx.inTypes(d.types)) if (!allPre.includes(t)) cancel.push(t);
    const cancelTrait: string[] = [];
    for (const t of cancel) {
      if (!this.has(t)) continue;
      // Innate traits are never mutated away (canmutprofmut is off by default); the new
      // mutation replaces them below instead.
      if (this.isBase(t)) {
        if (!cancelTrait.includes(t)) cancelTrait.push(t);
        continue;
      }
      // One trait can knock out several others: remove one, then start over.
      this.removeMutation(t);
      return this.mutateTowards(id, depth + 1);
    }

    const prereq1 = (d.prereqs ?? []).some((p) => this.has(p));
    const prereq2 = (d.prereqs2 ?? []).some((p) => this.has(p));
    if (!(prereq1 && prereq2) && ((d.prereqs ?? []).length || (d.prereqs2 ?? []).length)) {
      if (!prereq1 && (d.prereqs ?? []).length) return this.mutateTowardsList(d.prereqs!, 2);
      if (!prereq2 && (d.prereqs2 ?? []).length) return this.mutateTowardsList(d.prereqs2!, 2);
    }

    if (d.threshold) {
      this.msg('You feel something straining deep inside you, yearning to be free…');
      return false;
    }
    if (d.profession) return false;
    const flags = d.flags ?? [];
    if (this.c.male ? flags.includes('FEMALE_EXCLUSIVE') || flags.includes('FEMALE_PREFERRED') : flags.includes('MALE_EXCLUSIVE') || flags.includes('MALE_PREFERRED')) return false;
    const tier = this.idx.thresholdTier(id);
    if (tier !== 0) {
      const ok = (d.category ?? []).some((cat) => {
        const t = this.idx.thresholdMuts(cat)[tier];
        return !!t && this.has(t);
      });
      if (!ok) {
        this.msg('You feel something straining deep inside you, yearning to be free…');
        return false;
      }
    }

    // A prerequisite that changes_to this one is replaced by it.
    const replacedBy = (list: string[] | undefined) => (list ?? []).find((p) => this.has(p) && (this.idx.def(p)?.changes_to ?? []).includes(id));
    const gained = this.name(id);
    let replaced = false;
    for (const r of [replacedBy(d.prereqs), replacedBy(d.prereqs2)]) {
      if (!r || !this.has(r)) continue;
      this.msg(`Your ${this.name(r)} mutation turns into ${gained}!`, this.rating(d, this.idx.def(r), true));
      this.unsetMutation(r);
      replaced = true;
    }
    for (const t of cancelTrait) {
      this.msg(`Your innate ${this.name(t)} trait turns into ${gained}!`, this.rating(d, this.idx.def(t), true));
      this.unsetMutation(t);
      replaced = true;
    }
    if (!replaced) {
      const pts = d.points ?? 0;
      this.msg(`You gain a mutation called ${gained}!`, d.mixed_effect ? 'c_pink' : pts > 0 ? 'c_light_green' : pts < 0 ? 'c_light_red' : 'c_white');
    }
    this.setMutation(id);
    return true;
  }

  // ------------------------------------------------------------------ thresholds
  /** mutation.cpp test_crossing_threshold (IV mutagen, before and after mutating). */
  testCrossingThreshold(cat: string, tier = 1): boolean {
    const hasThreshTrait = () => [...this.c.traits].some((t) => this.idx.def(t)?.threshold);
    if (this.threshTier >= tier) {
      if (hasThreshTrait()) return false;
      // Tier without a threshold trait (debug removals): reset like BN.
      this.threshTier = 0;
      this.threshCategory = null;
    }
    if (this.threshTier < tier - 1) return this.testCrossingThreshold(cat, tier - 1);
    const thresh = this.idx.thresholdMuts(cat);
    if (thresh.length <= tier || !thresh[tier]) return false;
    if (this.threshTier > 0 && this.threshCategory !== cat) {
      if (hasThreshTrait()) return false;
      this.threshTier = 0;
      this.threshCategory = null;
    }
    const levels = this.categoryLevels();
    let total = 0;
    for (const c of this.idx.categories.keys()) total += levels.get(c) ?? 0;
    const primary = this.highestCategory(levels);
    const breach = primary ? levels.get(primary) ?? 0 : 0;
    if (cat === primary && breach > 50) {
      const booster = cat === 'URSINE' || cat === 'ALPHA' ? 50 : 0;
      if (this.rng.next() * total < breach + booster) {
        this.msg("Something strains mightily for a moment… and then… you're… FREE!", 'c_light_green');
        this.setMutation(thresh[tier]!);
        this.threshCategory = cat;
        this.threshTier++;
        if (cat === 'URSINE' && this.has('CARNIVORE')) {
          this.unsetMutation('CARNIVORE');
          this.msg('Your appetite for blood fades.');
        }
        this.onThreshold?.(cat, cddaText(this.idx.categories.get(cat)?.memorial_message) || 'Crossed a threshold');
        return true;
      }
    } else if (this.has('NOPAIN')) {
      this.msg('You feel extremely disappointed as nothing happens.', 'c_light_red');
    } else if (breach > 100) {
      this.msg('You stagger with a piercing headache!', 'c_light_red');
      this.c.modPain(8);
      this.c.addEffect('stunned', turnsToEffectSeconds(this.rng.int(3, 5)));
    } else if (breach > 80) {
      this.msg('Your head throbs with memories of your life, before all this…', 'c_light_red');
      this.c.modPain(6);
      this.c.addEffect('stunned', turnsToEffectSeconds(this.rng.int(2, 4)));
    } else if (breach > 60) {
      this.msg('Images of your past life flash before you.', 'c_light_red');
      this.c.addEffect('stunned', turnsToEffectSeconds(this.rng.int(2, 3)));
    }
    return false;
  }

  // ------------------------------------------------------------------ mutagens & purifiers
  /**
   * try_reject_mutagen: null = accepted; otherwise the message and whether the dose is
   * destroyed (used up) or merely refused.
   */
  rejection(it: Item, strong: boolean): { msg: string; destroyed: boolean } | null {
    if (this.has('MUTAGEN_AVOID')) return { msg: "After what happened that last time?  uh-uh.  You're not drinking that chemical stuff.", destroyed: false };
    if (useActionTypes(it).some((t) => ['MYCUS', 'MARLOSS', 'MARLOSS_SEED', 'MARLOSS_GEL'].includes(t))) return null;
    if (this.has('THRESH_MYCUS')) {
      if (['M_SPORES', 'M_FERTILE', 'M_BLOSSOMS', 'M_BLOOM'].some((t) => this.has(t))) return { msg: 'This is a contaminant.  We reject it from the Mycus.  We decontaminate it with spores.', destroyed: true };
      return { msg: 'This is a contaminant.  We reject it from the Mycus.  We must eliminate this contaminant at the earliest opportunity.', destroyed: false };
    }
    if (this.has('THRESH_MARLOSS')) return { msg: `The ${it.name()} sears your insides white-hot, and you collapse to the ground!`, destroyed: true };
    return null;
  }

  /** The THRESH_MARLOSS reaction to mutagen (try_reject_mutagen's destroyed branch). */
  private marlossReaction(strong: boolean): void {
    this.c.modPain(35 + (strong ? 20 : 0));
    const dmg = this.rng.int(20, 35) + (strong ? 10 : 0);
    for (const p of ['head', 'torso', 'arm_l', 'arm_r', 'leg_l', 'leg_r'] as const) this.c.applyDamage(p, dmg);
    this.c.fallAsleep(Math.max(60, 5 * 3600 - 60 * (this.c.int + (strong ? 100 : 0))));
    this.setMutation('MUTAGEN_AVOID');
    if (strong) {
      this.unsetMutation('THRESH_MARLOSS');
      this.msg('It was probably that marloss -- how did you know to call it "marloss" anyway?', 'c_yellow');
      this.msg('Best to stay clear of that alien crap in future.', 'c_yellow');
    } else this.msg("That was some toxic mutagen!  Let's stick with Marloss next time, that's safe.", 'c_yellow');
  }

  private category(cat: string | undefined): MutationCategory & typeof CATEGORY_DEFAULTS & { id: string } {
    const id = cat ?? ANY;
    return { ...CATEGORY_DEFAULTS, ...(this.idx.categories.get(id) ?? { id }) } as MutationCategory & typeof CATEGORY_DEFAULTS & { id: string };
  }

  /** mutagen_actor::use (drinking mutagen). The caller has already consumed the dose. */
  useMutagen(it: Item, ua: MutagenAction): MutagenUse {
    const cat = this.category(ua.mutation_category);
    const strong = !!ua.is_strong, weak = !!ua.is_weak;
    const rej = this.rejection(it, false);
    if (rej) {
      this.msg(rej.msg, 'c_light_red');
      if (this.has('THRESH_MARLOSS')) this.marlossReaction(false);
      return { ok: false, msg: rej.msg };
    }
    const noCategory = cat.id === ANY;
    const balanced = this.idx.balanced;
    // Mutagenic flesh often just fails to work (unbalanced rules only).
    if (weak && !this.rng.oneIn(3) && !balanced) return { ok: true };
    if (balanced && noCategory) {
      for (let i = (strong ? 1 : 0) + (weak ? 0 : 1); i > 0; i--) this.c.addEffect('accumulated_mutagen', 2 * 86400, { permanent: true });
    }
    if (this.has('MUT_JUNKIE')) {
      this.msg('You quiver with anticipation…', 'c_light_green');
      this.c.morale.add('morale_mutagen', 5, 50, 3600, 1800);
    }
    if (cat.mutagen_message) this.msg(cddaText(cat.mutagen_message));
    if (this.rng.oneIn(6)) {
      this.msg('You suddenly feel dizzy, and collapse to the ground.', 'c_light_red');
      this.c.addEffect('downed', turnsToEffectSeconds(20));
    }
    const count = 1 + (strong && this.rng.oneIn(3) ? 1 : 0);
    for (let i = 0; i < count; i++) {
      this.mutateCategory(cat.id);
      if (cat.mutagen_pain) this.c.modPain(cat.mutagen_pain * this.rng.int(1, 5));
    }
    this.modStoredNutr(cat.mutagen_hunger * count);
    this.c.thirst += cat.mutagen_thirst * count;
    this.c.sleepiness += cat.mutagen_fatigue * count;
    return { ok: true };
  }

  /** mutagen_iv_actor::use (injecting a serum). */
  useMutagenIv(it: Item, ua: MutagenAction): MutagenUse {
    const cat = this.category(ua.mutation_category);
    const tier = ua.tier ?? 1;
    const rej = this.rejection(it, false);
    if (rej) {
      this.msg(rej.msg, 'c_light_red');
      if (this.has('THRESH_MARLOSS')) this.marlossReaction(false);
      return { ok: false, msg: rej.msg };
    }
    this.msg(this.has('MUT_JUNKIE') ? cddaText(cat.junkie_message) || "Oh, yeah!  That's the stuff!" : cddaText(cat.iv_message));
    // Crossing first lets this dose already grant post-threshold mutations.
    this.testCrossingThreshold(cat.id, tier);
    if (!this.has('NOPAIN') && cat.iv_sound) {
      this.c.modPain(cat.iv_pain);
      this.onNoise?.(cat.iv_noise + this.c.str, cddaText(cat.iv_sound_message) || 'You inject yoursel-arRGH!');
    }
    let count = cat.iv_min_mutations;
    for (let i = 0; i < cat.iv_additional_mutations; i++) if (!this.rng.oneIn(cat.iv_additional_mutations_chance)) count++;
    for (let i = 0; i < count; i++) {
      this.mutateCategory(cat.id);
      this.c.modPain(cat.iv_pain * this.rng.int(1, 5));
    }
    this.c.storedKcal -= 10 * cat.iv_hunger * count;
    this.c.thirst += cat.iv_thirst * count;
    this.c.sleepiness += cat.iv_fatigue * count;
    if (cat.iv_morale > 0 || cat.id === 'CHIMERA' || cat.id === 'ELFA') {
      const type = cat.id === 'CHIMERA' ? 'morale_mutagen_chimera' : cat.id === 'ELFA' ? 'morale_mutagen_elf' : 'morale_mutagen_mutation';
      this.c.morale.add(type, cat.iv_morale, cat.iv_morale_max, 3600, 1800);
    }
    if (cat.iv_sleep && !this.rng.oneIn(3)) {
      this.msg(cddaText(cat.iv_sleep_message) || 'You fall asleep.', 'c_light_red');
      this.c.fallAsleep(Math.max(60, cat.iv_sleep_dur - this.c.int * 5));
    }
    this.testCrossingThreshold(cat.id, tier);
    return { ok: true };
  }

  /** Mutations a purifier may remove (do_purify's candidate list). */
  purifiable(): string[] {
    const thresh = this.threshCategory ?? this.highestCategory();
    const crossed = this.crossedThreshold();
    return [...this.c.traits].filter((id) => {
      if (this.isBase(id) || !this.idx.def(id)) return false;
      const d = this.idx.def(id)!;
      return !(d.category ?? []).some((cat) => cat === thresh && crossed && this.threshTier > this.idx.thresholdTier(id));
    });
  }

  /** iuse::purifier (do_purify) / purify_iv / purify_smart. */
  purify(kind: (typeof PURIFIER_ACTIONS)[number]): MutagenUse {
    const valid = this.purifiable();
    if (kind === 'PURIFY_SMART') {
      const choices = valid.filter((id) => this.idx.purifiable(id));
      if (!choices.length) return { ok: false, msg: "You don't have any mutations to purify." };
      const pick = this.choosePurify ? this.choosePurify(choices) : choices[0];
      if (!pick) return { ok: false };
      this.msg('You inject the purifier.  The liquid thrashes inside the tube and goes down reluctantly.');
      this.removeMutation(pick);
      this.c.modPain(3);
      return { ok: true };
    }
    if (!valid.length) {
      this.msg('You feel cleansed.');
      return { ok: true };
    }
    const iv = kind === 'PURIFY_IV';
    const cured = iv ? Math.min(8, this.rng.int(4, Math.max(4, valid.length))) : Math.min(4, this.rng.int(1, valid.length));
    for (let i = 0; i < cured && valid.length; i++) {
      const id = valid.splice(this.rng.int(0, valid.length - 1), 1)[0];
      if (this.idx.purifiable(id)) this.removeMutation(id);
      else this.msg(iv ? 'You feel a distinct burning inside, but it passes.' : 'You feel a slight itching inside, but it passes.', 'c_yellow');
      if (iv) {
        if (!this.has('NOPAIN')) {
          this.c.modPain(2 * cured);
          this.msg("Feels like you're on fire, but you're OK.", 'c_yellow');
        }
        this.modStoredNutr(2 * cured);
        this.c.thirst += 2 * cured;
        this.c.sleepiness += 2 * cured;
      }
    }
    return { ok: true };
  }

  /** Character::mod_stored_nutr: legacy nutrition points → kcal (2500 / 288 each). */
  private modStoredNutr(nutr: number): void {
    this.c.storedKcal -= Math.round((nutr * 2500) / (12 * 24));
  }

  /** A new character's accumulated mutagen (game.cpp start_game: 27 days, capped at 22). */
  startGame(): void {
    this.c.addEffect('accumulated_mutagen', 27 * 86400, { permanent: true });
  }

  // ------------------------------------------------------------------ activation
  /** Mutations with an activation (BN `active`). */
  activatable(): string[] {
    return [...this.c.traits].filter((id) => this.idx.def(id)?.active);
  }
  isPowered(id: string): boolean {
    return this.powered.has(id);
  }
  /** can_use_mutation: resource floors below which activation would kill you. */
  private canUse(d: MutData): boolean {
    return !(
      (d.hunger && this.c.storedKcal < this.c.healthyKcal() * 0.5) ||
      (d.thirst && this.c.thirst >= 240) ||
      (d.fatigue && this.c.sleepiness >= 575)
    );
  }
  /** Character::activate_mutation / deactivate_mutation (costs, transform, toggle). */
  toggle(id: string): string {
    const d = this.idx.def(id);
    if (!d?.active || !this.has(id)) return `You can't activate ${this.name(id)}.`;
    if (this.powered.has(id)) {
      this.powered.delete(id);
      this.charge.delete(id);
      if (d.transform) this.switchMutation(id, d.transform);
      return `You stop using your ${this.name(id)}.`;
    }
    if (!this.canUse(d)) return `You feel like using your ${this.name(id)} would kill you!`;
    this.spendResources(id, d);
    this.powered.add(id);
    if (d.transform) {
      this.switchMutation(id, d.transform);
      return cddaText(d.transform.msg_transform) || `You activate your ${this.name(id)}.`;
    }
    return `You activate your ${this.name(id)}.`;
  }
  private switchMutation(from: string, t: { target: string; active?: boolean }): void {
    this.unsetMutation(from);
    this.setMutation(t.target);
    if (t.active) this.powered.add(t.target);
  }
  /** Character::mutation_spend_resources (activation). */
  private spendResources(id: string, d: MutData): void {
    const cost = d.cost ?? 0;
    const charge = this.charge.get(id) ?? 0;
    if (this.powered.has(id) && charge > 0) {
      this.charge.set(id, charge - 1);
      return;
    }
    if ((d.time ?? 0) > 0) this.charge.set(id, d.time! - 1);
    if (d.hunger) this.c.storedKcal -= cost * 6;
    if (d.thirst) this.c.thirst += cost;
    if (d.fatigue) this.c.sleepiness += cost;
  }
  /** Character::suffer_mutation_power: a powered mutation's upkeep, once per turn. */
  private upkeep(id: string, d: MutData): void {
    const charge = this.charge.get(id) ?? 0;
    if (charge > 0) {
      this.charge.set(id, charge - 1);
      return;
    }
    if ((d.time ?? 0) > 0) this.charge.set(id, d.time! - 1);
    const cost = d.cost ?? 0;
    let stop = false;
    if (d.hunger) {
      this.modStoredNutr(cost);
      if (this.c.bmiFat() < 18.5) {
        this.msg(`You're too malnourished to keep your ${this.name(id)} going.`, 'c_yellow');
        stop = true;
      }
    }
    if (d.thirst) {
      this.c.thirst += cost;
      if (this.c.thirst >= 240) {
        this.msg(`You're too dehydrated to keep your ${this.name(id)} going.`, 'c_yellow');
        stop = true;
      }
    }
    if (d.fatigue) {
      this.c.sleepiness += cost;
      if (this.c.sleepiness >= 575) {
        this.msg(`You're too exhausted to keep your ${this.name(id)} going.`, 'c_yellow');
        stop = true;
      }
    }
    if (stop) {
      this.powered.delete(id);
      this.charge.delete(id);
    }
  }

  // ------------------------------------------------------------------ time
  /** Advance active mutation upkeep by gameDt game seconds (one BN turn per second). */
  update(gameDt: number): void {
    if (this.c.dead || gameDt <= 0) return;
    this.syncBase();
    this.acc += gameDt;
    const n = Math.floor(this.acc);
    if (n <= 0) return;
    this.acc -= n;
    this.time += n;
    for (const id of [...this.powered]) {
      const d = this.idx.def(id);
      if (!d?.cost || !d.time) continue;
      // Upkeep once per `time` turns: fast-forward the charge countdown in bulk.
      let left = n;
      while (left > 0 && this.powered.has(id)) {
        const charge = this.charge.get(id) ?? 0;
        if (charge >= left) {
          this.charge.set(id, charge - left);
          break;
        }
        left -= charge + 1;
        this.charge.set(id, 0);
        this.upkeep(id, d);
      }
    }
  }

  // ------------------------------------------------------------------ hardcoded effects
  /** Extra encumbrance on a part from encumbrance_always / encumbrance_covered. */
  encumbrance(bp: BodyPartId): number {
    let n = 0;
    for (const id of this.c.traits) {
      const d = this.idx.def(id);
      if (!d) continue;
      for (const [p, e] of d.encumbrance_always ?? []) if (this.idx.mainPart(p) === bp) n += e;
      if (d.encumbrance_covered?.length && this.c.inv.worn.some((w) => covers(w, bp)))
        for (const [p, e] of d.encumbrance_covered) if (this.idx.mainPart(p) === bp) n += e;
    }
    return n;
  }

  /**
   * Character::mutation_armor: each mutation's `armor` entries (the last entry naming a part
   * wins, like the C++ map) with BN resistance keys: bash/cut/stab/bullet, `physical` for all
   * four, `non_physical`, `all`. Stab uses cut armor (passive_absorb_hit).
   */
  armor(bp: BodyPartId, dtype: string): number {
    const type = dtype === 'stab' ? 'cut' : dtype;
    let n = 0;
    for (const id of this.c.traits) {
      let res: Record<string, unknown> | null = null;
      for (const a of this.idx.def(id)?.armor ?? []) {
        const parts = asArray(a.parts as string | string[] | undefined);
        if (parts.includes('ALL') || parts.includes(bp)) res = a;
      }
      if (res) n += resistanceFor(res, type);
    }
    return n;
  }

  /** Character::night_vision_sight_range from mutations: the best night_vision_range. */
  nightVisionRange(): number {
    let best = 0;
    for (const id of this.c.traits) best = Math.max(best, this.idx.def(id)?.night_vision_range ?? 0);
    return best;
  }

  /** Mutation ids to try as sprite overlays (visible ones; the atlas decides which have art). */
  overlays(): string[] {
    return [...this.c.traits].filter((id) => this.idx.visible(id) && !!this.idx.def(id));
  }

  /**
   * Enchantment `condition` evaluator for Character.enchantCondition: BN enchantment
   * conditions (ALWAYS, ACTIVE = the mutation is powered, INACTIVE) and the simple ones
   * old data used. Unknown conditions count as true.
   */
  conditionHolds(cond: unknown, traitId: string, isDay: () => boolean): boolean {
    if (Array.isArray(cond)) return cond.every((c) => this.conditionHolds(c, traitId, isDay));
    if (cond === undefined || cond === 'ALWAYS') return true;
    if (cond === 'ACTIVE') return this.powered.has(traitId);
    if (cond === 'INACTIVE') return !this.powered.has(traitId);
    if (cond === 'is_day' || cond === 'DAY') return isDay();
    if (cond === 'NIGHT') return !isDay();
    if (cond === 'u_has_weapon') return !!this.c.inv.wielded;
    if (typeof cond === 'object' && cond) {
      const o = cond as Record<string, unknown>;
      if ('not' in o) return !this.conditionHolds(o.not, traitId, isDay);
      if ('and' in o) return (o.and as unknown[]).every((x) => this.conditionHolds(x, traitId, isDay));
      if ('or' in o) return (o.or as unknown[]).some((x) => this.conditionHolds(x, traitId, isDay));
      if ('u_has_trait' in o) return this.has(String(o.u_has_trait));
      if ('u_has_effect' in o) return this.c.hasEffect(String(o.u_has_effect));
    }
    return true;
  }

  toJSON(): MutationStateJSON {
    return {
      powered: [...this.powered], base: [...this.base], threshTier: this.threshTier, threshCategory: this.threshCategory,
      charge: Object.fromEntries(this.charge), time: this.time,
    };
  }
  /** Loads BN saves; v1 (DDA) saves' vitamins/CHANGING timers are simply ignored. */
  load(j: MutationStateJSON): void {
    this.powered.clear();
    for (const p of j.powered ?? []) this.powered.add(p);
    this.base.clear();
    for (const b of j.base ?? []) this.base.add(b);
    this.gained = new Set([...this.c.traits].filter((t) => !this.base.has(t)));
    this.charge.clear();
    for (const [k, v] of Object.entries(j.charge ?? {})) this.charge.set(k, v);
    this.threshTier = j.threshTier ?? 0;
    this.threshCategory = j.threshCategory ?? null;
    // Old saves: a threshold trait without tier bookkeeping counts as tier 1 of its category.
    if (!this.threshTier && this.crossedThreshold()) {
      const cat = this.thresholdCategory();
      if (cat) {
        this.threshCategory = cat;
        this.threshTier = 1;
      }
    }
    this.time = j.time ?? 0;
    // DDA's hidden CHANGING trait has no meaning in BN.
    if (this.has('CHANGING') && !this.idx.def('CHANGING')) this.c.removeTrait('CHANGING');
  }
}

/**
 * calc_category_weights: additions 1 + 4·lvl/max(hi, 20), removals 5 − 4·lvl/max(hi, 20);
 * the strongest category (first on ties) doubled; normalized.
 */
function categoryWeights(levels: Map<string, number>, addition: boolean): Map<string, number> {
  let maxCat: string | null = null;
  let maxLvl = -Infinity;
  for (const [c, l] of levels) if (l > maxLvl) ((maxLvl = l), (maxCat = c));
  const h = Math.max(maxLvl, 20);
  const w = new Map<string, number>();
  for (const [c, l] of levels) w.set(c, addition ? 1 + 4 * (l / h) : 5 - 4 * (l / h));
  if (maxCat) w.set(maxCat, w.get(maxCat)! * 2);
  let sum = 0;
  for (const v of w.values()) sum += v;
  for (const [c, v] of w) w.set(c, v / sum);
  return w;
}

/** score_difference_to_chance: normal density, mean 0, sigma 5. */
function gaussian(diff: number): number {
  const sigma = 5;
  return (1 / (sigma * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * (diff / sigma) ** 2);
}

/** BN load_damage_map: a damage type's resistance with physical/non_physical/all fallbacks. */
function resistanceFor(res: Record<string, unknown>, type: string): number {
  const num = (k: string) => (typeof res[k] === 'number' ? (res[k] as number) : undefined);
  const physical = ['bash', 'cut', 'stab', 'bullet'].includes(type);
  return num(type) ?? (physical ? num('physical') : num('non_physical')) ?? num('all') ?? 0;
}

/** Use action type names of an item (strings or objects). */
export function useActionTypes(it: Item): string[] {
  return asArray(it.def.use_action as unknown).map((u) => (typeof u === 'string' ? u : String((u as { type?: string })?.type ?? '')));
}

/** The mutagen use_action of an item, if any. */
export function mutagenAction(it: Item): MutagenAction | null {
  for (const u of asArray(it.def.use_action as unknown)) {
    if (u && typeof u === 'object' && ((u as { type?: string }).type === 'mutagen' || (u as { type?: string }).type === 'mutagen_iv')) return u as MutagenAction;
  }
  return null;
}

/** mutation_branch::conflicts_with_item (restricts_gear, allowed_items(_only), allow_soft_gear). */
export function conflictsWithItem(data: GameData, d: MutData, it: Item): boolean {
  for (const f of d.allowed_items ?? []) if (it.hasFlag(f)) return false;
  for (const part of d.restricts_gear ?? []) {
    if (!isBodyPart(part) || !covers(it, part)) continue;
    if (it.hasFlag('OVERSIZE') || it.hasFlag('resized_large')) return !!d.allowed_items_only;
    if (d.allow_soft_gear && isSoft(data, it)) return false;
    return true;
  }
  return false;
}

/** item::is_soft: every material is soft. */
export function isSoft(data: GameData, it: Item): boolean {
  if (it.hasFlag('SOFT')) return true;
  if (it.hasFlag('STIFF')) return false;
  const mats = (it.def.material ?? []).map((m) => (typeof m === 'string' ? m : (m as { type: string }).type));
  if (!mats.length) return false;
  return mats.every((m) => data.misc?.material?.[m]?.soft === true);
}
