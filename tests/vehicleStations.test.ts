// Inside vehicles (src/game/vehwalk.ts, docs/VEHICLES.md "Inside vehicles"): which interior
// model a vehicle gets from its data, its stations, hopping between them with W/A/S/D, `e`
// at a station (drive, get out, hatches), and the free-walk fallback.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import { chassisBodyRect } from '../src/game/chassis';
import { has, spawnVehicle, type Vehicle } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { VehicleSystem } from '../src/game/vehicles';
import { cabinKind, stationRole, stationsOf } from '../src/game/vehwalk';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { loadNodeData } from '../tools/lib/node_data';

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
  for (let y = -1; y <= 3; y++) for (let x = -1; x <= 4; x++) game.map.chunk(x, y, 0);
  const vs = new VehicleSystem(game, vdata);
  game.vehicles = vs;
  game.systems.push(vs);
  vs.bodyShape = chassisBodyRect;
  vs.scriptedInput = true;
  game.player.x = 90.5;
  game.player.y = 90.5;
  return { game, vs };
}
function put(vs: VehicleSystem, proto: string, x: number, y: number, facing: number): Vehicle {
  const v = vs.spawn(proto, Math.floor(x), Math.floor(y), 0, facing, { fuel: 100, status: 2, rng: new Rng(7), force: true })!;
  for (const p of v.parts) if (has(p, 'OPENABLE')) p.open = false;
  v.locked = false;
  v.version++;
  return v;
}
const make = (id: string): Vehicle => spawnVehicle(vdata, data, id, { x: 0.5, y: 0.5, z: 0, facing: 0, fuel: -1, status: 0, rng: new Rng(1), items: false });
/** Run the game for `s` seconds holding `keys` (e.g. ['KeyW']). */
function hold(game: Game, keys: string[], s: number): void {
  const held = game.input.held as Set<string>;
  for (const k of keys) held.add(k);
  for (let t = 0; t < s; t += 1 / 30) game.tick(1 / 30);
  for (const k of keys) held.delete(k);
  game.tick(1 / 30);
}

describe('which interior a vehicle gets (from its data)', () => {
  it('cars, pickups and bikes: at the wheel or outside; RVs, buses, vans: a deck; tanks and APCs: crew stations', () => {
    for (const id of ['car', 'suv', 'pickup', 'motorcycle', 'bicycle', 'humvee', 'policecar']) expect([id, cabinKind(make(id))]).toEqual([id, 'wheel']);
    for (const id of ['rv', 'lux_rv', 'bus', 'schoolbus', 'cube_van', 'ambulance']) expect([id, cabinKind(make(id))]).toEqual([id, 'deck']);
    for (const id of ['tank_m1_abrams', 'tank_m60_patton', 'apc', 'ifv_m2_bradley']) expect([id, cabinKind(make(id))]).toEqual([id, 'crew']);
  });

  it('an Abrams has a driver, turret seats and hatches; nothing to stand on', () => {
    const v = make('tank_m1_abrams');
    const st = stationsOf(v);
    const kinds = st.map((s) => s.kind);
    expect(kinds.filter((k) => k === 'driver')).toHaveLength(1);
    expect(kinds).toContain('gunner');
    expect(kinds.filter((k) => k === 'hatch').length).toBeGreaterThanOrEqual(2);
    expect(kinds).not.toContain('deck');
    // the main gun's seat is a gunner station (turret fire will hang off it)
    expect(st.some((s) => s.kind === 'gunner' && v.partsAt(s.mx, s.my).some((p) => p.def.id === 'mounted_tank_manual'))).toBe(true);
  });

  it('an RV has its driver, seats, beds, aisle spots and doors', () => {
    const kinds = new Set(stationsOf(make('rv')).map((s) => s.kind));
    for (const k of ['driver', 'deck', 'bed'] as const) expect([k, kinds.has(k)]).toEqual([k, true]);
    // its outside doors are the ways out of the stations beside them (the cab door by the
    // driver); the internal door and the window curtains aren't exits
    const exits = stationsOf(make('rv')).flatMap((s) => s.exits.map((e) => e.door.def.id));
    expect(exits).toContain('door_front_left');
    expect(exits.some((id) => /internal|curtain/.test(id))).toBe(false);
  });

  it('every station of the road vehicles sits inside the drawn body', () => {
    for (const id of ['car', 'rv', 'bus', 'cube_van', 'pickup']) {
      const v = make(id);
      const b = chassisBodyRect(v)!;
      for (const s of stationsOf(v)) expect([id, s.kind, s.x >= b.x0 && s.x <= b.x1 && s.y >= b.y0 && s.y <= b.y1]).toEqual([id, s.kind, true]);
    }
  });
});

