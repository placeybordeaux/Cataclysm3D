import type { TerrainDef } from '../data/types';
import { CHUNK } from '../world/coords';
import type { Chunk, GameMap } from '../world/map';
import { hasFlag } from '../world/registry';
import { patternFor } from './pixelArt';
import { terrainShape } from './tileKinds';

// Visual ground height (look.ts `relief` / `archDetail`): gameplay, collision and light stay
// on the flat tile grid; only what is drawn (and the eye) rides this field.
//
//  - relief: natural outdoor ground (grass, dirt, forest floor, sand, snow) gets a gentle
//    heightfield defined at tile corners. It fades to 0 within RAMP tiles of anything that
//    isn't relief ground (roads, floors, walls, furniture, water), so nothing built ever
//    floats or sinks; rural roads get a ditch one tile out.
//  - raised: sidewalks sit RAISE above the road (curbs). Where two tiles' surfaces don't
//    meet, the mesher draws a vertical "skirt" (chunkMesh.ts).
//
// Heights are metres relative to the level's floor. Corner fields are cached per chunk and
// keyed by the versions of the 3x3 chunks around it (the ramp reaches across borders).

export const RAISE = 0.14;
const EPOCH_MS = 40;
const RAMP = 3;

/** Per-terrain classification: 0 flat, >0 relief amplitude, <0 raised (curb). */
function classify(t: TerrainDef, curbs: boolean): number {
  const shape = terrainShape(t);
  if (curbs && shape === 'floor' && /^t_sidewalk/.test(t.id)) return -1;
  if (shape !== 'floor' && shape !== 'tree' && shape !== 'shrub') return 0;
  if (hasFlag(t, 'INDOORS') || hasFlag(t, 'ROAD') || hasFlag(t, 'LIQUID')) return 0;
  const p = patternFor(t.id, t.flags, 'floor');
  if (shape === 'tree' || shape === 'shrub') return 1.2;
  if (p === 'grass') return /long|tall/.test(t.id) ? 1.15 : 1;
  if (p === 'dirt') return /furrow|farm|field/.test(t.id) ? 0.35 : 1.1;
  if (p === 'sand' || p === 'snow') return 0.7;
  return 0;
}

