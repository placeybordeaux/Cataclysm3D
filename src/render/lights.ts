import * as THREE from 'three';
import { LEVEL_HEIGHT } from '../world/coords';
import { form } from './formLight';
import { ShadowRig, initialShadowMode } from './shadows';

// All scene lights. The *number* of each light type is fixed at construction so shader
// programs never recompile at runtime.
//
// Lamps, fires and other light sources are lit in two layers:
//  * the CDDA-style light map (lightmap.ts) shadowcasts every source over the tile grid, so
//    light never passes through walls; it gives a flat (normal-independent) term, and
//  * a pool of POOL_SIZE three.js point lights, reassigned every frame to the nearest
//    sources, adds normal-based shading and round light pools. Point lights are unoccluded,
//    so the shader multiplies them by a gate from the light map (zero where the map says no
//    artificial light arrives): no leaks, but lamps still model the surfaces they light.
//
// Other systems add lights with:
//   const h = renderer.lights.add({ x, y, z, color: 0xff9040, radius: 8, intensity: 1, flicker: true });
//   h.set(x, y, z); h.intensity = 0.5; h.remove();
// Changing a handle makes the light map rebuild on the next frame (brief muzzle flashes work).

export const POOL_SIZE = 4;

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
  /** light-map view of this source (luminance derived from intensity/radius) */
  lum: number;
}

/** Handle intensity/radius -> CDDA luminance for the light map (a radius-8, intensity-1
 *  lamp is ~ a CDDA 40 lum light). */
function handleLuminance(s: Source): number {
  return s.intensity * s.radius * 5;
}

/** A tile light source found by the light map (terrain/furniture light_emitted, fire, items). */
export interface StaticLight {
  x: number; // tile coords, integer
  y: number;
  z: number;
  lum: number;
  color: number;
  flicker: boolean;
  /** metres above the floor */
  height: number;
}

/** CDDA luminance -> point-light params. CDDA lamps are ~ 20-120 lum; fires ~ 20-160. */
function fromStatic(l: StaticLight): Source {
  return {
    x: l.x + 0.5, y: l.y + 0.5, z: l.z, height: l.height, color: l.color,
    intensity: Math.min(2, 0.4 + l.lum / 80), radius: Math.min(14, 3 + Math.sqrt(l.lum) * 0.9), flicker: l.flicker,
    phase: (l.x * 12.9898 + l.y * 78.233) % 6.283, d2: 0, lum: l.lum,
  };
}

