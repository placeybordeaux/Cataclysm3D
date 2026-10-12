import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bodyShapeOf } from '../src/render/chars/archetype';
import { HUM, makeRig } from '../src/render/chars/rig';
import { CharLayer } from '../src/render/chars/charLayer';
import { rimGrips } from '../src/render/vehicleRider';
import { GRIP_TURN_MAX } from '../src/render/vehicleCockpit';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { spawnVehicle, type Vehicle } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { analyze, classify, setVehicleWidth, wheelRadius } from '../src/render/vehicleLayout';
import { buildOutline, buildVehicleModel, parkedSteerAngle } from '../src/render/vehicleModel';
import { armourHull } from '../src/render/vehicleTank';
import { isCompactor } from '../src/render/vehicleRoller';
import { workMachine } from '../src/render/vehicleWork';
import { isDrum, isTrack, wheelRuns } from '../src/render/vehicleFrame';
import { paintSkin, SKIN_PPM, skinLayout, skinLayoutInfo } from '../src/render/vehicleSkin';
import { loadNodeData } from '../tools/lib/node_data';

let data: GameData;
let vdata: VehicleDataFile;

beforeAll(() => {
  data = loadNodeData().game;
  vdata = JSON.parse(readFileSync(resolve('public/data/vehicles.json'), 'utf8'));
});

const make = (id: string, status = 0, seed = 1): Vehicle => spawnVehicle(vdata, data, id, { x: 0.5, y: 0.5, z: 0, facing: 0, fuel: 50, status, rng: new Rng(seed) });

/** Bounds of a geometry; `aboveY` skips vertices lower than it (debris lying on the road). */
function bounds(g: THREE.BufferGeometry, aboveY = -Infinity): { min: number[]; max: number[] } {
  const pos = g.getAttribute('position');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.count; i++)
    for (let k = 0; k < 3; k++) {
      if (pos.getY(i) < aboveY) continue;
      const v = pos.getComponent(i, k);
      expect(Number.isFinite(v)).toBe(true);
      min[k] = Math.min(min[k], v);
      max[k] = Math.max(max[k], v);
    }
  return { min, max };
}

describe('vehicle model: classification', () => {
  it('maps common prototypes to body styles', () => {
    const want: Record<string, string> = {
      car: 'sedan', sedan: 'sedan', car_sports: 'sports', suv: 'suv', pickup: 'pickup', cube_van: 'van', ambulance: 'van',
      policecar: 'sedan', bus: 'bus', schoolbus: 'bus', semi_truck: 'truck', motorcycle: 'motorcycle', bicycle: 'bicycle',
      hippie_van: 'minivan', car_hatch: 'hatch', humvee: 'suv', shopping_cart: 'frame', '2seater2': 'frame',
    };
    for (const [id, style] of Object.entries(want)) expect([id, classify(make(id))]).toEqual([id, style]);
  });

  it('splits a sedan into hood / windscreen / cabin / rear glass / trunk', () => {
    const L = analyze(make('sedan'));
    expect(L.sections.map((s) => s.kind)).toEqual(['hood', 'shield', 'cabin', 'rearglass', 'deck']);
    expect(L.xCowl).toBeCloseTo(L.xOf(1.5), 9);
    // BN grids run long: a 6-row sedan is drawn ~5.6 m, not 6
    expect(L.xNose - L.xTail).toBeLessThan(5.7);
    expect(L.xNose - L.xTail).toBeGreaterThan(5.3);
  });

  it('gives a pickup an open bed behind the cab and a box van its box', () => {
    expect(analyze(make('pickup')).sections.map((s) => s.kind)).toEqual(['hood', 'shield', 'cabin', 'rearglass', 'bed']);
    expect(analyze(make('cube_van')).sections.map((s) => s.kind)).toEqual(['hood', 'shield', 'cabin', 'box']);
  });

  it('keeps seats inside their own grid tiles when the width is squeezed', () => {
    for (const id of ['car', 'suv', 'cube_van', 'bus', 'semi_truck', 'pickup']) {
      const v = make(id);
      const L = analyze(v);
      for (const p of v.parts.filter((q) => q.def.flags.includes('SEAT'))) expect(Math.abs(L.zOf(p.my) - p.my)).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(L.hw * 2).toBeLessThan(L.rows[0].cols.length + 0.01);
    }
  });

  it("'fill' width draws bodies near the grid footprint, 'real' squeezes them", () => {
    const v = make('car');
    const real = analyze(v).hw;
    setVehicleWidth('fill');
    try {
      expect(analyze(v).hw).toBeCloseTo(4 / 2 - 0.3, 5);
    } finally {
      setVehicleWidth('real');
    }
    expect(real * 2).toBeLessThan(2.8);
  });

  it('sizes wheels from BN cm rims (a 42.5 cm car rim is a ~0.65 m tyre, not 1.4 m)', () => {
    const car = make('car');
    const w = car.wheels[0];
    expect(w.def.wheel?.diameter).toBe(42.5);
    expect(wheelRadius(w) * 2).toBeGreaterThan(0.6);
    expect(wheelRadius(w) * 2).toBeLessThan(0.7);
    const bike = make('bicycle').wheels[0];
    // bicycle "diameter" (67.5) is the whole wheel
    expect(wheelRadius(bike) * 2).toBeCloseTo(0.675, 2);
  });
});