/** 32-bit integer hash of a lattice point (the tile seed pointSeed is not a hash). */
export function hash2(x: number, y: number, s = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
const h01 = (x: number, y: number, s: number) => hash2(x, y, s) / 4294967296;

/** Smooth value noise in [0, 1). */
export function vnoise(x: number, y: number, s = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  let fx = x - xi, fy = y - yi;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = h01(xi, yi, s), b = h01(xi + 1, yi, s), c = h01(xi, yi + 1, s), d = h01(xi + 1, yi + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

interface CornerCache {
  sig: number;
  /** (CHUNK+1)^2 corner heights, corner (i, j) = world corner (cx*CHUNK+i, cy*CHUNK+j) */
  h: Float32Array;
}

const N = CHUNK + 1;
const PAD = RAMP + 1;
const W = CHUNK + 2 * PAD;

export class GroundField {
  relief = false;
  curbs = false;
  private cls = new Float32Array(0);
  private clsCurbs = false;
  private road = new Uint8Array(0);
  private cache = new Map<number, CornerCache>();
  private grid = new Float32Array(W * W);
  // Short-lived memos: the map keys chunks by strings, and the mesher asks for thousands of
  // corners per chunk. Entries live for one EPOCH_MS window so edits/evictions show up.
  private epoch = -1;
  private chunkMemo = new Map<number, Chunk | null>();
  private fieldMemo = new Map<number, Float32Array | null>();
  private roadGrid = new Uint8Array(W * W);

  constructor(private map: GameMap) {}

  get active(): boolean {
    return this.relief || this.curbs;
  }

  /** Forget cached fields (look switched). */
  reset(): void {
    this.cache.clear();
    this.chunkMemo.clear();
    this.fieldMemo.clear();
    this.cls = new Float32Array(0);
  }

  private terClass(i: number): number {
    const defs = this.map.terrain.defs;
    if (i >= this.cls.length || this.clsCurbs !== this.curbs) {
      this.cls = new Float32Array(defs.length);
      this.road = new Uint8Array(defs.length);
      this.clsCurbs = this.curbs;
      for (let k = 0; k < defs.length; k++) {
        this.cls[k] = classify(defs[k], this.curbs);
        this.road[k] = hasFlag(defs[k], 'ROAD') || /^t_(pavement|dirtroad)/.test(defs[k].id) ? 1 : 0;
      }
    }
    return this.cls[i];
  }

  /** Classification of one tile of a loaded chunk; furniture pins ground flat. */
  private tileClass(c: Chunk, li: number): number {
    const k = this.terClass(c.ter[li]);
    if (k > 0 && c.furn[li] !== 0) return 0;
    return k;
  }

  /** Raised (sidewalk) offset of a whole tile, or 0. */
  tileRaise(x: number, y: number, z: number): number {
    if (!this.curbs) return 0;
    const c = this.loaded(x, y, z);
    if (!c) return 0;
    const li = (((y % CHUNK) + CHUNK) % CHUNK) * CHUNK + (((x % CHUNK) + CHUNK) % CHUNK);
    return this.terClass(c.ter[li]) < 0 ? RAISE : 0;
  }

  /** True when tile (x, y) is relief ground (its surface follows the corner field). */
  isRelief(x: number, y: number, z: number): boolean {
    if (!this.relief) return false;
    const c = this.loaded(x, y, z);
    if (!c) return false;
    const li = (((y % CHUNK) + CHUNK) % CHUNK) * CHUNK + (((x % CHUNK) + CHUNK) % CHUNK);
    return this.tileClass(c, li) > 0;
  }

  private tick(): void {
    const e = Math.floor(performance.now() / EPOCH_MS);
    if (e !== this.epoch) {
      this.epoch = e;
      this.chunkMemo.clear();
      this.fieldMemo.clear();
    }
  }

  private loaded(x: number, y: number, z: number): Chunk | null {
    const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK);
    return this.chunkAt(cx, cy, z);
  }

  private chunkAt(cx: number, cy: number, z: number): Chunk | null {
    this.tick();
    const k = ((z + 16) * 4096 + (cx + 2048)) * 4096 + (cy + 2048);
    let c = this.chunkMemo.get(k);
    if (c === undefined) {
      c = this.map.hasChunk(cx, cy, z) ? this.map.chunk(cx, cy, z) : null;
      this.chunkMemo.set(k, c);
    }
    return c;
  }

  /** Relief height at integer corner (X, Y) (0 without relief). */
  corner(X: number, Y: number, z: number): number {
    if (!this.relief) return 0;
    const cx = Math.floor(X / CHUNK), cy = Math.floor(Y / CHUNK);
    // a corner on a chunk's far edge is also corner 0 of the next chunk: use the owner
    const f = this.field(cx, cy, z);
    if (!f) return 0;
    return f[(Y - cy * CHUNK) * N + (X - cx * CHUNK)];
  }

  /** Surface normal of the relief at corner (X, Y), three.js axes (x, up, tile y). */
  cornerNormal(X: number, Y: number, z: number): [number, number, number] {
    const dx = (this.corner(X + 1, Y, z) - this.corner(X - 1, Y, z)) / 2;
    const dy = (this.corner(X, Y + 1, z) - this.corner(X, Y - 1, z)) / 2;
    const l = Math.hypot(dx, 1, dy);
    return [-dx / l, 1 / l, -dy / l];
  }

  /** Visual ground height (m above the level floor) at a float tile position. */
  heightAt(x: number, y: number, z: number): number {
    if (!this.active) return 0;
    const tx = Math.floor(x), ty = Math.floor(y);
    const c = this.loaded(tx, ty, z);
    if (!c) return 0;
    const li = (((ty % CHUNK) + CHUNK) % CHUNK) * CHUNK + (((tx % CHUNK) + CHUNK) % CHUNK);
    const k = this.tileClass(c, li);
    if (k < 0) return RAISE;
    if (k === 0 || !this.relief) return 0;
    const fx = x - tx, fy = y - ty;
    const a = this.corner(tx, ty, z), b = this.corner(tx + 1, ty, z), d = this.corner(tx, ty + 1, z), e = this.corner(tx + 1, ty + 1, z);
    return a + (b - a) * fx + (d - a) * fy + (a - b - d + e) * fx * fy;
  }

  /** Corner field of chunk (cx, cy, z), rebuilt when it or a neighbour changes. */
  private field(cx: number, cy: number, z: number): Float32Array | null {
    const key = ((z + 16) * 4096 + (cx + 2048)) * 4096 + (cy + 2048);
    this.tick();
    const memo = this.fieldMemo.get(key);
    if (memo !== undefined) return memo;
    const f = this.fieldUncached(cx, cy, z, key);
    this.fieldMemo.set(key, f);
    return f;
  }

  private fieldUncached(cx: number, cy: number, z: number, key: number): Float32Array | null {
    if (!this.chunkAt(cx, cy, z)) return null;
    let sig = 17;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.chunkAt(cx + dx, cy + dy, z);
        sig = (Math.imul(sig, 31) + (c ? c.version + 1 : 0)) | 0;
      }
    const hit = this.cache.get(key);
    if (hit && hit.sig === sig) return hit.h;
    const h = this.compute(cx, cy, z);
    if (this.cache.size > 600) this.cache.clear();
    this.cache.set(key, { sig, h });
    return h;
  }

  private compute(cx: number, cy: number, z: number): Float32Array {
    const m = this.map;
    const x0 = cx * CHUNK - PAD, y0 = cy * CHUNK - PAD;
    const g = this.grid, rg = this.roadGrid;
    // tile classes over the chunk plus a PAD border (unloaded = flat)
    for (let j = 0; j < W; j++)
      for (let i = 0; i < W; i++) {
        const x = x0 + i, y = y0 + j;
        const c = this.loaded(x, y, z);
        let k = 0, road = 0;
        if (c) {
          const li = (((y % CHUNK) + CHUNK) % CHUNK) * CHUNK + (((x % CHUNK) + CHUNK) % CHUNK);
          k = this.tileClass(c, li);
          road = this.road[c.ter[li]];
        }
        g[j * W + i] = k;
        rg[j * W + i] = road;
      }
    const out = new Float32Array(N * N);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        // corner (X, Y) touches tiles (X-1..X, Y-1..Y); grid index of tile X is X - x0
        const gi = i + PAD, gj = j + PAD;
        let amp = 0, n = 0;
        for (const [ox, oy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
          const k = g[(gj + oy) * W + gi + ox];
          if (k > 0) { amp += k; n++; }
        }
        if (n < 4) continue; // touches something flat: pinned
        amp /= 4;
        // ring distance to the nearest non-relief tile, and whether a road is that tile
        let d = RAMP, road = false;
        for (let r = 1; r <= RAMP && d === RAMP; r++) {
          for (let ty = gj - 1 - r; ty <= gj + r; ty++)
            for (let tx = gi - 1 - r; tx <= gi + r; tx++) {
              if (Math.max(Math.abs(tx - gi + 0.5), Math.abs(ty - gj + 0.5)) < r) continue;
              if (g[ty * W + tx] <= 0) {
                d = Math.min(d, r);
                if (rg[ty * W + tx]) road = true;
              }
            }
        }
        const X = cx * CHUNK + i, Y = cy * CHUNK + j;
        const nz = (vnoise(X / 9, Y / 9, 1) - 0.5) * 0.9 + (vnoise(X / 3.3, Y / 3.3, 2) - 0.5) * 0.28;
        const t = d / RAMP;
        let h = nz * amp * t * t * (3 - 2 * t);
        // rural roads: a ditch one tile out from the edge
        if (road) h += d === 1 ? -0.3 : d === 2 ? -0.1 : 0;
        out[j * N + i] = Math.max(-0.45, Math.min(0.6, h));
      }
    return out;
  }
}
