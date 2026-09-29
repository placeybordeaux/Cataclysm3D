import { Rng, hashString } from '../../core/rng';
import type { ItemSpawn } from '../map';
import type { OterDef, WorldgenData } from '../worldgen_data';
import { MapBuffer, OMT } from './buffer';
import type { GenStats } from './stats';
import { evalValue, intR, IntR, ParamCtx, ParamDef, parseWeighted, rollR, Scope, weightedPick } from './values';
import { MatchType, OmtRef, otMatch, rotateOffset } from '../overmap/oter';
import type { SpawnedItem } from '../../data/itemgroups';

// Interpreter for CDDA's "json" mapgen method (src/mapgen.cpp mapgen_function_json /
// jmapgen_* pieces). A mapgen object is compiled once into per-symbol piece lists (palettes
// merged in the same order CDDA's mapgen_palette::add uses) plus positioned objects, then
// applied in CDDA's phases: removal, terrain, furniture, default, nested, transform,
// faction ownership, zones.

const enum Phase { Removal, Terrain, Furniture, Default, Nested, Transform, Faction, Zones }

/** Mapping keys (usable in "terrain"-style symbol tables, palettes and "mapping"). */
const SYMBOL_KINDS = [
  'terrain', 'furniture', 'fields', 'npcs', 'signs', 'vendingmachines', 'toilets', 'gaspumps', 'items',
  'monsters', 'vehicles', 'item', 'remove_vehicles', 'remove_all', 'traps', 'monster', 'rubble', 'computers',
  'sealed_item', 'nested', 'liquids', 'corpses', 'graffiti', 'zones', 'ter_furn_transforms',
] as const;
/** Positioned-object keys -> the piece kind they create. */
const PLACE_KINDS: Record<string, string> = {
  place_remove_all: 'remove_all', place_item: 'item', place_fields: 'fields', place_npcs: 'npcs',
  place_signs: 'signs', place_vendingmachines: 'vendingmachines', place_toilets: 'toilets',
  place_liquids: 'liquids', place_corpses: 'corpses', place_gaspumps: 'gaspumps', place_items: 'items',
  place_loot: 'loot', place_monsters: 'monsters', place_vehicles: 'vehicles', remove_vehicles: 'remove_vehicles',
  remove_npcs: 'remove_npcs', place_traps: 'traps', place_furniture: 'furniture', place_terrain: 'terrain',
  place_monster: 'monster', place_rubble: 'rubble', place_computers: 'computers', place_nested: 'nested',
  place_graffiti: 'graffiti', place_zones: 'zones', place_ter_furn_transforms: 'ter_furn_transforms',
  place_variables: 'variables', faction_owner: 'faction_owner',
};
/** Keys we understand structurally (not pieces). Anything else in an object is "unsupported". */
const STRUCTURAL = new Set([
  'rows', 'palettes', 'mapgensize', 'fill_ter', 'flags', 'rotation', 'parameters', 'set', 'mapping',
  'predecessor_mapgen', 'fallback_predecessor_mapgen', 'id', 'type',
]);

function phaseOf(kind: string): Phase {
  switch (kind) {
    case 'terrain': return Phase.Terrain;
    case 'furniture': case 'toilets': return Phase.Furniture;
    case 'nested': return Phase.Nested;
    case 'ter_furn_transforms': return Phase.Transform;
    case 'faction_owner': return Phase.Faction;
    case 'zones': case 'variables': return Phase.Zones;
    case 'remove_all': case 'remove_vehicles': case 'remove_npcs': return Phase.Removal;
    default: return Phase.Default;
  }
}

interface Piece {
  kind: string;
  phase: Phase;
  /** terrain/furniture/traps: weighted alternatives of mapgen values */
  alts?: [unknown, number][];
  data?: any;
  /** [param name, required value] pairs from parameterized palette choices */
  constraints?: [string, string][];
}

interface Placed {
  piece: Piece;
  x: IntR;
  y: IntR;
  z: number;
  repeat: IntR;
}

interface SetOp {
  phase: Phase;
  shape: 'point' | 'line' | 'square';
  what: string;
  id?: string;
  amount?: IntR;
  x: IntR; y: IntR; x2: IntR; y2: IntR;
  z: number;
  chance: number;
  repeat: IntR;
}

export interface Compiled {
  size: number;
  /** per cell (y * size + x): pieces for that cell's symbol, or null */
  cells: (Piece[] | null)[];
  objects: Placed[];
  setmaps: SetOp[];
  params: Map<string, ParamDef>;
  fillTer?: unknown;
  rotation?: IntR;
  predecessor?: string;
  fallbackPredecessor?: string;
  flags: Set<string>;
}

/** Everything the interpreter needs from the rest of the game, per world. */
export interface MapgenEnv {
  seed: number;
  data: WorldgenData;
  stats: GenStats;
  /** undefined = unknown terrain id */
  terrainFlags(id: string): readonly string[] | undefined;
  furnitureKnown(id: string): boolean;
  furnitureFlags(id: string): readonly string[] | undefined;
  /** CDDA ter_furn_transform definition by id (misc.ter_furn_transform) */
  terFurnTransform(id: string): any;
  /** furniture id that bashing `id` leaves behind ('' = nothing), for ransacked vending machines */
  furnitureBashTo(id: string): string | undefined;
  /** terrain id that bashing `id` leaves behind (undefined = unbashable) */
  terrainBashTo(id: string): string | undefined;
  expandItems(ref: unknown, rng: Rng): SpawnedItem[];
  /** CDDA snippet category -> texts (misc.snippet) */
  snippets(category: string): readonly unknown[] | undefined;
  /** Run another OMT type's mapgen into `levels` (predecessor_mapgen support). */
  runPredecessor(type: string, dat: MapgenDat, levels: Levels): void;
}

