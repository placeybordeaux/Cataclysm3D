import type { GameData, RecipeDef, RequirementData } from '../data/types';
import { autoStoreLiquid } from './liquid';
import type { GameMap } from '../world/map';
import type { GameClock } from '../core/time';
import type { ActivityManager } from './activity';
import type { Character } from './character';
import type { PlayerAvatar } from './player';
import { CraftingInventory } from './crafting_inv';
import { asArray, countByCharges, createItem, inNewContainer, Item } from './item';
import { consumeItem, L, locate, moveItem, spawnItem, spawnSome, transaction, type Loc } from './moves';
import { consumeRequirements, evaluateRequirements, itemDisplayName, type RequirementEval } from './requirements';
import { cddaText } from './units';

// Crafting after Cataclysm: Bright Nights (crafting.cpp, recipe.cpp, craft_command.cpp):
//  - which recipes you know: learned (books, profession, disassembly, crafting from a book) or
//    autolearned once the recipe's skill levels are met; plus, while a book is in reach, the
//    recipes it contains that your skill can follow (BN needs no identification for that);
//  - whether you can craft one: tools/qualities/components from the CraftingInventory
//    (inventory + ground + furniture + fire) and enough light (BN lets you work in the dark,
//    slower, unless the recipe is BLIND_HARD…IMPOSSIBLE and your skill is short);
//  - starting a craft makes a real "in progress" item (BN itype `craft`) that holds the
//    components: they never vanish mid-craft. Stopping keeps it (with its progress) in your
//    inventory or at your feet; you continue it later, or take it apart to get the components
//    back. BN's success roll picks failure points where components can be destroyed and
//    progress lost; destroyed components must be replaced to continue; the skill is practised
//    every 5% of progress; results appear when it's finished.

/** What crafting/construction/reading need from Game (so tests can pass a light stand-in). */
export interface CraftHost {
  data: GameData;
  map: GameMap;
  player: PlayerAvatar;
  clock: GameClock;
  activities: ActivityManager;
  message(text: string, color?: string): void;
  /** Game's event bus when present (map change notifications). */
  events?: { emit(type: 'mapChanged', payload: { x: number; y: number; z: number }): void };
}

// ------------------------------------------------------------------ light
/** BN LIGHT_AMBIENT_LIT: light at which fine detail is as clear as it gets. */
const LIGHT_AMBIENT_LIT = 10;
/** BN character_funcs::FINE_VISION_THRESHOLD: can_see_fine_details at or below. */
export const FINE_VISION_THRESHOLD = 4;

function lightLevel(host: CraftHost): number | null {
  const p = host.player;
  const x = Math.floor(p.x), y = Math.floor(p.y), z = p.z;
  const la = ((host as any).lightAt ?? (host.map as any).lightAt) as ((x: number, y: number, z: number) => number) | undefined;
  if (typeof la === 'function') return la.call((host as any).lightAt ? host : host.map, x, y, z);
  return null;
}

/** A light source carried and switched on (flashlight_on, lit lantern…): BN active_light. */
function carriedLight(host: CraftHost): number {
  let best = 0;
  for (const it of host.player.inv.allItems()) {
    const l = Number(it.def.light ?? 0);
    if (l > 0 && (it.active || it.typeId.endsWith('_on') || it.typeId.endsWith('_lit'))) best = Math.max(best, l);
  }
  return best;
}

/**
 * Local estimate when no light model is wired (tests): daylight above ground, or a fire, lamp
 * furniture or lit carried item close by is "lit" (10), else dark (0).
 */
function estimatedLight(host: CraftHost): number {
  const p = host.player;
  const x = Math.floor(p.x), y = Math.floor(p.y), z = p.z;
  const R = 5;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const tx = x + dx, ty = y + dy;
      if (host.map.fieldsAt(tx, ty, z).some((f) => f.type === 'fd_fire')) return LIGHT_AMBIENT_LIT;
      if ((host.map.furnAt(tx, ty, z).light_emitted ?? 0) > 0 || (host.map.terAt(tx, ty, z).light_emitted ?? 0) > 0) return LIGHT_AMBIENT_LIT;
    }
  }
  const h = host.clock.hourOfDay;
  return z >= 0 && h >= 6 && h < 20 ? LIGHT_AMBIENT_LIT : 0;
}

/**
 * BN fine_detail_vision_mod: 1 (perfect) .. 11 (pitch dark). Uses the shared `lightAt` when
 * the vision system provides it; a lit carried light counts as your own light source.
 */
export function fineVisionMod(host: CraftHost): number {
  const own = carriedLight(host);
  const ownMod = Math.max(1, LIGHT_AMBIENT_LIT - own - 2);
  const light = lightLevel(host) ?? (own > 0 ? LIGHT_AMBIENT_LIT : estimatedLight(host));
  const ambient = Math.max(1, LIGHT_AMBIENT_LIT - light + 1);
  return Math.min(own > 0 ? ownMod : Infinity, ambient);
}

/** Enough light for fine work (BN can_see_fine_details): reading needs it, crafting goes slower without. */
export function hasCraftingLight(host: CraftHost): boolean {
  return fineVisionMod(host) <= FINE_VISION_THRESHOLD;
}

/** SkillLevelMap::exceeds_recipe_requirements: the smallest margin over the recipe's skills. */
export function exceedsRecipeRequirements(c: Character, r: RecipeDef): number {
  let over = r.skill_used ? c.getSkill(r.skill_used) - r.difficulty : 0;
  for (const [s, l] of r.skills_required ?? []) over = Math.min(over, c.getSkill(s) - l);
  return over;
}

