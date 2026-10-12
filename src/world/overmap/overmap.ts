import { Rng, hashSeed } from '../../core/rng';
import type { CubeDir, OvermapData, SpecialConnection, SpecialDef, SpecialSpawns } from '../worldgen_data';
import { ConnectionBuilder, type ConnectionGrid } from './connections';
import { tunnelSeams, type TunnelSeam } from './seams';
import { MinHeap } from './heap';
import { Noise2D } from './noise';
import { placeMutableSpecials, type MutableHost } from './mutable_place';
import { MutableSpecial, type MutableReadHost, type PlacedPiece } from './mutable';
import { LAKE_COLUMN_TYPES, lakeColumn } from './lakes';
import { specialMonGroups, type MonGroup } from './mongroups';
import { MAX_Z, MIN_Z } from '../coords';
import {
  LINE_E, LINE_N, LINE_S, LINE_W, OmtRef, isLinear, isRotatable, oterId, parseOterId, rotateLine, rotateOffset,
} from './oter';

// Overmap generation, modelled on CDDA's overmap.cpp / overmap_city.cpp but split into
// lazily generated square regions (CDDA overmaps are 180x180 OMTs; ours are REGION wide).
// Natural terrain (fields, forests, lakes, rivers) comes from global noise so it is seamless
// across regions; towns, roads and specials are placed per region from a region-seeded RNG.
// Regions exchange roads through deterministic "portal" tiles on shared edges, so the road
// network is continuous without either region having to generate the other.

export const REGION = 96;
/** The modular underground lab special (CDDA 0.J+ labs; see tools/extract/mapgen.ts). */
export const LAB_SPECIAL = 'lab_mutagen_6_level';
/** Surface microlab (elevator down to a z-2 microlab complex with CBM/mutagen rooms). */
export const MICROLAB_SPECIAL = '4x4_microlab_surface';
/** BN's classic science lab: a z0 lab_stairs bunker over the mutable "lab_basement" special
 *  (generated here by placeLabBasement; drawn by src/world/mapgen/lab.ts). */
export const CLASSIC_LAB_SPECIAL = 'Lab';
/** The oter types a lab_basement is built from (BN overmap_mutable/lab.json). genVersion 1
 *  only grows the first five; 2 adds the escape cells chunk and train depots. */
export const LAB_BASEMENT_TYPES = ['lab', 'lab_filler', 'lab_stairs', 'lab_core', 'lab_finale', 'lab_escape_cells', 'lab_escape_entrance', 'lab_train_depot'] as const;
const RR = REGION * REGION;

export interface City {
  name: string;
  /** centre, global OMT coords */
  x: number;
  y: number;
  size: number;
}

export interface SpecialInstance {
  uid: number;
  def: string;
  /** OMT origin (the special's [0,0,0] point) and rotation 0..3 */
  x: number;
  y: number;
  rot: number;
  city?: City;
  /** mapgen overmap_special-scoped parameters (lazily rolled; start locations pre-set some) */
  args: Map<string, string>;
}

export interface OmtInfo extends OmtRef {
  /** full oter id, e.g. "house_01_east", "road_nesw", "field" */
  id: string;
  /** natural terrain this OMT replaced (for fallback_predecessor_mapgen), if any */
  predecessor?: string;
  special?: SpecialInstance;
}

/** BN city_generation_profile: big towns try to place one "finale" building (mall,
 *  hospital, ...) among their first `counter` buildings. */
interface FinaleState {
  attempt: boolean;
  counter: number;
  placed: boolean;
}

/** See Region.connectionRequests. */
export interface ConnectionRequest {
  x: number;
  y: number;
  z: number;
  /** BN overmap_connection id */
  connection: string;
  /** SpecialInstance uid that asked (0 = none, e.g. a manhole). Lets the builder find the
   *  special's connection "from" point, the side the tunnel enters it from. */
  uid: number;
}

interface Slot {
  t: number;
  rot: number;
  line: number;
  sp: number;
}

class Region {
  readonly t = new Uint16Array(RR);
  readonly rot = new Uint8Array(RR);
  readonly line = new Int8Array(RR).fill(-1);
  /** special instance uid per z0 tile (0 = none) */
  readonly sp = new Int32Array(RR);
  /** z != 0 terrain placed by specials, keyed by z * RR + index */
  readonly layers = new Map<number, Slot>();
  readonly cities: City[] = [];
  readonly specials: SpecialInstance[] = [];
  /**
   * Non-road connections (BN overmap_connection ids such as "sewer_tunnel", "subway_tunnel")
   * asked for by anything that places terrain: specials, city buildings, the lab grower, mutable
   * specials. Built once every special in the region is placed (genVersion >= 2). Coordinates
   * are region-local OMTs at the connection's own z.
   */
  readonly connectionRequests: ConnectionRequest[] = [];
  /** BN road_nesw_manhole candidates (city centres and one in 8 street branch points), checked
   *  once road lines are known (genVersion >= 2). */
  readonly manholes: { x: number; y: number; city: City; center: boolean }[] = [];
  /** This region's halves of the tunnel crossings on its edges (seams.ts, genVersion >= 3). */
  seams: readonly TunnelSeam[] = [];
  constructor(readonly rx: number, readonly ry: number) {}
  get x0() { return this.rx * REGION; }
  get y0() { return this.ry * REGION; }
}

const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
const NO_GROUPS: readonly MonGroup[] = Object.freeze([]);
const LINE_BIT = [LINE_N, LINE_E, LINE_S, LINE_W];

/**
 * Overmap generation version. Overmaps are never saved, only regenerated from the seed, so a
 * change to what generates where would move buildings under chunks a save already stored.
 * Saves record the version they were made with (save/format.ts `world.genVersion`; saves
 * without it are 1) and keep generating that way; new games use the latest.
 *   1  generation before the transport fixes
 *   2  transport fixes (docs/WORLD_TRANSPORT.md)
 *   3  transport follow-ups (cross-region tunnels, lakes, special spawns, depth); gate every
 *      change with `genVersion >= 3`
 */
export const WORLDGEN_VERSION = 3;

export class Overmap {
  private regions = new Map<string, Region>();
  private types: string[] = [];
  private typeIdx = new Map<string, number>();
  private specialsByUid = new Map<number, SpecialInstance>();
  private landNoise: Noise2D;
  private thickNoise: Noise2D;
  private lakeNoise: Noise2D;
  private riverNoise: Noise2D;
  private riverWarp: Noise2D;
  private riverMask: Noise2D;
  /** location id -> set of oter types it accepts */
  private locationSets = new Map<string, Set<string>>();
  private finales = new WeakMap<City, FinaleState>();
  /** City a request without a special belongs to (manhole sewers). */
  private requestCity = new WeakMap<ConnectionRequest, City>();
  /** BN overmap::joins_used: "x,y,z,dir" (global OMT) -> join id matched there by a mutable special. */
  private joinsUsed = new Map<string, string>();
  /** One entry per mutable special grown (mutable_place.ts), for tests and probes. */
  readonly mutableReports: { uid: number; def: string; openMandatory: number; bnUnresolved: boolean; pieces: PlacedPiece[] }[] = [];
  private labBasement?: MutableSpecial;
  /** BN overmap::zg for special spawns (genVersion >= 3): "sx,sy" (absolute submap) -> groups.
   *  A group can lie in a neighbouring region; it is listed once its special's region exists. */
  private monGroupIndex = new Map<string, MonGroup[]>();
  private monGroupsBySpecial = new Map<number, MonGroup[]>();
  /** Default terrain below ground: DDA has solid_earth at z-1; BN is empty_rock everywhere. */
  private readonly shallowUnderground: string;
  readonly T: Record<string, number> = {};

