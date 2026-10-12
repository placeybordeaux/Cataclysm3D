import { Rng } from '../../core/rng';
import { MAX_Z, MIN_Z } from '../coords';
import type { CubeDir, MutableSpecialDef, OvermapData, SpecialConnection, SpecialDef, SpecialSpawns } from '../worldgen_data';
import { mutableRequiredLocations, placeMutable, type MutableGrid, type MutablePlacement } from './mutable';
import { rotateOffset } from './oter';
import type { City, ConnectionRequest, SpecialInstance } from './overmap';

// Scatters BN's mutable wilderness specials (Anthill, Acid Anthill, Lab with Anthill, Slime Pit,
// Ice Lab, stream_mutable) and the mines that nest mine_tunnel over one region, from genVersion 2.
// Port of overmap.cpp place_specials / place_special_attempt / random_special_rotation /
// can_place_special / place_special, restricted to the specials in OvermapData.mutableWildSpecials.
//
// Differences from BN, all forced by our 96x96 regions standing in for BN's 180x180 overmaps:
//  - occurrences are per 180x180 overmap; counts are scaled by REGION_AREA (UNIQUE: a
//    min/max * REGION_AREA chance of one per region instead of min/max per overmap);
//  - the candidate-point pool is shared only between these specials (the older wilderness
//    specials were placed by Overmap.placeSpecials and simply occupy their terrain);
//  - nothing may touch a region's outermost ring (roads cross there through portals).

export interface MutableHost {
  readonly data: OvermapData;
  readonly regionSize: number;
  /** cities of this region (global coords) */
  readonly cities: readonly City[];
  readonly x0: number;
  readonly y0: number;
  /** region-local OMT type (the default terrain where nothing was placed) */
  typeAt(x: number, y: number, z: number): string;
  accepts(location: string, type: string): boolean;
  defaultTerrain(z: number): string;
  /** write `oter` (BN id, may carry a direction / line suffix) turned by `rot`, owned by `uid` */
  setTerrain(x: number, y: number, z: number, oter: string, rot: number, uid: number): void;
  newInstance(def: string, x: number, y: number, rot: number, city: City | undefined): SpecialInstance;
  placeFixed(def: SpecialDef, x: number, y: number, rot: number, city: City | undefined): SpecialInstance;
  /** BN place_special's monster group at the special's origin (region-local); a no-op below genVersion 3 */
  addSpawns(inst: SpecialInstance, spawns: SpecialSpawns, x: number, y: number, z: number): void;
  /** BN local_road connection to (x, y, 0): link it to the nearest road */
  buildLocalRoad(x: number, y: number): void;
  requestConnection(c: ConnectionRequest): void;
  /** BN overmap::joins_used (region-local position) for mapgen's "joins" conditions */
  recordJoin(x: number, y: number, z: number, dir: CubeDir, id: string): void;
  /** BN place_nested lab_basement: Overmap.placeLabBasement grows it (its own RNG, escape-cell rules) */
  placeLabBasement(rng: Rng, inst: SpecialInstance, x: number, y: number, z: number, rot: number): void;
  /** every mutable special grown, with the solver's verdict (tests, debug probes) */
  report?(inst: SpecialInstance, res: MutablePlacement): void;
}

/** One BN overmap is 180x180 OMTs; our regions are smaller. */
const BN_OMAP = 180;
/** BN SPECIALS_SPACING default (options.cpp). */
const SPECIALS_SPACING = 6;
/** BN allows z -10..10 (OVERMAP_DEPTH / OVERMAP_HEIGHT); our map only has MIN_Z..MAX_Z. */
const Z_MIN = MIN_Z, Z_MAX = MAX_Z;
const WATER = new Set(['river_center', 'lake_surface', 'river', 'lake_shore']);
/** overmap_connection default/own terrains (BN overmap_connections.json) */
const CONNECTION_TERRAINS: Record<string, string[]> = {
  local_road: ['road', 'road_nesw_manhole', 'bridge', 'dam'],
  sewer_tunnel: ['sewer'],
  subway_tunnel: ['subway', 'underground_sub_station'],
};

type Loc = { p: [number, number, number]; locations: string[] };
interface Entry {
  id: string;
  mut?: MutableSpecialDef;
  fixed?: SpecialDef;
  flags: string[];
  occurrences: [number, number];
  cityDistance: [number, number];
  citySizes: [number, number];
  connections: SpecialConnection[];
  nested: { p: [number, number, number]; special: string }[];
  rotatable: boolean;
  required: Loc[];
}

