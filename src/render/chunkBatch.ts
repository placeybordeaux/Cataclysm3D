import * as THREE from 'three';
import { CHUNK } from '../world/coords';

// Draw-call batching for far chunks (docs/PERF.md). Every chunk is one mesh per texture page
// (~5 per chunk, 10 pages in use), so a 168 m draw distance in a town is ~950 draw calls in the
// main pass and ~1000 more each time the far shadow cascade redraws; in Firefox each WebGL
// call costs ~7-8 us of CPU (9.5 ms/frame of `draw` in the user's dump at 1200-1400 calls).
//
// Far chunks rarely change, so their page meshes are merged per BLOCKxBLOCK block of columns,
// all levels together, per material: one draw instead of up to BLOCK^2. The chunk manager keeps
// owning the chunk groups; this layer only hides the merged source meshes (mesh.visible, not
// the groups the manager toggles) and frees their GPU buffers (three re-uploads them if a
// block is ever disbanded). A block is disbanded the moment any member group is replaced
// (a rebuild), removed, hidden (top-down cut) or comes within `nearChunks` of the player, so
// edits, LOD flips and streaming never see a stale merged mesh.

interface Batch {
  key: string;
  bx: number;
  by: number;
  z: number;
  members: THREE.Group[];
  /** performance.now() of the merge */
  at: number;
  merged: THREE.Mesh[];
  hidden: THREE.Mesh[];
}

const BATCHABLE = 'batchable';

/** Mark a chunk page mesh as mergeable (chunkManager.ts buildSteps). */
export function markBatchable(m: THREE.Mesh): void {
  m.userData[BATCHABLE] = true;
}

export class ChunkBatcher {
  readonly group = new THREE.Group();
  enabled = true;
  /** columns per block side */
  block = 3;
  /**
   * blocks with a column this close (chunks, Chebyshev) are left alone: the player's own 3x3 is
   * where edits happen, and the near-detail ring (chunkManager lodRadius 1.8) lies inside it
   */
  nearChunks = 1;
  /** a chunk group must have been up this long before it is merged (still refining otherwise) */
  settleMs = 1500;
  /** a merged block takes in late members at most this often */
  rejoinMs = 4000;
  /** ms per frame for merging (one block at least) */
  budgetMs = 2;
  readonly stats = { batches: 0, merged: 0, hidden: 0, built: 0, disbanded: 0, lastMs: 0, why: { replaced: 0, hidden: 0, near: 0, joined: 0 } };
  private batches = new Map<string, Batch>();
  private seen = new WeakMap<THREE.Group, number>();
  private inBatch = new WeakSet<THREE.Group>();

  constructor() {
    this.group.name = 'chunk batches';
  }

  /** `chunks`: the chunk manager's group; `busy`: streaming is catching up (don't add work). */
  update(px: number, py: number, chunks: THREE.Group, busy: boolean): void {
    if (!this.enabled) {
      if (this.batches.size) this.clear();
      return;
    }
    const pcx = Math.floor(px / CHUNK), pcy = Math.floor(py / CHUNK);
    const B = this.block;
    // per column, not per block: a block next to the player merges the columns that are far
    // enough (and re-forms without one that comes near)
    const near = (g: THREE.Group) => {
      const c = coordsOf(g)!;
      return Math.max(Math.abs(c.cx - pcx), Math.abs(c.cy - pcy)) <= this.nearChunks;
    };
    // 1. disband what went stale
    for (const b of this.batches.values()) {
      const why = b.members.some((g) => g.parent !== chunks) ? 'replaced' : b.members.some((g) => !g.visible) ? 'hidden' : b.members.some(near) ? 'near' : null;
      if (why) {
        this.stats.why[why]++;
        this.disband(b);
      }
    }
    if (busy) return;
    // 2. find blocks to merge
    const now = performance.now();
    const cand = new Map<string, { bx: number; by: number; z: number; groups: THREE.Group[] }>();
    for (const o of chunks.children) {
      const g = o as THREE.Group;
      if (this.inBatch.has(g) || !g.visible) continue;
      let born = this.seen.get(g);
      if (born === undefined) this.seen.set(g, (born = now));
      if (now - born < this.settleMs) continue;
      const c = coordsOf(g);
      if (!c) continue;
      if (near(g)) continue;
      const bx = Math.floor(c.cx / B), by = Math.floor(c.cy / B);
      // every level of the block in one batch (a town is 4-6 levels deep from a rooftop)
      const key = `${bx},${by}`;
      let e = cand.get(key);
      if (!e) cand.set(key, (e = { bx, by, z: c.z, groups: [] }));
      e.groups.push(g);
    }
    const t0 = performance.now();
    for (const [key, e] of cand) {
      const old = this.batches.get(key);
      // a member that settled after its block was merged (a rebuilt chunk) joins by re-merging,
      // at most every `rejoinMs` per block: members of a block streaming in one by one would
      // otherwise re-merge it (copy + upload a few MB) once per member
      if (old && now - old.at < this.rejoinMs) continue;
      if (old) {
        this.stats.why.joined++;
        this.disband(old);
        e.groups.push(...old.members.filter((g) => g.parent === chunks && g.visible));
      }
      if (e.groups.length < 2) continue;
      this.build(key, e.bx, e.by, e.z, e.groups);
      if (performance.now() - t0 > this.budgetMs) break;
    }
    this.stats.lastMs = performance.now() - t0;
    this.stats.batches = this.batches.size;
  }

