import type { Rng } from '../../core/rng';
import type { SpawnedItem } from '../../data/itemgroups';
import type { OterDef, RegionSettings } from '../worldgen_data';
import { LINE_E, LINE_N, LINE_S, LINE_W, type OmtRef } from '../overmap/oter';
import { MapBuffer, OMT } from './buffer';
import type { MapgenDat } from './jsonmapgen';
import { weightedPick } from './values';

// Ports of Cataclysm: Bright Nights' C++ builtin generators (src/mapgen/mapgen_functions.cpp)
// that BN overmap terrains use instead of JSON: field, road_* (one mapgen_road for all five
// shapes), parking_lot and the plain fills. Forests and water keep the approximations in
// builtin.ts; the Lua lab generator lives in lab.ts.

export interface BuiltinEnv {
  region: RegionSettings;
  terrains: Record<string, OterDef>;
  expandItems(ref: unknown, rng: Rng): SpawnedItem[];
}

const SEEX = 12, SEEY = 12;

function addItems(buf: MapBuffer, i: number, list: SpawnedItem[]): void {
  for (const e of list) buf.addItem(i, e.count === 1 ? { typeId: e.id, spawned: e } : { typeId: e.id, count: e.count, spawned: e });
}

/** CDDA map::place_items(group, chance, whole OMT): roll_remainder(chance/100) group rolls on
 *  random tiles (ongrass=false keeps them off non-flat tiles in CDDA; we don't check). */
function placeItems(env: BuiltinEnv, buf: MapBuffer, rng: Rng, group: string, chance: number): void {
  const v = Math.min(chance, 100) / 100;
  const n = Math.floor(v) + (rng.next() < v - Math.floor(v) ? 1 : 0);
  for (let k = 0; k < n; k++) addItems(buf, rng.int(0, OMT * OMT - 1), env.expandItems(group, rng));
}

function groundcover(region: RegionSettings, rng: Rng): string {
  return weightedPick(rng, region.default_groundcover) ?? 't_region_groundcover';
}

/** A terrain-or-furniture id from region tables (`t_*` sets terrain, `f_*` furniture). */
function terOrFurn(buf: MapBuffer, i: number, id: string): void {
  if (id.startsWith('f_')) buf.furn[i] = id;
  else buf.ter[i] = id;
}

/** mapgen_field: groundcover with a sprinkle of shrubs/flowers/boulders; ~1 OMT in 120 is a
 *  "boosted" patch dominated by one plant (regional_settings.cpp groundcover_extra). */
export function mapgenField(env: BuiltinEnv, dat: MapgenDat, buf: MapBuffer): void {
  const rng = dat.rng;
  const fc = env.region.field;
  const pick = (boosted: boolean): string => {
    // groundcover_extra::pick: weights are percentages; the remainder is default_ter.
    const list = boosted ? fc!.boosted_other : fc!.other;
    let roll = rng.int(0, 1000000);
    for (const [id, pct] of list) {
      roll -= Math.floor(pct * 10000);
      if (roll <= 0) return id;
    }
    return fc!.default_ter;
  };
  const boosted = !!fc && fc.boost_chance * 10000 > rng.int(0, 1000000);
  const mpercent = fc ? (boosted ? fc.boosted_percent_coverage : fc.percent_coverage) * 10000 : 0;
  const altbush = fc ? pick(true) : '';
  for (let i = 0; i < OMT * OMT; i++) {
    buf.ter[i] = groundcover(env.region, rng);
    if (fc && mpercent > rng.int(0, 1000000)) {
      if (boosted && fc.boosted_other_percent * 10000 > rng.int(0, 1000000)) terOrFurn(buf, i, altbush);
      else terOrFurn(buf, i, pick(false));
    }
  }
  placeItems(env, buf, rng, 'field', 60);
}

// ------------------------------------------------------------------------------------------
// mapgen_road

// N E S W NE SE SW NW, like mapgendata::t_nesw.
const NESWX: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]];
const LINE_BITS = [LINE_N, LINE_E, LINE_S, LINE_W];

function roadDirs(r: OmtRef, env: BuiltinEnv): boolean[] {
  // oter_t::has_connection: LINEAR types connect along their line mask; road_nesw_manhole
  // (NO_ROTATE, not LINEAR) is a four-way.
  if (r.type === 'road_nesw_manhole') return [true, true, true, true];
  if (r.line < 0 || !env.terrains[r.type]?.flags.includes('LINEAR')) return [false, false, false, false];
  return LINE_BITS.map((b) => (r.line & b) !== 0);
}