/** CDDA mapgendata: context for generating one OMT. */
export interface MapgenDat {
  env: MapgenEnv;
  omx: number;
  omy: number;
  z: number;
  oter: OmtRef;
  /** oter rotation applied to the generated map (CDDA oter_t::get_rotation) */
  rotation: number;
  /** rotation for neighbour lookups (0 with IGNORE_ROTATION_FOR_ADJACENCY) */
  adjRotation: number;
  /** oter at world OMT offset (dx, dy, dz) from this one */
  omtAt(dx: number, dy: number, dz: number): OmtRef;
  /** terrains this OMT replaced, innermost last (for fallback_predecessor_mapgen) */
  predecessors: string[];
  params: ParamCtx;
  rng: Rng;
  cityName: string;
  names: { given: string[]; family: string[] };
}

/** z offset -> buffer. Level 0 is the OMT being generated; others are overlays. */
export type Levels = Map<number, MapBuffer>;

const NEIGHBOR_DIRS: Record<string, [number, number, number]> = {
  north: [0, -1, 0], east: [1, 0, 0], south: [0, 1, 0], west: [-1, 0, 0],
  north_east: [1, -1, 0], south_east: [1, 1, 0], south_west: [-1, 1, 0], north_west: [-1, -1, 0],
  above: [0, 0, 1], below: [0, 0, -1],
};

// ---------------------------------------------------------------------------------------
// Compilation

export class MapgenCompiler {
  private cache = new Map<string, Compiled>();
  constructor(private data: WorldgenData, private stats: GenStats) {}

  compile(objIndex: number, ox = 0, oy = 0, nested = false): Compiled {
    const key = `${objIndex}:${ox}:${oy}`;
    let c = this.cache.get(key);
    if (!c) {
      c = this.build(this.data.mapgen.objects[objIndex], ox, oy, nested);
      this.cache.set(key, c);
    }
    return c;
  }

  /** Compile an arbitrary object (tests, or objects not in the data file). */
  build(obj: any, ox: number, oy: number, nested: boolean): Compiled {
    const size = nested && Array.isArray(obj.mapgensize) ? obj.mapgensize[0] : OMT;
    const params = new Map<string, ParamDef>();
    const symbols = new Map<string, Piece[]>();
    this.addPalette(obj, [], params, params, symbols, new Set());

    for (const k of Object.keys(obj)) {
      if (!STRUCTURAL.has(k) && !PLACE_KINDS[k] && !(SYMBOL_KINDS as readonly string[]).includes(k)) {
        this.stats.unsupportedFeature(k);
      }
    }

    const cells: (Piece[] | null)[] = new Array(size * size).fill(null);
    if (Array.isArray(obj.rows)) {
      for (let y = 0; y < size; y++) {
        const row = obj.rows[y + oy];
        if (typeof row !== 'string') continue;
        const chars = Array.from(row);
        for (let x = 0; x < size; x++) {
          const ch = chars[x + ox];
          if (ch === undefined) continue;
          const pieces = symbols.get(ch);
          if (pieces && pieces.length) cells[y * size + x] = pieces;
          // symbols defined only as t_null/f_null are legitimate "leave as is" markers
          else if (!pieces && ch !== ' ' && ch !== '.') this.stats.unknownId('symbol', ch);
        }
      }
    }

    const inBounds = (x: IntR, y: IntR) => x.a >= 0 && y.a >= 0 && x.a < size && y.a < size;
    const objects: Placed[] = [];
    for (const [key, kind] of Object.entries(PLACE_KINDS)) {
      const list = obj[key];
      if (!Array.isArray(list)) continue;
      for (const e of list) {
        const x = shift(intR(e.x, 0), -ox), y = shift(intR(e.y, 0), -oy);
        if (!inBounds(x, y)) continue;
        const piece = this.makePiece(kind, kind === 'terrain' ? e.ter : kind === 'furniture' ? e.furn : kind === 'traps' ? e.trap : e, true);
        if (!piece) continue;
        objects.push({ piece, x, y, z: typeof e.z === 'number' ? e.z : 0, repeat: intR(e.repeat, 1) });
      }
    }
    objects.sort((a, b) => a.piece.phase - b.piece.phase);

    const setmaps: SetOp[] = [];
    if (Array.isArray(obj.set)) {
      for (const e of obj.set) {
        const shape = e.point !== undefined ? 'point' : e.line !== undefined ? 'line' : e.square !== undefined ? 'square' : undefined;
        if (!shape) continue;
        const what: string = e[shape];
        const x = shift(intR(e.x, 0), -ox), y = shift(intR(e.y, 0), -oy);
        if (!inBounds(x, y)) continue;
        setmaps.push({
          phase: what === 'terrain' ? Phase.Terrain : what === 'furniture' ? Phase.Furniture : Phase.Default,
          shape, what, id: e.id, amount: e.amount !== undefined ? intR(e.amount, 0) : undefined,
          x, y, x2: shift(intR(e.x2 ?? e.x, 0), -ox), y2: shift(intR(e.y2 ?? e.y, 0), -oy),
          z: typeof e.z === 'number' ? e.z : 0, chance: typeof e.chance === 'number' ? e.chance : 1, repeat: intR(e.repeat, 1),
        });
      }
      setmaps.sort((a, b) => a.phase - b.phase);
    }

    return {
      size, cells, objects, setmaps, params,
      fillTer: nested ? undefined : obj.fill_ter,
      rotation: obj.rotation !== undefined ? intR(obj.rotation, 0) : undefined,
      predecessor: obj.predecessor_mapgen,
      fallbackPredecessor: obj.fallback_predecessor_mapgen,
      flags: new Set(Array.isArray(obj.flags) ? obj.flags : []),
    };
  }