describe('vehicle model: geometry', () => {
  const ids = ['car', 'sedan', 'car_sports', 'suv', 'pickup', 'cube_van', 'ambulance', 'policecar', 'bus', 'schoolbus', 'semi_truck', 'hippie_van', 'car_hatch', 'humvee', 'flatbed_truck', 'rv', 'fire_truck', 'limousine', 'beetle', 'muscle_car', 'jltv', 'motorcycle', 'bicycle', 'motorcycle_sidecart', 'scooter'];
  for (const id of ids)
    it(`builds ${id} within its footprint`, () => {
      for (const status of [0, 1]) {
        const v = make(id, status, 7);
        const m = buildVehicleModel(v, 0);
        expect(m).not.toBeNull();
        const [x0, y0, x1, y1] = v.bounds();
        const bodyish = [m!.body, m!.roof, m!.parts].filter((g): g is THREE.BufferGeometry => !!g);
        expect(bodyish.length).toBeGreaterThan(0);
        // open doors swing out past the side (and a bit forward); otherwise mirrors may poke
        // out a little past the side columns and nothing leaves the grid
        const doorSlack = v.parts.some((p) => p.open && p.my !== Math.round((y0 + y1) / 2)) ? 1.3 : 0;
        for (const g of bodyish) {
          // glass on the road and a burnt wreck's scorch lie beyond the body
          const b = bounds(g, 0.03);
          expect(b.min[0]).toBeGreaterThan(x0 - 0.5 - 0.1);
          expect(b.max[0]).toBeLessThan(x1 + 0.5 + 0.1 + doorSlack * 0.3);
          expect(b.min[2]).toBeGreaterThan(y0 - 0.5 - 0.3 - doorSlack);
          expect(b.max[2]).toBeLessThan(y1 + 0.5 + 0.3 + doorSlack);
          expect(b.min[1]).toBeGreaterThan(-0.05);
          // under a z-level (2.6 m)
          expect(b.max[1]).toBeLessThan(2.95);
        }
      }
    });

  it('builds every prototype without NaNs or exceptions (or declines it)', () => {
    let built = 0;
    for (const id of Object.keys(vdata.vehicles)) {
      for (const status of [0, 1]) {
        const v = make(id, status, 3);
        if (!v.parts.length) continue;
        const m = buildVehicleModel(v, 0);
        if (!m) continue;
        built++;
        for (const g of [m.body, m.roof, m.parts, m.glass, m.lamps, m.tails, m.beacons]) if (g) bounds(g);
      }
    }
    expect(built).toBeGreaterThan(150);
  }, 60_000);

  it('draws odd grids as a tidy frame, every part on its own tile', () => {
    for (const id of ['shopping_cart', 'golf_cart', 'food_cart', 'car_chassis']) {
      const v = make(id);
      const m = buildVehicleModel(v, 0)!;
      expect([id, m.bodyUsesParts]).toEqual([id, true]);
      const b = bounds(m.parts!);
      const [x0, y0, x1, y1] = v.bounds();
      expect(b.min[2]).toBeGreaterThan(y0 - 0.6);
      expect(b.max[2]).toBeLessThan(y1 + 0.6);
      expect(b.max[0]).toBeLessThan(x1 + 1.5); // turret barrels reach forward
      expect(b.min[0]).toBeGreaterThan(x0 - 0.6);
    }
  });

  it('draws armoured hulls as tanks / APCs: tracks, turret and gun from the parts', () => {
    const want: Record<string, [string, string | null]> = {
      tank_m1_abrams: ['tracks', 'mbt'], tank_m60_patton: ['tracks', 'mbt'], tank_m60_patton_mothballed: ['tracks', 'mbt'],
      tank_m60_patton_decoy: ['none', 'mbt'], howitzer_m109: ['tracks', 'box'], tank_xm7_elec: ['tracks', 'mbt'],
      ifv_m2_bradley: ['tracks', 'ifv'], apc: ['tracks', null], 'aapc-mg': ['wheels', null], xapc_hover: ['hover', null], tank_xm_hover: ['hover', 'mbt'],
    };
    for (const [id, [gear, turret]] of Object.entries(want)) expect([id, armourHull(make(id))]).toEqual([id, { gear, turret }]);
    // tractors on treads, armoured boats and helicopters stay frames
    for (const id of ['tractor_heavy_plow', 'tractor_bandit', 'excavator', 'CG_cutter', 'helicopter_apache_1a', 'hovercraft_motor_single']) expect([id, armourHull(make(id))]).toEqual([id, null]);
    for (const status of [0, 1]) {
      const v = make('tank_m1_abrams', status, 5);
      const m = buildVehicleModel(v, 0)!;
      expect(m.bodyUsesParts).toBe(true);
      // The turret, its gun and the MGs are separate geometry around their pivots (they traverse
      // and elevate, vehicleMesh.ts): put them back where they sit at rest and bound it all.
      expect(m.turrets).toHaveLength(1);
      const t = m.turrets![0];
      expect(t.part?.def.id).toBe('mounted_tank_manual');
      expect(t.mgs.map((g) => g.part.def.id).sort()).toEqual(['mounted_browning', 'mounted_m240']);
      const at = (g: THREE.BufferGeometry | null, ...offs: number[][]) => {
        if (!g) return null;
        const b = bounds(g), o = [0, 1, 2].map((k) => offs.reduce((a, d) => a + d[k], 0));
        return { min: b.min.map((x, k) => x + o[k]), max: b.max.map((x, k) => x + o[k]) };
      };
      const gun = at(t.gun!.geo, t.pivot, t.gun!.pivot)!;
      const all = [bounds(m.parts!), at(t.geo, t.pivot), gun, ...t.mgs.map((g) => at(g.geo, t.pivot, g.onTurret ? g.pivot : [-t.pivot[0], -t.pivot[1], -t.pivot[2]].map((x, k) => x + g.pivot[k])))].filter((x): x is { min: number[]; max: number[] } => !!x);
      const b = { min: [0, 1, 2].map((k) => Math.min(...all.map((q) => q.min[k]))), max: [0, 1, 2].map((k) => Math.max(...all.map((q) => q.max[k]))) };
      const [x0, y0, x1, y1] = v.bounds();
      expect(b.min[2]).toBeGreaterThan(y0 - 0.75);
      expect(b.max[2]).toBeLessThan(y1 + 0.75);
      expect(b.min[0]).toBeGreaterThan(x0 - 0.6);
      // the 120 mm gun (on the turret, laid straight ahead) projects well past the bow; the hull itself stops at the grid
      if (status === 0) expect(gun.max[0]).toBeGreaterThan(x1 + 2);
      expect(b.max[0]).toBeLessThan(x1 + 4);
      expect(bounds(m.parts!).max[0]).toBeLessThan(x1 + 0.6);
      // the barrel's muzzle is `len` ahead of its trunnion
      if (status === 0) expect(t.pivot[0] + t.gun!.pivot[0] + t.gun!.len).toBeCloseTo(gun.max[0], 0);
      expect(b.min[1]).toBeGreaterThan(-0.05);
      expect(b.max[1]).toBeLessThan(2.95);
    }
  });

  it('draws a road roller with one drum per run of drum cells, inside its grid', () => {
    const v = make('road_roller');
    expect(isCompactor(v)).toBe(true);
    expect(wheelRuns(v.wheels.filter(isDrum), 'y').map((r) => [r.at, r.lo, r.hi])).toEqual(expect.arrayContaining([[2, -2, 2], [-3, -2, 2]]));
    const m = buildVehicleModel(v, 0)!;
    expect(m.bodyUsesParts).toBe(true);
    expect(m.ride?.kind).toBe('seat');
    const b = bounds(m.parts!);
    const [x0, y0, x1, y1] = v.bounds();
    expect(b.min[0]).toBeGreaterThan(x0 - 0.6);
    expect(b.max[0]).toBeLessThan(x1 + 0.6);
    expect(b.min[2]).toBeGreaterThan(y0 - 0.6);
    expect(b.max[2]).toBeLessThan(y1 + 0.6);
    expect(b.max[1]).toBeLessThan(2.95);
    // nothing else in BN rolls on drums; treads on tractors are tracks, not drums
    expect(isCompactor(make('tractor_heavy_plow'))).toBe(false);
    expect(make('tractor_heavy_plow').wheels.every(isTrack)).toBe(true);
  });

  it('draws construction and farm machines from their tool parts (vehicleWork.ts)', () => {
    const want: Record<string, [string, string]> = {
      excavator: ['excavator', 'tracks'], trencher: ['trencher', 'wheels'], roadheader_mining: ['roadheader', 'tracks'],
      tractor_bandit: ['dozer', 'tracks'], forklift: ['forklift', 'wheels'], engine_crane: ['hoist', 'wheels'], handjack: ['hoist', 'wheels'],
      tractor_plow: ['tractor', 'wheels'], tractor_reaper: ['tractor', 'wheels'], tractor_seed: ['tractor', 'wheels'], oldtractor: ['tractor', 'wheels'],
      autotractor: ['tractor', 'wheels'], tractor_heavy_plow: ['tractor', 'tracks'], tractor_heavy_seed: ['tractor', 'tracks'],
      tractor_heavy_reaper: ['tractor', 'tracks'], autosweeper: ['sweeper', 'wheels'],
    };
    for (const [id, [kind, gear]] of Object.entries(want)) expect([id, workMachine(make(id))]).toEqual([id, { kind, gear }]);
    // carts, wagons, tanks, boats (the water sweeper's SCOOP), aircraft and trains stay what they were
    for (const id of ['golf_cart', 'shopping_cart', 'dogsled', 'covered_wagon', 'water_autosweeper', 'CG_cutter', 'helicopter_apache_1a', 'coal_hopper', 'car_chassis']) expect([id, workMachine(make(id))]).toEqual([id, null]);
    for (const id of Object.keys(want)) {
      for (const status of [0, 1]) {
        const v = make(id, status, 7);
        const m = buildVehicleModel(v, 0)!;
        expect([id, m.bodyUsesParts]).toEqual([id, true]);
        const [x0, y0, x1, y1] = v.bounds();
        for (const g of [m.parts!, m.roof, m.glass, m.lamps, m.tails, m.beacons]) {
          if (!g) continue;
          // the body stays on its cells: only a blade's corners, teeth and lamps poke a little past
          const b = bounds(g);
          expect([id, b.min[0] > x0 - 0.75, b.max[0] < x1 + 0.75, b.min[2] > y0 - 0.75, b.max[2] < y1 + 0.75]).toEqual([id, true, true, true, true]);
          expect([id, b.min[1] > -0.05, b.max[1] < 4.3]).toEqual([id, true, true]);
        }
        // a driver's seat means a ride (the robot tractor / sweeper and the hoist have none)
        expect([id, !!m.ride]).toEqual([id, !!v.driverSeat() && v.parts.some((p) => p.def.flags.includes('SEAT'))]);
      }
    }
  });

  it('work machines: tools from the parts, wrecks scorched with the glass out', () => {
    // the excavator's arm reaches the rockwheel's cell and stands well above the cab
    const ex = make('excavator');
    const tool = ex.parts.find((p) => p.def.flags.includes('ROCKWHEEL'))!;
    const b = bounds(buildVehicleModel(ex, 0)!.parts!);
    expect(b.max[0]).toBeGreaterThan(tool.mx + 0.3);
    expect(b.max[1]).toBeGreaterThan(3.5);
    // destroy the bucket: the arm slumps
    tool.hp = 0;
    ex.version++;
    expect(bounds(buildVehicleModel(ex, 0)!.parts!).max[1]).toBeLessThan(b.max[1] - 0.5);
    // burnt out: no glass, no beacon
    for (const id of ['excavator', 'tractor_heavy_plow', 'forklift', 'roadheader_mining']) {
      const v = make(id);
      const intact = buildVehicleModel(v, 0)!;
      expect([id, !!(intact.glass || id === 'forklift')]).toEqual([id, true]);
      for (const p of v.parts) if (!p.def.flags.includes('WHEEL')) p.hp = 0;
      v.version++;
      const m = buildVehicleModel(v, 0)!;
      expect([id, m.glass, m.beacons]).toEqual([id, null, null]);
    }
  });

  it('lifts tanks, rollers and work machines onto the z-level floor', () => {
    for (const id of ['tank_m1_abrams', 'road_roller', 'excavator', 'tractor_plow', 'forklift', 'trencher']) {
      const b = bounds(buildVehicleModel(make(id), 2.6)!.parts!);
      expect([id, b.min[1] > 2.55]).toEqual([id, true]);
    }
  });

  it('cuts window panes and wheel arches into a sedan', () => {
    const L = analyze(make('sedan'));
    const o = buildOutline(L);
    expect(o.arches.length).toBe(2);
    // the roof is the highest point of the top outline
    expect(Math.max(...o.loop.slice(0, o.nTop).map((p) => p.y))).toBeCloseTo(L.p.roof, 5);
    expect(o.loop.some((p) => p.kind === 'glass')).toBe(true);
  });

  it('opens a hole and swings a leaf out for an open door', () => {
    const v = make('car');
    const closed = buildVehicleModel(v, 0)!;
    for (const p of v.parts) if (p.def.id === 'door_front_left') p.open = true;
    const open = buildVehicleModel(v, 0)!;
    const minZ = (g: THREE.BufferGeometry) => bounds(g).min[2];
    // the leaf sticks out past the left side of the body
    expect(minZ(open.body!)).toBeLessThan(minZ(closed.body!) - 0.4);
  });

  it('paints a skin at 32 texels per metre with every texel set', () => {
    const v = make('policecar');
    const L = analyze(v);
    const lay = skinLayout(skinLayoutInfo(L), 2);
    expect(lay.sheets.right.w).toBe(Math.ceil((L.xNose - L.xTail + 0.5) * SKIN_PPM));
    const s = paintSkin(skinLayoutInfo(L), { paint: v.paint, seed: 1, panes: { [-1]: [], [1]: [] } as never, arches: [], rowBlood: new Map(), rowDamage: new Map(), headlamps: [], taillamps: [], wallTop: { x0: -5, step: 1, values: new Float32Array(12).fill(1.4) }, yMax: 2 });
    let unset = 0;
    for (const sh of Object.values(s.layout.sheets))
      for (let v2 = 0; v2 < sh.h; v2++) for (let u = 0; u < sh.w; u++) if (s.data[((sh.v0 + v2) * s.layout.width + sh.u0 + u) * 4 + 3] !== 255) unset++;
    expect(unset).toBe(0);
  });

  it('parked front wheels: straight about half the time, never past ~23 degrees', () => {
    const a = Array.from({ length: 400 }, (_, i) => parkedSteerAngle(i + 1));
    const straight = a.filter((x) => x === 0).length;
    expect(straight).toBeGreaterThan(140);
    expect(straight).toBeLessThan(260);
    expect(Math.max(...a.map(Math.abs))).toBeLessThanOrEqual(0.41);
  });

  it('the distance LOD drops the cabin interior', () => {
    const v = make('sedan');
    const near = buildVehicleModel(v, 0)!, far = buildVehicleModel(v, 0, { far: true })!;
    const tris = (m: typeof near) => m.parts!.getIndex()!.count / 3;
    expect(tris(far)).toBeLessThan(tris(near) * 0.7);
  });

  it('an open hatch lifts above the roof', () => {
    const v = make('car_hatch');
    const top = () => {
      const m = buildVehicleModel(v, 0)!;
      return Math.max(bounds(m.body!).max[1], m.glass ? bounds(m.glass).max[1] : 0);
    };
    for (const p of v.parts) p.open = false;
    const closed = top();
    const lids = v.parts.filter((p) => p.def.flags.includes('MULTISQUARE'));
    expect(lids.length).toBeGreaterThan(0);
    for (const p of lids) p.open = true;
    expect(top()).toBeGreaterThan(closed + 0.2);
  });

  it('the driven build has a cockpit: wheel, two dials, a windscreen film', () => {
    const v = make('sedan');
    expect(buildVehicleModel(v, 0)!.cockpit).toBeUndefined();
    const m = buildVehicleModel(v, 0, { separateWheels: true })!;
    const c = m.cockpit!;
    expect(c.dials.map((d) => d.kind)).toEqual(['speed', 'fuel']);
    expect(c.film).not.toBeNull();
    // the wheel is ahead of the driver's seat and below the eye
    expect(c.wheel.y).toBeLessThan(m.eyeH);
    expect(c.wheel.x).toBeGreaterThan(m.driverX!);
  });

  it('smashed glass leaves flecks on the road', () => {
    const v = make('sedan');
    const low = (m: ReturnType<typeof buildVehicleModel>) => {
      const pos = m!.parts!.getAttribute('position');
      let n = 0;
      for (let i = 0; i < pos.count; i++) if (pos.getY(i) < 0.03) n++;
      return n;
    };
    const intact = low(buildVehicleModel(v, 0));
    for (const p of v.parts) if (p.def.flags.includes('WINDSHIELD')) p.hp = 0;
    expect(low(buildVehicleModel(v, 0))).toBeGreaterThan(intact + 30);
  });

  it('can hand the skin to a worker as structured-cloneable data', () => {
    const m = buildVehicleModel(make('ambulance', 1), 0, { deferSkin: true })!;
    expect(m.skin).toBeNull();
    const job = structuredClone(m.skinJob!);
    const s = paintSkin(job.info, job.inp);
    expect(s.data.length).toBe(s.layout.width * s.layout.height * 4);
  });

  it('reuses the skin when only doors / lights change', () => {
    const v = make('suv');
    const a = buildVehicleModel(v, 0)!;
    v.parts.find((p) => p.def.id === 'door_front_right')!.open = true;
    v.lightsOn = true;
    const b = buildVehicleModel(v, 0, { reuseSkinKey: a.skinKey })!;
    expect(b.skinKey).toBe(a.skinKey);
    expect(b.skin).toBeNull();
  });
});

