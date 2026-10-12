import type { Game } from './game';
import { hasFlag } from '../world/registry';
import { furnitureSolidHeight, isBoxFurniture, raycastTiles } from './raycast';
import { LEVEL_HEIGHT } from '../world/coords';
import { CREATURE_RADIUS } from './physics';

// "What am I looking at?" for interaction keys (e / X): march the view ray from the eye out
// to arm's reach and return the first tile worth interacting with (a door, window, furniture,
// stairs, items, a sign …). Small on purpose; the UI's look-mode raycast (src/game/raycast.ts)
// is the general tool and the two can be merged later.

export interface TargetTile {
  x: number;
  y: number;
  z: number;
  /** Horizontal distance from the player to the tile centre, in tiles. */
  dist: number;
}

const EYE = 1.6, EYE_CROUCH = 1.0;
/** CDDA interaction range is adjacent tiles; 1.5 m from the eye covers diagonals. */
export const REACH = 1.5;

/** Is there anything on this tile an examine/smash could act on? */
export function interesting(game: Game, x: number, y: number, z: number): boolean {
  const map = game.map;
  const t = map.terAt(x, y, z);
  if (t.id === 't_null') return false;
  if (!map.passable(x, y, z)) return true;
  if (t.open || t.close || t.examine_action) return true;
  if (hasFlag(t, 'GOES_UP') || hasFlag(t, 'GOES_DOWN') || hasFlag(t, 'DOOR') || hasFlag(t, 'WINDOW')) return true;
  if (map.furnAt(x, y, z).id !== 'f_null') return true;
  if (map.itemsAt(x, y, z).length) return true;
  return false;
}

/** Unit view direction in world tiles: [dx (east), dy (south), dz (up)]. */
export function viewDir(game: Game): [number, number, number] {
  const p = game.player;
  const c = Math.cos(p.pitch);
  return [Math.sin(p.yaw) * c, -Math.cos(p.yaw) * c, Math.sin(p.pitch)];
}

/** The tile under the crosshair within `reach` (door, furniture, items, …) or null. */
export function targetTile(game: Game, reach = REACH): TargetTile | null {
  const p = game.player;
  const [dx, dy, dz] = viewDir(game);
  const eye = p.crouching ? EYE_CROUCH : EYE;
  const px = p.tileX, py = p.tileY;
  const steps = Math.ceil((reach + 1) / 0.05);
  let lastKey = '';
  for (let i = 1; i <= steps; i++) {
    const t = i * 0.05;
    const x = p.x + dx * t, y = p.y + dy * t, h = eye + dz * t;
    const horiz = Math.hypot(x - p.x, y - p.y);
    const tx = Math.floor(x), ty = Math.floor(y);
    const key = `${tx},${ty}`;
    // Looking down hits the floor: whatever is on that tile (items, stairs, a trap) is the target.
    if (h <= 0) {
      if (horiz <= reach + 0.5 && (tx !== px || ty !== py || interesting(game, tx, ty, p.z))) return { x: tx, y: ty, z: p.z, dist: horiz };
      return null;
    }
    if (horiz > reach + 0.5) break;
    // Standing over a climbable counter/table/cupboard (passable in CDDA): looking down into
    // it means it, not the piece next to it (the own tile used to be skipped outright).
    if (tx === px && ty === py && h <= furnitureSolidHeight(game.map.furnAt(tx, ty, p.z)) && isBoxFurniture(game.map.furnAt(tx, ty, p.z)))
      return { x: tx, y: ty, z: p.z, dist: horiz };
    if (key === lastKey || (tx === px && ty === py)) continue;
    lastKey = key;
    if (interesting(game, tx, ty, p.z)) return { x: tx, y: ty, z: p.z, dist: horiz };
    // Stop at walls that aren't interesting (can't reach through them).
    if (game.map.opaque(tx, ty, p.z)) break;
  }
  return null;
}

/** The adjacent tile the player faces (8 directions), for smash/close with nothing aimed at. */
export function frontTile(game: Game): TargetTile {
  const p = game.player;
  const a = Math.round(p.yaw / (Math.PI / 4)) * (Math.PI / 4);
  const ox = Math.round(Math.sin(a)), oy = Math.round(-Math.cos(a));
  return { x: p.tileX + ox, y: p.tileY + oy, z: p.z, dist: Math.hypot(ox, oy) };
}

/**
 * A person as `e` sees them: an upright cylinder on the spot they're drawn at (not their tile:
 * someone walking is drawn across two tiles). A little wider and taller than the body (0.3 m
 * radius) so aiming at someone's face or just over their head still means them; the playtest
 * that found the bench-behind-the-beggar bug had the crosshair a hand above a short NPC's head.
 */
export const PERSON_PICK_RADIUS = 0.4;
export const PERSON_PICK_HEIGHT = 1.9;
/** Non-box furniture blocks the view of a person only up to about seat height. */
const LOW_FURNITURE = 0.6;

