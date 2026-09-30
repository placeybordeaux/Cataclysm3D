import { cardsOn, crossCards, flatCard } from './cards';
import { bakeFigure, isFigure } from './chars/figures';
import type * as THREE from 'three';
import { CHUNK, LEVEL_HEIGHT, chunkOf, localOf } from '../world/coords';
import type { Chunk, GameMap } from '../world/map';
import { pointSeed } from './atlasIndex';
import { GeomBuilder } from './geometry';
import type { TileFrame, TileTextureSource } from './textureSource';
import { hasFlag } from '../world/registry';
import { fieldStyle, furnitureShape, terrainShape, type FurnitureShape, type TerrainShape } from './tileKinds';
import { type GroundField, RAISE, vnoise } from './ground';
import type { LookFeatures } from './look';
import { emitProps } from './props';
import { doorCasing, fence as fenceParts, hipRoofTile, METAL, wallBand, windowDetail, type ArchFrames } from './arch';
import { frameAverage } from './framePixels';
import type { VoxelProps } from './voxel';
import { runSteps } from './steps';
import { isBareTree, type TreeSpec } from './trees';
import { wantsFlora3d } from './flora';
import type { ModelFactory } from './furniture';
import type { SurfacePainter } from './surfaces';

// Builds the static geometry of one chunk at one z-level: merged quads grouped by texture
// page (one draw call per page), plus the billboards the chunk contributes. Light sources
// are not collected here: the light map (lightmap.ts) scans chunks itself. Pure w.r.t.
// three.js scene state: the ChunkManager owns meshes/handles.
//
// Vertical layout of a level (z * LEVEL_HEIGHT = floor top):
//   floor top ........ base
//   slab underside ... base - SLAB   (ceiling of the level below)
//   wall tops ........ base + LEVEL_HEIGHT - SLAB (meets the ceiling; never coplanar with
//                      the floor above, so no z-fighting even when both are drawn)

export const SLAB = 0.12;
const WALL_TOP = LEVEL_HEIGHT - SLAB;
/** How far a ceiling reaches into the walls around it (hides seam cracks; see the slab code). */
const CEIL_TUCK = 0.02;
const DOOR_H = 2.1;
const SILL_H = 0.9;
const WATER_DROP = 0.22;
const HALFWALL_H = 1.0;
/** Share of sky ambient reaching faces under a roof (interiors are darker than outside).
 *  Only a fallback now: the light map (lightmap.ts) replaces it on the player's level. */
export const INDOOR_SKY = 0.5;
/** Height of floor decals (blood, bile...) above the floor: clear of z-fighting at range. */
const DECAL_LIFT = 0.012;
/** Floor terrains whose tileset sprite is a cut-out drawn over ground (see the floor case). */
const GROUND_OVERLAY = /^t_(trunk|stump|dirtmound|pit)(_|$)/;
/** Item sprites lying on furniture: top height by furniture shape. */
const FURN_TOP: Record<FurnitureShape, number> = { none: 0, billboard: 0, table: 0.8, counter: 0.92, cabinet: 1.85 };

export interface ChunkSprite {
  x: number; // tile coords (float, centre of tile = +0.5)
  y: number;
  z: number;
  frame: TileFrame;
  height: number; // metres
  kind: 'tree' | 'furniture' | 'item' | 'fire' | 'cloud';
  /** metres above the level floor (items on tables, drifting smoke) */
  lift?: number;
  opacity?: number;
  /** dissolve when the camera is close (tall trees) */
  fadeNear?: boolean;
}

export interface ChunkMeshData {
  pages: Map<THREE.Texture, GeomBuilder>;
  sprites: ChunkSprite[];
  /** look `props`: puddle surfaces (drawn with their own sky-reflecting material) */
  puddles?: GeomBuilder;
  /** look `trees3d`: trees/shrubs to build as trunk + leaf clumps (trees.ts) */
  trees?: TreeSpec[];
  /** modelled furniture: see-through glass quads (furniture/glass.ts material) */
  glass?: GeomBuilder;
}

/** Optional per-look inputs (look.ts); absent = the classic mesh. */
export interface MeshExtras {
  f: LookFeatures;
  ground: GroundField | null;
  /** A white texel on the procedural page: vertex-coloured geometry (props, voxels). */
  white: TileFrame;
  /** look `archDetail`: frames for trim, plinths, shingles (arch.ts) */
  arch?: ArchFrames;
  voxels?: VoxelProps;
  /** Chunk is near the player: expensive volumes (3D trees, voxel props) only here. */
  near: boolean;
  /** Chunk is in the middle ring (chunkManager midRadius): flora.ts builds a lighter LOD. */
  mid?: boolean;
  /** furniture style 'model' (furniture/): modelled pieces replace voxels and billboards */
  models?: ModelFactory;
  /** painted surfaces (surfaces.ts) active: interior wall finishes, baseboards, crown */
  surfaces?: SurfacePainter;
}

const SHAPES: TerrainShape[] = ['none', 'floor', 'liquid', 'wall', 'halfwall', 'window', 'door', 'door_open', 'fence', 'tree', 'shrub', 'stairs_up', 'stairs_down'];
const S = Object.fromEntries(SHAPES.map((s, i) => [s, i])) as Record<TerrainShape, number>;

/**
 * Render-only shape overrides (game logic keeps terrainShape): broken windows and doors lose
 * their WINDOW/DOOR flags in CDDA and classified as floor or fence, so a smashed window was a
 * floor decal of glass shards and an empty frame a pane of floating glass texels. Drawn as
 * the opening they are; their pane/leaf is skipped (or modelled as shards: furniture/).
 */
const BROKEN_WINDOW = /^t_window_(frame|empty)|_frame_domestic$|window.*_noglass$/;
const BROKEN_DOOR = /^t_(door|rdoor)(_[a-z]+)?_b(_peep)?$|^t_(door|mdoor)(_[a-z]+)?_frame$|^t_door_frame$/;
function renderShape(id: string): TerrainShape | null {
  // (boarded/reinforced frames stay walls of boards: tileKinds)
  if (BROKEN_WINDOW.test(id) && !/boarded|reinforced|enhanced/.test(id)) return 'window';
  if (BROKEN_DOOR.test(id)) return 'door';
  // locked doors carry no DOOR flag (you can't open them) and stained glass is flagged WALL:
  // both classified as plain walls, so a locked front door was a brick in the wall
  if (/^t_(door|rdoor|mdoor)(_[a-z]+)*_(locked|pickable)(_[a-z]+)*$/.test(id) && !/_o(_|$)/.test(id)) return 'door';
  if (/^t_window_stained_/.test(id)) return 'window';
  return null;
}

