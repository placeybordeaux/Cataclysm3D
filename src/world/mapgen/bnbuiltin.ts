import { Rng, hashSeed } from '../../core/rng';
import type { SpawnedItem } from '../../data/itemgroups';
import type { OterDef, RegionSettings } from '../worldgen_data';
import { LINE_E, LINE_N, LINE_S, LINE_W, type OmtRef } from '../overmap/oter';
import { MapBuffer, OMT } from './buffer';
import type { MapgenDat } from './jsonmapgen';
import { weightedPick } from './values';
import { mapgenMine, mapgenRockPartial, mapgenSlimepit } from './bncaves';

// Ports of Cataclysm: Bright Nights' C++ builtin generators (src/mapgen/mapgen_functions.cpp)
// that BN overmap terrains use instead of JSON: field, road_* (one mapgen_road for all five
// shapes), parking_lot, subway_* and sewer_* (underground transport) and the plain fills. Forests and water keep the approximations in
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
  buf.rotate(rot);
  if (dat.oter.type === 'road_nesw_manhole') {
    const [mx, my] = manholeSpot(dat.env.seed, dat.omx, dat.omy);
    buf.ter[MapBuffer.idx(mx, my)] = 't_manhole_cover';
  }
}

/**
 * Where road_nesw_manhole puts its cover: BN's rng(6, SEEX*2-6) on both axes, but from an RNG
 * of its own keyed on the OMT, so the sewer OMT below can put its ladder under it (BN draws no
 * ladder: it lets you down onto whatever tile is below and gives no way back up). The range is
 * symmetric, so placing it after the road's rotation keeps BN's distribution.
 */
