import { Rng, hashSeed, hashString } from '../core/rng';
import { warnOnce } from '../data/warn';
import type { GameData } from '../data/types';
import { expandItemGroup } from '../data/itemgroups';
import { CHUNK } from './coords';
import type { Chunk, ChunkGenerator, GameMap, MapItem } from './map';
import { hasFlag } from './registry';
import type { WorldgenData } from './worldgen_data';
import { MapBuffer, OMT } from './mapgen/buffer';
import { mapgenForest, mapgenLakeUnderwaterShore, mapgenWater, biomeFor, isWaterType, resolveRegional } from './mapgen/builtin';
import { type BuiltinEnv, addManholeLadder, manholeSpot, runBnBuiltin } from './mapgen/bnbuiltin';
import { mapgenLab } from './mapgen/lab';
import { MAP_EXTRA_FUNCTIONS, type MapExtraEnv } from './mapgen/mapextras';
import { Levels, MapgenDat, MapgenEnv, MapgenRunner } from './mapgen/jsonmapgen';
import { GenStats } from './mapgen/stats';
import { ArgStores, ParamCtx } from './mapgen/values';
import { OmtInfo, Overmap, SpecialInstance, WORLDGEN_VERSION } from './overmap/overmap';
import { LAKE_DEPTH } from './overmap/lakes';
import { DIR_SUFFIX, mapgenIdOf, oterId, oterRotation } from './overmap/oter';
import { weightedPick } from './mapgen/values';

// The world chunk generator: one chunk == one OMT at one z-level. The overmap says what
// goes where; CDDA JSON mapgen (or a builtin for forests/water) fills the 24x24 tiles.
// Everything is deterministic in (world seed, chunk coords).

export interface StartLocation {
  x: number;
  y: number;
  z: number;
  /** overmap special the start is in */
  special: string;
  omx: number;
  omy: number;
}

export class WorldGenerator implements ChunkGenerator {
  readonly overmap: Overmap;
  readonly stats = new GenStats();
  readonly runner: MapgenRunner;
  private map: GameMap | null = null;
  /** overlays produced by mapgen z offsets for chunks not generated yet, keyed by chunk key */
  private pending = new Map<string, MapBuffer[]>();
  /** omt_stack-scoped parameter stores, and special-scope stores for OMTs outside specials */
  private stackArgs = new Map<string, Map<string, string>>();
  private looseSpecialArgs = new Map<string, Map<string, string>>();
  private terFlagCache = new Map<string, readonly string[] | undefined>();
  /** CDDA ter_furn_migration: obsolete ids still used by some mapgen -> current ids */
  private terMigration = new Map<string, { ter: string; furn?: string }>();
  private furnMigration = new Map<string, string>();
  /** update_mapgen runs so far (salts their RNG so repeated updates differ) */
  private updates = 0;

  constructor(readonly seed: number, readonly wg: WorldgenData, readonly game: GameData, readonly genVersion: number = WORLDGEN_VERSION) {
    this.overmap = new Overmap(seed, wg.overmap, genVersion);
    for (const m of Object.values<any>(game.misc?.ter_furn_migration ?? {})) {
      if (m.from_ter && m.to_ter) this.terMigration.set(m.from_ter, { ter: m.to_ter, furn: m.to_furn });
      if (m.from_furn && m.to_furn) this.furnMigration.set(m.from_furn, m.to_furn);
    }
    const env: MapgenEnv = {
      seed,
      data: wg,
      stats: this.stats,
      terrainFlags: (id) => this.terrainFlags(id),
      furnitureKnown: (id) => !!this.map?.furniture.has(id) || this.furnMigration.has(id),
      furnitureFlags: (id) => {
        const n = this.map?.furniture.tryIndex(this.furnMigration.get(id) ?? id);
        return n === undefined ? undefined : this.map!.furniture.get(n).flags;
      },
      terFurnTransform: (id) => game.misc?.ter_furn_transform?.[id],
      furnitureBashTo: (id) => {
        const m = this.map;
        const n = m?.furniture.tryIndex(id);
        if (!m || n === undefined) return undefined;
        const f = m.furniture.get(n).bash?.furn_set;
        return f === undefined ? '' : f === 'f_null' ? '' : f;
      },
      terrainBashTo: (id) => {
        const m = this.map;
        const n = m?.terrain.tryIndex(this.terMigration.get(id)?.ter ?? id);
        return m && n !== undefined ? m.terrain.get(n).bash?.ter_set : undefined;
      },
      snippets: (cat) => game.misc?.snippet?.[cat],
      expandItems: (ref, rng) => expandItemGroup(this.game, ref as any, rng),
      runPredecessor: (type, dat, levels) => {
        const ref = { type, rot: 0, line: -1 };
        const sub: MapgenDat = { ...dat, oter: ref, rotation: 0, adjRotation: 0 };
        this.generateInto(sub, levels);
      },
    };
    this.runner = new MapgenRunner(env);
  }