  private build(key: string, bx: number, by: number, z: number, groups: THREE.Group[]): void {
    const byMat = new Map<THREE.Material, THREE.Mesh[]>();
    for (const g of groups)
      for (const o of g.children) {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.userData[BATCHABLE] || !m.visible || Array.isArray(m.material)) continue;
        let l = byMat.get(m.material);
        if (!l) byMat.set(m.material, (l = []));
        l.push(m);
      }
    const b: Batch = { key, bx, by, z, members: groups, at: performance.now(), merged: [], hidden: [] };
    for (const [mat, list] of byMat) {
      if (list.length < 2) continue;
      const geo = mergeIndexed(list.map((m) => m.geometry));
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, mat);
      const src = list[0];
      mesh.customDepthMaterial = src.customDepthMaterial;
      mesh.castShadow = src.castShadow;
      mesh.receiveShadow = src.receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.name = `batch ${key}`;
      this.group.add(mesh);
      b.merged.push(mesh);
      for (const m of list) {
        m.visible = false;
        // free the GPU copy: three re-uploads the (still CPU-side) arrays if it is shown again
        m.geometry.dispose();
        b.hidden.push(m);
      }
    }
    for (const g of groups) this.inBatch.add(g);
    this.batches.set(key, b);
    this.stats.built++;
    this.stats.merged += b.merged.length;
    this.stats.hidden += b.hidden.length;
  }

  private disband(b: Batch): void {
    for (const m of b.merged) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    for (const m of b.hidden) m.visible = true;
    for (const g of b.members) this.inBatch.delete(g);
    this.batches.delete(b.key);
    this.stats.disbanded++;
    this.stats.merged -= b.merged.length;
    this.stats.hidden -= b.hidden.length;
  }

  clear(): void {
    for (const b of [...this.batches.values()]) this.disband(b);
    this.stats.batches = 0;
  }
}

function coordsOf(g: THREE.Group): { cx: number; cy: number; z: number } | null {
  let c = g.userData.cc as { cx: number; cy: number; z: number } | undefined;
  if (c) return c;
  const m = /^chunk (-?\d+),(-?\d+),(-?\d+)$/.exec(g.name);
  if (!m) return null;
  g.userData.cc = c = { cx: Number(m[1]), cy: Number(m[2]), z: Number(m[3]) };
  return c;
}

/**
 * Concatenate indexed geometries with the same attribute layout (GeomBuilder output: positions
 * are already in world space). Null if the layouts differ.
 */
export function mergeIndexed(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  const names = Object.keys(geos[0].attributes);
  for (const g of geos) {
    if (!g.index || Object.keys(g.attributes).length !== names.length) return null;
    for (const n of names) {
      const a = g.attributes[n] as THREE.BufferAttribute, a0 = geos[0].attributes[n] as THREE.BufferAttribute;
      if (!a || a.itemSize !== a0.itemSize || a.array.constructor !== a0.array.constructor || a.normalized !== a0.normalized) return null;
    }
  }
  const out = new THREE.BufferGeometry();
  let verts = 0, idx = 0;
  for (const g of geos) {
    verts += g.attributes.position.count;
    idx += g.index!.count;
  }
  for (const n of names) {
    const a0 = geos[0].attributes[n] as THREE.BufferAttribute;
    const Ctor = a0.array.constructor as new (n: number) => THREE.TypedArray;
    const arr = new Ctor(verts * a0.itemSize);
    let off = 0;
    for (const g of geos) {
      const a = g.attributes[n] as THREE.BufferAttribute;
      arr.set(a.array.subarray(0, a.count * a.itemSize), off);
      off += a.count * a.itemSize;
    }
    out.setAttribute(n, new THREE.BufferAttribute(arr, a0.itemSize, a0.normalized));
  }
  const index = new Uint32Array(idx);
  let io = 0, vo = 0;
  for (const g of geos) {
    const src = g.index!.array;
    const n = g.index!.count;
    for (let i = 0; i < n; i++) index[io + i] = src[i] + vo;
    io += n;
    vo += g.attributes.position.count;
  }
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/** Add the batcher to the renderer (on by default; `?batch=0`, `cdda.chunkBatch(false)`). */
export function installChunkBatch(renderer: {
  scene: THREE.Scene;
  beforeRender: ((dt: number) => void)[];
  chunks: { group: THREE.Group; behind: boolean; curtained: boolean };
}, player: () => { x: number; y: number }, api: Record<string, unknown>): ChunkBatcher {
  const b = new ChunkBatcher();
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('batch') : null;
  if (q !== null && q !== '0' && q !== '1') throw new Error(`?batch=${q}: expected 0 or 1`);
  if (q === '0') b.enabled = false;
  renderer.scene.add(b.group);
  renderer.beforeRender.push(() => {
    const p = player();
    b.update(p.x, p.y, renderer.chunks.group, renderer.chunks.behind || renderer.chunks.curtained);
  });
  api.chunkBatch = (on?: boolean, o: { block?: number; near?: number } = {}) => {
    if (on !== undefined) b.enabled = !!on;
    if (o.block !== undefined || o.near !== undefined) {
      b.clear();
      if (o.block !== undefined) b.block = o.block;
      if (o.near !== undefined) b.nearChunks = o.near;
    }
    return { enabled: b.enabled, ...b.stats };
  };
  return b;
}
