// Shapes of the worldgen data files emitted by tools/extract/mapgen.ts into public/data/:
//   mapgen.json   - CDDA "mapgen" objects (om_terrain + nested), keyed for fast lookup
//   palettes.json - CDDA "palette" objects by id
//   overmap.json  - overmap terrains, specials/city buildings, region settings, names
// Mapgen objects are kept verbatim (minus "//" comments) because the interpreter in
// src/world/mapgen/ reads them the same way CDDA's mapgen.cpp does.
import { DATA_BASE } from '../core/assets';

export type Json = any;

/** One registered mapgen for an om_terrain id. `o` indexes MapgenData.objects. */
export interface OmtMapgenRef {
  /** CDDA weight (default 1000; 0 disables) */
  w: number;
  o: number;
  /** For multi-OMT om_terrain arrays: origin of this OMT's 24x24 slice in the object. */
  ox?: number;
  oy?: number;
}

export interface MapgenData {
  /** om_terrain id (type id, e.g. "house_01", "road_straight") -> weighted mapgens */
  omt: Record<string, OmtMapgenRef[]>;
  /** nested_mapgen_id -> weighted nested chunks */
  nested: Record<string, { w: number; o: number }[]>;
  /** update_mapgen_id -> object index (only ids dialogue/missions reference; see extract:mapgen) */
  update?: Record<string, number>;
  objects: Json[];
}

export type PaletteData = Record<string, Json>;

export interface OterDef {
  id: string;
  name: string;
  sym: string;
  color: string;
  flags: string[];
  /** CDDA "uniform_terrain": the whole OMT is this terrain (open_air, solid_earth, ...) */
  uniform?: string;
  /** CDDA builtin mapgen name (forest, river_curved, lake_shore, ...) */
  builtin?: string;
  extras?: string;
  mondensity?: number;
  spawns?: { group: string; population: [number, number]; chance: number };
}

export interface SpecialOvermap {
  /** [x, y, z] offset in OMTs, for the special's north-facing orientation */
  p: [number, number, number];
  /** oter id with direction suffix, e.g. "house_01_north"; absent = location-only constraint */
  om?: string;
  locations?: string[];
}

export interface SpecialConnection {
  p: [number, number, number];
  terrain?: string;
  connection?: string;
  from?: [number, number, number];
  existing?: boolean;
}

export interface SpecialDef {
  id: string;
  /** true when loaded from a CDDA city_building (placed by town growth, not scattered) */
  city: boolean;
  overmaps: SpecialOvermap[];
  connections: SpecialConnection[];
  locations: string[];
  cityDistance: [number, number];
  citySizes: [number, number];
  occurrences: [number, number];
  flags: string[];
}

export interface ForestBiome {
  id: string;
  terrains: string[];
  sparseness_adjacency_factor: number;
  item_group?: string;
  item_group_chance?: number;
  item_spawn_iterations?: number;
  groundcover: [string, number][];
  /** components resolved from forest_biome_component, sorted by sequence */
  components: { chance: number; types: [string, number][] }[];
  terrain_furniture?: Record<string, { chance: number; furniture: [string, number][] }>;
}

export interface RegionSettings {
  default_groundcover: [string, number][];
  city: {
    city_size: number;
    city_spacing: number;
    shop_radius: number;
    shop_sigma: number;
    park_radius: number;
    park_sigma: number;
    houses: [string, number][];
    shops: [string, number][];
    parks: [string, number][];
  };
  forest: {
    noise_threshold_forest: number;
    noise_threshold_forest_thick: number;
    noise_threshold_swamp_adjacent_water: number;
    noise_threshold_swamp_isolated: number;
  };
  lake: { noise_threshold_lake: number; lake_size_min: number };
  forestBiomes: ForestBiome[];
  /** t_region_* / f_region_* pseudo ids -> weighted concrete (or further pseudo) ids */
  regionTerrain: Record<string, [string, number][]>;
  regionFurniture: Record<string, [string, number][]>;
}

export interface OvermapData {
  terrains: Record<string, OterDef>;
  specials: Record<string, SpecialDef>;
  /** CDDA overmap_location id -> oter type ids */
  locations: Record<string, string[]>;
  region: RegionSettings;
  /** Wilderness specials this build scatters (subset chosen by the extractor). */
  wildSpecials: string[];
  names: { city: string[]; given: string[]; family: string[] };
}

export interface WorldgenData {
  mapgen: MapgenData;
  palettes: PaletteData;
  overmap: OvermapData;
}

export async function loadWorldgenData(base = DATA_BASE): Promise<WorldgenData> {
  const get = async (file: string) => {
    const res = await fetch(base + file);
    if (!res.ok) throw new Error(`Failed to load ${base + file}: HTTP ${res.status} (run \`npm run extract:mapgen\`)`);
    return res.json();
  };
  const [mapgen, palettes, overmap] = await Promise.all([get('mapgen.json'), get('palettes.json'), get('overmap.json')]);
  return { mapgen, palettes, overmap };
}
