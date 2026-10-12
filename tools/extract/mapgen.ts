// Extract Cataclysm: Bright Nights worldgen content (mapgen, palettes, overmap terrains/
// specials, region settings, city names) into compact JSON under public/data/.
//
// Usage: npm run extract:mapgen -- [--cdda ~/code/Cataclysm-BN] [--out public/data] [--dry-run]
//   --dry-run   parse + report sizes/stats, write nothing
//
// Only mapgen reachable from what our overmap generator can place is kept (city buildings
// from region settings, the wilderness specials whitelisted below, and base terrains),
// closed over nested chunks, palettes and predecessor terrains. That keeps mapgen.json
// a few MB instead of ~8 MB of labs/dimensions/basecamps we never generate.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  ForestBiome, MapgenData, MutableSpecialDef, OterDef, OvermapConnectionDef, OvermapData,
  RegionSettings, SpecialDef, SpecialOvermap,
} from '../../src/world/worldgen_data';
import type { ItemGroupRef } from '../../src/data/types';
import { defaultCddaDir, loadCddaObjects, objectIds, resolveFamily } from './cdda';
import { prepareObject } from './prepare';
import { migrateGroup, normalizeGroupRef, type ItemMigration } from './itemgroup';
import { normalizeMutableSpecial } from './mutable';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`extract:mapgen - BN mapgen/overmap JSON -> public/data/{mapgen,palettes,overmap}.json
  --cdda <dir>   game checkout (default $CDDA_DIR or ~/code/Cataclysm-BN)
  --out <dir>    output dir (default public/data)
  --dry-run      don't write files, just report`);
  process.exit(0);
}
const arg = (name: string, def: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const CDDA = resolve(arg('--cdda', defaultCddaDir()));
const OUT = resolve(arg('--out', 'public/data'));
const DRY = argv.includes('--dry-run');

/** Wilderness overmap specials we scatter outside towns (must exist, non-mutable). */
export const WILD_SPECIALS = [
  // BN's evacuee start: the shelter plus its two alternative floor plans.
  'Evac Shelter', 'Evac Shelter 1', 'Evac Shelter 2', 'Rural Gas Station', 'cemetery', 'cemetery_religious',
  'Dairy Farm', 'Apple Orchard', 'Farm', 'Cabin', 'Cabin_1', 'Cabin_2', 'Cabin_3', 'Cabin_4',
  'rural_house', 'rural_house_yard', 'campsite', 'junkyard', 'Radio Tower', 'desolate barn',
  'Hunting Blind', 'LMOE Shelter', 'Pond', 'Derelict Property', 'Moonshine Still', 'Sugar House',
  'shooting range', '4x4_microlab_surface', 'Cave', 'Toxic Waste Dump', 'Swamp Shack', 'Fishing Pond',
  // The Free Merchants' refugee center (NPC hub); overmap.ts keeps one near the start town.
  'evac_center',
  // BN keeps two kinds of lab: the classic science lab ("Lab": a z0 lab_stairs entrance over the
  // mutable lab_basement special, drawn by the Lua "lab" mapgen, see src/world/mapgen/lab.ts) and
  // the modular JSON 6-floor mutagen lab. overmap.ts guarantees one of each near the start.
  'Lab', 'lab_mutagen_6_level',
];

/**
 * Specials overmap.ts places from genVersion 2 (placeMutableSpecials): BN's mutable wilderness
 * specials, plus the fixed mine specials, which exist to host the nested mutable mine_tunnel.
 * Kept apart from WILD_SPECIALS because genVersion 1 iterates that list and must not change.
 * Left out: lab_basement (grown by placeLabBasement) and sunken_lab (LAKE_SPECIALS).
 */
export const MUTABLE_WILD_SPECIALS = [
  'Anthill', 'Acid Anthill', 'Lab with Anthill', 'Slime Pit', 'Ice Lab', 'stream_mutable',
  'Mine Entrance', 'Spiral mine', 'Amigara mine', 'Wyrms mine',
];

/**
 * BN "LAKE" specials, placed from genVersion 3 on lake_surface over the lake columns
 * (src/world/overmap/lakes.ts, placeMutableSpecials' lake zone). Kept apart from
 * MUTABLE_WILD_SPECIALS so genVersion 2 placement doesn't change.
 */
export const LAKE_SPECIALS = ['sunken_lab'];
/** BN place_lakes column terrains under lake_surface / lake_shore (genVersion 3). */
const LAKE_COLUMN_OTERS = ['lake_water_cube', 'lake_bed', 'lake_underwater_shore'];

/** BN terrains drawn by hardcoded C++ that isn't a registered cfunction (mapgen.cpp draw_map
 *  dispatches on the oter id): name -> our builtin name. */
const BN_HARDCODED: Record<string, string> = { mine: 'mine', mine_down: 'mine', mine_finale: 'mine' };

/** Base terrains the overmap generator emits directly (BN has no solid_earth/deep_rock: every
 *  z<0 OMT defaults to empty_rock). `bridge` replaces road over water. The classic lab's
 *  underground terrains come from overmap.ts's lab_basement generator. */
const BASE_OTERS = [
  'field', 'forest', 'forest_thick', 'forest_water', 'road', 'road_nesw_manhole', 'river',
  'river_center', 'lake_surface', 'lake_shore', 'open_air', 'empty_rock', 'bridge',
  'lab', 'lab_filler', 'lab_stairs', 'lab_core', 'lab_finale',
  // Underground networks overmap.ts lays out itself (genVersion 2): sewer_isolated under city
  // manholes and the sewer_tunnel / subway_tunnel connections (see CONNECTIONS_BUILT).
  'sewer', 'subway',
];
/** BN overmap_connections whose subtype terrains the overmap generator builds. */
const CONNECTIONS_BUILT = ['sewer_tunnel', 'subway_tunnel'];

/** BN mapgen_functions.cpp get_mapgen_cfunction: C++ generators an OMT uses when its mapgen id
 *  equals one of these names (load_overmap_terrain_mapgens registers them by id) or when its
 *  overmap_terrain says {"method": "builtin", "name": ...}. */
const BN_CFUNCTIONS = new Set([
  'null', 'test', 'crater', 'field', 'forest', 'forest_trail_straight', 'forest_trail_curved', 'forest_trail_end',
  'forest_trail_tee', 'forest_trail_four_way', 'hive', 'road_straight', 'road_curved', 'road_end', 'road_tee',
  'road_four_way', 'highway', 'railroad_straight', 'railroad_curved', 'railroad_end', 'railroad_tee',
  'railroad_four_way', 'railroad_bridge', 'river_center', 'river_curved_not', 'river_straight', 'river_curved',
  'river_shore', 'parking_lot', 'cavern', 'open_air', 'rift', 'hellmouth', 'empty_rock', 'rock', 'subway_straight',
  'subway_curved', 'subway_end', 'subway_tee', 'subway_four_way', 'sewer_straight', 'sewer_curved', 'sewer_end',
  'sewer_tee', 'sewer_four_way', 'tutorial', 'lake_shore', 'pd_border',
]);
/** region_settings map_extras keys whose extras those builtins apply (BN mapgen.cpp generate()
 *  runs the extras of every oter; we do it only for these, so other terrains keep their output). */
const TRANSPORT_EXTRAS = ['sewer', 'subway'];
const LINEAR_SUFFIXES = ['_straight', '_curved', '_end', '_tee', '_four_way'];
const DIRS = ['_north', '_east', '_south', '_west'];

// ---------------------------------------------------------------------------------------
// Load (shared loader from tools/extract/cdda.ts; the main extractor skips these types)

// BN keeps region settings in one monolithic region_settings object (DDA 0.F style), not DDA
// 0.J's region_settings_* / forest_biome_* split.
const WANTED_TYPES = [
  'mapgen', 'palette', 'overmap_terrain', 'overmap_special', 'city_building', 'overmap_location', 'region_settings', 'MIGRATION',
  'overmap_connection',
  'map_extra',
  // only for their "alias" ids (see canonical below)
  'terrain', 'furniture',
];
const byType = loadCddaObjects(CDDA, { types: WANTED_TYPES });
const all = (t: string) => byType.get(t) ?? [];
console.log(`loaded ${WANTED_TYPES.map((t) => all(t).length).reduce((a, b) => a + b, 0)} worldgen objects from ${CDDA}`);

/** Strip "//" comment keys recursively (they're 10-15% of mapgen bytes). */
function strip(o: any): any {
  if (Array.isArray(o)) return o.map(strip);
  if (o && typeof o === 'object') {
    const r: any = {};
    for (const [k, v] of Object.entries(o)) if (!k.startsWith('//')) r[k] = strip(v);
    return r;
  }
  return o;
}
// BN terrain/furniture may declare "alias" ids (t_fence -> t_fence_h, t_fence_v; the roof's
// t_gutter_north...) that mapgen keeps using. The runtime registries only know canonical ids,
// so mapgen strings naming an alias are rewritten here.
const aliasOf = new Map<string, string>();
for (const t of ['terrain', 'furniture']) {
  for (const o of all(t)) {
    for (const a of o.alias === undefined ? [] : Array.isArray(o.alias) ? o.alias : [o.alias]) {
      const prev = aliasOf.get(a);
      if (prev && prev !== o.id) throw new Error(`${t} alias ${a} claimed by ${prev} and ${o.id}`);
      aliasOf.set(a, o.id);
    }
  }
}
function canonical(o: any): any {
  if (typeof o === 'string') return aliasOf.get(o) ?? o;
  if (Array.isArray(o)) return o.map(canonical);
  if (o && typeof o === 'object') {
    const r: any = {};
    for (const [k, v] of Object.entries(o)) r[aliasOf.get(k) ?? k] = canonical(v);
    return r;
  }
  return o;
}
const str = (v: any): string => (typeof v === 'string' ? v : v?.str ?? v?.str_sp ?? String(v ?? ''));
const ids = (v: any): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// ---------------------------------------------------------------------------------------
// Overmap terrains (copy-from / extend / delete resolution)

const oterFamily = resolveFamily(all('overmap_terrain'), {}, prepareObject).byId;
const terrains: Record<string, OterDef> = {};
for (const [id, r] of oterFamily) {
  {
    const def: OterDef = { id, name: str(r.name) || id, sym: str(r.sym ?? '?'), color: str(r.color ?? 'white'), flags: [...new Set<string>(r.flags ?? [])] };
    if (r.uniform_terrain) def.uniform = r.uniform_terrain;
    // BN spells builtins {"method": "builtin", "name": "forest"} (DDA: {"builtin": "forest"}).
    const b = Array.isArray(r.mapgen) ? r.mapgen.find((m: any) => m.method === 'builtin' || m.builtin) : undefined;
    if (b) def.builtin = b.name ?? b.builtin;
    if (typeof r.extras === 'string') def.extras = r.extras;
    if (typeof r.mondensity === 'number') def.mondensity = r.mondensity;
    if (r.spawns) def.spawns = r.spawns;
    terrains[id] = def;
  }
}

// ---------------------------------------------------------------------------------------
// Specials + city buildings

const pt = (p: any): [number, number, number] => [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
const range = (v: any, def: [number, number]): [number, number] =>
  Array.isArray(v) ? [v[0], v[1]] : typeof v === 'number' ? [v, v] : def;
const specials: Record<string, SpecialDef> = {};
for (const [type, city] of [['overmap_special', false], ['city_building', true]] as const) {
  for (const o of all(type)) {
    if (o.subtype === 'mutable') continue;
    const overmaps: SpecialOvermap[] = (o.overmaps ?? []).map((e: any) => {
      const s: SpecialOvermap = { p: pt(e.point) };
      if (e.overmap) s.om = e.overmap;
      if (e.locations) s.locations = e.locations;
      return s;
    });
    specials[o.id] = {
      id: o.id,
      city,
      overmaps,
      connections: (o.connections ?? []).map((c: any) => ({
        p: pt(c.point), terrain: c.terrain, connection: c.connection, from: c.from ? pt(c.from) : undefined, existing: c.existing,
      })),
      locations: o.locations ?? ['land'],
      cityDistance: range(o.city_distance, [-1, -1]),
      citySizes: range(o.city_sizes, [0, -1]),
      occurrences: range(o.occurrences, [0, 0]),
      flags: o.flags ?? [],
    };
    // BN "place_nested": another (usually mutable) special grown from a point of this one,
    // e.g. the classic Lab's lab_basement under its lab_stairs entrance.
    if (Array.isArray(o.place_nested) && o.place_nested.length)
      specials[o.id].nested = o.place_nested.map((n: any) => ({ p: pt(n.point), special: n.special }));
  }
}
for (const w of WILD_SPECIALS) if (!specials[w]) throw new Error(`WILD_SPECIALS entry not found: ${w}`);

// BN mutable specials (normalized by tools/extract/mutable.ts, grown by
// src/world/overmap/mutable.ts), one `mutables` map: first the ones place_nested reaches from
// WILD_SPECIALS (the classic Lab's lab_basement), then MUTABLE_WILD_SPECIALS and what they nest.
const allMutable: Record<string, MutableSpecialDef> = {};
for (const o of all('overmap_special')) if (o.subtype === 'mutable') allMutable[o.id] = normalizeMutableSpecial(o);
const mutables: Record<string, MutableSpecialDef> = {};
const wildNestedMutables: string[] = [];
for (const w of WILD_SPECIALS) {
  for (const n of specials[w].nested ?? []) {
    if (allMutable[n.special] && !mutables[n.special]) (mutables[n.special] = allMutable[n.special]), wildNestedMutables.push(n.special);
  }
}
{
  const queue = MUTABLE_WILD_SPECIALS.slice();
  while (queue.length) {
    const id = queue.shift()!;
    const m = allMutable[id];
    const nested = m ? m.nested : specials[id]?.nested;
    if (!m && !specials[id]) throw new Error(`MUTABLE_WILD_SPECIALS: ${id} is not an overmap special`);
    if (m) mutables[id] = m;
    for (const n of nested ?? []) if (allMutable[n.special] && !mutables[n.special]) queue.push(n.special);
  }
}

// overmap_connection id -> the oter types it is made of (overmap_connection::has), for nested
// mapgen "connections" conditions (lab_train_depot opens a tunnel towards a subway).
const connectionTerrains: Record<string, string[]> = {};
for (const o of all('overmap_connection')) connectionTerrains[o.id] = [...new Set<string>((o.subtypes ?? []).map((t: any) => t.terrain))];

const locations: Record<string, string[]> = {};
for (const o of all('overmap_location')) locations[o.id] = o.terrains ?? [];

// BN overmap_connection (overmap_connection.cpp load / subtype::load): basic_cost defaults to 0,
// weight to 1, layout to "city"; ORTHOGONAL is the only subtype flag.
const connections: Record<string, OvermapConnectionDef> = {};
for (const o of all('overmap_connection')) {
  connections[o.id] = {
    id: o.id,
    defaultTerrain: o.default_terrain,
    layout: o.layout ?? 'city',
    subtypes: (o.subtypes ?? []).map((st: any) => {
      for (const l of st.locations) if (!locations[l]) throw new Error(`overmap_connection ${o.id}: unknown location ${l}`);
      return { terrain: st.terrain, locations: st.locations, basicCost: st.basic_cost ?? 0, weight: st.weight ?? 1, orthogonal: (st.flags ?? []).includes('ORTHOGONAL') };
    }),
  };
  if (connections[o.id].layout !== 'city' && connections[o.id].layout !== 'p2p') throw new Error(`overmap_connection ${o.id}: unknown layout ${o.layout}`);
}
for (const id of CONNECTIONS_BUILT) if (!connections[id]) throw new Error(`overmap_connection ${id} not found`);

// ---------------------------------------------------------------------------------------
// Region settings (BN region_settings "default", one monolithic object).

const rs = all('region_settings').find((o) => o.id === 'default');
if (!rs) throw new Error('region_settings default not found');
/** {id: weight} (BN) -> [id, weight][] (what the runtime's weighted picks read). */
const weights = (o: Record<string, number> | undefined, what: string): [string, number][] => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`region_settings: ${what} is not an {id: weight} object`);
  return Object.entries(o).filter(([k]) => !k.startsWith('//')).map(([k, w]) => [k, Number(w)]);
};
const rsCity = rs.city;
// BN forest_mapgen_settings is keyed by the forest OMT type it applies to; components are
// named {sequence, chance, types} objects (forest_mapgen_settings in regional_settings.cpp).
const forestBiomes: ForestBiome[] = Object.entries<any>(rs.forest_mapgen_settings).map(([oter, b]) => {
  const comps = Object.values<any>(b.components ?? {}).sort((a, c) => (a.sequence ?? 0) - (c.sequence ?? 0));
  const tf: ForestBiome['terrain_furniture'] = {};
  for (const [ter, e] of Object.entries<any>(b.terrain_furniture ?? {})) tf[ter] = { chance: e.chance, furniture: weights(e.furniture, `${oter}.terrain_furniture.${ter}`) };
  return {
    id: oter,
    terrains: [oter],
    sparseness_adjacency_factor: b.sparseness_adjacency_factor ?? 0,
    item_group: b.item_group,
    item_group_chance: b.item_group_chance,
    item_spawn_iterations: b.item_spawn_iterations,
    groundcover: weights(b.groundcover, `${oter}.groundcover`),
    components: comps.map((c) => ({ chance: c.chance, types: weights(c.types, `${oter} component`) })),
    terrain_furniture: Object.keys(tf).length ? tf : undefined,
  } satisfies ForestBiome;
});
const rtf = rs.region_terrain_and_furniture;
const regionTerrain: Record<string, [string, number][]> = {};
const regionFurniture: Record<string, [string, number][]> = {};
for (const [id, o] of Object.entries<any>(rtf.terrain)) regionTerrain[id] = weights(o, id);
for (const [id, o] of Object.entries<any>(rtf.furniture)) regionFurniture[id] = weights(o, id);
const fc = rs.field_coverage;
const region: RegionSettings = {
  default_groundcover: rs.default_groundcover,
  city: {
    // BN world options CITY_SIZE / CITY_SPACING (options.cpp defaults 8 and 4); BN's region
    // settings don't carry them.
    city_size: 8, city_spacing: 4,
    shop_radius: rsCity.shop_radius, shop_sigma: rsCity.shop_sigma,
    park_radius: rsCity.park_radius, park_sigma: rsCity.park_sigma,
    apartment_radius: rsCity.apartment_radius, apartment_sigma: rsCity.apartment_sigma,
    houses: weights(rsCity.houses, 'city.houses'), shops: weights(rsCity.shops, 'city.shops'), parks: weights(rsCity.parks, 'city.parks'),
    urban_houses: weights(rsCity.urban_houses, 'city.urban_houses'), urban_shops: weights(rsCity.urban_shops, 'city.urban_shops'),
    finales: weights(rsCity.finales, 'city.finales'),
  },
  forest: {
    noise_threshold_forest: rs.overmap_forest_settings.noise_threshold_forest,
    noise_threshold_forest_thick: rs.overmap_forest_settings.noise_threshold_forest_thick,
    noise_threshold_swamp_adjacent_water: rs.overmap_forest_settings.noise_threshold_swamp_adjacent_water,
    noise_threshold_swamp_isolated: rs.overmap_forest_settings.noise_threshold_swamp_isolated,
  },
  lake: { noise_threshold_lake: rs.overmap_lake_settings.noise_threshold_lake, lake_size_min: rs.overmap_lake_settings.lake_size_min },
  forestBiomes,
  regionTerrain,
  regionFurniture,
  field: {
    percent_coverage: fc.percent_coverage,
    default_ter: fc.default_ter,
    other: weights(fc.other, 'field_coverage.other'),
    boost_chance: fc.boost_chance,
    boosted_percent_coverage: fc.boosted_percent_coverage,
    boosted_other: weights(fc.boosted_other, 'field_coverage.boosted_other'),
    boosted_other_percent: fc.boosted_other_percent,
  },
};

