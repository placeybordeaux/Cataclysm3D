import type { Game } from './game';
import type { Item } from './item';
import { createItem } from './item';
import { has, type Vehicle, type VehiclePart } from './vehicle';
import { liquidSample, siphonTargets, tankMlPerCharge, transferTankInto } from './siphoning';
import { CRAFT_RANGE, type CraftingInventory, type CraftToolResource } from './crafting_inv';
import { PUMP_L_PER_S } from './refuel';
import type { PlayerAvatar } from './player';
import type { Character } from './character';
import type { VehicleSystem } from './vehicles';
import { recordResourceUndo } from './moves';

interface FacilityHost { player: PlayerAvatar; vehicles?: VehicleSystem | null }

/** V3: installed facilities are reachable from the driver's seat even while moving.
 * Parked facilities use the ordinary nearby crafting range until walkable rigs exist. */
export function vehicleFacilityReason(game: FacilityHost, v: Vehicle, part: VehiclePart, flag: string): string | null {
  if (!game.vehicles?.list.includes(v)) return 'This vehicle is no longer here.';
  if (!v.parts.includes(part) || !has(part, flag) || part.hp <= 0) return 'This facility is broken or missing.';
  if (v.locked) return 'The vehicle is locked.';
  if (game.player.z !== v.z) return 'Move closer to this facility.';
  if (game.vehicles.driving === v) return null;
  if (Math.abs(v.velocity) > 0.05) return 'Take a seat before using a moving vehicle’s facilities.';
  const [x, y] = v.mountToWorld(part.mx, part.my);
  return Math.hypot(game.player.x - x, game.player.y - y) <= CRAFT_RANGE ? null : 'Move closer to this facility.';
}

/** BN inventory::form_from_map exposes each integrated tool once per vehicle;
 * map::use_charges drains one battery kJ per requested tool charge. */
export function addVehicleCraftingSources(game: FacilityHost, inv: CraftingInventory): CraftingInventory {
  for (const v of game.vehicles?.list ?? []) {
    const providers = new Map<string, VehiclePart[]>();
    const resource: CraftToolResource = {
      available: () => Math.floor(v.fuelLeft('battery')),
      consume: charges => {
        const amount = Math.min(charges, Math.floor(v.fuelLeft('battery')));
        const before = v.parts.filter(p => p.hp > 0 && p.fuelType === 'battery').map(p => [p, p.charges] as const);
        const version = v.version;
        recordResourceUndo(() => { for (const [p, charge] of before) p.charges = charge; v.version = version; });
        const drained = v.drainFuel('battery', amount);
        if (drained) v.version++;
        return drained;
      },
    };
    for (const part of v.parts) {
      if (vehicleFacilityReason(game, v, part, 'CRAFTER')) continue;
      for (const id of part.def.integratedTools ?? []) {
        if (!inv.data.items[id]) continue;
        const parts = providers.get(id) ?? []; parts.push(part); providers.set(id, parts);
      }
    }
    for (const [id, parts] of providers) inv.add({ item: createItem(inv.data, id), kind: 'vehicle', loc: null, parent: null, resource,
      valid: () => parts.some(p => !vehicleFacilityReason(game, v, p, 'CRAFTER')) });
  }
  return inv;
}

export function faucetTanks(v: Vehicle): VehiclePart[] {
  return v.parts.filter(p => p.hp > 0 && has(p, 'FLUIDTANK') && p.fuelType === 'water_clean' && p.charges >= tankMlPerCharge(v, p) && tankMlPerCharge(v, p) > 0);
}

export function faucetReason(game: Game, v: Vehicle, faucet: VehiclePart, tank: VehiclePart): string | null {
  return vehicleFacilityReason(game, v, faucet, 'FAUCET') ??
    (faucetTanks(v).includes(tank) ? null : 'There is no transferable clean water in this tank.');
}

export function fillFromFaucet(game: Game, v: Vehicle, faucet: VehiclePart, tank: VehiclePart, container: Item, ml: number): number {
  if (faucetReason(game, v, faucet, tank)) return 0;
  return transferTankInto(game, v, tank, container, ml);
}