/** BN lighting_crafting_speed_multiplier: 1 in good light; slower (or 0 = impossible) in the dark. */
export function lightSpeedMultiplier(host: CraftHost, r: RecipeDef, visionMod = fineVisionMod(host)): number {
  if (r.flags?.includes('BLIND_NO_EFFECT') || visionMod <= FINE_VISION_THRESHOLD) return 1;
  const darkness = (visionMod - FINE_VISION_THRESHOLD) / 7;
  const deficit = Math.max(0, -exceedsRecipeRequirements(host.player, r));
  const calc = (blockDivisor: number, basePenalty: number, deficitScale: number): number => {
    if (deficit >= darkness * blockDivisor) return 0;
    const result = 1 - darkness * (basePenalty + (deficitScale > 0 ? deficit / deficitScale : 0));
    return result <= 0 ? 0 : Math.max(0.05, result);
  };
  const f = r.flags ?? [];
  if (f.includes('BLIND_IMPOSSIBLE')) return darkness >= 0.5 ? 0 : calc(1000, 1, 5);
  if (f.includes('BLIND_NEARLY_IMPOSSIBLE')) return calc(3, 0.75, 10);
  if (f.includes('BLIND_HARD')) return calc(6, 0.6, 14);
  if (f.includes('BLIND_EASY')) return calc(20, 0.25, 27);
  return calc(12, 0.4, 20);
}

/** BN morale_crafting_speed_multiplier: sadness slows hard work. */
export function moraleSpeedMultiplier(c: Character, r: RecipeDef): number {
  const morale = c.morale.level();
  if (morale >= 0) return 1;
  let mult = Math.max(1, (2 * r.difficulty) / Math.max(1, c.getSkill(r.skill_used ?? '')));
  for (const [s, l] of r.skills_required ?? []) mult *= Math.max(1, (2 * l) / Math.max(1, c.getSkill(s)));
  return 1 / (1 + (mult * morale) / -50);
}

/** BN crafting_speed_multiplier (no workbench/tool-speed/assistant terms). 0 = can't work. */
export function craftSpeed(host: CraftHost, r: RecipeDef, lightMult = lightSpeedMultiplier(host, r)): number {
  const c = host.player;
  const m = moraleSpeedMultiplier(c, r) * lightMult * c.mutationValue('crafting_speed_modifier');
  return m + c.enchantBonus('CRAFTING_SPEED', m);
}

// ------------------------------------------------------------------ knowledge
/** Skills a recipe needs to be autolearned (the extractor expanded `true` like BN finalize). */
export function autolearnRequirements(r: RecipeDef): [string, number][] | null {
  return r.autolearn ? r.autolearn : null;
}

export function meetsSkills(c: Character, reqs: [string, number][]): boolean {
  return reqs.every(([s, l]) => c.getSkill(s) >= l);
}

/** Recipes the crafting screen offers (BN hides CC_BUILDING blueprints and SECRET ones). */
export function isCraftRecipe(r: RecipeDef): boolean {
  return !!r.result && r.type !== 'uncraft' && r.category !== 'CC_BUILDING' && r.category !== 'CC_*' && !r.flags?.includes('SECRET');
}

/** Character::knows_recipe: learned, or its autolearn skills are met. */
export function knowsRecipe(c: Character, r: RecipeDef): boolean {
  if (c.learnedRecipes.has(r.id)) return true;
  const req = autolearnRequirements(r);
  return !!req && meetsSkills(c, req);
}

const recipeById = new WeakMap<GameData, Map<string, RecipeDef>>();
export function recipeIndex(data: GameData): Map<string, RecipeDef> {
  let m = recipeById.get(data);
  if (!m) recipeById.set(data, (m = new Map(data.recipes.map((r) => [r.id, r]))));
  return m;
}

/** Character::learn_recipe (never_learn recipes can't be memorised). Returns true if new. */
export function learnRecipe(c: Character, id: string): boolean {
  if (c.learnedRecipes.has(id)) return false;
  if (recipeIndex(c.data).get(id)?.never_learn) return false;
  c.learnedRecipes.add(id);
  return true;
}

export interface BookRecipe {
  recipe: RecipeDef;
  /** Skill (in the recipe's skill_used) needed to follow it from the book. */
  level: number;
  name?: string;
}

const bookIndexCache = new WeakMap<GameData, Map<string, BookRecipe[]>>();
/**
 * book item id → recipes it contains (recipe book_learn; recipe_dictionary finalize: a level
 * of -1/0 means max(the book's required level, the recipe's difficulty)).
 */
export function bookRecipeIndex(data: GameData): Map<string, BookRecipe[]> {
  let idx = bookIndexCache.get(data);
  if (idx) return idx;
  idx = new Map();
  for (const r of data.recipes) {
    for (const [book, lvl] of r.book_learn ?? []) {
      if (!data.items[book]) continue;
      const level = lvl > 0 ? lvl : Math.max(data.items[book].required_level ?? 0, r.difficulty);
      const l = idx.get(book) ?? [];
      l.push({ recipe: r, level });
      idx.set(book, l);
    }
  }
  bookIndexCache.set(data, idx);
  return idx;
}

/** item::get_available_recipes: what a book lets `c` craft (enough skill to follow it). */
export function bookAvailableRecipes(c: Character, bookId: string): BookRecipe[] {
  return (bookRecipeIndex(c.data).get(bookId) ?? []).filter((br) => !br.recipe.skill_used || c.getSkill(br.recipe.skill_used) >= br.level);
}

export interface KnownRecipe {
  recipe: RecipeDef;
  /** 'memory' or the book item id it's being read from. */
  source: 'memory' | string;
}