  private get builtinEnv(): BuiltinEnv {
    return {
      region: this.wg.overmap.region,
      terrains: this.wg.overmap.terrains,
      expandItems: (ref, rng) => expandItemGroup(this.game, ref as any, rng),
    };
  }

  private get mapExtraEnv(): MapExtraEnv {
    const m = this.map;
    if (!m) throw new Error('map extras before the generator has a map');
    return {
      expandItems: (ref, rng) => expandItemGroup(this.game, ref as any, rng),
      terrainFlags: (id) => this.terrainFlags(id),
      passable: (buf, i) => this.tilePassable(buf, i),
      terrainBash: (id) => {
        const n = m.terrain.tryIndex(this.terMigration.get(id)?.ter ?? id);
        const b = n === undefined ? undefined : m.terrain.get(n).bash;
        // (a bashable terrain without ter_set counts as unbashable: make_rubble then lays t_dirt,
        // which is where BN's destroy loop ends up for rubble too)
        return b && b.str_max !== -1 ? b.ter_set : undefined;
      },
      furnitureBash: (id) => {
        const n = m.furniture.tryIndex(this.furnMigration.get(id) ?? id);
        const b = n === undefined ? undefined : m.furniture.get(n).bash;
        if (!b || b.str_max === -1) return undefined;
        return !b.furn_set || b.furn_set === 'f_null' ? '' : b.furn_set;
      },
      fieldMaxIntensity: (id) => {
        const levels = this.game.misc?.field_type?.[id]?.intensity_levels;
        if (!Array.isArray(levels) || !levels.length) throw new Error(`map extra: unknown field type ${id}`);
        return levels.length;
      },
    };
  }

  private terrainFlags(id: string): readonly string[] | undefined {
    if (this.terFlagCache.has(id)) return this.terFlagCache.get(id);
    const m = this.map;
    const n = m?.terrain.tryIndex(this.terMigration.get(id)?.ter ?? id);
    const flags = m && n !== undefined ? m.terrain.get(n).flags : undefined;
    this.terFlagCache.set(id, flags);
    return flags;
  }

  // ------------------------------------------------------------------------------------

  /**
   * Drop overlays waiting for chunks that were never generated. Needed when the map is
   * cleared (save loaded into a running game): the sources regenerate and re-queue them.
   */
  resetPending(): void {
    this.pending.clear();
  }

  forgetColumn(cx: number, cy: number): void {
    const prefix = `${cx},${cy},`;
    for (const k of this.pending.keys()) if (k.startsWith(prefix)) this.pending.delete(k);
  }

