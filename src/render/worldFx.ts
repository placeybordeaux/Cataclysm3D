import * as THREE from 'three';
import type { Game } from '../game/game';
import type { Renderer } from './renderer';
import type { TileFrame } from './textureSource';
import type { SpriteHandle } from './sprites';
import type { LightHandle } from './lights';
import { CHUNK, LEVEL_HEIGHT } from '../world/coords';
import { fieldType } from '../game/fields';
import { playerSeesTrap, trapDef } from '../game/traps';
import { itemLight } from '../game/vision';
import { playerLightState } from '../game/lightitems';
import type { Item } from '../game/item';

// World-interaction visuals the chunk mesher doesn't draw: liquid fields (blood, bile,
// gibs …) and visible traps as flat decals on the floor, gases (smoke) as billboards, lit
// items lying on the map as point lights, and the player's own light (the renderer's
// flashlight beam for torches/flashlights, a point light for lanterns). Per-chunk objects
// are rebuilt when chunk.version changes, like the mesher.

const RADIUS = 2;

interface ChunkFx {
  version: number;
  objects: THREE.Object3D[];
  sprites: SpriteHandle[];
  lights: LightHandle[];
}

export class WorldFx {
  readonly group = new THREE.Group();
  private chunks = new Map<string, ChunkFx>();
  private mats = new Map<THREE.Texture, THREE.Material>();
  private playerGlow: LightHandle | null = null;
  /** Last beam state we set; edge-triggered so cdda.flashlight() debug toggles still work. */
  private beam: boolean | null = null;

  constructor(private game: Game, private renderer: Renderer) {
    this.group.name = 'worldFx';
    renderer.scene.add(this.group);
  }

  private frame(id: string, symbol: string, color: string): TileFrame {
    try {
      return this.renderer.source.sprite(id);
    } catch {
      return this.renderer.source.glyph(symbol || '?', color || 'white');
    }
  }