/** Character::get_available_recipes: memory + books in the crafting inventory. */
export function availableRecipes(c: Character, inv: CraftingInventory): KnownRecipe[] {
  const out = new Map<string, KnownRecipe>();
  for (const r of c.data.recipes) if (isCraftRecipe(r) && knowsRecipe(c, r)) out.set(r.id, { recipe: r, source: 'memory' });
  const seen = new Set<string>();
  for (const s of inv.sources) {
    if (!s.item.isBook() || seen.has(s.item.typeId)) continue;
    seen.add(s.item.typeId);
    for (const br of bookAvailableRecipes(c, s.item.typeId)) if (!out.has(br.recipe.id) && isCraftRecipe(br.recipe)) out.set(br.recipe.id, { recipe: br.recipe, source: s.item.typeId });
  }
  return [...out.values()];
}

/** Books (item ids) that contain `r`, for "where do I learn this" (get_books_for_recipe). */
export function booksForRecipe(data: GameData, r: RecipeDef): { book: string; level: number }[] {
  return (r.book_learn ?? []).filter(([b]) => data.items[b]).map(([book]) => ({ book, level: bookRecipeIndex(data).get(book)!.find((x) => x.recipe === r)!.level }));
}

// ------------------------------------------------------------------ nested categories
export interface NestedCategory {
  id: string;
  name: string;
  description?: string;
  category: string;
  subcategory?: string;
  members: string[];
}

const nestedCache = new WeakMap<GameData, NestedCategory[]>();
/** BN "nested_category" recipe groups ("bows", "spears" …) shown as expandable entries. */
export function nestedCategories(data: GameData): NestedCategory[] {
  let l = nestedCache.get(data);
  if (!l) {
    l = Object.values((data.misc.nested_category ?? {}) as Record<string, any>).map((n) => ({
      id: n.id,
      name: cddaText(n.name) || n.id,
      description: cddaText(n.description),
      category: n.category,
      subcategory: n.subcategory,
      members: (n.nested_category_data ?? []) as string[],
    }));
    nestedCache.set(data, l);
  }
  return l;
}

// ------------------------------------------------------------------ checks
export function recipeName(data: GameData, r: RecipeDef): string {
  const n = cddaText(r.name as unknown);
  // Recipe names like "%s in jar" put the result's name in the %s.
  if (n) return n.includes('%s') ? n.replace('%s', itemDisplayName(data, r.result)) : n;
  return itemDisplayName(data, r.result);
}

export function recipeRequirements(r: RecipeDef): RequirementData {
  return { components: r.components ?? [], tools: r.tools ?? [], qualities: r.qualities ?? [] };
}

export interface CraftCheck {
  ok: boolean;
  /** Blocking problems, BN wording where possible. */
  missing: string[];
  req: RequirementEval;
  /** Light allows working at all (maybe slowly). */
  light: boolean;
  /** Overall speed multiplier (1 = normal; light and morale). */
  speed: number;
}

export function craftingInventory(host: CraftHost): CraftingInventory {
  const p = host.player;
  return CraftingInventory.gather(host.data, p, host.map, { x: p.x, y: p.y, z: p.z });
}

/**
 * Can `r` be crafted `batch` times right now? `lit` overrides the light check (true: assume
 * light, as the "you could craft" watcher does so dusk doesn't re-announce recipes).
 */
export function canCraft(host: CraftHost, r: RecipeDef, batch = 1, inv = craftingInventory(host), lit?: boolean): CraftCheck {
  const req = evaluateRequirements(host.data, recipeRequirements(r), inv, batch);
  const missing = [...req.missing];
  const lightMult = lit === true ? 1 : lightSpeedMultiplier(host, r);
  const light = lightMult > 0;
  if (!light) missing.push("You can't see to craft!");
  return { ok: missing.length === 0, missing, req, light, speed: light ? craftSpeed(host, r, lightMult) : 0 };
}

// ------------------------------------------------------------------ time & success
/** recipe::batch_time: logistic batch savings [rscale %, rsize] (no assistants). Seconds. */
export function batchTime(time: number, batch: number, factors: unknown, multiplier = 1): number {
  const local = time / (multiplier > 0 ? multiplier : 1);
  const f = Array.isArray(factors) ? factors : null;
  const rscale = f ? (f[0] ?? 0) / 100 : 0, rsize = f ? f[1] ?? 0 : 0;
  if (batch <= 1 || rscale === 0 || rsize <= 0) return local * Math.max(1, batch);
  const scale = rsize / 6;
  let t = 0;
  for (let x = 0; x < batch; x++) t += local * (1 - rscale * (2 / (1 + Math.exp(-(x / scale))) - 1));
  return Math.max(t, local);
}

/** Seconds to craft `batch` of `r` at `speed` (default: the crafter's morale speed only). */
export function craftTime(c: Character, r: RecipeDef, batch = 1, speed?: number): number {
  const s = speed ?? moraleSpeedMultiplier(c, r) * c.mutationValue('crafting_speed_modifier');
  return Math.max(1, Math.round(batchTime(r.time, batch, r.batch_time_factors, s)));
}

