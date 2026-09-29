import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import { cruiseThrust, CRUISE_STEP_VMIPH, MPH_PER_MS, VMIPH_PER_MS, resolveCollision, rotate, simpleCubicSolution, spawnVehicle, Vehicle, has } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { feltAcceleration, maxSteerAt, registerVehicleSave, VehicleSystem } from '../src/game/vehicles';
import { createItem } from '../src/game/item';
import { saveRegistry } from '../src/save/registry';
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

const stubInput = () => ({ held: new Set<string>(), captured: false, onPress() {}, consumeMouse: () => [0, 0] }) as any;

function world(): { game: Game; vs: VehicleSystem } {
  const game = new Game(data, 1, stubInput());
  game.map.generator = new FlatGen();
  const vs = new VehicleSystem(game, vdata);
  game.systems.push(vs);
  game.player.x = 0.5;
  game.player.y = -20.5;
  return { game, vs };
}

const pristineCar = (vs: VehicleSystem, x = 10, y = 10, facing = 0) => {
  const v = vs.spawn('car', x, y, 0, facing, { fuel: 100, status: 2, rng: new Rng(7) })!;
  for (const p of v.parts) if (has(p, 'OPENABLE')) p.open = false;
  v.locked = false;
  return v;
};

describe('vehicle data', () => {
  it('car inherits the 4x4 body from car_abstract and appends its engine and tank', () => {
    const car = vdata.vehicles.car;
    const ids = car.parts.map((p) => p.part);
    expect(ids).toContain('engine_inline4');
    expect(ids).toContain('tank');
    expect(ids).toContain('controls');
    expect(ids.filter((i) => i === 'wheel').length).toBe(4);
    expect(car.parts.find((p) => p.part === 'tank')!.fuel).toBe('gasoline');
    expect(vdata.fuels.gasoline.kjPerCharge).toBeCloseTo(34.2);
  });
  it('city_vehicles is a group mapgen can roll', () => {
    expect(vdata.groups.city_vehicles.length).toBeGreaterThan(5);
  });
});

