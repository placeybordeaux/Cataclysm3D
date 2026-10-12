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
  /** mapgen id -> builtin generator name (BN C++ mapgen_functions.cpp names such as "field",
   *  "road_straight", "forest", or "lua:lab" for BN's Lua mapgen). JSON mapgen wins when both exist. */
  builtin?: Record<string, string>;
  /** BN region_settings map_extras, only for the oter "extras" keys our builtins apply them for
   *  (sewer, subway; see applyMapExtra in worldgen.ts): one_in(chance) picks one weighted extra. */
  extras?: Record<string, MapExtraTable>;
  objects: Json[];
}

export interface MapExtraTable {
  chance: number;
  /** `o` = update_mapgen object index for JSON extras; `fn` = a BN C++ map_extra_function we
   *  don't port (picked like the others so the odds stay BN's, then reported as unsupported). */
  values: { id: string; w: number; o?: number; fn?: string }[];
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
  /** BN place_nested: specials grown from a point of this one (e.g. Lab -> lab_basement). */
  nested?: { p: [number, number, number]; special: string }[];
  /** BN overmap_special_spawns: the monster group place_special drops at the special's origin. */
  spawns?: SpecialSpawns;
}

/**
 * BN overmap_special_spawns (overmap.cpp 589): a roaming population (e.g. an anthill's GROUP_ANT,
 * 1000-2000 within 10-30 submaps) placed as overmap monster groups, genVersion >= 3
 * (src/world/overmap/mongroups.ts). Ranges are inclusive [min, max]; radius is in submaps.
 */
export interface SpecialSpawns {
  group: string;
  population: [number, number];
  radius: [number, number];
}

// --- BN "subtype": "mutable" overmap specials (overmap.cpp mutable_overmap_special_data),
// normalized by tools/extract/mapgen.ts and grown by src/world/overmap/mutable.ts.

export type CubeDir = 'north' | 'east' | 'south' | 'west' | 'above' | 'below';
/** BN join_type */
export type MutableJoinType = 'mandatory' | 'optional' | 'available' | 'reject';
/** BN int_distribution: fixed, [min, max] range, {poisson: mean} or {chance: p}. */
export type IntDistribution = number | [number, number] | { poisson: number } | { chance: number };
/** BN z_constraints: a level, [min, max], "top"/"bottom", or {top?, bottom?} offsets. */
export type ZConstraint = number | [number, number] | 'top' | 'bottom' | { top?: number; bottom?: number };

export interface MutableJoinDef {
  id: string;
  /** absent: the join is its own opposite */
  opposite?: string;
  /** absent: the special's default locations */
  into_locations?: string[];
}

export interface MutableTerrainJoin {
  id: string;
  type: MutableJoinType;
  alternatives?: string[];
}

export interface MutableOvermapDef {
  /** oter id as written in BN (direction suffix allowed, e.g. "anthill_north", "ants_ns") */
  overmap: string;
  /** absent: the special's default locations */
  locations?: string[];
  joins: Partial<Record<CubeDir, MutableTerrainJoin>>;
  /** direction -> BN overmap_connection id (e.g. lab_train_depot north: subway_tunnel) */
  connections?: Partial<Record<CubeDir, string>>;
}

export interface MutableRulePiece {
  overmap: string;
  pos: [number, number, number];
  /** 0..3 = north/east/south/west */
  rot: number;
}

export interface MutablePlacementRule {
  name?: string;
  pieces: MutableRulePiece[];
  /** BN "join": the rule only applies where it can match this join */
  join?: string;
  /** shared multiplier name scaling max */
  scale?: string;
  z?: ZConstraint;
  rotate?: boolean;
  /** absent = INT_MAX (unlimited) */
  max?: IntDistribution;
  /** absent = INT_MAX */
  weight?: number;
}

export interface MutableSpecialDef {
  id: string;
  locations: string[];
  cityDistance: [number, number];
  citySizes: [number, number];
  occurrences: [number, number];
  flags: string[];
  /** BN "rotate" (default true) */
  rotate: boolean;
  connections: SpecialConnection[];
  nested?: { p: [number, number, number]; special: string }[];
  /** BN check_for_locations (+ check_for_locations_area expanded); empty = the root at [0,0,0] */
  checkForLocations: { p: [number, number, number]; locations: string[] }[];
  joins: MutableJoinDef[];
  overmaps: Record<string, MutableOvermapDef>;
  root: string;
  shared: Record<string, IntDistribution>;
  phases: MutablePlacementRule[][];
  spawns?: SpecialSpawns;
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
    /** BN: towns bigger than 10 pick shops (and, within apartment_radius, houses) from these. */
    apartment_radius?: number;
    apartment_sigma?: number;
    urban_houses?: [string, number][];
    urban_shops?: [string, number][];
    /** BN: big towns try to place one of these "finale" buildings (mall, hospital...). */
    finales?: [string, number][];
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
  /** BN field_coverage (mapgen_field): shrubs/flowers/boulders scattered over fields. */
  field?: {
    percent_coverage: number;
    default_ter: string;
    other: [string, number][];
    boost_chance: number;
    boosted_percent_coverage: number;
    boosted_other: [string, number][];
    boosted_other_percent: number;
  };
}

/** BN overmap_connection subtype (overmap_connection.h). */
export interface ConnectionSubtype {
  /** oter type it lays down */
  terrain: string;
  /** overmap_location ids it may be laid over (empty: only where this terrain already is) */
  locations: string[];
  basicCost: number;
  weight: number;
  /** BN ORTHOGONAL: Manhattan distance estimate instead of trig */
  orthogonal: boolean;
}

/** BN overmap_connection: how a road/sewer/subway connection is laid out (overmap_connections.json). */
export interface OvermapConnectionDef {
  id: string;
  defaultTerrain: string;
  /** "city": link to the owning city's centre first; "p2p": to the nearest earlier connection */
  layout: 'city' | 'p2p';
  subtypes: ConnectionSubtype[];
}

export interface OvermapData {
  terrains: Record<string, OterDef>;
  specials: Record<string, SpecialDef>;
  /** CDDA overmap_location id -> oter type ids */
  locations: Record<string, string[]>;
  region: RegionSettings;
  /** Wilderness specials this build scatters (subset chosen by the extractor). */
  wildSpecials: string[];
  /** BN overmap_connections by id (absent in data extracted before genVersion 2). */
  connections?: Record<string, OvermapConnectionDef>;
  /**
   * Specials placed from genVersion 2 by Overmap.placeMutableSpecials, in this order: the
   * mutable wilderness specials plus the fixed specials that only exist to host a nested
   * mutable one (the mines and their mine_tunnel). Ids name `mutables` or `specials`.
   */
  mutableWildSpecials?: string[];
  /** BN "LAKE" specials (sunken_lab) placed from genVersion 3 in the lake columns, by
   *  placeMutableSpecials' lake zone. Absent in data extracted before genVersion 3. */
  lakeSpecials?: string[];
  names: { city: string[]; given: string[]; family: string[] };
  /** BN mutable overmap specials ("subtype": "mutable") we grow, by id: lab_basement (Overmap.
   *  placeLabBasement), the mutableWildSpecials and what they nest (mine_tunnel); all grown by
   *  src/world/overmap/mutable.ts. Absent in data extracted before they were kept. */
  mutables?: Record<string, MutableSpecialDef>;
  /** BN overmap_connection id -> oter types it is made of (its subtypes' terrains). */
  connectionTerrains?: Record<string, string[]>;
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
