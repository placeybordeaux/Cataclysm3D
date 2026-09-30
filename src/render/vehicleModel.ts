import * as THREE from 'three';
import { has, type Vehicle, type VehiclePart } from '../game/vehicle';
import { GeomBuilder, type V3 } from './geometry';
import type { TileFrame } from './textureSource';
import { analyze, type Layout } from './vehicleLayout';
import { liveryBody, paintSkin, sheetUv, type SheetName, type Skin, type SkinInput } from './vehicleSkin';
import { Batches, chamferBox, faceNormal, partFrames, quad4, tube, wheel, type PartSwatch } from './vehicleGeom';
import { buildBike } from './vehicleBikes';

// The "model" vehicle renderer: a cohesive low-poly body generated from the part grid
// (vehicleLayout.ts decides the style and where things are), instead of one box per part.
//
// Body = a side profile (nose -> hood -> windscreen -> roof -> rear glass / hatch / bed /
// box -> tail, over a sill with wheel-arch cut-outs), used twice:
//  - side walls: the profile polygon at +-half width, with the window openings (and open
//    doors) cut out as holes;
//  - a skin strip lofted along the profile across the width, with rounded shoulders, a
//    crown (hood / roof / nose bulge), plan taper at the ends and tumblehome above the belt.
// Windscreen / rear glass are strip segments drawn with the glass material; side glass fills
// the holes. Everything is double-sided so the cabin reads from inside (cockpit camera).
// Faces are textured from a per-vehicle pixel-art skin (vehicleSkin.ts), projected by face
// normal onto side / top / front / rear sheets. Parts that aren't body (wheels, seats, dash,
// bumpers, mirrors) use the shared swatch page (vehicleGeom.ts).
//
// Local frame as vehicleMesh.ts: X = mount x (forward), Z = mount y (right), Y = metres above
// the ground (+ `base`, the z-level's floor height).

type SegKind = 'paint' | 'glass' | 'open' | 'under';
interface OP {
  x: number;
  y: number;
  /** Kind of the segment that ENDS at this point. */
  kind: SegKind;
  /** Shoulder radius and crown at this point. */
  b: number;
  crown: number;
  /** Which glass part this glass segment is (for breakage). */
  glass?: 'shield' | 'rear' | 'tail';
}

export interface ModelBuild {
  body: THREE.BufferGeometry | null;
  roof: THREE.BufferGeometry | null;
  parts: THREE.BufferGeometry | null;
  glass: THREE.BufferGeometry | null;
  lamps: THREE.BufferGeometry | null;
  tails: THREE.BufferGeometry | null;
  beacons: THREE.BufferGeometry | null;
  skin: Skin | null;
  /** Identifies the skin's content: rebuilds with the same key reuse the texture. */
  skinKey: string;
  layout: Layout;
  /** Driver eye height above the floor level (m) and the driver's visual lateral position. */
  eyeH: number;
  driverZ: number | null;
  /** Bikes lean on their stand when nobody rides them (rad, + = right side down). */
  parkedLean: number;
}

const FULL: TileFrame = { texture: null as unknown as THREE.Texture, uv: [0, 0, 1, 1], w: 1, h: 1, ppm: 32 };

// --- profile ---------------------------------------------------------------------------

function glassBroken(parts: (VehiclePart | null | undefined)[]): boolean {
  const g = parts.filter((p): p is VehiclePart => !!p);
  return g.length > 0 && g.filter((p) => p.hp <= 0).length * 2 >= g.length;
}

