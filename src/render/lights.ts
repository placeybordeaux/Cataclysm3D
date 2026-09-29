import * as THREE from 'three';
import { LEVEL_HEIGHT } from '../world/coords';
import type { ChunkLight } from './chunkMesh';

// All scene lights. The *number* of each light type is fixed at construction so shader
// programs never recompile at runtime: point lights come from a pool of POOL_SIZE that is
// reassigned every frame to the nearest active sources (unused slots get intensity 0).
//
// Other systems add lights with:
//   const h = renderer.lights.add({ x, y, z, color: 0xff9040, radius: 8, intensity: 1, flicker: true });
//   h.set(x, y, z); h.intensity = 0.5; h.remove();

export const POOL_SIZE = 8;

export interface LightSpec {
  x: number;
  y: number;
  z: number;
  /** metres above the level floor (default 1.2) */
  height?: number;
  color?: number;
  /** relative brightness, 1 = a bright room lamp */
  intensity?: number;
  /** reach in metres (hard cutoff; banded falloff inside) */
  radius?: number;
  flicker?: boolean;
}

export interface LightHandle {
  set(x: number, y: number, z: number): void;
  intensity: number;
  color: number;
  radius: number;
  remove(): void;
}

interface Source {
  x: number; y: number; z: number; height: number;
  color: number; intensity: number; radius: number; flicker: boolean;
  phase: number;
  d2: number;
}

/** CDDA luminance -> our light params. CDDA lamps are ~ 20-120 lum; fires ~ 50-150. */
export function fromLuminance(l: ChunkLight): Source {
  const radius = Math.min(14, 3 + Math.sqrt(l.luminance) * 0.9);
  return {
    x: l.x, y: l.y, z: l.z, height: l.height, color: l.color,
    intensity: Math.min(2, 0.4 + l.luminance / 80), radius, flicker: l.flicker,
    phase: (l.x * 12.9898 + l.y * 78.233) % 6.283, d2: 0,
  };
}

// Sky/sun keyframes by hour. Colors are linear-ish multipliers tuned by eye for mood:
// cold blue nights, amber dawn/dusk, slightly warm desaturated days.
interface SkyKey { h: number; sun: number; sunI: number; hemiSky: number; hemiGround: number; hemiI: number; zenith: number; horizon: number; fog: number }
// Hemisphere intensities look high because three's Lambert divides ambient by pi; the
// ground colour doubles as bounce light (ceilings and interiors are lit only by it).
const NIGHT: Omit<SkyKey, 'h'> = { sun: 0x7088c8, sunI: 0.5, hemiSky: 0x3a5088, hemiGround: 0x1a1a26, hemiI: 1.25, zenith: 0x03050c, horizon: 0x0e1628, fog: 0x0c1220 };
const KEYS: SkyKey[] = [
  { h: 0, ...NIGHT },
  { h: 4.5, ...NIGHT },
  { h: 5.6, sun: 0xff8a50, sunI: 0.5, hemiSky: 0x7a6a98, hemiGround: 0x2c2228, hemiI: 1.4, zenith: 0x1a2040, horizon: 0xc0704a, fog: 0x5a4450 },
  { h: 7, sun: 0xffc890, sunI: 1.7, hemiSky: 0x9aa8c8, hemiGround: 0x5a4c3c, hemiI: 2.2, zenith: 0x4a6a9a, horizon: 0xd0a888, fog: 0x9a9098 },
  { h: 12, sun: 0xfff0dc, sunI: 2.5, hemiSky: 0xb8c8e0, hemiGround: 0x6a604c, hemiI: 2.6, zenith: 0x4c78b0, horizon: 0xb4c4d0, fog: 0xa8b4bc },
  { h: 17, sun: 0xffe0b0, sunI: 2.2, hemiSky: 0xa8b4cc, hemiGround: 0x685844, hemiI: 2.4, zenith: 0x4a70a4, horizon: 0xc8b8a8, fog: 0xa8a4a4 },
  { h: 19.2, sun: 0xff7a3a, sunI: 1.3, hemiSky: 0x907aa0, hemiGround: 0x3c2a28, hemiI: 1.7, zenith: 0x2a3060, horizon: 0xe07a44, fog: 0x7a5a5a },
  { h: 20.4, sun: 0x8a70b0, sunI: 0.5, hemiSky: 0x4a4a7a, hemiGround: 0x1c1820, hemiI: 1.3, zenith: 0x0a0c20, horizon: 0x40304a, fog: 0x1c1826 },
  { h: 22, ...NIGHT },
  { h: 24, ...NIGHT },
];

