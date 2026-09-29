import * as THREE from 'three';
import type { GameEvents } from '../core/events';
import type { Game } from '../game/game';
import type { Monster } from '../game/monster';
import { LEVEL_HEIGHT } from '../world/coords';
import type { MonsterView } from './monsterView';
import type { Renderer } from './renderer';
import type { SpriteHandle } from './sprites';
import type { TileFrame } from './textureSource';

// Hit feedback for the survivor's attacks (the `playerAttack` event from playercombat.ts):
//  - a burst of single-pixel "impact" particles at the hit point: blood in the target's
//    CDDA blood colour, sparks off metal/robots, a puff of dust where a bullet hits a wall
//  - a brief white flash on the target sprite (the red hurt flash follows it)
//  - a visual stagger on every damaging hit, scaled by the blow's share of max HP (MonsterView.kick)
//  - a bigger spray on kills and a splash where the body lands (MonsterView.onBodyLanded)
//  - gun tracers (a dotted pixel line for a frame or two) and bullet marks where rounds hit walls
// Particles are sized to stay 2–4 low-res pixels on screen whatever their distance, so they
// read as pixel-art spatter rather than modern-shooter decals.

type AttackEvent = GameEvents['playerAttack'];

/** CDDA field colours: fd_blood red, fd_bile/acid green-yellow, veggy green, insect olive. */
const BLOOD: Record<string, number[]> = {
  fd_blood: [0x8a1010, 0xb01818, 0x5a0808],
  fd_bile: [0x7a8a20, 0x5a6a10],
  fd_acid: [0x9aff40, 0x60c020],
  fd_blood_veggy: [0x2a8a2a, 0x1a6a1a],
  fd_blood_insect: [0x7a8a2a, 0x5a6a1a],
  fd_blood_invertebrate: [0x6a7aa0, 0x4a5a80],
};
const SPARKS = [0xffe070, 0xffffff, 0xffa030];
const DUST = [0x9a9080, 0x6a6458, 0xc0b8a8];
const TRACER = [0xfff0b0, 0xffd060];
const HOLE = [0x141210, 0x2a2622];
const PALETTE = [...new Set([...Object.values(BLOOD).flat(), ...SPARKS, ...DUST, ...TRACER, ...HOLE])];

/** Tracer dots live this long (s): one or two frames at 60 fps. */
const TRACER_LIFE = 0.05;
const MAX_MARKS = 60;
const MARK_LIFE = 30;

interface Particle {
  h: SpriteHandle;
  x: number;
  y: number;
  /** metres above the level floor */
  hgt: number;
  /** the sprite's fixed lift (its hgt at creation) */
  lift0: number;
  z: number;
  vx: number;
  vy: number;
  vh: number;
  t: number;
  /** stops when it hits the floor (blood) or fades in the air (sparks, dust) */
  sticky: boolean;
}

const spanCache = new Map<string, { bottom: number; top: number }>();

/**
 * Vertical extent of the opaque pixels of a sprite frame, as fractions of its height from
 * the bottom (0 = bottom edge). Read back once per frame from the atlas page.
 */
export function artSpan(f: TileFrame): { bottom: number; top: number } {
  const key = `${f.texture.uuid}:${f.uv.join(',')}`;
  let r = spanCache.get(key);
  if (r) return r;
  r = { bottom: 0, top: 1 };
  const img = f.texture.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (img && img.width && typeof document !== 'undefined') {
    const [u0, v0, u1, v1] = f.uv;
    const x = Math.round(Math.min(u0, u1) * img.width), w = Math.max(1, Math.round(Math.abs(u1 - u0) * img.width));
    // three.js UVs have v0 at the bottom (flipY): image row = (1 - v) * height.
    const y = Math.round((1 - Math.max(v0, v1)) * img.height), h = Math.max(1, Math.round(Math.abs(v1 - v0) * img.height));
    try {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, x, y, w, h, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h).data;
      let first = -1, last = -1;
      for (let row = 0; row < h; row++)
        for (let col = 0; col < w; col++)
          if (d[(row * w + col) * 4 + 3] > 128) {
            if (first < 0) first = row;
            last = row;
            break;
          }
      if (first >= 0) r = { bottom: 1 - (last + 1) / h, top: 1 - first / h };
    } catch {
      // tainted/unsupported image: assume the art fills the frame
    }
  }
  spanCache.set(key, r);
  return r;
}

const MAX_PARTICLES = 160;
const GRAVITY = 9;

export class HitFx {
  private particles: Particle[] = [];
  private tracerDots: { h: SpriteHandle; t: number }[] = [];
  private marks: { h: SpriteHandle; t: number }[] = [];
  private seenTracers = new WeakSet<object>();
  private tracerSource: (() => readonly { x0: number; y0: number; x1: number; y1: number; z: number }[]) | null = null;
  private frames = new Map<number, TileFrame>();
  private rng = Math.random;

  constructor(private game: Game, private renderer: Renderer, private view: MonsterView | null) {
    this.makePalette();
    game.events.on('playerAttack', (e) => this.onAttack(e));
    renderer.beforeRender.push((dt) => this.update(dt));
  }

