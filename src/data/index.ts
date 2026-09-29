// Convenience lookups over GameData. Unknown ids warn once (warn.ts) and return undefined
// rather than throwing: game data may reference mod-only content.

import type { Rng } from '../core/rng';
import type { FurnitureDef, GameData, ItemDef, MonsterDef, MonsterGroupDef, RecipeDef, TerrainDef } from './types';
import { warnOnce } from './warn';

export { warnOnce, warnedIds } from './warn';
export { ammoCapacity, chargesPerVolume, defaultAmmo, expandItemGroup, possibleItems, type SpawnedItem } from './itemgroups';

/** CDDA item::tname-ish: singular for n == 1, plural otherwise. */
export function itemName(def: Pick<ItemDef, 'name' | 'name_plural'>, n = 1): string {
  return n === 1 ? def.name : def.name_plural;
}

/** "3 planks", "plank" */
export function itemCountName(def: Pick<ItemDef, 'name' | 'name_plural'>, n: number): string {
  return n === 1 ? def.name : `${n} ${def.name_plural}`;
}

export function monsterName(def: Pick<MonsterDef, 'name' | 'name_plural'>, n = 1): string {
  return n === 1 ? def.name : def.name_plural;
}

export function getItem(data: GameData, id: string): ItemDef | undefined {
  const d = data.items[id];
  if (!d) warnOnce('item', id);
  return d;
}

export function getMonster(data: GameData, id: string): MonsterDef | undefined {
  const d = data.monsters[id];
  if (!d) warnOnce('monster', id);
  return d;
}

export function getTerrain(data: GameData, id: string): TerrainDef | undefined {
  const d = data.terrain[id];
  if (!d) warnOnce('terrain', id);
  return d;
}

export function getFurniture(data: GameData, id: string): FurnitureDef | undefined {
  const d = data.furniture[id];
  if (!d) warnOnce('furniture', id);
  return d;
}

/** misc lookup, e.g. getMisc(data, 'material', 'wood'), getMisc(data, 'profession', 'unemployed'). */
export function getMisc<T = any>(data: GameData, type: string, id: string): T | undefined {
  const d = data.misc[type]?.[id];
  if (d === undefined) warnOnce(type, id);
  return d as T | undefined;
}

const recipeIndex = new WeakMap<GameData, { byId: Map<string, RecipeDef>; byResult: Map<string, RecipeDef[]> }>();
function recipes(data: GameData) {
  let idx = recipeIndex.get(data);
  if (!idx) {
    idx = { byId: new Map(), byResult: new Map() };
    for (const r of data.recipes) {
      idx.byId.set(r.id, r);
      const l = idx.byResult.get(r.result);
      if (l) l.push(r);
      else idx.byResult.set(r.result, [r]);
    }
    recipeIndex.set(data, idx);
  }
  return idx;
}

export function getRecipe(data: GameData, id: string): RecipeDef | undefined {
  const r = recipes(data).byId.get(id);
  if (!r) warnOnce('recipe', id);
  return r;
}

/** All recipes producing `itemId` (base recipe first, then variants/suffixed ones). */
export function recipesFor(data: GameData, itemId: string): RecipeDef[] {
  return recipes(data).byResult.get(itemId) ?? [];
}

/** Random text from a snippet category (misc.snippet), or undefined. */
export function snippet(data: GameData, category: string, rng: Rng): string | undefined {
  const texts: string[] | undefined = data.misc.snippet?.[category];
  if (!texts?.length) {
    warnOnce('snippet', category);
    return undefined;
  }
  return rng.pick(texts);
}

export interface MonsterSpawn {
  id: string;
  /** pack size rolled from pack_size */
  count: number;
}

export interface MonsterGroupContext {
  /** game seconds since the cataclysm began; entries outside [starts, ends) are skipped */
  elapsed?: number;
  season?: 'SPRING' | 'SUMMER' | 'AUTUMN' | 'WINTER';
  /** used for DAY/NIGHT/DUSK/DAWN conditions */
  timeOfDay?: 'DAY' | 'NIGHT' | 'DUSK' | 'DAWN';
}

function entryValid(e: MonsterGroupDef['monsters'][number], ctx: MonsterGroupContext): boolean {
  if (ctx.elapsed !== undefined) {
    // start_of_cataclysm + starts < turn, and (ends == 0 || start + ends > turn)
    if (e.starts !== undefined && !(ctx.elapsed > e.starts)) return false;
    if (e.ends && ctx.elapsed >= e.ends) return false;
  }
  const conds = e.conditions ?? [];
  const tod = conds.filter((c) => c === 'DAY' || c === 'NIGHT' || c === 'DUSK' || c === 'DAWN');
  if (tod.length && ctx.timeOfDay && !tod.includes(ctx.timeOfDay)) return false;
  const seasons = conds.filter((c) => c === 'SPRING' || c === 'SUMMER' || c === 'AUTUMN' || c === 'WINTER');
  if (seasons.length && ctx.season && !seasons.includes(ctx.season)) return false;
  return true;
}

/**
 * BN MonsterGroupManager::GetResultFromGroup (mongroup.cpp): roll 1..freq_total (default
 * 1000), walk the *valid* entries subtracting their freq until one covers the roll; if none
 * does, the group's default monster spawns (one of it). Pack size is only rolled when the
 * entry's max pack is > 1. "mon_null" results are dropped. BN groups hold monsters only (no
 * nested groups); `_recursive` is kept for old callers and ignored. (The evolve_chance
 * upgrade rolls of GetUpgradedMonsterGroup are not modelled.)
 */
export function pickFromMonsterGroup(data: GameData, groupId: string, rng: Rng, ctx: MonsterGroupContext = {}, _recursive = false): MonsterSpawn[] {
  const g = data.monsterGroups[groupId];
  if (!g) {
    warnOnce('monstergroup', groupId);
    return [];
  }
  let chance = rng.int(1, Math.max(1, g.freq_total));
  let out: MonsterSpawn = { id: g.default, count: 1 };
  for (const e of g.monsters) {
    if (!entryValid(e, ctx)) continue;
    if (e.weight >= chance) {
      const pack = e.pack_size && e.pack_size[1] > 1 ? rng.int(e.pack_size[0], e.pack_size[1]) : 1;
      out = { id: e.monster, count: pack };
      break;
    }
    chance -= e.weight;
  }
  return out.id && out.id !== 'mon_null' ? [out] : [];
}
