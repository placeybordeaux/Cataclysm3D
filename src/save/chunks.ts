import type { GameData } from '../data/types';
import { Chunk, type Field, type GameMap, type MapItem, type MapZone, type SpawnRequest, type VehicleRequest } from '../world/map';
import { CHUNK } from '../world/coords';
import { chunkMapDamage, setChunkMapDamage } from '../game/bash';
import type { ItemJSON } from '../game/item';
import { loadItemSafe, type Warn } from './items';

// Chunk <-> JSON. Terrain and furniture are stored as indices into per-save palettes of id
// strings (registry indices are not stable across data versions), run-length encoded:
// [paletteIndex, runLength, paletteIndex, runLength, ...]. Everything keyed by tile uses the
// chunk-local index (ly * 24 + lx).

export interface ChunkJSON {
  /** [cx, cy, z] */
  at: [number, number, number];
  ter: number[];
  furn: number[];
  /** Per tile; runs of identical items (glass shards, a stack of blankets) are [count, item]. */
  items?: [number, (ItemJSON | [number, ItemJSON])[]][];
  /** [tile, type, intensity, age] */
  fields?: [number, string, number, number][];
  traps?: [number, string][];
  signs?: [number, string][];
  graffiti?: [number, string][];
  computers?: [number, Record<string, unknown>][];
  radiation?: [number, number][];
  /** Persistent bash damage (bash.ts). */
  damage?: [number, number][];
  spawns?: SpawnRequest[];
  vehicles?: VehicleRequest[];
  zones?: MapZone[];
  omt?: { id: string; source: string };
  empty?: boolean;
}

/** Id palette shared by all chunks of one save. */
export class Palette {
  readonly ids: string[] = [];
  private byId = new Map<string, number>();
  index(id: string): number {
    let n = this.byId.get(id);
    if (n === undefined) {
      n = this.ids.length;
      this.ids.push(id);
      this.byId.set(id, n);
    }
    return n;
  }
}

function rle(arr: ArrayLike<number>, map: (n: number) => number): number[] {
  const out: number[] = [];
  let cur = -1, run = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = map(arr[i]);
    if (v === cur) run++;
    else {
      if (run) out.push(cur, run);
      cur = v;
      run = 1;
    }
  }
  if (run) out.push(cur, run);
  return out;
}

function unrle(data: number[], into: Uint16Array, map: (n: number) => number): void {
  let i = 0;
  for (let k = 0; k + 1 < data.length; k += 2) {
    const v = map(data[k]);
    const end = Math.min(into.length, i + data[k + 1]);
    while (i < end) into[i++] = v;
  }
  if (i !== into.length) throw new Error(`chunk layer has ${i} tiles, expected ${into.length}`);
}

/** Collapse runs of identical items: half of a typical save's items repeat their neighbour. */
function runs(list: ItemJSON[]): (ItemJSON | [number, ItemJSON])[] {
  const out: (ItemJSON | [number, ItemJSON])[] = [];
  let prev = '', n = 0;
  const flush = (i: number) => {
    if (n) out.push(n === 1 ? list[i - 1] : [n, list[i - 1]]);
  };
  for (let i = 0; i < list.length; i++) {
    const s = JSON.stringify(list[i]);
    if (s === prev) n++;
    else {
      flush(i);
      prev = s;
      n = 1;
    }
  }
  flush(list.length);
  return out;
}

const entries = <V>(m: Map<number, V>): [number, V][] | undefined => (m.size ? [...m] : undefined);

function itemToJSON(it: MapItem): ItemJSON {
  const t = it as MapItem & { toJSON?: () => ItemJSON };
  return t.toJSON ? t.toJSON() : { typeId: it.typeId };
}

