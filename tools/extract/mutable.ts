// BN "subtype": "mutable" overmap specials -> MutableSpecialDef (src/world/worldgen_data.ts).
// Mirrors the JSON reading in BN overmap.cpp (overmap_special::load, mutable_overmap_terrain /
// _join / _placement_rule deserialize) and turns its shorthands into one explicit shape, so the
// runtime solver (src/world/overmap/mutable.ts) never has to guess. Anything we don't model
// throws instead of being dropped.

import type {
  CubeDir, IntDistribution, MutableJoinDef, MutableOvermapDef, MutablePlacementRule, MutableSpecialDef,
  MutableTerrainJoin, SpecialConnection, ZConstraint,
} from '../../src/world/worldgen_data';

const CUBE: CubeDir[] = ['north', 'east', 'south', 'west', 'above', 'below'];
const OM_DIRS = ['north', 'east', 'south', 'west'];
const JOIN_TYPES = ['mandatory', 'optional', 'available', 'reject'];

const pt = (p: any): [number, number, number] => [p?.[0] ?? 0, p?.[1] ?? 0, p?.[2] ?? 0];
/** BN numeric_interval: [min, max] with max < min meaning unbounded (kept as written). */
const range = (v: any, def: [number, number]): [number, number] => (Array.isArray(v) ? [v[0], v[1]] : typeof v === 'number' ? [v, v] : def);

function dist(v: any, ctx: string): IntDistribution {
  if (typeof v === 'number') return v;
  if (Array.isArray(v) && v.length === 2) return [v[0], v[1]];
  if (v && typeof v === 'object' && typeof v.poisson === 'number') return { poisson: v.poisson };
  if (v && typeof v === 'object' && typeof v.chance === 'number') return { chance: v.chance };
  throw new Error(`${ctx}: unrecognized int_distribution ${JSON.stringify(v)}`);
}

function zc(v: any, ctx: string): ZConstraint | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'number' || v === 'top' || v === 'bottom') return v;
  if (Array.isArray(v) && v.length === 2) return [v[0], v[1]];
  if (v && typeof v === 'object' && (v.top !== undefined || v.bottom !== undefined)) return { top: v.top, bottom: v.bottom };
  throw new Error(`${ctx}: unrecognized z constraint ${JSON.stringify(v)}`);
}

function terrainJoin(v: any, ctx: string): MutableTerrainJoin {
  if (typeof v === 'string') return { id: v, type: 'mandatory' };
  if (v && typeof v === 'object' && typeof v.id === 'string') {
    const type = v.type ?? 'mandatory';
    if (!JOIN_TYPES.includes(type)) throw new Error(`${ctx}: unknown join type ${type}`);
    const out: MutableTerrainJoin = { id: v.id, type };
    if (v.alternatives?.length) out.alternatives = [...v.alternatives];
    return out;
  }
  throw new Error(`${ctx}: expected join string or object, got ${JSON.stringify(v)}`);
}

function rot(v: any, ctx: string): number {
  if (v === undefined) return 0;
  const i = OM_DIRS.indexOf(v);
  if (i < 0) throw new Error(`${ctx}: unknown rot ${JSON.stringify(v)}`);
  return i;
}

