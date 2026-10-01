// "Field notes": multiple-choice questions about Cataclysm generated from the game's own data,
// for the reading minigame (docs/ADAPTATION.md "Reading: field notes"). A book asks about what
// it teaches — the recipes it holds (what goes into them, which tool quality they need), its
// skill (which ammo a gun fires, which battery fits a flashlight, which bandage stops
// bleeding, which weapon cuts hardest) — so the answers are always right without anyone
// writing a question by hand, and a new player picks up real Cataclysm knowledge on the way.
//
// Correctness is by construction and re-checked in tests/readquiz.test.ts over every BN book:
//  * every question carries its rule (key → is this a right answer?); exactly one option passes;
//  * the player sees names, not ids, and BN reuses names ("battery", "rag" …), so an option is
//    only offered when *every* thing of that name agrees with the rule (`nameVerdict`);
//  * comparisons ("which goes bad first?") need a margin between the winner and the rest, wider
//    for beginner books, so a question never hinges on a rounding difference.
//
// Pure: GameData + book id + an Rng in, a Question out. No game state, no DOM.

import type { GameData, ItemDef, RecipeDef } from '../../data/types';
import type { Rng } from '../../core/rng';
import { asArray } from '../item';
import { bookRecipeIndex, recipeName } from '../crafting';
import { commonness } from '../reloadhelp';
import { itemDisplayName, qualityName } from '../requirements';
import { cddaText } from '../units';

/** What an option's key names: an item id, a material id, a vehicle fuel id… */
export type Domain = 'item' | 'material' | 'fuel' | 'technique' | 'style' | 'part' | 'recipe';

export type TemplateId =
  | 'recipe_uses'
  | 'recipe_quality'
  | 'book_makes'
  | 'recipe_hardest'
  | 'quality_item'
  | 'spoils_first'
  | 'never_spoils'
  | 'heal'
  | 'gun_ammo'
  | 'gun_magazine'
  | 'gun_skill'
  | 'battery_fits'
  | 'needs_power'
  | 'weapon_class'
  | 'damage_most'
  | 'ma_technique'
  | 'ma_style'
  | 'ma_weapon'
  | 'price_most'
  | 'encumbrance_most'
  | 'swim_gear'
  | 'throwing'
  | 'engine_fuel'
  | 'car_needs'
  | 'made_of'
  | 'material_of';

export interface Question {
  template: TemplateId;
  prompt: string;
  /** Display names, first letter up. */
  options: string[];
  /** Index of the right option. */
  answer: number;
  /** One line shown after answering: why that's right ("Pot: boiling 2"). */
  explain: string;
  domain: Domain;
  /** What each option stands for (ids in `domain`). */
  keys: string[];
  /** Is `key` a right answer to this question? (tests check exactly one option passes) */
  rule: (key: string) => boolean;
}

/** How hard a book's questions are: beginner books get 3 options, familiar items, wide margins. */
export interface Tier {
  options: 3 | 4;
  /** Comparison questions: the winner beats every other option by this factor. */
  margin: number;
  /** Only items that actually spawn (BN item groups), so a beginner has a chance of knowing them. */
  familiar: boolean;
}

export function tierFor(def: ItemDef): Tier {
  const lvl = Math.max(def.max_level ?? 0, def.required_level ?? 0);
  if (lvl <= 2) return { options: 3, margin: 2.5, familiar: true };
  if (lvl <= 5) return { options: 4, margin: 1.8, familiar: true };
  return { options: 4, margin: 1.35, familiar: false };
}

// ------------------------------------------------------------------ names and pools

interface Index {
  /** Items a question may show: real, spawnable-looking things (no pseudo tools, no "on" states). */
  items: string[];
  itemSet: Set<string>;
  byName: Map<string, string[]>;
  byCategory: Map<string, string[]>;
  common: Map<string, number>;
}
const indexCache = new WeakMap<GameData, Index>();

const HIDDEN_CATEGORIES = new Set(['bionics', 'artifacts', 'mutagen', 'maps', 'books']);

/**
 * What an option calls an item: BN's name minus " (off)" — the switched-off tool *is* the
 * flashlight you carry (its "(on)" twin is a separate, ineligible item).
 */
export function itemName(data: GameData, id: string): string {
  return itemDisplayName(data, id).replace(/ \(off\)$/, '');
}

const STATE_SUFFIX = /\((on|active|inactive|retracted|extended|deployed|folded|unfolded|open|closed|armed|unarmed|charged|empty|full)\)$/i;

function eligible(id: string, d: ItemDef): boolean {
  if (d.flags?.includes('PSEUDO') || d.flags?.includes('NO_SPAWN')) return false;
  // "flashlight (on)" and friends are states of another item, not things you find.
  if (typeof (d as { revert_to?: unknown }).revert_to === 'string') return false;
  if (HIDDEN_CATEGORIES.has(d.category as string)) return false;
  const n = cddaText(d.name);
  if (!n || /debug|fake|placeholder/i.test(n) || /debug|^fake_/i.test(id)) return false;
  // "radio (off)", "quarterstaff (retracted)": a state of a thing reads oddly as an answer.
  if (STATE_SUFFIX.test(n) || /^inactive /i.test(n)) return false;
  return true;
}

function index(data: GameData): Index {
  let ix = indexCache.get(data);
  if (ix) return ix;
  const byName = new Map<string, string[]>();
  const byCategory = new Map<string, string[]>();
  const items: string[] = [];
  // Every item's name, eligible or not: an ineligible item sharing a name still makes it ambiguous.
  for (const [id, d] of Object.entries(data.items)) {
    const n = itemName(data, id).toLowerCase();
    (byName.get(n) ?? byName.set(n, []).get(n)!).push(id);
    if (!eligible(id, d)) continue;
    items.push(id);
    const c = String(d.category ?? '');
    (byCategory.get(c) ?? byCategory.set(c, []).get(c)!).push(id);
  }
  ix = { items, itemSet: new Set(items), byName, byCategory, common: commonness(data) };
  indexCache.set(data, ix);
  return ix;
}

/** Display name of `key` in `domain` (what the option says). */
export function domainName(data: GameData, domain: Domain, key: string): string {
  switch (domain) {
    case 'item':
      return itemName(data, key);
    case 'material':
      return cddaText(data.misc.material?.[key]?.name) || key;
    case 'fuel':
      return fuelName(data, key);
    case 'technique':
      return cddaText(data.misc.technique?.[key]?.name) || key;
    case 'style':
      return cddaText(data.misc.martial_art?.[key]?.name) || key;
    case 'part':
      return cddaText(vehicleParts(data)[key]?.name) || key;
    case 'recipe': {
      const r = recipeById(data).get(key);
      return r ? recipeName(data, r) : key;
    }
  }
}

const recipeIdCache = new WeakMap<GameData, Map<string, RecipeDef>>();
function recipeById(data: GameData): Map<string, RecipeDef> {
  let m = recipeIdCache.get(data);
  if (!m) recipeIdCache.set(data, (m = new Map(data.recipes.filter((r) => r.type === 'recipe').map((r) => [r.id, r]))));
  return m;
}

