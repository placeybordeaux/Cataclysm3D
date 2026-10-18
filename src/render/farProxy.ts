import * as THREE from 'three';
import type { TerrainDef } from '../data/types';
import { CHUNK, LEVEL_HEIGHT, MAX_Z } from '../world/coords';
import type { Chunk, GameMap } from '../world/map';
import { isAir } from '../world/levels';
import type { V3 } from './geometry';
import { worldMaterials } from './materials';
import type { TileFrame } from './textureSource';
import { terrainShape } from './tileKinds';
import { boundsOf, layoutOf, speciesOf } from './flora';

interface CrownShape {
  /** radius, top and underside above the tree's floor (m) */
  r: number;
  top: number;
  bot: number;
}
const crownShapes = new Map<string, CrownShape>();
/** The crown of a tree terrain id as flora.ts builds it (averaged over its layout variants). */
export function crownShape(id: string): CrownShape {
  let c = crownShapes.get(id);
  if (c) return c;
  const sp = speciesOf(id, false);
  const H = sp.family === 'sapling' ? Math.max(1.6, Math.min(2.8, TREE_H * 1.6)) : TREE_H * sp.scale;
  let hw = 0, top = 0, bot = 0;
  for (let v = 0; v < 3; v++) {
    const L = layoutOf(sp.family, v, false);
    const b = boundsOf(L);
    let lo = 1;
    for (const l of L.lumps) lo = Math.min(lo, l.c[1] - l.r[1]);
    for (const k of L.cones) lo = Math.min(lo, k.y0);
    hw += b.hw / 3;
    top += b.top / 3;
    bot += (lo === 1 ? 0.35 : Math.max(0.05, lo)) / 3;
  }
  c = { r: Math.max(0.5, hw * H), top: top * H, bot: bot * H };
  crownShapes.set(id, c);
  return c;
}

// Far proxies (docs/FAR_LOD.md): a low-poly stand-in for every column out to ~1.75x the draw
// distance, built from the real map instead of the overmap. Per tile: the top of what stands
// there across the column's levels (walls a storey each, roofs and floors as slabs, tree
// crowns) and the colour of its art (the atlas average), greedy-merged into boxes. At the
// draw-distance edge the real chunk then lands on a building that already has its footprint,
// height and roof colour, instead of rising out of the bare far ground ring.
//
// Columns nobody has generated come from a second generator writing into a scratch map with
// no chunk hooks (no monsters, vehicles, NPCs or save tracking happen out there), then dropped
// again: generation is deterministic per seed and chunk, so it is the same terrain the live
// map will make. Columns the live map has (you have been there) are read from it, edits
// included.
//
// Drawn through the world material (lighting, haze and draw-distance fade match the chunks)
// with the white atlas frame and vertex colours, merged per BLOCK x BLOCK columns: ~600
// columns would otherwise be ~600 draw calls.

/** Proxy ground sits under the real ground (relief dips to -0.45 m in the terrain look). */
const GROUND_Y = -0.2;
/**
 * Tree crowns, sized like the 3D trees (flora.ts): the mesher's height (4.8-5.64 m, mean
 * TREE_H, chunkMesh.ts) times the species' scale, the crown's radius, top and underside from
 * the species' layout, domed and spread over every tile it covers. A proxy one tile wide at a
 * fixed 5.6 m left a real forest's continuous 5-8 m canopy full of holes (proxyQa).
 */
const TREE_H = 5.22;
const CROWN_LO = 2;
/** Canopies are lifted like flora.ts lifts its leaf ramp: the sprite's own colours carry baked
 *  shade and outline, and as an average they read dark olive next to the lit 3D crowns. */
const CANOPY_LIFT = 1.45;
/** Under a crown: trunks and undergrowth in its shade. */
const TRUNK_SHADE = 0.4;
/** Hipped roofs of the volume looks (chunkMesh.ts PITCHED, arch.ts hipRoofTile). */
const PITCHED = /^t_(shingle_flat_roof|thatch_roof|tile_flat_roof)$/;
const ROOF_SLOPE = 0.5;
/** floats per quad record: 4 corners, normal, linear rgb, kind (QK) */
const QF = 19;
/** What a quad belongs to (proxyQa compares buildings and trees separately). */
export const QK = { build: 0, crown: 1, mast: 2 } as const;
const BLOCK = 4;

/** Lattice: see-through impassable terrain (railings, fences, radio tower girders). */
const enum K { None, Ground, Slab, Wall, Half, Tree, Shrub, Lattice }
/** A floor or roof with no wall under it (bridge deck, catwalk, overhang) is this thick. */
const SLAB = 0.3;
/** A lattice stacked over this many levels or more is a mast: drawn as a thin post per tile. */
const MAST_LEVELS = 2;
const MAST_W = 0.3;

export interface TileLook {
  kind: K;
  /** linear rgb */
  col: [number, number, number];
  /** a roof the volume looks pitch (hipped) */
  pitched: boolean;
  /** trees: the crown */
  crown: CrownShape | null;
}

/** CDDA colour names for terrain without art (procedural sources, missing sprites). */
const NAMED: Record<string, [number, number, number]> = {
  white: [200, 200, 200], light_gray: [150, 150, 150], dark_gray: [90, 90, 90], brown: [110, 80, 50],
  green: [60, 110, 50], light_green: [90, 150, 70], blue: [60, 80, 140], light_blue: [110, 140, 190],
  red: [140, 50, 40], light_red: [190, 90, 80], yellow: [190, 170, 80], cyan: [70, 140, 150], magenta: [140, 60, 140],
};

const lin = (c: number) => Math.pow(c / 255, 2.2);

/**
 * What a terrain tile contributes to a proxy, and its colour. `art` = the atlas average sRGB
 * (0-255) of the id, or null. `bright` scales the linear colour: tile art is drawn with baked
 * AO and banded light, a flat average would read a little lighter than the chunk next to it.
 */
