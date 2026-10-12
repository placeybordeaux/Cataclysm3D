import type * as THREE from 'three';
import { has, type Vehicle, type VehiclePart } from '../game/vehicle';
import { chassisOf } from '../game/chassis';
import { GeomBuilder, type V3 } from './geometry';
import { wheelRadius, type Layout } from './vehicleLayout';
import { Batches, chamferBox, faceNormal, partFrames, tube, wheel } from './vehicleGeom';
import { darkenC, lampBox, type ModelBuild } from './vehicleModel';
import type { TileFrame } from './textureSource';

// The "model" look for armoured hulls: tanks, self-propelled guns, IFVs and APCs (BN's
// tank_m1_abrams, tank_m60_patton*, howitzer_m109, ifv_m2_bradley, tank_xm7_elec, apc*,
// aapc-*, the hover tank / APC). Their chassis template is a frame (frame_tracked, or
// frame_boat for the hover ones: collision is the cells), and vehicleFrame.ts drew them as
// a grid of tiles with every tread3 as a 1.6 m car tyre: a row of giant tyres, no tank.
//
// Here the hull is read from the parts, not the prototype id:
//  - running gear: TRACKED wheels with a wheel size are tracks (a track per side, skirts
//    over the upper run, road wheels below), plain wheels are an 8x8's wheels, TRACKED
//    wheels without a size are hover pads (BN hover_repulsor), none at all is a decoy;
//  - the heaviest TURRET part decides the turret: a tank gun gets a low angular turret with
//    a long barrel, a howitzer a tall box turret, an autocannon a small one; machine guns go
//    on cupolas. No gun but a turret ring still gets the (empty) turret;
//  - without a turret the hull is a tall APC box.
// Like the frame look, nothing is squeezed: the hull covers the cells it collides with.
// Only the gun barrel reaches past them (as mirrors do on cars).
//
// Local frame as vehicleMesh.ts: X = mount x (forward), Z = mount y (right), Y = metres
// above the ground (+ `base`).

/** Gun classes by the turret part's mass (BN item weight, g: vehicle_data.ts). */
const MAIN_GUN_G = 500_000; // tank guns 1.5-3.3 t, the howitzer 4.3 t
const MEDIUM_GUN_G = 80_000; // the 25 mm autocannon 120 kg, the TOW launcher 200 kg; an M2 is 38 kg

type Gear = 'tracks' | 'wheels' | 'hover' | 'none';
type TurretKind = 'mbt' | 'box' | 'ifv';

/**
 * A hull's turret as separately built geometry (each piece built around its pivot, local mount
 * frame: X forward, Y up, Z right): the turret on its ring, the main gun on its trunnion
 * (`pivot` relative to the turret's), machine guns on their pintles (relative to the turret
 * when they ride on it, else to the hull). `len`: pivot to muzzle along +X (m). vehicleMesh.ts
 * traverses and elevates them from src/game/turret.ts turretAim.
 */
export interface TurretBuild {
  /** The main gun the turret carries (it sets the traverse), null for an empty ring / hull MGs only. */
  part: VehiclePart | null;
  geo: THREE.BufferGeometry | null;
  pivot: V3;
  gun: { geo: THREE.BufferGeometry | null; pivot: V3; len: number } | null;
  mgs: { part: VehiclePart; geo: THREE.BufferGeometry | null; pivot: V3; len: number; onTurret: boolean }[];
}

export interface ArmourInfo {
  gear: Gear;
  turret: TurretKind | null;
}

/**
 * Is this grid an armoured hull (and with what running gear / turret)? null = not one: it
 * stays with vehicleFrame.ts (tractors and excavators on treads, armoured boats, helicopters).
 */
export function armourHull(v: Vehicle): ArmourInfo | null {
  const t = chassisOf(v).template;
  // frame_air / frame_boat: the hover tank and APC (BN hover_repulsor is a WHEEL that also
  // FLOATS / has a ROTOR, so frameFamily files them under boats).
  if (t !== 'frame_tracked' && t !== 'frame_air' && t !== 'frame_boat') return null;
  if (!v.parts.length) return null;
  // Real aircraft parts (wings, a rotor that isn't a hover pad, balloons): not a ground hull.
  if (v.parts.some((p) => !has(p, 'WHEEL') && (has(p, 'WING') || has(p, 'ROTOR') || has(p, 'BALLOON') || has(p, 'PROPELLER') || has(p, 'FLOATS')))) return null;
  let mounts = 0, armoured = 0;
  for (const k of v.mounts()) {
    mounts++;
    const mx = Math.floor(k / 1024) - 512, my = (k % 1024) - 512;
    if (v.partsAt(mx, my).some((p) => p.def.location === 'armor')) armoured++;
  }
  // Plated over most of its cells: the military hulls are 75-95 %, a bandit tractor 10 %.
  if (armoured < 12 || armoured < mounts * 0.5) return null;
  const wheels = v.wheels;
  const tracked = wheels.filter((w) => has(w, 'TRACKED'));
  const gear: Gear = tracked.some((w) => w.def.wheel) ? 'tracks' : tracked.length ? 'hover' : wheels.length ? 'wheels' : 'none';
  const gun = mainGun(v);
  const g = gun?.def.weight ?? 0;
  const ring = v.parts.filter((p) => has(p, 'TURRET_MOUNT')).length;
  const turret: TurretKind | null = gun && /howitzer/.test(gun.def.item) ? 'box' : g >= MAIN_GUN_G ? 'mbt' : g >= MEDIUM_GUN_G ? 'ifv' : ring >= 2 && gear !== 'wheels' ? 'mbt' : null;
  return { gear, turret };
}

