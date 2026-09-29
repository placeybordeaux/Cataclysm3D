import * as THREE from 'three';
import type { Game } from '../game/game';
import { CHUNK, LEVEL_HEIGHT } from '../world/coords';
import { hasFlag } from '../world/registry';

// SCAFFOLD renderer: flat-colored boxes, full resolution. Replaced by the pixel-art
// pipeline (src/render/*). Kept minimal on purpose.

const EYE = 1.6;

export class Renderer {
  readonly three: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(75, 1, 0.05, 300);
  private built = new Map<string, { version: number; obj: THREE.Object3D }>();

  constructor(private canvas: HTMLCanvasElement, private game: Game) {
    this.three = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.scene.background = new THREE.Color(0x8fa3b0);
    this.scene.add(new THREE.HemisphereLight(0xdde8ff, 0x445533, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(30, 60, 10);
    this.scene.add(sun);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.three.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    const p = this.game.player;
    const pcx = Math.floor(p.x / CHUNK), pcy = Math.floor(p.y / CHUNK);
    for (let dz = -1; dz <= 1; dz++)
      for (let cy = pcy - 2; cy <= pcy + 2; cy++)
        for (let cx = pcx - 2; cx <= pcx + 2; cx++) {
          const c = this.game.map.chunk(cx, cy, p.z + dz);
          if (!c) continue;
          const key = `${cx},${cy},${c.z}`;
          const b = this.built.get(key);
          if (b && b.version === c.version) continue;
          if (b) this.scene.remove(b.obj);
          const obj = this.buildChunk(cx, cy, c.z);
          this.scene.add(obj);
          this.built.set(key, { version: c.version, obj });
        }
    this.camera.position.set(p.x, p.z * LEVEL_HEIGHT + EYE, p.y);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(p.pitch, -p.yaw, 0);
    this.three.render(this.scene, this.camera);
  }

  private buildChunk(cx: number, cy: number, z: number): THREE.Object3D {
    const map = this.game.map;
    const group = new THREE.Group();
    const box = new THREE.BoxGeometry(1, 1, 1);
    const mats = new Map<string, THREE.Material>();
    const mat = (color: string) => {
      let m = mats.get(color);
      if (!m) mats.set(color, (m = new THREE.MeshLambertMaterial({ color: cddaColor(color) })));
      return m;
    };
    for (let ly = 0; ly < CHUNK; ly++)
      for (let lx = 0; lx < CHUNK; lx++) {
        const x = cx * CHUNK + lx, y = cy * CHUNK + ly;
        const t = map.terAt(x, y, z);
        if (t.id === 't_null' || hasFlag(t, 'NO_FLOOR')) continue;
        const wall = t.move_cost === 0;
        const h = wall ? LEVEL_HEIGHT : 0.05;
        const m = new THREE.Mesh(box, mat(t.color));
        m.scale.set(1, h, 1);
        m.position.set(x + 0.5, z * LEVEL_HEIGHT + h / 2, y + 0.5);
        group.add(m);
        const f = map.furnAt(x, y, z);
        if (f.id !== 'f_null') {
          const fm = new THREE.Mesh(box, mat(f.color));
          fm.scale.set(0.8, 0.8, 0.8);
          fm.position.set(x + 0.5, z * LEVEL_HEIGHT + 0.45, y + 0.5);
          group.add(fm);
        }
      }
    return group;
  }
}

/** CDDA curses color names -> RGB. Shared by UI and renderer fallbacks. */
export const CDDA_COLORS: Record<string, number> = {
  black: 0x000000, red: 0xff0000, green: 0x006e00, brown: 0x5c3317, blue: 0x0000c8,
  magenta: 0x8b3a62, cyan: 0x0096b4, light_gray: 0x969696, dark_gray: 0x636363,
  light_red: 0xff9696, light_green: 0x00ff00, yellow: 0xffff00, light_blue: 0x6464ff,
  pink: 0xfe00fe, light_cyan: 0x00f0ff, white: 0xffffff,
};

export function cddaColor(name: string | undefined): number {
  if (!name) return 0xffffff;
  let n = name.replace(/^[ci]_/, '').replace(/^h_/, '');
  n = n.split('_').filter((p) => p !== 'white' || n === 'white').join('_') || n;
  n = n.replace(/^lt/, 'light').replace(/^dk/, 'dark');
  return CDDA_COLORS[n] ?? CDDA_COLORS[n.split('_')[0]] ?? 0xcccccc;
}
