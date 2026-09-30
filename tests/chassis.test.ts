// Vehicles v3 phase 1 (docs/design/VEHICLES_V3.md, docs/VEHICLES.md "v3 phase 1"): every BN
// vehicle maps onto a chassis template, nothing is lost doing it (parts, their state, cargo),
// the template's body is a sane collision body, seats are reachable, pre-v3 saves migrate,
// and gameplay (crash sides, seating, stairs) reads from the template.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import {
  chassisBodyRect, chassisOf, chassisSeats, hitMount, layoutOf, mapChassis, pickTemplate, SOCKET_KINDS, SOCKET_LOCATIONS, FITTING_LOCATIONS, TEMPLATES, TEMPLATE_IDS, type TemplateId,
} from '../src/game/chassis';
import { census, L } from '../src/game/moves';
import { has, spawnVehicle, Vehicle, type VehicleJSON } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { GET_IN_RANGE, registerVehicleSave, VehicleSystem, type VehicleSaveJSON } from '../src/game/vehicles';
import { saveRegistry } from '../src/save/registry';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { loadNodeData } from '../tools/lib/node_data';

let data: GameData;
let vdata: VehicleDataFile;
beforeAll(() => {
  data = loadNodeData().game;
  vdata = JSON.parse(readFileSync(resolve('public/data/vehicles.json'), 'utf8'));
});

const make = (id: string, status = 0, seed = 1, items = false): Vehicle => spawnVehicle(vdata, data, id, { x: 0.5, y: 0.5, z: 0, facing: 0, fuel: -1, status, rng: new Rng(seed), items });
const ids = () => Object.keys(vdata.vehicles);
const cargoLocs = (v: Vehicle) => v.parts.filter((p) => has(p, 'CARGO')).map((p) => L.cargo(p));
/** Everything about a part that must survive mapping and migration. */
const partState = (v: Vehicle) => v.parts.map((p) => [p.def.id, p.mx, p.my, p.variant ?? '', p.hp, p.open, p.enabled, p.fuelType ?? '', p.charges, !!p.fault, p.blood, p.items.length].join('|'));

describe('templates', () => {
  it('are a ladder with real-scale promises, sockets that take BN locations', () => {
    expect(TEMPLATE_IDS).toContain('rig');
    for (const id of TEMPLATE_IDS) {
      const t = TEMPLATES[id];
      expect(t.id).toBe(id);
      expect(t.cols[0]).toBeLessThanOrEqual(t.cols[1]);
      expect(t.rows[0]).toBeLessThanOrEqual(t.rows[1]);
      if (t.family === 'frame') expect(t.length).toBeNull();
      else expect(t.length![0]).toBeLessThan(t.length![1]);
    }
    for (const k of SOCKET_KINDS) expect(SOCKET_LOCATIONS[k].length).toBeGreaterThan(0);
    // every location a BN part uses is taken by some socket kind or rides along as a fitting
    const known = new Set([...SOCKET_KINDS.flatMap((k) => SOCKET_LOCATIONS[k]), ...FITTING_LOCATIONS, 'engine_block', 'axle', 'roof', 'on_roof', 'on_ceiling']);
    for (const p of Object.values(vdata.parts)) expect([p.id, known.has(p.location ?? '')]).toEqual([p.id, true]);
  });
});

