import * as THREE from 'three';
import type { Game } from '../game/game';
import { has, type Vehicle, type VehiclePart } from '../game/vehicle';
import type { VehicleSystem } from '../game/vehicles';
import { LEVEL_HEIGHT } from '../world/coords';
import { setupPixelTexture } from './atlas';
import { INDOOR_SKY } from './chunkMesh';
import { cddaColor } from './colors';
import { GeomBuilder } from './geometry';
import type { LightHandle } from './lights';
import { patchNormalOutput, worldMaterials } from './materials';
import type { Renderer } from './renderer';
import type { TileFrame } from './textureSource';

// 3D meshes for vehicles, built from their parts mount by mount, as low-poly boxes wearing
// small procedural pixel-art swatches (UltiCa's vp_* sprites are 3/4-view drawings for a
// top-down grid, so like walls they don't suit box faces). Materials are the world
// material from materials.ts, so vehicles get the same banded lighting, shadows, outlines
// and palette grading as the chunk geometry; body colour comes from per-vertex tint.
//
// Each vehicle is an Object3D (body, roof, glass, lamps) placed every frame from the
// vehicle's continuous position and facing; geometry is rebuilt when vehicle.version
// changes (doors, damage, lights). Roofs hide in top-down view so you can see inside,
// like CDDA's map. Headlights: one shadowless SpotLight for the nearest lit vehicle (the
// light count is fixed at startup so shaders never recompile) + pool point lights.
//
// Local frame: three.js X = mount x (forward), Z = mount y (right side), Y = metres above
// z = 0 (absolute, so the renderer's top-down wall cut compares heights correctly).

const FLOOR = 0.32; // underside of the body
const DECK = 0.45; // interior floor / seat base
const BELT = 1.02; // top of doors, hood, fenders
const ROOF_LO = 1.8;
const ROOF_HI = 1.9;
const PANEL = 0.14; // thickness of door/board shells
const VIEW_RANGE = 90;
/** Headlight beam lights: [metres ahead of the bumper, intensity, radius]. */
const BEAM: [number, number, number][] = [[2.5, 1.1, 6], [7, 1.0, 8], [13, 0.8, 9]];

// --- procedural swatches ---------------------------------------------------------------

type Swatch = 'panel' | 'dark' | 'tire' | 'fabric' | 'light' | 'floor' | 'hub' | 'grille';
const SWATCHES: Swatch[] = ['panel', 'dark', 'tire', 'fabric', 'light', 'floor', 'hub', 'grille'];
const SW = 32;

function hash(x: number, y: number, s: number): number {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Grey-scale pixel art (tinted per vertex), one 32x32 swatch per surface kind. */
function paintSwatch(kind: Swatch, px: (x: number, y: number, v: number) => void): void {
  for (let y = 0; y < SW; y++)
    for (let x = 0; x < SW; x++) {
      const n = hash(x, y, SWATCHES.indexOf(kind));
      let v = 200;
      switch (kind) {
        case 'panel':
          // smooth paint, a seam every half metre and a soft highlight band
          v = 214 + (n < 0.06 ? -10 : 0) + (y === 0 || x === 0 ? -34 : 0) + (y === 16 ? -18 : 0) + (y > 3 && y < 7 ? 12 : 0);
          break;
        case 'dark':
          v = 88 + Math.floor(n * 24) - (x % 8 === 0 ? 14 : 0);
          break;
        case 'tire':
          v = 44 + ((x + (y >> 2)) % 6 < 2 ? 22 : 0) + Math.floor(n * 8);
          break;
        case 'fabric':
          v = 176 + (((x >> 1) + (y >> 1)) % 2 ? 26 : 0) + Math.floor(n * 12) - (y % 8 === 0 ? 24 : 0);
          break;
        case 'light':
          v = 255;
          break;
        case 'floor':
          v = 118 + Math.floor(n * 30) - ((x ^ y) % 5 === 0 ? 16 : 0);
          break;
        case 'hub': {
          const d = Math.hypot(x - 15.5, y - 15.5);
          v = d < 5 ? 150 : d < 11 ? 205 + Math.floor(n * 20) : 120;
          break;
        }
        case 'grille':
          v = y % 4 < 2 ? 60 : 170;
          break;
      }
      px(x, y, Math.max(0, Math.min(255, v)));
    }
}

let pageCache: { tex: THREE.Texture; frames: Record<Swatch, TileFrame> } | null = null;

function swatchPage(): { tex: THREE.Texture; frames: Record<Swatch, TileFrame> } {
  if (pageCache) return pageCache;
  const w = SW * SWATCHES.length;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = SW;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, SW);
  SWATCHES.forEach((k, i) => paintSwatch(k, (x, y, v) => {
    const o = (y * w + i * SW + x) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
    img.data[o + 3] = 255;
  }));
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  setupPixelTexture(tex);
  // Canvas rows are top-down; three flips Y on upload, so v=1 is the top row.
  const frames = Object.fromEntries(SWATCHES.map((k, i) => [k, { texture: tex, uv: [(i * SW) / w, 0, ((i + 1) * SW) / w, 1], w: SW, h: SW, ppm: 32 } as TileFrame])) as Record<Swatch, TileFrame>;
  pageCache = { tex, frames };
  return pageCache;
}

