import type { GeomBuilder } from '../geometry';
import type { TileFrame, TileTextureSource } from '../textureSource';
import type { GameMap } from '../../world/map';
import type { StairLink } from '../../game/stairs';
import type { StairWalker } from '../../game/stairwalk';
import { ModelBuilder, placeModel, type ModelMesh } from '../furniture/mesh';
import type { ModelAtlas } from '../furniture/atlas';
import { framePixels } from '../framePixels';
import { spritePalette } from '../furniture/palette';
import { LEVEL_HEIGHT } from '../../world/coords';
import { hasFlag } from '../../world/registry';
import { buildLower, buildUpper, stairStyle } from './model';

// The chunk mesher's side of walkable stairs (chunkMesh.ts MeshExtras.stairs): which tiles a
// flight covers (no old step boxes there, no floor slab over a stairwell) and the modelled
// flight / stairwell, baked into the chunk that holds the flight's anchor tile on each level.

/** Tile roles: 0 none, 1 flight (lower level), 2 stairwell (upper level), 3 plain stair tile. */
export type StairRole = 0 | 1 | 2 | 3;

export class StairMesher {
  private models = new WeakMap<StairLink, { lower: ModelMesh; upper: ModelMesh }>();
  /** stats: models built */
  built = 0;

  constructor(readonly walker: StairWalker, private atlas: ModelAtlas, private map: GameMap) {}

  get active(): boolean {
    return this.walker.index.enabled;
  }

  /** Solve every flight touching chunk (cx, cy) on level z before it is meshed. */
  prepare(cx: number, cy: number, z: number): void {
    const idx = this.walker.index;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      idx.ensureChunk(cx + dx, cy + dy, z);
      idx.ensureChunk(cx + dx, cy + dy, z + 1);
    }
    // this build already sees the links it just solved
    idx.dirtyChunks.delete(`${cx},${cy},${z}`);
  }

  role(x: number, y: number, z: number): StairRole {
    const idx = this.walker.index;
    const l = idx.at(x, y, z);
    if (l) return l.z === z ? 1 : 2;
    return idx.isPlain(x, y, z) ? 3 : 0;
  }

  /** Bake the flight (lower level) or stairwell (upper level) anchored at (x, y, z). */
  emit(geo: (f: TileFrame) => GeomBuilder, src: TileTextureSource, x: number, y: number, z: number, base: number): void {
    const l = this.walker.index.at(x, y, z);
    if (!l || l.tiles[0][0] !== x || l.tiles[0][1] !== y) return;
    let m = this.models.get(l);
    if (!m) {
      const px = framePixels(src.terrain(l.terId, 'sprite'));
      const pal = px ? spritePalette(px) : null;
      const floorId = this.map.terAt(l.bottom[0][0], l.bottom[0][1], l.z).id;
      const st = stairStyle(l, pal, floorId);
      const solid = (tx: number, ty: number, tz: number) => {
        const t = this.map.terAt(tx, ty, tz);
        return t.move_cost <= 0 && !hasFlag(t, 'DOOR') && !t.open && !/door|window/.test(t.id);
      };
      const lo = new ModelBuilder(this.atlas);
      buildLower(lo, l, st, solid);
      const up = new ModelBuilder(this.atlas);
      buildUpper(up, l, st, solid);
      m = { lower: lo.done(), upper: up.done() };
      this.models.set(l, m);
      this.built++;
    }
    const lowerBase = l.z === z ? base : base - LEVEL_HEIGHT;
    placeModel(geo, l.z === z ? m.lower : m.upper, { x, y: lowerBase, z: y, yaw: 0 });
  }
}