  /**
   * CDDA mapgen_palette::add: recurse into referenced palettes first, then append this
   * palette's own symbol placings. Parameterized palette ids expand to every possible
   * palette with a constraint on the parameter's value.
   */
  private addPalette(
    pal: any, constraints: [string, string][], topParams: Map<string, ParamDef>,
    _params: Map<string, ParamDef>, symbols: Map<string, Piece[]>, ancestors: Set<string>,
  ): void {
    const own = new Map<string, ParamDef>();
    for (const [name, p] of Object.entries<any>(pal.parameters ?? {})) {
      const def: ParamDef = { type: p.type, scope: (p.scope ?? 'overmap_special') as Scope, default: p.default };
      own.set(name, def);
      if (!topParams.has(name)) topParams.set(name, def);
    }
    // Only definitions are needed to enumerate possible palette ids; no rolling happens here.
    const probe = new ParamCtx(
      { seed: 0, specialKey: 0, special: new Map(), stackKey: 0, stack: new Map(), omtKey: 0, omt: new Map() },
      new Map([...topParams, ...own]), new Rng(1),
    );
    for (const ref of Array.isArray(pal.palettes) ? pal.palettes : []) {
      const possible = probe.possible(ref);
      if (possible.length === 0) {
        this.stats.unknownId('palette ref', JSON.stringify(ref));
        continue;
      }
      let paramName: string | undefined;
      if (possible.length > 1) {
        if (ref && typeof ref === 'object' && 'param' in ref) paramName = ref.param;
        else {
          // CDDA adds a hidden overmap_special-scoped parameter for inline distributions so
          // every OMT of a special picks the same palette.
          paramName = `palette_choice_${hashString(JSON.stringify(ref))}`;
          if (!topParams.has(paramName)) topParams.set(paramName, { scope: 'overmap_special', default: ref });
        }
      }
      for (const id of possible) {
        const p = this.data.palettes[id];
        if (!p) {
          this.stats.unknownId('palette', id);
          continue;
        }
        if (ancestors.has(id)) continue;
        const next = new Set(ancestors).add(id);
        const cons: [string, string][] = paramName ? [...constraints, [paramName, id]] : constraints;
        this.addPalette(p, cons, topParams, _params, symbols, next);
      }
    }
    for (const kind of SYMBOL_KINDS) {
      const table = pal[kind];
      if (table && typeof table === 'object' && !Array.isArray(table)) {
        for (const [sym, v] of Object.entries(table)) this.addSymbol(symbols, sym, kind, v, constraints);
      }
    }
    if (pal.mapping && typeof pal.mapping === 'object') {
      for (const [sym, m] of Object.entries<any>(pal.mapping)) {
        for (const kind of SYMBOL_KINDS) if (m[kind] !== undefined) this.addSymbol(symbols, sym, kind, m[kind], constraints);
      }
    }
  }

  private addSymbol(symbols: Map<string, Piece[]>, sym: string, kind: string, v: unknown, constraints: [string, string][]): void {
    let list = symbols.get(sym);
    if (!list) symbols.set(sym, (list = []));
    const alternative = kind === 'terrain' || kind === 'furniture' || kind === 'traps';
    const values = alternative || !Array.isArray(v) ? [v] : v;
    for (const one of values) {
      const p = this.makePiece(kind, one, false);
      if (!p) continue;
      if (constraints.length) p.constraints = constraints;
      list.push(p);
    }
  }

  /** Build a piece. `v` is the mapping value (symbol tables) or the placed object. */
  private makePiece(kind: string, v: any, placed: boolean): Piece | null {
    const phase = phaseOf(kind);
    if (kind === 'terrain' || kind === 'furniture' || kind === 'traps') {
      const key = kind === 'terrain' ? 'ter' : kind === 'furniture' ? 'furn' : 'trap';
      const unwrap = (e: any) => (e && typeof e === 'object' && !Array.isArray(e) && key in e ? e[key] : e);
      let alts: [unknown, number][];
      if (Array.isArray(v) && !placed) {
        alts = v.map((e: any) =>
          Array.isArray(e) ? [unwrap(e[0]), typeof e[1] === 'number' ? e[1] : 1] : [unwrap(e), 1]) as [unknown, number][];
      } else alts = [[unwrap(v), 1]];
      // "t_null"/"f_null" entries are no-ops in CDDA (is_nop); keep them as weighted
      // "nothing" choices only when mixed with real alternatives.
      if (alts.every(([a]) => a === 't_null' || a === 'f_null' || a === 'tr_null')) return null;
      const data = kind === 'traps' && v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
      return { kind, phase, alts, data };
    }
    return { kind, phase, data: v };
  }
}

const shift = (r: IntR, d: number): IntR => (d ? { a: r.a + d, b: r.b + d } : r);

// ---------------------------------------------------------------------------------------
// Application

