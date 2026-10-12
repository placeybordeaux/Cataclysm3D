// Momentum crashes and heavy handling (src/game/vehicleImpact.ts, vehicles.ts). Playtest: an
// Abrams clipping an ambulance stopped dead and killed its driver, because another vehicle was
// an immovable wall. Now contacts exchange an impulse: the heavy one barely slows, the light one
// is shoved and spun, riders feel their own vehicle's velocity change. And tanks handle heavy.
// Run with drawn bodies (the modelled look), as the game does.
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
import { contactImpulse, handlingFor, motionOf, type ContactBody } from '../src/game/vehicleImpact';
import { obbHitsObb, obbHitsTile, rectObb } from '../src/game/vehicleShape';
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

function world() {
  const game = new Game(data, 3, stubInput());
  game.map.generator = new FlatGen();
  for (let y = -1; y <= 4; y++) for (let x = -1; x <= 5; x++) game.map.chunk(x, y, 0);
  game.map.terrain.add({ ...data.terrain.t_rock, id: 't_test_wall', name: 'test wall', bash: undefined });
  const ms = new MonsterSystem(game);
  const vs = new VehicleSystem(game, vdata);
  game.vehicles = vs;
  vs.creatureHooks = monsterCreatureHooks(ms);
  game.systems.push(ms, vs);
  vs.bodyShape = bodyRectFor;
  game.player.x = 110.5;
  game.player.y = 110.5;
  vs.scriptedInput = true;
  return { game, ms, vs };
}

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
function drive(vs: VehicleSystem, v: Vehicle) {
  [vs.game.player.x, vs.game.player.y] = v.mountToWorld(0, 0);
  expect(vs.takeControls(v).ok).toBe(true);
  const r = vs.startEngine(v);
  expect(r.ok, r.msg).toBe(true);
  vs.driveMode = 'direct';
}
const mph = (v: Vehicle) => v.velocity * MPH_PER_MS;
/** Body centre in world space (what the physics rotates about). */
const centre = (vs: VehicleSystem, v: Vehicle) => {
  const b = vs.physRect(v);
  return v.mountToWorld((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
};
const momentum = (vs: VehicleSystem, list: Vehicle[]) =>
  list.reduce(([px, py], v) => {
    const [vx, vy] = vs.planarVelocity(v);
    return [px + v.mass() * vx, py + v.mass() * vy];
  }, [0, 0]);

/**
 * `rammer` (driven, W held) at `speed` mph heading east into a parked `target` facing
 * `targetFacing`, aimed `offset` m right of the target's centre. Runs until `seconds` after
 * the target first moves; returns what happened.
 */
function ram(rammer: string, target: string, targetFacing: number, speed: number, offset = 0, opts: { seconds?: number; model?: 'momentum' | 'immovable' } = {}) {
  const { game, vs } = world();
  if (opts.model) vs.crashModel = opts.model;
  const t = put(vs, target, 70.5, 40.5, targetFacing);
  const [, tcy] = centre(vs, t);
  const rb = vs.physRect(put(vs, rammer, 5.5, 90.5, 0));
  const r = put(vs, rammer, 70.5 - 22 - (rb.x1 - rb.x0), tcy - (rb.y0 + rb.y1) / 2 + offset, 0);
  drive(vs, r);
  vs.input = { throttle: 1, steer: 0, brake: false };
  r.velocity = speed / MPH_PER_MS;
  const torso0 = game.player.hp.torso.cur;
  const t0 = { x: t.x, y: t.y, f: t.facing };
  let hit = -1, before = 0, minAfter = Infinity;
  for (let i = 0; i < 200; i++) {
    const vb = mph(r);
    game.tick(1 / 30);
    if (hit < 0 && (t.x !== t0.x || t.y !== t0.y || t.facing !== t0.f || mph(r) < vb - 2)) {
      hit = i;
      before = vb;
    }
    if (hit >= 0) minAfter = Math.min(minAfter, mph(r));
    if (hit >= 0 && i - hit >= (opts.seconds ?? 0.5) * 30) break;
  }
  return {
    game, vs, r, t, hit, before, after: mph(r), minAfter,
    moved: Math.hypot(t.x - t0.x, t.y - t0.y), turned: Math.abs(((t.facing - t0.f + 540) % 360) - 180),
    torsoLost: torso0 - game.player.hp.torso.cur,
  };
}

describe('momentum crashes: the impulse', () => {
  const body = (m: number, cx: number, cy: number, pvx: number, pvy: number): ContactBody => ({ m, I: (m * (25 + 4)) / 12, cx, cy, pvx, pvy });
  it('conserves linear and angular momentum between two bodies, head-on and off-centre', () => {
    for (const [px, py] of [[0, 0], [0, 1.2]]) {
      const a = body(18000, -3, 0, 13, 0), b = body(1800, 3, 0, 0, 0);
      const r = contactImpulse(a, b, px, py, -1, 0, 0.25, 0.3);
      expect(r.jx).toBeLessThan(0);
      // linear: the impulse is equal and opposite by construction; check the velocity changes
      const dva = r.jx / a.m, dvb = -r.jx / b.m;
      expect(a.m * dva + b.m * dvb).toBeCloseTo(0, 6);
      // the light one gets ~10x the heavy one's velocity change
      expect(Math.abs(dvb) / Math.abs(dva)).toBeCloseTo(10, 5);
      // angular about the origin: r x J on each side sums to zero (same contact point)
      const La = (px - a.cx) * r.jy - (py - a.cy) * r.jx + (a.cx * r.jy - a.cy * r.jx);
      const Lb = -((px - b.cx) * r.jy - (py - b.cy) * r.jx) - (b.cx * r.jy - b.cy * r.jx);
      expect(La + Lb).toBeCloseTo(0, 6);
    }
  });
  it('separating bodies get no impulse; restitution sets the bounce', () => {
    expect(contactImpulse(body(1000, -3, 0, -1, 0), body(1000, 3, 0, 0, 0), 0, 0, -1, 0, 0.25, 0.3).jx).toBe(0);
    // equal masses head-on (centred): velocities after are v(1 -+ e)/2
    const r = contactImpulse(body(1000, -3, 0, 10, 0), body(1000, 3, 0, 0, 0), 0, 0, -1, 0, 0.25, 0.3);
    expect(10 + r.jx / 1000).toBeCloseTo(3.75, 6);
    expect(-r.jx / 1000).toBeCloseTo(6.25, 6);
  });
});

describe('momentum crashes in the world', () => {
  it('a rolling car into a parked one: total momentum is conserved within 5% across the hit', () => {
    const { game, vs } = world();
    const parked = put(vs, 'car', 50.5, 30.5, 90);
    const [, py] = centre(vs, parked);
    const b = vs.physRect(parked);
    const car = put(vs, 'car', 30.5, py - (b.y0 + b.y1) / 2, 0);
    car.velocity = 9;
    let checked = false;
    for (let i = 0; i < 600 && !checked; i++) {
      const p0 = momentum(vs, [car, parked]);
      const moved0 = parked.x;
      game.tick(1 / 120);
      if (parked.x !== moved0) {
        const p1 = momentum(vs, [car, parked]);
        expect(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / Math.hypot(p0[0], p0[1])).toBeLessThan(0.05);
        // and it went somewhere: the parked car now carries most of it
        expect(parked.mass() * Math.hypot(...vs.planarVelocity(parked))).toBeGreaterThan(0.4 * Math.hypot(p0[0], p0[1]));
        checked = true;
      }
    }
    expect(checked).toBe(true);
  });

  it('an Abrams at 30 mph into a parked ambulance, head-on and at an angle: keeps going, shoves and spins it, the driver is fine', () => {
    for (const [facing, offset] of [[90, 0], [45, 1.5], [0, 3.3]] as const) {
      const res = ram('tank_m1_abrams', 'ambulance', facing, 30, offset);
      const label = `ambulance at ${facing} deg, offset ${offset}`;
      expect(res.hit, label).toBeGreaterThan(0);
      expect(res.minAfter, label).toBeGreaterThan(res.before * 0.75);
      expect(res.moved, label).toBeGreaterThan(2);
      if (facing !== 90) expect(res.turned, label).toBeGreaterThan(10);
      expect(res.torsoLost, label).toBeLessThan(10);
      expect(res.game.player.dead, label).toBe(false);
      // nothing on the tank is wrecked by an ambulance
      expect(res.r.parts.filter((p) => p.hp === 0).length, label).toBe(0);
      // ...while the ambulance took real damage
      expect(res.t.parts.some((p) => p.hp < p.def.durability), label).toBe(true);
    }
  });

  it("the old 'immovable' model (Options > Vehicle crashes) still stops the tank dead against the ambulance", () => {
    const res = ram('tank_m1_abrams', 'ambulance', 90, 30, 0, { model: 'immovable' });
    expect(res.minAfter).toBeLessThan(3);
    expect(res.moved).toBe(0);
  });

  it('a car at 30 mph into a parked tank stops hard, the tank barely moves, and the driver feels it', () => {
    const res = ram('car', 'tank_m1_abrams', 90, 30);
    expect(res.minAfter).toBeLessThan(2);
    expect(res.before - res.minAfter).toBeGreaterThan(25);
    expect(res.moved).toBeLessThan(0.5);
    expect(res.torsoLost).toBeGreaterThan(0);
  });

  it('a car into a parked car: both move on, the parked one shoved and the mover slowed', () => {
    const res = ram('car', 'car', 90, 30);
    expect(res.moved).toBeGreaterThan(2);
    expect(res.minAfter).toBeLessThan(res.before * 0.6);
    expect(res.minAfter).toBeGreaterThan(0);
  });

  it("GTA's rear-quarter hit: a car clipping a parked car's tail at 30 mph spins it out past 90 deg, W held or not", () => {
    /** Rammer `side` m left of the target's centre line, both facing east; W held or let go after the hit. */
    const quarter = (side: number, holdW: boolean) => {
      const { game, vs } = world();
      const t = put(vs, 'car', 70.5, 40.5, 0);
      const [, tcy] = centre(vs, t);
      const r = put(vs, 'car', 30.5, 40.5, 0);
      r.y += tcy + side - centre(vs, r)[1];
      vs.reindex(r);
      drive(vs, r);
      vs.input = { throttle: 1, steer: 0, brake: false };
      r.velocity = 30 / MPH_PER_MS;
      const [x0, y0, f0] = [t.x, t.y, t.facing];
      let hit = -1, turned = 0, last = 0;
      for (let i = 0; i < 30 * 4; i++) {
        game.tick(1 / 30);
        if (hit < 0 && (t.x !== x0 || t.facing !== f0)) hit = i;
        if (hit >= 0 && !holdW) vs.input = { throttle: 0, steer: 0, brake: false };
        // accumulated, so a turn past 180 deg still counts
        const d = ((t.facing - last - f0 + 540) % 360) - 180;
        turned += d;
        last += d;
      }
      return { hit, turned: Math.abs(turned), moved: Math.hypot(t.x - x0, t.y - y0), player: game.player };
    };
    for (const side of [-1.2, -1.6, -2]) {
      const held = quarter(side, true), let_go = quarter(side, false);
      const label = `${side} m off`;
      expect(held.hit, label).toBeGreaterThan(0);
      expect(held.turned, `${label}, W held`).toBeGreaterThan(90);
      expect(let_go.turned, `${label}, W released`).toBeGreaterThan(90);
      // the rammer's nose catching the swinging tail no longer straightens it back up
      expect(held.turned, label).toBeGreaterThan(let_go.turned * 0.5);
      expect(held.moved, label).toBeGreaterThan(3);
      expect(held.player.dead, label).toBe(false);
    }
  });

  it('a square shunt does not spin anything out: the parked car is braked as before', () => {
    const res = ram('car', 'car', 0, 25, 0, { seconds: 2 });
    expect(res.turned).toBeLessThan(10);
    expect(motionOf(res.t).skid).toBe(0);
  });

  it('a moderate glancing hit is never lethal, even on your last HP', () => {
    for (const target of ['tank_m1_abrams', 'car']) {
      const { game, vs } = world();
      // the target's flank angles 15 deg across the car's lane: the car's front corner meets it
      const t = put(vs, target, 70.5, 40.5, 345);
      const o = rectObb(t, vs.physRect(t));
      const b = vs.physRect(put(vs, 'car', 5.5, 90.5, 0));
      const flankY = o.cy - o.hy / Math.cos((15 * Math.PI) / 180);
      const car = put(vs, 'car', o.cx - 25, flankY - (b.y1 - b.y0) / 2 + 0.6 - (b.y0 + b.y1) / 2, 0);
      drive(vs, car);
      game.player.hp.torso.cur = 3;
      vs.input = { throttle: 1, steer: 0, brake: false };
      car.velocity = 30 / MPH_PER_MS;
      let hit = false;
      const [tx0, ty0] = [t.x, t.y];
      for (let i = 0; i < 90; i++) {
        const v0 = car.velocity;
        game.tick(1 / 30);
        hit ||= car.velocity < v0 - 0.5 || t.x !== tx0 || t.y !== ty0;
      }
      expect(hit, target).toBe(true);
      expect(game.player.dead, target).toBe(false);
      expect(car.x, `${target}: slid along and carried on past it`).toBeGreaterThan(o.cx);
    }
  });

  it('shoved vehicles never overlap terrain or each other: a tank plows a car into a row of cars and a wall', () => {
    const { game, ms, vs } = world();
    for (let y = 20; y < 60; y++) game.map.setTer(95, y, 0, 't_test_wall');
    const shoved = put(vs, 'car', 60.5, 38.5, 90);
    const row = [put(vs, 'car', 80.5, 34.5, 0), put(vs, 'pickup', 80.5, 40.5, 0), put(vs, 'car', 87.5, 37.5, 0)];
    const zed = ms.spawnById('mon_zombie', 75.5, 44.5, 0)!;
    const zhp = zed.hp;
    const tank = put(vs, 'tank_m1_abrams', 35.5, 38.5 - 1, 0);
    drive(vs, tank);
    vs.input = { throttle: 1, steer: 0, brake: false };
    tank.velocity = 25 / MPH_PER_MS;
    const all = [tank, shoved, ...row];
    const boxes = (v: Vehicle) => rectObb(v, vs.physRect(v));
    const moved = new Set<Vehicle>();
    const start = new Map(all.map((v) => [v, [v.x, v.y, v.facing]]));
    for (let i = 0; i < 240; i++) {
      game.tick(1 / 30);
      for (let a = 0; a < all.length; a++) {
        const oa = boxes(all[a]);
        for (let b = a + 1; b < all.length; b++) expect(obbHitsObb(oa, boxes(all[b])), `tick ${i}: ${all[a].name} / ${all[b].name}`).toBe(false);
        for (let y = 20; y < 60; y++) expect(obbHitsTile(oa, 95, y), `tick ${i}: ${all[a].name} in the wall`).toBe(false);
      }
      for (const v of all) {
        const s = start.get(v)!;
        if (v.x !== s[0] || v.y !== s[1] || v.facing !== s[2]) moved.add(v);
      }
    }
    // the chain reached past the first car, and the zombie in the way was hit
    expect(moved.has(shoved)).toBe(true);
    expect(row.some((v) => moved.has(v))).toBe(true);
    expect(zed.dead || zed.hp < zhp || Math.hypot(zed.x - 75.5, zed.y - 44.5) > 0.5).toBe(true);
    // and everything has come to rest (or been held by the tank) without any slide left over
    for (const v of [shoved, ...row]) expect(Math.hypot(motionOf(v).sx, motionOf(v).sy), v.name).toBeLessThan(20);
  });
});

describe('heavy handling', () => {
  const zeroTo = (proto: string, target: number, mode: 'weighty' | 'light' = 'weighty') => {
    const { game, vs } = world();
    vs.handlingMode = mode;
    const v = put(vs, proto, 30.5, 30.5, 0);
    drive(vs, v);
    vs.input = { throttle: 1, steer: 0, brake: false };
    let t = 0;
    while (t < 30 && mph(v) < target) {
      game.tick(1 / 30);
      t += 1 / 30;
    }
    let top = 0;
    for (let i = 0; i < 30 * 30; i++) {
      game.tick(1 / 30);
      top = Math.max(top, mph(v));
    }
    return { t, top };
  };
  /** Degrees turned pivoting from a standstill (D held) after each of `marks` seconds. */
  const pivot = (proto: string, marks: number[], mode: 'weighty' | 'light' = 'weighty') => {
    const { game, vs } = world();
    vs.handlingMode = mode;
    const v = put(vs, proto, 30.5, 30.5, 0);
    drive(vs, v);
    vs.input = { throttle: 0, steer: 1, brake: false };
    const out: number[] = [];
    let t = 0;
    for (const m of marks) {
      while (t < m - 1e-9) {
        game.tick(1 / 30);
        t += 1 / 30;
      }
      out.push(((v.facing + 540) % 360) - 180);
    }
    return out;
  };

  it("an Abrams takes over twice a car's time to reach 20 mph and is governed to ~45 mph; the old handling is kept", () => {
    const car = zeroTo('car', 20), tank = zeroTo('tank_m1_abrams', 20), light = zeroTo('tank_m1_abrams', 20, 'light');
    expect(tank.t).toBeGreaterThan(car.t * 2);
    expect(tank.t).toBeLessThan(9);
    expect(tank.top).toBeGreaterThan(40);
    expect(tank.top).toBeLessThan(47);
    expect(light.t).toBeLessThan(tank.t * 0.7);
    expect(light.top).toBeGreaterThan(60);
    // cars keep their feel: the car's figures are the same in both modes
    expect(zeroTo('car', 20, 'light').t).toBeCloseTo(car.t, 5);
  });

  it('tracked vehicles scale with mass and power: an APC is quicker than the Abrams off the line but governed lower', () => {
    const apc = handlingFor(6600, 147000, true, 'weighty'), tank = handlingFor(18150, 1004000, true, 'weighty');
    expect(apc.heft).toBeLessThan(tank.heft);
    expect(apc.topSpeed).toBeLessThan(tank.topSpeed);
    expect(apc.pivotSpool).toBeLessThan(tank.pivotSpool);
    // a semi (wheeled, 7 t) is only a little heavier-feeling than a car, and never governed
    const semi = handlingFor(7050, 240000, false, 'weighty');
    expect(semi.heft).toBeLessThan(0.3);
    expect(semi.topSpeed).toBe(Infinity);
  });

  it("the Abrams' pivot spools up: slow for the first half second, then ~30 deg/s; a light tracked tractor snaps round", () => {
    const [t05, t15, t25] = pivot('tank_m1_abrams', [0.5, 1.5, 2.5]);
    const [l05] = pivot('tank_m1_abrams', [0.5], 'light');
    const [r05] = pivot('tractor_heavy_plow', [0.5]);
    expect(t05).toBeLessThan(l05 * 0.5);
    expect(t05).toBeLessThan(r05 * 0.5);
    expect((t25 - t15) / 1).toBeGreaterThan(25);
    expect((t25 - t15) / 1).toBeLessThan(40);
  });
});
