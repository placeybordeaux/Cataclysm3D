import type { GameMap } from '../world/map';
import type { TerrainDef } from '../data/types';
import { hasFlag } from '../world/registry';
import { CHUNK, LEVEL_HEIGHT, MAX_Z, MIN_Z, chunkOf, localOf } from '../world/coords';

// Walkable staircases (docs/STAIRS.md). BN stairs are two tiles at the same x,y: GOES_UP on
// the lower level, GOES_DOWN on the upper one, and changing level is a key press. A storey
// is LEVEL_HEIGHT (2.6 m) but a tile is 1 m, so a literal flight needs more run than the
// one tile BN gives it. This module turns each BN pair into a *stair link*: a flight whose
// footprint may spread over free neighbouring tiles (variant `flight`) or stays inside the
// stair tile(s) as a steep flight / spiral (variant `compact`), plus the path a creature
// follows on it (xy + height + facing, parametrised by distance). Creatures ride that path
// (stairwalk.ts); the renderer models the flight and cuts the stairwell from it
// (render/stairs/). Pure: needs only the GameMap, so it runs in tests.
//
// Survey of the layouts around the start (tools/dev/probe_stairs.ts, 2 seeds): most house
// stairs sit in 1-wide pockets — 60 % have one free side upstairs, and a straight run of
// free floor behind the stair *and* a free exit ahead of it upstairs exists for ~25 %.
// Most flights therefore turn (L or U) inside their tile: those become spiral stairs.

export type StairVariant = 'flight' | 'compact' | 'classic';
export const STAIR_VARIANTS: StairVariant[] = ['flight', 'compact', 'classic'];

export type StairKind = 'stairs' | 'ladder' | 'slope';
export type StairShape = 'straight' | 'spiral' | 'ladder';

/** Directions N, E, S, W (y grows south). */
export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];
/** Facing angle (player yaw convention: 0 = north, +π/2 = east) of direction d. */
export const HEADING = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

/** Height (m above the lower floor) where a climber counts as being on the upper level. The
 *  eye (1.6 m) passes the lower ceiling (2.48 m) at about this point, so the light map and
 *  the level-bound systems switch when the view does. */
export const SWITCH_H = 1.0;
/** How far a landing point sits inside its tile: just over a creature radius (0.3), so a
 *  creature let go there is clear of the (blocked) flight tiles. */
export const LANDING_IN = 0.31;
/** Walking-line radius of a spiral stair around its tile centre. */
export const SPIRAL_R = 0.3;
const SAMPLE = 0.04;

/** What kind of level-changing terrain this is, or null for ones we don't model (water, ramps). */
export function stairKind(t: TerrainDef): StairKind | null {
  if (!hasFlag(t, 'GOES_UP') && !hasFlag(t, 'GOES_DOWN')) return null;
  if (hasFlag(t, 'DIFFICULT_Z') || /ladder|rope|manhole/.test(t.id)) return 'ladder';
  if (/stairs/.test(t.id)) return 'stairs';
  if (/slope/.test(t.id)) return 'slope';
  return null;
}

// ---------------------------------------------------------------------------------- path

/**
 * A climbing path: dense samples of position (tile coords), height above the lower floor
 * and facing. `s` runs along the 3D length; s = 0 is the bottom landing point, s = len the
 * top landing point.
 */
export class StairPath {
  readonly len: number;
  constructor(readonly x: Float64Array, readonly y: Float64Array, readonly h: Float64Array, readonly head: Float64Array, readonly cum: Float64Array) {
    this.len = cum[cum.length - 1];
  }

  private seg(s: number): [number, number] {
    const c = this.cum;
    if (s <= 0) return [0, 0];
    if (s >= this.len) return [c.length - 2, 1];
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (c[m] <= s) lo = m;
      else hi = m;
    }
    const d = c[hi] - c[lo];
    return [lo, d > 1e-9 ? (s - c[lo]) / d : 0];
  }

  /** Position, height and facing at distance s (clamped). */
  at(s: number): { x: number; y: number; h: number; head: number } {
    const [i, t] = this.seg(s);
    const j = Math.min(i + 1, this.x.length - 1);
    let dh = this.head[j] - this.head[i];
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    return {
      x: this.x[i] + (this.x[j] - this.x[i]) * t,
      y: this.y[i] + (this.y[j] - this.y[i]) * t,
      h: this.h[i] + (this.h[j] - this.h[i]) * t,
      head: this.head[i] + dh * t,
    };
  }

  /** s of the sample nearest to (x, y, h) (h weighted a little: a spiral passes over itself). */
  nearest(x: number, y: number, h: number): number {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.x.length; i++) {
      const d = (this.x[i] - x) ** 2 + (this.y[i] - y) ** 2 + 0.5 * (this.h[i] - h) ** 2;
      if (d < bd) (bd = d), (best = i);
    }
    return this.cum[best];
  }
}