export function normalizeMutableSpecial(o: any): MutableSpecialDef {
  const ctx = `mutable special ${o.id}`;
  const locations: string[] = o.locations ?? [];
  if (!locations.length) throw new Error(`${ctx}: no default locations`);
  const joins: MutableJoinDef[] = (o.joins ?? []).map((j: any) => {
    if (typeof j === 'string') return { id: j };
    const out: MutableJoinDef = { id: j.id };
    if (j.opposite) out.opposite = j.opposite;
    if (j.into_locations?.length) out.into_locations = [...j.into_locations];
    return out;
  });
  const overmaps: Record<string, MutableOvermapDef> = {};
  for (const [key, t] of Object.entries<any>(o.overmaps ?? {})) {
    const def: MutableOvermapDef = { overmap: t.overmap, joins: {} };
    if (typeof t.overmap !== 'string') throw new Error(`${ctx}: overmap ${key} lacks an oter id`);
    if (t.locations?.length) def.locations = [...t.locations];
    for (const d of CUBE) if (t[d] !== undefined) def.joins[d] = terrainJoin(t[d], `${ctx} overmap ${key} ${d}`);
    if (t.connections) {
      def.connections = {};
      for (const [d, c] of Object.entries<any>(t.connections)) {
        if (!CUBE.includes(d as CubeDir)) throw new Error(`${ctx} overmap ${key}: bad connection direction ${d}`);
        def.connections[d as CubeDir] = c.connection;
      }
    }
    overmaps[key] = def;
  }
  const phases: MutablePlacementRule[][] = (o.phases ?? []).map((phase: any[]) => phase.map((r: any): MutablePlacementRule => {
    const rctx = `${ctx} rule ${r.name ?? r.overmap ?? '(chunk)'}`;
    if (r.om_pos !== undefined) throw new Error(`${rctx}: om_pos (absolute overmap position) is not supported`);
    const pieces = r.overmap !== undefined ? [{ overmap: r.overmap, pos: [0, 0, 0] as [number, number, number], rot: 0 }]
      : Array.isArray(r.chunk) ? r.chunk.map((c: any) => ({ overmap: c.overmap, pos: pt(c.pos), rot: rot(c.rot, rctx) }))
      : undefined;
    if (!pieces?.length) throw new Error(`${rctx}: placement rule must specify "overmap" or "chunk"`);
    const out: MutablePlacementRule = { pieces };
    if (r.name) out.name = r.name;
    if (r.join) out.join = r.join;
    if (r.scale) out.scale = r.scale;
    const z = zc(r.z, rctx);
    if (z !== undefined) out.z = z;
    if (r.rotate !== undefined) out.rotate = !!r.rotate;
    if (r.max !== undefined) out.max = dist(r.max, `${rctx} max`);
    if (r.weight !== undefined) out.weight = r.weight;
    return out;
  }));
  const check: MutableSpecialDef['checkForLocations'] = (o.check_for_locations ?? []).map((e: any) => ({ p: pt(e[0]), locations: [...e[1]] }));
  // BN check_for_locations_area: every point of the (swapped-to-ascending) box gets the types.
  for (const a of o.check_for_locations_area ?? []) {
    const f = pt(a.from), t = pt(a.to);
    const [x0, x1] = [Math.min(f[0], t[0]), Math.max(f[0], t[0])];
    const [y0, y1] = [Math.min(f[1], t[1]), Math.max(f[1], t[1])];
    const [z0, z1] = [Math.min(f[2], t[2]), Math.max(f[2], t[2])];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) check.push({ p: [x, y, z], locations: [...a.type] });
  }
  const shared: Record<string, IntDistribution> = {};
  for (const [k, v] of Object.entries<any>(o.shared ?? {})) shared[k] = dist(v, `${ctx} shared ${k}`);
  const out: MutableSpecialDef = {
    id: o.id,
    locations,
    cityDistance: range(o.city_distance, [0, -1]),
    citySizes: range(o.city_sizes, [0, -1]),
    occurrences: range(o.occurrences, [0, 0]),
    flags: o.flags ?? [],
    rotate: o.rotate === undefined ? true : !!o.rotate,
    connections: (o.connections ?? []).map((c: any): SpecialConnection => ({
      p: pt(c.point), terrain: c.terrain, connection: c.connection, from: c.from ? pt(c.from) : undefined, existing: c.existing,
    })),
    checkForLocations: check,
    joins,
    overmaps,
    root: o.root,
    shared,
    phases,
  };
  if (Array.isArray(o.place_nested) && o.place_nested.length) out.nested = o.place_nested.map((n: any) => ({ p: pt(n.point), special: n.special }));
  if (o.spawns) out.spawns = { group: o.spawns.group, population: range(o.spawns.population, [0, 0]), radius: range(o.spawns.radius, [0, 0]) };
  if (!overmaps[out.root]) throw new Error(`${ctx}: root ${out.root} is not one of its overmaps`);
  return out;
}
