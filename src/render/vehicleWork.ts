import type * as THREE from 'three';
import { has, type Vehicle, type VehiclePart } from '../game/vehicle';
import { GeomBuilder, type V3 } from './geometry';
import { wheelRadius, type Layout } from './vehicleLayout';
import { Batches, chamferBox, faceNormal, partFrames, tube, wheel } from './vehicleGeom';
import { darkenC, lampBox, seat, steeringWheel, type ModelBuild } from './vehicleModel';
import { extrude, trackRun } from './vehicleTank';
import { isTrack, wheelRuns } from './vehicleFrame';
import { rimGrips, type RideAnchors } from './vehicleRider';
import type { TileFrame } from './textureSource';

// The "model" look for construction and farm machines: BN's excavator, trencher, mining
// roadheader, bandit bulldozer, forklift, engine crane / handjack, the tractors (wheeled,
// tracked, steam, robot) with their ploughs / seed drills / reapers, and the street sweeper.
// Their templates are frames (collision is the cells), and the frame look drew them as a
// grid of tiles: an excavator was a plated box with a grey block where the digging arm is.
//
// What gets drawn is read from the parts, never the prototype id:
//  - the work tool decides the machine: a ROCKWHEEL on treads is an excavator's boom, stick
//    and bucket (BN's excavator digs with it), on wheels a trencher's digging chain; ROADHEAD
//    a roadheader's cutter boom over a gathering apron; forklift_fork a mast with forks;
//    crane_* on a one-cell grid an engine hoist; PLOW / REAPER / PLANTER a tractor towing (or
//    pushing) the implements at their cells; SCOOP a sweeper; a row of rams across the bow of a
//    tracked grid a dozer blade;
//  - running gear: tread runs are tracks (trackRun, shared with the tanks), wheels are fat
//    work tyres (a tractor's fixed axle drawn big, as on the real thing);
//  - the cab: centred on the driver's seat, glass all round if BN gives the grid any glass,
//    an open canopy if it has a roof but no glass, a two-post ROPS bar otherwise; no seat
//    (the robot tractor / sweeper) means no cab, just a closed body;
//  - an engine burning coal or wood is a steam boiler with a stack.
// Paint: construction yellow, farm green with yellow hubs, a rusty yellow for a machine with
// guns on it (the bandit dozer), forklift orange, hoist red, sweeper white. A wreck (half its
// parts destroyed) is drawn burnt; a destroyed tool slumps or is missing, broken glass is out,
// a dead tread lies flat, a dead tyre is flat.
//
// Like the tanks and the roller, the body covers the cells it collides with and stays inside
// them: only the dozer blade's corners, a bucket's teeth and the like reach a few cm past.
//
// Local frame as vehicleMesh.ts: X = mount x (forward), Z = mount y (right), Y = metres above
// the ground (+ `base`, the z-level's floor).

export type WorkKind = 'excavator' | 'trencher' | 'roadheader' | 'dozer' | 'tractor' | 'forklift' | 'hoist' | 'sweeper';

export interface WorkInfo {
  kind: WorkKind;
  gear: 'tracks' | 'wheels';
}

const AIRBOAT = ['WING', 'ROTOR', 'BALLOON', 'PROPELLER', 'FLOATS'];
const IMPLEMENT = ['PLOW', 'REAPER', 'PLANTER'];

const YELLOW = 0xd09a1c, ORANGE = 0xc8681e, GREEN = 0x3f6a2c, RED = 0xa8302a, WHITE = 0xc8c8c0;
const BLACK = 0x232325, STEEL = 0x55575a, CHROME = 0xa8acb0;

/** Rams (BN ram_*) along the bow of the grid: a dozer blade if 3+ of them sit in a row. */
function bladeRow(v: Vehicle): { x: number; lo: number; hi: number; parts: VehiclePart[] } | null {
  const rams = v.parts.filter((p) => /^ram_/.test(p.def.id) && p.def.location === 'structure');
  if (rams.length < 3) return null;
  const xf = Math.max(...v.parts.map((p) => p.mx));
  const runs = wheelRuns(rams.filter((p) => p.mx === xf), 'y').sort((a, b) => b.parts.length - a.parts.length);
  const r = runs[0];
  return r && r.parts.length >= 3 ? { x: xf, lo: r.lo, hi: r.hi, parts: r.parts } : null;
}

/** Is this (frame) grid a work machine, and which? null = not one: it stays a frame. */
export function workMachine(v: Vehicle): WorkInfo | null {
  if (!v.parts.length || !v.wheels.length) return null;
  // Aircraft and boats (wings, rotors, hulls) are never work machines, whatever they carry.
  if (v.parts.some((p) => AIRBOAT.some((f) => has(p, f)))) return null;
  const gear = v.wheels.some(isTrack) ? 'tracks' : 'wheels';
  const any = (f: (p: VehiclePart) => boolean) => v.parts.some(f);
  let mounts = 0;
  for (const _ of v.mounts()) mounts++;
  let kind: WorkKind | null = null;
  if (any((p) => has(p, 'ROCKWHEEL'))) kind = gear === 'tracks' ? 'excavator' : 'trencher';
  else if (any((p) => has(p, 'ROADHEAD'))) kind = 'roadheader';
  else if (any((p) => p.def.id === 'forklift_fork')) kind = 'forklift';
  else if (mounts <= 2 && any((p) => /^crane/.test(p.def.id))) kind = 'hoist';
  // a tractor needs something to pull with: an engine or a team (a plough on a bare frame isn't one)
  else if (any((p) => IMPLEMENT.some((f) => has(p, f))) && v.engines.length) kind = 'tractor';
  else if (any((p) => has(p, 'SCOOP'))) kind = 'sweeper';
  else if (gear === 'tracks' && bladeRow(v)) kind = 'dozer';
  return kind ? { kind, gear } : null;
}

// --- solids ------------------------------------------------------------------------------

/** Quad / triangle wound away from `c` (the convex solid's centre): see vehicleTank.ts. */
function quadOut(g: GeomBuilder, c: V3, a: V3, b: V3, d: V3, e: V3, f: TileFrame, uv: readonly number[]): void {
  const n = faceNormal(a, b, d);
  const m: V3 = [(a[0] + d[0]) / 2 - c[0], (a[1] + d[1]) / 2 - c[1], (a[2] + d[2]) / 2 - c[2]];
  if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] >= 0) g.quad(a, b, d, e, n, uv, f);
  else g.quad(e, d, b, a, [-n[0], -n[1], -n[2]], [uv[2], uv[3], uv[0], uv[1]], f);
}

function triOut(g: GeomBuilder, c: V3, a: V3, b: V3, d: V3, f: TileFrame): void {
  const n = faceNormal(a, b, d);
  const m: V3 = [(a[0] + b[0] + d[0]) / 3 - c[0], (a[1] + b[1] + d[1]) / 3 - c[1], (a[2] + b[2] + d[2]) / 3 - c[2]];
  const uv = [a[0], a[2], b[0], b[2], d[0], d[2]];
  if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] >= 0) g.tri(a, b, d, n, uv, f, [1, 1, 1]);
  else g.tri(d, b, a, [-n[0], -n[1], -n[2]], [uv[4], uv[5], uv[2], uv[3], uv[0], uv[1]], f, [1, 1, 1]);
}

/** A convex plan polygon (x, z) extruded from y0 to y1, capped: house, hoods, hoppers. */
function prism(g: GeomBuilder, plan: [number, number][], y0: number, y1: number, side: TileFrame, top: TileFrame): void {
  const n = plan.length;
  const cx = plan.reduce((s, p) => s + p[0], 0) / n, cz = plan.reduce((s, p) => s + p[1], 0) / n;
  const c: V3 = [cx, (y0 + y1) / 2, cz];
  let run = 0;
  for (let i = 0; i < n; i++) {
    const [ax, az] = plan[i], [bx, bz] = plan[(i + 1) % n];
    const len = Math.hypot(bx - ax, bz - az);
    quadOut(g, c, [ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], side, [run, y0, run + len, y1]);
    run += len;
  }
  for (const y of [y0, y1]) for (let i = 0; i < n; i++) {
    const [ax, az] = plan[i], [bx, bz] = plan[(i + 1) % n];
    triOut(g, c, [cx, y, cz], [ax, y, az], [bx, y, bz], top);
  }
}

/** A cylinder from a to b with capped ends (pins, drums, hubs, rams). */
function cyl(g: GeomBuilder, a: V3, b: V3, r: number, f: TileFrame, cap: TileFrame, sides = 10): void {
  tube(g, a, b, r, f, sides);
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  const w: V3 = [d[0] / len, d[1] / len, d[2] / len];
  const up: V3 = Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u: V3 = [up[1] * w[2] - up[2] * w[1], up[2] * w[0] - up[0] * w[2], up[0] * w[1] - up[1] * w[0]];
  const ul = Math.hypot(...u);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const vv: V3 = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  for (const e of [a, b]) for (let i = 0; i < sides; i++) {
    const p = (k: number): V3 => {
      const t = (k / sides) * Math.PI * 2, cs = Math.cos(t) * r, sn = Math.sin(t) * r;
      return [e[0] + u[0] * cs + vv[0] * sn, e[1] + u[1] * cs + vv[1] * sn, e[2] + u[2] * cs + vv[2] * sn];
    };
    triOut(g, mid, e, p(i), p(i + 1), cap);
  }
}

/** A four-sided pyramid spike from `p` along `dir` (unit), base half-width r: dozer / ram spikes, picks. */
function spike(g: GeomBuilder, p: V3, dir: V3, len: number, r: number, f: TileFrame): void {
  const up: V3 = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u: V3 = [up[1] * dir[2] - up[2] * dir[1], up[2] * dir[0] - up[0] * dir[2], up[0] * dir[1] - up[1] * dir[0]];
  const ul = Math.hypot(...u);
  const uu: V3 = [u[0] / ul, u[1] / ul, u[2] / ul];
  const vv: V3 = [dir[1] * uu[2] - dir[2] * uu[1], dir[2] * uu[0] - dir[0] * uu[2], dir[0] * uu[1] - dir[1] * uu[0]];
  const tip: V3 = [p[0] + dir[0] * len, p[1] + dir[1] * len, p[2] + dir[2] * len];
  const c: V3 = [p[0] + dir[0] * len * 0.3, p[1] + dir[1] * len * 0.3, p[2] + dir[2] * len * 0.3];
  const q = [[1, 0], [0, 1], [-1, 0], [0, -1]].map(([a, b]) => [p[0] + (uu[0] * a + vv[0] * b) * r, p[1] + (uu[1] * a + vv[1] * b) * r, p[2] + (uu[2] * a + vv[2] * b) * r] as V3);
  for (let i = 0; i < 4; i++) triOut(g, c, q[i], q[(i + 1) % 4], tip, f);
}

/** The side-profile outline of a beam from a to b (x, y) with end thicknesses ta / tb. */
function beam(a: [number, number], b: [number, number], ta: number, tb: number): [number, number][] {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
  const nx = -dy / l, ny = dx / l;
  return [[a[0] - nx * ta / 2, a[1] - ny * ta / 2], [b[0] - nx * tb / 2, b[1] - ny * tb / 2], [b[0] + nx * tb / 2, b[1] + ny * tb / 2], [a[0] + nx * ta / 2, a[1] + ny * ta / 2]];
}

const lerp2 = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// --- build -------------------------------------------------------------------------------

type Frames = ReturnType<typeof partFrames>;

