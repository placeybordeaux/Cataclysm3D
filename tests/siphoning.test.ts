import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadNodeData } from '../tools/lib/node_data';
import { Game } from '../src/game/game';
import { Vehicle, spawnVehicle } from '../src/game/vehicle';
import { Rng } from '../src/core/rng';
import { VehicleSystem } from '../src/game/vehicles';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { createItem } from '../src/game/item';
import { L, spawnItem } from '../src/game/moves';
import { hosePath, tankPoint, siphonInto, siphonIntoVehicle, siphonReason, siphonTargets, siphonVehicleTargets, startSiphoning, startSiphoningToVehicle, tankMlPerCharge } from '../src/game/siphoning';
let data: ReturnType<typeof loadNodeData>['game'];
let vdata: VehicleDataFile;
beforeAll(() => { data = loadNodeData().game; vdata = JSON.parse(readFileSync('public/data/vehicles.json', 'utf8')); });
function setup(fuel = 'gasoline') {
  const game = new Game(data, 1, { held: new Set(), captured: false, onPress() {}, consumeMouse: () => [0, 0] } as any);
  const v = new Vehicle(vdata, 'car'); v.x = game.player.x; v.y = game.player.y; v.z = game.player.z;
  const def = Object.values(vdata.parts).find(p => p.flags.includes('FLUIDTANK') && (p.capacity ?? 0) >= 10000)!;
  const tank = v.addPart(def, 0, 0); tank.fuelType = fuel; tank.charges = 10000;
  const hose = createItem(data, 'hose'); expect(spawnItem(hose, L.inv(game.player), { force: true }).ok).toBe(true);
  const bottle = createItem(data, 'bottle_plastic');
  spawnItem(bottle, L.ground(game.map, game.player.tileX, game.player.tileY, game.player.z));
  return { game, v, tank, hose, bottle };
}
describe('vehicle siphoning', () => {
  it('requires a hose, reach, an intact liquid tank and a stopped vehicle', () => {
    const { game, v, tank } = setup();
    expect(siphonReason(game, v, tank)).toBeNull();
    v.velocity = 2; expect(siphonReason(game, v, tank)).toContain('moving');
    v.velocity = 0; game.player.x += 10; expect(siphonReason(game, v, tank)).toContain('Stand next to');
    game.player.x -= 10; tank.hp = 0; expect(siphonReason(game, v, tank)).toContain('intact');
    tank.hp = 100; game.player.inv.hasQuality = () => false; expect(siphonReason(game, v, tank)).toContain('hose');
  });
  it('moves gasoline through the location API without overdrawing or overflowing', () => {
    const { game, v, tank, bottle } = setup();
    const room = siphonTargets(game, v, tank).find(t => t.item === bottle)!.room;
    const transferred = siphonInto(game, v, tank, bottle, 10000);
    expect(transferred).toBe(room);
    expect(tank.charges + bottle.contents[0].charges).toBe(10000);
    expect(siphonInto(game, v, tank, bottle, 1000)).toBe(0);
    expect(tank.charges).toBe(10000 - transferred);
  });
  it('converts water ml to 250 ml item charges, keeping fractional source volume', () => {
    const { game, v, tank, bottle } = setup('water_clean');
    expect(tankMlPerCharge(v, tank)).toBe(250);
    expect(siphonInto(game, v, tank, bottle, 249)).toBe(0);
    expect(siphonInto(game, v, tank, bottle, 501)).toBe(500);
    expect(bottle.contents[0].charges).toBe(2);
    expect(tank.charges).toBe(9500);
  });
  it('does not mix incompatible liquid or create liquid in inaccessible containers', () => {
    const { game, v, tank, bottle } = setup();
    spawnItem(createItem(data, 'water_clean', { charges: 1 }), L.in(bottle));
    expect(siphonInto(game, v, tank, bottle, 1000)).toBe(0);
    const distant = createItem(data, 'bottle_plastic');
    expect(siphonInto(game, v, tank, distant, 1000)).toBe(0);
    expect(tank.charges).toBe(10000);
  });
  it('uses BN fill rate and retains actual transfers when interrupted or saved', () => {
    const { game, v, tank, bottle } = setup();
    expect(startSiphoning(game, v, tank, bottle)).toBe(true);
    game.activities.update(game, 0.1, 0.3);
    expect(bottle.contents[0].charges).toBe(200);
    expect(tank.charges).toBe(9800);
    game.activities.cancel('movement');
    const restored = Vehicle.fromJSON(vdata, data, v.toJSON());
    expect(restored.parts[0].charges).toBe(9800);
    expect(bottle.contents[0].charges).toBe(200);
  });
  it('never siphons batteries, reactors or non-liquid tanks', () => {
    const { game, v, tank, bottle } = setup();
    tank.fuelType = 'coal_lump';
    expect(siphonInto(game, v, tank, bottle, 1000)).toBe(0);
    const battery = v.addPart(vdata.parts.battery_car, 0, 0); battery.charges = 100;
    expect(siphonInto(game, v, battery, bottle, 1000)).toBe(0);
    expect(battery.charges).toBe(100);
  });
});