// ---------------------------------------------------------------------------------------
// Mapgen reachability

// BN "method": "lua" mapgens (luamethod: lab, lab_ice, slimepit) have no object; their
// om_terrains get a builtin marker "lua:<method>" (src/world/mapgen/lab.ts ports the lab one).
const luaBuiltins: Record<string, string> = {};
for (const m of all('mapgen')) {
  if (m.method !== 'lua') continue;
  for (const id of [m.om_terrain].flat(2) as string[]) luaBuiltins[id] = `lua:${m.luamethod}`;
}
const mapgens = all('mapgen').filter((m) => !m.update_mapgen_id && m.method !== 'lua');
for (const m of mapgens) if (m.method !== 'json') throw new Error(`unknown mapgen method ${m.method}`);
const nestedDefs = new Map<string, any[]>();
const omtDefs = new Map<string, any[]>();
for (const m of mapgens) {
  if (m.nested_mapgen_id) {
    let l = nestedDefs.get(m.nested_mapgen_id);
    if (!l) nestedDefs.set(m.nested_mapgen_id, (l = []));
    l.push(m);
  } else if (m.om_terrain !== undefined) {
    for (const id of (m.om_terrain as any[]).flat ? [m.om_terrain].flat(2) : [m.om_terrain]) {
      let l = omtDefs.get(id);
      if (!l) omtDefs.set(id, (l = []));
      l.push(m);
    }
  }
}
const paletteRaw = new Map(all('palette').map((p) => [p.id, p]));