/** nesw_array_rotate: `dist` counterclockwise rotations of a 4-array. */
function rot4<T>(a: T[], dist: number): T[] {
  const o = a.slice();
  for (let k = 0; k < dist; k++) o.push(o.shift()!);
  return o;
}
/** ... and of an 8-array (N E S W NE SE SW NW), one step = 45 degrees. */
function rot8<T>(a: T[], dist: number): T[] {
  const ring = [0, 4, 1, 5, 2, 6, 3, 7];
  let cur = a.slice();
  for (let k = 0; k < dist; k++) {
    const n = cur.slice();
    for (let j = 0; j < 8; j++) n[ring[j]] = cur[ring[(j + 1) % 8]];
    cur = n;
  }
  return cur;
}

/** coord_rotate_cw: (x, y) -> (23 - y, x) per step, like map::rotate. */
function rotCw(x: number, y: number, rot: number): [number, number] {
  for (let k = 0; k < rot; k++) [x, y] = [SEEY * 2 - 1 - y, x];
  return [x, y];
}

function square(buf: MapBuffer, id: string, x1: number, y1: number, x2: number, y2: number): void {
  for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++)
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) if (MapBuffer.inb(x, y)) buf.ter[MapBuffer.idx(x, y)] = id;
}
function circle(buf: MapBuffer, id: string, cx: number, cy: number, r: number): void {
  for (let y = 0; y < OMT; y++) for (let x = 0; x < OMT; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) buf.ter[MapBuffer.idx(x, y)] = id;
}
function line(buf: MapBuffer, id: string, x1: number, y1: number, x2: number, y2: number, furn = false): void {
  // Only axis-aligned lines are used by mapgen_road.
  for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++)
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
      if (!MapBuffer.inb(x, y)) continue;
      if (furn) buf.furn[MapBuffer.idx(x, y)] = id;
      else buf.ter[MapBuffer.idx(x, y)] = id;
    }
}

/** Road vehicles: a small subset of BN's vehicle_spawn default_city / default_country
 *  (road_vehicles.json): clear road, 1-3 wrecks, or a car parked by the kerb. */
function roadVehicles(buf: MapBuffer, rng: Rng, city: boolean, shape: 'straight' | 'curved' | 'other'): void {
  if (!city) {
    if (rng.next() < 0.025) buf.vehicles.push({ id: 'highway', x: rng.int(8, 16), y: rng.int(8, 16), rotation: rng.pick([90, 270]), status: 1, fuel: -1 });
    return;
  }
  const roll = rng.int(0, 99);
  if (roll < 33) return;
  if (roll < 66) {
    const n = rng.int(1, 3);
    for (let k = 0; k < n; k++) buf.vehicles.push({ id: 'city_vehicles', x: rng.int(0, 19), y: rng.int(0, 19), rotation: rng.pick([90, 270]), status: 1, fuel: -1 });
    return;
  }
  if (shape === 'other') return;
  // road_straight_parked / road_curved_parked: the kerb lanes of the north-oriented shape.
  const spots = shape === 'straight'
    ? [{ x: 6, y: rng.int(4, 16), f: 90 }, { x: 17, y: rng.int(4, 16), f: 270 }]
    : [{ x: 6, y: rng.int(4, 16), f: 90 }, { x: rng.int(4, 16), y: 6, f: 180 }];
  const s = rng.pick(spots);
  buf.vehicles.push({ id: 'city_vehicles', x: s.x, y: s.y, rotation: s.f, status: 1, fuel: -1 });
}

/** mapgen_road: every road shape, with sidewalks next to SIDEWALK neighbours, yellow centre
 *  dots, curves towards bending neighbours, plazas where four-ways cluster, cul-de-sacs. */
