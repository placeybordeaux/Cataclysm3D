import type { GameData, RecipeDef, RequirementData } from '../data/types';
import { abandonCraft, craftingInventory, craftState, exceedsRecipeRequirements, giveOrDrop, lightSpeedMultiplier, learnRecipe, meetsSkills, recipeIndex, type CraftHost } from './crafting';
import type { CraftingInventory } from './crafting_inv';
import { createItem, countByCharges, inNewContainer, Item } from './item';
import { consumeItem, L, locate, unloadItem, type Loc } from './moves';
import { consumeRequirements, evaluateRequirements, itemDisplayName, type RequirementEval } from './requirements';
import { disassemblyPractice, withPracticeSource } from './practice';

// Disassembly after Bright Nights (crafting.cpp can_disassemble / complete_disassemble,
// recipe_dictionary.cpp): an item comes apart if misc.uncraft has a recipe for it, a recipe that
// makes it is reversible, or it's a book (torn into paper). The tools and qualities of the
// recipe are needed, with BN's replacements (welders/forges → fine metal sawing, sewing →
// cutting, presses → pulling); components come back minus no_recover / UNRECOVERABLE ones,
// each rolled against skill and the item's damage. Contents, magazines and rounds come out
// first. An in-progress craft comes apart into the components it holds.

const uncraftCache = new WeakMap<GameData, Map<string, RecipeDef>>();

/** item id → the recipe used to take it apart (recipe_dictionary uncraft map). */
export function uncraftIndex(data: GameData): Map<string, RecipeDef> {
  let idx = uncraftCache.get(data);
  if (idx) return idx;
  idx = new Map();
  for (const [id, r] of Object.entries((data.misc.uncraft ?? {}) as Record<string, RecipeDef>)) idx.set(r.result ?? id, r);
  for (const r of data.recipes) {
    if (!r.reversible || !r.result || idx.has(r.result)) continue;
    idx.set(r.result, r);
  }
  // Books with no recipe: pages of paper (uncraft_book × volume / 12.5 ml, 10 s a page).
  const book = data.misc.requirement?.uncraft_book as RequirementData | undefined;
  if (book) {
    for (const d of Object.values(data.items)) {
      if (idx.has(d.id) || !d.subtypes?.includes('BOOK') || !(d.volume > 0)) continue;
      const pages = Math.max(1, Math.floor(d.volume / 12.5));
      idx.set(d.id, {
        id: d.id, type: 'uncraft', result: d.id, category: 'CC_NONCRAFT', difficulty: 0, time: pages * 10, autolearn: false, result_mult: 1, contained: false, reversible: true,
        components: book.components.map((g) => g.map((c) => ({ ...c, count: c.count * pages }))), tools: book.tools, qualities: book.qualities,
      });
    }
  }
  uncraftCache.set(data, idx);
  return idx;
}

export function uncraftRecipe(data: GameData, itemId: string): RecipeDef | undefined {
  return uncraftIndex(data).get(itemId);
}