export function manholeSpot(seed: number, omx: number, omy: number): [number, number] {
  const r = new Rng(hashSeed(seed, omx, omy, 0x6d616e68));
  return [r.int(6, SEEX * 2 - 6), r.int(6, SEEY * 2 - 6)];
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

// ------------------------------------------------------------------------------------------
// mapgen_subway / mapgen_sewer

/** mapf::formatted_set_simple: one character per tile, every row 24 wide. */
function formatted(buf: MapBuffer, rows: readonly string[], bind: Record<string, string>): void {
  if (rows.length !== OMT) throw new Error(`formatted_set_simple: ${rows.length} rows`);
  for (let y = 0; y < OMT; y++) {
    const row = rows[y];
    if (row.length !== OMT) throw new Error(`formatted_set_simple: row ${y} is ${row.length} wide`);
    for (let x = 0; x < OMT; x++) {
      const t = bind[row[x]];
      if (t === undefined) throw new Error(`formatted_set_simple: unbound '${row[x]}'`);
      buf.ter[MapBuffer.idx(x, y)] = t;
      buf.furn[MapBuffer.idx(x, y)] = '';
    }
  }
}

// Tracks sit on columns 4, 8, 15 and 19 in every shape (and in BN's station, lab cargo station
// and microlab station JSON), which is what makes them continue across OMT edges.
const SUBWAY_BIND = {
  '.': 't_rock_floor', '#': 't_rock', '^': 't_railroad_rubble', '-': 't_railroad_tie', '|': 't_railroad_tie',
  X: 't_railroad_track', x: 't_railroad_track_on_tie', D: 't_railroad_track_d', S: 't_buffer_stop',
};
const SUBWAY_FOUR_WAY = [
  '...^X^^^X^....^X^^^X^...', '..^DX^^DX^....^XD^^XD^..', '.^D^X^D^X^....^X^D^X^D^.', '^D^^XD^^X^^^^^^X^^DX^^D^',
  'XXXXDXXXXXXXXXXXXXXDXXXX', '^^^DX^^^X^^^^^^X^^^XD^^^', '^^D^X^^^X^^^^^^X^^^X^D^^', '^D^^X^^^X^^^^^^X^^^X^^D^',
  'XXXXXXXXXXXXXXXXXXXXXXXX', '^^^^X^^^X^^^^^^X^^^X^^^^', '...^X^^^X^....^X^^^X^...', '...^X^^^X^....^X^^^X^...',
  '...^X^^^X^....^X^^^X^...', '...^X^^^X^....^X^^^X^...', '^^^^X^^^X^^^^^^X^^^X^^^^', 'XXXXXXXXXXXXXXXXXXXXXXXX',
  '^D^^X^^^X^^^^^^X^^^X^^D^', '^^D^X^^^X^^^^^^X^^^X^D^^', '^^^DX^^^X^^^^^^X^^^XD^^^', 'XXXXDXXXXXXXXXXXXXXDXXXX',
  '^D^^XD^^X^^^^^^X^^DX^^D^', '.^D^X^D^X^....^X^D^X^D^.', '..^DX^^DX^....^XD^^XD^..', '...^X^^^X^....^X^^^X^...',
];
const SUBWAY_TEE = [
  '..^D^^^D^....^D^^^D^....', '.^D^^^D^....^D^^^D^.....', '^D^^^D^....^D^^^D^......', 'D^^^D^^^^^^D^^^D^^^^^^^^',
  'XXXDXXXXXXDXXXDXXXXXXXXX', '^^D^^^^^^D^^^D^^^^^^^^^^', '^D^^^^^^D^^^D^^^^^^^^^^^', 'D^^^^^^D^^^D^^^^^^^^^^^^',
  'XXXXXXDXXXDXXXXXXXXXXXXX', '^^^^^D^^^D^^^^^^^^^^^^^^', '...^D^^^D^..............', '..^D^^^D^...............',
  '.^D^^^D^................', '^D^^^D^.................', 'D^^^D^^^^^|^^|^^|^^|^^|^', 'XXXDXXXXXXxXXxXXxXXxXXxX',
  '^^D^^^^^^^|^^|^^|^^|^^|^', '^D^^^^^^^^|^^|^^|^^|^^|^', 'D^^^^^^^^^|^^|^^|^^|^^|^', 'XXXXXXXXXXxXXxXXxXXxXXxX',
  '^^^^^^^^^^|^^|^^|^^|^^|^', '........................', '........................', '........................',
];
const SUBWAY_DIAGONAL = [
  '...^D^^^D^....^D^^^D^...', '....^D^^^D^....^D^^^D^..', '.....^D^^^D^....^D^^^D^.', '......^D^^^D^....^D^^^D^',
  '.......^D^^^D^....^D^^^D', '#.......^D^^^D^....^D^^^', '##.......^D^^^D^....^D^^', '###.......^D^^^D^....^D^',
  '####.......^D^^^D^....^D', '#####.......^D^^^D^....^', '######.......^D^^^D^....', '#######.......^D^^^D^...',
  '########.......^D^^^D^..', '#########.......^D^^^D^.', '##########.......^D^^^D^', '###########.......^D^^^D',
  '############.......^D^^^', '#############.......^D^^', '##############.......^D^', '###############.......^D',
  '################.......^', '#################.......', '##################......', '###################.....',
];
const SUBWAY_STRAIGHT = Array.from({ length: OMT }, (_, y) => (y % 3 === 1 ? '...-x---x-....-x---x-...' : '...^X^^^X^....^X^^^X^...'));
const SUBWAY_END = [
  '...^X^^^X^....^D^^^D^...', '...-x---x-...^DX^^DX^...', '...^X^^^X^..^D^X^D^X^...', '...^X^^^X^.^D^^XD^^X^...',
  '...^X^^^X^^D^^^D^^^X^...', '...^X^^^X^D^^^DX^^^X^...', '...^X^^^XD^^^D^X^^^X^...', '...^X^^^D^^^D^-x---x-...',
  '...^X^^DX^^D^.^X^^^X^...', '...^X^D^X^D^..^X^^^X^...', '...^XD^^XD^...-x---x-...', '...^D^^^D^....^X^^^X^...',
  '...^X^^^X^....^X^^^X^...', '...-x---x-....-x---x-...', '...^X^^^X^....^X^^^X^...', '...^X^^^X^....^X^^^X^...',
  '...-x---x-....-x---x-...', '...^X^^^X^....^X^^^X^...', '...^X^^^X^....^X^^^X^...', '...^S^^^S^....^S^^^S^...',
  '...^^^^^^^....^^^^^^^...', '#......................#', '##....................##', '########################',
];

/** oter_t::has_connection per direction (N E S W) for LINEAR types; none for anything else. */
function lineDirs(r: OmtRef, env: BuiltinEnv): boolean[] {
  if (r.line < 0 || !env.terrains[r.type]?.flags.includes('LINEAR')) return [false, false, false, false];
  return LINE_BITS.map((b) => (r.line & b) !== 0);
}

/** mapgen_subway: four track lines on rubble in a rock-floored tunnel; ties, diagonal
 *  crossovers at junctions, a buffer stop (and maybe a draisine) at dead ends, cave moss. */
export function mapgenSubway(env: BuiltinEnv, dat: MapgenDat, buf: MapBuffer): void {
  const rng = dat.rng;
  // dat.fill_groundcover(): every tile is overwritten below, but it consumes the RNG in BN too.
  for (let i = 0; i < OMT * OMT; i++) buf.ter[i] = groundcover(env.region, rng);
  let dirs = lineDirs(dat.oter, env);
  // Neighbours flagged SUBWAY (oter_flags::subway_connection) pull a connection in. No BN
  // terrain carries the flag today; kept so data that adds it behaves like BN. (BN also works
  // out curvedir_nesw here, but never reads it.)
  for (let d = 0; d < 4; d++) {
    const [dx, dy] = NESWX[d];
    if (env.terrains[dat.omtAt(dx, dy, 0).type]?.flags.includes('SUBWAY')) dirs[d] = true;
  }
  const num = dirs.filter(Boolean).length;
  let rot = 0, diag = false;
  if (num === 3) rot = !dirs[0] ? 2 : !dirs[1] ? 3 : !dirs[3] ? 1 : 0;
  else if (num === 2) {
    if (dirs[1] && dirs[3]) rot = 1;
    else if (dirs[1] && dirs[2]) (rot = 1), (diag = true);
    else if (dirs[2] && dirs[3]) (rot = 2), (diag = true);
    else if (dirs[3] && dirs[0]) (rot = 3), (diag = true);
    else if (dirs[0] && dirs[1]) diag = true;
  } else if (num === 1) rot = dirs[1] ? 1 : dirs[2] ? 2 : dirs[3] ? 3 : 0;
  dirs = rot4(dirs, rot);

  // num 0 (subway_isolated) maps to subway_four_way like any linear type, but BN's switch has
  // no case for it and leaves the groundcover; we do the same.
  if (num === 4) formatted(buf, SUBWAY_FOUR_WAY, SUBWAY_BIND);
  else if (num === 3) formatted(buf, SUBWAY_TEE, SUBWAY_BIND);
  else if (num === 2) formatted(buf, diag ? SUBWAY_DIAGONAL : SUBWAY_STRAIGHT, SUBWAY_BIND);
  else if (num === 1) {
    formatted(buf, SUBWAY_END, SUBWAY_BIND);
    subwayDeadendVehicles(buf, rng);
  }

  for (let i = 0; i < OMT * OMT; i++) {
    if (rng.oneIn(12) && buf.ter[i] === 't_rock_floor') {
      buf.ter[i] = 't_moss_underground';
      if (rng.oneIn(15)) buf.furn[i] = 'f_cave_mushrooms';
    }
  }
  buf.rotate(rot);
}

/** VehicleSpawn default_subway_deadend (road_vehicles.json): half the time nothing, else 1-2
 *  draisines at the "subway_deadend" vehicle_placement spots, on the unrotated map. */
function subwayDeadendVehicles(buf: MapBuffer, rng: Rng): void {
  if (rng.int(0, 199) < 100) return;
  const n = rng.int(1, 2);
  for (let k = 0; k < n; k++) {
    const s = rng.oneIn(2) ? { x: 16, y: rng.int(3, 13), f: 270 } : { x: 7, y: rng.int(7, 17), f: 90 };
    buf.vehicles.push({ id: 'trains_draisine', x: s.x, y: s.y, rotation: s.f, status: -1, fuel: -1 });
  }
}

/** mapgen_sewer: solid rock with a 4-wide sewage channel from the centre towards every
 *  connected side (sewer_isolated keeps just the centre pool), plus "sewer" loot. The look
 *  comes from the mx_sewer_* map extra applied on top (worldgen.ts applyMapExtra). */
export function mapgenSewer(env: BuiltinEnv, dat: MapgenDat, buf: MapBuffer): void {
  const dirs = lineDirs(dat.oter, env);
  const num = dirs.filter(Boolean).length;
  for (let i = 0; i < OMT; i++)
    for (let j = 0; j < OMT; j++) {
      let fill = true;
      if (j >= SEEY - 2 && j <= SEEY + 1) {
        if (i <= SEEX - 2) fill = !dirs[3];
        else if (i >= SEEX + 1) fill = !dirs[1];
        else fill = false;
      } else if (i >= SEEX - 2 && i <= SEEX + 1) {
        fill = j <= SEEY - 2 ? !dirs[0] : !dirs[2];
      }
      buf.ter[MapBuffer.idx(i, j)] = fill ? 't_rock' : 't_sewage';
    }
  placeItems(env, buf, dat.rng, 'sewer', 4 + num * 6);
}

/**
 * Not BN: a ladder under the manhole above (see manholeSpot) and, if the map extra walled it
 * off, a concrete passage from it to the nearest tile that reaches the sewer's openings
 * (the channel ends on connected sides; the centre pool for an isolated sewer).
 */
export function addManholeLadder(env: BuiltinEnv, dat: MapgenDat, buf: MapBuffer, x: number, y: number, passable: (i: number) => boolean): void {
  const idx = MapBuffer.idx;
  const lad = idx(x, y);
  buf.ter[lad] = 't_ladder_up';
  buf.furn[lad] = '';
  const dirs = lineDirs(dat.oter, env);
  const seeds: number[] = [];
  for (let k = SEEX - 2; k <= SEEX + 1; k++) {
    if (dirs[0]) seeds.push(idx(k, 0));
    if (dirs[1]) seeds.push(idx(OMT - 1, k));
    if (dirs[2]) seeds.push(idx(k, OMT - 1));
    if (dirs[3]) seeds.push(idx(0, k));
  }
  if (!seeds.length) for (let cx = SEEX - 1; cx <= SEEX; cx++) for (let cy = SEEY - 2; cy <= SEEY + 1; cy++) seeds.push(idx(cx, cy));
  const reach = new Uint8Array(OMT * OMT);
  const q = seeds.filter(passable);
  for (const i of q) reach[i] = 1;
  while (q.length) {
    const i = q.pop()!;
    const ix = i % OMT, iy = (i / OMT) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = ix + NESWX[d][0], ny = iy + NESWX[d][1];
      if (!MapBuffer.inb(nx, ny)) continue;
      const n = idx(nx, ny);
      if (!reach[n] && (passable(n) || n === lad)) (reach[n] = 1), q.push(n);
    }
  }
  if (reach[lad]) return;
  // Nearest reachable tile (or the channel centre if the extra sealed everything), then an L
  // of floor to it: along x first, then y.
  let best = -1, bd = Infinity;
  for (let i = 0; i < OMT * OMT; i++) {
    if (!reach[i]) continue;
    const d = Math.abs((i % OMT) - x) + Math.abs(((i / OMT) | 0) - y);
    if (d < bd) (bd = d), (best = i);
  }
  const [tx, ty] = best >= 0 ? [best % OMT, (best / OMT) | 0] : [SEEX, SEEY];
  const dig = (cx: number, cy: number) => {
    const i = idx(cx, cy);
    if (i === lad || passable(i)) return;
    buf.ter[i] = 't_thconc_floor';
    buf.furn[i] = '';
  };
  for (let cx = x; cx !== tx; cx += Math.sign(tx - x)) dig(cx, y);
  for (let cy = y; cy !== ty; cy += Math.sign(ty - y)) dig(tx, cy);
  dig(tx, ty);
}