  private makePalette(): void {
    const c = document.createElement('canvas');
    c.width = PALETTE.length;
    c.height = 1;
    const g = c.getContext('2d')!;
    PALETTE.forEach((col, i) => {
      g.fillStyle = `#${col.toString(16).padStart(6, '0')}`;
      g.fillRect(i, 0, 1, 1);
    });
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    const n = PALETTE.length;
    // Sample the texel centre only, so nearest filtering can't bleed a neighbour's colour.
    PALETTE.forEach((col, i) => this.frames.set(col, { texture: tex, uv: [(i + 0.25) / n, 0.25, (i + 0.75) / n, 0.75], w: 1, h: 1 }));
  }

  /** Metres of world size that cover `px` low-res pixels at distance `d` metres. */
  private pixelSize(d: number, px: number): number {
    const cam = this.renderer.rig.camera;
    const lowH = (this.renderer as unknown as { pipeline?: { lowH: number } }).pipeline?.lowH ?? 360;
    return (px * 2 * Math.tan((cam.fov * Math.PI) / 360) * Math.max(0.3, d)) / lowH;
  }

  /** Draw gun tracers for new entries of PlayerCombat.tracers (and monster guns sharing it). */
  watchTracers(src: () => readonly { x0: number; y0: number; x1: number; y1: number; z: number }[]): void {
    this.tracerSource = src;
  }

