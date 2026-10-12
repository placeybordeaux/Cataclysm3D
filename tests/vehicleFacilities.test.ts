import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadNodeData } from '../tools/lib/node_data';
import { Game } from '../src/game/game';
import { Vehicle } from '../src/game/vehicle';
import { VehicleSystem } from '../src/game/vehicles';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { createItem } from '../src/game/item';
import { L, spawnItem } from '../src/game/moves';
import { drinkFromFaucet, faucetDrinkSeconds, faucetReason, faucetTanks, fillFromFaucet, startFaucetDrink, startFaucetFill } from '../src/game/vehicleFacilities';
let data: ReturnType<typeof loadNodeData>['game'], vd: VehicleDataFile;
beforeAll(() => { data = loadNodeData().game; vd = JSON.parse(readFileSync('public/data/vehicles.json', 'utf8')); });
function setup() {
  const game = new Game(data, 1, { held: new Set(), captured: false, onPress() {}, consumeMouse: () => [0, 0] } as any);
  game.vehicles = new VehicleSystem(game, vd);
  const v = new Vehicle(vd, 'car'); v.x = game.player.x; v.y = game.player.y; v.z = game.player.z; v.locked = false;
  const faucet = v.addPart(Object.values(vd.parts).find(p => p.flags.includes('FAUCET'))!, 0, 0);
  const tank = v.addPart(Object.values(vd.parts).find(p => p.flags.includes('FLUIDTANK') && (p.capacity ?? 0) >= 10000)!, 8, 0);
  tank.fuelType = 'water_clean'; tank.charges = 10000;
  game.vehicles.add(v);
  const bottle = createItem(data, 'bottle_plastic'); spawnItem(bottle, L.inv(game.player), { force: true });
  game.player.inv.hasQuality = () => false;
  return { game, v, faucet, tank, bottle };
}
describe('vehicle faucet facilities', () => {
  it('adds faucet overhead to source meal time, preserving integer rounding and trait precedence', () => {
    const { game } = setup();
    const duration = (...traits: string[]) => { game.player.hasTrait = id => traits.includes(id); return faucetDrinkSeconds(game.player); };
    expect(duration()).toBe(5);
    expect(duration('GOURMAND')).toBe(4);
    for (const mouth of ['MOUTH_TENTACLES', 'MANDIBLES', 'FANGS_SPIDER']) expect(duration(mouth)).toBe(3.75);
    expect(duration('SHARKTEETH')).toBe(3.33);
    expect(duration('SABER_TEETH')).toBe(7.5);
    expect(duration('AMORPHOUS')).toBe(5.25);
    expect(duration('BEAK_HUM')).toBe(5);
    expect(duration('MOUTH_TENTACLES', 'SHARKTEETH', 'GOURMAND', 'SABER_TEETH', 'AMORPHOUS')).toBe(6.62);
  });
  it('drinks exactly one real clean-water portion, applies normal hydration and preserves refusal checks', () => {
    const { game, v, faucet, tank } = setup();
    game.player.thirst = 200;
    expect(drinkFromFaucet(game, v, faucet, tank)).toBe(true);
    expect(tank.charges).toBe(9750);
    expect(game.player.thirst).toBe(200 - (data.items.water_clean.quench ?? 0));
    game.player.inv.consumeChecks.push(() => 'Test consumption refusal');
    expect(drinkFromFaucet(game, v, faucet, tank)).toBe(false);
    expect(tank.charges).toBe(9750);
  });
  it('pays BN drinking time, consumes only on completion, and cancels without free hydration or source loss', () => {
    const { game, v, faucet, tank } = setup(); game.player.thirst = 200;
    expect(startFaucetDrink(game, v, faucet, tank)).toBe(true);
    expect(game.activities.current!.spec.duration).toBe(5);
    game.activities.update(game, 0.1, 1);
    expect(tank.charges).toBe(10000); expect(game.player.thirst).toBe(200);
    game.activities.cancel('movement'); expect(tank.charges).toBe(10000);
    startFaucetDrink(game, v, faucet, tank); faucet.hp = 0;
    game.activities.update(game, 0.1, 6);
    expect(tank.charges).toBe(10000); expect(game.player.thirst).toBe(200);
    faucet.hp = 100; startFaucetDrink(game, v, faucet, tank);
    game.activities.update(game, 0.1, 6);
    expect(tank.charges).toBe(9750);
    expect(game.player.thirst).toBe(200 - (data.items.water_clean.quench ?? 0));
  });
  it('uses distant connected clean water tanks without a hose, conserving integral water charges', () => {
    const { game, v, faucet, tank, bottle } = setup();
    expect(faucetReason(game, v, faucet, tank)).toBeNull();
    expect(fillFromFaucet(game, v, faucet, tank, bottle, 249)).toBe(0);
    expect(fillFromFaucet(game, v, faucet, tank, bottle, 10000)).toBe(500);
    expect(tank.charges + bottle.contents[0].charges * 250).toBe(10000);
    expect(fillFromFaucet(game, v, faucet, tank, bottle, 10000)).toBe(0);
  });
  it('rejects unclean water, fuel, broken or removed facilities, locks and inaccessible parked facilities', () => {
    const { game, v, faucet, tank, bottle } = setup();
    for (const id of ['water', 'gasoline']) { tank.fuelType = id; expect(faucetTanks(v)).toEqual([]); expect(fillFromFaucet(game, v, faucet, tank, bottle, 500)).toBe(0); }
    tank.fuelType = 'water_clean'; faucet.hp = 0; expect(faucetReason(game, v, faucet, tank)).toContain('broken');
    faucet.hp = 100; v.locked = true; expect(faucetReason(game, v, faucet, tank)).toContain('locked');
    v.locked = false; game.player.x += 10; expect(faucetReason(game, v, faucet, tank)).toContain('closer');
    game.player.x -= 10; game.vehicles!.remove(v); expect(faucetReason(game, v, faucet, tank)).toContain('no longer');
  });
  it('permits moving seat access across a long vehicle, but rejects outside access and leaving the seat', () => {
    const { game, v, faucet, tank } = setup();
    v.velocity = 5; expect(faucetReason(game, v, faucet, tank)).toContain('seat');
    game.vehicles!.driving = v; game.player.x += 10;
    expect(faucetReason(game, v, faucet, tank)).toBeNull();
    game.vehicles!.driving = null; expect(faucetReason(game, v, faucet, tank)).toContain('seat');
  });
  it('retains actual partial transfers on cancellation and save, and revalidates facilities during filling', () => {
    const { game, v, faucet, tank, bottle } = setup();
    expect(startFaucetFill(game, v, faucet, tank, bottle)).toBe(true);
    game.activities.update(game, 0.1, 0.5);
    expect(bottle.contents[0].charges).toBe(1); expect(tank.charges).toBe(9750);
    faucet.hp = 0; game.activities.update(game, 0.1, 0.5);
    expect(game.activities.current).toBeNull(); expect(tank.charges).toBe(9750);
    const restored = Vehicle.fromJSON(vd, data, v.toJSON());
    expect(restored.parts.find(p => p.fuelType === 'water_clean')!.charges).toBe(9750);
  });
});

it('stops a moving seated fill when controls are released, without creating the unfinished remainder', () => {
  const { game, v, faucet, tank, bottle } = setup();
  v.velocity = 5; game.vehicles!.driving = v;
  expect(startFaucetFill(game, v, faucet, tank, bottle)).toBe(true);
  game.activities.update(game, 0.1, 0.5);
  game.vehicles!.driving = null;
  game.activities.update(game, 0.1, 1);
  expect(game.activities.current).toBeNull(); expect(tank.charges).toBe(9750);
  expect(bottle.contents[0].charges).toBe(1);
});
