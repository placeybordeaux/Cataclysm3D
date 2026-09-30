import * as THREE from 'three';
import type { Chunk, GameMap } from '../world/map';
import { CHUNK } from '../world/coords';
import { buildChunkMeshSteps, ShapeTable, type ChunkMeshData, type MeshExtras } from './chunkMesh';
import type { TreeSpec } from './trees';
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
//  - desired set = chunks within `radius` (circular) on levels [z - below, z + above], and
//    above ground the ground level and the storeys up to the player too (levelRadius)
//  - an entry is rebuilt when its signature (own + 6 neighbour chunk versions) changes,
//    since wall faces and slab edges depend on neighbours
//  - rebuilds are nearest-first (chunks behind the camera later) under a strict per-frame
//    time budget: a build is a generator (chunkMesh/trees yield per row / per tree) that
//    may span several frames, the old mesh staying on screen until the new one is done.
//    One volumetric chunk near the player is 5-15 ms of meshing; built in one go it was the
//    30-60 ms frame when sprinting or driving through town under the "full" look.
//  - entries beyond radius + 1 are disposed (hysteresis avoids thrash at borders)
//  - schedule 'need' (default, docs/PERF.md): chunks are built in the order they will be
//    *needed* — unbuilt chunks in view first, then by the seconds until the player's motion
//    brings them inside the fog — and LOD flips are cosmetic refinements done only when the
//    world ahead is built. Driving through town used to spend two thirds of the meshing on
//    near-ring LOD flips while the road ahead stayed unbuilt for 10-20 s. 'distance' is the
//    wave-3 order (squared distance, chunks behind the camera later).

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
  /** inside midRadius but not lodRadius */
  mid?: boolean;
  /** in-progress (time-sliced) build and the signature it started from */
  job: { gen: Generator<void, void>; sig: number; vsig: number; near: boolean; ver: number; ms: number; t0: number; kind: 'full' | 'trees' } | null;
  /** own chunk version at the last finished build (edits vs. LOD/neighbour changes) */
  builtVer: number;
  /** a build has finished at least once (invalidateAll keeps the old mesh up; this stays) */
  shown?: boolean;
  /** trees of the last build and the objects built from them, and the middle-ring state they
   *  were built for: a middle-ring flip rebuilds only these (treeSteps), not the chunk */
  trees?: TreeSpec[];
  treeObjs?: THREE.Object3D[];
  treeMid?: boolean;
  /** performance.now() when the entry entered the wanted set (telemetry: queue age) */
  wantT: number;
  /** chunk versions only (sig without the LOD flag), and at the last finished full build */
  vsig: number;
  builtVsig: number;
  /** near flag of the last finished full build */
  builtNear?: boolean;
  /** 'need' schedule: what this frame's work on the entry is (see classify) */
  cls: WorkClass;
}

/**
 * Why an entry needs work: never shown (a hole), content changed (an edit, an overlay, a
 * neighbour, invalidateAll), or only its LOD changed (up = entered the near ring, down = left
 * it, trees = crossed the flora middle ring). The last three are cosmetic.
 */
type WorkClass = 'hole' | 'edit' | 'up' | 'down' | 'trees';

/** What telemetry (src/perf) may read of an entry. */
export type ChunkEntryView = Readonly<Pick<Entry, 'cx' | 'cy' | 'z' | 'shown' | 'wantT' | 'visible' | 'job'>>;

/**
 * Optional observer (src/perf/telemetry.ts). Called only when installed, so an idle game pays
 * one null check per event.
 */
export interface ChunkProbe {
  want(cx: number, cy: number, z: number): void;
  /** a build finished: `first` = the chunk had never been shown; `ms` = work, `wall` = start to finish */
  built(cx: number, cy: number, z: number, first: boolean, ms: number, wall: number, kind: 'full' | 'trees' | 'empty', waitMs: number): void;
  drop(cx: number, cy: number, z: number, shown: boolean): void;
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
  /** this frame: ms spent creating entries (mapgen of missing map chunks) and in total */
  frameCreateMs: number;
  frameMs: number;
}

