// Gibbed bodies come apart (src/game/gibs.ts, src/render/chars/gibs.ts): BN still decides the
// gib (no corpse), the simulation plans a flight per piece along the blow, the renderer cuts the
// creature's own rig into those pieces, flies them to rest and keeps to its budget.
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import { MonsterSystem } from '../src/game/monai';
import type { Monster } from '../src/game/monster';
import { has } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { monsterCreatureHooks, VehicleSystem } from '../src/game/vehicles';
import { flingEnd, launchFromImpact } from '../src/game/runoverFling';
import { GIB_GORE_SLOTS, planGibs, type GibBurst, type GibGore } from '../src/game/gibs';
import { gibbedBody } from '../src/game/mondeath';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { loadNodeData } from '../tools/lib/node_data';
import { bodyShapeOf } from '../src/render/chars/archetype';
import { makeRig, type Rig } from '../src/render/chars/rig';
import { CharLayer, type CharInstance, type Skin } from '../src/render/chars/charLayer';
import { RAGDOLL } from '../src/render/chars/ragdoll';
import { GibBody, GibSet, GIB_VIEW, gibPieces } from '../src/render/chars/gibs';
import type { ZStyle } from '../src/render/chars/zombie';
import monsters from '../public/data/monsters.json';

const kmh = (k: number) => k / 3.6;

// --- planning (pure) ---------------------------------------------------------------------

