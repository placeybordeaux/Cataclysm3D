// Run-over flights (src/game/runoverFling.ts): launch from the impact, the flight through the
// map, and the simulation (monai + vehicles) keeping the body where the flight says it is.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import { MonsterSystem } from '../src/game/monai';
import { has } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { monsterCreatureHooks, VehicleSystem } from '../src/game/vehicles';
import { flingEnd, launchFromImpact, planFling, RUNOVER, sampleFling, type FlingWorld, type RunoverImpact } from '../src/game/runoverFling';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { loadNodeData } from '../tools/lib/node_data';

const kmh = (k: number) => k / 3.6;
const imp = (o: Partial<RunoverImpact> = {}): RunoverImpact => ({ x: 5.5, y: 5.5, vx: kmh(40), vy: 0, offset: 0, mass: 80, seed: 0.3, ...o });
const open: FlingWorld = { blocked: () => false };

describe('launch from the impact', () => {
  it('goes along the vehicle, faster hits fly higher and spin harder', () => {
    const slow = launchFromImpact(imp({ vx: kmh(20) })), fast = launchFromImpact(imp({ vx: kmh(70) }));
    for (const l of [slow, fast]) {
      expect(l.vx).toBeGreaterThan(0);
      expect(Math.abs(l.vy)).toBeLessThan(l.vx * 0.1);
    }
    expect(fast.vz).toBeGreaterThan(slow.vz);
    expect(fast.pitch).toBeGreaterThan(slow.pitch);
    // a slow bump shoves it ahead of the bumper; at speed the car runs under it
    expect(slow.vx).toBeGreaterThan(kmh(20));
    expect(fast.vx).toBeLessThan(kmh(70));
  });
  it('an off-centre hit throws it to that side and spins it; a heavy body flies less', () => {
    // heading east: the vehicle's right is south (+y)
    const right = launchFromImpact(imp({ offset: 0.9 })), left = launchFromImpact(imp({ offset: -0.9 }));
    expect(right.vy).toBeGreaterThan(0.5);
    expect(left.vy).toBeLessThan(-0.5);
    expect(Math.sign(right.yaw)).toBe(-Math.sign(left.yaw));
    const hulk = launchFromImpact(imp({ mass: 800 }));
    expect(hulk.vz).toBeLessThan(launchFromImpact(imp()).vz * 0.5);
  });
  it('refuses a stationary vehicle', () => {
    expect(() => launchFromImpact(imp({ vx: 0 }))).toThrow();
  });
});

describe('the flight', () => {
  const fly = (k: number, w: FlingWorld = open) => planFling(5.5, 5.5, launchFromImpact(imp({ vx: kmh(k) })), w)!;
  it('arcs, touches down, bounces at speed and skids to rest; further when faster', () => {
    const d = (p: ReturnType<typeof fly>) => flingEnd(p)[0] - 5.5;
    const [a, b, c] = [fly(20), fly(40), fly(70)];
    expect(d(a)).toBeGreaterThan(1.5);
    expect(d(b)).toBeGreaterThan(d(a));
    expect(d(c)).toBeGreaterThan(d(b));
    expect(d(c)).toBeLessThan(40);
    for (const p of [a, b, c]) {
      expect(p.hs.every((h) => h >= 0)).toBe(true);
      expect(p.hs[p.hs.length - 1]).toBe(0);
      expect(p.duration).toBeLessThan(RUNOVER.maxTime);
      expect(p.landT).toBeGreaterThan(0);
      expect(p.contacts.some((q) => q.kind === 'ground')).toBe(true);
    }
    expect(c.contacts.filter((q) => q.kind === 'ground').length).toBeGreaterThan(1);
    // at 70 km/h the arc clears a car's roof-line midway
    expect(Math.max(...c.hs)).toBeGreaterThan(1.0);
  });
  it('bounces off a wall instead of passing through it', () => {
    // a wall along x = 9
    const w: FlingWorld = { blocked: (tx) => tx === 9 };
    const p = fly(70, w);
    for (const x of p.xs) expect(x + RUNOVER.radius).toBeLessThanOrEqual(9 + 1e-6);
    expect(p.contacts.some((q) => q.kind === 'wall')).toBe(true);
    expect(flingEnd(p)[0]).toBeLessThan(9);
  });
  it('stays under a roof', () => {
    const p = fly(70, { blocked: () => false, roofed: () => true });
    expect(Math.max(...p.hs)).toBeLessThanOrEqual(RUNOVER.ceiling + 1e-6);
  });
  it('comes to rest on a free tile: slides over to one, or gives up (pinned)', () => {
    const p0 = fly(40);
    const [ex, ey] = flingEnd(p0);
    const bad = Math.floor(ex);
    const p = fly(40, { blocked: () => false, free: (tx) => tx !== bad });
    const [fx] = flingEnd(p);
    expect(Math.floor(fx)).not.toBe(bad);
    expect(Math.abs(fx - ex)).toBeLessThan(RUNOVER.endSearch + 1);
    expect(fly(40, { blocked: () => false, free: () => false }) ?? null).toBeNull();
    expect(ey).toBeCloseTo(5.5, 0);
  });
  it('sampling is continuous and clamps at both ends', () => {
    const p = fly(40);
    expect(sampleFling(p, -1)).toEqual({ x: p.xs[0], y: p.ys[0], h: 0 });
    const end = sampleFling(p, p.duration + 5);
    expect([end.x, end.y]).toEqual(flingEnd(p));
    let last = sampleFling(p, 0);
    for (let t = 0; t < p.duration; t += 0.01) {
      const s = sampleFling(p, t);
      expect(Math.hypot(s.x - last.x, s.y - last.y)).toBeLessThan(0.5);
      last = s;
    }
  });
});