/**
 * Chunk radius drawn on level `z` with the player on `pz`, or -1 for "not drawn".
 *
 * Around the player: [pz - below, pz + above] at the full radius R. Above ground (pz > 0) the
 * ground itself and every storey between it and the player are drawn too: from a rooftop the
 * street is most of the view, and with only one level below it was a flat sheet of haze under
 * floating buildings (docs/PERF.md "Above ground"). Most of those chunks are open air, skipped
 * without meshing, so the cost is the buildings you actually see. Up a tower the storeys in
 * between are many; past `fullGap` of them the middle ones (not the ground, z=1 or the two just
 * under the player's window) get a smaller radius: far lower storeys of far towers are hidden
 * behind the near ones and the fog anyway.
 * Basements (pz < 0) keep the window: you shouldn't see the surface through the ground.
 */
export function levelRadius(z: number, pz: number, R: number, below: number, above: number, fullGap = 4, ground = true): number {
  if (z >= pz - below && z <= pz + above) return R;
  if (!ground || pz <= 0 || z < 0 || z > pz) return -1;
  if (z === 0) return R;
  const gap = pz - below - 1; // storeys strictly between the ground and the player's window
  if (gap <= fullGap || z === 1 || z >= pz - below - 2) return R;
  return Math.max(2, Math.ceil(R / 2));
}

/** Lowest level levelRadius() can draw with the player on `pz`. */
export function lowestLevel(pz: number, below: number, ground = true): number {
  return ground && pz > 0 ? Math.min(0, pz - below) : pz - below;
}

const key = (cx: number, cy: number, z: number) => ((z + 16) * 4096 + (cx + 2048)) * 4096 + (cy + 2048);