/** BN vehicle_use::DRINK consumes one water_clean item charge, draining the
 * source only if normal consumption (fullness, mutations, etc.) succeeds. */
export function drinkFromFaucet(game: Game, v: Vehicle, faucet: VehiclePart, tank: VehiclePart): boolean {
  if (faucetReason(game, v, faucet, tank)) return false;
  const sample = liquidSample(game, v, tank)!;
  sample.charges = 1;
  if (!game.player.inv.consume(sample, null).ok) return false;
  tank.charges -= tankMlPerCharge(v, tank);
  v.version++;
  return true;
}

/** BN consumption.cpp::eat meal time plus vehicle_use::DRINK's extra 250 moves.
 * Integer rounding follows C++ int division and compound multiplication. */
export function faucetDrinkSeconds(character: Character): number {
  let moves = 250;
  if (['MOUTH_TENTACLES', 'MANDIBLES', 'FANGS_SPIDER'].some(t => character.hasTrait(t))) moves = Math.trunc(moves / 2);
  else if (character.hasTrait('SHARKTEETH')) moves = Math.trunc(moves / 3);
  else if (character.hasTrait('GOURMAND')) moves -= 100;
  // BEAK_HUM's extra time applies only to food that is not drinkable.
  if (character.hasTrait('SABER_TEETH')) moves += 250;
  if (character.hasTrait('AMORPHOUS')) moves = Math.trunc(moves * 1.1);
  return (moves + 250) / 100;
}

export function startFaucetDrink(game: Game, v: Vehicle, faucet: VehiclePart, tank: VehiclePart): boolean {
  const reason = faucetReason(game, v, faucet, tank);
  if (reason) { game.message(reason, 'c_yellow'); return false; }
  let aborted = false;
  return game.activities.start({
    name: 'drinking from the vehicle faucet', kind: 'vehicle_faucet_drink', target: faucet,
    duration: faucetDrinkSeconds(game.player),
    onProgress: () => {
      const reason = faucetReason(game, v, faucet, tank);
      if (reason) { aborted = true; game.activities.cancel(reason); }
    },
    onComplete: () => { if (!aborted) drinkFromFaucet(game, v, faucet, tank); },
  });
}

/** BN faucet exposes clean water from connected tanks; fill activity uses the same
 * source-backed liquid rate as siphoning, without requiring an external hose. */
export function startFaucetFill(game: Game, v: Vehicle, faucet: VehiclePart, tank: VehiclePart, container: Item): boolean {
  const reason = faucetReason(game, v, faucet, tank);
  const target = siphonTargets(game, v, tank).find(t => t.item === container);
  if (reason || !target) { game.message(reason ?? 'That container has no room or is out of reach.', 'c_yellow'); return false; }
  const perCharge = tankMlPerCharge(v, tank);
  const wanted = Math.min(Math.floor(tank.charges / perCharge) * perCharge, target.room * perCharge);
  let credit = 0, transferred = 0, aborted = false;
  return game.activities.start({
    name: `filling ${container.baseName()} from the faucet`, kind: 'vehicle_faucet', target: faucet,
    duration: wanted / (PUMP_L_PER_S * 1000),
    onProgress: dt => {
      const reason = faucetReason(game, v, faucet, tank);
      if (reason || !siphonTargets(game, v, tank).some(t => t.item === container)) {
        aborted = true; game.activities.cancel(reason ?? 'The container is full or out of reach.'); return;
      }
      credit += dt * PUMP_L_PER_S * 1000;
      const moved = fillFromFaucet(game, v, faucet, tank, container, Math.min(credit, wanted - transferred));
      credit -= moved; transferred += moved;
    },
    onComplete: () => { if (!aborted) game.message(`You fill the ${container.baseName()} with ${(transferred / 1000).toFixed(2)} L of ${liquidSample(game, v, tank)?.baseName() ?? 'clean water'}.`); },
    onCancel: () => game.message(`Filling stops; ${(transferred / 1000).toFixed(2)} L already transferred is kept.`),
  });
}
