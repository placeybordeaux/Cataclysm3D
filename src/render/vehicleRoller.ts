import type * as THREE from 'three';
import { has, type Vehicle, type VehiclePart } from '../game/vehicle';
import { GeomBuilder } from './geometry';
import type { Layout } from './vehicleLayout';
import { Batches, chamferBox, partFrames, tube } from './vehicleGeom';
import { extrude } from './vehicleTank';
import { darkenC, lampBox, seat, steeringWheel, type ModelBuild } from './vehicleModel';
import { isDrum, wheelRuns } from './vehicleFrame';
import { rimGrips, type RideAnchors } from './vehicleRider';

// The "model" look for drum compactors (BN road_roller): grids whose running gear includes
// compaction drums (vehicleFrame.ts isDrum: a sized WHEEL mounted in the cell's centre, BN
// roller_drum). Their template is a frame (the id matches mapping.ts's "roller" rule), and the
// frame look drew every drum cell as a 1.6 m car tyre and the cab as a 5 m glass box.
//
// Here: each run of drum cells across the grid is one smooth steel drum in a yellow yoke;
// a chassis between the drums; an engine hood from the rearmost drum to the cab; an operator
// platform with handrails over the roofed cells and, centred on the driver's seat, a ROPS cab
// (glass where BN has windows / windscreens / doors, an open canopy otherwise). Plain wheels
// (a single-drum roller's rear tyres) are drawn as fat tyres. Construction yellow.
//
// Local frame as vehicleMesh.ts: X = mount x (forward), Z = mount y (right), Y up (+ base).

const YELLOW = 0xd09a1c;
const PLATFORM = 1.25, ROOF = 2.75;

/** Does this (frame) grid roll on compaction drums? */
export function isCompactor(v: Vehicle): boolean {
  return v.wheels.some(isDrum);
}

