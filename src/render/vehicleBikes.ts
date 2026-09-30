import type * as THREE from 'three';
import { has, type Vehicle } from '../game/vehicle';
import { GeomBuilder, type V3 } from './geometry';
import type { Layout } from './vehicleLayout';
import { Batches, chamferBox, partFrames, tube, wheel } from './vehicleGeom';
import type { ModelBuild } from './vehicleModel';
import type { RideAnchors } from './vehicleRider';

// Motorcycles and bicycles for the "model" renderer: tubes, a tank, a saddle, forks and
// spoked wheels instead of a body shell. A bike's grid is 3-4 tiles long (one per part row),
// so the visual wheelbase is pulled in to a real bike's (~1.45 m / ~1.05 m) around the grid
// centre; the rider still sits over the saddle's tile. Parked bikes lean on the kickstand
// (VehicleRenderer applies `parkedLean` when nobody is riding).

function darkenTint(c: number): number {
  return (Math.round(((c >> 16) & 255) * 0.6) << 16) | (Math.round(((c >> 8) & 255) * 0.6) << 8) | Math.round((c & 255) * 0.6);
}

/**
 * `driven`: the bike being ridden gets its crank (arms + pedals) as a separate mesh the
 * renderer turns with the rider's feet (vehicleRider.ts); parked bikes keep them in `parts`.
 */
