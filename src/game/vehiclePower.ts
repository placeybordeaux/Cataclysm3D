import type { Game } from './game';
import { bodyLocs, consumeItem, walkLocs } from './moves';
import { has, type Vehicle, type VehiclePart } from './vehicle';
import { isOutside, sunAltitudeAt, sunLight } from './vision';
import { CHUNK, MAX_Z } from '../world/coords';
import { rechargeVehicleCargo } from './recharging';
import { isColdCargo, processColdCargo, rotCargo } from './vehicleStorage';

/** BN vehicle::update_time: exposed panels generate epower scaled by sunlight.
 * Battery charges are kJ. Moonlight and artificial lamps cannot run solar panels.
 * Integrate a long activity in at most five-minute pieces to include day/night changes.
 */
export function generateSolarPower(game: Game, vehicle: Vehicle, seconds: number, endTime = game.clock.seconds, panelWatts?: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const watts = panelWatts ?? solarWatts(game, vehicle);
  const steps = Math.max(1, Math.ceil(seconds / 300));
  const dt = seconds / steps;
  let generated = 0;
  for (let i = 0; i < steps; i++) {
    const sample = endTime - seconds + (i + 0.5) * dt;
    // BN's default_daylight_level is 100; weather light_modifier attenuates sunlight.
    const altitude = sunAltitudeAt(sample);
    const sunlight = altitude > 0 ? Math.max(0, sunLight(altitude) + (game.weather?.lightModifier ?? 0)) / 100 : 0;
    generated += vehicle.addFuel('battery', watts * sunlight * dt / 1000);
  }
  return generated;
}

function solarWatts(game: Game, vehicle: Vehicle): number {
  const exposed = vehicle.parts.filter(p => p.hp > 0 && has(p, 'SOLAR_PANEL')).filter(p => {
    const [x, y] = vehicle.mountToWorld(p.mx, p.my);
    const tx = Math.floor(x), ty = Math.floor(y);
    if (!isOutside(game.map, tx, ty, vehicle.z)) return false;
    // Higher levels only where generated (as roofAbove in world/levels.ts): the chunk manager
    // generates every level a column has, and reading would otherwise run mapgen for open air
    // all the way up to z10, raising GameMap.topZ for every sky-cover loop in the game.
    if (game.map.hasFloor(tx, ty, vehicle.z + 1)) return false;
    const cx = Math.floor(tx / CHUNK), cy = Math.floor(ty / CHUNK);
    for (let z = vehicle.z + 2; z <= MAX_Z; z++) if (game.map.hasChunk(cx, cy, z) && game.map.hasFloor(tx, ty, z)) return false;
    return true;
  });
  return exposed.reduce((sum, p) => sum + Math.max(0, p.def.epower ?? 0) * p.hp / p.def.durability, 0);
}

/** BN reactor `power` is kJ produced per fuel charge, not mechanical watts.
 * Use fractional fuel consumption instead of probabilistic rounding; the existing
 * part charges save field preserves progress without creating or losing fuel.
 */
export function generateReactorPower(vehicle: Vehicle, seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  let generated = 0;
  for (const part of vehicle.parts) {
    if (!has(part, 'REACTOR') || !part.enabled || part.hp <= 0) continue;
    const efficiency = part.def.power ?? 0;
    if (efficiency <= 0 || part.charges <= 0) continue;
    const available = part.charges * efficiency;
    const output = Math.max(0, part.def.epower ?? 0) * part.hp / part.def.durability * seconds / 1000;
    const stored = vehicle.addFuel('battery', Math.min(available, output));
    part.charges = Math.max(0, part.charges - stored / efficiency);
    generated += stored;
    if (part.charges <= 0) part.enabled = false;
  }
  return generated;
}

/** Load carried matching ammunition through moves.ts, with no fabricated fuel. */
export function loadReactorFuel(game: Game, vehicle: Vehicle, reactor: VehiclePart): number {
  if (vehicle.locked || reactor.hp <= 0 || !vehicle.parts.includes(reactor) || !has(reactor, 'REACTOR')) return 0;
  let loaded = 0;
  for (const { item, loc } of [...walkLocs(bodyLocs(game.player))]) {
    if (item.typeId !== reactor.def.fuel_type || !item.countByCharges) continue;
    const amount = Math.min(item.charges, Math.floor((reactor.def.capacity ?? 0) - reactor.charges));
    if (amount <= 0) continue;
    if (consumeItem(item, loc, amount)) {
      reactor.charges += amount;
      loaded += amount;
      reactor.fuelType = reactor.def.fuel_type;
    }
  }
  if (loaded) vehicle.version++;
  return loaded;
}

/** Interleave generation and charging during waits; generating an entire wait first
 * discards solar output when the battery starts full, then drains it all afterwards. */
export function updateVehiclePower(game: Game, vehicle: Vehicle, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const watts = solarWatts(game, vehicle);
  const cargo = vehicle.parts.filter(p => has(p, 'CARGO'));
  const cold = cargo.filter(isColdCargo);
  const ambient = game.weather?.temperature ?? game.player.env.temperature;
  rotCargo(cargo.filter(p => !isColdCargo(p)), seconds, ambient);
  const activeCold = cold.some(p => p.hp > 0 && p.enabled && (p.def.epower ?? 0) < 0);
  if (!activeCold) rotCargo(cold, seconds, ambient);
  if (!watts && !activeCold && !vehicle.parts.some(p => p.hp > 0 && p.enabled && (has(p, 'REACTOR') || has(p, 'RECHARGE')))) return;
  for (let elapsed = 0; elapsed < seconds;) {
    const dt = Math.min(1, seconds - elapsed);
    if (activeCold) processColdCargo(vehicle, cold, dt, ambient);
    rechargeVehicleCargo(vehicle, dt);
    generateSolarPower(game, vehicle, dt, game.clock.seconds - seconds + elapsed + dt, watts);
    generateReactorPower(vehicle, dt);
    elapsed += dt;
  }
}