/** Top outline (nose bottom -> tail bottom) then the underside with arches (tail -> nose). */
export function buildOutline(L: Layout): { loop: OP[]; nTop: number; arches: { x: number; y: number; r: number }[] } {
  const p = L.p, xn = L.xNose, xt = L.xTail;
  const pts: OP[] = [];
  const add = (x: number, y: number, kind: SegKind = 'paint', glass?: OP['glass']) => {
    const last = pts[pts.length - 1];
    if (last && Math.abs(last.x - x) < 1e-3 && Math.abs(last.y - y) < 1e-3) return;
    pts.push({ x, y, kind, b: p.shoulder, crown: p.crown, glass });
  };
  const bump = p.sill + 0.08;
  const secs = L.sections;
  const shieldI = secs.findIndex((s) => s.kind === 'shield');
  const hasHood = secs.some((s) => s.kind === 'hood');
  const topOf = (k: string) => (k === 'box' ? p.box : k === 'bed' || k === 'deck' ? p.deck : k === 'flat' ? p.sill + 0.5 : k === 'hood' ? p.hood : p.roof);
  let cur: number;
  let i0: number;
  add(xn, bump);
  if (shieldI >= 0 && hasHood && !p.flatFront) {
    const xc = secs[shieldI].x0;
    const noseTop = p.nose;
    add(xn, noseTop - 0.1);
    add(xn - 0.14, noseTop);
    add((xn + xc) / 2, (noseTop + p.hood) / 2 + 0.03);
    add(xc + 0.03, p.hood);
    add(xc - p.rake, p.roof, 'glass', 'shield');
    // slim A-pillars: a tighter shoulder along the windscreen
    pts[pts.length - 2].b = pts[pts.length - 1].b = Math.min(p.shoulder, 0.07);
    cur = p.roof;
    i0 = shieldI + 1;
  } else if (shieldI >= 0) {
    add(xn, p.belt - 0.04);
    add(xn - p.rake, p.roof - 0.02, 'glass', 'shield');
    cur = p.roof;
    i0 = shieldI + 1;
  } else {
    const h = topOf(secs[0]?.kind ?? 'cabin');
    add(xn, h - 0.1);
    add(xn - 0.1, h);
    cur = h;
    i0 = 1;
  }
  const lastPt = () => pts[pts.length - 1];
  const step = (xb: number, h: number) => {
    if (Math.abs(cur - h) < 0.07) return;
    if (lastPt().x > xb + 0.01) add(xb, cur);
    add(xb, h);
    cur = h;
  };
  let tailGlass = false;
  const style = L.style;
  const hatchRun = style === 'suv' ? 0.3 : style === 'minivan' ? 0.35 : style === 'van' || style === 'bus' || style === 'truck' ? 0.1 : style === 'sports' ? 1.1 : 0.85;
  for (let i = i0; i < secs.length; i++) {
    const s = secs[i];
    const last = i === secs.length - 1;
    switch (s.kind) {
      case 'hood':
      case 'shield':
      case 'cabin':
        step(s.x0, p.roof);
        break;
      case 'box':
        step(s.x0, p.box);
        break;
      case 'rearglass':
        if ((style === 'sedan' || style === 'sports' || style === 'hatch') && !last) {
          step(s.x0, p.roof);
          add(s.x0, p.roof);
          add(s.x0 - p.rearRake, p.deck + 0.02, 'glass', 'rear');
          cur = p.deck + 0.02;
        } else if (last) {
          step(s.x0, p.roof);
          tailGlass = true;
        } else {
          // pickup cab back: vertical, the rear window in it
          step(s.x0, p.roof);
          add(s.x1 + 0.04, p.roof);
          add(s.x1, p.roof - 0.06);
          add(s.x1, p.belt + 0.06, 'glass', 'rear');
          cur = p.belt + 0.06;
        }
        break;
      case 'bed':
        step(s.x0, p.deck);
        add(last ? xt + 0.06 : s.x1, p.deck, 'open');
        break;
      case 'deck': {
        const hatchDoor = s.rows.some((x) => L.rows.find((r) => r.x === x)?.endDoor && has(L.rows.find((r) => r.x === x)!.endDoor!, 'WINDOW'));
        if (last && cur > p.deck + 0.2 && (hatchDoor || style === 'suv' || style === 'minivan' || style === 'hatch')) {
          // hatchback / SUV tailgate: the roof runs on and slopes down to the tail
          const xr = Math.max(xt + 0.15, s.x0 - (1 - hatchRun) * (s.x0 - xt));
          add(xr, cur);
          add(xt + 0.06, p.belt + 0.04, 'glass', 'tail');
          cur = p.belt + 0.04;
        } else if (cur > p.deck + 0.2) {
          add(s.x0, cur);
          add(s.x0 - 0.45, p.deck, 'paint');
          cur = p.deck;
        } else step(s.x0, p.deck);
        break;
      }
      case 'flat':
        step(s.x0, p.sill + 0.5);
        break;
    }
  }
  // tail face
  if (lastPt().x > xt + 0.1) add(xt + 0.08, cur);
  add(xt, cur - 0.08);
  if (tailGlass && cur - 0.1 > p.belt + 0.1) add(xt, p.belt + 0.05, 'glass', 'tail');
  add(xt, bump);
  const top = roundCorners(pts);
  const nTop = top.length;

  // underside, tail -> nose, with arches over each axle
  const axles = new Map<number, { x: number; r: number }>();
  for (const w of L.wheels) {
    if (w.side === 0 && L.style !== 'motorcycle' && L.style !== 'bicycle') continue;
    const k = Math.round(w.x * 100);
    const a = axles.get(k);
    if (!a || a.r < w.r) axles.set(k, { x: w.x, r: w.r });
  }
  const arches: { x: number; y: number; r: number }[] = [];
  const bottom: OP[] = [];
  const addB = (x: number, y: number) => bottom.push({ x, y, kind: 'under', b: 0.025, crown: 0 });
  addB(xt, p.sill);
  for (const a of [...axles.values()].sort((u, v) => u.x - v.x)) {
    const ar = a.r + 0.06, cy = a.r;
    if (cy + ar < p.sill + 0.05) continue;
    const ts = Math.asin(Math.max(-1, Math.min(1, (p.sill - cy) / ar)));
    const t0 = Math.PI - ts, t1 = ts;
    // skip arches that would cut past the nose / tail
    const xa = a.x + ar * Math.cos(t0), xb = a.x + ar * Math.cos(t1);
    if (xa < xt + 0.05 || xb > xn - 0.05) continue;
    arches.push({ x: a.x, y: cy, r: ar });
    const N = 9;
    for (let i = 0; i <= N; i++) {
      const t = t0 + ((t1 - t0) * i) / N;
      addB(a.x + ar * Math.cos(t), cy + ar * Math.sin(t));
    }
  }
  addB(xn, p.sill);
  return { loop: [...top, ...bottom], nTop, arches };
}

