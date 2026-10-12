import { CHUNK, MAX_Z, MIN_Z } from './coords';
import { terrainShape } from '../render/tileKinds';
import type { TerrainDef } from '../data/types';

// Which z-levels exist for the eye: ONE source of truth for the chunk manager, the prefetcher,
// the telemetry, and every view that decides whether a thing on another level is drawn
// (monsters, NPCs, vehicles, fire, arrows). docs/PERF.md "Levels from the world".
//
// The rule: what is drawn is derived from what the world contains, never from a window of
// levels around the player. The bug class it ends: a fixed window (player z - 1 .. z + 2) left
// the roof of a two-storey fire-station bay unbuilt (sky and sun through the ceiling), the street
// under a rooftop unbuilt (a flat pale sheet), and hid zombies one storey further down.
//
// Per column (one OMT = one chunk wide), the overmap says how tall it is without generating
// anything: its top is the highest level whose OMT isn't open air, plus one (mapgen writes a
// building's roof into the level above its top floor as an overlay). With the eye on the
// surface or above it, a column is drawn from the ground (or the player's window, if lower) up
// to its top; open-air chunks cost nothing (the chunk manager skips them without meshing).
// Underground the window around the player stays: rock hides the rest.

export interface OmtLookup {
  omtAt(x: number, y: number, z: number): { id: string };
}

/** What columnTop reads from the live map (GameMap): never generates. */
export interface LiveMap {
  hasChunk(cx: number, cy: number, z: number): boolean;
  chunk(cx: number, cy: number, z: number): { empty: boolean } | null;
  /** highest level holding any chunk (GameMap.topZ); absent = MAX_Z */
  topZ?(): number;
}

export interface LevelPolicy {
  /** draw radius (chunks) */
  radius: number;
  /** the player's own window: [pz - below, pz + above] is always drawn */
  below: number;
  above: number;
  /** 'world' (default): the per-column extent too; 'window': only the player's window (the old rule) */
  mode: 'world' | 'window';
}

const colKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);

export class VisibleLevels {
  /** the eye (tile coords), updated by the chunk manager every frame */
  readonly eye = { x: 0, y: 0, z: 0 };
  policy: LevelPolicy = { radius: 6, below: 1, above: 1, mode: 'world' };
  private tops = new Map<number, number>();
  /** this frame's live tops (generated chunks above the overmap's top: a player-built floor on a roof) */
  private live = new Map<number, number>();

  /**
   * `om` null = no overmap (gen=test): columns are as tall as the player's window or their
   * generated content. `map` (optional) adds what was built after mapgen.
   */
  constructor(private om: OmtLookup | null = null, public map: LiveMap | null = null) {}

  private frames = 0;
  /**
   * Start of a frame (the chunk manager calls this). Content above a column's overmap top only
   * appears through play (building on a roof), so the live tops are re-read every 30 frames:
   * a full re-scan every frame cost ~0.4 ms in a city.
   */
  beginFrame(): void {
    if (++this.frames % 30 === 0) this.live.clear();
  }

  /** Forget cached live tops now (a test or a debug edit placing terrain above a column's top). */
  refresh(): void {
    this.live.clear();
  }

  /**
   * Levels [lo, hi] column (cx, cy) can want with the eye on pz (radiusAt >= 0 inside, -1
   * outside). The chunk manager's per-frame loops iterate this instead of every level.
   */
  columnSpan(cx: number, cy: number, pz: number, p: LevelPolicy = this.policy): [number, number] {
    const wlo = Math.max(MIN_Z, pz - p.below), whi = Math.min(MAX_Z, pz + p.above);
    if (p.mode === 'window' || pz < 0) return [wlo, whi];
    const top = this.columnTop(cx, cy);
    const t = Number.isNaN(top) ? whi : Math.min(MAX_Z, top);
    return [Math.min(wlo, 0), Math.max(whi, t)];
  }

  get overmap(): OmtLookup | null {
    return this.om;
  }
  set overmap(o: OmtLookup | null) {
    this.om = o;
    this.tops.clear();
  }

  /**
   * Highest level column (cx, cy) has anything on: its top OMT + the roof overlay above it
   * (cached: the overmap never changes), raised by any generated non-empty chunk above that
   * (per frame). NaN = unknown (no overmap, nothing generated above the ground).
   */
  columnTop(cx: number, cy: number): number {
    const om = this.overmapTop(cx, cy);
    if (!this.map) return om;
    const k = colKey(cx, cy);
    let t = this.live.get(k);
    if (t !== undefined) return t;
    t = om;
    // generated, non-empty chunks above it (only those already generated: nothing is made here)
    for (let z = Math.min(MAX_Z, this.map.topZ?.() ?? MAX_Z); z > (Number.isNaN(om) ? MIN_Z : om); z--)
      if (this.map.hasChunk(cx, cy, z) && !this.map.chunk(cx, cy, z)!.empty) {
        t = z;
        break;
      }
    this.live.set(k, t);
    return t;
  }

