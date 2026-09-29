import type { GameData, MutationDef } from '../data/types';
import { ALL_PARTS, isBodyPart, type BodyPartId } from './bodyparts';
import type { Character } from './character';
import { armorPortion, covers, materialIds } from './inventory';
import { consumeItem, L, moveItem, spawnItem } from './moves';
import { asArray, createItem, type Item } from './item';
import { cddaText } from './units';

// CDDA mutations (mutation.cpp, mutation_data.cpp, character_body/health vitamins and the
// data-driven "changing" EOCs in data/json/effects_on_condition/mutation_eocs/changing_eocs.json).
//
// How modern CDDA mutates (and what the extracted data implies):
//   - Mutagens are consume_drug items that add *vitamins*: `mutagen` (the generic catalyst)
//     plus a category primer (`mutagen_lizard`, `mutagen_human` for purifier …). Mutagenic
//     slurry adds `mutagenic_slurry`, which decays 1/s into catalyst + every primer + toxin.
//   - Every 30–45 min, with catalyst >= 450, a weighted roll (2500 : catalyst) grants the
//     hidden CHANGING trait. While CHANGING, every 1–6 h: catalyst >= 300 → mutate(), then
//     catalyst -= 60 + rand(80); else 1-in-3 the change ends and the catalyst is flushed.
//   - Character::mutate picks a category weighted by its primer vitamin, rolls good/bad by
//     instability, and mutates towards a valid trait, paying its `vitamin_cost` in primer.
//   - Purifier is the HUMAN category: its traits are all `dummy` with broad `types`/`cancels`,
//     so "mutating towards" one removes a conflicting mutation instead of adding anything.
//   - Thresholds: once the category level (mutation heights) reaches 30 and the primer covers
//     the threshold's cost, a mutation roll may cross it (breach_power% chance).
//   - Vitamin excess applies the vitamin's `excess` effect (mutagen sickness: hurt/pain).
//
// Everything here is per Character (MutationState), UI-free and deterministic on the
// character's Rng so it can be unit tested against the real data.

/** The mutation fields this module reads (CDDA JSON key names). */
export interface MutData extends MutationDef {
  category?: string[];
  prereqs?: string[];
  prereqs2?: string[];
  /** CDDA "changes_to": replacements. */
  changes_to?: string[];
  /** CDDA "leads_to": additions. */
  leads_to?: string[];
  cancels?: string[];
  types?: string[];
  threshreq?: string[];
  strict_threshreq?: boolean;
  threshold?: boolean;
  threshold_substitutes?: string[];
  valid?: boolean;
  purifiable?: boolean;
  dummy?: boolean;
  profession?: boolean;
  debug?: boolean;
  player_display?: boolean;
  mixed_effect?: boolean;
  visibility?: number;
  ugliness?: number;
  vitamin_cost?: number;
  restricts_gear?: string[];
  allowed_items?: string[];
  allow_soft_gear?: boolean;
  destroys_gear?: boolean;
  integrated_armor?: string[];
  encumbrance_always?: [string, number][];
  encumbrance_covered?: [string, number][];
  armor?: { parts?: string[]; part_types?: string[]; [dtype: string]: unknown }[];
  active?: boolean;
  starts_active?: boolean;
  cost?: number;
  time?: number;
  hunger?: boolean;
  thirst?: boolean;
  sleepiness?: boolean;
  transform?: { target: string; msg_transform?: string; active?: boolean; moves?: number };
  flags?: string[];
}

export interface MutationCategory {
  id: string;
  name?: string;
  threshold_mut?: string;
  threshold_min?: number;
  vitamin?: string;
  base_removal_chance?: number;
  base_removal_cost_mul?: number;
  mutagen_message?: string;
  memorial_message?: string;
}

export interface VitaminDef {
  id: string;
  name?: string;
  vit_type?: string;
  excess?: string;
  deficiency?: string;
  min?: number;
  max?: number;
  /** Seconds per unit of decay (negative = generation). */
  rate?: number;
  disease_excess?: [number, number][];
  decays_into?: [string, number][];
}

/** Data indices built once per GameData. */
export class MutationIndex {
  readonly defs = new Map<string, MutData>();
  readonly categories = new Map<string, MutationCategory>();
  /** CDDA mutations_category: category → trait ids (includes thresholds, filtered at use). */
  readonly byCategory = new Map<string, string[]>();
  /** mutation_type → trait ids (get_mutations_in_types). */
  readonly byType = new Map<string, string[]>();
  readonly vitamins = new Map<string, VitaminDef>();
  /** body_part / sub_body_part id → main body part id we model (hand_l, head …). */
  readonly subParent = new Map<string, string>();
  /** All mutagen vitamins (a category's `vitamin`), for the weighted category pick. */
  readonly categoryVitamins: [string, string][] = [];