/** Everything the per-machine builders share: batches, extents, paint, lifted primitives. */
class Ctx {
  readonly F: Frames = partFrames();
  readonly parts = new Batches();
  readonly roof = new Batches();
  readonly beacons = new Batches();
  readonly glass = new GeomBuilder();
  readonly lamps = new GeomBuilder();
  readonly tails = new GeomBuilder();
  readonly cells: [number, number][] = [];
  readonly xr: number; readonly xf: number; readonly zl: number; readonly zr: number; readonly zc: number;
  readonly wrecked: boolean;
  paint = YELLOW;
  paintDark = darkenC(YELLOW, 0.7);
  /** Hub / rim colour (tractors: yellow on green). */
  hub = YELLOW;
  constructor(readonly v: Vehicle, readonly base: number, readonly far: boolean) {
    for (const k of v.mounts()) this.cells.push([Math.floor(k / 1024) - 512, (k % 1024) - 512]);
    const xs = this.cells.map(([x]) => x), ys = this.cells.map(([, y]) => y);
    this.xr = Math.min(...xs) - 0.5; this.xf = Math.max(...xs) + 0.5;
    this.zl = Math.min(...ys) - 0.5; this.zr = Math.max(...ys) + 0.5;
    this.zc = (this.zl + this.zr) / 2;
    // A wreck: half of the parts that aren't tyres / treads destroyed (status-1 spawns lose
    // a part here and there; the burnt-out look and a fire leave most of it at 0 hp).
    const body = v.parts.filter((p) => !has(p, 'WHEEL'));
    this.wrecked = body.length > 0 && body.filter((p) => p.hp <= 0).length * 2 >= body.length;
  }
  setPaint(c: number, hub = c): void {
    // a wreck is scorched: darker and pulled toward soot, so it doesn't just read as shade
    const burn = (k: number) => {
      const d = darkenC(k, 0.5), soot = 0x2a2622, t = 0.45;
      const ch = (s: number) => Math.round(((d >> s) & 255) * (1 - t) + ((soot >> s) & 255) * t);
      return (ch(16) << 16) | (ch(8) << 8) | ch(0);
    };
    this.paint = this.wrecked ? burn(c) : c;
    this.paintDark = darkenC(this.paint, 0.7);
    this.hub = this.wrecked ? burn(hub) : hub;
  }
  Y = (h: number) => this.base + h;
  g = (tint: number) => this.parts.get(tint);
  box(tint: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r = 0.05, side: TileFrame = this.F.metal, top: TileFrame = this.F.metal): void {
    chamferBox(this.parts.get(tint), x0, this.Y(y0), z0, x1, this.Y(y1), z1, Math.min(r, (x1 - x0) / 2.2, (z1 - z0) / 2.2), side, top);
  }
  ext(tint: number, loop: [number, number][], z0: number, z1: number, side: TileFrame = this.F.metal, cap: TileFrame = this.F.metal): void {
    extrude(this.parts.get(tint), loop.map(([x, y]) => [x, this.Y(y)]), Math.min(z0, z1), Math.max(z0, z1), side, cap, 1, [0.5, 0.5]);
  }
  prism(tint: number, plan: [number, number][], y0: number, y1: number, side: TileFrame = this.F.metal, top: TileFrame = this.F.metal): void {
    prism(this.parts.get(tint), plan, this.Y(y0), this.Y(y1), side, top);
  }
  cyl(tint: number, a: V3, b: V3, r: number, sides = 10, f: TileFrame = this.F.metal): void {
    cyl(this.parts.get(tint), [a[0], this.Y(a[1]), a[2]], [b[0], this.Y(b[1]), b[2]], r, f, this.F.dark, this.far ? Math.min(sides, 8) : sides);
  }
  tube(tint: number, a: V3, b: V3, r: number, sides = 6, f: TileFrame = this.F.dark): void {
    tube(this.parts.get(tint), [a[0], this.Y(a[1]), a[2]], [b[0], this.Y(b[1]), b[2]], r, f, sides);
  }
  spike(tint: number, p: V3, dir: V3, len: number, r: number): void {
    spike(this.parts.get(tint), [p[0], this.Y(p[1]), p[2]], dir, len, r, this.F.metal);
  }
  /** Hydraulic ram from a to b: a dark barrel over the first 55 %, a chrome rod beyond. */
  ram(a: V3, b: V3, r = 0.08): void {
    const m: V3 = [a[0] + (b[0] - a[0]) * 0.55, a[1] + (b[1] - a[1]) * 0.55, a[2] + (b[2] - a[2]) * 0.55];
    this.cyl(BLACK, a, m, r, 8);
    this.cyl(CHROME, m, b, r * 0.55, 6);
  }
  glassPane(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    this.glass.box(x0, this.Y(y0), z0, x1, this.Y(y1), z1, 63, this.F.light, this.F.light, this.Y(y0));
  }
  /** Any of these parts alive? */
  alive(flag: string): boolean {
    return this.v.parts.some((p) => has(p, flag) && p.hp > 0);
  }
  find(f: (p: VehiclePart) => boolean): VehiclePart | undefined {
    return this.v.parts.find(f);
  }
  out(b: Batches | GeomBuilder): THREE.BufferGeometry | null {
    return b instanceof Batches ? b.build() : b.vertexCount ? b.build() : null;
  }
}

interface Tracks {
  h: number;
  x0: number;
  x1: number;
  /** Inner faces of the left / right tracks: the hull between them. */
  inL: number;
  inR: number;
  outL: number;
  outR: number;
}

/** One belt per run of tread cells, sized from BN's tread diameter / width (cm). */
function tracks(c: Ctx): Tracks {
  const ws = c.v.wheels.filter(isTrack);
  const ys = ws.map((q) => q.my);
  const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
  let h = 0, x0 = Infinity, x1 = -Infinity, inL = -Infinity, inR = Infinity, outL = Infinity, outR = -Infinity;
  for (const run of wheelRuns(ws, 'x')) {
    const w = run.parts[0];
    const dir: -1 | 1 = w.my <= mid ? -1 : 1;
    // tread1 75 cm -> 0.69 m tall, tread2 125 cm -> 0.91 m
    const d = (w.def.wheel?.diameter ?? 75) / 100, wd = (w.def.wheel?.width ?? 40) / 100;
    const th = Math.max(0.6, Math.min(0.95, 0.35 + d * 0.45));
    const width = Math.max(0.4, Math.min(0.85, wd * 1.15));
    const zo = w.my + dir * 0.47, zi = zo - dir * width;
    const xa = run.lo - 0.47, xb = run.hi + 0.47;
    trackRun(c.parts, c.F, c.base, { xa, xb, zo, dir, width, h: th, s: 1, alive: run.parts.some((q) => q.hp > 0), far: c.far, rubber: 0x2c2c2a });
    h = Math.max(h, th);
    x0 = Math.min(x0, xa);
    x1 = Math.max(x1, xb);
    if (dir < 0) { inL = Math.max(inL, zi); outL = Math.min(outL, zo); }
    else { inR = Math.min(inR, zi); outR = Math.max(outR, zo); }
  }
  return {
    h: h || 0.6, x0: Number.isFinite(x0) ? x0 : c.xr, x1: Number.isFinite(x1) ? x1 : c.xf,
    inL: Number.isFinite(inL) ? inL : c.zl, inR: Number.isFinite(inR) ? inR : c.zr,
    outL: Number.isFinite(outL) ? outL : c.zl, outR: Number.isFinite(outR) ? outR : c.zr,
  };
}

/**
 * Work tyres: chunky, with a hub disc in the hub colour. `scale` lets a tractor draw its
 * fixed (driven) axle big; returns each wheel's drawn radius and outer face.
 */
function tyres(c: Ctx, scale: (w: VehiclePart) => number = () => 1): { w: VehiclePart; r: number; z: number; width: number }[] {
  const out: { w: VehiclePart; r: number; z: number; width: number }[] = [];
  for (const w of c.v.wheels.filter((q) => !isTrack(q))) {
    const r = wheelRadius(w) * scale(w);
    const width = Math.max(0.12, Math.min(0.55, ((w.def.wheel?.width ?? 20) / 100) * 1.25 * Math.sqrt(scale(w))));
    const dir = w.my < c.zc - 0.01 ? -1 : w.my > c.zc + 0.01 ? 1 : 0;
    const z = w.my + dir * (0.5 - width / 2 - 0.02);
    const flat = w.hp <= 0;
    const h = flat ? r * 0.82 : r;
    wheel(c.g(flat ? 0x3a3636 : 0x2e2e2c), w.mx, c.Y(h), z, r, width, c.F, { flat, sides: c.far ? 10 : r > 0.5 ? 18 : 14, rim: 'tread', rimFrac: 0.9 });
    // the rim: a disc in the hub colour, proud of the outer sidewall
    if (dir !== 0) {
      const zo = z + dir * (width / 2 - 0.02);
      c.cyl(c.hub, [w.mx, h, zo - dir * 0.04], [w.mx, h, zo + dir * 0.02], r * 0.58, 12);
      c.cyl(STEEL, [w.mx, h, zo + dir * 0.02], [w.mx, h, zo + dir * 0.07], r * 0.16, 8);
    }
    out.push({ w, r, z, width });
  }
  return out;
}

interface CabOpts {
  x0: number; x1: number; z0: number; z1: number;
  floor: number; top: number;
  /** glass on all sides above the waist (BN gave the grid windows), else open */
  glazed: boolean;
  roofed: boolean;
  frame: number;
  /** add a beacon on the roof */
  beacon?: boolean;
}

/** Operator cab / canopy / ROPS: four posts, roof, glass all round above a waist panel. */
function cab(c: Ctx, o: CabOpts): void {
  const post = c.g(BLACK);
  // a wreck's glass is out (a burnt-out cab keeps the odd pane in BN, but reads better empty)
  if (c.wrecked) o = { ...o, glazed: false, beacon: false };
  const pr = 0.055;
  if (o.roofed || o.glazed) {
    for (const [x, z] of [[o.x0, o.z0], [o.x0, o.z1], [o.x1, o.z0], [o.x1, o.z1]] as const) chamferBox(post, x - pr, c.Y(o.floor), z - pr, x + pr, c.Y(o.top), z + pr, 0.02, c.F.dark, c.F.dark);
  } else {
    // open seat: a two-post roll bar behind the operator
    for (const z of [o.z0, o.z1]) chamferBox(post, o.x0 - pr, c.Y(o.floor), z - pr, o.x0 + pr, c.Y(o.top), z + pr, 0.02, c.F.dark, c.F.dark);
    c.tube(BLACK, [o.x0, o.top, o.z0], [o.x0, o.top, o.z1], 0.06, 6, c.F.dark);
  }
  if (o.roofed) {
    chamferBox(c.roof.get(o.frame), o.x0 - 0.12, c.Y(o.top), o.z0 - 0.12, o.x1 + 0.12, c.Y(o.top + 0.1), o.z1 + 0.12, 0.08, c.F.metal, c.F.metal);
    if (o.beacon) chamferBox(c.beacons.get(0xffa020), (o.x0 + o.x1) / 2 - 0.25, c.Y(o.top + 0.1), o.z1 - 0.3, (o.x0 + o.x1) / 2 - 0.09, c.Y(o.top + 0.27), o.z1 - 0.14, 0.05, c.F.light, c.F.light);
  }
  if (o.glazed) {
    const w0 = o.floor + 0.62;
    for (const [a, b, d, e] of [[o.x0, o.z0, o.x1, o.z0 + 0.03], [o.x0, o.z1 - 0.03, o.x1, o.z1], [o.x1 - 0.03, o.z0, o.x1, o.z1], [o.x0, o.z0, o.x0 + 0.03, o.z1]] as const) {
      c.glassPane(a, w0, b, d, o.top - 0.03, e);
      c.box(o.frame, a, o.floor, b, d, w0, e, 0.01);
    }
    // a frame bar at the waist and under the roof all round
    for (const y of [w0, o.top - 0.04]) {
      c.tube(BLACK, [o.x0, y, o.z0], [o.x1, y, o.z0], 0.03, 4);
      c.tube(BLACK, [o.x0, y, o.z1], [o.x1, y, o.z1], 0.03, 4);
      c.tube(BLACK, [o.x0, y, o.z0], [o.x0, y, o.z1], 0.03, 4);
      c.tube(BLACK, [o.x1, y, o.z0], [o.x1, y, o.z1], 0.03, 4);
    }
  }
}

/** The operator's seat and controls; returns the rider anchors (and where the eye goes). */
function operator(c: Ctx, sx: number, dz: number, floor: number, controls: 'wheel' | 'levers'): { ride?: RideAnchors; seatX: number } {
  const st = c.v.parts.find((p) => has(p, 'SEAT') && c.v.driverSeat()?.mx === p.mx && c.v.driverSeat()?.my === p.my) ?? c.v.parts.find((p) => has(p, 'SEAT'));
  if (st) {
    const s2 = { ...st, mx: sx, my: dz } as VehiclePart;
    const L = { zOf: (my: number) => my, xOf: (mx: number) => mx } as Layout;
    seat(c.g(st.hp > 0 ? 0x2c2c30 : 0x3a3a3a), s2, L, c.base, floor, floor + 0.48, c.F, false);
  }
  if (!c.v.parts.some((p) => has(p, 'CONTROLS'))) return { seatX: sx };
  const hipX = sx - 0.1;
  const feet: [V3, V3] = [[hipX + 0.5, c.Y(floor + 0.08), dz + 0.12], [hipX + 0.5, c.Y(floor + 0.08), dz - 0.12]];
  if (controls === 'wheel') {
    c.box(BLACK, sx + 0.35, floor, dz - 0.22, sx + 0.58, floor + 0.72, dz + 0.22, 0.05, c.F.dark, c.F.dark);
    steeringWheel(c.g(0x1e1e22), sx + 0.4, c.Y(floor + 0.88), dz, 0.17, c.F.dark);
    return { seatX: sx, ride: { kind: 'seat', hip: [hipX, c.Y(floor + 0.55), dz], lean: -0.05, grips: rimGrips(sx + 0.4, c.Y(floor + 0.88), dz, 0.17, 0.45), feet } };
  }
  // levers / joysticks on consoles either side of the seat
  for (const s of [-1, 1]) {
    c.box(BLACK, sx - 0.05, floor, dz + s * 0.42, sx + 0.3, floor + 0.55, dz + s * 0.28, 0.04, c.F.dark, c.F.dark);
    c.tube(0x1e1e22, [sx + 0.2, floor + 0.55, dz + s * 0.35], [sx + 0.24, floor + 0.75, dz + s * 0.35], 0.022, 5);
  }
  const g1: V3 = [sx + 0.24, c.Y(floor + 0.75), dz + 0.35], g2: V3 = [sx + 0.24, c.Y(floor + 0.75), dz - 0.35];
  return { seatX: sx, ride: { kind: 'seat', hip: [hipX, c.Y(floor + 0.55), dz], lean: -0.05, grips: [g1, g2], feet } };
}

