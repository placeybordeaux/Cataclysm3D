import * as THREE from 'three';
import { setupPixelTexture } from './atlas';
import { normalOutputChunk } from './materials';
import type { TileFrame } from './textureSource';

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

export type AttackKind = 'melee' | 'fire' | 'throw';

export interface ViewmodelItem {
  typeId: string;
  isGun?(): boolean;
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
  throw: { dur: 0.55, keys: [[0, 0, 0, 0, 1], [0.3, 0.05, -0.06, -0.35, 1], [0.5, -0.2, 0.22, 0.6, 1], [0.52, -0.2, 0.22, 0.6, 0], [0.62, 0, -0.45, 0, 0], [0.63, 0, -0.45, 0, 1], [1, 0, 0, 0, 1]] },
};
const PUNCH: Key[] = [[0, 0, 0, 0, 1], [0.35, -0.13, 0.16, 0, 1], [0.55, -0.12, 0.15, 0, 1], [1, 0, 0, 0, 1]];

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
  private anim: { kind: AttackKind; t: number; dur: number; keys: Key[]; hand: 0 | 1 } | null = null;
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
  /** Brief light for muzzle flashes (renderer wires this to a mode:'point' light). */
  onMuzzleFlash: ((seconds: number) => void) | null = null;

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
    const is = Math.max(hs, Math.min(9, Math.round((lowH * 0.4) / Math.max(crop.width, crop.height))));
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
      this.anim.t += dt / this.anim.dur;
      if (this.anim.t >= 1) this.anim = null;
    }
    if (!this.frozen) this.flashT = Math.max(0, this.flashT - dt);

    // bob and animation offsets are fractions of the screen height
    const bobX = Math.cos(this.bobPhase) * this.bobAmp * 0.025;
    const bobY = -Math.abs(Math.sin(this.bobPhase)) * this.bobAmp * 0.025;
    const vis = this.enabled;
    const place = (p: Part, x: number, y: number, rot: number, shown: boolean) => {
      p.mesh.visible = vis && shown;
      // whole low-res pixels, so sprite texels never straddle pixel boundaries
      p.mesh.position.set(Math.round(x), Math.round(y), 0);
      p.mesh.rotation.z = rot;
    };

    const [fl, fr] = this.fists!;
    if (this.weapon) {
      const a = this.anim ? pose(this.anim.keys, this.anim.t) : { dx: 0, dy: 0, rot: 0, vis: true };
      const gx = lowW * 0.5 + lowH * (0.42 + bobX + this.sway + a.dx);
      const gy = lowH * (0.22 + bobY + a.dy);
      place(this.weapon, gx, gy, a.rot, a.vis);
      fl.mesh.visible = fr.mesh.visible = false;
      const m = this.weapon.muzzle.clone().rotateAround(new THREE.Vector2(), a.rot);
      place(this.flash!, gx + m.x, gy + m.y, 0, this.flashT > 0);
    } else {
      for (let hand = 0; hand < 2; hand++) {
        const a = this.anim && this.anim.hand === hand ? pose(this.anim.keys, this.anim.t) : { dx: 0, dy: 0, rot: 0, vis: true };
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