/** Chamfer sharp convex corners of the top outline (never the first / last point). */
function roundCorners(pts: OP[]): OP[] {
  const out: OP[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const d1x = b.x - a.x, d1y = b.y - a.y, d2x = c.x - b.x, d2y = c.y - b.y;
    const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y);
    if (l1 < 1e-3 || l2 < 1e-3) continue;
    const turn = (d1x * d2y - d1y * d2x) / (l1 * l2);
    const dot = (d1x * d2x + d1y * d2y) / (l1 * l2);
    // CCW loop: a right turn (turn < 0) is convex
    if (turn < -0.3 || dot < 0.2) {
      const r = Math.min(0.09, l1 / 3, l2 / 3);
      out.push({ ...b, x: b.x - (d1x / l1) * r, y: b.y - (d1y / l1) * r, kind: b.kind });
      out.push({ ...c, x: b.x + (d2x / l2) * r, y: b.y + (d2y / l2) * r, kind: b.kind === 'glass' || c.kind === 'glass' ? 'paint' : c.kind === 'open' && b.kind === 'open' ? 'open' : 'paint', glass: undefined });
    } else out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Outward unit normals (2D) of a CCW closed loop, averaged at vertices, with miter factor. */
function loopNormals(loop: { x: number; y: number }[]): { nx: number; ny: number; m: number }[] {
  const n = loop.length;
  const seg = loop.map((a, i) => {
    const b = loop[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
    return { nx: dy / l, ny: -dx / l };
  });
  return loop.map((_, i) => {
    const s0 = seg[(i - 1 + n) % n], s1 = seg[i];
    let nx = s0.nx + s1.nx, ny = s0.ny + s1.ny;
    const l = Math.hypot(nx, ny);
    if (l < 1e-6) {
      nx = s1.nx;
      ny = s1.ny;
    } else {
      nx /= l;
      ny /= l;
    }
    const m = 1 / Math.max(0.55, nx * s1.nx + ny * s1.ny);
    return { nx, ny, m };
  });
}

// --- build -----------------------------------------------------------------------------

/** Build the model for a vehicle, or null for grids the model doesn't cover ('frame'). */
export function buildVehicleModel(v: Vehicle, base: number, opts: { reuseSkinKey?: string } = {}): ModelBuild | null {
  const L = analyze(v);
  if (L.style === 'motorcycle' || L.style === 'bicycle') return buildBike(v, L, base);
  if (L.style === 'frame' || !L.sections.length) return null;
  const p = L.p;
  const F = partFrames();
  const { loop, nTop, arches } = buildOutline(L);
  const normals = loopNormals(loop);
  // Inset the outline by each point's shoulder radius: the side walls sit on the inset
  // outline and the strip's rounded shoulder brings the silhouette back out to it.
  const Q = loop.map((pt, i) => ({ ...pt, x: pt.x - normals[i].nx * pt.b * normals[i].m, y: pt.y - normals[i].ny * pt.b * normals[i].m }));
  const hw = L.hw;
  const yMax = Math.max(...loop.map((q) => q.y)) + p.crown + 0.05;

  const noTumble = (x: number) => L.sections.some((s) => (s.kind === 'box' || s.kind === 'bed') && x <= s.x0 + 0.01 && x >= s.x1 - 0.01);
  const taper = (x: number) => {
    let t = 1;
    const f = (x - (L.xNose - 0.7)) / 0.7;
    if (f > 0) t -= 0.08 * f * f;
    const r = (L.xTail + 0.5 - x) / 0.5;
    if (r > 0) t -= 0.05 * r * r;
    return t;
  };
  const tumble = (x: number, y: number) => (y <= p.belt || noTumble(x) ? 1 : 1 - p.tumble * Math.min(1, (y - p.belt) / Math.max(0.3, p.roof - p.belt)));
  const P3 = (x: number, y: number, zl: number): V3 => [x, base + y, L.yc + zl * taper(x) * tumble(x, y)];

  // Top of the side wall (inset outline) as a function of x, for window openings.
  const topQ = Q.slice(0, nTop);
  const topX0 = Math.min(...topQ.map((q) => q.x)), topX1 = Math.max(...topQ.map((q) => q.x));
  const ghTop = (x: number): number => {
    x = Math.max(topX0, Math.min(topX1, x));
    let best = -Infinity;
    for (let i = 0; i < topQ.length - 1; i++) {
      const a = topQ[i], b = topQ[i + 1];
      const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
      if (x < lo - 1e-6 || x > hi + 1e-6) continue;
      const y = hi - lo < 1e-6 ? Math.max(a.y, b.y) : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
      best = Math.max(best, y);
    }
    return best;
  };
  const botQ = Q.slice(nTop);
  const bottomAt = (x: number): number => {
    let best = -Infinity;
    for (let i = 0; i < botQ.length - 1; i++) {
      const a = botQ[i], b = botQ[i + 1];
      const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
      if (x < lo - 1e-6 || x > hi + 1e-6) continue;
      best = Math.max(best, hi - lo < 1e-6 ? Math.max(a.y, b.y) : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x));
    }
    return best === -Infinity ? p.sill : best;
  };
  const dloTop = (x: number) => Math.min(ghTop(x - 0.06), ghTop(x), ghTop(x + 0.06)) - 0.06;

  // --- side openings: window panes, open / missing doors ---
  type Pane = { x0: number; x1: number; pts: [number, number][]; kind: 'glass' | 'open'; part: VehiclePart | null; door: boolean };
  const panes: Record<-1 | 1, Pane[]> = { [-1]: [], [1]: [] } as Record<-1 | 1, Pane[]>;
  const doorHoles: Record<-1 | 1, { d: (typeof L.doors)[number]; pts: [number, number][]; pane: Pane | null }[]> = { [-1]: [], [1]: [] } as never;
  const secOf = (x: number) => L.sections.find((s) => s.rows.includes(x))?.kind;
  const verticalRear = !(L.style === 'sedan' || L.style === 'sports' || L.style === 'hatch');
  const belt = p.belt;
  const paneFor = (x0: number, x1: number): [number, number][] | null => {
    const xs: number[] = [];
    for (let x = x1; x < x0; x += 0.08) xs.push(x);
    xs.push(x0);
    const pts: [number, number][] = [];
    let first: number | null = null, lastX = x1;
    let prevX = x1, prevY = dloTop(x1);
    for (const x of xs) {
      const y = dloTop(x);
      if (y > belt + 0.12) {
        if (first === null) {
          // entering: interpolate where the top crosses the sill line of the window
          first = prevY <= belt + 0.12 && x > x1 ? prevX + ((x - prevX) * (belt + 0.12 - prevY)) / (y - prevY || 1) : x;
          pts.push([first, belt + 0.04]);
          if (first !== x) pts.push([first, belt + 0.12]);
        }
        pts.push([x, y]);
        lastX = x;
      } else if (first !== null) {
        const xe = prevX + ((x - prevX) * (prevY - belt - 0.12)) / (prevY - y || 1);
        pts.push([xe, belt + 0.12]);
        lastX = xe;
        break;
      }
      prevX = x;
      prevY = y;
    }
    if (first === null || lastX - first < 0.12) return null;
    pts.push([lastX, belt + 0.04]);
    // pts run rear -> front along the top; make the polygon CCW: bottom rear, bottom front, top front -> rear
    const bottomRear = pts[0], topPts = pts.slice(1, -1), bottomFront = pts[pts.length - 1];
    return [bottomRear, bottomFront, ...topPts.reverse()].map(([x, y]) => [x, y] as [number, number]);
  };
  for (const side of [-1, 1] as const) {
    const intervals: { x0: number; x1: number; part: VehiclePart | null; kind: 'glass' | 'open'; door: boolean }[] = [];
    for (const r of L.rows) {
      const k = secOf(r.x);
      const w = r.side[side];
      const inCab = k === 'cabin' || k === 'shield' || (k === 'box' && (w.kind === 'glass' || w.kind === 'door')) || (k === 'rearglass' && verticalRear);
      if (!inCab) continue;
      const door = L.doors.find((d) => d.part === w.part);
      if (w.kind === 'door' && door) {
        intervals.push({ x0: door.x0, x1: door.x1, part: door.part, kind: door.window ? 'glass' : 'open', door: true });
      } else if (w.kind === 'glass' || (w.kind === 'half' && r.roof) || (w.kind === 'none' && r.roof)) {
        const prev = intervals[intervals.length - 1];
        const kind = w.kind === 'none' ? 'open' : 'glass';
        if (prev && !prev.door && prev.kind === kind && L.style !== 'bus' && Math.abs(prev.x1 - (r.x + 0.5)) < 0.01) prev.x1 = r.x - 0.5;
        else intervals.push({ x0: r.x + 0.5, x1: r.x - 0.5, part: w.part, kind, door: false });
      }
    }
    // doors reaching forward to the A-pillar overlap the row ahead: trim the earlier pane
    for (let i = 0; i < intervals.length - 1; i++) if (intervals[i].x1 < intervals[i + 1].x0) intervals[i].x1 = intervals[i + 1].x0;
    const g = L.style === 'bus' ? 0.06 : 0.06;
    for (let i = 0; i < intervals.length; i++) {
      const iv = intervals[i];
      const x0 = iv.x0 - (i > 0 ? g : 0.02), x1 = iv.x1 + (i < intervals.length - 1 ? g : 0.03);
      const doorInfo = iv.door ? L.doors.find((d) => d.part === iv.part) ?? null : null;
      const open = !!doorInfo && doorInfo.part.open;
      const pts = x0 - x1 > 0.15 ? paneFor(x0, x1) : null;
      const broken = iv.part ? iv.part.hp <= 0 : false;
      const pane: Pane | null = pts ? { x0, x1, pts, kind: iv.kind === 'glass' && !broken ? 'glass' : 'open', part: iv.part, door: iv.door } : null;
      if (open && doorInfo) {
        // the whole door is a hole; its pane travels with the leaf
        const hp: [number, number][] = [];
        const dx0 = doorInfo.x0 - 0.01, dx1 = doorInfo.x1 + 0.01;
        const xs: number[] = [];
        for (let x = dx1; x < dx0; x += 0.1) xs.push(x);
        xs.push(dx0);
        const topAt = (x: number) => ghTop(x) - 0.03;
        const botAt = (x: number) => Math.min(bottomAt(x) + 0.05, topAt(x) - 0.06);
        for (const x of xs) hp.push([x, botAt(x)]);
        for (const x of [...xs].reverse()) hp.push([x, topAt(x)]);
        doorHoles[side].push({ d: doorInfo, pts: hp, pane });
      } else if (pane) panes[side].push(pane);
    }
  }

  // --- skin ---
  const lampSpecs = lamps(L, v);
  const rowBlood = new Map<number, number>(), rowDamage = new Map<number, number>();
  for (const q of v.parts) {
    rowBlood.set(q.mx, Math.max(rowBlood.get(q.mx) ?? 0, q.blood));
    if (q.def.location === 'structure' || has(q, 'WHEEL')) continue;
    const d = q.def.durability > 0 ? 1 - Math.max(0, q.hp) / q.def.durability : 0;
    rowDamage.set(q.mx, Math.max(rowDamage.get(q.mx) ?? 0, d));
  }
  const skinIn: SkinInput = {
    paint: v.paint,
    seed: v.uid % 1000,
    panes: { [-1]: panes[-1].map((q) => ({ x0: q.x0, x1: q.x1, pts: q.pts, kind: q.kind })), [1]: panes[1].map((q) => ({ x0: q.x0, x1: q.x1, pts: q.pts, kind: q.kind })) } as SkinInput['panes'],
    arches,
    rowBlood,
    rowDamage,
    headlamps: lampSpecs.head.map((l) => ({ z: l.z, y: l.y, w: l.w, h: l.h })),
    taillamps: lampSpecs.tail.map((l) => ({ z: l.z, y: l.y, w: l.w, h: l.h })),
    wallTop: ghTop,
    yMax,
  };
  const skinKey = [v.protoId, v.paint, v.uid, Math.round(L.wear * 20), [...rowDamage.values()].map((d) => Math.round(d * 4)).join(''), [...rowBlood.values()].map((b) => Math.round(b / 150)).join('')].join('|');
  const skin = opts.reuseSkinKey === skinKey ? null : paintSkin(L, skinIn);
  const lay = skin?.layout ?? null;
  const uvOf = (sheet: SheetName, a: V3): [number, number] => {
    if (!lay) return [0, 0];
    if (sheet === 'right' || sheet === 'left') return sheetUv(lay, sheet, a[0], a[1] - base);
    if (sheet === 'top' || sheet === 'under') return sheetUv(lay, sheet, a[0], a[2]);
    return sheetUv(lay, sheet, a[2], a[1] - base);
  };
  const sheetFor = (n: V3, kind?: SegKind): SheetName => {
    if (kind === 'under') return 'under';
    const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
    if (ay >= ax && ay >= az) return n[1] > 0 ? 'top' : 'under';
    if (ax >= az) return n[0] > 0 ? 'front' : 'rear';
    return n[2] > 0 ? 'right' : 'left';
  };

  const body = new GeomBuilder(), roof = new GeomBuilder(), glass = new GeomBuilder();
  const tri = (g: GeomBuilder, a: V3, b: V3, c: V3, kind?: SegKind, forceSheet?: SheetName, shade = 1, uvFrom?: [V3, V3, V3]) => {
    const n = faceNormal(a, b, c);
    if (!Number.isFinite(n[0])) return;
    const sheet = forceSheet ?? sheetFor(n, kind);
    const src = uvFrom ?? [a, b, c];
    const ua = uvOf(sheet, src[0]), ub = uvOf(sheet, src[1]), uc = uvOf(sheet, src[2]);
    const s = sheet === 'under' ? 0.55 * shade : shade;
    g.tri(a, b, c, n, [ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]], FULL, [s, s, s]);
  };
  const quadB = (g: GeomBuilder, a: V3, b: V3, c: V3, d: V3, kind?: SegKind, forceSheet?: SheetName) => {
    tri(g, a, b, c, kind, forceSheet);
    tri(g, a, c, d, kind, forceSheet);
  };

  // --- skin strip ---
  const C30 = Math.cos(Math.PI / 6), S30 = 0.5, C60 = 0.5, S60 = Math.sin(Math.PI / 3);
  const section = (i: number): V3[] => {
    const q = Q[i], n = normals[i];
    const b = q.b, cr = q.crown;
    const rows: [number, number][] = [[hw, 0], [hw - b + b * C30, b * S30], [hw - b + b * C60, b * S60], [hw - b, b], [(hw - b) * 0.5, b + cr * 0.75], [0, b + cr], [-(hw - b) * 0.5, b + cr * 0.75], [-(hw - b), b], [-(hw - b + b * C60), b * S60], [-(hw - b + b * C30), b * S30], [-hw, 0]];
    return rows.map(([zl, off]) => P3(q.x + n.nx * off, q.y + n.ny * off, zl));
  };
  const sections = Q.map((_, i) => section(i));
  const cab = L.cabin;
  // Roof panels hide in top-down view (you look into the cabin, like CDDA's map).
  const roofFront = L.xCowl !== null && !p.flatFront ? L.xCowl - p.rake * 0.6 : L.xNose - p.rake - 0.05;
  const inRoofZone = (x: number, y: number) => !!cab && y > p.belt + 0.25 && x < roofFront;
  const shieldParts = L.sections.filter((s) => s.kind === 'shield').flatMap((s) => s.rows).flatMap((x) => v.parts.filter((q) => q.mx === x && has(q, 'WINDSHIELD')));
  const rearParts = L.sections.filter((s) => s.kind === 'rearglass').flatMap((s) => s.rows).flatMap((x) => v.parts.filter((q) => q.mx === x && (has(q, 'WINDSHIELD') || has(q, 'WINDOW'))));
  const endDoor = L.rows[L.rows.length - 1]?.endDoor ?? null;
  const tailOpen = !!endDoor && endDoor.open;
  const brokenGlass = { shield: glassBroken(shieldParts), rear: glassBroken(rearParts), tail: endDoor ? endDoor.hp <= 0 : glassBroken(rearParts) };
  const shards: [V3, V3][] = [];
  for (let i = 0; i < Q.length; i++) {
    const j = (i + 1) % Q.length;
    const A = sections[i], B = sections[j];
    const pt = loop[j];
    let kind = pt.kind;
    const segLen = Math.hypot(Q[j].x - Q[i].x, Q[j].y - Q[i].y);
    if (segLen < 1e-4) continue;
    // an open tailgate / shutter / hatch leaves the tail face open (side walls stay)
    const onTail = Math.max(loop[i].x, loop[j].x) < L.xTail + 0.35 && i < nTop - 1 && Math.min(loop[i].y, loop[j].y) > p.sill + 0.2;
    if (tailOpen && onTail) kind = 'open';
    const isGlass = kind === 'glass';
    const broken = isGlass && pt.glass ? brokenGlass[pt.glass] : false;
    const target = inRoofZone((Q[i].x + Q[j].x) / 2, Math.min(Q[i].y, Q[j].y)) && kind === 'paint' ? roof : body;
    for (let k = 0; k < 10; k++) {
      const middle = k >= 3 && k < 7;
      const a = A[k], a2 = A[k + 1], b = B[k], b2 = B[k + 1];
      if (middle && kind === 'open') continue;
      if (middle && isGlass) {
        if (!broken) quadB(glass, a, a2, b2, b);
        else if (k === 3) shards.push([A[3], A[7]]);
        continue;
      }
      quadB(target, a, a2, b2, b, kind);
    }
  }
  // Cracked-out glass: jagged teeth left in the frame.
  for (const [a, b] of shards) {
    const n = 7;
    for (let s = 0; s < n; s++) {
      const t0 = s / n, t1 = (s + 1) / n, tm = (t0 + t1) / 2;
      const lerp = (t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      const h = 0.04 + ((s * 7919 + v.uid) % 5) * 0.03;
      const tip = lerp(tm);
      tip[1] += h;
      glass.tri(lerp(t0), lerp(t1), tip, [1, 0, 0], [0, 0, 0, 0, 0, 0], FULL, [1, 1, 1]);
    }
  }

  // --- side walls ---
  const contour = Q.map((q) => new THREE.Vector2(q.x, q.y));
  if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
  for (const side of [-1, 1] as const) {
    const holes: THREE.Vector2[][] = [];
    for (const pn of panes[side]) holes.push(pn.pts.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const dh of doorHoles[side]) holes.push(dh.pts.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const h of holes) if (!THREE.ShapeUtils.isClockWise(h)) h.reverse();
    const all = [...contour, ...holes.flat()];
    const faces = THREE.ShapeUtils.triangulateShape(contour, holes);
    const zl = side * hw;
    const sheet: SheetName = side > 0 ? 'right' : 'left';
    for (const [ia, ib, ic] of faces) {
      const a = P3(all[ia].x, all[ia].y, zl), b = P3(all[ib].x, all[ib].y, zl), c = P3(all[ic].x, all[ic].y, zl);
      const n = faceNormal(a, b, c);
      if (n[2] * side >= 0) tri(body, a, b, c, 'paint', sheet);
      else tri(body, a, c, b, 'paint', sheet);
    }
    // side glass
    for (const pn of panes[side]) {
      if (pn.kind !== 'glass') {
        if (pn.part && pn.part.hp <= 0) {
          const [x1, y1] = pn.pts[0], [x0] = pn.pts[1];
          shardsSide(glass, P3(x1, y1, zl - side * 0.03), P3(x0, y1, zl - side * 0.03), v.uid);
        }
        continue;
      }
      paneGlass(glass, pn.pts, (x, y) => P3(x, y, side * (hw - 0.03)), side);
    }
    // open doors: a leaf swung out ~65 deg on its front hinge
    for (const dh of doorHoles[side]) {
      const d = dh.d;
      const ang = 1.15;
      const hx = d.x0, cs = Math.cos(ang), sn = Math.sin(ang);
      const swing = (x: number, y: number, zOff: number): V3 => {
        const at = P3(x, y, side * (hw + zOff));
        const zh = P3(hx, y, side * hw)[2];
        const dx = x - hx, dz = at[2] - zh;
        return [hx + dx * cs, at[1], zh + side * -dx * sn + dz * cs];
      };
      const leaf = dh.pts.map(([x, y]) => new THREE.Vector2(x, y));
      if (THREE.ShapeUtils.isClockWise(leaf)) leaf.reverse();
      const win = dh.pane?.pts.map(([x, y]) => new THREE.Vector2(x, y)) ?? null;
      const wHoles = win ? [win] : [];
      for (const h of wHoles) if (!THREE.ShapeUtils.isClockWise(h)) h.reverse();
      const lall = [...leaf, ...wHoles.flat()];
      const lf = THREE.ShapeUtils.triangulateShape(leaf, wHoles);
      for (const [ia, ib, ic] of lf) {
        const pa = lall[ia], pb = lall[ib], pc = lall[ic];
        const a = swing(pa.x, pa.y, 0), b = swing(pb.x, pb.y, 0), c = swing(pc.x, pc.y, 0);
        const ua = P3(pa.x, pa.y, side * hw), ub = P3(pb.x, pb.y, side * hw), uc = P3(pc.x, pc.y, side * hw);
        // outward after the swing: (sin a, 0, side cos a)
        const n = faceNormal(a, b, c);
        if (n[0] * sn + n[2] * side * cs >= 0) tri(body, a, b, c, 'paint', sheet, 1, [ua, ub, uc]);
        else tri(body, a, c, b, 'paint', sheet, 1, [ua, uc, ub]);
      }
      if (dh.pane && dh.pane.kind === 'glass') paneGlass(glass, dh.pane.pts, (x, y) => swing(x, y, -0.02), side);
    }
  }

  // --- parts: wheels, interior, bumpers, mirrors ---
  const parts = new Batches(), wheels = new Batches();
  const paintC = liveryBody(L, v.paint);
  const floorY = p.sill + 0.1;
  const seatTop = Math.max(floorY + 0.2, p.belt - 0.45);
  const cabX0 = cab ? cab.x0 : L.xNose, cabX1 = L.sections.filter((s) => s.kind !== 'deck' && s.kind !== 'bed' && s.kind !== 'flat' && s.kind !== 'hood').reduce((m, s) => Math.min(m, s.x1), cabX0);
  // floor across the cabin (and boxes), inside the walls
  if (cab) {
    const fz = hw - 0.06;
    parts.get(darkenC(p.interior, 0.8)).box(cabX1 + 0.05, base + floorY - 0.04, L.yc - fz, cabX0 - 0.05, base + floorY, L.yc + fz, 4, F.floor, F.floor, base);
  }
  // bed floors
  for (const s of L.sections.filter((q) => q.kind === 'bed')) {
    const fz = hw - 0.06;
    parts.get(0x55565a).box(Math.max(L.xTail + 0.08, s.x1), base + p.sill + 0.26, L.yc - fz, s.x0 - 0.02, base + p.sill + 0.3, L.yc + fz, 4, F.ribbed, F.ribbed, base);
    // cab back / bulkhead below the rail
    quadB(body, P3(s.x0, p.sill + 0.28, hw - 0.02), P3(s.x0, p.sill + 0.28, -(hw - 0.02)), P3(s.x0, p.deck, -(hw - 0.02)), P3(s.x0, p.deck, hw - 0.02), 'paint', 'rear');
  }
  // chassis block between the wheels: grounds the body (you see under a car, not through it)
  {
    const wz = Math.max(0.2, hw - 0.42);
    parts.get(0x2a2a2c).box(L.xTail + 0.45, base + p.sill * 0.35, L.yc - wz, L.xNose - 0.45, base + p.sill + 0.03, L.yc + wz, 63, F.dark, F.dark, base);
  }
  // bumpers
  const bumperTint = p.bumper === 'chrome' ? 0xb8bcc2 : p.bumper === 'black' ? 0x2e2f33 : paintC;
  const bumperSw: PartSwatch = p.bumper === 'chrome' ? 'chrome' : p.bumper === 'black' ? 'dark' : 'metal';
  for (const [x, dir] of [[L.xNose, 1], [L.xTail, -1]] as const) {
    const bz = hw * taper(x) + 0.02;
    const xa = dir > 0 ? x - 0.18 : x - 0.06, xb = dir > 0 ? x + 0.06 : x + 0.18;
    chamferBox(parts.get(bumperTint), xa, base + p.sill - 0.02, L.yc - bz, xb, base + p.sill + 0.22, L.yc + bz, 0.12, F[bumperSw], F[bumperSw]);
  }
  // mirrors at the A-pillar base
  if (L.xCowl !== null) {
    const mx = (p.flatFront ? L.xNose - p.rake : L.xCowl) - 0.22;
    for (const side of [-1, 1]) {
      const z = L.yc + side * (hw * tumble(mx, belt + 0.1) + 0.12);
      chamferBox(parts.get(p.blackPillars ? 0x2a2a2e : paintC), mx - 0.06, base + belt + 0.04, z - 0.1, mx + 0.08, base + belt + 0.2, z + 0.1, 0.04, F.metal, F.metal);
      tube(parts.get(0x2a2a2e), [mx, base + belt + 0.06, L.yc + side * (hw - 0.02)], [mx, base + belt + 0.1, z - side * 0.08], 0.02, F.dark, 4);
    }
  }
  // dashboard + steering wheel
  let driverZ: number | null = null;
  const dashFront = p.flatFront || L.xCowl === null ? L.xNose - 0.12 : L.xCowl - 0.02;
  // The cockpit camera sits at `eyeH`: the dash stays under the bonnet line so from the
  // driver's seat the car is a thin band (dash, then a sliver of bonnet) under the road.
  const dashTop = Math.min(belt - 0.1, p.hood - 0.14);
  if (cab) {
    const dz = hw - 0.08;
    chamferBox(parts.get(darkenC(p.interior, 0.7)), dashFront - 0.34, base + dashTop - 0.28, L.yc - dz, dashFront, base + dashTop, L.yc + dz, 0.05, F.dark, F.dark);
  }
  const ctrl = v.parts.find((q) => has(q, 'CONTROLS'));
  if (ctrl && cab) {
    driverZ = L.zOf(ctrl.my);
    const sx = Math.min(dashFront - 0.46, ctrl.mx + 0.62);
    steeringWheel(parts.get(0x1e1e22), sx, base + dashTop - 0.16, driverZ, 0.18, F.dark);
    // instrument binnacle
    chamferBox(parts.get(0x1a1a1c), dashFront - 0.36, base + dashTop - 0.02, driverZ - 0.15, dashFront - 0.24, base + dashTop + 0.03, driverZ + 0.15, 0.03, F.dark, F.dark);
  }
  // seats
  for (const s of v.parts.filter((q) => has(q, 'SEAT') || has(q, 'BED'))) {
    const tint = s.hp > 0 ? p.interior : darkenC(p.interior, 0.6);
    seat(parts.get(tint), s, L, base, floorY, seatTop, F, has(s, 'BED'));
  }
  // wheels
  for (const w of L.wheels) {
    const flat = w.part.hp <= 0;
    const r = w.r;
    wheel(wheels.get(flat ? 0x5a5656 : 0x9a9a9a), w.x, base + (flat ? r * 0.8 : r), w.z, r, w.width, F, { flat, sides: r > 0.4 ? 16 : 14, rimFrac: L.style === 'truck' || L.style === 'bus' ? 0.55 : 0.64 });
  }
  // exhaust
  tube(parts.get(0x8a8a8e), [L.xTail + 0.5, base + p.sill * 0.6, L.yc - hw * 0.45], [L.xTail - 0.04, base + p.sill * 0.6, L.yc - hw * 0.45], 0.035, F.chrome, 6);

  // --- lamps (emissive when on) ---
  const lampsG = new GeomBuilder(), tailsG = new GeomBuilder(), beaconsB = new Batches();
  for (const l of lampSpecs.head) if (l.ok) lampBox(lampsG, l.x, base + l.y, l.z, l.w, l.h, 1);
  for (const l of lampSpecs.tail) lampBox(tailsG, l.x, base + l.y, l.z, l.w, l.h, -1);
  beacons(beaconsB, L, base, hw, p, F);

  // --- sag on flat tyres (the body settles onto the dead corner) ---
  const sag = sagPlane(L);
  const out = (g: GeomBuilder | Batches, sagIt = true): THREE.BufferGeometry | null => {
    const geo = g instanceof Batches ? g.build() : g.vertexCount ? g.build() : null;
    if (geo && sagIt && sag) applySag(geo, sag);
    return geo;
  };
  const partsGeo = out(parts);
  const wheelsGeo = out(wheels, false);
  const merged = partsGeo && wheelsGeo ? mergeTwo(partsGeo, wheelsGeo) : partsGeo ?? wheelsGeo;

  const eyeH = Math.min(p.roof - 0.14, Math.max(seatTop + 0.68, p.hood + 0.3, belt + 0.24));
  return {
    body: out(body), roof: out(roof), parts: merged, glass: out(glass), lamps: out(lampsG), tails: out(tailsG), beacons: out(beaconsB),
    skin, skinKey, layout: L, eyeH, driverZ, parkedLean: 0,
  };
}

function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  // same attribute layout (GeomBuilder output)
  const out = new THREE.BufferGeometry();
  for (const n of Object.keys(a.attributes)) {
    const aa = a.getAttribute(n).array as Float32Array, bb = b.getAttribute(n).array as Float32Array;
    const arr = new Float32Array(aa.length + bb.length);
    arr.set(aa, 0);
    arr.set(bb, aa.length);
    out.setAttribute(n, new THREE.BufferAttribute(arr, a.getAttribute(n).itemSize));
  }
  const ia = a.getIndex()!.array, ib = b.getIndex()!.array;
  const va = a.getAttribute('position').count, total = va + b.getAttribute('position').count;
  const idx = total > 65535 ? new Uint32Array(ia.length + ib.length) : new Uint16Array(ia.length + ib.length);
  idx.set(ia, 0);
  for (let i = 0; i < ib.length; i++) idx[ia.length + i] = ib[i] + va;
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  a.dispose();
  b.dispose();
  return out;
}