/** Driver's seat position: the controls' cell (or the grid's middle), z kept off the edges. */
function driver(c: Ctx, inset = 0.5): { x: number; z: number; has: boolean } {
  const d = c.v.driverSeat();
  if (!d) return { x: (c.xr + c.xf) / 2, z: c.zc, has: false };
  return { x: d.mx, z: Math.max(c.zl + inset, Math.min(c.zr - inset, d.my)), has: true };
}

/** Headlamps (CONE_LIGHT parts) on a face at x, and flood / work lamps (CIRCLE / HALF_CIRCLE). */
function workLamps(c: Ctx, frontX: number, y: number, zs: number[], flood: { x: number; y: number; z: number }[]): void {
  if (c.alive('CONE_LIGHT') || c.alive('WIDE_CONE_LIGHT')) for (const z of zs) lampBox(c.lamps, frontX, c.Y(y), z, 0.1, 0.07, 1);
  if (c.alive('CIRCLE_LIGHT') || c.alive('HALF_CIRCLE_LIGHT')) for (const f of flood) {
    c.box(BLACK, f.x - 0.1, f.y - 0.07, f.z - 0.12, f.x + 0.02, f.y + 0.09, f.z + 0.12, 0.03, c.F.dark, c.F.dark);
    lampBox(c.lamps, f.x + 0.03, c.Y(f.y + 0.01), f.z, 0.1, 0.07, 1);
  }
}

function tailLamps(c: Ctx, x: number, y: number, zs: number[]): void {
  for (const z of zs) lampBox(c.tails, x, c.Y(y), z, 0.08, 0.05, -1);
}

/** Guns mounted on the machine (the bandit dozer): a ring and a barrel over their cell. */
function guns(c: Ctx, topAt: (mx: number, my: number) => number): void {
  for (const gun of c.v.parts.filter((p) => has(p, 'TURRET'))) {
    const y = topAt(gun.mx, gun.my);
    const big = gun.def.weight >= 30_000;
    const z = Math.max(c.zl + 0.3, Math.min(c.zr - 0.3, gun.my));
    c.cyl(0x3a3c34, [gun.mx, y, z], [gun.mx, y + 0.18, z], 0.22, 8);
    c.box(0x2a2a2c, gun.mx - 0.3, y + 0.18, z - 0.12, gun.mx + 0.25, y + 0.42, z + 0.12, 0.04, c.F.dark, c.F.dark);
    if (gun.hp > 0) c.tube(0x2a2a2c, [gun.mx + 0.2, y + 0.3, z], [gun.mx + (big ? 1.5 : 0.9), y + 0.31, z], big ? 0.05 : 0.03, 6);
  }
}

interface Pose {
  eyeH: number;
  dx: number;
  dz: number;
  hasDriver: boolean;
  ride?: RideAnchors;
}

// --- excavator ---------------------------------------------------------------------------

function excavator(c: Ctx): Pose {
  c.setPaint(YELLOW);
  const F = c.F;
  const T = tracks(c);
  const tool = c.find((p) => has(p, 'ROCKWHEEL'))!;
  const toolOk = tool.hp > 0 && !c.wrecked;
  const bz = Math.max(c.zl + 0.4, Math.min(c.zr - 0.4, tool.my));
  // undercarriage: the car body between the tracks and the slew ring on it
  const H0 = T.h + 0.16;
  c.box(BLACK, T.x0 + 0.5, 0.3, T.inL + 0.02, T.x1 - 0.5, T.h * 0.82, T.inR - 0.02, 0.1, F.metal, F.metal);
  const hx = (T.x0 + T.x1) / 2;
  c.cyl(0x2a2a2a, [hx, T.h * 0.8, c.zc], [hx, H0, c.zc], Math.min(1.0, (T.inR - T.inL) / 2), 14);

  // the house: a plate over the tracks with a rounded counterweight at the back
  const hr = Math.max(c.xr + 0.05, T.x0 - 0.1), hf = Math.min(T.x1 + 0.05, tool.mx - 1.2);
  const zl = c.zl + 0.25, zr = c.zr - 0.25;
  const plan = (x0: number, x1: number, a: number, b: number, round: number): [number, number][] => [
    [x1, a], [x1, b], [x0 + round, b], [x0 + round * 0.3, b - round * 0.55], [x0, b - round * 1.3], [x0, a + round * 1.3], [x0 + round * 0.3, a + round * 0.55], [x0 + round, a],
  ];
  c.prism(c.paintDark, plan(hr, hf, zl, zr, 0.6), H0, H0 + 0.28);
  const d = driver(c, 0.55);
  // cab on the driver's side of the boom (left on BN's grid, as on real machines)
  const cz0 = Math.max(zl + 0.02, d.z - 0.55), cz1 = Math.min(d.z + 0.5, bz - 0.3);
  const cx1 = hf - 0.05, cx0 = Math.max(hr + 1.1, cx1 - 1.75);
  // engine / counterweight block behind the cab
  const ex1 = cx0 - 0.06;
  c.prism(c.paint, plan(hr, ex1, zl, zr, 0.6), H0 + 0.28, H0 + 1.12);
  c.prism(c.paint, plan(hr + 0.04, ex1 - 0.1, zl + 0.1, zr - 0.1, 0.55), H0 + 1.12, H0 + 1.2);
  // grilles on the engine hood, the counterweight's dark lower band
  c.box(darkenC(c.paint, 0.5), hr + 0.55, H0 + 1.19, c.zc - (zr - zl) * 0.15, ex1 - 0.35, H0 + 1.23, zr - 0.35, 0.02, F.fins, F.fins);
  c.prism(BLACK, plan(hr - 0.02, hr + 0.9, zl - 0.02, zr + 0.02, 0.6), H0 + 0.28, H0 + 0.5);
  // exhaust stack and a handrail along the hood's right edge
  c.cyl(BLACK, [ex1 - 0.5, H0 + 1.2, zr - 0.5], [ex1 - 0.5, H0 + 1.75, zr - 0.5], 0.07, 8);
  c.tube(c.paint, [hr + 0.7, H0 + 1.6, zr - 0.15], [ex1 - 0.2, H0 + 1.6, zr - 0.15], 0.03, 5);
  for (const x of [hr + 0.7, ex1 - 0.2]) c.tube(c.paint, [x, H0 + 1.2, zr - 0.15], [x, H0 + 1.6, zr - 0.15], 0.03, 5);
  // tool box / tanks right of the boom, in front of the engine
  if (zr - (bz + 0.35) > 0.25) c.box(c.paint, cx0, H0 + 0.28, bz + 0.35, hf - 0.15, H0 + 0.95, zr, 0.06);
  // walkway left of the cab
  if (cz0 - zl > 0.2) c.box(STEEL, cx0, H0 + 0.28, zl, hf - 0.05, H0 + 0.33, cz0 - 0.02, 0.02, F.ribbed, F.ribbed);

  // cab
  const floor = H0 + 0.28, top = floor + 1.72;
  const glazed = c.alive('WINDSHIELD') || c.alive('WINDOW');
  cab(c, { x0: cx0, x1: cx1, z0: cz0, z1: cz1, floor, top, glazed, roofed: c.v.parts.some((p) => has(p, 'ROOF') && p.hp > 0) || glazed, frame: c.paint, beacon: !c.wrecked });
  const op = operator(c, Math.max(cx0 + 0.45, Math.min(cx1 - 0.6, d.x)), (cz0 + cz1) / 2, floor, 'levers');
  workLamps(c, cx1 + 0.08, top - 0.12, [], [{ x: cx1 + 0.05, y: top - 0.1, z: cz0 + 0.2 }, { x: cx1 + 0.05, y: top - 0.1, z: cz1 - 0.2 }]);
  tailLamps(c, hr + 0.02, H0 + 0.75, [zl + 0.4, zr - 0.4]);

  // the digging arm: boom from a foot bracket at the house front, stick, bucket at the tool cell
  const bw = 0.24; // half the boom's width
  const front = tool.mx + 0.5;
  const P0: [number, number] = [hf - 0.3, H0 + 0.75];
  const span = front - P0[0];
  // parked: bucket curled in on the ground in front; slumped (tool destroyed / wreck): flatter
  const elbow: [number, number] = toolOk ? [P0[0] + span * 0.62, H0 + 2.65] : [P0[0] + span * 0.68, H0 + 1.45];
  const tip: [number, number] = toolOk ? [front - 0.32, 1.3] : [front - 0.15, 0.45];
  const knee = ((): [number, number] => {
    const m = lerp2(P0, elbow, 0.55);
    const dx = elbow[0] - P0[0], dy = elbow[1] - P0[1], l = Math.hypot(dx, dy);
    return [m[0] - (dy / l) * 0.32, m[1] + (dx / l) * 0.32];
  })();
  const zb0 = bz - bw, zb1 = bz + bw;
  c.box(c.paintDark, P0[0] - 0.35, H0 + 0.28, zb0 - 0.08, hf, H0 + 1.0, zb1 + 0.08, 0.05);
  c.ext(c.paint, beam(P0, knee, 0.5, 0.48), zb0, zb1);
  c.ext(c.paint, beam(knee, elbow, 0.48, 0.38), zb0, zb1);
  // joint fillers so the banana doesn't show a notch
  c.cyl(c.paint, [knee[0], knee[1], zb0], [knee[0], knee[1], zb1], 0.24, 10);
  c.cyl(c.paint, [elbow[0], elbow[1], zb0 + 0.04], [elbow[0], elbow[1], zb1 - 0.04], 0.2, 10);
  // stick, narrower
  c.ext(c.paint, beam(elbow, tip, 0.34, 0.26), bz - 0.17, bz + 0.17);
  for (const p of [P0, elbow, tip]) c.cyl(STEEL, [p[0], p[1], zb0 - 0.05], [p[0], p[1], zb1 + 0.05], 0.07, 8);
  // rams: a pair lifting the boom, one over the boom to the stick, one down the stick to the bucket
  const bm = lerp2(P0, knee, 0.75);
  for (const s of [-1, 1]) c.ram([hf - 0.05, H0 + 0.55, bz + s * (bw + 0.08)], [bm[0], bm[1] - 0.15, bz + s * (bw + 0.08)], 0.085);
  const kt = lerp2(knee, elbow, 0.1);
  c.ram([kt[0], kt[1] + 0.3, bz], [elbow[0] - 0.12, elbow[1] + 0.42, bz], 0.075);
  c.box(c.paint, elbow[0] - 0.2, elbow[1], bz - 0.1, elbow[0] + 0.05, elbow[1] + 0.5, bz + 0.1, 0.03);
  if (tool.hp > 0) {
    const st = lerp2(elbow, tip, 0.15);
    c.ram([st[0] + 0.2, st[1] + 0.1, bz], [tip[0] + 0.22, tip[1] + 0.12, bz], 0.06);
    // bucket: a D-section scoop hanging from the stick, teeth curled under toward the machine
    const [tx, ty] = tip;
    const drop = toolOk ? Math.min(1.12, ty - 0.08) : Math.min(0.75, ty);
    const bucket: [number, number][] = [[tx + 0.14, ty + 0.06], [tx + 0.32, ty - drop * 0.4], [tx + 0.18, ty - drop * 0.85], [tx - 0.1, ty - drop], [tx - 0.46, ty - drop * 0.9], [tx - 0.3, ty - drop * 0.2], [tx - 0.12, ty + 0.05]];
    c.ext(c.paint, bucket, bz - 0.46, bz + 0.46);
    // the cutting edge and teeth along it
    c.ext(BLACK, [[tx - 0.46, ty - drop * 0.9], [tx - 0.1, ty - drop], [tx - 0.12, ty - drop + 0.08], [tx - 0.44, ty - drop * 0.9 + 0.08]], bz - 0.47, bz + 0.47);
    for (let i = 0; i < 5; i++) {
      const z = bz - 0.38 + i * 0.19;
      c.spike(STEEL, [tx - 0.42, ty - drop * 0.9 + 0.04, z], [-0.85, -0.53, 0], 0.18, 0.045);
    }
  }
  return { eyeH: floor + 1.15, dx: op.seatX, dz: (cz0 + cz1) / 2, hasDriver: d.has, ride: op.ride };
}