/** requirement_data::disassembly_requirements. */
export function disassemblyRequirements(data: GameData, r: RecipeDef): RequirementData {
  const newQ: { id: string; level: number }[] = [];
  let removeFire = false;
  let pulling = 'none' as 'none' | 'plain' | 'rifle' | 'shell';
  const tools = (r.tools ?? []).filter((grp) => {
    for (const t of grp) {
      const id = t.id;
      if (['welder', 'welder_crude', 'oxy_torch', 'forge', 'char_forge'].includes(id)) return void newQ.push({ id: 'SAW_M_FINE', level: 1 }), false;
      if (id === 'sewing_kit' || id === 'mold_plastic') return void newQ.push({ id: 'CUT', level: 1 }), false;
      if (id === 'crucible') return false;
      if (id === 'press_workbench') return (pulling = 'rifle'), (removeFire = true), false;
      if (id === 'press_dowel') return (pulling = 'shell'), (removeFire = true), false;
      if (id === 'press') return (pulling = 'plain'), (removeFire = true), false;
      if (id === 'fire' && removeFire) return false;
    }
    return true;
  });
  if (pulling === 'shell') newQ.push({ id: 'CUT', level: 1 });
  else if (pulling === 'rifle') newQ.push({ id: 'PULL', level: 2 });
  else if (pulling === 'plain') newQ.push({ id: 'PULL', level: 1 });
  const qualities = (r.qualities ?? [])
    .map((grp) => {
      for (const q of grp) {
        if (q.id === 'SEW') return void newQ.push({ id: 'CUT', level: q.level }), [];
        if (q.id === 'GLARE' || q.id === 'KNIT') return [];
      }
      return grp;
    })
    .filter((g) => g.length);
  for (const q of newQ) if (!qualities.some((g) => g.some((x) => x.id === q.id))) qualities.push([q]);
  const components = (r.components ?? [])
    .map((grp) => grp.filter((c) => !c.no_recover && !data.items[c.id]?.flags?.includes('UNRECOVERABLE')))
    .filter((grp) => grp.length > 0);
  return { tools, qualities, components };
}

/** What taking one apart yields: the first alternative of each component group. */
export function disassemblyYield(data: GameData, r: RecipeDef): { id: string; count: number }[] {
  const req = disassemblyRequirements(data, r);
  return req.components.map((grp) => ({ id: grp[0].id, count: Math.max(1, Math.abs(grp[0].count)) }));
}

/** recipe::disassembly_batch_size: stacks come apart `charges` at a time. */
export function disassemblyBatch(r: RecipeDef): number {
  return Math.max(1, r.charges ?? 1);
}

export interface DisassemblyCheck {
  ok: boolean;
  missing: string[];
  req: RequirementEval;
  /** Seconds it takes. */
  time: number;
}

/** crafting::can_disassemble. */
export function canDisassemble(host: CraftHost, it: Item, inv: CraftingInventory = craftingInventory(host)): DisassemblyCheck {
  const empty = { ok: false, req: evaluateRequirements(host.data, {}, inv), time: 0 };
  if (craftState(host.data, it)) return { ...empty, ok: true, missing: [], time: 1 };
  const r = uncraftRecipe(host.data, it.typeId);
  if (!r || it.hasFlag('ETHEREAL_ITEM')) return { ...empty, missing: ['You cannot disassemble this.'] };
  const need = disassemblyRequirements(host.data, r);
  const req = evaluateRequirements(host.data, { tools: need.tools, qualities: need.qualities }, inv);
  const missing = [...req.missing];
  if (lightSpeedMultiplier(host, r) <= 0) missing.push("You can't see to craft!");
  const food = it.isComestible() ? it : it.contents.find((c) => c.isComestible());
  if (food?.goesBad() && food.rotten()) missing.push("It's rotten, I'm not taking that apart.");
  if (it.countByCharges && it.charges < disassemblyBatch(r)) missing.push(`You need at least ${disassemblyBatch(r)} charges of ${it.baseName(2)}.`);
  return { ok: missing.length === 0, missing, req, time: Math.max(1, r.time) };
}

/** Candidates: carried items and items within reach that can come apart. */
export function disassemblables(host: CraftHost): { item: Item; where: 'inv' | [number, number, number] }[] {
  const p = host.player;
  const out: { item: Item; where: 'inv' | [number, number, number] }[] = [];
  const idx = uncraftIndex(host.data);
  const ok = (it: Item) => idx.has(it.typeId) || !!craftState(host.data, it);
  for (const it of p.inv.carried()) if (ok(it)) out.push({ item: it, where: 'inv' });
  if (p.inv.wielded && ok(p.inv.wielded)) out.push({ item: p.inv.wielded, where: 'inv' });
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = Math.floor(p.x) + dx, y = Math.floor(p.y) + dy;
      for (const mi of host.map.itemsAt(x, y, p.z)) if (mi instanceof Item && ok(mi)) out.push({ item: mi, where: [x, y, p.z] });
    }
  return out;
}

