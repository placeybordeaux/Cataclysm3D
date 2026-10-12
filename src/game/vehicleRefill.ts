import type { Game } from './game';
import type { Item } from './item';
import { consumeItem, L } from './moves';
import { fillTanks, playerReaches, tankRoom } from './refuel';
import type { HosePoint } from './activity';
import { liquidColor, nearestTankPoint, sidePointNear } from './siphoning';
import type { Vehicle } from './vehicle';

// Pour a carried container of liquid (a jerrycan of gasoline) into a vehicle's tanks. BN
// veh_interact::do_refill ('f') picks a carried container whose contents the tank can take;
// ACT_VEHICLE 'f' then pours it all with item::fill_with, as much as fits, and says
// "There's some left over!" when it doesn't. It needs no hose and costs 1000 moves (10 s;
// handle_liquid.cpp's LD_VEH notes it matches do_refill). The port fills the vehicle's tanks
// of that liquid (or empty ones its engines burn it from) together, as the gas pump does,
// instead of asking for one tank part.

/** BN do_refill time: 1000 moves at 100 moves per second. */
export const REFILL_SECONDS = 10;

export interface RefillSource {
  container: Item;
  liquid: Item;
  /** Vehicle tank ml per item charge (1 for fuels, 250 for water). */
  mlPerCharge: number;
  /** Charges that fit, never more than the container holds. */
  charges: number;
}

/** Why you can't refill `v` right now, or null. */
export function refillReason(game: Game, v: Vehicle): string | null {
  if (Math.abs(v.velocity) > 0.05) return "You can't refill a moving vehicle.";
  if (!playerReaches(game, v)) return `Stand next to the ${v.name} to pour into it.`;
  return null;
}

/** Carried containers holding a liquid `v`'s tanks can take, with how much fits. */
export function refillSources(game: Game, v: Vehicle): RefillSource[] {
  const out: RefillSource[] = [];
  for (const container of game.player.inv.allItems()) {
    const liquid = container.contents[0];
    if (!liquid || container.contents.length !== 1 || !liquid.isLiquid() || liquid.charges <= 0) continue;
    const perL = v.vdata.fuels[liquid.typeId]?.chargesPerL;
    if (!perL || perL <= 0) continue;
    const mlPerCharge = 1000 / perL;
    const charges = Math.min(liquid.charges, Math.floor(tankRoom(v, liquid.typeId) / mlPerCharge + 1e-9));
    if (charges > 0) out.push({ container, liquid, mlPerCharge, charges });
  }
  return out;
}

/** Pour now. Returns the charges poured (0 when the source no longer fits or is gone). */
export function refillFrom(game: Game, v: Vehicle, container: Item): number {
  if (refillReason(game, v)) return 0;
  const src = refillSources(game, v).find(s => s.container === container);
  if (!src) return 0;
  const ml = src.charges * src.mlPerCharge;
  const added = fillTanks(v, src.liquid.typeId, ml);
  // tankRoom said it fits; a shortfall would mean liquid vanishing from the container.
  if (Math.abs(added - ml) > 1e-6) throw new Error(`refill: ${v.name} took ${added} of ${ml} ml of ${src.liquid.typeId}`);
  consumeItem(src.liquid, L.in(container), src.charges);
  return src.charges;
}

/** Timed refill: the whole pour happens at the end, as BN's activity does. */
export function startRefill(game: Game, v: Vehicle, container: Item): boolean {
  const reason = refillReason(game, v);
  if (reason) { game.message(reason, 'c_yellow'); return false; }
  const src = refillSources(game, v).find(s => s.container === container);
  if (!src) { game.message(`The ${v.name} can't take what's in the ${container.baseName()}.`, 'c_yellow'); return false; }
  const name = src.liquid.baseName();
  return game.activities.start({
    name: `pouring ${name} into the ${v.name}`,
    duration: REFILL_SECONDS,
    kind: 'refill', target: v,
    at: { x: Math.floor(v.x), y: Math.floor(v.y), z: v.z },
    hose: {
      style: 'pour', color: liquidColor(src.liquid.typeId),
      // From the can in your hands into the filler when it is within arm's reach, else into
      // the body side in front of you: reach allows the far side of a car (BN refills from any
      // adjacent square), and a stream across the roof would read as nonsense.
      from: () => {
        const p = game.player, t = pourTarget(game, v, src.liquid.typeId);
        if (!t) return null;
        // The spout at arm's length, short of the paint; waist height keeps the can out of
        // the first-person view's middle.
        const d = Math.hypot(t.x - p.x, t.y - p.y) || 1, k = Math.max(0.2, Math.min(0.55, d - 0.15)) / d;
        return { x: p.x + (t.x - p.x) * k, y: p.y + (t.y - p.y) * k, z: p.z, h: 1.0 };
      },
      to: () => pourTarget(game, v, src.liquid.typeId),
    },
    onComplete: () => {
      const n = refillFrom(game, v, container);
      if (!n) { game.message(`You couldn't pour anything into the ${v.name}.`, 'c_yellow'); return; }
      const left = container.contents[0]?.charges ?? 0;
      game.message(`You pour ${(n * src.mlPerCharge / 1000).toFixed(2)} L of ${name} into the ${v.name}.${left > 0 ? " There's some left over!" : ''}`, 'c_light_green');
    },
    onCancel: () => game.message(`You stop pouring; nothing went into the ${v.name}.`),
  });
}

/** Arm's reach from your centre to a filler cap, metres. */
const ARM_REACH = 1.2;

/** Where a pour from your hands lands: the filler if you can reach it, else the side before you. */
function pourTarget(game: Game, v: Vehicle, fuel: string): HosePoint | null {
  const p = game.player, t = nearestTankPoint(game, v, fuel);
  if (t && Math.hypot(t.x - p.x, t.y - p.y) <= ARM_REACH) return t;
  return sidePointNear(game, v, p.x, p.y);
}