  generate(map: GameMap, c: Chunk): void {
    this.map = map;
    // Upper levels need the level below first: roofs/tree tops and z+1 overlays come from it.
    if (c.z > 0) map.chunk(c.cx, c.cy, c.z - 1);
    const t0 = performance.now();
    const omt = this.overmap.omtAt(c.cx, c.cy, c.z);
    const base = new MapBuffer(c.z > 0 ? 't_open_air' : c.z < 0 ? 't_soil' : 't_region_groundcover');
    const levels: Levels = new Map([[0, base]]);
    const dat = this.makeDat(c.cx, c.cy, c.z, omt);
    const source = this.generateInto(dat, levels);

    const key = `${c.cx},${c.cy},${c.z}`;
    for (const ov of this.pending.get(key) ?? []) applyOverlay(base, ov);
    this.pending.delete(key);

    const onUnknown = (id: string) => this.stats.unknownId('region', id);
    for (const b of levels.values()) resolveRegional(b, this.wg.overmap.region, dat.rng, onUnknown);
    if (c.z > 0) this.addRoofs(map, c, base);

    this.writeChunk(map, c, base);
    c.omt = { id: omt.id, source };
    this.addOterSpawns(c, omt);

    for (const [dz, b] of levels) {
      if (dz === 0) continue;
      const tz = c.z + dz;
      if (map.hasChunk(c.cx, c.cy, tz)) {
        const target = map.chunk(c.cx, c.cy, tz)!;
        if (map.overlayFilter && !map.overlayFilter(target, key)) continue;
        const tmp = this.readChunk(map, target);
        applyOverlay(tmp, b);
        this.writeChunk(map, target, tmp);
      } else {
        const k = `${c.cx},${c.cy},${tz}`;
        let l = this.pending.get(k);
        if (!l) this.pending.set(k, (l = []));
        l.push(b);
      }
    }
    this.stats.chunkDone(source, performance.now() - t0, c.z);
  }

  /**
   * CDDA run_mapgen_update_func: apply an update_mapgen (id from mapgen.json `update`, or an
   * inline object like a mission's "update_mapgen") to the live chunk of OMT (omx, omy, z),
   * generating it first if needed. Like update_mapgen_function_json::update_map the chunk is
   * rotated back to north, the pieces applied in the usual phases, and rotated again, so the
   * JSON's coordinates mean the same as in the OMT's own mapgen. Items, fields and traps
   * already there survive unless the update removes them. New monster/vehicle/NPC requests
   * go through `map.onChunkUpdated`. Returns false for an unknown id.
   */
  applyUpdate(map: GameMap, src: string | Record<string, unknown>, omx: number, omy: number, z: number, opts: { dropMissionTargets?: boolean } = {}): boolean {
    this.map = map;
    let obj: any;
    if (typeof src === 'string') {
      const idx = this.wg.mapgen.update?.[src];
      if (idx === undefined) {
        warnOnce('update_mapgen', src, `[mapgen] unknown update_mapgen "${src}" (not referenced by npcs.json when extracted?)`);
        return false;
      }
      obj = this.wg.mapgen.objects[idx];
    } else obj = src;
    // Mission targets ("target": true) are spawned by the mission system, which tracks them.
    if (opts.dropMissionTargets && Array.isArray(obj.place_monster)) obj = { ...obj, place_monster: obj.place_monster.filter((p: any) => !p.target) };
    const c = map.chunk(omx, omy, z);
    if (!c) return false;
    const compiled = { ...this.runner.compiler.build(obj, 0, 0, false), fillTer: undefined, predecessor: undefined, fallbackPredecessor: undefined };
    const omt = this.overmap.omtAt(omx, omy, z);
    const dat = this.makeDat(omx, omy, z, omt);
    const rng = new Rng(hashSeed(this.seed, omx, omy, z, hashString(typeof src === 'string' ? src : JSON.stringify(src)), this.updates++));
    const d: MapgenDat = { ...dat, rng, params: new ParamCtx(dat.params.stores, new Map(), rng) };
    const base = this.readChunk(map, c);
    // Requests the chunk already handed out must not be made twice.
    base.spawns = [];
    base.vehicles = [];
    base.npcs = [];
    const levels: Levels = new Map([[0, base]]);
    this.runner.runTop(compiled, d, levels);
    const onUnknown = (id: string) => this.stats.unknownId('region', id);
    for (const b of levels.values()) resolveRegional(b, this.wg.overmap.region, rng, onUnknown);
    const changed: Chunk[] = [c];
    this.writeChunk(map, c, base);
    for (const [dz, b] of levels) {
      if (dz === 0) continue;
      const target = map.chunk(omx, omy, z + dz);
      if (!target) continue;
      const tmp = this.readChunk(map, target);
      tmp.spawns = [];
      tmp.vehicles = [];
      tmp.npcs = [];
      applyOverlay(tmp, b);
      this.writeChunk(map, target, tmp);
      changed.push(target);
    }
    for (const ch of changed) for (const fn of map.onChunkUpdated) fn(ch);
    return true;
  }

