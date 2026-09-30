import type { FurnitureDef, TerrainDef } from '../data/types';

// Terrain/furniture ids are interned to small integers so chunks can store them in typed
// arrays (a 24x24 chunk is 576 u16s rather than 576 strings). Index 0 is always the
// null id ("t_null" / "f_null").

export class IdRegistry<T extends { id: string }> {
  readonly defs: T[] = [];
  private byId = new Map<string, number>();
  constructor(nullDef: T) {
    this.add(nullDef);
  }
  add(def: T): number {
    const existing = this.byId.get(def.id);
    if (existing !== undefined) {
      this.defs[existing] = def;
      return existing;
    }
    const n = this.defs.length;
    if (n >= 65535) throw new Error('IdRegistry overflow');
    this.defs.push(def);
    this.byId.set(def.id, n);
    return n;
  }
  /** Throws on unknown ids: a silent fallback would hide typos in mapgen. Use tryIndex to probe. */
  index(id: string): number {
    const n = this.byId.get(id);
    if (n === undefined) throw new Error(`Unknown id: ${id}`);
    return n;
  }
  tryIndex(id: string): number | undefined {
    return this.byId.get(id);
  }
  get(n: number): T {
    return this.defs[n];
  }
  has(id: string): boolean {
    return this.byId.has(id);
  }
}

export const NULL_TER: TerrainDef = {
  id: 't_null', name: 'nothing', symbol: ' ', color: 'c_black', move_cost: 0, flags: [],
};
export const NULL_FURN: FurnitureDef = {
  id: 'f_null', name: 'nothing', symbol: ' ', color: 'c_black', move_cost_mod: 0, flags: [],
};

/** Per-def cached flag lookups; flags arrays are small but queried every frame. */
const flagCache = new WeakMap<object, Set<string>>();
/**
 * ter_t::is_diggable (BN map/mapdata.cpp): the terrain has digging_results with a result.
 * BN dropped DDA's DIGGABLE flag (2 terrains still carry it, 50 have digging_results), so
 * testing the flag made grass and dirt "too hard to dig": no barricade, pit or grave anywhere
 * (wave-3 playtest). The flag still counts for old data.
 */
export function isDiggable(def: { flags: string[]; digging_results?: { result_ter?: string } }): boolean {
  const r = def.digging_results?.result_ter;
  return (!!r && r !== 't_null') || hasFlag(def, 'DIGGABLE');
}

export function hasFlag(def: { flags: string[] }, flag: string): boolean {
  let s = flagCache.get(def);
  if (!s) flagCache.set(def, (s = new Set(def.flags)));
  return s.has(flag);
}
