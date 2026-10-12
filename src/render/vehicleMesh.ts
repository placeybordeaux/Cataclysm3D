import * as THREE from 'three';
import type { Game } from '../game/game';
import { has, type Vehicle, type VehiclePart } from '../game/vehicle';
import type { VehicleSystem } from '../game/vehicles';
import type { Station, StationView } from '../game/vehwalk';
import { LEVEL_HEIGHT } from '../world/coords';
import { hasFlag } from '../world/registry';
import { setupPixelTexture } from './atlas';
import { INDOOR_SKY } from './chunkMesh';
import { cddaColor } from './colors';
import { GeomBuilder } from './geometry';
import type { LightHandle } from './lights';
import { headingFromFacing, eyeHeightFor, type DriveView } from './driveCamera';
import { patchNormalOutput, vehicleBodyMaterials, worldMaterials } from './materials';
import type { Renderer } from './renderer';
import type { TileFrame } from './textureSource';
import { Batches, hash, partSwatchPage } from './vehicleGeom';
import { buildVehicleModel } from './vehicleModel';
import { pointInBody } from '../game/vehicleShape';
import { Cockpit, type HandColors } from './vehicleCockpit';
import { makeWheelHands } from './vehicleHands';
import { AtlasTextureSource } from './atlasSource';
import { charLayers, charSettings, spriteInfo } from './chars/index';
import { CRANK_M_PER_TURN, genericAnchors, riderSlot, stationAnchors, type RideAnchors } from './vehicleRider';
import type { V3 } from './geometry';
import { bodyRectFor, setVehicleWidth, vehicleWidth, type VehicleWidth } from './vehicleLayout';
import { noseX } from '../game/chassis';
import { liveryBody } from './vehicleSkin';
import { createHeadlight, HEADLIGHT_SPOTS, pickHeadlightSpots, prepareHeadlightShadow } from './headlightShadow';
import type { TurretBuild } from './vehicleTank';
import { hullYaw, turretAim, turretHooks } from '../game/turret';

/** Standing eye above the floor at a deck station (the on-foot camera's EYE). */
const STAND_EYE = 1.6;

// 3D meshes for vehicles, built from their parts mount by mount, as low-poly boxes wearing
// small procedural pixel-art swatches (UltiCa's vp_* sprites are 3/4-view drawings for a
// top-down grid, so like walls they don't suit box faces). Materials are the world
// material from materials.ts, so vehicles get the same banded lighting, shadows, outlines
// and palette grading as the chunk geometry; body colour comes from per-vertex tint.
//
// Each vehicle is an Object3D (body, roof, glass, lamps) placed every frame from the
// vehicle's continuous position and facing; geometry is rebuilt when vehicle.version
// changes (doors, damage, lights). Roofs hide in top-down view so you can see inside,
// like CDDA's map. Headlights: HEADLIGHT_SPOTS shadowed SpotLights, the car you drive first and
// then the nearest lit ones (the light count is fixed at startup so shaders never recompile)
// + pool point lights.
//
// Local frame: three.js X = mount x (forward), Z = mount y (right side), Y = metres above
// z = 0 (absolute, so the renderer's top-down wall cut compares heights correctly).

const FLOOR = 0.32; // underside of the body
const DECK = 0.45; // interior floor / seat base
const BELT = 1.02; // top of doors, hood, fenders
const ROOF_LO = 1.8;
const ROOF_HI = 1.9;
const PANEL = 0.14; // thickness of door/board shells
// The cockpit view is built around the driver's eye (driveCamera.ts eyeHeightFor, ~1.2 m in a
// car, EYE_FORWARD ahead of the seat's centre): a low cowl/dash under the windscreen and a
// bonnet that slopes down to the nose keep the car to a thin band at the bottom of the view.
const COWL = 0.9; // top of the dash/cowl under the windscreen
const HOOD_REAR = 0.9; // bonnet height at the windscreen
const HOOD_FRONT = 0.7; // ...and at the nose
export const EYE_FORWARD = 0.15;
const VIEW_RANGE = 90;
/**
 * Headlight beam lights: [metres ahead of the bumper, intensity, radius]. They reach ~35 m:
 * stopping from 30 mph takes ~12 m plus ~13 m of reaction, so obstacles at a safe night speed
 * show up before they matter (the old 3-light beam ended ~15 m out).
 */
const BEAM: [number, number, number][] = [[3, 1.1, 7], [10, 1.0, 9], [19, 0.9, 10], [29, 0.75, 10]];

// --- procedural swatches ---------------------------------------------------------------

type Swatch = 'panel' | 'panelTop' | 'dark' | 'tire' | 'fabric' | 'light' | 'floor' | 'hub' | 'grille';
const SWATCHES: Swatch[] = ['panel', 'panelTop', 'dark', 'tire', 'fabric', 'light', 'floor', 'hub', 'grille'];
const SW = 32;

