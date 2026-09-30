// Collision against the drawn vehicle body (src/game/vehicleShape.ts) rather than whole grid
// tiles: the modelled look draws a car ~2.6 m wide on its 4-tile grid, and the old tile
// collision left an invisible wall ~0.7 m beside the paint.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import { MonsterSystem } from '../src/game/monai';
import { moveWithCollision } from '../src/game/physics';
import { has, MPH_PER_MS } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { monsterCreatureHooks, VehicleSystem } from '../src/game/vehicles';
import { bodyRectFor } from '../src/render/vehicleLayout';
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

function world(shaped: boolean, facing = 0) {
  const game = new Game(data, 3, stubInput());
  game.map.generator = new FlatGen();
  for (let y = -1; y <= 2; y++) for (let x = -1; x <= 3; x++) game.map.chunk(x, y, 0);
  const ms = new MonsterSystem(game);
  const vs = new VehicleSystem(game, vdata);
  game.vehicles = vs;
  vs.creatureHooks = monsterCreatureHooks(ms);
  game.systems.push(ms, vs);
  if (shaped) vs.bodyShape = bodyRectFor;
  const car = vs.spawn('car', 10, 10, 0, facing, { fuel: 100, status: 2, rng: new Rng(7) })!;
  for (const p of car.parts) if (has(p, 'OPENABLE')) p.open = false;
  car.locked = false;
  car.version++;
  game.player.x = 30.5;
  game.player.y = 30.5;
  return { game, ms, vs, car };
}

/** Walk a circle from (x, y) toward (+0, +1) steps until it stops; return where. */
function walk(map: GameMap, x: number, y: number, dx: number, dy: number): [number, number] {
  for (let i = 0; i < 200; i++) [x, y] = moveWithCollision(map, x, y, 0, dx * 0.05, dy * 0.05);
  return [x, y];
}

describe('collision with the drawn vehicle body', () => {
  it('walking up to the side stops at the paint, not at the tile edge', () => {
    for (const shaped of [false, true]) {
      const { game, car, vs } = world(shaped);
      // left side (mount y = -1 is world y 9.5; its tile starts at y = 9)
      const [, y] = walk(game.map, 11.5, 7.5, 0, 1);
      if (!shaped) expect(y).toBeCloseTo(9 - 0.3, 1);
      else {
        const b = vs.bodyRect(car)!;
        const edge = car.mountToWorld(0, b.y0)[1];
        expect(edge).toBeGreaterThan(9.5);
        expect(y).toBeGreaterThan(9 - 0.3 + 0.35); // well past the old invisible wall
        expect(y).toBeLessThan(edge - 0.29); // but not into the paint
        expect(y).toBeGreaterThan(edge - 0.35);
      }
    }
  });

  it('follows the body when the vehicle is turned 45 degrees', () => {
    const { game, vs, car } = world(true, 45);
    const b = vs.bodyRect(car)!;
    // approach the middle of the left side along its normal
    const [cx, cy] = car.mountToWorld((b.x0 + b.x1) / 2, b.y0);
    const nx = Math.sin((45 * Math.PI) / 180), ny = -Math.cos((45 * Math.PI) / 180);
    const [x, y] = walk(game.map, cx + nx * 3, cy + ny * 3, -nx, -ny);
    const d = Math.hypot(x - cx, y - cy);
    expect(d).toBeGreaterThan(0.25);
    expect(d).toBeLessThan(0.4);
  });

  it('an open door lets you walk in; inside the car you are on it', () => {
    const { game, vs, car } = world(true);
    const door = car.parts.find((p) => p.def.id === 'door_front_left')!;
    vs.toggleDoor(car, door.mx, door.my);
    const [, y] = walk(game.map, 10.5, 7.5, 0, 1);
    expect(y).toBeGreaterThan(9.8);
    game.player.x = 10.5;
    game.player.y = y;
    expect(vs.playerOn()?.v).toBe(car);
    // standing in the door's tile but outside the paint is not "on" the car
    game.player.y = 9.2;
    expect(vs.playerOn()).toBeNull();
  });

  it('closing a door works from beside it, not from inside the doorway', () => {
    const { game, vs, car } = world(true);
    const door = car.parts.find((p) => p.def.id === 'door_front_left')!;
    vs.toggleDoor(car, door.mx, door.my);
    game.player.x = 10.5;
    game.player.y = 9.25; // door tile, outside the body
    expect(vs.toggleDoor(car, door.mx, door.my)).toMatch(/close/);
    vs.toggleDoor(car, door.mx, door.my);
    game.player.y = 9.85; // in the doorway
    expect(vs.toggleDoor(car, door.mx, door.my)).toMatch(/in the way/);
  });

  it("driving past someone standing beside the paint doesn't run them over or carry them", () => {
    const { game, vs, car } = world(true);
    game.player.x = 12.5;
    game.player.y = 9.25; // in the left column's tile, 0.4 m off the paint
    const hp = JSON.stringify(game.player.hp);
    car.velocity = 8 / MPH_PER_MS;
    for (let i = 0; i < 20; i++) game.tick(1 / 30);
    expect(car.x).toBeGreaterThan(11.5);
    expect(game.player.x).toBeCloseTo(12.5, 5);
    expect(JSON.stringify(game.player.hp)).toEqual(hp);
  });

  it('still runs over zombies in its path, and not ones beside it', () => {
    const { game, ms, vs, car } = world(true);
    vs.takeControls(car);
    const ahead = ms.spawnById('mon_zombie', 20.5, 10.5, 0)!;
    const beside = ms.spawnById('mon_zombie', 24.5, 9.25, 0)!;
    for (const z of [ahead, beside]) z.addEffect('stunned', 60);
    vs.scriptedInput = true;
    for (let i = 0; i < 90; i++) {
      car.velocity = Math.max(car.velocity, 20 / MPH_PER_MS);
      // it would shamble toward you: hold it on the verge, 0.4 m off the paint
      if (!beside.dead) [beside.x, beside.y] = [24.5, 9.25];
      game.tick(1 / 30);
    }
    expect(car.x).toBeGreaterThan(26);
    expect(ahead.dead).toBe(true);
    expect(beside.dead).toBe(false);
    expect(beside.hp).toBe(beside.hpMax);
  });
});