// --- tractor-style bodies (trencher, wheeled / tracked tractors) --------------------------

/** Engine hood (or a steam boiler) from x0 to x1, centred on z = zc. */
function hood(c: Ctx, x0: number, x1: number, zc: number, hw: number, y0: number, y1: number, steam: boolean): void {
  const F = c.F;
  if (steam) {
    // boiler on its side, smokebox and stack at the front, firebox under the driver's end
    const r = Math.min(hw, (y1 - y0) / 2 + 0.1);
    const yc = y0 + r;
    c.cyl(0x2e2e30, [x0, yc, zc], [x1 - 0.25, yc, zc], r, 14);
    c.cyl(0x1c1c1e, [x1 - 0.25, yc, zc], [x1, yc, zc], r * 1.04, 14);
    for (const t of [0.25, 0.55, 0.85]) c.cyl(0x8a6a30, [x0 + (x1 - x0) * t, yc, zc], [x0 + (x1 - x0) * t + 0.05, yc, zc], r * 1.03, 14);
    c.cyl(0x1c1c1e, [x1 - 0.35, yc + r * 0.6, zc], [x1 - 0.35, yc + r + 0.9, zc], 0.11, 8);
    c.cyl(0x1c1c1e, [x1 - 0.35, yc + r + 0.85, zc], [x1 - 0.35, yc + r + 0.95, zc], 0.16, 8);
    c.box(0x2e2e30, x0 - 0.05, y0 - 0.25, zc - hw * 0.9, x0 + 0.4, yc + r * 0.6, zc + hw * 0.9, 0.05);
    // flywheel on the right
    c.cyl(0x2a2a2c, [x0 + 0.5, yc + r * 0.4, zc + hw + 0.02], [x0 + 0.5, yc + r * 0.4, zc + hw + 0.1], 0.4, 14);
    return;
  }
  // a sloped nose: profile extruded across the hood's width
  c.ext(c.paint, [[x0, y0], [x1, y0], [x1, y1 - 0.18], [x1 - 0.22, y1], [x0, y1]], zc - hw, zc + hw);
  // grille on the nose, louvres down the sides
  c.box(0x1c1c1e, x1 - 0.02, y0 + 0.08, zc - hw * 0.72, x1 + 0.02, y1 - 0.24, zc + hw * 0.72, 0.01, F.fins, F.dark);
  for (const s of [-1, 1]) c.box(darkenC(c.paint, 0.55), x0 + 0.25, y0 + (y1 - y0) * 0.35, zc + s * hw - 0.02, x1 - 0.3, y1 - 0.15, zc + s * hw + 0.02, 0.01, F.fins, F.fins);
}

/** Exhaust stack. */
function stack(c: Ctx, x: number, y0: number, y1: number, z: number): void {
  c.cyl(BLACK, [x, y0, z], [x, y1, z], 0.065, 8);
  c.cyl(BLACK, [x, y1 - 0.08, z], [x + 0.08, y1 + 0.02, z], 0.07, 6);
}

/** An implement (plough / reaper / seed drill / scoop) across z0..z1 at the cell column x; `dir` = its outward end (+1 front, -1 rear). */
function implement(c: Ctx, flag: string, x: number, z0: number, z1: number, dir: 1 | -1, under: boolean, ok: boolean): void {
  const F = c.F;
  const xi = x - dir * 0.45, xo = x + dir * 0.45; // inner / outer edges of the cell
  const w = z1 - z0;
  const blue = ok ? 0x2f4f8a : darkenC(0x2f4f8a, 0.5), red = ok ? 0x9a2a22 : darkenC(0x9a2a22, 0.5), grey = ok ? 0x6a6c6e : 0x3a3a3a;
  if (flag === 'PLOW') {
    // toolbar across, a mouldboard bottom per metre, staggered, shares on the ground
    const top = under ? 0.55 : 0.8;
    if (!under) {
      // toolbar across, and a diagonal main beam carrying the bottoms
      c.box(red, Math.min(xi, xo) + 0.05, top - 0.14, z0 + 0.05, Math.min(xi, xo) + 0.25, top, z1 - 0.05, 0.03);
      c.box(red, Math.max(xi, xo) - 0.25, top - 0.14, z0 + 0.05, Math.max(xi, xo) - 0.05, top, z1 - 0.05, 0.03);
      for (const z of [z0 + 0.15, (z0 + z1) / 2, z1 - 0.15]) c.box(red, Math.min(xi, xo) + 0.05, top - 0.12, z - 0.06, Math.max(xi, xo) - 0.05, top - 0.02, z + 0.06, 0.02);
    }
    const n = Math.max(1, Math.round(w / 0.9));
    for (let i = 0; i < n; i++) {
      const z = z0 + (w * (i + 0.5)) / n;
      const xs = x + dir * (((i % 2) - 0.5) * 0.25);
      c.tube(BLACK, [xs, top - 0.05, z], [xs + dir * 0.12, 0.25, z], 0.05, 5);
      // the mouldboard: a twisted plate, approximated as a raked slab turned 30 deg
      const lo = ok ? 0.03 : 0.12;
      c.ext(red, [[xs - 0.32, lo], [xs + 0.32, lo], [xs + 0.18, 0.38], [xs - 0.12, 0.42]], z - 0.12, z + 0.06, F.metal, F.metal);
      c.spike(STEEL, [xs + dir * 0.28, lo + 0.04, z - 0.03], [dir, -0.15, 0], 0.18, 0.05);
    }
    if (!under) {
      // gauge wheel at the end
      wheel(c.g(0x2e2e2c), xo - dir * 0.15, c.Y(0.22), z1 - 0.12, 0.22, 0.12, F, { sides: 10, rim: 'rim' });
    }
    return;
  }
  if (flag === 'REAPER') {
    // a header: cutter bar trough on the ground, side dividers, a bat reel above
    const xa = Math.min(xi, xo), xb = Math.max(xi, xo);
    c.ext(c.hub === YELLOW ? GREEN : c.paint, dir > 0 ? [[xa, 0.08], [xb, 0.04], [xb, 0.14], [xa + 0.15, 0.6], [xa, 0.6]] : [[xa, 0.04], [xb, 0.08], [xb, 0.6], [xb - 0.15, 0.6], [xa, 0.14]], z0, z1);
    for (const z of [z0, z1]) c.ext(c.paint, dir > 0 ? [[xa, 0.05], [xb + 0.1, 0.05], [xa + 0.2, 0.75], [xa, 0.75]] : [[xb, 0.05], [xa - 0.1, 0.05], [xb - 0.2, 0.75], [xb, 0.75]], z - 0.04, z + 0.04);
    c.box(BLACK, Math.min(xo - dir * 0.08, xo), 0.04, z0, Math.max(xo - dir * 0.08, xo), 0.09, z1, 0.01, F.fins, F.fins);
    if (ok) {
      // reel: a shaft and six bats around it
      const rx = x + dir * 0.1, ry = 0.85, rr = 0.36;
      c.cyl(STEEL, [rx, ry, z0 + 0.04], [rx, ry, z1 - 0.04], 0.04, 6);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        c.tube(0xb89a2a, [rx + Math.cos(a) * rr, ry + Math.sin(a) * rr, z0 + 0.06], [rx + Math.cos(a) * rr, ry + Math.sin(a) * rr, z1 - 0.06], 0.025, 4);
      }
      for (const z of [z0 + 0.06, z1 - 0.06]) for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI;
        c.tube(STEEL, [rx + Math.cos(a) * rr, ry + Math.sin(a) * rr, z], [rx - Math.cos(a) * rr, ry - Math.sin(a) * rr, z], 0.02, 4);
      }
      // arms from the header sides to the reel
      for (const z of [z0 + 0.02, z1 - 0.02]) c.tube(c.paint, [xi, 0.75, z], [rx, ry, z], 0.035, 5);
    }
    return;
  }
  if (flag === 'PLANTER') {
    // seed hopper on a frame, a row of disc openers below, press wheels behind
    const xa = Math.min(xi, xo) + 0.1, xb = Math.max(xi, xo) - 0.1;
    c.box(BLACK, xa, 0.32, z0 + 0.05, xb, 0.42, z1 - 0.05, 0.03);
    if (ok) {
      const hm = (xa + xb) / 2;
      c.ext(blue, [[hm - 0.15, 0.55], [hm + 0.15, 0.55], [xb, 1.1], [xa, 1.1]], z0 + 0.12, z1 - 0.12);
      c.box(darkenC(blue, 0.7), xa - 0.02, 1.1, z0 + 0.1, xb + 0.02, 1.16, z1 - 0.1, 0.02);
      for (const z of [z0 + 0.3, z1 - 0.3]) c.tube(BLACK, [hm, 0.42, z], [hm, 0.55, z], 0.05, 5);
    }
    const n = Math.max(2, Math.round(w / 0.45));
    for (let i = 0; i < n; i++) {
      const z = z0 + (w * (i + 0.5)) / n;
      c.tube(BLACK, [x, 0.35, z], [x, 0.18, z], 0.025, 4);
      c.cyl(grey, [x, 0.16, z - 0.02], [x, 0.16, z + 0.02], 0.15, 10);
    }
    return;
  }
  // SCOOP: a pickup head under the body, two side brooms ahead of it
  c.box(BLACK, x - 0.4, 0.06, z0 + 0.05, x + 0.4, 0.32, z1 - 0.05, 0.05, F.ribbed, F.dark);
  if (ok) c.cyl(0x6a5a3a, [x, 0.17, z0 + 0.1], [x, 0.17, z1 - 0.1], 0.15, 10, F.fabric);
}

/** Implements in the grid: per row of cells, runs of the same kind (gaps of plain frame filled). */
function drawImplements(c: Ctx, bodyX0: number, bodyX1: number): void {
  for (const flag of [...IMPLEMENT, 'SCOOP']) {
    const ps = c.v.parts.filter((p) => has(p, flag));
    const rows = new Map<number, VehiclePart[]>();
    for (const p of ps) rows.set(p.mx, [...(rows.get(p.mx) ?? []), p]);
    for (const [x, list] of rows) {
      const lo = Math.min(...list.map((p) => p.my)), hi = Math.max(...list.map((p) => p.my));
      // which end it faces: behind the body faces back, ahead faces forward; under it, either
      const dir: 1 | -1 = x > (bodyX0 + bodyX1) / 2 ? 1 : -1;
      // under the body (the robot tractor's plough between its axles) or hitched beyond it; not
      // BN's location: its plough is an 'under' part even on the tractors that tow it
      const under = x - 0.5 >= bodyX0 - 0.01 && x + 0.5 <= bodyX1 + 0.01;
      const ok = list.some((p) => p.hp > 0) && !c.wrecked;
      const span = hi - lo + 1;
      // A single-cell implement on a narrow tractor (the old tractor's plough / drill) is
      // still a working width: let it spread over the axle (wheel cells either side).
      const zw = span === 1 && !under ? Math.min(1.1, (c.zr - c.zl) / 2 - 0.05) : span / 2;
      const zm = (lo + hi) / 2;
      implement(c, flag, x, zm - zw + (span === 1 && !under ? 0 : 0.03), zm + zw - (span === 1 && !under ? 0 : 0.03), dir, under, ok);
      // hitch: a drawbar from the body's end to the implement
      if (!under) {
        const xe = dir > 0 ? bodyX1 : bodyX0;
        if (Math.abs(x - dir * 0.45 - xe) > 0.05) c.box(BLACK, Math.min(xe, x - dir * 0.4), 0.42, zm - 0.07, Math.max(xe, x - dir * 0.4), 0.52, zm + 0.07, 0.02);
        // three-point hitch: two lower links and the top link
        for (const s of [-1, 1]) c.tube(BLACK, [xe, 0.6, c.zc + s * 0.35], [x - dir * 0.35, 0.6, zm + s * Math.min(0.8, zw * 0.6)], 0.05, 6);
        c.tube(BLACK, [xe, 1.05, c.zc], [x - dir * 0.35, 0.85, zm], 0.045, 6);
      }
    }
  }
}