export function tileLook(t: TerrainDef, art: [number, number, number] | null, bright0: number): TileLook {
  const shape = terrainShape(t);
  const kind =
    shape === 'none' ? K.None
      : shape === 'wall' || shape === 'window' || shape === 'door' || shape === 'door_open' ? K.Wall
        : shape === 'halfwall' ? K.Half
          : shape === 'tree' ? K.Tree
            : shape === 'shrub' ? K.Shrub
              : shape === 'fence' ? K.Lattice
                : K.Ground;
  const bright = kind === K.Tree ? bright0 * CANOPY_LIFT : bright0;
  const name = String((t as { color?: unknown }).color ?? '').replace(/^c_/, '');
  const s = art ?? NAMED[name] ?? [120, 120, 120];
  return { kind, col: [lin(s[0]) * bright, lin(s[1]) * bright, lin(s[2]) * bright], pitched: PITCHED.test(t.id), crown: kind === K.Tree ? crownShape(t.id) : null };
}

/**
 * The proxy of one column as quad records (QF floats each: corners a b c d, normal, colour, QK kind),
 * in world coordinates (x, height, y). `levels[i]` is the chunk at z = i (0 = ground), null for
 * a level with nothing. `cell` = tiles per proxy cell (1, or 2 further out: max height, colour
 * of the tallest tile).
 */