describe('mapping every BN vehicle', () => {
  it('maps all 257 prototypes onto a template, with every part in exactly one socket or the overflow', () => {
    expect(ids().length).toBe(257);
    const counts: Partial<Record<TemplateId, number>> = {};
    let overflow = 0;
    for (const id of ids()) {
      const v = make(id);
      const ch = chassisOf(v);
      expect(TEMPLATES[ch.template]).toBeDefined();
      counts[ch.template] = (counts[ch.template] ?? 0) + 1;
      const placed = ch.sockets.flatMap((s) => s.parts);
      const all = [...placed, ...ch.overflow.map((o) => o.part)];
      // the same part objects, each once
      expect([id, all.length]).toEqual([id, v.parts.length]);
      expect(new Set(all).size).toBe(v.parts.length);
      for (const p of v.parts) expect(all).toContain(p);
      for (const s of ch.sockets) for (const p of s.parts) expect(ch.socketOf.get(p)).toBe(s);
      overflow += ch.overflow.length;
    }
    // stock BN vehicles fit their templates (overflow is for odd builds, tested below)
    expect(overflow).toBe(0);
    for (const t of ['sedan', 'suv', 'pickup', 'box_truck', 'bus', 'motorcycle', 'bicycle', 'frame'] as TemplateId[]) expect(counts[t]).toBeGreaterThan(0);
  });

  it('puts the familiar vehicles on the familiar rungs', () => {
    const want: Record<string, TemplateId> = {
      car: 'sedan', sedan: 'sedan', policecar: 'sedan', car_sports: 'sports', car_hatch: 'hatch', suv: 'suv', humvee: 'suv', pickup: 'pickup',
      hippie_van: 'minivan', animalctrl: 'van', cube_van: 'box_truck', ambulance: 'box_truck', rv: 'box_truck', bus: 'bus', schoolbus: 'bus',
      semi_truck: 'semi_cab', fire_engine: 'heavy_truck', flatbed_truck: 'heavy_truck', truck_trailer: 'trailer', afs_gas_tanker: 'trailer',
      motorcycle: 'motorcycle', scooter: 'scooter', bicycle: 'bicycle', golf_cart: 'frame', tractor_plow: 'frame', shopping_cart: 'frame_small',
      apc: 'frame_tracked', tank_m1_abrams: 'frame_tracked', kayak: 'frame_boat', helicopter_apache_1a: 'frame_air', motorcycle_plane: 'frame_air',
    };
    for (const [id, t] of Object.entries(want)) expect([id, chassisOf(make(id)).template]).toEqual([id, t]);
  });

  it('gives every shaped template a sane collision body inside its promise and its grid', () => {
    for (const id of ids()) {
      const v = make(id);
      const ch = chassisOf(v);
      const t = TEMPLATES[ch.template];
      const b = chassisBodyRect(v);
      if (t.family === 'frame') {
        expect([id, b]).toEqual([id, null]);
        continue;
      }
      expect([id, b]).not.toEqual([id, null]);
      const len = b!.x1 - b!.x0, wid = b!.y1 - b!.y0;
      for (const n of [b!.x0, b!.x1, b!.y0, b!.y1]) expect(Number.isFinite(n)).toBe(true);
      expect([id, len >= t.length![0] - 1e-9 && len <= t.length![1] + 1e-9]).toEqual([id, true]);
      expect([id, wid >= t.width![0] - 1e-9 && wid <= t.width![1] + 1e-9]).toEqual([id, true]);
      const [x0, y0, x1, y1] = v.bounds();
      // never bigger than the grid (the grid is what mapgen checked for room)
      expect(b!.x0).toBeGreaterThanOrEqual(x0 - 0.5 - 1e-9);
      expect(b!.x1).toBeLessThanOrEqual(x1 + 0.5 + 1e-9);
      expect(b!.y0).toBeGreaterThanOrEqual(y0 - 0.5 - 1e-9);
      expect(b!.y1).toBeLessThanOrEqual(y1 + 0.5 + 1e-9);
    }
  });

  it('places every seat inside its own cell and the body, and each is reachable from outside', () => {
    const unreachable: string[] = [];
    for (const id of ids()) {
      const v = make(id);
      const seats = chassisSeats(v);
      const b = chassisBodyRect(v);
      for (const s of seats) {
        expect(Math.abs(s.x - s.mx)).toBeLessThanOrEqual(0.5 + 1e-9);
        expect(Math.abs(s.y - s.my)).toBeLessThanOrEqual(0.5 + 1e-9);
        if (b) expect([id, s.x >= b.x0 && s.x <= b.x1 && s.y >= b.y0 && s.y <= b.y1]).toEqual([id, true]);
        expect(s.h).toBeGreaterThan(0.2);
        expect(s.h).toBeLessThan(1.6);
      }
      // Walk in: open every door, enter from any edge cell you can step onto, move between
      // cells that don't block (BN move cost > 0).
      for (const p of v.parts) if (has(p, 'OPENABLE')) p.open = true;
      const cells = new Map<string, [number, number]>();
      for (const p of v.parts) cells.set(`${p.mx},${p.my}`, [p.mx, p.my]);
      const open = (mx: number, my: number) => v.moveCostAt(mx, my) > 0;
      const N = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const seen = new Set<string>();
      const queue: [number, number][] = [];
      for (const [k, [mx, my]] of cells) if (open(mx, my) && N.some(([dx, dy]) => !cells.has(`${mx + dx},${my + dy}`))) (seen.add(k), queue.push([mx, my]));
      while (queue.length) {
        const [mx, my] = queue.shift()!;
        for (const [dx, dy] of N) {
          const k = `${mx + dx},${my + dy}`;
          if (!cells.has(k) || seen.has(k) || !open(mx + dx, my + dy)) continue;
          seen.add(k);
          queue.push([mx + dx, my + dy]);
        }
      }
      for (const s of seats) {
        if (seen.has(`${s.mx},${s.my}`)) continue;
        // The driver's seat is also boarded from beside the vehicle (VehicleSystem.getInReason:
        // within GET_IN_RANGE of it): some BN grids wall every seat in (the bubble car).
        const [x0, y0, x1, y1] = v.bounds();
        const outside = Math.min(s.x - (x0 - 0.5), x1 + 0.5 - s.x, s.y - (y0 - 0.5), y1 + 0.5 - s.y) + 0.3;
        if (s.driver && outside <= GET_IN_RANGE) continue;
        unreachable.push(`${id}@${s.mx},${s.my}${s.driver ? ' (driver)' : ''}`);
      }
    }
    // Drivers can always get in; passengers of the vehicles on the roads can walk to their seat.
    // (BN's F-15's canopy doors open onto its wings, which block: sealed in BN too.)
    expect(unreachable.filter((u) => /driver/.test(u))).toEqual(['plane_f15e_eagle@-2,0 (driver)']);
    const road = ['car', 'sedan', 'suv', 'pickup', 'cube_van', 'ambulance', 'hippie_van', 'bus', 'schoolbus', 'policecar', 'semi_truck', 'motorcycle', 'bicycle', 'rv', 'fire_engine'];
    expect(unreachable.filter((u) => road.includes(u.split('@')[0]))).toEqual([]);
    // What's left is BN's own data: rooms without doors (surv_rv / bus_tour beds, the bubble
    // car's canopy); docs/VEHICLES.md lists them.
    console.info(`[chassis] seats BN walls in: ${unreachable.join(' ')}`);
  });

  it('conserves every part, its state and every cargo item through mapping and a save round trip', () => {
    for (const id of ids()) {
      for (const status of [-1, 1]) {
        const v = make(id, status, 7, true);
        const before = partState(v);
        const items = census(cargoLocs(v));
        chassisOf(v);
        layoutOf(v);
        expect(partState(v)).toEqual(before);
        const j: VehicleJSON = JSON.parse(JSON.stringify(v.toJSON()));
        expect(j.chassis?.template).toBe(v.template);
        const back = Vehicle.fromJSON(vdata, data, j);
        expect(back.template).toBe(v.template);
        expect(chassisOf(back).template).toBe(v.template);
        expect([id, partState(back)]).toEqual([id, before]);
        const after = census(cargoLocs(back));
        expect(after.aliased).toEqual([]);
        expect([id, [...after.counts].sort()]).toEqual([id, [...items.counts].sort()]);
      }
    }
  });

  it('keeps parts a template has no socket for, working, in an explicit overflow', () => {
    const v = make('car');
    expect(chassisOf(v).template).toBe('sedan');
    const engines = v.engines.length;
    // installed later (the template is kept): an engine in the trunk (BN would allow it; a
    // sedan's bay is under the bonnet) and a ram welded two columns off the side
    const extra = v.addPart(vdata.parts.engine_v8, -2, 0);
    const off = v.addPart(vdata.parts.ram_steel, 0, 4);
    const ch = chassisOf(v);
    expect(ch.overflow.map((o) => o.part)).toEqual([extra, off]);
    expect(ch.overflow[0].reason).toMatch(/engine bay/);
    expect(ch.overflow[1].reason).toMatch(/off the sedan body/);
    // still installed, still counted by BN's rules
    expect(v.parts).toContain(extra);
    expect(v.engines.length).toBe(engines + 1);
    // the frame family has room for anything: forced onto it, nothing overflows
    expect(mapChassis(v, 'frame').overflow).toEqual([]);
  });

  it('falls back to the frame family for grids outside the named template, and can put a long grid on the rig', () => {
    const v = make('golf_cart');
    expect(pickTemplate(v).template).toBe('frame');
    const rig = make('flatbed_truck');
    const ch = mapChassis(rig, 'rig');
    expect(ch.overflow).toEqual([]);
    rig.template = 'rig';
    const b = chassisBodyRect(rig)!;
    expect(b.x1 - b.x0).toBeGreaterThan(TEMPLATES.rig.length![0]);
    expect(layoutOf(rig).sections.length).toBeGreaterThan(0);
  });
});