describe('vehicle model: where the rider sits (vehicleRider.ts)', () => {
  it('bikes: hips over the saddle between the wheels, grips ahead of the hips, feet low', () => {
    for (const id of ['bicycle', 'motorcycle', 'scooter']) {
      const v = make(id);
      const m = buildVehicleModel(v, 0, { separateWheels: true })!;
      const a = m.ride!;
      expect(a, id).toBeTruthy();
      expect(a.kind).toBe(id === 'bicycle' ? 'bicycle' : 'motorcycle');
      const xs = m.layout.wheels.map((w) => w.x);
      expect(a.hip[0]).toBeGreaterThan(Math.min(...xs) - 0.6);
      expect(a.hip[0]).toBeLessThan(Math.max(...xs));
      expect(a.hip[1]).toBeGreaterThan(0.6);
      for (const g of a.grips) {
        expect(g[0]).toBeGreaterThan(a.hip[0]);
        expect(Math.abs(g[2] - a.hip[2])).toBeGreaterThan(0.15);
      }
      // right hand (+z) first
      expect(a.grips[0][2]).toBeGreaterThan(a.grips[1][2]);
      for (const f of a.feet) expect(f[1]).toBeLessThan(a.hip[1] - 0.3);
    }
  });

  it('a ridden bicycle gets a turning crank; a parked one keeps its pedals in the frame', () => {
    const v = make('bicycle');
    expect(buildVehicleModel(v, 0, { separateWheels: true })!.crank).toBeTruthy();
    expect(buildVehicleModel(v, 0)!.crank).toBeUndefined();
    expect(buildVehicleModel(v, 0, { separateWheels: true })!.ride!.crank!.r).toBeGreaterThan(0.1);
  });

  it('cars: the driver sits on the driver seat, under the roof, hands on the rim ahead', () => {
    for (const id of ['car', 'suv', 'pickup', 'bus']) {
      const v = make(id);
      const m = buildVehicleModel(v, 0, { separateWheels: true })!;
      const a = m.ride!;
      expect(a, id).toBeTruthy();
      expect(a.kind).toBe('seat');
      expect(Math.abs(a.hip[2] - m.driverZ!)).toBeLessThan(1e-6);
      // head top (~0.8 m over the hips) stays under the roof line
      expect(a.hip[1] + 0.8).toBeLessThan(m.layout.p.roof + 0.05);
      for (const g of a.grips) expect(g[0]).toBeGreaterThan(a.hip[0] + 0.3);
    }
  });

  it('cars: both hands stay on the rim through the whole steering range (full lock x2.6)', () => {
    const rig = makeRig(bodyShapeOf({ id: 'player_male', bodytype: 'human', species: ['HUMAN'], volume: 62500 }));
    const dm = rig.dims!;
    for (const id of ['car', 'car_sports', 'suv', 'pickup', 'bus', 'cube_van']) {
      const m = buildVehicleModel(make(id), 0, { separateWheels: true })!;
      const a = m.ride!, w = m.cockpit!.wheel;
      const n = new THREE.Vector3(Math.cos(w.tilt), Math.sin(w.tilt), 0);
      for (let turn = -1.6; turn <= 1.6; turn += 0.2) {
        // the cockpit turns the rim about its axis by -angle; grips ride with it
        const q = new THREE.Quaternion().setFromAxisAngle(n, -Math.max(-GRIP_TURN_MAX, Math.min(GRIP_TURN_MAX, turn)));
        const hands = rimGrips(0, 0, 0, w.r, w.tilt).map((g) => {
          const p = new THREE.Vector3(...g).applyQuaternion(q).add(new THREE.Vector3(w.x, w.y, w.z));
          return [p.z - a.hip[2], p.y - a.hip[1] + dm.hipY, -(p.x - a.hip[0])] as [number, number, number];
        });
        const layer = new CharLayer(false);
        const inst = layer.add(rig, { page: 0, rects: new Int32Array(rig.parts.length * 5), refs: 0 });
        inst.setPose({ t: 0, phase: 0, gait: 0, windup: null, windKind: 'melee', strike: 0, down: 0, flinch: 0, dead: false, seed: 0.3, ride: { lean: a.lean, hands: [hands[0], hands[1]], feet: [[0.1, 0.3, -0.5], [-0.1, 0.3, -0.5]] } });
        inst.build(null);
        for (const [part, want] of [[HUM.handR, hands[0]], [HUM.handL, hands[1]]] as const) {
          const got = new THREE.Vector3().applyMatrix4(new THREE.Matrix4().fromArray(inst.mats, part * 16));
          expect(got.distanceTo(new THREE.Vector3(...want)), `${id} at ${turn.toFixed(1)}`).toBeLessThan(0.02);
        }
      }
    }
  });
});
