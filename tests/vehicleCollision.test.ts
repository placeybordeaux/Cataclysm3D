// Driving crashes follow the drawn car body (src/game/vehicleShape.ts OBBs, vehicles.ts
// collidePose): a car is ~2.2 m wide on its 4-tile grid, so whole-tile crashes left ~1 m of
// visible air beside the paint and gaps that looked wide enough weren't. Headless / parts look
// (no body shape) keep whole tiles; several tests check both to show the difference.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import { MonsterSystem } from '../src/game/monai';
import { has, MPH_PER_MS, type Vehicle } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { monsterCreatureHooks, VehicleSystem } from '../src/game/vehicles';
import { obbHitsObb, obbHitsTile, rectObb, type Obb } from '../src/game/vehicleShape';
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

function world(shaped: boolean) {
  const game = new Game(data, 3, stubInput());
  game.map.generator = new FlatGen();
  for (let y = -1; y <= 3; y++) for (let x = -1; x <= 4; x++) game.map.chunk(x, y, 0);
  // an unbreakable wall (no bash data): BN's "veh_coll_other"
  game.map.terrain.add({ ...data.terrain.t_rock, id: 't_test_wall', name: 'test wall', bash: undefined });
  const ms = new MonsterSystem(game);
  const vs = new VehicleSystem(game, vdata);
  game.vehicles = vs;
  vs.creatureHooks = monsterCreatureHooks(ms);
  game.systems.push(ms, vs);
  if (shaped) vs.bodyShape = bodyRectFor;
  game.player.x = 90.5;
  game.player.y = 90.5;
  vs.scriptedInput = true;
  return { game, ms, vs };
}

/** A pristine vehicle at world (x, y) (mount 0,0), doors shut; tile footprints may overlap others'. */
function put(vs: VehicleSystem, proto: string, x: number, y: number, facing: number): Vehicle {
  const v = vs.spawn(proto, Math.floor(x), Math.floor(y), 0, facing, { fuel: 100, status: 2, rng: new Rng(7), force: true })!;
  for (const p of v.parts) if (has(p, 'OPENABLE')) p.open = false;
  v.locked = false;
  v.x = x;
  v.y = y;
  v.version++;
  vs.reindex(v);
  return v;
}

const hp = (v: Vehicle) => v.parts.reduce((a, p) => a + p.hp, 0);
const wall = (map: GameMap, x: number, y: number) => map.setTer(x, y, 0, 't_test_wall');
/** Grow a box by `d` on every side (to ask "touching?"). */
const grow = (o: Obb, d: number): Obb => ({ ...o, hx: o.hx + d, hy: o.hy + d });
/** The driven car: take the controls (you ride in the seat), engine on. */
function drive(vs: VehicleSystem, v: Vehicle) {
  [vs.game.player.x, vs.game.player.y] = v.mountToWorld(0, 0);
  expect(vs.takeControls(v).ok).toBe(true);
  expect(vs.startEngine(v).ok).toBe(true);
  vs.driveMode = 'direct';
}

