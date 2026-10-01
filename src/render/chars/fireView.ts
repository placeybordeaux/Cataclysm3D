import * as THREE from 'three';
import type { Game } from '../../game/game';
import type { Renderer } from '../renderer';
import { CHUNK, LEVEL_HEIGHT } from '../../world/coords';
import { loadAtlas, type Atlas, type FrameRef } from '../atlas';
import { cardSettings, cardsOn } from '../cards';
import { FxMeshes } from './fxMeshes';

// Live fires (docs/CHARACTERS.md round 6): each `fd_fire` field is three crossed, world-fixed
// cards playing UltiCa's own flame animation (fd_fire_int1..3: 4-8 frames at 8/60 s, i.e.
// ~7.5 fps stepped — the tileset's timing), sized by intensity, with embers rising off it.
// The flame light itself is the light map's fire source, which already flickers; the cards are
// unlit (a flame is its own light) and dim only a little with the scene.
// Replaces the static fire cards the chunk mesher bakes (cards.ts) while this view is running.

const FRAME_S = 8 / 60;
const SCAN_S = 0.5;
const RANGE = 3; // chunks around the player

interface FireSpot { x: number; y: number; z: number; lvl: number; seed: number }

export class FireView {
  private atlas: Atlas | null = null;
  private fires: FireSpot[] = [];
  private scanT = 0;
  private clock = 0;
  private lastStep = -1;
  private meshes = new Map<THREE.Texture, THREE.Mesh>();
  private group = new THREE.Group();
  private embers: FxMeshes;
  private sparks: { x: number; y: number; z: number; h: number; vx: number; vy: number; vh: number; life: number; max: number }[] = [];
  private rng = 12345;

  constructor(readonly game: Game, readonly renderer: Renderer) {
    this.group.name = 'fires';
    renderer.scene.add(this.group);
    this.embers = new FxMeshes(renderer);
    cardSettings.fireLive = true;
    loadAtlas().then((a) => (this.atlas = a), () => {});
    renderer.beforeRender.push((dt) => this.update(dt));
  }

  private rand(): number {
    this.rng = (this.rng * 1103515245 + 12345) & 0x7fffffff;
    return this.rng / 0x7fffffff;
  }

  private scan(): void {
    const p = this.game.player;
    const pcx = Math.floor(p.x / CHUNK), pcy = Math.floor(p.y / CHUNK);
    const out: FireSpot[] = [];
    // the levels the world draws (src/world/levels.ts): a fire on the street seen from a roof
    const lv = this.renderer.chunks.levels;
    const [zLo, zHi] = lv.span(p.z);
    for (let z = zLo; z <= zHi; z++) for (let cy = pcy - RANGE; cy <= pcy + RANGE; cy++) for (let cx = pcx - RANGE; cx <= pcx + RANGE; cx++) {
      if (!lv.drawn(cx * CHUNK, cy * CHUNK, z) || !this.game.map.hasChunk(cx, cy, z)) continue;
      const c = this.game.map.chunk(cx, cy, z);
      if (!c) continue;
      for (const [i, list] of c.fields) for (const fd of list) {
        if (fd.type !== 'fd_fire') continue;
        const x = cx * CHUNK + (i % CHUNK), y = cy * CHUNK + Math.floor(i / CHUNK);
        out.push({ x, y, z, lvl: Math.max(1, Math.min(3, fd.intensity)), seed: ((x * 73856093) ^ (y * 19349663)) >>> 0 });
      }
    }
    this.fires = out;
  }

  private frames(lvl: number): FrameRef[] {
    const a = this.atlas!;
    const t = a.index.tiles[`fd_fire_int${lvl}`] ?? a.index.tiles.fd_fire;
    return (t?.fg ?? []).map((v) => a.frameRef(v.sprites[0]));
  }

