import * as THREE from 'three';
import type { Game } from '../game/game';
import type { Renderer } from './renderer';
import type { SpriteHandle } from './sprites';
import type { TileFrame } from './textureSource';
import type { LightHandle } from './lights';
import { patchNormalOutput } from './materials';
import { LEVEL_HEIGHT } from '../world/coords';
import { sfx } from '../audio/sfx';

// Turret gunfire and blasts (src/turrets.ts `turretFired`, src/game/blast.ts `explosion`):
//  - a muzzle flash: a short-lived unlit star along the barrel (two frames), a point light that
//    lights the hull and the road, and for a tank gun a ring of blast sideways off the muzzle;
//  - smoke: pixel-art puffs (the sprite system's dithered opacity) rolling out along the line of
//    fire and up, and dust kicked off the ground by a tank gun's overpressure;
//  - the camera: a tank gun shakes the view for half a second, nearer = harder (a machine gun
//    just twitches it); a blast near you does the same;
//  - sound: the gun's report comes from PlayerCombat (sfx.rangedShot); a tank gun adds the
//    pack's huge explosion under it, so it booms instead of cracking.
// A blast: an orange fireball and its light, a burst of smoke over the radius.

type Puff = { h: SpriteHandle; x: number; y: number; z: number; hgt: number; lift0: number; vx: number; vy: number; vh: number; t: number; life: number; size0: number; size1: number; op: number };
type Flash = { mesh: THREE.Mesh; t: number; life: number };

const FRAME_N = 3;

export class TurretFx {
  private puffs: Puff[] = [];
  private flashes: Flash[] = [];
  private lights: { l: LightHandle; t: number; life: number; i0: number }[] = [];
  private shake = { t: 0, amp: 0 };
  private frames: TileFrame[] = [];
  private flashMat: THREE.MeshBasicMaterial;
  private fireMat: THREE.MeshBasicMaterial;
  private flashGeo: THREE.BufferGeometry;
  private ballGeo: THREE.BufferGeometry;
  readonly group = new THREE.Group();
  /**
   * Screenshot aid (tools/realinput_turret.ts): flashes and lights last at least this long (s).
   * 0 in play: a real flash is two or three frames, gone before a scripted capture lands.
   */
  hold = 0;

  constructor(private game: Game, private renderer: Renderer) {
    this.group.name = 'turretFx';
    renderer.scene.add(this.group);
    this.frames = makeFrames();
    this.flashMat = new THREE.MeshBasicMaterial({ color: 0xfff1b8, side: THREE.DoubleSide });
    this.fireMat = new THREE.MeshBasicMaterial({ color: 0xff8a2a, side: THREE.DoubleSide });
    for (const m of [this.flashMat, this.fireMat]) patchNormalOutput(m, false);
    this.flashGeo = starGeometry();
    this.ballGeo = new THREE.OctahedronGeometry(1, 1);
    game.events.on('turretFired', (e) => this.fired(e));
    game.events.on('explosion', (e) => this.blast(e));
    renderer.beforeRender.push((dt) => this.update(dt));
  }

  /** Puffs alive (tests / debug). */
  get count(): number {
    return this.puffs.length + this.flashes.length;
  }

  private puff(x: number, y: number, z: number, hgt: number, v: [number, number, number], o: { life: number; size0: number; size1: number; op: number; frame?: number }): void {
    if (this.puffs.length > 220) this.kill(0);
    const h = this.renderer.sprites.add({ x, y, z, frame: this.frames[o.frame ?? 0], height: o.size0, width: o.size0, anchor: 'center', lift: hgt, opacity: o.op });
    this.puffs.push({ h, x, y, z, hgt, lift0: hgt, vx: v[0], vy: v[1], vh: v[2], t: 0, life: o.life, size0: o.size0, size1: o.size1, op: o.op });
  }

  private kill(i: number): void {
    this.puffs[i].h.remove();
    this.puffs.splice(i, 1);
  }

  private light(x: number, y: number, z: number, hgt: number, color: number, intensity: number, radius: number, life: number): void {
    const l = this.renderer.lights.add({ x, y, z, height: hgt, color, intensity, radius });
    this.lights.push({ l, t: 0, life, i0: intensity });
  }

  /** Camera shake for something `power` strong at distance `d` m (0 = right under you). */
  private quake(power: number, d: number): void {
    const amp = power / (1 + (d * d) / 60);
    if (amp < 0.002) return;
    this.shake.amp = Math.max(this.shake.amp * Math.max(0, 1 - this.shake.t / 0.6), amp);
    this.shake.t = 0;
    this.renderer.rig.kick(amp * 0.9, (Math.random() - 0.5) * amp * 0.6);
  }