/** Per-registry-index shape codes, extended lazily as ids get interned. */
export class ShapeTable {
  private ter = new Uint8Array(0);
  private furn: FurnitureShape[] = [];
  constructor(private map: GameMap) {}
  terrain(i: number): number {
    if (i >= this.ter.length) {
      const defs = this.map.terrain.defs;
      const t = new Uint8Array(defs.length);
      for (let k = 0; k < defs.length; k++) t[k] = S[renderShape(defs[k].id) ?? terrainShape(defs[k])];
      this.ter = t;
    }
    return this.ter[i];
  }
  furniture(i: number): FurnitureShape {
    const defs = this.map.furniture.defs;
    while (this.furn.length < defs.length) this.furn.push(furnitureShape(defs[this.furn.length]));
    return this.furn[i];
  }
}

/** Reads terrain indices across chunk borders with a tiny chunk cache (no string keys per tile). */
class LevelSampler {
  private cache = new Map<number, Chunk | null>();
  constructor(private map: GameMap, readonly z: number) {}
  private chunkAt(cx: number, cy: number): Chunk | null {
    const k = (cx + 32768) * 65536 + (cy + 32768);
    let c = this.cache.get(k);
    if (c === undefined) this.cache.set(k, (c = this.map.chunk(cx, cy, this.z)));
    return c;
  }
  ter(x: number, y: number): number {
    const c = this.chunkAt(chunkOf(x), chunkOf(y));
    return c ? c.ter[localOf(y) * CHUNK + localOf(x)] : 0;
  }
}

// Direction tables: N, E, S, W in tile space (y south).
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

export function buildChunkMesh(
  map: GameMap, shapes: ShapeTable, src: TileTextureSource, chunk: Chunk,
  season: 'spring' | 'summer' | 'autumn' | 'winter', items?: (id: string) => boolean, extras?: MeshExtras,
): ChunkMeshData {
  return runSteps(buildChunkMeshSteps(map, shapes, src, chunk, season, items, extras));
}

/**
 * buildChunkMesh as a generator that yields after every row of tiles, so the chunk manager
 * can spread one chunk over several frames under a strict per-frame budget (a volumetric
 * chunk near the player costs 5-15 ms in one go). The map must not be assumed unchanged
 * between steps: the caller compares chunk versions afterwards and rebuilds when stale.
 */