/** domain → lower-case name → keys; built on first use (vehicles may arrive later: not cached empty). */
const nameCache = new WeakMap<GameData, Map<Domain, Map<string, string[]>>>();
function domainKeys(data: GameData, domain: Domain): string[] {
  switch (domain) {
    case 'item':
      return Object.keys(data.items);
    case 'material':
      return Object.keys(data.misc.material ?? {});
    case 'fuel':
      return Object.keys(fuels(data));
    case 'technique':
      return Object.keys(data.misc.technique ?? {});
    case 'style':
      return Object.keys(data.misc.martial_art ?? {});
    case 'part':
      return Object.keys(vehicleParts(data));
    case 'recipe':
      return [...recipeById(data).keys()];
  }
}

/** Every key in `domain` with this display name (case-insensitive): what a player could mean by it. */
export function keysNamed(data: GameData, domain: Domain, name: string): string[] {
  let per = nameCache.get(data);
  if (!per) nameCache.set(data, (per = new Map()));
  let m = per.get(domain);
  if (!m) {
    m = new Map();
    const keys = domainKeys(data, domain);
    for (const k of keys) {
      const n = domainName(data, domain, k).toLowerCase();
      (m.get(n) ?? m.set(n, []).get(n)!).push(k);
    }
    if (keys.length) per.set(domain, m);
  }
  return m.get(name.toLowerCase()) ?? [];
}

/**
 * Does every key sharing `key`'s name agree with the rule? 'yes' (all right), 'no' (all wrong),
 * 'mixed' (the name is ambiguous for this question: never offer it).
 */
