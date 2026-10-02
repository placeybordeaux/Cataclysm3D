import * as THREE from 'three';
import type { GameMap } from '../world/map';
import { CHUNK, LEVEL_HEIGHT } from '../world/coords';
import { pointSeed } from './atlasIndex';
import { SpriteLayer, type SpriteSpec, type StaticSpriteGroup } from './sprites';
import type { TileTextureSource } from './textureSource';

// Ground clutter near the player: small grass-tuft billboards scattered over grass tiles
// for Shadowglass-like richness. Purely cosmetic and regenerated around the player (not
// part of the chunk meshes), so the cost stays bounded (~radius^2 tiles) however far the
// world is drawn. Tufts don't cast shadows; they are lit by the light map like any sprite.

export class DecorLayer {
  readonly sprites: SpriteLayer;
  /** Tiles around the player that get tufts. */
  radius = 18;
  /** Regenerate once the player is this many tiles from the last centre. */
  private step = 6;
  private tufts: StaticSpriteGroup | null = null;
  private cx = NaN;
  private cy = NaN;
  private cz = NaN;
  private season = '';
  private sig = 0;
  private density = new Map<number, number>(); // terrain index -> tufts/tile code
  enabled = true;

  constructor(source: () => TileTextureSource) {
    this.sprites = new SpriteLayer(source, false);
    this.sprites.group.name = 'decor';
  }

  get count(): number {
    return this.tufts?.count ?? 0;
  }

  /** 0 = none, 1 = lawn, 2 = long grass, 3 = tall grass (bigger tufts). */
  private grassKind(map: GameMap, ti: number): number {
    let k = this.density.get(ti);
    if (k === undefined) {
      const id = map.terrain.defs[ti].id;
      k = /^t_grass_tall|^t_grass_long_tall/.test(id) ? 3 : /^t_grass_long/.test(id) ? 2 : /^t_grass($|_golf|_white|_alien)/.test(id) ? 1 : 0;
      this.density.set(ti, k);
    }
    return k;
  }

  private chunkSig(map: GameMap, px: number, py: number, pz: number): number {
    let sig = 0;
    const r = this.radius + this.step;
    for (let cy = Math.floor((py - r) / CHUNK); cy <= Math.floor((py + r) / CHUNK); cy++)
      for (let cx = Math.floor((px - r) / CHUNK); cx <= Math.floor((px + r) / CHUNK); cx++) {
        const v = map.hasChunk(cx, cy, pz) && (!this.ready || this.ready(cx, cy, pz)) ? map.chunk(cx, cy, pz)!.version + 1 : 0;
        sig = (Math.imul(sig, 31) + v) | 0;
      }
    return sig;
  }

  update(map: GameMap, px: number, py: number, pz: number, season: string, src: TileTextureSource): void {
    if (!this.enabled) {
      this.clear();
      return;
    }
    const moved = Number.isNaN(this.cx) || Math.hypot(px - this.cx, py - this.cy) > this.step || pz !== this.cz;
    const sig = moved ? 0 : this.chunkSig(map, this.cx, this.cy, pz);
    if (!moved && season === this.season && sig === this.sig) return;
    this.cx = Math.floor(px) + 0.5;
    this.cy = Math.floor(py) + 0.5;
    this.cz = pz;
    this.season = season;
    this.sig = this.chunkSig(map, this.cx, this.cy, pz);
    this.rebuild(map, src);
  }

  /** Rebuild on the next update (texture source swapped). */
  /**
   * Is a chunk's own geometry on screen (ChunkManager.chunkShown)? Tufts wait for it: grass
   * standing on the far ground ring before the street is built is the inside before the outside
   * (src/render/surroundings.ts). Null = always (tests, headless).
   */
  ready: ((cx: number, cy: number, z: number) => boolean) | null = null;

  invalidate(): void {
    this.cx = NaN;
  }

  private clear(): void {
    this.tufts?.dispose();
    this.tufts = null;
  }

  private rebuild(map: GameMap, src: TileTextureSource): void {
    this.clear();
    const R = this.radius, z = this.cz;
    const x0 = Math.floor(this.cx), y0 = Math.floor(this.cy);
    const specs: SpriteSpec[] = [];
    for (let y = y0 - R; y <= y0 + R; y++)
      for (let x = x0 - R; x <= x0 + R; x++) {
        const dx = x - x0, dy = y - y0;
        if (dx * dx + dy * dy > R * R) continue;
        const ccx = Math.floor(x / CHUNK), ccy = Math.floor(y / CHUNK);
        const c = map.hasChunk(ccx, ccy, z) && (!this.ready || this.ready(ccx, ccy, z)) ? map.chunk(ccx, ccy, z)! : null;
        if (!c) continue;
        const li = (((y % CHUNK) + CHUNK) % CHUNK) * CHUNK + (((x % CHUNK) + CHUNK) % CHUNK);
        const kind = this.grassKind(map, c.ter[li]);
        if (!kind || c.furn[li] !== 0 || c.items.has(li)) continue;
        const seed = pointSeed(x * 3 + 1, y * 7 + 2) >>> 0;
        // lawns get sparse tufts; long/tall grass is dense
        let n = kind === 1 ? [0, 1, 1, 2][seed & 3] : kind === 2 ? 2 + (seed & 1) : 3 + (seed & 1);
        // under snow only the taller dead stalks poke through
        if (this.season === 'winter') n = kind === 1 ? 0 : Math.ceil(n / 3);
        for (let k = 0; k < n; k++) {
          const s = (seed >>> (k * 5)) ^ (k * 0x9e3779b9);
          const jx = ((s & 255) / 255) * 0.8 + 0.1, jy = (((s >>> 8) & 255) / 255) * 0.8 + 0.1;
          const tall = kind === 3 && k < 2;
          const f = src.sprite(`tuft:${(s >>> 16) & 3}:${this.season}${tall ? ':tall' : ''}`);
          specs.push({ x: x + jx, y: y + jy, z, frame: f, height: tall ? 0.75 : 0.34 + ((s >>> 20) & 3) * 0.04, lift: -0.02 });
        }
      }
    if (specs.length) this.tufts = this.sprites.addStatic(specs, new THREE.Sphere(new THREE.Vector3(this.cx, z * LEVEL_HEIGHT, this.cy), R + 2));
  }
}