/** BN Character::crafting_success_roll dice counts: skill dice/sides vs difficulty dice (24 sides). */
function successDice(c: Character, r: RecipeDef): { skillDice: number; skillSides: number; diffDice: number } {
  let secDice = 0, secDiff = 0;
  for (const [s, l] of r.skills_required ?? []) {
    secDice += c.getSkill(s);
    secDiff += l;
  }
  const primary = r.skill_used ? c.getSkill(r.skill_used) : 0;
  let skillDice = secDiff > 0 ? primary * 3 + secDice : primary * 4;
  for (const id of c.traits) {
    const bonus = (c.data.misc.mutation?.[id] as { craft_skill_bonus?: [string, number][] } | undefined)?.craft_skill_bonus;
    for (const [sk, n] of bonus ?? []) if (sk === r.skill_used) skillDice += n;
  }
  return { skillDice: Math.max(0, skillDice), skillSides: 16 + c.int, diffDice: secDiff > 0 ? r.difficulty * 3 + secDiff : r.difficulty * 4 };
}

/** crafting_success_roll: skill roll / difficulty roll; >= 1 means the rest goes without a mishap. */
export function craftingSuccessRoll(c: Character, r: RecipeDef): number {
  const d = successDice(c, r);
  const diff = c.rng.dice(d.diffDice, 24);
  if (diff === 0) return 2;
  return c.rng.dice(d.skillDice, d.skillSides) / diff;
}

/** Probability distribution of dice(n, sides), memoised (for the UI's success chance). */
const diceDist = new Map<string, Float64Array>();
function distribution(n: number, sides: number): Float64Array {
  const key = `${n}d${sides}`;
  let d = diceDist.get(key);
  if (d) return d;
  d = new Float64Array(n * sides + 1);
  d[0] = 1;
  for (let i = 0; i < n; i++) {
    const next = new Float64Array(n * sides + 1);
    for (let s = 0; s <= i * sides; s++) {
      if (!d[s]) continue;
      for (let f = 1; f <= sides; f++) next[s + f] += d[s] / sides;
    }
    d = next;
  }
  diceDist.set(key, d);
  return d;
}

/** Chance the whole craft goes without a single mishap: P(skill roll >= difficulty roll). */
export function successChance(c: Character, r: RecipeDef): number {
  const d = successDice(c, r);
  if (d.diffDice === 0) return 1;
  if (d.skillDice === 0) return 0;
  const sk = distribution(d.skillDice, d.skillSides), df = distribution(d.diffDice, 24);
  // cumulative of the skill roll from the top
  const atLeast = new Float64Array(sk.length + 1);
  for (let i = sk.length - 1; i >= 0; i--) atLeast[i] = atLeast[i + 1] + sk[i];
  let p = 0;
  for (let y = 0; y < df.length; y++) if (df[y]) p += df[y] * (y < atLeast.length ? atLeast[y] : 0);
  return Math.min(1, p);
}

// ------------------------------------------------------------------ results
/** recipe::create_results for a batch: result_mult, charges, contained results. */
export function createResults(data: GameData, r: RecipeDef, batch = 1): Item[] {
  const def = data.items[r.result];
  if (!def) throw new Error(`recipe ${r.id}: unknown result ${r.result}`);
  const byCharges = countByCharges(def);
  const one = (mult: number): Item => {
    const it = createItem(data, r.result);
    if (r.charges !== undefined) it.charges = r.charges;
    if (byCharges) it.charges = Math.max(1, it.charges) * mult;
    else if (it.ammoTypes().length && !it.hasFlag('CRAFT_WITH_FULL_MAG')) {
      // BN craft_has_charges: tools/guns that take ammo come out empty.
      it.charges = 0;
      it.ammoId = null;
    }
    if (it.hasFlag('VARSIZE') && !it.flags.includes('FIT')) it.flags.push('FIT');
    return it;
  };
  const out: Item[] = [];
  if (r.contained || !byCharges) {
    const n = byCharges ? batch : batch * (r.result_mult ?? 1);
    for (let i = 0; i < n; i++) out.push(one(byCharges ? r.result_mult ?? 1 : 1));
  } else out.push(one((r.result_mult ?? 1) * batch));
  if (!r.contained) return out;
  const cont = r.container ?? def.container;
  if (!cont || !data.items[cont]) return out;
  return out.map((it) => {
    const { container, rest } = inNewContainer(data, it, cont);
    if (rest) throw new Error(`recipe ${r.id}: result doesn't fit its container ${cont}`);
    return container;
  });
}

/** recipe::create_byproducts. */
export function createByproducts(data: GameData, r: RecipeDef, batch: number): Item[] {
  const out: Item[] = [];
  for (const [id, n] of r.byproducts ?? []) {
    const def = data.items[id];
    if (!def) continue;
    if (countByCharges(def)) {
      const it = createItem(data, id);
      it.charges = Math.max(1, it.charges) * n * batch;
      out.push(it);
    } else for (let i = 0; i < n * batch; i++) out.push(createItem(data, id));
  }
  return out;
}

/**
 * What to do with a crafted liquid that no carried closed container took (BN liquid_handler's
 * "drink / pour into / pour out" menu). Set by the UI (src/ui/liquid_ui.ts); null = decide
 * without asking (tests, headless): fill any container around, then the ground.
 */
export const liquidHooks: { handle: ((host: CraftHost, liquid: Item) => void) | null } = { handle: null };

/**
 * Put freshly made items with the character (BN set_item_inventory / liquid_handler): liquids
 * into a container that fits (carried, then nearby), others into the inventory, wielded if
 * hands are free and it's the only thing made, else at their feet.
 */