  private overmapTop(cx: number, cy: number): number {
    if (!this.om) return NaN;
    const k = colKey(cx, cy);
    let t = this.tops.get(k);
    if (t !== undefined) return t;
    t = 0;
    for (let z = MAX_Z; z > 0; z--)
      if (!isAir(this.om.omtAt(cx, cy, z).id)) {
        t = z;
        break;
      }
    t = Math.min(MAX_Z, t + 1);
    // bounded: a long drive visits many columns
    if (this.tops.size > 50000) this.tops.clear();
    this.tops.set(k, t);
    return t;
  }

  /**
   * Radius (chunks) out to which level `z` of column (cx, cy) is drawn with the eye on `pz`;
   * -1 = never. Pure given the column's top (see levelRadius).
   */
  radiusAt(cx: number, cy: number, z: number, pz: number, p: LevelPolicy = this.policy): number {
    const inWindow = z >= pz - p.below && z <= pz + p.above;
    if (inWindow) return p.radius;
    if (p.mode === 'window') return -1;
    return levelRadius(z, pz, p.radius, p.below, p.above, this.columnTop(cx, cy));
  }

  /** Lowest and highest level any column can want with the eye on `pz` (loop bounds). */
  span(pz: number, p: LevelPolicy = this.policy): [number, number] {
    if (p.mode === 'window' || pz < 0) return [Math.max(MIN_Z, pz - p.below), Math.min(MAX_Z, pz + p.above)];
    return [Math.max(MIN_Z, Math.min(0, pz - p.below)), MAX_Z];
  }

  /**
   * Is level `z` at tile (x, y) drawn for the current eye (inside its column's radius)? What
   * views use to decide whether a creature, vehicle or effect on another level is shown.
   */
  drawn(x: number, y: number, z: number): boolean {
    const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK);
    const r = this.radiusAt(cx, cy, z, this.eye.z);
    if (r < 0) return false;
    const dx = cx - Math.floor(this.eye.x / CHUNK), dy = cy - Math.floor(this.eye.y / CHUNK);
    return dx * dx + dy * dy <= (r + 0.5) * (r + 0.5);
  }
}

/** Open air on the overmap (nothing to draw at that level of the column). */
export function isAir(omtId: string): boolean {
  return omtId === 'open_air' || omtId.startsWith('open_air_') || omtId === '';
}

/**
 * Chunk radius drawn on level `z` of a column whose top is `top` (NaN = unknown: no overmap),
 * with the eye on `pz`, or -1 for "not drawn".
 *  - the player's window [pz - below, pz + above]: R.
 *  - underground (pz < 0): nothing else (rock hides it; no surface through the ground).
 *  - on the surface or above: every level from the ground (0) up to the column's top: R, but
 *    R - 2 above the window (tower tops, high roofs: far ones are deep in the haze). Up a
 *    tower more than 4 storeys above the ground, the middle storeys (not the ground, z 1, the
 *    two under the player's window, or anything at or above it) get half the radius: far lower
 *    storeys of far towers are hidden behind the near ones and the fog.
 */
export function levelRadius(z: number, pz: number, R: number, below: number, above: number, top: number): number {
  if (z >= pz - below && z <= pz + above) return R;
  if (pz < 0 || z < 0) return -1;
  const t = Number.isNaN(top) ? pz + above : top;
  if (z > t) return -1;
  // above the window (tower tops, high roofs): out to R - 2, where the haze is already thick;
  // full radius cost ~2x the unbuilt-street time driving through a city (perf city40)
  if (z > pz + above) return Math.max(2, R - 2);
  const gap = pz - below - 1; // storeys strictly between the ground and the player's window
  if (z >= pz - below || gap <= 4 || z <= 1 || z >= pz - below - 2) return R;
  return Math.max(2, Math.ceil(R / 2));
}

/**
 * Is there anything overhead at tile (x, y) above level z — a floor, a roof, a catwalk — at any
 * height? The sky-light test for "indoors" (ambient, rain sound, sprites' sky term, the light
 * map's outside flag). Looking only one level up let the sun into a two-storey engine bay whose
 * z+1 is open air under a roof at z+3. `top` = the column's top if known.
 */
export function roofAbove(map: { terAt(x: number, y: number, z: number): TerrainDef; hasChunk?(cx: number, cy: number, z: number): boolean }, x: number, y: number, z: number, top: number | (() => number) = NaN): boolean {
  // the level above first (almost always the answer, and it's called per character per frame)
  if (terrainShape(map.terAt(x, y, z + 1)) !== 'none') return true;
  // then up to the column's top (VisibleLevels.columnTop), read only now: an open field doesn't
  // generate five levels of open air to find nothing
  const t = typeof top === 'function' ? top() : top;
  const hi = Number.isNaN(t) ? MAX_Z : Math.min(MAX_Z, t);
  // without a known top, only levels already generated (the chunk manager generates every level
  // a column has): asking about a far tile must not run mapgen up to the sky
  const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK);
  for (let zz = z + 2; zz <= hi; zz++) {
    if (Number.isNaN(t) && map.hasChunk && !map.hasChunk(cx, cy, zz)) continue;
    if (terrainShape(map.terAt(x, y, zz)) !== 'none') return true;
  }
  return false;
}
