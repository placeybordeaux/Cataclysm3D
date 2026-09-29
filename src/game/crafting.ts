import type { GameData, RecipeDef, RequirementData } from '../data/types';
import { autoStoreLiquid } from './liquid';
import { expandItemGroup } from '../data/itemgroups';
import type { GameMap } from '../world/map';
import type { GameClock } from '../core/time';
import type { ActivityManager } from './activity';
import type { Character } from './character';
import type { PlayerAvatar } from './player';
import { CraftingInventory } from './crafting_inv';
import { asArray, countByCharges, createItem, fromSpawned, Item } from './item';
import { consumeRequirements, evaluateRequirements, itemDisplayName, type RequirementEval } from './requirements';
import { cddaText } from './units';

// Crafting (crafting.cpp, recipe.cpp, character_crafting.cpp), simplified for real time:
//  - which recipes you know: autolearn once skills are met, learned (books/profession/
//    memorized), or readable right now from an identified book in reach;
//  - whether you can craft one: tools/qualities/components from the CraftingInventory
//    (inventory + ground + furniture + fire), required proficiencies, and light;
//  - crafting is an activity: components are consumed up front (CDDA does too), the CDDA
//    success roll picks failure points where components can be destroyed and progress lost,
//    the primary skill is practiced as the work progresses, and results land in your
//    inventory (or on the ground when they don't fit).

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
/**
 * Whether there's enough light to do fine work at the player's tile. Uses a shared
 * `lightAt(x, y, z)` (CDDA light units; ~>= 4 is "bright enough") when the world/vision
 * system provides one on the game or map; otherwise a local estimate: daylight above
 * ground, or a light source (fire, lamp furniture, a lit carried item) close by.
 */
export function hasCraftingLight(host: CraftHost): boolean {
  const p = host.player;
  const x = Math.floor(p.x), y = Math.floor(p.y), z = p.z;
  const la = ((host as any).lightAt ?? (host.map as any).lightAt) as ((x: number, y: number, z: number) => number) | undefined;
  if (typeof la === 'function') return la.call((host as any).lightAt ? host : host.map, x, y, z) >= 4;
  for (const it of p.inv.allItems()) if (Number(it.def.light ?? 0) > 0 && (it.active || it.typeId.endsWith('_on') || it.typeId.endsWith('_lit'))) return true;
  const R = 5;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const tx = x + dx, ty = y + dy;
      if (host.map.fieldsAt(tx, ty, z).some((f) => f.type === 'fd_fire')) return true;
      if ((host.map.furnAt(tx, ty, z).light_emitted ?? 0) > 0 || (host.map.terAt(tx, ty, z).light_emitted ?? 0) > 0) return true;
    }
  }
  const h = host.clock.hourOfDay;
  return z >= 0 && h >= 6 && h < 20;
}

// ------------------------------------------------------------------ knowledge
const DEFAULT_PROF = { time: 2, penalty: 1 };

export interface RecipeProficiency {
  proficiency: string;
  required?: boolean;
  time_multiplier?: number;
  skill_penalty?: number;
}

export function recipeProficiencies(r: { proficiencies?: unknown[] }): RecipeProficiency[] {
  return (r.proficiencies ?? []) as RecipeProficiency[];
}

/** Skills a recipe needs to be autolearned (CDDA: primary at difficulty + skills_required). */
export function autolearnRequirements(r: RecipeDef): [string, number][] | null {
  if (!r.autolearn) return null;
  if (Array.isArray(r.autolearn)) return r.autolearn;
  const out: [string, number][] = [];
  if (r.skill_used) out.push([r.skill_used, r.difficulty ?? 0]);
  for (const s of r.skills_required ?? []) out.push(s);
  return out;
}

export function meetsSkills(c: Character, reqs: [string, number][]): boolean {
  return reqs.every(([s, l]) => c.getSkill(s) >= l);
}

/** Craftable-recipe candidates: real results, not practice/blueprint entries. */
export function isCraftRecipe(r: RecipeDef): boolean {
  return !!r.result && r.category !== 'CC_BUILDING' && r.category !== 'CC_PRACTICE' && r.category !== 'CC_CAMP' && !r.flags?.includes('SECRET');
}

