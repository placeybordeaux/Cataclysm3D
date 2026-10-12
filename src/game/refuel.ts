import type { Game } from './game';
import { examineHandlers, type Interaction } from './interact';
import { consumeItem, itemsAt, L } from './moves';
import { has, type Vehicle } from './vehicle';
import { distinctVehicleNames } from './vehicleNames';
import type { VehicleSystem } from './vehicles';

// "Fill up" at a gas pump: pump the fuel mapgen left in it (BN places the fuel as a liquid
// item on the pump tile: mapgen place_gaspumps, 10-50 L when no amount is given) into a
// vehicle's tanks. BN's iexamine::gaspump hands that liquid to liquid_handler, whose
// ACT_FILL_LIQUID moves 2/3 L per second of game time (activity_handlers.cpp
// `volume_per_second = 4/6 L`); we keep that rate, run it as a timed activity, and skip the
// dexterity spill roll (a new player losing the fuel they came for to a hidden roll teaches
// nothing). Fuel charges are ml (vehicles.json `fuels.<id>.chargesPerL` = 1000).

/** BN fill_liquid rate: litres per game second. */
export const PUMP_L_PER_S = 4 / 6;
/** How close (tiles, centre to nearest mount) a vehicle must be to reach it with the hose. */
export const HOSE_REACH = 2.5;
/**
 * The same reach measured to a shaped body's paint (the chassis template, vehicles v3): a
 * body's side is ~0.4 m in from its outer tiles' centres, so this matches HOSE_REACH.
 */
export const HOSE_REACH_BODY = 2.1;

/** The fuel item on a pump tile (gasoline, diesel...), if any is left. */
export function pumpFuel(game: Game, x: number, y: number, z: number) {
  return itemsAt(L.ground(game.map, x, y, z)).find((it) => it.countByCharges && it.charges > 0 && !!game.vehicles?.vdata.fuels[it.typeId]) ?? null;
}

/** Tanks on `v` that can take `fuel`: tanks already of it, or empty tanks its engines could burn it from. */
function tanksFor(v: Vehicle, fuel: string) {
  const burns = v.engineFuels().includes(fuel);
  return v.parts.filter((p) => has(p, 'FLUIDTANK') && p.hp > 0 && (p.fuelType === fuel || (burns && (!p.fuelType || p.charges <= 0))));
}

/** Room for `fuel` in `v`'s tanks (charges). */
export function tankRoom(v: Vehicle, fuel: string): number {
  return tanksFor(v, fuel).reduce((a, p) => a + Math.max(0, (p.def.capacity ?? 0) - (p.fuelType === fuel ? p.charges : 0)), 0);
}

/**
 * Hose distance from a tile centre to `v`: to the body as drawn (its chassis template) when
 * it has one, else to its tiles. Compare with HOSE_REACH.
 */
export function hoseDistance(vs: VehicleSystem | null | undefined, v: Vehicle, cx: number, cy: number): number {
  const b = vs?.bodyRect(v);
  if (!b) return Math.min(...v.occupiedTiles().map((t) => Math.hypot(t.tx + 0.5 - cx, t.ty + 0.5 - cy)));
  const [lx, ly] = v.worldToMount(cx, cy);
  const dx = Math.max(b.x0 - lx, 0, lx - b.x1), dy = Math.max(b.y0 - ly, 0, ly - b.y1);
  return Math.hypot(dx, dy) + (HOSE_REACH - HOSE_REACH_BODY);
}

/** Is the player standing where a hose (or a can's spout) reaches `v`? */
export function playerReaches(game: Game, v: Vehicle): boolean {
  const p = game.player;
  return p.z === v.z && hoseDistance(game.vehicles, v, p.tileX + 0.5, p.tileY + 0.5) <= HOSE_REACH;
}

/** Vehicles whose body is within hose reach of the pump, nearest first. */
export function vehiclesByPump(vs: VehicleSystem, x: number, y: number, z: number): Vehicle[] {
  const cx = x + 0.5, cy = y + 0.5;
  const dist = (v: Vehicle) => hoseDistance(vs, v, cx, cy);
  return vs.list.filter((v) => v.z === z && Math.hypot(v.x - cx, v.y - cy) < 16 && dist(v) <= HOSE_REACH).sort((a, b) => dist(a) - dist(b));
}