function tractor(c: Ctx, info: WorkInfo): Pose {
  const F = c.F;
  const v = c.v;
  const steamEngine = v.engines.some((e) => /coal|wood|charcoal/.test(e.def.fuel_type ?? ''));
  c.setPaint(steamEngine ? 0x5a3a28 : GREEN, YELLOW);
  const d = driver(c, 0.5);
  const robot = !v.parts.some((p) => has(p, 'SEAT'));
  const implX = v.parts.filter((p) => IMPLEMENT.some((f) => has(p, f)) && p.def.location !== 'under').map((p) => p.mx);
  // the body runs between the implement rows
  const rearImpl = implX.filter((x) => x < (d.has ? d.x : 0)), frontImpl = implX.filter((x) => x > (d.has ? d.x : 0));
  const bx0 = rearImpl.length ? Math.max(...rearImpl) + 0.5 : c.xr + 0.05;
  const bx1 = frontImpl.length ? Math.min(...frontImpl) - 0.5 : c.xf - 0.05;
  const engines = v.engines.length ? v.engines : [];
  let floor = 0.95, eyeH = 2.1, dx = d.x, dz = d.z, ride: RideAnchors | undefined;

  if (info.gear === 'tracks') {
    // tracked (Challenger-style): tracks, a long hood ahead of a big glass cab
    const T = tracks(c);
    floor = T.h + 0.35;
    const hz = Math.min(0.8, (T.inR - T.inL) / 2 + 0.25);
    c.box(c.paintDark, bx0 + 0.05, 0.35, T.inL + 0.02, bx1 - 0.05, floor, T.inR - 0.02, 0.08);
    // fenders over the tracks
    for (const [z0, z1] of [[T.outL, T.inL], [T.inR, T.outR]]) c.box(c.paint, T.x0 + 0.15, T.h + 0.04, Math.min(z0, z1) - 0.03, T.x1 - 0.1, T.h + 0.12, Math.max(z0, z1) + 0.03, 0.04);
    const eng = engines.length ? Math.min(...engines.map((e) => e.mx)) : d.x + 1;
    const hx0 = Math.min(eng - 0.5, d.x + 1.2);
    hood(c, hx0, bx1 - 0.05, c.zc, hz, floor - 0.1, floor + 0.95, steamEngine);
    stack(c, hx0 + 0.35, floor + 0.95, floor + 1.95, c.zc + hz * 0.55);
    const cx0 = Math.max(bx0 + 0.4, d.x - 1.15), cx1 = hx0 - 0.02;
    const cw = Math.min(1.05, (c.zr - c.zl) / 2 - 0.3);
    const cz0 = Math.max(c.zl + 0.3, d.z - cw), cz1 = Math.min(c.zr - 0.3, d.z + cw);
    c.box(c.paint, cx0 - 0.1, T.h + 0.12, cz0 - 0.1, cx1, floor, cz1 + 0.1, 0.05);
    const top = floor + 1.85;
    const glazed = c.alive('WINDSHIELD') || c.alive('WINDOW');
    cab(c, { x0: cx0, x1: cx1, z0: cz0, z1: cz1, floor, top, glazed, roofed: v.parts.some((p) => has(p, 'ROOF') && p.hp > 0) || glazed, frame: c.paint, beacon: !c.wrecked });
    const op = operator(c, Math.max(cx0 + 0.45, Math.min(cx1 - 0.6, d.x)), d.z, floor, 'wheel');
    dx = op.seatX; ride = op.ride; eyeH = floor + 1.15;
    // rear deck: fuel tank behind the cab, the hitch block under it
    c.box(c.paint, bx0 + 0.25, floor - 0.2, c.zc - 0.6, cx0 - 0.15, floor + 0.3, c.zc + 0.6, 0.18);
    c.box(BLACK, bx0 + 0.02, 0.4, c.zc - 0.45, bx0 + 0.5, floor - 0.2, c.zc + 0.45, 0.05);
    workLamps(c, bx1 - 0.02, floor + 0.55, [c.zc - hz * 0.6, c.zc + hz * 0.6], [{ x: cx1 + 0.05, y: top - 0.1, z: cz0 + 0.2 }, { x: cx1 + 0.05, y: top - 0.1, z: cz1 - 0.2 }]);
    tailLamps(c, bx0 + 0.03, floor + 0.2, [c.zc - 0.6, c.zc + 0.6]);
    // mirrors on arms from the cab front corners
    for (const m of v.parts.filter((p) => has(p, 'VISION') && has(p, 'PROTRUSION') && p.hp > 0)) {
      const s = m.my < c.zc ? -1 : 1;
      const zc = s < 0 ? cz0 : cz1;
      c.tube(BLACK, [cx1, top - 0.35, zc], [cx1 + 0.1, top - 0.3, zc + s * 0.45], 0.02, 4);
      c.box(BLACK, cx1 + 0.05, top - 0.55, zc + s * 0.45 - 0.08, cx1 + 0.12, top - 0.2, zc + s * 0.45 + 0.08, 0.02, F.chrome, F.dark);
    }
  } else {
    // wheeled: big fixed-axle tyres, small steering ones, narrow hood, seat between the fenders
    const steer = (w: VehiclePart) => has(w, 'STEERABLE') || /steerable/.test(w.def.id) || v.partsAt(w.mx, w.my).some((p) => /steerable/.test(p.def.id));
    const anyFixed = v.wheels.some((w) => !steer(w));
    const big = (w: VehiclePart) => (anyFixed && !steer(w) ? Math.min(1.85, 0.8 / wheelRadius(w)) : 1.1);
    const ts = tyres(c, big);
    const rear = ts.filter((t) => !anyFixed || !steer(t.w));
    const rr = Math.max(0.45, ...rear.map((t) => t.r));
    const axle = rear.length ? rear.reduce((s, t) => s + t.w.mx, 0) / rear.length : bx0 + 1;
    const innerL = Math.max(c.zl, ...ts.filter((t) => t.z < c.zc).map((t) => t.z + t.width / 2 + 0.04));
    const innerR = Math.min(c.zr, ...ts.filter((t) => t.z > c.zc).map((t) => t.z - t.width / 2 - 0.04));
    const hz = Math.max(0.3, Math.min(0.48, (innerR - innerL) / 2 - 0.05));
    floor = Math.max(0.85, rr * 1.15);
    // chassis rails from the rear axle to the nose
    c.box(BLACK, bx0 + 0.1, 0.42, c.zc - hz * 0.8, bx1 - 0.05, 0.7, c.zc + hz * 0.8, 0.05);
    if (robot) {
      // the robot tractor / sweeper body: a closed box over the cells, a sensor mast on top
      const zl = Math.max(c.zl + 0.08, innerL + 0.02), zr = Math.min(c.zr - 0.08, innerR - 0.02);
      const roofed = c.cells.filter(([x, y]) => v.partsAt(x, y).some((p) => has(p, 'ROOF')));
      c.ext(c.paint, [[bx0 + 0.05, 0.55], [bx1 - 0.05, 0.55], [bx1 - 0.05, 1.15], [bx1 - 0.35, 1.4], [bx0 + 0.05, 1.4]], c.zl + 0.08, c.zr - 0.08);
      if (roofed.length) {
        const rx0 = Math.min(...roofed.map(([x]) => x)) - 0.45, rx1 = Math.max(...roofed.map(([x]) => x)) + 0.45;
        c.box(c.paintDark, rx0, 1.4, zl, rx1, 1.75, zr, 0.12);
      }
      c.box(0x1c1c1e, bx1 - 0.07, 0.65, c.zc - 0.5, bx1 - 0.02, 1.05, c.zc + 0.5, 0.01, F.fins, F.dark);
      const cam = v.parts.find((p) => has(p, 'CAMERA'));
      if (cam) {
        c.tube(BLACK, [cam.mx - 0.2, 1.4, c.zc], [cam.mx - 0.2, 2.05, c.zc], 0.03, 5);
        c.box(BLACK, cam.mx - 0.3, 2.05, c.zc - 0.1, cam.mx - 0.1, 2.2, c.zc + 0.1, 0.04, F.dark, F.dark);
        lampBox(c.lamps, cam.mx - 0.08, c.Y(2.12), c.zc, 0.04, 0.03, 1);
      }
      if (!c.wrecked) chamferBox(c.beacons.get(0xffa020), (bx0 + bx1) / 2 - 0.3, c.Y(roofed.length ? 1.75 : 1.4), c.zc - 0.08, (bx0 + bx1) / 2 - 0.14, c.Y(roofed.length ? 1.92 : 1.57), c.zc + 0.08, 0.05, F.light, F.light);
      workLamps(c, bx1 - 0.02, 0.95, [c.zc - 0.6, c.zc + 0.6], []);
      tailLamps(c, bx0 + 0.03, 0.9, [c.zc - 0.6, c.zc + 0.6]);
      eyeH = 1.8;
    } else {
      // hood from the engine to the nose
      const eng = engines.length ? Math.min(...engines.map((e) => e.mx)) : d.x + 1;
      const hx0 = Math.min(eng - 0.45, d.x + 0.45);
      hood(c, hx0, bx1 - 0.05, c.zc, hz, 0.6, floor + 0.55, steamEngine);
      if (!steamEngine) stack(c, hx0 + 0.3, floor + 0.55, floor + 1.45, c.zc + hz * 0.5);
      // operator platform between the rear fenders, fuel tank behind the seat
      const px0 = Math.max(bx0 + 0.1, axle - rr * 0.85), px1 = hx0;
      c.box(STEEL, px0, floor - 0.08, innerL + 0.02, px1, floor, innerR - 0.02, 0.03, F.ribbed, F.ribbed);
      c.box(c.paintDark, px0, 0.55, c.zc - hz * 0.8, px1, floor - 0.08, c.zc + hz * 0.8, 0.05);
      for (const t of rear) {
        // fender over each big tyre
        const s = t.z < c.zc ? -1 : 1;
        const z0 = t.z - t.width / 2 - 0.06, z1 = t.z + t.width / 2 + 0.06;
        const loop: [number, number][] = [];
        for (let i = 0; i <= 6; i++) {
          const a = Math.PI * (0.12 + (0.76 * i) / 6);
          loop.push([t.w.mx + Math.cos(a) * (t.r + 0.1), t.r + Math.sin(a) * (t.r + 0.1)]);
        }
        for (let i = 0; i < loop.length - 1; i++) c.ext(c.paint, beam(loop[i], loop[i + 1], 0.06, 0.06), z0, z1);
        // the step plate from the fender to the platform
        c.box(c.paint, t.w.mx - t.r * 0.6, floor - 0.08, Math.min(t.z - s * t.width / 2, s < 0 ? innerL : innerR), t.w.mx + t.r * 0.6, floor, Math.max(t.z - s * t.width / 2, s < 0 ? innerL : innerR), 0.02);
      }
      const sx = Math.max(px0 + 0.35, Math.min(px1 - 0.55, d.x));
      const roofed = v.parts.some((p) => has(p, 'ROOF') && p.hp > 0);
      const glazed = c.alive('WINDSHIELD') || c.alive('WINDOW');
      const cw = Math.min(0.6, hz + 0.25);
      cab(c, { x0: sx - 0.55, x1: roofed || glazed ? px1 - 0.02 : sx + 0.5, z0: d.z - cw, z1: d.z + cw, floor, top: floor + 1.5, glazed, roofed, frame: c.paint });
      const op = operator(c, sx, d.z, floor, 'wheel');
      dx = op.seatX; ride = op.ride; eyeH = floor + 1.15;
      workLamps(c, bx1 + 0.01, floor + 0.3, [c.zc - hz * 0.6, c.zc + hz * 0.6], [{ x: sx + 0.5, y: floor + 1.4, z: d.z }]);
      tailLamps(c, px0 - 0.02, floor - 0.2, [innerL + 0.15, innerR - 0.15]);
    }
  }
  drawImplements(c, bx0, bx1);
  return { eyeH, dx, dz, hasDriver: d.has && !robot, ride };
}

// --- trencher ----------------------------------------------------------------------------