export function mapgenRoad(env: BuiltinEnv, dat: MapgenDat, buf: MapBuffer): void {
  const rng = dat.rng;
  for (let i = 0; i < OMT * OMT; i++) buf.ter[i] = groundcover(env.region, rng);
  const nb = NESWX.map(([dx, dy]) => dat.omtAt(dx, dy, 0));
  const hasSidewalk = (r: OmtRef) => !!env.terrains[r.type]?.flags.includes('SIDEWALK');
  let sidewalks = nb.map(hasSidewalk);
  const neighborSidewalks = sidewalks.filter(Boolean).length;

  let roads = roadDirs(dat.oter, env);
  const numDirs = roads.filter(Boolean).length;
  const deadEnd = numDirs === 1 ? 8 : 0;

  let curve = [0, 0, 0, 0];
  for (let dir = 0; dir < 4; dir++) {
    if (!roads[dir] || nb[dir].type !== 'road') continue;
    const n = roadDirs(nb[dir], env);
    if (n.filter(Boolean).length === 2 && n[(dir + 2) % 4]) {
      if (n[(dir + 3) % 4]) curve[dir]--;
      if (n[(dir + 1) % 4]) curve[dir]++;
    }
  }

  let rot = 0, diag = false, plaza = -1;
  const is4 = (r: OmtRef) => (r.type === 'road' && r.line === 15) || r.type === 'road_nesw_manhole';
  const cmp = (a: boolean[], b: number[]) => b.every((v, k) => !!v === a[k]);
  if (numDirs === 4) {
    const f = nb.map(is4);
    const P: [number[], number][] = [
      [[1, 1, 1, 1, 1, 1, 1, 1], 8], [[0, 1, 1, 0, 0, 1, 0, 0], 7], [[1, 1, 0, 0, 1, 0, 0, 0], 6],
      [[1, 0, 0, 1, 0, 0, 0, 1], 5], [[0, 0, 1, 1, 0, 0, 1, 0], 4], [[1, 1, 1, 0, 1, 1, 0, 0], 3],
      [[1, 1, 0, 1, 1, 0, 0, 1], 2], [[1, 0, 1, 1, 0, 0, 1, 1], 1], [[0, 1, 1, 1, 0, 1, 1, 0], 0],
    ];
    plaza = P.find(([p]) => cmp(f, p))?.[1] ?? -1;
    if (plaza > -1) rot = plaza % 4;
  } else if (numDirs === 3) {
    rot = !roads[0] ? 2 : !roads[1] ? 3 : !roads[3] ? 1 : 0;
  } else if (numDirs === 2) {
    if (roads[1] && roads[3]) rot = 1;
    else if (roads[1] && roads[2]) (rot = 1), (diag = true);
    else if (roads[2] && roads[3]) (rot = 2), (diag = true);
    else if (roads[3] && roads[0]) (rot = 3), (diag = true);
    else if (roads[0] && roads[1]) diag = true;
  } else if (numDirs === 1) {
    rot = roads[1] ? 1 : roads[2] ? 2 : roads[3] ? 3 : 0;
  }
  sidewalks = rot8(sidewalks, rot * 2);
  roads = rot4(roads, rot);
  curve = rot4(curve, rot);

  const W = SEEX * 2, H = SEEY * 2;
  if (diag) {
    if (sidewalks[4] || sidewalks[5] || sidewalks[6]) {
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) if (x > y - 4 && (x < 4 || y > H - 5 || y >= x)) buf.ter[MapBuffer.idx(x, y)] = 't_sidewalk';
    }
    const r2 = Math.floor(rot / 2);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (x > y && ((x > 3 && y < H - 4) || (x < 4 && curve[0] < 0) || (y > H - 5 && curve[1] > 0))) {
          const yellow = (x + r2) % 4 !== 0 && (x - y === SEEX - 1 + (1 - r2) || x - y === SEEX + (1 - r2));
          buf.ter[MapBuffer.idx(x, y)] = yellow ? 't_pavement_y' : 't_pavement';
        }
      }
  } else {
    let culDeSac = false;
    if (numDirs === 1 && rng.oneIn(3) && neighborSidewalks) {
      culDeSac = true;
      buf.ter.fill('t_sidewalk');
    }
    for (let dir = 0; dir < 4; dir++) {
      if (!roads[dir]) continue;
      if (sidewalks[(dir + 3) % 4] || sidewalks[((dir + 3) % 4) + 4] || sidewalks[dir]) {
        const [x1, y1] = rotCw(0, 0, dir), [x2, y2] = rotCw(3, SEEY - 1 + deadEnd, dir);
        square(buf, 't_sidewalk', x1, y1, x2, y2);
      }
      if (sidewalks[(dir + 1) % 4] || sidewalks[dir + 4] || sidewalks[dir]) {
        const [x1, y1] = rotCw(W - 5, 0, dir), [x2, y2] = rotCw(W - 1, SEEY - 1 + deadEnd, dir);
        square(buf, 't_sidewalk', x1, y1, x2, y2);
      }
    }
    if (deadEnd > 0 && sidewalks[2]) square(buf, 't_sidewalk', 0, SEEY + deadEnd, W - 1, SEEY + deadEnd + 4);
    for (let dir = 0; dir < 4; dir++) {
      if (!roads[dir]) continue;
      const [x1, y1] = rotCw(4, 0, dir), [x2, y2] = rotCw(W - 1 - 4, SEEY - 1 + deadEnd, dir);
      square(buf, 't_pavement', x1, y1, x2, y2);
      if (curve[dir] !== 0) {
        for (let x = 1; x < 4; x++)
          for (let y = 0; y < x; y++) {
            const [tx, ty] = rotCw(curve[dir] === -1 ? x : W - 1 - x, y, dir);
            buf.ter[MapBuffer.idx(tx, ty)] = 't_pavement';
          }
      }
    }
    for (let dir = 0; dir < 4; dir++) {
      if (!roads[dir]) continue;
      const maxY = numDirs === 4 || (numDirs === 3 && dir === 0) ? 4 : SEEY;
      for (let x = SEEX - 1; x <= SEEX; x++)
        for (let y = 0; y < maxY; y++) {
          if ((y + (Math.floor((dir + rot) / 2) % 2)) % 4) {
            const [xn, yn] = rotCw(x, y, dir);
            buf.ter[MapBuffer.idx(xn, yn)] = 't_pavement_y';
          }
        }
    }
    if (culDeSac) circle(buf, 't_pavement', SEEX - 0.5, SEEY - 0.5, 11);
    if (plaza > -1) {
      if (plaza === 8) buf.ter.fill('t_sidewalk');
      else if (plaza < 4) {
        square(buf, 't_pavement', 0, SEEY - 10, W - 1, SEEY - 1);
        square(buf, 't_sidewalk', 0, SEEY - 2, W - 1, H - 1);
        if (rng.oneIn(3)) line(buf, 't_tree_young', 1, SEEY, W - 2, SEEY);
        if (rng.oneIn(3)) {
          line(buf, 'f_bench', 2, SEEY + 2, 5, SEEY + 2, true);
          line(buf, 'f_bench', 10, SEEY + 2, 13, SEEY + 2, true);
          line(buf, 'f_bench', 18, SEEY + 2, 21, SEEY + 2, true);
        }
      } else {
        circle(buf, 't_pavement', 0, H - 1, 21);
        circle(buf, 't_sidewalk', 0, H - 1, 13);
        if (rng.oneIn(3)) {
          circle(buf, 't_tree_young', 0, H - 1, 11);
          circle(buf, 't_sidewalk', 0, H - 1, 10);
        }
        if (rng.oneIn(3)) circle(buf, 't_water_sh', 4, H - 5, 3);
      }
    }
  }

  if (plaza !== 8) roadVehicles(buf, rng, neighborSidewalks > 0, numDirs === 2 ? (diag ? 'curved' : 'straight') : 'other');
  if (neighborSidewalks && rng.oneIn(2)) buf.spawns.push({ kind: 'group', id: 'GROUP_ZOMBIE', x: 0, y: 0, x2: W - 1, y2: H - 1 });
  placeItems(env, buf, rng, plaza > -1 ? 'trash' : 'road', 5);
  if (dat.oter.type === 'road_nesw_manhole') buf.ter[MapBuffer.idx(rng.int(6, W - 6), rng.int(6, W - 6))] = 't_manhole_cover';
  buf.rotate(rot);
}