export class MapgenRunner {
  readonly compiler: MapgenCompiler;
  constructor(readonly env: MapgenEnv) {
    this.compiler = new MapgenCompiler(env.data, env.stats);
  }

  /** Pick a weighted mapgen for a mapgen id and run it. Returns false if none is defined. */
  runOmt(mapgenId: string, dat: MapgenDat, levels: Levels): boolean {
    const refs = this.env.data.mapgen.omt[mapgenId];
    if (!refs || refs.length === 0) return false;
    const ref = weightedPick(dat.rng, refs.map((r) => [r, r.w] as const));
    if (!ref) return false;
    this.runTop(this.compiler.compile(ref.o, ref.ox ?? 0, ref.oy ?? 0), dat, levels);
    return true;
  }

  /** CDDA mapgen_function_json::generate, including the predecessor/rotation dance. */
  runTop(c: Compiled, dat: MapgenDat, levels: Levels): void {
    if (c.predecessor) this.env.runPredecessor(c.predecessor, dat, levels);
    else if (c.fallbackPredecessor) {
      const pred = dat.predecessors.length ? dat.predecessors[dat.predecessors.length - 1] : c.fallbackPredecessor;
      const inner: MapgenDat = { ...dat, predecessors: dat.predecessors.slice(0, -1) };
      this.env.runPredecessor(pred, inner, levels);
    }
    // Rotate backwards first so the predecessor ends up unrotated once we rotate forwards.
    const rot = c.rotation ? rollR(c.rotation, dat.rng) % 4 : 0;
    const total = (rot + dat.rotation) % 4;
    for (const b of levels.values()) b.rotate(4 - total);
    const params = new ParamCtx(dat.params.stores, c.params, dat.rng, dat.params);
    const d: MapgenDat = { ...dat, params };
    if (c.fillTer !== undefined) {
      const t = evalValue(c.fillTer, params, dat.rng);
      if (t && t !== 't_null') {
        if (this.env.terrainFlags(t) === undefined) this.env.stats.unknownId('terrain', t, 'fill_ter');
        else levels.get(0)!.ter.fill(t);
      }
    }
    this.applyPhases(c, d, levels, 0, 0, c.flags);
    for (const b of levels.values()) b.rotate(total);
  }

  private applyPhases(c: Compiled, dat: MapgenDat, levels: Levels, ox: number, oy: number, flags: Set<string>): void {
    const rng = dat.rng;
    let si = 0, oi = 0;
    for (let phase = Phase.Removal; phase <= Phase.Zones; phase++) {
      for (; si < c.setmaps.length && c.setmaps[si].phase === phase; si++) this.applySet(c.setmaps[si], dat, levels, ox, oy);
      for (let i = 0; i < c.cells.length; i++) {
        const pieces = c.cells[i];
        if (!pieces) continue;
        const x = (i % c.size) + ox, y = Math.floor(i / c.size) + oy;
        for (const p of pieces) {
          if (p.phase !== phase) continue;
          this.applyPiece(p, { a: x, b: x }, { a: y, b: y }, 0, dat, levels, flags);
        }
      }
      for (; oi < c.objects.length && c.objects[oi].piece.phase === phase; oi++) {
        const o = c.objects[oi];
        const n = rollR(o.repeat, rng);
        const x = shift(o.x, ox), y = shift(o.y, oy);
        for (let r = 0; r < n; r++) this.applyPiece(o.piece, x, y, o.z, dat, levels, flags);
      }
    }
  }

  private level(levels: Levels, dz: number): MapBuffer {
    let b = levels.get(dz);
    if (!b) levels.set(dz, (b = new MapBuffer()));
    return b;
  }

