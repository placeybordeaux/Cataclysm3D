import type { GameData, RecipeDef, RequirementData } from '../data/types';
import { CraftingInventory } from './crafting_inv';
import { giveOrDrop, hasCraftingLight, learnRecipe, type CraftHost } from './crafting';
import { createItem, countByCharges, Item } from './item';
import { evaluateRequirements, itemDisplayName, type RequirementEval } from './requirements';

// Disassembly (crafting.cpp complete_disassemble, recipe_dictionary.cpp): an item can be
// taken apart if misc.uncraft has a recipe for it, or a recipe that makes it is
// "reversible". Tools and qualities of the recipe are needed (with CDDA's replacements:
// welders/forges become fine metal sawing, sewing becomes cutting); components come back
// minus "no_recover" ones, each rolled against skill and item damage.

const uncraftCache = new WeakMap<GameData, Map<string, RecipeDef>>();

/** item id -> the recipe used to take it apart. */
export function uncraftIndex(data: GameData): Map<string, RecipeDef> {
  let idx = uncraftCache.get(data);
  if (idx) return idx;
  idx = new Map();
  for (const [id, r] of Object.entries((data.misc.uncraft ?? {}) as Record<string, RecipeDef>)) idx.set(r.result ?? id, r);
  for (const r of data.recipes) {
    if (!r.reversible || !r.result || idx.has(r.result)) continue;
    const t = typeof r.reversible === 'object' && r.reversible.time ? r.reversible.time : r.time;
    idx.set(r.result, { ...r, time: t, uncraftOf: r.id } as RecipeDef);
  }
  uncraftCache.set(data, idx);
  return idx;
}

export function uncraftRecipe(data: GameData, itemId: string): RecipeDef | undefined {
  return uncraftIndex(data).get(itemId);
}

const TOOL_TO_QUALITY: Record<string, { id: string; level: number } | null> = {
  welder: { id: 'SAW_M_FINE', level: 1 },
  welder_crude: { id: 'SAW_M_FINE', level: 1 },
  oxy_torch: { id: 'SAW_M_FINE', level: 1 },
  forge: { id: 'SAW_M_FINE', level: 1 },
  char_forge: { id: 'SAW_M_FINE', level: 1 },
  crucible: null,
  press: { id: 'PULL', level: 1 },
};

/** requirement_data::disassembly_requirements. */
export function disassemblyRequirements(data: GameData, r: RecipeDef): RequirementData {
  const newQ: { id: string; level: number }[] = [];
  let removeFire = false;
  const tools = (r.tools ?? [])
    .filter((grp) => {
      for (const t of grp) {
        if (t.id in TOOL_TO_QUALITY) {
          const q = TOOL_TO_QUALITY[t.id];
          if (q) newQ.push(q);
          if (t.id === 'press') removeFire = true;
          return false;
        }
        if (t.id === 'fire' && removeFire) return false;
      }
      return true;
    })
    // Disassembly never burns tool charges: just the tool's presence is required.
    .map((grp) => grp.map((t) => ({ ...t, count: -1 })));
  const qualities = (r.qualities ?? []).filter((grp) => {
    for (const q of grp) {
      if (q.id === 'SEW') {
        newQ.push({ id: 'CUT', level: q.level });
        return false;
      }
      if (q.id === 'GLARE' || q.id === 'KNIT') return false;
    }
    return true;
  });
  for (const q of newQ) if (!qualities.some((g) => g.some((x) => x.id === q.id))) qualities.push([q]);
  const components = (r.components ?? [])
    .map((grp) => grp.filter((c) => !c.no_recover && !data.items[c.id]?.flags?.includes('UNRECOVERABLE')))
    .filter((grp) => grp.length > 0);
  return { tools, qualities, components };
}

/** What taking one `itemId` apart yields: the first alternative of each component group. */
export function disassemblyYield(data: GameData, r: RecipeDef): { id: string; count: number }[] {
  const req = disassemblyRequirements(data, r);
  return req.components.map((grp) => ({ id: grp[0].id, count: Math.max(1, Math.abs(grp[0].count)) }));
}

export interface DisassemblyCheck {
  ok: boolean;
  missing: string[];
  req: RequirementEval;
}

export function canDisassemble(host: CraftHost, it: Item, inv?: CraftingInventory): DisassemblyCheck {
  const r = uncraftRecipe(host.data, it.typeId);
  const p = host.player;
  inv ??= CraftingInventory.gather(host.data, p, host.map, { x: p.x, y: p.y, z: p.z });
  const req = evaluateRequirements(host.data, r ? { tools: disassemblyRequirements(host.data, r).tools, qualities: disassemblyRequirements(host.data, r).qualities } : {}, inv);
  const missing = r ? [...req.missing] : [`You cannot disassemble this.`];
  if (it.containerPockets().some((pk) => pk.contents.length)) missing.push('You must empty it first.');
  if (it.countByCharges && r && it.charges < (r.charges ?? 1)) missing.push(`You need at least ${r.charges} charges.`);
  if (!hasCraftingLight(host)) missing.push("You can't see to craft!");
  return { ok: missing.length === 0, missing, req };
}

