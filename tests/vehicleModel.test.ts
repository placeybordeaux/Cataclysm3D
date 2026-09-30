import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { spawnVehicle, type Vehicle } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { analyze, classify, setVehicleWidth, wheelRadius } from '../src/render/vehicleLayout';
import { buildOutline, buildVehicleModel, parkedSteerAngle } from '../src/render/vehicleModel';
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
    for (const id of ['shopping_cart', 'golf_cart', 'tractor_plow', 'apc', 'car_chassis']) {
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
});