const LINE_ID_SUFFIXES = ['_isolated', '_end_south', '_end_west', '_ne', '_end_north', '_ns', '_es', '_nes',
  '_end_east', '_wn', '_ew', '_new', '_sw', '_nsw', '_esw', '_nesw'];
const baseType = (om: string) => {
  for (const d of DIRS) if (om.endsWith(d) && terrains[om.slice(0, -d.length)]) return om.slice(0, -d.length);
  for (const d of LINE_ID_SUFFIXES) {
    const t = om.slice(0, -d.length);
    if (om.endsWith(d) && terrains[t]?.flags.includes('LINEAR')) return t;
  }
  return om;
};
const wantOm = new Set<string>();
const addOm = (id: string) => {
  const b = baseType(id);
  if (wantOm.has(b)) return;
  wantOm.add(b);
  if (terrains[b]?.flags.includes('LINEAR')) for (const s of LINEAR_SUFFIXES) wantOm.add(b + s);
};
BASE_OTERS.forEach(addOm);
// The Lua lab mapgen runs these JSON floor plans (data:generate) for its rooms.
for (const id of ['lab_1side', 'lab_4side', 'lab_4side_filler', 'lab_finale_1level', 'lab_1side_ice', 'lab_finale_1level_ice']) {
  if (!omtDefs.has(id)) throw new Error(`lab floor plan mapgen ${id} missing`);
  addOm(id);
}
for (const id of wildNestedMutables) for (const t of Object.values(mutables[id].overmaps)) addOm(t.overmap);
const c = region.city;
const cityIds = [...new Set([...c.houses, ...c.shops, ...c.parks, ...(c.urban_houses ?? []), ...(c.urban_shops ?? []), ...(c.finales ?? [])].map(([id]) => id))];
for (const id of [...cityIds, ...WILD_SPECIALS]) {
  const s = specials[id];
  if (s) s.overmaps.forEach((o) => o.om && addOm(o.om));
  else if (terrains[id]) addOm(id);
  else console.warn(`region/whitelist entry is neither special nor terrain: ${id}`);
}
for (const id of CONNECTIONS_BUILT) for (const st of connections[id].subtypes) addOm(st.terrain);
// Terrains of the genVersion 2 specials are pulled in after everything above has been closed
// over (see the second drain below), so the objects, nested chunks and palettes the existing
// content already used keep their order in the outputs.
const lateOm: string[] = [];
for (const id of MUTABLE_WILD_SPECIALS) specials[id]?.overmaps.forEach((o) => o.om && lateOm.push(o.om));
for (const m of Object.values(mutables)) {
  for (const o of Object.values(m.overmaps)) {
    if (!terrains[baseType(o.overmap)]) throw new Error(`mutable special ${m.id}: unknown oter ${o.overmap}`);
    lateOm.push(o.overmap);
  }
}
// genVersion 3 lakes: the columns under every lake tile and the LAKE specials standing in them.
lateOm.push(...LAKE_COLUMN_OTERS);
for (const id of LAKE_SPECIALS) {
  const s = specials[id];
  if (!s) throw new Error(`LAKE_SPECIALS entry not found: ${id}`);
  for (const n of s.nested ?? []) if (!mutables[n.special]) throw new Error(`LAKE_SPECIALS ${id} nests ${n.special}, which isn't a kept mutable special`);
  s.overmaps.forEach((o) => o.om && lateOm.push(o.om));
}

