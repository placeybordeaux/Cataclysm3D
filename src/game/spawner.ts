import { Rng, hashSeed } from '../core/rng';
import { CHUNK } from '../world/coords';
import type { Chunk, SpawnRequest } from '../world/map';
import { pickFromMonsterGroup, type MonsterGroupContext, type MonsterSpawn } from '../data/index';
import { warnOnce } from '../data/warn';
import { dormantBase, type MonsterSystem } from './monai';
import { chunkTracker } from '../save/tracking';

// Turns mapgen spawn requests (Chunk.spawns) into monsters, plus CDDA's overmap-level city
// hordes (overmap::place_mongroups). Chunks generate lazily, so everything is keyed off the
// chunk's own coordinates and a per-chunk RNG: the same world seed gives the same monsters no
// matter in which order chunks were generated.
//
// Semantics (mapgen.cpp):
//  - kind 'monster': one mtype, `count` individuals at (x, y) (chance already rolled by mapgen).
//  - kind 'group' with `density` or from place_monsters: num = density * rng(10, 50) rolls of
//    the group (MonsterGroupManager::GetResultFromGroup), each placed at a random passable
//    tile of `area`. Missing density = the OMT's monster density (sum of neighbour mondensity
//    over a 7x7 OMT window / 100, as mapgendata computes it).
//  - kind 'group' with `count` (overmap_terrain "spawns", monster-group "monster" entries):
//    `count` population points rolled from the group, each consuming max(1, pack) points.

/** What the spawner needs from the overmap (src/world/overmap). */
export interface OvermapView {
  /** oter type id at an OMT (e.g. "road", "house_01", "forest"). */
  omtType(x: number, y: number, z: number): string;
  /** overmap_terrain mondensity of the OMT's type (0 when unset). */
  mondensity(x: number, y: number): number;
  /** Cities near an OMT: centre in OMT coords and CDDA size. */
  citiesNear(x: number, y: number): { name: string; x: number; y: number; size: number }[];
}

export interface SpawnerOptions {
  /**
   * Scale on CDDA's SPAWN_CITY_HORDE_SCALAR (80 zombies per city size). 1 = CDDA default.
   * Real-time melee is harder than turn-based, so the default is lower.
   */
  cityHordeScale?: number;
  /** Scale on mapgen group densities (CDDA SPAWN_DENSITY). */
  density?: number;
  /** No hostile spawns closer than this to the player when a chunk generates. */
  safeRadius?: number;
}

/** CDDA external_options defaults. */
const CITY_HORDE_THRESHOLD = 4;
const CITY_HORDE_SMALL_CHANCE = 16;
const CITY_HORDE_SPREAD = 1.5;
const CITY_HORDE_SCALAR = 80;
const MON_RADIUS = 3;

interface CityHorde {
  /** omt key -> number of submaps (quarter-OMTs) eligible for horde placement */
  subs: Map<string, number>;
  totalSubs: number;
  desired: number;
}

export class Spawner {
  readonly opts: Required<SpawnerOptions>;
  private cities = new Map<string, CityHorde | null>();
  /** Counts for debugging / tests. */
  readonly stats = { chunks: 0, requests: 0, monsters: 0, horde: 0, dormant: 0 };
  /**
   * Chunks whose spawns were already consumed in an earlier session (set by save/load):
   * regenerating them must not spawn their monsters again — those live in the save.
   */
  skipChunk: ((c: Chunk) => boolean) | null = null;

  constructor(readonly sys: MonsterSystem, readonly overmap: OvermapView | null = null, opts: SpawnerOptions = {}) {
    this.opts = { cityHordeScale: 0.3, density: 1, safeRadius: 10, ...opts };
  }

  /** Hook into map generation; also consumes chunks generated before installation. */
  install(): void {
    const map = this.sys.game.map;
    for (const c of map.loadedChunks()) this.onChunk(c);
    map.onChunkGenerated.push((c) => this.onChunk(c));
    map.onChunkUpdated.push((c) => this.onChunkUpdated(c));
  }

