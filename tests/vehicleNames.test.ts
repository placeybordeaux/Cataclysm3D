// Telling same-name vehicles apart in menus (src/game/vehicleNames.ts): siphon / pump targets
// used to read "Fill nearby vehicle: Car" twice.
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadNodeData } from '../tools/lib/node_data';
import { Game } from '../src/game/game';
import { Vehicle } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { directionFromPlayer, distinctVehicleNames, vehicleColour } from '../src/game/vehicleNames';

let data: ReturnType<typeof loadNodeData>['game'];
let vdata: VehicleDataFile;
beforeAll(() => { data = loadNodeData().game; vdata = JSON.parse(readFileSync('public/data/vehicles.json', 'utf8')); });

function car(game: Game, proto: string, dx: number, dy: number, paint: number): Vehicle {
  const v = new Vehicle(vdata, proto);
  v.addPart(vdata.parts.frame_vertical, 0, 0);
  Object.assign(v, { x: game.player.x + dx, y: game.player.y + dy, z: game.player.z, paint });
  return v;
}

describe('distinct vehicle names', () => {
  it('a unique name stays plain; two Cars get their colour and where they are', () => {
    const game = new Game(data, 1, { held: new Set(), captured: false, onPress() {}, consumeMouse: () => [0, 0] } as any);
    game.player.yaw = 0; // looking north
    const red = car(game, 'car', -4, 0, 0x8a2c28), blue = car(game, 'car', 4, 0, 0x2c4a86), van = car(game, 'cube_van', 0, -5, 0x2c4a86);
    const names = distinctVehicleNames(game, [red, blue, van]);
    expect(names.get(red)).toBe('the red Car to your left');
    expect(names.get(blue)).toBe('the blue Car to your right');
    expect(names.get(van)).toBe(`the ${van.name}`);
  });
  it('same colour: direction alone; the vehicle you siphon from counts as a namesake', () => {
    const game = new Game(data, 1, { held: new Set(), captured: false, onPress() {}, consumeMouse: () => [0, 0] } as any);
    game.player.yaw = Math.PI / 2; // looking east
    const from = car(game, 'car', 0, 4, 0x8a2c28), to = car(game, 'car', 0, -4, 0x8a2c28);
    expect(distinctVehicleNames(game, [to], [from]).get(to)).toBe('the Car to your left');
    expect(distinctVehicleNames(game, [to]).get(to)).toBe('the Car');
    // identical colour and side: the distance tells them apart
    const near = car(game, 'car', 0, -3, 0x8a2c28), far = car(game, 'car', 0, -9, 0x8a2c28);
    const n = distinctVehicleNames(game, [near, far]);
    expect(n.get(near)).toMatch(/^the Car to your left \(\d+ m\)$/);
    expect(n.get(near)).not.toBe(n.get(far));
  });
  it('liveries name the drawn colour, not the hidden spawn paint', () => {
    const game = new Game(data, 1, { held: new Set(), captured: false, onPress() {}, consumeMouse: () => [0, 0] } as any);
    expect(vehicleColour(car(game, 'policecar', 0, 0, 0x8a2c28))).toBe('black-and-white');
    expect(vehicleColour(car(game, 'tank_m1_abrams', 0, 0, 0x8a2c28))).toBe('tan');
    game.player.yaw = 0;
    expect(directionFromPlayer(game, game.player.x, game.player.y + 10)).toBe('behind you');
    expect(directionFromPlayer(game, game.player.x, game.player.y - 10)).toBe('ahead');
  });
});