const keptOm = new Set<any>();
const keptNested = new Set<string>();
const keptPalettes = new Set<string>();
const queue: any[] = [];
const scan = (o: any) => queue.push(o);
const enqueueOm = (id: string) => {
  for (const m of omtDefs.get(id) ?? []) if (!keptOm.has(m)) { keptOm.add(m); scan(m.object); }
};
for (const id of wantOm) enqueueOm(id);
// update_mapgen (mapgen with "update_mapgen_id"): only the ones dialogue, missions and EOCs
// can run (ids referenced from npcs.json, so run extract:npcs first), plus the palettes/
// nested chunks they and the missions' inline "update_mapgen" objects use. CDDA runs the
// first definition of an id (update_mapgens[id].funcs()[0]).
const npcsPath = join(OUT, 'npcs.json');
const npcsText = existsSync(npcsPath) ? readFileSync(npcsPath, 'utf8') : null;
if (!npcsText) console.warn(`${npcsPath} missing: no update_mapgen kept (run extract:npcs before extract:mapgen)`);
const updateDefs = new Map<string, any>();
for (const m of all('mapgen')) if (m.update_mapgen_id && !updateDefs.has(m.update_mapgen_id)) updateDefs.set(m.update_mapgen_id, m);
const keptUpdates = new Map<string, any>();
if (npcsText) {
  for (const [id, m] of updateDefs) if (npcsText.includes(JSON.stringify(id))) keptUpdates.set(id, m);
  // unshift: processed after everything the world generator needs, so the object order
  // (and thus mapgen.json) of the existing content doesn't change.
  for (const m of keptUpdates.values()) queue.unshift(m.object);
  for (const md of Object.values<any>(JSON.parse(npcsText).missions ?? {})) {
    for (const phase of ['start', 'end', 'fail']) {
      const um = md?.[phase]?.update_mapgen;
      for (const u of Array.isArray(um) ? um : um ? [um] : []) queue.unshift({ ...u, om_terrain: undefined });
    }
  }
}
// Strings anywhere inside kept objects that name nested chunks/palettes/terrains pull those
// in. Over-inclusion (a string that merely looks like an id) is harmless.
function drain(): void {
  while (queue.length) {
    const o = queue.pop();
    const visit = (v: any) => {
      if (typeof v === 'string') {
        if (nestedDefs.has(v) && !keptNested.has(v)) {
          keptNested.add(v);
          for (const n of nestedDefs.get(v)!) scan(n.object);
        }
        if (paletteRaw.has(v) && !keptPalettes.has(v)) {
          keptPalettes.add(v);
          scan(paletteRaw.get(v));
        }
        if (omtDefs.has(v) && !wantOm.has(v) && terrains[v]) {
          addOm(v);
          enqueueOm(v);
        }
      } else if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object') Object.values(v).forEach(visit);
    };
    visit(o);
  }
}
drain();
// Map extras of the transport terrains (every sewer OMT gets one of BN's mx_sewer_* layouts).
const mapExtraDefs = new Map(all('map_extra').map((o) => [o.id, o]));
const extraTables = new Map<string, { chance: number; values: { id: string; w: number; obj?: any; fn?: string }[] }>();
for (const key of TRANSPORT_EXTRAS) {
  const t = rs.map_extras?.[key];
  if (!t) throw new Error(`region_settings default has no map_extras.${key}`);
  const values = weights(t.extras, `map_extras.${key}`).map(([id, w]) => {
    const mx = mapExtraDefs.get(id);
    if (!mx) throw new Error(`map_extra ${id} (map_extras.${key}) not found`);
    const g = mx.generator ?? {};
    if (g.generator_method === 'update_mapgen') {
      const m = updateDefs.get(g.generator_id);
      if (!m) throw new Error(`map_extra ${id}: update_mapgen ${g.generator_id} not found`);
      queue.push(m.object);
      return { id, w, obj: m.object };
    }
    if (g.generator_method === 'map_extra_function') return { id, w, fn: g.generator_id as string };
    throw new Error(`map_extra ${id}: unsupported generator_method ${g.generator_method}`);
  });
  extraTables.set(key, { chance: Number(t.chance), values });
}
// Nested chunks only the extras use are written after everything else, so the object indices
// of the existing content don't move.
const firstPassNested = new Set(keptNested);
drain();
for (const id of lateOm) {
  const before = new Set(wantOm);
  addOm(id);
  for (const w of wantOm) if (!before.has(w)) enqueueOm(w);
}
drain();