  /** update_mapgen placed monsters in a live chunk: spawn just those (no city horde, no skip). */
  onChunkUpdated(c: Chunk): void {
    const requests = c.spawns;
    c.spawns = [];
    const rng = new Rng(hashSeed(this.sys.game.seed, c.cx, c.cy, c.z, c.version, 0x0bda));
    for (const r of requests) {
      this.stats.requests++;
      this.request(c, r, rng);
    }
  }

  private groupCtx(): MonsterGroupContext {
    const clock = this.sys.game.clock;
    const h = clock.hourOfDay;
    return {
      elapsed: clock.seconds,
      season: clock.season.toUpperCase() as MonsterGroupContext['season'],
      timeOfDay: h >= 5 && h < 7 ? 'DAWN' : h >= 7 && h < 18 ? 'DAY' : h >= 18 && h < 20 ? 'DUSK' : 'NIGHT',
    };
  }

  onChunk(c: Chunk): void {
    const requests = c.spawns;
    // Spawn points are one-shot (CDDA removes them once spawned) so reloads don't duplicate.
    c.spawns = [];
    if (this.skipChunk?.(c)) return;
    const rng = new Rng(hashSeed(this.sys.game.seed, c.cx, c.cy, c.z, 0x5ba7));
    this.stats.chunks++;
    this.baselineChunk = c;
    this.cleanBeforeCorpses = null;
    try {
      for (const r of requests) {
        this.stats.requests++;
        this.request(c, r, rng);
      }
      if (c.z === 0 && this.overmap) this.cityHorde(c, rng);
    } finally {
      this.baselineChunk = null;
    }
    // Dormant-zombie corpses are part of what generating this chunk produces: accept them into
    // its baseline so a chunk nobody touched stays clean (evictable, not saved). The monster
    // stash keeps them across eviction and save/load, since the spawner skips regenerated chunks.
    if (this.cleanBeforeCorpses) chunkTracker(this.sys.game)?.rebaseline(c);
  }

  /** Chunk being populated by onChunk (not update_mapgen), and whether it was clean before any corpse. */
  private baselineChunk: Chunk | null = null;
  private cleanBeforeCorpses: boolean | null = null;

  private request(c: Chunk, r: SpawnRequest, rng: Rng): void {
    const data = this.sys.game.data;
    if (r.kind === 'monster') {
      if (!data.monsters[r.id]) {
        warnOnce('monster', r.id);
        return;
      }
      this.place(c, [{ id: r.id, count: r.count ?? 1 }], r.x, r.y, rng, r);
      return;
    }
    if (!data.monsterGroups[r.id]) {
      warnOnce('monstergroup', r.id);
      return;
    }
    const area = r.area ?? [r.x, r.y, r.x, r.y];
    if (r.count !== undefined || r.density === undefined && !this.isPlaceMonsters(r)) {
      // Population points (overmap spawns / monster-group entries).
      let pop = r.count ?? 1;
      while (pop > 0) {
        const res = pickFromMonsterGroup(data, r.id, rng, this.groupCtx());
        pop -= Math.max(1, res.reduce((s, x) => s + x.count, 0));
        const [x, y] = this.randomPoint(c, area, rng);
        this.place(c, res, x, y, rng, r);
      }
      return;
    }
    const density = (r.density ?? this.omtDensity(c)) * this.opts.density;
    let num = rollRemainder(density * (10 + rng.next() * 40), rng);
    while (num > 0) {
      const res = pickFromMonsterGroup(data, r.id, rng, this.groupCtx());
      num -= Math.max(1, res.reduce((s, x) => s + x.count, 0));
      const [x, y] = this.randomPoint(c, area, rng);
      this.place(c, res, x, y, rng, r);
    }
  }