// Sky/sun keyframes by hour. Colors are linear-ish multipliers tuned by eye for mood:
// cold blue nights, amber dawn/dusk, slightly warm desaturated days.
interface SkyKey { h: number; sun: number; sunI: number; hemiSky: number; hemiGround: number; hemiI: number; zenith: number; horizon: number; fog: number }
// Hemisphere intensities look high because three's Lambert divides ambient by pi; the
// ground colour doubles as bounce light (ceilings and interiors are lit only by it).
const NIGHT: Omit<SkyKey, 'h'> = { sun: 0x7088c8, sunI: 0.38, hemiSky: 0x3a5088, hemiGround: 0x1a1a26, hemiI: 0.95, zenith: 0x03050c, horizon: 0x0e1628, fog: 0x0a0f1a };
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
  /** 0..1 how much of the sun/moon disc shows through the clouds (atmosphere.ts overcast) */
  sunVisible = 1;

  update(hour: number, sun?: SkySun): void {
    // Keyframes are authored for a 06:00-20:00 day; with real sunrise/sunset (which move with
    // the season) the hour is remapped so dawn colours arrive at the actual dawn.
    const h = sun ? canonicalHour(hour, sun.sunrise, sun.sunset) : hour;
    this.sunVisible = 1;
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].h <= h) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const t = Math.min(1, Math.max(0, (h - a.h) / (b.h - a.h)));
    lerpHex(this.zenith, a.zenith, b.zenith, t);
    lerpHex(this.horizon, a.horizon, b.horizon, t);
    lerpHex(this.fog, a.fog, b.fog, t);
    lerpHex(this.sunColor, a.sun, b.sun, t);
    lerpHex(this.hemiSky, a.hemiSky, b.hemiSky, t);
    lerpHex(this.hemiGround, a.hemiGround, b.hemiGround, t);
    this.sunIntensity = a.sunI + (b.sunI - a.sunI) * t;
    this.hemiIntensity = a.hemiI + (b.hemiI - a.hemiI) * t;
    if (sun) {
      // Real sun position (src/game/sun.ts): low winter noons, long summer days.
      const alt = sun.altitude * DEG, az = sun.azimuth * DEG;
      this.sunDir.set(-Math.sin(az) * Math.cos(alt), Math.sin(alt), Math.cos(az) * Math.cos(alt)).normalize();
    } else {
      // Sun arc: rises in the east at 6:00, sets west at 20:00 (fixed spring-ish day), tilted
      // south so noon shadows point north like at New England latitudes.
      const dayT = (hour - 6) / 14;
      const ang = dayT * Math.PI;
      this.sunDir.set(Math.cos(ang), Math.sin(ang) * 0.85, 0.45).normalize();
    }
    const nightT = ((h + 24 - 20) % 24) / 10; // 20:00 -> 0, 06:00 -> 1
    const mang = nightT * Math.PI;
    this.moonDir.set(Math.cos(mang), Math.max(0.25, Math.sin(mang) * 0.8), -0.35).normalize();
    this.night = h < 5 || h > 21 ? 1 : h < 6.5 ? (6.5 - h) / 1.5 : h > 19.5 ? (h - 19.5) / 1.5 : 0;
    this.moonLit = this.sunDir.y < 0.06;
    if (sun?.season) this.applySeason(sun.season, 1 - this.night);
  }

  /**
   * Seasonal mood on top of the time-of-day keys: snow bounce and a cold, pale sky in winter,
   * warm low light in autumn, lush greens in summer. `day` 0..1 fades the effect at night.
   */
  private applySeason(season: 'spring' | 'summer' | 'autumn' | 'winter', day: number): void {
    const s = SEASON_TINT[season];
    const k = 0.35 + 0.65 * day;
    const mul = (c: THREE.Color, m: readonly [number, number, number]) =>
      c.setRGB(c.r * (1 + (m[0] - 1) * k), c.g * (1 + (m[1] - 1) * k), c.b * (1 + (m[2] - 1) * k));
    mul(this.hemiGround, s.ground);
    mul(this.hemiSky, s.sky);
    mul(this.sunColor, s.sun);
    mul(this.fog, s.fog);
    mul(this.horizon, s.fog);
    mul(this.zenith, s.zenith);
    this.hemiIntensity *= 1 + (s.ambient - 1) * k;
  }
}

/** What SkyState needs to know about the real sun (src/game/sun.ts) and the season. */
export interface SkySun {
  /** hours of the day */
  sunrise: number;
  sunset: number;
  /** degrees */
  altitude: number;
  azimuth: number;
  season?: 'spring' | 'summer' | 'autumn' | 'winter';
}

const DEG = Math.PI / 180;

/** Map a real hour onto the keyframes' 06:00 sunrise / 13:00 noon / 20:00 sunset day. */
export function canonicalHour(hour: number, sunrise: number, sunset: number): number {
  const noon = (sunrise + sunset) / 2;
  const knots: [number, number][] = [[0, 0], [sunrise, 6], [noon, 13], [sunset, 20], [24, 24]];
  for (let i = 0; i < knots.length - 1; i++) {
    const [x0, y0] = knots[i], [x1, y1] = knots[i + 1];
    if (hour <= x1) return y0 + ((hour - x0) / Math.max(1e-6, x1 - x0)) * (y1 - y0);
  }
  return hour;
}