export function buildColumnQuads(cx: number, cy: number, levels: readonly (Chunk | null)[], look: (terIndex: number, z: number) => TileLook, cell = 1, pitch = false): Float32Array {
  const n = CHUNK / cell;
  const H = new Float32Array(n * n).fill(GROUND_Y);
  const top = new Uint32Array(n * n);
  const side = new Uint32Array(n * n);
  /** the top is a tree crown: its sides hang from crownBot (trunk shade below, see edge) */
  const crown = new Uint8Array(n * n);
  const crownBot = new Float32Array(n * n);
  /** trees, rasterised as crowns after the levels (they spread over their neighbours) */
  const trees: { x: number; y: number; base: number; c: CrownShape; col: [number, number, number] }[] = [];
  /**
   * The top is a floor or roof with no wall right under it: its sides are a SLAB-thick edge,
   * not a wall to the ground (NaN = stands on the ground). Without it a bridge deck, a catwalk
   * or a radio tower's platforms read as a solid block.
   */
  const floatBot = new Float32Array(n * n).fill(NaN);
  /** per tile: the level below had a wall there (what a slab on top rests on) */
  let wallBelow = new Uint8Array(CHUNK * CHUNK), wallHere = new Uint8Array(CHUNK * CHUNK);
  /** per tile: lattice levels (lowest, highest, how many) and its colour */
  const latLo = new Int8Array(CHUNK * CHUNK).fill(127), latHi = new Int8Array(CHUNK * CHUNK).fill(-1), latN = new Uint8Array(CHUNK * CHUNK);
  const latCol = new Uint32Array(CHUNK * CHUNK);
  const q = (v: number) => Math.max(0, Math.min(1023, Math.round(v * 1023)));
  const pack = (c: readonly number[]) => (q(c[0]) << 20) | (q(c[1]) << 10) | q(c[2]);
  const unpack = (p: number): V3 => [((p >>> 20) & 1023) / 1023, ((p >>> 10) & 1023) / 1023, (p & 1023) / 1023];
  /** `pitch`: per tile of a pitched roof region, tiles to its edge (Chebyshev, within the column) */
  const roofD = new Uint8Array(CHUNK * CHUNK);
  const hash = (x: number, y: number) => {
    let h = Math.imul(x * 374761393 + y * 668265263, 1274126177);
    h ^= h >>> 13;
    return ((h >>> 0) % 1000) / 1000;
  };
  for (let z = 0; z < levels.length; z++) {
    const c = levels[z];
    if (!c) continue;
    const base = z * LEVEL_HEIGHT;
    if (pitch && z > 0) {
      // distance to the nearest non-pitched tile (or the column edge), as arch.ts slopes it
      let any = false;
      for (let i = 0; i < CHUNK * CHUNK; i++) {
        const p = look(c.ter[i], z).pitched;
        roofD[i] = p ? 255 : 0;
        any ||= p;
      }
      if (any)
        for (let pass = 0; pass < 6; pass++)
          for (let ly = 0; ly < CHUNK; ly++)
            for (let lx = 0; lx < CHUNK; lx++) {
              const i = ly * CHUNK + lx;
              if (roofD[i] === 0) continue;
              let m = 255;
              for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++) {
                  const x = lx + dx, y = ly + dy;
                  m = Math.min(m, x < 0 || y < 0 || x >= CHUNK || y >= CHUNK ? 0 : roofD[y * CHUNK + x]);
                }
              roofD[i] = Math.min(roofD[i], m + 1);
            }
    }
    wallHere.fill(0);
    for (let ly = 0; ly < CHUNK; ly++)
      for (let lx = 0; lx < CHUNK; lx++) {
        const L = look(c.ter[ly * CHUNK + lx], z);
        const ti = ly * CHUNK + lx;
        if (L.kind === K.Wall || L.kind === K.Half) wallHere[ti] = 1;
        let h: number;
        switch (L.kind) {
          case K.None: continue;
          case K.Lattice:
            latLo[ti] = Math.min(latLo[ti], z);
            latHi[ti] = Math.max(latHi[ti], z);
            latN[ti]++;
            latCol[ti] = pack(L.col);
            continue;
          case K.Ground:
            h = z === 0 ? GROUND_Y : L.pitched && pitch ? base + Math.min(roofD[ly * CHUNK + lx] - 0.5, 6) * ROOF_SLOPE : base + 0.1;
            break;
          case K.Wall: h = base + LEVEL_HEIGHT; break;
          case K.Half: h = base + 1; break;
          case K.Tree:
            trees.push({ x: lx + 0.5, y: ly + 0.5, base, c: L.crown!, col: L.col });
            continue;
          case K.Shrub: h = base + 1; break;
          default: continue;
        }
        const i = Math.floor(ly / cell) * n + Math.floor(lx / cell);
        // ground at z0 always sets a colour; anything else only by standing taller
        if (h > H[i] + 0.01 || (z === 0 && L.kind === K.Ground && H[i] <= GROUND_Y + 0.01 && top[i] === 0)) {
          H[i] = Math.round(h * 20) / 20;
          top[i] = pack(L.col) | 0x40000000;
          if (L.kind === K.Wall || L.kind === K.Half || L.kind === K.Shrub) side[i] = pack(L.col) | 0x40000000;
          crown[i] = 0;
          floatBot[i] = L.kind === K.Ground && z > 0 && !wallBelow[ti] ? H[i] - SLAB : NaN;
        }
      }
    [wallBelow, wallHere] = [wallHere, wallBelow];
  }
  // crowns: a dome over every cell centre within the radius, the highest wins
  for (const t of trees) {
    const R = t.c.r;
    const shade = 0.85 + 0.3 * hash(Math.floor(cx * CHUNK + t.x), Math.floor(cy * CHUNK + t.y) + 7);
    const col = pack([t.col[0] * shade, t.col[1] * shade, t.col[2] * shade]) | 0x40000000;
    const i0 = Math.max(0, Math.floor((t.x - R) / cell)), i1 = Math.min(n - 1, Math.floor((t.x + R) / cell));
    const j0 = Math.max(0, Math.floor((t.y - R) / cell)), j1 = Math.min(n - 1, Math.floor((t.y + R) / cell));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot((i + 0.5) * cell - t.x, (j + 0.5) * cell - t.y);
        if (d > R) continue;
        const u = d / R;
        const h = Math.round((t.base + t.c.bot + (t.c.top - t.c.bot) * Math.sqrt(1 - u * u)) * 20) / 20;
        const k = j * n + i;
        if (h <= H[k] + 0.01) continue;
        H[k] = h;
        top[k] = col;
        side[k] = col;
        crown[k] = 1;
        crownBot[k] = t.base + t.c.bot;
        floatBot[k] = NaN;
      }
  }
  const out: number[] = [];
  let kind: number = QK.build;
  const quad = (a: V3, b: V3, c: V3, d: V3, nn: V3, col: V3) => out.push(...a, ...b, ...c, ...d, ...nn, ...col, kind);
  const bx = cx * CHUNK, by = cy * CHUNK;
  // tops: greedy rectangles of equal (height, colour)
  const done = new Uint8Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (done[k] || top[k] === 0) continue;
      const h = H[k], t = top[k];
      let w = 1;
      while (i + w < n && !done[k + w] && H[k + w] === h && top[k + w] === t && crown[k + w] === crown[k]) w++;
      let d = 1;
      grow: while (j + d < n) {
        for (let q = 0; q < w; q++) {
          const kk = (j + d) * n + i + q;
          if (done[kk] || H[kk] !== h || top[kk] !== t || crown[kk] !== crown[k]) break grow;
        }
        d++;
      }
      for (let dd = 0; dd < d; dd++) for (let q = 0; q < w; q++) done[(j + dd) * n + i + q] = 1;
      const x0 = bx + i * cell, x1 = bx + (i + w) * cell, z0 = by + j * cell, z1 = by + (j + d) * cell;
      kind = crown[k] ? QK.crown : QK.build;
      quad([x0, h, z1], [x1, h, z1], [x1, h, z0], [x0, h, z0], [0, 1, 0], unpack(t));
    }
  // sides: where a cell stands above its neighbour (outside the column: the ground), merged
  // along the edge while (top, bottom, colour) stay the same
  const hAt = (i: number, j: number) => (i < 0 || j < 0 || i >= n || j >= n ? GROUND_Y : H[j * n + i]);
  const colAt = (k: number) => unpack(side[k] || top[k]);
  // +x / -x faces run along j; +z / -z along i
  for (const [di, dj, nrm] of [[1, 0, [1, 0, 0]], [-1, 0, [-1, 0, 0]], [0, 1, [0, 0, 1]], [0, -1, [0, 0, -1]]] as [number, number, V3][]) {
    const alongJ = di !== 0;
    /** the face along edge row `a` from cell b0 to b1, between heights lo and hi */
    const edge = (a: number, b0: number, b1: number, lo: number, hi: number, col: V3) => {
      if (alongJ) {
        const x = bx + (di > 0 ? a + 1 : a) * cell, z0 = by + b0 * cell, z1 = by + b1 * cell;
        if (di > 0) quad([x, lo, z1], [x, lo, z0], [x, hi, z0], [x, hi, z1], nrm, col);
        else quad([x, lo, z0], [x, lo, z1], [x, hi, z1], [x, hi, z0], nrm, col);
      } else {
        const z = by + (dj > 0 ? a + 1 : a) * cell, x0 = bx + b0 * cell, x1 = bx + b1 * cell;
        if (dj > 0) quad([x0, lo, z], [x1, lo, z], [x1, hi, z], [x0, hi, z], nrm, col);
        else quad([x1, lo, z], [x0, lo, z], [x0, hi, z], [x1, hi, z], nrm, col);
      }
    };
    for (let a = 0; a < n; a++) {
      let run = -1, rh = 0, rlo = 0, rcol = 0;
      const flush = (end: number) => {
        kind = QK.build;
        if (run >= 0) edge(a, run, end, rlo, rh, unpack(rcol));
        run = -1;
      };
      for (let b = 0; b < n; b++) {
        const i = alongJ ? a : b, j = alongJ ? b : a;
        const k = j * n + i;
        const h = H[k], lo = hAt(i + di, j + dj);
        const sc = side[k] || top[k];
        if (h <= lo + 0.05 || top[k] === 0) { flush(b); continue; }
        const fb = floatBot[k];
        if (!Number.isNaN(fb)) {
          // a floating deck: its edge only
          flush(b);
          if (h > Math.max(lo, fb) + 0.05) edge(a, b, b + 1, Math.max(lo, fb), h, unpack(sc));
          continue;
        }
        if (crown[k]) {
          // a tree: canopy above CROWN_LO, trunks and shade below it (open underneath, the
          // trees' proxies let the eye through to a pale road far behind: a bright line)
          flush(b);
          kind = QK.crown;
          const c = unpack(sc), cb = Math.max(crownBot[k], CROWN_LO * 0.5);
          if (lo < cb) edge(a, b, b + 1, lo, Math.min(h, cb), [c[0] * TRUNK_SHADE, c[1] * TRUNK_SHADE, c[2] * TRUNK_SHADE]);
          if (h > cb + 0.05) edge(a, b, b + 1, Math.max(lo, cb), h, c);
          continue;
        }
        if (run >= 0 && h === rh && lo === rlo && sc === rcol) continue;
        flush(b);
        run = b; rh = h; rlo = lo; rcol = sc;
      }
      flush(n);
    }
  }
  // masts: a lattice stacked over levels (radio towers) as thin posts, one per tile
  kind = QK.mast;
  for (let ti = 0; ti < CHUNK * CHUNK; ti++) {
    if (latN[ti] < MAST_LEVELS) continue;
    const x = bx + (ti % CHUNK) + 0.5, zc = by + Math.floor(ti / CHUNK) + 0.5, w = MAST_W / 2;
    const lo = latLo[ti] === 0 ? GROUND_Y : latLo[ti] * LEVEL_HEIGHT, hi = (latHi[ti] + 1) * LEVEL_HEIGHT;
    const c0 = unpack(latCol[ti]), col: V3 = [c0[0] * 0.8, c0[1] * 0.8, c0[2] * 0.8];
    const x0 = x - w, x1 = x + w, z0 = zc - w, z1 = zc + w;
    quad([x0, lo, z1], [x1, lo, z1], [x1, hi, z1], [x0, hi, z1], [0, 0, 1], col);
    quad([x1, lo, z0], [x0, lo, z0], [x0, hi, z0], [x1, hi, z0], [0, 0, -1], col);
    quad([x1, lo, z1], [x1, lo, z0], [x1, hi, z0], [x1, hi, z1], [1, 0, 0], col);
    quad([x0, lo, z0], [x0, lo, z1], [x0, hi, z1], [x0, hi, z0], [-1, 0, 0], col);
    quad([x0, hi, z1], [x1, hi, z1], [x1, hi, z0], [x0, hi, z0], [0, 1, 0], col);
  }
  return Float32Array.from(out);
}

