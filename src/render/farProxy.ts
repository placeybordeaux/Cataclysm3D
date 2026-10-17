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
/** Tree crowns: a box from CROWN_LO to CROWN_HI above the level floor. */
const CROWN_LO = 2.2, CROWN_HI = 7;
/** floats per quad record: 4 corners, normal, linear rgb */
const QF = 18;
const BLOCK = 4;

const enum K { None, Ground, Slab, Wall, Half, Tree, Shrub }

export interface TileLook {
  kind: K;
  /** linear rgb */
  col: [number, number, number];
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
export function tileLook(t: TerrainDef, art: [number, number, number] | null, bright: number): TileLook {
  const shape = terrainShape(t);
  const kind =
    shape === 'none' ? K.None
      : shape === 'wall' || shape === 'window' || shape === 'door' || shape === 'door_open' ? K.Wall
        : shape === 'halfwall' ? K.Half
          : shape === 'tree' ? K.Tree
            : shape === 'shrub' ? K.Shrub
              : K.Ground;
  const name = String((t as { color?: unknown }).color ?? '').replace(/^c_/, '');
  const s = art ?? NAMED[name] ?? [120, 120, 120];
  return { kind, col: [lin(s[0]) * bright, lin(s[1]) * bright, lin(s[2]) * bright] };
}

/**
 * The proxy of one column as quad records (QF floats each: corners a b c d, normal, colour),
 * in world coordinates (x, height, y). `levels[i]` is the chunk at z = i (0 = ground), null for
 * a level with nothing. `cell` = tiles per proxy cell (1, or 2 further out: max height, colour
 * of the tallest tile).
 */
export function buildColumnQuads(cx: number, cy: number, levels: readonly (Chunk | null)[], look: (terIndex: number) => TileLook, cell = 1): Float32Array {
  const n = CHUNK / cell;
  const H = new Float32Array(n * n).fill(GROUND_Y);
  const top = new Uint32Array(n * n);
  const side = new Uint32Array(n * n);
  /** the top is a ground-level tree crown: its sides hang from CROWN_LO, open below */
  const crown = new Uint8Array(n * n);
  const pack = (c: readonly number[]) => (Math.round(c[0] * 1023) << 20) | (Math.round(c[1] * 1023) << 10) | Math.round(c[2] * 1023);
  const unpack = (p: number): V3 => [((p >>> 20) & 1023) / 1023, ((p >>> 10) & 1023) / 1023, (p & 1023) / 1023];
  for (let z = 0; z < levels.length; z++) {
    const c = levels[z];
    if (!c) continue;
    const base = z * LEVEL_HEIGHT;
    for (let ly = 0; ly < CHUNK; ly++)
      for (let lx = 0; lx < CHUNK; lx++) {
        const L = look(c.ter[ly * CHUNK + lx]);
        let h: number;
        switch (L.kind) {
          case K.None: continue;
          case K.Ground: h = z === 0 ? GROUND_Y : base + 0.1; break;
          case K.Wall: h = base + LEVEL_HEIGHT; break;
          case K.Half: h = base + 1; break;
          case K.Tree: h = base + CROWN_HI; break;
          case K.Shrub: h = base + 1; break;
          default: continue;
        }
        const i = Math.floor(ly / cell) * n + Math.floor(lx / cell);
        // ground at z0 always sets a colour; anything else only by standing taller
        if (h > H[i] + 0.01 || (z === 0 && L.kind === K.Ground && H[i] <= GROUND_Y + 0.01 && top[i] === 0)) {
          H[i] = Math.round(h * 20) / 20;
          top[i] = pack(L.col) | 0x40000000;
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
    for (let a = 0; a < n; a++) {
      let run = -1, rh = 0, rlo = 0, rcol = 0;
      const flush = (end: number) => {
        if (run < 0) return;
        const col = unpack(rcol);
        if (alongJ) {
          const x = bx + (di > 0 ? a + 1 : a) * cell, z0 = by + run * cell, z1 = by + end * cell;
          if (di > 0) quad([x, rlo, z1], [x, rlo, z0], [x, rh, z0], [x, rh, z1], nrm, col);
          else quad([x, rlo, z0], [x, rlo, z1], [x, rh, z1], [x, rh, z0], nrm, col);
        } else {
          const z = by + (dj > 0 ? a + 1 : a) * cell, x0 = bx + run * cell, x1 = bx + end * cell;
          if (dj > 0) quad([x0, rlo, z], [x1, rlo, z], [x1, rh, z], [x0, rh, z], nrm, col);
          else quad([x1, rlo, z], [x0, rlo, z], [x0, rh, z], [x1, rh, z], nrm, col);
        }
        run = -1;
      };
      for (let b = 0; b < n; b++) {
        const i = alongJ ? a : b, j = alongJ ? b : a;
        const k = j * n + i;
        const h = H[k], lo = hAt(i + di, j + dj);
        const sc = side[k] || top[k];
        if (h <= lo + 0.05 || top[k] === 0) { flush(b); continue; }
        const bottom = crown[k] ? Math.max(lo, CROWN_LO) : lo;
        if (h <= bottom + 0.05) { flush(b); continue; }
        if (run >= 0 && h === rh && bottom === rlo && sc === rcol) continue;
        flush(b);
        run = b; rh = h; rlo = bottom; rcol = sc;
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
}

interface Block {
  mesh: THREE.Mesh | null;
  dirty: boolean;
  /** a member was hidden, shown or taken solo: re-merge this frame (else it overlaps the chunks) */
  urgent: boolean;
  /** performance.now() of the last merge */
  at: number;
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
  /** atlas average sRGB of a terrain id */
  art(id: string): [number, number, number] | null;
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
  private blocks = new Map<number, Block>();
  private looks: (TileLook | undefined)[] = [];
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
    let L = this.looks[i];
    if (!L) {
      const t = map.terrain.get(i);
      L = tileLook(t, this.deps.art(t.id), this.bright);
      this.looks[i] = L;
    }
    return L;
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
      this.markBlock(cx, cy);
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
    // leaving the drawn area: rebuild from the live chunks (edits made while it was drawn)
    if (!hidden && this.deps.live.hasChunk(cx, cy, 0)) {
      this.cols.delete(colKey(cx, cy));
      this.scanAt.missing = true;
    }
    this.markBlock(cx, cy);
  }

  /** Back into its block (a fade-in finished, or it was abandoned). */
  unsolo(cx: number, cy: number): void {
    const c = this.cols.get(colKey(cx, cy));
    if (c) this.dropSolo(c);
  }

  private dropSolo(c: Col): void {
    if (!c.solo) return;
    this.group.remove(c.solo);
    c.solo.geometry.dispose();
    c.solo = null;
    this.markBlock(c.cx, c.cy);
  }

  private markBlock(cx: number, cy: number, urgent = true): void {
    const k = blockKey(cx, cy);
    let b = this.blocks.get(k);
    if (!b) this.blocks.set(k, (b = { mesh: null, dirty: true, urgent, at: 0 }));
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
      this.dropSolo(c);
      this.cols.delete(k);
      this.markBlock(c.cx, c.cy, false);
    }
    this.merge(true, () => false);
    // no idle time for half a second (a slow machine, a busy city): some progress in the frame
    if (t0 - this.lastIdle > 500 && !this.yieldTo()) {
      const end = t0 + this.budgetMs;
      this.work(() => performance.now() > end);
    }
    this.stats.columns = this.cols.size;
    this.stats.blocks = this.blocks.size;
    this.stats.lastMs = performance.now() - t0;
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
      this.lastIdle = performance.now();
      // a column is 0.1-1 ms; start one only with room left
      if (this.at.on && !this.yieldTo()) this.work(() => d.timeRemaining() < 2);
      ric(loop);
    };
    ric(loop);
  }

  /** Columns nearest first (ahead before behind), then lazy block merges, until `stop()`. */
  private work(stop: () => boolean): void {
    const { pcx, pcy, fx, fy } = this.at;
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
      const members: Col[] = [];
      for (let y = 0; y < BLOCK; y++)
        for (let x = 0; x < BLOCK; x++) {
          const c = this.cols.get(colKey(bx * BLOCK + x, by * BLOCK + y));
          if (c && !c.hidden && !c.solo && c.quads.length) members.push(c);
        }
      if (!members.length) {
        this.blocks.delete(k);
        continue;
      }
      b.mesh = this.meshOf(members, `proxy block ${bx},${by}`);
      if (b.mesh) this.group.add(b.mesh);
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
    const map = fromLive ? live : scratch;
    const t0 = performance.now();
    const levels: (Chunk | null)[] = [];
    for (let z = 0; z <= top; z++) {
      // the live map: only what exists (generating there would fire its hooks)
      const c = fromLive ? (live.hasChunk(cx, cy, z) ? live.chunk(cx, cy, z) : null) : scratch.chunk(cx, cy, z);
      levels.push(c && !c.empty ? c : null);
    }
    if (!fromLive) this.stats.genMs += performance.now() - t0;
    const quads = buildColumnQuads(cx, cy, levels, (i) => this.look(i, map), cell);
    if (!fromLive) {
      for (let z = top; z >= 0; z--) if (scratch.hasChunk(cx, cy, z)) scratch.evictChunk(scratch.chunk(cx, cy, z)!);
      (scratch.generator as { forgetColumn?(cx: number, cy: number): void } | null)?.forgetColumn?.(cx, cy);
    }
    this.cols.set(colKey(cx, cy), { cx, cy, quads, hidden: this.hiddenKeys.has(colKey(cx, cy)), solo: null, live: fromLive, born: performance.now() });
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

  /** Drop everything (look/season change, teleport, load: the next updates rebuild). */
  clear(): void {
    for (const c of this.cols.values()) this.dropSolo(c);
    for (const b of this.blocks.values()) if (b.mesh) { this.group.remove(b.mesh); b.mesh.geometry.dispose(); }
    this.cols.clear();
    this.blocks.clear();
    this.hiddenKeys.clear();
    this.looks = [];
    this.scanAt.missing = true;
  }
}

/** Column top level from the overmap: the highest OMT that isn't air, plus its roof. */
export function overmapTopOf(omtAt: (x: number, y: number, z: number) => { id: string }, cx: number, cy: number): number {
  for (let z = MAX_Z; z > 0; z--) if (!isAir(omtAt(cx, cy, z).id)) return Math.min(MAX_Z, z + 1);
  return 1;
}