function mainGun(v: Vehicle): VehiclePart | null {
  let best: VehiclePart | null = null;
  for (const p of v.parts) if (has(p, 'TURRET') && (!best || p.def.weight > best.def.weight)) best = p;
  return best;
}

// --- solids -----------------------------------------------------------------------------

/**
 * A quad facing away from `c` (the solid's centre): the shapes here are convex, so winding
 * by "outward" is simpler and safer than keeping every loop's orientation straight.
 */
function quadOut(g: GeomBuilder, c: V3, a: V3, b: V3, d: V3, e: V3, f: TileFrame, uv: readonly number[]): void {
  const n = faceNormal(a, b, d);
  const m: V3 = [(a[0] + d[0]) / 2 - c[0], (a[1] + d[1]) / 2 - c[1], (a[2] + d[2]) / 2 - c[2]];
  if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] >= 0) g.quad(a, b, d, e, n, uv, f);
  else g.quad(e, d, b, a, [-n[0], -n[1], -n[2]], [uv[2], uv[3], uv[0], uv[1]], f);
}

function triOut(g: GeomBuilder, c: V3, a: V3, b: V3, d: V3, f: TileFrame, uv: readonly number[]): void {
  const n = faceNormal(a, b, d);
  const m: V3 = [(a[0] + b[0] + d[0]) / 3 - c[0], (a[1] + b[1] + d[1]) / 3 - c[1], (a[2] + b[2] + d[2]) / 3 - c[2]];
  if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] >= 0) g.tri(a, b, d, n, uv, f, [1, 1, 1]);
  else g.tri(d, b, a, [-n[0], -n[1], -n[2]], [uv[4], uv[5], uv[2], uv[3], uv[0], uv[1]], f, [1, 1, 1]);
}

/** A convex side profile (x, y) extruded across z0..z1: hull, track, skirt (vehicleRoller.ts: drums). */
export function extrude(g: GeomBuilder, loop: [number, number][], z0: number, z1: number, side: TileFrame, cap: TileFrame, uvAlong = 1, capUv: [number, number] = [1, 1]): void {
  const n = loop.length;
  const cx = loop.reduce((s, p) => s + p[0], 0) / n, cy = loop.reduce((s, p) => s + p[1], 0) / n;
  const c: V3 = [cx, cy, (z0 + z1) / 2];
  let run = 0;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = loop[i], [bx, by] = loop[(i + 1) % n];
    const len = Math.hypot(bx - ax, by - ay);
    quadOut(g, c, [ax, ay, z0], [ax, ay, z1], [bx, by, z1], [bx, by, z0], side, [z0, run * uvAlong, z1, (run + len) * uvAlong]);
    run += len;
  }
  for (const z of [z0, z1]) for (let i = 0; i < n; i++) {
    const [ax, ay] = loop[i], [bx, by] = loop[(i + 1) % n];
    const [ku, kv] = capUv;
    triOut(g, c, [cx, cy, z], [ax, ay, z], [bx, by, z], cap, [cx * ku, cy * kv, ax * ku, ay * kv, bx * ku, by * kv]);
  }
}

/** A convex plan polygon (x, z) at y0 lofted to another (same count) at y1, capped: turrets. */
function loft(g: GeomBuilder, lo: [number, number][], y0: number, hi: [number, number][], y1: number, side: TileFrame, top: TileFrame, k = 0.5): void {
  const n = lo.length;
  const cx = lo.reduce((s, p) => s + p[0], 0) / n, cz = lo.reduce((s, p) => s + p[1], 0) / n;
  const c: V3 = [cx, (y0 + y1) / 2, cz];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const len = Math.hypot(lo[j][0] - lo[i][0], lo[j][1] - lo[i][1]);
    quadOut(g, c, [lo[i][0], y0, lo[i][1]], [lo[j][0], y0, lo[j][1]], [hi[j][0], y1, hi[j][1]], [hi[i][0], y1, hi[i][1]], side, [0, y0 * k, len * k, y1 * k]);
  }
  const hx = hi.reduce((s, p) => s + p[0], 0) / n, hz = hi.reduce((s, p) => s + p[1], 0) / n;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    triOut(g, c, [hx, y1, hz], [hi[i][0], y1, hi[i][1]], [hi[j][0], y1, hi[j][1]], top, [hx * k, hz * k, hi[i][0] * k, hi[i][1] * k, hi[j][0] * k, hi[j][1] * k]);
    triOut(g, c, [cx, y0, cz], [lo[i][0], y0, lo[i][1]], [lo[j][0], y0, lo[j][1]], top, [cx * k, cz * k, lo[i][0] * k, lo[i][1] * k, lo[j][0] * k, lo[j][1] * k]);
  }
}

/** Plan polygon mirrored about z = zc from its right half (x, dz) listed front to rear. */
function mirrored(x0: number, zc: number, half: [number, number][]): [number, number][] {
  const right = half.map(([x, dz]) => [x0 + x, zc + dz] as [number, number]);
  const left = [...half].reverse().map(([x, dz]) => [x0 + x, zc - dz] as [number, number]);
  return [...right, ...left];
}