// --- gameplay reads from the template --------------------------------------------------------

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

describe('gameplay on the template', () => {
  it('maps vehicles as they enter the world (spawns)', () => {
    const { vs } = world();
    const v = put(vs, 'pickup', 20.5, 20.5, 0);
    expect(v.template).toBe('pickup');
    expect(v.chassis?.template).toBe('pickup');
  });

  it('a hit on a side lands on that side\'s panel socket (a front-quarter hit dents the front door)', () => {
    const v = make('car');
    const b = chassisBodyRect(v)!;
    const doorFL = v.parts.find((p) => p.def.id === 'door_front_left')!;
    const L = layoutOf(v);
    // the left side, level with the front door's drawn middle
    const [mx, my] = hitMount(v, L.xOf(doorFL.mx), b.y0);
    expect([mx, my]).toEqual([doorFL.mx, doorFL.my]);
    // square on the nose, middle: the nose row
    const [nx] = hitMount(v, b.x1, (b.y0 + b.y1) / 2);
    expect(nx).toBe(v.bounds()[2]);
    // the tail: the rear row (trunk lid)
    const [tx, ty] = hitMount(v, b.x0, (b.y0 + b.y1) / 2);
    expect(v.partsAt(tx, ty).some((p) => p.def.id === 'door_trunk')).toBe(true);
  });

  it('seats the driver on the drawn seat', () => {
    const { game, vs } = world();
    const v = put(vs, 'bus', 40.5, 40.5, 0);
    const c = v.controls()!;
    [game.player.x, game.player.y] = v.mountToWorld(c.mx, c.my);
    expect(vs.takeControls(v).ok).toBe(true);
    const seat = chassisSeats(v).find((s) => s.driver)!;
    const [wx, wy] = v.mountToWorld(seat.x, seat.y);
    expect(game.player.x).toBeCloseTo(wx, 9);
    expect(game.player.y).toBeCloseTo(wy, 9);
    expect(vs.playerOn()?.v).toBe(v);
  });

  it('stair flights (another overlay walling tiles off for walkers) stop vehicles, and spawns avoid them', () => {
    for (const shaped of [true, false]) {
      const { game, vs } = world();
      if (!shaped) vs.bodyShape = null;
      // a flight's footprint, as src/game/stairwalk.ts marks it: move cost 0 for walkers
      const flight = new Set(['60,20', '60,21', '61,20', '61,21']);
      game.map.overlays.push({ moveCost: (x, y, z) => (z === 0 && flight.has(`${x},${y}`) ? 0 : undefined) });
      const v = put(vs, 'car', 50.5, 20.5, 0);
      const c = v.controls()!;
      [game.player.x, game.player.y] = v.mountToWorld(c.mx, c.my);
      expect(vs.takeControls(v).ok).toBe(true);
      expect(vs.startEngine(v).ok).toBe(true);
      v.velocity = 6;
      for (let i = 0; i < 90; i++) game.tick(1 / 30);
      expect(v.velocity).toBe(0);
      // stopped short of the flight: the template's nose at its edge, or (whole tiles) no
      // grid tile on it (CDDA tiles: a cell holds a tile when it holds the tile's centre)
      if (shaped) {
        const nose = v.mountToWorld(chassisBodyRect(v)!.x1, 0)[0];
        expect(nose).toBeLessThanOrEqual(60 + 1e-6);
        expect(nose).toBeGreaterThan(59.9);
      } else {
        expect(v.occupiedTiles().some((t) => flight.has(`${t.tx},${t.ty}`))).toBe(false);
        expect(v.mountToWorld(v.bounds()[2], 0)[0]).toBeGreaterThan(59);
      }
      // and mapgen can't drop a car on it
      expect(vs.spawn('car', 60, 21, 0, 0)).toBeNull();
    }
  });
});

