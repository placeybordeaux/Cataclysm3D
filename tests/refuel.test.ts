// "Fill up" at a gas pump (src/game/refuel.ts): the pump's fuel item (BN mapgen place_gaspumps)
// goes into the vehicle's tanks at BN's fill_liquid rate (2/3 L per game second), charges are ml.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import { interactionsAt } from '../src/game/interact';
import { createItem } from '../src/game/item';
import { itemsAt, L, spawnOnGround } from '../src/game/moves';
import { installRefuel, PUMP_L_PER_S, pumpFuel, tankRoom } from '../src/game/refuel';
import { has } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { VehicleSystem } from '../src/game/vehicles';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { loadNodeData } from '../tools/lib/node_data';

let data: GameData;
let vdata: VehicleDataFile;
beforeAll(() => {
  data = loadNodeData().game;
  vdata = JSON.parse(readFileSync(resolve('public/data/vehicles.json'), 'utf8'));
});

class FlatGen implements ChunkGenerator {
  generate(map: GameMap, chunk: Chunk): void {
    chunk.ter.fill(map.terrain.index(chunk.z === 0 ? 't_pavement' : chunk.z > 0 ? 't_open_air' : 't_rock'));
    chunk.empty = false;
  }
}
const stubInput = () => ({ held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] }) as any;

function world(fuelL = 30) {
  const game = new Game(data, 3, stubInput());
  game.map.generator = new FlatGen();
  for (let y = -1; y <= 2; y++) for (let x = -1; x <= 2; x++) game.map.chunk(x, y, 0);
  const vs = new VehicleSystem(game, vdata);
  game.vehicles = vs;
  game.systems.push(vs);
  installRefuel(game, vs);
  // a pump at (10, 7) with fuelL litres of gasoline; a car parked alongside (its left side at y 9)
  game.map.setTer(10, 7, 0, 't_gas_pump');
  spawnOnGround(game.map, 10, 7, 0, createItem(data, 'gasoline', { charges: fuelL * 1000 }));
  const car = vs.spawn('car', 10, 10, 0, 0, { fuel: 0, status: 0, rng: new Rng(7) })!;
  game.player.x = 9.5;
  game.player.y = 8.5;
  return { game, vs, car };
}

describe('filling up at a gas pump', () => {
  it('offers to fill a car parked by the pump, with the litres it will take', () => {
    const { game, car } = world();
    const acts = interactionsAt(game, 10, 7, 0);
    const fill = acts.find((a) => a.id === `fill_${car.uid}`);
    expect(fill?.label).toMatch(/Fill up the Car with gasoline \(\d+ L\)/);
  });

  it('pumps at BN\'s 2/3 L/s into the tank, and the pump runs dry', () => {
    const { game, car } = world(20);
    const room = tankRoom(car, 'gasoline');
    expect(room).toBeGreaterThan(20000);
    interactionsAt(game, 10, 7, 0).find((a) => a.id === `fill_${car.uid}`)!.run();
    expect(game.activities.current).not.toBeNull();
    const dur = game.activities.current!.spec.duration;
    expect(dur).toBeCloseTo(20 / PUMP_L_PER_S, 0);
    for (let i = 0; i < 30 * 60 && game.activities.current; i++) game.tick(1 / 30);
    expect(game.activities.current).toBeNull();
    expect(car.fuelLeft('gasoline')).toBe(20000);
    expect(pumpFuel(game, 10, 7, 0)).toBeNull();
    expect(itemsAt(L.ground(game.map, 10, 7, 0)).filter((it) => it.typeId === 'gasoline' && it.charges > 0)).toHaveLength(0);
    // the tank really is a gasoline tank the engine can use
    expect(car.parts.filter((p) => has(p, 'FLUIDTANK') && p.fuelType === 'gasoline').length).toBeGreaterThan(0);
  });

  it('a dry pump says so; no vehicle nearby says where to park', () => {
    const { game, vs, car } = world(0.001);
    vs.remove(car);
    const said: string[] = [];
    game.message = (t: string) => void said.push(t);
    interactionsAt(game, 10, 7, 0).find((a) => a.id === 'examine')!.run();
    expect(said.join(' ')).toMatch(/Park a vehicle/);
  });
});
