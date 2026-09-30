import * as THREE from 'three';
import type { Chunk, GameMap } from '../world/map';
import { CHUNK } from '../world/coords';
import { buildChunkMeshSteps, ShapeTable, type ChunkMeshData, type MeshExtras } from './chunkMesh';
import { stepUntil } from './steps';
import { frameStats } from '../perfDebug';
import { puddleMaterial } from './props';
import { worldMaterials } from './materials';
import { glassMaterial } from './furniture/glass';
import type { SpriteLayer, StaticSpriteGroup } from './sprites';
import { LEVEL_HEIGHT } from '../world/coords';
import type { TileTextureSource } from './textureSource';
import { terrainShape } from './tileKinds';

// Keeps chunk meshes around the player in sync with the map:
//  - desired set = chunks within `radius` (circular) on levels [z - below, z + above]
//  - an entry is rebuilt when its signature (own + 6 neighbour chunk versions) changes,
//    since wall faces and slab edges depend on neighbours
//  - rebuilds are nearest-first (chunks behind the camera later) under a strict per-frame
//    time budget: a build is a generator (chunkMesh/trees yield per row / per tree) that
//    may span several frames, the old mesh staying on screen until the new one is done.
//    One volumetric chunk near the player is 5-15 ms of meshing; built in one go it was the
//    30-60 ms frame when sprinting or driving through town under the "full" look.
//  - entries beyond radius + 1 are disposed (hysteresis avoids thrash at borders)

interface Entry {
  cx: number;
  cy: number;
  z: number;
  chunk: Chunk;
  /** own + neighbour chunks whose versions feed the signature */
  deps: (Chunk | null)[];
  sig: number;
  builtSig: number;
  group: THREE.Group | null;
  sprites: StaticSpriteGroup | null;
  visible: boolean;
  d2: number;
  /** inside lodRadius (volumetric trees/props) at the last signature */
  near: boolean;
  /** in-progress (time-sliced) build and the signature it started from */
  job: { gen: Generator<void, void>; sig: number; ver: number; ms: number } | null;
  /** own chunk version at the last finished build (edits vs. LOD/neighbour changes) */
  builtVer: number;
}

export interface ChunkStats {
  entries: number;
  pending: number;
  builtThisFrame: number;
  lastBuildMs: number;
  /** empty (open-air) chunks skipped instead of meshed, cumulative */
  skippedEmpty: number;
  /** first builds of chunks already inside the clearly visible (not fogged) range: pop-in, cumulative */
  lateBuilds: number;
  /** slowest single build (ms) and builds over 8 ms, cumulative (look perf) */
  maxBuildMs: number;
  slowBuilds: number;
  /** of which: mesh data, 3D trees (ms, cumulative) */
  meshMs: number;
  treeMs: number;
  /** most meshing time spent in one frame (ms, cumulative max) and builds finished */
  maxFrameMs: number;
  builds: number;
  /** longest single uninterrupted step (ms) and its phase: the slicing granularity */
  maxStepMs: number;
  maxStep: string;
}

const key = (cx: number, cy: number, z: number) => ((z + 16) * 4096 + (cx + 2048)) * 4096 + (cy + 2048);

export class ChunkManager {
  readonly group = new THREE.Group();
  /** Chunks drawn around the player (circular); post-pass fog hides the edge. */
  radius = 6;
  levelsBelow = 1;
  levelsAbove = 1;
  /** Max milliseconds of meshing per frame (builds are sliced; at least one step runs). */
  budgetMs = 4;
  /** Budget when the player's own surroundings changed (a door opened, a wall smashed):
   *  those should show within a frame or two. */
  urgentBudgetMs = 10;
  /** Camera forward on the ground plane (x, y in tile space), for build priority. */
  readonly forward = { x: 0, y: -1 };
  /** Distance (tiles) inside which a chunk appearing counts as visible pop-in (set by the renderer from the fog). */
  visibleDist = 1e9;
  readonly stats: ChunkStats = { entries: 0, pending: 0, builtThisFrame: 0, lastBuildMs: 0, skippedEmpty: 0, lateBuilds: 0, maxBuildMs: 0, slowBuilds: 0, meshMs: 0, treeMs: 0, maxFrameMs: 0, builds: 0, maxStepMs: 0, maxStep: '' };
  private entries = new Map<number, Entry>();
  private dirty: Entry[] = [];
  private shapes: ShapeTable;
  season: 'spring' | 'summer' | 'autumn' | 'winter' = 'spring';
  /** Per-look mesher inputs (look.ts), read at every build; null = classic. */
  extras: ((near: boolean) => MeshExtras | undefined) | null = null;
  /** Chunks within this many chunk widths get the near-only volumes (0 = none). */
  lodRadius = 0;
  /** Builds extra per-chunk objects from mesh data (3D trees; time-sliced); added to the chunk group. */
  extraObjects: ((data: ChunkMeshData, cx: number, cy: number, z: number) => Generator<void, THREE.Object3D[]>) | null = null;

