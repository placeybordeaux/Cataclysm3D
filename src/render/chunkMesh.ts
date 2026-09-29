import type * as THREE from 'three';
import { CHUNK, LEVEL_HEIGHT, chunkOf, localOf } from '../world/coords';
import type { Chunk, GameMap } from '../world/map';
import { pointSeed } from './atlasIndex';
import { GeomBuilder } from './geometry';
import type { TileFrame, TileTextureSource } from './textureSource';
import { hasFlag } from '../world/registry';
import { fieldStyle, furnitureShape, terrainShape, type FurnitureShape, type TerrainShape } from './tileKinds';

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
}

const SHAPES: TerrainShape[] = ['none', 'floor', 'liquid', 'wall', 'halfwall', 'window', 'door', 'door_open', 'fence', 'tree', 'shrub', 'stairs_up', 'stairs_down'];
const S = Object.fromEntries(SHAPES.map((s, i) => [s, i])) as Record<TerrainShape, number>;

/** Per-registry-index shape codes, extended lazily as ids get interned. */
export class ShapeTable {
  private ter = new Uint8Array(0);
  private furn: FurnitureShape[] = [];
  constructor(private map: GameMap) {}
  terrain(i: number): number {
    if (i >= this.ter.length) {
      const defs = this.map.terrain.defs;
      const t = new Uint8Array(defs.length);
      for (let k = 0; k < defs.length; k++) t[k] = S[terrainShape(defs[k])];
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
  season: 'spring' | 'summer' | 'autumn' | 'winter', items?: (id: string) => boolean,
): ChunkMeshData {
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
  const emitFloor = (x: number, y: number, id: string, seed: number, y0 = base) => {
    const f = src.terrain(id, 'floor', { variantSeed: seed, season });
    const ao = [cornerAo(x, y, -1, 1), cornerAo(x, y, 1, 1), cornerAo(x, y, 1, -1), cornerAo(x, y, -1, -1)];
    topQuad(x, y, y0, f, ao);
  };

  for (let ly = 0; ly < CHUNK; ly++)
    for (let lx = 0; lx < CHUNK; lx++) {
      const x = x0c + lx, y = y0c + ly;
      const ti = chunk.ter[ly * CHUNK + lx];
      const def = terDefs[ti];
      const shape = shapes.terrain(ti);
      const seed = pointSeed(x, y) >>> 0;
      const nShape = [0, 1, 2, 3].map((d) => shapeAt(here, x + DX[d], y + DY[d]));
      const skyOf = (tx: number, ty: number) => (shapeAt(above, tx, ty) !== S.none ? INDOOR_SKY : 1);
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
          geo(f).quad([x, base - SLAB, y], [x + 1, base - SLAB, y], [x + 1, base - SLAB, y + 1], [x, base - SLAB, y + 1], [0, -1, 0], [x, y, x + 1, y + 1], f);
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
            sideFace(geo(side), x, y, d, base, base + top, side, base, 1);
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
          g.box(x, base, y, x + 1, base + SILL_H, y + 1, faces | 4, side, cap, base, 1);
          g.box(x, base + DOOR_H, y, x + 1, base + WALL_TOP, y + 1, faces | 8, side, cap, base, 1);
          paneQuads(geo(pane), x, y, alongX, base + SILL_H, base + DOOR_H, pane, base + SILL_H);
          break;
        }
        case S.door:
        case S.door_open: {
          const floorId = neighborFloor(x, y);
          if (floorId) emitFloor(x, y, floorId, seed);
          const alongX = wallLike(nShape[1]) || wallLike(nShape[3]) || !(wallLike(nShape[0]) || wallLike(nShape[2]));
          const wallId = findWallId(here, shapes, terDefs, x, y) ?? 't_wall';
          const side = src.terrain(wallId, 'wall');
          const cap = src.terrain(wallId, 'top');
          geo(side).box(x, base + DOOR_H, y, x + 1, base + WALL_TOP, y + 1, exposedFaces(nShape, isWall) | 8, side, cap, base, 1);
          const slab = src.terrain(def.id, 'pane');
          const T = 0.08;
          const g = geo(slab);
          if (shape === S.door) {
            if (alongX) g.box(x, base, y + 0.5 - T / 2, x + 1, base + DOOR_H, y + 0.5 + T / 2, 63 & ~8, slab, slab, base);
            else g.box(x + 0.5 - T / 2, base, y, x + 0.5 + T / 2, base + DOOR_H, y + 1, 63 & ~8, slab, slab, base);
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
          const pane = src.terrain(def.id, 'pane');
          const h = /chain|wire|bars/.test(def.id) ? 2.0 : 1.1;
          const conn = (s: number) => s === S.fence || wallLike(s);
          const g = geo(pane);
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
          sprites.push({ x: x + 0.5 + jx, y: y + 0.5 + jy, z, frame: f, height: h, kind: 'tree', fadeNear: shape === S.tree });
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
      }
      if (fi !== 0) {
        const fdef = map.furniture.defs[fi];
        const fs = shapes.furniture(fi);
        if (fs === 'billboard') {
          const f = src.furniture(fdef.id, 'sprite');
          sprites.push({ x: x + 0.5, y: y + 0.5, z, frame: f, height: f.h / (f.ppm ?? 16), kind: 'furniture' });
        } else {
          const top = src.furniture(fdef.id, 'top');
          const side = src.furniture(fdef.id, 'side');
          if (fs === 'table') {
            const g = geo(top);
            g.box(x + 0.04, base + 0.74, y + 0.04, x + 0.96, base + 0.8, y + 0.96, 63, side, top, base);
            const L = 0.07;
            for (const [lx2, lz2] of [[0.1, 0.1], [0.83, 0.1], [0.1, 0.83], [0.83, 0.83]])
              geo(side).box(x + lx2, base, y + lz2, x + lx2 + L, base + 0.74, y + lz2 + L, 63 & ~12, side, side, base);
          } else {
            const h = fs === 'cabinet' ? 1.85 : 0.92;
            const ins = fs === 'cabinet' ? 0.06 : 0.02;
            geo(side).box(x + ins, base, y + ins, x + 1 - ins, base + h, y + 1 - ins, 63 & ~8, side, top, base);
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
          const f = src.item(it.typeId);
          const h = (f.h / (f.ppm ?? 16)) * 0.5;
          // pile offsets: deterministic per tile so rebuilds don't shuffle the heap
          const a = ((seed >> (k * 3)) & 7) * 0.785 + k * 2.1;
          const r = k === 0 ? 0 : 0.2;
          sprites.push({ x: x + 0.5 + Math.cos(a) * r, y: y + 0.5 + Math.sin(a) * r, z, frame: f, height: h, kind: 'item', lift: itemLift - 0.12 * h });
        }
      }
      // Fields: floor decals (blood, bile...) go into the chunk geometry; smoke/gas are
      // dithered translucent billboards; fire is a billboard (its light is in the light map).
      const fl = chunk.fields.get(ly * CHUNK + lx);
      if (fl) for (const fd of fl) {
        const st = fieldStyle(fd.type);
        const lvl = Math.max(1, Math.min(3, fd.intensity));
        if (st.kind === 'fire') {
          sprites.push({ x: x + 0.5, y: y + 0.5, z, frame: src.sprite(`${fd.type}_int${lvl}`), height: 0.5 + lvl * 0.25, kind: 'fire' });
        } else if (st.kind === 'decal') {
          const f = src.sprite(`${fd.type}_int${lvl}`);
          // random quarter turn per tile breaks up repeats; rotate is honoured by topQuad
          const rf: TileFrame = { ...f, rotate: ((seed >> 5) & 3) as 0 | 1 | 2 | 3 };
          topQuad(x, y, base + (shape === S.liquid ? -WATER_DROP : 0) + DECAL_LIFT, rf);
        } else if (st.kind === 'cloud') {
          const f = src.sprite(`${fd.type}_int${lvl}`);
          sprites.push({ x: x + 0.5, y: y + 0.5, z, frame: f, height: 1.2 + lvl * 0.35, kind: 'cloud', lift: 0.15, opacity: 0.3 + lvl * 0.15 });
        }
      }
    }
  return { pages, sprites };
}

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
