import type { Game } from './game';
import { hasFlag } from '../world/registry';
import { isOutside } from './vision';
import { isDeepWater } from './water';
import { vehicleYouAreIn } from './vehicleRest';
import { has, type Vehicle } from './vehicle';
import type { CharacterWorld } from './relicEnchant';

// Character.world for the player and NPCs: where they are, for item enchantment conditions and
// climate control (src/game/relicEnchant.ts).

interface Placed {
  x: number;
  y: number;
  z: number;
  readonly tileX: number;
  readonly tileY: number;
}

/**
 * vehicle::refresh_insides for one mount: roofed, and each of the four neighbouring mounts has
 * a roof or a closed obstacle (board, windshield, shut door). BN also skips an obstacle that is
 * itself "inside", an order-dependent detail of its loop that is left out here.
 */
export function vehicleMountInside(v: Vehicle, mx: number, my: number): boolean {
  const ok = (p: { hp: number }) => p.hp > 0;
  if (!v.partsAt(mx, my).some((p) => ok(p) && has(p, 'ROOF'))) return false;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const near = v.partsAt(mx + dx, my + dy);
    const cover = near.some((p) => ok(p) && (has(p, 'ROOF') || (has(p, 'OBSTACLE') && !(has(p, 'OPENABLE') && p.open))));
    if (!cover) return false;
  }
  return true;
}

export function characterWorld(game: Game, who: Placed): CharacterWorld {
  return {
    seconds: () => game.clock.seconds,
    outside: () => isOutside(game.map, who.tileX, who.tileY, who.z),
    z: () => who.z,
    divable: () => isDeepWater(game, who.tileX, who.tileY, who.z),
    onFungus: () => {
      const f = game.map.furnAt(who.tileX, who.tileY, who.z);
      return hasFlag(game.map.terAt(who.tileX, who.tileY, who.z), 'FUNGUS') || (f.id !== 'f_null' && hasFlag(f, 'FUNGUS'));
    },
    vehicleClimateControl: () => {
      const here = who === (game.player as Placed) ? vehicleYouAreIn(game) : game.vehicles?.occupantAt(who.x, who.y, who.z) ?? null;
      return !!here && vehicleMountInside(here.v, here.mx, here.my) && here.v.totalPower() > 0;
    },
  };
}