/**
 * The part of a column's quads above height `y` (farLod.ts caps: the storeys the chunks don't
 * draw). Proxy quads are axis-aligned: tops are kept if above `y`; walls are cut at `y` (the
 * corners below it raised to it) and dropped when wholly below.
 */
export function clipQuads(quads: Float32Array, y: number): Float32Array {
  const out: number[] = [];
  for (let o = 0; o < quads.length; o += QF) {
    const ny = quads[o + 13];
    let lo = Infinity, hi = -Infinity;
    for (let v = 0; v < 4; v++) {
      lo = Math.min(lo, quads[o + v * 3 + 1]);
      hi = Math.max(hi, quads[o + v * 3 + 1]);
    }
    if (hi <= y + 0.01) continue;
    const q = Array.from(quads.subarray(o, o + QF));
    if (Math.abs(ny) < 0.5 && lo < y) for (let v = 0; v < 4; v++) q[v * 3 + 1] = Math.max(q[v * 3 + 1], y);
    out.push(...q);
  }
  return Float32Array.from(out);
}

interface Col {
  cx: number;
  cy: number;
  quads: Float32Array;
  /** excluded from its block: the real chunks show (hidden) or it fades on its own (solo) */
  hidden: boolean;
  solo: THREE.Mesh | null;
  /** built from the live map (true) or the scratch generator */
  live: boolean;
  /** performance.now() when it was built (fade-in) */
  born: number;
  /** drawn but out of date (its chunks were shown and may have been edited): rebuilt from the
   *  live map in idle time, the old proxy staying up meanwhile */
  stale: boolean;
  /** live chunks it was built from: levels present and their versions (liveSig) */
  sig: number;
  /** while hidden behind its chunks: the part above what they draw (a tower's top storeys) */
  cap: { y: number; mesh: THREE.Mesh | null; quads: Float32Array } | null;
}

interface Block {
  mesh: THREE.Mesh | null;
  /** members added, dropped or rebuilt since the last merge */
  dirty: boolean;
  /** a member that must be drawn isn't in the merged mesh: re-merge this frame (else a hole) */
  urgent: boolean;
  /** performance.now() of the last merge */
  at: number;
  /**
   * Each member's vertices in the merged mesh (4 per quad, in quad order) and the quads they
   * were made from. Hiding a column (its chunks show, or it fades on its own) collapses its
   * vertices in place, showing it writes them back: no re-merge, which cost 1-2 ms a block
   * and happened at every hand-off (~20 a second at 40 mph).
   */
  ranges: Map<number, { start: number; quads: Float32Array }>;
}

const colKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);
const blockKey = (cx: number, cy: number) => colKey(Math.floor(cx / BLOCK), Math.floor(cy / BLOCK));

export interface FarProxyDeps {
  /** the live map (columns you have been to are read from it) */
  live: GameMap;
  /** a hook-free map whose generator shares the live world's seed and overmap */
  scratch: GameMap;
  /** column top level (overmap: the top OMT that isn't air, + its roof) */
  overmapTop(cx: number, cy: number): number;
  white(): TileFrame;
  /** atlas average sRGB of a terrain id (`top`: of the sprite's top, a tree's canopy) */
  art(id: string, part?: 'top'): [number, number, number] | null;
  /** the look pitches shingle/thatch/tile roofs (look.f.archDetail) */
  pitch(): boolean;
}

export class FarProxyLayer {
  readonly group = new THREE.Group();
  enabled = true;
  /** outer edge of the ring, as a multiple of the draw radius */
  radiusMul = 1.75;
  /** beyond this many chunks, 2x2-tile cells */
  coarseFrom = 11;
  /** ms per frame for building proxies when the browser gives no idle time (startIdle) */
  budgetMs = 0.75;
  /** the same while the player stands still (a load, a teleport: frames have room, the ring is empty) */
  stillBudgetMs = 4;
  /** player speed (m/s), for the budget (farLodInstall.ts sets it from the chunk manager) */
  speed: () => number = () => 0;
  /** a block takes in new columns at most this often (they arrive at the ring's rim, far off) */
  mergeEveryMs = 500;
  /** debug (cdda.proxyView): draw every proxy, hidden ones too, to compare them with the chunks */
  showAll = false;
  /** true while the chunk streaming is behind: no new proxies then (they only add load) */
  yieldTo: () => boolean = () => false;
  /** linear brightness of the tile averages (by eye against the chunks at the edge) */
  bright = 0.85;
  readonly stats = { columns: 0, built: 0, live: 0, blocks: 0, quads: 0, lastMs: 0, genMs: 0, buildMs: 0, mergeMs: 0, idleRuns: 0, frameRuns: 0 };
  private cols = new Map<number, Col>();
  /**
   * Columns the hand-off has hidden (their chunks show), by key, whether or not their proxy
   * exists right now: one rebuilt later (from the live map, after a mode switch, after a
   * drop) must come back hidden, or it is drawn over the real chunks.
   */
  private hiddenKeys = new Set<number>();
  private staleN = 0;
  private blocks = new Map<number, Block>();
  /** by terrain id: the live and scratch maps' registries may number them differently */
  private looks = new Map<string, TileLook>();
  private offsets: [number, number][] = [];
  private offsetsR = -1;
  /** the ring is only rescanned after moving to another chunk or while columns are missing */
  private scanAt = { cx: NaN, cy: NaN, missing: true };