export function giveOrDrop(host: CraftHost, items: Item[], inv?: CraftingInventory): void {
  const p = host.player;
  const ground = L.ground(host.map, Math.floor(p.x), Math.floor(p.y), p.z);
  for (const it of items) {
    if (it.isLiquid() && liquidHooks.handle) {
      const left = autoStoreLiquid(host, it);
      if (left) liquidHooks.handle(host, left);
      continue;
    }
    if (it.isLiquid()) {
      // Closed containers (bottles, jugs) before open ones (pots) so boiled water doesn't
      // end up in the cooking pot; carried first, then what lies around.
      const holders = [...p.inv.allItems(), ...(inv?.sources.filter((s) => s.kind === 'map').map((s) => s.item) ?? [])]
        .filter((h) => h.isContainer())
        .sort((a, b) => Number(!a.isWatertight()) - Number(!b.isWatertight()));
      let left: Item | null = it;
      for (const h of holders) {
        if (!left) break;
        left = spawnSome(left, L.in(h), { actor: p, quiet: true });
      }
      if (left) {
        spawnItem(left, ground, { actor: p, quiet: true, force: true });
        host.message(`You don't have a container for the ${left.name()}, so you pour it onto the ground.`, 'c_yellow');
      }
      continue;
    }
    if (p.inv.stashNew(it) === null) continue;
    if (!p.inv.wielded && items.length === 1 && spawnItem(it, L.hands(p), { actor: p, quiet: true }).ok) {
      host.message(`You wield your ${it.name()}.`);
      continue;
    }
    spawnItem(it, ground, { actor: p, quiet: true, force: true });
    host.message(`You put the ${it.name()} on the ground.`);
  }
}

// ------------------------------------------------------------------ in-progress crafts
/** BN itype "craft": the in-progress item. */
export const CRAFT_ITEM = 'craft';

export interface CraftState {
  recipe: RecipeDef;
  batch: number;
  /** 0..1 */
  progress: number;
  /** Progress at which the next mishap happens (>= 1: none). */
  nextFailure: number;
  /** Components the craft is made of (the alternatives picked, × batch): destroyed ones must be replaced. */
  comps: { id: string; count: number }[];
  /** 5% practice steps already granted. */
  practiced: number;
}

/** The recipe and progress of an in-progress craft item, or null (not a craft / a construction). */
export function craftState(data: GameData, it: Item): CraftState | null {
  if (!it.isCraft() || it.vars.con_id !== undefined) return null;
  const r = recipeIndex(data).get(String(it.vars.craft_recipe));
  if (!r) return null;
  let comps: { id: string; count: number }[] = [];
  try {
    comps = JSON.parse(String(it.vars.craft_comps ?? '[]'));
  } catch {
    comps = [];
  }
  return {
    recipe: r,
    batch: Number(it.vars.craft_batch ?? 1),
    progress: Number(it.vars.craft_progress ?? 0),
    nextFailure: Number(it.vars.craft_next_failure ?? 2),
    comps,
    practiced: Number(it.vars.craft_practiced ?? 0),
  };
}

function writeState(it: Item, st: Pick<CraftState, 'progress' | 'nextFailure' | 'practiced'>): void {
  it.vars.craft_progress = Math.max(0, Math.min(1, st.progress));
  it.vars.craft_next_failure = st.nextFailure;
  it.vars.craft_practiced = st.practiced;
}

/** item::set_next_failure_point: somewhere in what's left, scaled by a fresh success roll. */
function nextFailurePoint(c: Character, r: RecipeDef, progress: number): number {
  return progress + craftingSuccessRoll(c, r) * (1 - progress);
}

/** Where a craft item is: on the crafter, or on a tile within reach. */
export function craftLoc(host: CraftHost, craft: Item): Loc | null {
  const p = host.player;
  const own = p.inv.locOf(craft);
  if (own) return own;
  const around: Loc[] = [];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) around.push(L.ground(host.map, Math.floor(p.x) + dx, Math.floor(p.y) + dy, p.z));
  return locate(craft, around);
}

/** In-progress crafts the player carries or has within reach. */
export function inProgressCrafts(host: CraftHost): { item: Item; state: CraftState; nearby: boolean }[] {
  const out: { item: Item; state: CraftState; nearby: boolean }[] = [];
  for (const it of host.player.inv.allItems()) {
    const st = craftState(host.data, it);
    if (st) out.push({ item: it, state: st, nearby: false });
  }
  const p = host.player;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++)
      for (const mi of host.map.itemsAt(Math.floor(p.x) + dx, Math.floor(p.y) + dy, p.z)) {
        if (!(mi instanceof Item)) continue;
        const st = craftState(host.data, mi);
        if (st) out.push({ item: mi, state: st, nearby: true });
      }
  return out;
}

/** Components a craft still lacks (destroyed by mishaps) — BN continue_requirements. */
export function missingComponents(craft: Item, st: CraftState): { id: string; count: number }[] {
  const have = new Map<string, number>();
  for (const c of craft.contents) have.set(c.typeId, (have.get(c.typeId) ?? 0) + c.count());
  const out: { id: string; count: number }[] = [];
  for (const { id, count } of st.comps) {
    const got = have.get(id) ?? 0;
    if (got < count) out.push({ id, count: count - got });
    have.set(id, Math.max(0, got - count));
  }
  return out;
}

/** Requirements to keep working on a craft: tools/qualities (charges were paid up front) + replacements. */
export function continueRequirements(craft: Item, st: CraftState): RequirementData {
  const r = st.recipe;
  return {
    qualities: r.qualities ?? [],
    tools: (r.tools ?? []).map((g) => g.map((t) => ({ ...t, count: -1 }))),
    components: missingComponents(craft, st).map((m) => [{ id: m.id, count: m.count }]),
  };
}

export interface CraftOptions {
  batch?: number;
  /** Skip the activity and finish at once (tests, debug). */
  instant?: boolean;
  /** Component alternative picked per group (group index → item id). */
  choice?: Record<number, string>;
}