// --- save migration ----------------------------------------------------------------------------

describe('save migration (pre-v3 grids)', () => {
  it('maps a pre-v3 save onto templates once, losing nothing, and saves the templates', () => {
    const fixture: VehicleSaveJSON = JSON.parse(readFileSync(resolve('tests/fixtures/vehicles_pre_v3.json'), 'utf8'));
    expect(fixture.vehicles.every((v) => v.chassis === undefined)).toBe(true);
    const { game, vs } = world();
    registerVehicleSave(game, vs);
    const entry = saveRegistry(game).sorted().find(([k]) => k === 'vehicles')![1];
    const warnings: string[] = [];
    const ctx = { game, data, version: 1, warn: (m: string) => warnings.push(m) };
    entry.load(JSON.parse(JSON.stringify(fixture)), ctx);
    expect(warnings).toEqual([]);
    expect(vs.migrated).toBe(fixture.vehicles.length);
    expect(vs.list.map((v) => v.template)).toEqual(['sedan', 'pickup', 'box_truck', 'bus', 'motorcycle', 'frame', 'frame_tracked', 'semi_cab']);
    expect(vs.driving?.uid).toBe(fixture.driving);
    // every part and its state, every cargo item
    for (const [i, vj] of fixture.vehicles.entries()) {
      const v = vs.list[i];
      expect(v.parts.map((p) => [p.def.id, p.mx, p.my, p.hp, p.charges, !!p.open, !!p.fault])).toEqual(vj.parts.map((p) => [p.id, p.mx, p.my, p.hp, p.charges ?? 0, !!p.open, !!p.fault]));
      expect(v.parts.map((p) => p.items.map((it) => it.typeId).join(','))).toEqual(vj.parts.map((p) => (p.items ?? []).map((it) => it.typeId).join(',')));
    }
    expect(vs.list.reduce((a, v) => a + v.parts.reduce((b, p) => b + p.items.length, 0), 0)).toBeGreaterThan(0);
    // saved again: templates written, and a reload is no migration
    const saved = JSON.parse(JSON.stringify(entry.save())) as VehicleSaveJSON;
    expect(saved.vehicles.map((v) => v.chassis?.template)).toEqual(vs.list.map((v) => v.template));
    expect(saved.vehicles.every((v) => v.chassis?.v === 1)).toBe(true);
    entry.load(saved, ctx);
    expect(vs.migrated).toBe(0);
    expect(vs.list.map((v) => v.template)).toEqual(['sedan', 'pickup', 'box_truck', 'bus', 'motorcycle', 'frame', 'frame_tracked', 'semi_cab']);
  });

  it('keeps a saved template over what the grid would pick (a stripped car stays a car)', () => {
    const v = make('car');
    const j = v.toJSON();
    j.chassis = { template: 'hatch', v: 1 };
    // outside the hatch's envelope (4-5 rows) but it's the vehicle's body now: kept
    const back = Vehicle.fromJSON(vdata, data, j);
    expect(chassisOf(back).template).toBe('hatch');
    expect(chassisOf(back).why).toBe('saved');
    expect(chassisBodyRect(back)).not.toBeNull();
    // stripped to its frames (as saved): still a hatch, every part placed
    const bare = Vehicle.fromJSON(vdata, data, { ...j, parts: j.parts.filter((p) => vdata.parts[p.id].location === 'structure') });
    const ch = chassisOf(bare);
    expect(ch.template).toBe('hatch');
    expect(ch.sockets.flatMap((s) => s.parts).length + ch.overflow.length).toBe(bare.parts.length);
    expect(chassisBodyRect(bare)).not.toBeNull();
  });

  it('refuses chassis data from a newer build, and re-maps unknown templates with a warning', () => {
    const j = make('car').toJSON();
    j.chassis = { template: 'sedan', v: 99 };
    expect(() => Vehicle.fromJSON(vdata, data, j)).toThrow(/newer/);
    j.chassis = { template: 'hovertank', v: 1 };
    const warn: string[] = [];
    const back = Vehicle.fromJSON(vdata, data, j, { warn: (m) => warn.push(m) });
    expect(warn.join()).toMatch(/hovertank/);
    expect(chassisOf(back).template).toBe('sedan');
  });
});