function trencher(c: Ctx): Pose {
  c.setPaint(ORANGE, ORANGE);
  const F = c.F;
  const v = c.v;
  const tool = c.find((p) => has(p, 'ROCKWHEEL'))!;
  const d = driver(c, 0.5);
  const ts = tyres(c, () => 1.35);
  const rr = Math.max(0.4, ...ts.map((t) => t.r));
  const innerL = Math.max(c.zl, ...ts.filter((t) => t.z < c.zc).map((t) => t.z + t.width / 2 + 0.04));
  const innerR = Math.min(c.zr, ...ts.filter((t) => t.z > c.zc).map((t) => t.z - t.width / 2 - 0.04));
  const front = tool.mx > d.x ? 1 : -1;
  // body: everything but the tool's cell
  const bx0 = front > 0 ? c.xr + 0.05 : tool.mx + 0.5, bx1 = front > 0 ? tool.mx - 0.5 : c.xf - 0.05;
  const deck = rr * 2 + 0.05;
  c.box(BLACK, bx0 + 0.1, 0.35, innerL + 0.05, bx1 - 0.05, deck - 0.1, innerR - 0.05, 0.06);
  // a fender over each tyre, with a mud flap
  for (const t of ts) {
    c.box(c.paint, t.w.mx - t.r - 0.12, 2 * t.r + 0.06, t.z - t.width / 2 - 0.05, t.w.mx + t.r + 0.12, 2 * t.r + 0.14, t.z + t.width / 2 + 0.05, 0.03);
    c.box(BLACK, t.w.mx - t.r - 0.14, t.r * 0.6, t.z - t.width / 2 - 0.03, t.w.mx - t.r - 0.1, 2 * t.r + 0.1, t.z + t.width / 2 + 0.03, 0.01, F.ribbed, F.dark);
  }
  // engine: a big hood behind the operator
  const eng = v.engines[0];
  const ex = eng ? eng.mx : d.x - 1;
  // (from the engine cell over the axle behind it, leaving BN's empty end row for the blade)
  const hx0 = front > 0 ? Math.max(bx0 + 0.15, ex - 1.5) : Math.max(d.x + 0.45, ex - 0.5);
  const hx1 = front > 0 ? Math.min(d.x - 0.45, ex + 0.5) : Math.min(bx1 - 0.15, ex + 1.5);
  c.box(c.paint, hx0, deck - 0.1, innerL + 0.05, hx1, deck + 0.85, innerR - 0.05, 0.14);
  c.box(darkenC(c.paint, 0.5), hx0 + 0.15, deck + 0.84, innerL + 0.25, hx1 - 0.15, deck + 0.88, innerR - 0.25, 0.02, F.fins, F.fins);
  stack(c, (hx0 + hx1) / 2, deck + 0.85, deck + 1.6, innerR - 0.25);
  // backfill blade on the far end (BN's empty frame row)
  const farX = front > 0 ? c.xr : c.xf;
  if (Math.abs(farX - (front > 0 ? hx0 : hx1)) > 0.5) {
    const bxIn = front > 0 ? farX + 0.55 : farX - 0.55, bxOut = farX - front * -0.08;
    const xa = Math.min(bxIn, bxOut), xb = Math.max(bxIn, bxOut);
    c.ext(c.paint, front > 0 ? [[xa, 0.08], [xa + 0.12, 0.08], [xa + 0.22, 0.72], [xa + 0.05, 0.72]] : [[xb, 0.08], [xb - 0.12, 0.08], [xb - 0.22, 0.72], [xb - 0.05, 0.72]], c.zl + 0.08, c.zr - 0.08);
    c.box(STEEL, xa, 0.04, c.zl + 0.08, xb - 0.25, 0.1, c.zr - 0.08, 0.01);
    for (const s of [-1, 1]) {
      c.tube(BLACK, [front > 0 ? xa + 0.2 : xb - 0.2, 0.4, c.zc + s * 0.6], [front > 0 ? bx0 + 0.2 : bx1 - 0.2, 0.55, c.zc + s * 0.6], 0.05, 6);
      c.ram([front > 0 ? hx0 + 0.1 : hx1 - 0.1, deck + 0.2, c.zc + s * 0.3], [front > 0 ? xa + 0.18 : xb - 0.18, 0.62, c.zc + s * 0.3], 0.05);
    }
  }
  // operator: open seat with a ROPS bar, console with the wheel, over the tool end
  const floor = deck;
  const sx = front > 0 ? Math.max(hx1 + 0.4, Math.min(bx1 - 0.5, d.x)) : d.x;
  c.box(STEEL, hx1, floor - 0.02, innerL + 0.05, bx1 - 0.05, floor + 0.04, innerR - 0.05, 0.02, F.ribbed, F.ribbed);
  const roofed = v.parts.some((p) => has(p, 'ROOF') && p.hp > 0);
  cab(c, { x0: sx - 0.5, x1: bx1 - 0.08, z0: d.z - 0.55, z1: d.z + 0.55, floor, top: floor + 1.5, glazed: c.alive('WINDSHIELD'), roofed, frame: c.paint });
  const op = operator(c, sx, d.z, floor, 'wheel');
  // the digging chain: a boom from a gearbox at the front, slanting down into the trench
  const ok = tool.hp > 0 && !c.wrecked;
  const gx = tool.mx - front * 0.32, gy = floor + 0.55;
  const tipX = tool.mx + front * 0.38, tipY = ok ? 0.2 : 0.4;
  const bz = c.zc;
  c.box(c.paintDark, Math.min(gx, gx + front * 0.45) - 0.05, gy - 0.35, bz - 0.32, Math.max(gx, gx + front * 0.45), gy + 0.35, bz + 0.32, 0.08);
  // the gearbox stands on a frame from the deck
  c.box(c.paint, Math.min(gx - front * 0.3, gx + front * 0.2), deck - 0.15, bz - 0.36, Math.max(gx - front * 0.3, gx + front * 0.2), gy - 0.3, bz + 0.36, 0.05);
  c.cyl(BLACK, [gx + front * 0.15, gy, bz - 0.36], [gx + front * 0.15, gy, bz + 0.36], 0.2, 10);
  const boom = beam([gx + front * 0.2, gy], [tipX, Math.max(0.02, tipY)], 0.42, 0.32);
  c.ext(c.paint, boom, bz - 0.09, bz + 0.09);
  // the chain round the boom, with teeth sticking out of both edges
  const chain = beam([gx + front * 0.2, gy], [tipX, Math.max(0.02, tipY)], 0.54, 0.44);
  c.ext(0x2a2a2a, chain, bz - 0.16, bz - 0.09, F.tread, F.dark);
  c.ext(0x2a2a2a, chain, bz + 0.09, bz + 0.16, F.tread, F.dark);
  if (ok) {
    const [a0, a1, b1, b0] = [chain[0], chain[1], chain[2], chain[3]];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      for (const [p, q] of [[a0, a1], [b0, b1]] as const) {
        const x = p[0] + (q[0] - p[0]) * t, y = p[1] + (q[1] - p[1]) * t;
        if (y < 0.02) continue;
        const dx0 = q[0] - p[0], dy0 = q[1] - p[1], l = Math.hypot(dx0, dy0);
        const side = p === a0 ? -1 : 1;
        const nx = (-dy0 / l) * side, ny = (dx0 / l) * side;
        c.spike(0x8a8c90, [x, y, bz + (i % 2 ? 0.1 : -0.1)], [nx, ny, 0], 0.18, 0.05);
      }
    }
    // spoil auger across the trench mouth
    c.cyl(BLACK, [tool.mx - front * 0.1, 0.18, bz - 0.85], [tool.mx - front * 0.1, 0.18, bz + 0.85], 0.12, 8, F.fins);
  }
  // work lamps on the roll bar
  workLamps(c, bx1 - 0.02, deck + 0.45, [], [{ x: sx - 0.4, y: floor + 1.62, z: d.z - 0.35 }, { x: sx - 0.4, y: floor + 1.62, z: d.z + 0.35 }]);
  tailLamps(c, hx0 - 0.02, deck + 0.5, [innerL + 0.2, innerR - 0.2]);
  return { eyeH: floor + 1.15, dx: op.seatX, dz: d.z, hasDriver: d.has, ride: op.ride };
}

// --- roadheader --------------------------------------------------------------------------

function roadheader(c: Ctx): Pose {
  c.setPaint(YELLOW);
  const F = c.F;
  const v = c.v;
  const T = tracks(c);
  const tool = c.find((p) => has(p, 'ROADHEAD'))!;
  const d = driver(c, 0.5);
  const top = T.h + 0.3;
  // long low body between and over the tracks
  c.box(c.paintDark, c.xr + 0.08, 0.3, T.inL + 0.02, T.x1 + 0.1, top, T.inR - 0.02, 0.08);
  c.box(c.paint, T.x0 + 0.1, T.h - 0.02, c.zl + 0.04, T.x1 + 0.05, top, c.zr - 0.04, 0.06);
  // tail: the conveyor's discharge end sticking out the back
  c.ext(BLACK, [[c.xr + 0.02, top - 0.05], [T.x0 + 0.4, top - 0.05], [T.x0 + 0.4, top + 0.15], [c.xr - 0.05, top + 0.45], [c.xr - 0.05, top + 0.3]], c.zc - 0.35, c.zc + 0.35);
  for (const s of [-1, 1]) c.ext(c.paintDark, [[c.xr - 0.05, top + 0.3], [T.x0 + 0.4, top - 0.05], [T.x0 + 0.4, top + 0.3], [c.xr - 0.05, top + 0.62]], c.zc + s * 0.38, c.zc + s * 0.44);
  // operator: low armoured canopy over the seat (BN hdroof), glass at the front
  const roofed = c.cells.filter(([x, y]) => v.partsAt(x, y).some((p) => has(p, 'ROOF')));
  const cx0 = roofed.length ? Math.min(...roofed.map(([x]) => x)) - 0.45 : d.x - 0.6;
  const cx1 = roofed.length ? Math.max(...roofed.map(([x]) => x)) + 0.45 : d.x + 0.6;
  const cz0 = d.z - 0.5, cz1 = d.z + 0.5;
  const ctop = top + 1.35;
  cab(c, { x0: cx0, x1: cx1, z0: cz0, z1: cz1, floor: top, top: ctop, glazed: false, roofed: v.parts.some((p) => has(p, 'ROOF') && p.hp > 0), frame: 0x4a4a4c, beacon: !c.wrecked });
  if (c.alive('WINDSHIELD') && !c.wrecked) c.glassPane(cx1 - 0.03, top + 0.55, cz0 + 0.05, cx1, ctop - 0.04, cz1 - 0.05);
  c.box(c.paint, cx1 - 0.04, top, cz0, cx1, top + 0.55, cz1, 0.01);
  // seat-side cabinets (BN trunk_flat on the track cells)
  for (const s of [-1, 1]) {
    const z0 = s < 0 ? c.zl + 0.08 : cz1 + 0.06, z1 = s < 0 ? cz0 - 0.06 : c.zr - 0.08;
    if (z1 - z0 > 0.2) c.box(c.paint, cx0, top, z0, cx1 - 0.3, top + 0.55, z1, 0.05);
  }
  const op = operator(c, Math.max(cx0 + 0.45, Math.min(cx1 - 0.6, d.x)), d.z, top, 'levers');
  // electric drive cabinet ahead of the cab
  const engX = v.engines.length ? v.engines[0].mx : cx1 + 0.6;
  const turX = Math.max(cx1 + 1.0, tool.mx - 2.7);
  const kx1 = Math.min(engX + 0.45, turX - 0.6);
  c.box(c.paint, cx1 + 0.08, top, c.zc - 0.6, kx1, top + 0.8, c.zc + 0.6, 0.1);
  c.box(darkenC(c.paint, 0.5), cx1 + 0.25, top + 0.79, c.zc - 0.45, kx1 - 0.15, top + 0.83, c.zc + 0.45, 0.02, F.fins, F.fins);
  // gathering apron: a wedge across the bow at floor level, its sides the rams (BN ram_hardsteel)
  const ax0 = T.x1 + 0.05, ax1 = Math.min(tool.mx - 0.8, ax0 + 1.0);
  const sides = v.parts.filter((p) => /^ram_/.test(p.def.id));
  const az0 = sides.length ? Math.min(c.zl + 0.05, Math.min(...sides.map((p) => p.my)) - 0.45) : c.zl + 0.05;
  const az1 = sides.length ? Math.max(c.zr - 0.05, Math.max(...sides.map((p) => p.my)) + 0.45) : c.zr - 0.05;
  c.ext(c.paintDark, [[ax0, 0.15], [ax1, 0.03], [ax1, 0.1], [ax0, 0.5]], az0, az1);
  for (const z of [az0 + 0.06, az1 - 0.06]) c.ext(c.paint, [[ax0, 0.2], [ax1, 0.05], [ax1 - 0.1, 0.35], [ax0, 0.8]], z - 0.06, z + 0.06);
  // gathering stars: two spoked discs on the apron
  for (const s of [-1, 1]) {
    const sx = (ax0 + ax1) / 2, sz = c.zc + s * (az1 - az0) * 0.22;
    c.cyl(0x3a3a3a, [sx, 0.32, sz], [sx, 0.42, sz], 0.38, 5);
  }
  // conveyor trough up the middle
  c.box(BLACK, T.x0 + 0.3, top - 0.08, c.zc - 0.3, ax0 + 0.2, top + 0.02, c.zc + 0.3, 0.02, F.ribbed, F.ribbed);
  // cutter boom from a turret ahead of the drive cabinet, out to the cutting head
  const ok = tool.hp > 0 && !c.wrecked;
  c.cyl(c.paintDark, [turX, top, c.zc], [turX, top + 0.35, c.zc], 0.55, 12);
  const P0: [number, number] = [turX, top + 0.45], P1: [number, number] = ok ? [tool.mx - 0.15, 1.35] : [tool.mx - 0.25, 0.75];
  c.ext(c.paint, beam(P0, P1, 0.7, 0.5), c.zc - 0.32, c.zc + 0.32);
  c.box(c.paintDark, turX - 0.4, top + 0.2, c.zc - 0.4, turX + 0.4, top + 0.85, c.zc + 0.4, 0.1);
  for (const s of [-1, 1]) c.ram([turX + 0.2, top + 0.15, c.zc + s * 0.45], [lerp2(P0, P1, 0.6)[0], lerp2(P0, P1, 0.6)[1] - 0.2, c.zc + s * 0.38], 0.08);
  if (tool.hp > 0) {
    // the cutting head: a drum, tapered at the nose, studded with picks
    const hx0 = P1[0] - 0.05, hx1 = tool.mx + 0.42, hy = P1[1], r = Math.min(0.55, hy - 0.08);
    c.cyl(STEEL, [hx0, hy, c.zc], [hx1 - 0.25, hy, c.zc], r, 12);
    c.cyl(STEEL, [hx1 - 0.25, hy, c.zc], [hx1, hy, c.zc], r * 0.6, 12);
    const n = c.far ? 3 : 5, m = c.far ? 6 : 9;
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
      const a = (j / m) * Math.PI * 2 + i * 0.6;
      const x = hx0 + 0.1 + ((hx1 - 0.3 - hx0) * i) / Math.max(1, n - 1);
      const dirv: V3 = [0.25, Math.sin(a), Math.cos(a)];
      const l = Math.hypot(...dirv);
      c.spike(0x8a8c90, [x, hy + Math.sin(a) * r * 0.95, c.zc + Math.cos(a) * r * 0.95], [dirv[0] / l, dirv[1] / l, dirv[2] / l], 0.14, 0.04);
    }
  }
  // flood lamps on the front corners (BN directed_floodlight on the track cells)
  const floods = v.parts.filter((p) => (has(p, 'CIRCLE_LIGHT') || has(p, 'HALF_CIRCLE_LIGHT')) && p.hp > 0);
  workLamps(c, T.x1, top + 0.2, [], floods.map((p) => ({ x: p.mx + 0.35, y: top + 0.2, z: Math.max(c.zl + 0.25, Math.min(c.zr - 0.25, p.my)) })));
  tailLamps(c, c.xr + 0.06, top - 0.15, [c.zl + 0.35, c.zr - 0.35]);
  return { eyeH: top + 1.1, dx: op.seatX, dz: d.z, hasDriver: d.has, ride: op.ride };
}

