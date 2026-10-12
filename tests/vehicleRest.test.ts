import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadNodeData } from '../tools/lib/node_data';
import { Game } from '../src/game/game';
import { spawnVehicle, Vehicle } from '../src/game/vehicle';
import { Rng } from '../src/core/rng';
import { VehicleSystem } from '../src/game/vehicles';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { comfortAt, goToSleep, installRest, playerComfort } from '../src/game/rest';
import { vehicleBedding, vehicleMountSpot, vehicleSleepSpot } from '../src/game/vehicleRest';
import { createItem } from '../src/game/item';

let data: ReturnType<typeof loadNodeData>['game'], vd: VehicleDataFile;
beforeAll(() => { data = loadNodeData().game; vd = JSON.parse(readFileSync('public/data/vehicles.json', 'utf8')); });

function setup() {
  const game = new Game(data, 3, { held: new Set(), captured: false, onPress() {}, capture: () => () => {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as any);
  game.vehicles = new VehicleSystem(game, vd);
  const log: string[] = [];
  game.events.on('message', (m) => log.push(m.text));
  const p = game.player;
  // A stock car parked a few tiles away from the survivor (driver's seat on mount 0,0: a
  // reclining seat, BED + SEAT, comfort 3).
  const v = spawnVehicle(vd, data, 'car', { x: Math.floor(p.x) + 6.5, y: Math.floor(p.y) + 0.5, z: p.z, facing: 0, fuel: 50, status: 0, rng: new Rng(3) } as never);
  v.locked = false;
  for (const q of v.parts) q.hp = q.def.durability;
  game.vehicles.add(v);
  installRest(game);
  return { game, v, p, log };
}

const BED = () => vd.parts.bed;

describe('BN vehicle sleeping comfort', () => {
  it('rates a mount by its first intact BOARDABLE part, else minus the move cost (base_comfort_value)', () => {
    const { v } = setup();
    expect(vd.parts.bed.comfort).toBe(4);
    expect(vd.parts.reclining_seat.comfort).toBe(3);
    expect(vd.parts.seat.comfort).toBe(2);
    const driver = vehicleMountSpot(v, 0, 0);
    expect(driver).toMatchObject({ comfort: 3, comfortable: true });
    const seatMount = v.parts.find((q) => q.def.id === 'seat')!;
    expect(vehicleMountSpot(v, seatMount.mx, seatMount.my).comfort).toBe(2);
    for (const q of v.partsAt(seatMount.mx, seatMount.my)) if (q.def.flags.includes('BOARDABLE')) q.hp = 0;
    // nothing boardable left on the tile: −move_cost (8, clambering over a seat)
    expect(vehicleMountSpot(v, seatMount.mx, seatMount.my)).toMatchObject({ comfort: -v.moveCostAt(seatMount.mx, seatMount.my), comfortable: false });
  });

  it('uses the map tile when you are not in a vehicle (furniture bed regression)', () => {
    const { game, p } = setup();
    game.map.setFurn(Math.floor(p.x), Math.floor(p.y), p.z, 'f_bed');
    expect(playerComfort(game)).toMatchObject({ comfort: 5, on: 'bed' });
    expect(playerComfort(game).vehicle).toBeUndefined();
    expect(playerComfort(game).comfort).toBe(comfortAt(game, p.tileX, p.tileY, p.z).comfort);
  });

  it('from the driver seat offers the best bed in the vehicle, and lets go of the controls to sleep', () => {
    const { game, v, p, log } = setup();
    expect(game.vehicles!.takeControls(v).ok).toBe(true);
    expect(playerComfort(game)).toMatchObject({ comfort: 3, on: 'reclining seat in the Car' });
    const bed = v.addPart(BED(), -9, 0);
    expect(playerComfort(game)).toMatchObject({ comfort: 4, on: `bed in the Car` });
    expect(vehicleSleepSpot(game)).toMatchObject({ mx: bed.mx, my: bed.my });
    p.sleepiness = 250;
    expect(goToSleep(game)).toBe(true);
    expect(log).toContain('This is a comfortable place to sleep.');
    expect(log).toContain('You settle down on the bed in the Car.');
    expect(game.vehicles!.driving).toBeNull();
    expect(p.sleepComfort).toBe(4);
    // bedding: the bed's floor_bedding_warmth 800 legacy = 1.6 °C, plus a blanket in its cargo
    expect(vehicleBedding(vehicleSleepSpot(game)!).bedding).toBeCloseTo(1.6, 10);
    const blanket = createItem(data, 'blanket');
    bed.items.push(blanket);
    expect(vehicleBedding(vehicleSleepSpot(game)!).items).toBeGreaterThan(0);
  });

  it('refuses to lie down while the vehicle moves, and wakes a sleeper when it starts moving', () => {
    const { game, v, p, log } = setup();
    game.vehicles!.takeControls(v);
    v.velocity = 4;
    expect(playerComfort(game).refuse).toMatch(/moving/);
    expect(goToSleep(game)).toBe(false);
    expect(game.activities.current).toBeNull();
    v.velocity = 0;
    p.sleepiness = 400;
    expect(goToSleep(game)).toBe(true);
    p.fallAsleep();
    v.velocity = 2;
    game.activities.update(game, 0.1, 1);
    expect(p.isAsleep()).toBe(false);
    expect(log).toContain('The Car lurches into motion and you wake up.');
    expect(game.activities.current).toBeNull();
  });

  it('follows the bed breaking or the vehicle disappearing while you sleep', () => {
    const { game, v, p } = setup();
    game.vehicles!.takeControls(v);
    const bed = v.addPart(BED(), -9, 0);
    p.sleepiness = 400;
    expect(goToSleep(game)).toBe(true);
    p.fallAsleep();
    game.activities.update(game, 0.1, 1);
    expect(p.sleepComfort).toBe(4);
    bed.hp = 0;
    game.activities.update(game, 0.1, 1);
    expect(p.sleepComfort).toBe(3); // back to the reclining seat
    game.vehicles!.remove(v);
    game.activities.update(game, 0.1, 1);
    expect(p.sleepComfort).toBe(comfortAt(game, p.tileX, p.tileY, p.z).comfort);
    expect(p.isAsleep()).toBe(true);
  });

  it("keeps BN's refusal on a vehicle tile with no seat, bed or aisle", () => {
    const { game, v } = setup();
    for (const q of v.parts) if (q.def.flags.includes('SEAT') || q.def.flags.includes('BED')) q.hp = 0;
    game.vehicles!.takeControls(v);
    const ci = playerComfort(game);
    expect(ci.vehicle?.comfortable).toBe(false);
    expect(ci.refuse).toBe("It's hard to get to sleep in the Car.");
    expect(goToSleep(game)).toBe(false);
  });

  it('a save taken asleep in the vehicle resumes on the vehicle bed (sleepwatch restarts the activity)', () => {
    const { game, v, p } = setup();
    game.vehicles!.takeControls(v);
    v.addPart(BED(), -9, 0);
    p.sleepiness = 400;
    goToSleep(game);
    p.fallAsleep();
    // Restore the vehicle from its save form and drop the running activity, as a load does.
    const json = v.toJSON();
    game.vehicles!.remove(v);
    const restored = Vehicle.fromJSON(vd, data, json);
    game.vehicles!.add(restored);
    game.activities.current = null;
    p.sleepComfort = 0;
    game.tick(1 / 30);
    const current = () => game.activities.current;
    expect(current()?.spec.name).toBe('sleeping');
    game.activities.update(game, 0.1, 1);
    expect(p.sleepComfort).toBe(4);
  });
});
