import * as THREE from 'three';
import { setupPixelTexture } from './atlas';
import { normalOutputChunk } from './materials';
import type { TileFrame } from './textureSource';
import { bowFrame, type DrawnKind } from './bowArt';

// Doom/Daggerfall-style first-person view of the wielded item.
//
// Drawn as a screen-space overlay *inside* the low-res scene target (after the world, with
// the depth buffer cleared), so it goes through the same outline/dither/LUT post pass and
// every sprite texel lands on whole low-res pixels. The item's atlas sprite is cropped to
// its opaque pixels, mirrored so melee weapons point up-left from the lower right, and
// composited with a procedurally drawn fist + sleeve at the grip. Bare-handed shows two
// fists. Animations: walking bob, 'melee' swing / punch, 'fire' recoil + muzzle flash
// (with a brief point light), 'throw'.
//
//   renderer.viewmodel.attack('melee' | 'fire' | 'throw')
//
// The combat feel layer (src/game/combatfeel.ts) drives phase-exact animations on top:
// `swing()` times anticipation -> strike -> follow-through -> recovery so the contact pose
// lands exactly when the blow resolves, `impact()` holds the pose for hit-stop, `setGuard()`
// raises the weapon/fists while RMB is held, `recoil()` scales the gun kick, `jolt()` knocks
// the hands when you're hit, `reload()` dips the gun for the reload time, `ads` centres it.

export type AttackKind = 'melee' | 'fire' | 'throw' | 'sweep';

/** What PlayerCombat.bowPose reports for drawn / whirled weapons. */
export interface BowPose {
  style: 'draw' | 'whirl' | 'trigger';
  cls: string;
  draw: number;
  nocked: boolean;
  shake: number;
  whirl: number;
}

/** Draw stages pre-rendered per drawn weapon (the displayed draw snaps to the nearest). */
const BOW_STAGES = 7;

export interface ViewmodelItem {
  typeId: string;
  isGun?(): boolean;
  /** CDDA size data (Item.def): drives how much of the screen the held item covers. */
  def?: { longest_side?: number; volume?: number };
}

/**
 * Longest on-screen extent of a held item as a fraction of the low-res height: a knife is
 * small, a bat or spear reaches across, and bulky things (a fire extinguisher's squat
 * sprite) are held lower and smaller so they don't blot out the view.
 * `aspect` = short/long side of the cropped sprite.
 */
export function heldItemExtent(def: ViewmodelItem['def'], aspect: number): number {
  const vol = def?.volume ?? 500;
  const len = def?.longest_side ?? Math.cbrt(vol) * 1.5;
  let f = Math.max(0.18, Math.min(0.38, 0.22 + 0.12 * Math.log2(Math.max(1, len) / 30)));
  if (aspect > 0.45) f *= 0.8;
  return f;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG = /* glsl */ `
layout(location = 1) out highp vec4 gNormal;
uniform sampler2D map;
uniform vec3 uTint;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(map, vUv);
  if (c.a < 0.5 || uOpacity < 0.5) discard;
  gl_FragColor = vec4(c.rgb * uTint, 1.0);
  ${normalOutputChunk(false, 0)}
}`;
// Muzzle flash: unlit (it *is* the light).
const FRAG_FLASH = FRAG.replace('c.rgb * uTint', 'c.rgb * 2.2');

const SKIN = '#c8946c', SKIN_DARK = '#8a5a3c', SKIN_LIGHT = '#e0b48c', OUTLINE = '#1a1210';
const SLEEVE = '#3c4250', SLEEVE_DARK = '#262a34';

interface Part {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  /** canvas size in low-res pixels */
  w: number;
  h: number;
  /** muzzle point relative to the pivot, low-res pixels (x right, y up) */
  muzzle: THREE.Vector2;
}

/** Pixel data of a TileFrame (any source), via its page image and UV rect. */
function frameCanvas(f: TileFrame): HTMLCanvasElement | null {
  const img = f.texture.image as (CanvasImageSource & { width: number; height: number; data?: Uint8Array }) | undefined;
  if (!img || !img.width) return null;
  const W = img.width, H = img.height;
  const x = Math.round(f.uv[0] * W), w = Math.round((f.uv[2] - f.uv[0]) * W);
  if (img.data) {
    // DataTexture page (procedural source): raw RGBA rows, bottom-up (v0 = row 0)
    const h = Math.round((f.uv[3] - f.uv[1]) * H), top = Math.round(f.uv[3] * H) - 1;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const out = ctx.createImageData(w, h);
    for (let iy = 0; iy < h; iy++) out.data.set(img.data.subarray(((top - iy) * W + x) * 4, ((top - iy) * W + x + w) * 4), iy * w * 4);
    ctx.putImageData(out, 0, 0);
    return c;
  }
  // three.js flips images on upload, so v1 (top in UV space) is row 0 of the image
  const y = Math.round((f.texture.flipY ? 1 - f.uv[3] : f.uv[1]) * H), h = Math.round((f.uv[3] - f.uv[1]) * H);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
  return c;
}

/** Crop to opaque pixels; optionally mirror horizontally. */
function cropOpaque(src: HTMLCanvasElement, mirror: boolean): HTMLCanvasElement {
  const ctx = src.getContext('2d', { willReadFrequently: true })!;
  const d = ctx.getImageData(0, 0, src.width, src.height).data;
  let x0 = src.width, y0 = src.height, x1 = -1, y1 = -1;
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++)
      if (d[(y * src.width + x) * 4 + 3] > 64) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
  if (x1 < 0) return src;
  const c = document.createElement('canvas');
  c.width = x1 - x0 + 1;
  c.height = y1 - y0 + 1;
  const o = c.getContext('2d')!;
  if (mirror) { o.translate(c.width, 0); o.scale(-1, 1); }
  o.drawImage(src, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}

function px(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, w = 1, h = 1): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}


