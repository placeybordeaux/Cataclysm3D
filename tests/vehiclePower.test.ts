import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadNodeData } from '../tools/lib/node_data';
import { Game } from '../src/game/game';
import { Vehicle } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { generateSolarPower } from '../src/game/vehiclePower';
let game: Game;
let data: VehicleDataFile;
beforeAll(() => {
  data = JSON.parse(readFileSync('public/data/vehicles.json', 'utf8'));
  game = new Game(loadNodeData().game, 1, { held: new Set(), captured: false, onPress() {}, consumeMouse: () => [0, 0] } as any);
});
function setup() {
  const v = new Vehicle(data, 'car');
  const battery = v.addPart(data.parts.battery_car, 0, 0);
  const panel = v.addPart(data.parts.solar_panel, 0, 0);
  game.clock.seconds = 12 * 3600;
  game.weather = null;
  game.map.terAt = () => ({ flags: [] }) as any;
  game.map.hasFloor = () => false;
  game.map.hasChunk = () => false;
  return { v, battery, panel };
}
describe('vehicle solar generation', () => {
  it('stores sunlight as kJ and respects intact battery capacity', () => {
    const { v, battery } = setup();
    expect(generateSolarPower(game, v, 100)).toBeGreaterThan(4);
    expect(battery.charges).toBeLessThan(11);
    battery.charges = battery.def.capacity! - 0.1;
    expect(generateSolarPower(game, v, 100)).toBeCloseTo(0.1);
    expect(battery.charges).toBe(battery.def.capacity);
  });
  it('does not use moonlight, underground panels, roofs or broken panels', () => {
    const { v, panel } = setup();
    game.clock.seconds = 0;
    expect(generateSolarPower(game, v, 100)).toBe(0);
    game.clock.seconds = 12 * 3600;
    v.z = -1;
    expect(generateSolarPower(game, v, 100)).toBe(0);
    v.z = 0;
    game.map.hasFloor = () => true;
    expect(generateSolarPower(game, v, 100)).toBe(0);
    game.map.hasFloor = () => false;
    panel.hp = 0;
    expect(generateSolarPower(game, v, 100)).toBe(0);
  });
  it('scales output with panel damage and weather and survives save/load', () => {
    const { v, panel } = setup();
    const full = generateSolarPower(game, v, 100);
    v.drainFuel('battery', full);
    panel.hp /= 2;
    expect(generateSolarPower(game, v, 100)).toBeCloseTo(full / 2);
    const saved = Vehicle.fromJSON(data, game.data, v.toJSON());
    expect(saved.fuelLeft('battery')).toBeCloseTo(full / 2);
    game.weather = { lightModifier: -200 } as any;
    expect(generateSolarPower(game, v, 100)).toBe(0);
  });
  it('integrates warped time across a sunset rather than generating throughout the night', () => {
    const { v } = setup();
    game.clock.seconds = 24 * 3600;
    const overnight = generateSolarPower(game, v, 12 * 3600);
    expect(overnight).toBeGreaterThan(0);
    expect(overnight).toBeLessThan(80 * 12 * 3600 / 1000);
    expect(generateSolarPower(game, v, NaN)).toBe(0);
  });
});

import { generateReactorPower, loadReactorFuel, updateVehiclePower } from '../src/game/vehiclePower';
import { createItem } from '../src/game/item';
import { L, spawnItem } from '../src/game/moves';
import { VehicleSystem } from '../src/game/vehicles';
describe('vehicle power integration and reactors', () => {
  it('blocks sunlight beneath roofs several levels above the panel', () => {
    const { v } = setup();
    game.map.hasFloor = (_x, _y, z) => z === 3;
    // levels above the next are read only where generated (vehiclePower.ts solarWatts)
    game.map.hasChunk = (_cx, _cy, z) => z === 3;
    expect(generateSolarPower(game, v, 100)).toBe(0);
  });
  it('uses game elapsed time in the installed system', () => {
    const { v, battery } = setup();
    const vs = new VehicleSystem(game, data);
    vs.list.push(v);
    vs.update(game, 0.01, 100);
    expect(battery.charges).toBeGreaterThan(4);
  });
  it('interleaves charging with generation identically across a wait and one-second updates', () => {
    const { v, battery } = setup();
    battery.charges = battery.def.capacity!;
    const cargo = v.addPart(data.parts.trunk, 0, 0);
    v.addPart(data.parts.recharge_station, 0, 0).enabled = true;
    const cell = createItem(game.data, 'medium_battery_cell');
    spawnItem(cell, L.cargo(cargo, v));
    const partitioned = Vehicle.fromJSON(data, game.data, v.toJSON());
    const start = game.clock.seconds;
    updateVehiclePower(game, v, 100);
    for (let i = 0; i < 100; i++) {
      game.clock.seconds = start - 100 + i + 1;
      updateVehiclePower(game, partitioned, 1);
    }
    expect(partitioned.fuelLeft('battery')).toBeCloseTo(v.fuelLeft('battery'), 8);
    expect(partitioned.parts.find(p => p.items.length)!.items[0].ammoRemaining()).toBe(cell.ammoRemaining());
  });
  it('uses reactor efficiency rather than plutonium combustion energy, saving fractional fuel', () => {
    const { v } = setup();
    const reactor = v.addPart(data.parts.minireactor, 0, 0);
    reactor.charges = 2;
    reactor.enabled = true;
    expect(generateReactorPower(v, 0.5)).toBe(50);
    expect(reactor.charges).toBe(1.5);
    const loaded = Vehicle.fromJSON(data, game.data, v.toJSON());
    expect(loaded.parts.find(p => p.def.id === 'minireactor')!.charges).toBe(1.5);
    expect(generateReactorPower(v, 10)).toBe(150);
    expect(reactor.charges).toBe(0);
    expect(reactor.enabled).toBe(false);
  });
  it('does not burn reactor fuel with full or broken storage, disabled or broken reactors', () => {
    const { v, battery } = setup();
    const reactor = v.addPart(data.parts.minireactor, 0, 0);
    reactor.charges = 2;
    expect(generateReactorPower(v, 10)).toBe(0);
    reactor.enabled = true;
    battery.charges = battery.def.capacity!;
    expect(generateReactorPower(v, 10)).toBe(0);
    battery.charges = 0;
    battery.hp = 0;
    expect(generateReactorPower(v, 10)).toBe(0);
    battery.hp = battery.def.durability;
    reactor.hp = 0;
    expect(generateReactorPower(v, 10)).toBe(0);
    expect(reactor.charges).toBe(2);
  });
  it('loads only existing carried matching fuel through the conservation API', () => {
    const { v } = setup();
    const reactor = v.addPart(data.parts.minireactor, 0, 0);
    const fuel = createItem(game.data, 'plut_cell', { charges: 5 });
    spawnItem(fuel, L.inv(game.player), { force: true });
    expect(loadReactorFuel(game, v, reactor)).toBe(5);
    expect(game.player.inv.allItems().includes(fuel)).toBe(false);
    expect(reactor.charges).toBe(5);
    expect(loadReactorFuel(game, v, reactor)).toBe(0);
  });
});