export function nameVerdict(data: GameData, domain: Domain, key: string, rule: (k: string) => boolean): 'yes' | 'no' | 'mixed' {
  const same = keysNamed(data, domain, domainName(data, domain, key));
  const keys = same.length ? same : [key];
  const n = keys.filter(rule).length;
  return n === keys.length ? 'yes' : n === 0 ? 'no' : 'mixed';
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "a flashlight", "an electric soldering iron" (names starting "pair of …" read fine with "a"). */
const an = (s: string) => {
  // Acronyms are spelled out: "an RC car", "a UPS".
  const vowel = /^[A-Z]{2}/.test(s) ? /^[AEFHILMNORSX]/.test(s) : /^[aeiou]/i.test(s) && !/^(one|uni|use|eu)/i.test(s);
  return vowel ? `an ${s}` : `a ${s}`;
};

// ------------------------------------------------------------------ data helpers

type VehiclePart = { id: string; name: unknown; flags?: string[]; fuel_type?: string; item?: string };
type Fuel = { name: string; kjPerCharge?: number };
/**
 * vehicles.json is its own file, loaded when the game needs vehicles (vehicle_ui.ts); the
 * vehicle questions (engine fuel, what a car needs) wait until someone hands it over.
 */
const vehicleFiles = new WeakMap<GameData, { parts: Record<string, VehiclePart>; fuels: Record<string, Fuel> }>();
export function setQuizVehicles(data: GameData, v: { parts: Record<string, unknown>; fuels: Record<string, unknown> }): void {
  vehicleFiles.set(data, v as { parts: Record<string, VehiclePart>; fuels: Record<string, Fuel> });
}
function vehicleParts(data: GameData): Record<string, VehiclePart> {
  return vehicleFiles.get(data)?.parts ?? {};
}
function fuels(data: GameData): Record<string, Fuel> {
  return vehicleFiles.get(data)?.fuels ?? {};
}
function fuelName(data: GameData, id: string): string {
  return fuels(data)[id]?.name ?? itemName(data, id);
}

const qualityLevel = (d: ItemDef | undefined, q: string): number => {
  let best = 0;
  for (const [id, l] of (d?.qualities ?? []) as [string, number][]) if (id === q && l > best) best = l;
  return best;
};
const flags = (d: ItemDef | undefined): string[] => (d?.flags as string[] | undefined) ?? [];
const materials = (d: ItemDef | undefined): string[] => asArray(d?.material as string | string[] | undefined);
const spoils = (d: ItemDef | undefined): number => Number(d?.spoils_in ?? 0);
const meleeDamage = (d: ItemDef | undefined, t: string): number => Number((d?.melee_damage as Record<string, number> | undefined)?.[t] ?? 0);
type HealAction = { type?: string; bleed?: number; disinfectant_power?: number; bandages_power?: number };
function healAction(d: ItemDef | undefined): HealAction | null {
  for (const ua of asArray(d?.use_action as unknown)) if (ua && typeof ua === 'object' && (ua as HealAction).type === 'heal') return ua as HealAction;
  return null;
}
function encumbrance(d: ItemDef | undefined): number {
  let e = 0;
  for (const a of asArray((d as { armor?: unknown })?.armor as { encumbrance?: number }[] | undefined)) e = Math.max(e, Number(a?.encumbrance ?? 0));
  return e;
}
const ammoTypesOf = (d: ItemDef | undefined): string[] => asArray(d?.ammo_type as string | string[] | undefined);
const magazinesOf = (d: ItemDef | undefined): Record<string, string[]> => (d?.magazines as Record<string, string[]> | undefined) ?? {};

/** All recipes (not uncrafts) that share this recipe's display name: a player can't tell them apart. */
function sameNameRecipes(data: GameData, r: RecipeDef): RecipeDef[] {
  const n = recipeName(data, r);
  return recipesByName(data).get(n) ?? [r];
}
const recipeNameCache = new WeakMap<GameData, Map<string, RecipeDef[]>>();
function recipesByName(data: GameData): Map<string, RecipeDef[]> {
  let m = recipeNameCache.get(data);
  if (m) return m;
  m = new Map();
  for (const r of data.recipes) {
    if (r.type !== 'recipe') continue;
    const n = recipeName(data, r);
    (m.get(n) ?? m.set(n, []).get(n)!).push(r);
  }
  recipeNameCache.set(data, m);
  return m;
}

// ------------------------------------------------------------------ building a question

interface Ctx {
  data: GameData;
  book: ItemDef;
  bookId: string;
  skill: string | undefined;
  tier: Tier;
  rng: Rng;
  recipes: RecipeDef[];
}

/** Weighted pick favouring common things (sqrt of spawn weight), so beginners see familiar items. */
function pickItem(ctx: Ctx, ids: readonly string[]): string | null {
  if (!ids.length) return null;
  const ix = index(ctx.data);
  const w = ids.map((id) => [id, Math.sqrt(ix.common.get(id) ?? 0) + 0.05] as const);
  return ctx.rng.weighted(w);
}

function familiarOk(ctx: Ctx, id: string): boolean {
  return !ctx.tier.familiar || (index(ctx.data).common.get(id) ?? 0) > 0;
}

function shuffle<T>(rng: Rng, a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Assemble a question from a right key and candidate wrong keys, enforcing the invariants:
 * distinct names, the right one unambiguously right, every distractor unambiguously wrong.
 */
function assemble(
  ctx: Ctx,
  template: TemplateId,
  domain: Domain,
  prompt: string,
  right: string,
  candidates: readonly string[],
  rule: (k: string) => boolean,
  explain: string,
): Question | null {
  const { data, rng } = ctx;
  if (!rule(right) || nameVerdict(data, domain, right, rule) !== 'yes') return null;
  const want = ctx.tier.options - 1;
  const names = new Set([domainName(data, domain, right).toLowerCase()]);
  const wrong: string[] = [];
  // Sample rather than scan: pools are thousands long and most candidates pass.
  const pool = candidates.slice();
  for (let tries = 0; wrong.length < want && pool.length && tries < 400; tries++) {
    const i = rng.int(0, pool.length - 1);
    const k = pool[i];
    pool[i] = pool[pool.length - 1];
    pool.pop();
    const n = domainName(data, domain, k).toLowerCase();
    if (!n || names.has(n) || n.length > 40) continue;
    if (rule(k) || nameVerdict(data, domain, k, rule) !== 'no') continue;
    names.add(n);
    wrong.push(k);
  }
  if (wrong.length < want) return null;
  const keys = shuffle(rng, [right, ...wrong]);
  return {
    template,
    prompt,
    options: keys.map((k) => cap(domainName(data, domain, k))),
    answer: keys.indexOf(right),
    explain,
    domain,
    keys,
    rule,
  };
}

/** Items of these categories (eligible, familiar if the tier asks). */
function itemsIn(ctx: Ctx, cats: readonly string[], extra?: (id: string, d: ItemDef) => boolean): string[] {
  const ix = index(ctx.data);
  const out: string[] = [];
  for (const c of cats) for (const id of ix.byCategory.get(c) ?? []) if (familiarOk(ctx, id) && (!extra || extra(id, ctx.data.items[id]))) out.push(id);
  return out;
}

/** Where a "which tool…" answer comes from: tools first (a broadsword *can* cut vegetables, but…). */
function toolAnswer(ctx: Ctx, rule: (id: string) => boolean): string | null {
  return pickItem(ctx, itemsIn(ctx, TOOL_CATS.filter((c) => c !== 'weapons'), (id) => rule(id))) ?? pickItem(ctx, itemsIn(ctx, ['weapons'], (id) => rule(id)));
}

const TOOL_CATS = ['tools', 'tools_cooking', 'tools_workshop', 'tools_farming', 'tools_chemistry', 'tools_entry', 'weapons', 'electronics'];

/** "Which of these is better at X?" over numeric `value`: a clear winner by the tier's margin. */
function compareMost(
  ctx: Ctx,
  template: TemplateId,
  pool: string[],
  value: (id: string) => number,
  prompt: string,
  explain: (id: string, v: number) => string,
  least = false,
): Question | null {
  const { rng, tier } = ctx;
  const sign = least ? -1 : 1;
  const cands = pool.filter((id) => value(id) > 0);
  if (cands.length < tier.options) return null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const picked: string[] = [];
    const seen = new Set<string>();
    for (let t = 0; picked.length < tier.options && t < 60; t++) {
      const id = pickItem(ctx, cands)!;
      const n = itemName(ctx.data, id).toLowerCase();
      if (seen.has(n)) continue;
      seen.add(n);
      picked.push(id);
    }
    if (picked.length < tier.options) return null;
    picked.sort((a, b) => sign * (value(b) - value(a)));
    const best = value(picked[0]);
    const second = value(picked[1]);
    const ok = least ? second >= best * tier.margin : best >= second * tier.margin;
    if (!ok) continue;
    // Right = beyond the geometric middle between the winner and the runner-up.
    const thr = Math.sqrt(best * second);
    const rule = (k: string) => {
      const v = value(k);
      return v > 0 && (least ? v < thr : v > thr);
    };
    const q = assemble(ctx, template, 'item', prompt, picked[0], picked.slice(1), rule, explain(picked[0], best));
    if (q) return q;
  }
  return null;
}

// ------------------------------------------------------------------ templates

type Template = (ctx: Ctx) => Question | null;

/** Everything a recipe (and its same-named variants) can use: components, tools, qualities. */
function recipeUseRule(data: GameData, r: RecipeDef): (id: string) => boolean {
  const group = sameNameRecipes(data, r);
  const ids = new Set<string>();
  const quals: [string, number][] = [];
  for (const g of group) {
    for (const alt of [...(g.components ?? []), ...(g.tools ?? [])]) for (const c of alt) ids.add(c.id);
    for (const alt of g.qualities ?? []) for (const q of alt) quals.push([q.id, q.level]);
  }
  return (id: string) => {
    if (ids.has(id)) return true;
    const d = data.items[id];
    // BN cooks_like: an item standing in for another as a recipe ingredient.
    const like = (d as { cooks_like?: string } | undefined)?.cooks_like;
    if (like && ids.has(like)) return true;
    return quals.some(([q, l]) => qualityLevel(d, q) >= l);
  };
}

const recipeUses: Template = (ctx) => {
  const { data, rng } = ctx;
  if (!ctx.recipes.length) return null;
  const r = rng.pick(ctx.recipes);
  const rule = recipeUseRule(data, r);
  const comps = (r.components ?? []).flat().map((c) => c.id);
  const tools = (r.tools ?? []).flat().map((c) => c.id);
  const ix = index(data);
  const usable = (id: string) => ix.itemSet.has(id) && familiarOk(ctx, id) && id !== r.result;
  const fromComps = comps.filter(usable);
  const fromTools = tools.filter(usable);
  const isComp = fromComps.length > 0 && (fromTools.length === 0 || rng.next() < 0.7);
  const right = pickItem(ctx, isComp ? fromComps : fromTools);
  if (!right) return null;
  const cat = String(data.items[right].category ?? '');
  const pool = itemsIn(ctx, [cat]);
  const name = recipeName(data, r);
  const rightName = itemName(data, right);
  return assemble(ctx, 'recipe_uses', 'item', `Which of these goes into making ${name}?`, right, pool, rule,
    isComp ? `${cap(name)} is made with ${rightName}.` : `You need ${rightName} as a tool for ${name}.`);
};

const recipeQuality: Template = (ctx) => {
  const { data, rng } = ctx;
  const withQ = ctx.recipes.filter((r) => (r.qualities ?? []).some((g) => g.length));
  if (!withQ.length) return null;
  const r = rng.pick(withQ);
  const q = rng.pick(rng.pick((r.qualities ?? []).filter((g) => g.length)));
  const qn = qualityName(data, q.id);
  const rule = (id: string) => qualityLevel(data.items[id], q.id) >= q.level;
  const right = toolAnswer(ctx, rule);
  if (!right) return null;
  const pool = itemsIn(ctx, TOOL_CATS, (_id, d) => qualityLevel(d, q.id) === 0);
  const name = recipeName(data, r);
  return assemble(ctx, 'recipe_quality', 'item', `Making ${name} takes a tool for ${qn}. Which of these will do?`, right, pool, rule,
    `${cap(itemName(data, right))}: ${qn} ${qualityLevel(data.items[right], q.id)} (needs ${q.level}).`);
};

const bookMakes: Template = (ctx) => {
  const { data, rng } = ctx;
  if (ctx.recipes.length < 1) return null;
  const taughtResults = new Set(ctx.recipes.map((r) => r.result));
  const taughtNames = new Set(ctx.recipes.map((r) => recipeName(data, r).toLowerCase()));
  const rule = (id: string) => taughtResults.has(id) || taughtNames.has(itemName(data, id).toLowerCase());
  const r = rng.pick(ctx.recipes);
  const right = r.result;
  if (!index(data).itemSet.has(right)) return null;
  const pool = itemsIn(ctx, [String(data.items[right]?.category ?? '')]);
  const title = cddaText(ctx.book.name);
  return assemble(ctx, 'book_makes', 'item', `Which of these does ${title} show you how to make?`, right, pool, rule,
    `${title} teaches ${recipeName(data, r)}${r.difficulty ? ` (${r.skill_used ?? 'skill'} ${r.difficulty})` : ''}.`);
};

const recipeHardest: Template = (ctx) => {
  const { data, rng, tier } = ctx;
  // Per name: the easiest and hardest variant, so "hardest" holds whichever one you think of.
  const span = new Map<string, { lo: number; hi: number; id: string }>();
  for (const r of ctx.recipes) {
    const n = recipeName(data, r);
    if (span.has(n)) continue;
    const all = sameNameRecipes(data, r);
    span.set(n, { lo: Math.min(...all.map((x) => x.difficulty)), hi: Math.max(...all.map((x) => x.difficulty)), id: r.id });
  }
  const list = [...span.values()];
  if (list.length < tier.options) return null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const picked = shuffle(rng, list.slice()).slice(0, tier.options).sort((a, b) => b.lo - a.lo);
    const best = picked[0];
    const restMax = Math.max(...picked.slice(1).map((p) => p.hi));
    if (best.lo < restMax + 2) continue;
    const thr = restMax + 1;
    const rule = (id: string) => {
      const r = recipeById(data).get(id);
      return !!r && Math.min(...sameNameRecipes(data, r).map((x) => x.difficulty)) >= thr;
    };
    const q = assemble(ctx, 'recipe_hardest', 'recipe', 'Which of these takes the most skill to make?', best.id, picked.slice(1).map((p) => p.id), rule,
      `${cap(domainName(data, 'recipe', best.id))} needs skill ${best.lo}.`);
    if (q) return q;
  }
  return null;
};