  constructor(readonly seed: number, readonly data: OvermapData, readonly genVersion: number = WORLDGEN_VERSION) {
    if (!Number.isInteger(genVersion) || genVersion < 1 || genVersion > WORLDGEN_VERSION) throw new Error(`unsupported overmap genVersion ${genVersion} (this build knows 1..${WORLDGEN_VERSION})`);
    this.landNoise = new Noise2D(hashSeed(seed, 101));
    this.thickNoise = new Noise2D(hashSeed(seed, 102));
    this.lakeNoise = new Noise2D(hashSeed(seed, 103));
    this.riverNoise = new Noise2D(hashSeed(seed, 104));
    this.riverWarp = new Noise2D(hashSeed(seed, 105));
    this.riverMask = new Noise2D(hashSeed(seed, 106));
    for (const t of ['field', 'forest', 'forest_thick', 'forest_water', 'road', 'river_center', 'lake_surface', 'open_air', 'empty_rock']) {
      if (!data.terrains[t]) throw new Error(`overmap.json lacks base terrain ${t}`);
      this.T[t] = this.intern(t);
    }
    this.shallowUnderground = data.terrains.solid_earth ? 'solid_earth' : 'empty_rock';
    if (data.terrains.bridge) this.T.bridge = this.intern('bridge');
    for (const [id, terr] of Object.entries(data.locations)) this.locationSets.set(id, new Set(terr));
    if (genVersion >= 2) {
      if (!data.connections) throw new Error('overmap.json lacks overmap connections (re-run npm run extract:mapgen)');
      for (const t of ['road_nesw_manhole', 'sewer']) if (!data.terrains[t]) throw new Error(`overmap.json lacks terrain ${t} (re-run npm run extract:mapgen)`);
      this.T.road_nesw_manhole = this.intern('road_nesw_manhole');
    }
    if (genVersion >= 3) {
      for (const t of ['lake_shore', 'lake_water_cube', 'lake_bed', 'lake_underwater_shore']) if (!data.terrains[t]) throw new Error(`overmap.json lacks terrain ${t} (re-run npm run extract:mapgen)`);
      if (!data.lakeSpecials) throw new Error('overmap.json lacks lakeSpecials (re-run npm run extract:mapgen)');
    }
  }

  private intern(t: string): number {
    let i = this.typeIdx.get(t);
    if (i === undefined) {
      i = this.types.length;
      this.types.push(t);
      this.typeIdx.set(t, i);
    }
    return i;
  }

  // ------------------------------------------------------------------------------------
  // Public API

  /** Overmap terrain at global OMT coords. */
  omtAt(x: number, y: number, z: number): OmtInfo {
    const r = this.region(Math.floor(x / REGION), Math.floor(y / REGION));
    const i = (y - r.y0) * REGION + (x - r.x0);
    let ref: OmtRef, sp = 0;
    if (z === 0) {
      ref = { type: this.types[r.t[i]], rot: r.rot[i], line: r.line[i] };
      sp = r.sp[i];
    } else {
      const s = r.layers.get(z * RR + i);
      if (s) {
        ref = { type: this.types[s.t], rot: s.rot, line: s.line };
        sp = s.sp;
      } else ref = { type: z > 0 ? 'open_air' : z === -1 ? this.shallowUnderground : 'empty_rock', rot: 0, line: -1 };
    }
    const info: OmtInfo = { ...ref, id: oterId(ref, this.data.terrains) };
    if (sp) info.special = this.specialsByUid.get(sp);
    if (z === 0 && (sp || ref.type === 'road' || ref.type === 'bridge' || ref.type === 'road_nesw_manhole')) info.predecessor = this.baseLand(x, y);
    return info;
  }

  /**
   * Special-spawn monster groups on absolute submap (sx, sy), any z (src/world/overmap/mongroups.ts).
   * Only regions generated so far contribute: never generates one (callers run every frame).
   */
  monGroupsAt(sx: number, sy: number): readonly MonGroup[] {
    return this.monGroupIndex.get(`${sx},${sy}`) ?? NO_GROUPS;
  }

  /** The groups a placed special spawned (empty below genVersion 3 or without BN spawns). */
  monGroupsOf(uid: number): readonly MonGroup[] {
    return this.monGroupsBySpecial.get(uid) ?? NO_GROUPS;
  }

  /** BN overmap::join_used_at: the join a mutable special matched on this OMT face (mapgen reads it). */
  joinAt(x: number, y: number, z: number, dir: CubeDir): string | undefined {
    this.region(Math.floor(x / REGION), Math.floor(y / REGION));
    return this.joinsUsed.get(`${x},${y},${z},${dir}`);
  }

  /**
   * Cities of the regions around (x, y). `generate` false: only regions that already exist
   * (a region is ~20-50 ms of generation: bookkeeping callers must not force one inside a frame).
   */
  citiesNear(x: number, y: number, radiusRegions = 1, generate = true): City[] {
    const rx = Math.floor(x / REGION), ry = Math.floor(y / REGION);
    const out: City[] = [];
    for (let dy = -radiusRegions; dy <= radiusRegions; dy++)
      for (let dx = -radiusRegions; dx <= radiusRegions; dx++) {
        const r = generate ? this.region(rx + dx, ry + dy) : this.regions.get(`${rx + dx},${ry + dy}`);
        if (r) out.push(...r.cities);
      }
    return out;
  }