describe('siphoning into another vehicle (BN "Fill nearby vehicle")', () => {
  function twoCars() {
    const s = setup();
    s.game.vehicles = new VehicleSystem(s.game, vdata);
    s.game.vehicles.add(s.v);
    const other = new Vehicle(vdata, 'car'); other.x = s.v.x + 1; other.y = s.v.y; other.z = s.v.z;
    s.game.vehicles!.add(other);
    const otherTank = other.parts.find(p => p.def.flags.includes('FLUIDTANK') && other.engineFuels().includes('gasoline'))
      ?? other.addPart(Object.values(vdata.parts).find(p => p.flags.includes('FLUIDTANK') && (p.capacity ?? 0) >= 10000)!, 0, 0);
    for (const p of other.parts) if (p.def.flags.includes('FLUIDTANK')) { p.fuelType = 'gasoline'; p.charges = 0; }
    return { ...s, other, otherTank };
  }
  it('offers a nearby vehicle and moves ml for ml without creating fuel', () => {
    const { game, v, tank, other } = twoCars();
    const target = siphonVehicleTargets(game, v, tank).find(t => t.vehicle === other);
    expect(target).toBeDefined();
    expect(siphonVehicleTargets(game, v, tank).some(t => t.vehicle === v)).toBe(false);
    const before = other.fuelLeft('gasoline');
    const moved = siphonIntoVehicle(game, v, tank, other, 3000);
    expect(moved).toBe(3000);
    expect(tank.charges).toBe(7000);
    expect(other.fuelLeft('gasoline') - before).toBe(3000);
  });
  it('runs as a timed activity at the hose rate', () => {
    const { game, v, tank, other } = twoCars();
    expect(startSiphoningToVehicle(game, v, tank, other)).toBe(true);
    game.activities.update(game, 0.1, 0.3);
    expect(tank.charges).toBe(9800);
    expect(other.fuelLeft('gasoline')).toBe(200);
  });
  it('needs the other vehicle within hose reach', () => {
    const { game, v, tank, other } = twoCars();
    other.x += 20;
    expect(siphonVehicleTargets(game, v, tank)).toEqual([]);
    expect(siphonIntoVehicle(game, v, tank, other, 1000)).toBe(0);
    expect(tank.charges).toBe(10000);
  });
});

describe('where the hose runs', () => {
  it('puts a car\'s filler on the body side nearest its tank, facing out', () => {
    const game = new Game(data, 1, { held: new Set(), captured: false, onPress() {}, consumeMouse: () => [0, 0] } as any);
    const v = spawnVehicle(vdata, data, 'car', { x: 100.5, y: 100.5, z: 0, facing: 30, status: 2, rng: new Rng(1), items: false });
    const tank = v.parts.find(p => p.def.flags.includes('FLUIDTANK') && p.my === -1)!;
    const pt = tankPoint(game, v, tank)!;
    const [lx, ly] = v.worldToMount(pt.x, pt.y);
    // no chassis template in node: the body is the car's whole tiles, my -1.5 .. 2.5
    expect(ly).toBeCloseTo(-1.54, 5);
    expect(lx).toBeCloseTo(tank.mx, 5);
    const [ox, oy] = v.worldToMount(pt.x + pt.nx!, pt.y + pt.ny!);
    expect([ox - lx, oy - ly].map(n => Math.round(n))).toEqual([0, -1]);
  });
  it('lays the hose around the body, never through it', () => {
    const game = new Game(data, 1, { held: new Set(), captured: false, onPress() {}, consumeMouse: () => [0, 0] } as any);
    const v = spawnVehicle(vdata, data, 'car', { x: 100.5, y: 100.5, z: 0, facing: 30, status: 2, rng: new Rng(1), items: false });
    const tank = v.parts.find(p => p.def.flags.includes('FLUIDTANK') && p.my === -1)!;
    const a = tankPoint(game, v, tank)!;
    // the hands on the far side of the car from the filler
    const [hx, hy] = v.mountToWorld(tank.mx, 4);
    const path = hosePath(game, a, { x: hx, y: hy, z: 0, h: 0.9 }, [v]);
    expect(path.length).toBeGreaterThan(2);
    const inside = (p: { x: number; y: number }) => { const [x, y] = v.worldToMount(p.x, p.y); return x > -3.5 && x < 2.5 && y > -1.5 && y < 2.5; };
    for (let i = 1; i < path.length; i++)
      for (let t = 0; t <= 1; t += 0.05)
        expect(inside({ x: path[i - 1].x + (path[i].x - path[i - 1].x) * t, y: path[i - 1].y + (path[i].y - path[i - 1].y) * t })).toBe(false);
  });
});
