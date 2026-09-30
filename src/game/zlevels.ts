import type { Game } from './game';
import { MAX_Z, MIN_Z } from '../world/coords';
import { hasFlag, isDiggable } from '../world/registry';
import { MAIN_PARTS } from './bodyparts';
import { emitSound } from './sound';

// Vertical movement, after CDDA game::vertical_move / find_or_make_stairs and
// map::creature_falls / Character::impact:
//  - `<` / `>` while standing on (or right next to) GOES_UP / GOES_DOWN terrain moves you a
//    level; you arrive on the matching stairs (same x,y if they line up, else the nearest
//    matching stair tile within STAIR_SEARCH tiles, like CDDA's search of the destination)
//  - walking onto a tile with no floor (open air, a hole) drops you until you hit a floor,
//    taking CDDA's fall damage: force = 30 × levels, reduced by dex/dodge
//  - there is no jumping: going up needs stairs or a ladder

export type StairDir = 'up' | 'down';
export const STAIR_SEARCH = 24;

const flagFor = (dir: StairDir) => (dir === 'up' ? 'GOES_UP' : 'GOES_DOWN');
const matching = (dir: StairDir) => (dir === 'up' ? 'GOES_DOWN' : 'GOES_UP');

/** Stairs going `dir` on the player's tile or an adjacent one (player's tile preferred). */
export function stairsNear(game: Game, dir: StairDir): { x: number; y: number; z: number } | null {
  const p = game.player;
  const f = flagFor(dir);
  if (hasFlag(game.map.terAt(p.tileX, p.tileY, p.z), f)) return { x: p.tileX, y: p.tileY, z: p.z };
  let best: { x: number; y: number; z: number } | null = null, bd = Infinity;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = p.tileX + dx, y = p.tileY + dy;
      if (!hasFlag(game.map.terAt(x, y, p.z), f)) continue;
      const d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y);
      if (d < bd && d <= 1.6) (bd = d), (best = { x, y, z: p.z });
    }
  return best;
}

/** Where you arrive taking stairs at (x, y, z) in `dir`, or null if there is nowhere to go. */
export function stairDestination(game: Game, x: number, y: number, z: number, dir: StairDir): { x: number; y: number; z: number } | null {
  const tz = z + (dir === 'up' ? 1 : -1);
  if (tz < MIN_Z || tz > MAX_Z) return null;
  const map = game.map;
  const want = matching(dir);
  if (hasFlag(map.terAt(x, y, tz), want)) return { x, y, z: tz };
  let best: { x: number; y: number; z: number } | null = null, bd = Infinity;
  for (let r = 1; r <= STAIR_SEARCH && !best; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!hasFlag(map.terAt(x + dx, y + dy, tz), want)) continue;
        const d = dx * dx + dy * dy;
        if (d < bd) (bd = d), (best = { x: x + dx, y: y + dy, z: tz });
      }
  if (best) return best;
  // No matching stairs: CDDA lets you through if the spot above/below is walkable floor.
  if (map.passable(x, y, tz) && map.hasFloor(x, y, tz)) return { x, y, z: tz };
  return null;
}

/** `<` / `>`: take the stairs. Returns true if the player changed level. */
export function goStairs(game: Game, dir: StairDir): boolean {
  const p = game.player;
  if (p.dead || p.isAsleep()) return false;
  const s = stairsNear(game, dir);
  if (!s) {
    game.message(dir === 'up' ? "You can't go up here!" : "You can't go down here!");
    return false;
  }
  const dest = stairDestination(game, s.x, s.y, s.z, dir);
  if (!dest) {
    game.message(dir === 'up' ? "You can't climb up there." : "You can't go down there.");
    return false;
  }
  if (!game.map.passable(dest.x, dest.y, dest.z)) {
    game.message('The way is blocked.');
    return false;
  }
  const ladder = hasFlag(game.map.terAt(s.x, s.y, s.z), 'DIFFICULT_Z');
  p.x = dest.x + 0.5;
  p.y = dest.y + 0.5;
  p.z = dest.z;
  p.burnMoveStamina(ladder ? 200 : 100);
  game.message(ladder ? (dir === 'up' ? 'You climb up the ladder.' : 'You climb down the ladder.') : dir === 'up' ? 'You walk up the stairs.' : 'You walk down the stairs.');
  emitSound(game, dest, 6, 'footsteps', { category: 'movement', source: p, sfxId: '' });
  return true;
}