/** Grey-scale pixel art (tinted per vertex), one 32x32 swatch per surface kind. */
function paintSwatch(kind: Swatch, px: (x: number, y: number, v: number) => void): void {
  for (let y = 0; y < SW; y++)
    for (let x = 0; x < SW; x++) {
      const n = hash(x, y, SWATCHES.indexOf(kind));
      let v = 200;
      switch (kind) {
        case 'panel':
          // Painted metal, sides: mid-tone (the paint tint multiplies it; at the old near-white
          // value a sunlit car read as a flat white slab), a seam every half metre, a soft
          // highlight band.
          v = 170 + (n < 0.06 ? -8 : 0) + (y === 0 || x === 0 ? -30 : 0) + (y === 16 ? -16 : 0) + (y > 3 && y < 7 ? 10 : 0);
          break;
        case 'panelTop':
          // Bonnet / roof / boot tops get the full sky and sun, so they're painted darker, with
          // a faint diagonal sheen so a flat top still reads as a glossy panel, not a plane.
          v = 132 + (n < 0.05 ? -6 : 0) + (x === 0 || y === 0 ? -24 : 0) + (Math.abs(((x + y) % 32) - 12) < 2 ? 14 : 0);
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
  // Bonnet: half-board rows ahead of the windscreen slope from HOOD_REAR down to HOOD_FRONT.
  const shieldRows = mountsWith((p) => has(p, 'WINDSHIELD')).map(([a]) => a);
  const shieldX = shieldRows.length ? Math.max(...shieldRows) : Infinity;
  const noseX = v.bounds()[2] + 0.5;
  const hoodAt = (x: number) => HOOD_REAR + ((HOOD_FRONT - HOOD_REAR) * (x - (shieldX + 0.5))) / Math.max(0.5, noseX - (shieldX + 0.5));
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
      // BN wheel sizes are in cm (a car wheel: 42.5 x 22.5, i.e. a 17" rim); the tyre adds
      // ~10 cm of sidewall. (Read as inches, car tyres came out 1.4 m tall and stuck up
      // through the bonnet into the driver's view.)
      const d = w.def.wheel?.diameter ?? 40;
      const r = Math.max(0.2, Math.min(0.7, d / 200 + 0.1));
      const width = Math.max(0.15, Math.min(0.45, ((w.def.wheel?.width ?? 20) / 100) * 1.1));
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
      if (hasRoofNeighbour(v, mx, my, isRoofed) && !isRoofed(mx, my)) box(roof, paint, x0, ROOF_LO, z0, x1, ROOF_HI, z1, F.panel, F.panelTop);
    } else if (shield) {
      // Cowl + a thin dark dash top, then the windscreen sloping up to the roof line. The cowl
      // top is dark (it's the dashboard seen through the glass) so it frames the road instead
      // of glaring.
      const tint = bodyPaint(shield);
      body.get(tint).box(x0, y(FLOOR), z0, x1, y(COWL - 0.02), z1, 63 & ~4, F.panel, F.panelTop, base);
      box(body, 0x26262a, x0, COWL - 0.02, z0, x1, COWL, z1, F.dark);
      if (shield.hp > 0) slantedGlass(glass, base, mx, my, F.light);
      if (outer[2] || outer[3]) aPillar(body.get(trim), base, mx, my, outer[2] ? 1 : -1, F.dark);
      box(body, 0x303034, x0 + 0.05, COWL, z0 + 0.05, x0 + 0.3, COWL + 0.03, z1 - 0.05, F.dark);
    } else if (half && mx > shieldX) {
      // Bonnet and front wings: sloping down to the nose.
      const tint = bodyPaint(half);
      wedge(body.get(tint), base, x0, x1, z0, z1, FLOOR, hoodAt(x0), hoodAt(x1), F.panel, F.panelTop);
      if (outer[0]) box(body, 0x404044, x1 - 0.02, FLOOR + 0.12, z0 + 0.12, x1 + 0.02, FLOOR + 0.42, z1 - 0.12, F.grille);
    } else if (half) {
      // Rear quarters (and bonnets of cars without a windscreen): a body block to belt height.
      const tint = bodyPaint(half);
      box(body, tint, x0, FLOOR, z0, x1, BELT, z1, F.panel, F.panelTop);
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
      // Steering wheel: a dark ring-ish slab ahead of and below the driver's eye, so from the
      // seat only its top rim peeks up at the bottom of the view.
      const g = body.get(0x222226);
      tiltedSlab(g, base, mx + 0.45, 0.92, my, 0.34, 0.05, F.dark);
      box(body, 0x333338, x1 - 0.08, DECK, my - 0.05, x1, 0.86, my + 0.05, F.dark);
    }

    for (const l of parts.filter((p) => has(p, 'CONE_LIGHT') || has(p, 'WIDE_CONE_LIGHT'))) {
      if (l.hp <= 0) continue;
      // Headlamps on the front face of the front row.
      const fx = outer[0] ? x1 + 0.01 : x1 - 0.2;
      // Below the bonnet line, which drops to HOOD_FRONT at the nose.
      lamps.box(fx - 0.04, y(0.5), my - 0.22, fx + 0.03, y(0.64), my + 0.22, 63, F.light, F.light, base);
    }
    const tail = !outer[0] && outer[1] && (half || (door && has(door, 'DOOR')) || board);
    if (tail && (outer[2] || outer[3])) {
      box(body, 0x8a1010, x0 - 0.03, 0.72, my - 0.18, x0 + 0.02, 0.88, my + 0.18, F.light);
    }

    if (isRoofed(mx, my)) box(roof, bodyPaint(parts.find((p) => has(p, 'ROOF'))), x0, ROOF_LO, z0, x1, ROOF_HI, z1, F.panel, F.panelTop);
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
  // Thin (6 cm) so it frames the windscreen from the driver's seat instead of hiding the road.
  const w = 0.06;
  const z = side > 0 ? my + 0.5 - w : my - 0.5;
  // stepped to follow the windscreen's slope: low at the front, full height at the back
  g.box(mx - 0.05, base + COWL - 0.05, z, mx + 0.25, base + (COWL + ROOF_LO) / 2, z + w, 63, f, f, base);
  g.box(mx - 0.5, base + (COWL + ROOF_LO) / 2 - 0.05, z, mx - 0.05, base + ROOF_LO, z + w, 63, f, f, base);
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
  const xf = mx + 0.3, xr = mx - 0.5, h0 = base + COWL, h1 = base + ROOF_LO;
  const z0 = my - 0.5, z1 = my + 0.5;
  const nx = h1 - h0, ny = xf - xr, len = Math.hypot(nx, ny);
  const n: [number, number, number] = [nx / len, ny / len, 0];
  g.quad([xf, h0, z1], [xf, h0, z0], [xr, h1, z0], [xr, h1, z1], n, [0, 0, 1, 1], f);
  // back face so it's visible from the driver's seat too
  g.quad([xf, h0, z0], [xf, h0, z1], [xr, h1, z1], [xr, h1, z0], [-n[0], -n[1], 0], [0, 0, 1, 1], f);
}

/**
 * A body block whose top slopes along x from height `hr` (at x0) to `hf` (at x1): the bonnet.
 * Sides are trapezoids; the top's normal tilts forward so it shades like a curved panel.
 */
function wedge(g: GeomBuilder, base: number, x0: number, x1: number, z0: number, z1: number, h0: number, hr: number, hf: number, side: TileFrame, top: TileFrame): void {
  const y0 = base + h0, yr = base + hr, yf = base + hf;
  const dx = x1 - x0, nlen = Math.hypot(hr - hf, dx);
  const nTop: [number, number, number] = [(hr - hf) / nlen, dx / nlen, 0];
  g.quad([x0, yr, z1], [x1, yf, z1], [x1, yf, z0], [x0, yr, z0], nTop, [x0, -z1, x1, -z0], top);
  g.quad([x1, y0, z1], [x1, y0, z0], [x1, yf, z0], [x1, yf, z1], [1, 0, 0], [-z1, h0, -z0, hf], side);
  g.quad([x0, y0, z0], [x0, y0, z1], [x0, yr, z1], [x0, yr, z0], [-1, 0, 0], [z0, h0, z1, hr], side);
  g.quad([x0, y0, z1], [x1, y0, z1], [x1, yf, z1], [x0, yr, z1], [0, 0, 1], [x0, h0, x1, Math.max(hr, hf)], side);
  g.quad([x1, y0, z0], [x0, y0, z0], [x0, yr, z0], [x1, yf, z0], [0, 0, -1], [-x1, h0, -x0, Math.max(hr, hf)], side);
  g.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], [x0, z0, x1, z1], side);
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