/** Accumulates path samples; heading defaults to the direction of travel. */
class PathBuilder {
  private xs: number[] = [];
  private ys: number[] = [];
  private hs: number[] = [];
  private hd: (number | null)[] = [];
  point(x: number, y: number, h: number, head: number | null = null): void {
    const n = this.xs.length;
    if (n && Math.hypot(this.xs[n - 1] - x, this.ys[n - 1] - y, this.hs[n - 1] - h) < 1e-6) return;
    this.xs.push(x); this.ys.push(y); this.hs.push(h); this.hd.push(head);
  }
  /** Straight segment to (x, y, h), sampled. */
  line(x: number, y: number, h: number, head: number | null = null): void {
    const n = this.xs.length;
    const x0 = this.xs[n - 1], y0 = this.ys[n - 1], h0 = this.hs[n - 1];
    const L = Math.hypot(x - x0, y - y0, h - h0);
    const k = Math.max(1, Math.ceil(L / SAMPLE));
    for (let i = 1; i <= k; i++) this.point(x0 + ((x - x0) * i) / k, y0 + ((y - y0) * i) / k, h0 + ((h - h0) * i) / k, head);
  }
  /** Straight segment while the facing turns from `h0` to `h1` (the short way round). */
  lineTurn(x: number, y: number, h: number, h0: number, h1: number): void {
    const n = this.xs.length;
    const x0 = this.xs[n - 1], y0 = this.ys[n - 1], hh0 = this.hs[n - 1];
    const L = Math.hypot(x - x0, y - y0, h - hh0);
    const k = Math.max(8, Math.ceil(L / SAMPLE));
    const d = Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0)) || Math.PI;
    for (let i = 1; i <= k; i++) this.point(x0 + ((x - x0) * i) / k, y0 + ((y - y0) * i) / k, hh0 + ((h - hh0) * i) / k, h0 + (d * i) / k);
  }
  /** Cubic Hermite (xy) from the last point to (x, y) with end tangents; h lerps. */
  hermite(x: number, y: number, h: number, t0: [number, number], t1: [number, number]): void {
    const n = this.xs.length;
    const x0 = this.xs[n - 1], y0 = this.ys[n - 1], h0 = this.hs[n - 1];
    const L = Math.hypot(x - x0, y - y0) * 1.2 + 0.05;
    const k = Math.max(4, Math.ceil(L / SAMPLE));
    for (let i = 1; i <= k; i++) {
      const t = i / k, t2 = t * t, t3 = t2 * t;
      const a = 2 * t3 - 3 * t2 + 1, b = t3 - 2 * t2 + t, c = -2 * t3 + 3 * t2, d = t3 - t2;
      this.point(a * x0 + b * t0[0] + c * x + d * t1[0], a * y0 + b * t0[1] + c * y + d * t1[1], h0 + (h - h0) * t);
    }
  }
  done(): StairPath {
    const n = this.xs.length;
    if (n < 2) throw new Error('stair path needs at least two points');
    const x = Float64Array.from(this.xs), y = Float64Array.from(this.ys), h = Float64Array.from(this.hs);
    const cum = new Float64Array(n), head = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1], h[i] - h[i - 1]);
    // facing: explicit where given, else the horizontal direction of travel (a vertical
    // stretch keeps the last one); unwrapped so interpolation never spins the long way
    let last: number | null = null;
    for (let i = 0; i < n; i++) {
      let a = this.hd[i];
      if (a === null) {
        const j = Math.min(i + 1, n - 1), k = j === i ? i - 1 : i;
        const dx = x[j] - x[k], dy = y[j] - y[k];
        a = Math.hypot(dx, dy) > 1e-5 ? Math.atan2(dx, -dy) : last;
      }
      if (a === null) {
        // leading vertical stretch: take the first horizontal heading after it
        for (let m = i + 1; m < n && a === null; m++) {
          const dx = x[m] - x[m - 1], dy = y[m] - y[m - 1];
          if (Math.hypot(dx, dy) > 1e-5) a = Math.atan2(dx, -dy);
        }
        a ??= 0;
      }
      if (last !== null) a = last + Math.atan2(Math.sin(a - last), Math.cos(a - last));
      head[i] = last = a;
    }
    return new StairPath(x, y, h, head, cum);
  }
}

// ---------------------------------------------------------------------------------- links

export interface StairLink {
  /** packed key of the anchor (lowest x, then y, stair tile on the lower level) */
  key: number;
  /** lower level; the flight arrives on z + 1 */
  z: number;
  kind: StairKind;
  shape: StairShape;
  /** lower stair terrain (material for the model) */
  terId: string;
  /** the BN stair tiles (lower level), row-major */
  tiles: [number, number][];
  /** flight footprint on the lower level (walking there is only along the path) */
  lower: [number, number][];
  /** stairwell on the upper level: the floor is cut away over the flight */
  upper: [number, number][];
  /** direction of travel going up: into the flight at the bottom, out of it at the top */
  dIn: number;
  dOut: number;
  /** straight flights: tiles along dIn and across it; `rise` starts at (x0, y0) edge */
  run: number;
  width: number;
  /** straight flights: the corner of the footprint where the rise starts (tile coords):
   *  the bottom edge runs from (ex, ey) across `width` tiles */
  ex: number;
  ey: number;
  /** spiral: centre, start angle (math angle in the x/y-south plane), signed sweep */
  spiral?: { cx: number; cy: number; a0: number; sweep: number };
  /** ladder: the side of the tile the ladder stands against */
  ladderSide?: number;
  /** half-width (m) creatures may stray sideways from the path (wide straight flights) */
  lane: number;
  path: StairPath;
  /** the bottom and top landing tiles */
  bottom: [number, number][];
  top: [number, number][];
  /** stair tiles of a wide block this link turned into plain floor (walkable on both levels) */
  plain: [number, number][];
}