// --- geometry --------------------------------------------------------------------------

/** Geometry batches keyed by tint so the colour can be baked into vertex colours. */
class Batches {
  private map = new Map<number, GeomBuilder>();
  sky = 1;
  get(tint: number): GeomBuilder {
    let g = this.map.get(tint);
    if (!g) this.map.set(tint, (g = new GeomBuilder()));
    g.skyVis = this.sky;
    return g;
  }
  build(): THREE.BufferGeometry | null {
    const parts: THREE.BufferGeometry[] = [];
    for (const [tint, g] of this.map) {
      if (!g.vertexCount) continue;
      const geo = g.build();
      const col = geo.getAttribute('color') as THREE.BufferAttribute;
      // Used as a plain multiplier (not sRGB-decoded): the swatches are already dark-ish
      // and decoding would crush saturated paints to near black under banded lighting.
      const c = new THREE.Color().setRGB(((tint >> 16) & 255) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255, THREE.LinearSRGBColorSpace);
      for (let i = 0; i < col.count; i++) col.setXYZ(i, col.getX(i) * c.r, col.getY(i) * c.g, col.getZ(i) * c.b);
      parts.push(geo);
    }
    if (!parts.length) return null;
    const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts);
    if (parts.length > 1) for (const p of parts) p.dispose();
    return merged;
  }
}

/**
 * Concatenate indexed geometries with identical attribute layouts (GeomBuilder output).
 * Hand-rolled instead of BufferGeometryUtils so no extra three/examples module is pulled
 * into the dev server's dependency pre-bundle.
 */
function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const names = Object.keys(geos[0].attributes);
  let verts = 0, idx = 0;
  for (const g of geos) {
    verts += g.getAttribute('position').count;
    idx += g.getIndex()!.count;
  }
  for (const n of names) {
    const size = geos[0].getAttribute(n).itemSize;
    const arr = new Float32Array(verts * size);
    let o = 0;
    for (const g of geos) {
      const a = g.getAttribute(n).array as Float32Array;
      arr.set(a, o);
      o += a.length;
    }
    out.setAttribute(n, new THREE.BufferAttribute(arr, size));
  }
  const index = verts > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  let io = 0, vo = 0;
  for (const g of geos) {
    const ia = g.getIndex()!.array;
    for (let i = 0; i < ia.length; i++) index[io++] = ia[i] + vo;
    vo += g.getAttribute('position').count;
  }
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

const DIRS = [
  [1, 0], // front (+x)
  [-1, 0], // rear
  [0, 1], // right (+y)
  [0, -1], // left
] as const;