type Tint = readonly [number, number, number];
const SEASON_TINT: Record<'spring' | 'summer' | 'autumn' | 'winter', { ground: Tint; sky: Tint; sun: Tint; fog: Tint; zenith: Tint; ambient: number }> = {
  spring: { ground: [0.96, 1.06, 0.94], sky: [1, 1, 1], sun: [1, 1, 0.98], fog: [0.98, 1.02, 1], zenith: [1, 1, 1], ambient: 1 },
  summer: { ground: [1.0, 1.08, 0.88], sky: [1.02, 1.02, 0.98], sun: [1.03, 1.0, 0.94], fog: [1.02, 1.02, 0.96], zenith: [0.95, 1.0, 1.06], ambient: 1.02 },
  autumn: { ground: [1.14, 0.98, 0.78], sky: [1.04, 0.98, 0.92], sun: [1.08, 0.96, 0.82], fog: [1.08, 1.0, 0.88], zenith: [0.98, 0.96, 0.94], ambient: 1 },
  // snow on the ground reflects: brighter, bluish bounce; pale overcast-looking sky
  winter: { ground: [1.55, 1.6, 1.75], sky: [0.96, 1.0, 1.08], sun: [0.94, 0.97, 1.04], fog: [1.08, 1.12, 1.2], zenith: [0.9, 0.95, 1.05], ambient: 1.1 },
};

export class LightManager {
  readonly group = new THREE.Group();
  /** The sun/moon and its shadow maps (shadows.ts: one to four directional lights by mode). */
  readonly shadows: ShadowRig;
  /** The first sun light (legacy: the only one). */
  get sun(): THREE.DirectionalLight {
    return this.shadows.lights[0];
  }
  /** set by lights.update: a sun-shadow map must be redrawn this frame */
  shadowDue = false;
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  /** Shadowless fill from the side opposite the sun (look.ts `fill`): a light pointing at
   *  the camera flattens forms unless a second light keeps their shape. Always present
   *  (intensity 0 when off) so shader programs never change. */
  readonly fill = new THREE.DirectionalLight(0xffffff, 0);
  fillK = 0;
  readonly flashlight = new THREE.SpotLight(0xfff2d8, 0, 22, 0.42, 0.35, 1.2);
  flashlightOn = false;
  /** Global multiplier for point/spot intensities (tuning). */
  pointScale = 6;
  private pool: THREE.PointLight[] = [];
  private dynamic = new Set<Source>();
  private statics: Source[] = [];
  private staticList: readonly StaticLight[] | null = null;
  private active: Source[] = [];
  /** A handle changed since the light map last read them (renderer forces a rebuild). */
  handlesDirty = false;
  private time = 0;
  /** Shadow frustum half-size in metres around the camera focus (legacy mode; look.ts). */
  shadowExtent = 30;
  private shadowSize: number;

