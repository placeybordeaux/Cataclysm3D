import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadNodeData } from '../tools/lib/node_data';
import { Game } from '../src/game/game';
import { Vehicle } from '../src/game/vehicle';
import { VehicleSystem } from '../src/game/vehicles';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { cantContinue, continueCraft, craftState, findRecipe, startCraft } from '../src/game/crafting';
import { createItem } from '../src/game/item';
import { L, spawnItem } from '../src/game/moves';
import { benchSpeed, benchTooSlow, craftBench, findBestBench, lerpedMultiplier } from '../src/game/workbench';

let data: ReturnType<typeof loadNodeData>['game'], vd: VehicleDataFile;
beforeAll(() => { data = loadNodeData().game; vd = JSON.parse(readFileSync('public/data/vehicles.json', 'utf8')); });

function setup(benchPart: string | null = 'workbench') {
  const game = new Game(data, 1, { held: new Set(), captured: false, onPress() {}, consumeMouse: () => [0, 0] } as any);
  game.vehicles = new VehicleSystem(game, vd);
  const v = new Vehicle(vd, 'car'); v.x = game.player.x; v.y = game.player.y; v.z = game.player.z; v.locked = false;
  const part = benchPart ? v.addPart(vd.parts[benchPart], 0, 0) : null;
  game.vehicles.add(v);
  const p = game.player;
  // Daylight-independent: these tests compare bench speeds, not lighting.
  (game.map as any).lightAt = () => 10;
  return { game, v, part, p, tx: Math.floor(p.x), ty: Math.floor(p.y) };
}

const small = { mass: 100, volume: 250 };

describe('BN workbench data and multipliers', () => {
  it('extracts vehicle WORKBENCH data in grams and millilitres from veh_type.cpp load_workbench', () => {
    expect(vd.parts.workbench.workbench).toEqual({ multiplier: 1.2, mass: 300000, volume: 30000 });
    expect(vd.parts.survivors_workbench.workbench).toEqual({ multiplier: 1.5, mass: 300000, volume: 30000 });
    expect(vd.parts.robobench.workbench).toEqual({ multiplier: 1.8, mass: 300000, volume: 30000 });
    expect(vd.parts.veh_table.workbench).toEqual({ multiplier: 1.1, mass: 150000, volume: 20000 });
    for (const p of Object.values(vd.parts)) if (p.flags.includes('WORKBENCH')) expect(p.workbench).toBeDefined();
  });
  it('lerps the slowdown to 25% at 1000 kg / 1000 L like activity_speed_adapters.cpp', () => {
    expect(lerpedMultiplier(299_999, 300_000, 1_000_000)).toBe(1);
    expect(lerpedMultiplier(650_000, 300_000, 1_000_000)).toBeCloseTo(0.625, 10);
    expect(lerpedMultiplier(1_000_001, 300_000, 1_000_000)).toBe(0.25);
    // 400 kg on a vehicle workbench: 1.2 × (1 − 100 kg × 0.75 / 700 kg)
    expect(benchSpeed({ mass: 400_000, volume: 1000 }, vd.parts.workbench.workbench!)).toBeCloseTo(1.2 * (1 - 0.75 / 7), 10);
    expect(benchTooSlow(0.1, 1)).toBe(true);
    expect(benchTooSlow(0.3, 0.19)).toBe(true);
    expect(benchTooSlow(0.3, 0.5)).toBe(false);
  });
});