export function buildBike(v: Vehicle, L: Layout, base: number, driven = false): ModelBuild {
  const F = partFrames();
  const parts = new Batches(), lamps = new GeomBuilder(), tails = new GeomBuilder();
  const ctrl = v.parts.find((q) => has(q, 'CONTROLS')) ?? v.parts.find((q) => has(q, 'SEAT'));
  const col = ctrl ? ctrl.my : Math.round(L.yc);
  const own = L.wheels.filter((w) => w.part.my === col);
  const side = L.wheels.filter((w) => w.part.my !== col);
  const bicycle = L.style === 'bicycle';
  const xs = own.map((w) => w.part.mx);
  const xF0 = xs.length ? Math.max(...xs) : L.xNose - 0.5, xR0 = xs.length ? Math.min(...xs) : L.xTail + 0.5;
  const cx = (xF0 + xR0) / 2;
  const wb = Math.min(xF0 - xR0, bicycle ? 1.05 : 1.45);
  const xF = cx + wb / 2, xR = cx - wb / 2;
  const front = own.find((w) => w.part.mx === xF0) ?? own[0];
  const rear = own.find((w) => w.part.mx === xR0) ?? own[own.length - 1];
  const rF = front?.r ?? 0.32, rR = rear?.r ?? 0.32;
  const z = col;
  const paint = v.paint;
  const chrome = 0xb8bcc2, black = 0x222226;
  const P = (x: number, y: number, dz = 0): V3 => [x, base + y, z + dz];
  const g = (tint: number) => parts.get(tint);

  if (front) wheel(g(front.part.hp > 0 ? 0x9a9a9a : 0x5a5656), xF, base + rF, z, rF, Math.max(0.05, front.width), F, { sides: 16, rim: bicycle ? 'spokes' : 'rim', rimFrac: bicycle ? 0.9 : 0.66, flat: front.part.hp <= 0 });
  if (rear) wheel(g(rear.part.hp > 0 ? 0x9a9a9a : 0x5a5656), xR, base + rR, z, rR, Math.max(0.05, rear.width * (bicycle ? 1 : 1.3)), F, { sides: 16, rim: bicycle ? 'spokes' : 'rim', rimFrac: bicycle ? 0.9 : 0.66, flat: rear.part.hp <= 0 });

  let eyeH: number;
  let ride: RideAnchors;
  let crank: ModelBuild['crank'];
  if (bicycle) {
    const r = rR;
    const R = P(xR, r), B = P(xR + 0.42, r - 0.04), S = P(xR + 0.3, r + 0.5), H = P(xF - 0.3, r + 0.46), Hb = P(xF - 0.27, r + 0.3);
    const t = 0.022, fr = g(paint);
    tube(fr, B, S, t, F.metal);
    tube(fr, S, H, t, F.metal);
    tube(fr, B, Hb, t * 1.2, F.metal);
    tube(fr, H, Hb, t * 1.3, F.metal);
    for (const s of [-1, 1]) {
      tube(fr, P(xR, r, s * 0.05), S, t * 0.7, F.metal);
      tube(fr, P(xR, r, s * 0.05), B, t * 0.7, F.metal);
      tube(g(chrome), Hb, P(xF, rF, s * 0.04), t * 0.8, F.chrome);
    }
    // bars, stem, saddle, cranks
    const bar = P(xF - 0.34, r + 0.62);
    tube(g(chrome), H, bar, t, F.chrome);
    tube(g(black), P(xF - 0.34, r + 0.62, -0.26), P(xF - 0.34, r + 0.62, 0.26), t, F.dark);
    const seatP = P(xR + 0.27, r + 0.6);
    tube(g(chrome), S, seatP, t * 0.8, F.chrome);
    chamferBox(g(black), seatP[0] - 0.14, seatP[1] - 0.01, z - 0.07, seatP[0] + 0.1, seatP[1] + 0.05, z + 0.07, 0.04, F.leather, F.leather);
    tube(g(0x555558), P(xR + 0.42, r - 0.04, -0.1), P(xR + 0.42, r - 0.04, 0.1), 0.03, F.metal);
    const crankR = 0.17, pedalHalf = 0.12;
    if (!driven) {
      // parked: cranks fixed at 3 and 9 o'clock-ish
      for (const s of [-1, 1]) chamferBox(g(black), xR + 0.36 + s * 0.12, base + r - 0.08 - s * 0.1, z + s * 0.12 - 0.05, xR + 0.48 + s * 0.12, base + r - 0.06 - s * 0.1, z + s * 0.12 + 0.05, 0.02, F.dark, F.dark);
    } else {
      // ridden: arms + pedals around their own centre (the renderer turns them about +z; the
      // right arm points along +x at angle 0, the left one opposite)
      const cb = new Batches();
      for (const s of [-1, 1]) {
        const ex = s * crankR;
        tube(cb.get(0x555558), [0, 0, s * 0.07], [ex, 0, s * 0.07], 0.014, F.metal, 5);
        tube(cb.get(0x555558), [ex, 0, s * 0.07], [ex, 0, s * pedalHalf], 0.008, F.metal, 4);
        chamferBox(cb.get(black), ex - 0.05, -0.012, s * pedalHalf - 0.045, ex + 0.05, 0.012, s * pedalHalf + 0.045, 0.01, F.dark, F.dark);
      }
      const geo = cb.build();
      if (geo) crank = { geo, x: xR + 0.42, y: base + r - 0.04, z };
    }
    if (v.parts.some((q) => has(q, 'CONE_LIGHT'))) chamferBox(lamps, bar[0] + 0.02, bar[1] - 0.12, z - 0.04, bar[0] + 0.08, bar[1] - 0.06, z + 0.04, 0.02, F.light, F.light);
    eyeH = r + 1.2;
    // on the saddle, reaching well forward to the flat bars; pedalling round the crank
    const gz = 0.22;
    ride = {
      kind: 'bicycle', hip: P(seatP[0] - 0.06, seatP[1] - base + 0.13), lean: 0.62,
      grips: [P(bar[0] - 0.02, bar[1] - base + 0.02, gz), P(bar[0] - 0.02, bar[1] - base + 0.02, -gz)],
      feet: [P(xR + 0.42, r - 0.1, pedalHalf), P(xR + 0.42, r - 0.1, -pedalHalf)],
      crank: { c: P(xR + 0.42, r - 0.04), r: crankR, half: pedalHalf },
    };
  } else {
    // A standard / cruiser: steering head up front, teardrop tank, flat saddle, engine hung
    // under the tank, swingarm to the rear axle, exhaust down the right side.
    const hx = xF - 0.34, hy = rF + 0.62;
    const tint = paint;
    const frame = 0x26262a;
    // forks (chrome), triple clamp, front fender
    for (const s of [-1, 1]) tube(g(chrome), P(hx, hy, s * 0.085), P(xF, rF, s * 0.085), 0.03, F.chrome, 6);
    chamferBox(g(0x333338), hx - 0.06, base + hy - 0.03, z - 0.12, hx + 0.06, base + hy + 0.04, z + 0.12, 0.03, F.metal, F.metal);
    chamferBox(g(tint), xF - rF * 0.75, base + rF * 2 + 0.03, z - 0.075, xF + rF * 0.5, base + rF * 2 + 0.07, z + 0.075, 0.035, F.metal, F.metal);
    // handlebars on risers, grips, mirrors
    const by = hy + 0.17, bx = hx - 0.12;
    for (const s of [-1, 1]) tube(g(chrome), P(hx - 0.02, hy + 0.03, s * 0.06), P(bx, by, s * 0.08), 0.018, F.chrome, 5);
    tube(g(chrome), P(bx, by, -0.34), P(bx, by, 0.34), 0.018, F.chrome, 6);
    for (const s of [-1, 1]) {
      tube(g(black), P(bx, by, s * 0.28), P(bx - 0.02, by, s * 0.4), 0.03, F.dark, 6);
      tube(g(0x303034), P(bx, by, s * 0.24), P(bx - 0.03, by + 0.2, s * 0.3), 0.01, F.dark, 4);
      chamferBox(g(black), bx - 0.06, base + by + 0.19, z + s * 0.3 - 0.06, bx - 0.01, base + by + 0.26, z + s * 0.3 + 0.06, 0.02, F.dark, F.dark);
    }
    // round headlamp (lit lens in `lamps`)
    chamferBox(g(chrome), hx + 0.05, base + hy - 0.13, z - 0.09, hx + 0.17, base + hy + 0.03, z + 0.09, 0.05, F.chrome, F.chrome);
    const lit = v.parts.some((q) => has(q, 'CONE_LIGHT') && q.hp > 0);
    if (lit) chamferBox(lamps, hx + 0.17, base + hy - 0.11, z - 0.07, hx + 0.19, base + hy + 0.01, z + 0.07, 0.035, F.light, F.light);
    // teardrop tank: tall at the head, tapering toward the saddle
    const tx1 = hx - 0.06, tx0 = hx - 0.6;
    chamferBox(g(tint), tx0 + 0.12, base + hy - 0.16, z - 0.15, tx1, base + hy + 0.04, z + 0.15, 0.08, F.metal, F.metal);
    chamferBox(g(tint), tx0, base + hy - 0.13, z - 0.11, tx0 + 0.2, base + hy - 0.02, z + 0.11, 0.06, F.metal, F.metal);
    chamferBox(g(darkenTint(tint)), tx0 + 0.18, base + hy + 0.04, z - 0.04, tx1 - 0.08, base + hy + 0.06, z + 0.04, 0.02, F.metal, F.metal);
    // saddle, side panel under it, rear fender + taillight
    const sx0 = xR + 0.12, sx1 = tx0 + 0.04;
    chamferBox(g(0x1c1c1e), sx0 + 0.1, base + hy - 0.15, z - 0.14, sx1, base + hy - 0.05, z + 0.14, 0.07, F.leather, F.leather);
    chamferBox(g(0x1c1c1e), sx0, base + hy - 0.12, z - 0.1, sx0 + 0.22, base + hy - 0.07, z + 0.1, 0.05, F.leather, F.leather);
    chamferBox(g(tint), sx0 + 0.12, base + hy - 0.34, z - 0.1, sx1 - 0.05, base + hy - 0.15, z + 0.1, 0.05, F.metal, F.metal);
    chamferBox(g(tint), xR - rR * 0.85, base + rR * 2 + 0.02, z - 0.08, sx0 + 0.15, base + rR * 2 + 0.07, z + 0.08, 0.04, F.metal, F.metal);
    chamferBox(tails, xR - rR * 0.85 - 0.03, base + rR * 2 + 0.02, z - 0.05, xR - rR * 0.85 + 0.01, base + rR * 2 + 0.08, z + 0.05, 0.02, F.light, F.light);
    // engine: finned cylinders over a crankcase, gearbox behind
    const ex0 = xR + 0.5, ex1 = hx - 0.16;
    const em = (ex0 + ex1) / 2;
    chamferBox(g(0x3a3a3e), ex0, base + 0.24, z - 0.13, ex1, base + 0.5, z + 0.13, 0.06, F.metal, F.metal);
    chamferBox(g(0x8a8a90), em - 0.02, base + 0.5, z - 0.11, em + 0.2, base + hy - 0.2, z + 0.11, 0.04, F.fins, F.metal);
    chamferBox(g(0x8a8a90), em - 0.24, base + 0.5, z - 0.11, em - 0.04, base + hy - 0.22, z + 0.11, 0.04, F.fins, F.metal);
    chamferBox(g(0x5a5a60), ex0 - 0.08, base + 0.3, z - 0.1, ex0 + 0.12, base + 0.52, z + 0.1, 0.05, F.metal, F.metal);
    // frame: backbone under the tank, down tube, swingarm, shocks
    tube(g(frame), P(hx, hy - 0.02), P(sx0 + 0.25, hy - 0.2), 0.028, F.dark, 5);
    tube(g(frame), P(hx, hy - 0.05), P(ex1 + 0.04, 0.3), 0.028, F.dark, 5);
    for (const s of [-1, 1]) {
      tube(g(frame), P(ex0, 0.34, s * 0.09), P(xR, rR, s * 0.09), 0.026, F.dark, 5);
      tube(g(chrome), P(xR + 0.1, rR + 0.05, s * 0.1), P(sx0 + 0.18, hy - 0.2, s * 0.1), 0.022, F.chrome, 5);
    }
    // exhaust: header down from the cylinders, muffler along the right side
    tube(g(chrome), P(em + 0.16, 0.55, 0.12), P(em + 0.1, 0.24, 0.17), 0.03, F.chrome, 6);
    tube(g(chrome), P(em + 0.1, 0.24, 0.17), P(ex0 - 0.1, 0.25, 0.19), 0.03, F.chrome, 6);
    tube(g(chrome), P(ex0 - 0.1, 0.25, 0.19), P(xR - 0.1, rR + 0.02, 0.19), 0.05, F.chrome, 7);
    eyeH = hy + 0.8;
    // astride the saddle just behind the tank, a slight crouch to the wide bars, feet on pegs
    // under the knees
    const hipX = sx1 - 0.12;
    ride = {
      kind: 'motorcycle', hip: P(hipX, hy + 0.04), lean: 0.4,
      grips: [P(bx - 0.03, by, 0.31), P(bx - 0.03, by, -0.31)],
      feet: [P(hipX + 0.22, 0.34, 0.2), P(hipX + 0.22, 0.34, -0.2)],
    };
  }
  // sidecar tub on its own column
  for (const w of side) {
    const tz = w.part.my;
    wheel(g(w.part.hp > 0 ? 0x9a9a9a : 0x5a5656), cx - 0.1, base + w.r, tz + 0.2, w.r, Math.max(0.05, w.width), F, { sides: 14 });
    chamferBox(g(paint), cx - 0.9, base + 0.28, tz - 0.34, cx + 0.6, base + 0.78, tz + 0.3, 0.22, F.metal, F.metal);
    tube(g(0x2a2a2e), P(cx - 0.3, 0.3), [cx - 0.3, base + 0.3, tz - 0.3], 0.03, F.dark, 5);
  }
  const out = (b: Batches | GeomBuilder): THREE.BufferGeometry | null => (b instanceof Batches ? b.build() : b.vertexCount ? b.build() : null);
  return {
    body: null, roof: null, parts: out(parts), glass: null, lamps: out(lamps), tails: out(tails), beacons: null,
    skin: null, skinJob: null, skinKey: '', layout: L, eyeH, driverZ: z, parkedLean: bicycle ? 0.1 : 0.14, ride, crank,
  };
}