describe('driving collision follows the drawn body', () => {
  it('a car body is narrower and shorter than its grid (what the rest relies on)', () => {
    const { vs } = world(true);
    const car = put(vs, 'car', 10.5, 10.5, 0);
    const b = vs.bodyRect(car)!;
    const [x0, y0, x1, y1] = car.bounds();
    expect(b.y1 - b.y0).toBeLessThan(y1 - y0 + 1 - 1.4); // > 0.7 m of air each side
    expect(b.x1 - b.x0).toBeLessThan(x1 - x0 + 1);
    expect(b.y1 - b.y0).toBeGreaterThan(1.8);
  });

  it('drives past a parked car with 0.3 m between the paint (whole tiles: crashes)', () => {
    for (const shaped of [true, false]) {
      const { game, vs } = world(shaped);
      const parked = put(vs, 'car', 40.5, 20.5, 0);
      const b = bodyRectFor(parked)!; // the drawn outline even when collision ignores it
      const edge = parked.mountToWorld(0, b.y1)[1];
      // the mover's left paint 0.3 m right of the parked car's right paint
      const mover = put(vs, 'car', 26.5, edge + 0.3 - b.y0, 0);
      const h0 = hp(mover), hp0 = hp(parked);
      mover.velocity = 8;
      for (let i = 0; i < 120; i++) game.tick(1 / 30);
      if (shaped) {
        expect(mover.x).toBeGreaterThan(50);
        expect(hp(mover)).toBe(h0);
        expect(hp(parked)).toBe(hp0);
        expect(obbHitsObb(rectObb(mover, b), rectObb(parked, b))).toBe(false);
      } else {
        expect(mover.x).toBeLessThan(40);
        expect(mover.velocity).toBe(0);
      }
    }
  });

  it('drives along a wall with 0.3 m to spare (whole tiles: scrapes to a stop)', () => {
    for (const shaped of [true, false]) {
      const { game, vs } = world(shaped);
      for (let x = 20; x < 70; x++) wall(game.map, x, 30);
      const b = bodyRectFor(put(vs, 'car', 5.5, 5.5, 0))!;
      const car = put(vs, 'car', 22.5, 30 - 0.3 - b.y1, 0); // right paint 0.3 m off the wall's face
      const h0 = hp(car);
      car.velocity = 8;
      for (let i = 0; i < 90; i++) game.tick(1 / 30);
      if (shaped) {
        expect(car.x).toBeGreaterThan(40);
        expect(hp(car)).toBe(h0);
      } else expect(car.x).toBeLessThan(23);
    }
  });

  it('fits through a 3-tile gap the 4-tile grid would not', () => {
    for (const shaped of [true, false]) {
      const { game, vs } = world(shaped);
      // a wall across the road at x = 30 with a gap y = 20..22
      for (let y = 5; y < 40; y++) if (y < 20 || y > 22) wall(game.map, 30, y);
      const b = bodyRectFor(put(vs, 'car', 5.5, 5.5, 0))!;
      const car = put(vs, 'car', 15.5, 21.5 - (b.y0 + b.y1) / 2, 0); // body centred in the gap
      const h0 = hp(car);
      car.velocity = 6;
      for (let i = 0; i < 150; i++) game.tick(1 / 30);
      if (shaped) {
        expect(car.x).toBeGreaterThan(35);
        expect(hp(car)).toBe(h0);
      } else {
        expect(car.x).toBeLessThan(30);
        expect(hp(car)).toBeLessThan(h0);
      }
    }
  });

  it('head-on into a wall: stops with the bumper on the wall, the front takes the damage', () => {
    const { game, vs } = world(true);
    for (let y = 0; y < 40; y++) wall(game.map, 30, y);
    const car = put(vs, 'car', 15.5, 15.5, 0);
    const b = vs.bodyRect(car)!;
    const front = car.parts.filter((p) => p.mx === Math.round(b.x1 - 0.3));
    const f0 = front.reduce((a, p) => a + p.hp, 0);
    const rear = car.parts.filter((p) => p.mx < 0).reduce((a, p) => a + p.hp, 0);
    car.velocity = 10;
    for (let i = 0; i < 90; i++) game.tick(1 / 30);
    expect(car.velocity).toBe(0);
    const nose = car.mountToWorld(b.x1, 0)[0];
    expect(nose).toBeLessThanOrEqual(30);
    expect(nose).toBeGreaterThan(30 - 0.03); // paint on the wall, not a substep short
    expect(front.reduce((a, p) => a + p.hp, 0)).toBeLessThan(f0);
    expect(car.parts.filter((p) => p.mx < 0).reduce((a, p) => a + p.hp, 0)).toBe(rear);
  });

  it.each([['headless / parts look', false], ["crashGeometry 'tiles' in the modelled look", true]])("whole tiles (%s) keep BN's tile rule: stopped when the front mount would take the wall tile", (_, shaped) => {
    const { game, vs } = world(shaped as boolean);
    vs.crashGeometry = 'tiles';
    for (let y = 0; y < 40; y++) wall(game.map, 30, y);
    const car = put(vs, 'car', 15.5, 15.5, 0);
    const b = bodyRectFor(car)!;
    car.velocity = 10;
    for (let i = 0; i < 90; i++) game.tick(1 / 30);
    expect(car.velocity).toBe(0);
    const [, , x1] = car.bounds();
    const frontMount = car.mountToWorld(x1, 0)[0];
    expect(frontMount).toBeLessThanOrEqual(30); // the wall tile's centre (30.5) never maps to it
    expect(frontMount).toBeGreaterThan(29.7);
    // ...which lets the drawn nose (past the front mount's centre) poke into the wall: that
    // is why the modelled look uses the body instead
    expect(car.mountToWorld(b.x1, 0)[0]).toBeGreaterThan(30);
  });

  it('OBB vs OBB: rams a parked car square and at an angle, stopping where the bodies touch; both take damage at the contact', () => {
    for (const facing of [90, 60]) {
      const { game, vs } = world(true);
      const parked = put(vs, 'car', 40.5, 20.5, facing);
      const pb = vs.bodyRect(parked)!;
      const [pcx, pcy] = parked.mountToWorld((pb.x0 + pb.x1) / 2, (pb.y0 + pb.y1) / 2);
      const b = vs.bodyRect(put(vs, 'car', 5.5, 5.5, 0))!;
      const car = put(vs, 'car', 20.5, pcy - (b.y0 + b.y1) / 2, 0); // aimed at the parked car's middle
      const h0 = hp(car), p0 = hp(parked);
      car.velocity = 9;
      for (let i = 0; i < 90; i++) game.tick(1 / 30);
      expect(car.velocity).toBe(0);
      const a = rectObb(car, b), o = rectObb(parked, pb);
      expect(obbHitsObb(a, o)).toBe(false);
      expect(obbHitsObb(grow(a, 0.03), o)).toBe(true);
      expect(car.x).toBeLessThan(pcx);
      expect(hp(car)).toBeLessThan(h0);
      expect(hp(parked)).toBeLessThan(p0);
      // the mover's damage is at its front (the part nearest the touch point)
      const hurt = car.parts.filter((p) => p.hp < p.def.durability);
      expect(hurt.length).toBeGreaterThan(0);
      for (const p of hurt) expect(p.mx).toBeGreaterThanOrEqual(Math.round(b.x1 - 0.3) - 1);
    }
  });

  it('a lane change in a 4-tile-wide alley: the body turns clear of the walls (whole tiles: crashes)', () => {
    for (const shaped of [true, false]) {
      const { game, vs } = world(shaped);
      for (let x = 10; x < 80; x++) {
        wall(game.map, x, 17);
        wall(game.map, x, 22);
      }
      const b = bodyRectFor(put(vs, 'car', 5.5, 5.5, 0))!;
      const car = put(vs, 'car', 15.5, 20 - (b.y0 + b.y1) / 2, 0);
      drive(vs, car);
      const h0 = hp(car);
      let maxYaw = 0;
      const steer = (s: number, seconds: number) => {
        vs.input = { throttle: 0.4, steer: s, brake: false };
        for (let i = 0; i < seconds * 30; i++) {
          game.tick(1 / 30);
          maxYaw = Math.max(maxYaw, Math.abs(((car.facing + 180) % 360) - 180));
        }
      };
      steer(0, 1);
      steer(-1, 0.5);
      steer(1, 0.9);
      steer(-1, 0.4);
      steer(0, 1);
      expect(maxYaw).toBeGreaterThan(4);
      if (shaped) {
        expect(hp(car)).toBe(h0);
        expect(car.x).toBeGreaterThan(22);
      } else expect(hp(car)).toBeLessThan(h0);
    }
  });

  it('turning toward a wall stops when the corner touches it', () => {
    const { game, vs } = world(true);
    for (let x = 10; x < 80; x++) wall(game.map, x, 30);
    const b = bodyRectFor(put(vs, 'car', 5.5, 5.5, 0))!;
    const car = put(vs, 'car', 20.5, 30 - 0.4 - b.y1, 0);
    drive(vs, car);
    vs.input = { throttle: 0.5, steer: 1, brake: false }; // D: clockwise, toward +y (the wall)
    let stoppedAt = -1;
    for (let i = 0; i < 150 && stoppedAt < 0; i++) {
      game.tick(1 / 30);
      if (i > 10 && car.velocity === 0) stoppedAt = i;
    }
    expect(stoppedAt).toBeGreaterThan(0);
    expect(car.facing).toBeGreaterThan(1);
    expect(car.facing).toBeLessThan(90);
    const o = rectObb(car, b);
    let touching = false;
    for (let x = 10; x < 80; x++) {
      expect(obbHitsTile(o, x, 30)).toBe(false);
      touching ||= obbHitsTile(grow(o, 0.05), x, 30);
    }
    expect(touching).toBe(true);
  });

  it('no tunnelling at 60 mph: a one-tile wall, a one-tile post, and a long frame hitch', () => {
    const { game, vs } = world(true);
    for (let y = 0; y < 40; y++) wall(game.map, 50, y);
    wall(game.map, 50, 45); // a lone post in the next lane
    const b = bodyRectFor(put(vs, 'car', 5.5, 5.5, 0))!;
    const a = put(vs, 'car', 15.5, 20.5, 0);
    const post = put(vs, 'car', 15.5, 45.5 - (b.y0 + b.y1) / 2, 0);
    for (const v of [a, post]) v.velocity = 60 / MPH_PER_MS;
    for (let i = 0; i < 60; i++) game.tick(1 / 30);
    for (const v of [a, post]) {
      expect(v.mountToWorld(b.x1, 0)[0]).toBeLessThanOrEqual(50);
      expect(v.mountToWorld(b.x1, 0)[0]).toBeGreaterThan(49.9);
    }
    // one 0.25 s frame at 60 mph (6.7 m, more than the gap and the wall together)
    const c = put(vs, 'car', 44.5, 60.5, 0);
    wall(game.map, 50, 60);
    wall(game.map, 50, 61);
    c.velocity = 60 / MPH_PER_MS;
    vs.move(c, c.velocity * 0.25, 0);
    expect(c.mountToWorld(b.x1, 0)[0]).toBeLessThanOrEqual(50);
  });

  it('at 60 mph a bicycle in the lane is shoved aside, never driven through', () => {
    const { game, vs } = world(true);
    const car = put(vs, 'car', 10.5, 20.5, 0);
    const b = vs.bodyRect(car)!;
    const bike = put(vs, 'bicycle', 40.5, 20.5 + (b.y0 + b.y1) / 2, 90);
    expect(bike.mass()).toBeLessThan(car.mass() * 0.2);
    const [bx, by] = [bike.x, bike.y];
    car.velocity = 60 / MPH_PER_MS;
    let overlapped = false;
    for (let i = 0; i < 45; i++) {
      game.tick(1 / 30);
      overlapped ||= obbHitsObb(rectObb(car, b), rectObb(bike, vs.bodyRect(bike)!));
    }
    expect(overlapped).toBe(false);
    expect(Math.hypot(bike.x - bx, bike.y - by)).toBeGreaterThan(0.5);
    expect(hp(bike)).toBeLessThan(bike.parts.reduce((a, p) => a + p.def.durability, 0));
  });

  it('two cars parked paint-to-paint with overlapping grids: at(), playerOn and walking between them', () => {
    const { game, vs } = world(true);
    const a = put(vs, 'car', 20.5, 20.5, 0);
    const b = vs.bodyRect(a)!;
    const gap = 0.8;
    const bCar = put(vs, 'car', 20.5, 20.5 + (b.y1 - b.y0) + gap, 0);
    // their grids share a tile row; each tile answers for the body over its centre
    const ya = a.mountToWorld(0, b.y1)[1], yb = bCar.mountToWorld(0, b.y0)[1];
    const tilesA = new Set(a.occupiedTiles().map((t) => `${t.tx},${t.ty}`));
    const shared = bCar.occupiedTiles().filter((t) => tilesA.has(`${t.tx},${t.ty}`));
    expect(shared.length).toBeGreaterThan(0);
    for (const t of shared) {
      const cy = t.ty + 0.5;
      expect(vs.at(t.tx, t.ty, 0)?.v).toBe(cy < ya + 0.01 ? a : cy > yb - 0.01 ? bCar : vs.at(t.tx, t.ty, 0)?.v);
    }
    const inA = a.mountToWorld(0, 0), inB = bCar.mountToWorld(0, 0);
    [game.player.x, game.player.y] = inA;
    expect(vs.playerOn()?.v).toBe(a);
    [game.player.x, game.player.y] = inB;
    expect(vs.playerOn()?.v).toBe(bCar);
    // standing in the gap between the paint: on neither, and not blocked
    game.player.x = 20.5;
    game.player.y = (ya + yb) / 2;
    expect(vs.playerOn()).toBeNull();
    expect(vs.collide(game.player.x, game.player.y, 0, 0.3)).toBe(false);
    // removing one leaves the other's tiles indexed
    vs.remove(bCar);
    for (const t of a.occupiedTiles()) expect(vs.at(t.tx, t.ty, 0)?.v).toBe(a);
  });

  it('runs over a zombie in its lane and not one 0.4 m off the paint while squeezing past a car', () => {
    const { game, ms, vs } = world(true);
    const parked = put(vs, 'car', 40.5, 20.5, 0);
    const b = vs.bodyRect(parked)!;
    const mover = put(vs, 'car', 20.5, parked.mountToWorld(0, b.y1)[1] + 0.3 - b.y0, 0);
    drive(vs, mover);
    const my = mover.mountToWorld(0, (b.y0 + b.y1) / 2)[1];
    const ahead = ms.spawnById('mon_zombie', 60.5, my, 0)!;
    const beside = ms.spawnById('mon_zombie', 64.5, mover.mountToWorld(0, b.y1)[1] + 0.4 + 0.3, 0)!;
    for (const z of [ahead, beside]) z.addEffect('stunned', 60);
    const bpos = [beside.x, beside.y];
    for (let i = 0; i < 180; i++) {
      mover.velocity = Math.max(mover.velocity, 20 / MPH_PER_MS);
      if (!beside.dead) [beside.x, beside.y] = bpos;
      game.tick(1 / 30);
    }
    expect(mover.x).toBeGreaterThan(66);
    expect(ahead.dead).toBe(true);
    expect(beside.hp).toBe(beside.hpMax);
  });
});
