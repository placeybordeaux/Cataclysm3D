import * as THREE from 'three';
import { MPH_PER_MS, type Vehicle } from '../game/vehicle';
import { setupPixelTexture } from './atlas';
import { GeomBuilder, type V3 } from './geometry';
import { patchNormalOutput } from './materials';
import type { TileFrame } from './textureSource';
import { Batches, chamferBox, partFrames, tube } from './vehicleGeom';

// The driver's-seat extras, built only for the vehicle you drive (VehicleRenderer): the
// steering wheel as its own mesh turning with the front wheels, your forearms and fists on
// it, pixel-art speed and fuel dials whose needles follow the real values, and a dusty,
// wiper-swept film on the inside of the windscreen. Everything is in the vehicle's local
// frame (mount x forward, mount y right, metres up + the level's floor), added under the
// renderer's lean pivot.

/** Where the model put the cockpit (vehicleModel.ts, driven builds only). */
export interface CockpitAnchors {
  /** Steering wheel centre, rim radius, tilt back from vertical (rad). */
  wheel: { x: number; y: number; z: number; r: number; tilt: number };
  /** Dial centres and the dial plane's axes (right, up, normal toward the eye). */
  dials: { kind: 'speed' | 'fuel'; c: V3; right: V3; up: V3; n: V3; r: number }[];
  /** Where the driver's elbows are (forearms run from here to the fists). */
  elbows: [V3, V3];
  /** The windscreen film (inside the glass, UVs 0..1 across and up), or null if broken. */
  film: THREE.BufferGeometry | null;
}

// --- textures --------------------------------------------------------------------------

const DIAL = 64;

/** 3x5 pixel glyphs for dial labels. */
const GLYPHS: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'], '2': ['###', '..#', '###', '#..', '###'], '4': ['#.#', '#.#', '###', '..#', '..#'],
  '6': ['###', '#..', '###', '#.#', '###'], '8': ['###', '#.#', '###', '#.#', '###'], '1': ['.#.', '##.', '.#.', '.#.', '###'],
  'E': ['###', '#..', '##.', '#..', '###'], 'F': ['###', '#..', '##.', '#..', '#..'], 'M': ['#.#', '###', '###', '#.#', '#.#'],
  'P': ['##.', '#.#', '##.', '#..', '#..'], 'H': ['#.#', '#.#', '###', '#.#', '#.#'],
};

/** Dial sweep: 0 at -120 deg (lower left) to max at +120 deg, clockwise from the top. */
export const DIAL_SWEEP = (240 * Math.PI) / 180;
export const SPEED_MAX_MPH = 120;