  /**
   * CDDA overmap_terrain "spawns" (e.g. houses: GROUP_VANILLA, 1-4, 80%) become a monster
   * group request covering the whole OMT. Separate RNG so mapgen results don't depend on it.
   */
  private addOterSpawns(c: Chunk, omt: OmtInfo): void {
    const s = this.wg.overmap.terrains[omt.type]?.spawns;
    if (!s) return;
    const rng = new Rng(hashSeed(this.seed, c.cx, c.cy, c.z, 77));
    if (!rng.chance(s.chance)) return;
    const count = rng.int(s.population[0], s.population[1]);
    if (count <= 0) return;
    const X = c.cx * CHUNK, Y = c.cy * CHUNK;
    c.spawns.push({ kind: 'group', id: s.group, x: X + 12, y: Y + 12, z: c.z, area: [X, Y, X + CHUNK - 1, Y + CHUNK - 1], count });
  }

  /**
   * Generate one OMT type in isolation (fields all around, no special) and return the raw
   * buffer. For debugging and data coverage runs; does not touch the map.
   */
  previewOmt(map: GameMap, type: string, rot = 0, seed = 1): { buf: MapBuffer; source: string } {
    this.map = map;
    const defs = this.wg.overmap.terrains;
    const ref = { type, rot, line: defs[type]?.flags.includes('LINEAR') ? 15 : -1 };
    const omt: OmtInfo = { ...ref, id: type };
    const dat = this.makeDat(1_000_000 + seed, 1_000_000, 0, omt);
    const d: MapgenDat = { ...dat, omtAt: () => ({ type: 'field', rot: 0, line: -1 }), cityName: 'Preview' };
    const levels: Levels = new Map([[0, new MapBuffer('t_region_groundcover')]]);
    const source = this.generateInto(d, levels);
    resolveRegional(levels.get(0)!, this.wg.overmap.region, d.rng, (id) => this.stats.unknownId('region', id));
    return { buf: levels.get(0)!, source };
  }

  private makeDat(x: number, y: number, z: number, omt: OmtInfo): MapgenDat {
    const sp = omt.special;
    const stackKey = `${x},${y}`;
    let stack = this.stackArgs.get(stackKey);
    if (!stack) this.stackArgs.set(stackKey, (stack = new Map()));
    let special: Map<string, string>;
    if (sp) special = sp.args;
    else {
      special = this.looseSpecialArgs.get(stackKey) ?? new Map();
      this.looseSpecialArgs.set(stackKey, special);
    }
    const stores: ArgStores = {
      seed: this.seed,
      specialKey: sp ? hashSeed(sp.uid, 7) : hashSeed(x, y, 11),
      special,
      stackKey: hashSeed(x, y, 13),
      stack,
      omtKey: hashSeed(x, y, z, 17),
      omt: new Map(),
    };
    const rng = new Rng(hashSeed(this.seed, x, y, z, 1234));
    const defs = this.wg.overmap.terrains;
    const city = sp?.city ?? this.overmap.closestCity(x, y, 0);
    return {
      env: this.runner.env,
      omx: x, omy: y, z,
      oter: { type: omt.type, rot: omt.rot, line: omt.line },
      rotation: oterRotation(omt, defs),
      adjRotation: defs[omt.type]?.flags.includes('IGNORE_ROTATION_FOR_ADJACENCY') ? 0 : oterRotation(omt, defs),
      omtAt: (dx, dy, dz) => this.overmap.omtAt(x + dx, y + dy, z + dz),
      predecessors: omt.predecessor ? [omt.predecessor] : [],
      joinAt: (dir) => this.overmap.joinAt(x, y, z, dir),
      params: new ParamCtx(stores, new Map(), rng),
      rng,
      cityName: city?.name ?? 'illegible city name',
      names: this.wg.overmap.names,
    };
  }