export interface CraftResult {
  ok: boolean;
  msg: string;
  /** The in-progress craft item (when one was made or continued). */
  craft?: Item;
}

/**
 * Called after a craft finishes and its results were handed out (progression: lifetime
 * crafted counts, "you could craft" nudges skip recipes already made; the craft queue).
 * Listeners must not throw.
 */
export const craftedHooks: ((r: RecipeDef, batch: number) => void)[] = [];
/** Called when a craft stops unfinished (interrupted, failed, can't continue). */
export const craftStoppedHooks: ((r: RecipeDef, reason: string) => void)[] = [];

/**
 * Start crafting `r`: check, take the components into a new in-progress craft item (inventory,
 * else at your feet), pay the tools' charges, then work on it. Returns immediately; the result
 * appears when the activity completes.
 */
export function startCraft(host: CraftHost, r: RecipeDef, opts: CraftOptions = {}): CraftResult {
  const c = host.player;
  const batch = Math.max(1, Math.floor(opts.batch ?? 1));
  const inv = craftingInventory(host);
  const check = canCraft(host, r, batch, inv);
  if (!check.ok) {
    const msg = check.light ? `You can't craft that: missing ${check.missing.join('; ')}.` : "You can't see to craft!";
    host.message(msg, 'c_light_red');
    return { ok: false, msg };
  }
  const name = recipeName(host.data, r);
  const craft = createItem(host.data, CRAFT_ITEM);
  craft.vars.craft_recipe = r.id;
  craft.vars.craft_batch = batch;
  craft.vars.craft_label = `in progress ${name}`;
  let placed: Loc | null = null;
  transaction(() => {
    const { used } = consumeRequirements(recipeRequirements(r), inv, batch, L.in(craft), opts.choice);
    craft.vars.craft_comps = JSON.stringify(used);
    writeState(craft, { progress: 0, nextFailure: nextFailurePoint(c, r, 0), practiced: 0 });
    // BN set_item_inventory: carried if it fits, else on the ground where you work.
    const p = host.player;
    const ground = L.ground(host.map, Math.floor(p.x), Math.floor(p.y), p.z);
    for (const to of [L.inv(p), ground]) {
      if (spawnItem(craft, to, { actor: p, quiet: true, force: to === ground }).ok) {
        placed = to;
        break;
      }
    }
    return placed !== null;
  });
  if (!placed) throw new Error(`startCraft: couldn't place the craft for ${r.id}`);
  if ((placed as Loc).kind === 'ground') host.message(`You put the ${craft.baseName()} on the ground.`);
  if (r.skill_used && c.getSkill(r.skill_used) > r.difficulty * 1.25)
    host.message(`You feel that ${c.skillName(r.skill_used)} tasks of this level are becoming trivial.`, 'c_light_gray');
  const res = continueCraft(host, craft, { instant: opts.instant, starting: true });
  return { ...res, craft };
}

/** Why work on `craft` can't go on right now (null = it can). */
export function cantContinue(host: CraftHost, craft: Item, inv = craftingInventory(host)): string | null {
  const st = craftState(host.data, craft);
  if (!st) return `The ${craft.baseName()} isn't something you can work on.`;
  if (!craftLoc(host, craft)) return `The ${craft.baseName()} is out of reach.`;
  if (lightSpeedMultiplier(host, st.recipe) <= 0) return "You can't see to craft!";
  const ev = evaluateRequirements(host.data, continueRequirements(craft, st), inv, 1);
  return ev.ok ? null : `You can no longer make that craft: missing ${ev.missing.join('; ')}.`;
}

/**
 * Work on an in-progress craft until it's done (or you stop). Replacements for destroyed
 * components are taken first. Fails with a message when tools, light or replacements are missing.
 */
