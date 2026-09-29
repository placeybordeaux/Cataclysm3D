import type { Rng } from '../../core/rng';
import type { ForestBiome, RegionSettings } from '../worldgen_data';
import { MapBuffer, OMT } from './buffer';
import type { MapgenDat } from './jsonmapgen';
import { weightedPick } from './values';
import type { ExpandedItem } from '../../data/itemgroups';

// Procedural generators for terrain CDDA builds in C++ (mapgen_functions.cpp): forests
// (mapgen_forest, driven by region_settings forest biomes), rivers and lakes (builtin
// river_* / lake_shore), and region pseudo-terrain resolution.

/** CDDA resolve_regional_terrain_and_furniture: t_region_* / f_region_* -> concrete ids. */
export function resolveRegional(buf: MapBuffer, region: RegionSettings, rng: Rng, onUnknown: (id: string) => void): void {
  const resolve = (id: string, table: Record<string, [string, number][]>): string => {
    for (let depth = 0; depth < 8; depth++) {
      const opts = table[id];
      if (!opts) {
        if (id.startsWith('t_region') || id.startsWith('f_region')) onUnknown(id);
        return id;
      }
      id = weightedPick(rng, opts) ?? id;
    }
    return id;
  };
  for (let i = 0; i < OMT * OMT; i++) {
    const t = buf.ter[i];
    if (t.startsWith('t_region')) buf.ter[i] = resolve(t, region.regionTerrain);
    const f = buf.furn[i];
    if (f.startsWith('f_region')) buf.furn[i] = resolve(f, region.regionFurniture);
  }
}

export function biomeFor(region: RegionSettings, type: string): ForestBiome | undefined {
  return region.forestBiomes.find((b) => b.terrains.includes(type));
}

/** Forest biome feature pick: first component whose one_in(chance) succeeds. */
function biomeFeature(b: ForestBiome, rng: Rng): string | undefined {
  for (const c of b.components) if (rng.oneIn(c.chance)) return weightedPick(rng, c.types);
  return undefined;
}

/**
 * Simplified CDDA mapgen_forest: each tile draws from this OMT's biome or, near an edge,
 * from the neighbouring OMT's biome (or bare region groundcover when the neighbour has no
 * biome), weighted by distance to that edge and the biomes' sparseness factors. That gives
 * the same soft forest/field borders without CDDA's full perimeter spline machinery.
 */
export function mapgenForest(
  dat: MapgenDat, buf: MapBuffer, region: RegionSettings, expandItems: (ref: unknown, rng: Rng) => ExpandedItem[],
): void {
  const rng = dat.rng;
  const self = biomeFor(region, dat.oter.type);
  if (!self) return;
  const maxFactor = Math.max(...region.forestBiomes.map((b) => b.sparseness_adjacency_factor));
  const nb: (ForestBiome | undefined)[] = [
    biomeFor(region, dat.omtAt(0, -1, 0).type), biomeFor(region, dat.omtAt(1, 0, 0).type),
    biomeFor(region, dat.omtAt(0, 1, 0).type), biomeFor(region, dat.omtAt(-1, 0, 0).type),
  ];
  const selfF = self.sparseness_adjacency_factor;
  for (let y = 0; y < OMT; y++)
    for (let x = 0; x < OMT; x++) {
      const i = y * OMT + x;
      const depth = [y, OMT - 1 - x, OMT - 1 - y, x];
      const pool: [ForestBiome | null, number][] = [[self, 3 * selfF]];
      let empty = 3 * (maxFactor - selfF);
      for (let d = 0; d < 4; d++) {
        const w = Math.pow(5 / (depth[d] + 1), 2);
        if (w < 0.05) continue;
        const f = nb[d]?.sparseness_adjacency_factor ?? 0;
        if (nb[d]) pool.push([nb[d]!, w * f]);
        empty += w * (maxFactor - f);
      }
      pool.push([null, Math.max(0, empty) * 0.35]);
      const b = weightedPick(rng, pool);
      if (!b) {
        buf.ter[i] = weightedPick(rng, region.default_groundcover) ?? 't_region_groundcover';
        continue;
      }
      buf.ter[i] = weightedPick(rng, b.groundcover) ?? 't_region_groundcover';
      const feat = biomeFeature(b, rng);
      if (feat) {
        if (feat.startsWith('f_')) buf.furn[i] = feat;
        else buf.ter[i] = feat;
      }
      const tf = b.terrain_furniture?.[buf.ter[i]];
      if (tf && rng.oneIn(tf.chance)) buf.furn[i] = weightedPick(rng, tf.furniture) ?? '';
    }
  if (self.item_group) {
    for (let k = 0; k < (self.item_spawn_iterations ?? 0); k++) {
      if (!rng.chance(self.item_group_chance ?? 0)) continue;
      const i = rng.int(0, OMT * OMT - 1);
      for (const e of expandItems(self.item_group, rng)) buf.addItem(i, e.count === 1 ? { typeId: e.id } : { typeId: e.id, count: e.count });
    }
  }
}

export const isWaterType = (type: string) => type.startsWith('river') || type.startsWith('lake');

/**
 * Rivers and lakes (stands in for CDDA's river_straight/curved and lake_shore builtins).
 * Tiles within a noisy bank width of any non-water neighbour OMT become shore (land, then
 * shallow water); the rest is deep water. Rivers use the "moving" water variants.
 */
export function mapgenWater(dat: MapgenDat, buf: MapBuffer): void {
  const rng = dat.rng;
  const river = dat.oter.type.startsWith('river');
  const deep = river ? 't_water_moving_dp' : 't_water_dp';
  const shallow = river ? 't_water_moving_sh' : 't_water_sh';
  const land: boolean[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) land.push(!isWaterType(dat.omtAt(dx, dy, 0).type));
  const L = (dx: number, dy: number) => land[(dy + 1) * 3 + dx + 1];
  // Seeded per-OMT-edge wobble so shores meander but stay continuous inside the OMT.
  const wob = (k: number, t: number) => Math.sin(t * 0.45 + k * 1.7 + ((dat.omx * 31 + dat.omy * 17) % 13)) * 1.5;
  for (let y = 0; y < OMT; y++)
    for (let x = 0; x < OMT; x++) {
      let d = 99;
      if (L(0, -1)) d = Math.min(d, y - wob(0, x));
      if (L(0, 1)) d = Math.min(d, OMT - 1 - y - wob(2, x));
      if (L(-1, 0)) d = Math.min(d, x - wob(3, y));
      if (L(1, 0)) d = Math.min(d, OMT - 1 - x - wob(1, y));
      if (L(-1, -1)) d = Math.min(d, Math.hypot(x, y) - 1);
      if (L(1, -1)) d = Math.min(d, Math.hypot(OMT - 1 - x, y) - 1);
      if (L(-1, 1)) d = Math.min(d, Math.hypot(x, OMT - 1 - y) - 1);
      if (L(1, 1)) d = Math.min(d, Math.hypot(OMT - 1 - x, OMT - 1 - y) - 1);
      const i = y * OMT + x;
      if (d < 3) {
        buf.ter[i] = 't_region_groundcover';
        if (rng.oneIn(12)) buf.ter[i] = 't_region_shrub';
      } else if (d < 3.5 && rng.oneIn(3)) buf.ter[i] = 't_dirt';
      else if (d < 6) buf.ter[i] = shallow;
      else buf.ter[i] = deep;
    }
}