  /** place_monsters requests carry an area or explicit density; single points are pack spawns. */
  private isPlaceMonsters(r: SpawnRequest): boolean {
    return !!r.area;
  }

  /** mapgendata::monster_density: sum of mondensity over a 7x7 OMT window / 100. */
  omtDensity(c: Chunk): number {
    if (!this.overmap) return 0.5;
    let d = 0;
    for (let j = -MON_RADIUS; j <= MON_RADIUS; j++) for (let i = -MON_RADIUS; i <= MON_RADIUS; i++) d += this.overmap.mondensity(c.cx + i, c.cy + j);
    return d / 100;
  }

  private randomPoint(c: Chunk, area: [number, number, number, number], rng: Rng): [number, number] {
    const map = this.sys.game.map;
    let x = area[0], y = area[1];
    for (let tries = 10; tries > 0; tries--) {
      x = rng.int(Math.min(area[0], area[2]), Math.max(area[0], area[2]));
      y = rng.int(Math.min(area[1], area[3]), Math.max(area[1], area[3]));
      if (this.inChunk(c, x, y) && map.passable(x, y, c.z)) break;
    }
    return [x, y];
  }

  private inChunk(c: Chunk, x: number, y: number): boolean {
    return x >= c.cx * CHUNK && y >= c.cy * CHUNK && x < (c.cx + 1) * CHUNK && y < (c.cy + 1) * CHUNK;
  }

  /** Put each individual of each result near (x, y) on a free passable tile of this chunk. */
  private place(c: Chunk, res: MonsterSpawn[], x: number, y: number, rng: Rng, r?: Pick<SpawnRequest, 'friendly' | 'name'>): void {
    const map = this.sys.game.map;
    const data = this.sys.game.data;
    const p = this.sys.game.player;
    for (const s of res) {
      const base = dormantBase(s.id);
      if (base) {
        // Dormant zombies lie around as corpses and rise when approached.
        const bdef = data.monsters[base];
        if (!bdef) {
          warnOnce('monster', base);
          continue;
        }
        for (let n = 0; n < s.count; n++) {
          const tx = x + (n ? rng.int(-1, 1) : 0), ty = y + (n ? rng.int(-1, 1) : 0);
          if (!this.inChunk(c, tx, ty) || !map.passable(tx, ty, c.z)) continue;
          if (this.baselineChunk === c && this.cleanBeforeCorpses === null) {
            const tracker = chunkTracker(this.sys.game);
            this.cleanBeforeCorpses = !!tracker && !tracker.isDirty(c);
          }
          this.sys.placeCorpse(bdef, tx + 0.5, ty + 0.5, c.z, { dormant: true, facing: rng.next() * 6.28 });
          this.stats.dormant++;
        }
        continue;
      }
      const def = data.monsters[s.id];
      if (!def) {
        warnOnce('monster', s.id);
        continue;
      }
      for (let n = 0; n < s.count; n++) {
        let tx = x, ty = y;
        for (let tries = 0; tries < 12; tries++) {
          const rad = 1 + Math.floor(tries / 4);
          const cx = tries === 0 ? x : x + rng.int(-rad, rad), cy = tries === 0 ? y : y + rng.int(-rad, rad);
          if (this.inChunk(c, cx, cy) && map.passable(cx, cy, c.z) && !this.occupied(cx, cy, c.z)) {
            tx = cx;
            ty = cy;
            break;
          }
        }
        if (!this.inChunk(c, tx, ty) || !map.passable(tx, ty, c.z)) continue;
        const hostile = def.aggression > 0 && !r?.friendly;
        if (hostile && p.z === c.z && Math.hypot(tx + 0.5 - p.x, ty + 0.5 - p.y) < this.opts.safeRadius) continue;
        this.sys.spawn(def, tx + 0.3 + rng.next() * 0.4, ty + 0.3 + rng.next() * 0.4, c.z, {
          friendly: r?.friendly,
          name: r?.name,
          rng: new Rng(hashSeed(this.sys.game.seed, tx, ty, c.z, this.stats.monsters)),
        });
        this.stats.monsters++;
      }
    }
  }