function paint(ctx: CanvasRenderingContext2D, rows: string[], col: Record<string, string>, x = 0, y = 0): void {
  rows.forEach((r, j) => [...r].forEach((ch, i) => { if (col[ch]) px(ctx, col[ch], x + i, y + j); }));
}

// Right fist seen from behind: four finger segments on top, thumb wrapped across the front.
const FIST = [
  '..OOOOOOOO..',
  '.OLLOLLOLLO.',
  'OLSSOSSOSSDO',
  'OSSSOSSOSSDO',
  'OSDDODDODDDO',
  'OSSSSSSSSSDO',
  'OOOOSSSSSSDO',
  'OLLLLOSSSSDO',
  'OSSSSSOSSDDO',
  '.OSSSSSODDO.',
  '..OSSDDDDO..',
  '...OOOOOO...',
];
const FIST_COL: Record<string, string> = { O: OUTLINE, S: SKIN, D: SKIN_DARK, L: SKIN_LIGHT };
const FIST_W = 12, FIST_H = 12;

/** Sleeve from (x0,y0) toward (x1,y1): thick outlined line, in hand pixels. */
function drawSleeve(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, thick: number): void {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (const [color, t] of [[OUTLINE, thick + 2], [SLEEVE_DARK, thick], [SLEEVE, thick - 3]] as const) {
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
      px(ctx, color, x - t / 2, y - t / 2, t, t);
    }
  }
}

/** Fist + sleeve running off to the lower right, in hand pixels; fist centre at (6, 6). */
function handCanvas(arm: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = FIST_W + arm;
  c.height = FIST_H + arm;
  const ctx = c.getContext('2d')!;
  drawSleeve(ctx, 8, 9, c.width + 4, c.height + 4, 8);
  paint(ctx, FIST, FIST_COL);
  return c;
}

const FLASH = [
  '.....Y.....',
  '..Y..Y..Y..',
  '...YOWOY...',
  '....WWW....',
  '.YOWWWWWOY.',
  'YYWWWWWWWYY',
  '.YOWWWWWOY.',
  '....WWW....',
  '...YOWOY...',
  '..Y..Y..Y..',
  '.....Y.....',
];

/** Nearest-neighbour upscale of a canvas by an integer factor. */
function upscale(src: HTMLCanvasElement, k: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width * k;
  c.height = src.height * k;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

const ease = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Piecewise pose keys: [t, dx, dy, rot, visible]; eased between keys. */
type Key = [number, number, number, number, number];
function pose(keys: Key[], t: number): { dx: number; dy: number; rot: number; vis: boolean } {
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1][0] <= t) i++;
  const a = keys[i], b = keys[i + 1];
  const k = ease(Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0] || 1))));
  return { dx: lerp(a[1], b[1], k), dy: lerp(a[2], b[2], k), rot: lerp(a[3], b[3], k), vis: (k < 0.5 ? a[4] : b[4]) > 0 };
}