/** Character::fall_damage_mod: 100 % at 0, −4 % per point of dex/2 + dodge. */
export function fallDamageMod(game: Game): number {
  const p = game.player;
  const dd = Math.max(0, p.dex / 2 + p.getSkill('dodge'));
  return Math.max(0, (100 - dd * 4) / 100);
}

/**
 * Drop the player to the first floor below. Applies Character::impact(30 × levels).
 * Returns the number of levels fallen (0 = had a floor).
 */
export function fallIfUnsupported(game: Game): number {
  const p = game.player;
  const map = game.map;
  let z = p.z;
  while (z > MIN_Z && !map.hasFloor(p.tileX, p.tileY, z) && map.terAt(p.tileX, p.tileY, z).id !== 't_null') z--;
  const height = p.z - z;
  if (height <= 0) return 0;
  // Can't land inside a wall: stop on top of it (one level higher) if it's solid.
  if (!map.passable(p.tileX, p.tileY, z) && z < p.z) {
    z++;
    if (z === p.z) return 0;
  }
  p.z = z;
  const levels = height;
  game.message(levels > 1 ? `You fall down ${levels} levels!` : 'You fall down a level!', 'c_red');
  impact(game, levels * 30);
  emitSound(game, { x: p.tileX, y: p.tileY, z }, 10 + levels * 5, 'a thud', { category: 'combat', source: p });
  return levels;
}

/** Character::impact for landing on the tile the player is on. Returns total damage. */
export function impact(game: Game, force: number): number {
  const p = game.player;
  const map = game.map;
  const x = p.tileX, y = p.tileY, z = p.z;
  const ter = map.terAt(x, y, z), furn = map.furnAt(x, y, z);
  let eff = force + (isDiggable(ter) ? 0 : 3);
  if (furn.id !== 'f_null') eff = Math.max(0, eff - Number(furn.fall_damage_reduction ?? 0));
  let mod = fallDamageMod(game);
  if (eff > 30 && mod < 1) {
    const scaled = Math.pow(mod, 30 / eff);
    mod = (30 * mod + scaled * (eff - 30)) / eff;
  }
  const target = furn.id !== 'f_null' ? `the ${furn.name}` : `the ${ter.name}`;
  if (mod < 1 && mod * force < 5) {
    game.message(`You land on ${target}.`);
    return 0;
  }
  let total = 0;
  if (mod * eff >= 5) {
    for (const bp of MAIN_PARTS) {
      const bash = (eff * p.rng.int(60, 100)) / 100;
      total += p.takeHit(bp, [{ type: 'bash', amount: bash * mod }]).damage;
    }
  }
  if (total > 0) game.message(`You are slammed against ${target} for ${total} damage.`, 'c_red');
  else game.message(`You land on ${target}.`);
  if (p.rng.next() < mod) p.addEffect('downed', p.rng.int(1, 1 + Math.floor(mod * 3)));
  return total;
}

/** Installs the `<`/`>` keys and the falling check. */
export function installZLevels(game: Game): void {
  game.keys.register('stairs_up', 'Go up stairs', () => goStairs(game, 'up'));
  game.keys.register('stairs_down', 'Go down stairs', () => goStairs(game, 'down'));
  game.systems.push({
    name: 'falling',
    update(g) {
      if (g.player.dead) return;
      fallIfUnsupported(g);
    },
  });
}