export function darkenC(c: number, k: number): number {
  return (Math.round(((c >> 16) & 255) * k) << 16) | (Math.round(((c >> 8) & 255) * k) << 8) | Math.round((c & 255) * k);
}

function paneGlass(g: GeomBuilder, pts: [number, number][], at: (x: number, y: number) => V3, side: number): void {
  const c = pts.map(([x, y]) => new THREE.Vector2(x, y));
  if (THREE.ShapeUtils.isClockWise(c)) c.reverse();
  const faces = THREE.ShapeUtils.triangulateShape(c, []);
  for (const [ia, ib, ic] of faces) {
    const a = at(c[ia].x, c[ia].y), b = at(c[ib].x, c[ib].y), cc = at(c[ic].x, c[ic].y);
    const n = faceNormal(a, b, cc);
    if (n[2] * side >= 0) g.tri(a, b, cc, n, [0, 0, 0, 0, 0, 0], FULL, [1, 1, 1]);
    else g.tri(a, cc, b, [-n[0], -n[1], -n[2]], [0, 0, 0, 0, 0, 0], FULL, [1, 1, 1]);
  }
}

function shardsSide(g: GeomBuilder, a: V3, b: V3, seed: number): void {
  const n = 6;
  for (let s = 0; s < n; s++) {
    const t0 = s / n, t1 = (s + 1) / n;
    const lerp = (t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const tip = lerp((t0 + t1) / 2);
    tip[1] += 0.03 + ((s * 31 + seed) % 4) * 0.035;
    g.tri(lerp(t0), lerp(t1), tip, [0, 0, 1], [0, 0, 0, 0, 0, 0], FULL, [1, 1, 1]);
  }
}

/** Emissive lamp lens: a thin box proud of the face it sits on. */
function lampBox(g: GeomBuilder, x: number, y: number, z: number, w: number, h: number, dir: number): void {
  const x0 = dir > 0 ? x - 0.02 : x - 0.025, x1 = dir > 0 ? x + 0.025 : x + 0.02;
  g.box(x0, y - h, z - w, x1, y + h, z + w, 63 & ~(dir > 0 ? 2 : 1), FULL, FULL, y - h);
}

interface LampSpec { x: number; y: number; z: number; w: number; h: number; ok: boolean }

/** Headlamps (from the vehicle's CONE_LIGHT parts) and tail lamps (always: none in BN data). */
function lamps(L: Layout, v: Vehicle): { head: LampSpec[]; tail: LampSpec[] } {
  const p = L.p, hw = L.hw;
  const head: LampSpec[] = [];
  const lights = v.parts.filter((q) => has(q, 'CONE_LIGHT') || has(q, 'WIDE_CONE_LIGHT'));
  const noseX = L.xNose + p.crown * 0.3;
  const lz = hw * 0.92 - p.lampW - 0.08;
  const sides = new Map<number, boolean>();
  for (const l of lights) {
    const s = l.my < L.yc - 0.01 ? -1 : l.my > L.yc + 0.01 ? 1 : 0;
    sides.set(s, (sides.get(s) ?? false) || l.hp > 0);
  }
  if (sides.has(0) && sides.size === 1) {
    // one centre lamp on a grid with a single light: split it into a pair anyway
    sides.set(-1, sides.get(0)!);
    sides.set(1, sides.get(0)!);
    sides.delete(0);
  }
  const lampY = p.flatFront ? p.sill + 0.42 : Math.min(p.lampY, p.nose - 0.14);
  for (const [s, ok] of sides) head.push({ x: noseX, y: lampY, z: L.yc + s * lz, w: p.lampW, h: p.lampH, ok });
  const tail: LampSpec[] = [];
  const ty = p.flatFront || L.style === 'van' || L.style === 'truck' ? p.sill + 0.45 : Math.min(p.belt - 0.14, p.deck - 0.16);
  for (const s of [-1, 1]) tail.push({ x: L.xTail, y: ty, z: L.yc + s * (hw * 0.95 - 0.2), w: 0.12, h: 0.07, ok: true });
  return { head, tail };
}

function seat(g: GeomBuilder, s: VehiclePart, L: Layout, base: number, floorY: number, seatTop: number, F: ReturnType<typeof partFrames>, bed: boolean): void {
  const x = s.mx, z = L.zOf(s.my);
  const half = Math.min(0.27, Math.max(0.16, (L.zOf(1) - L.zOf(0)) * 0.46));
  const sw = F.fabric;
  // cushion
  chamferBox(g, x - 0.3, base + floorY + 0.02, z - half, x + 0.22, base + seatTop, z + half, 0.05, sw, sw);
  if (bed) {
    chamferBox(g, x - 0.45, base + seatTop - 0.05, z - half, x + 0.45, base + seatTop + 0.08, z + half, 0.05, sw, sw);
    return;
  }
  if (s.hp <= 0) return;
  // backrest leaning back ~15 deg, headrest on top
  const bx0 = x - 0.36, bx1 = x - 0.22, top = seatTop + 0.58;
  const lean = 0.14;
  const corners = (y: number, dx: number): [V3, V3, V3, V3] => [[bx0 - dx, base + y, z - half], [bx1 - dx, base + y, z - half], [bx1 - dx, base + y, z + half], [bx0 - dx, base + y, z + half]];
  const lo = corners(seatTop - 0.05, 0), hi = corners(top, lean);
  quad4(g, lo[1], hi[1], hi[2], lo[2], sw); // front (+x)
  quad4(g, lo[3], hi[3], hi[0], lo[0], sw); // back
  quad4(g, lo[2], hi[2], hi[3], lo[3], sw); // right
  quad4(g, lo[0], hi[0], hi[1], lo[1], sw); // left
  quad4(g, hi[0], hi[3], hi[2], hi[1], sw); // top
  chamferBox(g, bx0 - lean - 0.02, base + top, z - half * 0.55, bx1 - lean - 0.02, base + top + 0.16, z + half * 0.55, 0.03, sw, sw);
}

function steeringWheel(g: GeomBuilder, x: number, y: number, z: number, r: number, f: TileFrame): void {
  // A ring of tubes tilted ~25 deg back toward the driver, plus a column into the dash.
  const tilt = 0.45, N = 10;
  const pt = (i: number): V3 => {
    const a = (i / N) * Math.PI * 2;
    const u = Math.cos(a) * r, w = Math.sin(a) * r;
    return [x - u * Math.sin(tilt), y + u * Math.cos(tilt), z + w];
  };
  for (let i = 0; i < N; i++) tube(g, pt(i), pt(i + 1), 0.022, f, 4);
  tube(g, [x, y, z], [x + 0.35, y - 0.18, z], 0.03, f, 5);
  tube(g, pt(0), pt(N / 2), 0.02, f, 4);
}

function beacons(b: Batches, L: Layout, base: number, hw: number, p: Layout['p'], F: ReturnType<typeof partFrames>): void {
  const cab = L.cabin;
  if (!cab) return;
  const roofY = base + p.roof + p.crown + 0.02;
  if (L.livery === 'police' || L.livery === 'security' || L.livery === 'swat') {
    const x = (cab.x0 - p.rake + cab.x1) / 2 + 0.2;
    const w = hw * 0.62;
    chamferBox(b.get(0x1a1a1e), x - 0.12, roofY - 0.02, L.yc - w, x + 0.12, roofY + 0.05, L.yc + w, 0.04, F.dark, F.dark);
    const cols = L.livery === 'security' ? [0xf0a020, 0xf0a020] : [0xe02020, 0x2040f0];
    chamferBox(b.get(cols[0]), x - 0.1, roofY + 0.05, L.yc - w + 0.02, x + 0.1, roofY + 0.15, L.yc - 0.05, 0.04, F.light, F.light);
    chamferBox(b.get(cols[1]), x - 0.1, roofY + 0.05, L.yc + 0.05, x + 0.1, roofY + 0.15, L.yc + w - 0.02, 0.04, F.light, F.light);
  } else if (L.livery === 'ambulance' || L.livery === 'fire') {
    const boxS = L.sections.find((s) => s.kind === 'box');
    const top = base + (boxS ? p.box : p.roof) + p.crown;
    const x = boxS ? boxS.x0 - 0.15 : cab.x0 - p.rake - 0.1;
    for (const s of [-1, 1]) chamferBox(b.get(0xe02020), x - 0.08, top - 0.02, L.yc + s * (hw - 0.25) - 0.1, x + 0.08, top + 0.1, L.yc + s * (hw - 0.25) + 0.1, 0.03, F.light, F.light);
    chamferBox(b.get(0xf0f0f0), x - 0.08, top - 0.02, L.yc - 0.12, x + 0.08, top + 0.08, L.yc + 0.12, 0.03, F.light, F.light);
  } else if (L.livery === 'school') {
    // the warning lamps high on the front and rear faces
    const top = base + p.roof - 0.08;
    const front = (L.xCowl ?? L.xNose) - p.rake + 0.02;
    for (const [x, c, d] of [[front, 0xf0a020, 1], [L.xTail, 0xe02020, -1]] as const)
      for (const s of [-1, 1]) chamferBox(b.get(c), x - (d > 0 ? 0.02 : 0.05), top - 0.14, L.yc + s * (hw - 0.3) - 0.08, x + (d > 0 ? 0.05 : 0.02), top - 0.02, L.yc + s * (hw - 0.3) + 0.08, 0.02, F.light, F.light);
  }
}

interface Sag { cx: number; cz: number; drop: number; ax: number; az: number }

/** Plane the body sinks along when tyres are destroyed (small-angle shear of heights). */
function sagPlane(L: Layout): Sag | null {
  const flats = L.wheels.filter((w) => w.part.hp <= 0);
  if (!flats.length) return null;
  const cx = (L.xNose + L.xTail) / 2, cz = L.yc;
  let drop = 0, sx = 0, sz = 0;
  for (const w of flats) {
    const d = w.r * 0.22;
    drop += d / L.wheels.length;
    sx += (d * (w.x - cx)) / Math.max(1, ((L.xNose - L.xTail) / 2) ** 2) / 2;
    sz += (d * (w.z - cz)) / Math.max(0.5, L.hw ** 2) / 2;
  }
  return { cx, cz, drop, ax: sx, az: sz };
}

function applySag(geo: THREE.BufferGeometry, s: Sag): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, pos.getY(i) - (s.drop + s.ax * (x - s.cx) + s.az * (z - s.cz)));
  }
  pos.needsUpdate = true;
  geo.computeBoundingSphere();
}