  constructor(private map: GameMap, private sprites: SpriteLayer, public source: TileTextureSource) {
    this.group.name = 'chunks';
    this.shapes = new ShapeTable(map);
  }

  /** Force every chunk to rebuild (texture source swap, save loaded, season change). */
  invalidateAll(): void {
    for (const e of this.entries.values()) {
      e.builtSig = -1;
      // a half-built job read the old source/look/season: start over
      e.job = null;
      e.deps = this.depsOf(e.cx, e.cy, e.z);
      e.chunk = e.deps[0]!;
    }
  }

  /** Is tile (x,y,z) under a roof/floor (anything on the level above)? Used for ambient. */
  covered(x: number, y: number, z: number): boolean {
    return terrainShape(this.map.terAt(x, y, z + 1)) !== 'none';
  }

  update(px: number, py: number, pz: number, zVisible: (z: number) => boolean, unlimited = false): void {
    const pcx = Math.floor(px / CHUNK), pcy = Math.floor(py / CHUNK);
    const R = this.radius;
    const t0 = performance.now();
    // 1. make sure desired entries exist, nearest first. Creating an entry generates map
    //    chunks (mapgen can be slow), so this shares the frame budget with meshing.
    if (this.offsetsR !== R) this.computeOffsets(R);
    let created = 0;
    outer: for (const [dx, dy] of this.offsets)
      for (let z = pz - this.levelsBelow; z <= pz + this.levelsAbove; z++) {
        const cx = pcx + dx, cy = pcy + dy;
        const k = key(cx, cy, z);
        if (this.entries.has(k)) continue;
        if (!unlimited && created > 0 && performance.now() - t0 > this.budgetMs) break outer;
        const deps = this.depsOf(cx, cy, z);
        if (!deps[0]) continue; // outside MIN_Z..MAX_Z
        created++;
        this.entries.set(k, {
          cx, cy, z, chunk: deps[0], deps, sig: 0, builtSig: -1, group: null, sprites: null,
          visible: true, d2: 0, near: false, job: null, builtVer: -1,
        });
      }
    frameStats.lap('chunks.create');
    // 2. signatures, visibility, eviction
    const dirty = this.dirty;
    dirty.length = 0;
    for (const [k, e] of this.entries) {
      const ddx = e.cx - pcx, ddy = e.cy - pcy;
      if (ddx * ddx + ddy * ddy > (R + 1.5) * (R + 1.5) || e.z < pz - this.levelsBelow - 1 || e.z > pz + this.levelsAbove + 1) {
        this.dispose(e);
        this.entries.delete(k);
        continue;
      }
      const inLevels = e.z >= pz - this.levelsBelow && e.z <= pz + this.levelsAbove;
      const vis = inLevels && zVisible(e.z);
      if (vis !== e.visible) this.setVisible(e, vis);
      let sig = 0;
      for (const d of e.deps) sig = (sig * 31 + (d ? d.version + 1 : 0)) | 0;
      if (this.lodRadius > 0) {
        e.near = ddx * ddx + ddy * ddy <= this.lodRadius * this.lodRadius;
        sig = (sig * 31 + (e.near ? 7 : 3)) | 0;
      }
      e.sig = sig;
      if ((sig !== e.builtSig || e.job) && inLevels) {
        e.d2 = this.priority(e, px, py, pz);
        dirty.push(e);
      }
    }
    // 3. rebuild in priority order under budget; a build may take several frames
    dirty.sort((a, b) => a.d2 - b.d2);
    frameStats.lap('chunks.sig');
    let built = 0;
    const pctx = Math.floor(px / CHUNK), pcty = Math.floor(py / CHUNK);
    for (const e of dirty) {
      // the player's own chunk or a neighbour was edited (a door, a smashed wall): show it
      // promptly. LOD flips (near/far volumes) while moving are not urgent.
      const urgent = e.builtSig !== -1 && e.chunk.version !== e.builtVer && e.z === pz && Math.abs(e.cx - pctx) <= 1 && Math.abs(e.cy - pcty) <= 1;
      const budget = urgent ? this.urgentBudgetMs : this.budgetMs;
      const now = performance.now();
      if (!unlimited && (built > 0 || created > 0) && now - t0 > budget) break;
      if (e.builtSig === -1 && e.z === pz && !e.job) {
        const nx = Math.max(e.cx * CHUNK, Math.min(px, e.cx * CHUNK + CHUNK));
        const ny = Math.max(e.cy * CHUNK, Math.min(py, e.cy * CHUNK + CHUNK));
        if (Math.hypot(nx - px, ny - py) < this.visibleDist) this.stats.lateBuilds++;
      }
      if (!e.job) e.job = { gen: this.buildSteps(e), sig: e.sig, ver: e.chunk.version, ms: 0 };
      const job = e.job;
      const b0 = performance.now();
      const r = stepUntil(job.gen, unlimited ? Infinity : t0 + budget);
      job.ms += performance.now() - b0;
      built++;
      if (!r.done) break;
      // A stale result (the map changed mid-build) still replaces the old mesh; builtSig
      // keeps the job's signature so the entry goes dirty again and rebuilds.
      e.builtSig = job.sig;
      e.builtVer = job.ver;
      e.job = null;
      this.stats.builds++;
      this.stats.lastBuildMs = job.ms;
      this.stats.maxBuildMs = Math.max(this.stats.maxBuildMs, job.ms);
      if (job.ms > 8) this.stats.slowBuilds++;
    }
    this.stats.maxFrameMs = Math.max(this.stats.maxFrameMs, performance.now() - t0);
    this.stats.builtThisFrame = built;
    this.stats.pending = dirty.length - built;
    this.stats.entries = this.entries.size;
  }

