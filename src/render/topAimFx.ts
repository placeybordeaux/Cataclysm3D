import * as THREE from 'three';
import type { Game } from '../game/game';
import type { Renderer } from './renderer';
import type { SpriteHandle } from './sprites';
import type { TileFrame } from './textureSource';
import type { PlayerCombat } from '../game/playercombat';
import { aimHooks, freeAim } from '../game/aimmodel';
import { FEEL } from '../game/combatfeel';
import { LEVEL_HEIGHT } from '../world/coords';

// Top-down aim, drawn (docs/COMBAT_FEEL.md "Top view"): from above the screen centre means
// nothing, so the facing is shown in the world instead. With a ranged weapon an aim line runs
// from the survivor along the shot (PlayerCombat.topAim: the facing plus the weave, auto-pitched
// to centre mass, or the head while aiming) to where it would land — the first body or solid
// within range — with a ring there. Same visibility rule as the first-person reticle: the weave,
// the full line and the ring show while aiming (RMB / drawing) and just after a shot; the rest of
// the time a short, quiet facing tick. Melee: a short tick along the facing (the swing's centre).
// Pixel-sized billboard dots, pooled.

const COL = { line: 0xf2f2e6, hot: 0xff5a40, dim: 0x9a9a90, ring: 0xffd060 };

export class TopAimFx {
  private frames = new Map<number, TileFrame>();
  private pool: SpriteHandle[] = [];
  private used = 0;
  /** What the line met last frame (tests, debug): the creature's uid, where, and the zone height. */
  last: { on: boolean; shown: boolean; target: number | null; x: number; y: number; h: number; yaw: number; pitch: number } | null = null;

  constructor(private game: Game, private renderer: Renderer, private combat: PlayerCombat) {
    const pal = Object.values(COL);
    const c = document.createElement('canvas');
    c.width = pal.length;
    c.height = 1;
    const g = c.getContext('2d')!;
    pal.forEach((col, i) => {
      g.fillStyle = `#${col.toString(16).padStart(6, '0')}`;
      g.fillRect(i, 0, 1, 1);
    });
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    pal.forEach((col, i) => this.frames.set(col, { texture: tex, uv: [(i + 0.25) / pal.length, 0.25, (i + 0.75) / pal.length, 0.75], w: 1, h: 1 }));
  }

  private dot(x: number, y: number, h: number, col: number, px: number): void {
    let s = this.pool[this.used];
    if (!s) this.pool.push((s = this.renderer.sprites.add({ x, y, z: h / LEVEL_HEIGHT, frame: this.frames.get(col)!, height: 0.05, width: 0.05, anchor: 'center' })));
    this.used++;
    s.setFrame(this.frames.get(col)!);
    s.set(x, y, h / LEVEL_HEIGHT);
    const cam = this.renderer.rig.camera;
    const d = Math.hypot(x - cam.position.x, y - cam.position.z, h - cam.position.y);
    const size = (px * 2 * Math.tan((cam.fov * Math.PI) / 360) * d) / this.renderer.pipeline.lowH;
    s.setSize(size, size);
    s.setVisible(true);
  }

  /** Per render frame (src/aim.ts). `extra`: seconds since the last simulation tick. */
  frame(extra: number, now: number): void {
    this.used = 0;
    const game = this.game;
    const p = game.player;
    const top = aimHooks.topView?.() ?? null;
    this.last = null;
    if (top && !p.dead && !game.input.captured) {
      const w = p.inv.wielded;
      const c = this.combat;
      const floor = p.z * LEVEL_HEIGHT;
      if (w?.isGun() && freeAim()) {
        const shown = c.reticleShown();
        const off = c.aim.offset(extra);
        // The drawn line is the shot: record it so a click fires along exactly this (hidden at rest:
        // the weave still decides a hip shot, the line just doesn't show it).
        c.aim.markShown(off.x, off.y, now);
        const range = Math.max(1, ((w.ammoData()?.range ?? 0) + (w.def.range ?? 0)) || 30);
        const t = c.topAim(shown ? off.x : 0, range, top.eye);
        const hit = c.castAim(t.yaw, t.pitch, range, undefined, t.o);
        const sx = p.x, sy = p.y, sh = floor + 1.2;
        const len = Math.hypot(hit.x - sx, hit.y - sy);
        const n = Math.min(80, Math.floor((shown ? len : Math.min(len, 2.5)) / 0.45));
        for (let i = 1; i <= n; i++) {
          const k = (i * 0.45) / Math.max(0.01, len);
          this.dot(sx + (hit.x - sx) * k, sy + (hit.y - sy) * k, sh + (hit.hAbs - sh) * k, shown ? (hit.hit ? COL.hot : COL.line) : COL.dim, shown ? 3 : 2);
        }
        if (shown) {
          // The ring where it lands: around the body it meets (gold), or a small cross on the wall/ground.
          const r = hit.hit ? hit.hit.radius + 0.12 : 0.18;
          const m = hit.hit ? 12 : 4;
          for (let i = 0; i < m; i++) {
            const a = (i / m) * Math.PI * 2;
            this.dot(hit.x + Math.cos(a) * r, hit.y + Math.sin(a) * r, hit.hAbs, hit.hit ? COL.ring : COL.line, 3.5);
          }
        }
        this.last = { on: true, shown, target: hit.hit?.uid ?? null, x: hit.x, y: hit.y, h: hit.hAbs - floor, yaw: t.yaw, pitch: t.pitch };
      } else {
        // Melee or bare hands: a short tick along the facing, to the edge of reach.
        const reach = w?.hasFlag('REACH_ATTACK') ? FEEL.reachLong : FEEL.reach;
        for (let i = 1; i <= 3; i++) {
          const d = 0.35 + (reach * i) / 3;
          this.dot(p.x + Math.sin(p.yaw) * d, p.y - Math.cos(p.yaw) * d, floor + 1.0, COL.dim, 2.5);
        }
        this.last = { on: true, shown: false, target: null, x: p.x, y: p.y, h: 1, yaw: p.yaw, pitch: 0 };
      }
    }
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].setVisible(false);
  }
}
