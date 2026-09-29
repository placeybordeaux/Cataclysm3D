// Running zombies over (QA_V2 #19/#29): BN's impulse collision model, torso armor, and the kill
// credited to the driver (stats, achievements and progression all read creatureDied).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import { MonsterSystem } from '../src/game/monai';
import { has, MPH_PER_MS, resolveBodyCollision } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { monsterCreatureHooks, VehicleSystem } from '../src/game/vehicles';
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

function world() {
  const game = new Game(data, 3, stubInput());
  game.map.generator = new FlatGen();
  for (let y = -1; y <= 2; y++) for (let x = -1; x <= 3; x++) game.map.chunk(x, y, 0);
  const ms = new MonsterSystem(game);
  const vs = new VehicleSystem(game, vdata);
  game.vehicles = vs; // as installVehicles does
  vs.creatureHooks = monsterCreatureHooks(ms);
  game.systems.push(ms, vs);
  game.clock.seconds = 12 * 3600;
  const car = vs.spawn('car', 10, 10, 0, 0, { fuel: 100, status: 2, rng: new Rng(7) })!;
  for (const p of car.parts) if (has(p, 'OPENABLE')) p.open = false;
  car.locked = false;
  const deaths: { killer: unknown }[] = [];
  game.events.on('creatureDied', (e) => deaths.push({ killer: e.killer }));
  return { game, ms, vs, car, deaths };
}

describe('running creatures over', () => {
  it("BN's impulse model: a car at 20 mph deals an ordinary zombie more than its 80 HP; at 5 mph it doesn't", () => {
    const hit = (mph: number) => {
      let dealt = 0;
      resolveBodyCollision({ mass: 1500, velocity: mph / MPH_PER_MS, mass2: 81.5, hpMax: 80, hit: (d) => ((dealt += d), true) });
      return dealt;
    };
    expect(hit(20)).toBeGreaterThan(80);
    expect(hit(5)).toBeLessThan(40);
    // damage grows with speed
    expect(hit(30)).toBeGreaterThan(hit(20));
  });

  it('driving through six zombies at 20 mph kills them all, each credited to the driver', () => {
    const { game, ms, vs, car, deaths } = world();
    game.player.x = 10.5;
    game.player.y = 10.5;
    vs.takeControls(car);
    const zeds = [0, 1, 2, 3, 4, 5].map((i) => ms.spawnById('mon_zombie', 18.5 + i * 4, 10.5 + (i % 2), 0)!);
    // Keep them standing where they are (the test is about the impact, not the chase).
    for (const z of zeds) z.addEffect('stunned', 60);
    car.velocity = 20 / MPH_PER_MS;
    vs.scriptedInput = true;
    for (let i = 0; i < 150 && zeds.some((z) => !z.dead); i++) {
      car.velocity = Math.max(car.velocity, 20 / MPH_PER_MS);
      game.tick(1 / 30);
    }
    expect(zeds.filter((z) => z.dead).length).toBe(6);
    expect(deaths.filter((d) => d.killer === game.player).length).toBe(6);
  });

  it("a driverless car's run-over kills nobody's kill (no credit)", () => {
    const { game, ms, car, deaths } = world();
    game.player.x = 5.5;
    game.player.y = 30.5;
    const z = ms.spawnById('mon_zombie', 18.5, 10.5, 0)!;
    z.addEffect('stunned', 60);
    car.velocity = 25 / MPH_PER_MS;
    for (let i = 0; i < 60 && !z.dead; i++) game.tick(1 / 30);
    expect(z.dead).toBe(true);
    expect(deaths.some((d) => d.killer === game.player)).toBe(false);
  });
});