export const packKey = (x: number, y: number, z: number) => ((x + 32768) * 65536 + (y + 32768)) * 32 + (z + 16);

interface Candidate {
  shape: StairShape;
  dIn: number;
  dOut: number;
  run: number;
  width: number;
  /** row-major footprint (same xy on both levels) */
  foot: [number, number][];
  bottom: [number, number][];
  top: [number, number][];
  /** straight: start corner of the rise edge */
  ex: number;
  ey: number;
  score: number;
  ladderSide?: number;
  sweep?: number;
  /** wide blocks solved as one tile: the block's other tiles */
  plain?: [number, number][];
}

/** Terrain-only passability (no overlays: our own footprints are overlays). */
function rawPassable(map: GameMap, x: number, y: number, z: number): boolean {
  const t = map.terAt(x, y, z);
  if (t.move_cost <= 0) return false;
  return map.furnAt(x, y, z).move_cost_mod >= 0;
}
const isDoorish = (t: TerrainDef) => hasFlag(t, 'DOOR') || !!t.open || (/door|hatch|gate/.test(t.id) && !/frame|wall/.test(t.id));
const isStairTer = (t: TerrainDef) => hasFlag(t, 'GOES_UP') || hasFlag(t, 'GOES_DOWN') || hasFlag(t, 'RAMP_UP') || hasFlag(t, 'RAMP_DOWN');

/**
 * All stair links of a map, solved lazily and cached. The mesher and the gameplay both ask
 * here, so both always agree on a flight. A link is solved once and kept while its stair
 * tiles stay stairs: dropping a chair next to it must not reshape a staircase.
 */
export class StairIndex {
  private links = new Map<number, StairLink>();
  /** footprint tile (both levels) -> link */
  private foot = new Map<number, StairLink>();
  /** stair tiles that have no link (classic behaviour): packKey -> true */
  private none = new Set<number>();
  /** stair tiles of a wide block that its link turned into plain floor (both levels) */
  private plainOf = new Map<number, StairLink>();
  /** while solving a wide block tile by tile: its other tiles count as floor */
  private asFloor: Set<number> | null = null;
  /** chunk (cx, cy, z) -> version it was scanned at */
  private scanned = new Map<string, number>();
  /** Per terrain index: 1 = lower stair (GOES_UP of a kind we model), 2 = GOES_DOWN, 0 = neither. */
  private cls = new Uint8Array(0);
  /** bumped whenever links are added or removed (renderers rebuild the chunks around) */
  version = 0;
  /** chunks (key "cx,cy,z") whose meshes depend on a link that changed */
  readonly dirtyChunks = new Set<string>();

  constructor(readonly map: GameMap, public variant: StairVariant = 'flight') {}

  /** Drop everything (variant change). */
  reset(variant: StairVariant = this.variant): void {
    this.variant = variant;
    for (const l of this.links.values()) this.markDirty(l);
    this.links.clear();
    this.foot.clear();
    this.plainOf.clear();
    this.none.clear();
    this.scanned.clear();
    this.version++;
  }

  get enabled(): boolean {
    return this.variant !== 'classic';
  }

  all(): IterableIterator<StairLink> {
    return this.links.values();
  }

  /** Link whose footprint covers tile (x, y) on level z (either the flight or its well). */
  at(x: number, y: number, z: number): StairLink | null {
    return this.foot.get(packKey(x, y, z)) ?? null;
  }

  /** Is (x, y, z) a stair tile its link turned into plain floor (either level)? */
  isPlain(x: number, y: number, z: number): boolean {
    return this.plainOf.has(packKey(x, y, z));
  }

  /** Link owning plain stair tile (x, y, z). */
  plainLink(x: number, y: number, z: number): StairLink | null {
    return this.plainOf.get(packKey(x, y, z)) ?? null;
  }

  /** Is (x, y, z) part of a stairwell cut into the upper floor? */
  isWell(x: number, y: number, z: number): boolean {
    const l = this.foot.get(packKey(x, y, z));
    return !!l && l.z + 1 === z;
  }

  private terClass(i: number): number {
    if (i >= this.cls.length) {
      const defs = this.map.terrain.defs;
      const c = new Uint8Array(defs.length);
      for (let k = 0; k < defs.length; k++) {
        const t = defs[k];
        const kind = stairKind(t);
        c[k] = !kind ? 0 : hasFlag(t, 'GOES_UP') ? 1 : 2;
      }
      this.cls = c;
    }
    return this.cls[i];
  }