function paintDial(data: Uint8Array, W: number, ox: number, kind: 'speed' | 'fuel'): void {
  const put = (x: number, y: number, c: [number, number, number, number]) => {
    if (x < 0 || y < 0 || x >= DIAL || y >= DIAL) return;
    const o = (y * W + ox + x) * 4;
    data.set(c, o);
  };
  const cx = DIAL / 2 - 0.5, cy = DIAL / 2 - 0.5;
  for (let y = 0; y < DIAL; y++)
    for (let x = 0; x < DIAL; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > 31.5) put(x, y, [0, 0, 0, 0]);
      else if (d > 29.5) put(x, y, [150, 152, 158, 255]); // chrome bezel
      else put(x, y, d < 27 ? [18, 20, 24, 255] : [30, 32, 38, 255]);
    }
  // ticks: angle t from the top, clockwise; y is flipped on upload (row 0 = bottom)
  const tick = (frac: number, len: number, col: [number, number, number, number]) => {
    const a = -DIAL_SWEEP / 2 + frac * DIAL_SWEEP;
    for (let r = 27 - len; r <= 27; r += 0.5) put(Math.round(cx + Math.sin(a) * r), Math.round(cy + Math.cos(a) * r), col);
  };
  const white: [number, number, number, number] = [226, 226, 214, 255], red: [number, number, number, number] = [220, 48, 36, 255];
  const text = (s: string, x: number, y: number, col = white) => {
    [...s].forEach((ch, i) => GLYPHS[ch]?.forEach((row, j) => [...row].forEach((b, k) => b === '#' && put(x + i * 4 + k, y + 4 - j, col))));
  };
  if (kind === 'speed') {
    for (let mph = 0; mph <= SPEED_MAX_MPH; mph += 10) tick(mph / SPEED_MAX_MPH, mph % 20 === 0 ? 6 : 3, mph >= 100 ? red : white);
    // labels every 40 mph, just inside the ticks
    for (const mph of [0, 40, 80, 120]) {
      const a = -DIAL_SWEEP / 2 + (mph / SPEED_MAX_MPH) * DIAL_SWEEP;
      const s = String(mph);
      text(s, Math.round(cx + Math.sin(a) * 16 - s.length * 2), Math.round(cy + Math.cos(a) * 16 - 2));
    }
    text('MPH', Math.round(cx - 6), Math.round(cy - 14), [150, 150, 140, 255]);
  } else {
    for (let i = 0; i <= 4; i++) tick(i / 4, i % 2 === 0 ? 6 : 3, i === 0 ? red : white);
    const at = (frac: number, s: string, col = white) => {
      const a = -DIAL_SWEEP / 2 + frac * DIAL_SWEEP;
      text(s, Math.round(cx + Math.sin(a) * 17 - 1), Math.round(cy + Math.cos(a) * 17 - 2), col);
    };
    at(0, 'E', red);
    at(1, 'F');
    // a pump pictogram
    for (let y = -5; y <= 3; y++) for (let x = -3; x <= 2; x++) if (!(y > -2 && y < 2 && x > -2 && x < 1)) put(Math.round(cx + x), Math.round(cy - 12 + y), [150, 150, 140, 255]);
  }
}

let dialTex: THREE.DataTexture | null = null;
/** Speed dial on the left half, fuel on the right. */
export function dialTexture(): THREE.DataTexture {
  if (dialTex) return dialTex;
  const W = DIAL * 2;
  const data = new Uint8Array(W * DIAL * 4);
  paintDial(data, W, 0, 'speed');
  paintDial(data, W, DIAL, 'fuel');
  dialTex = new THREE.DataTexture(data, W, DIAL, THREE.RGBAFormat);
  setupPixelTexture(dialTex);
  return dialTex;
}

let filmTex: THREE.DataTexture | null = null;
/**
 * Inside-of-the-windscreen film, 128x64: faint dust specks, grime at the base and in the
 * corners, the two wiper arcs swept cleaner, a soft diagonal reflection band. Alpha stays
 * low (a few %) so the road reads through it.
 */