/**
 * Which vehicle renderer draws the world's vehicles: 'model' (vehicleModel.ts: cohesive
 * low-poly bodies, the default) or 'parts' (this file: one box per part, the v2 look).
 * `?vehicles=parts|model`, Options -> Vehicle look, `cdda.vehicleLook()`.
 */
export type VehicleLook = 'model' | 'parts';
export const VEHICLE_LOOKS: VehicleLook[] = ['model', 'parts'];
const LOOK_KEY = 'cdda3d.vehicleLook';

const WIDTH_KEY = 'cdda3d.vehicleWidth';

export function initialVehicleWidth(): VehicleWidth {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('vehiclewidth') : null;
  if (q) {
    if (q !== 'real' && q !== 'fill') throw new Error(`?vehiclewidth= must be real or fill, got "${q}"`);
    return q;
  }
  try {
    const s = localStorage.getItem(WIDTH_KEY);
    if (s === 'real' || s === 'fill') return s;
  } catch {
    // no storage
  }
  return 'real';
}

export function initialVehicleLook(): VehicleLook {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('vehicles') : null;
  if (q) {
    if (q !== 'model' && q !== 'parts') throw new Error(`?vehicles= must be model or parts, got "${q}"`);
    return q;
  }
  try {
    const s = localStorage.getItem(LOOK_KEY);
    if (s === 'model' || s === 'parts') return s;
  } catch {
    // no storage
  }
  return 'model';
}

interface Skin {
  key: string;
  tex: THREE.DataTexture;
  mat: THREE.MeshLambertMaterial;
  depth: THREE.MeshDepthMaterial;
}

interface Entry {
  /** Placed at the vehicle's position / facing every frame. */
  obj: THREE.Group;
  /** Lean pivot (bikes on their stand); holds the meshes. */
  lean: THREE.Group;
  meshes: THREE.Mesh[];
  roof: THREE.Mesh | null;
  lamps: THREE.Mesh | null;
  tails: THREE.Mesh | null;
  beacons: THREE.Mesh | null;
  skin: Skin | null;
  /** Meshes drawn with the skin (body, roof): they swap from the placeholder when it lands. */
  skinMeshes: THREE.Mesh[];
  /** Skin being painted by the worker. */
  pending: { id: number; key: string } | null;
  /** Built for the driven vehicle: separate wheel meshes that steer and spin. */
  driven: boolean;
  /** Driven vehicle: wheel, hands, dials, windscreen film (vehicleCockpit.ts). */
  cockpit: Cockpit | null;
  /** Model look: roof height above the floor level (m), null without a roof. */
  roofY: number | null;
  /** Model look: the floor you stand on inside (cabin floor, a hull's deck) and a turret's
   *  roof, above the floor level (m); null when the build doesn't say (station eyes, vehwalk). */
  deckY: number | null;
  turretTop: number | null;
  turretFoot: { x: number; z: number; r: number } | null;
  /** Built at the distance LOD (no interior, no shadow casting). */
  far: boolean;
  wheels: { mesh: THREE.Mesh; r: number; steer: boolean; spin: number }[];
  bike: boolean;
  version: number;
  z: number;
  look: VehicleLook;
  /** Model look: driver eye above the floor level and lateral seat position (mount y units). */
  eyeH: number | null;
  driverZ: number | null;
  driverX: number | null;
  eyeX: number | null;
  parkedLean: number;
  /** Headlight beam: a few dynamic lights along the cone (they feed the tile light map). */
  beam: LightHandle[];
  /** Where the driver's body sits (model look; vehicleRider.ts), null = generic seat. */
  ride: RideAnchors | null;
  /** Ridden bicycle: the crank mesh, the crank angle ridden and the angle shown (stepped). */
  crank: THREE.Mesh | null;
  pedal: number;
  pedalShown: number;
  pedalTick: number;
  /** Mount space of the meshes (child of the lean pivot): the rider's frame. */
  pivot: THREE.Group;
  /** Model look: the glass seen from outside (lighter while your body sits behind it). */
  glassOut: THREE.Mesh | null;
  /** Armoured hulls: the turret, gun and MG pieces that traverse and elevate (src/game/turret.ts aims them). */
  turrets: TurretView[];
}

/** A built turret's moving pieces (vehicleTank.ts TurretBuild): yaw on the ring, pitch on the trunnion / pintle. */
interface TurretView {
  part: VehiclePart | null;
  /** The turret body, turned about +Y (null geometry = hull MGs only, the group is the hull frame). */
  group: THREE.Group;
  hasTurret: boolean;
  gun: { group: THREE.Group; mesh: THREE.Mesh | null; len: number } | null;
  mgs: { part: VehiclePart; group: THREE.Group; mesh: THREE.Mesh | null; len: number; onTurret: boolean }[];
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** How far (m) a barrel runs back after a shot, `t` s ago: slammed back, then eased home. */
function barrelRecoil(t: number, travel: number): number {
  if (!Number.isFinite(t) || t < 0) return 0;
  if (t < 0.04) return (travel * t) / 0.04;
  return travel * Math.exp(-(t - 0.04) * 6);
}

/** Distance LOD thresholds (m): simplified beyond LOD_FAR, detailed again inside LOD_NEAR. */
const LOD_FAR = 50, LOD_NEAR = 42;

/** Model builds allowed per frame (ms) once one has been built: spreads pop-in over frames. */
const BUILD_BUDGET_MS = 4;

export class VehicleRenderer {
  readonly group = new THREE.Group();
  private entries = new Map<Vehicle, Entry>();
  // Faint tint: at 0.32 opacity the windscreen hazed the whole cockpit view grey.
  private glassMat = new THREE.MeshLambertMaterial({ color: 0x7ea4b8, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide });
  // Model glass: tinted from outside (reads as glass on a car in daylight), nearly clear from
  // inside so the cockpit view isn't hazed.
  private glassOut = new THREE.MeshLambertMaterial({ color: 0x34424e, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.FrontSide });
  private glassIn = new THREE.MeshLambertMaterial({ color: 0x9ab4c4, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.BackSide });
  // With your body at the wheel (chase / top-down cameras) the driven car's glass is tinted
  // less, so you can see yourself driving through it.
  private glassOutRider = new THREE.MeshLambertMaterial({ color: 0x3a4a56, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.FrontSide });
  private lampOn = new THREE.MeshBasicMaterial({ color: 0xfff2c8 });
  private lampOff = new THREE.MeshBasicMaterial({ color: 0x8a8a80 });
  private tailOn = new THREE.MeshBasicMaterial({ color: 0xff3020 });
  private tailOff = new THREE.MeshBasicMaterial({ color: 0x5a1410 });
  private beaconMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  /** Shadowed headlight spots (headlightShadow.ts pickHeadlightSpots says which cars get them). */
  // Range must stay over materials.ts HEADLIGHT_MIN_RANGE (that's what gives it the road
  // wrap); decay 0.5 keeps the road ~30 m out within a few bands of the road at the bumper.
  readonly headlights: readonly THREE.SpotLight[] = Array.from({ length: HEADLIGHT_SPOTS }, createHeadlight);
  /** Spot intensity: the road reads ~35 m ahead at night. */
  headlightIntensity = 45;
  private lookMode: VehicleLook = initialVehicleLook();
  /** Skin painter worker (undefined = not tried yet, null = unavailable: paint inline). */
  private worker: Worker | null | undefined;
  private jobId = 0;
  /** Flat paint-coloured body materials shown until a vehicle's skin arrives. */
  private placeholders = new Map<number, { tex: THREE.DataTexture; mat: THREE.MeshLambertMaterial; depth: THREE.MeshDepthMaterial }>();
  /** Mesh build timings (both looks), for the bench tools: `cdda.renderer.vehicleView.buildStats`. */
  readonly buildStats = { n: 0, totalMs: 0, maxMs: 0 };