  constructor(readonly data: GameData) {
    const misc = data.misc ?? {};
    for (const m of Object.values((misc.mutation ?? {}) as Record<string, MutData>)) this.defs.set(m.id, m);
    for (const c of Object.values((misc.mutation_category ?? {}) as Record<string, MutationCategory>)) {
      this.categories.set(c.id, c);
      if (c.vitamin && c.vitamin !== 'null') this.categoryVitamins.push([c.id, c.vitamin]);
    }
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
    for (const v of Object.values((misc.vitamin ?? {}) as Record<string, VitaminDef>)) this.vitamins.set(v.id, v);
    for (const s of Object.values((misc.sub_body_part ?? {}) as Record<string, { id: string; parent: string }>)) this.subParent.set(s.id, s.parent);
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
  vitaminCost(id: string): number {
    return this.defs.get(id)?.vitamin_cost ?? 100;
  }
  inCategory(id: string, cat: string): boolean {
    return (this.defs.get(id)?.category ?? []).includes(cat);
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
  /** Map a CDDA body part / sub part id to one of ours (sole → foot, crown → head …). */
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
  vitamins: Record<string, number>;
  powered: string[];
  base: string[];
  time: number;
  nextChangingCheck: number;
  nextChangingMutate: number;
}

const HOUR = 3600;

/**
 * One character's mutation state: vitamins, powered (activated) mutations, which traits are
 * innate ("base" traits, CDDA my_traits), and the CHANGING timers. The trait set itself lives
 * on Character.traits so the existing enchantment code applies mutation effects.
 */
export class MutationState {
  readonly idx: MutationIndex;
  vitamins: Record<string, number> = {};
  readonly powered = new Set<string>();
  /** Starting traits (CDDA my_traits): removal gets category base_removal_chance/cost. */
  readonly base = new Set<string>();
  /** Game seconds processed (vitamin decay ticks, EOC timers). */
  time = 0;
  nextChangingCheck = 0;
  nextChangingMutate = 0;
  /** Items pushed off by a new mutation go here (the installer drops them on the map). */
  onDropItem: ((it: Item) => void) | null = null;
  /** Called after any gain/loss so views (sprite overlays) can refresh. */
  onChanged: (() => void) | null = null;
  /** Mutations gained/lost through this system; everything else on the character is innate. */
  private gained = new Set<string>();
  private acc = 0;

  constructor(readonly c: Character) {
    this.idx = mutationIndex(c.data);
    for (const t of c.traits) this.base.add(t);
    this.nextChangingCheck = this.rollChangingCheck();
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
  /** Traits on the character that aren't innate or hidden (for the `[` menu / sprite). */
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
  crossedThreshold(): boolean {
    for (const t of this.c.traits) if (this.idx.def(t)?.threshold) return true;
    return false;
  }
  thresholdCategory(): string | null {
    for (const t of this.c.traits) {
      if (!this.idx.def(t)?.threshold) continue;
      for (const [cat, c] of this.idx.categories) if (c.threshold_mut === t) return cat;
    }
    return null;
  }

  /** Character::mutation_height: 1 + tallest prerequisite chain. */
  mutationHeight(id: string, depth = 0): number {
    const d = this.idx.def(id);
    if (!d || depth > 30) return 1;
    let h = 0;
    for (const p of [...(d.prereqs ?? []), ...(d.prereqs2 ?? [])]) h = Math.max(h, this.mutationHeight(p, depth + 1));
    return 1 + h;
  }

  /** Character::calc_mutation_levels: per category, threshold +10, each top mutation height+2. */
  categoryLevels(): Map<string, number> {
    const out = new Map<string, number>();
    const add = (cat: string, n: number) => out.set(cat, (out.get(cat) ?? 0) + n);
    for (const id of this.c.traits) {
      const d = this.idx.def(id);
      if (!d) continue;
      if (d.threshold) {
        // Thresholds carry no category list in data; credit their category by threshold_mut.
        for (const [cat, c] of this.idx.categories) if (c.threshold_mut === id) add(cat, 10);
        continue;
      }
      const upgraded = (d.leads_to ?? []).some((u) => this.has(u) && !(this.idx.def(u)?.flags ?? []).includes('NON_THRESH'));
      if (upgraded || (d.flags ?? []).includes('NON_THRESH')) continue;
      const h = this.mutationHeight(id);
      for (const cat of d.category ?? []) add(cat, h + 2);
    }
    return out;
  }

  /** Character::get_instability_per_category */
  instability(cat: string): number {
    let n = 0;
    for (const id of this.c.traits) {
      const d = this.idx.def(id);
      if (!d || (d.points ?? 0) <= -1 || d.threshold || !(d.category ?? []).length || this.isBase(id)) continue;
      const h = this.mutationHeight(id);
      n += (d.category ?? []).includes(cat) ? h : h * 2;
    }
    return Math.max(0, n);
  }

  /** get_total_in_category(POSITIVE): non-threshold traits with points >= 0. */
  positiveInCategory(cat: string): number {
    let n = 0;
    for (const id of this.idx.byCategory.get(cat) ?? []) {
      const d = this.idx.def(id)!;
      if ((d.points ?? 0) >= 0 && !d.threshold) n++;
    }
    return Math.max(1, n);
  }

  /** Character::roll_bad_mutation */
  rollBadMutation(cat: string): boolean {
    const insta = this.instability(cat);
    if (insta === 0) return false;
    const chance = Math.min(0.67, (0.5 * insta) / this.positiveInCategory(cat));
    return this.rng.next() < chance;
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

  /** has_conflicting_trait: opposite, lower, replacement or same-type trait present. */
  conflictingTraits(id: string): string[] {
    const d = this.idx.def(id);
    if (!d) return [];
    const out = new Set<string>();
    for (const t of d.cancels ?? []) if (this.has(t)) out.add(t);
    const lower = (x: string, depth = 0) => {
      if (depth > 30) return;
      const xd = this.idx.def(x);
      for (const p of [...(xd?.prereqs ?? []), ...(xd?.prereqs2 ?? [])]) {
        if (this.has(p)) out.add(p);
        lower(p, depth + 1);
      }
    };
    lower(id);
    for (const r of d.changes_to ?? []) if (this.has(r)) out.add(r);
    for (const t of this.idx.inTypes(d.types)) if (t !== id && this.has(t)) out.add(t);
    return [...out];
  }

  /** Character::mutation_ok (+ the vitamin check when mutating with vitamins). */
  mutationOk(id: string, good: boolean, bad: boolean, neutral: boolean, vitamin?: string): boolean {
    const d = this.idx.def(id);
    if (!d) return false;
    if (vitamin && this.vitamin(vitamin) < this.idx.vitaminCost(id)) return false;
    if (d.debug) return false;
    if (this.has(id) || this.hasChildFlag(id)) return false;
    const pts = d.points ?? 0;
    if (!good && pts > 0) return false;
    if (!bad && pts < 0) return false;
    if (!neutral && pts === 0) return false;
    return true;
  }

  // ------------------------------------------------------------------ vitamins
  vitamin(id: string): number {
    return this.vitamins[id] ?? 0;
  }
  /** Character::vitamin_mod: clamp to [min,max], decays_into on decrease, excess effect. */
  vitaminMod(id: string, qty: number): number {
    const v = this.idx.vitamins.get(id);
    if (!v) {
      console.warn(`Unknown vitamin "${id}"`);
      return 0;
    }
    const cur = this.vitamin(id);
    if (qty > 0) this.vitamins[id] = Math.min(cur + qty, v.max ?? Infinity);
    else if (qty < 0) {
      this.vitamins[id] = Math.max(cur + qty, v.min ?? 0);
      for (const [into, n] of v.decays_into ?? []) if (this.vitamins[id] !== 0 || cur !== 0) this.vitaminMod(into, n * Math.abs(qty));
    }
    this.updateVitaminEffect(id);
    return this.vitamins[id];
  }
  /** vitamin::severity → the excess effect's intensity (Character::update_vitamins). */
  private updateVitaminEffect(id: string): void {
    const v = this.idx.vitamins.get(id);
    if (!v?.excess || !this.c.effectTypes.has(v.excess)) return;
    const q = this.vitamin(id);
    let lvl = 0;
    (v.disease_excess ?? []).forEach(([a, b], i) => {
      if ((q >= a && q <= b) || (q <= a && q >= b)) lvl = i + 1;
    });
    const e = this.c.effects.get(v.excess);
    if (lvl === 0) {
      if (e) this.c.removeEffect(v.excess);
    } else if (e) e.setIntensity(lvl);
    else this.c.addEffect(v.excess, 1, { intensity: lvl, permanent: true });
  }
  /** consume_drug "vitamins": [[id, amount]] or [[id, min, max]]. */
  addVitaminsFrom(list: unknown): void {
    for (const entry of asArray(list as unknown[])) {
      if (!Array.isArray(entry)) continue;
      const [id, lo, hi] = entry as [string, number, number?];
      const n = hi !== undefined ? this.rng.int(lo, hi) : lo;
      if (n) this.vitaminMod(id, n);
    }
  }

  // ------------------------------------------------------------------ gain / loss
  /** set_mutation + mutation_effect: integrated armor, pushed-off gear, starts_active. */
  setMutation(id: string): void {
    if (this.has(id)) return;
    this.c.addTrait(id);
    this.gained.add(id);
    const d = this.idx.def(id);
    if (!d) return;
    if (d.starts_active) this.powered.add(id);
    const inv = this.c.inv;
    for (const armorId of d.integrated_armor ?? []) {
      if (inv.worn.some((w) => w.typeId === armorId)) continue;
      if (!this.c.data.items[armorId]) {
        console.warn(`Unknown integrated armor "${armorId}" on ${id}`);
        continue;
      }
      // integrated armor grows as part of the body: created worn, never anywhere else
      spawnItem(createItem(this.c.data, armorId), L.worn(this.c), { force: true, quiet: true });
    }
    // Clothing the new body part can't take: destroyed or pushed off (mutation_effect).
    for (const it of [...inv.worn]) {
      if (it.hasFlag('INTEGRATED') || it.hasFlag('OVERSIZE') || it.hasFlag('UNRESTRICTED')) continue;
      if (!this.conflictsWithItem(d, it)) continue;
      // Things fall to the ground (or, with no ground to fall on, stay with you).
      const away = this.c.inv.groundHere() ?? L.inv(this.c);
      if (d.destroys_gear) {
        this.msg(`Your ${it.name()} is destroyed!`, 'c_red');
        for (const x of [...it.allContents()]) {
          const from = x === it.magazine ? L.mag(it) : it.gunmods.includes(x) ? L.mod(it) : L.in(it);
          if (moveItem(x, from, away, { force: true, quiet: true }).ok) this.onDropItem?.(x);
        }
        consumeItem(it, L.worn(this.c));
      } else {
        this.msg(`Your ${it.name()} is pushed off!`, 'c_red');
        if (moveItem(it, L.worn(this.c), away, { force: true, quiet: true }).ok) this.onDropItem?.(it);
      }
    }
    this.onChanged?.();
  }

  /** unset_mutation + mutation_loss_effect */
  unsetMutation(id: string): void {
    if (!this.has(id)) return;
    this.c.removeTrait(id);
    this.powered.delete(id);
    this.gained.delete(id);
    const d = this.idx.def(id);
    for (const armorId of d?.integrated_armor ?? []) {
      const w = this.c.inv.worn.find((x) => x.typeId === armorId);
      if (w) consumeItem(w, L.worn(this.c));
    }
    this.onChanged?.();
  }

  /** mutation_branch::conflicts_with_item (restricts_gear, allowed_items, allow_soft_gear). */
  conflictsWithItem(d: MutData, it: Item): boolean {
    const soft = isSoft(this.c.data, it);
    if (d.allow_soft_gear && soft) return false;
    for (const f of d.allowed_items ?? []) if (it.hasFlag(f)) return false;
    for (const bp of d.restricts_gear ?? []) {
      if (itemCoversPart(this.idx, it, bp) && (!soft || !d.allow_soft_gear)) return true;
    }
    return false;
  }

  /** Reason the character can't wear `it` because of a mutation (Character::can_wear). */
  wearBlocker(it: Item): string | null {
    if (it.hasFlag('INTEGRATED') || it.hasFlag('OVERSIZE') || it.hasFlag('UNRESTRICTED')) return null;
    for (const id of this.c.traits) {
      const d = this.idx.def(id);
      if (d && this.conflictsWithItem(d, it)) return `Your ${this.name(id)} mutation prevents you from wearing your ${it.name()}.`;
    }
    return null;
  }

  name(id: string): string {
    return cddaText(this.idx.def(id)?.name) || this.c.traitName(id);
  }

  /** Character::remove_mutation: shrink back into a prerequisite or a canceled base trait. */
  removeMutation(id: string, silent = false): void {
    const d = this.idx.def(id);
    const shrinkTo = (list: string[] | undefined, skip?: string) => {
      for (const pre of list ?? []) if ((this.idx.def(pre)?.changes_to ?? []).includes(id) && pre !== skip) return pre;
      return undefined;
    };
    let replacing = shrinkTo(d?.prereqs);
    let replacing2 = shrinkTo(d?.prereqs2, replacing);
    // A base trait this mutation had canceled comes back when nothing else replaces it.
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
      const rd = this.idx.def(r);
      const rating = rd?.mixed_effect || d?.mixed_effect ? 'c_yellow' : (rd?.points ?? 0) > (d?.points ?? 0) ? 'c_light_green' : (rd?.points ?? 0) < (d?.points ?? 0) ? 'c_light_red' : 'c_white';
      const quiet = silent || (!this.idx.visible(id) && !this.idx.visible(r));
      if (!quiet) {
        if (this.idx.visible(id) && this.idx.visible(r)) this.msg(`Your ${lost} mutation turns into ${this.name(r)}!`, rating);
        else if (this.idx.visible(r)) this.msg(`You gain a mutation called ${this.name(r)}!`, rating);
        else this.msg(`You lose your ${lost} mutation.`, rating);
      }
      this.setMutation(r);
      replaced = true;
    }
    if (!replaced && !silent && this.idx.visible(id)) {
      const pts = d?.points ?? 0;
      this.msg(`You lose your ${lost} mutation.`, d?.mixed_effect ? 'c_yellow' : pts > 0 ? 'c_light_red' : pts < 0 ? 'c_light_green' : 'c_white');
    }
  }

  // ------------------------------------------------------------------ mutating
  /** A category's primer vitamin (null for ANY/MYCUS or when not using vitamins). */
  private categoryVitamin(cat: string, useVitamins: boolean): string | undefined {
    if (!useVitamins || cat === 'ANY') return undefined;
    const v = this.idx.categories.get(cat)?.vitamin;
    return v && v !== 'null' ? v : undefined;
  }

  /** get_vitamin_weighted_categories */
  private weightedCategories(): [string, number][] {
    return this.idx.categoryVitamins.map(([cat, v]) => [cat, this.vitamin(v)] as [string, number]).filter(([, w]) => w > 0);
  }

  /**
   * Character::mutate(true_random_chance, use_vitamins). Returns the trait gained or removed
   * (null when nothing happened) for tests and the debug API.
   */
  mutate(trueRandomChance = 0, useVitamins = true): boolean {
    let catList = this.weightedCategories();
    let good = false, bad = false;
    const neutral = true;
    let tryOpposite = true;
    let cat: string;
    const pick = () => {
      const c = this.rng.weighted(catList);
      catList = catList.filter(([id]) => id !== c);
      return c;
    };
    if (trueRandomChance > 0 && this.rng.oneIn(trueRandomChance)) {
      cat = 'ANY';
      good = bad = true;
      tryOpposite = false;
    } else if (catList.length) {
      cat = pick();
      if (this.rollBadMutation(cat)) bad = true;
      else good = true;
    } else {
      this.msg('Your body tries to mutate, but it lacks a primer to do so and only contorts for a moment.', 'c_light_red');
      return false;
    }
    if (this.has('CHAOTIC_BAD')) {
      good = false;
      bad = true;
      tryOpposite = false;
    }
    for (let guard = 0; guard < 64; guard++) {
      const vit = this.categoryVitamin(cat, useVitamins);
      const valid: string[] = [];
      const dummies: string[] = [];
      const upgrades: string[] = [];
      const pool = cat === 'ANY' ? [...this.idx.defs.keys()] : this.idx.byCategory.get(cat) ?? [];
      for (const id of pool) {
        const d = this.idx.def(id)!;
        if (d.valid !== false && !this.has(id) && !d.dummy) valid.push(id);
        if (d.dummy) dummies.push(id);
        if (this.has(id)) {
          for (const m of [...(d.changes_to ?? []), ...(d.leads_to ?? [])]) {
            if (this.idx.valid(m) && this.mutationOk(m, good, bad, neutral, vit) && (cat === 'ANY' || this.idx.inCategory(m, cat))) upgrades.push(m);
          }
        }
      }
      const filtered = valid.filter((id) => this.idx.valid(id) && this.mutationOk(id, good, bad, neutral, vit));
      // Prioritize upgrading existing mutations: (upgrades) chances in (upgrades + 4).
      if (this.rng.oneIn(2) && upgrades.length) {
        const roll = this.rng.int(0, upgrades.length + 4);
        if (roll < upgrades.length) return this.mutateTowards(upgrades[roll], cat, useVitamins);
      }
      // Dummy traits (purifier's HUMAN_*) only matter when something conflicts with them.
      if (dummies.length) {
        for (const id of shuffle(dummies, this.rng)) {
          if (this.conflictingTraits(id).length && this.mutateTowards(id, cat, useVitamins)) {
            this.categoryMessage(cat);
            return true;
          }
        }
      }
      if (!filtered.length) {
        if (tryOpposite && !catList.length) {
          tryOpposite = false;
          good = !good;
          bad = !bad;
          catList = this.weightedCategories();
        }
        if (catList.length) {
          cat = pick();
          continue;
        }
        this.msg('Your body tries to mutate, but it lacks a primer to do so and only contorts for a moment.', 'c_light_red');
        return false;
      }
      const catDef = this.idx.categories.get(cat);
      if (vit && this.vitamin(vit) >= (catDef?.threshold_min ?? 2200)) this.tryCrossingThreshold(cat);
      if (this.mutateTowardsList(filtered, cat, 2, useVitamins)) {
        this.categoryMessage(cat);
        return true;
      }
      return false;
    }
    return false;
  }

  private categoryMessage(cat: string): void {
    const m = this.idx.categories.get(cat)?.mutagen_message;
    if (m) this.msg(cddaText(m), 'c_yellow');
  }

  /** Character::mutate_category */
  mutateCategory(cat: string, useVitamins = true, trueRandom = false): boolean {
    if (cat === 'ANY') return this.mutate(0, useVitamins);
    let good = false, bad = false;
    if (trueRandom) good = bad = true;
    else if (this.rollBadMutation(cat)) bad = true;
    else good = true;
    const vit = this.categoryVitamin(cat, useVitamins);
    const valid = (this.idx.byCategory.get(cat) ?? []).filter((id) => this.mutationOk(id, good, bad, true, vit));
    return this.mutateTowardsList(valid, cat, 2, useVitamins);
  }

  mutateTowardsList(muts: string[], cat: string, tries: number, useVitamins: boolean, removedBase = false): boolean {
    const list = [...muts];
    while (list.length && tries > 0) {
      const i = this.rng.int(0, list.length - 1);
      if (this.mutateTowards(list[i], cat, useVitamins, removedBase)) return true;
      list.splice(i, 1);
      tries--;
    }
    return false;
  }

  /** Character::mutate_towards(trait, category, variant, use_vitamins, removed_base_trait) */
  mutateTowards(id: string, cat = 'ANY', useVitamins = false, removedBase = false): boolean {
    if (this.hasChildFlag(id)) {
      this.removeChildFlag(id);
      return true;
    }
    const d = this.idx.def(id);
    if (!d) {
      console.warn(`mutateTowards: unknown mutation "${id}"`);
      return false;
    }
    const catDef = this.idx.categories.get(cat);
    let prereqs1 = [...(d.prereqs ?? [])];
    let prereqs2 = [...(d.prereqs2 ?? [])];
    let cancel = [...(d.cancels ?? [])];
    const allPre = this.idx.allPrereqs(id);
    for (const t of this.idx.inTypes(d.types)) if (!allPre.includes(t) && t !== id) cancel.push(t);
    const cancelRecheck = [...cancel];
    const cancelTrait: string[] = [];
    cancel = cancel.filter((t) => {
      if (!this.has(t)) return false;
      if (!this.idx.purifiable(t)) {
        cancelTrait.push(t);
        return false;
      }
      if (this.isBase(t) && !this.rng.chance(catDef?.base_removal_chance ?? 100)) {
        cancelTrait.push(t);
        return false;
      }
      return true;
    });
    for (const t of cancel) {
      if (this.isBase(t)) {
        removedBase = true;
        this.base.delete(t);
        this.msg('Something integral to you has changed.  Good riddance.');
      }
      this.removeMutation(t);
    }
    // Pruned one level of a canceled tree: stop for now (the rest goes on later rolls).
    for (const t of cancelRecheck) if (this.has(t)) return true;
    for (const t of cancelTrait) if (!this.idx.purifiable(t)) return false;

    const has1 = prereqs1.some((p) => this.has(p));
    const has2 = prereqs2.some((p) => this.has(p));
    const need1 = prereqs1.length > 0, need2 = prereqs2.length > 0;
    if (cat !== 'ANY') {
      prereqs1 = prereqs1.filter((p) => this.idx.inCategory(p, cat));
      prereqs2 = prereqs2.filter((p) => this.idx.inCategory(p, cat));
    }
    if ((need1 && !has1 && !prereqs1.length) || (need2 && !has2 && !prereqs2.length)) return false;
    if (!(has1 && has2) && (prereqs1.length || prereqs2.length)) {
      if (!has1 && prereqs1.length) return this.mutateTowardsList(prereqs1, cat, 2, useVitamins, removedBase);
      if (!has2 && prereqs2.length) return this.mutateTowardsList(prereqs2, cat, 2, useVitamins, removedBase);
    }

    if (d.threshold) {
      this.msg('You feel something straining deep inside you, yearning to be free…');
      return false;
    }
    if (d.profession) return false;
    for (const b of this.bionicBlockers) {
      const r = b(id);
      if (r !== null) return r;
    }
    const threshreq = d.threshreq ?? [];
    let hasThresh = false;
    for (const t of threshreq) {
      if (this.has(t)) hasThresh = true;
      for (const sub of this.idx.def(t)?.threshold_substitutes ?? []) if (this.has(sub) && !d.strict_threshreq) hasThresh = true;
    }
    if (threshreq.length && !hasThresh) {
      this.msg('You feel something straining deep inside you, yearning to be free…');
      return false;
    }

    const vit = this.categoryVitamin(cat, useVitamins);
    if (vit) {
      let cost = this.idx.vitaminCost(id);
      if (removedBase) cost *= catDef?.base_removal_cost_mul ?? 3;
      if (this.vitamin(vit) < cost) return false;
      this.vitaminMod(vit, -cost);
    }

    // A prerequisite that changes_to this one is replaced by it.
    const replacedBy = (list: string[] | undefined) => (list ?? []).find((p) => this.has(p) && (this.idx.def(p)?.changes_to ?? []).includes(id));
    const replacing = replacedBy(d.prereqs);
    const replacing2 = replacedBy(d.prereqs2);
    const gained = this.name(id);
    let replaced = false;
    const rate = (from: MutData | undefined) =>
      d.mixed_effect || from?.mixed_effect ? 'c_yellow' : (from?.points ?? 0) < (d.points ?? 0) ? 'c_light_green' : (from?.points ?? 0) > (d.points ?? 0) ? 'c_light_red' : 'c_white';
    for (const r of [replacing, replacing2]) {
      if (!r || !this.has(r)) continue;
      const rd = this.idx.def(r);
      const newVis = this.idx.visible(id), oldVis = this.idx.visible(r);
      if (newVis && oldVis) this.msg(`Your ${this.name(r)} mutation turns into ${gained}!`, rate(rd));
      else if (newVis) this.msg(`You gain a mutation called ${gained}!`, rate(rd));
      else if (oldVis) this.msg(`You lose your ${this.name(r)} mutation.`, rate(rd));
      this.unsetMutation(r);
      replaced = true;
    }
    for (const t of cancelTrait) {
      const td = this.idx.def(t);
      this.msg(this.idx.visible(id) ? `Your innate ${this.name(t)} trait turns into ${gained}!` : `You lose your innate ${this.name(t)} trait!`, rate(td));
      this.base.delete(t);
      this.unsetMutation(t);
      replaced = true;
    }
    if (!replaced && this.idx.visible(id)) {
      const pts = d.points ?? 0;
      this.msg(`You gain a mutation called ${gained}!`, d.mixed_effect ? 'c_yellow' : pts > 0 ? 'c_light_green' : pts < 0 ? 'c_light_red' : 'c_white');
    }
    if (!d.dummy) this.setMutation(id);
    return true;
  }

  /**
   * Bionic conflicts (handle_bio_mut_conflict / canceled_mutations), set by the bionics
   * system: return true/false to decide the mutation outcome, or null when no conflict.
   */
  readonly bionicBlockers: ((mutation: string) => boolean | null)[] = [];

  /** Character::try_crossing_threshold / can_cross_threshold / cross_threshold */
  tryCrossingThreshold(cat: string): boolean {
    if (this.crossedThreshold() || cat === 'ANY') return false;
    const c = this.idx.categories.get(cat);
    const thresh = c?.threshold_mut;
    if (!c || !thresh || !c.vitamin) return false;
    const breach = this.categoryLevels().get(cat) ?? 0;
    const td = this.idx.def(thresh);
    if (breach < 30 || this.vitamin(c.vitamin) < this.idx.vitaminCost(thresh)) return false;
    if (!(breach >= 100 || this.rng.chance(breach))) return false;
    this.vitaminMod(c.vitamin, -this.idx.vitaminCost(thresh));
    this.msg("Something strains mightily for a moment… and then… you're… FREE!", 'c_light_green');
    for (const t of td?.cancels ?? []) this.unsetMutation(t);
    this.setMutation(thresh);
    if (c.memorial_message) this.onThreshold?.(cat, cddaText(c.memorial_message));
    return true;
  }
  /** Called when a threshold is crossed (memorial / stats hook). */
  onThreshold: ((cat: string, memorial: string) => void) | null = null;

  // ------------------------------------------------------------------ activation
  /** Mutations with an activation (CDDA `active`). */
  activatable(): string[] {
    return [...this.c.traits].filter((id) => this.idx.def(id)?.active);
  }
  isPowered(id: string): boolean {
    return this.powered.has(id);
  }
  /** Character::activate_mutation / deactivate_mutation (costs, transform, toggle). */
  toggle(id: string): string {
    const d = this.idx.def(id);
    if (!d?.active || !this.has(id)) return `You can't activate ${this.name(id)}.`;
    if (this.powered.has(id)) {
      this.powered.delete(id);
      if (d.transform) this.switchMutation(id, d.transform);
      return `You stop using your ${this.name(id)}.`;
    }
    const cost = d.cost ?? 0;
    if (d.hunger && this.c.storedKcal < this.c.healthyKcal() * 0.5) return `You're too hungry to use your ${this.name(id)}.`;
    if (d.thirst && this.c.thirst >= 260) return `You're too thirsty to use your ${this.name(id)}.`;
    if (d.sleepiness && this.c.sleepiness >= 575) return `You're too tired to use your ${this.name(id)}.`;
    this.payCost(d, cost);
    if (d.transform) {
      this.switchMutation(id, d.transform);
      return cddaText(d.transform.msg_transform) || `You activate your ${this.name(id)}.`;
    }
    // Only mutations with an ongoing cost stay on (CDDA: time > 0 or toggles like NV).
    this.powered.add(id);
    return `You activate your ${this.name(id)}.`;
  }
  private switchMutation(from: string, t: { target: string; active?: boolean }): void {
    this.unsetMutation(from);
    this.setMutation(t.target);
    if (t.active) this.powered.add(t.target);
  }
  private payCost(d: MutData, cost: number): void {
    if (!cost) return;
    if (d.hunger) this.c.storedKcal -= cost;
    if (d.thirst) this.c.thirst += cost;
    if (d.sleepiness) this.c.sleepiness += cost;
  }

  // ------------------------------------------------------------------ time
  private rollChangingCheck(): number {
    return this.time + this.rng.int(30 * 60, 45 * 60);
  }

  /** Advance vitamins, CHANGING EOCs and active mutation costs by gameDt game seconds. */
  update(gameDt: number): void {
    if (this.c.dead || gameDt <= 0) return;
    this.syncBase();
    this.acc += gameDt;
    const n = Math.floor(this.acc);
    if (n <= 0) return;
    this.acc -= n;
    const t0 = this.time;
    this.time += n;
    // Vitamin decay: ticks_between(from, to, rate) per vitamin.
    for (const v of this.idx.vitamins.values()) {
      if (!this.vitamins[v.id] || !v.rate || v.rate <= 0) continue;
      const ticks = Math.floor(this.time / v.rate) - Math.floor(t0 / v.rate);
      if (ticks > 0) this.vitaminMod(v.id, -Math.min(ticks, this.vitamins[v.id]));
    }
    // changing_initiate_check (recurrence 30–45 min)
    while (this.time >= this.nextChangingCheck) {
      this.nextChangingCheck += this.rng.int(30 * 60, 45 * 60);
      this.changingCheck();
    }
    // changing_mutate (recurrence 1–6 h, only while CHANGING)
    if (this.has('CHANGING')) {
      if (!this.nextChangingMutate || this.nextChangingMutate < t0) this.nextChangingMutate = this.time + this.rng.int(HOUR, 6 * HOUR);
      while (this.has('CHANGING') && this.time >= this.nextChangingMutate) {
        this.nextChangingMutate += this.rng.int(HOUR, 6 * HOUR);
        this.changingMutate();
      }
    } else this.nextChangingMutate = 0;
    // Active mutation upkeep every `time` turns.
    for (const id of this.powered) {
      const d = this.idx.def(id);
      if (!d?.cost || !d.time) continue;
      const ticks = Math.floor(this.time / d.time) - Math.floor(t0 / d.time);
      for (let i = 0; i < ticks; i++) this.payCost(d, d.cost);
    }
  }

  /** changing_initiate_check */
  changingCheck(): void {
    if (this.has('CHANGING') || this.vitamin('mutagen') < 450) return;
    const roll = this.rng.next() * (2500 + this.vitamin('mutagen'));
    if (roll < 2500) {
      if (this.rng.oneIn(4)) this.msg(this.snippet('<CHANGING_FAILED>') ?? 'You feel a shift in your body, but it quickly reverts.', 'c_light_red');
      return;
    }
    this.msg(this.snippet('<CHANGING_SUCCESS>') ?? 'Your body is slowly reshaping itself!', 'c_yellow');
    this.setMutation('CHANGING');
    this.mutate(0, true);
  }

  /** changing_mutate */
  changingMutate(): void {
    if (this.vitamin('mutagen') >= 300) {
      this.msg('You feel a deep, churning sensation fill your body.', 'c_yellow');
      this.mutate(0, true);
      this.vitaminMod('mutagen', -60);
      this.vitaminMod('mutagen', -this.rng.int(0, 80));
    } else if (this.rng.oneIn(3)) {
      this.msg(this.snippet('<CHANGING_ENDS>') ?? 'Your mutation abruptly ends from a lack of nutrients.', 'c_light_red');
      this.unsetMutation('CHANGING');
      this.vitamins.mutagen = 0;
      this.updateVitaminEffect('mutagen');
    }
  }

  private snippet(cat: string): string | null {
    const list = this.c.data.misc?.snippet?.[cat] as unknown[] | undefined;
    if (!list?.length) return null;
    const s = this.rng.pick(list);
    return typeof s === 'string' ? s : cddaText((s as { text?: string }).text) || null;
  }

  // ------------------------------------------------------------------ hardcoded effects
  /** Extra encumbrance on a part from encumbrance_always / encumbrance_covered. */
  encumbrance(bp: BodyPartId): number {
    let n = 0;
    for (const id of this.c.traits) {
      const d = this.idx.def(id);
      if (!d) continue;
      for (const [p, e] of d.encumbrance_always ?? []) if (this.idx.mainPart(p) === bp) n += e;
      if (d.encumbrance_covered?.length && this.c.inv.worn.some((w) => !w.hasFlag('INTEGRATED') && covers(w, bp)))
        for (const [p, e] of d.encumbrance_covered) if (this.idx.mainPart(p) === bp) n += e;
    }
    return n;
  }

  /** Flat armor from a mutation's `armor` entries (parts listed by id). */
  armor(bp: BodyPartId, dtype: string): number {
    let n = 0;
    for (const id of this.c.traits) {
      for (const a of this.idx.def(id)?.armor ?? []) {
        const parts = a.parts ?? [];
        if (!parts.includes(bp) && !parts.includes('ALL')) continue;
        const v = a[dtype];
        if (typeof v === 'number') n += v;
      }
    }
    return n;
  }

  /**
   * CDDA get_vision_threshold night vision range: NIGHTVISION +2, NIGHTVISION2 (and cat/elf
   * night eyes) +4.5, NIGHTVISION3 / full-dark eyes +10. Counted only while powered for
   * toggleable ones (they start active).
   */
  nightVisionRange(): number {
    const on = (id: string) => this.has(id) && (!this.idx.def(id)?.active || this.powered.has(id));
    if (on('NIGHTVISION3') || on('ELFA_FNV') || on('CEPH_VISION')) return 10;
    if (on('NIGHTVISION2') || on('FEL_NV') || on('URSINE_EYE') || on('ELFA_NV')) return 4.5;
    if (on('NIGHTVISION')) return 2;
    return 0;
  }

  /** Mutation ids to try as sprite overlays (visible ones; the atlas decides which have art). */
  overlays(): string[] {
    return [...this.c.traits].filter((id) => this.idx.visible(id) && !!this.idx.def(id));
  }

  /**
   * Enchantment `condition` evaluator for Character.enchantCondition: ALWAYS, ACTIVE (the
   * mutation is powered), and the simple dialogue conditions mutations use (u_has_trait,
   * u_has_weapon, is_day, not/and/or). Unknown conditions count as true (CDDA's common case).
   */
  conditionHolds(cond: unknown, traitId: string, isDay: () => boolean): boolean {
    if (cond === undefined || cond === 'ALWAYS') return true;
    if (cond === 'ACTIVE') return this.powered.has(traitId);
    if (cond === 'INACTIVE') return !this.powered.has(traitId);
    if (cond === 'is_day') return isDay();
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
      vitamins: { ...this.vitamins }, powered: [...this.powered], base: [...this.base],
      time: this.time, nextChangingCheck: this.nextChangingCheck, nextChangingMutate: this.nextChangingMutate,
    };
  }
  load(j: MutationStateJSON): void {
    this.vitamins = { ...j.vitamins };
    this.powered.clear();
    for (const p of j.powered) this.powered.add(p);
    this.base.clear();
    for (const b of j.base) this.base.add(b);
    this.gained = new Set([...this.c.traits].filter((t) => !this.base.has(t)));
    this.time = j.time;
    this.nextChangingCheck = j.nextChangingCheck;
    this.nextChangingMutate = j.nextChangingMutate;
    for (const id of Object.keys(this.vitamins)) this.updateVitaminEffect(id);
  }
}

/** Does `it` cover a CDDA body part or sub part (e.g. foot_sole_l, head_crown)? */
export function itemCoversPart(idx: MutationIndex, it: Item, part: string): boolean {
  const main = idx.mainPart(part);
  if (!main) return false;
  if (isBodyPart(part)) return covers(it, part);
  // Sub part: covered if a portion lists it specifically, or covers the parent without
  // narrowing (no specifically_covers).
  for (const p of it.def.armor ?? []) {
    if (!asArray(p.covers as string | string[] | undefined).includes(main)) continue;
    if (!p.specifically_covers?.length || p.specifically_covers.includes(part)) return true;
  }
  return false;
}

/** item::is_soft: SOFT flag, or every material is soft. */
export function isSoft(data: GameData, it: Item): boolean {
  if (it.hasFlag('SOFT')) return true;
  if (it.hasFlag('STIFF')) return false;
  // Modern armor lists materials per portion; the item-level list may be empty.
  const mats = [...materialIds(it.def), ...(it.def.armor ?? []).flatMap((p) => (p.material ?? []).map((m) => m.type))];
  if (!mats.length) return false;
  return mats.every((m) => data.misc?.material?.[m]?.soft === true);
}

function shuffle<T>(arr: T[], rng: { int(lo: number, hi: number): number }): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Mutagen-type consumables: their use_action lists vitamins (consume_drug). */
export function mutagenVitamins(it: Item): unknown[] | null {
  const ua = it.def.use_action as { type?: string; vitamins?: unknown[] } | undefined;
  const list = Array.isArray(ua) ? ua : ua ? [ua] : [];
  for (const u of list) if (u && typeof u === 'object' && (u as { vitamins?: unknown[] }).vitamins) return (u as { vitamins: unknown[] }).vitamins;
  return null;
}

/** Vitamins this module tracks (mutagen primers, catalyst, slurry, toxins, instability). */
export function isMutagenVitamin(id: string): boolean {
  return id.startsWith('mutagen') || id === 'mutant_toxin' || id === 'instability';
}

/** consume_drug "tools_needed": {id: -1} (syringe for injected mutagens). */
export function toolsNeeded(it: Item): string[] {
  const ua = it.def.use_action as { tools_needed?: Record<string, number> } | undefined;
  const list = Array.isArray(ua) ? ua : ua ? [ua] : [];
  const out: string[] = [];
  for (const u of list) if (u && typeof u === 'object' && (u as { tools_needed?: Record<string, number> }).tools_needed) out.push(...Object.keys((u as { tools_needed: Record<string, number> }).tools_needed));
  return out;
}