/** BN numeric_interval reads [min, max] with max < min as "no upper bound". */
const within = ([lo, hi]: [number, number], v: number) => v >= lo && (hi < lo || v <= hi);
const bounded = ([lo, hi]: [number, number]) => hi >= lo;

function rollRemainder(v: number, rng: Rng): number {
  const i = Math.floor(v);
  return i + (rng.next() < v - i ? 1 : 0);
}

export function placeMutableSpecials(h: MutableHost, rng: Rng): void {
  const ids = h.data.mutableWildSpecials;
  if (!ids?.length) return;
  const N = h.regionSize;
  const regionArea = (N * N) / (BN_OMAP * BN_OMAP);
  const entries = ids.map((id) => entryFor(h.data, id));

  const inbounds = (x: number, y: number, z: number, margin: number) =>
    x >= margin && y >= margin && x < N - margin && y < N - margin && z >= Z_MIN && z <= Z_MAX;

  // BN place_specials zones: specials needing a z0 location go to the "land" pool of tiles some
  // such special could stand on; the rest (none of ours today) to every non-water tile.
  const landLocs = new Set<string>();
  const isLand = (e: Entry) => e.required.some((l) => l.p[2] === 0);
  for (const e of entries) {
    if (e.flags.includes('LAKE') || e.flags.includes('RIVER')) throw new Error(`mutable special ${e.id}: LAKE/RIVER specials are not supported`);
    if (isLand(e)) for (const l of e.required) if (l.p[2] === 0) l.locations.forEach((x) => landLocs.add(x));
  }
  const pools: Record<'land' | 'under', number[]> = { land: [], under: [] };
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const t = h.typeAt(x, y, 0);
      if (WATER.has(t)) continue;
      pools.under.push(y * N + x);
      if ([...landLocs].some((l) => h.accepts(l, t))) pools.land.push(y * N + x);
    }
  // BN zone_ratio for the non-unique counts (crowding and SPECIALS_DENSITY taken as 1).
  const ratio = { land: pools.land.length / (N * N), under: pools.under.length / (N * N) };
  const removed = new Uint8Array(N * N);
  for (const pool of Object.values(pools)) {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
  }

  // BN sorts by special_area (z0 locations for land specials, the rest otherwise), biggest first.
  const area = (e: Entry) => e.required.filter((l) => (isLand(e) ? l.p[2] === 0 : l.p[2] !== 0)).length;
  const order = entries.map((e, i) => [e, i] as const).sort((a, b) => area(b[0]) - area(a[0]) || a[1] - b[1]).map(([e]) => e);

  const among = (x: number, y: number, z: number, locs: readonly string[]) => {
    const t = h.typeAt(x, y, z);
    return locs.some((l) => h.accepts(l, t));
  };
  const nested = (e: Entry) => e.nested.map((n) => ({ n, def: entryFor(h.data, n.special) }));
  const requiredWithNested = (e: Entry): Loc[] => {
    const out = [...e.required];
    for (const { n, def } of nested(e)) {
      for (const l of def.required) out.push({ p: [l.p[0] + n.p[0], l.p[1] + n.p[1], l.p[2] + n.p[2]], locations: l.locations });
    }
    return out;
  };
  /** BN overmap::can_place_special */
  const canPlace = (locs: Loc[], x: number, y: number, rot: number) => locs.every((l) => {
    const [dx, dy] = rotateOffset(l.p[0], l.p[1], rot);
    const px = x + dx, py = y + dy, pz = l.p[2];
    if (!inbounds(px, py, pz, 1)) return false;
    return among(px, py, pz, l.locations) || (pz !== 0 && h.typeAt(px, py, pz) === h.defaultTerrain(pz));
  });
  const belongsTo = (conn: string, t: string) => (CONNECTION_TERRAINS[conn] ?? []).includes(t);
  /** BN overmap_connection::can_start_at, reduced to the connections our specials use. */
  const canStartAt = (conn: string, t: string, z: number) => {
    if (conn === 'local_road') return z === 0 && (belongsTo(conn, t) || WATER.has(t) || h.accepts('land', t));
    return t === h.defaultTerrain(z) || belongsTo(conn, t);
  };
  /** BN random_special_rotation: rotations satisfying the most connections, shuffled, first that fits. */
  const pickRotation = (e: Entry, locs: Loc[], x: number, y: number): number => {
    const best: number[] = [];
    let top = 0;
    for (let r = 0; r < 4; r++) {
      let score = 0, valid = true;
      for (const c of e.connections) {
        if (!c.connection) continue;
        const [dx, dy] = rotateOffset(c.p[0], c.p[1], r);
        const px = x + dx, py = y + dy;
        if (!inbounds(px, py, c.p[2], 0)) {
          valid = false;
          break;
        }
        const t = h.typeAt(px, py, c.p[2]);
        if (belongsTo(c.connection, t)) score++;
        else if (c.existing || !canStartAt(c.connection, t, c.p[2])) {
          valid = false;
          break;
        }
      }
      if (valid && score >= top) {
        if (score > top) (top = score), (best.length = 0);
        best.push(r);
      }
      if (!e.rotatable) break;
    }
    for (let i = best.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [best[i], best[j]] = [best[j], best[i]];
    }
    return best.find((r) => canPlace(locs, x, y, r)) ?? -1;
  };
  const nearestCity = (x: number, y: number): City | undefined => {
    let best: City | undefined, bd = 999;
    for (const c of h.cities) {
      const d = cityDistanceFrom(c, h.x0 + x, h.y0 + y);
      if (d < bd) (bd = d), (best = c);
    }
    return best;
  };

  const connect = (inst: SpecialInstance, conns: { connection: string; x: number; y: number; z: number }[]) => {
    for (const c of conns) {
      if (!inbounds(c.x, c.y, c.z, 0)) continue;
      if (!canStartAt(c.connection, h.typeAt(c.x, c.y, c.z), c.z)) continue;
      if (c.connection === 'local_road' && c.z === 0) h.buildLocalRoad(c.x, c.y);
      else h.requestConnection({ x: c.x, y: c.y, z: c.z, connection: c.connection, uid: inst.uid });
    }
  };

  /** BN overmap::place_special; returns the OMTs it used. */
  const place = (e: Entry, x: number, y: number, z: number, rot: number, city: City | undefined): [number, number, number][] => {
    const used: [number, number, number][] = [];
    let inst: SpecialInstance;
    const conns: { connection: string; x: number; y: number; z: number }[] = [];
    if (e.mut) {
      inst = h.newInstance(e.id, h.x0 + x, h.y0 + y, rot, city);
      const res = placeMutable(e.mut, gridFor(h, inst.uid, inbounds), rng, x, y, z, rot);
      h.report?.(inst, res);
      // BN place_special puts the group at `p`, the root, whichever way the special grew.
      if (e.mut.spawns) h.addSpawns(inst, e.mut.spawns, x, y, z);
      for (const [jx, jy, jz, dir, id] of res.joinsUsed) h.recordJoin(jx, jy, jz, dir, id);
      for (const p of res.placed) used.push([p.x, p.y, p.z]);
      for (const c of res.connections) conns.push(c);
    } else {
      inst = h.placeFixed(e.fixed!, x, y, rot, city);
      for (const o of e.fixed!.overmaps) {
        const [dx, dy] = rotateOffset(o.p[0], o.p[1], rot);
        if (o.om) used.push([x + dx, y + dy, z + o.p[2]]);
      }
    }
    for (const c of e.connections) {
      if (!c.connection) continue;
      const [dx, dy] = rotateOffset(c.p[0], c.p[1], rot);
      conns.push({ connection: c.connection, x: x + dx, y: y + dy, z: z + c.p[2] });
    }
    connect(inst, conns);
    for (const { n, def } of nested(e)) {
      const [dx, dy] = rotateOffset(n.p[0], n.p[1], rot);
      const nx = x + dx, ny = y + dy, nz = z + n.p[2];
      if (n.special === 'lab_basement') {
        h.placeLabBasement(rng, inst, nx, ny, nz, rot);
        continue;
      }
      const locs = requiredWithNested(def).map((l) => ({ ...l, p: [l.p[0], l.p[1], l.p[2] + nz] as [number, number, number] }));
      if (canPlace(locs, nx, ny, rot)) used.push(...place(def, nx, ny, nz, rot, nearestCity(nx, ny)));
    }
    return used;
  };

  for (const e of order) {
    const zone = isLand(e) ? 'land' : 'under';
    const [lo, hi] = e.occurrences;
    let amount: number;
    if (e.flags.includes('UNIQUE') || e.flags.includes('GLOBALLY_UNIQUE')) {
      // BN x_in_y(min, max): one per overmap with probability min/max.
      amount = hi > 0 && rng.next() < (lo / hi) * regionArea ? 1 : 0;
    } else {
      const realMax = Math.max(lo, hi * ratio[zone]);
      amount = rollRemainder((lo + rng.next() * (realMax - lo)) * regionArea, rng);
    }
    if (amount < 1) continue;

    // BN place_special_attempt
    const needCity = e.citySizes[0] > 0 || (bounded(e.cityDistance) && e.cityDistance[1] < BN_OMAP);
    const perCity = new Map<City, number>();
    let maxPerCity = Infinity;
    if (needCity) {
      for (const c of h.cities) if (within(e.citySizes, c.size)) perCity.set(c, 0);
      if (!perCity.size) continue;
      maxPerCity = Math.ceil(amount / perCity.size);
    }
    const locs = requiredWithNested(e);
    let placed = 0;
    for (const idx of pools[zone]) {
      if (removed[idx]) continue;
      const x = idx % N, y = Math.floor(idx / N);
      const city = nearestCity(x, y);
      if (needCity) {
        const n = city && perCity.get(city);
        // BN can_belong_to_city subtracts the city size twice (get_distance_from already did once).
        if (!city || n === undefined || n >= maxPerCity || !within(e.cityDistance, cityDistanceFrom(city, h.x0 + x, h.y0 + y) - city.size)) continue;
      }
      const rot = pickRotation(e, locs, x, y);
      if (rot < 0) continue;
      const used = place(e, x, y, 0, rot, city);
      if (needCity && city) perCity.set(city, perCity.get(city)! + 1);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [ux, uy, uz] of used) {
        if (uz !== 0) continue;
        x0 = Math.min(x0, ux), y0 = Math.min(y0, uy), x1 = Math.max(x1, ux), y1 = Math.max(y1, uy);
      }
      for (let yy = Math.max(0, y0 - SPECIALS_SPACING); yy <= Math.min(N - 1, y1 + SPECIALS_SPACING); yy++)
        for (let xx = Math.max(0, x0 - SPECIALS_SPACING); xx <= Math.min(N - 1, x1 + SPECIALS_SPACING); xx++) removed[yy * N + xx] = 1;
      removed[idx] = 1;
      if (++placed >= amount) break;
    }
  }
}