describe('find_best_bench', () => {
  it('holds small crafts in hands and puts unliftable ones on the ground (regression without benches)', () => {
    const { game, v } = setup(null);
    game.vehicles!.remove(v);
    expect(findBestBench(game, small, true)).toMatchObject({ type: 'hands', multiplier: 1 });
    expect(findBestBench(game, small, false)).toMatchObject({ type: 'ground', multiplier: 0.7 });
  });
  it('uses a furniture workbench in reach (regression for the furniture path)', () => {
    const { game, v, tx, ty, p } = setup(null);
    game.vehicles!.remove(v);
    game.map.setFurn(tx + 2, ty, p.z, 'f_workbench');
    expect(findBestBench(game, small, true)).toMatchObject({ type: 'furniture', multiplier: 1.2, x: tx + 2 });
    game.map.setFurn(tx + 2, ty, p.z, 'f_null');
    game.map.setFurn(tx + 3, ty, p.z, 'f_workbench');
    expect(findBestBench(game, small, true).type).toBe('hands');
  });
  it('uses an intact parked vehicle workbench within reach and prefers the better bench', () => {
    const { game, v, part, tx, ty, p } = setup('workbench');
    expect(findBestBench(game, small, true)).toMatchObject({ type: 'vehicle', multiplier: 1.2, part });
    game.map.setFurn(tx + 1, ty, p.z, 'f_workbench');
    // You stand on the bench's mount: best_bench_here already found 1.2, and an equal raw
    // multiplier in reach doesn't replace it (BN's strict ">").
    expect(game.vehicles!.occupantAt(p.x, p.y, p.z)?.v).toBe(v);
    expect(findBestBench(game, small, true).type).toBe('vehicle');
    const robo = v.addPart(vd.parts.robobench, 1, 0);
    expect(findBestBench(game, small, true)).toMatchObject({ type: 'vehicle', multiplier: 1.8, part: robo });
  });
  it('drops broken, locked, distant, moving or removed vehicle benches, but keeps them from the driver seat', () => {
    const { game, v, part, p } = setup('workbench');
    part!.hp = 0; expect(findBestBench(game, small, true).type).toBe('hands');
    part!.hp = 100; v.locked = true; expect(findBestBench(game, small, true).type).toBe('hands');
    v.locked = false; p.x += 3; expect(findBestBench(game, small, true).type).toBe('hands');
    v.velocity = 5; expect(findBestBench(game, small, true).type).toBe('hands');
    game.vehicles!.driving = v;
    expect(findBestBench(game, small, true)).toMatchObject({ type: 'vehicle', part });
    game.vehicles!.driving = null; v.velocity = 0; p.x -= 3;
    game.vehicles!.remove(v); expect(findBestBench(game, small, true).type).toBe('hands');
  });
  it('lets a heavy craft that a raw multiplier favours slow down on the smaller bench, as BN does', () => {
    const { game } = setup('veh_table');
    const heavy = { mass: 400_000, volume: 1000 };
    const b = findBestBench(game, heavy, true);
    expect(b.type).toBe('vehicle');
    expect(b.multiplier).toBeCloseTo(1.1 * (1 - (250_000 * 0.75) / 850_000), 10);
  });
});

describe('crafting at a vehicle workbench', () => {
  function cotton(game: Game) {
    const r = findRecipe(data, 'cotton_ball_by hand')!;
    expect(r).toBeDefined();
    game.player.learnedRecipes.add(r.id);
    spawnItem(createItem(data, 'cotton_boll'), L.inv(game.player), { force: true });
    return r;
  }
  it('speeds the craft by the bench multiplier and slows down from the moment the bench is lost', () => {
    const base = setup(null);
    const r0 = cotton(base.game);
    expect(startCraft(base.game, r0).ok).toBe(true);
    const handsDuration = base.game.activities.current!.spec.duration;

    const { game, part } = setup('workbench');
    const r = cotton(game);
    const res = startCraft(game, r);
    expect(res.ok).toBe(true);
    const act = game.activities.current!;
    expect(act.spec.duration).toBe(Math.round(handsDuration / 1.2));
    game.activities.update(game, 0.1, act.spec.duration / 2);
    const half = craftState(data, res.craft!)!.progress;
    expect(half).toBeCloseTo(0.5, 2);
    part!.hp = 0; // the bench breaks mid-craft
    game.activities.update(game, 0.1, 0.001);
    const now = game.activities.current!;
    expect(now.spec.target).toBe(res.craft);
    // the remaining half now takes the hands pace; progress is kept
    expect(now.spec.duration).toBeCloseTo(handsDuration * (1 - craftState(data, res.craft!)!.progress), -1);
    expect(craftState(data, res.craft!)!.progress).toBeGreaterThanOrEqual(half);
  });
  it('resumes a stopped craft at the bench that is in reach now (the progress lives on the saved craft item)', () => {
    const { game, v } = setup('workbench');
    const r = cotton(game);
    const res = startCraft(game, r);
    const full = game.activities.current!.spec.duration;
    game.activities.update(game, 0.1, full / 4);
    game.activities.cancel('interrupted');
    const progress = craftState(data, res.craft!)!.progress;
    // round-trip the craft item like a save would
    const restored = res.craft!;
    expect(Number(restored.vars.craft_progress)).toBeCloseTo(progress, 10);
    game.vehicles!.remove(v);
    expect(continueCraft(game, restored).ok).toBe(true);
    expect(game.activities.current!.spec.duration).toBe(Math.max(1, Math.round(full * 1.2 * (1 - progress))));
    expect(craftBench(game, restored).type).toBe('hands');
  });
  it('refuses to work on a craft too heavy for any bench in reach', () => {
    const { game } = setup(null);
    const r = cotton(game);
    const res = startCraft(game, r);
    game.activities.cancel('interrupted');
    // A craft weighing more than 1000 kg on the ground: 0.7 × 0.25 = 0.175 bench speed, total ≤ 0.2
    const anvil = createItem(data, 'cotton_boll');
    anvil.weight = () => 2_000_000;
    res.craft!._contents.push(anvil);
    game.player.inv.weightCapacity = () => 0;
    expect(cantContinue(game, res.craft!)).toMatch(/too large and\/or heavy/);
  });
});
