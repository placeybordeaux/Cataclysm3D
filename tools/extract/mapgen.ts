// Extract CDDA worldgen content (mapgen, palettes, overmap terrains/specials, region
// settings, city names) into compact JSON under public/data/.
//
// Usage: npm run extract:mapgen -- [--cdda ~/code/Cataclysm-DDA] [--out public/data] [--dry-run]
//   --dry-run   parse + report sizes/stats, write nothing
//
// Only mapgen reachable from what our overmap generator can place is kept (city buildings
// from region settings, the wilderness specials whitelisted below, and base terrains),
// closed over nested chunks, palettes and predecessor terrains. That keeps mapgen.json
// a few MB instead of ~8 MB of labs/dimensions/basecamps we never generate.

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type {
  ForestBiome, MapgenData, OterDef, OvermapData, RegionSettings, SpecialDef, SpecialOvermap,
} from '../../src/world/worldgen_data';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`extract:mapgen - CDDA mapgen/overmap JSON -> public/data/{mapgen,palettes,overmap}.json
  --cdda <dir>   CDDA checkout (default ~/code/Cataclysm-DDA)
  --out <dir>    output dir (default public/data)
  --dry-run      don't write files, just report`);
  process.exit(0);
}
const arg = (name: string, def: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const CDDA = resolve(arg('--cdda', join(homedir(), 'code/Cataclysm-DDA')));
const OUT = resolve(arg('--out', 'public/data'));
const DRY = argv.includes('--dry-run');
const DATA = join(CDDA, 'data/json');

/** Wilderness overmap specials we scatter outside towns (must exist, non-mutable). */
export const WILD_SPECIALS = [
  'Evac Shelter', 'Evac Shelter Unfinished', 'Rural Gas Station', 'cemetery', 'cemetery_religious',
  'church_rural', 'Dairy Farm', 'Apple Orchard', 'Cabin', 'Cabin_1', 'Cabin_2', 'Cabin_3', 'Cabin_4',
  'rural_house', 'rural_house_yard', 'campsite', 'junkyard', 'Radio Tower', 'desolate barn',
  'Hunting Blind', 'LMOE Shelter', 'Pond', 'Derelict Property', 'Moonshine Still', 'Sugar House',
  'shooting range', '4x4_microlab_surface', 'Cave', 'Toxic Waste Dump', 'Swamp Shack',
];

/** Base terrains the overmap generator emits directly. */
const BASE_OTERS = [
  'field', 'forest', 'forest_thick', 'forest_water', 'road', 'road_nesw_manhole', 'river',
  'river_center', 'lake_surface', 'lake_shore', 'open_air', 'solid_earth', 'empty_rock', 'deep_rock',
];
const LINEAR_SUFFIXES = ['_straight', '_curved', '_end', '_tee', '_four_way'];
const DIRS = ['_north', '_east', '_south', '_west'];

// ---------------------------------------------------------------------------------------
// Load

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.json')) out.push(p);
  }
  return out;
}