  /** Rebuild the card geometry for this animation step (tens of fires: a few hundred verts). */
  private build(step: number): void {
    const byPage = new Map<THREE.Texture, { pos: number[]; uv: number[]; idx: number[] }>();
    for (const f of this.fires) {
      const fr = this.frames(f.lvl);
      if (!fr.length) continue;
      const r = fr[(step + (f.seed % fr.length)) % fr.length];
      let b = byPage.get(r.texture);
      if (!b) byPage.set(r.texture, (b = { pos: [], uv: [], idx: [] }));
      const h = 0.55 + f.lvl * 0.3, w = h * (r.w / Math.max(1, r.h));
      const cx = f.x + 0.5, cy = f.y + 0.5;
      const base = f.z * LEVEL_HEIGHT + (this.renderer.groundAt?.(cx, cy, f.z) ?? 0);
      const a0 = ((f.seed & 255) / 256) * Math.PI;
      for (let k = 0; k < 3; k++) {
        const a = a0 + (k * Math.PI) / 3;
        const ux = Math.cos(a) * w * 0.5, uz = Math.sin(a) * w * 0.5;
        const v0 = b.pos.length / 3;
        b.pos.push(cx - ux, base, cy - uz, cx + ux, base, cy + uz, cx + ux, base + h, cy + uz, cx - ux, base + h, cy - uz);
        b.uv.push(r.uv.u0, r.uv.v0, r.uv.u1, r.uv.v0, r.uv.u1, r.uv.v1, r.uv.u0, r.uv.v1);
        b.idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
      }
    }
    for (const [page, m] of this.meshes) if (!byPage.has(page)) m.visible = false;
    for (const [page, b] of byPage) {
      let m = this.meshes.get(page);
      if (!m) {
        // unlit and double-sided: a flame is its own light; alpha-tested on the pixel grid
        const mat = new THREE.MeshBasicMaterial({ map: page, alphaTest: 0.5, side: THREE.DoubleSide, color: new THREE.Color(1.15, 1.05, 0.95) });
        m = new THREE.Mesh(new THREE.BufferGeometry(), mat);
        m.frustumCulled = false;
        this.group.add(m);
        this.meshes.set(page, m);
      }
      const g = m.geometry;
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.setIndex(b.idx);
      m.visible = true;
    }
  }

  update(dt: number): void {
    const live = cardsOn() && !!this.atlas;
    this.group.visible = live;
    if (!live) return;
    this.clock += dt;
    this.scanT -= dt;
    let changed = false;
    if (this.scanT <= 0) {
      this.scanT = SCAN_S;
      const before = this.fires.length;
      this.scan();
      changed = before !== this.fires.length || this.fires.length > 0;
    }
    const step = Math.floor(this.clock / FRAME_S);
    if (step !== this.lastStep || changed) {
      this.lastStep = step;
      this.build(step);
    }
    // embers: a few per fire, drifting up and sideways, shrinking as they cool
    const p = this.game.player;
    for (const f of this.fires) {
      if (!this.renderer.chunks.levels.drawn(f.x, f.y, f.z) || Math.hypot(f.x - p.x, f.y - p.y) > 40) continue;
      if (this.rand() < dt * (1.5 + f.lvl * 1.5)) {
        const max = 0.8 + this.rand() * 0.9;
        this.sparks.push({ x: f.x + 0.3 + this.rand() * 0.4, y: f.y + 0.3 + this.rand() * 0.4, z: f.z, h: 0.3 + f.lvl * 0.15, vx: (this.rand() - 0.5) * 0.3, vy: (this.rand() - 0.5) * 0.3, vh: 0.6 + this.rand() * 0.5, life: max, max });
      }
    }
    this.embers.begin();
    this.sparks = this.sparks.filter((s) => (s.life -= dt) > 0);
    for (const s of this.sparks) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.h += s.vh * dt;
      s.vx += Math.sin(this.clock * 3 + s.max * 9) * dt * 0.4;
      const k = s.life / s.max;
      this.embers.place('spark', s.x, s.y, s.z, s.h, [1, 0, 0], k > 0.5 ? [255, 200, 90] : [230, 110, 40], 0.25 + 0.25 * k);
    }
    this.embers.end();
  }
}
