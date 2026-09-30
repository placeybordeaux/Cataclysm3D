import type { GeomBuilder } from '../geometry';
import type { TileFrame, TileTextureSource } from '../textureSource';
import { framePixels } from '../framePixels';
import { hashString } from '../../core/rng';
import { ModelAtlas } from './atlas';
import { archetypeFor, terrainArchetype, type Archetype } from './catalog';
import { BACK, FRONT, LEFT, RIGHT, type Ctx } from './kit';
import { ModelBuilder, placeModel, type ModelMesh } from './mesh';
import { flatPalette, spritePalette, type SpritePalette } from './palette';
import { buildItem, itemHeight, itemShape, itemSize } from './items';
import { buildDoorLeaf, buildWindow, curtainColour, doorKind, windowState } from './openings';
import type { ItemDef } from '../../data/types';

// Modelled furniture (docs/FURNITURE.md): low-poly pieces with per-face pixel textures in
// place of voxel-inflated sprites. The chunk mesher asks `furniture()` first; a null answer
// (id not in the catalog) falls through to the voxel / billboard path, so coverage can grow
// one archetype at a time.
//
// Style switch: `?furniture=model|voxel`, Options > Furniture, `cdda.setFurnitureStyle()`.

export type FurnitureStyle = 'model' | 'voxel';
export const FURNITURE_STYLES: FurnitureStyle[] = ['model', 'voxel'];
const STORE_KEY = 'cdda3d.furnitureStyle';

function initialStyle(): FurnitureStyle {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('furniture') : null;
  if (q) {
    if (!FURNITURE_STYLES.includes(q as FurnitureStyle)) throw new Error(`?furniture must be one of ${FURNITURE_STYLES.join('|')}, got ${q}`);
    return q as FurnitureStyle;
  }
  try {
    const s = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
    if (s && FURNITURE_STYLES.includes(s as FurnitureStyle)) return s as FurnitureStyle;
  } catch { /* storage blocked: default */ }
  return 'model';
}

export const furnitureState = { style: initialStyle() };

export function storeFurnitureStyle(s: FurnitureStyle): void {
  try {
    localStorage.setItem(STORE_KEY, s);
  } catch { /* storage blocked */ }
}

/** Neighbourhood the mesher knows (world directions N, E, S, W). */
export interface Around {
  /** wall-like terrain toward direction d (0 N, 1 E, 2 S, 3 W) */
  wall: boolean[];
  /** furniture id at an offset from the tile (f_null for none) */
  furn(dx: number, dy: number): string;
  /** wall-like terrain at an offset (for pieces spanning tiles: a bed's head wall) */
  wallAt(dx: number, dy: number): boolean;
}

/** Cost counters (cdda.furnitureStats): models built, placements, quads baked. */
export const modelStats = { built: 0, buildMs: 0, placed: 0, placeMs: 0, quads: 0 };

// World direction tables, y south: N, E, S, W.
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
/** yaw that turns the model's front (+z, south) toward world direction d */
const YAW_FACING = [Math.PI, Math.PI / 2, 0, -Math.PI / 2];

export class ModelFactory {
  readonly atlas = new ModelAtlas();
  private meshes = new Map<string, ModelMesh>();
  private palettes = new Map<string, SpritePalette>();
  private itemMeshes = new Map<string, { m: ModelMesh; h: number } | null>();
  /** item definitions (set by the renderer): shape and size come from category / volume */
  itemDefs: Record<string, ItemDef> = {};

  /**
   * Bake ground item `typeId` (the k-th from the top of its pile) on tile (x, y) resting at
   * height `y0`. Returns false when there is no definition (caller falls back).
   */
  item(geo: (f: TileFrame) => GeomBuilder, src: TileTextureSource, typeId: string, x: number, y: number, y0: number, seed: number, k: number): boolean {
    let e = this.itemMeshes.get(typeId);
    if (e === undefined) {
      const d = this.itemDefs[typeId];
      if (!d) e = null;
      else {
        const tb = performance.now();
        const shape = itemShape(d);
        const s = itemSize(d.volume);
        const px = framePixels(src.item(typeId));
        const pal = (px && spritePalette(px)) ?? flatPalette([150, 140, 120]);
        const b = new ModelBuilder(this.atlas);
        buildItem(b, shape, s, pal, hashString(typeId));
        e = { m: b.done(), h: itemHeight(shape, s) };
        modelStats.built++;
        modelStats.buildMs += performance.now() - tb;
      }
      this.itemMeshes.set(typeId, e);
    }
    if (!e) return false;
    const t0 = performance.now();
    // pile layout: deterministic per tile so rebuilds don't shuffle the heap
    const a = ((seed >>> (k * 3)) & 7) * 0.785 + k * 2.1;
    const r = k === 0 ? ((seed >>> 20) & 7) * 0.02 : 0.2 + ((seed >>> (k + 9)) & 3) * 0.03;
    const yaw = (((seed >>> (5 + k * 4)) & 15) / 16) * Math.PI * 2;
    placeModel(geo, e.m, { x: x + 0.5 + Math.cos(a) * r, y: y0 + 0.002, z: y + 0.5 + Math.sin(a) * r, yaw });
    modelStats.placed++;
    modelStats.quads += e.m.quads;
    modelStats.placeMs += performance.now() - t0;
    return true;
  }