// Item migrations (Item_factory::finalize applies these to every item group, and mapgen
// migrates single item ids when it spawns them).
const itemsPath = join(OUT, 'items.json');
const knownItems: Record<string, unknown> | null = existsSync(itemsPath) ? JSON.parse(readFileSync(itemsPath, 'utf8')) : null;
const migrations = new Map<string, ItemMigration>();
for (const m of all('MIGRATION')) {
  if (m.from_variant) continue;
  for (const id of objectIds(m)) {
    if (typeof m.replace !== 'string') migrations.delete(id);
    else migrations.set(id, m.variant ? { replace: m.replace, variant: m.variant } : { replace: m.replace });
  }
}
if (knownItems) for (const [id, m] of migrations) if (!knownItems[m.replace]) migrations.delete(id);
const migrateItem = (id: unknown) => (typeof id === 'string' ? migrations.get(id)?.replace ?? id : id);

/**
 * Mapgen inline item groups ("items": {"item": {...}}) use CDDA's raw group syntax; convert
 * them to the normalized ItemGroupDef the runtime expander reads (defaulting to
 * "collection", as jmapgen_item_group does), and migrate obsolete item ids.
 */
function normalizeMapgenItems(obj: any): any {
  const group = (e: any) => {
    if (e && typeof e === 'object' && e.item !== undefined && typeof e.item !== 'string') {
      const ref = normalizeGroupRef(e.item, 'collection') as ItemGroupRef;
      migrateGroup(ref, migrations);
      e.item = ref;
    }
  };
  const single = (e: any) => {
    if (e && typeof e === 'object' && typeof e.item === 'string') e.item = migrateItem(e.item);
  };
  const each = (v: any, f: (e: any) => void) => (Array.isArray(v) ? v.forEach(f) : f(v));
  for (const v of Object.values<any>(obj.items ?? {})) each(v, group);
  for (const v of Object.values<any>(obj.item ?? {})) each(v, single);
  for (const m of Object.values<any>(obj.mapping ?? {})) {
    if (m.items) each(m.items, group);
    if (m.item) each(m.item, single);
  }
  (obj.place_items ?? []).forEach(group);
  (obj.place_item ?? []).forEach(single);
  (obj.add ?? []).forEach(single); // BN: deprecated alias of place_item
  (obj.place_loot ?? []).forEach(single);
  for (const v of Object.values<any>(obj.sealed_item ?? {})) each(v, (e) => { group(e.items); single(e.item); });
  return obj;
}