// Offsets as fractions of the low-res height (x right, y up), rotation in radians
// (positive = counter-clockwise, i.e. the head of a weapon swings left).
const ANIMS: Record<AttackKind, { dur: number; keys: Key[] }> = {
  melee: { dur: 0.42, keys: [[0, 0, 0, 0, 1], [0.22, 0.05, 0.03, -0.35, 1], [0.48, -0.32, 0.05, 0.4, 1], [0.62, -0.3, 0.04, 0.38, 1], [1, 0, 0, 0, 1]] },
  fire: { dur: 0.22, keys: [[0, 0, 0, 0, 1], [0.12, 0.03, 0.05, 0.14, 1], [1, 0, 0, 0, 1]] },
  // Wide arc (AoE techniques): wind up far right, carry the swing across the whole view.
  sweep: { dur: 0.55, keys: [[0, 0, 0, 0, 1], [0.2, 0.14, 0.02, -0.55, 1], [0.55, -0.5, 0.06, 0.75, 1], [0.7, -0.52, 0.05, 0.72, 1], [1, 0, 0, 0, 1]] },
  throw: { dur: 0.55, keys: [[0, 0, 0, 0, 1], [0.3, 0.05, -0.06, -0.35, 1], [0.5, -0.2, 0.22, 0.6, 1], [0.52, -0.2, 0.22, 0.6, 0], [0.62, 0, -0.45, 0, 0], [0.63, 0, -0.45, 0, 1], [1, 0, 0, 0, 1]] },
};
// Block: raise the weapon across the body and hold it briefly.
const BLOCK: Key[] = [[0, 0, 0, 0, 1], [0.25, -0.12, 0.2, 0.5, 1], [0.7, -0.12, 0.2, 0.5, 1], [1, 0, 0, 0, 1]];
const BLOCK_FISTS: Key[] = [[0, 0, 0, 0, 1], [0.25, -0.1, 0.18, 0, 1], [0.7, -0.1, 0.18, 0, 1], [1, 0, 0, 0, 1]];
const PUNCH: Key[] = [[0, 0, 0, 0, 1], [0.35, -0.13, 0.16, 0, 1], [0.55, -0.12, 0.15, 0, 1], [1, 0, 0, 0, 1]];

export type SwingStyle = 'swing' | 'thrust' | 'punch';

/** Phase lengths (s) of a feel-layer swing; contact = windup + strike. */
export interface SwingPhases {
  windup: number;
  strike: number;
  follow: number;
  recovery: number;
  style: SwingStyle;
}

/** Poses [dx, dy, rot] per swing style: anticipation (wound up), contact, follow-through. */
const SWING_POSES: Record<SwingStyle, { wind: [number, number, number]; contact: [number, number, number]; follow: [number, number, number] }> = {
  // Weapon cocked back over the right shoulder, whips across to the left.
  swing: { wind: [0.12, 0.07, -0.7], contact: [-0.2, 0.07, 0.28], follow: [-0.4, 0.0, 0.7] },
  // Pull back and down, then drive straight into the centre of the view.
  thrust: { wind: [0.07, -0.1, -0.12], contact: [-0.16, 0.16, 0.08], follow: [-0.18, 0.17, 0.1] },
  // Fist drawn back low, then punched to the crosshair.
  punch: { wind: [0.05, -0.07, 0], contact: [-0.14, 0.17, 0], follow: [-0.13, 0.16, 0] },
};
// Guard: weapon raised across the body / both fists up.
const GUARD_POSE: [number, number, number] = [-0.14, 0.2, 0.55];
const GUARD_FISTS: [number, number, number] = [-0.1, 0.17, 0];

/**
 * Keys (normalised to 0..1) for a phased swing, starting from the pose the hands are in now so
 * back-to-back swings and guard-to-swing never pop. Contact sits exactly at windup + strike.
 */
export function swingKeys(ph: SwingPhases, from: [number, number, number] = [0, 0, 0]): { keys: Key[]; dur: number } {
  const P = SWING_POSES[ph.style];
  const dur = ph.windup + ph.strike + ph.follow + ph.recovery;
  const at = (s: number) => s / dur;
  return {
    dur,
    keys: [
      [0, from[0], from[1], from[2], 1],
      [at(ph.windup), ...P.wind, 1],
      [at(ph.windup + ph.strike), ...P.contact, 1],
      [at(ph.windup + ph.strike + ph.follow), ...P.follow, 1],
      [1, 0, 0, 0, 1],
    ],
  };
}

