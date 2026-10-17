import * as THREE from 'three';
import type { TerrainDef } from '../data/types';
import { CHUNK, LEVEL_HEIGHT, MAX_Z } from '../world/coords';
import type { Chunk, GameMap } from '../world/map';
import { isAir } from '../world/levels';
import { GeomBuilder, type V3 } from './geometry';
import { worldMaterials } from './materials';
import type { TileFrame } from './textureSource';
import { terrainShape } from './tileKinds';

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
/** Tree crowns: from CROWN_LO up to CROWN_HI above the level floor, the top varying per 2x2
 *  tiles by CROWN_VAR (one flat slab read as a green wall where the real trees are crowns).
 *  The mesher's trees are 4.8-5.6 m tall (chunkMesh.ts), their crowns from ~0.4 of that. */
const CROWN_LO = 2, CROWN_HI = 5.6, CROWN_VAR = 0.9;
/** Canopies are lifted like flora.ts lifts its leaf ramp: the sprite's own colours carry baked
 *  shade and outline, and as an average they read dark olive next to the lit 3D crowns. */
const CANOPY_LIFT = 1.45;
/** Under a crown: trunks and undergrowth in its shade. */
const TRUNK_SHADE = 0.4;
/** Hipped roofs of the volume looks (chunkMesh.ts PITCHED, arch.ts hipRoofTile). */
const PITCHED = /^t_(shingle_flat_roof|thatch_roof|tile_flat_roof)$/;
const ROOF_SLOPE = 0.5;
/** floats per quad record: 4 corners, normal, linear rgb */
const QF = 18;
const BLOCK = 4;

const enum K { None, Ground, Slab, Wall, Half, Tree, Shrub }

export interface TileLook {
  kind: K;
  /** linear rgb */
  col: [number, number, number];
  /** a roof the volume looks pitch (hipped) */
  pitched: boolean;
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
              : K.Ground;
  const bright = kind === K.Tree ? bright0 * CANOPY_LIFT : bright0;
  const name = String((t as { color?: unknown }).color ?? '').replace(/^c_/, '');
  const s = art ?? NAMED[name] ?? [120, 120, 120];
  return { kind, col: [lin(s[0]) * bright, lin(s[1]) * bright, lin(s[2]) * bright], pitched: PITCHED.test(t.id) };
}

/**
 * The proxy of one column as quad records (QF floats each: corners a b c d, normal, colour),
 * in world coordinates (x, height, y). `levels[i]` is the chunk at z = i (0 = ground), null for
 * a level with nothing. `cell` = tiles per proxy cell (1, or 2 further out: max height, colour
 * of the tallest tile).
 */