export function* buildChunkMeshSteps(
  map: GameMap, shapes: ShapeTable, src: TileTextureSource, chunk: Chunk,
  season: 'spring' | 'summer' | 'autumn' | 'winter', items?: (id: string) => boolean, extras?: MeshExtras,
): Generator<void, ChunkMeshData> {
  const LF = extras?.f;
  const G = extras?.ground && extras.ground.active ? extras.ground : null;
  const trees: TreeSpec[] = [];
  const pud = { g: undefined as GeomBuilder | undefined };
  const glassB = { g: undefined as GeomBuilder | undefined };
  const glassGeo = () => (glassB.g ??= new GeomBuilder());
  const MD = LF?.voxelProps ? extras?.models : undefined;
  const SP = extras?.surfaces?.active() ? extras.surfaces : undefined;
  // interior finishes are chosen per building: one seed per chunk (≈ one OMT, one house)
  const buildingSeed = (Math.imul(chunk.cx, 73856093) ^ Math.imul(chunk.cy, 19349663)) >>> 0;
  const A = LF?.archDetail ? extras?.arch : undefined;
  // pitched roofs: shingle/thatch/tile roof regions get a hipped roof (arch.ts)
  const pitched = (tx: number, ty: number) => PITCHED.test(terDefs[here.ter(tx, ty)].id);
  const roofDist = new Map<number, number>();
  const roofCornerDist = (X: number, Y: number) => {
    const k = (X + 32768) * 65536 + (Y + 32768);
    let d = roofDist.get(k);
    if (d !== undefined) return d;
    d = 6;
    outer: for (let r = 0; r < 6; r++)
      for (let ty = Y - 1 - r; ty <= Y + r; ty++)
        for (let tx = X - 1 - r; tx <= X + r; tx++) {
          if (Math.max(Math.abs(tx + 0.5 - X), Math.abs(ty + 0.5 - Y)) < r) continue;
          if (!pitched(tx, ty)) { d = r; break outer; }
        }
    roofDist.set(k, d);
    return d;
  };
  const z = chunk.z;
  const base = z * LEVEL_HEIGHT;
  const here = new LevelSampler(map, z);
  const above = new LevelSampler(map, z + 1);
  const below = new LevelSampler(map, z - 1);
  const pages = new Map<THREE.Texture, GeomBuilder>();
  const sprites: ChunkSprite[] = [];
  // Ambient multiplier for faces emitted next; set per tile / per side face.
  let curSky = 1;
  const geo = (f: TileFrame) => {
    let g = pages.get(f.texture);
    if (!g) pages.set(f.texture, (g = new GeomBuilder()));
    g.skyVis = curSky;
    return g;
  };
  const terDefs = map.terrain.defs;
  const shapeAt = (s: LevelSampler, x: number, y: number) => shapes.terrain(s.ter(x, y));
  const isWall = (s: number) => s === S.wall;
  const wallLike = (s: number) => s === S.wall || s === S.halfwall || s === S.window || s === S.door || s === S.door_open;
  const floorish = (s: number) => s === S.floor || s === S.stairs_up;
  const x0c = chunk.cx * CHUNK, y0c = chunk.cy * CHUNK;

  /** Floor frame for tiles without their own floor (door thresholds, fences, trees). */
  const neighborFloor = (x: number, y: number): string | null => {
    for (let d = 0; d < 4; d++) {
      const i = here.ter(x + DX[d], y + DY[d]);
      if (floorish(shapes.terrain(i)) && !GROUND_OVERLAY.test(terDefs[i].id)) return terDefs[i].id;
    }
    return null;
  };
  /** Minecraft-style corner AO on floors next to walls: 0 (dark) .. 3 (open). */
  const cornerAo = (x: number, y: number, sx: number, sy: number) => {
    const a = isWall(shapeAt(here, x + sx, y)) ? 1 : 0;
    const b = isWall(shapeAt(here, x, y + sy)) ? 1 : 0;
    const c = isWall(shapeAt(here, x + sx, y + sy)) ? 1 : 0;
    const lvl = a && b ? 0 : 3 - (a + b + c);
    return [0.62, 0.74, 0.87, 1][lvl];
  };

  /** Horizontal upward quad covering tile (x,y) at height y0, honouring frame rotation. */
  const topQuad = (x: number, y: number, y0: number, f: TileFrame, ao?: number[], cut = 0) => {
    // corners a=(x0,z1) b=(x1,z1) c=(x1,z0) d=(x0,z0); rotating the corner list rotates the
    // texture on the quad (CDDA rotates single sprites / multitile edges in 90 deg steps)
    const c: [number, number, number][] = [[x, y0, y + 1], [x + 1, y0, y + 1], [x + 1, y0, y], [x, y0, y]];
    const r = (4 - (f.rotate ?? 0)) & 3;
    const k = (i: number) => (r + i) & 3;
    geo(f).quad(c[k(0)], c[k(1)], c[k(2)], c[k(3)], [0, 1, 0], [0, 0, 1, 1], f, ao && [ao[k(0)], ao[k(1)], ao[k(2)], ao[k(3)]], cut);
  };
  // Local caches of the ground field for this chunk (+1 tile / +2 corner border): the mesher
  // asks for the same corners and tile classes many times per tile, and the field's own
  // lookups go through string-keyed chunk maps.
  const GC = 27; // corners x0c-1 .. x0c+25
  const cornerCache = new Float32Array(GC * GC).fill(NaN);
  const tileCls = new Int8Array(26 * 26).fill(-2); // -2 unknown, 0 flat, 1 relief, 2 raised
  const cls = (tx: number, ty: number) => {
    const i = (ty - y0c + 1) * 26 + (tx - x0c + 1);
    if (i < 0 || i >= 676 || tx < x0c - 1 || tx > x0c + 24) return G!.isRelief(tx, ty, z) ? 1 : G!.tileRaise(tx, ty, z) > 0 ? 2 : 0;
    if (tileCls[i] === -2) tileCls[i] = G!.isRelief(tx, ty, z) ? 1 : G!.tileRaise(tx, ty, z) > 0 ? 2 : 0;
    return tileCls[i];
  };
  const isRel = (tx: number, ty: number) => !!G && cls(tx, ty) === 1;
  const raiseOf = (tx: number, ty: number) => (G && cls(tx, ty) === 2 ? RAISE : 0);
  const cornerH = (X: number, Y: number) => {
    const i = (Y - y0c + 1) * GC + (X - x0c + 1);
    if (X < x0c - 1 || X > x0c + 25 || Y < y0c - 1 || Y > y0c + 25) return G!.corner(X, Y, z);
    let h = cornerCache[i];
    if (Number.isNaN(h)) cornerCache[i] = h = G!.corner(X, Y, z);
    return h;
  };
  const cornerN = (X: number, Y: number): [number, number, number] => {
    const dx = (cornerH(X + 1, Y) - cornerH(X - 1, Y)) / 2, dy = (cornerH(X, Y + 1) - cornerH(X, Y - 1)) / 2;
    const l = Math.hypot(dx, 1, dy);
    return [-dx / l, 1 / l, -dy / l];
  };
  /** Visual ground height at a float position inside this chunk (props, items). */
  const heightLocal = (px: number, py: number) => {
    if (!G) return 0;
    const tx = Math.floor(px), ty = Math.floor(py);
    const k = cls(tx, ty);
    if (k === 2) return RAISE;
    if (k !== 1) return 0;
    const fx = px - tx, fy = py - ty;
    const a = cornerH(tx, ty), b = cornerH(tx + 1, ty), d = cornerH(tx, ty + 1), e = cornerH(tx + 1, ty + 1);
    return a + (b - a) * fx + (d - a) * fy + (a - b - d + e) * fx * fy;
  };
  const groundLocal = { heightAt: (px: number, py: number) => heightLocal(px, py) };
  const macroCache = new Map<number, [number, number, number]>();
  /** Large-scale colour variation of outdoor ground at a corner (look `macroTint`). */
  const macro = (X: number, Y: number): [number, number, number] => {
    const key = (X + 32768) * 65536 + (Y + 32768);
    let m = macroCache.get(key);
    if (m) return m;
    const v = 0.86 + vnoise(X / 13, Y / 13, 7) * 0.24 + (vnoise(X / 4, Y / 4, 9) - 0.5) * 0.08;
    const w = (vnoise(X / 29, Y / 29, 8) - 0.5) * 0.22;
    m = [v * (1 + w), v * (1 + w * 0.4), v * (1 - w)];
    macroCache.set(key, m);
    return m;
  };
  /**
   * Ground quad for tile (x, y): relief heights / curb raise from the ground field and the
   * macro tint on outdoor ground; the classic path is topQuad. `lift` stacks decals on it.
   */
  const groundQuad = (x: number, y: number, y0: number, f: TileFrame, ao: number[] | undefined, outdoor: boolean, lift = 0) => {
    const relief = isRel(x, y);
    const raise = relief ? 0 : raiseOf(x, y);
    const tint = !!LF?.macroTint && outdoor;
    if (!relief && !tint) return topQuad(x, y, y0 + raise + lift, f, ao);
    const P: [number, number][] = [[x, y + 1], [x + 1, y + 1], [x + 1, y], [x, y]];
    const c: [number, number, number][] = P.map(([X, Y]) => [X, y0 + raise + lift + (relief ? cornerH(X, Y) : 0), Y]);
    const nrm = P.map(([X, Y]) => (relief ? cornerN(X, Y) : ([0, 1, 0] as [number, number, number])));
    const col: number[] = [];
    P.forEach(([X, Y], i) => {
      const k = ao ? ao[i] : 1;
      const t = tint ? macro(X, Y) : [1, 1, 1];
      col.push(k * t[0], k * t[1], k * t[2]);
    });
    const r = (4 - (f.rotate ?? 0)) & 3;
    const ord = [0, 1, 2, 3].map((i) => (r + i) & 3);
    geo(f).quadEx(c[ord[0]], c[ord[1]], c[ord[2]], c[ord[3]], ord.map((i) => nrm[i]), [0, 0, 1, 1], f, ord.flatMap((i) => col.slice(i * 3, i * 3 + 3)));
  };
  const emitFloor = (x: number, y: number, id: string, seed: number, y0 = base) => {
    const f = src.terrain(id, 'floor', { variantSeed: seed, season });
    const ao = [cornerAo(x, y, -1, 1), cornerAo(x, y, 1, 1), cornerAo(x, y, 1, -1), cornerAo(x, y, -1, -1)];
    if (G || LF?.macroTint) groundQuad(x, y, y0, f, ao, curSky >= 1 && !terDefs[here.ter(x, y)].flags.includes('INDOORS'));
    else topQuad(x, y, y0, f, ao);
  };
  /** Surface height of a ground-bearing tile at one of its corners (relief or curb). */
  const surfH = (tx: number, ty: number, X: number, Y: number) =>
    !G ? 0 : isRel(tx, ty) ? cornerH(X, Y) : raiseOf(tx, ty);
  const groundBearing = (sh: number) => sh === S.floor || sh === S.tree || sh === S.shrub || sh === S.door || sh === S.door_open || sh === S.fence;

  for (let ly = 0; ly < CHUNK; ly++) {
    if (ly > 0) yield;
    for (let lx = 0; lx < CHUNK; lx++) {
      const x = x0c + lx, y = y0c + ly;
      const ti = chunk.ter[ly * CHUNK + lx];
      const def = terDefs[ti];
      const shape = shapes.terrain(ti);
      const seed = pointSeed(x, y) >>> 0;
      const nShape = [0, 1, 2, 3].map((d) => shapeAt(here, x + DX[d], y + DY[d]));
      const skyOf = (tx: number, ty: number) => (shapeAt(above, tx, ty) !== S.none ? INDOOR_SKY : 1);
      /** Face toward d looks at open outdoor ground (plinths/cornices go there). */
      const outdoorFace = (d: number) => z >= 0 && (nShape[d] === S.floor || nShape[d] === S.tree || nShape[d] === S.shrub || nShape[d] === S.fence) &&
        skyOf(x + DX[d], y + DY[d]) >= 1;
      /** Box face bits (of `faces`) that look into a room: interior finish with painted surfaces. */
      const roomBits = (faces: number) => {
        if (!SP || z < 0) return 0;
        const bits = [32, 1, 16, 2];
        let m = 0;
        for (let d = 0; d < 4; d++) if (faces & bits[d] && floorish(nShape[d]) && skyOf(x + DX[d], y + DY[d]) < 1) m |= bits[d];
        return m;
      };
      const ownSky = skyOf(x, y);
      curSky = ownSky;

      // Floor slab underside + exposed slab edges: anything with a floor at this level
      // that has air (or a non-solid tile) under it.
      const hasSlab = shape !== S.none && shape !== S.liquid && shape !== S.stairs_down;
      if (hasSlab && z > -10) {
        const belowShape = shapeAt(below, x, y);
        if (!isWall(belowShape) && belowShape !== S.stairs_up) {
          curSky = INDOOR_SKY; // a ceiling always faces a covered room
          const f = src.terrain(def.id, 'ceiling');
          // Tuck the ceiling's edges a little into the walls of the room below: edge-to-edge,
          // GPUs rasterize a dotted crack along the wall tops that shows the bright sky.
          let cx0 = x, cx1 = x + 1, cy0 = y, cy1 = y + 1;
          for (let d = 0; d < 4; d++) {
            if (!wallLike(shapeAt(below, x + DX[d], y + DY[d]))) continue;
            if (DX[d] < 0) cx0 -= CEIL_TUCK;
            if (DX[d] > 0) cx1 += CEIL_TUCK;
            if (DY[d] < 0) cy0 -= CEIL_TUCK;
            if (DY[d] > 0) cy1 += CEIL_TUCK;
          }
          const cy = base - SLAB;
          geo(f).quad([cx0, cy, cy0], [cx1, cy, cy0], [cx1, cy, cy1], [cx0, cy, cy1], [0, -1, 0], [x, y, x + 1, y + 1], f);
        }
        curSky = 1;
        for (let d = 0; d < 4; d++) {
          if (nShape[d] !== S.none) continue;
          const f = src.terrain(def.id, 'ceiling');
          sideFace(geo(f), x, y, d, base - SLAB, base, f, base - SLAB);
        }
      }

      curSky = ownSky;
      switch (shape) {
        case S.none:
        case S.stairs_down:
          break;
        case S.floor:
          if (GROUND_OVERLAY.test(def.id)) {
            // tileset draws felled trunks/stumps as cut-outs over the ground: lay them on
            // the surrounding ground instead of punching see-through holes in the floor
            emitFloor(x, y, neighborFloor(x, y) ?? 't_dirt', seed);
            topQuad(x, y, base + DECAL_LIFT, src.terrain(def.id, 'floor', { variantSeed: seed, season }));
          } else emitFloor(x, y, def.id, seed);
          if (A && def.flags.includes('ROOF')) {
            if (PITCHED.test(def.id)) hipRoofTile(geo, A, x, y, base, roofCornerDist, pitched, 1000 + z);
            else {
              // flat roof: a parapet along edges that drop away (open air next door)
              const wid = findWallId(below, shapes, terDefs, x, y) ?? 't_wall';
              const side = src.terrain(wid, 'wall');
              const cap = src.terrain(wid, 'top');
              for (let d = 0; d < 4; d++) {
                if (nShape[d] !== S.none) continue;
                const t = 0.16;
                const bx0 = d === 1 ? x + 1 - t : x, bx1 = d === 3 ? x + t : x + 1;
                const bz0 = d === 2 ? y + 1 - t : y, bz1 = d === 0 ? y + t : y + 1;
                geo(side).box(bx0, base, bz0, bx1, base + 0.42, bz1, 63 & ~8, side, cap, base, 1);
              }
            }
          }
          break;
        case S.liquid: {
          const f = src.terrain(def.id, 'floor', { variantSeed: seed, season, connections: connMask(nShape, (n) => n === S.liquid) });
          const wy = base - WATER_DROP;
          topQuad(x, y, wy, f);
          // Banks: the drop between the neighbor's floor and the water surface.
          for (let d = 0; d < 4; d++) {
            if (nShape[d] === S.liquid || nShape[d] === S.none) continue;
            const nid = terDefs[here.ter(x + DX[d], y + DY[d])].id;
            const bank = src.terrain(floorish(nShape[d]) ? nid : 't_dirt', 'floor', { season });
            sideFace(geo(bank), x, y, d, wy, base, bank, wy);
          }
          break;
        }
        case S.wall:
        case S.halfwall: {
          const top = shape === S.wall ? WALL_TOP : HALFWALL_H;
          const side = src.terrain(def.id, 'wall', { connections: connMask(nShape, wallLike) });
          const conn = connMask(nShape, wallLike);
          const cap = src.terrain(def.id, 'top', { connections: conn });
          for (let d = 0; d < 4; d++) {
            if (isWall(nShape[d])) continue;
            // a wall face is lit like the space it faces (street vs. room)
            curSky = skyOf(x + DX[d], y + DY[d]);
            // painted surfaces: a room-facing side gets the building's interior finish,
            // with a baseboard and a crown moulding
            const roomSide = !!SP && curSky < 1 && z >= 0 && floorish(nShape[d]);
            const face = roomSide ? src.terrain(def.id, 'wall', { connections: conn, indoor: true, variantSeed: buildingSeed }) : side;
            sideFace(geo(face), x, y, d, base, base + top, face, base, 1);
            if (roomSide && SP) {
              const trim = SP.trim();
              wallBand(geo(trim), trim, x, y, d, base, base + 0.1, 0.014, base);
              if (shape === S.wall) wallBand(geo(trim), trim, x, y, d, base + WALL_TOP - 0.07, base + WALL_TOP, 0.022, base);
            }
            if (A && shape === S.wall && outdoorFace(d)) {
              wallBand(geo(A.plinth), A.plinth, x, y, d, base, base + 0.32, 0.06, base);
              // cornice on the top storey, just under the roof slab
              if (!isWall(shapeAt(above, x, y))) wallBand(geo(A.trim), A.trim, x, y, d, base + WALL_TOP - 0.2, base + WALL_TOP + SLAB + 0.03, 0.08, base);
            }
          }
          curSky = 1;
          // Cap: when something covers it (slab above, or the ground over bedrock) it only
          // matters once top-down mode cuts the wall open, so it's flagged cut=2 (hidden
          // otherwise); exposed caps are always drawn.
          const covered = shapeAt(above, x, y) !== S.none;
          topQuad(x, y, base + top, cap, undefined, covered && shape === S.wall ? 2 : 1);
          break;
        }
        case S.window: {
          const alongX = wallLike(nShape[1]) || wallLike(nShape[3]) || !(wallLike(nShape[0]) || wallLike(nShape[2]));
          const wallId = findWallId(here, shapes, terDefs, x, y) ?? 't_wall';
          const side = src.terrain(wallId, 'wall');
          const cap = src.terrain(wallId, 'top');
          const pane = src.terrain(def.id, 'pane');
          const g = geo(side);
          const faces = exposedFaces(nShape, isWall);
          // sill and lintel as full-depth blocks so the window reads as a hole in a thick wall
          // painted surfaces: the room-facing sides of sill and lintel get the interior finish
          const rb = roomBits(faces);
          g.box(x, base, y, x + 1, base + SILL_H, y + 1, (faces & ~rb) | 4, side, cap, base, 1);
          g.box(x, base + DOOR_H, y, x + 1, base + WALL_TOP, y + 1, (faces & ~rb) | 8, side, cap, base, 1);
          if (rb) {
            const inner = src.terrain(wallId, 'wall', { indoor: true, variantSeed: buildingSeed });
            geo(inner).box(x, base, y, x + 1, base + SILL_H, y + 1, rb, inner, cap, base, 1);
            geo(inner).box(x, base + DOOR_H, y, x + 1, base + WALL_TOP, y + 1, rb, inner, cap, base, 1);
          }
          // modelled look: real glass / shards / curtains instead of the textured pane
          if (!(MD && MD.window(geo, glassGeo, src, def.id, x, y, base + SILL_H, base + DOOR_H, alongX, indoorSide(here, terDefs, x, y, alongX))) && !BROKEN_WINDOW.test(def.id))
            paneQuads(geo(pane), x, y, alongX, base + SILL_H, base + DOOR_H, pane, base + SILL_H);
          if (A) {
            windowDetail(geo, A, x, y, alongX, base + SILL_H, base + DOOR_H, /wood|log|board/.test(wallId));
            for (let d = 0; d < 4; d++) if (outdoorFace(d)) wallBand(geo(A.plinth), A.plinth, x, y, d, base, base + 0.32, 0.06, base);
          }
          break;
        }
        case S.door:
        case S.door_open: {
          const floorId = neighborFloor(x, y);
          if (floorId) emitFloor(x, y, floorId, seed);
          const alongX = wallLike(nShape[1]) || wallLike(nShape[3]) || !(wallLike(nShape[0]) || wallLike(nShape[2]));
          const foundWall = findWallId(here, shapes, terDefs, x, y);
          const wallId = foundWall ?? 't_wall';
          const side = src.terrain(wallId, 'wall');
          const cap = src.terrain(wallId, 'top');
          const dfaces = exposedFaces(nShape, isWall), drb = roomBits(dfaces);
          // a gate in a fence line has no wall above it (modelled look: no floating lintel)
          const freeGate = !!MD && !foundWall && /gate|fence/.test(def.id);
          if (!freeGate) geo(side).box(x, base + DOOR_H, y, x + 1, base + WALL_TOP, y + 1, (dfaces & ~drb) | 8, side, cap, base, 1);
          if (drb && !freeGate) {
            const inner = src.terrain(wallId, 'wall', { indoor: true, variantSeed: buildingSeed });
            geo(inner).box(x, base + DOOR_H, y, x + 1, base + WALL_TOP, y + 1, drb, inner, cap, base, 1);
          }
          if (A && !freeGate) doorCasing(geo, A, x, y, alongX, base, base + DOOR_H);
          const slab = src.terrain(def.id, 'pane');
          const T = 0.08;
          const g = geo(slab);
          if (MD && MD.door(geo, glassGeo, src, def.id, x, y, base, DOOR_H + 0.02, alongX, shape === S.door_open, indoorSide(here, terDefs, x, y, alongX))) {
            // modelled door leaf (furniture/openings.ts)
          } else if (BROKEN_DOOR.test(def.id)) {
            // smashed door / empty frame: the casing and lintel only
          } else if (shape === S.door) {
            // The leaf reaches a little into the lintel: flush, its top edge sits mid-face on
            // the lintel's underside and GPUs show a 1px line of daylight along it.
            const top = base + DOOR_H + 0.02;
            if (alongX) g.box(x, base, y + 0.5 - T / 2, x + 1, top, y + 0.5 + T / 2, 63 & ~8, slab, slab, base);
            else g.box(x + 0.5 - T / 2, base, y, x + 0.5 + T / 2, top, y + 1, 63 & ~8, slab, slab, base);
          } else {
            // Swung open 90 degrees against the jamb: hinge at the tile's west/north edge,
            // lying toward the indoor side when we can tell which side that is.
            const inward = indoorSide(here, terDefs, x, y, alongX);
            if (alongX) {
              const zs = inward > 0 ? y + 0.5 : y + 0.5 - 0.9;
              g.box(x + 0.02, base, zs, x + 0.02 + T, base + DOOR_H, zs + 0.9, 63 & ~8, slab, slab, base);
            } else {
              const xs = inward > 0 ? x + 0.5 : x + 0.5 - 0.9;
              g.box(xs, base, y + 0.02, xs + 0.9, base + DOOR_H, y + 0.02 + T, 63 & ~8, slab, slab, base);
            }
          }
          break;
        }
        case S.fence: {
          const floorId = neighborFloor(x, y);
          if (floorId) emitFloor(x, y, floorId, seed);
          // fixture-like terrain (consoles, ATMs, gas pumps) as a model (furniture/)
          if (MD && MD.terrainProp(geo, glassGeo, src, def.id, x, y, base + raiseOf(x, y), seed, {
            wall: nShape.map(wallLike),
            furn: (dx, dy) => map.furnAt(x + dx, y + dy, z).id,
            wallAt: (dx, dy) => wallLike(shapeAt(here, x + dx, y + dy)),
          })) break;
          const conn = (s: number) => s === S.fence || wallLike(s);
          // modelled fences / railings (furniture/fences.ts)
          if (MD && MD.fence(geo, glassGeo, src, def.id, x, y, base + raiseOf(x, y), [0, 1, 2, 3].map((d) => conn(nShape[d])))) break;
          const pane = src.terrain(def.id, 'pane');
          const h = /chain|wire|bars/.test(def.id) ? 2.0 : 1.1;
          const g = geo(pane);
          const kind = /chain|wire/.test(def.id) ? 'chain' : /rail|bars|metal|iron|steel/.test(def.id) ? 'metal' : 'wood';
          if (A) {
            const cn = [0, 1, 2, 3].map((d) => conn(nShape[d]));
            const fb = base + raiseOf(x, y);
            const avg = frameAverage(pane);
            fenceParts(geo, A, x, y, fb, h, kind, cn, kind === 'wood' ? [avg[0] * 1.1, avg[1] * 1.1, avg[2] * 1.1] : METAL);
            if (kind !== 'chain') break;
          }
          let any = false;
          for (let d = 0; d < 4; d++) {
            if (!conn(nShape[d])) continue;
            any = true;
            halfPane(g, x, y, d, base, base + h, pane);
          }
          if (!any) paneQuads(g, x, y, true, base, base + h, pane, base);
          break;
        }
        case S.tree:
        case S.shrub: {
          const floorId = neighborFloor(x, y) ?? 't_grass';
          emitFloor(x, y, floorId, seed);
          const f = src.terrain(def.id, 'sprite', { variantSeed: seed, season });
          // Jitter keeps forests from looking planted in rows.
          const jx = ((seed & 255) / 255 - 0.5) * 0.4, jy = (((seed >> 8) & 255) / 255 - 0.5) * 0.4;
          // Tileset trees are ~3 m at their native scale; first person wants them taller.
          const h = shape === S.tree ? 4.8 + ((seed >> 16) & 7) * 0.12 : f.h / (f.ppm ?? 16);
          // Tall trees dissolve (dithered) when the camera is right next to them instead of
          // filling the view with a handful of giant texels. (A 3D trunk box was tried: it
          // never lines up with the billboard's drawn trunk and looked worse.)
          if (wantsFlora3d(!!LF?.trees3d, !!extras?.near, isBareTree(f, shape === S.shrub))) trees.push({ x: x + 0.5 + jx, y: y + 0.5 + jy, z, frame: f, height: h, shrub: shape === S.shrub, seed: seed ^ 0x5bd1e995, id: def.id, season, lod: extras?.near ? 0 : extras?.mid ? 1 : 2 });
          else sprites.push({ x: x + 0.5 + jx, y: y + 0.5 + jy, z, frame: f, height: h, kind: 'tree', fadeNear: shape === S.tree });
          break;
        }
        case S.stairs_up: {
          const f = src.terrain(def.id, 'floor');
          // Rise toward a wall if there is one (stairs usually run along a wall).
          let dir = 0;
          for (let d = 0; d < 4; d++) if (isWall(nShape[d])) { dir = d; break; }
          const n = 8;
          const g = geo(f);
          for (let i = 0; i < n; i++) {
            const a = i / n, b = (i + 1) / n;
            const h = base + ((i + 1) / n) * LEVEL_HEIGHT;
            const [bx0, bz0, bx1, bz1] =
              dir === 0 ? [x, y + 1 - b, x + 1, y + 1 - a] :
              dir === 1 ? [x + a, y, x + b, y + 1] :
              dir === 2 ? [x, y + a, x + 1, y + b] : [x + 1 - b, y, x + 1 - a, y + 1];
            g.box(bx0, base, bz0, bx1, h, bz1, 63 & ~8, f, f, base);
          }
          break;
        }
      }

      // Skirts: where this tile's surface stands above a neighbour's (curbs, relief meeting
      // a lower tile), close the gap with a vertical face toward the neighbour.
      if (G && groundBearing(shape)) {
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (!groundBearing(nShape[d])) continue;
          const [P, Q] = SKIRT_EDGE[d];
          const PX = x + P[0], PY = y + P[1], QX = x + Q[0], QY = y + Q[1];
          const hiP = surfH(x, y, PX, PY), hiQ = surfH(x, y, QX, QY);
          const loP = surfH(nx, ny, PX, PY), loQ = surfH(nx, ny, QX, QY);
          if (hiP - loP < 0.01 && hiQ - loQ < 0.01) continue;
          const fid = shape === S.floor ? def.id : neighborFloor(x, y) ?? 't_dirt';
          const f = src.terrain(fid, 'floor', { variantSeed: seed, season });
          const u0 = d === 1 || d === 3 ? PY : PX, u1 = d === 1 || d === 3 ? QY : QX;
          geo(f).quad([PX, base + Math.min(loP, hiP), PY], [QX, base + Math.min(loQ, hiQ), QY], [QX, base + hiQ, QY], [PX, base + hiP, PY], SKIRT_N[d],
            [u0, 0, u1, Math.max(hiP - loP, hiQ - loQ)], f, [0.7, 0.7, 1, 1]);
        }
      }
      // Scattered props (rocks, twigs, litter, puddles) on this tile
      if (LF?.props && extras) {
        const li = ly * CHUNK + lx;
        emitProps(geo, extras.white, x, y, z, base, def, shape === S.tree || shape === S.shrub, shape === S.floor,
          chunk.furn[li] !== 0 || chunk.items.has(li), nShape.some((ns) => ns === S.tree), curSky >= 1, G ? groundLocal : null, pud);
      }
      // Furniture
      const fi = chunk.furn[ly * CHUNK + lx];
      // Where items on this tile sit: on the furniture's top, or hidden inside it.
      let itemLift = 0, itemsHidden = false;
      if (fi !== 0) {
        const fdef = map.furniture.defs[fi];
        const fs = shapes.furniture(fi);
        // CDDA CONTAINER furniture (lockers, dressers, fridges) holds its items out of sight
        itemsHidden = hasFlag(fdef, 'CONTAINER') || hasFlag(fdef, 'SEALED');
        itemLift = fs === 'billboard' ? (/bed|couch|sofa|mattress|cot/.test(fdef.id) ? 0.45 : 0) : FURN_TOP[fs];
        const mt = MD?.topOf(fdef.id);
        if (mt != null) itemLift = mt;
      }
      if (fi !== 0) {
        const fdef = map.furniture.defs[fi];
        const fs = shapes.furniture(fi);
        const fb = base + raiseOf(x, y);
        if (cardsOn() && isFigure(fdef.id) && bakeFigure(geo, fdef.id, x, y, fb, Math.PI - facingYaw(nShape, isWall), seed)) {
          // mannequins and statues: a posed humanoid (render/chars/figures.ts)
        } else if (MD && MD.furniture(geo, glassGeo, src, fdef.id, x, y, fb, seed, {
          wall: nShape.map(wallLike),
          furn: (dx, dy) => (dx || dy ? map.furnAt(x + dx, y + dy, z).id : fdef.id),
          wallAt: (dx, dy) => wallLike(shapeAt(here, x + dx, y + dy)),
        })) {
          // drawn as a modelled piece (furniture/)
        } else if (fs === 'billboard' && LF?.voxelProps && extras?.near && extras?.voxels && extras.voxels.furniture(geo, extras.white, src, fdef.id, x, y, fb, seed, facingYaw(nShape, isWall))) {
          // drawn as a voxel volume
        } else if (fs === 'billboard') {
          const f = src.furniture(fdef.id, 'sprite');
          // world-fixed crossed cards instead of a camera-facing billboard (render/cards.ts)
          if (cardsOn()) crossCards(geo, f, x + 0.5, y + 0.5, fb, f.h / (f.ppm ?? 16), seed, 2);
          else sprites.push({ x: x + 0.5, y: y + 0.5, z, frame: f, height: f.h / (f.ppm ?? 16), kind: 'furniture' });
        } else {
          const top = src.furniture(fdef.id, 'top');
          const side = src.furniture(fdef.id, 'side');
          if (fs === 'table') {
            const g = geo(top);
            g.box(x + 0.04, fb + 0.74, y + 0.04, x + 0.96, fb + 0.8, y + 0.96, 63, side, top, fb);
            const L = 0.07;
            for (const [lx2, lz2] of [[0.1, 0.1], [0.83, 0.1], [0.1, 0.83], [0.83, 0.83]])
              geo(side).box(x + lx2, fb, y + lz2, x + lx2 + L, fb + 0.74, y + lz2 + L, 63 & ~12, side, side, fb);
          } else {
            const h = fs === 'cabinet' ? 1.85 : 0.92;
            const ins = fs === 'cabinet' ? 0.06 : 0.02;
            geo(side).box(x + ins, fb, y + ins, x + 1 - ins, fb + h, y + 1 - ins, 63 & ~8, side, top, fb);
          }
        }
      }

      // Items: the top item's sprite; a pile (2+) shows up to three items spread around the
      // tile so it reads as a heap. Items in container furniture are hidden like CDDA does.
      const list = chunk.items.get(ly * CHUNK + lx);
      if (list && list.length && !itemsHidden) {
        const n = Math.min(3, list.length);
        for (let k = 0; k < n; k++) {
          const it = list[list.length - 1 - k];
          if (items && !items(it.typeId)) continue;
          if (MD && MD.item(geo, src, it.typeId, x, y, base + heightLocal(x + 0.5, y + 0.5) + itemLift, seed, k)) continue;
          const f = src.item(it.typeId);
          // only the top of a pile becomes a volume (the rest stay small billboards): piles in
          // stores and warehouses otherwise dominate the chunk's meshing time
          if (k === 0 && LF?.voxelProps && extras?.near && extras?.voxels && extras.voxels.item(geo, extras.white, f, x, y, base + heightLocal(x + 0.5, y + 0.5) + itemLift, seed, k)) continue;
          const h = (f.h / (f.ppm ?? 16)) * 0.5;
          // pile offsets: deterministic per tile so rebuilds don't shuffle the heap
          const a = ((seed >> (k * 3)) & 7) * 0.785 + k * 2.1;
          const r = k === 0 ? 0 : 0.2;
          if (cardsOn()) flatCard(geo, f, x + 0.5 + Math.cos(a) * r, y + 0.5 + Math.sin(a) * r, base + heightLocal(x + 0.5, y + 0.5) + itemLift + k * 0.004, h * 1.3, a * 1.7 + k);
          else sprites.push({ x: x + 0.5 + Math.cos(a) * r, y: y + 0.5 + Math.sin(a) * r, z, frame: f, height: h, kind: 'item', lift: itemLift - 0.12 * h });
        }
      }
      // Fields: floor decals (blood, bile...) go into the chunk geometry; smoke/gas are
      // dithered translucent billboards; fire is a billboard (its light is in the light map).
      const fl = chunk.fields.get(ly * CHUNK + lx);
      if (fl) for (const fd of fl) {
        const st = fieldStyle(fd.type);
        const lvl = Math.max(1, Math.min(3, fd.intensity));
        if (st.kind === 'fire') {
          if (cardsOn()) crossCards(geo, src.sprite(`${fd.type}_int${lvl}`), x + 0.5, y + 0.5, base + heightLocal(x + 0.5, y + 0.5), 0.5 + lvl * 0.25, seed, 3);
          else sprites.push({ x: x + 0.5, y: y + 0.5, z, frame: src.sprite(`${fd.type}_int${lvl}`), height: 0.5 + lvl * 0.25, kind: 'fire' });
        } else if (st.kind === 'decal') {
          const f = src.sprite(`${fd.type}_int${lvl}`);
          // random quarter turn per tile breaks up repeats; rotate is honoured by topQuad
          const rf: TileFrame = { ...f, rotate: ((seed >> 5) & 3) as 0 | 1 | 2 | 3 };
          if (G && shape !== S.liquid) groundQuad(x, y, base, rf, undefined, false, DECAL_LIFT);
          else topQuad(x, y, base + (shape === S.liquid ? -WATER_DROP : 0) + DECAL_LIFT, rf);
        } else if (st.kind === 'cloud') {
          const f = src.sprite(`${fd.type}_int${lvl}`);
          sprites.push({ x: x + 0.5, y: y + 0.5, z, frame: f, height: 1.2 + lvl * 0.35, kind: 'cloud', lift: 0.15, opacity: 0.3 + lvl * 0.15 });
        }
      }
      // first sight of many new furniture/item models (painting their faces) can make a
      // row expensive: yield mid-row then (furniture/index.ts yieldHint)
      if (MD?.yieldHint()) yield;
    }
  }
  return { pages, sprites, puddles: pud.g, trees: trees.length ? trees : undefined, glass: glassB.g };
}