  private applySet(s: SetOp, dat: MapgenDat, levels: Levels, ox: number, oy: number): void {
    const rng = dat.rng;
    if (s.chance !== 1 && !rng.oneIn(s.chance)) return;
    const buf = this.level(levels, s.z);
    const n = rollR(s.repeat, rng);
    for (let r = 0; r < n; r++) {
      const x1 = rollR(s.x, rng) + ox, y1 = rollR(s.y, rng) + oy;
      const pts: [number, number][] = [];
      if (s.shape === 'point') pts.push([x1, y1]);
      else {
        const x2 = rollR(s.x2, rng) + ox, y2 = rollR(s.y2, rng) + oy;
        if (s.shape === 'square') {
          for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++)
            for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) pts.push([x, y]);
        } else pts.push(...bresenham(x1, y1, x2, y2));
      }
      for (const [x, y] of pts) {
        if (!MapBuffer.inb(x, y)) continue;
        const i = MapBuffer.idx(x, y);
        switch (s.what) {
          case 'terrain':
            if (s.id && this.knownTer(s.id)) buf.ter[i] = s.id;
            break;
          case 'furniture':
            if (s.id && this.knownFurn(s.id)) buf.furn[i] = s.id === 'f_null' ? '' : s.id;
            break;
          case 'trap':
            if (s.id) buf.traps.set(i, s.id);
            break;
          case 'trap_remove':
            buf.traps.delete(i);
            break;
          case 'item_remove':
            buf.items.delete(i);
            break;
          case 'field_remove':
            buf.fields.delete(i);
            break;
          case 'radiation':
            buf.radiation.set(i, s.amount ? rollR(s.amount, rng) : 0);
            break;
          case 'bash': {
            // one guaranteed bash: furniture first, else terrain, per their bash results
            const f = buf.furn[i];
            const fb = f ? this.env.furnitureBashTo(f) : undefined;
            if (f && fb !== undefined) buf.furn[i] = fb;
            else {
              const tb = this.env.terrainBashTo(buf.ter[i]);
              if (tb) buf.ter[i] = tb;
            }
            break;
          }
          case 'variable':
          case 'creature_remove':
            break;
          default:
            this.env.stats.unsupportedFeature(`set:${s.what}`);
        }
      }
    }
  }

  private knownTer(id: string): boolean {
    if (this.env.terrainFlags(id) !== undefined) return true;
    this.env.stats.unknownId('terrain', id);
    return false;
  }
  private knownFurn(id: string): boolean {
    if (id === 'f_null' || this.env.furnitureKnown(id)) return true;
    this.env.stats.unknownId('furniture', id);
    return false;
  }

  private constraintsOk(p: Piece, dat: MapgenDat): boolean {
    if (!p.constraints) return true;
    for (const [name, val] of p.constraints) if (dat.params.get(name) !== val) return false;
    return true;
  }

  private addItems(buf: MapBuffer, i: number, list: SpawnedItem[]): void {
    for (const e of list) {
      const it: ItemSpawn = { typeId: e.id };
      if (e.count !== 1) it.count = e.count;
      if (e.charges !== undefined) it.charges = e.charges;
      if (e.contents?.length) it.contents = e.contents.map((c) => ({ typeId: c.id, count: c.count, charges: c.charges }));
      // Keep the full roll (ammo, variant, nested contents) for the item factory.
      it.spawned = e;
      buf.addItem(i, it);
    }
  }

  private applyPiece(p: Piece, xr: IntR, yr: IntR, dz: number, dat: MapgenDat, levels: Levels, flags: Set<string>): void {
    if (!this.constraintsOk(p, dat)) return;
    const env = this.env, rng = dat.rng, d = p.data;
    const buf = this.level(levels, dz);
    const px = () => rollR(xr, rng), py = () => rollR(yr, rng);
    const at = (): number => {
      const x = px(), y = py();
      return MapBuffer.inb(x, y) ? MapBuffer.idx(x, y) : -1;
    };
    const pickAlt = () => evalValue(weightedPick(rng, p.alts!), dat.params, rng);
    switch (p.kind) {
      case 'terrain': {
        const id = pickAlt();
        if (!id || id === 't_null') return;
        const i = at();
        if (i < 0) return;
        const tf = env.terrainFlags(id);
        if (tf === undefined) return env.stats.unknownId('terrain', id);
        const boringWall = tf.includes('WALL') && !tf.includes('PLACE_ITEM');
        const eraseAll = flags.has('ERASE_ALL_BEFORE_PLACING_TERRAIN');
        if (boringWall || eraseAll || flags.has('ERASE_FURNITURE_BEFORE_PLACING_TERRAIN') || flags.has('DISMANTLE_ALL_BEFORE_PLACING_TERRAIN') || flags.has('DISMANTLE_FURNITURE_BEFORE_PLACING_TERRAIN')) {
          buf.furn[i] = '';
          buf.signs.delete(i);
        }
        if (boringWall || eraseAll || flags.has('ERASE_TRAP_BEFORE_PLACING_TERRAIN')) buf.traps.delete(i);
        if (boringWall || eraseAll || flags.has('ERASE_ITEMS_BEFORE_PLACING_TERRAIN')) buf.items.delete(i);
        buf.graffiti.delete(i);
        buf.ter[i] = id;
        return;
      }
      case 'furniture': {
        const id = pickAlt();
        if (!id || id === 'f_null') return;
        const i = at();
        if (i < 0) return;
        if (flags.has('SKIP_ON_OPEN_AIR') && buf.ter[i] === 't_open_air') return;
        if (!env.furnitureKnown(id)) return env.stats.unknownId('furniture', id);
        buf.furn[i] = id;
        return;
      }
      case 'traps': {
        const id = pickAlt();
        const i = at();
        if (!id || i < 0) return;
        if (d?.remove) buf.traps.delete(i);
        else if (id !== 'tr_null') buf.traps.set(i, id);
        return;
      }
      case 'fields': {
        const id = evalValue(d.field, dat.params, rng);
        const i = at();
        if (!id || i < 0 || id === 'fd_null') return;
        if (!rng.chance(d.chance ?? 100)) return;
        if (d.remove) {
          const l = buf.fields.get(i);
          if (l) buf.fields.set(i, l.filter((f) => f.type !== id));
          return;
        }
        const ints: number[] = Array.isArray(d.intensity) ? d.intensity : [d.intensity ?? d.density ?? 1];
        buf.addField(i, id, rng.pick(ints), d.age ?? 0);
        return;
      }
      case 'signs': {
        const i = at();
        if (i < 0) return;
        const furn = d.furniture ?? 'f_sign';
        if (this.knownFurn(furn)) buf.furn[i] = furn;
        buf.signs.set(i, this.expandText(d.signage ?? (d.snippet ? `<snippet:${d.snippet}>` : ''), dat));
        return;
      }
      case 'graffiti': {
        const i = at();
        if (i < 0) return;
        buf.graffiti.set(i, this.expandText(d.text ?? (d.snippet ? `<snippet:${d.snippet}>` : ''), dat));
        return;
      }
      case 'vendingmachines': {
        const i = at();
        if (i < 0) return;
        const group = d.item_group !== undefined ? evalValue(d.item_group, dat.params, rng) : 'default_vending_machine';
        const furn = d.reinforced ? (d.powered ? 'f_vending_reinforced' : 'f_vending_reinforced_off') : d.powered ? 'f_vending_c' : 'f_vending_c_off';
        buf.furn[i] = this.knownFurn(furn) ? furn : '';
        if (!group) return;
        // CDDA: lootable machines are ransacked unless one_in(days_since_cataclysm + 4).
        if (d.lootable && !rng.oneIn(4)) {
          const broken = env.furnitureBashTo(furn);
          if (broken !== undefined) buf.furn[i] = broken;
          const cx = i % OMT, cy = Math.floor(i / OMT);
          for (let yy = cy - 1; yy <= cy + 1; yy++)
            for (let xx = cx - 1; xx <= cx + 1; xx++)
              if (MapBuffer.inb(xx, yy) && rng.oneIn(4)) buf.addItem(MapBuffer.idx(xx, yy), { typeId: 'glass_shard', count: rng.int(1, 25) });
        } else this.addItems(buf, i, env.expandItems(group, rng));
        return;
      }
      case 'toilets': {
        const i = at();
        if (i < 0) return;
        if (this.knownFurn('f_toilet')) buf.furn[i] = 'f_toilet';
        const amount = rollR(intR(d.amount, 0), rng);
        buf.addItem(i, amount > 0 ? { typeId: 'water', charges: amount } : { typeId: 'water' });
        return;
      }
      case 'gaspumps': {
        const i = at();
        if (i < 0) return;
        let charges = rollR(intR(d.amount, 0), rng) * 100;
        if (charges === 0) charges = rng.int(10000, 50000);
        const fuel = (d.fuel !== undefined ? evalValue(d.fuel, dat.params, rng) : undefined) ?? (rng.oneIn(4) ? 'diesel' : 'gasoline');
        const pump = ({ gasoline: 't_gas_pump', diesel: 't_diesel_pump', jp8: 't_jp8_pump', avgas: 't_avgas_pump' } as Record<string, string>)[fuel] ?? 't_gas_pump';
        buf.furn[i] = '';
        if (this.knownTer(pump)) buf.ter[i] = pump;
        buf.addItem(i, { typeId: fuel, charges });
        return;
      }
      case 'items': {
        // CDDA map::place_items: roll_remainder(chance / 100) spawns, each a fresh group roll.
        const chance = rollR(intR(d.chance, 100), rng);
        const n = roll(Math.min(chance, 100) / 100, rng);
        for (let k = 0; k < n; k++) {
          const i = at();
          if (i >= 0) this.addItems(buf, i, env.expandItems(d.item, rng));
        }
        return;
      }
      case 'loot': {
        if (rng.int(0, 99) >= (d.chance ?? 100)) return;
        const i = at();
        if (i < 0) return;
        if (d.group) this.addItems(buf, i, env.expandItems(d.group, rng));
        else if (d.item) buf.addItem(i, d.variant ? ({ typeId: d.item, variant: d.variant } as ItemSpawn) : { typeId: d.item });
        return;
      }
      case 'item': {
        const id = evalValue(d.item, dat.params, rng);
        if (!id) return;
        const c = rollR(intR(d.chance, 100), rng);
        const count = c === 100 ? 1 : roll(c / 100, rng);
        for (let k = 0; k < count; k++) {
          const i = at();
          if (i < 0) continue;
          const amount = rollR(intR(d.amount, 1), rng);
          buf.addItem(i, amount === 1 ? { typeId: id } : { typeId: id, count: amount });
        }
        return;
      }
      case 'liquids': {
        if (!rng.oneIn(rollR(intR(d.chance, 1), rng))) return;
        const id = evalValue(d.liquid, dat.params, rng);
        const i = at();
        if (!id || i < 0) return;
        const a = intR(d.amount, -1);
        let charges = a.a > -1 ? rollR(a, rng) : undefined;
        if (charges !== undefined && ['gasoline', 'avgas', 'diesel', 'jp8'].includes(id)) charges *= 100;
        buf.addItem(i, charges === undefined ? { typeId: id } : { typeId: id, charges });
        return;
      }
      case 'corpses': {
        const i = at();
        if (i < 0) return;
        buf.addItem(i, { typeId: 'corpse', corpseGroup: d.group, corpseAgeDays: d.age ?? 0 } as ItemSpawn);
        return;
      }
      case 'monsters': {
        const id = evalValue(d.monster, dat.params, rng);
        if (!id || id === 'GROUP_NULL') return;
        const chance = rollR(intR(d.chance, 1), rng);
        if (!rng.oneIn(chance)) return;
        buf.spawns.push({
          kind: 'group', id, x: xr.a, y: yr.a, x2: xr.b, y2: yr.b,
          density: typeof d.density === 'number' && d.density >= 0 ? d.density : undefined,
          chance: chance > 1 ? chance : undefined,
        });
        return;
      }
      case 'monster': {
        const raw = rollR(intR(d.chance, 100), rng);
        if (raw !== 100 && !rng.chance(raw)) return;
        const pack = rollR(intR(d.pack_size, 1), rng);
        const x = px(), y = py();
        if (!MapBuffer.inb(x, y)) return;
        if (d.group !== undefined) {
          const g = evalValue(d.group, dat.params, rng);
          if (g && g !== 'GROUP_NULL') buf.spawns.push({ kind: 'group', id: g, x, y, count: pack, chance: raw !== 100 ? raw : undefined, name: d.name, friendly: d.friendly });
        } else {
          const list = Array.isArray(d.monster) ? parseWeighted(d.monster, 100) : [[d.monster, 100] as [unknown, number]];
          const id = evalValue(weightedPick(rng, list), dat.params, rng);
          if (id && id !== 'mon_null') buf.spawns.push({ kind: 'monster', id, x, y, count: pack, chance: raw !== 100 ? raw : undefined, name: d.name, friendly: d.friendly });
        }
        return;
      }
      case 'vehicles': {
        const id = evalValue(d.vehicle, dat.params, rng);
        const chance = typeof d.chance === 'number' ? d.chance : 100;
        if (!id || !rng.chance(chance)) return;
        const rot = Array.isArray(d.rotation) ? rng.pick(d.rotation as number[]) : d.rotation;
        buf.vehicles.push({ id, x: px(), y: py(), rotation: rot, status: d.status, fuel: d.fuel });
        return;
      }
      case 'remove_all': {
        const i = at();
        if (i >= 0) buf.clearTile(i);
        return;
      }
      case 'rubble': {
        const i = at();
        if (i < 0) return;
        const rub = (d.rubble_type !== undefined ? evalValue(d.rubble_type, dat.params, rng) : 'f_rubble') ?? 'f_rubble';
        const floor = (d.floor_type !== undefined ? evalValue(d.floor_type, dat.params, rng) : 't_dirt') ?? 't_dirt';
        const tf = env.terrainFlags(buf.ter[i]);
        if (d.overwrite || !tf || tf.includes('WALL')) if (this.knownTer(floor)) buf.ter[i] = floor;
        if (this.knownFurn(rub)) buf.furn[i] = rub;
        return;
      }
      case 'computers': {
        const i = at();
        if (i < 0) return;
        if (this.knownFurn('f_console')) buf.furn[i] = 'f_console';
        buf.computers.set(i, d);
        return;
      }
      case 'sealed_item': {
        const c = rollR(intR(d.chance, 100), rng);
        if (c !== 100 && !rng.chance(c)) return;
        const i = at();
        if (i < 0) return;
        buf.furn[i] = '';
        if (d.item) {
          const id = evalValue(d.item.item, dat.params, rng);
          if (id) buf.addItem(i, { typeId: id });
        }
        if (d.items) this.addItems(buf, i, env.expandItems(d.items.item, rng));
        const f = evalValue(d.furniture, dat.params, rng);
        if (f && this.knownFurn(f)) buf.furn[i] = f;
        return;
      }
      case 'nested':
        return this.applyNested(d, xr, yr, dz, dat, levels);
      case 'zones': {
        const type = evalValue(d.type, dat.params, rng);
        if (!type) return;
        const faction = d.faction !== undefined ? evalValue(d.faction, dat.params, rng) : undefined;
        buf.zones.push({ type, faction, x0: xr.a, y0: yr.a, x1: xr.b, y1: yr.b });
        return;
      }
      case 'ter_furn_transforms': {
        const id = evalValue(d.transform, dat.params, rng);
        if (!id) return;
        const tf = env.terFurnTransform(id);
        if (!tf) return env.stats.unknownId('ter_furn_transform', id);
        // CDDA applies the transform to every tile of the x/y range
        for (let y = yr.a; y <= yr.b; y++)
          for (let x = xr.a; x <= xr.b; x++) if (MapBuffer.inb(x, y)) this.transformTile(tf, buf, MapBuffer.idx(x, y), rng);
        return;
      }
      case 'variables':
        return;
      default:
        env.stats.unsupportedFeature(p.kind);
    }
  }

  /** One ter_furn_transform on one tile: terrain, furniture, trap and field rules independently. */
  private transformTile(tf: any, buf: MapBuffer, i: number, rng: Rng): void {
    const env = this.env;
    const pick = (rules: any[] | undefined, cur: string, flags: readonly string[] | undefined, validKey: string): string | undefined => {
      for (const r of rules ?? []) {
        const valid = (r[validKey] as string[] | undefined)?.includes(cur) || (r.valid_flags as string[] | undefined)?.some((f) => flags?.includes(f));
        if (!valid) continue;
        const res = Array.isArray(r.result) ? weightedPick(rng, parseWeighted(r.result)) : r.result;
        return typeof res === 'string' ? res : undefined;
      }
      return undefined;
    };
    const t = pick(tf.terrain, buf.ter[i], env.terrainFlags(buf.ter[i]), 'valid_terrain');
    if (t && t !== 't_null' && this.knownTer(t)) buf.ter[i] = t;
    if (buf.furn[i]) {
      const f = pick(tf.furniture, buf.furn[i], env.furnitureFlags(buf.furn[i]), 'valid_furniture');
      if (f !== undefined) buf.furn[i] = f === 'f_null' ? '' : this.knownFurn(f) ? f : buf.furn[i];
    }
    const tr = buf.traps.get(i);
    if (tr) {
      const n = pick(tf.trap, tr, undefined, 'valid_trap');
      if (n !== undefined) n === 'tr_null' ? buf.traps.delete(i) : buf.traps.set(i, n);
    }
    const fl = buf.fields.get(i);
    if (fl && tf.field) {
      buf.fields.set(i, fl.flatMap((f) => {
        const n = pick(tf.field, f.type, undefined, 'valid_field');
        return n === undefined ? [f] : n === 'fd_null' ? [] : [{ ...f, type: n }];
      }));
    }
  }

  private applyNested(d: any, xr: IntR, yr: IntR, dz: number, dat: MapgenDat, levels: Levels): void {
    const rng = dat.rng;
    const pass = this.nestConditions(d, dat);
    const list = pass ? d.chunks : d.else_chunks;
    if (!Array.isArray(list) || list.length === 0) return;
    const weighted = parseWeighted(list, 100).map(([v, w]) => [v, typeof w === 'number' ? w : Number((w as any)?.default ?? 100)] as [unknown, number]);
    const id = evalValue(weightedPick(rng, weighted), dat.params, rng);
    if (!id || id === 'null') return;
    const defs = this.env.data.mapgen.nested[id];
    if (!defs) return this.env.stats.unknownId('nested', id);
    const ref = weightedPick(rng, defs.map((r) => [r, r.w] as const));
    if (!ref) return;
    const c = this.compiler.compile(ref.o, 0, 0, true);
    const ox = rollR(xr, rng), oy = rollR(yr, rng);
    // Nested chunks: fresh "nest"-scope parameters, own flags; CDDA ignores their rotation.
    const params = new ParamCtx(dat.params.stores, c.params, rng, dat.params);
    const sub: MapgenDat = { ...dat, params };
    if (dz === 0) this.applyPhases(c, sub, levels, ox, oy, c.flags);
    else {
      // Shift every level by dz so the nest's own z offsets stay relative to its host.
      const shifted: Levels = new Map();
      for (const [k, v] of levels) shifted.set(k - dz, v);
      this.applyPhases(c, sub, shifted, ox, oy, c.flags);
      for (const [k, v] of shifted) levels.set(k + dz, v);
    }
  }

  /** jmapgen_nested neighbour/flag/predecessor/z checks. */
  private nestConditions(d: any, dat: MapgenDat): boolean {
    const defs = this.env.data.overmap.terrains;
    const neighbor = (dir: string) => {
      const off = NEIGHBOR_DIRS[dir];
      if (!off) return undefined;
      const [rx, ry] = rotateOffset(off[0], off[1], dat.adjRotation);
      return dat.omtAt(rx, ry, off[2]);
    };
    if (d.neighbors) {
      for (const [dir, spec] of Object.entries<any>(d.neighbors)) {
        const n = neighbor(dir);
        if (!n) continue;
        const opts = Array.isArray(spec) ? spec : [spec];
        const ok = opts.some((o: any) =>
          typeof o === 'string' ? otMatch(o, n, defs) : otMatch(o.om_terrain, n, defs, (o.om_terrain_match_type ?? 'CONTAINS') as MatchType));
        if (!ok) return false;
      }
    }
    const hasFlag = (dir: string, f: string) => {
      const n = neighbor(dir);
      return !!n && !!defs[n.type]?.flags.includes(f);
    };
    if (d.flags) {
      for (const [dir, fl] of Object.entries<any>(d.flags)) if (!(fl as string[]).some((f) => hasFlag(dir, f))) return false;
    }
    if (d.flags_any && Object.keys(d.flags_any).length) {
      const any = Object.entries<any>(d.flags_any).some(([dir, fl]) => (fl as string[]).some((f) => hasFlag(dir, f)));
      if (!any) return false;
    }
    if (d.joins && Object.keys(d.joins).length) {
      // Joins only exist for mutable overmap specials, which we don't place.
      this.env.stats.unsupportedFeature('nested:joins');
      return false;
    }
    if (Array.isArray(d.predecessors) && d.predecessors.length) {
      const ok = d.predecessors.some((o: any) => dat.predecessors.some((p) =>
        typeof o === 'string' ? otMatch(o, { type: p, rot: 0, line: -1 }, defs)
          : otMatch(o.om_terrain, { type: p, rot: 0, line: -1 }, defs, (o.om_terrain_match_type ?? 'CONTAINS') as MatchType)));
      if (!ok) return false;
    }
    if (Array.isArray(d.check_z) && d.check_z.length && !d.check_z.includes(dat.z)) return false;
    return true;
  }

  /**
   * CDDA SNIPPET.expand + replace_city_tag: "<snippet:cat>" (our marker for a sign/graffiti
   * "snippet" field) and any "<tag>" naming a snippet category are replaced by a random
   * entry; name tags use data/names.
   */
  private expandText(text: string, dat: MapgenDat, depth = 0): string {
    const rng = dat.rng;
    const pickSnippet = (cat: string): string | undefined => {
      const list = this.env.snippets(cat);
      if (!list || list.length === 0) return undefined;
      const e: any = rng.pick(list);
      return typeof e === 'string' ? e : e?.text ?? undefined;
    };
    let out = text
      .replace(/<snippet:([^>]+)>/g, (_, cat: string) => pickSnippet(cat) ?? '')
      .replace(/<city>/g, dat.cityName)
      .replace(/<given_name>/g, () => rng.pick(dat.names.given))
      .replace(/<family_name>/g, () => rng.pick(dat.names.family))
      .replace(/<full_name>/g, () => `${rng.pick(dat.names.given)} ${rng.pick(dat.names.family)}`);
    out = out.replace(/<[a-z_A-Z0-9]+>/g, (tag) => pickSnippet(tag) ?? tag);
    return depth < 3 && /<[^>]+>/.test(out) && out !== text ? this.expandText(out, dat, depth + 1) : out;
  }
}

/** CDDA roll_remainder: floor(v) plus one more with probability frac(v). */
function roll(v: number, rng: Rng): number {
  const f = Math.floor(v);
  return f + (rng.next() < v - f ? 1 : 0);
}

function bresenham(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let i = 0; i < 200; i++) {
    out.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return out;
}

export type { OterDef };