const weightOf = (w: any): number => (w === undefined ? 1000 : typeof w === 'number' ? w : w.default ?? 1000);
const mapgenOut: MapgenData = { omt: {}, nested: {}, objects: [] };
for (const m of keptOm) {
  const o = mapgenOut.objects.push(normalizeMapgenItems(strip(m.object))) - 1;
  const w = weightOf(m.weight);
  const om = m.om_terrain;
  const add = (id: string, ox?: number, oy?: number) => {
    (mapgenOut.omt[id] ??= []).push(ox || oy ? { w, o, ox, oy } : { w, o });
  };
  if (typeof om === 'string') add(om);
  else if (om.every((e: any) => typeof e === 'string')) om.forEach((id: string) => add(id));
  else om.forEach((row: string[], ry: number) => row.forEach((id, rx) => add(id, rx * 24, ry * 24)));
}
const writeNested = (id: string) => {
  mapgenOut.nested[id] = nestedDefs.get(id)!.map((m) => ({ w: weightOf(m.weight), o: mapgenOut.objects.push(normalizeMapgenItems(strip(m.object))) - 1 }));
};
for (const id of firstPassNested) writeNested(id);
for (const [id, m] of [...keptUpdates].sort(([a], [b]) => (a < b ? -1 : 1))) {
  (mapgenOut.update ??= {})[id] = mapgenOut.objects.push(normalizeMapgenItems(strip(m.object))) - 1;
}
for (const id of keptNested) if (!firstPassNested.has(id)) writeNested(id);
mapgenOut.extras = {};
for (const [key, t] of extraTables) {
  mapgenOut.extras[key] = {
    chance: t.chance,
    values: t.values.map((v) => (v.obj ? { id: v.id, w: v.w, o: mapgenOut.objects.push(normalizeMapgenItems(strip(v.obj))) - 1 } : { id: v.id, w: v.w, fn: v.fn })),
  };
}
// Builtin (C++ / Lua) generators by mapgen id, for ids the generator may need.
mapgenOut.builtin = {};
for (const id of [...wantOm].sort()) {
  const name = luaBuiltins[id] ?? BN_HARDCODED[id] ?? terrains[id]?.builtin ?? (BN_CFUNCTIONS.has(id) ? id : undefined);
  if (name) mapgenOut.builtin[id] = name;
}
const palettesOut: Record<string, any> = {};
for (const id of keptPalettes) palettesOut[id] = normalizeMapgenItems(strip(paletteRaw.get(id)));