  /** Fill `levels` for dat.oter. Returns a short description of the method used. */
  private generateInto(dat: MapgenDat, levels: Levels): string {
    const defs = this.wg.overmap.terrains;
    const def = defs[dat.oter.type];
    const base = levels.get(0)!;
    const mapgenId = mapgenIdOf(dat.oter, defs);
    if (this.runner.runOmt(mapgenId, dat, levels)) return `json`;
    // Surface water gets shores blended against land neighbours (CDDA's river/lake builtins)
    // even though river_center/lake_surface declare a uniform terrain.
    if (isWaterType(dat.oter.type) && dat.z === 0) {
      mapgenWater(dat, base);
      return 'builtin:water';
    }
    // genVersion 3 lake columns: BN's lake_shore builtin below z0 (lakes.ts).
    if (dat.oter.type === 'lake_underwater_shore') {
      mapgenLakeUnderwaterShore(dat, base, LAKE_DEPTH);
      return 'builtin:lake_shore';
    }
    // BN C++/Lua builtins (field, road_*, parking_lot, rock, the Lua lab...).
    const builtin = this.wg.mapgen.builtin?.[mapgenId] ?? def?.builtin;
    if (builtin) {
      if (builtin === 'lua:lab' || builtin === 'lua:lab_ice') {
        mapgenLab({ runner: this.runner, terrains: defs }, dat, levels);
        return `builtin:${builtin}`;
      }
      if (builtin === 'forest' && biomeFor(this.wg.overmap.region, dat.oter.type)) {
        mapgenForest(dat, base, this.wg.overmap.region, (ref, rng) => expandItemGroup(this.game, ref as any, rng));
        return 'builtin:forest';
      }
      if (runBnBuiltin(builtin, this.builtinEnv, dat, base)) {
        if (builtin.startsWith('sewer_') || builtin.startsWith('subway_')) this.finishTransport(builtin, dat, levels);
        return `builtin:${builtin}`;
      }
      this.stats.unsupportedFeature(`builtin mapgen ${builtin}`);
    }
    if (def?.uniform) {
      base.ter.fill(def.uniform);
      return 'uniform';
    }
    if (biomeFor(this.wg.overmap.region, dat.oter.type)) {
      mapgenForest(dat, base, this.wg.overmap.region, (ref, rng) => expandItemGroup(this.game, ref as any, rng));
      return 'builtin:forest';
    }
    if (dat.z === 0) {
      this.stats.unsupportedFeature(`no mapgen for oter ${mapgenId}`);
      base.ter.fill('t_region_groundcover');
      return 'fallback';
    }
    return 'fallback';
  }

  /**
   * After the sewer/subway builtins: BN mapgen.cpp generate() rolls the oter's region map extra
   * (every sewer gets an mx_sewer_* layout), and a sewer under a manhole gets its ladder.
   */
  private finishTransport(builtin: string, dat: MapgenDat, levels: Levels): void {
    const def = this.wg.overmap.terrains[dat.oter.type];
    if (def?.extras) this.applyMapExtra(def.extras, dat, levels);
    if (builtin.startsWith('sewer_') && dat.omtAt(0, 0, 1).type === 'road_nesw_manhole') {
      const base = levels.get(0)!;
      const [x, y] = manholeSpot(this.seed, dat.omx, dat.omy);
      addManholeLadder(this.builtinEnv, dat, base, x, y, (i) => this.tilePassable(base, i));
    }
  }

  /** Terrain and furniture at buffer tile i both let a creature through (unknown ids don't). */
  private tilePassable(buf: MapBuffer, i: number): boolean {
    const m = this.map;
    if (!m) throw new Error('tilePassable before the generator has a map');
    const t = m.terrain.tryIndex(this.terMigration.get(buf.ter[i])?.ter ?? buf.ter[i]);
    if (t === undefined || m.terrain.get(t).move_cost <= 0) return false;
    if (!buf.furn[i]) return true;
    const f = m.furniture.tryIndex(this.furnMigration.get(buf.furn[i]) ?? buf.furn[i]);
    return f !== undefined && m.furniture.get(f).move_cost_mod >= 0;
  }