  constructor(private deps: FarProxyDeps) {
    this.group.name = 'far proxies';
    this.group.matrixAutoUpdate = false;
  }

  /** Outer radius (chunks) for draw radius R. */
  outer(R: number): number {
    return R * this.radiusMul;
  }

  private look(i: number, map: GameMap): TileLook {
    const t = map.terrain.get(i);
    let L = this.looks.get(t.id);
    if (!L) {
      L = tileLook(t, this.deps.art(t.id, terrainShape(t) === 'tree' ? 'top' : undefined), this.bright);
      this.looks.set(t.id, L);
    }
    return L;
  }

  /** Debug (cdda.proxyCheck): highest point of column (cx, cy)'s proxy, NaN without one. */
  proxyTop(cx: number, cy: number): number {
    const c = this.cols.get(colKey(cx, cy));
    if (!c) return NaN;
    let top = -Infinity;
    for (let o = 0; o < c.quads.length; o += QF) for (let v = 0; v < 4; v++) top = Math.max(top, c.quads[o + v * 3 + 1]);
    return top;
  }

  /** Debug (cdda.farLod tower check): the highest point this layer draws of column (cx, cy) now. */
  drawnTop(cx: number, cy: number): number {
    const c = this.cols.get(colKey(cx, cy));
    if (!c) return -Infinity;
    if (!c.hidden || c.solo) return this.proxyTop(cx, cy);
    if (c.cap?.mesh) {
      let top = -Infinity;
      const q = clipQuads(c.quads, c.cap.y);
      for (let o = 0; o < q.length; o += QF) for (let v = 0; v < 4; v++) top = Math.max(top, q[o + v * 3 + 1]);
      return top;
    }
    return -Infinity;
  }