export class ChunkManager {
  readonly group = new THREE.Group();
  /** Chunks drawn around the player (circular); post-pass fog hides the edge. */
  radius = 6;
  levelsBelow = 1;
  levelsAbove = 1;
  /** Above ground: 'ground' (default) also draws the ground and the storeys down to it;
   *  'window' = only [z - below, z + above] (the old behaviour; ?below=window, cdda.drawBelow). */
  below: 'ground' | 'window' = 'ground';
  /** Max milliseconds of meshing per frame (builds are sliced; at least one step runs). */
  budgetMs = 4;
  /** Budget when the player's own surroundings changed (a door opened, a wall smashed):
   *  those should show within a frame or two. */
  urgentBudgetMs = 10;
  /** Camera forward on the ground plane (x, y in tile space), for build priority. */
  readonly forward = { x: 0, y: -1 };
  /** Build order: 'need' (default) or 'distance' (the wave-3 order); ?stream=, cdda.streamSchedule. */
  schedule: 'need' | 'distance' = 'need';
  /** 'need': budget while an unbuilt chunk is in view or about to be (catching up beats a steady frame rate). */
  boostBudgetMs = 8;
  /**
   * 'need': the budgets grow into the frame's slack (interval minus our main loop, smoothed,
   * less a margin): streaming throughput is budget x frame rate, so when frames are long for
   * other reasons (a slow GPU, presenting a big window, a city at 30 fps with room left in the
   * vsync slot) a fixed 4 ms built the world several times slower than the time allowed. A
   * share of the slack, not all of it: the loop grows with the budget, which shrinks the
   * slack (self-limiting), where a share of the *interval* fed back on itself (city p99 50 ->
   * 83 ms in the benchmark). Floors budgetMs / boostBudgetMs, caps 12 / 20 ms.
   */
  slackShare = 0.5;
  /**
   * 'need', after a load or teleport: while the player's own 3x3 is unbuilt the view is
   * curtained (nearChunks.ts), there is nothing to keep smooth, so builds get this much per
   * frame and entries are made for the 3x3 only (a load used to create all ~900 wanted entries
   * first — mapgen for every level out to 168 m — at 8 ms a frame while the near builds got
   * the 1-2 ms left over: 1.5 s to the first near chunk in Chromium, 4 s in Firefox).
   */
  curtainBudgetMs = 40;
  /**
   * 'need': budget while unbuilt chunks are in view and the player stands still (after a load,
   * a teleport, an Options change that rebuilds everything): watching the town assemble at
   * ~40 fps for a few seconds beats watching it at 60 fps for twice as long. Moving, the boost
   * budget applies instead (driving stays smooth).
   */
  settleBudgetMs = 16;
  /** 'need': creating entries (mapgen) may take this share of the budget while builds are pending */
  createShare = 0.5;
  /** the view is curtained this frame (telemetry) */
  curtained = false;
  private pendingLast = 0;
  private curtainSince = -1;
  boostSlackShare = 0.7;
  /** budget in force this frame (telemetry) */
  effBudgetMs = 4;
  private ivEma = 1000 / 60;
  private loopEma = 8;
  private lastUpdateT = 0;
  /** Half the camera's horizontal field of view (rad), for "in view" (the renderer keeps it current). */
  viewHalf = 1.1;
  /** Player velocity (tiles/s), smoothed from positions between updates. */
  readonly vel = { x: 0, y: 0 };
  /** 'need': an unbuilt chunk is in view or needed within half a second (the boost budget applies) */
  behind = false;
  private lastPos: { x: number; y: number; t: number } | null = null;
  /** Distance (tiles) inside which a chunk appearing counts as visible pop-in (set by the renderer from the fog). */
  visibleDist = 1e9;
  readonly stats: ChunkStats = { entries: 0, pending: 0, builtThisFrame: 0, lastBuildMs: 0, skippedEmpty: 0, lateBuilds: 0, maxBuildMs: 0, slowBuilds: 0, meshMs: 0, treeMs: 0, maxFrameMs: 0, builds: 0, maxStepMs: 0, maxStep: '', frameCreateMs: 0, frameMs: 0 };
  private entries = new Map<number, Entry>();
  private dirty: Entry[] = [];
  private shapes: ShapeTable;
  season: 'spring' | 'summer' | 'autumn' | 'winter' = 'spring';
  /** Per-look mesher inputs (look.ts), read at every build; null = classic. */
  extras: ((near: boolean) => MeshExtras | undefined) | null = null;
  /** Chunks within this many chunk widths get the near-only volumes (0 = none). */
  lodRadius = 0;
  /** Beyond lodRadius and within this: the middle ring (flora.ts lighter trees; 0 = none). */
  midRadius = 0;
  /** Builds extra per-chunk objects from mesh data (3D trees; time-sliced); added to the chunk group. */
  extraObjects: ((data: ChunkMeshData, cx: number, cy: number, z: number) => Generator<void, THREE.Object3D[]>) | null = null;

  /** Telemetry observer (src/perf), null when off. */
  probe: ChunkProbe | null = null;

  constructor(private map: GameMap, private sprites: SpriteLayer, public source: TileTextureSource) {
    this.group.name = 'chunks';
    this.shapes = new ShapeTable(map);
  }

