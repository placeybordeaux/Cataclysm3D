import { has, type Vehicle, type VehiclePart } from './vehicle';

/** BN game_constants.h and item.cpp::clip_by_temperature_flag. */
export const FRIDGE_C = 2;
export const FREEZER_C = -5;

/** Stored tank liquids have no item condition yet; this covers real cargo only. */
export function isColdCargo(part: VehiclePart): boolean {
  return has(part, 'CARGO') && (has(part, 'FRIDGE') || has(part, 'FREEZER'));
}

export function rotCargo(parts: VehiclePart[], seconds: number, temperature: number): void {
  if (seconds <= 0) return;
  for (const part of parts) for (const item of part.items) item.processRot(seconds, temperature);
}

/** Each enabled intact cold compartment draws its actual epower. A battery that
 * runs out partway through the interval buys only that fraction of cooling time.
 * Temperature responds immediately: item thermal inertia is not modelled. */
export function processColdCargo(vehicle: Vehicle, parts: VehiclePart[], seconds: number, ambientC: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  let spent = 0;
  for (const part of parts) {
    const kw = isColdCargo(part) && part.enabled && part.hp > 0 ? Math.max(0, -(part.def.epower ?? 0)) / 1000 : 0;
    const energy = kw ? vehicle.drainFuel('battery', kw * seconds) : 0;
    const cooledSeconds = kw ? Math.min(seconds, energy / kw) : 0;
    const coldC = Math.min(ambientC, has(part, 'FREEZER') ? FREEZER_C : FRIDGE_C);
    rotCargo([part], cooledSeconds, coldC);
    rotCargo([part], seconds - cooledSeconds, ambientC);
    spent += energy;
  }
  return spent;
}
