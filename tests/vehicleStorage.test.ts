import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadNodeData } from '../tools/lib/node_data';
import { Game } from '../src/game/game';
import { Vehicle } from '../src/game/vehicle';
import { VehicleSystem } from '../src/game/vehicles';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { createItem, hourlyRotpoints } from '../src/game/item';
import { L, spawnItem } from '../src/game/moves';
import { updateVehiclePower } from '../src/game/vehiclePower';
import { FREEZER_C, FRIDGE_C, processColdCargo } from '../src/game/vehicleStorage';
let data: ReturnType<typeof loadNodeData>['game'], vd: VehicleDataFile;
beforeAll(() => { data = loadNodeData().game; vd = JSON.parse(readFileSync('public/data/vehicles.json', 'utf8')); });
function setup(id = 'fridge', energy = 100) {
  const game = new Game(data, 1, { held: new Set(), captured: false, onPress() {}, consumeMouse: () => [0, 0] } as any);
  game.weather = { temperature: 25 } as any;
  const v = new Vehicle(vd, 'car');
  const storage = v.addPart(vd.parts[id], 0, 0); storage.enabled = true;
  const battery = v.addPart(vd.parts.battery_car, 0, 0); battery.charges = energy;
  const meat = createItem(data, 'meat'); spawnItem(meat, L.cargo(storage, v), { force: true });
  return { game, v, storage, battery, meat };
}
describe('powered vehicle cold storage', () => {
  it('ages real nested food while preserving sealed container contents through the existing item rules', () => {
    const { game, v, storage } = setup('fridge', 0);
    const open = createItem(data, 'bottle_plastic'), sealed = createItem(data, 'can_food');
    const looseMeat = createItem(data, 'meat'), sealedMeat = createItem(data, 'meat');
    spawnItem(open, L.cargo(storage, v), { force: true }); spawnItem(sealed, L.cargo(storage, v), { force: true });
    spawnItem(looseMeat, L.in(open), { force: true }); spawnItem(sealedMeat, L.in(sealed), { force: true });
    // Insertion opens a sealed can through moves.ts. Restore the sealed type to
    // model food that was sealed after filling, rather than testing an open can.
    sealed.convert('can_food'); expect(sealed.def.container_data?.preserves).toBe(true);
    updateVehiclePower(game, v, 60);
    expect(looseMeat.rot).toBeCloseTo(60 * hourlyRotpoints(25) / 3600); expect(sealedMeat.rot).toBe(0);
  });
  it('uses BN temperature caps and game-time epower while all ordinary cargo ages at ambient temperature', () => {
    const { game, v, battery, meat } = setup();
    const cargo = v.addPart(vd.parts.trunk, 1, 0);
    const warm = createItem(data, 'meat'); spawnItem(warm, L.cargo(cargo, v), { force: true });
    updateVehiclePower(game, v, 60);
    expect(battery.charges).toBeCloseTo(100 - 60 * 60 / 1000);
    expect(meat.rot).toBeCloseTo(60 * hourlyRotpoints(FRIDGE_C) / 3600);
    expect(warm.rot).toBeCloseTo(60 * hourlyRotpoints(25) / 3600);
    expect(warm.rot).toBeGreaterThan(meat.rot);
    const frozen = setup('freezer'); updateVehiclePower(frozen.game, frozen.v, 60);
    expect(FREEZER_C).toBe(-5); expect(frozen.meat.rot).toBe(0);
    expect(frozen.battery.charges).toBeCloseTo(100 - 90 * 60 / 1000);
  });
  it('spends only available energy and ages food at ambient temperature after power is exhausted', () => {
    const { game, v, battery, meat } = setup('fridge', 0.03);
    updateVehiclePower(game, v, 1);
    expect(battery.charges).toBe(0);
    expect(meat.rot).toBeCloseTo((0.5 * hourlyRotpoints(FRIDGE_C) + 0.5 * hourlyRotpoints(25)) / 3600);
    const before = meat.rot; updateVehiclePower(game, v, 60);
    expect(meat.rot - before).toBeCloseTo(60 * hourlyRotpoints(25) / 3600);
  });
  it('warms broken and disabled storage, never raises cold ambient temperatures, and avoids duplicate physics draw', () => {
    for (const kind of ['broken', 'disabled']) {
      const { game, v, storage, battery, meat } = setup();
      if (kind === 'broken') storage.hp = 0; else storage.enabled = false;
      updateVehiclePower(game, v, 60);
      expect(meat.rot).toBeCloseTo(60 * hourlyRotpoints(25) / 3600); expect(battery.charges).toBe(100);
    }
    const { v, storage, meat, battery } = setup();
    expect(v.updateElectrics(60)).toBe(0); expect(battery.charges).toBe(100);
    processColdCargo(v, [storage], 60, -10); expect(meat.rot).toBe(0);
  });
  it('advances from actual VehicleSystem gameDt rather than real-time physics and saves cold cargo condition', () => {
    const { game, v, storage, battery, meat } = setup('freezer');
    v.x = game.player.x; v.y = game.player.y; v.z = game.player.z;
    game.vehicles = new VehicleSystem(game, vd); game.vehicles.add(v);
    game.vehicles.update(game, 0.1, 60);
    expect(battery.charges).toBeCloseTo(94.6); expect(meat.rot).toBe(0);
    const restored = Vehicle.fromJSON(vd, data, v.toJSON());
    const savedStorage = restored.parts.find(p => p.def.id === storage.def.id)!;
    expect(savedStorage.enabled).toBe(true); expect(restored.fuelLeft('battery')).toBeCloseTo(94.6);
    expect(savedStorage.items[0].rot).toBe(0);
    restored.parts.find(p => p.fuelType === 'battery')!.charges = 0;
    updateVehiclePower(game, restored, 60);
    expect(savedStorage.items[0].rot).toBeCloseTo(60 * hourlyRotpoints(25) / 3600);
  });
  it('conserves partitioned solar power, charger transfers and cold-storage draw during a long wait', () => {
    const a = setup('fridge', 10), b = setup('fridge', 10);
    for (const { game, v } of [a, b]) {
      game.clock.seconds = 12 * 3600; game.map.hasFloor = () => false; game.map.terAt = () => ({ flags: [] } as any);
      v.addPart(vd.parts.solar_panel, 0, 0);
      v.addPart(vd.parts.recharge_station, 0, 0).enabled = true;
      spawnItem(createItem(data, 'medium_battery_cell'), L.cargo(v.parts[0], v), { force: true });
    }
    updateVehiclePower(a.game, a.v, 120);
    const end = b.game.clock.seconds;
    for (let i = 0; i < 120; i++) { b.game.clock.seconds = end - 119 + i; updateVehiclePower(b.game, b.v, 1); }
    expect(a.battery.charges).toBeCloseTo(b.battery.charges, 8); expect(a.meat.rot).toBeCloseTo(b.meat.rot, 8);
    expect(a.storage.items[1].ammoRemaining()).toBe(b.storage.items[1].ammoRemaining());
    expect(Number(a.storage.items[1].vars.recharge_kj)).toBeCloseTo(Number(b.storage.items[1].vars.recharge_kj), 8);
  });
});