  /**
   * Solve every stair in chunk (cx, cy) on levels z-1..z (links reaching z from below and
   * starting at z). May generate the chunks a flight looks at (the level above and the
   * neighbours), so call it from a frame/tick step, never from inside physics.
   */
  ensureChunk(cx: number, cy: number, z: number): void {
    if (!this.enabled) return;
    for (const lz of [z - 1, z]) {
      if (lz < MIN_Z || lz + 1 > MAX_Z) continue;
      const k = `${cx},${cy},${lz}`;
      const c = this.map.hasChunk(cx, cy, lz) ? this.map.chunk(cx, cy, lz) : null;
      if (!c) continue;
      const cu = this.map.hasChunk(cx, cy, lz + 1) ? this.map.chunk(cx, cy, lz + 1) : null;
      const ver = c.version * 4096 + (cu ? cu.version + 1 : 0);
      if (this.scanned.get(k) === ver) continue;
      this.scanned.set(k, ver);
      for (let ly = 0; ly < CHUNK; ly++)
        for (let lx = 0; lx < CHUNK; lx++) {
          const i = ly * CHUNK + lx;
          const x = cx * CHUNK + lx, y = cy * CHUNK + ly;
          let lower = this.terClass(c.ter[i]) === 1;
          // a GOES_DOWN tile above floor with no stairs under it: BN lets you through
          if (!lower && cu && this.terClass(cu.ter[i]) === 2) lower = this.isLowerStair(x, y, lz);
          if (!lower) continue;
          const pk = packKey(x, y, lz);
          const have = this.foot.get(pk);
          if (have && have.z === lz && have.tiles.some(([tx, ty]) => tx === x && ty === y)) continue;
          if (this.none.has(pk) || this.plainOf.has(pk)) continue;
          this.solveAt(x, y, lz);
        }
      // links whose stair tiles are no longer stairs (bashed, deconstructed) go away
      for (const l of [...this.links.values()]) {
        if (l.z !== lz || chunkOf(l.tiles[0][0]) !== cx || chunkOf(l.tiles[0][1]) !== cy) continue;
        if (!l.tiles.every(([tx, ty]) => this.isLowerStair(tx, ty, lz))) this.remove(l);
      }
    }
  }

