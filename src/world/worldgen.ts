import { Rng, hashSeed } from '../core/rng';
import type { GameData } from '../data/types';
import { expandItemGroup } from '../data/itemgroups';
import { CHUNK } from './coords';
import type { Chunk, ChunkGenerator, GameMap } from './map';
import { hasFlag } from './registry';
import type { WorldgenData } from './worldgen_data';
import { MapBuffer, OMT } from './mapgen/buffer';
import { mapgenForest, mapgenWater, biomeFor, isWaterType, resolveRegional } from './mapgen/builtin';
import { Levels, MapgenDat, MapgenEnv, MapgenRunner } from './mapgen/jsonmapgen';
import { GenStats } from './mapgen/stats';
import { ArgStores, ParamCtx } from './mapgen/values';
import { OmtInfo, Overmap, SpecialInstance } from './overmap/overmap';
import { mapgenIdOf, oterRotation } from './overmap/oter';

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

  constructor(readonly seed: number, readonly wg: WorldgenData, readonly game: GameData) {
    this.overmap = new Overmap(seed, wg.overmap);
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
      furnitureBashTo: (id) => {
        const m = this.map;
        const n = m?.furniture.tryIndex(id);
        if (!m || n === undefined) return undefined;
        const f = m.furniture.get(n).bash?.furn_set;
        return f === undefined ? '' : f === 'f_null' ? '' : f;
      },
      expandItems: (ref, rng) => expandItemGroup(this.game, ref as any, rng),
      runPredecessor: (type, dat, levels) => {
        const ref = { type, rot: 0, line: -1 };
        const sub: MapgenDat = { ...dat, oter: ref, rotation: 0, adjRotation: 0 };
        this.generateInto(sub, levels);
      },
    };
    this.runner = new MapgenRunner(env);
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
    if (c.z > 0 && omt.type === 'open_air') this.addRoofs(map, c, base);

    this.writeChunk(map, c, base);
    c.omt = { id: omt.id, source };
    this.addOterSpawns(c, omt);

    for (const [dz, b] of levels) {
      if (dz === 0) continue;
      const tz = c.z + dz;
      if (map.hasChunk(c.cx, c.cy, tz)) {
        const target = map.chunk(c.cx, c.cy, tz)!;
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
   * Put roofs over terrain that declares one (CDDA ter_t::roof) when this OMT is plain open
   * air: tree canopies over trees (map::add_tree_tops) and roofs over buildings that lack a
   * JSON roof level.
   */
  private addRoofs(map: GameMap, c: Chunk, buf: MapBuffer): void {
    const below = map.chunk(c.cx, c.cy, c.z - 1);
    if (!below) return;
    for (let i = 0; i < OMT * OMT; i++) {
      if (buf.ter[i] !== 't_open_air') continue;
      const t = map.terrain.get(below.ter[i]);
      const r = t.roof;
      if (!r) continue;
      if (!hasFlag(t, 'TREE') && !hasFlag(t, 'INDOORS') && !hasFlag(t, 'WALL')) continue;
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
    for (const [k, v] of b.items) c.items.set(k, v);
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
    }));
    c.vehicles = b.vehicles.map((v) => ({ ...v, x: X + v.x, y: Y + v.y, z: c.z }));
    c.zones = b.zones.map((z) => ({ type: z.type, faction: z.faction, x0: X + z.x0, y0: Y + z.y0, x1: X + z.x1, y1: Y + z.y1, z: c.z }));
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
    for (const [k, v] of c.items) b.items.set(k, v);
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
    return b;
  }

  // ------------------------------------------------------------------------------------
  // Start location & debug helpers

  /**
   * CDDA's default scenario starts in an evac shelter ("sloc_shelter_safe" forces the
   * shelter_basic palette). Returns a passable tile inside the shelter's ZONE_START_POINT.
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
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (m.passable(x, y, 0) && m.furnAt(x, y, 0).id === 'f_null') cand.push([x, y]);
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
}