export function continueCraft(host: CraftHost, craft: Item, opts: { instant?: boolean; starting?: boolean } = {}): CraftResult {
  const c = host.player;
  const st0 = craftState(host.data, craft);
  if (!st0) return { ok: false, msg: 'Not a craft.' };
  const r = st0.recipe;
  const name = recipeName(host.data, r);
  const inv = craftingInventory(host);
  const why = cantContinue(host, craft, inv);
  if (why) {
    host.message(why, 'c_light_red');
    for (const h of craftStoppedHooks) h(r, why);
    return { ok: false, msg: why, craft };
  }
  const missing = missingComponents(craft, st0);
  if (missing.length) consumeRequirements({ components: missing.map((m) => [m]) }, inv, 1, L.in(craft));

  const batch = st0.batch;
  const state = { progress: st0.progress, nextFailure: st0.nextFailure, practiced: st0.practiced };
  const total = () => craftTime(c, r, batch, craftSpeed(host, r) || 1);
  const save = () => writeState(craft, state);

  // BN craft_skill_gain every 5% of progress: (difficulty × 15 + 10) × batch_mult / 20.
  const practiceTo = (progress: number) => {
    const steps = Math.floor(progress * 20 + 1e-9);
    if (!r.skill_used) return void (state.practiced = Math.max(state.practiced, steps));
    const batchMult = batch + (craftTime(c, r, batch, 1) * 100) / 30000;
    const cap = Math.floor(r.difficulty * 1.25);
    for (; state.practiced < steps; state.practiced++) {
      c.practice(r.skill_used, c.rollRemainder(((r.difficulty * 15 + 10) * batchMult) / 20), cap);
      for (const [s, l] of r.skills_required ?? []) {
        if (s === r.skill_used || c.data.misc.skill?.[s]?.tags?.includes('combat_skill')) continue;
        c.practice(s, Math.floor(c.rollRemainder(((c.getSkill(s) * 15 + 10) * batchMult) / 20) / 2), Math.floor(l * 1.25));
      }
    }
  };

  const finish = () => {
    state.progress = 1;
    practiceTo(1);
    save();
    completeCraft(host, craft);
  };
  if (opts.instant) {
    finish();
    return { ok: true, msg: `You craft ${name}.`, craft };
  }

  let base = state.progress;
  const startAct = (): boolean => {
    const dur = Math.max(1, Math.round(total() * (1 - base)));
    return host.activities.start({
      name: `crafting ${name}`,
      duration: dur,
      kind: 'craft',
      target: craft,
      customUi: true,
      onProgress: (_dt, fraction) => {
        state.progress = base + (1 - base) * fraction;
        practiceTo(state.progress);
        if (state.progress >= state.nextFailure && fraction < 1) handleFailure();
        save();
      },
      onComplete: finish,
      onCancel: (_f, reason) => {
        save();
        if (craftLoc(host, craft)) host.message(`The ${craft.name()} is waiting for you; continue it from the crafting screen.`, 'c_light_gray');
        for (const h of craftStoppedHooks) h(r, reason);
      },
    });
  };

  // item::handle_craft_failure: destroy some components (each saved by a success roll), lose
  // progress, maybe stop when the components are all gone or replacements are missing.
  const handleFailure = () => {
    const roll = craftingSuccessRoll(c, r);
    const loc = L.in(craft);
    const had = craft.contents.length;
    const maxDestroyed = Math.max(1, Math.floor((had * 3) / 4));
    for (let i = 0; i < maxDestroyed && craft.contents.length; i++) {
      if (c.rng.next() < roll) continue;
      const lost = craft.contents[Math.floor(c.rng.next() * craft.contents.length)];
      host.message(`You mess up and destroy the ${lost.name()}.`, 'c_light_red');
      consumeItem(lost, loc);
    }
    if (had > 0 && craft.contents.length === 0) {
      const where = craftLoc(host, craft);
      if (where) consumeItem(craft, where);
      host.activities.cancel(`You fail to make the ${name}, and all components are ruined.`);
      return;
    }
    const exp = 0.25 + -Math.log(Math.max(1e-9, 1 - c.rng.next())) * 0.1;
    const loss = exp * (1 - Math.min(roll, 1));
    const lost = state.progress * loss;
    state.progress = Math.max(0, state.progress - lost);
    host.message(`You mess up and lose ${Math.round(lost * 100)}% progress.`, 'c_yellow');
    state.nextFailure = nextFailurePoint(c, r, state.progress);
    save();
    // Restart the clock from the new progress (the activity's own bookkeeping).
    const act = host.activities.current;
    base = state.progress;
    if (act) {
      act.elapsed = 0;
      act.spec.duration = Math.max(1, Math.round(total() * (1 - base)));
    }
    if (missingComponents(craft, craftState(host.data, craft)!).length) {
      const inv2 = craftingInventory(host);
      const need = continueRequirements(craft, craftState(host.data, craft)!);
      const ev = evaluateRequirements(host.data, need, inv2, 1);
      if (!ev.ok) host.activities.cancel(`You can't continue the ${name}: missing ${ev.missing.join('; ')}.`);
      else consumeRequirements({ components: need.components }, inv2, 1, L.in(craft));
    }
  };

  if (!opts.starting) host.message(`You continue working on the ${name}.`);
  else host.message(`You start working on the ${name}.`);
  if (!startAct()) return { ok: false, msg: 'Interrupted.', craft };
  return { ok: true, msg: `You start working on the ${name}.`, craft };
}

/** complete_craft: the craft item and its components become the results. */
export function completeCraft(host: CraftHost, craft: Item): boolean {
  const c = host.player;
  const st = craftState(host.data, craft);
  const where = craftLoc(host, craft);
  if (!st || !where) {
    host.message(`The ${craft.baseName()} is gone.`, 'c_light_red');
    return false;
  }
  const r = st.recipe;
  const name = recipeName(host.data, r);
  const inv = craftingInventory(host);
  const fromMemory = knowsRecipe(c, r);
  for (const comp of [...craft.contents]) consumeItem(comp, L.in(craft));
  consumeItem(craft, where);
  const results = createResults(host.data, r, st.batch);
  const byproducts = createByproducts(host.data, r, st.batch);
  if (fromMemory) host.message(`You craft ${name} from memory.`);
  else {
    host.message(`You craft ${name} using a book as a reference.`);
    // BN: 1000 × 8 × difficulty⁴ / (skill × int) moves to learn it on average.
    const level = bookLevelFor(c, r, inv) ?? r.difficulty;
    const speed = Math.max(c.getSkill(r.skill_used ?? ''), 1) * Math.max(c.int, 1);
    const timeToLearn = (1000 * 8 * level ** 4) / speed;
    if (c.rng.next() * timeToLearn < r.time * 100 && learnRecipe(c, r.id)) host.message(`You memorized the recipe for ${name}!`, 'c_light_green');
  }
  giveOrDrop(host, [...results, ...byproducts], inv);
  for (const hk of craftedHooks) hk(r, st.batch);
  return true;
}

/** The book level a recipe is followed at from books in reach (has_recipe custom difficulty). */
function bookLevelFor(c: Character, r: RecipeDef, inv: CraftingInventory): number | null {
  let best: number | null = null;
  for (const s of inv.sources) {
    if (!s.item.isBook()) continue;
    for (const br of bookAvailableRecipes(c, s.item.typeId)) if (br.recipe === r) best = best === null ? br.level : Math.min(best, br.level);
  }
  return best;
}