  constructor(private renderer: Renderer, private game: Game, private system: VehicleSystem) {
    this.group.name = 'vehicles';
    setVehicleWidth(initialVehicleWidth());
    // Creatures collide with the drawn body, not the whole grid tiles (vehicleShape.ts).
    system.bodyShape = (v) => (this.lookMode === 'model' ? bodyRectFor(v) : null);
    for (const m of [this.glassMat, this.glassOut, this.glassOutRider, this.glassIn, this.lampOn, this.lampOff, this.tailOn, this.tailOff, this.beaconMat]) patchNormalOutput(m, false);
    renderer.scene.add(this.group, ...this.headlights.flatMap((s) => [s, s.target]));
    renderer.vehicleView = this;
    // Turret shots leave the drawn muzzle (src/game/turret.ts muzzleOf falls back to an estimate).
    turretHooks.muzzle = (v, part) => this.muzzleOf(v, part);
    system.onRemoved.push((v) => this.drop(v));
    renderer.beforeRender.push((dt) => this.update(dt));
    // The character layers flush in their own beforeRender step: make sure it comes after
    // ours, so the rider placed at the end of update() is drawn in this frame's seat.
    charLayers(renderer);
  }

  get look(): VehicleLook {
    return this.lookMode;
  }
  /** Body width mode (vehicleLayout.ts VehicleWidth); every vehicle rebuilds. */
  get width(): VehicleWidth {
    return vehicleWidth();
  }
  set width(w: VehicleWidth) {
    setVehicleWidth(w);
    try {
      localStorage.setItem(WIDTH_KEY, w);
    } catch {
      // not persisted
    }
    for (const v of [...this.entries.keys()]) this.drop(v);
    this.system.shapeEpoch++;
  }
  /** Switch renderer; every vehicle rebuilds on the next frame. */
  set look(l: VehicleLook) {
    if (!VEHICLE_LOOKS.includes(l)) throw new Error(`unknown vehicle look ${l}`);
    this.lookMode = l;
    try {
      localStorage.setItem(LOOK_KEY, l);
    } catch {
      // not persisted
    }
    for (const v of [...this.entries.keys()]) this.drop(v);
    this.system.shapeEpoch++;
  }