describe('occupancy and rotation', () => {
  it('rotates mounts clockwise from east (CDDA facing)', () => {
    expect(rotate(1, 0, 0)).toEqual([1, 0]);
    expect(rotate(1, 0, 90)).toEqual([0, 1]); // forward = south
    expect(rotate(0, 1, 90)).toEqual([-1, 0]); // right side = west when facing south
    expect(rotate(2, -1, 180)).toEqual([-2, 1]);
    expect(rotate(2, -1, 270)).toEqual([-1, -2]);
  });

  it('covers exactly one tile per mount at every right angle, pivot on its tile', () => {
    const v = spawnVehicle(vdata, data, 'car', { x: 10.5, y: 20.5, z: 0, facing: 0, rng: new Rng(1) });
    const mounts = new Set([...v.mounts()]).size;
    for (const f of [0, 90, 180, 270]) {
      v.facing = f;
      const tiles = v.occupiedTiles();
      expect(tiles.length).toBe(mounts);
      expect(new Set(tiles.map((t) => `${t.tx},${t.ty}`)).size).toBe(mounts);
      expect(tiles.find((t) => t.mx === 0 && t.my === 0)).toMatchObject({ tx: 10, ty: 20 });
      // the front row (mx = 2 on a station wagon) is ahead in the facing direction
      const front = tiles.find((t) => t.mx === 2 && t.my === 0)!;
      const [dx, dy] = rotate(2, 0, f);
      expect([front.tx - 10, front.ty - 20]).toEqual([dx, dy]);
    }
  });

  it('diagonal facings still give every tile a single mount and keep the body closed', () => {
    const v = spawnVehicle(vdata, data, 'car', { x: 10.5, y: 20.5, z: 0, facing: 45, rng: new Rng(1) });
    const tiles = v.occupiedTiles();
    const keys = tiles.map((t) => `${t.tx},${t.ty}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(tiles.length).toBeGreaterThan(20);
    expect(v.mountAtTile(10, 20)).toEqual([0, 0]);
  });

  it('frames/boards block, open doors and seats are passable, boards block sight', () => {
    const { game, vs } = world();
    const v = pristineCar(vs);
    const tileOf = (mx: number, my: number) => v.mountToWorld(mx, my).map(Math.floor) as [number, number];
    const [dx, dy] = tileOf(0, -1); // driver door
    expect(game.map.passable(dx, dy, 0)).toBe(false);
    vs.toggleDoor(v, 0, -1);
    expect(game.map.moveCost(dx, dy, 0)).toBe(8);
    const [sx, sy] = tileOf(0, 0);
    expect(game.map.moveCost(sx, sy, 0)).toBe(8); // clamber over the seat
    const [hx, hy] = tileOf(2, -1); // quarter panel
    expect(game.map.passable(hx, hy, 0)).toBe(false);
    expect(game.map.opaque(hx, hy, 0)).toBe(false); // half boards don't block sight
    expect(game.map.passable(10, 5, 0)).toBe(true); // outside the car
  });

  it('player collision uses the vehicle overlay', async () => {
    const { game, vs } = world();
    pristineCar(vs, 10, 10, 0);
    const { moveWithCollision } = await import('../src/game/physics');
    // walk north into the car's right-side panels from below
    const [, y] = moveWithCollision(game.map, 10.5, 14.5, 0, 0, -3);
    expect(y).toBeGreaterThan(12.9);
  });
});

describe('physics', () => {
  it('cubic solver finds the real root', () => {
    const r = simpleCubicSolution(1, 0, 0, -8);
    expect(r).toBeCloseTo(2, 5);
    const r2 = simpleCubicSolution(1, 3, 110, -93250);
    expect(r2 ** 3 + 3 * r2 ** 2 + 110 * r2).toBeCloseTo(93250, 0);
  });

  it('a station wagon has a plausible top speed and acceleration', () => {
    const { vs } = world();
    const v = pristineCar(vs);
    v.engineOn = true;
    const vmax = v.maxVelocity() * 2.237;
    expect(vmax).toBeGreaterThan(70);
    expect(vmax).toBeLessThan(140);
    expect(v.acceleration(0)).toBeGreaterThan(2);
    expect(v.mass()).toBeGreaterThan(900);
  });

  it('burns fuel by engine energy consumption and fuel energy density', () => {
    const { vs } = world();
    const v = pristineCar(vs);
    v.engineOn = true;
    const before = v.fuelLeft('gasoline');
    expect(before).toBe(60000);
    const used = v.consumeFuel(1, 1);
    // engine_inline4: 311 kW at full load / 34.2 kJ per ml
    expect(used.gasoline).toBeCloseTo(311000 / 1000 / 34.2, 3);
    expect(v.fuelLeft('gasoline')).toBeCloseTo(before - used.gasoline, 6);
  });

  it('drives: engine start, throttle moves the car forward and burns fuel', () => {
    const { game, vs } = world();
    const v = pristineCar(vs, 10, 10, 0);
    game.player.x = 10.5;
    game.player.y = 10.5;
    expect(vs.takeControls(v).ok).toBe(true);
    const r = vs.startEngine(v);
    expect(r.ok).toBe(true);
    const fuel0 = v.fuelLeft('gasoline');
    vs.driveMode = 'direct';
    vs.scriptedInput = true;
    vs.input = { throttle: 1, steer: 0, brake: false };
    for (let i = 0; i < 90; i++) game.tick(1 / 30);
    expect(v.velocity).toBeGreaterThan(5);
    expect(v.x).toBeGreaterThan(15);
    expect(Math.abs(v.y - 10.5)).toBeLessThan(0.01);
    expect(v.fuelLeft('gasoline')).toBeLessThan(fuel0);
    // the driver rides along in the seat
    expect(game.player.x).toBeCloseTo(v.x, 5);
    // steering right turns clockwise (toward south)
    vs.input = { throttle: 0.3, steer: 1, brake: false };
    for (let i = 0; i < 30; i++) game.tick(1 / 30);
    expect(v.facing).toBeGreaterThan(5);
    expect(v.facing).toBeLessThan(180);
    // brakes stop it without reversing
    vs.input = { throttle: 0, steer: 0, brake: true };
    for (let i = 0; i < 120; i++) game.tick(1 / 30);
    expect(v.velocity).toBe(0);
  });

  it('a dead battery or empty tank keeps the engine off; locked cars need hotwiring', () => {
    const { vs } = world();
    const v = pristineCar(vs);
    v.drainFuel('battery', 1e9);
    expect(vs.startEngine(v).ok).toBe(false);
    const w = pristineCar(vs, 30, 10);
    w.drainFuel('gasoline', 1e9);
    expect(vs.startEngine(w).msg).toMatch(/out of gasoline/);
    const l = pristineCar(vs, 50, 10);
    l.locked = true;
    expect(vs.startEngine(l).msg).toMatch(/hotwire/);
  });
});

describe('cruise control (CDDA driving model option)', () => {
  it('cruise_thrust steps 4 mph, snaps to the safe speed, clamps to max and reverse', () => {
    // safe 45 mph, max 60, reverse -15 (combustion: max / 4)
    const step = (c: number, n: number) => cruiseThrust(c, n * CRUISE_STEP_VMIPH, 4500, 6000, -1500);
    expect(step(0, 1)).toBe(400);
    expect(step(400, 1)).toBe(800);
    expect(step(4400, 1)).toBe(4500); // crossing the safe speed stops on it
    expect(step(4500, 1)).toBe(4800); // the next press goes past, back onto the 4 mph grid
    expect(step(5600, 1)).toBe(6000);
    expect(step(6000, 1)).toBe(6000);
    expect(step(6000, -1)).toBe(5600);
    expect(step(4500, -1)).toBe(4400);
    expect(step(0, -1)).toBe(-400);
    expect(step(-1200, -1)).toBe(-1500);
    expect(step(-1500, 1)).toBe(-1200);
  });

  const drivingCar = () => {
    const { game, vs } = world();
    const v = pristineCar(vs, 10, 10, 0);
    game.player.x = 10.5;
    game.player.y = 10.5;
    vs.takeControls(v);
    expect(vs.startEngine(v).ok).toBe(true);
    // CDDA's model is an option now; direct driving is the default.
    vs.driveMode = 'cruise';
    vs.scriptedInput = true;
    vs.input = { throttle: 0, steer: 0, brake: false };
    return { game, vs, v };
  };
  const mph = (v: Vehicle) => v.velocity * MPH_PER_MS;

  it('converges on the target without overshooting, and holds it', () => {
    const { game, v } = drivingCar();
    v.cruiseVelocity = 2000;
    let peak = 0;
    for (let i = 0; i < 30 * 10; i++) {
      game.tick(1 / 30);
      peak = Math.max(peak, mph(v));
    }
    expect(mph(v)).toBeCloseTo(20, 1);
    expect(peak).toBeLessThanOrEqual(20.001);
    // Lowering the target brakes down to it.
    v.cruiseVelocity = 800;
    for (let i = 0; i < 30 * 4; i++) game.tick(1 / 30);
    expect(mph(v)).toBeCloseTo(8, 1);
    // Zero stops the car, and it stays stopped.
    v.cruiseVelocity = 0;
    for (let i = 0; i < 30 * 4; i++) game.tick(1 / 30);
    expect(v.velocity).toBe(0);
  });

  it('W taps raise the target 4 mph; a held W pauses at the safe speed; Space zeroes it', () => {
    const { game, vs, v } = drivingCar();
    const tap = (throttle: number) => {
      vs.input = { throttle, steer: 0, brake: false };
      game.tick(1 / 30);
      vs.input = { throttle: 0, steer: 0, brake: false };
      game.tick(1 / 30);
    };
    tap(1);
    tap(1);
    expect(v.cruiseVelocity).toBe(800);
    tap(-1);
    expect(v.cruiseVelocity).toBe(400);
    // Released keys leave the target alone: the car keeps cruising at 4 mph.
    for (let i = 0; i < 30 * 5; i++) game.tick(1 / 30);
    expect(mph(v)).toBeCloseTo(4, 1);
    const safe = Math.trunc(v.maxVelocity(true) * VMIPH_PER_MS);
    vs.input = { throttle: 1, steer: 0, brake: false };
    for (let i = 0; i < 30 * 30; i++) game.tick(1 / 30);
    // (burnt fuel lightens the car, nudging its safe speed by a hair)
    expect(Math.abs(v.cruiseVelocity - safe)).toBeLessThanOrEqual(3);
    // A tap from just under the safe speed first snaps to it (cruise_thrust); the next goes past.
    tap(1);
    if (v.cruiseVelocity <= safe) tap(1);
    expect(v.cruiseVelocity).toBeGreaterThan(safe);
    vs.input = { throttle: 0, steer: 0, brake: true };
    game.tick(1 / 30);
    expect(v.cruiseVelocity).toBe(0);
  });

  it('reaching 50 mph takes deliberate presses: holding W for 4 s stays well under it', () => {
    const { game, vs, v } = drivingCar();
    vs.input = { throttle: 1, steer: 0, brake: false };
    for (let i = 0; i < 30 * 4; i++) game.tick(1 / 30);
    expect(mph(v)).toBeLessThan(v.cruiseVelocity / 100 + 0.01);
    expect(mph(v)).toBeLessThan(40);
  });

  it('cruise target survives save/load; engine off drops it', () => {
    const { vs, v } = drivingCar();
    v.cruiseVelocity = 1200;
    const j = v.toJSON();
    expect(j.cruise).toBe(1200);
    expect(Vehicle.fromJSON(vdata, data, j).cruiseVelocity).toBe(1200);
    const { game } = { game: (vs as unknown as { game: Game }).game };
    v.engineOn = false;
    for (let i = 0; i < 3; i++) game.tick(1 / 30);
    expect(v.cruiseVelocity).toBe(0);
  });
});

describe('direct driving (default)', () => {
  const driving = (proto = 'car') => {
    const { game, vs } = world();
    const v = vs.spawn(proto, 10, 10, 0, 0, { fuel: 100, status: 2, rng: new Rng(7) })!;
    for (const p of v.parts) if (has(p, 'OPENABLE')) p.open = false;
    v.locked = false;
    vs.takeControls(v);
    expect(vs.startEngine(v).ok).toBe(true);
    vs.scriptedInput = true;
    return { game, vs, v };
  };
  const mph = (v: Vehicle) => v.velocity * MPH_PER_MS;
  const run = (game: Game, seconds: number, until?: () => boolean) => {
    let t = 0;
    while (t < seconds && !(until && until())) {
      game.tick(1 / 30);
      t += 1 / 30;
    }
    return t;
  };

  it('is the default model', () => {
    expect(world().vs.driveMode).toBe('direct');
  });

  it('W: a car does 0-30 mph in 3-5 s; electric and heavy vehicles stay in a playable band', () => {
    for (const [proto, lo, hi] of [['car', 3, 5], ['suv_electric', 2.5, 5], ['semi_truck', 4, 7], ['car_sports', 2, 4]] as const) {
      const { game, vs, v } = driving(proto);
      vs.input = { throttle: 1, steer: 0, brake: false };
      const t = run(game, 15, () => mph(v) >= 30);
      expect(t, proto).toBeGreaterThan(lo);
      expect(t, proto).toBeLessThan(hi);
    }
  });

  it('responds at once: moving within a quarter second of pressing W', () => {
    const { game, vs, v } = driving();
    vs.input = { throttle: 1, steer: 0, brake: false };
    run(game, 0.25);
    expect(mph(v)).toBeGreaterThan(0.5);
  });

  it('releasing W coasts: slows noticeably but keeps rolling', () => {
    const { game, vs, v } = driving();
    vs.input = { throttle: 1, steer: 0, brake: false };
    run(game, 15, () => mph(v) >= 30);
    vs.input = { throttle: 0, steer: 0, brake: false };
    run(game, 3);
    expect(mph(v)).toBeLessThan(27);
    expect(mph(v)).toBeGreaterThan(18);
  });

  it('S brakes firmly (30 mph to 0 in ~1.5-2 s), holds at 0 briefly, then reverses', () => {
    const { game, vs, v } = driving();
    v.velocity = 30 / MPH_PER_MS;
    vs.input = { throttle: -1, steer: 0, brake: false };
    const t = run(game, 5, () => v.velocity <= 0);
    expect(t).toBeGreaterThan(1.3);
    expect(t).toBeLessThan(2.1);
    expect(v.velocity).toBe(0);
    run(game, 0.15);
    expect(v.velocity).toBe(0); // no instant flip into reverse
    run(game, 1.5);
    expect(v.velocity).toBeLessThan(-0.5);
  });

  it('Space (handbrake) stops the car and never reverses it', () => {
    const { game, vs, v } = driving();
    v.velocity = 10;
    vs.input = { throttle: 0, steer: 0, brake: true };
    run(game, 2);
    expect(v.velocity).toBe(0);
  });

  it('steering narrows with speed: lateral acceleration stays car-like at 50 mph', () => {
    const { game, vs, v } = driving();
    v.velocity = 50 / MPH_PER_MS;
    vs.input = { throttle: 0.3, steer: 1, brake: false };
    run(game, 1);
    const lat = (v.velocity * v.velocity * Math.tan(Math.abs(v.steer))) / v.wheelbase();
    expect(lat).toBeLessThan(6);
    expect(lat).toBeGreaterThan(3);
    // and at parking speed the full lock is available
    expect(maxSteerAt(1, v.wheelbase())).toBeCloseTo(0.6, 2);
  });

  it('steering eases in rather than snapping', () => {
    const { game, vs, v } = driving();
    v.velocity = 5;
    vs.input = { throttle: 0.3, steer: 1, brake: false };
    game.tick(1 / 30);
    expect(Math.abs(v.steer)).toBeLessThan(0.1);
    run(game, 0.6);
    expect(Math.abs(v.steer)).toBeGreaterThan(0.3);
  });

  it('cruise control key locks the current speed; S cancels it', () => {
    const { game, vs, v } = driving();
    expect(vs.toggleCruise()).toMatch(/Get moving/);
    vs.input = { throttle: 1, steer: 0, brake: false };
    run(game, 15, () => mph(v) >= 25);
    expect(vs.toggleCruise()).toMatch(/set to 2[5-6] mph/);
    vs.input = { throttle: 0, steer: 0, brake: false };
    run(game, 5);
    expect(mph(v)).toBeGreaterThan(24);
    vs.input = { throttle: -1, steer: 0, brake: false };
    game.tick(1 / 30);
    expect(vs.cruiseOn).toBe(false);
    vs.input = { throttle: 0, steer: 0, brake: false };
    run(game, 3);
    expect(mph(v)).toBeLessThan(22);
  });

  it('felt acceleration compresses CDDA launch figures toward a car', () => {
    expect(feltAcceleration(6.5)).toBeCloseTo(3.4, 1);
    expect(feltAcceleration(26)).toBeLessThanOrEqual(5);
    expect(feltAcceleration(2)).toBeGreaterThanOrEqual(1.2);
    expect(feltAcceleration(11)).toBeGreaterThan(feltAcceleration(6.5));
  });
});

describe('collisions', () => {
  it('CDDA collision loop: walls stop the vehicle and hurt the part more at speed', () => {
    const slow = resolveCollision({ mass: 1500, velocity: 5, mass2: 1000, e: 0.1, partDens: 80 });
    const fast = resolveCollision({ mass: 1500, velocity: 20, mass2: 1000, e: 0.1, partDens: 80 });
    expect(fast.partDmg).toBeGreaterThan(slow.partDmg * 10);
    expect(fast.velocity).toBeLessThan(20);
    // a flimsy fence gets smashed and the car keeps most of its speed
    const fence = resolveCollision({ mass: 1500, velocity: 15, mass2: 10, e: 0.3, partDens: 6, smash: (d) => d > 5 });
    expect(fence.smashed).toBe(true);
    expect(fence.velocity).toBeGreaterThan(12);
  });

  it('driving into a wall stops the car, damages the front and jolts the driver', () => {
    const { game, vs } = world();
    // an unbreakable wall (no bash data): CDDA's "veh_coll_other", mass 1000
    game.map.terrain.add({ ...data.terrain.t_rock, id: 't_test_wall', name: 'test wall', bash: undefined });
    for (let y = 0; y < 24; y++) game.map.setTer(22, y, 0, 't_test_wall');
    const v = pristineCar(vs, 10, 10, 0);
    game.player.x = 10.5;
    game.player.y = 10.5;
    vs.takeControls(v);
    vs.startEngine(v);
    // remove the seatbelt so the jolt hurts
    for (const p of v.partsAt(0, 0)) if (has(p, 'SEATBELT')) p.hp = 0;
    v.velocity = 20;
    const hpBefore = v.parts.filter((p) => p.mx === 2).reduce((a, p) => a + p.hp, 0);
    const hp0 = game.player.hp.torso.cur;
    const msgs: string[] = [];
    game.events.on("message", (m) => msgs.push(m.text));
    vs.scriptedInput = true;
    vs.input = { throttle: 0, steer: 0, brake: false };
    for (let i = 0; i < 60; i++) game.tick(1 / 30);
    expect(v.velocity).toBe(0);
    // stopped before the wall: the front row is at most at x = 21
    const front = v.mountToWorld(2, 0)[0];
    expect(front).toBeLessThan(22);
    const hpAfter = v.parts.filter((p) => p.mx === 2).reduce((a, p) => a + p.hp, 0);
    expect(hpAfter).toBeLessThan(hpBefore);
    expect(game.player.hp.torso.cur).toBeLessThan(hp0);
    expect(game.map.terAt(22, 10, 0).id).toBe('t_test_wall');
  });

  it('a fast car smashes through a wooden fence and keeps going', () => {
    const { game, vs } = world();
    for (let y = 0; y < 24; y++) game.map.setTer(22, y, 0, 't_fence');
    const v = pristineCar(vs, 10, 10, 0);
    v.velocity = 15;
    for (let i = 0; i < 30; i++) game.tick(1 / 30);
    expect(v.x).toBeGreaterThan(20);
    expect(v.velocity).toBeGreaterThan(8);
    expect(game.map.terAt(22, 10, 0).id).not.toBe('t_fence');
  });

  it('runs over a creature: "rams into", damage scales with speed', () => {
    const { game, vs } = world();
    const v = pristineCar(vs, 10, 10, 0);
    game.player.x = 10.5;
    game.player.y = 10.5;
    vs.takeControls(v);
    const zed = { name: 'zombie', x: 18.5, y: 10.5, hp: 80, dead: false };
    vs.creatureHooks.at = (x, y) => (!zed.dead && Math.floor(zed.x) === x && Math.floor(zed.y) === y ? zed : null);
    vs.creatureHooks.damage = (c, dmg) => {
      zed.hp -= dmg;
      zed.dead = zed.hp <= 0;
      return zed.dead;
    };
    const msgs: string[] = [];
    game.events.on('message', (m) => msgs.push(m.text));
    v.velocity = 15;
    vs.scriptedInput = true;
    for (let i = 0; i < 30; i++) game.tick(1 / 30);
    expect(zed.hp).toBeLessThan(80);
    expect(msgs.some((m) => /rams into the zombie/.test(m))).toBe(true);
    // flung clear of the car (or killed), never left inside its body
    if (!zed.dead) expect(vs.at(Math.floor(zed.x), Math.floor(zed.y), 0)).toBeNull();
  });
});

describe('spawn state and persistence', () => {
  it('follows CDDA fuel/status semantics', () => {
    const full = spawnVehicle(vdata, data, 'car', { x: 0.5, y: 0.5, z: 0, facing: 0, fuel: 100, status: 0, rng: new Rng(3) });
    expect(full.fuelLeft('gasoline')).toBe(60000);
    expect(full.parts.every((p) => p.hp === p.def.durability)).toBe(true);
    const empty = spawnVehicle(vdata, data, 'car', { x: 0.5, y: 0.5, z: 0, facing: 0, fuel: 0, status: 0, rng: new Rng(3) });
    expect(empty.fuelLeft('gasoline')).toBe(0);
    let damaged = 0, locked = 0, partial = 0;
    for (let s = 0; s < 100; s++) {
      const v = spawnVehicle(vdata, data, 'car', { x: 0.5, y: 0.5, z: 0, facing: 0, rng: new Rng(100 + s) });
      if (v.parts.some((p) => p.hp < p.def.durability)) damaged++;
      if (v.locked) locked++;
      const f = v.fuelLeft('gasoline');
      if (f > 0 && f < 60000) partial++;
    }
    expect(damaged).toBeGreaterThan(90);
    // locked = no keys (1 in 3) and a surviving security system
    expect(locked).toBeGreaterThan(1);
    expect(locked).toBeLessThan(30);
    expect(partial).toBeGreaterThan(50);
  });

  it('round-trips through toJSON/fromJSON', () => {
    const v = spawnVehicle(vdata, data, 'car', { x: 5.5, y: 6.5, z: 0, facing: 90, rng: new Rng(5) });
    v.velocity = 3;
    v.parts[3].open = true;
    const j = JSON.parse(JSON.stringify(v.toJSON()));
    const w = Vehicle.fromJSON(vdata, data, j);
    expect(w.toJSON()).toEqual(v.toJSON());
    expect(w.occupiedTiles()).toEqual(v.occupiedTiles());
  });

  it('spawns mapgen requests, skipping ones that overlap walls or other vehicles', () => {
    const { game, vs } = world();
    game.map.setTer(40, 40, 0, 't_concrete_wall');
    const c = game.map.chunk(1, 1, 0)!;
    c.vehicles = [
      { id: 'city_vehicles', x: 30, y: 30, z: 0, rotation: 90, status: 1, fuel: -1 },
      { id: 'car', x: 30, y: 31, z: 0, rotation: 90 },
      { id: 'car', x: 40, y: 40, z: 0 },
    ];
    (vs as any).queueChunk(c);
    vs.flushPending();
    expect(vs.list.length).toBe(1);
    expect(vs.at(30, 30, 0)).not.toBeNull();
  });
});

describe('save/load section', () => {
  it('replaces vehicle state, keeps cargo and the driver, drops unknown prototypes', () => {
    const { game, vs } = world();
    registerVehicleSave(game, vs);
    const v = pristineCar(vs, 10, 10, 90);
    const trunk = v.parts.find((p) => p.def.id === 'trunk')!;
    trunk.items = [createItem(data, 'water_clean')];
    game.player.x = v.x;
    game.player.y = v.y;
    vs.takeControls(v);
    const section = saveRegistry(game).sorted().find(([k]) => k === 'vehicles')![1];
    const saved = JSON.parse(JSON.stringify(section.save())) as { vehicles: { uid: number; proto: string }[] };
    saved.vehicles.push({ ...saved.vehicles[0], uid: 999, proto: 'no_such_vehicle' });
    // something that must disappear on load
    pristineCar(vs, 40, 40, 0);
    const warnings: string[] = [];
    const ctx = { game, data, version: 1, warn: (m: string) => warnings.push(m) };
    section.load(saved, ctx);
    expect(vs.list.length).toBe(1);
    expect(vs.driving?.uid).toBe(v.uid);
    expect(vs.list[0].parts.find((p) => p.def.id === 'trunk')!.items[0].typeId).toBe('water_clean');
    expect(vs.at(40, 40, 0)).toBeNull();
    expect(vs.at(10, 10, 0)).not.toBeNull();
    expect(warnings.some((w) => /no_such_vehicle/.test(w))).toBe(true);
    section.missing!(ctx);
    expect(vs.list.length).toBe(0);
  });

  it("doesn't respawn mapgen vehicles for chunks generated before the save", () => {
    const { game, vs } = world();
    vs.skipChunk = (c) => c.cx === 1 && c.cy === 1;
    const c = game.map.chunk(1, 1, 0)!;
    c.vehicles = [{ id: 'car', x: 30, y: 30, z: 0 }];
    (vs as any).queueChunk(c);
    vs.flushPending();
    expect(vs.list.length).toBe(0);
    expect(c.vehicles.length).toBe(0);
  });
});