/** Standing props face away from an adjacent wall (the sprite's front is south, +z). */
function facingYaw(nShape: number[], isWall: (s: number) => boolean): number {
  // wall to the N -> face S (0); E -> face W; S -> face N; W -> face E
  const yaw = [0, -Math.PI / 2, Math.PI, Math.PI / 2];
  for (let d = 0; d < 4; d++) if (isWall(nShape[d])) return yaw[d];
  return 0;
}

/** Roof terrains that get a hipped roof (houses); other ROOF tiles stay flat with parapets. */
const PITCHED = /^t_(shingle_flat_roof|thatch_roof|tile_flat_roof)$/;

// Skirt edges per direction (N, E, S, W): corner offsets P, Q (P first, CCW seen from the
// neighbour) and the outward normal, matching sideFace's winding.
const SKIRT_EDGE: [[number, number], [number, number]][] = [[[1, 0], [0, 0]], [[1, 1], [1, 0]], [[0, 1], [1, 1]], [[0, 0], [0, 1]]];
const SKIRT_N: [number, number, number][] = [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0]];

function connMask(nShape: number[], pred: (s: number) => boolean): number {
  let m = 0;
  for (let d = 0; d < 4; d++) if (pred(nShape[d])) m |= 1 << d;
  return m;
}

/** GeomBuilder.box face bits for the 4 horizontal directions whose neighbor isn't `solid`. */
function exposedFaces(nShape: number[], solid: (s: number) => boolean): number {
  // N = -z (32), E = +x (1), S = +z (16), W = -x (2)
  const bits = [32, 1, 16, 2];
  let m = 0;
  for (let d = 0; d < 4; d++) if (!solid(nShape[d])) m |= bits[d];
  return m;
}