export function buildColumnQuads(cx: number, cy: number, levels: readonly (Chunk | null)[], look: (terIndex: number, z: number) => TileLook, cell = 1, pitch = false): Float32Array {
  const n = CHUNK / cell;
  const H = new Float32Array(n * n).fill(GROUND_Y);
  const top = new Uint32Array(n * n);
  const side = new Uint32Array(n * n);
  /** the top is a ground-level tree crown: its sides hang from CROWN_LO, open below */
  const crown = new Uint8Array(n * n);
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
    for (let ly = 0; ly < CHUNK; ly++)
      for (let lx = 0; lx < CHUNK; lx++) {
        const L = look(c.ter[ly * CHUNK + lx], z);
        let h: number;
        switch (L.kind) {
          case K.None: continue;
          case K.Ground:
            h = z === 0 ? GROUND_Y : L.pitched && pitch ? base + Math.min(roofD[ly * CHUNK + lx] - 0.5, 6) * ROOF_SLOPE : base + 0.1;
            break;
          case K.Wall: h = base + LEVEL_HEIGHT; break;
          case K.Half: h = base + 1; break;
          case K.Tree: h = base + CROWN_HI - CROWN_VAR * hash(Math.floor((cx * CHUNK + lx) / 2), Math.floor((cy * CHUNK + ly) / 2)); break;
          case K.Shrub: h = base + 1; break;
          default: continue;
        }
        const i = Math.floor(ly / cell) * n + Math.floor(lx / cell);
        // ground at z0 always sets a colour; anything else only by standing taller
        if (h > H[i] + 0.01 || (z === 0 && L.kind === K.Ground && H[i] <= GROUND_Y + 0.01 && top[i] === 0)) {
          H[i] = Math.round(h * 20) / 20;
          // crowns vary a little in colour too, like the real canopies' light and shade
          const k = L.kind === K.Tree ? 0.85 + 0.3 * hash(cx * CHUNK + lx + 7, cy * CHUNK + ly) : 1;
          top[i] = pack(k === 1 ? L.col : [L.col[0] * k, L.col[1] * k, L.col[2] * k]) | 0x40000000;
          if (L.kind === K.Wall || L.kind === K.Half || L.kind === K.Tree || L.kind === K.Shrub) side[i] = pack(L.col) | 0x40000000;
          crown[i] = L.kind === K.Tree && z === 0 ? 1 : 0;
        }
      }
  }
  const out: number[] = [];
  const quad = (a: V3, b: V3, c: V3, d: V3, nn: V3, col: V3) => out.push(...a, ...b, ...c, ...d, ...nn, ...col);
  const bx = cx * CHUNK, by = cy * CHUNK;
  // tops: greedy rectangles of equal (height, colour)
  const done = new Uint8Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (done[k] || top[k] === 0) continue;
      const h = H[k], t = top[k];
      let w = 1;
      while (i + w < n && !done[k + w] && H[k + w] === h && top[k + w] === t) w++;
      let d = 1;
      grow: while (j + d < n) {
        for (let q = 0; q < w; q++) {
          const kk = (j + d) * n + i + q;
          if (done[kk] || H[kk] !== h || top[kk] !== t) break grow;
        }
        d++;
      }
      for (let dd = 0; dd < d; dd++) for (let q = 0; q < w; q++) done[(j + dd) * n + i + q] = 1;
      const x0 = bx + i * cell, x1 = bx + (i + w) * cell, z0 = by + j * cell, z1 = by + (j + d) * cell;
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
        if (run >= 0) edge(a, run, end, rlo, rh, unpack(rcol));
        run = -1;
      };
      for (let b = 0; b < n; b++) {
        const i = alongJ ? a : b, j = alongJ ? b : a;
        const k = j * n + i;
        const h = H[k], lo = hAt(i + di, j + dj);
        const sc = side[k] || top[k];
        if (h <= lo + 0.05 || top[k] === 0) { flush(b); continue; }
        if (crown[k]) {
          // a tree: canopy above CROWN_LO, trunks and shade below it (open underneath, the
          // trees' proxies let the eye through to a pale road far behind: a bright line)
          flush(b);
          const c = unpack(sc);
          if (lo < CROWN_LO) edge(a, b, b + 1, lo, Math.min(h, CROWN_LO), [c[0] * TRUNK_SHADE, c[1] * TRUNK_SHADE, c[2] * TRUNK_SHADE]);
          if (h > CROWN_LO + 0.05) edge(a, b, b + 1, Math.max(lo, CROWN_LO), h, c);
          continue;
        }
        if (run >= 0 && h === rh && lo === rlo && sc === rcol) continue;
        flush(b);
        run = b; rh = h; rlo = lo; rcol = sc;
      }
      flush(n);
    }
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
  /** a block takes in new columns at most this often (they arrive at the ring's rim, far off) */
  mergeEveryMs = 500;
  /** debug (cdda.proxyView): draw every proxy, hidden ones too, to compare them with the chunks */
  showAll = false;
  /** true while the chunk streaming is behind: no new proxies then (they only add load) */
  yieldTo: () => boolean = () => false;
  /** linear brightness of the tile averages (by eye against the chunks at the edge) */
  bright = 0.85;
  readonly stats = { columns: 0, built: 0, live: 0, blocks: 0, quads: 0, lastMs: 0, genMs: 0 };
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
      this.cols.delete(k);
      this.markBlock(c.cx, c.cy, false);
    }
    this.merge(true, () => false);
    // No idle time for half a second (a slow machine, a busy city): some progress in the frame.
    // A column near the draw edge without a proxy always gets one (even while the streaming
    // is behind: the proxy is what shows there); the rest share a small budget.
    if (t0 - this.lastIdle > 500) {
      const near = this.scanAt.missing && this.missingWithin(pcx, pcy, R + 3);
      const end = t0 + (this.yieldTo() && !near ? this.budgetMs / 3 : this.budgetMs);
      let first = near;
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
        if (this.at.on && !this.yieldTo()) this.work(() => d.timeRemaining() < 2);
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
      b.mesh = this.meshOf(members, `proxy block ${bx},${by}`);
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
    const quads = buildColumnQuads(cx, cy, levels, (i, z) => this.look(i, maps[z]), cell, this.deps.pitch());
    if (scratchUsed) {
      for (let z = top; z >= 0; z--) if (scratch.hasChunk(cx, cy, z)) scratch.evictChunk(scratch.chunk(cx, cy, z)!);
      (scratch.generator as { forgetColumn?(cx: number, cy: number): void } | null)?.forgetColumn?.(cx, cy);
    }
    const old = this.cols.get(colKey(cx, cy));
    if (old?.stale) this.staleN--;
    if (old) this.dropSolo(old);
    this.cols.set(colKey(cx, cy), { cx, cy, quads, hidden: this.hiddenKeys.has(colKey(cx, cy)), solo: null, live: fromLive, born: performance.now(), stale: false, sig: this.liveSig(cx, cy) });
    this.stats.built++;
    if (fromLive) this.stats.live++;
    this.stats.quads += quads.length / QF;
    this.markBlock(cx, cy, false);
    this.fresh.push([cx, cy]);
  }

  private meshOf(cols: readonly Col[], name: string): THREE.Mesh | null {
    const f = this.deps.white();
    const g = new GeomBuilder();
    const n4: V3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const a: V3 = [0, 0, 0], b: V3 = [0, 0, 0], c: V3 = [0, 0, 0], d: V3 = [0, 0, 0];
    const col = [0, 0, 0];
    for (const cl of cols) {
      const q = cl.quads;
      for (let o = 0; o < q.length; o += QF) {
        a[0] = q[o]; a[1] = q[o + 1]; a[2] = q[o + 2];
        b[0] = q[o + 3]; b[1] = q[o + 4]; b[2] = q[o + 5];
        c[0] = q[o + 6]; c[1] = q[o + 7]; c[2] = q[o + 8];
        d[0] = q[o + 9]; d[1] = q[o + 10]; d[2] = q[o + 11];
        for (const v of n4) { v[0] = q[o + 12]; v[1] = q[o + 13]; v[2] = q[o + 14]; }
        col[0] = q[o + 15]; col[1] = q[o + 16]; col[2] = q[o + 17];
        g.quadEx(a, b, c, d, n4, [0, 0, 1, 1], f, col);
      }
    }
    if (g.vertexCount === 0) return null;
    const mesh = new THREE.Mesh(g.build(), worldMaterials(f.texture).mat);
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
    for (const c of this.cols.values()) this.dropSolo(c);
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