/** Qualities worth asking about for a skill when its books don't say (no recipes). */
const SKILL_QUALITIES: Record<string, string[]> = {
  cooking: ['COOK', 'BOIL', 'CUT', 'BUTCHER'],
  survival: ['CUT', 'AXE', 'DIG', 'BUTCHER', 'BOIL'],
  traps: ['DIG', 'CUT', 'HAMMER'],
  fabrication: ['HAMMER', 'SAW_W', 'SAW_M', 'CHISEL', 'DRILL', 'CUT'],
  tailor: ['SEW', 'CUT', 'LEATHER_AWL'],
  mechanics: ['WRENCH', 'SCREW', 'JACK', 'SAW_M', 'HAMMER', 'PRY'],
  driving: ['JACK', 'WRENCH', 'SCREW'],
  electronics: ['SCREW_FINE', 'SCREW', 'CUT'],
  computer: ['SCREW_FINE', 'SCREW'],
  firstaid: ['CUT_FINE', 'CUT'],
};

const qualityItem: Template = (ctx) => {
  const { data, rng } = ctx;
  const counts = new Map<string, number>();
  for (const r of ctx.recipes) for (const g of r.qualities ?? []) for (const q of g) counts.set(q.id, (counts.get(q.id) ?? 0) + 1);
  for (const q of SKILL_QUALITIES[ctx.skill ?? ''] ?? []) counts.set(q, (counts.get(q) ?? 0) + 2);
  const qs = [...counts].filter(([q]) => data.misc.tool_quality?.[q]);
  if (!qs.length) return null;
  const q = rng.weighted(qs);
  const qn = qualityName(data, q);
  const rule = (id: string) => qualityLevel(data.items[id], q) >= 1;
  const right = toolAnswer(ctx, rule);
  if (!right) return null;
  const pool = itemsIn(ctx, TOOL_CATS, (_id, d) => qualityLevel(d, q) === 0);
  return assemble(ctx, 'quality_item', 'item', `Which of these is a tool for ${qn}?`, right, pool, rule,
    `${cap(itemName(data, right))}: ${qn} ${qualityLevel(data.items[right], q)}.`);
};

const FOOD_CATS = ['food', 'cooking_ingredients'];
const days = (s: number) => (s >= 86400 ? `${Math.round((s / 86400) * 10) / 10} days` : `${Math.round(s / 3600)} hours`);

const spoilsFirst: Template = (ctx) =>
  compareMost(ctx, 'spoils_first', itemsIn(ctx, FOOD_CATS), (id) => spoils(ctx.data.items[id]), 'Which of these goes bad first?',
    (id, v) => `${cap(itemName(ctx.data, id))} spoils in about ${days(v)}.`, true);

const neverSpoils: Template = (ctx) => {
  const { data } = ctx;
  const comestible = (d: ItemDef) => d.type === 'COMESTIBLE' && Number(d.calories ?? 0) > 0;
  const rule = (id: string) => {
    const d = data.items[id];
    return !!d && comestible(d) && spoils(d) === 0;
  };
  const right = pickItem(ctx, itemsIn(ctx, FOOD_CATS, (id) => rule(id)));
  if (!right) return null;
  const pool = itemsIn(ctx, FOOD_CATS, (_id, d) => comestible(d) && spoils(d) > 0);
  return assemble(ctx, 'never_spoils', 'item', 'Which of these keeps without spoiling?', right, pool, rule,
    `${cap(itemName(data, right))} never goes bad; the others rot.`);
};

const HEALS: { key: 'bleed' | 'disinfectant_power' | 'bandages_power'; prompt: string; says: string }[] = [
  { key: 'bleed', prompt: 'Which of these stops bleeding?', says: 'stops bleeding' },
  { key: 'disinfectant_power', prompt: 'Which of these disinfects a wound?', says: 'disinfects wounds' },
  { key: 'bandages_power', prompt: 'Which of these bandages a wound so it heals faster?', says: 'is a bandage' },
];
const heal: Template = (ctx) => {
  const { data, rng } = ctx;
  const h = rng.pick(HEALS);
  const rule = (id: string) => Number(healAction(data.items[id])?.[h.key] ?? 0) > 0;
  const right = pickItem(ctx, itemsIn(ctx, ['drugs', 'scrap_fabric'], (id) => rule(id)));
  if (!right) return null;
  const pool = itemsIn(ctx, ['drugs'], (id) => !rule(id));
  return assemble(ctx, 'heal', 'item', h.prompt, right, pool, rule, `${cap(itemName(data, right))} ${h.says}.`);
};

