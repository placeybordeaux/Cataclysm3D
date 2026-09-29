import * as THREE from 'three';
import type { Chunk, GameMap } from '../world/map';
import { CHUNK } from '../world/coords';
import { buildChunkMesh, ShapeTable } from './chunkMesh';
import { worldMaterials } from './materials';
import type { SpriteLayer, StaticSpriteGroup } from './sprites';
import { LEVEL_HEIGHT } from '../world/coords';
import type { TileTextureSource } from './textureSource';
import { terrainShape } from './tileKinds';

// Keeps chunk meshes around the player in sync with the map:
//  - desired set = chunks within `radius` (circular) on levels [z - below, z + above]
//  - an entry is rebuilt when its signature (own + 6 neighbour chunk versions) changes,
//    since wall faces and slab edges depend on neighbours
//  - rebuilds are nearest-first under a per-frame time budget, so walking into new
//    territory spreads the work over frames instead of hitching
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
}

export interface ChunkStats {
  entries: number;
  pending: number;
  builtThisFrame: number;
  lastBuildMs: number;
  /** empty (open-air) chunks skipped instead of meshed, cumulative */
  skippedEmpty: number;
}

const key = (cx: number, cy: number, z: number) => ((z + 16) * 4096 + (cx + 2048)) * 4096 + (cy + 2048);

export class ChunkManager {
  readonly group = new THREE.Group();
  /** Chunks drawn around the player (circular); post-pass fog hides the edge. */
  radius = 4;
  levelsBelow = 1;
  levelsAbove = 1;
  /** Max milliseconds of meshing per frame (at least one chunk is always built). */
  budgetMs = 4;
  readonly stats: ChunkStats = { entries: 0, pending: 0, builtThisFrame: 0, lastBuildMs: 0, skippedEmpty: 0 };
  private entries = new Map<number, Entry>();
  private dirty: Entry[] = [];
  private shapes: ShapeTable;
  season: 'spring' | 'summer' | 'autumn' | 'winter' = 'spring';

  constructor(private map: GameMap, private sprites: SpriteLayer, public source: TileTextureSource) {
    this.group.name = 'chunks';
    this.shapes = new ShapeTable(map);
  }

  /** Force every chunk to rebuild (texture source swap, save loaded, season change). */
  invalidateAll(): void {
    for (const e of this.entries.values()) {
      e.builtSig = -1;
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
          visible: true, d2: 0,
        });
      }
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
      e.sig = sig;
      if (sig !== e.builtSig && inLevels) {
        e.d2 = ddx * ddx + ddy * ddy + (e.z === pz ? 0 : 0.5);
        dirty.push(e);
      }
    }
    // 3. rebuild nearest first under budget
    dirty.sort((a, b) => a.d2 - b.d2);
    let built = 0;
    for (const e of dirty) {
      if (!unlimited && (built > 0 || created > 0) && performance.now() - t0 > this.budgetMs) break;
      const b0 = performance.now();
      this.build(e);
      this.stats.lastBuildMs = performance.now() - b0;
      built++;
    }
    this.stats.builtThisFrame = built;
    this.stats.pending = dirty.length - built;
    this.stats.entries = this.entries.size;
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

  private build(e: Entry): void {
    this.dispose(e);
    const c = e.chunk;
    // Open sky (most chunks above ground): nothing to mesh. `empty` is maintained by
    // worldgen/setTer; items and fields are checked because addItem/addField don't clear it.
    if (c.empty && c.items.size === 0 && c.fields.size === 0 && c.furn.every((f) => f === 0)) {
      e.builtSig = e.sig;
      this.stats.skippedEmpty++;
      return;
    }
    const data = buildChunkMesh(this.map, this.shapes, this.source, e.chunk, this.season);
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
    e.builtSig = e.sig;
  }

  private setVisible(e: Entry, v: boolean): void {
    e.visible = v;
    if (e.group) e.group.visible = v;
    e.sprites?.setVisible(v);
  }

  private dispose(e: Entry): void {
    if (e.group) {
      for (const c of e.group.children) (c as THREE.Mesh).geometry.dispose();
      this.group.remove(e.group);
      e.group = null;
    }
    e.sprites?.dispose();
    e.sprites = null;
  }
}