  // 768: ~8 cm texels over the 60 m frustum, still finer than a low-res pixel at a few
  // metres, at ~half the shadow-pass fill cost of 1024 (see renderer shadowHz too).
  constructor(shadowMapSize = 768) {
    this.group.name = 'lights';
    this.shadowSize = shadowMapSize;
    // the sun-shadow lights go into the group first: three orders shadow-casting directional
    // lights by scene order, and the shader picks them by index (shadows.ts)
    this.shadows = new ShadowRig(this.group, () => ({ size: this.shadowSize, extent: this.shadowExtent }));
    this.shadows.setMode(initialShadowMode());
    this.group.add(this.hemi, this.fill, this.fill.target);
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
      phase: Math.random() * 6.283, d2: 0, lum: 0,
    };
    s.lum = handleLuminance(s);
    this.dynamic.add(s);
    this.handlesDirty = true;
    const self = this;
    // Only changes that move light between tiles or switch it on/off force a rebuild.
    return {
      set(x, y, z) {
        if (Math.floor(x) !== Math.floor(s.x) || Math.floor(y) !== Math.floor(s.y) || z !== s.z) self.handlesDirty = true;
        s.x = x; s.y = y; s.z = z;
      },
      get intensity() { return s.intensity; },
      set intensity(v: number) { if (v !== s.intensity) self.handlesDirty = true; s.intensity = v; s.lum = handleLuminance(s); },
      get color() { return s.color; },
      set color(v: number) { if (v !== s.color) self.handlesDirty = true; s.color = v; },
      get radius() { return s.radius; },
      set radius(v: number) { if (v !== s.radius) self.handlesDirty = true; s.radius = v; s.lum = handleLuminance(s); },
      remove() { self.dynamic.delete(s); self.handlesDirty = true; },
    };
  }

  /** Resize the sun shadow map / frustum (look.ts); the map reallocates on the next frame. */
  setShadow(size: number, extent: number): void {
    this.shadowSize = size;
    this.shadowExtent = extent;
    this.shadows.applyLookSize();
  }

  /** Handles for the light map (lightmap.ts reads x/y/z/lum/color/flicker/phase). */
  handles(): Iterable<Source> {
    return this.dynamic;
  }

  /** Tile sources found by the light map; they compete for the point-light pool too. */
  setStaticLights(list: readonly StaticLight[]): void {
    if (list === this.staticList) return;
    this.staticList = list;
    this.statics = list.map(fromStatic);
  }

  get activeCount(): number {
    return this.active.length;
  }

  update(dt: number, sky: SkyState, focus: THREE.Vector3, cam: THREE.Camera): void {
    this.time += dt;
    // Directional: sun by day, moon by night (one light so the shader never changes).
    let dir = sky.moonLit ? sky.moonDir : sky.sunDir;
    const fs = form.s;
    // Shadow cameras follow the focus, snapped to whole shadow texels (shadows.ts: legacy
    // snaps along axes that turn with the sun every frame; the other modes hold the sun still
    // between steps so the snap actually holds).
    this.shadowDue = this.shadows.update(dt, dir, focus, sky.sunColor, sky.sunIntensity * fs.key, this.flashlightOn);
    const snapped = tmpS.copy(this.sun.target.position);
    // the fill turns with the held sun step too, or its bands would still crawl every frame
    dir = this.shadows.heldDir(dir);
    this.hemi.color.copy(sky.hemiSky);
    this.hemi.groundColor.copy(sky.hemiGround);
    this.hemi.intensity = sky.hemiIntensity * fs.ambient;
    // fill, sky-coloured (formLight.ts): 'opposite' = from the anti-sun azimuth, fairly high
    // (v2); 'side' = from 90 degrees to the sun, always the same world side so shading
    // doesn't change as the camera turns, lower so it models walls rather than roofs
    this.fill.color.copy(sky.hemiSky);
    this.fill.intensity = Math.max(this.fillK, fs.fillMin) * sky.hemiIntensity * 0.9;
    this.fill.target.position.copy(snapped);
    if (fs.fillMode === 'side') {
      const hl = Math.hypot(dir.x, dir.z) || 1;
      const e = (fs.fillElev * Math.PI) / 180;
      this.fill.position.set(snapped.x - (dir.z / hl) * Math.cos(e) * 60, snapped.y + Math.sin(e) * 60, snapped.z + (dir.x / hl) * Math.cos(e) * 60);
    } else this.fill.position.set(snapped.x - dir.x * 40, snapped.y + 60, snapped.z - dir.z * 40);
    this.fill.target.updateMatrixWorld();

    // Pick nearest point sources.
    const act = this.active;
    act.length = 0;
    const consider = (s: Source) => {
      const dx = s.x - focus.x, dy = s.z * LEVEL_HEIGHT + s.height - focus.y, dz = s.y - focus.z;
      s.d2 = dx * dx + dy * dy + dz * dz;
      if (s.d2 < 60 * 60) act.push(s);
    };
    for (const s of this.dynamic) if (s.intensity > 0) consider(s);
    for (const s of this.statics) consider(s);
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
    // castShadow stays on: toggling it changes the shadow-light count every material is
    // compiled for, so the first flashlight switch recompiled every shader (a 0.8-1 s freeze,
    // docs/PERF.md). Off, its shadow map just isn't redrawn (intensity 0 hides it).
    fl.castShadow = true;
    fl.shadow.autoUpdate = this.flashlightOn;
    cam.updateMatrixWorld();
    fl.position.set(0.22, -0.28, 0.05).applyMatrix4(cam.matrixWorld);
    fl.target.position.set(0, 0, -10).applyMatrix4(cam.matrixWorld);
    fl.target.updateMatrixWorld();
  }
}

const tmpS = new THREE.Vector3();