  /**
   * BN map extras for region key `key` (mapgen.cpp generate(): one_in(chance), then a weighted
   * pick, applied like an update_mapgen: rotated back by the oter id's _north/_east/... suffix,
   * which for linear ids only end pieces have). Own RNG stream so the base mapgen is unchanged.
   */
  private applyMapExtra(key: string, dat: MapgenDat, levels: Levels): void {
    const table = this.wg.mapgen.extras?.[key];
    if (!table) {
      this.stats.unsupportedFeature(`map_extras ${key}`);
      return;
    }
    const rng = new Rng(hashSeed(this.seed, dat.omx, dat.omy, dat.z, hashString(`mx:${key}`)));
    if (!(table.chance > 0 && rng.oneIn(table.chance))) return;
    const pick = weightedPick(rng, table.values.map((v) => [v, v.w] as const));
    if (!pick) throw new Error(`map_extras ${key}: empty table`);
    if (pick.o === undefined) {
      // C++ generators run on the unrotated base buffer, like BN's mapgen_constructor. Gated so
      // a genVersion 1/2 world's untouched (regenerated) chunks come out as they did before.
      const fn = pick.fn !== undefined && this.genVersion >= 3 ? MAP_EXTRA_FUNCTIONS[pick.fn] : undefined;
      if (fn) fn(this.mapExtraEnv, levels.get(0)!, rng);
      else this.stats.unsupportedFeature(`map_extra_function ${pick.fn ?? pick.id}`);
      return;
    }
    const id = oterId(dat.oter, this.wg.overmap.terrains);
    const rot = Math.max(0, DIR_SUFFIX.findIndex((sfx) => id.endsWith(sfx)));
    const compiled = { ...this.runner.compiler.build(this.wg.mapgen.objects[pick.o], 0, 0, false), fillTer: undefined, predecessor: undefined, fallbackPredecessor: undefined };
    this.runner.runTop(compiled, { ...dat, rng, rotation: rot, params: new ParamCtx(dat.params.stores, new Map(), rng) }, levels);
  }

  /**
   * BN mapbuffer post-pass: every open-air tile above terrain that declares a roof (ter_t::roof)
   * becomes that roof: tree canopies over trees, roofs over buildings that lack a JSON roof
   * level (or leave holes in it). DDA limits this to TREE/INDOORS/WALL terrain in open_air OMTs.
   */
  private addRoofs(map: GameMap, c: Chunk, buf: MapBuffer): void {
    const below = map.chunk(c.cx, c.cy, c.z - 1);
    if (!below) return;
    for (let i = 0; i < OMT * OMT; i++) {
      if (buf.ter[i] !== 't_open_air') continue;
      const t = map.terrain.get(below.ter[i]);
      const r = t.roof;
      if (!r) continue;
      if (this.terrainFlags(r) !== undefined) buf.ter[i] = r;
    }
  }