/**
 * One track run along x (xa..xb) whose outer face is at z = zo (`dir` = which side is out):
 * the belt loop with raised idler / sprocket ends, and road wheels, idler and sprocket
 * just proud of the outer face. A broken track lies flat. Shared with vehicleFrame.ts
 * (tractors, excavators, bulldozers on treads).
 */
export function trackRun(
  parts: Batches, F: ReturnType<typeof partFrames>, base: number,
  o: { xa: number; xb: number; zo: number; dir: -1 | 1; width: number; h: number; s: number; alive: boolean; far: boolean; rubber: number },
): void {
  const { xa, xb, zo, dir, h, s, far } = o;
  const zi = zo - dir * o.width;
  const za = Math.min(zo, zi), zb = Math.max(zo, zi);
  const Y = (y: number) => base + y;
  // short runs (a 2-cell tractor tread) get smaller end rounding
  const e = Math.min(0.55, (xb - xa) * 0.2);
  const loop: [number, number][] = o.alive
    ? [[xa + e, 0], [xb - e * 1.25, 0], [xb, h * 0.55], [xb - e * 0.55, h], [xa + e * 0.55, h], [xa, h * 0.62]]
    : [[xa, 0], [xb, 0], [xb, 0.12], [xa, 0.12]];
  extrude(parts.get(o.alive ? o.rubber : 0x161616), loop.map(([x, y]) => [x, Y(y)]), za, zb, F.tread, F.dark, 1.6);
  if (!o.alive) return;
  const wz = zo + dir * 0.02, ww = Math.min(0.2, o.width * 0.3);
  const r = Math.min(0.37 * s, h * 0.4), span = xb - xa - 2 * e - 0.3;
  const n = Math.max(2, Math.round(span / (r * 2.25)) + 1);
  for (let i = 0; i < n; i++) {
    const x = xa + e + 0.15 + (span * i) / Math.max(1, n - 1);
    wheel(parts.get(0x3a3a36), x, Y(r + 0.04), wz, r, ww, F, { sides: far ? 8 : 12, rim: 'rim', rimFrac: 0.78 });
  }
  wheel(parts.get(0x3a3a36), xb - e * 0.65, Y(h * 0.55), wz, Math.min(0.3 * s, h * 0.32), ww, F, { sides: far ? 8 : 12, rim: 'rim', rimFrac: 0.8 });
  wheel(parts.get(0x30302c), xa + e * 0.65, Y(h * 0.6), wz, Math.min(0.34 * s, h * 0.36), ww, F, { sides: far ? 8 : 12, rim: 'fins', rimFrac: 0.85 });
}

// --- build ------------------------------------------------------------------------------

// Olive drab and CARC desert tan, darkened like the other liveries so the banded light doesn't
// bleach them, but warmer and more saturated than the road and the paving (playtest: the tan
// hull on its gridded 'metal' swatch read as more sidewalk).
const OLIVE = 0x56612e;
const TAN = 0xb09252;