describe('moving between stations', () => {
  it('RV: letting go of the wheel keeps you in the driver seat; W/A/S/D hop down the vehicle; the door gets you out', () => {
    const { game, vs } = world();
    const v = put(vs, 'rv', 40.5, 40.5, 0);
    const c = v.controls()!;
    [game.player.x, game.player.y] = v.mountToWorld(c.mx, c.my);
    expect(vs.takeControls(v).ok).toBe(true);
    vs.releaseControls();
    expect(vs.stations.seatDriver(v)).toBe(true);
    game.tick(1 / 30);
    expect(vs.stations.view()?.station.kind).toBe('driver');
    expect(game.movementOverride?.()).toBe(true);
    // facing east (0 deg); yaw pi/2 looks east, so S walks toward the tail
    game.player.yaw = Math.PI / 2;
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      hold(game, ['KeyS'], 0.9);
      const at = vs.stations.view()!;
      seen.add(at.station.kind);
      expect(vs.playerOn()?.v).toBe(v);
    }
    expect(seen.has('deck')).toBe(true);
    const [lx] = v.worldToMount(game.player.x, game.player.y);
    expect(lx).toBeLessThan(c.mx - 2);
    // to a station by a door, then out with e
    const doors = vs.stations.stations(v).map((s, i) => [s, i] as const).filter(([s]) => s.exits.length && s.kind !== 'driver');
    expect(doors.length).toBeGreaterThan(0);
    vs.stations.enter(v, doors[0][1]);
    const a = vs.stations.action()!;
    expect(a.label).toMatch(/Get out/);
    expect(a.run()).toMatch(/climb out/);
    expect(vs.stations.at).toBeNull();
    expect(vs.playerOn()).toBeNull();
    // and nothing re-boards you standing outside
    game.tick(1 / 30);
    expect(vs.stations.at).toBeNull();
  });

  it("RV: a step toward the driver's door from the driver's seat gets you out through it", () => {
    const { game, vs } = world();
    const v = put(vs, 'rv', 40.5, 40.5, 0);
    vs.stations.seatDriver(v);
    // facing east (0 deg), the driver's door (mount y -1) is to the north: look east, step left
    game.player.yaw = Math.PI / 2;
    hold(game, ['KeyA'], 0.3);
    expect(vs.stations.at).toBeNull();
    expect(vs.playerOn()).toBeNull();
    expect(v.parts.find((p) => p.def.id === 'door_front_left')!.open).toBe(true);
    expect(game.player.y).toBeLessThan(v.mountToWorld(0, -1)[1]);
  });

  it('a hop takes a fraction of a second, not BN seat-cell crawling', () => {
    const { game, vs } = world();
    const v = put(vs, 'bus', 40.5, 40.5, 0);
    vs.stations.seatDriver(v);
    game.player.yaw = Math.PI / 2;
    const held = game.input.held as Set<string>;
    held.add('KeyS');
    const start = vs.stations.at!.i;
    let t = 0;
    while (vs.stations.at!.i === start && t < 2) (game.tick(1 / 30), (t += 1 / 30));
    held.delete('KeyS');
    expect(vs.stations.at!.i).not.toBe(start);
    while (vs.stations.view()!.t < 1 && t < 3) (game.tick(1 / 30), (t += 1 / 30));
    expect(t).toBeLessThan(1);
  });

  it('Abrams: driver -> gunner -> hatch -> out, and the driver seat drives', () => {
    const { game, vs } = world();
    const v = put(vs, 'tank_m1_abrams', 40.5, 40.5, 0);
    expect(vs.stations.seatDriver(v)).toBe(true);
    expect(vs.stations.action()!.label).toMatch(/Drive/);
    // look back toward the turret (facing east: the turret is aft, west)
    game.player.yaw = -Math.PI / 2;
    const kinds: string[] = [];
    for (let i = 0; i < 4 && !kinds.includes('gunner'); i++) {
      hold(game, ['KeyW'], 0.9);
      kinds.push(vs.stations.view()!.station.kind);
    }
    expect(kinds).toContain('gunner');
    const hatch = vs.stations.stations(v).findIndex((s) => s.kind === 'hatch' && s.mx <= -3);
    vs.stations.enter(v, hatch);
    expect(vs.stations.action()!.label).toMatch(/Climb out/);
    expect(vs.stations.getOut()).toMatch(/climb out of the .*hatch/i);
    expect(vs.playerOn()).toBeNull();
    expect(game.map.passable(game.player.tileX, game.player.tileY, 0)).toBe(true);
    // the driver's seat takes the controls
    vs.stations.seatDriver(v);
    expect(vs.stations.action()!.run()).toMatch(/take the controls/);
    expect(vs.driving).toBe(v);
  });

  it('the station you saved at is the one you load at (every Abrams and RV station)', () => {
    for (const proto of ['tank_m1_abrams', 'rv']) {
      const n = (() => {
        const { vs } = world();
        return vs.stations.stations(put(vs, proto, 40.5, 40.5, 30)).length;
      })();
      for (let i = 0; i < n; i++) {
        const a = world();
        const v = put(a.vs, proto, 40.5, 40.5, 30);
        a.vs.stations.enter(v, i);
        a.game.tick(1 / 30);
        const saved = JSON.parse(JSON.stringify(a.vs.toJSON()));
        const b = world();
        b.vs.fromJSON(data, saved);
        // wherever the player section puts you (the nearest-station guess used to decide)
        const back = b.vs.list.find((q) => q.uid === v.uid)!;
        Object.assign(b.game.player, { x: back.x, y: back.y });
        b.game.tick(1 / 30);
        const label = `${proto} station ${i} (${a.vs.stations.current()!.kind})`;
        expect(b.vs.stations.at?.v.uid, label).toBe(v.uid);
        expect(b.vs.stations.at?.i, label).toBe(i);
      }
    }
  });

  it('car: W/A/S/D at a seat do nothing but hint; e gets out', () => {
    const { game, vs } = world();
    const v = put(vs, 'car', 40.5, 40.5, 0);
    const said: string[] = [];
    const msg = game.message.bind(game);
    game.message = (t: string, c?: string) => (said.push(t), msg(t, c));
    vs.stations.seatDriver(v);
    const at = vs.stations.at!.i;
    hold(game, ['KeyW'], 0.5);
    expect(vs.stations.at!.i).toBe(at);
    expect(said.join('|')).toMatch(/sitting in the Car/);
    expect(vs.stations.action()!.run()).toMatch(/climb out/);
    expect(vs.playerOn()).toBeNull();
  });

  it('walking in through an open car door puts you at the wheel', () => {
    const { game, vs } = world();
    const v = put(vs, 'car', 40.5, 40.5, 0);
    const c = v.controls()!;
    const door = v.parts.find((p) => has(p, 'OPENABLE') && Math.abs(p.mx - c.mx) + Math.abs(p.my - c.my) <= 1)!;
    door.open = true;
    v.version++;
    // stand just outside the driver's door, walk in
    const b = chassisBodyRect(v)!;
    const side = door.my < 0 ? b.y0 - 0.5 : b.y1 + 0.5;
    [game.player.x, game.player.y] = v.mountToWorld(door.mx, side);
    game.tick(1 / 30);
    expect(vs.driving).toBeNull();
    [game.player.x, game.player.y] = v.mountToWorld(door.mx, door.my < 0 ? b.y0 + 0.3 : b.y1 - 0.3);
    game.tick(1 / 30);
    expect(vs.driving).toBe(v);
  });

  it('free walk (the fallback) never seats you', () => {
    const { game, vs } = world();
    vs.stations.mode = 'free';
    const v = put(vs, 'rv', 40.5, 40.5, 0);
    const c = v.controls()!;
    [game.player.x, game.player.y] = v.mountToWorld(c.mx, c.my);
    game.tick(1 / 30);
    expect(vs.stations.at).toBeNull();
    expect(game.movementOverride?.() ?? false).toBe(false);
  });
});

describe('crew roles (station panel names)', () => {
  it('names the Abrams crew by gun, and tells two hatches by one seat apart', () => {
    const { vs } = world();
    const v = vs.spawn('tank_m1_abrams', 10, 10, 0, 0, { fuel: 100, status: 2, rng: new Rng(7) })!;
    const list = stationsOf(v, 'crew');
    const titles = list.map((s) => stationRole(v, s, list).title);
    expect(titles).toContain('Driver');
    expect(titles.some((t) => /^Gunner \(120mm tank gun\)$/.test(t))).toBe(true);
    expect(titles.some((t) => /^Commander \(/.test(t))).toBe(true);
    expect(titles.filter((t) => /hatch/.test(t)).length).toBeGreaterThanOrEqual(2);
    // every station has its own name: you can always tell where you are
    expect(new Set(titles).size).toBe(titles.length);
  });
});