  private material(tex: THREE.Texture): THREE.Material {
    let m = this.mats.get(tex);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.3, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      this.mats.set(tex, m);
    }
    return m;
  }

  private decal(f: TileFrame, x: number, y: number, z: number, size = 1, lift = 0.015): THREE.Mesh {
    const g = new THREE.PlaneGeometry(size, size);
    g.rotateX(-Math.PI / 2);
    const [u0, v0, u1, v1] = f.uv;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) ? u1 : u0, uv.getY(i) ? v1 : v0);
    const m = new THREE.Mesh(g, this.material(f.texture));
    m.position.set(x + 0.5, z * LEVEL_HEIGHT + lift, y + 0.5);
    m.receiveShadow = true;
    return m;
  }

  private build(cx: number, cy: number, z: number): ChunkFx {
    const game = this.game;
    const c = game.map.chunk(cx, cy, z)!;
    const fx: ChunkFx = { version: c.version, objects: [], sprites: [], lights: [] };
    for (const [i, list] of c.fields) {
      const x = cx * CHUNK + (i % CHUNK), y = cy * CHUNK + Math.floor(i / CHUNK);
      for (const fd of list) {
        if (fd.type === 'fd_fire') continue; // the mesher draws fires
        const ft = fieldType(game, fd.type);
        if (!ft) continue;
        const lv = ft.intensity_levels ?? [];
        const sym = String((lv[0] as { sym?: string } | undefined)?.sym ?? '~');
        let color = 'red';
        for (let k = 0; k < Math.min(fd.intensity, lv.length); k++) if ((lv[k] as { color?: string }).color) color = (lv[k] as { color: string }).color;
        const lookId = typeof ft.looks_like === 'string' && !this.hasSprite(fd.type) ? ft.looks_like : fd.type;
        const f = this.frame(lookId, sym, color);
        if (ft.phase === 'gas') {
          fx.sprites.push(this.renderer.sprites.add({ x: x + 0.5, y: y + 0.5, z, frame: f, height: 0.6 + fd.intensity * 0.35, anchor: 'center', lift: 1.1 }));
        } else {
          const obj = this.decal(f, x, y, z, 0.55 + fd.intensity * 0.15);
          this.group.add(obj);
          fx.objects.push(obj);
        }
      }
    }
    for (const [i] of c.traps) {
      const x = cx * CHUNK + (i % CHUNK), y = cy * CHUNK + Math.floor(i / CHUNK);
      if (!playerSeesTrap(game, x, y, z)) continue;
      const id = c.traps.get(i)!;
      const def = trapDef(game, id);
      if (!def || def.visibility === undefined && !def.action) continue;
      const obj = this.decal(this.frame(id, def.symbol ?? '^', def.color ?? 'white'), x, y, z, 0.8, 0.02);
      this.group.add(obj);
      fx.objects.push(obj);
    }
    for (const [i, items] of c.items) {
      let lum = 0;
      for (const it of items) lum += itemLight(it as unknown as Item);
      if (lum <= 0) continue;
      const x = cx * CHUNK + (i % CHUNK), y = cy * CHUNK + Math.floor(i / CHUNK);
      fx.lights.push(this.renderer.lights.add({ x: x + 0.5, y: y + 0.5, z, height: 0.4, color: 0xffd8a0, intensity: Math.min(2, 0.4 + lum / 80), radius: Math.min(14, 3 + Math.sqrt(lum) * 0.9), flicker: true }));
    }
    return fx;
  }

  private spriteKnown = new Map<string, boolean>();
  private hasSprite(id: string): boolean {
    let v = this.spriteKnown.get(id);
    if (v === undefined) {
      try {
        this.renderer.source.sprite(id);
        v = true;
      } catch {
        v = false;
      }
      this.spriteKnown.set(id, v);
    }
    return v;
  }

  private dispose(fx: ChunkFx): void {
    for (const o of fx.objects) {
      this.group.remove(o);
      (o as THREE.Mesh).geometry?.dispose();
    }
    for (const s of fx.sprites) s.remove();
    for (const l of fx.lights) l.remove();
  }

  update(): void {
    const game = this.game, p = game.player;
    const pcx = Math.floor(p.tileX / CHUNK), pcy = Math.floor(p.tileY / CHUNK);
    const want = new Set<string>();
    for (let cy = pcy - RADIUS; cy <= pcy + RADIUS; cy++)
      for (let cx = pcx - RADIUS; cx <= pcx + RADIUS; cx++) {
        if (!game.map.hasChunk(cx, cy, p.z)) continue;
        const key = `${cx},${cy},${p.z}`;
        want.add(key);
        const c = game.map.chunk(cx, cy, p.z)!;
        const have = this.chunks.get(key);
        if (have && have.version === c.version) continue;
        if (have) this.dispose(have);
        if (!c.fields.size && !c.traps.size && !c.items.size) {
          this.chunks.set(key, { version: c.version, objects: [], sprites: [], lights: [] });
          continue;
        }
        this.chunks.set(key, this.build(cx, cy, p.z));
      }
    for (const [k, fx] of this.chunks) if (!want.has(k)) (this.dispose(fx), this.chunks.delete(k));

    // The player's own light.
    const ls = playerLightState(game);
    const beam = ls.on && ls.directional;
    if (beam !== this.beam) {
      this.beam = beam;
      this.renderer.setFlashlight(beam);
    }
    if (ls.on && !ls.directional) {
      if (!this.playerGlow) this.playerGlow = this.renderer.lights.add({ x: p.x, y: p.y, z: p.z, height: 1.1, color: 0xffcc88, intensity: 1, radius: 6, flicker: true });
      this.playerGlow.set(p.x, p.y, p.z);
      this.playerGlow.radius = Math.min(14, 3 + Math.sqrt(ls.lum) * 0.9);
      this.playerGlow.intensity = Math.min(2, 0.4 + ls.lum / 60);
    } else if (this.playerGlow) {
      this.playerGlow.remove();
      this.playerGlow = null;
    }
  }
}

export function installWorldFx(game: Game, renderer: Renderer): WorldFx {
  const fx = new WorldFx(game, renderer);
  game.systems.push({ name: 'worldFx', update: () => fx.update() });
  return fx;
}