/** Recipe known from memory: learned, or autolearn skills met. */
export function knowsRecipe(c: Character, r: RecipeDef): boolean {
  if (c.learnedRecipes.has(r.id)) return true;
  const req = autolearnRequirements(r);
  return !!req && meetsSkills(c, req);
}

export function learnRecipe(c: Character, id: string): boolean {
  if (c.learnedRecipes.has(id)) return false;
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
/** book item id -> recipes it teaches (from recipes' book_learn, list or object form). */
export function bookRecipeIndex(data: GameData): Map<string, BookRecipe[]> {
  let idx = bookIndexCache.get(data);
  if (idx) return idx;
  idx = new Map();
  for (const r of data.recipes) {
    const bl = r.book_learn as unknown;
    if (!bl || r.never_learn) continue;
    const add = (book: string, level: number | undefined, name?: string) => {
      const l = idx!.get(book) ?? [];
      l.push({ recipe: r, level: level === undefined || level < 0 ? r.difficulty : level, name });
      idx!.set(book, l);
    };
    if (Array.isArray(bl)) for (const e of bl as [string, number?][]) add(e[0], e[1]);
    else for (const [book, v] of Object.entries(bl as Record<string, { skill_level?: number; recipe_name?: string }>)) add(book, v.skill_level, v.recipe_name);
  }
  bookIndexCache.set(data, idx);
  return idx;
}

/** Recipes a book lets `c` craft right now (identified + enough skill), item::get_available_recipes. */
export function bookAvailableRecipes(c: Character, bookId: string): BookRecipe[] {
  if (!c.identifiedBooks.has(bookId)) return [];
  return (bookRecipeIndex(c.data).get(bookId) ?? []).filter((br) => c.getSkill(br.recipe.skill_used ?? '') >= br.level || !br.recipe.skill_used);
}

export interface KnownRecipe {
  recipe: RecipeDef;
  /** 'memory' or the book item id it's being read from. */
  source: 'memory' | string;
}

/** Everything `c` can currently attempt: memory + identified books in the crafting inventory. */
export function availableRecipes(c: Character, inv: CraftingInventory): KnownRecipe[] {
  const out = new Map<string, KnownRecipe>();
  for (const r of c.data.recipes) if (isCraftRecipe(r) && knowsRecipe(c, r)) out.set(r.id, { recipe: r, source: 'memory' });
  for (const s of inv.sources) {
    if (!s.item.isBook()) continue;
    for (const br of bookAvailableRecipes(c, s.item.typeId)) if (!out.has(br.recipe.id) && isCraftRecipe(br.recipe)) out.set(br.recipe.id, { recipe: br.recipe, source: s.item.typeId });
  }
  return [...out.values()];
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
/** CDDA "nested_category" recipe groups ("bows", "spears" …) shown as expandable entries. */
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
  // CDDA recipe names like "%s in jar" put the result's name in the %s.
  if (n) return n.includes('%s') ? n.replace('%s', itemDisplayName(data, r.result)) : n;
  return itemDisplayName(data, r.result);
}

/** Recipe requirements incl. step tools (top-level tools/qualities already hold the union). */
export function recipeRequirements(r: RecipeDef): RequirementData {
  return { components: r.components ?? [], tools: r.tools ?? [], qualities: r.qualities ?? [] };
}

export interface CraftCheck {
  ok: boolean;
  /** Blocking problems, CDDA wording where possible. */
  missing: string[];
  req: RequirementEval;
  light: boolean;
  missingProficiencies: string[];
}

export function craftingInventory(host: CraftHost): CraftingInventory {
  const p = host.player;
  return CraftingInventory.gather(host.data, p, host.map, { x: p.x, y: p.y, z: p.z });
}

export function canCraft(host: CraftHost, r: RecipeDef, batch = 1, inv = craftingInventory(host), lit?: boolean): CraftCheck {
  const c = host.player;
  const req = evaluateRequirements(host.data, recipeRequirements(r), inv, batch);
  const missing = [...req.missing];
  const missingProficiencies = recipeProficiencies(r)
    .filter((p) => p.required && !c.proficiencies.has(p.proficiency))
    .map((p) => cddaText(host.data.misc.proficiency?.[p.proficiency]?.name) || p.proficiency);
  if (missingProficiencies.length) missing.push(`Missing required proficiencies: ${missingProficiencies.join(', ')}`);
  const light = r.flags?.includes('BLIND_EASY') || r.flags?.includes('BLIND_HARD') ? true : (lit ?? hasCraftingLight(host));
  if (!light) missing.push("You can't see to craft!");
  return { ok: missing.length === 0, missing, req, light, missingProficiencies };
}

// ------------------------------------------------------------------ time & success
function profMalus(data: GameData, c: Character, p: RecipeProficiency): number {
  if (p.required || c.proficiencies.has(p.proficiency)) return 1;
  const def = data.misc.proficiency?.[p.proficiency];
  const m = p.time_multiplier ?? def?.default_time_multiplier ?? DEFAULT_PROF.time;
  return m > 1 ? m : 1;
}

/** recipe::batch_info.apply: logistic [rscale%, rsize] or {mode: linear, setup}. */
export function batchTime(time: number, batch: number, factors: unknown): number {
  if (batch <= 1 || !factors) return time * batch;
  if (Array.isArray(factors)) {
    const rscale = (factors[0] ?? 0) / 100, rsize = factors[1] ?? 0;
    if (rscale === 0 || rsize <= 0) return time * batch;
    const scale = rsize / 6;
    let t = 0;
    for (let x = 0; x < batch; x++) t += time * (1 - rscale * (2 / (1 + Math.exp(-(x / scale))) - 1));
    return t;
  }
  const f = factors as { mode?: string; setup?: number | string; max_batch?: number };
  if (f.mode === 'linear') {
    const off = Math.min(time, Number(f.setup) || 0);
    const reps = Math.ceil(batch / (f.max_batch ?? batch));
    return reps * off + batch * (time - off);
  }
  return time * batch;
}

/** Seconds to craft `batch` of `r` (recipe::batch_time without assistants/tool speeds). */
export function craftTime(c: Character, r: RecipeDef, batch = 1): number {
  const data = c.data;
  let total: number;
  if (r.steps?.length) {
    total = 0;
    for (const s of r.steps) {
      let t = s.time;
      for (const p of recipeProficiencies(s)) t *= profMalus(data, c, p);
      total += batchTime(t, batch, s.batch_time_factors);
    }
  } else {
    let t = r.time;
    for (const p of recipeProficiencies(r)) t *= profMalus(data, c, p);
    total = batchTime(t, batch, r.batch_time_factors);
  }
  // morale_crafting_speed_multiplier: sadness slows hard work.
  const morale = c.morale.level();
  if (morale < 0) {
    let mult = Math.max(1, (2 * r.difficulty) / Math.max(1, c.getSkill(r.skill_used ?? '')));
    for (const [s, l] of r.skills_required ?? []) mult *= Math.max(1, (2 * l) / Math.max(1, c.getSkill(s)));
    total *= 1 + (mult * morale) / -50;
  }
  return Math.max(1, Math.round(total));
}

/** Character::get_recipe_weighted_skill_average (+int/4, - missing proficiency penalties). */
export function weightedSkill(c: Character, r: RecipeDef): number {
  let secTotal = 0, secDiff = 0;
  for (const [s, l] of r.skills_required ?? []) {
    secTotal += c.getSkill(s) * l;
    secDiff += l;
  }
  const primary = r.skill_used ? c.getSkill(r.skill_used) : 10;
  const d = Math.max(r.difficulty, 1);
  let avg = (2 * d * primary + secTotal) / Math.max(1, 2 * d + secDiff);
  avg += c.int / 4;
  for (const p of recipeProficiencies(r)) {
    if (p.required || c.proficiencies.has(p.proficiency)) continue;
    avg -= p.skill_penalty ?? c.data.misc.proficiency?.[p.proficiency]?.default_skill_penalty ?? DEFAULT_PROF.penalty;
  }
  return avg;
}

export interface RollData {
  center: number;
  stddev: number;
  finalDifficulty: number;
}

/** Character::recipe_success_roll_data (no helpers). */
export function successRollData(c: Character, r: RecipeDef): RollData {
  const center = weightedSkill(c, r);
  let secLevels = 0, secSq = 0;
  for (const [, l] of r.skills_required ?? []) {
    secLevels += l;
    secSq += l * l;
  }
  const fd = (2 * r.difficulty * r.difficulty + secSq) / Math.max(1, 2 * r.difficulty + secLevels);
  let sd = 2;
  if (fd > center) sd += (fd - center) / 3;
  if (fd < center) sd -= Math.min((center - fd) / 4, 1);
  return { center, stddev: Math.max(sd, 1), finalDifficulty: fd + 1 };
}

function normalRoll(rng: () => number, mean: number, sd: number): number {
  const u = Math.max(1e-12, rng()), v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Probability that a normal(mean, sd) roll exceeds `x`. */
function normalChanceAbove(mean: number, sd: number, x: number): number {
  const z = (x - mean) / (sd * Math.SQRT2);
  // Abramowitz-Stegun erf approximation; plenty for a UI percentage.
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 - erf);
}

/** Chance the whole craft goes without a single mishap (recipe_success_chance). */
export function successChance(c: Character, r: RecipeDef): number {
  const d = successRollData(c, r);
  return normalChanceAbove(d.center, d.stddev, 1 + d.finalDifficulty);
}

/** crafting_success_roll: >= 1 means no failure; otherwise the fraction of progress where one happens. */
export function craftingSuccessRoll(c: Character, r: RecipeDef): number {
  const d = successRollData(c, r);
  return Math.max(Math.max(normalRoll(() => c.rng.next(), d.center, d.stddev), 0) - d.finalDifficulty, 0);
}

/** crafting_failure_roll: chance (0..1+) to save each component when a mishap happens. */
function craftingFailureRoll(c: Character, r: RecipeDef): number {
  const d = successRollData(c, r);
  return Math.max(normalRoll(() => c.rng.next(), d.center, d.stddev * 0.5), 0);
}

// ------------------------------------------------------------------ results
/** recipe::create_result(s) for a batch: result_mult, charges, liquid containers. */
export function createResults(data: GameData, r: RecipeDef, batch = 1): Item[] {
  const def = data.items[r.result];
  if (!def) throw new Error(`recipe ${r.id}: unknown result ${r.result}`);
  const mult = (r.result_mult ?? 1) * batch;
  const out: Item[] = [];
  if (countByCharges(def)) {
    const it = createItem(data, r.result);
    it.charges = (r.charges ?? it.charges ?? 1) * mult;
    out.push(it);
  } else {
    for (let i = 0; i < mult; i++) {
      const it = createItem(data, r.result);
      if (r.charges !== undefined && (def.max_charges ?? 0) > 0) it.charges = r.charges;
      out.push(it);
    }
  }
  const container = r.container as string | undefined;
  if (container && data.items[container]) {
    return out.map((it) => {
      const cont = createItem(data, container);
      const left = cont.put(it);
      if (left) throw new Error(`recipe ${r.id}: result doesn't fit its container ${container}`);
      return cont;
    });
  }
  return out;
}

export function createByproducts(data: GameData, r: RecipeDef, batch: number, rng: import('../core/rng').Rng): Item[] {
  const out: Item[] = [];
  for (const [id, n] of r.byproducts ?? []) {
    if (!data.items[id]) continue;
    out.push(...fromSpawned(data, { id, count: n * batch } as any));
  }
  if (r.byproduct_group) for (let i = 0; i < batch; i++) for (const s of expandItemGroup(data, r.byproduct_group, rng)) out.push(...fromSpawned(data, s));
  return out;
}

/**
 * Put freshly made items with the character: liquids into a container that fits (carried,
 * then nearby), others stashed, wielded if hands are free, else dropped at their feet.
 * (CDDA's spawn_items / liquid_handler, simplified.)
 */
/**
 * What to do with a crafted liquid that no carried closed container took (CDDA
 * liquid_handler's "drink / pour into / pour out" menu). Set by the UI (src/ui/liquid_ui.ts);
 * null = decide without asking (tests, headless): fill any container around, then the ground.
 */
export const liquidHooks: { handle: ((host: CraftHost, liquid: Item) => void) | null } = { handle: null };

export function giveOrDrop(host: CraftHost, items: Item[], inv?: CraftingInventory): void {
  const p = host.player;
  const tx = Math.floor(p.x), ty = Math.floor(p.y);
  for (const it of items) {
    if (it.isLiquid() && liquidHooks.handle) {
      const left = autoStoreLiquid(host, it);
      if (left) liquidHooks.handle(host, left);
      continue;
    }
    if (it.isLiquid()) {
      // Closed containers (bottles, jugs) before open ones (pots) so boiled water doesn't
      // end up in the cooking pot.
      const holders = [...p.inv.allItems(), ...(inv?.sources.filter((s) => s.kind === 'map').map((s) => s.item) ?? [])].sort(
        (a, b) => Number(a.containerPockets().some((pk) => pk.data.open_container)) - Number(b.containerPockets().some((pk) => pk.data.open_container)),
      );
      let left: Item | null = it;
      for (const h of holders) {
        if (!left) break;
        if (h === left || !h.containerPockets().some((pk) => pk.data.watertight)) continue;
        if (h.containerPockets().some((pk) => pk.contents.some((c) => c.typeId !== left!.typeId))) continue;
        left = h.put(left);
      }
      if (left) {
        host.map.addItem(tx, ty, p.z, left);
        host.message(`You don't have a container for the ${left.name()}, so you pour it onto the ground.`, 'c_yellow');
      }
      continue;
    }
    const tooHeavy = p.inv.weightCarried() + it.weight() > p.inv.weightCapacity() * 4;
    if (!tooHeavy && p.inv.canStash(it)) p.inv.stash(it);
    else if (!tooHeavy && !p.inv.wielded && p.inv.canWield(it).ok && items.length === 1) {
      p.inv.wielded = it;
      host.message(`You wield your ${it.name()}.`);
    } else {
      host.map.addItem(tx, ty, p.z, it);
      host.message(`You put the ${it.name()} on the ground.`);
    }
  }
}

// ------------------------------------------------------------------ crafting
export interface CraftOptions {
  batch?: number;
  /** Skip the activity and finish at once (tests, debug). */
  instant?: boolean;
}

export interface CraftResult {
  ok: boolean;
  msg: string;
}

/** Items that were eaten by the craft; handed back on cancel. */
interface CraftInProgress {
  recipe: RecipeDef;
  batch: number;
  components: Item[];
  nextFailure: number;
  practiced: number;
}

/**
 * Start crafting `r`: check, consume components and tool charges, then run the activity.
 * Returns immediately; the result appears when the activity completes.
 */
/**
 * Called after a craft finishes and its results were handed out (progression: lifetime
 * crafted counts, "you could craft" nudges skip recipes already made). Listeners must not throw.
 */
export const craftedHooks: ((r: RecipeDef, batch: number) => void)[] = [];

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
  const fromMemory = knowsRecipe(c, r);
  const { items } = consumeRequirements(recipeRequirements(r), inv, batch);
  const craft: CraftInProgress = { recipe: r, batch, components: items, nextFailure: craftingSuccessRoll(c, r), practiced: 0 };
  const duration = craftTime(c, r, batch);
  const nominal = r.steps?.length ? r.steps.reduce((t, s) => t + s.time, 0) : r.time;
  const cap = Math.floor(r.difficulty * 1.25);

  const finish = () => {
    practiceTo(1);
    const results = createResults(host.data, r, batch);
    const byproducts = createByproducts(host.data, r, batch, c.rng);
    giveOrDrop(host, [...results, ...byproducts], craftingInventory(host));
    for (const hk of craftedHooks) hk(r, batch);
    if (fromMemory) host.message(`You craft ${name} from memory.`);
    else {
      host.message(`You craft ${name} using a reference.`);
      // CDDA: crafting from a book can commit it to memory (time_to_learn in moves).
      const learnSpeed = Math.max(c.getSkill(r.skill_used ?? ''), 1) * Math.max(c.int, 1);
      const timeToLearn = (1000 * 8 * r.difficulty ** 4) / learnSpeed;
      if (c.rng.next() * timeToLearn < r.time * 100 && learnRecipe(c, r.id)) host.message(`You memorized the recipe for ${name}!`, 'c_light_green');
    }
  };
  // Practice ticks = nominal seconds of work, spread across progress (activity_actor.cpp).
  const practiceTo = (fraction: number) => {
    if (!r.skill_used) return;
    const target = Math.floor(nominal * fraction);
    const ticks = target - craft.practiced;
    if (ticks <= 0) return;
    craft.practiced = target;
    const before = c.getSkill(r.skill_used);
    c.practice(r.skill_used, ticks, cap);
    if (c.getSkill(r.skill_used) === before && before > cap && craft.practiced === target && fraction >= 1)
      host.message(`You feel that ${c.skillName(r.skill_used)} tasks of this level are becoming trivial.`, 'c_light_gray');
  };
  const failure = (): boolean => {
    const roll = craftingFailureRoll(c, r);
    const maxDestroyed = Math.max(1, Math.floor((craft.components.length * 3) / 4));
    for (let i = 0; i < maxDestroyed && craft.components.length; i++) {
      if (c.rng.next() < roll) continue;
      const k = Math.floor(c.rng.next() * craft.components.length);
      const [lost] = craft.components.splice(k, 1);
      host.message(`You mess up and destroy the ${lost.name()}.`, 'c_light_red');
    }
    return items.length > 0 && craft.components.length === 0;
  };

  if (opts.instant) {
    finish();
    return { ok: true, msg: `You craft ${name}.` };
  }
  host.message(`You start working on the ${name}.`);
  const started = host.activities.start({
    name: `crafting ${name}`,
    duration,
    onProgress: (_dt, fraction) => {
      practiceTo(fraction);
      if (fraction < craft.nextFailure || fraction >= 1) return;
      if (failure()) {
        craft.components = [];
        host.activities.cancel(`You fail to make the ${name}, and all components are ruined.`);
        return;
      }
      const act = host.activities.current;
      const success = craftingSuccessRoll(c, r);
      const loss = (0.25 + -Math.log(Math.max(1e-9, c.rng.next())) * 0.1) * (1 - Math.min(1, success));
      if (act && loss > 0) {
        const lost = act.elapsed * loss;
        act.elapsed -= lost;
        host.message(`You mess up and lose ${Math.round((lost / duration) * 100)}% progress.`, 'c_yellow');
      }
      craft.nextFailure = (act?.fraction ?? fraction) + success;
    },
    onComplete: finish,
    onCancel: () => {
      // No partial "in progress" items: hand the components back.
      if (craft.components.length) giveOrDrop(host, craft.components, craftingInventory(host));
      craft.components = [];
    },
  });
  if (!started) {
    giveOrDrop(host, craft.components, inv);
    return { ok: false, msg: 'Interrupted.' };
  }
  return { ok: true, msg: `You start working on the ${name}.` };
}

/** Find a recipe by id or by result item id (first recipe for that item). */
export function findRecipe(data: GameData, idOrResult: string): RecipeDef | undefined {
  return data.recipes.find((r) => r.id === idOrResult) ?? data.recipes.find((r) => r.result === idOrResult);
}

/** Learn every craftable recipe (debug). */
export function learnAll(c: Character): number {
  let n = 0;
  for (const r of c.data.recipes) if (isCraftRecipe(r) && learnRecipe(c, r.id)) n++;
  return n;
}

/** Learn a profession's recipes and proficiencies (for character creation). */
export function applyProfessionKnowledge(c: Character, professionId: string): void {
  const prof = c.data.misc.profession?.[professionId];
  if (!prof) throw new Error(`unknown profession ${professionId}`);
  for (const id of asArray(prof.recipes as string[] | undefined)) learnRecipe(c, id);
  for (const p of asArray(prof.proficiencies as string[] | undefined)) c.proficiencies.add(p);
}

/** CDDA to_string(time_duration): "45 minutes", "1 hour and 30 minutes", "2 days and 3 hours". */
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