export function encodeChunk(map: GameMap, c: Chunk, ter: Palette, furn: Palette): ChunkJSON {
  const j: ChunkJSON = {
    at: [c.cx, c.cy, c.z],
    ter: rle(c.ter, (n) => ter.index(map.terrain.get(n).id)),
    furn: rle(c.furn, (n) => furn.index(map.furniture.get(n).id)),
  };
  if (c.items.size) j.items = [...c.items].map(([k, list]) => [k, runs(list.map(itemToJSON))]);
  if (c.fields.size) j.fields = [...c.fields].flatMap(([k, list]) => list.map((f) => [k, f.type, f.intensity, f.age] as [number, string, number, number]));
  j.traps = entries(c.traps);
  j.signs = entries(c.signs);
  j.graffiti = entries(c.graffiti);
  j.computers = entries(c.computers);
  j.radiation = entries(c.radiation);
  const dmg = chunkMapDamage(c);
  if (dmg?.size) j.damage = [...dmg];
  if (c.spawns.length) j.spawns = c.spawns;
  if (c.vehicles.length) j.vehicles = c.vehicles;
  if (c.zones.length) j.zones = c.zones;
  if (c.omt) j.omt = c.omt;
  if (c.empty) j.empty = true;
  // Drop undefined keys so the JSON stays small.
  for (const k of Object.keys(j) as (keyof ChunkJSON)[]) if (j[k] === undefined) delete j[k];
  return j;
}

/**
 * Palette ids -> this build's registry indices. Unknown ids (data changed since the save)
 * warn once and fall back to a plain id rather than failing the whole load.
 */
export function paletteResolver(ids: string[], has: (id: string) => boolean, index: (id: string) => number, fallback: string, what: string, warn: Warn): number[] {
  return ids.map((id) => {
    if (has(id)) return index(id);
    warn(`unknown ${what} "${id}" in saved chunk, replaced with ${fallback}`);
    return has(fallback) ? index(fallback) : 0;
  });
}

export function decodeChunk(data: GameData, j: ChunkJSON, ter: number[], furn: number[], warn: Warn): Chunk {
  const [cx, cy, z] = j.at;
  const c = new Chunk(cx, cy, z);
  const pick = (pal: number[], what: string) => (n: number) => {
    const v = pal[n];
    if (v === undefined) throw new Error(`chunk ${cx},${cy},${z}: ${what} palette index ${n} out of range`);
    return v;
  };
  unrle(j.ter, c.ter, pick(ter, 'terrain'));
  unrle(j.furn, c.furn, pick(furn, 'furniture'));
  const inChunk = (k: number) => Number.isInteger(k) && k >= 0 && k < CHUNK * CHUNK;
  for (const [k, list] of j.items ?? []) {
    if (!inChunk(k)) throw new Error(`chunk ${cx},${cy},${z}: bad item tile ${k}`);
    const items = list
      .flatMap((e) => (Array.isArray(e) ? Array.from({ length: e[0] }, () => loadItemSafe(data, e[1], warn)) : [loadItemSafe(data, e, warn)]))
      .filter((it): it is NonNullable<typeof it> => !!it);
    if (items.length) c.items.set(k, items);
  }
  for (const [k, type, intensity, age] of j.fields ?? []) {
    let list = c.fields.get(k);
    if (!list) c.fields.set(k, (list = []));
    list.push({ type, intensity, age } satisfies Field);
  }
  for (const [src, dst] of [[j.traps, c.traps], [j.signs, c.signs], [j.graffiti, c.graffiti], [j.computers, c.computers], [j.radiation, c.radiation]] as const) {
    for (const [k, v] of (src ?? []) as [number, unknown][]) (dst as Map<number, unknown>).set(k, v);
  }
  if (j.damage?.length) setChunkMapDamage(c, new Map(j.damage));
  c.spawns = j.spawns ?? [];
  c.vehicles = j.vehicles ?? [];
  c.zones = j.zones ?? [];
  if (j.omt) c.omt = j.omt;
  c.empty = !!j.empty;
  c.version = 1;
  return c;
}