  private writeChunk(map: GameMap, c: Chunk, b: MapBuffer): void {
    const air = map.terrain.index('t_open_air');
    let empty = true;
    for (let i = 0; i < OMT * OMT; i++) {
      const mt = this.terMigration.get(b.ter[i]);
      if (mt) {
        b.ter[i] = mt.ter;
        if (mt.furn && !b.furn[i]) b.furn[i] = mt.furn;
      }
      const mf = this.furnMigration.get(b.furn[i]);
      if (mf) b.furn[i] = mf;
      // map::furn_set: "f_clear" means "remove the furniture" (update_mapgen uses it a lot)
      if (b.furn[i] === 'f_clear') b.furn[i] = '';
      let t = map.terrain.tryIndex(b.ter[i] || 't_open_air');
      if (t === undefined) {
        this.stats.unknownId('terrain', b.ter[i], 'chunk write');
        t = map.terrain.tryIndex(c.z > 0 ? 't_open_air' : 't_dirt') ?? 0;
      }
      c.ter[i] = t;
      if (t !== air && t !== 0) empty = false;
      const f = b.furn[i] ? map.furniture.tryIndex(b.furn[i]) : 0;
      if (f === undefined) this.stats.unknownId('furniture', b.furn[i], 'chunk write');
      c.furn[i] = f ?? 0;
    }
    c.items.clear();
    const rate = map.itemSpawnRate;
    for (const [k, v] of b.items) {
      const out: MapItem[] = [];
      const rrng = rate !== 1 ? new Rng(hashSeed(map.seed, c.cx, c.cy, c.z, k, 0x17e5)) : null;
      for (const sp of v) {
        // Items already committed to the chunk (see readChunk) pass through untouched.
        if (sp.existing) out.push(sp.existing as MapItem);
        else {
          // ITEM_SPAWNRATE: whole spawns (a stack, a filled container) come or go, never split.
          const n = rrng ? Math.floor(rate) + (rrng.next() < rate - Math.floor(rate) ? 1 : 0) : 1;
          for (let i = 0; i < n; i++) {
            if (map.itemFactory) out.push(...map.itemFactory(sp));
            else out.push(sp);
          }
        }
      }
      if (out.length) c.items.set(k, out);
    }
    c.fields.clear();
    for (const [k, v] of b.fields) c.fields.set(k, v);
    c.traps.clear();
    for (const [k, v] of b.traps) c.traps.set(k, v);
    for (const [src, dst] of [[b.signs, c.signs], [b.graffiti, c.graffiti], [b.radiation, c.radiation], [b.computers, c.computers]] as const) {
      (dst as Map<number, unknown>).clear();
      for (const [k, v] of src as Map<number, unknown>) (dst as Map<number, unknown>).set(k, v);
    }
    const X = c.cx * CHUNK, Y = c.cy * CHUNK;
    c.spawns = b.spawns.map((s) => ({
      kind: s.kind, id: s.id, x: X + s.x, y: Y + s.y, z: c.z,
      ...(s.x2 !== undefined && s.y2 !== undefined && (s.x2 !== s.x || s.y2 !== s.y) ? { area: [X + s.x, Y + s.y, X + s.x2, Y + s.y2] as [number, number, number, number] } : {}),
      ...(s.density !== undefined ? { density: s.density } : {}),
      ...(s.chance !== undefined ? { chance: s.chance } : {}),
      ...(s.count !== undefined && s.count !== 1 ? { count: s.count } : {}),
      ...(s.name ? { name: s.name } : {}),
      ...(s.friendly ? { friendly: true } : {}),
      ...(s.individual ? { individual: true } : {}),
    }));
    c.vehicles = b.vehicles.map((v) => ({ ...v, x: X + v.x, y: Y + v.y, z: c.z }));
    c.zones = b.zones.map((z) => ({ type: z.type, faction: z.faction, x0: X + z.x0, y0: Y + z.y0, x1: X + z.x1, y1: Y + z.y1, z: c.z }));
    c.npcSpawns = b.npcs.map((n) => ({ ...n, x: X + n.x, y: Y + n.y, z: c.z }));
    c.empty = empty && c.items.size === 0;
    c.version++;
  }

  /** Inverse of writeChunk (for applying late overlays onto an existing chunk). */
  private readChunk(map: GameMap, c: Chunk): MapBuffer {
    const b = new MapBuffer();
    for (let i = 0; i < OMT * OMT; i++) {
      b.ter[i] = map.terrain.get(c.ter[i]).id;
      b.furn[i] = c.furn[i] ? map.furniture.get(c.furn[i]).id : '';
    }
    for (const [k, v] of c.items) b.items.set(k, v.map((it) => ({ typeId: it.typeId, existing: it })));
    for (const [k, v] of c.fields) b.fields.set(k, v);
    for (const [k, v] of c.traps) b.traps.set(k, v);
    for (const [k, v] of c.signs) b.signs.set(k, v);
    for (const [k, v] of c.graffiti) b.graffiti.set(k, v);
    for (const [k, v] of c.computers) b.computers.set(k, v);
    for (const [k, v] of c.radiation) b.radiation.set(k, v);
    const X = c.cx * CHUNK, Y = c.cy * CHUNK;
    b.spawns = c.spawns.map((s) => ({ ...s, x: s.x - X, y: s.y - Y, x2: s.area ? s.area[2] - X : undefined, y2: s.area ? s.area[3] - Y : undefined }));
    b.vehicles = c.vehicles.map((v) => ({ ...v, x: v.x - X, y: v.y - Y }));
    b.zones = c.zones.map((z) => ({ ...z, x0: z.x0 - X, y0: z.y0 - Y, x1: z.x1 - X, y1: z.y1 - Y }));
    b.npcs = c.npcSpawns.map((n) => ({ template: n.template, x: n.x - X, y: n.y - Y, uniqueId: n.uniqueId, target: n.target, addTrait: n.addTrait }));
    return b;
  }