// --- in the simulation ------------------------------------------------------------------

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
  game.vehicles = vs;
  vs.creatureHooks = monsterCreatureHooks(ms);
  game.systems.push(ms, vs);
  game.clock.seconds = 12 * 3600;
  const car = vs.spawn('car', 10, 10, 0, 0, { fuel: 100, status: 2, rng: new Rng(7) })!;
  for (const p of car.parts) if (has(p, 'OPENABLE')) p.open = false;
  car.locked = false;
  game.player.x = 5.5;
  game.player.y = 40.5;
  return { game, ms, vs, car };
}

/** Run a car east at `k` km/h into a stunned zombie 8 tiles ahead; return it once hit. */
function runOver(k: number, mode: 'ragdoll' | 'fall' = 'ragdoll') {
  const w = world();
  w.vs.runoverMode = mode;
  const z = w.ms.spawnById('mon_zombie', 18.5, 10.5, 0)!;
  z.addEffect('stunned', 60);
  let hit = false;
  for (let i = 0; i < 90 && !hit; i++) {
    w.car.velocity = kmh(k);
    w.game.tick(1 / 30);
    hit = z.dead || z.hp < z.hpMax;
  }
  expect(hit).toBe(true);
  return { ...w, z };
}

describe('run-overs in the simulation', () => {
  it('a survivor flies along its plan, lands where the plan ends, lies downed, then gets up', () => {
    const { game, ms, z, car } = runOver(20);
    expect(z.dead).toBe(false);
    expect(z.fling && z.fling.t >= 0).toBe(true);
    const plan = z.fling!.plan;
    const [ex, ey] = flingEnd(plan);
    // keep the car out of the way so it doesn't hit the body again
    car.velocity = 0;
    let t = 0;
    while (z.fling && t < 5) {
      game.tick(1 / 30);
      t += 1 / 30;
      car.velocity = 0;
      if (z.fling) {
        const s = sampleFling(plan, z.fling.t);
        expect(Math.hypot(z.x - s.x, z.y - s.y)).toBeLessThan(1e-6);
      }
    }
    expect(z.fling).toBeNull();
    expect(Math.hypot(z.x - ex, z.y - ey)).toBeLessThan(0.05);
    expect(z.hasEffect('downed')).toBe(true);
    for (let i = 0; i < 60; i++) game.tick(1 / 30);
    expect(z.hasEffect('downed')).toBe(false);
    expect(ms.monsterAt(z.tileX, z.tileY, 0)).toBe(z);
  });
  it('a body killed by the hit comes to rest (as a corpse) at the end of its flight', () => {
    const { ms, z } = runOver(70);
    expect(z.dead).toBe(true);
    const rec = ms.corpses.find((c) => c.monId === z.type.id)!;
    expect(rec).toBeTruthy();
    expect(rec.fling).toBeTruthy();
    const [ex, ey] = flingEnd(rec.fling!);
    expect([rec.x, rec.y]).toEqual([ex, ey]);
    // well down the road from the hit, inside the item's tile
    expect(ex - 18.5).toBeGreaterThan(6);
    expect(ms.corpseValid(rec)).toBe(true);
  });
  it("'fall' keeps BN's teleport fling and the corpse where it died", () => {
    const { ms, z } = runOver(70, 'fall');
    expect(z.fling).toBeNull();
    const rec = ms.corpses.find((c) => c.monId === z.type.id)!;
    expect(rec.fling).toBeUndefined();
    expect(Math.abs(rec.x - z.x)).toBeLessThan(1e-9);
  });
});