  fired(e: { muzzle: { x: number; y: number; h: number }; yaw: number; pitch: number; main: boolean }): void {
    const { x, y, h } = e.muzzle;
    const z = Math.floor(h / LEVEL_HEIGHT + 1e-6);
    const hgt = h - z * LEVEL_HEIGHT;
    const fx = Math.sin(e.yaw) * Math.cos(e.pitch), fy = -Math.cos(e.yaw) * Math.cos(e.pitch), fh = Math.sin(e.pitch);
    const big = e.main;
    // the flash: a star along the barrel, bigger for the tank gun, gone in two frames
    const m = new THREE.Mesh(this.flashGeo, this.flashMat);
    m.position.set(x + fx * (big ? 0.9 : 0.15), h + fh * (big ? 0.9 : 0.15), y + fy * (big ? 0.9 : 0.15));
    m.rotation.set(0, -e.yaw + Math.PI / 2, e.pitch, 'YZX');
    const sc = big ? 2.8 : 0.5;
    m.scale.set(sc * (0.9 + Math.random() * 0.3), sc * (0.6 + Math.random() * 0.3), sc * (0.6 + Math.random() * 0.3));
    this.group.add(m);
    this.flashes.push({ mesh: m, t: 0, life: Math.max(this.hold, big ? 0.07 : 0.035) });
    this.light(x, y, z, hgt, 0xffd890, big ? 9 : 2.2, big ? 28 : 9, Math.max(this.hold, big ? 0.14 : 0.05));
    const p = this.game.player;
    const dist = Math.hypot(p.x - x, p.y - y);
    if (big) {
      // smoke rolling out down the line of fire, a ring of blast off the muzzle, dust off the road
      for (let i = 0; i < 14; i++) {
        const s = 0.5 + Math.random() * 3.5, sp = 2 + Math.random() * 5;
        this.puff(x + fx * s, y + fy * s, z, hgt + fh * s, [fx * sp + (Math.random() - 0.5), fy * sp + (Math.random() - 0.5), 0.3 + Math.random() * 0.8], { life: 2.2 + Math.random() * 2, size0: 0.9, size1: 3.2 + Math.random() * 1.8, op: 0.95, frame: Math.random() < 0.3 ? 1 : 0 });
      }
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        const sx = Math.cos(a) * -fy, sy = Math.cos(a) * fx, sh = Math.sin(a);
        this.puff(x + fx * 0.5, y + fy * 0.5, z, hgt, [sx * 4 + fx, sy * 4 + fy, sh * 2], { life: 0.9 + Math.random() * 0.5, size0: 0.5, size1: 1.6, op: 0.7 });
      }
      for (let i = 0; i < 12; i++) {
        const a = Math.random() * Math.PI * 2, r = 1.5 + Math.random() * 3;
        this.puff(x - fx * 3 + Math.cos(a) * r, y - fy * 3 + Math.sin(a) * r, z, 0.2, [Math.cos(a) * 2.5, Math.sin(a) * 2.5, 0.4], { life: 1.2 + Math.random(), size0: 0.4, size1: 1.8, op: 0.55, frame: 2 });
      }
      this.quake(0.07, dist);
      sfx.explosion({ x, y, z }, 'huge');
    } else {
      if (Math.random() < 0.6) this.puff(x + fx * 0.3, y + fy * 0.3, z, hgt + fh * 0.3, [fx * 1.5, fy * 1.5, 0.4], { life: 0.7, size0: 0.15, size1: 0.6, op: 0.5 });
      this.quake(0.006, dist);
    }
  }

  blast(e: { x: number; y: number; z: number; radius: number; fire: boolean }): void {
    const r = Math.max(1, e.radius);
    const ball = new THREE.Mesh(this.ballGeo, this.fireMat);
    ball.position.set(e.x, e.z * LEVEL_HEIGHT + 0.6 + r * 0.25, e.y);
    ball.scale.setScalar(r * 0.7);
    this.group.add(ball);
    this.flashes.push({ mesh: ball, t: 0, life: 0.22 });
    this.light(e.x, e.y, e.z, 1.2, 0xffa040, 6 + r * 2, 10 + r * 6, 0.35);
    for (let i = 0; i < 10 + r * 6; i++) {
      const a = Math.random() * Math.PI * 2, s = Math.random() * r * 0.6, sp = 0.5 + Math.random() * r * 1.2;
      this.puff(e.x + Math.cos(a) * s, e.y + Math.sin(a) * s, e.z, 0.4 + Math.random() * r * 0.4, [Math.cos(a) * sp, Math.sin(a) * sp, 0.8 + Math.random() * 1.5], { life: 2 + Math.random() * 2, size0: 0.6, size1: 1.5 + r * 0.7, op: 0.85, frame: Math.random() < 0.5 ? 1 : 0 });
    }
    const p = this.game.player;
    this.quake(0.03 + r * 0.01, Math.hypot(p.x - e.x, p.y - e.y));
  }

  update(dt: number): void {
    // the view keeps shaking for a moment after a big one (rig.kick springs back in ~0.1 s)
    if (this.shake.amp > 0) {
      this.shake.t += dt;
      const k = Math.max(0, 1 - this.shake.t / 0.6);
      if (k <= 0) this.shake.amp = 0;
      else this.renderer.rig.kick((Math.random() - 0.4) * this.shake.amp * 0.5 * k, (Math.random() - 0.5) * this.shake.amp * 0.5 * k);
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      if (f.t >= f.life) {
        this.group.remove(f.mesh);
        this.flashes.splice(i, 1);
      } else f.mesh.rotation.x += 1.3;
    }
    for (let i = this.lights.length - 1; i >= 0; i--) {
      const l = this.lights[i];
      l.t += dt;
      if (l.t >= l.life) {
        l.l.remove();
        this.lights.splice(i, 1);
      } else l.l.intensity = l.i0 * (1 - l.t / l.life);
    }
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const q = this.puffs[i];
      q.t += dt;
      if (q.t >= q.life) {
        this.kill(i);
        continue;
      }
      const f = q.t / q.life;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.hgt = Math.max(0.1, q.hgt + q.vh * dt);
      const drag = Math.exp(-dt * 2.2);
      q.vx *= drag;
      q.vy *= drag;
      q.vh = q.vh * drag + 0.25 * dt;
      const size = q.size0 + (q.size1 - q.size0) * (1 - (1 - f) * (1 - f));
      q.h.setSize(size, size);
      q.h.setOpacity(q.op * (1 - f * f));
      q.h.set(q.x, q.y, q.z + (q.hgt - q.lift0) / LEVEL_HEIGHT);
    }
  }
}