const GUN_SKILLS = new Set(['gun', 'pistol', 'rifle', 'shotgun', 'smg', 'launcher', 'archery']);
function gunsFor(ctx: Ctx): string[] {
  const s = ctx.skill;
  return itemsIn(ctx, ['guns', 'weapons'], (_id, d) => d.type === 'GUN' && asArray(d.ammo as string | string[] | undefined).length > 0 && (s === 'gun' || !s || d.skill === s));
}

const gunAmmo: Template = (ctx) => {
  const { data } = ctx;
  const gun = pickItem(ctx, gunsFor(ctx));
  if (!gun) return null;
  const takes = new Set(asArray(data.items[gun].ammo as string | string[] | undefined));
  const rule = (id: string) => data.items[id]?.type === 'AMMO' && ammoTypesOf(data.items[id]).some((t) => takes.has(t));
  const right = pickItem(ctx, itemsIn(ctx, ['ammo'], (id) => rule(id)));
  if (!right) return null;
  const pool = itemsIn(ctx, ['ammo'], (id, d) => d.type === 'AMMO' && !rule(id));
  const gn = itemName(data, gun);
  const types = [...takes].map((t) => cddaText(data.misc.ammunition_type?.[t]?.name) || t).join(' or ');
  return assemble(ctx, 'gun_ammo', 'item', `What does the ${gn} fire?`, right, pool, rule, `The ${gn} takes ${types}.`);
};

const gunMagazine: Template = (ctx) => {
  const { data } = ctx;
  const gun = pickItem(ctx, gunsFor(ctx).filter((id) => Object.values(magazinesOf(data.items[id])).flat().length > 0));
  if (!gun) return null;
  const fits = new Set(Object.values(magazinesOf(data.items[gun])).flat());
  const rule = (id: string) => fits.has(id);
  const right = pickItem(ctx, [...fits].filter((id) => index(data).itemSet.has(id) && familiarOk(ctx, id)));
  if (!right) return null;
  const pool = itemsIn(ctx, ['magazines'], (id, d) => !fits.has(id) && !ammoTypesOf(d).includes('battery'));
  const gn = itemName(data, gun);
  return assemble(ctx, 'gun_magazine', 'item', `Which magazine fits the ${gn}?`, right, pool, rule, `The ${gn} loads ${itemName(data, right)}.`);
};

const gunSkill: Template = (ctx) => {
  const { data } = ctx;
  const s = ctx.skill;
  if (!s || s === 'gun' || !GUN_SKILLS.has(s)) return null;
  const sn = cddaText(data.misc.skill?.[s]?.name) || s;
  const rule = (id: string) => data.items[id]?.type === 'GUN' && data.items[id].skill === s;
  const right = pickItem(ctx, itemsIn(ctx, ['guns', 'weapons'], (id) => rule(id)));
  if (!right) return null;
  const pool = itemsIn(ctx, ['guns', 'weapons'], (_id, d) => d.type === 'GUN' && !!d.skill && d.skill !== s);
  return assemble(ctx, 'gun_skill', 'item', `Which of these do you shoot with the ${sn} skill?`, right, pool, rule,
    `${cap(itemName(data, right))} is a ${sn.toLowerCase()} weapon.`);
};

const batteryFits: Template = (ctx) => {
  const { data } = ctx;
  // The same fields reloadhelp.ts reads: the tool's magazine well for "battery".
  const tools = itemsIn(ctx, ['tools', 'electronics', 'tools_workshop', 'tools_cooking'], (_id, d) => (magazinesOf(d).battery ?? []).length > 0);
  const tool = pickItem(ctx, tools);
  if (!tool) return null;
  const fits = new Set(magazinesOf(data.items[tool]).battery);
  const rule = (id: string) => fits.has(id);
  const right = pickItem(ctx, [...fits].filter((id) => index(data).itemSet.has(id)));
  if (!right) return null;
  const pool = index(data).items.filter((id) => data.items[id].type === 'MAGAZINE' && ammoTypesOf(data.items[id]).includes('battery') && !fits.has(id));
  const tn = itemName(data, tool);
  return assemble(ctx, 'battery_fits', 'item', `Which battery fits ${an(tn)}?`, right, pool, rule, `${cap(an(tn))} takes ${[...fits].map((f) => itemName(data, f)).slice(0, 3).join(' or ')}.`);
};

const needsPower: Template = (ctx) => {
  const { data } = ctx;
  const powered = (d: ItemDef | undefined) => !!d && (asArray(d.ammo as string | string[] | undefined).includes('battery') || (magazinesOf(d).battery ?? []).length > 0 || flags(d).includes('USE_UPS'));
  const rule = (id: string) => powered(data.items[id]);
  // The answer takes batteries itself (not a UPS-powered suit: true, but not what the question means).
  const right = pickItem(ctx, itemsIn(ctx, ['electronics', 'tools'], (id, d) => rule(id) && !flags(d).includes('USE_UPS')));
  if (!right) return null;
  const pool = itemsIn(ctx, ['electronics', 'tools', 'tools_workshop'], (_id, d) => d.type === 'TOOL' && !powered(d) && !asArray(d.ammo as string | string[] | undefined).length);
  return assemble(ctx, 'needs_power', 'item', 'Which of these runs on batteries?', right, pool, rule, `${cap(itemName(data, right))} needs battery charge.`);
};

const WEAPON_CLASSES: Record<string, string[]> = {
  bashing: ['CLUBS', 'BATONS', 'MACES', '1H_HAMMERS', '2H_HAMMERS', 'MORNINGSTARS', 'FLAILS', 'QUARTERSTAVES', 'TONFAS'],
  cutting: ['KNIVES', '1H_SWORDS', '2H_SWORDS', 'SHORT_SWORDS', 'MEDIEVAL_SWORDS', 'JAPANESE_SWORDS', '1H_AXES', '2H_AXES', 'HAND_AXES'],
  stabbing: ['SPEARS', 'PIKES', 'GLAIVES', 'KNIVES'],
  melee: ['CLUBS', 'SPEARS', 'KNIVES', '1H_SWORDS', '2H_AXES', 'GLAIVES', 'QUARTERSTAVES', 'HOOKED_POLES', 'MACES'],
  unarmed: ['FIST_WEAPONS'],
  pistol: ['PISTOLS', 'REVOLVERS'],
  rifle: ['RIFLES'],
  shotgun: ['SHOTGUNS'],
  smg: ['SUBMACHINE_GUNS'],
  archery: ['BOWS'],
  launcher: ['GRENADE_LAUNCHERS', 'ROCKET_LAUNCHERS'],
  gun: ['PISTOLS', 'RIFLES', 'SHOTGUNS', 'SUBMACHINE_GUNS', 'REVOLVERS'],
};