  /**
   * Debug (cdda.proxyQa): per tile of column (cx, cy), the height of the proxy's top faces
   * (-Infinity where none), as drawn: the full proxy, not a cap. Null without a proxy.
   */
  heightmap(cx: number, cy: number, only?: 'build' | 'crown', scratchOnly = false): Float32Array | null {
    const c = this.cols.get(colKey(cx, cy));
    if (!c) return null;
    const H = new Float32Array(CHUNK * CHUNK).fill(-Infinity);
    // scratchOnly: the proxy as it is before you get there (all from the scratch generator)
    const q = scratchOnly ? this.scratchQuads(cx, cy) : c.quads, bx = cx * CHUNK, by = cy * CHUNK;
    for (let o = 0; o < q.length; o += QF) {
      if (q[o + 13] < 0.5) continue;
      if (only === 'build' && q[o + 18] === QK.crown) continue;
      if (only === 'crown' && q[o + 18] !== QK.crown) continue;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let v = 0; v < 4; v++) {
        x0 = Math.min(x0, q[o + v * 3]); x1 = Math.max(x1, q[o + v * 3]);
        z0 = Math.min(z0, q[o + v * 3 + 2]); z1 = Math.max(z1, q[o + v * 3 + 2]);
      }
      const y = q[o + 1];
      // tiles whose centre the face covers (a mast's 0.3 m top covers its tile's centre)
      for (let tz = Math.floor(z0 - by); tz < Math.ceil(z1 - by); tz++)
        for (let tx = Math.floor(x0 - bx); tx < Math.ceil(x1 - bx); tx++) {
          if (tx < 0 || tz < 0 || tx >= CHUNK || tz >= CHUNK) continue;
          const cxm = bx + tx + 0.5, czm = by + tz + 0.5;
          if (cxm < x0 - 0.01 || cxm > x1 + 0.01 || czm < z0 - 0.01 || czm > z1 + 0.01) continue;
          const i = tz * CHUNK + tx;
          H[i] = Math.max(H[i], y);
        }
    }
    return H;
  }

  /** Debug (proxyQa): column (cx, cy)'s quads from the scratch generator alone, as before a visit. */
  private scratchQuads(cx: number, cy: number): Float32Array {
    const { scratch } = this.deps;
    const top = Math.max(0, Math.min(MAX_Z, this.deps.overmapTop(cx, cy)));
    const levels: (Chunk | null)[] = [];
    for (let z = 0; z <= top; z++) {
      const ch = scratch.chunk(cx, cy, z);
      levels.push(ch && !ch.empty ? ch : null);
    }
    const q = buildColumnQuads(cx, cy, levels, (i) => this.look(i, scratch), 1, this.deps.pitch());
    for (let z = top; z >= 0; z--) if (scratch.hasChunk(cx, cy, z)) scratch.evictChunk(scratch.chunk(cx, cy, z)!);
    (scratch.generator as { forgetColumn?(cx: number, cy: number): void } | null)?.forgetColumn?.(cx, cy);
    return q;
  }

  /** Debug (cdda.proxyColumn): how column (cx, cy)'s proxy was made. */
  describe(cx: number, cy: number): { live: boolean; stale: boolean; hidden: boolean; quads: number; top: number } | null {
    const c = this.cols.get(colKey(cx, cy));
    return c ? { live: c.live, stale: c.stale, hidden: c.hidden, quads: c.quads.length / QF, top: this.proxyTop(cx, cy) } : null;
  }

  /** Is column (cx, cy) drawn as a proxy right now (built and not hidden)? */
  drawn(cx: number, cy: number): boolean {
    const c = this.cols.get(colKey(cx, cy));
    return !!c && !c.hidden;
  }

  /** Proxy column (cx, cy)'s geometry exists (it may be empty: open ground still has a top). */
  has(cx: number, cy: number): boolean {
    return this.cols.has(colKey(cx, cy));
  }

  /**
   * Build column (cx, cy)'s proxy now if it has none (the hand-off needs a cover: after a load
   * or teleport the ring is still filling). True if it exists afterwards.
   */
  ensure(cx: number, cy: number): boolean {
    if (this.cols.has(colKey(cx, cy))) return true;
    if (!this.enabled) return false;
    this.buildColumn(cx, cy, 1);
    return true;
  }

  /**
   * Take column (cx, cy) out of its block into a mesh of its own, for a fade (farLod.ts).
   * Null when it has no proxy (not built yet). The caller sets the fade on it.
   */
  solo(cx: number, cy: number): THREE.Mesh | null {
    const c = this.cols.get(colKey(cx, cy));
    if (!c || !c.quads.length) return null;
    if (!c.solo) {
      c.solo = this.meshOf([c], `proxy ${cx},${cy}`);
      if (c.solo) this.group.add(c.solo);
      this.applyVis(c);
    }
    return c.solo;
  }

  /** Hide column (cx, cy) (its real chunks show) or show it again (they were dropped). */
  setHidden(cx: number, cy: number, hidden: boolean): void {
    const k = colKey(cx, cy);
    if (hidden) this.hiddenKeys.add(k);
    else this.hiddenKeys.delete(k);
    const c = this.cols.get(k);
    if (!c) return;
    this.dropSolo(c);
    if (!hidden) this.dropCap(c);
    if (c.hidden === hidden) return;
    c.hidden = hidden;
    // Back from its chunks: if they differ from what it was built of (levels built since, a
    // tower top; edits), rebuild from them in idle time. The old proxy stays drawn until then
    // (deleting it left a hole for as long as the idle time took to come round).
    if (!hidden && !c.stale && this.liveSig(cx, cy) !== c.sig) {
      c.stale = true;
      this.staleN++;
    }
    this.applyVis(c);
  }

  /** Drawn in its block: not hidden behind its chunks (unless debug showAll) and not solo. */
  private inBlock(c: Col): boolean {
    return (!c.hidden || this.showAll) && !c.solo;
  }

  /** Show or collapse column `c`'s vertices in its block's mesh to match inBlock(c). */
  private applyVis(c: Col): void {
    const b = this.blocks.get(blockKey(c.cx, c.cy));
    const r = b?.ranges.get(colKey(c.cx, c.cy));
    const want = this.inBlock(c);
    if (!b?.mesh || !r || r.quads !== c.quads) {
      // not in the merged mesh as it is now: hidden is already right, shown needs a merge now
      if (want) this.markBlock(c.cx, c.cy, true);
      return;
    }
    const pos = b.mesh.geometry.attributes.position as THREE.BufferAttribute;
    const a = pos.array as Float32Array;
    const q = c.quads, nv = (q.length / QF) * 4;
    for (let v = 0; v < nv; v++) {
      const o = (r.start + v) * 3, src = Math.floor(v / 4) * QF + (v % 4) * 3;
      if (want) {
        a[o] = q[src]; a[o + 1] = q[src + 1]; a[o + 2] = q[src + 2];
      } else {
        // all four corners on one point far below: zero-area triangles, nothing drawn
        a[o] = q[0]; a[o + 1] = -1000; a[o + 2] = q[2];
      }
    }
    pos.addUpdateRange(r.start * 3, nv * 3);
    pos.needsUpdate = true;
  }

  /**
   * Draw the part of column (cx, cy)'s proxy above height `y` on its own (its chunks draw
   * the levels below; a tower's upper storeys are only built nearer, and not at all while
   * driving), or no cap (null). Cheap to call every frame: only a new `y` or a rebuilt
   * proxy changes anything.
   */
  setCap(cx: number, cy: number, y: number | null): void {
    const c = this.cols.get(colKey(cx, cy));
    if (!c) return;
    if (y === null) {
      this.dropCap(c);
      return;
    }
    if (c.cap && Math.abs(c.cap.y - y) < 0.01 && c.cap.quads === c.quads) return;
    this.dropCap(c);
    const part = clipQuads(c.quads, y);
    const cl: Col = { ...c, quads: part };
    const mesh = part.length ? this.meshOf([cl], `proxy cap ${cx},${cy}`) : null;
    if (mesh) this.group.add(mesh);
    c.cap = { y, mesh, quads: c.quads };
  }

  private dropCap(c: Col): void {
    if (!c.cap) return;
    if (c.cap.mesh) {
      this.group.remove(c.cap.mesh);
      c.cap.mesh.geometry.dispose();
    }
    c.cap = null;
  }

  /** Back into its block (a fade-in finished, or it was abandoned). */
  unsolo(cx: number, cy: number): void {
    const c = this.cols.get(colKey(cx, cy));
    if (c) this.dropSolo(c);
  }

  /** Signature of the live chunks of column (cx, cy) up to its top: which exist, their versions. */
  private liveSig(cx: number, cy: number): number {
    const live = this.deps.live;
    const top = Math.max(0, Math.min(MAX_Z, this.deps.overmapTop(cx, cy)));
    let h = 17;
    for (let z = 0; z <= top; z++) h = (Math.imul(h, 31) + (live.hasChunk(cx, cy, z) ? live.chunk(cx, cy, z)!.version + 1 : 0)) | 0;
    return h;
  }

  private dropSolo(c: Col): void {
    if (!c.solo) return;
    this.group.remove(c.solo);
    c.solo.geometry.dispose();
    c.solo = null;
    this.applyVis(c);
  }

  private markBlock(cx: number, cy: number, urgent = true): void {
    const k = blockKey(cx, cy);
    let b = this.blocks.get(k);
    if (!b) this.blocks.set(k, (b = { mesh: null, dirty: true, urgent, at: 0, ranges: new Map() }));
    b.dirty = true;
    b.urgent ||= urgent;
  }

  /** Columns built since the consumer last emptied this (farLod.ts fades them in). */
  readonly fresh: [number, number][] = [];

  /** last update's player chunk and view direction (idle work builds around them) */
  private at = { pcx: 0, pcy: 0, fx: 0, fy: -1, on: false };
  private idleRunning = false;
  private lastIdle = 0;

  /**
   * Per frame: only what can't wait. Columns out of range go (after a move), and blocks whose
   * members the hand-off just hid or took solo are re-merged (else they would overlap the
   * chunks). Building proxies and merging new ones happen in idle time (startIdle), or here
   * if the browser has had no idle time for a while.
   */
  update(px: number, py: number, pz: number, R: number, forward: { x: number; y: number }): void {
    const on = this.enabled && pz >= 0;
    this.group.visible = on;
    this.at.on = on;
    if (!on) return;
    const t0 = performance.now();
    const pcx = Math.floor(px / CHUNK), pcy = Math.floor(py / CHUNK);
    const outer = this.outer(R);
    if (this.offsetsR !== outer) this.computeOffsets(outer);
    const moved = pcx !== this.scanAt.cx || pcy !== this.scanAt.cy;
    this.scanAt.cx = pcx;
    this.scanAt.cy = pcy;
    if (moved) this.scanAt.missing = true;
    const fl = Math.hypot(forward.x, forward.y) || 1;
    this.at.pcx = pcx; this.at.pcy = pcy; this.at.fx = forward.x / fl; this.at.fy = forward.y / fl;
    const keep = (outer + 1.5) * (outer + 1.5);
    if (moved) for (const [k, c] of this.cols) {
      if ((c.cx - pcx) ** 2 + (c.cy - pcy) ** 2 <= keep) continue;
      if (c.stale) this.staleN--;
      this.dropSolo(c);
      this.dropCap(c);
      this.cols.delete(k);
      this.markBlock(c.cx, c.cy, false);
    }
    this.merge(true, () => false);
    // No idle time for half a second (a slow machine, a busy city): some progress in the frame.
    // A column near the draw edge without a proxy always gets one (even while the streaming
    // is behind: the proxy is what shows there); the rest share a small budget.
    if (t0 - this.lastIdle > 500) {
      const near = this.scanAt.missing && this.missingWithin(pcx, pcy, R + 3);
      const still = this.speed() < 1;
      const end = t0 + (still ? this.stillBudgetMs : this.yieldTo() && !near ? this.budgetMs / 3 : this.budgetMs);
      let first = near;
      this.stats.frameRuns++;
      this.work(() => (first ? ((first = false), false) : performance.now() > end));
    }
    this.stats.columns = this.cols.size;
    this.stats.blocks = this.blocks.size;
    this.stats.lastMs = performance.now() - t0;
  }

  /** Is a column within `r` chunks without a proxy? (offsets are nearest first) */
  private missingWithin(pcx: number, pcy: number, r: number): boolean {
    for (const [dx, dy] of this.offsets) {
      if (dx * dx + dy * dy > r * r) return false;
      if (!this.cols.has(colKey(pcx + dx, pcy + dy))) return true;
    }
    return false;
  }

  /** Build missing proxies and merge waiting blocks in the browser's idle time. */
  startIdle(): void {
    if (this.idleRunning) return;
    this.idleRunning = true;
    const ric: (cb: (d: { timeRemaining(): number }) => void) => void =
      typeof requestIdleCallback === 'function'
        ? (cb) => requestIdleCallback(cb, { timeout: 500 })
        : (cb) => setTimeout(() => cb({ timeRemaining: () => 8 }), 16);
    const loop = (d: { timeRemaining(): number }) => {
      // a column is 0.1-1 ms; start one only with room left. Only an idle period with room
      // counts as idle time (a busy page gets callbacks with ~0 ms left, all frame long)
      if (d.timeRemaining() >= 2) {
        this.lastIdle = performance.now();
        if (this.at.on && !this.yieldTo()) {
          this.stats.idleRuns++;
          this.work(() => d.timeRemaining() < 2);
        }
      }
      ric(loop);
    };
    ric(loop);
  }

  /** Columns nearest first (ahead before behind), then lazy block merges, until `stop()`. */
  private work(stop: () => boolean): void {
    const { pcx, pcy, fx, fy } = this.at;
    // one overdue block first: building alone could take every slot, and a built column only
    // shows once its block is merged
    let one = false;
    this.merge(false, () => (one ? true : ((one = true), false)));
    if (this.scanAt.missing) {
      let missing = false;
      scan: for (let pass = 0; pass < 2; pass++)
        for (const [dx, dy] of this.offsets) {
          const ahead = dx * fx + dy * fy >= -0.5 * Math.hypot(dx, dy);
          if ((pass === 0) !== ahead) continue;
          const cx = pcx + dx, cy = pcy + dy;
          if (this.cols.has(colKey(cx, cy))) continue;
          if (stop()) {
            missing = true;
            break scan;
          }
          this.buildColumn(cx, cy, Math.hypot(dx, dy) > this.coarseFrom ? 2 : 1);
        }
      this.scanAt.missing = missing;
    }
    if (this.staleN > 0 && !this.scanAt.missing)
      for (const c of this.cols.values()) {
        if (!c.stale) continue;
        if (stop()) break;
        const d = Math.hypot(c.cx - pcx, c.cy - pcy);
        this.buildColumn(c.cx, c.cy, d > this.coarseFrom ? 2 : 1);
      }
    if (!stop()) this.merge(false, stop);
  }

  /** Re-merge dirty blocks: the urgent ones only, or (lazy) the rest at most every mergeEveryMs. */
  private merge(urgentOnly: boolean, stop: () => boolean): void {
    const t1 = performance.now();
    for (const [k, b] of this.blocks) {
      if (!b.dirty) continue;
      if (urgentOnly ? !b.urgent : t1 - b.at < this.mergeEveryMs) continue;
      if (!urgentOnly && stop()) break;
      b.dirty = false;
      b.urgent = false;
      b.at = t1;
      if (b.mesh) {
        this.group.remove(b.mesh);
        b.mesh.geometry.dispose();
        b.mesh = null;
      }
      const bx = Math.floor(k / 65536) - 32768, by = (k % 65536) - 32768;
      // every built column, hidden and solo ones too (collapsed below): showing and hiding
      // them later needs no re-merge
      const members: Col[] = [];
      for (let y = 0; y < BLOCK; y++)
        for (let x = 0; x < BLOCK; x++) {
          const c = this.cols.get(colKey(bx * BLOCK + x, by * BLOCK + y));
          if (c && c.quads.length) members.push(c);
        }
      b.ranges.clear();
      if (!members.length) {
        this.blocks.delete(k);
        continue;
      }
      let start = 0;
      for (const c of members) {
        b.ranges.set(colKey(c.cx, c.cy), { start, quads: c.quads });
        start += (c.quads.length / QF) * 4;
      }
      const tm = performance.now();
      b.mesh = this.meshOf(members, `proxy block ${bx},${by}`);
      this.stats.mergeMs += performance.now() - tm;
      if (b.mesh) {
        this.group.add(b.mesh);
        for (const c of members) if (!this.inBlock(c)) this.applyVis(c);
      }
    }
  }

  private computeOffsets(R: number): void {
    const out: [number, number][] = [];
    const r = Math.ceil(R);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= R * R) out.push([dx, dy]);
    out.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
    this.offsets = out;
    this.offsetsR = R;
  }

  private buildColumn(cx: number, cy: number, cell: number): void {
    const { live, scratch } = this.deps;
    const top = Math.max(0, Math.min(MAX_Z, this.deps.overmapTop(cx, cy)));
    const fromLive = live.hasChunk(cx, cy, 0);
    const t0 = performance.now();
    const levels: (Chunk | null)[] = [];
    const maps: GameMap[] = [];
    // Each level from the live map when it has it (edits included; generating there would fire
    // its hooks), else from the scratch generator: the live map often has only the lower
    // storeys (tower tops aren't built while driving), and a proxy from those alone was short.
    let scratchUsed = false;
    for (let z = 0; z <= top; z++) {
      let c: Chunk | null;
      if (live.hasChunk(cx, cy, z)) {
        c = live.chunk(cx, cy, z);
        maps.push(live);
      } else {
        c = scratch.chunk(cx, cy, z);
        maps.push(scratch);
        scratchUsed = true;
      }
      levels.push(c && !c.empty ? c : null);
    }
    if (scratchUsed) this.stats.genMs += performance.now() - t0;
    const tq = performance.now();
    const quads = buildColumnQuads(cx, cy, levels, (i, z) => this.look(i, maps[z]), cell, this.deps.pitch());
    this.stats.buildMs += performance.now() - tq;
    if (scratchUsed) {
      for (let z = top; z >= 0; z--) if (scratch.hasChunk(cx, cy, z)) scratch.evictChunk(scratch.chunk(cx, cy, z)!);
      (scratch.generator as { forgetColumn?(cx: number, cy: number): void } | null)?.forgetColumn?.(cx, cy);
    }
    const old = this.cols.get(colKey(cx, cy));
    if (old?.stale) this.staleN--;
    if (old) this.dropSolo(old);
    if (old) this.dropCap(old);
    this.cols.set(colKey(cx, cy), { cx, cy, quads, hidden: this.hiddenKeys.has(colKey(cx, cy)), solo: null, live: fromLive, born: performance.now(), stale: false, sig: this.liveSig(cx, cy), cap: null });
    this.stats.built++;
    if (fromLive) this.stats.live++;
    this.stats.quads += quads.length / QF;
    this.markBlock(cx, cy, false);
    this.fresh.push([cx, cy]);
  }

  /**
   * One mesh of the columns' quads, the same attributes GeomBuilder.quadEx makes (white frame,
   * vertex colours, no cut, full sky), written straight from the quad records: through
   * GeomBuilder a 16-column block cost about as much as building the columns.
   */
  private meshOf(cols: readonly Col[], name: string): THREE.Mesh | null {
    let nq = 0;
    for (const cl of cols) nq += cl.quads.length / QF;
    if (nq === 0) return null;
    const f = this.deps.white();
    const nv = nq * 4;
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2), rect = new Float32Array(nv * 4), cut = new Float32Array(nv), sky = new Float32Array(nv).fill(1);
    const index = nv > 65535 ? new Uint32Array(nq * 6) : new Uint16Array(nq * 6);
    const du = f.uv[2] - f.uv[0], dv = f.uv[3] - f.uv[1];
    let v = 0, ii = 0;
    for (const cl of cols) {
      const q = cl.quads;
      for (let o = 0; o < q.length; o += QF) {
        for (let k = 0; k < 4; k++, v++) {
          pos[v * 3] = q[o + k * 3]; pos[v * 3 + 1] = q[o + k * 3 + 1]; pos[v * 3 + 2] = q[o + k * 3 + 2];
          nrm[v * 3] = q[o + 12]; nrm[v * 3 + 1] = q[o + 13]; nrm[v * 3 + 2] = q[o + 14];
          col[v * 3] = q[o + 15]; col[v * 3 + 1] = q[o + 16]; col[v * 3 + 2] = q[o + 17];
          uv[v * 2] = k === 1 || k === 2 ? 1 : 0;
          uv[v * 2 + 1] = k >= 2 ? 1 : 0;
          rect[v * 4] = f.uv[0]; rect[v * 4 + 1] = f.uv[1]; rect[v * 4 + 2] = du; rect[v * 4 + 3] = dv;
        }
        const b = v - 4;
        index[ii++] = b; index[ii++] = b + 1; index[ii++] = b + 2;
        index[ii++] = b; index[ii++] = b + 2; index[ii++] = b + 3;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('uvRect', new THREE.BufferAttribute(rect, 4));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('cut', new THREE.BufferAttribute(cut, 1));
    g.setAttribute('skyVis', new THREE.BufferAttribute(sky, 1));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    const mesh = new THREE.Mesh(g, worldMaterials(f.texture).mat);
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = name;
    return mesh;
  }

  /** Mark every block for an immediate re-merge (debug view switches). */
  remergeAll(): void {
    for (const b of this.blocks.values()) { b.dirty = true; b.urgent = true; }
    for (const c of this.cols.values()) this.markBlock(c.cx, c.cy);
  }

  /** Drop everything (look/season change, teleport, load: the next updates rebuild). */
  clear(): void {
    for (const c of this.cols.values()) {
      this.dropSolo(c);
      this.dropCap(c);
    }
    for (const b of this.blocks.values()) if (b.mesh) { this.group.remove(b.mesh); b.mesh.geometry.dispose(); }
    this.cols.clear();
    this.blocks.clear();
    this.hiddenKeys.clear();
    this.staleN = 0;
    this.looks.clear();
    this.scanAt.missing = true;
  }
}

/** Column top level from the overmap: the highest OMT that isn't air, plus its roof. */
export function overmapTopOf(omtAt: (x: number, y: number, z: number) => { id: string }, cx: number, cy: number): number {
  for (let z = MAX_Z; z > 0; z--) if (!isAir(omtAt(cx, cy, z).id)) return Math.min(MAX_Z, z + 1);
  return 1;
}