/** mapgen_parking_lot: striped pavement facing the road it touches. */
export function mapgenParkingLot(env: BuiltinEnv, dat: MapgenDat, buf: MapBuffer): void {
  const rng = dat.rng, W = SEEX * 2, H = SEEY * 2;
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const k = MapBuffer.idx(i, j);
      if ([5, 9, 13, 17, 21].includes(j) && ((i > 1 && i < 8) || (i > 14 && i < W - 2))) buf.ter[k] = 't_pavement_y';
      else if ((j < 2 && i > 7 && i < 17) || (j >= 2 && j < H - 2 && i > 1 && i < W - 2)) buf.ter[k] = 't_pavement';
      else buf.ter[k] = groundcover(env.region, rng);
    }
  // VehicleSpawn "parkinglot": a few parked cars in the striped bays.
  const n = rng.int(0, 4);
  for (let k = 0; k < n; k++) {
    const left = rng.oneIn(2);
    buf.vehicles.push({ id: 'parkinglot', x: left ? rng.int(3, 6) : rng.int(16, 20), y: rng.pick([7, 11, 15, 19]), rotation: left ? 180 : 0, status: 1, fuel: -1 });
  }
  placeItems(env, buf, rng, 'road', 8);
  // BN rotates by the first of east/south/west whose neighbour is a road ("road_*" id).
  for (let i = 1; i < 4; i++) {
    const [dx, dy] = NESWX[i];
    if (dat.omtAt(dx, dy, 0).type === 'road') {
      buf.rotate(i);
      break;
    }
  }
}

/** Plain fills: open_air, rock, empty_rock (BN mapgen_rock fills t_rock). */
export const FILL_BUILTINS: Record<string, string> = { open_air: 't_open_air', empty_rock: 't_rock', rock: 't_rock', null: 't_null', test: 't_grass' };

/** Builtins every oter id can map to (see MapgenData.builtin); returns false if unknown. */
export function runBnBuiltin(name: string, env: BuiltinEnv, dat: MapgenDat, buf: MapBuffer): boolean {
  if (FILL_BUILTINS[name]) {
    buf.ter.fill(FILL_BUILTINS[name]);
    return true;
  }
  if (name === 'field') mapgenField(env, dat, buf);
  else if (name.startsWith('road_')) mapgenRoad(env, dat, buf);
  else if (name === 'parking_lot') mapgenParkingLot(env, dat, buf);
  else return false;
  return true;
}