  /** A bullet's path as a dotted line of bright pixels, from just in front of the shooter. */
  tracer(x0: number, y0: number, x1: number, y1: number, z: number): void {
    const cam = this.renderer.rig.camera.position;
    const p = this.game.player;
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 0.5) return;
    const fromPlayer = Math.hypot(x0 - p.x, y0 - p.y) < 0.3;
    // The survivor's rounds leave the muzzle a little under the eye and meet the crosshair.
    const h0 = fromPlayer ? cam.y - z * LEVEL_HEIGHT - 0.3 : 1.2;
    const h1 = fromPlayer ? this.impactHeight(x1, y1, 2.5) : 1.2;
    const start = fromPlayer ? 1.2 : 0.4;
    const n = Math.min(40, Math.floor((len - start) * 4));
    for (let i = 0; i < n; i++) {
      const f = (start + ((len - start) * (i + Math.random() * 0.5)) / n) / len;
      const x = x0 + (x1 - x0) * f, y = y0 + (y1 - y0) * f;
      const d = Math.hypot(x - cam.x, y - cam.z);
      const size = this.pixelSize(d, 1.3);
      const col = TRACER[i % TRACER.length];
      const h = this.renderer.sprites.add({ x, y, z, frame: this.frames.get(col)!, height: size, width: size, anchor: 'center', lift: h0 + (h1 - h0) * f });
      this.tracerDots.push({ h, t: TRACER_LIFE });
    }
  }

  /** A dark bullet mark where a round hit a wall, a hand's width in front of it. */
  private mark(x: number, y: number, z: number): void {
    const p = this.game.player;
    const d0 = Math.hypot(x - p.x, y - p.y) || 1;
    const mx = x - ((x - p.x) / d0) * 0.04, my = y - ((y - p.y) / d0) * 0.04;
    const cam = this.renderer.rig.camera.position;
    const size = this.pixelSize(Math.hypot(mx - cam.x, my - cam.z), 2);
    const h = this.renderer.sprites.add({ x: mx, y: my, z, frame: this.frames.get(HOLE[Math.floor(this.rng() * HOLE.length)])!, height: size, width: size, anchor: 'center', lift: this.impactHeight(x, y, 2.5) });
    this.marks.push({ h, t: MARK_LIFE });
    if (this.marks.length > MAX_MARKS) this.marks.shift()!.h.remove();
  }

  /** Dust (and a little blood) where a falling body lands. */
  bodyLanded(x: number, y: number, z: number, blood: string | null): void {
    this.burst(x, y, z, 0.15, DUST, 6, 1.4, false);
    if (blood) this.burst(x, y, z, 0.2, BLOOD[blood] ?? BLOOD.fd_blood, 6, 1.6, true);
  }

  onAttack(e: AttackEvent): void {
    const m = e.target as Monster | undefined;
    const p = this.game.player;
    if (e.outcome === 'whiff' || e.outcome === 'miss') {
      // Bullets that hit nothing kick up dust where they stopped (and mark the wall); swings
      // through air make none.
      if (e.kind === 'gun') {
        this.burst(e.x, e.y, e.z, this.impactHeight(e.x, e.y, 1.6), DUST, 5, 1.2, false);
        this.mark(e.x, e.y, e.z);
      }
      return;
    }
    if (!m) return;
    const spr = this.view?.spriteOf(m);
    // UltiCa art doesn't fill its frame (a 32x48 zombie is ~29 px tall), so aim for the body.
    const span = spr ? artSpan(spr.frame) : { bottom: 0, top: 1 };
    const top = (spr?.height ?? 1.7) * span.top, bottom = (spr?.height ?? 1.7) * span.bottom;
    const hgt = Math.max(bottom + (top - bottom) * 0.3, this.impactHeight(m.x, m.y, bottom + (top - bottom) * 0.85));
    const view = this.view;
    const crit = e.outcome === 'crit';
    // monai's hurt already flashed it red; a crit flashes white-hot instead so it stands out.
    if (crit) view?.flash(m, 0xfff0c0, 0.1);
    const blood = e.blood ? BLOOD[e.blood] ?? BLOOD.fd_blood : null;
    const metal = m.type.material.some((x) => x === 'steel' || x === 'iron' || x === 'aluminum');
    const cols = blood ?? (metal ? SPARKS : DUST);
    let n = Math.min(14, 3 + Math.round(e.damage / 3));
    if (crit) n += 6;
    if (e.outcome === 'kill') n += 10;
    if (e.outcome === 'block') n = 2;
    this.burst(e.x, e.y, e.z, hgt, cols, n, crit || e.outcome === 'kill' ? 2.4 : 1.6, !!blood, Math.atan2(m.x - p.x, -(m.y - p.y)));
    // Every blow that hurts rocks the target, in proportion to how much of it the blow took.
    if (e.outcome !== 'block' && e.outcome !== 'kill' && e.damage > 0) {
      const share = e.damage / Math.max(1, m.hpMax);
      view?.kick(m, p.x, p.y, Math.max(0.3, Math.min(1.5, share * 4)) * (crit ? 1.3 : 1));
    }
  }

  /** Where on a sprite of height `top` the crosshair ray is, in metres above its floor. */
  private impactHeight(x: number, y: number, top: number): number {
    const cam = this.renderer.rig.camera.position;
    const p = this.game.player;
    const eye = cam.y - p.z * LEVEL_HEIGHT;
    const d = Math.hypot(x - cam.x, y - cam.z);
    const h = eye + Math.tan(p.pitch) * d;
    return Math.max(0.2, Math.min(top, h));
  }

  /** Spray `n` pixels from (x, y, hgt), mostly away from the attacker along `dir` (yaw). */
  private burst(x: number, y: number, z: number, hgt: number, cols: number[], n: number, speed: number, sticky: boolean, dir?: number): void {
    const cam = this.renderer.rig.camera.position;
    const d = Math.hypot(x - cam.x, y - cam.z);
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= MAX_PARTICLES) this.kill(0);
      // Mostly sideways and back toward the camera: spray straight away from the viewer would
      // vanish behind the target's own sprite.
      const a = dir === undefined ? this.rng() * Math.PI * 2 : dir + Math.PI * (0.35 + this.rng() * 1.3) * (this.rng() < 0.5 ? -1 : 1);
      const sp = speed * (0.4 + this.rng() * 0.8);
      const col = cols[Math.floor(this.rng() * cols.length)];
      const size = this.pixelSize(d, 1.5 + this.rng() * 2);
      const h = this.renderer.sprites.add({ x, y, z, frame: this.frames.get(col)!, height: size, width: size, anchor: 'center', lift: hgt });
      this.particles.push({
        h, x, y, z, hgt, lift0: hgt, vx: Math.sin(a) * sp, vy: -Math.cos(a) * sp, vh: (this.rng() - 0.2) * speed * 1.2,
        t: sticky ? 0.7 + this.rng() * 0.4 : 0.25 + this.rng() * 0.25, sticky,
      });
    }
  }

  private kill(i: number): void {
    this.particles[i].h.remove();
    this.particles.splice(i, 1);
  }

  update(dt: number): void {
    for (const t of this.tracerSource?.() ?? []) {
      if (this.seenTracers.has(t)) continue;
      this.seenTracers.add(t);
      this.tracer(t.x0, t.y0, t.x1, t.y1, t.z);
    }
    for (let i = this.tracerDots.length - 1; i >= 0; i--) {
      if ((this.tracerDots[i].t -= dt) > 0) continue;
      this.tracerDots[i].h.remove();
      this.tracerDots.splice(i, 1);
    }
    for (let i = this.marks.length - 1; i >= 0; i--) {
      if ((this.marks[i].t -= dt) > 0) continue;
      this.marks[i].h.remove();
      this.marks.splice(i, 1);
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const q = this.particles[i];
      q.t -= dt;
      if (q.t <= 0) {
        this.kill(i);
        continue;
      }
      if (q.hgt > 0.02) {
        q.x += q.vx * dt;
        q.y += q.vy * dt;
        q.vh -= GRAVITY * dt;
        q.hgt = Math.max(0.02, q.hgt + q.vh * dt);
        q.vx *= 1 - 2 * dt;
        q.vy *= 1 - 2 * dt;
      }
      // Sparks and dust don't land: they wink out a little early instead.
      if (!q.sticky && q.t < 0.08) q.h.setVisible(false);
      // Sprite 'lift' is fixed at creation, so height changes go through z (in levels).
      q.h.set(q.x, q.y, q.z + (q.hgt - q.lift0) / LEVEL_HEIGHT);
    }
  }

  /** Particles alive (tests/debug). */
  get count(): number {
    return this.particles.length;
  }
}