describe('planning the pieces', () => {
  const open = { blocked: () => false };
  const vehicle = (k: number, gore: GibGore = 'lots', seed = 3) =>
    planGibs({ x: 10.5, y: 10.5, z: 0, facing: Math.PI / 2, size: 'medium', launch: launchFromImpact({ x: 10.5, y: 10.5, vx: kmh(k), vy: 0, offset: 0.2, mass: 80, seed: 0.4 }) }, gore, open, new Rng(seed));
  it('a vehicle throws every piece ahead along its path, spread out, high over the roof at speed, and they all come to rest on the ground', () => {
    for (const k of [70, 100]) {
      const b = vehicle(k);
      expect(b.pieces.map((p) => p.slot)).toEqual([...GIB_GORE_SLOTS.lots]);
      expect(b.cause).toBe('vehicle');
      for (const p of b.pieces) {
        expect(p.plan.launch.vx).toBeGreaterThan(kmh(k) * 0.4);
        expect(p.plan.hs[p.plan.hs.length - 1]).toBe(0);
        expect(p.plan.hs.every((h) => h >= 0)).toBe(true);
        expect(flingEnd(p.plan)[0]).toBeGreaterThan(14);
      }
      // the head leaves from head height, the legs from the ground
      expect(b.pieces[1].plan.hs[0]).toBeGreaterThan(1.3);
      expect(b.pieces[4].plan.hs[0]).toBeLessThan(0.3);
      // spread: not one heap
      const ends = b.pieces.map((p) => flingEnd(p.plan));
      const xs = ends.map((e) => e[0]), ys = ends.map((e) => e[1]);
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(2);
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.8);
      // over a car's roof-line
      expect(Math.max(...b.pieces.map((p) => Math.max(...p.plan.hs)))).toBeGreaterThan(1.5);
    }
    // faster flies further
    const far = (b: GibBurst) => Math.max(...b.pieces.map((p) => flingEnd(p.plan)[0]));
    expect(far(vehicle(100))).toBeGreaterThan(far(vehicle(70)));
  });
  it('the gore level sets the number of pieces; a blow scatters them away from whoever struck', () => {
    expect(vehicle(70, 'some').pieces).toHaveLength(4);
    expect(vehicle(70, 'max').pieces).toHaveLength(10);
    const b = planGibs({ x: 10.5, y: 10.5, z: 0, facing: 0, size: 'medium', dir: [0, -1], overkill: 3 }, 'lots', open, new Rng(9));
    expect(b.cause).toBe('blow');
    for (const p of b.pieces) {
      expect(p.plan.launch.vy).toBeLessThan(0);
      expect(flingEnd(p.plan)[1]).toBeLessThan(10.5);
    }
  });
  it('is deterministic and keeps out of walls', () => {
    expect(JSON.stringify(vehicle(90))).toBe(JSON.stringify(vehicle(90)));
    const walled = planGibs({ x: 10.5, y: 10.5, z: 0, facing: 0, size: 'medium', launch: launchFromImpact({ x: 10.5, y: 10.5, vx: kmh(100), vy: 0, offset: 0, mass: 80, seed: 0.4 }) }, 'max', { blocked: (tx) => tx >= 15 }, new Rng(2));
    for (const p of walled.pieces) for (const x of p.plan.xs) expect(x).toBeLessThan(15);
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
  for (let y = -1; y <= 2; y++) for (let x = -1; x <= 4; x++) game.map.chunk(x, y, 0);
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
  const bursts: GibBurst[] = [];
  ms.onGibbed.push((_m, b) => bursts.push(b));
  return { game, ms, vs, car, bursts };
}

/** Run a car east at `k` km/h into a stunned plain zombie 8 tiles ahead; return it once hit. */
function runOver(k: number, opts: { gibs?: 'pieces' | 'splat'; gore?: GibGore } = {}) {
  const w = world();
  if (opts.gibs) w.ms.gibMode = opts.gibs;
  if (opts.gore) w.ms.gibGore = opts.gore;
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

const corpsesOf = (ms: MonsterSystem, z: Monster) => ms.corpses.filter((c) => c.monId === z.type.id);
const groundCorpses = (game: Game) => {
  let n = 0;
  for (let y = 0; y < 40; y++) for (let x = 0; x < 90; x++) n += game.map.itemsAt(x, y, 0).filter((it) => it.typeId === 'corpse').length;
  return n;
};

describe('a vehicle gibs a zombie', () => {
  it('BN still gibs it (no corpse); its pieces fly on along the road and leave blood where they land', () => {
    const { game, ms, z, bursts, car } = runOver(130);
    expect(z.dead).toBe(true);
    expect(gibbedBody(z)).toBe(true);
    expect(corpsesOf(ms, z)).toHaveLength(0);
    expect(groundCorpses(game)).toBe(0);
    expect(bursts).toHaveLength(1);
    const b = bursts[0];
    expect(b.cause).toBe('vehicle');
    expect(b.pieces).toHaveLength(6);
    for (const p of b.pieces) {
      expect(p.plan.launch.vx).toBeGreaterThan(5);
      expect(flingEnd(p.plan)[0]).toBeGreaterThan(z.x);
    }
    // the blood comes down with the pieces, not before
    const blood = () => {
      let n = 0;
      for (const p of b.pieces) {
        const [ex, ey] = flingEnd(p.plan);
        if (game.map.fieldsAt(Math.floor(ex), Math.floor(ey), 0).some((f) => f.type === 'fd_blood')) n++;
      }
      return n;
    };
    const before = blood();
    car.velocity = 0;
    for (let i = 0; i < 6 * 30; i++) {
      car.velocity = 0;
      game.tick(1 / 30);
    }
    expect(blood()).toBeGreaterThan(before);
  });
  it("'splat' is the old look: no pieces, no corpse", () => {
    const { ms, z, bursts } = runOver(130, { gibs: 'splat' });
    expect(z.dead).toBe(true);
    expect(corpsesOf(ms, z)).toHaveLength(0);
    expect(bursts).toHaveLength(0);
  });
  it('the gore level picks how many pieces', () => {
    expect(runOver(130, { gore: 'max' }).bursts[0].pieces).toHaveLength(10);
  });
  it('a body that is only killed (not gibbed) keeps its corpse and comes apart into nothing', () => {
    const { ms, z, bursts } = runOver(45);
    if (!z.dead) return; // survived at this speed: nothing to check
    expect(corpsesOf(ms, z)).toHaveLength(1);
    expect(bursts).toHaveLength(0);
  });
});

describe('an overkill blow gibs too', () => {
  it('the pieces scatter away from the survivor', () => {
    const { game, ms, bursts } = world();
    const z = ms.spawnById('mon_zombie', 5.5, 35.5, 0)!;
    ms.hurt(z, z.hpMax * 5, 'player');
    expect(z.dead).toBe(true);
    expect(corpsesOf(ms, z)).toHaveLength(0);
    expect(bursts).toHaveLength(1);
    expect(bursts[0].cause).toBe('blow');
    // the survivor is south (y 40.5): pieces go north
    for (const p of bursts[0].pieces) expect(flingEnd(p.plan)[1]).toBeLessThan(game.player.y);
  });
});

// --- drawing ----------------------------------------------------------------------------

type Mon = { id: string; bodytype?: string; species?: string[]; flags?: string[]; symbol?: string; volume?: number; name?: string };
const MON = monsters as unknown as Record<string, Mon>;
const rigOf = (id: string, zstyle: ZStyle = 'shamble') => makeRig(bodyShapeOf(MON[id]), { zstyle, variant: 1 });
const skinFor = (rig: Rig): Skin => ({ page: 0, rects: new Int32Array(rig.parts.length * 5), refs: 0 });
const CUBE = [...Array(8)].map((_, k) => new THREE.Vector3(k & 1 ? 0.5 : -0.5, k & 2 ? 0.5 : -0.5, k & 4 ? 0.5 : -0.5));
function lowest(inst: CharInstance): number {
  const m = new THREE.Matrix4(), v = new THREE.Vector3();
  let lo = Infinity;
  for (let i = 0; i < inst.rig.parts.length; i++) {
    if (inst.hidden?.[i]) continue;
    m.fromArray(inst.mats, i * 16);
    if (Math.abs(m.determinant()) < 1e-12) continue;
    for (const c of CUBE) lo = Math.min(lo, v.copy(c).applyMatrix4(m).y);
  }
  return lo;
}

describe('cutting a rig into pieces', () => {
  const cases: [string, ZStyle][] = [['mon_zombie', 'shamble'], ['mon_zombie', 'caricature'], ['mon_zombie', 'boxy'], ['mon_zombie_soldier', 'shamble'], ['mon_zombie_child', 'shamble'], ['mon_zombie_hulk', 'shamble'], ['mon_zombie_dog', 'shamble'], ['mon_dog', 'shamble']];
  for (const [id, zs] of cases)
    it(`${id} (${zs}): every part goes with exactly one piece; a humanoid loses its head and all four limbs`, () => {
      const rig = rigOf(id, zs);
      for (const gore of ['some', 'lots', 'max'] as GibGore[]) {
        const cut = gibPieces(rig, GIB_GORE_SLOTS[gore]);
        const shown = new Uint8Array(rig.parts.length);
        for (const { hidden } of cut.values()) for (let i = 0; i < hidden.length; i++) shown[i] += hidden[i] ? 0 : 1;
        expect([...shown].every((n) => n === 1)).toBe(true);
        expect(cut.has('torso')).toBe(true);
        expect(cut.has('head')).toBe(true);
        if (rig.dims) expect(cut.size).toBe(GIB_GORE_SLOTS[gore].length);
        else if (gore === 'lots') expect(cut.size).toBeGreaterThanOrEqual(4);
      }
    });
});

describe('a piece in flight', () => {
  const burst = planGibs({ x: 10.5, y: 10.5, z: 0, facing: Math.PI / 2, size: 'medium', launch: launchFromImpact({ x: 10.5, y: 10.5, vx: kmh(90), vy: 0, offset: 0.1, mass: 80, seed: 0.4 }) }, 'lots', { blocked: () => false }, new Rng(5));
  for (const zs of ['shamble', 'caricature', 'boxy'] as ZStyle[])
    it(`(${zs}) tumbles, never sinks into the floor, settles at the end of its flight and stays put`, () => {
      const rig = rigOf('mon_zombie', zs);
      const layer = new CharLayer(false);
      const cut = gibPieces(rig, burst.pieces.map((p) => p.slot));
      for (const [i, p] of burst.pieces.entries()) {
        const sel = cut.get(p.slot)!;
        const g = new GibBody(layer, rig, skinFor(rig), 0.1 + i * 0.13, p.plan, 0, burst.facing, sel.hidden, sel.root, RAGDOLL.loose);
        const q0 = g.inst.tumble!.clone();
        let low = Infinity, spun = 0, steps = 0;
        while (!g.done && steps < 300) {
          g.update(1 / 30);
          g.inst.build(null);
          low = Math.min(low, lowest(g.inst));
          spun = Math.max(spun, 2 * Math.acos(Math.min(1, Math.abs(g.inst.tumble!.dot(q0)))));
          for (const x of g.inst.mats) if (!Number.isFinite(x)) throw new Error('non-finite matrix');
          steps++;
        }
        expect(g.done).toBe(true);
        expect(spun).toBeGreaterThan(1);
        // a flailing joint may dip a few cm, never through the road
        expect(low).toBeGreaterThan(-0.08);
        const [ex, ey] = flingEnd(p.plan);
        expect(Math.hypot(g.inst.x - ex, g.inst.y - ey)).toBeLessThan(1e-6);
        expect(lowest(g.inst)).toBeLessThan(0.06);
        // lying still: no more rebuilds
        g.inst.dirty = false;
        g.update(1 / 30);
        expect(g.inst.dirty).toBe(false);
      }
    });
});

describe('the budget', () => {
  it('lies for a while, then sinks away; past the cap the oldest go first; gone when the area is left', () => {
    const rig = rigOf('mon_zombie');
    const layer = new CharLayer(false);
    const b = planGibs({ x: 10.5, y: 10.5, z: 0, facing: 0, size: 'medium', dir: [1, 0], overkill: 2 }, 'lots', { blocked: () => false }, new Rng(4));
    const cut = gibPieces(rig, b.pieces.map((p) => p.slot));
    const set = new GibSet();
    const make = () => {
      for (const p of b.pieces) {
        const sel = cut.get(p.slot)!;
        set.add(new GibBody(layer, rig, skinFor(rig), 0.3, p.plan, 0, 0, sel.hidden, sel.root, RAGDOLL.loose));
      }
    };
    const near = () => true;
    const tick = (s: number) => {
      for (let t = 0; t < s; t += 1 / 10) set.update(1 / 10, near, () => {});
    };
    make();
    tick(6);
    expect(set.live).toBe(6);
    expect(set.pieces.every((g) => g.done)).toBe(true);
    // over the cap: the extra bodies' worth of the oldest sink, quickly
    const bodies = Math.ceil(GIB_VIEW.cap / 6) + 2;
    for (let i = 0; i < bodies; i++) make();
    tick(6);
    expect(set.live).toBeLessThanOrEqual(GIB_VIEW.cap);
    expect(layer.count).toBeLessThanOrEqual(GIB_VIEW.cap);
    // they lie a good while, then sink away (not popped)
    const lying = set.live;
    tick(GIB_VIEW.life - 8);
    expect(set.live).toBe(lying);
    tick(4);
    expect(set.pieces.some((g) => g.sinkT !== null && !g.gone && g.inst.fade > 0)).toBe(true);
    tick(GIB_VIEW.sink + 3);
    expect(set.pieces).toHaveLength(0);
    expect(layer.count).toBe(0);
    // leaving the area drops them at once
    make();
    set.update(1 / 10, () => false, () => {});
    expect(set.pieces).toHaveLength(0);
    expect(layer.count).toBe(0);
  });
});