/** Vertical face on tile (x,y)'s edge toward direction d, facing outward. */
function sideFace(g: GeomBuilder, x: number, y: number, d: number, y0: number, y1: number, f: TileFrame, vBase: number, cut = 0): void {
  const v0 = y0 - vBase, v1 = y1 - vBase;
  const AO = [0.78, 0.78, 1, 1];
  switch (d) {
    case 0: g.quad([x + 1, y0, y], [x, y0, y], [x, y1, y], [x + 1, y1, y], [0, 0, -1], [-x - 1, v0, -x, v1], f, AO, cut); break;
    case 1: g.quad([x + 1, y0, y + 1], [x + 1, y0, y], [x + 1, y1, y], [x + 1, y1, y + 1], [1, 0, 0], [-y - 1, v0, -y, v1], f, AO, cut); break;
    case 2: g.quad([x, y0, y + 1], [x + 1, y0, y + 1], [x + 1, y1, y + 1], [x, y1, y + 1], [0, 0, 1], [x, v0, x + 1, v1], f, AO, cut); break;
    case 3: g.quad([x, y0, y], [x, y0, y + 1], [x, y1, y + 1], [x, y1, y], [-1, 0, 0], [y, v0, y + 1, v1], f, AO, cut); break;
  }
}

/** Double-sided thin pane through the tile centre (two back-to-back quads). */
function paneQuads(g: GeomBuilder, x: number, y: number, alongX: boolean, y0: number, y1: number, f: TileFrame, vBase: number): void {
  const v0 = y0 - vBase, v1 = y1 - vBase;
  if (alongX) {
    const zc = y + 0.5;
    g.quad([x, y0, zc], [x + 1, y0, zc], [x + 1, y1, zc], [x, y1, zc], [0, 0, 1], [x, v0, x + 1, v1], f);
    g.quad([x + 1, y0, zc], [x, y0, zc], [x, y1, zc], [x + 1, y1, zc], [0, 0, -1], [-x - 1, v0, -x, v1], f);
  } else {
    const xc = x + 0.5;
    g.quad([xc, y0, y + 1], [xc, y0, y], [xc, y1, y], [xc, y1, y + 1], [1, 0, 0], [-y - 1, v0, -y, v1], f);
    g.quad([xc, y0, y], [xc, y0, y + 1], [xc, y1, y + 1], [xc, y1, y], [-1, 0, 0], [y, v0, y + 1, v1], f);
  }
}

