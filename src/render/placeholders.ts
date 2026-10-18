import * as THREE from 'three';
import { CHUNK } from '../world/coords';
import { GeomBuilder } from './geometry';
import { worldMaterials } from './materials';
import { emitSilhouette, silhouetteStoreys, type OmtLookup } from './skyline';
import type { ChunkEntryView } from './chunkManager';
import type { TileFrame } from './textureSource';

// Stand-ins for chunks that are wanted but not built yet (docs/PERF.md). When streaming falls
// behind (a fast car into a dense town), an unbuilt chunk used to be a hole: the far ground
// ring's flat colour where a street of houses should be, then the houses popped in. Now the
// column shows the skyline's silhouette of what the overmap says is there — a house box with
// a gable roof, a block of town buildings, tree crowns — lit and fogged like the world, until
// the real mesh replaces it. Only for ground-level (z 0) chunks, while the player is on the
// surface or above it (rooftops look down on the street), where the far view is.

/** Linear albedo for the stand-ins: the skyline's colours are tuned for its own dim shader. */
const BRIGHTEN = 2.6;

const colKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);

export class PlaceholderLayer {
  readonly group = new THREE.Group();
  enabled = true;
  /** stand-ins shown, and built in total (stats) */
  readonly stats = { shown: 0, built: 0 };
  private meshes = new Map<number, THREE.Mesh>();
  private built = new Set<number>();
  private tick = 0;
  /**
   * farLod.ts: when set, a stand-in goes when the hand-off says its column is done (every
   * wanted level shown and dissolved in) instead of when its ground level is built, and no
   * stand-in is made where `covered` (a far proxy stands there).
   */
  doneFn: ((cx: number, cy: number) => boolean) | null = null;
  covered: ((cx: number, cy: number) => boolean) | null = null;
  /** stand-ins made at the last update (farLod.ts fades them in) */
  readonly fresh: THREE.Mesh[] = [];

  /** The stand-in drawn for column (cx, cy), null if none or nothing to draw (fields, roads). */
  meshAt(cx: number, cy: number): THREE.Mesh | null {
    const m = this.meshes.get(colKey(cx, cy));
    return m && m.parent ? m : null;
  }

  constructor(public overmap: OmtLookup | null, private white: () => TileFrame) {
    this.group.name = 'placeholders';
  }