const tmpA = new THREE.Color(), tmpB = new THREE.Color();
function lerpHex(out: THREE.Color, a: number, b: number, t: number): THREE.Color {
  tmpA.setHex(a); tmpB.setHex(b);
  return out.copy(tmpA).lerp(tmpB, t);
}

export class SkyState {
  readonly zenith = new THREE.Color();
  readonly horizon = new THREE.Color();
  readonly fog = new THREE.Color();
  readonly sunColor = new THREE.Color();
  sunIntensity = 1;
  readonly hemiSky = new THREE.Color();
  readonly hemiGround = new THREE.Color();
  hemiIntensity = 1;
  /** unit vector toward the sun (three.js space) */
  readonly sunDir = new THREE.Vector3();
  readonly moonDir = new THREE.Vector3();
  /** 0 day .. 1 full night (stars, moon visibility) */
  night = 0;
  /** whether the directional light currently represents the moon */
  moonLit = false;

  update(hour: number): void {
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].h <= hour) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const t = Math.min(1, Math.max(0, (hour - a.h) / (b.h - a.h)));
    lerpHex(this.zenith, a.zenith, b.zenith, t);
    lerpHex(this.horizon, a.horizon, b.horizon, t);
    lerpHex(this.fog, a.fog, b.fog, t);
    lerpHex(this.sunColor, a.sun, b.sun, t);
    lerpHex(this.hemiSky, a.hemiSky, b.hemiSky, t);
    lerpHex(this.hemiGround, a.hemiGround, b.hemiGround, t);
    this.sunIntensity = a.sunI + (b.sunI - a.sunI) * t;
    this.hemiIntensity = a.hemiI + (b.hemiI - a.hemiI) * t;
    // Sun arc: rises in the east at 6:00, sets west at 20:00 (fixed spring-ish day), tilted
    // south so noon shadows point north like at New England latitudes.
    const dayT = (hour - 6) / 14;
    const ang = dayT * Math.PI;
    this.sunDir.set(Math.cos(ang), Math.sin(ang) * 0.85, 0.45).normalize();
    const nightT = ((hour + 24 - 20) % 24) / 10; // 20:00 -> 0, 06:00 -> 1
    const mang = nightT * Math.PI;
    this.moonDir.set(Math.cos(mang), Math.max(0.25, Math.sin(mang) * 0.8), -0.35).normalize();
    this.night = hour < 5 || hour > 21 ? 1 : hour < 6.5 ? (6.5 - hour) / 1.5 : hour > 19.5 ? (hour - 19.5) / 1.5 : 0;
    this.moonLit = this.sunDir.y < 0.06;
  }
}

export class LightManager {
  readonly group = new THREE.Group();
  readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  readonly flashlight = new THREE.SpotLight(0xfff2d8, 0, 22, 0.42, 0.35, 1.2);
  flashlightOn = false;
  /** Global multiplier for point/spot intensities (tuning). */
  pointScale = 6;
  private pool: THREE.PointLight[] = [];
  private dynamic = new Set<Source>();
  private chunkLights: Source[][] = [];
  private active: Source[] = [];
  private time = 0;
  /** Shadow frustum half-size in metres around the camera focus. */
  shadowExtent = 30;

  constructor(shadowMapSize = 1024) {
    this.group.name = 'lights';
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    const c = this.sun.shadow.camera;
    c.left = -this.shadowExtent; c.right = this.shadowExtent; c.top = this.shadowExtent; c.bottom = -this.shadowExtent;
    c.near = 1; c.far = 160;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.03;
    this.group.add(this.sun, this.sun.target, this.hemi);
    for (let i = 0; i < POOL_SIZE; i++) {
      const p = new THREE.PointLight(0xffffff, 0, 8, 1.6);
      this.pool.push(p);
      this.group.add(p);
    }
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(512, 512);
    this.flashlight.shadow.bias = -0.0006;
    this.flashlight.shadow.normalBias = 0.02;
    this.flashlight.shadow.camera.near = 0.2;
    this.group.add(this.flashlight, this.flashlight.target);
  }

