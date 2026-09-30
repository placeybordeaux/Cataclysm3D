import { Rng, hashSeed } from '../../core/rng';
import type { OvermapData, SpecialDef } from '../worldgen_data';
import { Noise2D } from './noise';
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
/** The oter types a lab_basement is built from (BN overmap_mutable/lab.json). */
export const LAB_BASEMENT_TYPES = ['lab', 'lab_filler', 'lab_stairs', 'lab_core', 'lab_finale'] as const;
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
  constructor(readonly rx: number, readonly ry: number) {}
  get x0() { return this.rx * REGION; }
  get y0() { return this.ry * REGION; }
}

const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
const LINE_BIT = [LINE_N, LINE_E, LINE_S, LINE_W];

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
  /** Default terrain below ground: DDA has solid_earth at z-1; BN is empty_rock everywhere. */
  private readonly shallowUnderground: string;
  readonly T: Record<string, number> = {};

  constructor(readonly seed: number, readonly data: OvermapData) {
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
    if (z === 0 && (sp || ref.type === 'road' || ref.type === 'bridge')) info.predecessor = this.baseLand(x, y);
    return info;
  }

  /** Cities of every region generated so far plus the regions around (x, y). */
  citiesNear(x: number, y: number, radiusRegions = 1): City[] {
    const rx = Math.floor(x / REGION), ry = Math.floor(y / REGION);
    const out: City[] = [];
    for (let dy = -radiusRegions; dy <= radiusRegions; dy++)
      for (let dx = -radiusRegions; dx <= radiusRegions; dx++) out.push(...this.region(rx + dx, ry + dy).cities);
    return out;
  }

  closestCity(x: number, y: number, radiusRegions = 1): City | undefined {
    let best: City | undefined, bd = Infinity;
    for (const c of this.citiesNear(x, y, radiusRegions)) {
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
    if (this.isLake(x, y)) return 'lake_surface';
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
    this.placeCities(r, rng);
    this.connectRegion(r, rng);
    this.placeSpecials(r, rng);
    this.computeRoadLines(r);
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
        this.placeSpecial(r, def, bx, by, bdir, city);
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
        case 'river_center': case 'lake_surface': return 25;
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
      const uniq = def.flags.includes('OVERMAP_UNIQUE') || def.flags.includes('GLOBALLY_UNIQUE');
      let count = uniq ? (rng.int(1, 100) <= lo * area * 2 ? 1 : 0) : rollRemainder(rng.int(lo, hi) * area, rng);
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
        this.tryPlaceWild(r, rng, def, r.cities[0], true);
        continue;
      }
      for (let k = 0; k < count; k++) this.tryPlaceWild(r, rng, def, start && id === 'Evac Shelter' ? r.cities[0] : undefined);
    }
    // Microlabs hold most of CDDA's loose CBMs; make sure the start region has one too. Done
    // after the loop so the RNG draws (and thus placement) of everything above is unchanged.
    const micro = this.data.specials[MICROLAB_SPECIAL];
    if (start && r.cities.length && micro && !r.specials.some((s) => s.def === MICROLAB_SPECIAL)) this.tryPlaceWild(r, rng, micro, r.cities[0], true);
  }

  /** `widen`: big specials (the refugee center) search ever further from `near` until they fit. */
  private tryPlaceWild(r: Region, rng: Rng, def: SpecialDef, near?: City, widen = false): boolean {
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
        if (n.special === 'lab_basement') this.placeLabBasement(r, rng, inst, x + dx, y + dy, n.p[2]);
      }
      for (const c of def.connections) {
        const [dx, dy] = rotateOffset(c.p[0], c.p[1], rot);
        const cx = x + dx, cy = y + dy;
        if (cx < 1 || cy < 1 || cx >= REGION - 1 || cy >= REGION - 1) continue;
        const target = this.nearestRoad(r, cx, cy);
        if (target) this.buildRoad(r, [cx, cy], target);
      }
      void inst;
      return true;
    }
    return false;
  }

  /**
   * BN's mutable "lab_basement" special (overmap_mutable/lab.json), simplified: from a lab_core
   * under the entrance, each level is a connected blob of lab rooms inside a 4x4-OMT box (the
   * special's shared "size"); every level but the last has a lab_stairs room leading to the
   * lab_core below it, a lab_filler or two pad the blob, and the bottom level holds the finale.
   * Escape cells and train depots are left out.
   */
  private placeLabBasement(r: Region, rng: Rng, inst: SpecialInstance, x: number, y: number, z0: number): void {
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
      if (base !== 'river_center' && base !== 'lake_surface') continue;
      r.rot[i] = r.line[i] === 5 ? 0 : 1;
      r.t[i] = this.T.bridge;
      r.line[i] = -1;
    }
  }
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

class MinHeap {
  private k: number[] = [];
  private p: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, pri: number): void {
    const k = this.k, p = this.p;
    k.push(key);
    p.push(pri);
    let i = k.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (p[par] <= p[i]) break;
      [k[par], k[i]] = [k[i], k[par]];
      [p[par], p[i]] = [p[i], p[par]];
      i = par;
    }
  }
  pop(): number {
    const k = this.k, p = this.p;
    const top = k[0];
    const lk = k.pop()!, lp = p.pop()!;
    if (k.length) {
      k[0] = lk;
      p[0] = lp;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, rr = l + 1;
        let m = i;
        if (l < k.length && p[l] < p[m]) m = l;
        if (rr < k.length && p[rr] < p[m]) m = rr;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [p[m], p[i]] = [p[i], p[m]];
        i = m;
      }
    }
    return top;
  }
}