export function buildTank(v: Vehicle, L0: Layout, base: number, info: ArmourInfo, far = false): ModelBuild {
  // Armour plate instead of the parts' gridded 'metal' (vehicleGeom 'armor').
  const F0 = partFrames(), F = { ...F0, metal: F0.armor };
  const L: Layout = { ...L0, zOf: (my: number) => my, xOf: (mx: number) => mx };
  const parts = new Batches(), lamps = new GeomBuilder(), tails = new GeomBuilder();
  const Y = (h: number) => base + h;
  // extrude / loft take heights above the ground: lift them onto the z-level's floor
  const ext = (g: GeomBuilder, loop: [number, number][], z0: number, z1: number, side: TileFrame, cap: TileFrame, uvAlong = 1, capUv: [number, number] = [1, 1]) =>
    extrude(g, loop.map(([x, y]) => [x, y + base]), z0, z1, side, cap, uvAlong, capUv);
  const lft = (g: GeomBuilder, lo: [number, number][], y0: number, hi: [number, number][], y1: number, side: TileFrame, top: TileFrame) => loft(g, lo, y0 + base, hi, y1 + base, side, top);
  const at = (mx: number, my: number) => v.partsAt(mx, my);
  const cells: [number, number][] = [];
  for (const k of v.mounts()) cells.push([Math.floor(k / 1024) - 512, (k % 1024) - 512]);

  // Livery: the M1 is the desert-tan one everybody pictures; every other plated hull is olive
  // drab (not the random spawn paint: a teal howitzer reads as a toy). A vehicle whose armour
  // is mostly shot away is drawn burnt.
  const plates = v.parts.filter((p) => p.def.location === 'armor');
  const wrecked = plates.length > 0 && plates.filter((p) => p.hp <= 0).length * 2 >= plates.length;
  let paint = /abrams/.test(v.protoId) ? TAN : OLIVE;
  if (wrecked) paint = darkenC(paint, 0.45);
  // the shadowed lower hull and trim a step darker than it was (0.72): the hull's outline reads
  const paintDark = darkenC(paint, 0.62), rubber = wrecked ? 0x1c1c1c : 0x2c2c2a, steel = darkenC(paint, 0.5);

  // Hull extent: columns (along x) that hold at least half the widest column's cells. Odd
  // cells sticking out of that (an M60's nose cell, an APC's rear corners) are drawn as low
  // armoured blocks below, so collision still has something under it.
  const byX = new Map<number, number>();
  for (const [x] of cells) byX.set(x, (byX.get(x) ?? 0) + 1);
  const widest = Math.max(...byX.values());
  const bodyXs = [...byX].filter(([, n]) => n * 2 >= widest).map(([x]) => x);
  const ys = cells.map(([, y]) => y);
  const xr = Math.min(...bodyXs) - 0.5, xf = Math.max(...bodyXs) + 0.5;
  const zl = Math.min(...ys) - 0.5, zr = Math.max(...ys) + 0.5;
  const zc = (zl + zr) / 2, W = zr - zl, len = xf - xr;
  // Heights tuned on the 7-cell-wide M1 (deck 1.45 m, turret roof 2.35 m); a 5-wide tankette
  // or APC is a little lower, never squashed flat.
  const s = Math.max(0.78, Math.min(1, W / 7));
  const lift = info.gear === 'hover' ? 0.35 : 0;
  const deck = lift + (info.turret ? 1.45 : 1.95) * s;
  const trackTop = 0.95 * s;

  // --- running gear ---
  const tracked = v.wheels.filter((w) => has(w, 'TRACKED'));
  let inner = { l: zl, r: zr };
  if (info.gear === 'tracks' || info.gear === 'none') {
    // A decoy (BN's inflatable M60) has no running gear at all: it's meant to look like the
    // tank, so it gets dummy tracks along its outer rows.
    const sides: { z: number; dir: -1 | 1; x0: number; x1: number; alive: boolean }[] = [];
    if (tracked.length) {
      const yl = Math.min(...tracked.map((w) => w.my)), yr = Math.max(...tracked.map((w) => w.my));
      for (const [y, dir] of [[yl, -1], [yr, 1]] as const) {
        const ws = tracked.filter((w) => w.my === y);
        sides.push({ z: y, dir, x0: Math.min(...ws.map((w) => w.mx)) - 0.5, x1: Math.max(...ws.map((w) => w.mx)) + 0.5, alive: ws.some((w) => w.hp > 0) });
      }
    } else {
      sides.push({ z: zl + 0.5, dir: -1, x0: xr, x1: xf, alive: true }, { z: zr - 0.5, dir: 1, x0: xr, x1: xf, alive: true });
    }
    const tw = 0.86;
    for (const sd of sides) {
      const zo = sd.z + sd.dir * 0.5 - sd.dir * 0.04, zi = zo - sd.dir * tw;
      const za = Math.min(zo, zi), zb = Math.max(zo, zi);
      const xa = Math.max(sd.x0, xr) + 0.05, xb = Math.min(sd.x1, xf) - 0.05;
      const h = trackTop;
      trackRun(parts, F, base, { xa, xb, zo, dir: sd.dir, width: tw, h, s, alive: sd.alive, far, rubber });
      if (!sd.alive) continue;
      // side skirt: armour panels over the upper run, the front one raked up
      const sk: [number, number][] = [[xa + 0.12, 0.64 * s], [xb - 0.85, 0.62 * s], [xb - 0.05, 0.86 * s], [xb - 0.05, deck - 0.06], [xa + 0.12, deck - 0.06]];
      ext(parts.get(paint), sk.map(([x, y]) => [x, y + lift]), Math.min(zo + sd.dir * 0.11, zo + sd.dir * 0.18), Math.max(zo + sd.dir * 0.11, zo + sd.dir * 0.18), F.metal, F.metal, 1, [0.5, 0.5]);
      // the skirt's lower lip, darker: reads as the panel's thickness from a distance
      ext(parts.get(paintDark), [[xa + 0.12, 0.64 * s], [xb - 0.85, 0.62 * s], [xb - 0.85, 0.72 * s], [xa + 0.12, 0.74 * s]], Math.min(zo + sd.dir * 0.1, zo + sd.dir * 0.2), Math.max(zo + sd.dir * 0.1, zo + sd.dir * 0.2), F.dark, F.dark);
      if (sd.dir < 0) inner.l = Math.max(inner.l, zb);
      else inner.r = Math.min(inner.r, za);
    }
  } else if (info.gear === 'wheels') {
    for (const w of v.wheels) {
      const r = wheelRadius(w);
      const width = Math.max(0.3, Math.min(0.6, ((w.def.wheel?.width ?? 40) / 100) * 1.1));
      const dir = w.my <= zc ? -1 : 1;
      const z = w.my + dir * (0.5 - width / 2 - 0.04);
      wheel(parts.get(w.hp > 0 ? 0x5a5a56 : 0x3a3636), w.mx, Y(w.hp > 0 ? r : r * 0.8), z, r, width, F, { flat: w.hp <= 0, sides: far ? 10 : 16 });
      if (dir < 0) inner.l = Math.max(inner.l, z + width / 2);
      else inner.r = Math.min(inner.r, z - width / 2);
    }
  } else {
    // hover: a rubber skirt all round under the hull
    chamferBox(parts.get(rubber), xr + 0.1, Y(0.04), zl + 0.1, xf - 0.1, Y(lift + 0.1), zr - 0.1, 0.5, F.ribbed, F.dark);
    inner = { l: zl + 0.2, r: zr - 0.2 };
  }

  // --- hull ---
  const g = parts.get(paint);
  const belly = info.gear === 'hover' ? lift + 0.05 : 0.38 * s;
  const lowTop = info.gear === 'wheels' ? Math.max(0.9, ...v.wheels.map((w) => wheelRadius(w) * 2 + 0.06)) : trackTop * 0.92;
  // lower hull between the running gear
  ext(parts.get(paintDark), [[xr + 0.25, belly], [xf - 0.8, belly], [xf - 0.15, lowTop], [xr + 0.05, lowTop]], inner.l + 0.02, inner.r - 0.02, F.metal, F.metal);
  // upper hull over the full width (sponsons over the tracks): long sloped glacis in front
  const glacis = (info.turret ? 1.6 : 1.1) * s;
  const nose = deck - (info.turret ? 0.5 : 0.85) * s;
  ext(g, [[xr, lowTop], [xf - 0.05, lowTop], [xf, nose], [xf - glacis, deck], [xr + 0.12, deck], [xr, deck - 0.12]], zl + 0.02, zr - 0.02, F.metal, F.metal, 0.5, [0.5, 0.5]);
  // lower glacis / front plate between the tracks
  ext(g, [[xf - 0.75, belly + 0.1], [xf - 0.05, lowTop], [xf - 0.4, lowTop]], inner.l + 0.05, inner.r - 0.05, F.metal, F.metal);
  // engine deck grilles at the rear, and the rear plate's exhaust
  const fins = parts.get(darkenC(paint, 0.6));
  const gx0 = xr + 0.25, gx1 = xr + Math.min(2.2, len * 0.22);
  chamferBox(fins, gx0, Y(deck - 0.01), zc - W * 0.3, gx1, Y(deck + 0.03), zc + W * 0.3, 0.02, F.fins, F.fins);
  chamferBox(parts.get(0x24241f), xr - 0.04, Y(deck - 0.5 * s), zc - W * 0.22, xr + 0.05, Y(deck - 0.18 * s), zc + W * 0.22, 0.02, F.fins, F.dark);

  // stray cells outside the hull box: low armoured blocks
  for (const [mx, my] of cells) {
    if (mx - 0.5 >= xr - 1e-6 && mx + 0.5 <= xf + 1e-6) continue;
    const front = mx > xf;
    const top = deck - 0.45 * s;
    ext(g, front ? [[mx - 0.5, belly], [mx + 0.35, belly + 0.1], [mx + 0.45, belly + 0.3], [mx - 0.5, Math.min(top, nose - 0.1)]] : [[mx - 0.45, belly], [mx + 0.5, belly], [mx + 0.5, top], [mx - 0.4, top - 0.1]], my - 0.45, my + 0.45, F.metal, F.metal);
  }

  // headlights in guards on the glacis corners, tail lamps on the rear plate
  for (const l of v.parts.filter((q) => (has(q, 'CONE_LIGHT') || has(q, 'WIDE_CONE_LIGHT')) && q.hp > 0)) {
    const lz = Math.max(zl + 0.5, Math.min(zr - 0.5, l.my));
    chamferBox(parts.get(steel), xf - 0.25, Y(nose - 0.12), lz - 0.18, xf + 0.02, Y(nose + 0.12), lz + 0.18, 0.04, F.dark, F.dark);
    lampBox(lamps, xf + 0.03, Y(nose), lz, 0.12, 0.06, 1);
  }
  for (const z of [zl + 0.7, zr - 0.7]) lampBox(tails, xr - 0.02, Y(deck - 0.25), z, 0.08, 0.05, -1);

  // --- turret & guns ---
  // The turret, its main gun and each machine gun are built as their own geometry around their
  // pivots (turret ring, trunnion, pintle) so vehicleMesh.ts can traverse and elevate them toward
  // where the gunner looks (src/game/turret.ts turretAim). Built in hull coordinates first, then
  // moved so the pivot is the origin (`pivoted`).
  const gun = mainGun(v);
  const mgs = v.parts.filter((p) => has(p, 'TURRET') && p !== gun && info.turret).concat(info.turret ? [] : v.parts.filter((p) => has(p, 'TURRET')));
  const ring = v.parts.filter((p) => has(p, 'TURRET_MOUNT'));
  const roofY = info.turret ? deck + (info.turret === 'box' ? 1.05 : info.turret === 'ifv' ? 0.72 : 0.95) * s : deck;
  const cupolas: { x: number; z: number; mg: VehiclePart | null; y: number; onTurret: boolean }[] = [];
  const tb = new Batches(), gb = new Batches();
  let turretPivot: V3 | null = null, gunPivot: V3 | null = null, gunLen = 0;
  /** The turret's footprint as a circle it never leaves while traversing (hull coords). */
  let turretFoot: { x: number; z: number; r: number } | undefined;
  if (info.turret) {
    // Centred on the turret ring (BN's turret mounts); an MBT's sits a little aft of it, so
    // the long barrel balances over the hull's middle.
    const src = ring.length ? ring : gun ? [gun] : [];
    let tx = src.length ? src.reduce((a, p) => a + p.mx, 0) / src.length : xr + len * 0.45;
    let tz = src.length ? src.reduce((a, p) => a + p.my, 0) / src.length : zc;
    tz = zc + Math.max(-0.4, Math.min(0.4, tz - zc));
    const kind = info.turret;
    const Lt = kind === 'box' ? Math.min(5, Math.max(2.8, len * 0.46)) : kind === 'ifv' ? Math.min(3, Math.max(1.6, len * 0.3)) : Math.min(5.2, Math.max(2.4, len * 0.48));
    const Wt = W * (kind === 'box' ? 0.74 : kind === 'ifv' ? 0.46 : 0.64);
    if (kind === 'mbt') tx -= 0.25;
    if (kind === 'box') tx = Math.min(tx, xr + Lt / 2 + 0.3);
    tx = Math.max(xr + Lt / 2 + (kind === 'mbt' ? 0.8 : 0.1), Math.min(xf - glacis - Lt / 2 + 0.6, tx));
    turretFoot = { x: tx, z: tz, r: Math.min(Lt, Wt) / 2 };
    const tg = tb.get(paint);
    const fx = tx + Lt / 2, bx = tx - Lt / 2;
    const y0 = deck - 0.02, y1 = roofY;
    turretPivot = [tx, Y(y0), tz];
    // the turret ring under it stays on the hull (it shows as the turret turns)
    chamferBox(parts.get(paintDark), tx - Wt * 0.3, Y(y0 - 0.04), tz - Wt * 0.3, tx + Wt * 0.3, Y(y0 + 0.03), tz + Wt * 0.3, Wt * 0.15, F.metal, F.dark);
    if (kind === 'mbt') {
      // Abrams-style: a wide, flat, faceted turret with a chisel front and sloped cheeks
      const lo = mirrored(tx, tz, [[Lt / 2, Wt * 0.28], [Lt * 0.2, Wt * 0.5], [-Lt / 2, Wt * 0.48]]);
      const hi = mirrored(tx, tz, [[Lt / 2 - 0.4 * s, Wt * 0.22], [Lt * 0.16, Wt * 0.42], [-Lt / 2 + 0.05, Wt * 0.41]]);
      lft(tg, lo, y0, hi, y1, F.metal, F.metal);
      // bustle at the rear, with its stowage rack
      const b0 = y0 + 0.28 * s, b1 = y1 - 0.06;
      const blen = Math.min(1.1, Lt * 0.24);
      lft(tg, mirrored(bx + 0.1, tz, [[0, Wt * 0.36], [-blen, Wt * 0.34]]), b0, mirrored(bx + 0.1, tz, [[0, Wt * 0.35], [-blen + 0.06, Wt * 0.32]]), b1, F.metal, F.metal);
      const rk = tb.get(0x2c2c28);
      const rx0 = bx - blen + 0.02, rx1 = bx + 0.1, rz = Wt * 0.38, ry = b1 + 0.22 * s;
      for (const z of [tz - rz, tz + rz]) {
        tube(rk, [rx0, Y(ry), z], [rx1 + 0.4, Y(ry), z], 0.03, F.dark, 5);
        for (const x of [rx0, (rx0 + rx1) / 2]) tube(rk, [x, Y(b1 - 0.05), z], [x, Y(ry), z], 0.025, F.dark, 5);
      }
      tube(rk, [rx0, Y(ry), tz - rz], [rx0, Y(ry), tz + rz], 0.03, F.dark, 5);
      // rack's contents: a couple of bedrolls and boxes
      chamferBox(tb.get(darkenC(OLIVE, 0.9)), rx0 + 0.1, Y(b1), tz - rz + 0.15, rx0 + 0.55, Y(b1 + 0.18 * s), tz - 0.2, 0.05, F.fabric, F.fabric);
      chamferBox(tb.get(0x3f4029), rx0 + 0.1, Y(b1), tz + 0.3, rx0 + 0.6, Y(b1 + 0.2 * s), tz + rz - 0.1, 0.03, F.ribbed, F.ribbed);
      // smoke grenade launchers on the front cheeks
      for (const sg of [-1, 1]) chamferBox(tb.get(steel), tx + Lt * 0.05, Y(y1 - 0.05), tz + sg * Wt * 0.45 - 0.13, tx + Lt * 0.05 + 0.32, Y(y1 + 0.08), tz + sg * Wt * 0.45 + 0.13, 0.04, F.dark, F.dark);
      // gunner's sight box (left front of the roof)
      chamferBox(tb.get(paintDark), fx - 0.95 * s, Y(y1), tz - Wt * 0.22, fx - 0.5 * s, Y(y1 + 0.22 * s), tz - Wt * 0.22 + 0.4, 0.04, F.metal, F.dark);
      cupolas.push({ x: tx - Lt * 0.08, z: tz + Wt * 0.22, mg: null, y: y1, onTurret: true }, { x: tx - Lt * 0.1, z: tz - Wt * 0.2, mg: null, y: y1, onTurret: true });
    } else if (kind === 'box') {
      // M109-style: a tall slab-sided box, the gun out of the front face
      const lo = mirrored(tx, tz, [[Lt / 2, Wt * 0.44], [Lt / 2 - 0.3, Wt * 0.5], [-Lt / 2, Wt * 0.5]]);
      const hi = mirrored(tx, tz, [[Lt / 2 - 0.35 * s, Wt * 0.4], [Lt / 2 - 0.55 * s, Wt * 0.47], [-Lt / 2 + 0.05, Wt * 0.47]]);
      lft(tg, lo, y0, hi, y1, F.metal, F.metal);
      chamferBox(tb.get(paintDark), bx - 0.1, Y(y0 + 0.25), tz - Wt * 0.4, bx + 0.05, Y(y1 - 0.15), tz + Wt * 0.4, 0.02, F.ribbed, F.dark);
      cupolas.push({ x: tx - Lt * 0.05, z: tz + Wt * 0.25, mg: null, y: y1, onTurret: true }, { x: tx - Lt * 0.15, z: tz - Wt * 0.25, mg: null, y: y1, onTurret: true });
    } else {
      // IFV: a small angular two-man turret
      const lo = mirrored(tx, tz, [[Lt / 2, Wt * 0.32], [Lt * 0.15, Wt * 0.5], [-Lt / 2, Wt * 0.5]]);
      const hi = mirrored(tx, tz, [[Lt / 2 - 0.3 * s, Wt * 0.26], [Lt * 0.1, Wt * 0.42], [-Lt / 2 + 0.08, Wt * 0.42]]);
      lft(tg, lo, y0, hi, y1, F.metal, F.metal);
      cupolas.push({ x: tx - Lt * 0.1, z: tz + Wt * 0.2, mg: null, y: y1, onTurret: true });
      if (v.parts.some((p) => has(p, 'TURRET') && /atgm|tow/.test(p.def.item))) {
        // the TOW box folded against the turret's left side
        chamferBox(tb.get(paintDark), tx - Lt * 0.35, Y(y0 + 0.3 * s), tz - Wt * 0.5 - 0.4, tx + Lt * 0.25, Y(y1 + 0.05), tz - Wt * 0.5 - 0.02, 0.05, F.metal, F.metal);
      }
    }
    // the main gun: mantlet and barrel, elevating about the trunnion just inside the turret face
    if (gun) {
      const gy = y0 + (y1 - y0) * (kind === 'box' ? 0.5 : 0.55);
      const r = (kind === 'ifv' ? 0.05 : 0.1) * Math.max(0.85, s);
      const Lg = kind === 'ifv' ? Math.min(2.8, len * 0.32) : kind === 'box' ? Math.min(6.5, len * 0.6) : Math.min(5.6, len * 0.52);
      const broken = gun.hp <= 0;
      const tip = fx + (broken ? Lg * 0.35 : Lg);
      const bar = gb.get(kind === 'ifv' ? 0x23231f : darkenC(paint, 0.85));
      gunPivot = [fx - 0.1, Y(gy), tz];
      gunLen = tip - gunPivot[0];
      // mantlet
      chamferBox(gb.get(paintDark), fx - 0.3, Y(gy - (kind === 'ifv' ? 0.18 : 0.28) * s), tz - (kind === 'ifv' ? 0.22 : 0.42), fx + 0.22, Y(gy + (kind === 'ifv' ? 0.16 : 0.24) * s), tz + (kind === 'ifv' ? 0.22 : 0.42), 0.06, F.metal, F.metal);
      tube(bar, [fx + 0.2, Y(gy), tz], [tip, Y(gy), tz], r, F.metal, far ? 6 : 8);
      if (!broken && kind !== 'ifv') {
        // thermal sleeve bands / bore evacuator, and the muzzle (brake on a howitzer)
        const ev = fx + 0.2 + (tip - fx) * 0.45;
        tube(bar, [ev, Y(gy), tz], [ev + 0.5, Y(gy), tz], r * 1.35, F.metal, far ? 6 : 8);
        if (kind === 'box') chamferBox(bar, tip - 0.45, Y(gy - r * 1.6), tz - r * 2.2, tip + 0.02, Y(gy + r * 1.6), tz + r * 2.2, 0.03, F.fins, F.dark);
        else tube(bar, [tip - 0.25, Y(gy), tz], [tip, Y(gy), tz], r * 1.15, F.metal, far ? 6 : 8);
      }
      if (kind === 'mbt') chamferBox(gb.get(paintDark), fx + 0.1, Y(gy + r + 0.02), tz - 0.12, fx + 0.5, Y(gy + r + 0.16), tz + 0.12, 0.03, F.metal, F.dark);
    }
    // MGs go on the cupola on their own side (the M1's M2 on the commander's, right; the M240 on
    // the loader's, left: the seat you man it from is under it), overflow ones on the roof
    [...mgs].sort((a, b) => Math.abs(b.my - tz) - Math.abs(a.my - tz)).forEach((mg, i) => {
      const free = cupolas.filter((c) => !c.mg).sort((a, b) => Math.abs(a.z - mg.my) - Math.abs(b.z - mg.my))[0];
      if (free) free.mg = mg;
      else cupolas.push({ x: tx - Lt * 0.3, z: tz + (i % 2 ? -1 : 1) * Wt * 0.3, mg, y: y1, onTurret: true });
    });
  } else {
    // APC: MGs on pintles / cupolas at their own cells on the roof
    for (const mg of mgs) cupolas.push({ x: mg.mx, z: Math.max(zl + 0.5, Math.min(zr - 0.5, mg.my)), mg, y: deck, onTurret: false });
  }
  const mgBuilds: { part: VehiclePart; batches: Batches; pivot: V3; len: number; onTurret: boolean }[] = [];
  for (const c of cupolas) {
    const cy = c.y;
    const cr = 0.3 * s;
    const cb = c.onTurret ? tb : parts;
    chamferBox(cb.get(paintDark), c.x - cr, Y(cy - 0.02), c.z - cr, c.x + cr, Y(cy + 0.2 * s), c.z + cr, cr * 0.6, F.metal, F.metal);
    // hatch lid, flat on top
    chamferBox(cb.get(steel), c.x - cr * 0.8, Y(cy + 0.2 * s), c.z - cr * 0.8, c.x + cr * 0.8, Y(cy + 0.25 * s), c.z + cr * 0.8, cr * 0.5, F.dark, F.metal);
    if (c.mg) {
      const big = c.mg.def.weight >= 30_000;
      const my = cy + 0.38 * s;
      const mb = new Batches();
      const mgc = mb.get(c.mg.hp > 0 ? 0x24241f : 0x3a3030);
      // the pintle post stays with the cupola; receiver and barrel swing on top of it
      tube(cb.get(c.mg.hp > 0 ? 0x24241f : 0x3a3030), [c.x, Y(cy + 0.24 * s), c.z], [c.x, Y(my - 0.06), c.z], 0.025, F.dark, 5);
      chamferBox(mgc, c.x - 0.25, Y(my - 0.07), c.z - 0.06, c.x + 0.15, Y(my + 0.07), c.z + 0.06, 0.02, F.dark, F.dark);
      const tipX = c.x + (c.mg.hp > 0 ? (big ? 1.2 : 0.8) : 0.15);
      if (c.mg.hp > 0) {
        tube(mgc, [c.x + 0.15, Y(my), c.z], [tipX, Y(my), c.z], big ? 0.03 : 0.02, F.dark, 5);
        // the ammo can on the left of the receiver
        chamferBox(mb.get(0x3f4029), c.x - 0.12, Y(my - 0.16), c.z - 0.2, c.x + 0.08, Y(my - 0.02), c.z - 0.07, 0.02, F.ribbed, F.dark);
      }
      mgBuilds.push({ part: c.mg, batches: mb, pivot: [c.x, Y(my), c.z], len: tipX - c.x, onTurret: c.onTurret });
    }
  }
  // driver's hatch on the glacis / hull roof (the driver's head shows through it)
  const drv = v.driverSeat();
  const dx = drv ? drv.mx : xf - glacis - 0.3, dz = drv ? Math.max(zl + 0.6, Math.min(zr - 0.6, drv.my)) : zc;
  const hatchY = deck;
  chamferBox(parts.get(steel), dx - 0.3, Y(hatchY - 0.02), dz - 0.3, dx + 0.3, Y(hatchY + 0.06), dz + 0.3, 0.16, F.dark, F.dark);

  // the driver: sitting low in the hull, head and shoulders out of the hatch
  const hipY = Y(hatchY - 0.62);
  const ride = drv
    ? {
        kind: 'seat' as const, hip: [dx - 0.05, hipY, dz] as V3, lean: 0,
        grips: [[dx + 0.35, hipY + 0.3, dz + 0.2], [dx + 0.35, hipY + 0.3, dz - 0.2]] as [V3, V3],
        feet: [[dx + 0.6, hipY - 0.4, dz + 0.12], [dx + 0.6, hipY - 0.4, dz - 0.12]] as [V3, V3],
      }
    : undefined;

  const out = (b: Batches | GeomBuilder): THREE.BufferGeometry | null => (b instanceof Batches ? b.build() : b.vertexCount ? b.build() : null);
  // Geometry around its own pivot: vehicleMesh.ts places it there and turns it.
  const pivoted = (b: Batches, at: V3): THREE.BufferGeometry | null => {
    const g = b.build();
    g?.translate(-at[0], -at[1], -at[2]);
    return g;
  };
  const rel = (a: V3, to: V3 | null): V3 => (to ? [a[0] - to[0], a[1] - to[1], a[2] - to[2]] : a);
  const turrets: TurretBuild[] = [];
  if (turretPivot || mgBuilds.length) {
    const tp = turretPivot;
    turrets.push({
      part: gun && info.turret ? gun : null,
      geo: tp ? pivoted(tb, tp) : null,
      pivot: tp ?? [0, 0, 0],
      gun: gun && gunPivot && tp ? { geo: pivoted(gb, gunPivot), pivot: rel(gunPivot, tp), len: gunLen } : null,
      mgs: mgBuilds.map((m) => ({ part: m.part, geo: pivoted(m.batches, m.pivot), pivot: m.onTurret && tp ? rel(m.pivot, tp) : m.pivot, len: m.len, onTurret: m.onTurret && !!tp })),
    });
  }
  return {
    body: null, roof: null, parts: out(parts), glass: null, lamps: out(lamps), tails: out(tails), beacons: null,
    skin: null, skinJob: null, skinKey: '', layout: L,
    // the eye just above the open hatch: you drive head-out, over the glacis
    eyeH: hatchY + 0.35, deckY: deck, turretTop: roofY, turretFoot, driverZ: drv ? dz : null, driverX: drv ? dx : undefined, eyeX: drv ? dx + 0.05 : undefined,
    parkedLean: 0, bodyUsesParts: true, ride, turrets,
  };
}