/** Candidates for the `(` menu: carried items and items within reach that have an uncraft recipe. */
export function disassemblables(host: CraftHost): { item: Item; where: 'inv' | [number, number, number] }[] {
  const p = host.player;
  const out: { item: Item; where: 'inv' | [number, number, number] }[] = [];
  const idx = uncraftIndex(host.data);
  for (const it of p.inv.carried()) if (idx.has(it.typeId)) out.push({ item: it, where: 'inv' });
  if (p.inv.wielded && idx.has(p.inv.wielded.typeId)) out.push({ item: p.inv.wielded, where: 'inv' });
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = Math.floor(p.x) + dx, y = Math.floor(p.y) + dy;
      for (const mi of host.map.itemsAt(x, y, p.z)) if (mi instanceof Item && idx.has(mi.typeId)) out.push({ item: mi, where: [x, y, p.z] });
    }
  return out;
}

/** Remove the item from the inventory or the map tile it lies on. */
function takeItem(host: CraftHost, it: Item, r: RecipeDef): boolean {
  const p = host.player;
  // Stacks (ammo, charges) are disassembled `r.charges` at a time.
  const per = it.countByCharges ? (r.charges ?? 1) : 0;
  if (per > 0 && it.charges > per) {
    it.split(per);
    return true;
  }
  if (p.inv.remove(it)) return true;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) if (host.map.removeItem(Math.floor(p.x) + dx, Math.floor(p.y) + dy, p.z, it)) return true;
  return false;
}

/** complete_disassemble: roll each component against skill and damage, then hand them out. */
export function finishDisassembly(host: CraftHost, it: Item, r: RecipeDef): Item[] {
  const c = host.player, data = host.data;
  const skill = r.skill_used ?? '';
  const skillDice = 2 + Math.round(c.getSkill(skill) * 4), skillSides = 16 + c.int;
  const diffDice = r.difficulty ?? 0, diffSides = 24;
  if (skill) c.practice(skill, (r.difficulty ?? 0) * 2, r.difficulty ?? 0);
  const dmgChance = Math.pow(0.8, it.damageLevel());
  const recovered = new Map<string, number>(), lost = new Map<string, number>();
  const out: Item[] = [];
  for (const { id, count } of disassemblyYield(data, r)) {
    if (!data.items[id]) continue;
    const byCharges = countByCharges(data.items[id]);
    // Charge-counted components are one roll for the whole amount, like CDDA's single item.
    const units = byCharges ? [count] : Array(count).fill(1);
    for (const n of units) {
      const ok = (diffDice === 0 || c.rng.dice(skillDice, skillSides) > c.rng.dice(diffDice, diffSides)) && dmgChance > c.rng.next();
      (ok ? recovered : lost).set(id, ((ok ? recovered : lost).get(id) ?? 0) + n);
      if (ok) out.push(createItem(data, id, byCharges ? { charges: n } : {}));
    }
  }
  for (const [id, n] of lost) host.message(`You fail to recover ${n} ${itemDisplayName(data, id, n)}.`, 'c_light_red');
  for (const [id, n] of recovered) host.message(`You recover ${n} ${itemDisplayName(data, id, n)}.`, 'c_light_green');
  const learnId = (r as { uncraftOf?: string }).uncraftOf;
  if (learnId && (r as { decomp_learn?: number }).decomp_learn !== undefined && !c.learnedRecipes.has(learnId) && c.getSkill(skill) >= Number((r as any).decomp_learn) && c.rng.oneIn(4)) {
    learnRecipe(c, learnId);
    host.message(`You learned a recipe for ${it.baseName()} from disassembling it!`, 'c_light_green');
  }
  return out;
}

/** Start disassembling `it`: an activity of the uncraft recipe's time. */
export function startDisassembly(host: CraftHost, it: Item, opts: { instant?: boolean } = {}): boolean {
  const r = uncraftRecipe(host.data, it.typeId);
  const check = canDisassemble(host, it);
  if (!r || !check.ok) {
    host.message(check.missing.join(' ') || 'You cannot disassemble this.', 'c_light_red');
    return false;
  }
  const done = () => {
    if (!takeItem(host, it, r)) {
      host.message(`The ${it.name()} is gone.`, 'c_light_red');
      return;
    }
    giveOrDrop(host, finishDisassembly(host, it, r));
  };
  if (opts.instant) {
    done();
    return true;
  }
  return host.activities.start({ name: `disassembling the ${it.baseName()}`, duration: Math.max(1, r.time), onComplete: done });
}
