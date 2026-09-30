import type * as THREE from 'three';
import { has, type Vehicle, type VehiclePart } from '../game/vehicle';
import { GeomBuilder } from './geometry';
import { cddaColor } from './colors';
import { wheelRadius, type Layout } from './vehicleLayout';
import { Batches, chamferBox, partFrames, tube, wheel } from './vehicleGeom';
import { darkenC, lampBox, seat, steeringWheel, type ModelBuild } from './vehicleModel';
import { rimGrips, type RideAnchors } from './vehicleRider';
import { liveryBody, skinLayoutInfo } from './vehicleSkin';

// The "model" look for grids that aren't a car / truck / bus / bike: golf carts, tractors,
// carts, APCs and whatever players weld together. These stay frame-like (the grid is the
// honest shape of a home-made vehicle) but tidy: a chassis plate per frame mount, panels on
// the outside edges only, real seats and wheels, glass in window frames, machinery as
// rounded blocks instead of full-tile boxes. Unlike the car bodies nothing is squeezed:
// every part sits on its own tile.

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const CHASSIS_Y0 = 0.26, CHASSIS_Y1 = 0.38, PANEL = 0.07, ROOF_Y = 1.85;

function partTint(p: VehiclePart, fallback: number): number {
  const name = p.hp > 0 ? p.def.color : p.def.broken_color ?? p.def.color;
  if (!name) return fallback;
  const c = cddaColor(name);
  // CDDA curses colours are garish: pull them toward grey
  const mix = (s: number) => Math.round(((c >> s) & 255) * 0.55 + 0x60 * 0.45);
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

export function buildFrame(v: Vehicle, L0: Layout, base: number): ModelBuild {
  const F = partFrames();
  const L: Layout = { ...L0, zOf: (my: number) => my, xOf: (mx: number) => mx };
  const parts = new Batches(), roof = new Batches(), glass = new GeomBuilder(), lamps = new GeomBuilder(), tails = new GeomBuilder();
  const paint = liveryBody(skinLayoutInfo(L), v.paint);
  const chassis = 0x3e3e42;
  const Y = (h: number) => base + h;
  const at = (mx: number, my: number) => v.partsAt(mx, my);
  const mounts: [number, number][] = [];
  for (const k of v.mounts()) mounts.push([Math.floor(k / 1024) - 512, (k % 1024) - 512]);
  const structural = mounts.filter(([x, y]) => at(x, y).some((p) => p.def.location === 'structure' && !has(p, 'PROTRUSION')));

  // Chassis: a plate under every frame mount; grids with no frame at all (wheels only) get
  // a spine between their wheels so they don't float.
  for (const [mx, my] of structural) chamferBox(parts.get(chassis), mx - 0.47, Y(CHASSIS_Y0), my - 0.47, mx + 0.47, Y(CHASSIS_Y1), my + 0.47, 0.06, F.metal, F.floor);
  if (!structural.length && v.wheels.length) {
    const xs = v.wheels.map((w) => w.mx), ys = v.wheels.map((w) => w.my);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), yc = (Math.min(...ys) + Math.max(...ys)) / 2;
    chamferBox(parts.get(chassis), x0 - 0.2, Y(0.35), yc - 0.3, x1 + 0.2, Y(0.75), yc + 0.3, 0.12, F.metal, F.metal);
    for (const x of new Set(xs)) tube(parts.get(0x2a2a2e), [x, Y(0.45), Math.min(...ys)], [x, Y(0.45), Math.max(...ys)], 0.06, F.dark, 6);
  }

  const seatTop = 0.62;
  let ride: RideAnchors | undefined;
  for (const [mx, my] of mounts) {
    const ps = at(mx, my);
    const outer = DIRS.map(([dx, dy]) => !v.hasMount(mx + dx, my + dy));
    /** Box along one outside edge of the tile: [x0, x1, z0, z1] for thickness t. */
    const edgeBox = (i: number, t: number): [number, number, number, number] => {
      const [dx, dy] = DIRS[i];
      const x0 = mx - 0.5, x1 = mx + 0.5, z0 = my - 0.5, z1 = my + 0.5;
      if (dx === 1) return [x1 - t, x1, z0, z1];
      if (dx === -1) return [x0, x0 + t, z0, z1];
      if (dy === 1) return [x0, x1, z1 - t, z1];
      return [x0, x1, z0, z0 + t];
    };
    const edge = (i: number, h0: number, h1: number, tint: number) => {
      const [x0, x1, z0, z1] = edgeBox(i, PANEL);
      chamferBox(parts.get(tint), x0, Y(h0), z0, x1, Y(h1), z1, 0.02, F.metal, F.metal);
    };
    const glassEdge = (i: number) => {
      const [x0, x1, z0, z1] = edgeBox(i, 0.03);
      glass.box(x0, Y(1.0), z0, x1, Y(ROOF_Y - 0.05), z1, 63, F.light, F.light, Y(1.0));
      // corner posts
      chamferBox(parts.get(0x2a2a2e), x0, Y(1.0), z0, x0 + 0.05, Y(ROOF_Y), z0 + 0.05, 0.01, F.dark, F.dark);
    };
    const find = (flag: string) => ps.find((p) => has(p, flag));
    const board = find('FULL_BOARD'), half = find('HALF_BOARD'), door = ps.find((p) => has(p, 'OPENABLE') && has(p, 'OBSTACLE'));
    const pane = ps.find((p) => has(p, 'WINDSHIELD') || (has(p, 'WINDOW') && !has(p, 'OPENABLE')));
    const dent = (p: VehiclePart, c: number) => (p.hp > 0 ? c : darkenC(c, 0.55));
    const outs = outer.map((o, i) => (o ? i : -1)).filter((i) => i >= 0);
    if (board) {
      if (outs.length) for (const i of outs) edge(i, CHASSIS_Y1, board.hp > 0 ? ROOF_Y : 1.0, dent(board, paint));
      else chamferBox(parts.get(dent(board, paint)), mx - 0.45, Y(CHASSIS_Y1), my - 0.45, mx + 0.45, Y(1.5), my + 0.45, 0.08, F.metal, F.metal);
    } else if (door) {
      for (const i of outs) {
        if (door.open) continue;
        edge(i, CHASSIS_Y1, has(door, 'WINDOW') ? 1.0 : ROOF_Y, dent(door, paint));
        if (has(door, 'WINDOW') && door.hp > 0) glassEdge(i);
      }
    } else if (half) {
      if (outs.length) for (const i of outs) edge(i, CHASSIS_Y1, 1.0, dent(half, paint));
      else chamferBox(parts.get(dent(half, paint)), mx - 0.45, Y(CHASSIS_Y1), my - 0.45, mx + 0.45, Y(0.95), my + 0.45, 0.12, F.metal, F.metal);
    }
    if (pane) {
      // glass in a thin frame on the outside edges (a windscreen row faces forward)
      for (const i of outs) {
        if (pane.hp > 0) glassEdge(i);
        if (!board && !half && !door) edge(i, CHASSIS_Y1, 1.0, paint);
      }
    }
    for (const w of ps.filter((p) => has(p, 'WHEEL'))) {
      const r = wheelRadius(w);
      const width = Math.max(0.05, Math.min(0.6, ((w.def.wheel?.width ?? 20) / 100) * 1.1));
      const side = outer[2] ? 1 : outer[3] ? -1 : 0;
      wheel(parts.get(w.hp > 0 ? 0x9a9a9a : 0x5a5656), mx, Y(w.hp > 0 ? r : r * 0.8), my + side * (0.5 - width / 2), r, width, F, { flat: w.hp <= 0, sides: r > 0.4 ? 16 : 12 });
    }
    const s = find('SEAT') ?? find('BED');
    if (s) {
      seat(parts.get(s.hp > 0 ? partTint(s, 0x6a3a30) : 0x3a3a3a), s, L, base, CHASSIS_Y1 - 0.02, seatTop, F, has(s, 'BED'));
    }
    if (find('CONTROLS')) {
      steeringWheel(parts.get(0x1e1e22), mx + 0.42, Y(0.85), my, 0.17, F.dark);
      // the driver sits on this tile's seat (open frame: seen from every side)
      const hipX = mx - 0.1;
      ride = {
        kind: 'seat', hip: [hipX, Y(seatTop + 0.07), my], lean: -0.05,
        grips: rimGrips(mx + 0.42, Y(0.85), my, 0.17, 0.45),
        feet: [[hipX + 0.6, Y(CHASSIS_Y1 + 0.1), my + 0.11], [hipX + 0.6, Y(CHASSIS_Y1 + 0.1), my - 0.11]],
      };
    }
    if (ps.some((p) => has(p, 'ROOF') && p.hp > 0)) chamferBox(roof.get(paint), mx - 0.5, Y(ROOF_Y), my - 0.5, mx + 0.5, Y(ROOF_Y + 0.08), my + 0.5, 0.02, F.metal, F.metal);
    // machinery and cargo that block the tile: rounded blocks in the part's colour
    const machine = ps.find((p) => has(p, 'OBSTACLE') && !has(p, 'WHEEL') && p !== board && p !== half && p !== door && p !== pane && !has(p, 'SEAT'));
    if (machine) chamferBox(parts.get(partTint(machine, 0x707070)), mx - 0.36, Y(CHASSIS_Y1), my - 0.36, mx + 0.36, Y(has(machine, 'ENGINE') ? 0.9 : 1.15), my + 0.36, 0.1, F.metal, F.metal);
    else if (ps.some((p) => has(p, 'ENGINE'))) chamferBox(parts.get(0x4a4a50), mx - 0.3, Y(CHASSIS_Y1), my - 0.28, mx + 0.3, Y(0.75), my + 0.28, 0.08, F.fins, F.metal);
    else if (ps.some((p) => has(p, 'CARGO')) && !s) chamferBox(parts.get(0x55565a), mx - 0.44, Y(CHASSIS_Y1), my - 0.44, mx + 0.44, Y(CHASSIS_Y1 + 0.04), my + 0.44, 0.03, F.ribbed, F.ribbed);
    // turrets: a mount and a barrel pointing forward
    const gun = ps.find((p) => has(p, 'TURRET'));
    if (gun) {
      const top = ps.some((p) => has(p, 'ROOF')) ? ROOF_Y + 0.08 : 1.1;
      chamferBox(parts.get(0x3a3c34), mx - 0.18, Y(top), my - 0.18, mx + 0.18, Y(top + 0.2), my + 0.18, 0.06, F.metal, F.metal);
      tube(parts.get(0x2a2a2c), [mx, Y(top + 0.12), my], [mx + 0.9, Y(top + 0.14), my], 0.035, F.dark, 6);
    }
    for (const l of ps.filter((p) => (has(p, 'CONE_LIGHT') || has(p, 'WIDE_CONE_LIGHT')) && p.hp > 0)) lampBox(lamps, mx + 0.5, Y(0.62), l.my, 0.14, 0.06, 1);
    const pr = ps.find((p) => has(p, 'PROTRUSION') && p.hp > 0);
    if (pr && !ps.some((p) => p.def.location === 'structure' && !has(p, 'PROTRUSION'))) chamferBox(parts.get(0x2a2a2e), mx - 0.08, Y(1.05), my - 0.1, mx + 0.08, Y(1.22), my + 0.1, 0.03, F.dark, F.dark);
  }
  // tail lamps on the rear corners of the chassis
  if (structural.length) {
    const xMin = Math.min(...structural.map(([x]) => x));
    const rear = structural.filter(([x]) => x === xMin).map(([, y]) => y);
    for (const y of [Math.min(...rear), Math.max(...rear)]) lampBox(tails, xMin - 0.5, Y(0.5), y, 0.1, 0.05, -1);
  }

  const out = (b: Batches | GeomBuilder): THREE.BufferGeometry | null => (b instanceof Batches ? b.build() : b.vertexCount ? b.build() : null);
  return {
    body: null, roof: out(roof), parts: out(parts), glass: out(glass), lamps: out(lamps), tails: out(tails), beacons: null,
    skin: null, skinJob: null, skinKey: '', layout: L, eyeH: 1.2, driverZ: null, parkedLean: 0, bodyUsesParts: true, ride,
  };
}