// --- dozer -------------------------------------------------------------------------------

function dozer(c: Ctx): Pose {
  // A war rig (guns on it, BN's bandit dozer) is rusty and plated; a plain one is yellow.
  const armed = c.v.parts.some((p) => has(p, 'TURRET'));
  c.setPaint(armed ? 0x8a6a2a : YELLOW);
  const F = c.F;
  const v = c.v;
  const T = tracks(c);
  const blade = bladeRow(v)!;
  const d = driver(c, 0.5);
  const deck = T.h + 0.32;
  const ok = blade.parts.some((p) => p.hp > 0);
  // main frame between the tracks, fenders over them
  c.box(c.paintDark, T.x0 + 0.2, 0.32, T.inL + 0.02, T.x1 + 0.4, deck, T.inR - 0.02, 0.08);
  for (const [z0, z1] of [[T.outL, T.inL], [T.inR, T.outR]]) c.box(c.paint, T.x0 + 0.1, T.h + 0.02, Math.min(z0, z1) - 0.03, T.x1 - 0.1, T.h + 0.1, Math.max(z0, z1) + 0.03, 0.04);
  // engine hood ahead of the cab, up to the blade
  const eng = v.engines.length ? Math.min(...v.engines.map((e) => e.mx)) : d.x + 2;
  const hx0 = Math.min(eng - 0.5, d.x + 1.45), hx1 = blade.x - 0.65;
  const hz = Math.min(1.0, (T.inR - T.inL) / 2 + 0.25);
  c.ext(c.paint, [[hx0, deck - 0.05], [hx1, deck - 0.05], [hx1, deck + 0.9], [hx1 - 0.2, deck + 1.05], [hx0, deck + 1.1]], c.zc - hz, c.zc + hz);
  c.box(0x1c1c1e, hx1 - 0.02, deck + 0.1, c.zc - hz * 0.75, hx1 + 0.03, deck + 0.85, c.zc + hz * 0.75, 0.01, F.fins, F.dark);
  for (const s of [-1, 1]) c.box(darkenC(c.paint, 0.55), hx0 + 0.25, deck + 0.35, c.zc + s * hz - 0.02, hx1 - 0.25, deck + 0.85, c.zc + s * hz + 0.02, 0.01, F.fins, F.fins);
  stack(c, hx0 + 0.45, deck + 1.1, deck + 2.0, c.zc + hz * 0.5);
  // cab: windows plated over with rebar (BN rebar_plate on the windscreen cells) on a war rig
  const roofed = c.cells.filter(([x, y]) => v.partsAt(x, y).some((p) => has(p, 'ROOF')));
  const cx1 = hx0 - 0.03;
  const cx0 = Math.max(c.xr + 1.05, Math.min(d.x - 0.9, roofed.length ? Math.min(...roofed.map(([x]) => x)) - 0.45 : d.x - 0.9));
  const cw = Math.min(1.0, (T.inR - T.inL) / 2 + 0.3);
  const cz0 = Math.max(c.zl + 0.3, d.z - cw), cz1 = Math.min(c.zr - 0.3, d.z + cw);
  const top = deck + 1.8;
  const glazed = c.alive('WINDSHIELD') || c.alive('WINDOW');
  cab(c, { x0: cx0, x1: cx1, z0: cz0, z1: cz1, floor: deck, top, glazed, roofed: v.parts.some((p) => has(p, 'ROOF') && p.hp > 0) || glazed, frame: c.paint, beacon: !armed && !c.wrecked });
  const plated = v.parts.filter((p) => p.def.location === 'armor' && p.hp > 0 && v.partsAt(p.mx, p.my).some((q) => has(q, 'WINDSHIELD') || has(q, 'WINDOW')));
  if (plated.length) {
    // rebar grilles over the front and back glass
    for (const x of [cx1 + 0.04, cx0 - 0.04]) {
      if (!plated.some((p) => (x > d.x ? p.mx > d.x : p.mx < d.x))) continue;
      for (let i = 0; i <= 6; i++) c.tube(0x4a3a2a, [x, deck + 0.6, cz0 + ((cz1 - cz0) * i) / 6], [x, top - 0.05, cz0 + ((cz1 - cz0) * i) / 6], 0.022, 4);
      for (const y of [deck + 0.9, deck + 1.35]) c.tube(0x4a3a2a, [x, y, cz0], [x, y, cz1], 0.022, 4);
    }
  }
  const op = operator(c, Math.max(cx0 + 0.45, Math.min(cx1 - 0.6, d.x)), d.z, deck, 'levers');
  // rear: fuel tank and (if BN put glass there) the tank behind the cab
  if (cx0 - (T.x0 + 0.2) > 0.3) c.box(c.paint, T.x0 + 0.2, deck - 0.05, c.zc - 0.8, cx0 - 0.08, deck + 0.75, c.zc + 0.8, 0.12);
  // extra seats on the fenders (a war rig's gunner)
  for (const s of v.parts.filter((p) => has(p, 'SEAT') && (p.mx !== v.driverSeat()?.mx || p.my !== v.driverSeat()?.my))) {
    const L = { zOf: (my: number) => my, xOf: (mx: number) => mx } as Layout;
    seat(c.g(s.hp > 0 ? 0x3a2a24 : 0x3a3a3a), { ...s, my: Math.max(c.zl + 0.3, Math.min(c.zr - 0.3, s.my)) } as VehiclePart, L, c.base, T.h + 0.1, T.h + 0.55, F, false);
  }
  guns(c, (mx, my) => (roofed.some(([x, y]) => x === mx && y === my) ? top + 0.1 : my < cz0 || my > cz1 ? T.h + 0.6 : deck + 1.1));

  // the blade: a curved moldboard across the bow, push arms back to the track frames
  const bx = blade.x;
  const bz0 = Math.min(c.zl, blade.lo - 0.5) + 0.02, bz1 = Math.max(c.zr, blade.hi + 0.5) - 0.02;
  const lift = ok ? 0.05 : 0.0;
  const bh = Math.min(1.5, T.h + 0.75);
  const prof: [number, number][] = [[bx + 0.42, lift], [bx + 0.2, lift + bh * 0.25], [bx + 0.12, lift + bh * 0.55], [bx + 0.2, lift + bh * 0.85], [bx + 0.38, lift + bh]];
  const bladeC = ok ? c.paint : darkenC(c.paint, 0.6);
  for (let i = 0; i < prof.length - 1; i++) c.ext(bladeC, beam(prof[i], prof[i + 1], 0.08, 0.08), bz0, bz1);
  // ribs behind the moldboard, cutting edge along the bottom
  for (const z of [bz0 + 0.05, c.zc - 0.6, c.zc + 0.6, bz1 - 0.05]) c.ext(c.paintDark, [[bx - 0.12, lift + 0.1], [bx + 0.3, lift + 0.1], [bx + 0.15, lift + bh * 0.55], [bx + 0.3, lift + bh - 0.05], [bx - 0.05, lift + bh - 0.2]], z - 0.04, z + 0.04);
  c.box(STEEL, bx + 0.3, lift, bz0, bx + 0.46, lift + 0.12, bz1, 0.02);
  // spikes welded on (BN ram_spiked)
  for (const p of blade.parts.filter((q) => /spike/.test(q.def.id) && q.hp > 0)) {
    for (const y of [0.35, 0.8]) c.spike(0x6a6c70, [bx + 0.22, lift + bh * y, Math.max(bz0 + 0.2, Math.min(bz1 - 0.2, p.my))], [1, 0, 0], 0.32, 0.07);
  }
  // push arms outside the tracks, lift rams from the hood front
  for (const s of [-1, 1]) {
    const z = s < 0 ? Math.max(bz0 + 0.1, T.outL + 0.1) : Math.min(bz1 - 0.1, T.outR - 0.1);
    c.ext(c.paintDark, beam([bx - 0.05, lift + 0.4], [(T.x0 + T.x1) / 2, T.h * 0.5], 0.22, 0.18), z - 0.08, z + 0.08);
    c.ram([hx1 - 0.15, deck + 0.75, c.zc + s * (hz - 0.2)], [bx + 0.05, lift + bh * 0.6, c.zc + s * (hz - 0.2)], 0.08);
  }
  workLamps(c, hx1 + 0.02, deck + 0.6, [c.zc - hz * 0.6, c.zc + hz * 0.6], [{ x: cx1 + 0.05, y: top - 0.1, z: cz0 + 0.2 }, { x: cx1 + 0.05, y: top - 0.1, z: cz1 - 0.2 }]);
  tailLamps(c, T.x0 + 0.15, deck + 0.3, [c.zc - 0.7, c.zc + 0.7]);
  return { eyeH: deck + 1.15, dx: op.seatX, dz: d.z, hasDriver: d.has, ride: op.ride };
}

// --- forklift ----------------------------------------------------------------------------