export function buildRoller(v: Vehicle, L0: Layout, base: number, far = false): ModelBuild {
  const F = partFrames();
  const L: Layout = { ...L0, zOf: (my: number) => my, xOf: (mx: number) => mx };
  const parts = new Batches(), glass = new GeomBuilder(), lamps = new GeomBuilder(), tails = new GeomBuilder(), beacons = new Batches();
  const Y = (h: number) => base + h;
  const cells: [number, number][] = [];
  for (const k of v.mounts()) cells.push([Math.floor(k / 1024) - 512, (k % 1024) - 512]);
  const xs = cells.map(([x]) => x), ys = cells.map(([, y]) => y);
  const xr = Math.min(...xs) - 0.5, xf = Math.max(...xs) + 0.5, zl = Math.min(...ys) - 0.5, zr = Math.max(...ys) + 0.5;
  const zc = (zl + zr) / 2;
  const wrecked = v.wheels.length > 0 && v.wheels.every((w) => w.hp <= 0);
  const paint = wrecked ? darkenC(YELLOW, 0.5) : YELLOW;
  const paintDark = darkenC(paint, 0.7), black = 0x232325;

  // --- drums ---
  const drums = wheelRuns(v.wheels.filter(isDrum), 'y').map((run) => {
    const w = run.parts[0];
    const r = Math.max(0.4, Math.min(0.85, (w.def.wheel?.diameter ?? 120) / 200));
    // BN's 1.5 m drum is wider than its 1 m cell: an end drum is pulled inward so it stays
    // inside the grid (collision is the cells), its outer face on the end cell's edge.
    const x = run.at >= xf - 0.5 ? xf - 0.42 - r : run.at <= xr + 0.5 ? xr + 0.42 + r : run.at;
    return { x, z0: run.lo - 0.5, z1: run.hi + 0.5, r, alive: run.parts.some((q) => q.hp > 0) };
  });
  for (const d of drums) {
    const za = d.z0 + 0.16, zb = d.z1 - 0.16;
    // a smooth steel roll: many-sided, plain shading (no tread), dented flat when destroyed
    const r = d.alive ? d.r : d.r * 0.9;
    // a smooth steel roll: a many-sided prism, plain swatch so the normals do the shading
    const n = far ? 12 : 20;
    const ring: [number, number][] = [];
    for (let i = 0; i < n; i++) ring.push([d.x + Math.cos((i / n) * Math.PI * 2) * r, Y(r + Math.sin((i / n) * Math.PI * 2) * r)]);
    extrude(parts.get(d.alive ? 0x84868a : 0x5a5652), ring, za, zb, F.light, F.dark);
    // end discs and hubs, darker
    for (const z of [za, zb]) {
      chamferBox(parts.get(0x4a4a48), d.x - r * 0.72, Y(r - r * 0.72), z - 0.02, d.x + r * 0.72, Y(r + r * 0.72), z + 0.02, r * 0.3, F.dark, F.dark);
      chamferBox(parts.get(black), d.x - 0.18, Y(r - 0.18), Math.min(z, z + (z === za ? -0.1 : 0.1)), d.x + 0.18, Y(r + 0.18), Math.max(z, z + (z === za ? -0.1 : 0.1)), 0.07, F.dark, F.dark);
    }
    // yoke: side plates from the hub up to a frame over the drum, and the top beam
    const top = 2 * d.r + 0.08;
    for (const [z0, z1] of [[d.z0 + 0.02, d.z0 + 0.14], [d.z1 - 0.14, d.z1 - 0.02]]) {
      chamferBox(parts.get(paint), d.x - 0.2, Y(d.r - 0.05), z0, d.x + 0.2, Y(top), z1, 0.06, F.metal, F.metal);
    }
    chamferBox(parts.get(paint), d.x - d.r * 0.85, Y(top - 0.02), d.z0 + 0.02, d.x + d.r * 0.85, Y(top + 0.16), d.z1 - 0.02, 0.06, F.metal, F.metal);
    // scraper bars along the drum, fore and aft
    for (const sx of [-1, 1]) tube(parts.get(black), [d.x + sx * (d.r + 0.03), Y(d.r * 0.55), d.z0 + 0.16], [d.x + sx * (d.r + 0.03), Y(d.r * 0.55), d.z1 - 0.16], 0.035, F.dark, 4);
  }
  const drumX = drums.map((d) => d.x);
  // plain wheels (a single-drum roller's rear axle): fat tyres
  for (const w of v.wheels.filter((q) => !isDrum(q))) {
    const r = Math.max(0.35, Math.min(0.85, (w.def.wheel?.diameter ?? 60) / 200 + 0.12));
    const dir = w.my <= zc ? -1 : 1;
    tube(parts.get(w.hp > 0 ? 0x2a2a28 : 0x3a3636), [w.mx, Y(r), w.my + dir * 0.45], [w.mx, Y(r), w.my - dir * 0.15], r, F.tread, 14);
  }

  // --- chassis, engine hood ---
  const roofed = cells.filter(([x, y]) => v.partsAt(x, y).some((p) => has(p, 'ROOF')));
  const cab = roofed.length
    ? { x0: Math.min(...roofed.map(([x]) => x)) - 0.5, x1: Math.max(...roofed.map(([x]) => x)) + 0.5 }
    : { x0: xr + (xf - xr) * 0.35, x1: xr + (xf - xr) * 0.65 };
  const front = drumX.filter((x) => x > cab.x1 - 0.5), rear = drumX.filter((x) => x < cab.x0 + 0.5);
  const fd = front.length ? Math.min(...front) : xf, rd = rear.length ? Math.max(...rear) : xr;
  const maxR = Math.max(0.5, ...drums.map((d) => d.r));
  // main frame between the drums, narrower than they are wide
  chamferBox(parts.get(paintDark), rd, Y(0.5), zc - (zr - zl) * 0.32, fd, Y(PLATFORM - 0.05), zc + (zr - zl) * 0.32, 0.12, F.metal, F.metal);
  // engine hood: from over the rearmost drum to the cab (where tandem rollers carry it)
  const hx0 = rear.length ? rd - maxR * 0.6 : xr + 0.1, hx1 = cab.x0;
  if (hx1 - hx0 > 0.4) {
    const hz = (zr - zl) * 0.36;
    chamferBox(parts.get(paint), hx0, Y(PLATFORM - 0.1), zc - hz, hx1, Y(PLATFORM + 0.7), zc + hz, 0.25, F.metal, F.metal);
    // louvres down both sides and a grille on the back
    for (const sz of [-1, 1]) chamferBox(parts.get(darkenC(paint, 0.55)), hx0 + 0.25, Y(PLATFORM + 0.15), zc + sz * hz - 0.03, hx1 - 0.2, Y(PLATFORM + 0.5), zc + sz * hz + 0.03, 0.01, F.fins, F.fins);
    chamferBox(parts.get(black), hx0 - 0.03, Y(PLATFORM + 0.05), zc - hz * 0.7, hx0 + 0.05, Y(PLATFORM + 0.55), zc + hz * 0.7, 0.01, F.fins, F.dark);
    // exhaust stack
    tube(parts.get(black), [(hx0 + hx1) / 2 + 0.2, Y(PLATFORM + 0.7), zc + hz * 0.6], [(hx0 + hx1) / 2 + 0.2, Y(ROOF - 0.15), zc + hz * 0.6], 0.06, F.dark, 6);
    for (const z of [zc - hz * 0.8, zc + hz * 0.8]) lampBox(tails, hx0 - 0.04, Y(PLATFORM + 0.35), z, 0.08, 0.05, -1);
  }

  // --- operator platform and cab ---
  const px0 = Math.max(cab.x0, rd + maxR * 0.5), px1 = Math.min(cab.x1, fd - maxR * 0.5);
  chamferBox(parts.get(0x3a3a3c), px0 - 0.1, Y(PLATFORM - 0.08), zl + 0.1, px1 + 0.1, Y(PLATFORM), zr - 0.1, 0.05, F.ribbed, F.ribbed);
  // handrails round the platform's open edges
  const rail = parts.get(paint);
  for (const z of [zl + 0.15, zr - 0.15]) {
    tube(rail, [px0, Y(PLATFORM + 0.95), z], [px1, Y(PLATFORM + 0.95), z], 0.03, F.metal, 5);
    for (const x of [px0, (px0 + px1) / 2, px1]) tube(rail, [x, Y(PLATFORM), z], [x, Y(PLATFORM + 0.95), z], 0.03, F.metal, 5);
  }
  // The cab: centred on the driver, ~1.8 m wide however wide the BN grid is.
  const drv = v.driverSeat();
  const dz = drv ? drv.my : zc;
  const cw = Math.min(0.95, (zr - zl) / 2 - 0.2);
  const cz0 = Math.max(zl + 0.2, dz - cw), cz1 = Math.min(zr - 0.2, dz + cw);
  const cx0 = px0 + 0.05, cx1 = px1 - 0.05;
  const glazed = v.parts.some((p) => (has(p, 'WINDSHIELD') || has(p, 'WINDOW')) && p.hp > 0);
  const rops = parts.get(black);
  for (const [x, z] of [[cx0, cz0], [cx0, cz1], [cx1, cz0], [cx1, cz1]] as const) chamferBox(rops, x - 0.06, Y(PLATFORM), z - 0.06, x + 0.06, Y(ROOF), z + 0.06, 0.02, F.dark, F.dark);
  if (v.parts.some((p) => has(p, 'ROOF') && p.hp > 0)) {
    chamferBox(parts.get(0xe8e4d8), cx0 - 0.15, Y(ROOF), cz0 - 0.15, cx1 + 0.15, Y(ROOF + 0.1), cz1 + 0.15, 0.08, F.metal, F.metal);
    // amber beacon on the canopy (flashes with the lights on, like the emergency bars)
    chamferBox(beacons.get(0xffa020), (cx0 + cx1) / 2 - 0.08, Y(ROOF + 0.1), cz1 - 0.3, (cx0 + cx1) / 2 + 0.08, Y(ROOF + 0.26), cz1 - 0.14, 0.05, F.light, F.light);
  }
  if (glazed) {
    // glass all round above a waist panel (the door is the left pane, as on the real thing)
    const w0 = PLATFORM + 0.7;
    for (const [a, b, c, d] of [[cx0, cz0, cx1, cz0 + 0.03], [cx0, cz1 - 0.03, cx1, cz1], [cx1 - 0.03, cz0, cx1, cz1], [cx0, cz0, cx0 + 0.03, cz1]] as const) {
      glass.box(a, Y(w0), b, c, Y(ROOF - 0.04), d, 63, F.light, F.light, Y(w0));
      chamferBox(parts.get(paint), a, Y(PLATFORM), b, c, Y(w0), d, 0.01, F.metal, F.metal);
    }
  } else {
    // open ROPS: a seat-high guard at the front only
    chamferBox(parts.get(paint), cx1 - 0.05, Y(PLATFORM), cz0, cx1, Y(PLATFORM + 0.7), cz1, 0.01, F.metal, F.metal);
  }
  // seat, wheel, console
  let ride: RideAnchors | undefined;
  const st = v.parts.find((p) => has(p, 'SEAT') && p.mx === drv?.mx && p.my === drv?.my) ?? v.parts.find((p) => has(p, 'SEAT'));
  const sx = Math.max(cx0 + 0.45, Math.min(cx1 - 0.4, st ? st.mx : (cx0 + cx1) / 2));
  if (st) {
    const s2 = { ...st, mx: sx, my: dz } as VehiclePart;
    seat(parts.get(st.hp > 0 ? 0x2c2c30 : 0x3a3a3a), s2, L, base, PLATFORM, PLATFORM + 0.48, F, false);
  }
  if (v.parts.some((p) => has(p, 'CONTROLS'))) {
    chamferBox(parts.get(black), sx + 0.35, Y(PLATFORM), dz - 0.25, sx + 0.6, Y(PLATFORM + 0.75), dz + 0.25, 0.05, F.dark, F.dark);
    steeringWheel(parts.get(0x1e1e22), sx + 0.4, Y(PLATFORM + 0.9), dz, 0.17, F.dark);
    const hipX = sx - 0.1;
    ride = {
      kind: 'seat', hip: [hipX, Y(PLATFORM + 0.55), dz], lean: -0.05,
      grips: rimGrips(sx + 0.4, Y(PLATFORM + 0.9), dz, 0.17, 0.45),
      feet: [[hipX + 0.5, Y(PLATFORM + 0.1), dz + 0.11], [hipX + 0.5, Y(PLATFORM + 0.1), dz - 0.11]],
    };
  }
  // headlamps on the canopy front (BN's CONE_LIGHT parts), work lamps if it has none
  const heads = v.parts.filter((p) => (has(p, 'CONE_LIGHT') || has(p, 'WIDE_CONE_LIGHT')) && p.hp > 0);
  for (const z of heads.length ? [cz0 + 0.2, cz1 - 0.2] : []) lampBox(lamps, cx1 + 0.17, Y(ROOF - 0.08), z, 0.1, 0.06, 1);

  const out = (b: Batches | GeomBuilder): THREE.BufferGeometry | null => (b instanceof Batches ? b.build() : b.vertexCount ? b.build() : null);
  return {
    body: null, roof: null, parts: out(parts), glass: out(glass), lamps: out(lamps), tails: out(tails), beacons: out(beacons),
    skin: null, skinJob: null, skinKey: '', layout: L,
    eyeH: PLATFORM + 1.15, driverZ: drv ? dz : null, driverX: drv ? sx : undefined, eyeX: drv ? sx + 0.05 : undefined,
    parkedLean: 0, bodyUsesParts: true, ride,
  };
}
