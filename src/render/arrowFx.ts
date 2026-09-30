import * as THREE from 'three';
import type { Game } from '../game/game';
import type { Monster } from '../game/monster';
import type { MonsterSystem } from '../game/monai';
import { isAt, L } from '../game/moves';
import type { Flight, Landed, PlayerCombat } from '../game/playercombat';
import { arcHeight } from '../game/rangedfeel';
import { LEVEL_HEIGHT } from '../world/coords';
import { artSpan } from './hitFx';
import type { MonsterView } from './monsterView';
import type { Renderer } from './renderer';
import type { SpriteHandle } from './sprites';
import type { TileFrame } from './textureSource';

// Visible arrows, bolts and stones (PlayerCombat.flights / .landed / Monster.stuck):
//  - in flight: a shaft of pixels along the real 3D path (the gravity arc from rangedfeel.ts),
//    fletching at the tail, a faint streak behind it — so you watch where the shot actually went
//  - at rest: stuck in the ground leaning back toward the shooter, in a wall, or in a monster's
//    body (following it as it walks) until picked up / until it dies and they fall
// Everything is drawn as world-space billboards one or two low-res pixels thick (like hitFx's
// tracers), re-sized every frame so an arrow stays a crisp line at any distance.

const SHAFT = [0x8a6a40, 0x7a5a34];
const TIP = 0xb8bcc4;
const FLETCH = [0xe8e4dc, 0xb8322a];
const STREAK = 0xf4f0e0;
const STONE = [0x8c8a84, 0xa8a69e];
const PALETTE = [...SHAFT, TIP, ...FLETCH, STREAK, ...STONE];

interface Pt { x: number; y: number; h: number }

/** Seconds the dotted path of a flight lingers after the arrow passed. */
const TRAIL_LIFE = 0.45;

export class ArrowFx {
  private frames = new Map<number, TileFrame>();
  private pool: SpriteHandle[] = [];
  private used = 0;
  private z = 0;
  private clock = 0;
  private trail: (Pt & { z: number; t: number })[] = [];
  private lastPos = new WeakMap<Flight, number>();

  constructor(private game: Game, private renderer: Renderer, private combat: PlayerCombat, private sys: MonsterSystem, private view: MonsterView | null) {
    this.makePalette();
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
    PALETTE.forEach((col, i) => this.frames.set(col, { texture: tex, uv: [(i + 0.25) / n, 0.25, (i + 0.75) / n, 0.75], w: 1, h: 1 }));
  }

  /** Metres covering `px` low-res pixels at `d` metres. */
  private pixelSize(d: number, px: number): number {
    const cam = this.renderer.rig.camera;
    const lowH = (this.renderer as unknown as { pipeline?: { lowH: number } }).pipeline?.lowH ?? 360;
    return (px * 2 * Math.tan((cam.fov * Math.PI) / 360) * Math.max(0.3, d)) / lowH;
  }

  private dot(p: Pt, col: number, px: number): void {
    const cam = this.renderer.rig.camera.position;
    const size = Math.max(0.012, this.pixelSize(Math.hypot(p.x - cam.x, p.y - cam.z, p.h + this.z * LEVEL_HEIGHT - cam.y), px));
    let h = this.pool[this.used];
    if (!h) {
      h = this.renderer.sprites.add({ x: p.x, y: p.y, z: this.z, frame: this.frames.get(col)!, height: size, width: size, anchor: 'center', lift: 0 });
      this.pool.push(h);
    } else {
      h.setFrame(this.frames.get(col)!);
      h.setSize(size, size);
      h.setVisible(true);
    }
    h.set(p.x, p.y, this.z + p.h / LEVEL_HEIGHT);
    this.used++;
  }

  /**
   * A shaft from `tip` back along -dir (unit 3D, pointing tip-ward) for `len` metres; `stone`
   * draws one round pebble instead.
   */
  private arrow(tip: Pt, dir: [number, number, number], len: number, z: number, kind: 'arrow' | 'stone', streak = 0): void {
    this.z = z;
    const cam = this.renderer.rig.camera.position;
    const d = Math.hypot(tip.x - cam.x, tip.y - cam.z);
    if (kind === 'stone') {
      this.dot(tip, STONE[0], 3);
      for (let i = 1; i <= streak; i++) this.dot({ x: tip.x - dir[0] * 0.5 * i, y: tip.y - dir[1] * 0.5 * i, h: tip.h - dir[2] * 0.5 * i }, STREAK, 1);
      return;
    }
    // Enough dots that the shaft reads as a line at this distance (about one per 1.2 pixels).
    const pxLen = len / Math.max(1e-4, this.pixelSize(d, 1));
    const n = Math.max(4, Math.min(28, Math.round(pxLen / 1.1)));
    for (let i = 0; i <= n; i++) {
      const f = (i / n) * len;
      const p = { x: tip.x - dir[0] * f, y: tip.y - dir[1] * f, h: tip.h - dir[2] * f };
      const col = i === 0 ? TIP : i >= n - Math.max(1, Math.round(n * 0.18)) ? FLETCH[i % 2] : SHAFT[i % 2];
      this.dot(p, col, i === 0 || i >= n - 2 ? 3 : 2.2);
    }
    for (let i = 1; i <= streak; i++) {
      const f = len + i * 0.45;
      this.dot({ x: tip.x - dir[0] * f, y: tip.y - dir[1] * f, h: tip.h - dir[2] * f }, STREAK, 1);
    }
  }