/** BN city::get_distance_from: max(trig_dist - size, 0). */
function cityDistanceFrom(c: City, x: number, y: number): number {
  return Math.max(Math.floor(Math.hypot(c.x - x, c.y - y)) - c.size, 0);
}

function gridFor(h: MutableHost, uid: number, inbounds: (x: number, y: number, z: number, m: number) => boolean): MutableGrid {
  return {
    inbounds: (x, y, z) => inbounds(x, y, z, 1),
    isAmong: (x, y, z, locs) => {
      const t = h.typeAt(x, y, z);
      return locs.some((l) => h.accepts(l, t));
    },
    set: (x, y, z, oter, rot) => h.setTerrain(x, y, z, oter, rot, uid),
    describe: (x, y, z) => h.typeAt(x, y, z),
  };
}

function entryFor(data: OvermapData, id: string): Entry {
  const mut = data.mutables?.[id];
  if (mut) {
    return {
      id, mut, flags: mut.flags, occurrences: mut.occurrences, cityDistance: mut.cityDistance, citySizes: mut.citySizes,
      connections: mut.connections, nested: mut.nested ?? [], rotatable: mut.rotate, required: mutableRequiredLocations(mut),
    };
  }
  const fixed = data.specials[id];
  if (!fixed) throw new Error(`mutable placement: ${id} is neither a mutable nor a fixed special in overmap.json`);
  return {
    id, fixed, flags: fixed.flags, occurrences: fixed.occurrences,
    // our fixed-special extraction writes "no constraint" as [-1, -1]
    cityDistance: fixed.cityDistance[0] < 0 && fixed.cityDistance[1] < 0 ? [0, -1] : fixed.cityDistance,
    citySizes: fixed.citySizes,
    connections: fixed.connections, nested: fixed.nested ?? [], rotatable: !fixed.flags.includes('NO_ROTATE'),
    required: fixed.overmaps.map((o) => ({ p: o.p, locations: o.locations ?? fixed.locations })),
  };
}