  /**
   * `forEachEntry`: the chunk manager's wanted entries. A column gets a stand-in while its
   * ground-level chunk has no mesh yet (not created, or never finished), inside `radius` chunks.
   */
  update(px: number, py: number, pz: number, radius: number, forEachEntry: (fn: (e: ChunkEntryView) => void) => void, groundBelow = true): void {
    // every 4th frame: a stand-in a few frames late is still far ahead of the real mesh
    if ((this.tick++ & 3) !== 0) return;
    // above ground too: the ground level is drawn from rooftops (src/world/levels.ts)
    if (!this.enabled || !this.overmap || pz < 0 || (pz > 0 && !groundBelow)) {
      if (this.meshes.size) this.clear();
      return;
    }
    this.fresh.length = 0;
    const built = this.built;
    built.clear();
    const pcx = Math.floor(px / CHUNK), pcy = Math.floor(py / CHUNK);
    const done = this.doneFn, covered = this.covered;
    if (done) {
      const r = radius + 1;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (done(pcx + dx, pcy + dy) || covered?.(pcx + dx, pcy + dy)) built.add(colKey(pcx + dx, pcy + dy));
    } else
      forEachEntry((e) => {
        if (e.z === 0 && e.shown) built.add(colKey(e.cx, e.cy));
      });
    const R = radius + 0.5;
    // drop stand-ins whose chunk is built or out of range
    for (const [k, m] of this.meshes) {
      const cx = Math.floor(k / 65536) - 32768, cy = (k % 65536) - 32768;
      if (built.has(k) || (cx - pcx) ** 2 + (cy - pcy) ** 2 > R * R) this.remove(k, m);
    }
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > R * R) continue;
        const cx = pcx + dx, cy = pcy + dy;
        const k = colKey(cx, cy);
        if (built.has(k) || this.meshes.has(k)) continue;
        this.add(k, cx, cy);
      }
    this.stats.shown = this.meshes.size;
  }

  private add(k: number, cx: number, cy: number): void {
    const f = this.white();
    const g = new GeomBuilder();
    const n4 = (n: number[]) => [n, n, n, n] as [number, number, number][];
    const lit = (c: number[]) => [c[0] * BRIGHTEN, c[1] * BRIGHTEN, c[2] * BRIGHTEN];
    emitSilhouette(cx, cy, this.overmap!.omtAt(cx, cy, 0).id,
      (a, b, c, d, n, col) => g.quadEx(a as [number, number, number], b as [number, number, number], c as [number, number, number], d as [number, number, number], n4(n), [0, 0, 1, 1], f, lit(col)),
      (a, b, c, col) => {
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const l = Math.hypot(nn[0], nn[1], nn[2]) || 1;
        // the skyline draws double-sided and its crown triangles aren't consistently wound:
        // both windings here (a crown is 18 triangles)
        const A = a as [number, number, number], B = b as [number, number, number], Cc = c as [number, number, number];
        g.tri(A, B, Cc, [nn[0] / l, nn[1] / l, nn[2] / l], [0, 0, 1, 0, 1, 1], f, lit(col));
        g.tri(A, Cc, B, [-nn[0] / l, -nn[1] / l, -nn[2] / l], [0, 0, 1, 1, 1, 0], f, lit(col));
      }, silhouetteStoreys(this.overmap!, cx, cy));
    if (g.vertexCount === 0) {
      // fields, roads, water: the far ground ring already stands in; remember "nothing to draw"
      const m = new THREE.Mesh();
      m.visible = false;
      this.meshes.set(k, m);
      return;
    }
    const mesh = new THREE.Mesh(g.build(), worldMaterials(f.texture).mat);
    mesh.matrixAutoUpdate = false;
    mesh.name = `placeholder ${cx},${cy}`;
    this.group.add(mesh);
    this.meshes.set(k, mesh);
    this.stats.built++;
    this.fresh.push(mesh);
  }

  private remove(k: number, m: THREE.Mesh): void {
    if (m.parent) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.meshes.delete(k);
  }

  clear(): void {
    for (const [k, m] of this.meshes) this.remove(k, m);
    this.stats.shown = 0;
  }
}

/**
 * Add the stand-in layer to the renderer (on by default; `?placeholders=0` or
 * `cdda.placeholders(false)` turns it off). Needs the overmap (gen=world).
 */
export function installPlaceholders(renderer: {
  scene: THREE.Scene;
  beforeRender: ((dt: number) => void)[];
  skyline: { overmap: OmtLookup | null };
  whiteFrame(): TileFrame;
  chunks: { radius: number; levels: { policy: { mode: 'world' | 'window' } }; forEachEntry(fn: (e: ChunkEntryView) => void): void };
}, player: () => { x: number; y: number; z: number }, api: Record<string, unknown>): PlaceholderLayer {
  const layer = new PlaceholderLayer(renderer.skyline.overmap, () => renderer.whiteFrame());
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('placeholders') : null;
  if (q !== null && q !== '0' && q !== '1') throw new Error(`?placeholders=${q}: expected 0 or 1`);
  if (q === '0') layer.enabled = false;
  renderer.scene.add(layer.group);
  renderer.beforeRender.push(() => {
    // the overmap is attached after the renderer is made (lookInstall)
    layer.overmap ??= renderer.skyline.overmap;
    const p = player();
    layer.update(p.x, p.y, p.z, renderer.chunks.radius, (fn) => renderer.chunks.forEachEntry(fn), renderer.chunks.levels.policy.mode === 'world');
  });
  api.placeholders = (on?: boolean) => {
    if (on !== undefined) {
      layer.enabled = !!on;
      if (!on) layer.clear();
    }
    return { enabled: layer.enabled, ...layer.stats };
  };
  return layer;
}