function darken(c: number, k: number): number {
  return (Math.round(((c >> 16) & 255) * k) << 16) | (Math.round(((c >> 8) & 255) * k) << 8) | Math.round((c & 255) * k);
}
function mix(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
/** CDDA curses colours are garish; mute them for materials. */
function partColor(p: VehiclePart, fallback: number): number {
  const name = p.hp > 0 ? p.def.color : p.def.broken_color ?? p.def.color;
  if (!name) return fallback;
  return mix(cddaColor(name), 0x606060, 0.45);
}

interface Built {
  body: THREE.BufferGeometry | null;
  roof: THREE.BufferGeometry | null;
  glass: THREE.BufferGeometry | null;
  lamps: THREE.BufferGeometry | null;
}

/** Build the meshes' geometry for a vehicle (pure: no scene access). */
export function buildVehicleGeometry(v: Vehicle, base: number): Built {
  const { frames: F } = swatchPage();
  const body = new Batches(), roof = new Batches(), glass = new GeomBuilder(), lamps = new GeomBuilder();
  const paint = v.paint;
  const chassis = 0x5a5a60;
  const trim = 0x2c2c30;
  const y = (h: number) => base + h;
  const box = (b: Batches, tint: number, x0: number, h0: number, z0: number, x1: number, h1: number, z1: number, side: TileFrame, top: TileFrame = side) =>
    b.get(tint).box(x0, y(h0), z0, x1, y(h1), z1, 63, side, top, base);

  const mountsWith = (pred: (p: VehiclePart) => boolean) => {
    const out: [number, number][] = [];
    for (const k of v.mounts()) {
      const mx = Math.floor(k / 1024) - 512, my = (k % 1024) - 512;
      if (v.partsAt(mx, my).some(pred)) out.push([mx, my]);
    }
    return out;
  };
  const roofed = new Set(mountsWith((p) => has(p, 'ROOF') && p.hp > 0).map(([a, b]) => `${a},${b}`));
  const isRoofed = (mx: number, my: number) => roofed.has(`${mx},${my}`);

  for (const k of v.mounts()) {
    const mx = Math.floor(k / 1024) - 512, my = (k % 1024) - 512;
    const parts = v.partsAt(mx, my);
    const x0 = mx - 0.5, x1 = mx + 0.5, z0 = my - 0.5, z1 = my + 0.5;
    const outer = DIRS.map(([dx, dy]) => !v.hasMount(mx + dx, my + dy));
    const find = (flag: string) => parts.find((p) => has(p, flag));
    const bloody = parts.reduce((a, p) => Math.max(a, p.blood), 0);
    const tintP = (c: number) => (bloody > 150 ? mix(c, 0x5a0808, Math.min(0.7, bloody / 600)) : c);
    const bodyPaint = (p?: VehiclePart) => tintP(p && p.hp <= 0 ? darken(paint, 0.45) : paint);
    body.sky = isRoofed(mx, my) ? INDOOR_SKY : 1;

    // Chassis / floor under every framed mount.
    const frame = parts.find((p) => p.def.location === 'structure' && !has(p, 'PROTRUSION'));
    if (frame) {
      box(body, chassis, x0, FLOOR, z0, x1, DECK - 0.02, z1, F.dark, F.floor);
    } else {
      // Protrusions (wing mirrors) hang off the body: a small block on the inner edge.
      const pr = parts.find((p) => has(p, 'PROTRUSION') && p.hp > 0);
      if (pr) {
        const inward = DIRS.findIndex(([dx, dy]) => v.hasMount(mx + dx, my + dy));
        const [dx, dy] = DIRS[Math.max(0, inward)];
        const cx = mx + dx * 0.4, cz = my + dy * 0.4;
        box(body, trim, cx - 0.1, 1.0, cz - 0.12, cx + 0.1, 1.22, cz + 0.12, F.dark);
      }
    }

    // Wheels: dark octagonal tyres sticking out of the side they're on.
    for (const w of parts.filter((p) => has(p, 'WHEEL'))) {
      const d = w.def.wheel?.diameter ?? 16;
      const r = Math.max(0.24, Math.min(0.7, (d * 0.0254) / 2 + 0.13));
      const width = Math.max(0.2, Math.min(0.45, ((w.def.wheel?.width ?? 8) * 0.0254) * 1.1));
      const out = outer[2] ? 1 : outer[3] ? -1 : 0;
      const zc = my + out * (0.5 - width / 2 + 0.06);
      wheel(body.get(w.hp > 0 ? 0x9a9a9a : 0x4a4040), mx, y(r), zc, r, width, F.tire, F.hub);
    }

    const board = find('FULL_BOARD'), half = find('HALF_BOARD'), door = find('OPENABLE'), shield = find('WINDSHIELD');
    const seat = find('SEAT') ?? find('BED'), cargo = find('CARGO');
    const obstacle = parts.find((p) => has(p, 'OBSTACLE') && !has(p, 'WHEEL'));

    if (board) {
      // Full-height panels on the outside edges (or a solid block if boxed in).
      const tint = bodyPaint(board);
      const top = board.hp > 0 ? ROOF_LO : BELT;
      let any = false;
      DIRS.forEach(([dx, dy], i) => {
        if (!outer[i]) return;
        any = true;
        edgePanel(body.get(tint), base, mx, my, dx, dy, FLOOR, top, PANEL, F.panel);
      });
      if (!any) box(body, tint, x0, FLOOR, z0, x1, top, z1, F.panel);
    } else if (door && has(door, 'DOOR')) {
      const tint = bodyPaint(door);
      const windowed = has(door, 'WINDOW');
      // Outer edge: the side facing away from the vehicle (rear for trunk doors).
      const i = outer.findIndex((o, j) => o && (j >= 2 || !outer[2] && !outer[3]));
      const [dx, dy] = i >= 0 ? DIRS[i] : DIRS[3];
      if (!door.open) {
        const g = body.get(tint);
        edgePanel(g, base, mx, my, dx, dy, FLOOR, BELT, PANEL, F.panel);
        if (windowed) {
          edgePanel(glass, base, mx, my, dx, dy, BELT, ROOF_LO, 0.05, F.light);
          pillars(body.get(trim), base, mx, my, dx, dy, BELT, ROOF_LO, F.dark);
        } else if (hasRoofNeighbour(v, mx, my, isRoofed)) edgePanel(g, base, mx, my, dx, dy, BELT, ROOF_LO, PANEL, F.panel);
      } else {
        // Swung open ~80 deg on its front hinge (trunk lids lift up instead).
        openDoor(body.get(tint), base, mx, my, dx, dy, F.panel);
        if (windowed && dy !== 0) pillars(body.get(trim), base, mx, my, dx, dy, BELT, ROOF_LO, F.dark);
      }
      // A roof strip over the doorway so the cabin roof reaches the car's sides.
      if (hasRoofNeighbour(v, mx, my, isRoofed) && !isRoofed(mx, my)) box(roof, paint, x0, ROOF_LO, z0, x1, ROOF_HI, z1, F.panel);
    } else if (shield) {
      // Cowl + dashboard, then the windscreen sloping up to the roof line.
      const tint = bodyPaint(shield);
      box(body, tint, x0, FLOOR, z0, x1, BELT - 0.08, z1, F.panel);
      if (shield.hp > 0) slantedGlass(glass, base, mx, my, F.light);
      if (outer[2] || outer[3]) aPillar(body.get(trim), base, mx, my, outer[2] ? 1 : -1, F.dark);
      box(body, 0x303034, x0 + 0.05, BELT - 0.08, z0, x0 + 0.35, BELT + 0.02, z1, F.dark);
    } else if (half) {
      // Hood, fenders, rear quarters: a solid body block to belt height.
      const tint = bodyPaint(half);
      box(body, tint, x0, FLOOR, z0, x1, BELT, z1, F.panel);
      if (outer[0]) box(body, 0x404044, x1 - 0.02, FLOOR + 0.12, z0 + 0.12, x1 + 0.02, FLOOR + 0.42, z1 - 0.12, F.grille);
      if (outer[1]) box(body, 0x404044, x0 - 0.02, FLOOR + 0.12, z0 + 0.05, x0 + 0.02, FLOOR + 0.3, z1 - 0.05, F.dark);
    } else if (obstacle) {
      // Anything else that blocks (rams, appliances, tanks on the deck): a coloured block.
      box(body, tintP(partColor(obstacle, 0x707070)), x0 + 0.05, FLOOR, z0 + 0.05, x1 - 0.05, obstacle.def.location === 'armor' ? 0.8 : 1.2, z1 - 0.05, F.panel);
    }

    if (seat) {
      const tint = tintP(partColor(seat, 0x6a3a30));
      const broken = seat.hp <= 0;
      box(body, tint, x0 + 0.12, DECK, z0 + 0.1, x1 - 0.12, DECK + 0.3, z1 - 0.1, F.fabric);
      if (!broken) box(body, tint, x0 + 0.08, DECK + 0.3, z0 + 0.12, x0 + 0.26, DECK + 0.95, z1 - 0.12, F.fabric);
      if (has(seat, 'BED')) box(body, tint, x0 + 0.26, DECK + 0.3, z0 + 0.1, x1 - 0.12, DECK + 0.4, z1 - 0.1, F.fabric);
    } else if (cargo && !board && !(door && has(door, 'DOOR')) && !shield && !half && !obstacle) {
      // Trunks and cargo beds: a low carpeted deck.
      box(body, tintP(0x6e6458), x0 + 0.02, DECK - 0.02, z0 + 0.02, x1 - 0.02, DECK + 0.04, z1 - 0.02, F.floor);
    }

    const ctrl = find('CONTROLS');
    if (ctrl) {
      // Steering wheel: a dark ring-ish slab in front of the driver.
      const g = body.get(0x222226);
      tiltedSlab(g, base, mx + 0.32, 1.12, my, 0.36, 0.05, F.dark);
      box(body, 0x333338, x1 - 0.1, DECK, my - 0.06, x1, 1.0, my + 0.06, F.dark);
    }

    for (const l of parts.filter((p) => has(p, 'CONE_LIGHT') || has(p, 'WIDE_CONE_LIGHT'))) {
      if (l.hp <= 0) continue;
      // Headlamps on the front face of the front row.
      const fx = outer[0] ? x1 + 0.01 : x1 - 0.2;
      lamps.box(fx - 0.04, y(0.72), my - 0.22, fx + 0.03, y(0.88), my + 0.22, 63, F.light, F.light, base);
    }
    const tail = !outer[0] && outer[1] && (half || (door && has(door, 'DOOR')) || board);
    if (tail && (outer[2] || outer[3])) {
      box(body, 0x8a1010, x0 - 0.03, 0.72, my - 0.18, x0 + 0.02, 0.88, my + 0.18, F.light);
    }

    if (isRoofed(mx, my)) box(roof, bodyPaint(parts.find((p) => has(p, 'ROOF'))), x0, ROOF_LO, z0, x1, ROOF_HI, z1, F.panel);
  }

  return {
    body: body.build(),
    roof: roof.build(),
    glass: glass.vertexCount ? glass.build() : null,
    lamps: lamps.vertexCount ? lamps.build() : null,
  };
}

function hasRoofNeighbour(v: Vehicle, mx: number, my: number, roofed: (x: number, y: number) => boolean): boolean {
  return DIRS.some(([dx, dy]) => roofed(mx + dx, my + dy));
}

/** A shell panel along one edge of a mount tile. dx/dy: outward direction in mount space. */
function edgePanel(g: GeomBuilder, base: number, mx: number, my: number, dx: number, dy: number, h0: number, h1: number, t: number, f: TileFrame): void {
  const x0 = mx - 0.5, x1 = mx + 0.5, z0 = my - 0.5, z1 = my + 0.5;
  if (dx === 1) g.box(x1 - t, base + h0, z0, x1, base + h1, z1, 63, f, f, base);
  else if (dx === -1) g.box(x0, base + h0, z0, x0 + t, base + h1, z1, 63, f, f, base);
  else if (dy === 1) g.box(x0, base + h0, z1 - t, x1, base + h1, z1, 63, f, f, base);
  else g.box(x0, base + h0, z0, x1, base + h1, z0 + t, 63, f, f, base);
}

/** Door/window pillars at both ends of a side edge. */
function pillars(g: GeomBuilder, base: number, mx: number, my: number, dx: number, dy: number, h0: number, h1: number, f: TileFrame): void {
  const w = 0.08;
  if (dy !== 0) {
    const z = dy > 0 ? my + 0.5 - PANEL : my - 0.5;
    g.box(mx - 0.5, base + h0, z, mx - 0.5 + w, base + h1, z + PANEL, 63, f, f, base);
    g.box(mx + 0.5 - w, base + h0, z, mx + 0.5, base + h1, z + PANEL, 63, f, f, base);
  } else {
    const x = dx > 0 ? mx + 0.5 - PANEL : mx - 0.5;
    g.box(x, base + h0, my - 0.5, x + PANEL, base + h1, my - 0.5 + w, 63, f, f, base);
    g.box(x, base + h0, my + 0.5 - w, x + PANEL, base + h1, my + 0.5, 63, f, f, base);
  }
}

/** The pillar between side window and windscreen. */
function aPillar(g: GeomBuilder, base: number, mx: number, my: number, side: number, f: TileFrame): void {
  const z = side > 0 ? my + 0.5 - 0.1 : my - 0.5;
  // stepped to follow the windscreen's slope: low at the front, full height at the back
  g.box(mx - 0.1, base + BELT - 0.1, z, mx + 0.1, base + (BELT + ROOF_LO) / 2, z + 0.1, 63, f, f, base);
  g.box(mx - 0.5, base + (BELT + ROOF_LO) / 2 - 0.05, z, mx - 0.1, base + ROOF_LO, z + 0.1, 63, f, f, base);
}

function openDoor(g: GeomBuilder, base: number, mx: number, my: number, dx: number, dy: number, f: TileFrame): void {
  if (dy !== 0) {
    // Hinged at the front edge, swung out sideways.
    const zEdge = dy > 0 ? my + 0.5 : my - 0.5;
    const za = Math.min(zEdge, zEdge + dy * 0.85), zb = Math.max(zEdge, zEdge + dy * 0.85);
    g.box(mx + 0.38, base + FLOOR, za, mx + 0.5, base + BELT, zb, 63, f, f, base);
  } else {
    // Trunk lid / tailgate: lifted up above the opening.
    const xEdge = dx > 0 ? mx + 0.5 : mx - 0.5;
    const xa = Math.min(xEdge, xEdge + dx * 0.5), xb = Math.max(xEdge, xEdge + dx * 0.5);
    g.box(xa, base + ROOF_LO - 0.05, my - 0.5, xb, base + ROOF_LO + 0.03, my + 0.5, 63, f, f, base);
  }
}

/** Windscreen: a quad sloping from the cowl (front) up to the roof line (rear edge). */
function slantedGlass(g: GeomBuilder, base: number, mx: number, my: number, f: TileFrame): void {
  const xf = mx + 0.3, xr = mx - 0.5, h0 = base + BELT - 0.08, h1 = base + ROOF_LO;
  const z0 = my - 0.5, z1 = my + 0.5;
  const nx = h1 - h0, ny = xf - xr, len = Math.hypot(nx, ny);
  const n: [number, number, number] = [nx / len, ny / len, 0];
  g.quad([xf, h0, z1], [xf, h0, z0], [xr, h1, z0], [xr, h1, z1], n, [0, 0, 1, 1], f);
  // back face so it's visible from the driver's seat too
  g.quad([xf, h0, z0], [xf, h0, z1], [xr, h1, z1], [xr, h1, z0], [-n[0], -n[1], 0], [0, 0, 1, 1], f);
}

/** A slab tilted toward the driver (steering wheel). */
function tiltedSlab(g: GeomBuilder, base: number, x: number, h: number, z: number, size: number, t: number, f: TileFrame): void {
  const s = size / 2, c = Math.cos(0.5), sn = Math.sin(0.5);
  const pt = (u: number, w: number, d: number): [number, number, number] => [x + d * c - u * sn, base + h + u * c + d * sn, z + w];
  const faces: [number, number][] = [[-t / 2, -1], [t / 2, 1]];
  for (const [d, sgn] of faces) {
    const a = pt(-s, -s, d), b = pt(-s, s, d), cc = pt(s, s, d), dd = pt(s, -s, d);
    const n: [number, number, number] = [sgn * c, sgn * sn, 0];
    if (sgn > 0) g.quad(a, b, cc, dd, n, [0, 0, 1, 1], f);
    else g.quad(dd, cc, b, a, n, [0, 0, 1, 1], f);
  }
}

/** Octagonal tyre prism around an axis along Z (the vehicle's width), hub caps both sides. */
function wheel(g: GeomBuilder, x: number, h: number, zc: number, r: number, width: number, tread: TileFrame, hub: TileFrame): void {
  const N = 8;
  const z0 = zc - width / 2, z1 = zc + width / 2;
  const pt = (i: number): [number, number] => {
    const a = (i / N) * Math.PI * 2 + Math.PI / N;
    return [x + Math.cos(a) * r, h + Math.sin(a) * r];
  };
  for (let i = 0; i < N; i++) {
    const [ax, ay] = pt(i), [bx, by] = pt(i + 1);
    const mid = ((i + 0.5) / N) * Math.PI * 2 + Math.PI / N;
    const n: [number, number, number] = [Math.cos(mid), Math.sin(mid), 0];
    g.quad([ax, ay, z1], [ax, ay, z0], [bx, by, z0], [bx, by, z1], n, [0, 0, 1, width], tread);
  }
  // Caps as triangle fans (degenerate quads). GeomBuilder UVs span the quad's rect, so
  // each wedge shows the whole (radially symmetric) hub swatch: reads as a rim + hub.
  for (const [z, sgn] of [[z1, 1], [z0, -1]] as const) {
    const c: [number, number, number] = [x, h, z];
    for (let i = 0; i < N; i++) {
      const [ax, ay] = pt(i), [bx, by] = pt(i + 1);
      const a: [number, number, number] = [ax, ay, z], b: [number, number, number] = [bx, by, z];
      if (sgn > 0) g.quad(c, a, b, b, [0, 0, 1], [0, 0, 1, 1], hub);
      else g.quad(c, b, a, a, [0, 0, -1], [0, 0, 1, 1], hub);
    }
  }
}

// --- scene management ------------------------------------------------------------------

interface Entry {
  obj: THREE.Group;
  body: THREE.Mesh | null;
  roof: THREE.Mesh | null;
  glass: THREE.Mesh | null;
  lamps: THREE.Mesh | null;
  version: number;
  z: number;
  /** Headlight beam: a few dynamic lights along the cone (they feed the tile light map). */
  beam: LightHandle[];
}

export class VehicleRenderer {
  readonly group = new THREE.Group();
  private entries = new Map<Vehicle, Entry>();
  private glassMat = new THREE.MeshLambertMaterial({ color: 0x9cc4d4, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide });
  private lampOn = new THREE.MeshBasicMaterial({ color: 0xfff2c8 });
  private lampOff = new THREE.MeshBasicMaterial({ color: 0x8a8a80 });
  /** One shadowless spot for the nearest vehicle with its headlights on. */
  readonly headlight = new THREE.SpotLight(0xfff0d4, 0, 50, 0.5, 0.45, 1.0);

  constructor(private renderer: Renderer, private game: Game, private system: VehicleSystem) {
    this.group.name = 'vehicles';
    patchNormalOutput(this.glassMat, false);
    patchNormalOutput(this.lampOn, false);
    patchNormalOutput(this.lampOff, false);
    this.headlight.castShadow = false;
    renderer.scene.add(this.group, this.headlight, this.headlight.target);
    system.onRemoved.push((v) => this.drop(v));
    renderer.beforeRender.push(() => this.update());
  }

  private drop(v: Vehicle): void {
    const e = this.entries.get(v);
    if (!e) return;
    this.group.remove(e.obj);
    for (const m of [e.body, e.roof, e.glass, e.lamps]) m?.geometry.dispose();
    for (const l of e.beam) l.remove();
    this.entries.delete(v);
  }

  private build(v: Vehicle, e: Entry | undefined): Entry {
    if (e) {
      this.group.remove(e.obj);
      for (const m of [e.body, e.roof, e.glass, e.lamps]) m?.geometry.dispose();
    }
    const base = v.z * LEVEL_HEIGHT;
    const g = buildVehicleGeometry(v, base);
    const { tex } = swatchPage();
    const { mat, depth } = worldMaterials(tex);
    const obj = new THREE.Group();
    obj.name = `vehicle:${v.protoId}`;
    const mk = (geo: THREE.BufferGeometry | null, m: THREE.Material, shadow: boolean) => {
      if (!geo) return null;
      const mesh = new THREE.Mesh(geo, m);
      if (shadow) {
        mesh.customDepthMaterial = depth;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
      obj.add(mesh);
      return mesh;
    };
    const next: Entry = {
      obj,
      body: mk(g.body, mat, true),
      roof: mk(g.roof, mat, true),
      glass: mk(g.glass, this.glassMat, false),
      lamps: mk(g.lamps, v.lightsOn ? this.lampOn : this.lampOff, false),
      version: v.version,
      z: v.z,
      beam: e?.beam ?? [],
    };
    this.group.add(obj);
    return next;
  }

  update(): void {
    const p = this.game.player;
    const top = this.renderer.cameraMode === 'top';
    const rig = this.renderer.rig as unknown as { suppressBob?: boolean };
    rig.suppressBob = !!this.system.driving;
    this.renderer.handsBusy = !!this.system.driving;
    let spotFor: Vehicle | null = null, spotD = Infinity;
    const seen = new Set<Vehicle>();
    for (const v of this.system.list) {
      const d = Math.hypot(v.x - p.x, v.y - p.y);
      if (d > VIEW_RANGE || Math.abs(v.z - p.z) > 1) {
        if (this.entries.has(v)) this.drop(v);
        continue;
      }
      seen.add(v);
      let e = this.entries.get(v);
      if (!e || e.version !== v.version || e.z !== v.z) {
        e = this.build(v, e);
        this.entries.set(v, e);
      }
      e.obj.position.set(v.x, 0, v.y);
      e.obj.rotation.y = (-v.facing * Math.PI) / 180;
      // Top-down hides roofs (and anything above your level) so you can see inside.
      if (e.roof) e.roof.visible = !top || v.z < p.z;
      if (e.lamps) e.lamps.material = v.lightsOn ? this.lampOn : this.lampOff;
      const lit = v.lightsOn && v.withFlag('CONE_LIGHT', true).length > 0;
      if (lit) {
        const pri = this.system.driving === v ? -1 : d;
        if (pri < spotD) {
          spotD = pri;
          spotFor = v;
        }
      }
      // The light map only knows round sources, so a headlight cone is approximated by
      // lights stepping out along the beam, dimmer and wider with distance.
      if (lit && !e.beam.length) {
        e.beam = BEAM.map(([, intensity, radius]) => this.renderer.lights.add({ x: v.x, y: v.y, z: v.z, color: 0xfff0d0, intensity, radius, height: 0.5 }));
      } else if (!lit && e.beam.length) {
        for (const l of e.beam) l.remove();
        e.beam = [];
      }
      e.beam.forEach((l, i) => {
        const [fx, fy] = this.front(v, BEAM[i][0]);
        l.set(fx, fy, v.z);
      });
    }
    for (const v of [...this.entries.keys()]) if (!seen.has(v)) this.drop(v);

    const s = this.headlight;
    if (spotFor) {
      const v = spotFor;
      const [fx, fy] = this.front(v, 0.6);
      const [tx, ty] = this.front(v, 18);
      const h = v.z * LEVEL_HEIGHT;
      s.position.set(fx, h + 0.85, fy);
      s.target.position.set(tx, h - 0.6, ty);
      s.target.updateMatrixWorld();
      s.intensity = 60;
    } else s.intensity = 0;
  }

  /** World point `ahead` metres in front of the vehicle's front row. */
  private front(v: Vehicle, ahead: number): [number, number] {
    const [, , x1] = v.bounds();
    return v.mountToWorld(x1 + 0.5 + ahead, (v.bounds()[1] + v.bounds()[3]) / 2);
  }
}