const weaponClass: Template = (ctx) => {
  const { data, rng } = ctx;
  const classes = (WEAPON_CLASSES[ctx.skill ?? ''] ?? []).filter((c) => data.misc.weapon_category?.[c]);
  if (!classes.length) return null;
  const c = rng.pick(classes);
  const cn = cddaText(data.misc.weapon_category[c].name);
  const has = (d: ItemDef | undefined) => asArray(d?.weapon_category as string | string[] | undefined).includes(c);
  const rule = (id: string) => has(data.items[id]);
  const right = pickItem(ctx, itemsIn(ctx, ['weapons', 'guns', 'tools'], (id) => rule(id)));
  if (!right) return null;
  const isGun = data.items[right].type === 'GUN';
  const pool = itemsIn(ctx, ['weapons', 'guns'], (_id, d) => !has(d) && asArray(d.weapon_category as string | string[] | undefined).length > 0 && (d.type === 'GUN') === isGun);
  return assemble(ctx, 'weapon_class', 'item', `Which of these is one of the ${cn}?`, right, pool, rule, `${cap(itemName(data, right))} counts as ${cn.toLowerCase()} (techniques for that class work with it).`);
};

const DAMAGE: Record<string, string[]> = { bashing: ['bash'], cutting: ['cut'], stabbing: ['stab'], melee: ['bash', 'cut', 'stab'], unarmed: ['bash'], throw: ['bash', 'stab'] };
const DAMAGE_WORD: Record<string, string> = { bash: 'bashing', cut: 'cutting', stab: 'piercing' };
const damageMost: Template = (ctx) => {
  const kinds = DAMAGE[ctx.skill ?? ''];
  if (!kinds) return null;
  const t = ctx.rng.pick(kinds);
  const pool = itemsIn(ctx, ['weapons', 'tools'], (_id, d) => d.type !== 'GUN');
  return compareMost(ctx, 'damage_most', pool, (id) => meleeDamage(ctx.data.items[id], t), `Which of these does the most ${DAMAGE_WORD[t]} damage in melee?`,
    (id, v) => `${cap(itemName(ctx.data, id))}: ${v} ${DAMAGE_WORD[t]}.`);
};

type Style = { id: string; name: unknown; techniques?: string[] };
/** Martial arts with techniques, minus the debug style. */
function realStyles(data: GameData): Style[] {
  return Object.values((data.misc.martial_art ?? {}) as Record<string, Style>).filter((s) => !/debug/i.test(s.id + cddaText(s.name)) && (s.techniques ?? []).some((t) => data.misc.technique?.[t]));
}
const maTechnique: Template = (ctx) => {
  const { data, rng } = ctx;
  const styles = realStyles(data);
  const own = ctx.book.martial_art as string | undefined;
  const style = own ? styles.find((s) => s.id === own) : rng.pick(styles);
  if (!style) return null;
  const tname = (t: string) => domainName(data, 'technique', t).toLowerCase();
  const mine = new Set((style.techniques ?? []).filter((t) => data.misc.technique?.[t]).map(tname));
  const rule = (k: string) => mine.has(tname(k));
  const right = rng.pick((style.techniques ?? []).filter((t) => data.misc.technique?.[t]));
  const pool = styles.flatMap((s) => (s === style ? [] : (s.techniques ?? []).filter((t) => data.misc.technique?.[t])));
  const sn = cddaText(style.name);
  return assemble(ctx, 'ma_technique', 'technique', `Which of these is a ${sn} technique?`, right, pool, rule, `${cap(domainName(data, 'technique', right))} is taught by ${sn}.`);
};

const maStyle: Template = (ctx) => {
  const { data, rng } = ctx;
  const own = ctx.book.martial_art as string | undefined;
  const styles = realStyles(data);
  const style = own ? styles.find((s) => s.id === own) : rng.pick(styles);
  if (!style) return null;
  const tech = rng.pick((style.techniques ?? []).filter((t) => data.misc.technique?.[t]));
  const tn = domainName(data, 'technique', tech).toLowerCase();
  // Right: any style teaching a technique of that name (several share "Disarm", "Feint"…).
  const rule = (k: string) => (((data.misc.martial_art?.[k] as Style | undefined)?.techniques ?? []).some((t) => data.misc.technique?.[t] && domainName(data, 'technique', t).toLowerCase() === tn));
  return assemble(ctx, 'ma_style', 'style', `Which martial art teaches ${cap(tn)}?`, style.id, styles.map((s) => s.id), rule, `${cap(tn)} is a ${cddaText(style.name)} technique.`);
};

const maWeapon: Template = (ctx) => {
  const { data, rng } = ctx;
  const own = ctx.book.martial_art as string | undefined;
  const styles = Object.values((data.misc.martial_art ?? {}) as Record<string, Style & { weapon_category?: string[] }>).filter((s) => (s.weapon_category ?? []).length);
  const style = own ? styles.find((s) => s.id === own) : rng.pick(styles);
  if (!style) return null;
  const cats = new Set(style.weapon_category);
  const rule = (id: string) => asArray(data.items[id]?.weapon_category as string | string[] | undefined).some((c) => cats.has(c));
  const right = pickItem(ctx, itemsIn(ctx, ['weapons', 'tools'], (id) => rule(id)));
  if (!right) return null;
  const pool = itemsIn(ctx, ['weapons'], (id, d) => !rule(id) && asArray(d.weapon_category as string | string[] | undefined).length > 0 && d.type !== 'GUN');
  const sn = cddaText(style.name);
  return assemble(ctx, 'ma_weapon', 'item', `Which of these weapons can you fight with in ${sn}?`, right, pool, rule,
    `${sn} works with ${[...cats].map((c) => cddaText(data.misc.weapon_category?.[c]?.name).toLowerCase()).join(' and ')}.`);
};

const priceMost: Template = (ctx) =>
  compareMost(ctx, 'price_most', itemsIn(ctx, ['valuables', 'tools', 'electronics', 'drugs', 'ammo', 'food', 'clothing']), (id) => Number(ctx.data.items[id].price_postapoc ?? 0),
    'Which of these would a trader value most these days?', (id, v) => `${cap(itemName(ctx.data, id))} trades for about $${Math.round(v / 100)}.`);

const encumbranceMost: Template = (ctx) =>
  compareMost(ctx, 'encumbrance_most', itemsIn(ctx, ['clothing']), (id) => encumbrance(ctx.data.items[id]), 'Which of these hampers your movement most when worn?',
    (id, v) => `${cap(itemName(ctx.data, id))}: encumbrance ${v}.`);

const SWIM: { flag: string; prompt: string; says: string }[] = [
  { flag: 'FIN', prompt: 'Which of these makes you swim faster?', says: 'speeds up swimming' },
  { flag: 'SWIM_GOGGLES', prompt: 'Which of these lets you see clearly underwater?', says: 'are swimming goggles' },
  { flag: 'FLOTATION', prompt: 'Which of these keeps you afloat?', says: 'keeps you afloat' },
  { flag: 'WATERPROOF', prompt: 'Which of these keeps you dry in deep water?', says: 'is waterproof' },
];
const swimGear: Template = (ctx) => {
  const { data, rng } = ctx;
  const s = rng.pick(SWIM);
  const rule = (id: string) => flags(data.items[id]).includes(s.flag);
  const right = pickItem(ctx, index(data).items.filter((id) => rule(id) && data.items[id].category === 'clothing'));
  if (!right) return null;
  return assemble(ctx, 'swim_gear', 'item', s.prompt, right, itemsIn(ctx, ['clothing']), rule, `${cap(itemName(data, right))} ${s.says}.`);
};