  private occupied(x: number, y: number, z: number): boolean {
    for (const m of this.sys.all) if (m.z === z && m.tileX === x && m.tileY === y && !m.dead) return true;
    return false;
  }

  // ------------------------------------------------------------------ city hordes

  /**
   * overmap::place_mongroups: cities above the size threshold (or 1 in 16 small ones) get
   * size * 80 zombies spread over road submaps within size * 1.5 OMTs, denser toward the
   * centre (4 submaps per road OMT near the middle, fewer further out), 10 per group.
   * We roll this per road chunk: each eligible submap gets a GROUP_ZOMBIE_HORDE population
   * of 10 with probability desired / (10 * eligible submaps).
   */
  private cityHorde(c: Chunk, rng: Rng): void {
    const om = this.overmap!;
    if (om.omtType(c.cx, c.cy, 0) !== 'road') return;
    const scale = this.opts.cityHordeScale;
    if (scale <= 0) return;
    for (const city of om.citiesNear(c.cx, c.cy)) {
      const h = this.hordeFor(city);
      if (!h) continue;
      const subs = h.subs.get(`${c.cx},${c.cy}`) ?? 0;
      if (!subs) continue;
      const p = Math.min(1, (h.desired * scale) / (10 * h.totalSubs));
      const quads: [number, number][] = [[0, 0], [12, 0], [0, 12], [12, 12]];
      // CDDA shuffles the 4 quadrants and keeps `subs` of them.
      for (let i = quads.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [quads[i], quads[j]] = [quads[j], quads[i]];
      }
      for (let q = 0; q < subs; q++) {
        if (rng.next() >= p) continue;
        const X = c.cx * CHUNK + quads[q][0], Y = c.cy * CHUNK + quads[q][1];
        let pop = 10;
        while (pop > 0) {
          const res = pickFromMonsterGroup(this.sys.game.data, 'GROUP_ZOMBIE_HORDE', rng, this.groupCtx());
          pop -= Math.max(1, res.reduce((s, x) => s + x.count, 0));
          const [x, y] = this.randomPoint(c, [X, Y, X + 11, Y + 11], rng);
          const before = this.stats.monsters;
          this.place(c, res, x, y, rng);
          this.stats.horde += this.stats.monsters - before;
        }
      }
    }
  }

  private hordeFor(city: { name: string; x: number; y: number; size: number }): CityHorde | null {
    const key = `${city.x},${city.y}`;
    if (this.cities.has(key)) return this.cities.get(key)!;
    let res: CityHorde | null = null;
    // Whether a small city gets a horde is a per-city roll, seeded by its position.
    const crng = new Rng(hashSeed(this.sys.game.seed, city.x, city.y, 0xc17));
    if (city.size > CITY_HORDE_THRESHOLD || crng.oneIn(CITY_HORDE_SMALL_CHANCE)) {
      const radius = city.size * CITY_HORDE_SPREAD;
      const inc = Math.ceil(radius / 4);
      const subs = new Map<string, number>();
      let total = 0;
      const r = Math.floor(radius);
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const d = Math.hypot(dx, dy);
          if (d > radius) continue;
          if (this.overmap!.omtType(city.x + dx, city.y + dy, 0) !== 'road') continue;
          const n = 4 - Math.floor(d / inc);
          if (n <= 0) continue;
          subs.set(`${city.x + dx},${city.y + dy}`, n);
          total += n;
        }
      if (total > 0) res = { subs, totalSubs: total, desired: city.size * CITY_HORDE_SCALAR };
    }
    this.cities.set(key, res);
    return res;
  }
}

/** CDDA roll_remainder: integer part plus a chance for the fraction. */
export function rollRemainder(v: number, rng: Rng): number {
  const i = Math.floor(v);
  return i + (rng.next() < v - i ? 1 : 0);
}