function whereIs(host: CraftHost, it: Item): Loc | null {
  const p = host.player;
  const around: Loc[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) around.push(L.ground(host.map, Math.floor(p.x) + dx, Math.floor(p.y) + dy, p.z));
  return p.inv.locOf(it) ?? locate(it, around);
}

/**
 * complete_disassemble: empty it, use it up (one batch of a stack), roll each component
 * against skill and damage, hand them out, and maybe learn the recipe. Returns what came out.
 */
export function finishDisassembly(host: CraftHost, it: Item, r: RecipeDef): Item[] | null {
  const c = host.player, data = host.data;
  const loc = whereIs(host, it);
  if (!loc) return null;
  const p = host.player;
  const ground = L.ground(host.map, Math.floor(p.x), Math.floor(p.y), p.z);
  // remove_ammo: contents, magazines and loaded rounds come out first.
  if (it.hasContents() || it.magazine || (it.ammoRemaining() > 0 && !it.countByCharges)) unloadItem(it, [L.inv(p), ground], { actor: p, quiet: true, pourLiquids: true });
  const need = disassemblyRequirements(data, r);
  const inv = craftingInventory(host);
  if (need.tools.some((g) => g.some((t) => t.count > 0))) consumeRequirements({ tools: need.tools }, inv);
  host.message(`You disassemble the ${it.name()} into its components.`);
  const batch = it.countByCharges ? disassemblyBatch(r) : undefined;
  if (!consumeItem(it, loc, batch)) return null;

  const skill = r.skill_used ?? '';
  const skillDice = 2 + c.getSkill(skill) * 4, skillSides = 16 + c.int;
  const diffDice = r.difficulty ?? 0;
  // "disassembly only nets a bit of practice": difficulty × 2, capped at the difficulty — so a
  // difficulty-0 uncraft (a toaster) teaches nothing in BN (practiceSettings.simpleTasks adapts it).
  const pr = disassemblyPractice(r);
  if (pr) withPracticeSource(`Disassembling the ${it.baseName()}`, () => c.practice(pr.skill, pr.amount, pr.cap));
  const dmgChance = Math.min(1, Math.pow(0.8, it.damageLevel()));
  const out: Item[] = [];
  for (const { id, count } of disassemblyYield(data, r)) {
    const def = data.items[id];
    if (!def) continue;
    // Charge-counted components (and liquids) come out as one stack, like BN.
    const units = countByCharges(def) ? [count] : Array<number>(count).fill(1);
    for (const n of units) {
      const made = createItem(data, id, countByCharges(def) ? { charges: n } : {});
      if (diffDice !== 0 && c.rng.dice(skillDice, skillSides) <= c.rng.dice(diffDice, 24)) {
        host.message(`You fail to recover ${made.name()}.`, 'c_light_red');
        continue;
      }
      if (!(dmgChance > c.rng.next())) {
        host.message(`You fail to recover ${made.name()} from the ${it.baseName()}.`, 'c_light_red');
        continue;
      }
      if (!made.countByCharges && made.ammoTypes().length) {
        // tools that can be unloaded come apart unloaded
        made.charges = 0;
        made.ammoId = null;
      }
      if (it.flags.includes('FIT') && made.hasFlag('VARSIZE') && !made.flags.includes('FIT')) made.flags.push('FIT');
      if (made.isLiquid() && r.flags?.includes('UNCRAFT_LIQUIDS_CONTAINED') && made.def.container) {
        const { container } = inNewContainer(data, made, made.def.container);
        out.push(container);
      } else out.push(made);
    }
  }
  const got = new Map<string, number>();
  for (const o of out) got.set(o.baseName(), (got.get(o.baseName()) ?? 0) + o.count());
  if (got.size) host.message(`You recover ${[...got].map(([n, k]) => `${k} ${n}`).join(', ')}.`, 'c_light_green');
  giveOrDrop(host, out);

  // decomp_learn: learning the recipe (the one with the uncraft's id) by taking it apart.
  const learnable = recipeIndex(data).get(r.id);
  if (learnable && r.decomp_learn?.length && !c.learnedRecipes.has(learnable.id)) {
    if (meetsSkills(c, r.decomp_learn)) {
      const bonus = (1 + exceedsRecipeRequirements(c, r)) * Math.max(1, 0.9 + c.int * 0.025);
      if (c.rng.next() * 4 < bonus && learnRecipe(c, learnable.id)) host.message(`You learned a recipe for ${it.baseName()} from disassembling it!`, 'c_light_green');
      else host.message(`You might be able to learn a recipe for ${it.baseName()} if you disassemble another.`, 'c_light_gray');
    } else host.message('If you had better skills, you might learn a recipe next time.', 'c_light_gray');
  }
  return out;
}