  /** Solve the chunks around tile (x, y) on level z (a creature's neighbourhood). */
  ensureAround(x: number, y: number, z: number, r = 1): void {
    const cx = chunkOf(x), cy = chunkOf(y);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      this.ensureChunk(cx + dx, cy + dy, z);
      this.ensureChunk(cx + dx, cy + dy, z + 1);
    }
  }

  private isLowerStair(x: number, y: number, z: number): boolean {
    const t = this.map.terAt(x, y, z);
    if (stairKind(t) && hasFlag(t, 'GOES_UP')) return true;
    const u = this.map.terAt(x, y, z + 1);
    return !!stairKind(u) && hasFlag(u, 'GOES_DOWN') && !isStairTer(t) && rawPassable(this.map, x, y, z) && this.map.hasFloor(x, y, z);
  }

  private remove(l: StairLink): void {
    this.links.delete(l.key);
    for (const [x, y] of l.lower) this.foot.delete(packKey(x, y, l.z));
    for (const [x, y] of l.upper) this.foot.delete(packKey(x, y, l.z + 1));
    for (const [x, y] of l.plain) {
      this.plainOf.delete(packKey(x, y, l.z));
      this.plainOf.delete(packKey(x, y, l.z + 1));
    }
    this.markDirty(l);
    this.version++;
  }

  private markDirty(l: StairLink): void {
    for (const [x, y] of [...l.lower, ...l.bottom, ...l.plain]) this.dirtyChunks.add(`${chunkOf(x)},${chunkOf(y)},${l.z}`);
    for (const [x, y] of [...l.upper, ...l.top, ...l.plain]) this.dirtyChunks.add(`${chunkOf(x)},${chunkOf(y)},${l.z + 1}`);
  }

  /** Kind of the stair at lower tile (x, y, z): from the lower tile, else the one above. */
  private kindAt(x: number, y: number, z: number): { kind: StairKind; terId: string } | null {
    const t = this.map.terAt(x, y, z);
    const k = stairKind(t);
    if (k && hasFlag(t, 'GOES_UP')) return { kind: k, terId: t.id };
    const u = this.map.terAt(x, y, z + 1);
    const ku = stairKind(u);
    return ku ? { kind: ku, terId: u.id } : null;
  }

  private solveAt(x: number, y: number, z: number): void {
    const k0 = this.kindAt(x, y, z);
    if (!k0) return;
    // the block of stair tiles (wide stairs: the shelter's 2x2) — same kind, stairs above
    const block = this.block(x, y, z, k0.kind);
    const link = this.solveBlock(block, z, k0.kind, k0.terId);
    if (!link) {
      for (const [bx, by] of block) this.none.add(packKey(bx, by, z));
      return;
    }
    this.links.set(link.key, link);
    for (const [fx, fy] of link.lower) this.foot.set(packKey(fx, fy, z), link);
    for (const [fx, fy] of link.upper) this.foot.set(packKey(fx, fy, z + 1), link);
    for (const [px, py] of link.plain) {
      this.plainOf.set(packKey(px, py, z), link);
      this.plainOf.set(packKey(px, py, z + 1), link);
    }
    this.markDirty(link);
    this.version++;
  }

  /** Connected stair tiles of one kind around (x, y); a rectangle up to 3x3, else just the tile. */
  private block(x: number, y: number, z: number, kind: StairKind): [number, number][] {
    if (kind === 'ladder') return [[x, y]];
    const seen = new Set<string>([`${x},${y}`]);
    const out: [number, number][] = [[x, y]];
    for (let i = 0; i < out.length && out.length <= 9; i++) {
      const [px, py] = out[i];
      for (let d = 0; d < 4; d++) {
        const nx = px + DX[d], ny = py + DY[d];
        if (seen.has(`${nx},${ny}`)) continue;
        seen.add(`${nx},${ny}`);
        if (this.foot.has(packKey(nx, ny, z))) continue;
        const k = this.kindAt(nx, ny, z);
        if (k?.kind === kind && this.isLowerStair(nx, ny, z)) out.push([nx, ny]);
      }
    }
    const xs = out.map((p) => p[0]), ys = out.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (out.length !== w * h || w > 3 || h > 3) return [[x, y]];
    out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    return out;
  }

  // ---- footprint predicates (terrain only: the solver must not see its own overlays)
  private claimed(x: number, y: number, z: number): boolean {
    return this.foot.has(packKey(x, y, z));
  }
  /** Floor we may turn into flight (lower) or cut open into a stairwell (upper). */
  private freeFloor(x: number, y: number, z: number): boolean {
    const m = this.map;
    if (this.claimed(x, y, z)) return false;
    const t = m.terAt(x, y, z);
    if (isStairTer(t) || !rawPassable(m, x, y, z) || !m.hasFloor(x, y, z)) return false;
    if (m.furnAt(x, y, z).id !== 'f_null') return false;
    if (m.itemsAt(x, y, z).length) return false;
    // doors, windows and other openings stay what they are
    if (hasFlag(t, 'DOOR') || hasFlag(t, 'WINDOW') || /door|gate|window/.test(t.id)) return false;
    return true;
  }
  /** The upper tile over a lower stair tile: stairs down, or floor we may cut open. */
  private opensAbove(x: number, y: number, z: number): boolean {
    const u = this.map.terAt(x, y, z + 1);
    return (hasFlag(u, 'GOES_DOWN') && !!stairKind(u)) || this.freeFloor(x, y, z + 1);
  }
  /** Somewhere to stand at the end of a flight. */
  private landing(x: number, y: number, z: number): boolean {
    const m = this.map;
    if (this.claimed(x, y, z)) return false;
    const t = m.terAt(x, y, z);
    if (this.asFloor?.has(packKey(x, y, z))) return true;
    if (isStairTer(t) || !m.hasFloor(x, y, z)) return false;
    // closed (even locked) doors are fine: the climb waits at the top step until it opens
    return rawPassable(m, x, y, z) || isDoorish(t);
  }
  private walkable(x: number, y: number, z: number): boolean {
    const m = this.map;
    const t = m.terAt(x, y, z);
    return m.hasFloor(x, y, z) && (rawPassable(m, x, y, z) || isDoorish(t));
  }
  private wallish(x: number, y: number, z: number): boolean {
    const t = this.map.terAt(x, y, z);
    return t.move_cost <= 0 && !isDoorish(t);
  }

  /**
   * Every walkable tile next to `removed` on level z (plus `extra` tiles that must stay
   * reachable) can still reach `goal` without crossing `removed` (BFS in a window).
   */
  private connected(removed: [number, number][], goal: [number, number], z: number, extra: [number, number][]): boolean {
    const R = 10;
    const rm = new Set(removed.map(([x, y]) => `${x},${y}`));
    const need: [number, number][] = [...extra];
    for (const [x, y] of removed)
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (!rm.has(`${nx},${ny}`) && this.walkable(nx, ny, z) && !this.claimed(nx, ny, z)) need.push([nx, ny]);
      }
    if (!need.length) return true;
    const [gx, gy] = goal;
    const seen = new Set<string>([`${gx},${gy}`]);
    const q: [number, number][] = [[gx, gy]];
    for (let i = 0; i < q.length; i++) {
      const [x, y] = q[i];
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        const k = `${nx},${ny}`;
        if (seen.has(k) || rm.has(k) || Math.abs(nx - gx) > R || Math.abs(ny - gy) > R) continue;
        if (!this.walkable(nx, ny, z) || this.claimed(nx, ny, z)) continue;
        seen.add(k);
        q.push([nx, ny]);
      }
    }
    return need.every(([x, y]) => seen.has(`${x},${y}`));
  }

  private solveBlock(block: [number, number][], z: number, kind: StairKind, terId: string): StairLink | null {
    const xs = block.map((p) => p[0]), ys = block.map((p) => p[1]);
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
    const inBlock = (x: number, y: number) => x >= bx0 && x <= bx1 && y >= by0 && y <= by1;
    // the block's old access: walkable neighbours on each level (they must keep reaching it)
    const oldLow: [number, number][] = [], oldUp: [number, number][] = [];
    for (const [x, y] of block)
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (inBlock(nx, ny)) continue;
        if (this.walkable(nx, ny, z) && !this.claimed(nx, ny, z)) oldLow.push([nx, ny]);
        if (this.walkable(nx, ny, z + 1) && !this.claimed(nx, ny, z + 1)) oldUp.push([nx, ny]);
      }
    const cands: Candidate[] = [];
    if (kind === 'ladder') this.ladderCandidates(block[0], z, cands);
    else {
      this.straightCandidates(bx0, by0, bx1, by1, z, kind, cands);
      if (block.length === 1 && kind === 'stairs') this.spiralCandidates(block[0], z, cands);
    }
    let plain: [number, number][] = [];
    if (!cands.length && block.length > 1) {
      // a wide flight that fits no straight run (a 2-wide stair between walls, turning
      // back on itself): one tile becomes a spiral, the rest of the block plain floor
      this.asFloor = new Set(block.flatMap(([x, y]) => [packKey(x, y, z), packKey(x, y, z + 1)]));
      try {
        for (const t of block) {
          const before = cands.length;
          const others = block.filter((b) => b !== t);
          this.asFloor = new Set(others.flatMap(([x, y]) => [packKey(x, y, z), packKey(x, y, z + 1)]));
          this.straightCandidates(t[0], t[1], t[0], t[1], z, kind, cands);
          if (kind === 'stairs') this.spiralCandidates(t, z, cands);
          for (let i = before; i < cands.length; i++) cands[i].plain = others;
        }
      } finally {
        this.asFloor = null;
      }
    }
    if (!cands.length) return null;
    for (const c of cands) {
      // keeping both floors connected matters more than the shape
      const low = this.connected(c.foot, c.bottom[0], z, oldLow.filter(([x, y]) => !c.foot.some(([fx, fy]) => fx === x && fy === y)));
      const up = this.connected(c.foot, c.top[0], z + 1, oldUp.filter(([x, y]) => !c.foot.some(([fx, fy]) => fx === x && fy === y)));
      // a flight that cuts part of a floor off (a stair tile BN lets you walk across on the
      // way to another room) is no flight: those stay classic
      if (!low || !up) c.score = -Infinity;
      // a landing that is a dead end (a closet) is a poor top
      let open = 0;
      for (let d = 0; d < 4; d++) if (this.walkable(c.top[0][0] + DX[d], c.top[0][1] + DY[d], z + 1)) open++;
      c.score += Math.min(open, 3) * 2;
    }
    cands.sort((a, b) => b.score - a.score);
    if (cands[0].score === -Infinity) return null;
    plain = cands[0].plain ?? [];
    const tiles = plain.length ? block.filter((b) => !plain.includes(b)) : block;
    return this.build(cands[0], tiles, z, kind, terId, plain);
  }

  /**
   * Straight flights across the block along each axis. `flight` extends the run over free
   * floor before/after the block (both levels) toward a real proportion (3 tiles ≈ 41°);
   * `compact` keeps it inside the block (1 tile ≈ 69°: a steep ship's stair).
   */
  private straightCandidates(bx0: number, by0: number, bx1: number, by1: number, z: number, kind: StairKind, out: Candidate[]): void {
    for (let d = 0; d < 4; d++) {
      const alongX = DX[d] !== 0;
      const L = alongX ? bx1 - bx0 + 1 : by1 - by0 + 1;
      const W = alongX ? by1 - by0 + 1 : bx1 - bx0 + 1;
      // first row of the block in travel direction d, and the lateral start
      const rowX = (k: number, j: number): [number, number] => {
        // row k (0 = first row entered), lateral j (0..W-1)
        if (d === 0) return [bx0 + j, by1 - k];
        if (d === 2) return [bx0 + j, by0 + k];
        if (d === 1) return [bx0 + k, by0 + j];
        return [bx1 - k, by0 + j];
      };
      const rowOk = (k: number, pred: (x: number, y: number) => boolean) => {
        for (let j = 0; j < W; j++) {
          const [x, y] = rowX(k, j);
          if (!pred(x, y)) return false;
        }
        return true;
      };
      const maxRun = this.variant === 'flight' ? 4 : L;
      for (let n = L; n <= maxRun; n++)
        for (let e0 = 0; e0 <= n - L; e0++) {
          const e1 = n - L - e0;
          let ok = true;
          for (let k = -e0; k < 0 && ok; k++) ok = rowOk(k, (x, y) => this.freeFloor(x, y, z) && this.freeFloor(x, y, z + 1));
          for (let k = L; k < L + e1 && ok; k++) ok = rowOk(k, (x, y) => this.freeFloor(x, y, z) && this.freeFloor(x, y, z + 1));
          if (!ok) continue;
          // the block's own upper tiles must open up (stairs above, or floor we may cut)
          ok = rowsAll(L, (k) => rowOk(k, (x, y) => {
            const u = this.map.terAt(x, y, z + 1);
            return (hasFlag(u, 'GOES_DOWN') && !!stairKind(u)) || this.freeFloor(x, y, z + 1);
          }));
          if (!ok) continue;
          if (!rowOk(-e0 - 1, (x, y) => this.landing(x, y, z))) continue;
          if (!rowOk(L + e1, (x, y) => this.landing(x, y, z + 1))) continue;
          const foot: [number, number][] = [];
          for (let k = -e0; k < L + e1; k++) for (let j = 0; j < W; j++) foot.push(rowX(k, j));
          const bottom: [number, number][] = [], top: [number, number][] = [];
          for (let j = 0; j < W; j++) { bottom.push(rowX(-e0 - 1, j)); top.push(rowX(L + e1, j)); }
          // the rise starts on the edge between the bottom landing row and the first flight row
          const [fx, fy] = rowX(-e0, 0);
          const ex = d === 3 ? fx + 1 : fx, ey = d === 0 ? fy + 1 : fy;
          let score = 0;
          if (this.variant === 'flight') score += n === 3 ? 40 : n === 4 ? 30 : n === 2 ? 26 : 0;
          else score += 20;
          // along a wall (the usual house stair) rather than free-standing
          for (let k = -e0; k < L + e1; k++) {
            const [ax, ay] = rowX(k, -1), [bx, by] = rowX(k, W);
            if (this.wallish(ax, ay, z)) score += 1;
            if (this.wallish(bx, by, z)) score += 1;
          }
          out.push({ shape: 'straight', dIn: d, dOut: d, run: n, width: W, foot, bottom, top, ex, ey, score });
        }
    }
  }

  /** Spirals inside a single stair tile: in from one side, out on the same side (U) or a neighbour (L). */
  private spiralCandidates([x, y]: [number, number], z: number, out: Candidate[]): void {
    if (!this.opensAbove(x, y, z)) return;
    for (let dB = 0; dB < 4; dB++) {
      const bx = x + DX[dB], by = y + DY[dB];
      if (!this.landing(bx, by, z)) continue;
      for (let dU = 0; dU < 4; dU++) {
        if (dU === (dB + 2) % 4) continue; // straight through: that's a straight flight
        const ux = x + DX[dU], uy = y + DY[dU];
        if (!this.landing(ux, uy, z + 1)) continue;
        // U-turn: one full turn (you come out right above where you went in); L-turn: 1¼
        // turns the short way round (¾ would be 61° at the walking line: too steep)
        const aB = Math.atan2(DY[dB], DX[dB]);
        const aU = Math.atan2(DY[dU], DX[dU]);
        let diff = aU - aB;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // -π/2, 0, π/2
        const sweep = dU === dB ? 2 * Math.PI : (Math.sign(diff) || 1) * (2 * Math.PI + Math.abs(diff));
        const score = (this.variant === 'flight' ? 10 : 18) + (dU === dB ? 1 : 0);
        out.push({ shape: 'spiral', dIn: (dB + 2) % 4, dOut: dU, run: 1, width: 1, foot: [[x, y]], bottom: [[bx, by]], top: [[ux, uy]], ex: x, ey: y, score, sweep });
      }
    }
  }

  /** Ladders: in from any free side, up the rungs on a wall side, off onto any free side above. */
  private ladderCandidates([x, y]: [number, number], z: number, out: Candidate[]): void {
    if (!this.opensAbove(x, y, z)) return;
    for (let dB = 0; dB < 4; dB++) {
      const bx = x + DX[dB], by = y + DY[dB];
      if (!this.landing(bx, by, z)) continue;
      for (let dU = 0; dU < 4; dU++) {
        const ux = x + DX[dU], uy = y + DY[dU];
        if (!this.landing(ux, uy, z + 1)) continue;
        // the rungs go on a wall: ahead of you (a roof ladder against the house) if that is
        // where you step off, else any wall side that isn't where you come in
        let side = -1;
        if (dU !== dB && this.wallish(x + DX[dU], y + DY[dU], z)) side = dU;
        for (let d = 0; d < 4 && side < 0; d++) if (d !== dB && this.wallish(x + DX[d], y + DY[d], z)) side = d;
        if (side < 0) side = (dB + 2) % 4;
        let score = 10;
        if (side === dU) score += 4; // climb straight over the top
        if (dU === (dB + 2) % 4) score += 2;
        out.push({ shape: 'ladder', dIn: (dB + 2) % 4, dOut: dU, run: 1, width: 1, foot: [[x, y]], bottom: [[bx, by]], top: [[ux, uy]], ex: x, ey: y, score, ladderSide: side });
      }
    }
  }

  private build(c: Candidate, block: [number, number][], z: number, kind: StairKind, terId: string, plain: [number, number][] = []): StairLink {
    const [ax, ay] = block[0];
    const H = LEVEL_HEIGHT;
    const pb = new PathBuilder();
    let spiral: StairLink['spiral'];
    let lane = 0;
    if (c.shape === 'straight') {
      const d = c.dIn;
      const vx = DX[d], vy = DY[d];
      // lateral axis: along +x for N/S travel, +y for E/W
      const lx = vx === 0 ? 1 : 0, ly = vx === 0 ? 0 : 1;
      const half = c.width / 2;
      const e0x = c.ex + lx * half, e0y = c.ey + ly * half;
      const e1x = e0x + vx * c.run, e1y = e0y + vy * c.run;
      const head = HEADING[d];
      pb.point(e0x - vx * LANDING_IN, e0y - vy * LANDING_IN, 0, head);
      pb.line(e0x, e0y, 0, head);
      pb.line(e1x, e1y, H, head);
      pb.line(e1x + vx * LANDING_IN, e1y + vy * LANDING_IN, H, head);
      lane = Math.max(0, half - 0.34);
    } else if (c.shape === 'spiral') {
      const cx = ax + 0.5, cy = ay + 0.5;
      const dB = (c.dIn + 2) % 4;
      const a0 = Math.atan2(DY[dB], DX[dB]);
      const sweep = c.sweep!;
      const sg = Math.sign(sweep);
      spiral = { cx, cy, a0, sweep };
      const R = SPIRAL_R;
      const hAt = (a: number) => (H * (a - a0)) / sweep;
      // in from the landing, curving onto the walking line a little way round; out the same
      const lead = 0.55 * sg; // radians of the turn used to join the helix smoothly
      const P0: [number, number] = [cx + Math.cos(a0) * (0.5 + LANDING_IN), cy + Math.sin(a0) * (0.5 + LANDING_IN)];
      pb.point(P0[0], P0[1], 0);
      const aJ = a0 + lead;
      const tan = (a: number): [number, number] => [-Math.sin(a) * sg, Math.cos(a) * sg];
      const k = 0.55;
      const tj = tan(aJ);
      pb.hermite(cx + Math.cos(aJ) * R, cy + Math.sin(aJ) * R, hAt(aJ), [-Math.cos(a0) * k, -Math.sin(a0) * k], [tj[0] * k, tj[1] * k]);
      const aK = a0 + sweep - lead;
      const steps = Math.ceil(Math.abs(aK - aJ) * R / SAMPLE);
      for (let i = 1; i <= steps; i++) {
        const a = aJ + ((aK - aJ) * i) / steps;
        pb.point(cx + Math.cos(a) * R, cy + Math.sin(a) * R, hAt(a));
      }
      const a1 = a0 + sweep;
      const tk = tan(aK);
      pb.hermite(cx + Math.cos(a1) * (0.5 + LANDING_IN), cy + Math.sin(a1) * (0.5 + LANDING_IN), H, [tk[0] * k, tk[1] * k], [Math.cos(a1) * k, Math.sin(a1) * k]);
    } else {
      // ladder: walk to the foot, climb facing the rungs, step off onto the top landing
      const cx = ax + 0.5, cy = ay + 0.5;
      const side = c.ladderSide!;
      const dB = (c.dIn + 2) % 4;
      const faceX = DX[side], faceY = DY[side];
      const footX = cx + faceX * 0.12, footY = cy + faceY * 0.12;
      const P0: [number, number] = [cx + DX[dB] * (0.5 + LANDING_IN), cy + DY[dB] * (0.5 + LANDING_IN)];
      pb.point(P0[0], P0[1], 0);
      if (dB === (side + 2) % 4) pb.line(footX, footY, 0, HEADING[side]);
      else pb.hermite(footX, footY, 0, [-DX[dB] * 0.5, -DY[dB] * 0.5], [faceX * 0.5, faceY * 0.5]);
      pb.line(footX, footY, H, HEADING[side]);
      const P1: [number, number] = [cx + DX[c.dOut] * (0.5 + LANDING_IN), cy + DY[c.dOut] * (0.5 + LANDING_IN)];
      // stepping off: forward over the top, or turning round onto a landing beside/behind
      if (c.dOut === side) pb.line(P1[0], P1[1], H, HEADING[side]);
      else pb.lineTurn(P1[0], P1[1], H, HEADING[side], HEADING[c.dOut]);
    }
    const path = pb.done();
    return {
      key: packKey(ax, ay, z), z, kind, shape: c.shape, terId, tiles: block,
      lower: c.foot.slice(), upper: c.foot.slice(),
      dIn: c.dIn, dOut: c.dOut, run: c.run, width: c.width, ex: c.ex, ey: c.ey,
      spiral, ladderSide: c.ladderSide, lane, path, bottom: c.bottom, top: c.top, plain,
    };
  }
}

function rowsAll(n: number, f: (k: number) => boolean): boolean {
  for (let k = 0; k < n; k++) if (!f(k)) return false;
  return true;
}

/** Height of the path at s, split into the level a creature there is on and its lift. */
export function levelAt(link: StairLink, h: number): { z: number; lift: number } {
  return h >= SWITCH_H ? { z: link.z + 1, lift: h - LEVEL_HEIGHT } : { z: link.z, lift: h };
}

/** Local tile index helper for renderers iterating a chunk. */
export const localIndex = (x: number, y: number) => localOf(y) * CHUNK + localOf(x);