  private skinWorker(): Worker | null {
    if (this.worker !== undefined) return this.worker;
    try {
      this.worker = new Worker(new URL('./vehicleSkinWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<{ id: number; width: number; height: number; data: Uint8Array }>) => this.skinArrived(ev.data);
      this.worker.onerror = (err) => {
        // Fail loudly, then keep working: skins get painted inline from here on.
        console.error('[vehicles] skin worker failed; painting on the main thread', err);
        this.worker?.terminate();
        this.worker = null;
        for (const e of this.entries.values()) e.pending = null;
        for (const v of this.entries.keys()) v.version++;
      };
    } catch (err) {
      console.error('[vehicles] no skin worker; painting on the main thread', err);
      this.worker = null;
    }
    return this.worker;
  }

  private skinArrived(msg: { id: number; width: number; height: number; data: Uint8Array }): void {
    for (const e of this.entries.values()) {
      if (e.pending?.id !== msg.id) continue;
      const skin = this.makeSkin(e.pending.key, msg.data, msg.width, msg.height);
      e.pending = null;
      e.skin = skin;
      for (const m of e.skinMeshes) {
        m.material = skin.mat;
        m.customDepthMaterial = skin.depth;
      }
      return;
    }
    // the vehicle was rebuilt or left view meanwhile: nothing to do
  }

  private makeSkin(key: string, data: Uint8Array, w: number, h: number): Skin {
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    setupPixelTexture(tex);
    const { mat, depth } = vehicleBodyMaterials(tex);
    return { key, tex, mat, depth };
  }

  private placeholder(color: number): { mat: THREE.MeshLambertMaterial; depth: THREE.MeshDepthMaterial } {
    let p = this.placeholders.get(color);
    if (!p) {
      const tex = new THREE.DataTexture(new Uint8Array([(color >> 16) & 255, (color >> 8) & 255, color & 255, 255]), 1, 1, THREE.RGBAFormat);
      setupPixelTexture(tex);
      p = { tex, ...vehicleBodyMaterials(tex) };
      this.placeholders.set(color, p);
    }
    return p;
  }

  private disposeMeshes(e: Entry, keepSkin: Skin | null): void {
    this.group.remove(e.obj);
    for (const m of e.meshes) m.geometry.dispose();
    e.cockpit?.dispose();
    if (e.skin && e.skin !== keepSkin) {
      e.skin.tex.dispose();
      e.skin.mat.dispose();
      e.skin.depth.dispose();
    }
  }

  private drop(v: Vehicle): void {
    const e = this.entries.get(v);
    if (!e) return;
    this.disposeMeshes(e, null);
    for (const l of e.beam) l.remove();
    this.entries.delete(v);
  }

  private build(v: Vehicle, e: Entry | undefined, far = false): Entry {
    const base = v.z * LEVEL_HEIGHT;
    const obj = new THREE.Group();
    obj.name = `vehicle:${v.protoId}`;
    const lean = new THREE.Group();
    const pivot = new THREE.Group();
    lean.add(pivot);
    obj.add(lean);
    const meshes: THREE.Mesh[] = [];
    const mk = (geo: THREE.BufferGeometry | null, m: THREE.Material, shadow: THREE.MeshDepthMaterial | null) => {
      if (!geo) return null;
      const mesh = new THREE.Mesh(geo, m);
      if (shadow) {
        mesh.customDepthMaterial = shadow;
        mesh.castShadow = !far;
        mesh.receiveShadow = true;
      }
      pivot.add(mesh);
      meshes.push(mesh);
      return mesh;
    };
    const next: Entry = {
      obj, lean, meshes, roof: null, lamps: null, tails: null, beacons: null, skin: null, skinMeshes: [], pending: null,
      driven: v === this.system.driving, wheels: [], bike: false, far, roofY: null, deckY: null, turretTop: null, turretFoot: null, cockpit: null,
      version: v.version, z: v.z, look: this.lookMode, eyeH: null, driverZ: null, driverX: null, eyeX: null, parkedLean: 0, beam: e?.beam ?? [],
      ride: null, crank: null, pedal: e?.pedal ?? 0, pedalShown: e?.pedalShown ?? 0, pedalTick: 0, pivot, glassOut: null, turrets: [],
    };
    const t0 = performance.now();
    const worker = this.lookMode === 'model' ? this.skinWorker() : null;
    // A skin already painted (or being painted) for the same content is kept.
    const haveKey = e?.skin?.key ?? e?.pending?.key;
    const model = this.lookMode === 'model' ? buildVehicleModel(v, base, { reuseSkinKey: haveKey, deferSkin: !!worker, separateWheels: next.driven, far }) : null;
    if (model) {
      let skin: Skin | null = e?.skin && e.skin.key === model.skinKey ? e.skin : null;
      if (!skin && model.skin) skin = this.makeSkin(model.skinKey, model.skin.data, model.skin.layout.width, model.skin.layout.height);
      if (!skin && e?.pending && e.pending.key === model.skinKey) next.pending = e.pending;
      if (!skin && model.skinJob && worker) {
        next.pending = { id: ++this.jobId, key: model.skinKey };
        worker.postMessage({ id: next.pending.id, ...model.skinJob });
      }
      if (e) this.disposeMeshes(e, skin);
      next.skin = skin;
      const parts = worldMaterials(partSwatchPage().tex);
      const bodyMat = model.bodyUsesParts ? parts : skin ?? this.placeholder(liveryBody(model.layout, v.paint));
      const b = mk(model.body, bodyMat.mat, bodyMat.depth);
      next.roof = mk(model.roof, bodyMat.mat, bodyMat.depth);
      next.skinMeshes = model.bodyUsesParts ? [] : [b, next.roof].filter((m): m is THREE.Mesh => !!m);
      mk(model.parts, parts.mat, parts.depth);
      for (const t of model.turrets ?? []) next.turrets.push(this.turretView(t, pivot, meshes, parts.mat, parts.depth, far));
      if (model.glass) {
        next.glassOut = mk(model.glass, this.glassOut, null);
        mk(model.glass, this.glassIn, null);
      }
      next.lamps = mk(model.lamps, v.lightsOn ? this.lampOn : this.lampOff, null);
      next.tails = mk(model.tails, v.lightsOn ? this.tailOn : this.tailOff, null);
      next.beacons = mk(model.beacons, this.beaconMat, null);
      for (const w of model.wheels ?? []) {
        const mesh = mk(w.geo, parts.mat, parts.depth)!;
        mesh.position.set(w.x, w.y, w.z);
        next.wheels.push({ mesh, r: w.r, steer: w.steer, spin: 0 });
      }
      if (model.crank) {
        next.crank = mk(model.crank.geo, parts.mat, parts.depth)!;
        next.crank.position.set(model.crank.x, model.crank.y, model.crank.z);
        next.crank.rotation.z = next.pedalShown;
      }
      next.ride = model.ride ?? null;
      next.bike = model.layout.style === 'motorcycle' || model.layout.style === 'bicycle';
      if (model.cockpit) {
        next.cockpit = new Cockpit(model.cockpit, parts.mat, this.handColors(), makeWheelHands(this.game, this.renderer));
        pivot.add(next.cockpit.group);
      }
      next.eyeH = model.eyeH;
      next.roofY = model.layout.cabin && model.body ? model.layout.p.roof : null;
      next.deckY = model.deckY ?? null;
      next.turretTop = model.turretTop ?? null;
      next.turretFoot = model.turretFoot ?? null;
      next.driverX = model.driverX ?? null;
      next.eyeX = model.eyeX ?? null;
      next.driverZ = model.driverZ;
      next.parkedLean = model.parkedLean;
      // lean about the ground line under the bike
      lean.position.set(0, base, model.driverZ ?? 0);
      pivot.position.set(0, -base, -(model.driverZ ?? 0));
    } else {
      if (e) this.disposeMeshes(e, null);
      const g = buildVehicleGeometry(v, base);
      const { tex } = swatchPage();
      const { mat, depth } = worldMaterials(tex);
      mk(g.body, mat, depth);
      next.roof = mk(g.roof, mat, depth);
      mk(g.glass, this.glassMat, null);
      next.lamps = mk(g.lamps, v.lightsOn ? this.lampOn : this.lampOff, null);
      next.look = 'parts';
    }
    this.group.add(obj);
    const ms = performance.now() - t0;
    this.buildStats.n++;
    this.buildStats.totalMs += ms;
    this.buildStats.maxMs = Math.max(this.buildStats.maxMs, ms);
    return next;
  }

  update(dt = 0): void {
    const p = this.game.player;
    const rig = this.renderer.rig;
    const driving = this.system.driving;
    const station = driving ? null : this.system.stations.view();
    rig.suppressBob = !!driving || !!station;
    this.renderer.handsBusy = !!driving;
    if (driving && driving !== this.lastDriving) {
      // Taking the wheel: look where the car points (the cameras are relative to it from here).
      p.yaw = headingFromFacing(driving.facing);
      p.pitch = 0;
    }
    this.lastDriving = driving;
    const top = this.renderer.cameraMode === 'top';
    const litNow: { v: Vehicle; d: number }[] = [];
    const seen = new Set<Vehicle>();
    const t0 = performance.now();
    let built = 0;
    const now = t0 / 1000;
    for (const v of this.system.list) {
      const d = Math.hypot(v.x - p.x, v.y - p.y);
      // drawn iff its level is (src/world/levels.ts) and the road or floor around it is on
      // screen (src/render/surroundings.ts); the car you drive always (outrunning streaming
      // must not take the car out from under you)
      if (d > VIEW_RANGE || (v !== driving && !this.renderer.chunks.drawnAt(v.x, v.y, v.z))) {
        if (this.entries.has(v)) this.drop(v);
        continue;
      }
      seen.add(v);
      let e = this.entries.get(v);
      // Taking or leaving the wheel rebuilds too: the driven vehicle's wheels are separate meshes.
      const drivenChanged = !!e && e.look === 'model' && e.driven !== (v === driving);
      // Distance LOD with hysteresis (no flip-flopping at the boundary); never the driven one.
      const wantFar = this.lookMode === 'model' && v !== driving && d > (e?.far ? LOD_NEAR : LOD_FAR);
      const lodChanged = !!e && e.look === 'model' && e.far !== wantFar;
      if (!e || drivenChanged || lodChanged || e.version !== v.version || e.z !== v.z || (e.look !== this.lookMode && this.lookMode === 'parts')) {
        // Spread first builds over frames (a town street streams in dozens at once), but
        // never delay the vehicle being driven or a visible change to an existing one nearby.
        const urgent = v === driving || (e && d < 20);
        if (urgent || !built || performance.now() - t0 < BUILD_BUDGET_MS) {
          e = this.build(v, e, wantFar);
          this.entries.set(v, e);
          built++;
        }
      }
      if (!e) continue;
      e.obj.position.set(v.x, 0, v.y);
      e.obj.rotation.y = (-v.facing * Math.PI) / 180;
      // A parked bike leans left on its stand; ridden it stands up and leans into turns.
      if (e.parkedLean && v !== driving && Math.abs(v.velocity) < 0.3) e.lean.rotation.x = -e.parkedLean;
      else e.lean.rotation.x = e.bike ? Math.max(-0.45, Math.min(0.45, v.steer * Math.abs(v.velocity) * 0.12)) : 0;
      // Front wheels follow the steering; all of them roll with the speed.
      if (e.cockpit) e.cockpit.update(v, dt, fuelFraction(v), this.wiping());
      for (const w of e.wheels) {
        w.spin -= (v.velocity * dt) / w.r;
        w.mesh.rotation.set(0, w.steer ? -v.steer : 0, w.spin);
      }
      if (e.crank) this.pedal(e, v, dt);
      if (e.turrets.length) this.aimTurrets(e, v);
      // Top-down hides roofs (and anything above your level) so you can see inside.
      if (e.roof) e.roof.visible = !top || v.z < p.z;
      if (e.lamps) e.lamps.material = v.lightsOn ? this.lampOn : this.lampOff;
      if (e.tails) e.tails.material = v.lightsOn ? this.tailOn : this.tailOff;
      // Emergency beacons flash while the vehicle's lights are on.
      if (e.beacons) e.beacons.visible = !v.lightsOn || Math.floor(now * 3 + v.uid) % 2 === 0;
      const lit = v.lightsOn && v.withFlag('CONE_LIGHT', true).length > 0;
      if (lit) litNow.push({ v, d });
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
    this.placeRider(driving, station, now);
    rig.drive = driving ? this.driveView(driving) : null;
    rig.stationEye = station ? this.stationEye(station) : null;
    rig.stationWide = station?.cabin === 'crew';
    const own = station?.v ?? null;
    rig.stationOwn = own ? (tx, ty) => this.system.at(tx, ty, own.z)?.v === own : null;
    rig.eyeCap = driving || station ? null : this.doorwayEyeCap();
    // no rain inside the cabin in the cockpit view (the glass is ~1 m ahead)
    this.renderer.weather.clearRadius = driving && rig.driveCam === 'cockpit' && !this.entries.get(driving)?.bike ? 1.1 : 0;

    const spotFor = pickHeadlightSpots(litNow, driving, this.headlights.length);
    this.headlights.forEach((s, i) => {
      const v = spotFor[i];
      if (v) {
        const [fx, fy] = this.front(v, 0.6);
        // Aimed at the road ~30 m out (dipped beam), strong enough to still read there.
        const [tx, ty] = this.front(v, 30);
        const h = v.z * LEVEL_HEIGHT;
        s.position.set(fx, h + 0.7, fy);
        s.target.position.set(tx, h - 0.4, ty);
        s.target.updateMatrixWorld();
        s.intensity = this.headlightIntensity;
      } else s.intensity = 0;
      prepareHeadlightShadow(s, this.renderer.three.shadowMap.type);
    });
  }

  /** The moving pieces of a hull's turret (vehicleTank.ts TurretBuild) under the vehicle's mount frame. */
  private turretView(t: TurretBuild, parent: THREE.Group, meshes: THREE.Mesh[], mat: THREE.Material, depth: THREE.MeshDepthMaterial, far: boolean): TurretView {
    const mesh = (geo: THREE.BufferGeometry | null): THREE.Mesh | null => {
      if (!geo) return null;
      const m = new THREE.Mesh(geo, mat);
      m.customDepthMaterial = depth;
      m.castShadow = !far;
      m.receiveShadow = true;
      meshes.push(m);
      return m;
    };
    const group = new THREE.Group();
    group.position.set(...t.pivot);
    parent.add(group);
    const body = mesh(t.geo);
    if (body) group.add(body);
    let gun: TurretView['gun'] = null;
    if (t.gun) {
      const g = new THREE.Group();
      g.position.set(...t.gun.pivot);
      group.add(g);
      const m = mesh(t.gun.geo);
      if (m) g.add(m);
      gun = { group: g, mesh: m, len: t.gun.len };
    }
    const mgs = t.mgs.map((mg) => {
      const g = new THREE.Group();
      g.position.set(...mg.pivot);
      (mg.onTurret ? group : parent).add(g);
      const m = mesh(mg.geo);
      if (m) g.add(m);
      return { part: mg.part, group: g, mesh: m, len: mg.len, onTurret: mg.onTurret };
    });
    return { part: t.part, group, hasTurret: !!t.geo, gun, mgs };
  }

  /**
   * Turn the turret and its guns to where src/game/turret.ts says they point. The local frame is
   * the hull's (X forward, Z right), so a yaw `rel` clockwise from the hull's heading is a
   * rotation of -rel about +Y; elevation is a rotation about +Z. An unmanned MG riding on the
   * turret just turns with it. Barrels run back after a shot.
   */
  private aimTurrets(e: Entry, v: Vehicle): void {
    const hull = hullYaw(v);
    for (const t of e.turrets) {
      let tYaw = hull;
      if (t.part && t.hasTurret) {
        const a = turretAim(v, t.part);
        tYaw = a.yaw;
        t.group.rotation.y = -wrapAngle(a.yaw - hull);
        if (t.gun) {
          t.gun.group.rotation.z = a.pitch;
          if (t.gun.mesh) t.gun.mesh.position.x = -barrelRecoil(a.sinceShot, 0.55);
        }
      }
      for (const mg of t.mgs) {
        const a = turretAim(v, mg.part);
        if (mg.onTurret && !a.want) {
          // riding along: points where the turret points (and starts from there when manned)
          mg.group.rotation.set(0, 0, 0);
          a.yaw = tYaw;
          a.pitch = 0;
        } else {
          mg.group.rotation.y = -wrapAngle(a.yaw - (mg.onTurret ? tYaw : hull));
          mg.group.rotation.z = a.pitch;
        }
        if (mg.mesh) mg.mesh.position.x = -barrelRecoil(a.sinceShot, 0.05);
      }
    }
  }

  /** The drawn muzzle of a turret's gun in game coordinates (x, y tiles; h absolute metres), or null if not built. */
  muzzleOf(v: Vehicle, part: VehiclePart): { x: number; y: number; h: number } | null {
    const e = this.entries.get(v);
    if (!e) return null;
    for (const t of e.turrets) {
      const g = t.part === part && t.gun ? { group: t.gun.group, len: t.gun.len } : t.mgs.find((m) => m.part === part) ?? null;
      if (!g) continue;
      g.group.updateWorldMatrix(true, false);
      const w = new THREE.Vector3(g.len, 0, 0).applyMatrix4(g.group.matrixWorld);
      return { x: w.x, y: w.z, h: w.y };
    }
    return null;
  }

  /**
   * The eye at a vehicle station (src/game/vehwalk.ts): seated at the drawn driver's eye
   * height, standing on the drawn floor under the roof, head out of a hatch over a hull, and
   * between two stations mid-hop with a small step in it. Absolute metres.
   */
  private stationEye(s: StationView): number {
    const e = this.entries.get(s.v);
    const eye = (st: Station): number => {
      const deck = e?.deckY ?? 0.55;
      const seatEye = e?.eyeH ?? deck + 0.75;
      // a hatch: head and shoulders out over the turret; a turret seat: head over its cupola
      // and machine gun (the M1's M240 sits ~0.4 m above the turret roof, right at the seat)
      if (st.posture === 'hatch') {
        // a hatch on the turret puts your head out over its roof; one on the hull deck (the
        // M1's driver's, a hull hatch behind the turret) over the deck
        const f = e?.turretFoot;
        const onTurret = !f || Math.hypot(st.x - f.x, st.y - f.z) <= f.r;
        return (onTurret ? e?.turretTop ?? deck : deck) + 0.9;
      }
      if (s.cabin === 'crew') return st.turret ? (e?.turretTop ?? deck) + 0.75 : seatEye;
      if (st.posture === 'standing') return Math.min(deck + STAND_EYE, (e?.roofY ?? Infinity) - 0.15);
      if (st.kind === 'bed') return deck + 0.6;
      return seatEye;
    };
    const base = s.v.z * LEVEL_HEIGHT;
    const to = eye(s.station);
    if (!s.from || s.t >= 1) return base + to;
    const k = s.t * s.t * (3 - 2 * s.t);
    return base + eye(s.from) + (to - eye(s.from)) * k + Math.sin(Math.PI * s.t) * 0.05;
  }

  /**
   * On foot in (or leaning into) a roofed vehicle: the eye stays under its roof, like ducking
   * into a car, instead of the camera clipping through the roof panel.
   */
  private doorwayEyeCap(): number | null {
    const p = this.game.player;
    for (const [v, e] of this.entries) {
      if (e.roofY === null || v.z !== p.z || Math.hypot(v.x - p.x, v.y - p.y) > 12) continue;
      const b = this.system.bodyRect(v);
      if (!b || !pointInBody(v, b, p.x, p.y, 0.3)) continue;
      if (e.roofY > 1.95) continue;
      return v.z * LEVEL_HEIGHT + e.roofY - 0.2;
    }
    return null;
  }

  /**
   * Pedalling: the crank turns with the distance ridden (forward = the front pedal goes down,
   * the same sense as the wheels' spin), but the crank and the feet on it show it stepped at
   * the characters' animation rate (charSettings.fps), like every other body animation.
   */
  private pedal(e: Entry, v: Vehicle, dt: number): void {
    e.pedal -= (v.velocity * dt * Math.PI * 2) / CRANK_M_PER_TURN;
    e.pedal %= Math.PI * 2;
    const f = charSettings.fps;
    e.pedalTick += dt;
    if (f <= 0 || e.pedalTick >= 1 / f) {
      e.pedalTick = f > 0 ? e.pedalTick % (1 / f) : 0;
      e.pedalShown = e.pedal;
    }
    e.crank!.rotation.z = e.pedalShown;
  }

  /** Tools: the seated rider's state (null = no body in the seat), `cdda.renderer.vehicleView.riderCheck()`. */
  riderCheck(): ReturnType<NonNullable<ReturnType<typeof riderSlot>['rider']>['check']> & { ageMs: number } | null {
    const r = riderSlot(this.renderer).rider;
    return r ? { ...r.check(), ageMs: performance.now() - r.placedAt } : null;
  }

  private riderGrips: [V3, V3] = [[0, 0, 0], [0, 0, 0]];
  private riderWorld = { x: 0, y: 0, z: 0 };
  private riderClock = 0;
  /**
   * The survivor's body in the seat of the vehicle being driven (chase / top-down cameras,
   * 3D characters: the player model puts itself in riderSlot). Runs after the vehicle's own
   * placement this frame, so the body never trails the vehicle.
   */
  private placeRider(driving: Vehicle | null, station: StationView | null, now: number): void {
    const rider = riderSlot(this.renderer).rider;
    const e = driving ? this.entries.get(driving) : undefined;
    for (const [v, en] of this.entries) {
      const seated = !!rider && v === driving;
      if (en.cockpit) en.cockpit.handsVisible = !seated;
      if (en.glassOut) en.glassOut.material = seated ? this.glassOutRider : this.glassOut;
    }
    if (rider && !driving && station && station.station.posture !== 'standing') return this.placeStationRider(station, now);
    if (!rider || !driving || !e) return;
    let a = e.ride;
    if (!a) {
      const s = driving.driverSeat();
      if (!s) return;
      a = genericAnchors(s.mx, s.my, driving.z * LEVEL_HEIGHT);
    }
    e.pivot.updateWorldMatrix(true, false);
    const grips = e.cockpit ? e.cockpit.gripPoints(this.riderGrips) : null;
    const [wx, wy] = driving.mountToWorld(a.hip[0], a.hip[2]);
    Object.assign(this.riderWorld, { x: wx, y: wy, z: driving.z });
    // (idle breathing and the like run off the stepped clock, like other bodies)
    const f = charSettings.fps;
    this.riderClock = f > 0 ? Math.floor(now * f) / f : now;
    rider.place(a, e.pivot.matrixWorld, grips, e.pedalShown, this.riderClock, this.riderWorld);
  }

  /**
   * The body at a seated or hatch station (vehwalk.ts) outside first person: in the seat, or
   * standing in the hatch with its forearms on the rim, instead of the standing body lifted to
   * the station's eye with its legs through the seat. A commander in a hatch and a gunner in a
   * turret face where you look; everyone else faces forward.
   */
  private placeStationRider(s: StationView, now: number): void {
    const rider = riderSlot(this.renderer).rider;
    const e = this.entries.get(s.v);
    if (!rider || !e) return;
    const st = s.station;
    const p = this.game.player;
    const rel = p.yaw - hullYaw(s.v);
    const turn = st.posture === 'hatch' || st.turret ? Math.atan2(Math.sin(rel), Math.cos(rel)) : 0;
    const a = stationAnchors(st.posture === 'hatch' ? 'hatch' : 'seated', st.x, st.y, this.stationEye(s), turn);
    e.pivot.updateWorldMatrix(true, false);
    const [wx, wy] = s.v.mountToWorld(a.hip[0], a.hip[2]);
    Object.assign(this.riderWorld, { x: wx, y: wy, z: s.v.z });
    const f = charSettings.fps;
    this.riderClock = f > 0 ? Math.floor(now * f) / f : now;
    rider.place(a, e.pivot.matrixWorld, null, 0, this.riderClock, this.riderWorld);
  }

  /** Wipers: 0 off, 1 rain / drizzle, 2 storm (the weather you see falling). */
  private wiping(): 0 | 1 | 2 {
    const k = this.renderer.weather.kind;
    if (k === 'storm') return 2;
    if (k === 'rain') return 1;
    const w = this.game.weather;
    return w?.rains && w.precip !== 'none' ? (w.precip === 'heavy' ? 2 : 1) : 0;
  }

  private handCache: { key: string; colors: HandColors } | null = null;
  /** Sleeve and skin colours for the hands on the wheel: from your outfit, like the on-foot arms. */
  private handColors(): HandColors {
    const p = this.game.player;
    const worn = p.inv.worn.map((w) => w.typeId);
    const key = `${worn.join(',')}|${p.male}`;
    if (this.handCache?.key === key) return this.handCache.colors;
    let colors: HandColors = { sleeve: 0x3a4250, skin: 0xc89878 };
    const src = this.renderer.source;
    if (src instanceof AtlasTextureSource) {
      const f = src.composite(src.layersFor(worn.length ? worn : ['jeans', 'tshirt', 'jacket_flannel'], null, p.male ? 'male' : 'female'));
      const pal = f ? spriteInfo(f)?.pal : null;
      if (pal) {
        const hex = (c: readonly number[]) => (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2]);
        colors = { sleeve: hex(pal.main), skin: hex(pal.skin) };
      }
    }
    this.handCache = { key, colors };
    return colors;
  }

  private lastDriving: Vehicle | null = null;
  private eyeCache = { v: null as Vehicle | null, version: -1, h: 1.2 };
  /** mass() walks every part and item: recompute the eye height only when the vehicle changes. */
  private eyeHeight(v: Vehicle, length: number): number {
    const c = this.eyeCache;
    if (c.v !== v || c.version !== v.version) Object.assign(c, { v, version: v.version, h: eyeHeightFor(length, v.mass()) });
    return c.h;
  }
  private view: DriveView | null = null;

  /** The camera's view of the vehicle being driven (driveCamera.ts). */
  private driveView(v: Vehicle): DriveView {
    const [x0, y0, x1, y1] = v.bounds();
    const [cx, cy] = v.mountToWorld((x0 + x1) / 2, (y0 + y1) / 2);
    const length = x1 - x0 + 1, width = y1 - y0 + 1;
    const seat = v.driverSeat() ?? { mx: (x0 + x1) / 2, my: (y0 + y1) / 2 };
    const e = this.entries.get(v);
    // Eye over the front of the seat, a little ahead of where the head would really be: the
    // dash and bonnet then drop out of the lower edge instead of filling it. The model look
    // squeezes the body's width, so the seat (and eye) sit at its drawn position.
    const [ex, ey] = v.mountToWorld(e?.eyeX ?? (e?.driverX ?? seat.mx) + EYE_FORWARD, e?.driverZ ?? seat.my);
    const base = v.z * LEVEL_HEIGHT;
    const t = this.game.map.terAt(Math.floor(cx), Math.floor(cy), v.z);
    const rough = hasFlag(t, 'ROAD') || hasFlag(t, 'FLAT') ? 0 : 1;
    const out = this.view ?? ({} as DriveView);
    Object.assign(out, {
      x: cx, y: cy, base, heading: headingFromFacing(v.facing),
      eyeX: ex, eyeY: ey, eyeH: base + (e?.eyeH ?? this.eyeHeight(v, length)),
      length, width, speed: v.velocity, rough,
    });
    this.view = out;
    return out;
  }

  /** World point `ahead` metres in front of the vehicle's nose (its template's, in the model look). */
  private front(v: Vehicle, ahead: number): [number, number] {
    const [, y0, x1, y1] = v.bounds();
    const nose = this.lookMode === 'model' ? noseX(v) : x1 + 0.5;
    return v.mountToWorld(nose + ahead, (y0 + y1) / 2);
  }
}

/** Fraction of the main (non-battery) fuel left, for the fuel gauge; the battery for EVs. */
function fuelFraction(v: Vehicle): number {
  const fuels = v.runningFuels();
  const gas = fuels.filter((f) => f !== 'battery' && f !== 'muscle')[0] ?? (fuels.includes('battery') ? 'battery' : null);
  if (!gas) return 0;
  const cap = v.fuelCapacity(gas);
  return cap > 0 ? v.fuelLeft(gas) / cap : 0;
}