  closestCity(x: number, y: number, radiusRegions = 1, generate = true): City | undefined {
    let best: City | undefined, bd = Infinity;
    for (const c of this.citiesNear(x, y, radiusRegions, generate)) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bd) (bd = d), (best = c);
    }
    return best;
  }

  /** Nearest z0 OMT (Chebyshev rings) whose info satisfies `pred`, or undefined. */
  findNearest(pred: (o: OmtInfo) => boolean, from: { x: number; y: number }, maxRadius = 200): { x: number; y: number; omt: OmtInfo } | undefined {
    for (let r = 0; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const o = this.omtAt(from.x + dx, from.y + dy, 0);
          if (pred(o)) return { x: from.x + dx, y: from.y + dy, omt: o };
        }
    }
    return undefined;
  }

  /**
   * Where you walk into a placed special: the OMT its road connection leaves from (BN
   * overmap_special connections[].from), rotated like the special. null for specials without
   * one. A destination on "the refugee center" means its gate, not whichever fence tile the
   * player clicked (wave-3 playtest: the route ended at a locked back door).
   */
  specialEntrance(inst: SpecialInstance): { x: number; y: number } | null {
    const def = this.data.specials[inst.def];
    const c = def?.connections?.find((k) => k.from) ?? null;
    if (!c || !c.from) return null;
    const [dx, dy] = rotateOffset(c.from[0], c.from[1], inst.rot);
    return { x: inst.x + dx, y: inst.y + dy };
  }

  /**
   * Nearest OMT (global coords, any z != 0) of oter type `type` placed by a special, searching
   * regions outward from `from` (generating them). Nearest by horizontal distance, then depth.
   */
  findUnderground(type: string, from: { x: number; y: number }, maxRegions = 1): { x: number; y: number; z: number; omt: OmtInfo } | undefined {
    const rx = Math.floor(from.x / REGION), ry = Math.floor(from.y / REGION);
    let best: { x: number; y: number; z: number } | undefined, bd = Infinity, foundAt = Infinity;
    // A hit in ring n can still lose to one in ring n + 1 (corner vs edge), never to ring n + 2.
    for (let rad = 0; rad <= Math.min(maxRegions, foundAt + 1); rad++) {
      for (let dy = -rad; dy <= rad; dy++)
        for (let dx = -rad; dx <= rad; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
          const r = this.region(rx + dx, ry + dy);
          // looked up after generating: the type is interned when first placed
          const t = this.typeIdx.get(type);
          if (t === undefined) continue;
          for (const [k, slot] of r.layers) {
            if (slot.t !== t) continue;
            const z = Math.floor(k / RR), i = k - z * RR;
            const x = r.x0 + (i % REGION), y = r.y0 + Math.floor(i / REGION);
            const d = Math.hypot(x - from.x, y - from.y) - z * 1e-3;
            if (d < bd) (bd = d), (best = { x, y, z });
          }
        }
      if (best && foundAt === Infinity) foundAt = rad;
    }
    return best && { ...best, omt: this.omtAt(best.x, best.y, best.z) };
  }

  /** Nearest placed instance of an overmap special id. Generates regions outward as needed. */
  findSpecial(defId: string, from: { x: number; y: number }, maxRegions = 3): SpecialInstance | undefined {
    const rx = Math.floor(from.x / REGION), ry = Math.floor(from.y / REGION);
    let best: SpecialInstance | undefined, bd = Infinity;
    for (let rad = 0; rad <= maxRegions; rad++) {
      for (let dy = -rad; dy <= rad; dy++)
        for (let dx = -rad; dx <= rad; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
          for (const s of this.region(rx + dx, ry + dy).specials) {
            if (s.def !== defId) continue;
            const d = Math.hypot(s.x - from.x, s.y - from.y);
            if (d < bd) (bd = d), (best = s);
          }
        }
      if (best) return best;
    }
    return best;
  }

  /** Natural terrain type from noise (what CDDA calls the "base" oter before specials). */
  baseLand(x: number, y: number): string {
    if (this.isRiver(x, y)) return 'river_center';
    if (this.isLake(x, y)) return this.genVersion >= 3 && this.isLakeShore(x, y) ? 'lake_shore' : 'lake_surface';
    const f = this.data.region.forest;
    const n = this.landNoise.fbm(x, y, 4, 0.5, 1 / 22);
    // Calibrated so roughly 40% of land is forest, like CDDA's default region.
    const forest = n - 0.5 + f.noise_threshold_forest;
    if (forest > 0.212) {
      const wet = this.nearWater(x, y, 2);
      if (wet && this.thickNoise.fbm(x, y, 2, 0.5, 1 / 9) > 1 - f.noise_threshold_swamp_adjacent_water - 0.25) return 'forest_water';
      if (forest > 0.212 + 0.07 + this.thickNoise.at(x / 7, y / 7) * 0.06 + (f.noise_threshold_forest_thick - f.noise_threshold_forest)) return 'forest_thick';
      return 'forest';
    }
    return 'field';
  }

  isRiver(x: number, y: number): boolean {
    // Rivers follow zero-crossings of a domain-warped noise field (ridged noise), masked by
    // a very low frequency field so only some regions have one.
    if (this.riverMask.at(x / 260 + 3.1, y / 260 - 1.7) < -0.08) return false;
    const wx = x + this.riverWarp.at(x / 40, y / 40) * 18;
    const wy = y + this.riverWarp.at(x / 40 + 7.7, y / 40 + 3.3) * 18;
    const v = this.riverNoise.at(wx / 110, wy / 110);
    return Math.abs(v) < 0.018;
  }

  isLake(x: number, y: number): boolean {
    return this.lakeNoise.fbm(x, y, 3, 0.5, 1 / 30) > 0.79;
  }

  /**
   * genVersion >= 3, BN place_lakes: a lake OMT with any of its eight neighbours outside the lake
   * (rivers count as lake) is lake_shore. BN also drops lakes under lake_size_min (20 OMTs); our
   * lake noise is older than that and keeps every lake.
   */
  private isLakeShore(x: number, y: number): boolean {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (!this.isLake(x + dx, y + dy) && !this.isRiver(x + dx, y + dy)) return true;
    return false;
  }

  private nearWater(x: number, y: number, r: number): boolean {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) if (this.isRiver(x + dx, y + dy) || this.isLake(x + dx, y + dy)) return true;
    return false;
  }

  /** ASCII overmap around (cx, cy) using oter symbols; roads drawn with line glyphs. */
  dump(cx: number, cy: number, radius: number, z = 0): string {
    const rows: string[] = [];
    const lineGlyph = ['·', '│', '─', '└', '│', '│', '┌', '├', '─', '┘', '─', '┴', '┐', '┤', '┬', '┼'];
    for (let y = cy - radius; y <= cy + radius; y++) {
      let row = '';
      for (let x = cx - radius; x <= cx + radius; x++) {
        const o = this.omtAt(x, y, z);
        if (x === cx && y === cy) row += '@';
        else if (o.line >= 0) row += lineGlyph[o.line];
        else row += this.data.terrains[o.type]?.sym?.[0] ?? '?';
      }
      rows.push(row);
    }
    return rows.join('\n');
  }

  // ------------------------------------------------------------------------------------
  // Region generation

  private region(rx: number, ry: number): Region {
    // NaN region coords make every A* index NaN, so roadPath's heap grows until the tab OOMs.
    if (!Number.isInteger(rx) || !Number.isInteger(ry)) throw new Error(`overmap.region: bad region coordinates (${rx}, ${ry})`);
    const key = `${rx},${ry}`;
    let r = this.regions.get(key);
    if (!r) {
      r = new Region(rx, ry);
      this.regions.set(key, r);
      this.generateRegion(r);
    }
    return r;
  }

  regionCount(): number {
    return this.regions.size;
  }

  private generateRegion(r: Region): void {
    const rng = new Rng(hashSeed(this.seed, r.rx, r.ry, 7));
    for (let y = 0; y < REGION; y++)
      for (let x = 0; x < REGION; x++) r.t[y * REGION + x] = this.intern(this.baseLand(r.x0 + x, r.y0 + y));
    // BN place_lakes writes the columns with the lake, before cities and specials claim rock and
    // before any connection is built (BN tunnels only run through subterranean rock), so lakes
    // go first and a seam whose tile is under a lake is dropped (reserveSeams).
    if (this.genVersion >= 3) {
      this.placeLakeColumns(r);
      this.reserveSeams(r);
    }
    this.placeCities(r, rng);
    this.connectRegion(r, rng);
    this.placeSpecials(r, rng);
    // Own RNG stream so the placements above draw exactly what they did in genVersion 1.
    if (this.genVersion >= 2) placeMutableSpecials(this.mutableHost(r), new Rng(hashSeed(this.seed, r.rx, r.ry, 0x6d75)));
    // BN sorts specials by z0 area, so the LAKE ones (no z0 terrain) come last; own RNG stream.
    if (this.genVersion >= 3) placeMutableSpecials(this.mutableHost(r), new Rng(hashSeed(this.seed, r.rx, r.ry, 0x1a4e)), this.data.lakeSpecials!);
    this.computeRoadLines(r);
    if (this.genVersion >= 2) {
      this.placeManholes(r);
      this.buildConnections(r);
    }
  }

  /**
   * genVersion >= 3: the lake column oter at global (x, y, z < 0), from the noise alone (what
   * placeLakeColumns lays before anything else), or undefined. Safe to call for tiles of regions
   * that don't exist yet: it never generates one.
   */
  lakeColumnAt(x: number, y: number, z: number): string | undefined {
    if (this.genVersion < 3 || z >= 0) return undefined;
    return lakeColumn(this.baseLand(x, y))[-z - 1];
  }

  /** genVersion >= 3: BN place_lakes' columns under every lake_surface / lake_shore (lakes.ts). */
  private placeLakeColumns(r: Region): void {
    const cols = new Map<number, number[]>();
    for (const t of ['lake_surface', 'lake_shore']) cols.set(this.T[t] ?? this.intern(t), lakeColumn(t).map((c) => this.intern(c)));
    for (let i = 0; i < RR; i++) {
      const col = cols.get(r.t[i]);
      if (!col) continue;
      for (let k = 0; k < col.length; k++) r.layers.set(-(k + 1) * RR + i, { t: col[k], rot: 0, line: -1, sp: 0 });
    }
  }

  private get(r: Region, x: number, y: number): string | undefined {
    if (x < 0 || y < 0 || x >= REGION || y >= REGION) return undefined;
    return this.types[r.t[y * REGION + x]];
  }
  private setRoad(r: Region, x: number, y: number): void {
    const i = y * REGION + x;
    r.t[i] = this.T.road;
    r.rot[i] = 0;
    r.line[i] = 15;
    r.sp[i] = 0;
  }
  private isRoad(r: Region, x: number, y: number): boolean {
    return this.get(r, x, y) === 'road';
  }

  // --- cities (CDDA overmap::place_cities / build_city_street / place_building) ---

  private placeCities(r: Region, rng: Rng): void {
    const cs = this.data.region.city;
    const coverage = 1 / Math.pow(2, cs.city_spacing);
    const omtsPerCity = (cs.city_size * 2 + 1) * (cs.city_size * 2 + 1) * 3 / 4;
    let n = rollRemainder((RR * coverage) / omtsPerCity, rng);
    // The start region always gets a town near its middle so the shelter start is urban.
    const start = r.rx === 0 && r.ry === 0;
    if (start) n = Math.max(n, 1);
    const unique = new Set<string>();
    for (let k = 0; k < n; k++) {
      // BN random_city_generation_profile (DDA divides small towns by 3 instead of making
      // hamlets of size 1, and has no finales).
      let size = rng.int(cs.city_size - 1, cs.city_size + 1);
      const finale: FinaleState = { attempt: false, counter: 0, placed: false };
      let finaleDistance = 1;
      if (rng.oneIn(3)) size = 1;
      else if (rng.oneIn(2)) size = Math.floor((size * 2) / 3);
      else if (rng.oneIn(2)) (size = Math.floor((size * 3) / 2)), (finale.attempt = true), (finaleDistance = 5);
      else (size *= 2), (finale.attempt = true), (finaleDistance = 15);
      finale.attempt &&= !!cs.finales?.length;
      finale.counter = rng.int(0, finaleDistance);
      // Our towns need a street to hang buildings on; BN's size-1 hamlets are one crossroads.
      size = Math.max(size, 2);
      if (start && k === 0) size = Math.max(size, 6);
      const margin = size + 3;
      let placed = false;
      for (let tries = 0; tries < 40 && !placed; tries++) {
        const x = start && k === 0 && tries < 20 ? rng.int(REGION / 2 - 8, REGION / 2 + 8) : rng.int(margin, REGION - 1 - margin);
        const y = start && k === 0 && tries < 20 ? rng.int(REGION / 2 - 8, REGION / 2 + 8) : rng.int(margin, REGION - 1 - margin);
        const t = this.get(r, x, y)!;
        if (!['field', 'forest', 'forest_thick'].includes(t)) continue;
        if (r.cities.some((c) => Math.hypot(c.x - r.x0 - x, c.y - r.y0 - y) < c.size + size + 4)) continue;
        const city: City = { name: rng.pick(this.data.names.city), x: r.x0 + x, y: r.y0 + y, size };
        r.cities.push(city);
        this.finales.set(city, finale);
        this.setRoad(r, x, y);
        // BN place_cities: every city starts with a manhole intersection over the sewer hub.
        if (this.genVersion >= 2) this.addManhole(r, x, y, city, true);
        const startDir = rng.int(0, 3);
        for (let d = 0; d < 4; d++) this.buildCityStreet(r, rng, x, y, size, (startDir + d) % 4, city, unique, 2);
        placed = true;
      }
    }
  }

  private buildCityStreet(r: Region, rng: Rng, sx: number, sy: number, cs: number, dir: number, city: City, unique: Set<string>, blockWidth: number): void {
    const path = this.layOutStreet(r, sx, sy, dir, cs + 1);
    if (path.length <= 1) return;
    for (const [x, y] of path) this.setRoad(r, x, y);
    let c = cs, croad = cs;
    const newWidth = blockWidth === 2 ? rng.int(3, 5) : 2;
    for (let k = 1; k < path.length; k++) {
      c--;
      const [x, y] = path[k];
      if (c >= 2 && c < croad - blockWidth) {
        croad = c;
        let left = cs - rng.int(1, 3), right = cs - rng.int(1, 3);
        if (left === 1) left++;
        if (right === 1) right++;
        this.buildCityStreet(r, rng, x, y, left, (dir + 3) % 4, city, unique, newWidth);
        this.buildCityStreet(r, rng, x, y, right, (dir + 1) % 4, city, unique, newWidth);
        // BN build_city_street rolls one_in(8) before checking for a four-way road.
        if (this.genVersion >= 2 && rng.oneIn(8)) this.addManhole(r, x, y, city, false);
      }
      // BN build_city_street: the finale goes in once the town's counter runs out; a finale
      // that doesn't fit is abandoned so it never ends up at the edge of town.
      const fin = this.finales.get(city);
      let tryFinale = false;
      if (fin && fin.counter === 0 && !fin.placed && fin.attempt) tryFinale = true;
      else if (fin) fin.counter--;
      for (const side of [(dir + 3) % 4, (dir + 1) % 4]) {
        if (rng.oneIn(4)) continue;
        if (tryFinale && fin && !fin.placed) {
          if (this.placeBuilding(r, rng, x, y, side, city, unique, true)) fin.placed = true;
          else (tryFinale = false), (fin.counter = -1);
        } else this.placeBuilding(r, rng, x, y, side, city, unique);
      }
    }
    cs -= rng.int(1, 3);
    if (cs >= 2 && c === 0) {
      const [lx, ly] = path[path.length - 1];
      const rnd = rng.oneIn(2) ? (dir + 1) % 4 : (dir + 3) % 4;
      this.buildCityStreet(r, rng, lx, ly, cs, rnd, city, unique, 2);
      if (rng.oneIn(5)) this.buildCityStreet(r, rng, lx, ly, cs, (rnd + 2) % 4, city, unique, newWidth);
    }
  }

  /** CDDA lay_out_street: walk straight until blocked by water/buildings or adjacent roads. */
  private layOutStreet(r: Region, sx: number, sy: number, dir: number, len: number): [number, number][] {
    const valid = (x: number, y: number) => {
      if (x < 2 || y < 2 || x >= REGION - 2 || y >= REGION - 2) return false;
      const t = this.get(r, x, y)!;
      if (t !== 'road' && !this.accepts('land', t)) return false;
      let collisions = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if ((dx === DX[dir] && dy === DY[dir]) || (dx === -DX[dir] && dy === -DY[dir])) continue;
          if (this.isRoad(r, x + dx, y + dy)) {
            if (collisions >= 2) return false;
            collisions++;
          }
        }
      return true;
    };
    const ex = sx + DX[dir] * (len + 1), ey = sy + DY[dir] * (len + 1);
    if (this.isRoad(r, ex, ey)) len++;
    const out: [number, number][] = [];
    for (let k = 0; k < len; k++) {
      const x = sx + DX[dir] * k, y = sy + DY[dir] * k;
      if (!valid(x, y) && k > 0) break;
      out.push([x, y]);
      if (k > 1 && this.isRoad(r, x, y)) break;
    }
    return out;
  }

  private placeBuilding(r: Region, rng: Rng, rx: number, ry: number, dir: number, city: City, unique: Set<string>, finale = false): boolean {
    const bx = rx + DX[dir], by = ry + DY[dir];
    const bdir = (dir + 2) % 4;
    const townDist = (Math.hypot(r.x0 + bx - city.x, r.y0 + by - city.y) * 100) / Math.max(city.size, 1);
    for (let retries = 0; retries < 10; retries++) {
      const id = this.pickBuilding(rng, townDist, city.size, unique, finale);
      if (!id) return false;
      const def = this.specialOrBuilding(id);
      if (this.canPlaceSpecial(r, def, bx, by, bdir)) {
        const inst = this.placeSpecial(r, def, bx, by, bdir, city);
        // BN place_building -> place_special builds a city building's connections too.
        if (this.genVersion >= 2) this.placeConnections(r, def, inst, bx, by, bdir);
        if (def.flags.includes('CITY_UNIQUE') || def.flags.includes('GLOBALLY_UNIQUE') || def.flags.includes('OVERMAP_UNIQUE')) unique.add(id);
        return true;
      }
    }
    return false;
  }

  /** BN overmap::pick_random_building_to_place (towns over size 10 use the urban lists). */
  private pickBuilding(rng: Rng, townDist: number, citySize: number, unique: Set<string>, finale = false): string | undefined {
    const cs = this.data.region.city;
    const shopNormal = Math.max(cs.shop_radius, normalRoll(rng, cs.shop_radius, cs.shop_sigma));
    const aptRadius = cs.apartment_radius ?? 0;
    const aptNormal = Math.max(aptRadius, normalRoll(rng, aptRadius, cs.apartment_sigma ?? 0));
    const parkNormal = Math.max(cs.park_radius, normalRoll(rng, cs.park_radius, cs.park_sigma));
    const urban = citySize > 10;
    const or = (l: [string, number][] | undefined, d: [string, number][]) => (l?.length ? l : d);
    const list = finale && cs.finales?.length ? cs.finales
      : shopNormal > townDist ? (urban ? or(cs.urban_shops, cs.shops) : cs.shops)
      : parkNormal > townDist ? cs.parks
      : urban && aptNormal > townDist ? or(cs.urban_houses, cs.houses) : cs.houses;
    for (let k = 0; k < 20; k++) {
      const id = rng.weighted(list);
      if (unique.has(id)) continue;
      const def = this.specialOrBuilding(id);
      const [lo, hi] = def.citySizes;
      if (citySize < lo || (hi >= 0 && citySize > hi)) continue;
      return id;
    }
    return undefined;
  }

  /** City lists mix specials and bare oter ids; CDDA wraps the latter in a 1-OMT special. */
  private specialOrBuilding(id: string): SpecialDef {
    const s = this.data.specials[id];
    if (s) return s;
    const t = this.data.terrains[id];
    if (!t) throw new Error(`city building ${id} is neither special nor terrain`);
    const synth: SpecialDef = {
      id, city: true, overmaps: [{ p: [0, 0, 0], om: isRotatable(t) ? id + '_north' : id }], connections: [],
      locations: ['land'], cityDistance: [-1, -1], citySizes: [0, -1], occurrences: [0, 0], flags: [],
    };
    this.data.specials[id] = synth;
    return synth;
  }

  private accepts(location: string, type: string): boolean {
    return !!this.locationSets.get(location)?.has(type);
  }

  // --- special placement (CDDA overmap::can_place_special / place_special) ---

  private canPlaceSpecial(r: Region, def: SpecialDef, ox: number, oy: number, rot: number, margin = 1): boolean {
    for (const o of def.overmaps) {
      const [dx, dy] = rotateOffset(o.p[0], o.p[1], rot);
      const x = ox + dx, y = oy + dy;
      if (x < margin || y < margin || x >= REGION - margin || y >= REGION - margin) return false;
      const i = y * REGION + x;
      if (o.p[2] !== 0) {
        if (o.om && r.layers.has(o.p[2] * RR + i)) return false;
        continue;
      }
      const t = this.types[r.t[i]];
      const locs = o.locations ?? def.locations;
      if (!o.om) {
        // location-only points (e.g. where the connecting road will go) may already be road
        if (t !== 'road' && !locs.some((l) => this.accepts(l, t))) return false;
        continue;
      }
      if (r.sp[i] || !locs.some((l) => this.accepts(l, t))) return false;
    }
    return true;
  }

  private placeSpecial(r: Region, def: SpecialDef, ox: number, oy: number, rot: number, city?: City): SpecialInstance {
    // uid must not depend on region generation order: it seeds overmap_special-scoped
    // mapgen parameters, so it has to be the same whichever way the player explored.
    let uid = hashSeed(this.seed, r.rx, r.ry, r.specials.length, 31) & 0x7fffffff || 1;
    while (this.specialsByUid.has(uid)) uid = (uid + 1) & 0x7fffffff || 1;
    const inst: SpecialInstance = { uid, def: def.id, x: r.x0 + ox, y: r.y0 + oy, rot, city, args: new Map() };
    this.specialsByUid.set(inst.uid, inst);
    r.specials.push(inst);
    // Fixed specials are placed with their origin at z0.
    if (def.spawns) this.addSpecialSpawns(inst, def.spawns, inst.x, inst.y, 0);
    for (const o of def.overmaps) {
      if (!o.om) continue;
      const [dx, dy] = rotateOffset(o.p[0], o.p[1], rot);
      const x = ox + dx, y = oy + dy, i = y * REGION + x;
      const ref = parseOterId(o.om, this.data.terrains);
      if (!this.data.terrains[ref.type]) continue;
      const t = this.intern(ref.type);
      const orot = isRotatable(this.data.terrains[ref.type]) ? (ref.rot + rot) % 4 : 0;
      const line = ref.line >= 0 ? rotateLine(ref.line, rot) : -1;
      if (o.p[2] === 0) {
        r.t[i] = t;
        r.rot[i] = orot;
        r.line[i] = line;
        r.sp[i] = inst.uid;
      } else r.layers.set(o.p[2] * RR + i, { t, rot: orot, line, sp: inst.uid });
    }
    return inst;
  }

  /** BN place_special's "Place spawns" step (genVersion >= 3); (x, y, z) is the origin, global OMT. */
  private addSpecialSpawns(inst: SpecialInstance, spawns: SpecialSpawns, x: number, y: number, z: number): void {
    if (this.genVersion < 3) return;
    const groups = specialMonGroups(this.seed, inst.uid, spawns, x, y, z);
    this.monGroupsBySpecial.set(inst.uid, groups);
    for (const g of groups) {
      const k = `${g.sx},${g.sy}`;
      const list = this.monGroupIndex.get(k);
      if (list) list.push(g);
      else this.monGroupIndex.set(k, [g]);
    }
  }

  // --- roads between towns / regions ---

  /** Deterministic portal tile on the edge between two regions (shared by both sides). */
  private portal(rx: number, ry: number, side: number): [number, number] {
    // side: 0 north, 1 east, 2 south, 3 west. Normalise to the edge's owner (east/south).
    if (side === 0) return this.portal(rx, ry - 1, 2);
    if (side === 3) return this.portal(rx - 1, ry, 1);
    const h = hashSeed(this.seed, rx, ry, side, 99);
    const off = 12 + (h % (REGION - 24));
    return side === 1 ? [(rx + 1) * REGION - 1, ry * REGION + off] : [rx * REGION + off, (ry + 1) * REGION - 1];
  }

  /** Portal tile inside region r for a side (its own edge tile). */
  private portalLocal(r: Region, side: number): [number, number] {
    const [gx, gy] = this.portal(r.rx, r.ry, side);
    // for north/west the shared coordinate belongs to the neighbour; step inside
    const lx = gx - r.x0 + (side === 3 ? 1 : 0), ly = gy - r.y0 + (side === 0 ? 1 : 0);
    return [lx, ly];
  }

  private connectRegion(r: Region, rng: Rng): void {
    const hubs: [number, number][] = r.cities.map((c) => [c.x - r.x0, c.y - r.y0]);
    if (hubs.length === 0) {
      // No town: a crossroads somewhere central keeps the road network connected.
      for (let tries = 0; tries < 50; tries++) {
        const x = rng.int(REGION / 3, (2 * REGION) / 3), y = rng.int(REGION / 3, (2 * REGION) / 3);
        if (this.accepts('land', this.get(r, x, y)!)) {
          hubs.push([x, y]);
          this.setRoad(r, x, y);
          break;
        }
      }
      if (hubs.length === 0) hubs.push([REGION >> 1, REGION >> 1]);
    }
    // chain towns to each other
    for (let k = 1; k < hubs.length; k++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        const d = Math.abs(hubs[j][0] - hubs[k][0]) + Math.abs(hubs[j][1] - hubs[k][1]);
        if (d < bd) (bd = d), (best = j);
      }
      this.buildRoad(r, hubs[k], hubs[best]);
    }
    // each edge portal connects to the nearest hub
    for (let side = 0; side < 4; side++) {
      const p = this.portalLocal(r, side);
      let best = hubs[0], bd = Infinity;
      for (const h of hubs) {
        const d = Math.abs(h[0] - p[0]) + Math.abs(h[1] - p[1]);
        if (d < bd) (bd = d), (best = h);
      }
      this.buildRoad(r, p, best, true);
    }
  }

  /** A* road between two local tiles; existing roads are cheap, water is a costly causeway. */
  private buildRoad(r: Region, from: [number, number], to: [number, number], allowEdge = false): boolean {
    // A special's connection point can land on another, already placed special (roadPath
    // never routes through one, but it doesn't check where it starts). Paving it replaced the
    // start shelter with a road end on some seeds: new survivors woke up on a bare road next
    // to a zombie (wave-3 playtest, seed 743667900). Leave that connection unbuilt instead.
    if (r.sp[from[1] * REGION + from[0]]) return false;
    const path = this.roadPath(r, from, to, allowEdge);
    if (!path) return false;
    for (const [x, y] of path) if (!this.isRoad(r, x, y) && !r.sp[y * REGION + x]) this.setRoad(r, x, y);
    return true;
  }

  private roadPath(r: Region, from: [number, number], to: [number, number], allowEdge: boolean): [number, number][] | undefined {
    const cost = (x: number, y: number): number => {
      const edge = x <= 0 || y <= 0 || x >= REGION - 1 || y >= REGION - 1;
      if (x < 0 || y < 0 || x >= REGION || y >= REGION) return -1;
      // Region edges are reserved for portal endpoints so roads don't run along seams.
      if (edge && !(x === to[0] && y === to[1]) && !(allowEdge && x === from[0] && y === from[1])) return -1;
      const i = y * REGION + x;
      if (r.sp[i]) return -1;
      const t = this.types[r.t[i]];
      switch (t) {
        case 'road': return 1;
        case 'field': return 3;
        case 'forest': return 4;
        case 'forest_thick': return 5;
        case 'forest_water': return 7;
        case 'river_center': case 'lake_surface': case 'lake_shore': return 25;
        default: return -1;
      }
    };
    const N = RR;
    const g = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const open = new MinHeap();
    const s = from[1] * REGION + from[0], goal = to[1] * REGION + to[0];
    g[s] = 0;
    open.push(s, 0);
    const h = (i: number) => (Math.abs((i % REGION) - to[0]) + Math.abs(Math.floor(i / REGION) - to[1])) * 1;
    while (open.size) {
      const cur = open.pop();
      if (cur === goal) break;
      const cx = cur % REGION, cy = Math.floor(cur / REGION);
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d], ny = cy + DY[d];
        const c = cost(nx, ny);
        if (c < 0) continue;
        const ni = ny * REGION + nx;
        // discourage running alongside other roads (CDDA lay_out_street does the same)
        const ng = g[cur] + c;
        if (ng < g[ni]) {
          g[ni] = ng;
          prev[ni] = cur;
          open.push(ni, ng + h(ni));
        }
      }
    }
    if (g[goal] === Infinity) return undefined;
    const out: [number, number][] = [];
    for (let i = goal; i !== -1; i = prev[i]) out.push([i % REGION, Math.floor(i / REGION)]);
    return out.reverse();
  }

  // --- wilderness specials ---

  private placeSpecials(r: Region, rng: Rng): void {
    const area = RR / (180 * 180);
    const start = r.rx === 0 && r.ry === 0;
    const order = [...this.data.wildSpecials].sort((a, b) => (a === 'Evac Shelter' ? -1 : b === 'Evac Shelter' ? 1 : 0));
    for (const id of order) {
      const def = this.data.specials[id];
      if (!def) continue;
      const [lo, hi] = def.occurrences;
      let count: number;
      if (this.genVersion >= 2) {
        // BN place_specials: occurrences [min, max] of a UNIQUE special are a min/max chance of
        // one per 180x180 overmap. A region is `area` of that, so the chance is scaled by it:
        // the same expected count per OMT, never more than one per region.
        const uniq = def.flags.includes('UNIQUE') || def.flags.includes('OVERMAP_UNIQUE') || def.flags.includes('GLOBALLY_UNIQUE');
        count = uniq ? (rng.next() < (lo / hi) * area ? 1 : 0) : rollRemainder(rng.int(lo, hi) * area, rng);
      } else {
        const uniq = def.flags.includes('OVERMAP_UNIQUE') || def.flags.includes('GLOBALLY_UNIQUE');
        count = uniq ? (rng.int(1, 100) <= lo * area * 2 ? 1 : 0) : rollRemainder(rng.int(lo, hi) * area, rng);
      }
      if (id === 'Evac Shelter') count = Math.max(count, r.cities.length > 0 ? 1 : 0);
      // The refugee center (Free Merchants NPC hub) is globally unique: exactly one, placed
      // near the start town so new survivors can find it, like CDDA's scenarios point them at.
      if (id === 'evac_center') {
        if (!start || !r.cities.length) continue;
        this.tryPlaceWild(r, rng, def, r.cities[0], true);
        continue;
      }
      // CDDA guarantees labs exist somewhere on each overmap, not near the player; with our
      // smaller regions that could mean hundreds of OMTs of walking, so the start region
      // always gets one within a short trek of the start town (CBMs/mutagen need a lab).
      if ((id === LAB_SPECIAL || id === CLASSIC_LAB_SPECIAL) && start && r.cities.length) {
        // genVersion 2: that classic lab also always has escape cells, for the lab_escape start.
        this.tryPlaceWild(r, rng, def, r.cities[0], true, id === CLASSIC_LAB_SPECIAL && this.genVersion >= 2);
        continue;
      }
      for (let k = 0; k < count; k++) this.tryPlaceWild(r, rng, def, start && id === 'Evac Shelter' ? r.cities[0] : undefined);
    }
    // Microlabs hold most of CDDA's loose CBMs; make sure the start region has one too. Done
    // after the loop so the RNG draws (and thus placement) of everything above is unchanged.
    const micro = this.data.specials[MICROLAB_SPECIAL];
    if (start && r.cities.length && micro && !r.specials.some((s) => s.def === MICROLAB_SPECIAL)) this.tryPlaceWild(r, rng, micro, r.cities[0], true);
  }

  /** `widen`: big specials (the refugee center) search ever further from `near` until they fit.
   *  `labEscape`: a nested lab_basement must get the escape cells chunk (see placeLabBasement). */
  private tryPlaceWild(r: Region, rng: Rng, def: SpecialDef, near?: City, widen = false, labEscape = false): boolean {
    const [dmin, dmax] = def.cityDistance;
    for (let tries = 0; tries < (widen ? 400 : 80); tries++) {
      let x: number, y: number;
      if (near) {
        const ang = rng.next() * Math.PI * 2, dist = near.size + rng.int(Math.max(dmin, 1), Math.max(dmin, dmax)) + (widen ? Math.floor(tries / 8) : 0);
        x = Math.round(near.x - r.x0 + Math.cos(ang) * dist);
        y = Math.round(near.y - r.y0 + Math.sin(ang) * dist);
      } else {
        x = rng.int(3, REGION - 4);
        y = rng.int(3, REGION - 4);
      }
      const rot = def.flags.includes('NO_ROTATE') ? 0 : rng.int(0, 3);
      if (dmin >= 0 || dmax >= 0) {
        const d = this.cityEdgeDistance(r, x, y);
        if (dmin >= 0 && d < dmin) continue;
        if (dmax >= 0 && d > dmax) continue;
      }
      if (!this.canPlaceSpecial(r, def, x, y, rot, 3)) continue;
      const inst = this.placeSpecial(r, def, x, y, rot, near ?? this.nearestCity(r, x, y));
      for (const n of def.nested ?? []) {
        const [dx, dy] = rotateOffset(n.p[0], n.p[1], rot);
        if (n.special === 'lab_basement') this.placeLabBasement(r, rng, inst, x + dx, y + dy, n.p[2], rot, labEscape);
      }
      if (this.genVersion >= 2) this.placeConnections(r, def, inst, x, y, rot);
      else
        for (const c of def.connections) {
          // genVersion 1 paved every connection as a z0 road, sewers and subways included.
          const [dx, dy] = rotateOffset(c.p[0], c.p[1], rot);
          const cx = x + dx, cy = y + dy;
          if (cx < 1 || cy < 1 || cx >= REGION - 1 || cy >= REGION - 1) continue;
          const target = this.nearestRoad(r, cx, cy);
          if (target) this.buildRoad(r, [cx, cy], target);
        }
      return true;
    }
    return false;
  }

  /**
   * BN's mutable "lab_basement" special (overmap_mutable/lab.json) under a classic Lab, rotated
   * like it (BN place_nested). genVersion 2 grows it with the overmap_mutable port (mutable.ts):
   * levels of lab rooms joined by lab_stairs over lab_core, the escape cells + entrance chunk
   * (BN "lab_escape": z -10..-4, chance 0.2 x shared size 4), fillers, a lab_train_depot at z-2
   * and z-4 whose north side asks for a subway_tunnel, extra bottom labs and the finale.
   * `needEscape` (the start region's guaranteed lab) regrows with fresh RNGs until the escape
   * chunk appears, so the lab_escape start always has cells near the start.
   */
  private placeLabBasement(r: Region, rng: Rng, inst: SpecialInstance, x: number, y: number, z0: number, rot = 0, needEscape = false): void {
    if (this.genVersion < 2) return this.placeLabBasementV1(r, rng, inst, x, y, z0);
    const def = this.data.mutables?.lab_basement;
    if (!def) throw new Error('overmap.json lacks the lab_basement mutable special (re-run extract:mapgen)');
    const m = (this.labBasement ??= new MutableSpecial(def));
    const host = this.labReadHost(r);
    const origin = { x, y, z: z0 };
    if (!m.canPlace(host, origin, rot)) return;
    let res = m.grow(host, origin, rot, new Rng(hashSeed(this.seed, 0x1ab, r.rx, r.ry, x, y, 0)));
    const hasCells = () => res.placed.some((p) => p.type === 'lab_escape_cells');
    for (let attempt = 1; needEscape && !hasCells() && attempt < 64; attempt++) res = m.grow(host, origin, rot, new Rng(hashSeed(this.seed, 0x1ab, r.rx, r.ry, x, y, attempt)));
    if (needEscape && !hasCells()) throw new Error(`lab_basement at ${r.x0 + x},${r.y0 + y} never grew escape cells in 64 tries`);
    // BN reports this with a debugmsg and keeps the placement; lab.json never leaves one
    if (res.unresolvedMandatory) console.error(`lab_basement at ${r.x0 + x},${r.y0 + y}: ${res.unresolvedMandatory} unresolved mandatory joins`);
    for (const p of res.placed) {
      if (p.z === 0) throw new Error('lab_basement placed terrain at z0');
      const def = this.data.terrains[p.type];
      if (!def) throw new Error(`lab_basement writes unknown oter ${p.oter}`);
      r.layers.set(p.z * RR + p.y * REGION + p.x, { t: this.intern(p.type), rot: isRotatable(def) ? (parseOterId(p.oter, this.data.terrains).rot + p.rot) % 4 : 0, line: -1, sp: inst.uid });
    }
    for (const [jx, jy, jz, dir, id] of res.joinsUsed) this.joinsUsed.set(`${r.x0 + jx},${r.y0 + jy},${jz},${dir}`, id);
    for (const c of res.connections) r.connectionRequests.push({ x: c.x, y: c.y, z: c.z, connection: c.connection, uid: inst.uid });
  }

  /** What the mutable special grower reads: region-local terrain, bounded by the region and
   *  the z range the game renders (BN: the 180-OMT overmap and OVERMAP_DEPTH 10). */
  private labReadHost(r: Region): MutableReadHost {
    return {
      terrainAt: (x, y, z) => {
        const i = y * REGION + x;
        if (z === 0) return this.types[r.t[i]];
        const s = r.layers.get(z * RR + i);
        return s ? this.types[s.t] : this.defaultTerrain(z);
      },
      inbounds: (x, y, z) => x >= 0 && y >= 0 && x < REGION && y < REGION && z >= MIN_Z && z <= MAX_Z,
      location: (id) => this.locationSets.get(id),
      defaultTerrain: (z) => this.defaultTerrain(z),
    };
  }
  private defaultTerrain(z: number): string {
    return z > 0 ? 'open_air' : z === -1 ? this.shallowUnderground : z < 0 ? 'empty_rock' : 'field';
  }

  /**
   * genVersion 1's lab_basement, kept so old saves regenerate the same labs: from a lab_core
   * under the entrance, each level is a connected blob of lab rooms inside a 4x4-OMT box; every
   * level but the last has a lab_stairs room leading to the lab_core below it, a lab_filler or
   * two pad the blob, and the bottom level holds the finale. No escape cells or train depots.
   */
  private placeLabBasementV1(r: Region, rng: Rng, inst: SpecialInstance, x: number, y: number, z0: number): void {
    const levels = rng.int(2, 4);
    const minX = Math.max(1, x - rng.int(0, 3)), minY = Math.max(1, y - rng.int(0, 3));
    const inBox = (cx: number, cy: number) => cx >= minX && cy >= minY && cx < Math.min(REGION - 1, minX + 4) && cy < Math.min(REGION - 1, minY + 4);
    let root: [number, number] = [x, y];
    for (let lv = 0; lv < levels; lv++) {
      const z = z0 - lv;
      const free = (cx: number, cy: number) => inBox(cx, cy) && !r.layers.has(z * RR + cy * REGION + cx);
      if (!free(root[0], root[1])) return;
      const cells: [number, number][] = [root];
      const want = rng.int(5, 10);
      for (let tries = 0; cells.length < want && tries < 60; tries++) {
        const [bx, by] = rng.pick(cells);
        const d = rng.int(0, 3);
        const nx = bx + DX[d], ny = by + DY[d];
        if (free(nx, ny) && !cells.some(([cx, cy]) => cx === nx && cy === ny)) cells.push([nx, ny]);
      }
      const types: string[] = cells.map(() => 'lab');
      types[0] = 'lab_core';
      const last = lv === levels - 1;
      let next: [number, number] | undefined;
      if (cells.length > 1) {
        const k = rng.int(1, cells.length - 1);
        types[k] = last ? 'lab_finale' : 'lab_stairs';
        if (!last) next = cells[k];
        for (let f = 0; f < 2; f++) {
          const j = rng.int(1, cells.length - 1);
          if (types[j] === 'lab' && rng.oneIn(2)) types[j] = 'lab_filler';
        }
      } else if (!last) {
        // A one-room level can't hold both ends of a staircase; stop here with a finale.
        types[0] = 'lab_finale';
      }
      cells.forEach(([cx, cy], k) => {
        if (!this.data.terrains[types[k]]) return;
        r.layers.set(z * RR + cy * REGION + cx, { t: this.intern(types[k]), rot: 0, line: -1, sp: inst.uid });
      });
      if (!next) return;
      root = next;
    }
  }

  // --- connections (BN place_special's connection loop; see connections.ts) ---

  /**
   * genVersion >= 2: only local_road connections at z0 are paved here, as they always were; every
   * other connection (sewer_tunnel, subway_tunnel, at whatever z) becomes a connection request,
   * built by buildConnections once the region's terrain is final.
   */
  private placeConnections(r: Region, def: SpecialDef, inst: SpecialInstance, ox: number, oy: number, rot: number): void {
    for (const c of def.connections) {
      const id = connectionIdOf(c);
      const [dx, dy] = rotateOffset(c.p[0], c.p[1], rot);
      const cx = ox + dx, cy = oy + dy, z = c.p[2];
      if (id === 'local_road' && z === 0) {
        if (cx < 1 || cy < 1 || cx >= REGION - 1 || cy >= REGION - 1 || this.isRoad(r, cx, cy)) continue;
        const target = this.nearestRoad(r, cx, cy);
        if (target) this.buildRoad(r, [cx, cy], target);
        continue;
      }
      // BN: ter() outside the overmap is null, which no connection can start from.
      if (cx < 0 || cy < 0 || cx >= REGION || cy >= REGION) continue;
      r.connectionRequests.push({ x: cx, y: cy, z, connection: id, uid: inst.uid });
    }
  }

  /**
   * A manhole candidate. BN lays the sewer_isolated under it while building the city, before any
   * special, so specials (anthills, labs) can't take that rock: reserve it now. Whether it gets a
   * manhole (a four-way road) is only known once road lines are computed (placeManholes).
   */
  private addManhole(r: Region, x: number, y: number, city: City, center: boolean): void {
    const k = -RR + y * REGION + x;
    // genVersion >= 3: a street laid over a lake has water under it, not rock for a sewer.
    const below = r.layers.get(k);
    if (below && LAKE_COLUMN_TYPES.has(this.types[below.t])) return;
    if (!r.layers.has(k)) r.layers.set(k, { t: this.intern('sewer'), rot: 0, line: 0, sp: 0 });
    r.manholes.push({ x, y, city, center });
  }

  /** BN place_cities / build_city_street: road_nesw_manhole over a sewer_isolated, on four-way roads. */
  private placeManholes(r: Region): void {
    const sewer = this.intern('sewer');
    const done = new Set<number>();
    for (const m of r.manholes) {
      const i = m.y * REGION + m.x;
      if (done.has(i)) continue;
      done.add(i);
      const hub = r.layers.get(-RR + i);
      if (hub?.t !== sewer || hub.sp !== 0) throw new Error(`overmap: the sewer reserved under manhole ${m.x},${m.y} was overwritten by ${hub ? this.types[hub.t] : 'nothing'}`);
      if (r.t[i] === this.T.road && r.line[i] === 15) {
        r.t[i] = this.T.road_nesw_manhole;
        r.line[i] = -1;
      } else if (!m.center) {
        // Not a four-way: no manhole here, so give the reserved rock back.
        r.layers.delete(-RR + i);
        continue;
      }
      // BN always puts a manhole on a city's centre; its mapgen is a four-way, so a centre that
      // isn't one keeps its road and only gets the sewer hub underneath.
      if (m.center) continue;
      const req: ConnectionRequest = { x: m.x, y: m.y, z: -1, connection: 'sewer_tunnel', uid: 0 };
      r.connectionRequests.push(req);
      this.requestCity.set(req, m.city);
    }
  }

  private buildConnections(r: Region): void {
    const grid: ConnectionGrid = {
      size: REGION,
      get: (x, y, z) => {
        if (x < 0 || y < 0 || x >= REGION || y >= REGION) return null;
        if (z === 0) throw new Error('overmap connections: z0 is roads only');
        const s = r.layers.get(z * RR + y * REGION + x);
        if (s) return { type: this.types[s.t], rot: s.rot, line: s.line };
        return { type: z > 0 ? 'open_air' : z === -1 ? this.shallowUnderground : 'empty_rock', rot: 0, line: -1 };
      },
      set: (x, y, z, ref) => {
        const k = z * RR + y * REGION + x;
        r.layers.set(k, { t: this.intern(ref.type), rot: ref.rot, line: ref.line, sp: r.layers.get(k)?.sp ?? 0 });
      },
    };
    const b = new ConnectionBuilder(grid, this.data.terrains, this.data.connections!, this.locationSets);
    for (const req of r.connectionRequests) {
      if (req.z === 0) throw new Error(`overmap connection request ${req.connection} at z0 (uid ${req.uid}): z0 connections are roads, built with buildRoad`);
      const inst = req.uid ? this.specialsByUid.get(req.uid) : undefined;
      if (req.uid && !inst) throw new Error(`overmap connection request from unknown special uid ${req.uid}`);
      const city = this.requestCity.get(req) ?? (inst ? inst.city : this.nearestCity(r, req.x, req.y));
      b.connect({
        x: req.x, y: req.y, z: req.z, connection: req.connection,
        initialDir: inst ? this.initialDirOf(r, req, inst) : -1,
        city: city && { x: city.x - r.x0, y: city.y - r.y0 },
      });
    }
    // After the region's own requests, so a crossing joins the network nearest to it (BN p2p);
    // in a region without one, the first crossing is a stub and later ones link to it.
    for (const s of r.seams) {
      const k = s.z * RR + s.y * REGION + s.x;
      const slot = r.layers.get(k);
      if (!slot || this.types[slot.t] !== s.terrain || slot.sp !== 0 || !(slot.line & (1 << s.side)))
        throw new Error(`overmap: the ${s.terrain} seam reserved at ${r.x0 + s.x},${r.y0 + s.y},${s.z} was overwritten by ${slot ? this.types[slot.t] : 'nothing'}`);
      b.connect({ x: s.x, y: s.y, z: s.z, connection: s.connection, initialDir: (s.side + 2) % 4 });
    }
  }

  /**
   * genVersion >= 3: reserve this region's half of every tunnel crossing on its edges (seams.ts)
   * before anything is placed, so no special can take a tile the neighbour's half lines up with.
   * Its line bit already points across the edge; buildConnections joins it to the network.
   */
  private reserveSeams(r: Region): void {
    // A crossing under a lake can't exist (BN's subway only runs through subterranean rock, and
    // the lake column is laid first). Both halves test both sides' tiles from the noise alone, so
    // the two regions drop the same crossings whichever generates first.
    r.seams = tunnelSeams(this.seed, r.rx, r.ry, REGION).filter((s) => {
      const gx = r.x0 + s.x, gy = r.y0 + s.y;
      return !this.lakeColumnAt(gx, gy, s.z) && !this.lakeColumnAt(gx + DX[s.side], gy + DY[s.side], s.z);
    });
    for (const s of r.seams) {
      const k = s.z * RR + s.y * REGION + s.x;
      if (r.layers.has(k)) throw new Error(`overmap: two tunnel seams at ${r.x0 + s.x},${r.y0 + s.y},${s.z}`);
      r.layers.set(k, { t: this.intern(s.terrain), rot: 0, line: 1 << s.side, sp: 0 });
    }
  }

  /**
   * BN overmap_special_connection initial_dir: the direction from the connection's "from" point to
   * the point itself, so the tunnel's last tile opens back into the special. Requests from code
   * that grows terrain without a special def (the lab grower) fall back to the one neighbour the
   * special owns at that z.
   */
  private initialDirOf(r: Region, req: ConnectionRequest, inst: SpecialInstance): number {
    for (const c of this.data.specials[inst.def]?.connections ?? []) {
      if (!c.from || c.p[2] !== req.z || connectionIdOf(c) !== req.connection) continue;
      const [px, py] = rotateOffset(c.p[0], c.p[1], inst.rot);
      if (inst.x - r.x0 + px !== req.x || inst.y - r.y0 + py !== req.y) continue;
      const [fx, fy] = rotateOffset(c.from[0], c.from[1], inst.rot);
      return DX.findIndex((dx, d) => dx === px - fx && DY[d] === py - fy);
    }
    const owned = [0, 1, 2, 3].filter((d) => r.layers.get(req.z * RR + (req.y + DY[d]) * REGION + req.x + DX[d])?.sp === inst.uid);
    return owned.length === 1 ? (owned[0] + 2) % 4 : -1;
  }

  /** Region access for mutable_place.ts (BN mutable specials, genVersion >= 2). */
  private mutableHost(r: Region): MutableHost {
    const slot = (x: number, y: number, z: number) => z * RR + y * REGION + x;
    return {
      data: this.data,
      regionSize: REGION,
      cities: r.cities,
      x0: r.x0,
      y0: r.y0,
      typeAt: (x, y, z) => {
        if (z === 0) return this.types[r.t[y * REGION + x]];
        const s = r.layers.get(slot(x, y, z));
        return s ? this.types[s.t] : this.defaultTerrain(z);
      },
      accepts: (l, t) => this.accepts(l, t),
      defaultTerrain: (z) => this.defaultTerrain(z),
      setTerrain: (x, y, z, oter, rot, uid) => {
        const ref = parseOterId(oter, this.data.terrains);
        const def = this.data.terrains[ref.type];
        if (!def) throw new Error(`mutable special writes unknown oter ${oter}`);
        const t = this.intern(ref.type);
        const orot = isRotatable(def) ? (ref.rot + rot) % 4 : 0;
        const line = ref.line >= 0 ? rotateLine(ref.line, rot) : -1;
        if (z === 0) {
          const i = y * REGION + x;
          (r.t[i] = t), (r.rot[i] = orot), (r.line[i] = line), (r.sp[i] = uid);
        } else if (ref.type === this.defaultTerrain(z)) {
          // Plain rock/air written by a special (a mine's shaft top, the rock under Lab with
          // Anthill's stairs) stays unowned, so nested specials (lab_basement) can still claim it.
          r.layers.delete(slot(x, y, z));
        } else r.layers.set(slot(x, y, z), { t, rot: orot, line, sp: uid });
      },
      newInstance: (def, x, y, rot, city) => {
        // Same uid scheme as placeSpecial: independent of region generation order.
        let uid = hashSeed(this.seed, r.rx, r.ry, r.specials.length, 31) & 0x7fffffff || 1;
        while (this.specialsByUid.has(uid)) uid = (uid + 1) & 0x7fffffff || 1;
        const inst: SpecialInstance = { uid, def, x, y, rot, city, args: new Map() };
        this.specialsByUid.set(uid, inst);
        r.specials.push(inst);
        return inst;
      },
      placeFixed: (def, x, y, rot, city) => this.placeSpecial(r, def, x, y, rot, city),
      addSpawns: (inst, spawns, x, y, z) => this.addSpecialSpawns(inst, spawns, r.x0 + x, r.y0 + y, z),
      buildLocalRoad: (x, y) => {
        const target = this.nearestRoad(r, x, y);
        if (target) this.buildRoad(r, [x, y], target);
      },
      requestConnection: (c) => r.connectionRequests.push(c),
      recordJoin: (x, y, z, dir, id) => this.joinsUsed.set(`${r.x0 + x},${r.y0 + y},${z},${dir}`, id),
      placeLabBasement: (rng, inst, x, y, z, rot) => this.placeLabBasement(r, rng, inst, x, y, z, rot),
      report: (inst, res) => this.mutableReports.push({
        uid: inst.uid, def: inst.def, openMandatory: res.openMandatory, bnUnresolved: res.bnUnresolved,
        pieces: res.placed.map((p) => ({ ...p, x: r.x0 + p.x, y: r.y0 + p.y })),
      }),
    };
  }

  private cityEdgeDistance(r: Region, x: number, y: number): number {
    let best = Infinity;
    for (const c of r.cities) best = Math.min(best, Math.hypot(c.x - r.x0 - x, c.y - r.y0 - y) - c.size);
    return best === Infinity ? 999 : Math.max(0, best);
  }
  private nearestCity(r: Region, x: number, y: number): City | undefined {
    let best: City | undefined, bd = Infinity;
    for (const c of r.cities) {
      const d = Math.hypot(c.x - r.x0 - x, c.y - r.y0 - y);
      if (d < bd) (bd = d), (best = c);
    }
    return best;
  }
  private nearestRoad(r: Region, x: number, y: number): [number, number] | undefined {
    for (let rad = 0; rad < REGION; rad++)
      for (let dy = -rad; dy <= rad; dy++)
        for (let dx = -rad; dx <= rad; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
          if (this.isRoad(r, x + dx, y + dy)) return [x + dx, y + dy];
        }
    return undefined;
  }

  private computeRoadLines(r: Region): void {
    const portals = [0, 1, 2, 3].map((s) => this.portalLocal(r, s));
    for (let y = 0; y < REGION; y++)
      for (let x = 0; x < REGION; x++) {
        const i = y * REGION + x;
        if (!isLinear(this.data.terrains[this.types[r.t[i]]])) continue;
        let line = 0;
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (nx < 0 || ny < 0 || nx >= REGION || ny >= REGION) {
            if (portals[d][0] === x && portals[d][1] === y) line |= LINE_BIT[d];
          } else if (this.types[r.t[ny * REGION + nx]] === this.types[r.t[i]]) line |= LINE_BIT[d];
        }
        r.line[i] = line;
      }
    // BN lays straight roads over water as bridge OMTs (bridge_north runs N-S); other shapes
    // stay road, drawn over the water. After all lines, so roads still connect to bridges.
    if (this.T.bridge === undefined) return;
    for (let i = 0; i < RR; i++) {
      if (r.t[i] !== this.T.road || (r.line[i] !== 5 && r.line[i] !== 10)) continue;
      const base = this.baseLand(r.x0 + (i % REGION), r.y0 + Math.floor(i / REGION));
      if (base !== 'river_center' && base !== 'lake_surface' && base !== 'lake_shore') continue;
      r.rot[i] = r.line[i] === 5 ? 0 : 1;
      r.t[i] = this.T.bridge;
      r.line[i] = -1;
    }
  }
}

/** BN overmap_special_connection: legacy "terrain" connections map to a connection id. */
function connectionIdOf(c: SpecialConnection): string {
  if (c.connection) return c.connection;
  return c.terrain === 'sewer' ? 'sewer_tunnel' : c.terrain === 'subway' ? 'subway_tunnel' : c.terrain === 'forest_trail' ? 'forest_trail' : 'local_road';
}

function rollRemainder(v: number, rng: Rng): number {
  const f = Math.floor(v);
  return f + (rng.next() < v - f ? 1 : 0);
}

function normalRoll(rng: Rng, mean: number, sigma: number): number {
  if (sigma <= 0) return mean;
  const u = Math.max(1e-9, rng.next()), v = rng.next();
  return mean + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