/** Called after a disassembly finishes (UI refresh). */
export const disassembledHooks: ((itemId: string) => void)[] = [];

/**
 * Start disassembling `it`: an activity of the uncraft recipe's time. `then` queues more after it
 * (BN disassemble_activity_actor's target list: "Disassemble all" of a stack, or more batches of
 * a charges stack — the same item again per extra batch). Each is re-checked when its turn
 * comes; the queue stops at the first one that is gone or can't be done.
 */
export function startDisassembly(host: CraftHost, it: Item, opts: { instant?: boolean; then?: Item[] } = {}): boolean {
  if (craftState(host.data, it)) return abandonCraft(host, it);
  const r = uncraftRecipe(host.data, it.typeId);
  const check = canDisassemble(host, it);
  if (!r || !check.ok) {
    host.message(check.missing.join(' ') || 'You cannot disassemble this.', 'c_light_red');
    return false;
  }
  const rest = opts.then ?? [];
  const done = () => {
    const out = finishDisassembly(host, it, r);
    if (!out) return host.message(`The ${it.baseName()} is gone.`, 'c_light_red');
    for (const h of disassembledHooks) h(it.typeId);
    const [next, ...more] = rest;
    if (!next || !whereIs(host, next) || !canDisassemble(host, next).ok) return;
    startDisassembly(host, next, { instant: opts.instant, then: more });
  };
  if (opts.instant) {
    done();
    return true;
  }
  const left = rest.length ? ` (${rest.length} more after this)` : '';
  return host.activities.start({ name: `disassembling the ${it.baseName()}${left}`, kind: 'disassemble', target: it, customUi: true, duration: check.time, onComplete: done });
}

/**
 * The rest of the stack `it` is in, for "Disassemble all": identical items lying in the same place
 * (what the inventory shows as one row), or — for a charges stack — the same item once per extra
 * batch it holds.
 */
export function disassemblyStack(host: CraftHost, it: Item): Item[] {
  const r = uncraftRecipe(host.data, it.typeId);
  if (!r || craftState(host.data, it)) return [];
  if (it.countByCharges) return Array<Item>(Math.max(0, Math.floor(it.charges / disassemblyBatch(r)) - 1)).fill(it);
  const loc = whereIs(host, it);
  if (!loc) return [];
  const peers: readonly Item[] =
    loc.kind === 'ground' ? (host.map.itemsAt(loc.x, loc.y, loc.z).filter((o) => o instanceof Item) as Item[]) : loc.kind === 'in' ? loc.host.contents : loc.kind === 'inv' ? host.player.inv.carried() : [];
  if (it.hasContents()) return [];
  return peers.filter((o) => o !== it && o.typeId === it.typeId && !o.hasContents() && o.stacksWith(it));
}

/** Display names of what `r` yields ("2 sticks, 1 rag"). */
export function yieldText(data: GameData, r: RecipeDef): string {
  return disassemblyYield(data, r).map((y) => `${y.count} ${itemDisplayName(data, y.id, y.count)}`).join(', ');
}