  /**
   * Build order: squared chunk distance, other levels a little later, and chunks behind the
   * camera (beyond the player's own ring) later still: they're off screen, while the ones
   * ahead are what a sprint or a car runs into.
   */
  private priority(e: Entry, px: number, py: number, pz: number): number {
    const ccx = e.cx * CHUNK + CHUNK / 2 - px, ccy = e.cy * CHUNK + CHUNK / 2 - py;
    let d2 = (ccx * ccx + ccy * ccy) / (CHUNK * CHUNK) + (e.z === pz ? 0 : 0.5);
    const len = Math.hypot(ccx, ccy);
    if (len > CHUNK * 1.2) {
      const dot = (ccx * this.forward.x + ccy * this.forward.y) / len;
      if (dot < 0) d2 *= 1 + 2.5 * -dot;
    }
    // finish what's started before starting a peer: half-built jobs hold their data
    if (e.job) d2 *= 0.8;
    return d2;
  }

  private offsets: [number, number][] = [];
  private offsetsR = -1;
  private computeOffsets(R: number): void {
    this.offsets = [];
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) if (dx * dx + dy * dy <= (R + 0.5) * (R + 0.5)) this.offsets.push([dx, dy]);
    this.offsets.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
    this.offsetsR = R;
  }

  private depsOf(cx: number, cy: number, z: number): (Chunk | null)[] {
    const m = this.map;
    return [m.chunk(cx, cy, z), m.chunk(cx, cy - 1, z), m.chunk(cx + 1, cy, z), m.chunk(cx, cy + 1, z), m.chunk(cx - 1, cy, z), m.chunk(cx, cy, z + 1), m.chunk(cx, cy, z - 1)];
  }

  /** Charge one uninterrupted build step (since t0) to a phase; tracks the longest step. */
  private stat(phase: 'mesh' | 'geom' | 'tree', t0: number): void {
    const ms = performance.now() - t0;
    if (phase === 'mesh') this.stats.meshMs += ms;
    else if (phase === 'tree') this.stats.treeMs += ms;
    if (ms > this.stats.maxStepMs) {
      this.stats.maxStepMs = ms;
      this.stats.maxStep = phase;
    }
  }

  /** A chunk build as steps: mesh data (per row), 3D trees (per tree), then the swap. */
  private *buildSteps(e: Entry): Generator<void, void> {
    const c = e.chunk;
    // Open sky (most chunks above ground): nothing to mesh. `empty` is maintained by
    // worldgen/setTer; items and fields are checked because addItem/addField don't clear it.
    if (c.empty && c.items.size === 0 && c.fields.size === 0 && c.furn.every((f) => f === 0)) {
      this.dispose(e);
      this.stats.skippedEmpty++;
      return;
    }
    let t0 = performance.now();
    const gen = buildChunkMeshSteps(this.map, this.shapes, this.source, e.chunk, this.season, undefined, this.extras?.(e.near));
    let data: ChunkMeshData;
    for (;;) {
      const r = gen.next();
      if (r.done) { data = r.value; break; }
      this.stat('mesh', t0);
      yield;
      t0 = performance.now();
    }
    this.stat('mesh', t0);
    t0 = performance.now();
    const g = new THREE.Group();
    g.name = `chunk ${e.cx},${e.cy},${e.z}`;
    for (const [page, gb] of data.pages) {
      if (gb.vertexCount === 0) continue;
      const { mat, depth } = worldMaterials(page);
      const mesh = new THREE.Mesh(gb.build(), mat);
      mesh.customDepthMaterial = depth;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      g.add(mesh);
    }
    if (data.puddles && data.puddles.vertexCount) {
      const pm = new THREE.Mesh(data.puddles.build(), puddleMaterial());
      pm.matrixAutoUpdate = false;
      g.add(pm);
    }
    if (data.glass && data.glass.vertexCount) {
      const gm = new THREE.Mesh(data.glass.build(), glassMaterial());
      gm.matrixAutoUpdate = false;
      g.add(gm);
    }
    this.stat('geom', t0);
    if (this.extraObjects) {
      yield;
      t0 = performance.now();
      const tg = this.extraObjects(data, e.cx, e.cy, e.z);
      for (;;) {
        const r = tg.next();
        if (r.done) { for (const o of r.value) g.add(o); break; }
        this.stat('tree', t0);
        yield;
        t0 = performance.now();
      }
      this.stat('tree', t0);
    }
    // swap: the old mesh stayed up while this one was built
    this.dispose(e);
    g.matrixAutoUpdate = false;
    g.visible = e.visible;
    this.group.add(g);
    e.group = g;
    if (data.sprites.length) {
      // chunk-sized bounds (+ tallest sprite) so the whole group frustum-culls
      let top = 1;
      for (const s of data.sprites) top = Math.max(top, s.height + (s.lift ?? 0));
      const bounds = new THREE.Sphere(new THREE.Vector3(e.cx * CHUNK + CHUNK / 2, e.z * LEVEL_HEIGHT + top / 2, e.cy * CHUNK + CHUNK / 2), Math.hypot(CHUNK * 0.75, top / 2) + 2);
      e.sprites = this.sprites.addStatic(data.sprites.map((s) => ({
        x: s.x, y: s.y, z: s.z, frame: s.frame, height: s.height, lift: s.lift ?? 0,
        opacity: s.opacity, fadeNear: s.fadeNear,
      })), bounds);
      if (!e.visible) e.sprites.setVisible(false);
    }
  }

  private setVisible(e: Entry, v: boolean): void {
    e.visible = v;
    if (e.group) e.group.visible = v;
    e.sprites?.setVisible(v);
  }

  private dispose(e: Entry): void {
    if (e.group) {
      for (const c of e.group.children) {
        (c as THREE.Mesh).geometry?.dispose();
        (c.userData as { dispose?: () => void }).dispose?.();
      }
      this.group.remove(e.group);
      e.group = null;
    }
    e.sprites?.dispose();
    e.sprites = null;
  }
}