  add(spec: LightSpec): LightHandle {
    const s: Source = {
      x: spec.x, y: spec.y, z: spec.z, height: spec.height ?? 1.2, color: spec.color ?? 0xffd9a0,
      intensity: spec.intensity ?? 1, radius: spec.radius ?? 8, flicker: spec.flicker ?? false,
      phase: Math.random() * 6.283, d2: 0,
    };
    this.dynamic.add(s);
    const self = this;
    return {
      set(x, y, z) { s.x = x; s.y = y; s.z = z; },
      get intensity() { return s.intensity; },
      set intensity(v: number) { s.intensity = v; },
      get color() { return s.color; },
      set color(v: number) { s.color = v; },
      get radius() { return s.radius; },
      set radius(v: number) { s.radius = v; },
      remove() { self.dynamic.delete(s); },
    };
  }

  /** Chunk manager hands over static sources per built chunk (replaced wholesale). */
  setChunkLights(all: ChunkLight[][]): void {
    this.chunkLights = all.map((list) => list.map(fromLuminance));
  }

  get activeCount(): number {
    return this.active.length;
  }

  update(dt: number, sky: SkyState, focus: THREE.Vector3, cam: THREE.Camera): void {
    this.time += dt;
    // Directional: sun by day, moon by night (one light so the shader never changes).
    const dir = sky.moonLit ? sky.moonDir : sky.sunDir;
    this.sun.color.copy(sky.sunColor);
    this.sun.intensity = sky.sunIntensity;
    // Shadow camera follows the focus, snapped to whole shadow texels along the light's
    // axes so shadow edges don't crawl as the player moves (pixel stabilization).
    const ext = this.shadowExtent;
    const texel = (2 * ext) / this.sun.shadow.mapSize.x;
    const fwd = tmpV.copy(dir).negate();
    const right = tmpR.set(0, 1, 0).cross(fwd).normalize();
    const up = tmpU.copy(fwd).cross(right).normalize();
    const rx = Math.round(focus.dot(right) / texel) * texel;
    const uy = Math.round(focus.dot(up) / texel) * texel;
    const fz = focus.dot(fwd);
    const snapped = tmpS.set(0, 0, 0).addScaledVector(right, rx).addScaledVector(up, uy).addScaledVector(fwd, fz);
    this.sun.target.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(dir, 80);
    this.sun.target.updateMatrixWorld();
    this.hemi.color.copy(sky.hemiSky);
    this.hemi.groundColor.copy(sky.hemiGround);
    this.hemi.intensity = sky.hemiIntensity;

    // Pick nearest point sources.
    const act = this.active;
    act.length = 0;
    const consider = (s: Source) => {
      const dx = s.x - focus.x, dy = s.z * LEVEL_HEIGHT + s.height - focus.y, dz = s.y - focus.z;
      s.d2 = dx * dx + dy * dy + dz * dz;
      if (s.d2 < 60 * 60) act.push(s);
    };
    for (const s of this.dynamic) consider(s);
    for (const list of this.chunkLights) for (const s of list) consider(s);
    if (act.length > POOL_SIZE) act.sort((a, b) => a.d2 - b.d2);
    for (let i = 0; i < POOL_SIZE; i++) {
      const p = this.pool[i];
      const s = act[i];
      if (!s) { p.intensity = 0; continue; }
      p.position.set(s.x, s.z * LEVEL_HEIGHT + s.height, s.y);
      p.color.setHex(s.color);
      p.distance = s.radius;
      let k = s.intensity;
      if (s.flicker) k *= 0.8 + 0.12 * Math.sin(this.time * 11 + s.phase) + 0.08 * Math.sin(this.time * 23.7 + s.phase * 2);
      p.intensity = k * this.pointScale;
    }

    // Flashlight: held low and to the right so its shadows are visible from the eye.
    const fl = this.flashlight;
    fl.intensity = this.flashlightOn ? 14 : 0;
    fl.castShadow = this.flashlightOn;
    cam.updateMatrixWorld();
    fl.position.set(0.22, -0.28, 0.05).applyMatrix4(cam.matrixWorld);
    fl.target.position.set(0, 0, -10).applyMatrix4(cam.matrixWorld);
    fl.target.updateMatrixWorld();
  }
}

const tmpV = new THREE.Vector3(), tmpR = new THREE.Vector3(), tmpU = new THREE.Vector3(), tmpS = new THREE.Vector3();