const throwing: Template = (ctx) => {
  const { data } = ctx;
  // NPC_THROWN: what BN's survivors pick up to throw (javelins, throwing knives, rocks…).
  const rule = (id: string) => flags(data.items[id]).includes('NPC_THROWN');
  const right = pickItem(ctx, itemsIn(ctx, ['weapons', 'rocks', 'other'], (id) => rule(id)));
  if (!right) return null;
  const pool = itemsIn(ctx, ['weapons', 'tools'], (id, d) => !rule(id) && d.type !== 'GUN');
  return assemble(ctx, 'throwing', 'item', 'Which of these is made for throwing?', right, pool, rule, `${cap(itemName(data, right))} is a good throw.`);
};

const engineFuel: Template = (ctx) => {
  const { data, rng } = ctx;
  const parts = Object.values(vehicleParts(data));
  const engines = parts.filter((p) => p.flags?.includes('ENGINE') && p.fuel_type && fuels(data)[p.fuel_type]);
  if (!engines.length) return null;
  const e = rng.pick(engines);
  const en = cddaText(e.name);
  const same = engines.filter((x) => cddaText(x.name) === en);
  const burns = new Set(same.map((x) => x.fuel_type!));
  const rule = (f: string) => burns.has(f);
  const used = [...new Set(engines.map((x) => x.fuel_type!))];
  return assemble(ctx, 'engine_fuel', 'fuel', `What does ${an(en)} run on?`, e.fuel_type!, used, rule, `${cap(an(en))} burns ${fuelName(data, e.fuel_type!)}.`);
};

// BN vehicle.cpp: a vehicle drives with an engine fed from a tank or battery, controls to steer
// it (vehicle::has_part("CONTROLS")) and wheels on the ground (sufficient_wheel_config). The
// rest is comfort.
const NEEDED = ['CONTROLS', 'WHEEL', 'FLUIDTANK'];
const OPTIONAL = ['HORN', 'SEATBELT', 'STEREO', 'MUFFLER', 'CHIMES', 'ROOF', 'CARGO', 'HEADLIGHT', 'WINDSHIELD', 'BED'];
const carNeeds: Template = (ctx) => {
  const { data, rng } = ctx;
  const parts = Object.values(vehicleParts(data));
  const needed = (p: VehiclePart | undefined) => !!p && (p.flags ?? []).some((f) => NEEDED.includes(f) || f === 'ENGINE' || f === 'BATTERY');
  const rule = (k: string) => needed(vehicleParts(data)[k]);
  const flag = rng.pick(NEEDED);
  const cands = parts.filter((p) => p.flags?.includes(flag) && /^[a-z ()0-9-]+$/i.test(cddaText(p.name)));
  if (!cands.length) return null;
  const right = rng.pick(cands.slice(0, 6)).id;
  const pool = parts.filter((p) => (p.flags ?? []).some((f) => OPTIONAL.includes(f)) && !needed(p)).map((p) => p.id);
  const what = { CONTROLS: 'controls to steer it', WHEEL: 'wheels to roll on', FLUIDTANK: 'a tank to hold its fuel' }[flag];
  return assemble(ctx, 'car_needs', 'part', 'Besides an engine, which of these does a car need to drive?', right, pool, rule, `A car needs ${what}; the rest is comfort.`);
};

/** Item pools for the generic material questions, by skill. */
const SKILL_ITEMS: Record<string, string[]> = {
  cooking: ['tools_cooking', 'food'],
  survival: ['tools', 'weapons', 'clothing'],
  traps: ['tools', 'deployables'],
  fabrication: ['tools_workshop', 'scrap_metal', 'scrap_wood', 'spare_parts', 'weapons'],
  tailor: ['clothing', 'scrap_fabric'],
  electronics: ['electronics', 'scrap_electronics', 'tools'],
  computer: ['electronics', 'tools'],
  mechanics: ['veh_parts', 'tools_workshop', 'spare_parts'],
  driving: ['veh_parts', 'tools_workshop'],
  firstaid: ['drugs', 'tools'],
  bashing: ['weapons'],
  cutting: ['weapons'],
  stabbing: ['weapons'],
  melee: ['weapons'],
  unarmed: ['weapons', 'clothing'],
  throw: ['weapons', 'rocks'],
  dodge: ['clothing'],
  swimming: ['clothing'],
  barter: ['valuables', 'tools', 'clothing'],
  speech: ['valuables', 'clothing'],
  gun: ['guns'],
  pistol: ['guns'],
  rifle: ['guns'],
  shotgun: ['guns'],
  smg: ['guns'],
  launcher: ['guns', 'weapons'],
  archery: ['weapons', 'guns'],
};

const materialOf: Template = (ctx) => {
  const { data } = ctx;
  const pool = itemsIn(ctx, SKILL_ITEMS[ctx.skill ?? ''] ?? ['tools', 'clothing'], (_id, d) => materials(d).length > 0 && !!data.misc.material?.[materials(d)[0]]);
  const it = pickItem(ctx, pool);
  if (!it) return null;
  const mats = materials(data.items[it]);
  const primary = mats[0];
  const mname = (m: string) => domainName(data, 'material', m).toLowerCase();
  const pn = mname(primary);
  // Everything that shares the item's name must agree on what it's mostly made of.
  if (keysNamed(data, 'item', itemName(data, it)).some((o) => mname(materials(data.items[o])[0] ?? '') !== pn)) return null;
  const allNames = new Set(mats.map(mname));
  const rule = (m: string) => mname(m) === pn;
  // Any of its other materials would be half right: never offer them. Food materials ("ice
  // cream", "tomato") only as distractors for food: a cutlass made of dairy isn't a real doubt.
  const food = data.items[it].type === 'COMESTIBLE';
  const pool2 = Object.keys(data.misc.material ?? {}).filter((m) => !allNames.has(mname(m)) && !/^null$|^hflesh|^veggy|^flesh/.test(m) && (food || !data.misc.material[m].edible));
  return assemble(ctx, 'material_of', 'material', `What is ${itemName(data, it)} mostly made of?`, primary, pool2, rule,
    `${cap(itemName(data, it))} is ${mats.map(mname).join(' and ')}.`);
};

const madeOf: Template = (ctx) => {
  const { data, rng } = ctx;
  const cats = SKILL_ITEMS[ctx.skill ?? ''] ?? ['tools', 'clothing'];
  const pool = itemsIn(ctx, cats, (_id, d) => materials(d).length > 0);
  const seed = pickItem(ctx, pool);
  if (!seed) return null;
  const m = rng.pick(materials(data.items[seed]));
  const mn = domainName(data, 'material', m).toLowerCase();
  const rule = (id: string) => materials(data.items[id]).some((x) => domainName(data, 'material', x).toLowerCase() === mn);
  return assemble(ctx, 'made_of', 'item', `Which of these is made of ${mn}?`, seed, pool, rule, `${cap(itemName(data, seed))} is made of ${materials(data.items[seed]).map((x) => domainName(data, 'material', x).toLowerCase()).join(' and ')}.`);
};