/**
 * Take an in-progress craft apart (BN disassembling a craft): its components go back to your
 * inventory (or your feet); the progress and the tools' charges are lost.
 */
export function abandonCraft(host: CraftHost, craft: Item): boolean {
  const where = craftLoc(host, craft);
  if (!where || !craftState(host.data, craft)) return false;
  if (host.activities.current?.spec.target === craft) host.activities.cancel('You stop crafting.');
  const p = host.player;
  const ground = L.ground(host.map, Math.floor(p.x), Math.floor(p.y), p.z);
  const from = L.in(craft);
  for (const comp of [...craft.contents]) {
    if (comp.isLiquid()) {
      // Back into a container (carried sealed ones first), else it spills where you stand.
      const holders = p.inv.allItems().filter((h) => h.isContainer() && h !== craft).sort((a, b) => Number(!a.isWatertight()) - Number(!b.isWatertight()));
      for (const h of holders) if (comp.charges > 0 && craft.contents.includes(comp)) moveItem(comp, from, L.in(h), { actor: p, quiet: true, partial: true });
      if (craft.contents.includes(comp)) {
        moveItem(comp, from, ground, { actor: p, quiet: true, force: true });
        host.message(`The ${comp.name()} spills onto the ground.`, 'c_yellow');
      }
      continue;
    }
    // Into the inventory when it fits (a normal move checks), else at your feet.
    if (!moveItem(comp, from, L.inv(p), { actor: p, quiet: true }).ok) moveItem(comp, from, ground, { actor: p, quiet: true, force: true });
  }
  consumeItem(craft, where);
  host.message(`You take the ${craft.baseName()} apart and recover its components.`);
  return true;
}

// ------------------------------------------------------------------ craft queue
export interface QueuedCraft {
  id: number;
  recipe: RecipeDef;
  batch: number;
}

/**
 * Several crafts in a row, each a normal timed craft started when the previous one finishes.
 * An interrupted or impossible craft pauses the queue (entries stay; `resume()` goes on).
 */
export class CraftQueue {
  readonly entries: QueuedCraft[] = [];
  running = false;
  /** The queue entry being crafted now. */
  current: QueuedCraft | null = null;
  private seq = 1;
  readonly listeners = new Set<() => void>();
  constructor(private readonly host: CraftHost) {
    craftedHooks.push((r) => this.finished(r));
    craftStoppedHooks.push((r, why) => this.stopped(r, why));
  }
  private changed(): void {
    for (const l of this.listeners) l();
  }
  add(recipe: RecipeDef, batch = 1): QueuedCraft {
    const e = { id: this.seq++, recipe, batch };
    this.entries.push(e);
    this.changed();
    return e;
  }
  remove(id: number): void {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i >= 0) this.entries.splice(i, 1);
    this.changed();
  }
  clear(): void {
    this.entries.length = 0;
    this.running = false;
    this.changed();
  }
  /** Start the next entry if nothing else is going on. */
  resume(): void {
    this.running = true;
    this.next();
  }
  private next(): void {
    if (!this.running) return;
    if (this.host.activities.current) return;
    const e = this.entries.shift();
    if (!e) {
      this.running = false;
      this.current = null;
      this.changed();
      return;
    }
    this.current = e;
    this.changed();
    const r = startCraft(this.host, e.recipe, { batch: e.batch });
    if (!r.ok) {
      // put it back at the front and wait for the player
      this.entries.unshift(e);
      this.current = null;
      this.running = false;
      this.changed();
    }
  }
  private finished(r: RecipeDef): void {
    if (!this.current || this.current.recipe !== r) return;
    this.current = null;
    this.changed();
    // after the completing activity has cleared
    queueMicrotask(() => this.next());
  }
  private stopped(r: RecipeDef, _why: string): void {
    if (!this.current || this.current.recipe !== r) return;
    this.current = null;
    this.running = false;
    this.changed();
  }
}

const queues = new WeakMap<CraftHost, CraftQueue>();
export function craftQueue(host: CraftHost): CraftQueue {
  let q = queues.get(host);
  if (!q) queues.set(host, (q = new CraftQueue(host)));
  return q;
}

// ------------------------------------------------------------------ misc
/** Find a recipe by id or by result item id (first recipe for that item). */
export function findRecipe(data: GameData, idOrResult: string): RecipeDef | undefined {
  return recipeIndex(data).get(idOrResult) ?? data.recipes.find((r) => r.result === idOrResult);
}

/** Learn every craftable recipe (debug). */
export function learnAll(c: Character): number {
  let n = 0;
  for (const r of c.data.recipes) if (isCraftRecipe(r) && learnRecipe(c, r.id)) n++;
  return n;
}

/** Learn a profession's recipes (for character creation). BN has no proficiencies. */
export function applyProfessionKnowledge(c: Character, professionId: string): void {
  const prof = c.data.misc.profession?.[professionId];
  if (!prof) throw new Error(`unknown profession ${professionId}`);
  for (const id of asArray(prof.recipes as string[] | undefined)) learnRecipe(c, id);
}

/** BN to_string(time_duration): "45 minutes", "1 hour and 30 minutes", "2 days and 3 hours". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (s < 60) return unit(s, 'second');
  const m = Math.floor(s / 60);
  if (m < 60) return unit(m, 'minute');
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return mm ? `${unit(h, 'hour')} and ${unit(mm, 'minute')}` : unit(h, 'hour');
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `${unit(d, 'day')} and ${unit(hh, 'hour')}` : unit(d, 'day');
}