const byType = new Map<string, any[]>();
let files = 0;
for (const f of walk(DATA)) {
  let d: any;
  try {
    d = JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse ${f}: ${e}`);
  }
  files++;
  for (const o of Array.isArray(d) ? d : [d]) {
    if (!o || typeof o !== 'object' || typeof o.type !== 'string') continue;
    let l = byType.get(o.type);
    if (!l) byType.set(o.type, (l = []));
    l.push(o);
  }
}
const all = (t: string) => byType.get(t) ?? [];
console.log(`read ${files} files from ${DATA}`);

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
const str = (v: any): string => (typeof v === 'string' ? v : v?.str ?? v?.str_sp ?? String(v ?? ''));
const ids = (v: any): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// ---------------------------------------------------------------------------------------
// Overmap terrains (copy-from / extend / delete resolution)

const oterRaw = new Map<string, any>();
for (const o of all('overmap_terrain')) {
  if (o.abstract) oterRaw.set(o.abstract, o);
  for (const id of ids(o.id)) oterRaw.set(id, { ...o, id });
}
const oterResolved = new Map<string, any>();
function resolveOter(id: string, depth = 0): any {
  const done = oterResolved.get(id);
  if (done) return done;
  const raw = oterRaw.get(id);
  if (!raw) throw new Error(`overmap_terrain copy-from target missing: ${id}`);
  if (depth > 20) throw new Error(`copy-from loop at ${id}`);
  const base = raw['copy-from'] ? resolveOter(raw['copy-from'], depth + 1) : {};
  const r: any = { ...base, ...raw };
  let flags: string[] = raw.flags ? [...raw.flags] : [...(base.flags ?? [])];
  if (raw.extend?.flags) flags.push(...raw.extend.flags);
  if (raw.delete?.flags) flags = flags.filter((f) => !raw.delete.flags.includes(f));
  r.flags = [...new Set(flags)];
  oterResolved.set(id, r);
  return r;
}
const terrains: Record<string, OterDef> = {};
for (const o of all('overmap_terrain')) {
  for (const id of ids(o.id)) {
    const r = resolveOter(id);
    const def: OterDef = { id, name: str(r.name) || id, sym: str(r.sym ?? '?'), color: str(r.color ?? 'white'), flags: r.flags };
    if (r.uniform_terrain) def.uniform = r.uniform_terrain;
    const b = Array.isArray(r.mapgen) ? r.mapgen.find((m: any) => m.builtin) : undefined;
    if (b) def.builtin = b.builtin;
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
  }
}
for (const w of WILD_SPECIALS) if (!specials[w]) throw new Error(`WILD_SPECIALS entry not found: ${w}`);

const locations: Record<string, string[]> = {};
for (const o of all('overmap_location')) locations[o.id] = o.terrains ?? [];

// ---------------------------------------------------------------------------------------
// Region settings (id "default"), with forest biomes and region pseudo terrain resolved.

const byId = (type: string, id: string) => {
  const o = all(type).find((x) => x.id === id);
  if (!o) throw new Error(`${type} ${id} not found`);
  return o;
};
const rs = byId('region_settings', 'default');
const rsCity = byId('region_settings_city', rs.cities);
const rsForest = byId('region_settings_forest', rs.forests);
const rsLake = byId('region_settings_lake', rs.lakes);
const rsComp = byId('region_settings_forest_mapgen', rs.forest_composition);
const componentRaw = new Map(all('forest_biome_component').map((c) => [c.id, c]));
const resolveComponent = (id: string): any => {
  const c = componentRaw.get(id);
  if (!c) throw new Error(`forest_biome_component ${id} missing`);
  return c['copy-from'] ? { ...resolveComponent(c['copy-from']), ...c } : c;
};
const forestBiomes: ForestBiome[] = rsComp.biomes.map((bid: string) => {
  const b = byId('forest_biome_mapgen', bid);
  const comps = (b.components as string[]).map(resolveComponent).sort((a, c) => (a.sequence ?? 0) - (c.sequence ?? 0));
  return {
    id: b.id,
    terrains: b.terrains ?? [],
    sparseness_adjacency_factor: b.sparseness_adjacency_factor ?? 0,
    item_group: b.item_group,
    item_group_chance: b.item_group_chance,
    item_spawn_iterations: b.item_spawn_iterations,
    groundcover: b.groundcover ?? [],
    components: comps.map((c) => ({ chance: c.chance, types: c.types })),
    terrain_furniture: b.terrain_furniture,
  } satisfies ForestBiome;
});
const tf = byId('region_settings_terrain_furniture', rs.terrain_furniture);
const regionTerrain: Record<string, [string, number][]> = {};
const regionFurniture: Record<string, [string, number][]> = {};
for (const id of tf.ter_furn as string[]) {
  const o = byId('region_terrain_furniture', id);
  if (o.ter_id) regionTerrain[o.ter_id] = o.replace_with_terrain;
  if (o.furn_id) regionFurniture[o.furn_id] = o.replace_with_furniture;
}
const region: RegionSettings = {
  default_groundcover: rs.default_groundcover,
  city: {
    city_size: rsCity.city_size, city_spacing: rsCity.city_spacing,
    shop_radius: rsCity.shop_radius, shop_sigma: rsCity.shop_sigma,
    park_radius: rsCity.park_radius, park_sigma: rsCity.park_sigma,
    houses: rsCity.houses, shops: rsCity.shops, parks: rsCity.parks,
  },
  forest: {
    noise_threshold_forest: rsForest.noise_threshold_forest,
    noise_threshold_forest_thick: rsForest.noise_threshold_forest_thick,
    noise_threshold_swamp_adjacent_water: rsForest.noise_threshold_swamp_adjacent_water,
    noise_threshold_swamp_isolated: rsForest.noise_threshold_swamp_isolated,
  },
  lake: { noise_threshold_lake: rsLake.noise_threshold_lake, lake_size_min: rsLake.lake_size_min },
  forestBiomes,
  regionTerrain,
  regionFurniture,
};

// ---------------------------------------------------------------------------------------
// Terrain roofs (for auto-roofing z+1 over terrain that declares one)

const terRaw = new Map<string, any>();
for (const o of all('terrain')) {
  if (o.abstract) terRaw.set(o.abstract, o);
  for (const id of ids(o.id)) terRaw.set(id, o);
}
const roofOf = (id: string, depth = 0): string | undefined => {
  const o = terRaw.get(id);
  if (!o || depth > 20) return undefined;
  if (o.roof !== undefined) return o.roof || undefined;
  return o['copy-from'] ? roofOf(o['copy-from'], depth + 1) : undefined;
};
const terrainRoof: Record<string, string> = {};
for (const o of all('terrain')) for (const id of ids(o.id)) {
  const r = roofOf(id);
  if (r) terrainRoof[id] = r;
}

// ---------------------------------------------------------------------------------------
// Mapgen reachability

const mapgens = all('mapgen').filter((m) => !m.update_mapgen_id);
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
const cityIds = [...region.city.houses, ...region.city.shops, ...region.city.parks].map(([id]) => id);
for (const id of [...cityIds, ...WILD_SPECIALS]) {
  const s = specials[id];
  if (s) s.overmaps.forEach((o) => o.om && addOm(o.om));
  else if (terrains[id]) addOm(id);
  else console.warn(`region/whitelist entry is neither special nor terrain: ${id}`);
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
// Strings anywhere inside kept objects that name nested chunks/palettes/terrains pull those
// in. Over-inclusion (a string that merely looks like an id) is harmless.
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

const weightOf = (w: any): number => (w === undefined ? 1000 : typeof w === 'number' ? w : w.default ?? 1000);
const mapgenOut: MapgenData = { omt: {}, nested: {}, objects: [] };
for (const m of keptOm) {
  const o = mapgenOut.objects.push(strip(m.object)) - 1;
  const w = weightOf(m.weight);
  const om = m.om_terrain;
  const add = (id: string, ox?: number, oy?: number) => {
    (mapgenOut.omt[id] ??= []).push(ox || oy ? { w, o, ox, oy } : { w, o });
  };
  if (typeof om === 'string') add(om);
  else if (om.every((e: any) => typeof e === 'string')) om.forEach((id: string) => add(id));
  else om.forEach((row: string[], ry: number) => row.forEach((id, rx) => add(id, rx * 24, ry * 24)));
}
for (const id of keptNested) {
  mapgenOut.nested[id] = nestedDefs.get(id)!.map((m) => ({ w: weightOf(m.weight), o: mapgenOut.objects.push(strip(m.object)) - 1 }));
}
const palettesOut: Record<string, any> = {};
for (const id of keptPalettes) palettesOut[id] = strip(paletteRaw.get(id));

// ---------------------------------------------------------------------------------------
// Names

const names = JSON.parse(readFileSync(join(CDDA, 'data/names/en.json'), 'utf8')) as any[];
const nameList = (usage: string) => names.filter((n) => n.usage === usage).flatMap((n) => n.name as string[]);

// Only ship terrains/specials the generator can actually produce.
const usedSpecials: Record<string, SpecialDef> = {};
for (const id of [...cityIds, ...WILD_SPECIALS]) if (specials[id]) usedSpecials[id] = specials[id];
const usedTerrains: Record<string, OterDef> = {};
for (const id of wantOm) if (terrains[id]) usedTerrains[id] = terrains[id];
const overmapOut: OvermapData = {
  terrains: usedTerrains,
  specials: usedSpecials,
  locations,
  region,
  wildSpecials: WILD_SPECIALS,
  names: { city: nameList('city'), given: nameList('given'), family: nameList('family') },
  terrainRoof,
};

// ---------------------------------------------------------------------------------------
// Write

const outputs: [string, unknown][] = [
  ['mapgen.json', mapgenOut],
  ['palettes.json', palettesOut],
  ['overmap.json', overmapOut],
];
console.log(`om_terrain ids with mapgen: ${Object.keys(mapgenOut.omt).length} (of ${omtDefs.size}), ` +
  `nested: ${keptNested.size} (of ${nestedDefs.size}), palettes: ${keptPalettes.size} (of ${paletteRaw.size}), ` +
  `terrains: ${Object.keys(usedTerrains).length}, specials: ${Object.keys(usedSpecials).length}`);
if (!DRY) mkdirSync(OUT, { recursive: true });
for (const [file, data] of outputs) {
  const text = JSON.stringify(data);
  console.log(`${DRY ? '[dry-run] would write' : 'wrote'} ${join(OUT, file)} (${(text.length / 1e6).toFixed(2)} MB)`);
  if (!DRY) writeFileSync(join(OUT, file), text);
}