  private shaftLen(f: { cls: string; ammo?: { ammo_type?: unknown } }): number {
    return f.cls === 'crossbow' ? 0.45 : 0.75;
  }

  update(dt = 1 / 60): void {
    this.used = 0;
    const p = this.game.player;
    this.clock += dt;
    const now = this.clock;
    // The path it actually took: a fading line of dots left behind in the air (seen from behind
    // an arrow is a point; the trail shows where it went, like a tracer).
    for (const f of this.combat.flights) {
      // Fill the stretch flown since last frame (50 m/s is well over a metre a frame).
      let s = this.lastPos.get(f) ?? 1;
      for (; s + 0.35 <= f.s; s += 0.35) this.trail.push({ x: f.x0 + f.dx * s, y: f.y0 + f.dy * s, h: arcHeight(s, f.arc), z: f.z, t: now });
      this.lastPos.set(f, s);
      this.flight(f);
    }
    this.trail = this.trail.filter((q) => now - q.t < TRAIL_LIFE);
    for (const q of this.trail) {
      this.z = q.z;
      this.dot(q, STREAK, 2.2 * (1 - (now - q.t) / TRAIL_LIFE) + 0.8);
    }
    for (let i = this.combat.landed.length - 1; i >= 0; i--) {
      const r = this.combat.landed[i];
      if (!isAt(r.item, L.ground(r.map, Math.floor(r.x), Math.floor(r.y), r.z)) && !this.nearTile(r)) {
        this.combat.landed.splice(i, 1);
        continue;
      }
      if (Math.abs(r.z - p.z) > 1 || Math.hypot(r.x - p.x, r.y - p.y) > 60) continue;
      this.landed(r);
    }
    for (const m of this.sys.active) if (m.stuck.items.length && !m.dead) this.stuckIn(m);
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].setVisible(false);
  }

  /** A round that hit a wall may have been placed on the tile in front of it. */
  private nearTile(r: Landed): boolean {
    const tx = Math.floor(r.x - Math.sin(r.yaw) * 0.6), ty = Math.floor(r.y + Math.cos(r.yaw) * 0.6);
    return isAt(r.item, L.ground(r.map, tx, ty, r.z));
  }

  private flight(f: Flight): void {
    // Direction of travel: the plan direction and the arc's slope right here.
    const s = Math.max(0.05, f.s);
    const dh = (arcHeight(s + 0.05, f.arc) - arcHeight(Math.max(0, s - 0.05), f.arc)) / 0.1;
    const l = Math.hypot(1, dh);
    const dir: [number, number, number] = [f.dx / l, f.dy / l, dh / l];
    const len = Math.min(this.shaftLen(f), Math.max(0.1, f.s - 0.3));
    this.arrow({ x: f.x, y: f.y, h: f.h }, dir, len, f.z, f.cls === 'sling' ? 'stone' : 'arrow', f.s > 2 ? 3 : 0);
  }

  private landed(r: Landed): void {
    if (r.item.def.ammo_type === 'pebble' || r.item.def.ammo_type === 'rock') return; // stones just lie there
    const dx = Math.sin(r.yaw), dy = -Math.cos(r.yaw);
    const len = r.item.def.ammo_type === 'bolt' ? 0.45 : 0.75;
    if (r.into === 'ground') {
      // Buried a hand's width, leaning back up toward where it came from (~35° incidence).
      const c = Math.cos(0.6), s = Math.sin(0.6);
      const dir: [number, number, number] = [dx * c, dy * c, -s];
      this.arrow({ x: r.x, y: r.y, h: 0 }, dir, len * 0.8, r.z, 'arrow');
    } else {
      const c = Math.cos(0.08), s = Math.sin(0.08);
      this.arrow({ x: r.x, y: r.y, h: r.hgt }, [dx * c, dy * c, -s], len * 0.85, r.z, 'arrow');
    }
  }

  private stuckIn(m: Monster): void {
    const spr = this.view?.spriteOf(m);
    const span = spr ? artSpan(spr.frame) : { bottom: 0, top: 1 };
    const H = spr?.height ?? 1.8;
    const bottom = H * span.bottom, top = H * span.top;
    for (const it of m.stuck.items) {
      const hits = m.stuck.hits.get(it) ?? [];
      const n = Math.min(it.count(), Math.max(1, hits.length));
      for (let i = 0; i < n; i++) {
        const h = hits[i] ?? { side: 0, hgt: 0.6, yaw: 0 };
        const yaw = h.yaw + m.facing;
        const dx = Math.sin(yaw), dy = -Math.cos(yaw);
        const tip = { x: m.x - dx * m.radius * 0.2 + dy * -h.side * m.radius, y: m.y - dy * m.radius * 0.2 + dx * h.side * m.radius, h: bottom + (top - bottom) * h.hgt };
        const len = it.def.ammo_type === 'bolt' ? 0.4 : 0.6;
        this.arrow(tip, [dx, dy, -0.05], len, m.z, 'arrow');
      }
    }
  }
}
