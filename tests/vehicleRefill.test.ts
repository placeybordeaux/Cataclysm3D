// BN veh_interact::do_refill + ACT_VEHICLE 'f' (src/game/vehicleRefill.ts): pour a carried
// container into a vehicle's tanks, 1000 moves, as much as fits, the rest stays in the can.
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadNodeData } from '../tools/lib/node_data';
import { Game } from '../src/game/game';
import { Vehicle } from '../src/game/vehicle';
import { VehicleSystem } from '../src/game/vehicles';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { createItem } from '../src/game/item';
import { L, spawnItem } from '../src/game/moves';
import { REFILL_SECONDS, refillFrom, refillReason, refillSources, startRefill } from '../src/game/vehicleRefill';
let data: ReturnType<typeof loadNodeData>['game'];
let vdata: VehicleDataFile;
beforeAll(() => { data = loadNodeData().game; vdata = JSON.parse(readFileSync('public/data/vehicles.json', 'utf8')); });

function setup(gasMl: number, tankMl = 0, capacity = 10000) {
  const game = new Game(data, 1, { held: new Set(), captured: false, onPress() {}, consumeMouse: () => [0, 0] } as any);
  game.vehicles = new VehicleSystem(game, vdata);
  const v = new Vehicle(vdata, 'car'); v.x = game.player.x + 1; v.y = game.player.y; v.z = game.player.z;
  for (const p of [...v.parts]) if (p.def.flags.includes('FLUIDTANK')) v.parts.splice(v.parts.indexOf(p), 1);
  const def = Object.values(vdata.parts).find(p => p.flags.includes('FLUIDTANK') && p.capacity === capacity)
    ?? Object.values(vdata.parts).find(p => p.flags.includes('FLUIDTANK') && (p.capacity ?? 0) >= capacity)!;
  const tank = v.addPart(def, 0, 0); tank.fuelType = 'gasoline'; tank.charges = tankMl;
  game.vehicles.add(v);
  const can = createItem(data, 'jerrycan');
  expect(spawnItem(can, L.inv(game.player), { force: true }).ok).toBe(true);
  expect(spawnItem(createItem(data, 'gasoline', { charges: gasMl }), L.in(can)).ok).toBe(true);
  return { game, v, tank, can };
}

describe('refilling a vehicle from a carried container', () => {
  it('pours the whole can into the tank, ml for ml, and empties the can', () => {
    const { game, v, tank, can } = setup(5000);
    expect(refillReason(game, v)).toBeNull();
    const [src] = refillSources(game, v);
    expect(src.container).toBe(can);
    expect(src.charges).toBe(5000);
    expect(refillFrom(game, v, can)).toBe(5000);
    expect(tank.charges).toBe(5000);
    expect(can.contents.length).toBe(0);
  });
  it('fills only what fits and leaves the rest in the can', () => {
    const { game, v, tank, can } = setup(5000, 0, 10000);
    const cap = tank.def.capacity!;
    tank.charges = cap - 1500;
    expect(refillFrom(game, v, can)).toBe(1500);
    expect(tank.charges).toBe(cap);
    expect(can.contents[0].charges).toBe(3500);
    expect(refillSources(game, v)).toEqual([]);
  });
  it('refuses a moving vehicle, one out of reach, and a liquid the tanks cannot take', () => {
    const { game, v, can } = setup(1000);
    v.velocity = 3; expect(refillReason(game, v)).toContain('moving'); expect(refillFrom(game, v, can)).toBe(0);
    v.velocity = 0; v.x += 20; expect(refillReason(game, v)).toContain('Stand next to'); v.x -= 20;
    can.contents[0].convert('water_clean');
    expect(refillSources(game, v)).toEqual([]);
  });
  it('takes BN\'s 10 s and pours nothing if interrupted', () => {
    const { game, v, tank, can } = setup(2000);
    expect(startRefill(game, v, can)).toBe(true);
    game.activities.update(game, 0.1, REFILL_SECONDS / 2);
    expect(tank.charges).toBe(0);
    game.activities.cancel('movement');
    expect(tank.charges).toBe(0);
    expect(can.contents[0].charges).toBe(2000);
    expect(startRefill(game, v, can)).toBe(true);
    game.activities.update(game, 0.1, REFILL_SECONDS + 0.1);
    expect(tank.charges).toBe(2000);
  });
});
