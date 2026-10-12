import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadNodeData } from '../tools/lib/node_data';
import type { GameData } from '../src/data/types';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { Vehicle } from '../src/game/vehicle';
import { createItem, Item } from '../src/game/item';
import { rechargeVehicleCargo } from '../src/game/recharging';
import { L, spawnItem } from '../src/game/moves';
import { Game } from '../src/game/game';
import { VehicleSystem } from '../src/game/vehicles';
let data: GameData;
let vdata: VehicleDataFile;
beforeAll(() => { data = loadNodeData().game; vdata = JSON.parse(readFileSync('public/data/vehicles.json', 'utf8')); });
function setup(id = 'light_battery_cell') {
  const v = new Vehicle(vdata, 'car');
  v.addPart(vdata.parts.battery_car, 0, 0).charges = 100;
  const cargo = v.addPart(vdata.parts.trunk, 0, 0);
  const charger = v.addPart(vdata.parts.battery_charger, 0, 0);
  charger.enabled = true;
  const item = createItem(data, id, { charges: 0 });
  spawnItem(item, L.cargo(cargo, v));
  return { v, cargo, charger, item };
}
describe('vehicle recharging', () => {
  it('converts battery energy at the extracted rate and saves fractional progress', () => {
    const { v, item } = setup();
    rechargeVehicleCargo(v, 40);
    expect(item.ammoRemaining()).toBe(0);
    expect(v.fuelLeft('battery')).toBeCloseTo(99.4);
    expect(Item.fromJSON(data, item.toJSON()).vars.recharge_kj).toBeCloseTo(0.6);
    rechargeVehicleCargo(v, 40);
    expect(item.ammoRemaining()).toBe(1);
    expect(item.vars.recharge_kj).toBeCloseTo(0.2);
    expect(v.fuelLeft('battery')).toBeCloseTo(98.8);
  });
  it('charges integral rechargeable tools and stops at capacity', () => {
    const { v, item } = setup('smart_phone');
    item.charges = 199;
    rechargeVehicleCargo(v, 1000);
    expect(item.ammoRemaining()).toBe(200);
    expect(v.fuelLeft('battery')).toBe(99);
  });
  it('requires enabled intact chargers at the cargo mount', () => {
    const { v, charger, item } = setup();
    charger.enabled = false;
    expect(rechargeVehicleCargo(v, 100)).toBe(0);
    charger.enabled = true; charger.hp = 0;
    expect(rechargeVehicleCargo(v, 100)).toBe(0);
    charger.hp = 5; charger.mx = 1;
    // Changing mounts requires rebuilding the index, as loading does.
    const restored = Vehicle.fromJSON(vdata, data, v.toJSON());
    expect(rechargeVehicleCargo(restored, 100)).toBe(0);
    expect(item.ammoRemaining()).toBe(0);
  });
  it('never recharges disposable batteries and never overdrafts power', () => {
    const { v, item } = setup('light_disposable_cell');
    item.ammoConsume(item.ammoRemaining());
    expect(rechargeVehicleCargo(v, 1000)).toBe(0);
    expect(item.ammoRemaining()).toBe(0);
    const next = setup();
    next.v.drainFuel('battery', 99.5);
    rechargeVehicleCargo(next.v, 1000);
    expect(next.v.fuelLeft('battery')).toBe(0);
    expect(next.item.vars.recharge_kj).toBeCloseTo(0.5);
  });
  it('finds nested batteries and rechargeable magazines without charging twice', () => {
    const { v, cargo, item } = setup();
    const bag = createItem(data, 'bag_zipper');
    spawnItem(bag, L.cargo(cargo, v));
    const nested = createItem(data, 'medium_battery_cell');
    expect(spawnItem(nested, L.in(bag), { force: true }).ok).toBe(true);
    const light = createItem(data, 'flashlight');
    spawnItem(light, L.cargo(cargo, v));
    const mag = createItem(data, 'light_battery_cell');
    expect(spawnItem(mag, L.mag(light)).ok).toBe(true);
    rechargeVehicleCargo(v, 100);
    expect(item.ammoRemaining()).toBe(1);
    expect(nested.ammoRemaining()).toBe(1);
    expect(mag.ammoRemaining()).toBe(1);
    expect(mag.vars.recharge_kj).toBeCloseTo(0.5);
    expect(v.fuelLeft('battery')).toBeCloseTo(95.5);
  });
  it('uses elapsed game time through the installed vehicle system', () => {
    const { v, item } = setup();
    const input = { held: new Set<string>(), captured: false, onPress() {}, consumeMouse: () => [0, 0] } as any;
    const game = new Game(data, 1, input);
    const vs = new VehicleSystem(game, vdata);
    vs.list.push(v);
    vs.update(game, 0.01, 100);
    expect(item.ammoRemaining()).toBe(1);
    expect(item.vars.recharge_kj).toBeCloseTo(0.5);
    expect(v.fuelLeft('battery')).toBeCloseTo(98.5);
  });
});
