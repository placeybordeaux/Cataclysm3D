import * as THREE from 'three';
import type { Game } from '../game/game';
import type { Renderer } from './renderer';
import type { SpriteHandle } from './sprites';
import type { TileFrame } from './textureSource';
import { EnemyFire, type EnemyRound } from '../game/enemyfire';
import { LEVEL_HEIGHT } from '../world/coords';

// Enemy rounds in flight (src/game/enemyfire.ts), drawn so you can read them: a bullet is a
// short streak of hot pixels, an arrow a dark shaft with a pale head, a stone a grey dot. They
// move smoothly between simulation ticks and vanish where the round stopped — a miss visibly
// flies on past you and into the distance. Dots are pixel-sized billboards (like hitFx tracers).

const COLORS = { hot: 0xfff2b0, warm: 0xffb040, shaft: 0x5a3a1c, head: 0xd8d8d0, stone: 0x9a968c };

/** Per kind: dot count, streak length (m) and colour of each dot from the tail to the tip. */
const LOOK: Record<EnemyRound['kind'], { n: number; len: number; col: (i: number, n: number) => number; px: number }> = {
  bullet: { n: 10, len: 3.2, col: (i, n) => (i >= n - 3 ? COLORS.hot : COLORS.warm), px: 2.2 },
  arrow: { n: 6, len: 0.75, col: (i, n) => (i === n - 1 ? COLORS.head : COLORS.shaft), px: 1.6 },
  stone: { n: 1, len: 0, col: () => COLORS.stone, px: 3 },
};

export class EnemyFireFx {
  private frames = new Map<number, TileFrame>();
  private drawn = new Map<EnemyRound, { dots: SpriteHandle[]; s: number; at: number }>();

  constructor(private game: Game, private renderer: Renderer, private fire: () => EnemyFire | null) {
    const pal = Object.values(COLORS);
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
    renderer.beforeRender.push(() => this.update());
  }

  /** Metres covering `px` low-res pixels at distance d. */
  private pixel(d: number, px: number): number {
    const cam = this.renderer.rig.camera;
    return (px * 2 * Math.tan((cam.fov * Math.PI) / 360) * Math.max(0.3, d)) / this.renderer.pipeline.lowH;
  }

  private update(): void {
    const f = this.fire();
    const now = performance.now();
    const live = new Set(f?.rounds ?? []);
    for (const [r, d] of this.drawn) {
      if (live.has(r)) continue;
      for (const h of d.dots) h.remove();
      this.drawn.delete(r);
    }
    if (!f) return;
    const cam = this.renderer.rig.camera.position;
    const paused = this.game.paused || this.game.tacticalPause;
    for (const r of f.rounds) {
      const look = LOOK[r.kind];
      let d = this.drawn.get(r);
      if (!d) {
        d = { dots: [], s: r.s, at: now };
        for (let i = 0; i < look.n; i++) d.dots.push(this.renderer.sprites.add({ x: r.x0, y: r.y0, z: r.z, frame: this.frames.get(look.col(i, look.n))!, height: 0.05, width: 0.05, anchor: 'center' }));
        this.drawn.set(r, d);
      }
      if (r.s !== d.s) {
        d.s = r.s;
        d.at = now;
      }
      // Between ticks: where it is now (never more than one tick ahead of the simulation).
      const ahead = paused ? 0 : Math.min(1 / 30, (now - d.at) / 1000) * r.speed;
      const head = Math.min(r.maxS, r.s + ahead);
      for (let i = 0; i < look.n; i++) {
        const s = Math.max(0, head - look.len * (1 - (i + 1) / look.n));
        const p = EnemyFire.at(r, s);
        const dist = Math.hypot(p.x - cam.x, p.y - cam.z, p.h - cam.y);
        const size = this.pixel(dist, look.px);
        const h = d.dots[i];
        h.set(p.x, p.y, p.h / LEVEL_HEIGHT);
        h.setSize(size, size);
      }
    }
  }
}
