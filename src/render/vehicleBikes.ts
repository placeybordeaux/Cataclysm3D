import type * as THREE from 'three';
import { has, type Vehicle } from '../game/vehicle';
import { GeomBuilder, type V3 } from './geometry';
import type { Layout } from './vehicleLayout';
import { Batches, chamferBox, partFrames, tube, wheel } from './vehicleGeom';
import type { ModelBuild } from './vehicleModel';

// Motorcycles and bicycles for the "model" renderer: tubes, a tank, a saddle, forks and
// spoked wheels instead of a body shell. A bike's grid is 3-4 tiles long (one per part row),
// so the visual wheelbase is pulled in to a real bike's (~1.45 m / ~1.05 m) around the grid
// centre; the rider still sits over the saddle's tile. Parked bikes lean on the kickstand
// (VehicleRenderer applies `parkedLean` when nobody is riding).

export function buildBike(v: Vehicle, L: Layout, base: number): ModelBuild {
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
    for (const s of [-1, 1]) chamferBox(g(black), xR + 0.36 + s * 0.12, base + r - 0.08 - s * 0.1, z + s * 0.12 - 0.05, xR + 0.48 + s * 0.12, base + r - 0.06 - s * 0.1, z + s * 0.12 + 0.05, 0.02, F.dark, F.dark);
    if (v.parts.some((q) => has(q, 'CONE_LIGHT'))) chamferBox(lamps, bar[0] + 0.02, bar[1] - 0.12, z - 0.04, bar[0] + 0.08, bar[1] - 0.06, z + 0.04, 0.02, F.light, F.light);
    eyeH = r + 1.2;
  } else {
    const hx = xF - 0.3, hy = rF + 0.55;
    const tint = paint;
    // forks (chrome) and triple clamp
    for (const s of [-1, 1]) tube(g(chrome), P(hx, hy, s * 0.09), P(xF, rF, s * 0.09), 0.032, F.chrome, 6);
    chamferBox(g(0x333338), hx - 0.06, base + hy - 0.04, z - 0.13, hx + 0.06, base + hy + 0.04, z + 0.13, 0.03, F.metal, F.metal);
    // front fender over the tyre
    chamferBox(g(tint), xF - rF * 0.7, base + rF * 2 + 0.03, z - 0.08, xF + rF * 0.55, base + rF * 2 + 0.07, z + 0.08, 0.04, F.metal, F.metal);
    // handlebars + grips + mirrors
    const by = hy + 0.16, bx = hx - 0.1;
    tube(g(chrome), P(hx, hy + 0.02), P(bx, by), 0.025, F.chrome);
    tube(g(0x303034), P(bx, by, -0.36), P(bx, by, 0.36), 0.022, F.dark, 6);
    for (const s of [-1, 1]) {
      tube(g(black), P(bx, by, s * 0.3), P(bx, by, s * 0.42), 0.032, F.dark, 6);
      tube(g(0x303034), P(bx, by, s * 0.28), P(bx + 0.02, by + 0.2, s * 0.32), 0.012, F.dark, 4);
      chamferBox(g(black), bx - 0.02, base + by + 0.19, z + s * 0.32 - 0.06, bx + 0.04, base + by + 0.27, z + s * 0.32 + 0.06, 0.02, F.dark, F.dark);
    }
    // headlamp nacelle (lit lens in `lamps`)
    chamferBox(g(0x2a2a2e), hx + 0.02, base + hy - 0.12, z - 0.1, hx + 0.16, base + hy + 0.06, z + 0.1, 0.05, F.metal, F.metal);
    const lit = v.parts.some((q) => has(q, 'CONE_LIGHT') && q.hp > 0);
    if (lit) chamferBox(lamps, hx + 0.16, base + hy - 0.09, z - 0.075, hx + 0.19, base + hy + 0.04, z + 0.075, 0.03, F.light, F.light);
    // tank
    chamferBox(g(tint), hx - 0.62, base + hy - 0.2, z - 0.17, hx - 0.06, base + hy + 0.03, z + 0.17, 0.09, F.metal, F.metal);
    chamferBox(g(tint), hx - 0.56, base + hy + 0.03, z - 0.12, hx - 0.14, base + hy + 0.08, z + 0.12, 0.08, F.metal, F.metal);
    // saddle
    const sx0 = xR + 0.18, sx1 = hx - 0.58;
    chamferBox(g(0x1c1c1e), sx0, base + hy - 0.16, z - 0.15, sx1, base + hy - 0.02, z + 0.15, 0.07, F.leather, F.leather);
    // tail cowl, taillight, rear fender
    chamferBox(g(tint), xR - 0.12, base + hy - 0.22, z - 0.11, sx0 + 0.1, base + hy - 0.1, z + 0.11, 0.06, F.metal, F.metal);
    chamferBox(tails, xR - 0.15, base + hy - 0.2, z - 0.06, xR - 0.11, base + hy - 0.13, z + 0.06, 0.02, F.light, F.light);
    chamferBox(g(0x2a2a2e), xR - rR * 0.8, base + rR * 2 + 0.02, z - 0.07, xR + 0.1, base + rR * 2 + 0.05, z + 0.07, 0.03, F.dark, F.dark);
    // engine: block with cooling fins, crankcase
    const ex0 = xR + 0.42, ex1 = hx - 0.12;
    chamferBox(g(0x4a4a50), ex0, base + 0.2, z - 0.16, ex1, base + hy - 0.26, z + 0.16, 0.06, F.ribbed, F.metal);
    chamferBox(g(0x6a6a70), (ex0 + ex1) / 2 - 0.12, base + hy - 0.3, z - 0.12, (ex0 + ex1) / 2 + 0.16, base + hy - 0.19, z + 0.12, 0.04, F.ribbed, F.metal);
    // frame: down tube, backbone, swingarm
    tube(g(0x2a2a2e), P(hx, hy - 0.02), P(ex1 + 0.02, 0.28), 0.03, F.dark, 5);
    tube(g(0x2a2a2e), P(hx, hy + 0.02), P(sx0 + 0.1, hy - 0.16), 0.03, F.dark, 5);
    for (const s of [-1, 1]) tube(g(0x2a2a2e), P(ex0 + 0.05, 0.36, s * 0.1), P(xR, rR, s * 0.1), 0.03, F.dark, 5);
    // exhaust along the right side
    tube(g(chrome), P(ex1 - 0.02, 0.36, 0.12), P(ex0 - 0.05, 0.3, 0.2), 0.035, F.chrome, 6);
    tube(g(chrome), P(ex0 - 0.05, 0.3, 0.2), P(xR - 0.12, rR + 0.1, 0.2), 0.045, F.chrome, 6);
    eyeH = hy + 0.85;
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
    skin: null, skinKey: '', layout: L, eyeH, driverZ: z, parkedLean: bicycle ? 0.1 : 0.14,
  };
}
