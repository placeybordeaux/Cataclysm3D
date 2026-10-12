import type { Game } from './game';
import { chunkOf } from '../world/coords';

const GARAGES = new Set(['s_garage', 's_garage_1', 's_garage_2', 'garage_gas_1', 'garage_gas_2', 'garage_gas_3', 'bandit_garage_1', 'bandit_garage_2']);
/** v3's authored garage adaptation; roofs and unrelated buildings do not qualify. */
export function isVehicleGarage(game: Game, x: number, y: number, z: number): boolean {
  const id = game.map.chunk(chunkOf(x), chunkOf(y), z)?.omt?.id ?? '';
  return z === 0 && GARAGES.has(id.replace(/_(north|east|south|west)$/, ''));
}