export function filmTexture(): THREE.DataTexture {
  if (filmTex) return filmTex;
  const W = 256, H = 128;
  const data = new Uint8Array(W * H * 4);
  const hash = (x: number, y: number) => {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W, v = (y + 0.5) / H;
      // wiper arcs: pivots on the base line at u = 0.28 and 0.68, blade reach ~0.62 of the height
      const swept = [0.28, 0.68].some((pu) => Math.hypot((u - pu) * 2, v) < 0.62 && Math.hypot((u - pu) * 2, v) > 0.08);
      let dust = 0.012 + (1 - v) * 0.02 + (Math.abs(u - 0.5) > 0.44 ? 0.04 : 0);
      if (v < 0.05) dust += 0.08;
      if (swept) dust *= 0.3;
      const n = hash(x, y);
      // mostly a faint haze, with the odd single-texel fleck
      let a = n < 0.015 ? 0.16 * (swept ? 0.4 : 1) : dust * (0.7 + n * 0.3);
      let c = [120, 110, 92];
      // reflection band: the sky catching the glass, a diagonal stripe
      const band = Math.abs(u * 0.9 - v * 0.6 - 0.18);
      if (band < 0.05) {
        c = [200, 210, 220];
        a = Math.max(a, band < 0.025 ? 0.05 : 0.03);
      }
      const o = (y * W + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = Math.round(Math.min(0.3, a) * 255);
    }
  filmTex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  setupPixelTexture(filmTex);
  return filmTex;
}

// --- the rig ---------------------------------------------------------------------------

/** Wheel turns this many times the front-wheel angle (a car's steering ratio, shortened). */
const WHEEL_RATIO = 2.6;
const NEEDLE_RATE = 6;

export interface HandColors {
  sleeve: number;
  skin: number;
}

/** Steering wheel ring + spokes + column-less hub, centred on the origin, same tilt as the model. */
function wheelGeometry(r: number, tilt: number, F: Record<string, TileFrame>): GeomBuilder {
  const g = new GeomBuilder();
  const N = 12;
  const pt = (i: number): V3 => {
    const a = (i / N) * Math.PI * 2;
    const u = Math.cos(a) * r, w = Math.sin(a) * r;
    return [-u * Math.sin(tilt), u * Math.cos(tilt), w];
  };
  for (let i = 0; i < N; i++) tube(g, pt(i), pt(i + 1), 0.024, F.leather, 5);
  // three spokes and a hub
  for (const i of [3, 9, 6]) tube(g, [0, 0, 0], pt(i), 0.016, F.dark, 4);
  chamferBox(g, -0.03, -0.045, -0.045, 0.02, 0.045, 0.045, 0.02, F.dark, F.dark);
  return g;
}

function fistGeometry(F: Record<string, TileFrame>): GeomBuilder {
  const g = new GeomBuilder();
  chamferBox(g, -0.045, -0.04, -0.05, 0.045, 0.04, 0.05, 0.02, F.fabric, F.fabric);
  return g;
}

export class Cockpit {
  readonly group = new THREE.Group();
  private wheel: THREE.Mesh;
  private fists: THREE.Mesh[] = [];
  private arms: THREE.Mesh[] = [];
  private needles: { mesh: THREE.Mesh; kind: 'speed' | 'fuel'; value: number }[] = [];
  private steerShown = 0;
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private a: CockpitAnchors;

  constructor(a: CockpitAnchors, partsMat: THREE.Material, colors: HandColors) {
    this.a = a;
    const F = partFrames() as unknown as Record<string, TileFrame>;
    const own = <T extends THREE.BufferGeometry>(g: T) => (this.geos.push(g), g);
    const mat = <T extends THREE.Material>(m: T) => (this.mats.push(m), patchNormalOutput(m, false), m);
    // wheel
    const wb = new Batches();
    const wg = wheelGeometry(a.wheel.r, a.wheel.tilt, F);
    const wgeo = own(tint(wg.build(), 0x34343a));
    void wb;
    this.wheel = new THREE.Mesh(wgeo, partsMat);
    this.wheel.position.set(a.wheel.x, a.wheel.y, a.wheel.z);
    this.group.add(this.wheel);
    // hands: fists ride on the rim (children of the wheel), forearms are stretched each frame
    const skinMat = mat(new THREE.MeshLambertMaterial({ color: colors.skin }));
    const sleeveMat = mat(new THREE.MeshLambertMaterial({ color: colors.sleeve }));
    const fist = own(fistGeometry(F).build());
    const arm = own(new THREE.CylinderGeometry(0.036, 0.042, 1, 6, 1).translate(0, 0.5, 0));
    for (const s of [-1, 1]) {
      const f = new THREE.Mesh(fist, skinMat);
      // 10-to-2: on the rim, 60 deg either side of the top
      const ang = (s * Math.PI) / 3.2;
      const u = Math.cos(ang) * a.wheel.r, w = Math.sin(ang) * a.wheel.r;
      f.position.set(-u * Math.sin(a.wheel.tilt), u * Math.cos(a.wheel.tilt), w);
      f.rotation.set(0, 0, a.wheel.tilt);
      this.wheel.add(f);
      this.fists.push(f);
      const m = new THREE.Mesh(arm, sleeveMat);
      this.group.add(m);
      this.arms.push(m);
    }
    // dials: faces and needles
    const tex = dialTexture();
    const faceMat = mat(new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5 }));
    const needleMat = mat(new THREE.MeshBasicMaterial({ color: 0xff5a2a }));
    for (const d of a.dials) {
      const g = new THREE.PlaneGeometry(d.r * 2, d.r * 2);
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      const u0 = d.kind === 'speed' ? 0 : 0.5;
      for (let i = 0; i < uv.count; i++) uv.setX(i, u0 + uv.getX(i) * 0.5);
      own(g);
      const face = new THREE.Mesh(g, faceMat);
      const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(...d.right), new THREE.Vector3(...d.up), new THREE.Vector3(...d.n));
      face.quaternion.setFromRotationMatrix(basis);
      face.position.set(...d.c);
      this.group.add(face);
      const ng = own(new THREE.PlaneGeometry(0.006, d.r * 0.85).translate(0, d.r * 0.36, 0.003));
      const needle = new THREE.Mesh(ng, needleMat);
      face.add(needle);
      this.needles.push({ mesh: needle, kind: d.kind, value: 0 });
    }
    // windscreen film
    if (a.film) {
      // lit (Lambert) so it goes dark at night instead of glowing
      const fm = mat(new THREE.MeshLambertMaterial({ map: filmTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      const film = new THREE.Mesh(a.film, fm);
      film.renderOrder = 2;
      this.group.add(film);
      this.geos.push(a.film);
    }
  }

  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  update(v: Vehicle, dt: number, fuelFrac: number): void {
    const a = this.a;
    // the wheel follows the front wheels' angle, eased like a hand on it
    this.steerShown += (v.steer * WHEEL_RATIO - this.steerShown) * Math.min(1, dt * 12);
    const n = this.tmpA.set(Math.cos(a.wheel.tilt), Math.sin(a.wheel.tilt), 0);
    this.wheel.quaternion.setFromAxisAngle(n, -this.steerShown);
    this.wheel.updateMatrix();
    // forearms: elbow -> fist, rebuilt from the fists' new positions
    this.fists.forEach((f, i) => {
      const fp = this.tmpB.copy(f.position).applyMatrix4(this.wheel.matrix);
      const e = new THREE.Vector3(...a.elbows[i]);
      const dir = fp.clone().sub(e);
      const len = dir.length();
      const arm = this.arms[i];
      arm.position.copy(e);
      arm.quaternion.setFromUnitVectors(this.up, dir.normalize());
      arm.scale.set(1, Math.max(0.05, len - 0.03), 1);
    });
    for (const nd of this.needles) {
      const target = nd.kind === 'speed' ? Math.min(1, (Math.abs(v.velocity) * MPH_PER_MS) / SPEED_MAX_MPH) : Math.max(0, Math.min(1, fuelFrac));
      nd.value += (target - nd.value) * Math.min(1, dt * NEEDLE_RATE);
      nd.mesh.rotation.z = -(-DIAL_SWEEP / 2 + nd.value * DIAL_SWEEP);
    }
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}

/** Bake a tint into GeomBuilder vertex colours (the world material multiplies by them). */
function tint(geo: THREE.BufferGeometry, c: number): THREE.BufferGeometry {
  const col = geo.getAttribute('color') as THREE.BufferAttribute;
  const k = new THREE.Color().setRGB(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, THREE.LinearSRGBColorSpace);
  for (let i = 0; i < col.count; i++) col.setXYZ(i, col.getX(i) * k.r, col.getY(i) * k.g, col.getZ(i) * k.b);
  return geo;
}