/** Put up to `charges` of `fuel` into `v` (tanks of that fuel first, then empty ones). Returns charges added. */
export function fillTanks(v: Vehicle, fuel: string, charges: number): number {
  const want = Math.floor(Math.min(charges, tankRoom(v, fuel)));
  if (want <= 0) return 0;
  // claim empty tanks for this fuel (an empty tank has no fuel of its own to mix with)
  for (const p of tanksFor(v, fuel)) if (p.fuelType !== fuel) {
    p.fuelType = fuel;
    p.charges = 0;
  }
  const n = v.addFuel(fuel, want);
  v.version++;
  return n;
}

/** Pour `charges` of the pump's fuel into `v`. Returns charges moved. */
export function pumpInto(game: Game, v: Vehicle, x: number, y: number, z: number, charges: number): number {
  const fuel = pumpFuel(game, x, y, z);
  if (!fuel) return 0;
  const n = fillTanks(v, fuel.typeId, Math.min(charges, fuel.charges));
  if (n > 0) consumeItem(fuel, L.ground(game.map, x, y, z), n);
  return n;
}

/** Install the "Fill up" action on gas pumps (replaces interact.ts's "out of order" placeholder). */
export function installRefuel(game: Game, vs: VehicleSystem): void {
  examineHandlers.set('gaspump', (g, x, y, z, def) => {
    const out: Interaction[] = [];
    const fuel = pumpFuel(g, x, y, z);
    if (!fuel) {
      out.push({ id: 'examine', label: `Examine the ${def.name}`, run: () => g.message(`The ${def.name} is empty. Out of order.`, 'c_light_gray') });
      return out;
    }
    const perL = vs.vdata.fuels[fuel.typeId]?.chargesPerL ?? 1000;
    const litres = (n: number) => `${(n / perL).toFixed(n / perL < 10 ? 1 : 0)} L`;
    const name = vs.vdata.fuels[fuel.typeId]?.name ?? fuel.typeId;
    const near = vehiclesByPump(vs, x, y, z);
    // two Cars at one pump: "the red Car to your left" (vehicleNames.ts)
    const names = distinctVehicleNames(g, near);
    for (const v of near) {
      const room = tankRoom(v, fuel.typeId);
      const the = names.get(v)!;
      if (!room) {
        const why = v.engineFuels().includes(fuel.typeId) ? 'is full' : `doesn't run on ${name}`;
        out.push({ id: `fill_${v.uid}`, label: `Fill up ${the} (it ${why})`, run: () => g.message(`The ${v.name} ${why}.`, 'c_light_gray') });
        continue;
      }
      const total = Math.min(room, fuel.charges);
      out.push({
        id: `fill_${v.uid}`,
        label: `Fill up ${the} with ${name} (${litres(total)})`,
        run: () => {
          let pumped = 0, acc = 0;
          g.activities.start({
            name: `filling up ${the}`,
            kind: 'refuel',
            at: { x, y, z },
            duration: Math.max(2, total / perL / PUMP_L_PER_S),
            onProgress: (dt) => {
              acc += dt * PUMP_L_PER_S * perL;
              const n = Math.floor(acc);
              if (n <= 0) return;
              acc -= n;
              pumped += pumpInto(g, v, x, y, z, n);
            },
            onComplete: () => {
              pumped += pumpInto(g, v, x, y, z, total - pumped);
              const left = pumpFuel(g, x, y, z);
              g.message(`You fill up the ${v.name} with ${litres(pumped)} of ${name}.${left ? '' : ` The ${def.name} is dry now.`}`, 'c_light_green');
            },
            onCancel: () => g.message(`You stop pumping: ${litres(pumped)} of ${name} in the ${v.name}.`),
          });
        },
      });
    }
    if (!near.length)
      out.push({ id: 'examine', label: `Examine the ${def.name}`, run: () => g.message(`The ${def.name} still has ${name} in it (${litres(fuel.charges)}). Park a vehicle next to it to fill up.`) });
    return out;
  });
  void game;
}