export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);
  /** Light on the hands (linear RGB), set by the renderer from the light map. */
  readonly tint = new THREE.Color(1, 1, 1);
  enabled = true;
  private weapon: Part | null = null;
  private fists: [Part, Part] | null = null;
  private flash: Part | null = null;
  private itemKey = '';
  private handKey = -1;
  /** `contact`: normalised time of the swing's contact pose (hit-stop snaps to it). */
  private anim: { kind: AttackKind; t: number; dur: number; keys: Key[]; hand: 0 | 1 | 2; contact?: number } | null = null;
  /** Hold the current animation at its t (tests/screenshots). */
  private frozen = false;
  private punchHand: 0 | 1 = 1;
  private bobPhase = 0;
  private bobAmp = 0;
  private lastX = NaN;
  private lastY = NaN;
  private flashT = 0;
  private sway = 0;
  private lastYaw = NaN;
  /** Hit-stop: seconds the current animation holds its pose. */
  private holdT = 0;
  private guardOn = false;
  private guardBlend = 0;
  /** Aim down sights (RMB with a gun): the gun eases toward the centre of the view. */
  ads = false;
  /**
   * Free aim (src/game/aimmodel.ts): where the reticle sits, low-res pixels from the centre (x
   * right, y up). The gun (at the hip and down the sights) and a drawn bow follow it fully, so the
   * weapon visibly points where the shot will go. Set every frame by src/aim.ts.
   */
  readonly aimPx = { x: 0, y: 0 };
  private adsBlend = 0;
  /** Knock from being hit: offset (fractions of the screen height) that springs back. */
  private joltX = 0;
  private joltY = 0;
  /** The weapon hand's pose last frame, so a new animation starts where the hands are. */
  private lastPose: [number, number, number] = [0, 0, 0];
  /** Brief light for muzzle flashes (renderer wires this to a mode:'point' light). */
  onMuzzleFlash: ((seconds: number) => void) | null = null;
  /**
   * Draw state of a bow / slingshot / sling (PlayerCombat.bowPose, wired by feel.ts): bows and
   * slingshots are drawn procedurally (render/bowArt.ts) instead of the item icon held like a gun.
   */
  bowSource: (() => BowPose | null) | null = null;
  private bow: { key: string; part: Part; tex: THREE.CanvasTexture[]; meta: { grip: { x: number; y: number }; head: { x: number; y: number } }[] } | null = null;
  /** Release kick of a bow (s left), and a displayed draw that eases (the string snaps back fast). */
  private bowKick = 0;
  private bowDraw = 0;
  private shakeT = 0;

  constructor() {
    this.scene.name = 'viewmodel';
  }

  /** Canvas in low-res pixels; (gx, gy) = pivot pixel from the top-left. */
  private makePart(c: HTMLCanvasElement, gx: number, gy: number, mirror = false, frag = FRAG): Part {
    const tex = new THREE.CanvasTexture(c);
    setupPixelTexture(tex);
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0.5 - gx / c.width, -0.5 + gy / c.height, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: frag,
      uniforms: { map: { value: tex }, uTint: { value: this.tint }, uOpacity: { value: 1 } },
      depthTest: true, depthWrite: true, side: THREE.DoubleSide,
    });
    (mat.userData as any).mrt = true;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.scale.set((mirror ? -1 : 1) * c.width, c.height, 1);
    this.scene.add(mesh);
    return { mesh, mat, w: c.width, h: c.height, muzzle: new THREE.Vector2() };
  }

  private disposePart(p: Part | null): void {
    if (!p) return;
    this.scene.remove(p.mesh);
    p.mesh.geometry.dispose();
    (p.mat.uniforms.map.value as THREE.Texture).dispose();
    p.mat.dispose();
  }

  /** Start an attack animation. Melee with bare hands alternates fists. */
  attack(kind: AttackKind): void {
    this.frozen = false;
    if (!this.itemKey && kind === 'melee') {
      this.punchHand = this.punchHand === 1 ? 0 : 1;
      this.anim = { kind, t: 0, dur: 0.3, keys: PUNCH, hand: this.punchHand };
      return;
    }
    const a = ANIMS[kind];
    this.anim = { kind, t: 0, dur: a.dur, keys: a.keys, hand: 1 };
    if (kind === 'fire') {
      this.flashT = 0.06;
      this.onMuzzleFlash?.(0.08);
    }
  }

  /**
   * A phase-timed swing (combat feel layer): anticipation over `windup`, the fast strike so the
   * contact pose lands at windup + strike (when the blow resolves), follow-through, recovery.
   * Bare hands punch, alternating fists.
   */
  swing(ph: SwingPhases): void {
    this.frozen = false;
    this.holdT = 0;
    const fists = !this.itemKey;
    const style: SwingStyle = fists ? 'punch' : ph.style;
    if (fists) this.punchHand = this.punchHand === 1 ? 0 : 1;
    const from: [number, number, number] = fists ? [0, 0, 0] : this.lastPose;
    const { keys, dur } = swingKeys({ ...ph, style }, from);
    this.anim = { kind: 'melee', t: 0, dur, keys, hand: fists ? this.punchHand : 1, contact: keys[2][0] };
  }

  /**
   * Hit-stop: hold the contact pose for `seconds` (the blow connected). The simulation resolves
   * on its 30 Hz tick and the hands may be a frame short of contact then, so snap to it.
   */
  impact(seconds: number): void {
    const a = this.anim;
    if (a?.contact !== undefined && a.t < a.contact) a.t = a.contact;
    this.holdT = Math.max(this.holdT, seconds);
  }

  /** Raise (or lower) the guard; held until released, a swing takes precedence while it plays. */
  setGuard(on: boolean): void {
    this.guardOn = on;
  }

  /** Gun kick scaled by the shot's recoil (1 = a typical pistol round). */
  recoil(k: number, o: { flash?: boolean; cls?: string } = {}): void {
    this.frozen = false;
    // A drawn bow/slingshot: the string snaps forward and the bow jumps in the hand.
    if (this.bow && this.bowSource?.()?.style === 'draw') {
      this.bowKick = 0.22;
      this.bowDraw = 0;
      return;
    }
    // A sling: the whirling hand throws forward.
    if (o.cls === 'sling') {
      this.attack('throw');
      return;
    }
    const a = Math.max(0.15, Math.min(2.2, k));
    this.anim = {
      kind: 'fire', t: 0, dur: 0.16 + 0.08 * a, hand: 1,
      keys: [[0, 0, 0, 0, 1], [0.1, 0.02 * a, 0.045 * a, 0.12 * a, 1], [0.35, 0.012 * a, 0.03 * a, 0.07 * a, 1], [1, 0, 0, 0, 1]],
    };
    // Only burning powder flashes (rangedfeel.hasMuzzleFlash): a crossbow or air rifle just kicks.
    if (o.flash === false) return;
    this.flashT = 0.06;
    this.onMuzzleFlash?.(0.08);
  }

  /** Knock the hands (you got hit): `side` -1 left .. 1 right, `amount` 0..1. */
  jolt(side: number, amount: number): void {
    const k = Math.max(0, Math.min(1, amount));
    this.joltX += side * 0.05 * k;
    this.joltY -= 0.06 * k;
  }

  /** Lower the gun out of view and bring it back over the reload time. */
  reload(seconds: number, how: 'dip' | 'crank' = 'dip'): void {
    this.frozen = false;
    const d = Math.max(0.35, seconds);
    if (how === 'crank') {
      // A crossbow tipped nose-down and cranked: the stock rocks with each turn of the handle.
      const keys: Key[] = [[0, 0, 0, 0, 1], [0.15, 0.02, -0.16, 0.9, 1]];
      const turns = Math.max(3, Math.round(d * 4));
      for (let i = 1; i <= turns; i++) keys.push([0.15 + (0.7 * i) / turns, 0.02 + (i % 2 ? 0.015 : -0.01), -0.16 + (i % 2 ? -0.02 : 0.015), 0.9, 1]);
      keys.push([1, 0, 0, 0, 1]);
      this.anim = { kind: 'fire', t: 0, dur: d, hand: 1, keys };
      return;
    }
    this.anim = { kind: 'fire', t: 0, dur: d, hand: 1, keys: [[0, 0, 0, 0, 1], [0.22, 0.05, -0.3, -0.45, 1], [0.78, 0.05, -0.3, -0.45, 1], [1, 0, 0, 0, 1]] };
  }

  /** Pre-render the drawn weapon's stages (bowArt.ts) for this low-res height. */
  private buildBow(kind: DrawnKind, lowH: number): void {
    const key = `${kind}:${lowH}`;
    if (this.bow?.key === key) return;
    this.disposeBow();
    // Smaller hands than the gun grip: a bow is held at arm's length, and a big fist would hide the arrowhead.
    const hs = Math.max(2, Math.round(Viewmodel.handScale(lowH) * 0.6));
    const hand = upscale(handCanvas(18), hs);
    const tex: THREE.CanvasTexture[] = [];
    const meta: { grip: { x: number; y: number }; head: { x: number; y: number } }[] = [];
    let part: Part | null = null;
    for (const nocked of [true, false]) {
      for (let i = 0; i < BOW_STAGES; i++) {
        const f = bowFrame(kind, lowH, i / (BOW_STAGES - 1), nocked, hand, hs);
        if (!part) part = this.makePart(f.canvas, f.grip.x, f.grip.y);
        const t = i === 0 && nocked ? (part.mat.uniforms.map.value as THREE.CanvasTexture) : new THREE.CanvasTexture(f.canvas);
        if (t !== part.mat.uniforms.map.value) setupPixelTexture(t);
        tex.push(t);
        meta.push({ grip: f.grip, head: f.head });
      }
    }
    this.bow = { key, part: part!, tex, meta };
  }

  private disposeBow(): void {
    if (!this.bow) return;
    const shown = this.bow.part.mat.uniforms.map.value;
    for (const t of this.bow.tex) if (t !== shown) t.dispose();
    this.disposePart(this.bow.part);
    this.bow = null;
  }

  /**
   * A drawn weapon, per frame: canted low at rest, rising as the draw grows until at full draw
   * the arrowhead sits just under the crosshair; a shake when the arms tire; a jump on release.
   */
  private placeBow(dt: number, pose: BowPose, lowW: number, lowH: number, bobX: number, bobY: number): void {
    const b = this.bow!;
    // The string follows the draw; after a release it snaps back at once (bowDraw was zeroed).
    this.bowDraw += (pose.draw - this.bowDraw) * Math.min(1, dt * 18);
    if (pose.draw < this.bowDraw) this.bowDraw = pose.draw;
    this.bowKick = Math.max(0, this.bowKick - dt);
    const d = this.bowDraw;
    const stage = Math.round(d * (BOW_STAGES - 1));
    const idx = (pose.nocked && this.bowKick <= 0.12 ? 0 : BOW_STAGES) + stage;
    b.part.mat.uniforms.map.value = b.tex[idx];
    const m = b.meta[idx];
    const rot = -0.2 * (1 - d) - 0.04 * d;
    // Where the grip goes so the arrowhead meets the crosshair (just under it) at full draw.
    const hx = m.head.x - m.grip.x, hy = -(m.head.y - m.grip.y);
    const c = Math.cos(rot), s = Math.sin(rot);
    const aimX = lowW * 0.5 - lowH * 0.015 - (hx * c - hy * s), aimY = lowH * 0.5 - lowH * 0.04 - (hx * s + hy * c);
    const restX = lowW * 0.5 - lowH * 0.16, restY = lowH * 0.36;
    this.shakeT += dt;
    const shake = pose.shake * lowH * 0.006;
    const kick = this.bowKick > 0 ? Math.sin((this.bowKick / 0.22) * Math.PI) * lowH * 0.025 : 0;
    // bobX/bobY already carry the knock from being hit (jolt).
    const x = restX + (aimX - restX) * ease(d) + (bobX + this.sway) * lowH * (1 - 0.7 * d) + Math.sin(this.shakeT * 37) * shake + this.aimPx.x;
    const y = restY + (aimY - restY) * ease(d) + bobY * lowH * (1 - 0.7 * d) + Math.cos(this.shakeT * 29) * shake + kick + this.aimPx.y;
    b.part.mesh.visible = this.enabled;
    b.part.mesh.position.set(Math.round(x), Math.round(y), 0);
    b.part.mesh.rotation.z = rot - (this.bowKick > 0 ? 0.05 * Math.sin((this.bowKick / 0.22) * Math.PI) : 0);
  }

  /** Raise the weapon (or both fists) to block; never cuts a swing short. */
  block(): void {
    if (this.frozen || (this.anim && this.anim.t < 0.9)) return;
    // Bare hands: both fists come up (hand 2 = both).
    this.anim = this.itemKey
      ? { kind: 'melee', t: 0, dur: 0.4, keys: BLOCK, hand: 1 }
      : { kind: 'melee', t: 0, dur: 0.4, keys: BLOCK_FISTS, hand: 2 };
  }

  /** Debug/screenshots: show an attack pose frozen at t (0..1); `null` releases it. */
  freeze(kind: AttackKind | null, t = 0.5): void {
    if (!kind) { this.frozen = false; this.anim = null; this.flashT = 0; return; }
    this.attack(kind);
    this.anim!.t = t;
    if (kind === 'fire') this.flashT = 1e9;
    this.frozen = true;
  }

  /** Hand pixel size for a low-res height. */
  private static handScale(lowH: number): number {
    return Math.max(2, Math.round(lowH / 80));
  }

  private buildHands(lowH: number): void {
    this.disposePart(this.fists?.[0] ?? null);
    this.disposePart(this.fists?.[1] ?? null);
    this.disposePart(this.flash);
    const s = Viewmodel.handScale(lowH);
    const hand = upscale(handCanvas(26), s);
    this.fists = [this.makePart(hand, 6 * s, 6 * s, true), this.makePart(hand, 6 * s, 6 * s)];
    const fl = document.createElement('canvas');
    fl.width = fl.height = 11;
    paint(fl.getContext('2d')!, FLASH, { Y: '#ffb030', O: '#ffd060', W: '#fff4d0' });
    this.flash = this.makePart(upscale(fl, s), Math.floor(5.5 * s), Math.floor(5.5 * s), false, FRAG_FLASH);
    this.flash.mesh.renderOrder = 2;
    this.handKey = lowH;
  }

  /** Build the weapon part for an item (null = bare hands), at low-res pixel size. */
  private setItem(item: ViewmodelItem | null, frameOf: (id: string) => TileFrame, lowH: number): void {
    this.disposePart(this.weapon);
    this.weapon = null;
    if (!item) return;
    const raw = frameCanvas(frameOf(item.typeId));
    if (!raw) return;
    const gun = !!item.isGun?.();
    // UltiCa draws items pointing right (handle/grip left); mirror so they point up-left
    // from the lower-right hand.
    const crop = cropOpaque(raw, true);
    const d = crop.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, crop.width, crop.height).data;
    // Grip: the bottom-right-most opaque pixel (handles/pistol grips sit there once the
    // sprite is oriented), nudged a little into the item. Muzzle: the left-most pixel.
    let gx = 0, gy = 0, best = -1, mx = crop.width, my = 0;
    for (let y = 0; y < crop.height; y++)
      for (let x = 0; x < crop.width; x++) {
        if (d[(y * crop.width + x) * 4 + 3] <= 64) continue;
        if (x + y > best) { best = x + y; gx = x; gy = y; }
        if (x < mx) { mx = x; my = y; }
      }
    const inset = gun ? 1 : Math.max(1, Math.round(Math.min(crop.width, crop.height) * 0.15));
    gx = Math.max(0, gx - inset);
    gy = Math.max(0, gy - inset);
    // Items are scaled so they read at a similar size whatever their sprite footprint; the
    // hand keeps its own (usually smaller) integer pixel size.
    const hs = Viewmodel.handScale(lowH);
    const extent = heldItemExtent(item.def, Math.min(crop.width, crop.height) / Math.max(crop.width, crop.height));
    const is = Math.max(hs, Math.min(9, Math.round((lowH * extent) / Math.max(crop.width, crop.height))));
    const item2 = upscale(crop, is);
    const hand = upscale(handCanvas(40), hs);
    const G = { x: gx * is + Math.floor(is / 2), y: gy * is + Math.floor(is / 2) };
    const hx = G.x - 6 * hs, hy = G.y - 6 * hs;
    const ox = Math.max(0, -hx), oy = Math.max(0, -hy);
    const c = document.createElement('canvas');
    c.width = ox + Math.max(item2.width, hx + hand.width);
    c.height = oy + Math.max(item2.height, hy + hand.height);
    const ctx = c.getContext('2d')!;
    // sleeve under the item, fist over it: draw the hand, the item, then the fist again
    ctx.drawImage(hand, ox + hx, oy + hy);
    ctx.drawImage(item2, ox, oy);
    ctx.drawImage(hand, 0, 0, FIST_W * hs, FIST_H * hs, ox + hx, oy + hy, FIST_W * hs, FIST_H * hs);
    this.weapon = this.makePart(c, ox + G.x, oy + G.y);
    this.weapon.muzzle.set(mx * is - G.x, G.y - (my * is + is / 2));
  }

  /**
   * Per frame. `wielded` is the player's wielded item (or null), px/py the player position
   * (drives walking bob), yaw for a small look sway, lowW/lowH the low-res target size.
   */
  update(dt: number, wielded: ViewmodelItem | null, px: number, py: number, yaw: number,
    lowW: number, lowH: number, frameOf: (id: string) => TileFrame): void {
    if (this.handKey !== lowH) {
      this.buildHands(lowH);
      this.itemKey = '\0'; // rebuild the weapon at the new size too
    }
    const key = wielded ? wielded.typeId : '';
    if (key !== this.itemKey) {
      this.itemKey = key;
      this.setItem(wielded, frameOf, lowH);
      if (!this.frozen) this.anim = null;
    }
    const cam = this.camera;
    cam.left = 0; cam.right = lowW; cam.bottom = 0; cam.top = lowH;
    cam.updateProjectionMatrix();

    const moved = Number.isNaN(this.lastX) ? 0 : Math.hypot(px - this.lastX, py - this.lastY);
    this.lastX = px; this.lastY = py;
    const speed = dt > 0 ? moved / dt : 0;
    this.bobAmp += (Math.min(speed / 3, 1.4) - this.bobAmp) * Math.min(1, dt * 8);
    this.bobPhase += moved * 2.4;
    const dyaw = Number.isNaN(this.lastYaw) ? 0 : Math.atan2(Math.sin(yaw - this.lastYaw), Math.cos(yaw - this.lastYaw));
    this.lastYaw = yaw;
    // Hands lag behind fast turns a little (sway), then settle.
    this.sway += (-dyaw * 4 - this.sway) * Math.min(1, dt * 10);
    this.sway = Math.max(-0.06, Math.min(0.06, this.sway));

    if (this.anim && !this.frozen) {
      if (this.holdT > 0) this.holdT = Math.max(0, this.holdT - dt);
      else this.anim.t += dt / this.anim.dur;
      if (this.anim.t >= 1) this.anim = null;
    }
    if (!this.frozen) this.flashT = Math.max(0, this.flashT - dt);
    this.guardBlend += ((this.guardOn ? 1 : 0) - this.guardBlend) * Math.min(1, dt * 16);
    this.adsBlend += ((this.ads && wielded?.isGun?.() ? 1 : 0) - this.adsBlend) * Math.min(1, dt * 12);
    const spring = Math.min(1, dt * 9);
    this.joltX -= this.joltX * spring;
    this.joltY -= this.joltY * spring;

    // bob and animation offsets are fractions of the screen height
    // Aiming down the sights steadies the hands: less bob and sway.
    const steady = 1 - 0.7 * this.adsBlend;
    const bobX = Math.cos(this.bobPhase) * this.bobAmp * 0.025 * steady + this.joltX;
    const bobY = -Math.abs(Math.sin(this.bobPhase)) * this.bobAmp * 0.025 * steady + this.joltY;
    const vis = this.enabled;
    const place = (p: Part, x: number, y: number, rot: number, shown: boolean) => {
      p.mesh.visible = vis && shown;
      // whole low-res pixels, so sprite texels never straddle pixel boundaries
      p.mesh.position.set(Math.round(x), Math.round(y), 0);
      p.mesh.rotation.z = rot;
    };

    const [fl, fr] = this.fists!;
    const g = this.guardBlend;
    // Bows and slingshots: the procedural drawn weapon instead of the icon held like a gun.
    const bowPose = wielded ? this.bowSource?.() ?? null : null;
    const drawn: DrawnKind | null = bowPose?.style === 'draw' ? (bowPose.cls === 'bow' ? 'bow' : 'slingshot') : null;
    if (drawn) {
      this.buildBow(drawn, lowH);
      if (this.weapon) this.weapon.mesh.visible = false;
      fl.mesh.visible = fr.mesh.visible = false;
      this.flash!.mesh.visible = false;
      this.placeBow(dt, bowPose!, lowW, lowH, bobX, bobY);
      return;
    }
    if (this.bow) this.bow.part.mesh.visible = false;
    // A sling whirls overhead while the release builds (the hand circles, the sling spins).
    if (bowPose?.style === 'whirl' && bowPose.whirl > 0 && this.weapon && !this.anim) {
      const w = bowPose.whirl * 15;
      const wx = lowW * 0.5 + lowH * (0.3 + Math.cos(w) * 0.05 + bobX);
      const wy = lowH * (0.3 + Math.sin(w) * 0.05 + bobY);
      place(this.weapon, wx, wy, w, true);
      fl.mesh.visible = fr.mesh.visible = false;
      this.flash!.mesh.visible = false;
      return;
    }
    if (this.weapon) {
      const a = this.anim ? pose(this.anim.keys, this.anim.t) : { dx: GUARD_POSE[0] * g, dy: GUARD_POSE[1] * g, rot: GUARD_POSE[2] * g, vis: true };
      this.lastPose = [a.dx, a.dy, a.rot];
      // ADS: the gun comes in toward the centre and up so the muzzle sits just under the crosshair.
      const ads = this.adsBlend;
      const gx = lowW * 0.5 + lowH * ((0.42 - 0.3 * ads) + (bobX + this.sway) * steady + a.dx) + this.aimPx.x;
      const gy = lowH * (0.22 + 0.07 * ads + bobY + a.dy) + this.aimPx.y;
      place(this.weapon, gx, gy, a.rot, a.vis);
      fl.mesh.visible = fr.mesh.visible = false;
      const m = this.weapon.muzzle.clone().rotateAround(new THREE.Vector2(), a.rot);
      place(this.flash!, gx + m.x, gy + m.y, 0, this.flashT > 0);
    } else {
      for (let hand = 0; hand < 2; hand++) {
        const a = this.anim && (this.anim.hand === hand || this.anim.hand === 2)
          ? pose(this.anim.keys, this.anim.t)
          : { dx: GUARD_FISTS[0] * g, dy: GUARD_FISTS[1] * g, rot: 0, vis: true };
        const side = hand === 1 ? 1 : -1;
        const x = lowW * 0.5 + lowH * (side * (0.36 + bobX + a.dx) + this.sway);
        const y = lowH * (0.14 + bobY * (hand ? 1 : 0.8) + a.dy);
        place(this.fists![hand], x, y, 0, true);
      }
      this.flash!.mesh.visible = false;
    }
  }

  get animating(): boolean {
    return this.anim !== null;
  }
}