/** A muzzle flash: three crossed spiky quads along +X (the barrel axis), unit size. */
function starGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const spikes = 7;
  for (let k = 0; k < 3; k++) {
    const rot = (k * Math.PI) / 3;
    const base = pos.length / 3;
    pos.push(0, 0, 0);
    for (let i = 0; i <= spikes * 2; i++) {
      const a = (i / (spikes * 2)) * Math.PI - Math.PI / 2;
      const r = i % 2 ? 0.35 : 1;
      // in the plane spanned by +X and the rotated side axis
      const along = Math.cos(a) * r * 1.6, side = Math.sin(a) * r * 0.55;
      pos.push(along, side * Math.cos(rot), side * Math.sin(rot));
    }
    for (let i = 1; i <= spikes * 2; i++) idx.push(base, base + i, base + i + 1);
  }
  // and a spiky disc across the barrel, so it reads as a burst from behind the gun too
  const base = pos.length / 3;
  pos.push(0.25, 0, 0);
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2, r = i % 2 ? 0.3 : 0.75;
    pos.push(0.25, Math.cos(a) * r, Math.sin(a) * r);
  }
  for (let i = 1; i <= n; i++) idx.push(base, base + i, base + i + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Pixel-art smoke frames: grey puff, dark puff, tan dust (16x16 each, dithered edges). */
function makeFrames(): TileFrame[] {
  const S = 16;
  const c = document.createElement('canvas');
  c.width = S * FRAME_N;
  c.height = S;
  const g = c.getContext('2d')!;
  const cols: [number, number, number][][] = [
    [[0x9c, 0x9a, 0x94], [0xc4, 0xc2, 0xbc], [0x74, 0x72, 0x6e]],
    [[0x4a, 0x48, 0x46], [0x66, 0x62, 0x5e], [0x30, 0x2e, 0x2c]],
    [[0xa8, 0x98, 0x78], [0xc8, 0xb8, 0x98], [0x80, 0x70, 0x58]],
  ];
  // a fixed-seed lumpy disc so every puff isn't a perfect circle
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let f = 0; f < FRAME_N; f++) {
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const dx = (x + 0.5 - S / 2) / (S / 2), dy = (y + 0.5 - S / 2) / (S / 2);
        const d = Math.hypot(dx, dy) + (rnd() - 0.5) * 0.25;
        if (d > 1) continue;
        // lit from above: lighter top-left, darker bottom
        const shade = dy < -0.3 ? 1 : dy > 0.35 ? 2 : 0;
        const [r, gg, b] = cols[f][shade];
        const i = (y * S + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = gg;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    g.putImageData(img, f * S, 0);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  const out: TileFrame[] = [];
  for (let f = 0; f < FRAME_N; f++) out.push({ texture: tex, uv: [f / FRAME_N, 0, (f + 1) / FRAME_N, 1], w: S, h: S });
  return out;
}