/** Double-sided pane from the tile centre to its edge in direction d (fence segments). */
function halfPane(g: GeomBuilder, x: number, y: number, d: number, y0: number, y1: number, f: TileFrame): void {
  const cx = x + 0.5, cz = y + 0.5;
  const ex = cx + DX[d] * 0.5, ez = cz + DY[d] * 0.5;
  const v0 = 0, v1 = y1 - y0;
  // normal perpendicular to the segment, horizontal
  const nx = -(ez - cz), nz = ex - cx;
  const len = Math.hypot(nx, nz);
  const n: [number, number, number] = [nx / len, 0, nz / len];
  const u0 = DX[d] !== 0 ? cx : cz, u1 = DX[d] !== 0 ? ex : ez;
  g.quad([cx, y0, cz], [ex, y0, ez], [ex, y1, ez], [cx, y1, cz], [-n[0], 0, -n[2]], [u0, v0, u1, v1], f);
  g.quad([ex, y0, ez], [cx, y0, cz], [cx, y1, cz], [ex, y1, ez], n, [u1, v0, u0, v1], f);
}

/** Pick the id of an adjacent wall so window/door frames match the surrounding wall. */
function findWallId(s: LevelSampler, shapes: ShapeTable, defs: { id: string }[], x: number, y: number): string | null {
  for (let d = 0; d < 4; d++) {
    const i = s.ter(x + DX[d], y + DY[d]);
    if (shapes.terrain(i) === S.wall) return defs[i].id;
  }
  return null;
}

/** +1 if the INDOORS side is +y (alongX) / +x, -1 otherwise. */
function indoorSide(s: LevelSampler, defs: { flags: string[] }[], x: number, y: number, alongX: boolean): number {
  const [ax, ay] = alongX ? [0, 1] : [1, 0];
  const plus = defs[s.ter(x + ax, y + ay)].flags.includes('INDOORS');
  const minus = defs[s.ter(x - ax, y - ay)].flags.includes('INDOORS');
  return plus || !minus ? 1 : -1;
}