/**
 * Entry distance (metres along the normalised ray) into an upright cylinder standing on a
 * floor at height `base`, or null. Coordinates as raycast.ts: x east, y south, h up.
 */
export function rayCylinder(
  o: { x: number; y: number; h: number },
  d: { x: number; y: number; h: number },
  cx: number, cy: number, base: number,
  radius = PERSON_PICK_RADIUS, height = PERSON_PICK_HEIGHT,
): number | null {
  const len = Math.hypot(d.x, d.y, d.h);
  if (!(len > 0)) return null;
  const dx = d.x / len, dy = d.y / len, dh = d.h / len;
  // Horizontal circle: |o + d t - c|² = r² (in plan).
  const ox = o.x - cx, oy = o.y - cy;
  const a = dx * dx + dy * dy, b = 2 * (ox * dx + oy * dy), c = ox * ox + oy * oy - radius * radius;
  let t0: number, t1: number;
  if (a < 1e-12) {
    // Looking straight up/down: inside the circle or never.
    if (c > 0) return null;
    t0 = -Infinity;
    t1 = Infinity;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    t0 = (-b - s) / (2 * a);
    t1 = (-b + s) / (2 * a);
  }
  // Vertical slab [base, base + height].
  let h0: number, h1: number;
  if (Math.abs(dh) < 1e-12) {
    if (o.h < base || o.h > base + height) return null;
    h0 = -Infinity;
    h1 = Infinity;
  } else {
    h0 = (base - o.h) / dh;
    h1 = (base + height - o.h) / dh;
    if (h0 > h1) [h0, h1] = [h1, h0];
  }
  const lo = Math.max(t0, h0, 0), hi = Math.min(t1, h1);
  return lo <= hi ? lo : null;
}

/** Someone drawn standing on their own spot (an NPC). */
export interface Person {
  x: number;
  y: number;
  z: number;
  dead?: boolean;
}

/**
 * Everyone who should be picked by their drawn body rather than by their tile's column
 * (src/npcs.ts registers the NPCs). Used by `e` and by the free cursor's hover / click
 * (src/ui2/install.ts), so both find the same person.
 */
export const pickablePeople: ((game: Game) => Iterable<Person>)[] = [];
export function* allPickablePeople(game: Game): Generator<Person> {
  for (const f of pickablePeople) yield* f(game);
}

export interface ViewRay {
  o: { x: number; y: number; h: number };
  d: { x: number; y: number; h: number };
}

/** The player's own view ray (eye, yaw, pitch): what the crosshair means without a camera (tests). */
export function playerViewRay(game: Game): ViewRay {
  const p = game.player;
  const [x, y, h] = viewDir(game);
  return { o: { x: p.x, y: p.y, h: p.z * LEVEL_HEIGHT + (p.crouching ? EYE_CROUCH : EYE) }, d: { x, y, h } };
}

/**
 * The first person (NPC) the ray meets within `reach` tiles of the player (plan distance to
 * their body), provided nothing drawn stands in front of them: a counter, a wall, a car door,
 * or the floor when you look down at the pile at your feet. A bench below the line of sight
 * doesn't hide whoever stands behind it. Returns the person and the distance along the ray.
 */
export function personOnRay<T extends Person>(
  game: Game, people: Iterable<T>, ray: ViewRay, reach: number,
  opts: { skipOrigin?: boolean; vehicleAt?: (x: number, y: number, z: number) => number; creatureAt?: (x: number, y: number, z: number) => unknown } = {},
): { body: T; t: number } | null {
  const p = game.player;
  let best: T | null = null, bt = Infinity;
  for (const n of people) {
    if (n.dead || Math.hypot(n.x - p.x, n.y - p.y) - CREATURE_RADIUS > reach) continue;
    const t = rayCylinder(ray.o, ray.d, n.x, n.y, n.z * LEVEL_HEIGHT);
    if (t !== null && t < bt) (bt = t), (best = n);
  }
  if (!best) return null;
  const solid = raycastTiles(game.map, ray.o, ray.d, {
    maxDist: bt, skipOrigin: opts.skipOrigin ?? true, vehicleAt: opts.vehicleAt, creatureAt: opts.creatureAt,
    // Only box furniture (counters, tables, cupboards) is a solid block as drawn. The rest (a
    // bench, chair, bed, crate) is a 1.2 m stand-in box in raycast.ts, which hid a beggar
    // standing behind a knee-high bench; counted up to seat height only.
    furnitureHeight: (f) => (isBoxFurniture(f) ? furnitureSolidHeight(f) : Math.min(furnitureSolidHeight(f), LOW_FURNITURE)),
  });
  if (solid && solid.dist < bt) return null;
  return { body: best, t: bt };
}