  // ------------------------------------------------------------------------------------
  // Start location & debug helpers

  /**
   * The default (evacuee) scenario starts in an evac shelter. BN's sloc_shelter picks a
   * shelter OMT and a free indoor tile in it; DDA's shelter has a ZONE_START_POINT and a
   * "shelter_palette" parameter (sloc_shelter_safe), used when present.
   */
  findStartLocation(kind: 'shelter' = 'shelter', map?: GameMap): StartLocation {
    const m = map ?? this.map;
    if (!m) throw new Error('findStartLocation needs the GameMap (call after map.generator is set)');
    const defId = kind === 'shelter' ? 'Evac Shelter' : kind;
    const sp: SpecialInstance | undefined = this.overmap.findSpecial(defId, { x: 0, y: 0 });
    if (!sp) throw new Error(`no ${defId} found near origin`);
    if (!sp.args.has('shelter_palette')) sp.args.set('shelter_palette', 'shelter_basic');
    const c = m.chunk(sp.x, sp.y, 0)!;
    const zone = c.zones.find((z) => z.type === 'ZONE_START_POINT');
    const cand: [number, number][] = [];
    const x0 = zone ? zone.x0 : sp.x * CHUNK + 6, x1 = zone ? zone.x1 : sp.x * CHUNK + 17;
    const y0 = zone ? zone.y0 : sp.y * CHUNK + 6, y1 = zone ? zone.y1 : sp.y * CHUNK + 17;
    // BN floors carry no INDOORS flag: a tile is indoors when something covers it (its roof).
    const indoors = (x: number, y: number) => hasFlag(m.terAt(x, y, 0), 'INDOORS') || m.hasFloor(x, y, 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (m.passable(x, y, 0) && m.furnAt(x, y, 0).id === 'f_null' && indoors(x, y)) cand.push([x, y]);
    if (!cand.length) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (m.passable(x, y, 0) && m.furnAt(x, y, 0).id === 'f_null') cand.push([x, y]);
    if (!cand.length) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (m.passable(x, y, 0)) cand.push([x, y]);
    if (!cand.length) throw new Error('evac shelter start zone has no passable tile');
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    cand.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    return { x: cand[0][0], y: cand[0][1], z: 0, special: defId, omx: sp.x, omy: sp.y };
  }

  /** ASCII rows for a chunk: furniture symbol over terrain symbol, like CDDA's map view. */
  dumpChunk(map: GameMap, cx: number, cy: number, z: number): string {
    const c = map.chunk(cx, cy, z);
    if (!c) return '';
    const rows: string[] = [];
    for (let y = 0; y < CHUNK; y++) {
      let row = '';
      for (let x = 0; x < CHUNK; x++) {
        const i = y * CHUNK + x;
        const f = c.furn[i] ? map.furniture.get(c.furn[i]) : undefined;
        const t = map.terrain.get(c.ter[i]);
        row += (f?.symbol ?? t.symbol ?? '?').slice(0, 1) || ' ';
      }
      rows.push(row);
    }
    return rows.join('\n');
  }
}

/** Copy written cells of an overlay ('' = untouched) onto a buffer. */
function applyOverlay(dst: MapBuffer, ov: MapBuffer): void {
  for (let i = 0; i < OMT * OMT; i++) {
    if (ov.ter[i]) dst.ter[i] = ov.ter[i];
    if (ov.furn[i]) dst.furn[i] = ov.furn[i];
  }
  for (const [k, v] of ov.items) for (const it of v) dst.addItem(k, it);
  for (const [k, v] of ov.fields) for (const f of v) dst.addField(k, f.type, f.intensity, f.age);
  for (const [k, v] of ov.traps) dst.traps.set(k, v);
  for (const [k, v] of ov.signs) dst.signs.set(k, v);
  for (const [k, v] of ov.graffiti) dst.graffiti.set(k, v);
  for (const [k, v] of ov.computers) dst.computers.set(k, v);
  dst.spawns.push(...ov.spawns);
  dst.vehicles.push(...ov.vehicles);
  dst.zones.push(...ov.zones);
  dst.npcs.push(...ov.npcs);
}
