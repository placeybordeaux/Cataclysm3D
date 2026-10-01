import { CHUNK, MIN_Z } from '../world/coords';

// Where a creature can be put: ONE rule for every path that places a monster (mapgen spawns,
// city hordes, dormant corpses, stash restore, save load, revives, debug spawns) and for the
// settle pass that fixes up monsters loaded somewhere they can't be.
//
// BN: map::spawn_monsters_submap_group only takes `passable(p) && has_floor(p)` tiles; single
// spawns (overmap "spawns", mapgen monsters) go through monster::can_move_to, which lets a
// zombie stand on open air for exactly as long as it takes to fall (every level of the bubble
// is simulated there). Here monsters off the player's level +-1 are dormant and never get that
// fall, so an apartment tower's static spawn rolled onto the open air beside an upper storey
// hung there: the "floating zombies" of the levels-from-the-world change, which started
// generating every storey of every column.

export interface StandMap {
  passable(x: number, y: number, z: number): boolean;
  hasFloor(x: number, y: number, z: number): boolean;
  hasChunk(cx: number, cy: number, z: number): boolean;
}

/** Something that may be standing there: a monster, or its type before it exists. */
export interface Stander {
  flags?: readonly string[];
}

export const flies = (s: Stander): boolean => !!s.flags?.includes('FLIES');

const loaded = (map: StandMap, x: number, y: number, z: number) => map.hasChunk(Math.floor(x / CHUNK), Math.floor(y / CHUNK), z);

/**
 * Can `s` be at tile (x, y, z): passable, and a floor under it unless it flies. Reads the map
 * (generating the chunk if it isn't); see `standKnown` for the never-generating version.
 */
export function canStandAt(map: StandMap, s: Stander, x: number, y: number, z: number): boolean {
  return map.passable(x, y, z) && (flies(s) || map.hasFloor(x, y, z));
}

/** canStandAt for an already generated chunk; null = unknown (not generated: nothing is made here). */
export function standKnown(map: StandMap, s: Stander, x: number, y: number, z: number): boolean | null {
  return loaded(map, x, y, z) ? canStandAt(map, s, x, y, z) : null;
}

/** hasFloor for an already generated chunk; null = not generated. */
export function floorKnown(map: StandMap, x: number, y: number, z: number): boolean | null {
  return loaded(map, x, y, z) ? map.hasFloor(x, y, z) : null;
}

export interface StandOpts {
  /** only look at generated chunks (dormant/far monsters: asking must not run mapgen) */
  loadedOnly?: boolean;
  /** furthest ring (tiles) searched on the same level; default: the OMT (chunk) */
  radius?: number;
  /** tile already taken by another creature (skipped by the same-level search) */
  occupied?: (x: number, y: number, z: number) => boolean;
}

/**
 * Where to put `s` asked for at tile (x, y, z): the tile itself when it can stand there, else
 * the nearest tile on the same level inside the same OMT (so a tower's zombie stays in the
 * tower), else straight down to the first level it can stand on (where BN's fall would leave
 * it), else null (nowhere: the caller skips it and says so).
 */
export function standingSpot(map: StandMap, s: Stander, x: number, y: number, z: number, opts: StandOpts = {}): { x: number; y: number; z: number } | null {
  const ok = (tx: number, ty: number, tz: number) =>
    (!opts.loadedOnly || loaded(map, tx, ty, tz)) && canStandAt(map, s, tx, ty, tz);
  if (ok(x, y, z)) return { x, y, z };
  const x0 = Math.floor(x / CHUNK) * CHUNK, y0 = Math.floor(y / CHUNK) * CHUNK;
  const R = opts.radius ?? CHUNK;
  if (!opts.loadedOnly || loaded(map, x, y, z))
    for (let r = 1; r <= R; r++) {
      // ring r (Chebyshev), clipped to the OMT
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = x + dx, ty = y + dy;
          if (tx < x0 || ty < y0 || tx >= x0 + CHUNK || ty >= y0 + CHUNK) continue;
          if (opts.occupied?.(tx, ty, z)) continue;
          if (ok(tx, ty, z)) return { x: tx, y: ty, z };
        }
    }
  // down the column: through open air (no floor) only; a floor it can't stand on (a wall, a
  // closed hatch) stops the fall like BN's has_floor check does
  if (opts.loadedOnly && !loaded(map, x, y, z)) return null;
  if (map.hasFloor(x, y, z)) return null;
  for (let tz = z - 1; tz >= MIN_Z; tz--) {
    if (opts.loadedOnly && !loaded(map, x, y, tz)) return null;
    if (ok(x, y, tz)) return { x, y, z: tz };
    if (map.hasFloor(x, y, tz)) return null;
  }
  return null;
}