  private terrainPalette(src: TileTextureSource, id: string): SpritePalette | null {
    const key = 't:' + id;
    if (this.palettes.has(key)) return this.palettes.get(key)!;
    const px = framePixels(src.terrain(id, 'sprite'));
    const p = px ? spritePalette(px) : null;
    if (p) this.palettes.set(key, p);
    return p;
  }

  /**
   * Window infill (glass, shards, tape, bars, curtains) for the opening of window tile
   * (x, y) between `sill` and `head`. `inward` = +1 when the indoor side is +y (alongX) /
   * +x, else -1.
   */
  window(geo: (f: TileFrame) => GeomBuilder, glass: () => GeomBuilder, src: TileTextureSource, id: string, x: number, y: number,
    sill: number, head: number, alongX: boolean, inward: number): boolean {
    const H = head - sill;
    const key = `w|${id}|${H.toFixed(2)}`;
    let m = this.meshes.get(key);
    if (!m) {
      const b = new ModelBuilder(this.atlas);
      buildWindow(b, windowState(id), H, curtainColour(this.terrainPalette(src, id)));
      m = b.done();
      this.meshes.set(key, m);
      modelStats.built++;
    }
    const yaw = alongX ? (inward > 0 ? 0 : Math.PI) : inward > 0 ? Math.PI / 2 : -Math.PI / 2;
    placeModel(geo, m, { x: x + 0.5, y: sill, z: y + 0.5, yaw }, glass);
    return true;
  }

  /**
   * Door leaf for door tile (x, y): closed in the opening, or open (swung 90 degrees
   * against the jamb toward the indoor side). False for gates and other non-doors.
   */
  door(geo: (f: TileFrame) => GeomBuilder, glass: () => GeomBuilder, src: TileTextureSource, id: string, x: number, y: number,
    base: number, height: number, alongX: boolean, open: boolean, inward: number): boolean {
    if (!/door/.test(id) || /fence|gate|chain/.test(id)) return false;
    const kind = doorKind(id);
    const key = `d|${id}|${height.toFixed(2)}`;
    let m = this.meshes.get(key);
    if (!m) {
      const b = new ModelBuilder(this.atlas);
      b.aoHeight = 0.12;
      buildDoorLeaf(b, kind, id, this.terrainPalette(src, id), 0.96, height);
      m = b.done();
      this.meshes.set(key, m);
      modelStats.built++;
    }
    // door-local frame like the window's (+z = inside); hinge at local (-0.48, 0)
    const Y = alongX ? (inward > 0 ? 0 : Math.PI) : inward > 0 ? Math.PI / 2 : -Math.PI / 2;
    const c = Math.cos(Y), s = Math.sin(Y);
    const hx = -0.48, hz = open ? 0.03 : 0;
    const theta = open ? -Math.PI / 2 : 0;
    placeModel(geo, m, { x: x + 0.5 + hx * c + hz * s, y: base, z: y + 0.5 - hx * s + hz * c, yaw: Y + theta }, glass);
    return true;
  }

  /** Pieces the catalog models (for the mesher's "does this replace the billboard" test). */
  has(id: string): boolean {
    return archetypeFor(id) !== null;
  }

  /** Item rest height on a modelled piece (m above its floor), or null if unmodelled. */
  topOf(id: string): number | null {
    const a = archetypeFor(id);
    return a ? a.top ?? 0 : null;
  }

  private palette(src: TileTextureSource, id: string): SpritePalette {
    let p = this.palettes.get(id);
    if (p) return p;
    const f = id.startsWith('t_') ? src.terrain(id, 'sprite') : src.furniture(id, 'sprite');
    const px = framePixels(f);
    p = (px && spritePalette(px)) ?? flatPalette([140, 120, 100]);
    this.palettes.set(id, p);
    return p;
  }

  /**
   * Bake furniture `id` at tile (x, y) (floor at `base`) into the chunk geometry. Returns
   * false when the id has no model (caller falls back).
   */
  furniture(geo: (f: TileFrame) => GeomBuilder, glass: () => GeomBuilder, src: TileTextureSource, id: string,
    x: number, y: number, base: number, seed: number, around: Around): boolean {
    const a = archetypeFor(id);
    if (!a) return false;
    this.piece(a, geo, glass, src, id, x, y, base, seed, around);
    return true;
  }

  /** Fixture-like terrain (consoles, ATMs, gas pumps) as a model; false if not one. */
  terrainProp(geo: (f: TileFrame) => GeomBuilder, glass: () => GeomBuilder, src: TileTextureSource, id: string,
    x: number, y: number, base: number, seed: number, around: Around): boolean {
    const a = terrainArchetype(id);
    if (!a) return false;
    this.piece(a, geo, glass, src, id, x, y, base, seed, around);
    return true;
  }

