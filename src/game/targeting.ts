import type { Game } from './game';
import { hasFlag } from '../world/registry';

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