// ---------------------------------------------------------------------------------------
// Names

const names = JSON.parse(readFileSync(join(CDDA, 'data/names/en.json'), 'utf8')) as any[];
const nameList = (usage: string) => names.filter((n) => n.usage === usage).flatMap((n) => n.name as string[]);

// Only ship terrains/specials the generator can actually produce.
const usedSpecials: Record<string, SpecialDef> = {};
for (const id of [...cityIds, ...WILD_SPECIALS, ...MUTABLE_WILD_SPECIALS, ...LAKE_SPECIALS]) if (specials[id]) usedSpecials[id] = specials[id];
const usedTerrains: Record<string, OterDef> = {};
for (const id of wantOm) if (terrains[id]) usedTerrains[id] = terrains[id];
const overmapOut: OvermapData = {
  terrains: usedTerrains,
  specials: usedSpecials,
  locations,
  region,
  wildSpecials: WILD_SPECIALS,
  connections,
  mutableWildSpecials: MUTABLE_WILD_SPECIALS,
  lakeSpecials: LAKE_SPECIALS,
  names: { city: nameList('city'), given: nameList('given'), family: nameList('family') },
  mutables,
  connectionTerrains,
};

// ---------------------------------------------------------------------------------------
// Write

mapgenOut.objects = mapgenOut.objects.map(canonical);
for (const k of Object.keys(palettesOut)) palettesOut[k] = canonical(palettesOut[k]);
overmapOut.region = canonical(overmapOut.region);
console.log(`canonicalized ${aliasOf.size} terrain/furniture alias ids`);

const outputs: [string, unknown][] = [
  ['mapgen.json', mapgenOut],
  ['palettes.json', palettesOut],
  ['overmap.json', overmapOut],
];
console.log(`om_terrain ids with mapgen: ${Object.keys(mapgenOut.omt).length} (of ${omtDefs.size}), builtin: ${Object.keys(mapgenOut.builtin).length}, ` +
  `nested: ${keptNested.size} (of ${nestedDefs.size}), update_mapgen: ${keptUpdates.size} (of ${updateDefs.size}), palettes: ${keptPalettes.size} (of ${paletteRaw.size}), ` +
  `terrains: ${Object.keys(usedTerrains).length}, specials: ${Object.keys(usedSpecials).length}, mutable: ${Object.keys(mutables).length}`);
if (!DRY) mkdirSync(OUT, { recursive: true });
for (const [file, data] of outputs) {
  const text = JSON.stringify(data);
  console.log(`${DRY ? '[dry-run] would write' : 'wrote'} ${join(OUT, file)} (${(text.length / 1e6).toFixed(2)} MB)`);
  if (!DRY) writeFileSync(join(OUT, file), text);
}