  /**
   * Chunks on level `pz` within one chunk of the player that have never been built (a
   * teleport or load). While any exist their builds are urgent and the view stays curtained.
   */
  nearUnbuilt(px: number, py: number, pz: number): number {
    const pcx = Math.floor(px / CHUNK), pcy = Math.floor(py / CHUNK);
    let n = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const e = this.entries.get(key(pcx + dx, pcy + dy, pz));
        if (!e || !e.shown) n++;
      }
    return n;
  }

  /** Every entry (wanted chunk) as telemetry sees it. */
  forEachEntry(fn: (e: ChunkEntryView) => void): void {
    for (const e of this.entries.values()) fn(e);
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

  /** Rebuild one chunk's mesh (keeps the old one up meanwhile): a stair flight solved next door. */
  invalidateChunk(cx: number, cy: number, z: number): void {
    const e = this.entries.get(key(cx, cy, z));
    if (!e) return;
    e.builtSig = -1;
    e.job = null;
  }

  /**
   * Is the chunk's mesh current (built after the last change / invalidateChunk)? Chunks not in
   * range count as current. Stand-ins drawn over a chunk (render/grabView.ts) wait for this.
   */
  upToDate(cx: number, cy: number, z: number): boolean {
    const e = this.entries.get(key(cx, cy, z));
    return !e || (e.builtSig !== -1 && e.builtSig === e.sig && !e.job);
  }

  /** Is tile (x,y,z) under a roof/floor (anything on the level above)? Used for ambient. */
  covered(x: number, y: number, z: number): boolean {
    return terrainShape(this.map.terAt(x, y, z + 1)) !== 'none';
  }

  update(px: number, py: number, pz: number, zVisible: (z: number) => boolean, unlimited = false): void {
    const pcx = Math.floor(px / CHUNK), pcy = Math.floor(py / CHUNK);
    const R = this.radius;
    const t0 = performance.now();
    this.trackVelocity(px, py, t0);
    if (this.lastUpdateT) {
      const iv = t0 - this.lastUpdateT;
      // a hidden tab or a breakpoint is not the frame rate
      if (iv < 250) {
        this.ivEma += (iv - this.ivEma) * 0.05;
        this.loopEma += (frameStats.lastLoopMs - this.loopEma) * 0.05;
      }
    }
    this.lastUpdateT = t0;
    const need = this.schedule === 'need';
    // slack beyond what this frame's chunk work already takes (loopEma includes it)
    const slack = Math.max(0, this.ivEma - this.loopEma - Math.max(2, this.ivEma * 0.15));
    const base = need ? Math.min(12, this.budgetMs + slack * this.slackShare) : this.budgetMs;
    let boost = need ? Math.min(20, this.boostBudgetMs + slack * this.boostSlackShare) : this.boostBudgetMs;
    if (need && Math.hypot(this.vel.x, this.vel.y) < 1.5) boost = Math.max(boost, this.settleBudgetMs);
    // (as nearChunks.ts, give up after 4 s: a stuck build must not hold the big budget)
    let curtain = need && !unlimited && this.nearUnbuilt(px, py, pz) > 0;
    if (!curtain) this.curtainSince = -1;
    else if (this.curtainSince < 0) this.curtainSince = t0;
    else if (t0 - this.curtainSince > 4000) curtain = false;
    this.curtained = curtain;
    // 1. make sure desired entries exist, nearest first. Creating an entry generates map
    //    chunks (mapgen can be slow), so this shares the frame budget with meshing: while
    //    builds are waiting it gets a share, and behind the curtain only the 3x3 is created.
    if (this.offsetsR !== R) this.computeOffsets(R);
    let created = 0;
    const createBudget = curtain ? this.curtainBudgetMs : (this.behind ? boost : base) * (need && this.pendingLast > 0 ? this.createShare : 1);
    const ground = this.below === 'ground';
    const zLo = lowestLevel(pz, this.levelsBelow, ground), zHi = pz + this.levelsAbove;
    const lr = this.levelR;
    lr.length = 0;
    for (let z = zLo; z <= zHi; z++) lr.push(levelRadius(z, pz, R, this.levelsBelow, this.levelsAbove, 4, ground));
    outer: for (const [dx, dy] of this.offsets)
      for (let z = zLo; z <= zHi; z++) {
        const rz = lr[z - zLo];
        // offsets are circular around the player's chunk, like computeOffsets
        if (rz < 0 || (rz < R && dx * dx + dy * dy > (rz + 0.5) * (rz + 0.5))) continue;
        if (curtain && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) break outer; // offsets are nearest first
        const cx = pcx + dx, cy = pcy + dy;
        const k = key(cx, cy, z);
        if (this.entries.has(k)) continue;
        if (!unlimited && created > 0 && performance.now() - t0 > createBudget) break outer;
        const deps = this.depsOf(cx, cy, z);
        if (!deps[0]) continue; // outside MIN_Z..MAX_Z
        created++;
        this.entries.set(k, {
          cx, cy, z, chunk: deps[0], deps, sig: 0, builtSig: -1, group: null, sprites: null,
          visible: true, d2: 0, near: false, job: null, builtVer: -1, wantT: t0, vsig: 0, builtVsig: -1, cls: 'hole',
        });
        this.probe?.want(cx, cy, z);
      }
    this.stats.frameCreateMs = performance.now() - t0;
    frameStats.lap('chunks.create');
    // 2. signatures, visibility, eviction
    const dirty = this.dirty;
    dirty.length = 0;
    for (const [k, e] of this.entries) {
      const ddx = e.cx - pcx, ddy = e.cy - pcy;
      const dd = ddx * ddx + ddy * ddy;
      const rz = e.z >= zLo && e.z <= zHi ? lr[e.z - zLo] : -1;
      // hysteresis: kept one chunk past its level's radius, and one level past the player's
      // window (not past the ground: a basement under a rooftop stays dropped)
      const keepR = rz >= 0 ? rz : e.z >= pz - this.levelsBelow - 1 && e.z <= zHi + 1 ? R : -1;
      if (keepR < 0 || dd > (keepR + 1.5) * (keepR + 1.5)) {
        this.probe?.drop(e.cx, e.cy, e.z, !!e.shown);
        this.dispose(e);
        this.entries.delete(k);
        continue;
      }
      // (entries in the hysteresis ring stay up and current, as they always have)
      const inLevels = rz >= 0 && dd <= (rz + 1.5) * (rz + 1.5);
      const vis = inLevels && zVisible(e.z);
      if (vis !== e.visible) this.setVisible(e, vis);
      let sig = 0;
      for (const d of e.deps) sig = (sig * 31 + (d ? d.version + 1 : 0)) | 0;
      e.vsig = sig;
      if (this.lodRadius > 0) {
        // storeys well below a rooftop are seen from 8+ m away: the far volumes do
        e.near = dd <= this.lodRadius * this.lodRadius && pz - e.z <= 2;
        sig = (sig * 31 + (e.near ? 7 : 3)) | 0;
        // flora.ts middle ring (lighter tree LOD); 0 = no middle ring. Not in the signature:
        // crossing it swaps only the chunk's trees (treeSteps), not its whole mesh
        e.mid = !e.near && dd <= this.midRadius * this.midRadius;
      }
      e.sig = sig;
      if ((sig !== e.builtSig || e.job || this.treesStale(e)) && inLevels) {
        e.d2 = this.schedule === 'need' ? this.needPriority(e, px, py, pz) : this.priority(e, px, py, pz);
        dirty.push(e);
      }
    }
    if (this.schedule === 'need') this.deferCosmetic(dirty);
    else this.behind = false;
    // 3. rebuild in priority order under budget; a build may take several frames
    dirty.sort((a, b) => a.d2 - b.d2);
    frameStats.lap('chunks.sig');
    let built = 0;
    const pctx = Math.floor(px / CHUNK), pcty = Math.floor(py / CHUNK);
    for (const e of dirty) {
      // the player's own chunk or a neighbour was edited (a door, a smashed wall): show it
      // promptly. LOD flips (near/far volumes) while moving are not urgent.
      // Never-built chunks next to the player (teleport, load) are urgent too: until they
      // exist the view is curtained (nearChunks.ts).
      const nearP = e.z === pz && Math.abs(e.cx - pctx) <= 1 && Math.abs(e.cy - pcty) <= 1;
      const urgent = nearP && (!e.shown || (e.builtSig !== -1 && e.chunk.version !== e.builtVer));
      const budget = curtain ? this.curtainBudgetMs : urgent ? Math.max(this.urgentBudgetMs, boost) : this.behind ? boost : base;
      const now = performance.now();
      if (!unlimited && (built > 0 || created > 0) && now - t0 > budget) break;
      if (e.builtSig === -1 && e.z === pz && !e.job) {
        const nx = Math.max(e.cx * CHUNK, Math.min(px, e.cx * CHUNK + CHUNK));
        const ny = Math.max(e.cy * CHUNK, Math.min(py, e.cy * CHUNK + CHUNK));
        if (Math.hypot(nx - px, ny - py) < this.visibleDist) this.stats.lateBuilds++;
      }
      if (!e.job) {
        const full = e.sig !== e.builtSig;
        e.job = {
          gen: full ? this.buildSteps(e) : this.treeSteps(e), sig: full ? e.sig : e.builtSig, vsig: full ? e.vsig : e.builtVsig,
          near: full ? e.near : !!e.builtNear, ver: full ? e.chunk.version : e.builtVer, ms: 0, t0: now, kind: full ? 'full' : 'trees',
        };
      }
      const job = e.job;
      const b0 = performance.now();
      const r = stepUntil(job.gen, unlimited ? Infinity : t0 + budget);
      job.ms += performance.now() - b0;
      built++;
      if (!r.done) break;
      // A stale result (the map changed mid-build) still replaces the old mesh; builtSig
      // keeps the job's signature so the entry goes dirty again and rebuilds.
      e.builtSig = job.sig;
      e.builtVsig = job.vsig;
      e.builtNear = job.near;
      e.builtVer = job.ver;
      if (this.probe) {
        const end = performance.now();
        this.probe.built(e.cx, e.cy, e.z, !e.shown, job.ms, end - job.t0, job.kind === 'full' && !e.group ? 'empty' : job.kind, end - e.wantT);
      }
      e.shown = true;
      e.job = null;
      this.stats.builds++;
      this.stats.lastBuildMs = job.ms;
      this.stats.maxBuildMs = Math.max(this.stats.maxBuildMs, job.ms);
      if (job.ms > 8) this.stats.slowBuilds++;
    }
    this.effBudgetMs = curtain ? this.curtainBudgetMs : this.behind ? boost : base;
    this.stats.frameMs = performance.now() - t0;
    this.stats.maxFrameMs = Math.max(this.stats.maxFrameMs, this.stats.frameMs);
    this.stats.builtThisFrame = built;
    this.stats.pending = dirty.length - built;
    this.pendingLast = this.stats.pending;
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

  /** Smoothed player velocity from successive update() positions; a jump (teleport) resets it. */
  private trackVelocity(px: number, py: number, now: number): void {
    const l = this.lastPos;
    if (l && now > l.t) {
      const dt = (now - l.t) / 1000;
      const vx = (px - l.x) / dt, vy = (py - l.y) / dt;
      if (Math.hypot(vx, vy) < 80 && dt < 0.5) {
        const k = Math.min(1, dt * 4);
        this.vel.x += (vx - this.vel.x) * k;
        this.vel.y += (vy - this.vel.y) * k;
      } else this.vel.x = this.vel.y = 0;
    }
    this.lastPos = { x: px, y: py, t: now };
  }

  private minHoleNeed = Infinity;
  private anyHole = false;

  /**
   * 'need' build order, lower first: roughly the seconds until the chunk is needed. Inside the
   * fog range and in view = 0; beyond it, the distance still to cover at the speed the player
   * closes on it (1 m/s floor, so standing still fills the outer ring nearest first); out of
   * view later (much later when driving: the camera follows the road); basements later still.
   * Cosmetic work (LOD flips) is ranked after every hole and edit.
   */
  private needPriority(e: Entry, px: number, py: number, pz: number): number {
    const x0 = e.cx * CHUNK, y0 = e.cy * CHUNK;
    const nx = Math.max(x0, Math.min(px, x0 + CHUNK)) - px, ny = Math.max(y0, Math.min(py, y0 + CHUNK)) - py;
    const d = Math.hypot(nx, ny);
    const ccx = x0 + CHUNK / 2 - px, ccy = y0 + CHUNK / 2 - py;
    const len = Math.hypot(ccx, ccy);
    const speed = Math.hypot(this.vel.x, this.vel.y);
    // the fog is opaque from (radius - 1) chunks (renderer: fogFar); anything closer can be seen
    const fogFar = Math.max(2, this.radius - 1) * CHUNK;
    let t = 0;
    if (d > fogFar) {
      const closing = len > 0 ? (ccx * this.vel.x + ccy * this.vel.y) / len : 0;
      t = (d - fogFar) / Math.max(closing, 1);
    }
    const inView = len < CHUNK * 1.2 || Math.acos(Math.max(-1, Math.min(1, (ccx * this.forward.x + ccy * this.forward.y) / len))) < this.viewHalf + Math.atan((CHUNK * 0.71) / len);
    if (!inView) t += speed > 4 ? 3 : 0.75;
    // basements later still; above ground the street and storeys below are in plain view
    if (e.z < pz) t += pz > 0 && e.z >= 0 ? 0.25 : 1.5;
    else if (e.z > pz) t += 0.2;
    t += d * 0.002;
    // the player's own chunk and its 8 neighbours come first whatever the camera does: after
    // a teleport or a load the view stays curtained until they exist (nearChunks.ts)
    if (e.z === pz && Math.abs(e.cx - Math.floor(px / CHUNK)) <= 1 && Math.abs(e.cy - Math.floor(py / CHUNK)) <= 1) t = Math.min(t, -1 + d * 0.002);
    const cls: WorkClass = !e.shown ? 'hole' : e.vsig !== e.builtVsig || e.builtSig === -1 ? 'edit' : e.near !== !!e.builtNear ? (e.near ? 'up' : 'down') : 'trees';
    e.cls = cls;
    if (cls === 'hole') {
      if (t < this.minHoleNeed) this.minHoleNeed = t;
      this.anyHole = true;
    }
    // finish what's started before starting a peer: half-built jobs hold their data
    const started = e.job ? -0.05 : 0;
    if (cls === 'hole' || cls === 'edit') return t + (cls === 'edit' ? 0.1 : 0) + started;
    if (cls === 'down') return 50 + t + started;
    return 5 + t + started;
  }

  /**
   * Drop this frame's cosmetic work while the world isn't built: near-ring upgrades and tree
   * swaps wait until no hole is needed within 3 s; downgrades (leaving the near ring: the
   * detailed mesh is already up and only costs a little render time) wait until the player
   * stands still with nothing unbuilt at all. Sets `behind` (boost budget) for this frame.
   */
  private deferCosmetic(dirty: Entry[]): void {
    const soon = this.minHoleNeed, any = this.anyHole;
    this.behind = soon < 0.5;
    this.minHoleNeed = Infinity;
    this.anyHole = false;
    const moving = Math.hypot(this.vel.x, this.vel.y) > 1.5;
    let n = 0;
    for (const e of dirty) {
      if ((e.cls === 'up' || e.cls === 'trees') && soon < 3) continue;
      if (e.cls === 'down' && (moving || any)) continue;
      dirty[n++] = e;
    }
    dirty.length = n;
  }

  /** this frame's levelRadius() per level from lowestLevel() up (reused array) */
  private levelR: number[] = [];
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

  private treesStale(e: Entry): boolean {
    return !!e.shown && !!e.trees && !!e.group && !!e.mid !== !!e.treeMid;
  }

  /** Middle-ring flip: rebuild the chunk's trees at the new LOD and swap only them. */
  private *treeSteps(e: Entry): Generator<void, void> {
    const specs = e.trees!;
    const mid = !!e.mid;
    const lod: 0 | 1 | 2 = e.near ? 0 : mid ? 1 : 2;
    const trees = specs.map((t) => ({ ...t, lod }));
    let t0 = performance.now();
    const tg = this.extraObjects!({ pages: new Map(), sprites: [], trees }, e.cx, e.cy, e.z);
    let objs: THREE.Object3D[];
    for (;;) {
      const r = tg.next();
      if (r.done) { objs = r.value; break; }
      this.stat('tree', t0);
      yield;
      t0 = performance.now();
    }
    this.stat('tree', t0);
    const g = e.group;
    if (!g) return; // disposed meanwhile
    for (const o of e.treeObjs ?? []) {
      g.remove(o);
      (o as THREE.Mesh).geometry?.dispose();
      (o.userData as { dispose?: () => void }).dispose?.();
    }
    for (const o of objs) g.add(o);
    e.treeObjs = objs;
    e.trees = trees;
    e.treeMid = mid;
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
    const ex = this.extras?.(e.near);
    if (ex) ex.mid = e.mid;
    const gen = buildChunkMeshSteps(this.map, this.shapes, this.source, e.chunk, this.season, undefined, ex);
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
      e.trees = data.trees;
      e.treeMid = !!e.mid;
      for (;;) {
        const r = tg.next();
        if (r.done) { for (const o of r.value) g.add(o); e.treeObjs = r.value; break; }
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