/** Plain fills: open_air, empty_rock (BN mapgen_rock fills t_rock); "rock" is bncaves.ts mapgenRockPartial. */
export const FILL_BUILTINS: Record<string, string> = { open_air: 't_open_air', empty_rock: 't_rock', null: 't_null', test: 't_grass' };

/** Builtins every oter id can map to (see MapgenData.builtin); returns false if unknown. */
export function runBnBuiltin(name: string, env: BuiltinEnv, dat: MapgenDat, buf: MapBuffer): boolean {
  if (FILL_BUILTINS[name]) {
    buf.ter.fill(FILL_BUILTINS[name]);
    return true;
  }
  if (name === 'field') mapgenField(env, dat, buf);
  else if (name.startsWith('road_')) mapgenRoad(env, dat, buf);
  else if (name === 'parking_lot') mapgenParkingLot(env, dat, buf);
  else if (name.startsWith('subway_')) mapgenSubway(env, dat, buf);
  else if (name.startsWith('sewer_')) mapgenSewer(env, dat, buf);
  else if (name === 'mine') mapgenMine(env, dat, buf);
  else if (name === 'rock') mapgenRockPartial(dat, buf);
  else if (name === 'lua:slimepit') mapgenSlimepit(env, dat, buf, () => groundcover(env.region, dat.rng));
  else return false;
  return true;
}