const TEMPLATES: Record<TemplateId, Template> = {
  recipe_uses: recipeUses,
  recipe_quality: recipeQuality,
  book_makes: bookMakes,
  recipe_hardest: recipeHardest,
  quality_item: qualityItem,
  spoils_first: spoilsFirst,
  never_spoils: neverSpoils,
  heal,
  gun_ammo: gunAmmo,
  gun_magazine: gunMagazine,
  gun_skill: gunSkill,
  battery_fits: batteryFits,
  needs_power: needsPower,
  weapon_class: weaponClass,
  damage_most: damageMost,
  ma_technique: maTechnique,
  ma_style: maStyle,
  ma_weapon: maWeapon,
  price_most: priceMost,
  encumbrance_most: encumbranceMost,
  swim_gear: swimGear,
  throwing,
  engine_fuel: engineFuel,
  car_needs: carNeeds,
  made_of: madeOf,
  material_of: materialOf,
};

/** Which templates a skill's books draw from (besides the recipe ones), with weights. */
const SKILL_TEMPLATES: Record<string, [TemplateId, number][]> = {
  cooking: [['quality_item', 2], ['spoils_first', 2], ['never_spoils', 1]],
  survival: [['quality_item', 2], ['spoils_first', 1], ['heal', 1], ['material_of', 1]],
  traps: [['quality_item', 2], ['material_of', 1], ['throwing', 1]],
  fabrication: [['quality_item', 3], ['material_of', 2], ['made_of', 1]],
  tailor: [['quality_item', 2], ['made_of', 3], ['material_of', 2], ['encumbrance_most', 1]],
  electronics: [['battery_fits', 3], ['needs_power', 2], ['quality_item', 1], ['material_of', 1]],
  computer: [['battery_fits', 2], ['needs_power', 3], ['quality_item', 1], ['material_of', 1]],
  mechanics: [['quality_item', 3], ['engine_fuel', 2], ['car_needs', 2], ['battery_fits', 1], ['material_of', 1]],
  driving: [['engine_fuel', 3], ['car_needs', 3], ['quality_item', 1]],
  firstaid: [['heal', 5], ['quality_item', 1]],
  bashing: [['weapon_class', 3], ['damage_most', 3], ['material_of', 1]],
  cutting: [['weapon_class', 3], ['damage_most', 3], ['material_of', 1]],
  stabbing: [['weapon_class', 3], ['damage_most', 3], ['material_of', 1]],
  melee: [['weapon_class', 3], ['damage_most', 3], ['ma_technique', 1]],
  unarmed: [['ma_technique', 3], ['weapon_class', 2], ['damage_most', 1]],
  dodge: [['encumbrance_most', 3], ['ma_technique', 1], ['made_of', 1]],
  swimming: [['swim_gear', 4], ['encumbrance_most', 2], ['made_of', 1]],
  throw: [['throwing', 3], ['damage_most', 2], ['material_of', 1]],
  barter: [['price_most', 4], ['material_of', 1]],
  speech: [['price_most', 3], ['material_of', 1]],
  gun: [['gun_ammo', 3], ['gun_magazine', 2], ['weapon_class', 1]],
  pistol: [['gun_ammo', 3], ['gun_magazine', 2], ['gun_skill', 2], ['weapon_class', 1]],
  rifle: [['gun_ammo', 3], ['gun_magazine', 2], ['gun_skill', 2], ['weapon_class', 1]],
  shotgun: [['gun_ammo', 3], ['gun_magazine', 1], ['gun_skill', 2], ['weapon_class', 1]],
  smg: [['gun_ammo', 3], ['gun_magazine', 2], ['gun_skill', 2], ['weapon_class', 1]],
  launcher: [['gun_ammo', 3], ['gun_skill', 2], ['weapon_class', 1]],
  archery: [['gun_ammo', 3], ['gun_skill', 2], ['weapon_class', 1]],
};

/** The skill whose templates a book borrows: its own, or melee for a martial-arts manual. */
function topicOf(def: ItemDef): string | undefined {
  return (def.skill as string | undefined) || (def.martial_art ? 'melee' : undefined);
}

/** The weighted templates this book draws from: its recipes first, then its skill's. */
export function bookTemplates(data: GameData, bookId: string): [TemplateId, number][] {
  const def = data.items[bookId];
  if (!def) throw new Error(`readquiz: no item ${bookId}`);
  const out: [TemplateId, number][] = [];
  const nRec = (bookRecipeIndex(data).get(bookId) ?? []).length;
  if (nRec) {
    out.push(['recipe_uses', 4], ['book_makes', 2]);
    if ((bookRecipeIndex(data).get(bookId) ?? []).some((b) => (b.recipe.qualities ?? []).some((g) => g.length))) out.push(['recipe_quality', 2]);
    if (nRec >= 4) out.push(['recipe_hardest', 1]);
  }
  if (def.martial_art) {
    out.push(['ma_technique', 4], ['ma_style', 3]);
    if ((data.misc.martial_art?.[def.martial_art as string]?.weapon_category ?? []).length) out.push(['ma_weapon', 3]);
  }
  for (const t of SKILL_TEMPLATES[topicOf(def) ?? ''] ?? []) out.push(t);
  return out;
}

/** Fun-only books (novels, holy books, magazines with no skill or recipes) have no quiz. */
export function bookHasQuiz(data: GameData, bookId: string): boolean {
  return bookTemplates(data, bookId).length > 0;
}

export function makeCtx(data: GameData, bookId: string, rng: Rng): Ctx {
  const book = data.items[bookId];
  if (!book) throw new Error(`readquiz: no item ${bookId}`);
  return {
    data,
    book,
    bookId,
    skill: topicOf(book),
    tier: tierFor(book),
    rng,
    recipes: (bookRecipeIndex(data).get(bookId) ?? []).map((b) => b.recipe).filter((r) => !r.never_learn),
  };
}

/** One question from `template` for this book, or null if it can't make a sound one this time. */
export function questionFrom(data: GameData, bookId: string, template: TemplateId, rng: Rng): Question | null {
  return TEMPLATES[template](makeCtx(data, bookId, rng));
}

/**
 * The next question for a book: a weighted template, avoiding prompts in `recent` (the last few
 * asked), retrying until a template yields a sound question. Null only if the book has no quiz.
 */
export function nextQuestion(data: GameData, bookId: string, rng: Rng, recent: ReadonlySet<string> = new Set()): Question | null {
  const ts = bookTemplates(data, bookId);
  if (!ts.length) return null;
  const ctx = makeCtx(data, bookId, rng);
  let fallback: Question | null = null;
  for (let i = 0; i < 40; i++) {
    const q = TEMPLATES[rng.weighted(ts)](ctx);
    if (!q) continue;
    if (!recent.has(q.prompt + '|' + q.options[q.answer])) return q;
    fallback ??= q;
  }
  return fallback;
}

/** Stable identity of a question (for "don't repeat the last few"). */
export const questionKey = (q: Question) => q.prompt + '|' + q.options[q.answer];