function forklift(c: Ctx): Pose {
  c.setPaint(ORANGE, 0xc8c8c0);
  const F = c.F;
  const v = c.v;
  const forks = v.parts.filter((p) => p.def.id === 'forklift_fork');
  const fx = Math.min(...forks.map((p) => p.mx));
  const dir = fx > (c.xr + c.xf) / 2 ? 1 : -1;
  const d = driver(c, 0.5);
  const dz = c.zc + Math.max(-0.25, Math.min(0.25, d.z - c.zc));
  // cushion tyres: BN's 25 cm wheel is tiny, a forklift's ~0.55 m tyre fills the cell's height
  const ts = tyres(c, (w) => Math.max(1, 0.28 / wheelRadius(w)));
  const innerL = Math.max(c.zl + 0.05, ...ts.filter((t) => t.z < c.zc).map((t) => t.z + t.width / 2 + 0.03));
  const innerR = Math.min(c.zr - 0.05, ...ts.filter((t) => t.z > c.zc).map((t) => t.z - t.width / 2 - 0.03));
  const bx0 = dir > 0 ? c.xr + 0.05 : fx + 0.5, bx1 = dir > 0 ? fx - 0.5 : c.xf - 0.05;
  const rear = dir > 0 ? bx0 : bx1;
  const floor = 0.62;
  // body: low chassis over the wheels, a heavy counterweight at the back
  c.box(c.paint, bx0, 0.18, c.zl + 0.04, bx1, floor, c.zr - 0.04, 0.08);
  const cwx0 = dir > 0 ? bx0 - 0.02 : bx1 - 0.85, cwx1 = dir > 0 ? bx0 + 0.85 : bx1 + 0.02;
  c.ext(0x2a2a2a, dir > 0 ? [[cwx0, 0.15], [cwx1, 0.15], [cwx1, 1.25], [cwx0 + 0.15, 1.25], [cwx0, 1.05]] : [[cwx0, 0.15], [cwx1, 0.15], [cwx1, 1.05], [cwx1 - 0.15, 1.25], [cwx0, 1.25]], c.zl + 0.04, c.zr - 0.04);
  // engine / battery hood under the seat
  const sx = Math.max(bx0 + 0.9, Math.min(bx1 - 0.6, d.x));
  c.box(c.paint, Math.min(sx - 0.45, cwx1), floor, innerL, sx + 0.3, floor + 0.35, innerR, 0.08);
  // overhead guard: four posts and a grid roof
  const gx0 = dir > 0 ? cwx1 - 0.1 : sx - 0.55, gx1 = dir > 0 ? bx1 - 0.15 : cwx0 + 0.1;
  const gz0 = c.zl + 0.12, gz1 = c.zr - 0.12, gtop = 2.15;
  const roofed = v.parts.some((p) => has(p, 'ROOF') && p.hp > 0);
  for (const [x, z] of [[gx0, gz0], [gx0, gz1], [gx1, gz0], [gx1, gz1]] as const) c.tube(BLACK, [x, floor, z], [x + (x === gx1 ? -dir * 0.15 : 0), gtop, z], 0.045, 6);
  if (roofed) {
    for (const z of [gz0, gz1]) c.box(BLACK, gx0 - 0.05, gtop - 0.06, z - 0.05, gx1 + 0.05, gtop + 0.04, z + 0.05, 0.02, F.dark, F.dark);
    for (let i = 0; i <= 5; i++) {
      const x = gx0 + ((gx1 - gx0) * i) / 5;
      c.box(BLACK, x - 0.03, gtop - 0.04, gz0, x + 0.03, gtop + 0.02, gz1, 0.01, F.dark, F.dark);
    }
  }
  const op = operator(c, sx, dz, floor + 0.0, 'wheel');
  // mast: two channels just ahead of the front wheels, tilted back a touch
  const mx = dir > 0 ? bx1 + 0.08 : bx0 - 0.08;
  const mz0 = c.zc - 0.38, mz1 = c.zc + 0.38;
  for (const z of [mz0, mz1]) {
    c.box(0x3a3a3c, mx - 0.07, 0.1, z - 0.07, mx + 0.07, 2.3, z + 0.07, 0.01, F.dark, F.dark);
  }
  c.box(0x3a3a3c, mx - 0.06, 2.2, mz0, mx + 0.06, 2.3, mz1, 0.01, F.dark, F.dark);
  c.box(0x3a3a3c, mx - 0.06, 0.95, mz0, mx + 0.06, 1.02, mz1, 0.01, F.dark, F.dark);
  c.ram([mx - dir * 0.12, 0.25, c.zc], [mx - dir * 0.12, 1.9, c.zc], 0.06);
  // lift chains
  for (const z of [c.zc - 0.18, c.zc + 0.18]) c.tube(0x1c1c1c, [mx + dir * 0.05, 0.6, z], [mx + dir * 0.05, 2.25, z], 0.015, 4);
  // carriage and the forks, at the cells BN gives them
  const cy = 0.12;
  const car0 = mx + dir * 0.1;
  c.box(0x3a3a3c, Math.min(car0, car0 + dir * 0.08), cy, mz0 - 0.1, Math.max(car0, car0 + dir * 0.08), cy + 0.75, mz1 + 0.1, 0.01, F.dark, F.dark);
  for (const f of forks) {
    const z = c.zc + (f.my - c.zc) * 0.7;
    const x0 = car0 + dir * 0.06, x1 = f.mx + dir * 0.47;
    const droop = f.hp > 0 ? 0 : 0.08;
    c.box(0x2c2c2e, Math.min(x0, x0 + dir * 0.06), cy, z - 0.06, Math.max(x0, x0 + dir * 0.06), cy + 0.6, z + 0.06, 0.01, F.dark, F.dark);
    c.ext(0x2c2c2e, dir > 0 ? [[x0, cy], [x1, cy - droop], [x1, cy + 0.04 - droop], [x0, cy + 0.07]] : [[x1, cy - droop], [x0, cy], [x0, cy + 0.07], [x1, cy + 0.04 - droop]], z - 0.06, z + 0.06, F.dark, F.dark);
  }
  workLamps(c, gx1, gtop - 0.15, [], [{ x: gx1, y: gtop - 0.12, z: gz0 + 0.05 }, { x: gx1, y: gtop - 0.12, z: gz1 - 0.05 }]);
  if (c.alive('CONE_LIGHT')) for (const z of [gz0, gz1]) lampBox(c.lamps, gx1 + dir * 0.05, c.Y(gtop - 0.15), z, 0.06, 0.05, dir);
  if (roofed && !c.wrecked) chamferBox(c.beacons.get(0xffa020), (gx0 + gx1) / 2 - 0.08, c.Y(gtop + 0.04), c.zc - 0.08, (gx0 + gx1) / 2 + 0.08, c.Y(gtop + 0.2), c.zc + 0.08, 0.05, F.light, F.light);
  tailLamps(c, rear - dir * 0.03, 0.85, [c.zl + 0.25, c.zr - 0.25]);
  return { eyeH: floor + 1.15, dx: op.seatX, dz, hasDriver: d.has, ride: op.ride };
}

// --- hoist (engine crane / handjack) ----------------------------------------------------

function hoist(c: Ctx): Pose {
  c.setPaint(RED);
  const v = c.v;
  const crane = c.find((p) => /^crane/.test(p.def.id))!;
  const x = crane.mx, z = crane.my;
  const red = c.paint;
  // castor legs in a U, the column at the back, a boom out over the front, a ram under it
  for (const s of [-1, 1]) c.box(red, x - 0.45, 0.1, z + s * 0.32 - 0.05, x + 0.45, 0.2, z + s * 0.32 + 0.05, 0.02);
  c.box(red, x - 0.45, 0.1, z - 0.32, x - 0.35, 0.2, z + 0.32, 0.02);
  for (const [cx, s] of [[x - 0.4, -1], [x - 0.4, 1], [x + 0.4, -1], [x + 0.4, 1]] as const) {
    wheel(c.g(0x2a2a2a), cx, c.Y(0.05), z + s * 0.32, 0.05, 0.04, c.F, { sides: 8 });
  }
  const ok = crane.hp > 0 && !c.wrecked;
  c.box(red, x - 0.42, 0.2, z - 0.06, x - 0.3, 1.35, z + 0.06, 0.02);
  const tip: [number, number] = ok ? [x + 0.45, 1.55] : [x + 0.4, 0.9];
  c.ext(red, beam([x - 0.36, 1.32], tip, 0.12, 0.09), z - 0.05, z + 0.05);
  c.ram([x - 0.33, 0.35, z], [x + 0.05, (1.32 + tip[1]) / 2 - 0.05, z], 0.04);
  c.tube(0x1c1c1c, [tip[0], tip[1] - 0.04, z], [tip[0], Math.max(0.35, tip[1] - 0.7), z], 0.012, 4);
  c.spike(0x4a4a4c, [tip[0], Math.max(0.35, tip[1] - 0.7), z], [0, -1, 0], 0.12, 0.05);
  const d = driver(c, 0);
  void v;
  return { eyeH: 1.6, dx: d.x, dz: d.z, hasDriver: false };
}

// --- sweeper -----------------------------------------------------------------------------

function sweeper(c: Ctx): Pose {
  c.setPaint(WHITE, 0x9a9a9a);
  const F = c.F;
  const v = c.v;
  const ts = tyres(c);
  const rr = Math.max(0.3, ...ts.map((t) => t.r));
  const x0 = c.xr + 0.05, x1 = c.xf - 0.05;
  const zl = c.zl + 0.05, zr = c.zr - 0.05;
  // a rounded box body with an orange band, the hopper the back half
  // the lower body runs between the wheels (so they show), the upper one over them
  const innerL = Math.max(zl, ...ts.filter((t) => t.z < c.zc).map((t) => t.z + t.width / 2 + 0.03));
  const innerR = Math.min(zr, ...ts.filter((t) => t.z > c.zc).map((t) => t.z - t.width / 2 - 0.03));
  const belt = 2 * rr + 0.08;
  c.box(c.paintDark, x0 + 0.05, 0.28, innerL, x1 - 0.05, belt, innerR, 0.06);
  c.ext(c.paint, [[x0, belt], [x1, belt], [x1, 1.35], [x1 - 0.4, 1.8], [x0, 1.8]], zl, zr);
  c.box(ORANGE, x0 - 0.01, belt + 0.22, zl - 0.01, x1 + 0.01, belt + 0.36, zr + 0.01, 0.02);
  // dark front window band (sensors / the cab it would have had)
  c.box(0x1c1c1e, x1 - 0.42, 1.38, zl + 0.15, x1 - 0.02, 1.75, zr - 0.15, 0.02, F.dark, F.dark);
  // rear hopper door line, front grille and lamp
  c.box(darkenC(c.paint, 0.6), x0 - 0.02, belt + 0.45, c.zc - 0.6, x0 + 0.01, 1.65, c.zc + 0.6, 0.01, F.ribbed, F.dark);
  c.box(0x1c1c1e, x1 - 0.01, belt + 0.45, c.zc - 0.5, x1 + 0.02, belt + 0.65, c.zc + 0.5, 0.01, F.fins, F.dark);
  // gutter brooms under the front corners
  const ok = !c.wrecked;
  for (const s of [-1, 1]) {
    const bx = x1 - 0.12, bz = s < 0 ? zl + 0.25 : zr - 0.25;
    c.tube(BLACK, [bx - 0.4, 0.45, c.zc + s * 0.5], [bx, 0.22, bz], 0.04, 5);
    c.cyl(BLACK, [bx, 0.12, bz], [bx, 0.24, bz], 0.12, 8);
    if (ok) c.cyl(0x8a6a3a, [bx, 0.02, bz], [bx, 0.12, bz], 0.36, 12, F.fabric);
  }
  const cam = v.parts.find((p) => has(p, 'CAMERA'));
  if (cam) {
    c.tube(BLACK, [cam.mx, 1.75, c.zc], [cam.mx, 2.15, c.zc], 0.03, 5);
    c.box(BLACK, cam.mx - 0.1, 2.15, c.zc - 0.1, cam.mx + 0.1, 2.3, c.zc + 0.1, 0.04, F.dark, F.dark);
  }
  if (!c.wrecked) chamferBox(c.beacons.get(0xffa020), x1 - 0.75, c.Y(1.75), c.zc - 0.08, x1 - 0.59, c.Y(1.92), c.zc + 0.08, 0.05, F.light, F.light);
  workLamps(c, x1 + 0.01, belt + 0.55, [zl + 0.3, zr - 0.3], []);
  tailLamps(c, x0 - 0.01, belt + 0.55, [zl + 0.3, zr - 0.3]);
  drawImplements(c, x0, x1);
  const d = driver(c, 0.5);
  return { eyeH: 1.6, dx: d.x, dz: d.z, hasDriver: false };
}

export function buildWork(v: Vehicle, L0: Layout, base: number, info: WorkInfo, far = false): ModelBuild {
  const L: Layout = { ...L0, zOf: (my: number) => my, xOf: (mx: number) => mx };
  const c = new Ctx(v, base, far);
  const pose =
    info.kind === 'excavator' ? excavator(c)
    : info.kind === 'trencher' ? trencher(c)
    : info.kind === 'roadheader' ? roadheader(c)
    : info.kind === 'dozer' ? dozer(c)
    : info.kind === 'forklift' ? forklift(c)
    : info.kind === 'hoist' ? hoist(c)
    : info.kind === 'sweeper' ? sweeper(c)
    : tractor(c, info);
  return {
    body: null, roof: c.out(c.roof), parts: c.out(c.parts), glass: c.out(c.glass), lamps: c.out(c.lamps), tails: c.out(c.tails), beacons: c.out(c.beacons),
    skin: null, skinJob: null, skinKey: '', layout: L,
    eyeH: pose.eyeH, driverZ: pose.hasDriver ? pose.dz : null, driverX: pose.hasDriver ? pose.dx : undefined, eyeX: pose.hasDriver ? pose.dx + 0.05 : undefined,
    parkedLean: 0, bodyUsesParts: true, ride: pose.ride,
  };
}