  private piece(a: Archetype, geo: (f: TileFrame) => GeomBuilder, glass: () => GeomBuilder, src: TileTextureSource, id: string,
    x: number, y: number, base: number, seed: number, around: Around): void {
    const t0 = performance.now();
    const same = (d: number) => {
      const n = around.furn(DX[d], DY[d]);
      return n !== 'f_null' && archetypeFor(n)?.group === a.group && !!a.group;
    };
    const worldConn = [0, 1, 2, 3].map(same);
    const face = facingDir(a, around, worldConn, seed);
    // local direction k (BACK, RIGHT, FRONT, LEFT) -> world direction
    const toWorld = (k: number) => (face + 2 + k) & 3;
    const conn = [0, 1, 2, 3].map((k) => worldConn[toWorld(k)]) as Ctx['conn'];
    if (a.axis === 'side') conn[BACK] = conn[FRONT] = false;
    const wall = [0, 1, 2, 3].map((k) => around.wall[toWorld(k)]) as Ctx['wall'];
    const variant = `${id}|${conn.map(Number).join('')}|${a.kind === 'shower' || a.kind === 'cupboard' ? wall.map(Number).join('') : ''}`;
    let m = this.meshes.get(variant);
    if (!m) {
      const tb = performance.now();
      const b = new ModelBuilder(this.atlas);
      a.build(b, { id, pal: this.palette(src, id), conn, wall, seed: hashString(id), p: a.p ?? {} });
      m = b.done();
      this.meshes.set(variant, m);
      modelStats.built++;
      modelStats.buildMs += performance.now() - tb;
    }
    placeModel(geo, m, { x: x + 0.5, y: base, z: y + 0.5, yaw: YAW_FACING[face] }, glass);
    modelStats.placed++;
    modelStats.quads += m.quads;
    modelStats.placeMs += performance.now() - t0;
  }
}

/** World direction (0 N .. 3 W) the piece's front faces. */
function facingDir(a: Archetype, around: Around, conn: boolean[], seed: number): number {
  if (a.facing === 'table') {
    // chairs turn to the table/desk next to them (edge neighbours first, then diagonals)
    for (let d = 0; d < 4; d++) if (isTableLike(around.furn(DX[d], DY[d]))) return d;
  }
  if (a.facing !== 'free') {
    // (counter runs turn corners: a run's tiles keep their own wall when they have one)
    const ownWall = around.wall.some((w) => w);
    if (a.group && conn.some((c) => c) && !(a.axis === 'side' && ownWall)) {
      // multi-tile pieces (2x2 beds, counter runs, sofas) share one facing: the wall most of
      // the group's tiles back onto, found by walking the connected tiles
      const d = groupWall(a, around);
      if (d >= 0) return (d + 2) & 3;
    }
    // in a corner, back onto the wall the run continues along
    if (a.axis === 'side') for (let d = 0; d < 4; d++) if (around.wall[d] && (conn[(d + 1) & 3] || conn[(d + 3) & 3])) return (d + 2) & 3;
    for (let d = 0; d < 4; d++) if (around.wall[d]) return (d + 2) & 3;
    // connected along x (east-west run): face north or south; along y: east or west
    if (conn[1] || conn[3]) return seed & 1 ? 2 : 0;
    if (conn[0] || conn[2]) return seed & 1 ? 1 : 3;
    // freestanding cabinets/appliances (rare in mapgen): face south like their sprite
    if (a.facing === 'wall') return 2;
  }
  return (seed >>> 3) & 3;
}

/** Direction (0 N .. 3 W) of the wall most tiles of this piece's group touch, or -1. */
function groupWall(a: Archetype, around: Around): number {
  const seen = new Set<string>(['0,0']);
  const todo: [number, number][] = [[0, 0]];
  const count = [0, 0, 0, 0];
  while (todo.length && seen.size < 12) {
    const [x, y] = todo.pop()!;
    for (let d = 0; d < 4; d++) {
      if (around.wallAt(x + DX[d], y + DY[d])) count[d]++;
      const nx = x + DX[d], ny = y + DY[d], k = `${nx},${ny}`;
      if (seen.has(k) || Math.abs(nx) > 3 || Math.abs(ny) > 3) continue;
      const n = around.furn(nx, ny);
      if (n === 'f_null' || archetypeFor(n)?.group !== a.group) continue;
      seen.add(k);
      todo.push([nx, ny]);
    }
  }
  let best = -1;
  for (let d = 0; d < 4; d++) if (count[d] > 0 && (best < 0 || count[d] > count[best])) best = d;
  return best;
}

const isTableLike = (id: string) => {
  const k = archetypeFor(id)?.kind;
  return k === 'table' || k === 'desk' || k === 'coffeetable' || k === 'workbench';
};

export { LEFT, RIGHT };
