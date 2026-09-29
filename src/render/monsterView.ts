import * as THREE from 'three';
import type { Game, GameSystem } from '../game/game';
import { monsterSize, type Monster } from '../game/monster';
import type { CorpseRecord, MonsterSystem } from '../game/monai';
import type { PlayerCombat } from '../game/playercombat';
import { LEVEL_HEIGHT } from '../world/coords';
import { loadAtlas, type Atlas, type FrameRef } from './atlas';
import type { Renderer } from './renderer';
import type { SpriteHandle } from './sprites';
import type { TileFrame } from './textureSource';
import type { LightHandle } from './lights';

// Billboards for monsters, their corpses, projectiles and blood decals. Runs as a
// GameSystem (30 Hz) so `cdda.step()` + `cdda.settle()` screenshots see the same state the
// simulation has; movement at 30 Hz reads fine in the pixel-art style.
//
// Scale: UltiCa human sprites are 32x48 px for a ~1.75 m person, so MON_PPM px per metre.

const MON_PPM = 48 / 1.75;
const GLYPH_HEIGHT = { tiny: 0.45, small: 0.8, medium: 1.7, large: 2.3, huge: 3.2 } as const;
/** Fallen corpses: squashed to this fraction of standing height. */
const FALLEN = 0.3;
const FALL_TIME = 0.35;

interface MonView {
  h: SpriteHandle;
  frame: TileFrame;
  height: number;
  typeId: string;
}

interface CorpseView {
  h: SpriteHandle;
  rec: CorpseRecord;
  frame: TileFrame;
  height: number;
  t: number;
}

function toFrame(r: FrameRef, flip = false): TileFrame {
  const uv: [number, number, number, number] = flip ? [r.uv.u1, r.uv.v0, r.uv.u0, r.uv.v1] : [r.uv.u0, r.uv.v0, r.uv.u1, r.uv.v1];
  return { texture: r.texture, uv, w: r.w, h: r.h, ppm: 32 };
}

export class MonsterView implements GameSystem {
  readonly name = 'monster-view';
  private atlas: Atlas | null = null;
  private views = new Map<Monster, MonView>();
  private corpses = new Map<CorpseRecord, CorpseView>();
  private projectiles: SpriteHandle[] = [];
  private tracerSprites: SpriteHandle[] = [];
  private muzzle: LightHandle | null = null;
  private muzzleT = 0;
  private lastShots = 0;
  private corpseCheck = 0;
  readonly decals: DecalLayer;

  constructor(readonly game: Game, readonly renderer: Renderer, readonly sys: MonsterSystem, readonly combat: PlayerCombat | null) {
    loadAtlas().then(
      (a) => {
        this.atlas = a;
        // Re-skin anything created with glyph fallbacks before the atlas arrived.
        for (const [m, v] of this.views) this.refresh(m, v);
      },
      () => {},
    );
    sys.onHurt.push((m) => this.views.get(m)?.h.flash(0xff2a2a, 0.18));
    sys.onDied.push((m, c) => this.died(m, c));
    sys.onRemoved.push((m) => this.drop(m));
    sys.onCorpseGone.push((c) => this.dropCorpse(c));
    sys.onCorpse.push((c) => {
      const f = this.frameFor({ type: game.data.monsters[c.monId], uid: 0, size: monsterSize(game.data.monsters[c.monId]) });
      this.corpses.set(c, { h: this.fallen(c, f.frame, f.height, 1), rec: c, frame: f.frame, height: f.height, t: FALL_TIME });
    });
    sys.onSpawned.push((m) => {
      const v = this.views.get(m);
      if (v && v.typeId !== m.type.id) this.refresh(m, v);
    });
    this.decals = new DecalLayer(game, () => this.atlas);
    renderer.scene.add(this.decals.group);
    this.installHurtFlash();
  }

  /**
   * Red screen flash when the survivor is hit. A stop-gap until the HUD owns hit feedback
   * (it can read the same 'playerHurt' event and remove this).
   */
  private installHurtFlash(): void {
    if (typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5;opacity:0;transition:opacity .35s ease-out;' +
      'background:radial-gradient(ellipse at center, rgba(160,0,0,0) 45%, rgba(170,0,0,.85) 100%)';
    document.body.appendChild(el);
    this.game.events.on('playerHurt', (e) => {
      if (e.amount <= 0) return;
      el.style.transition = 'none';
      el.style.opacity = String(Math.min(0.9, 0.35 + e.amount / 20));
      void el.offsetWidth;
      el.style.transition = 'opacity .35s ease-out';
      el.style.opacity = '0';
    });
  }

  /** Sprite frame + height for a monster type (atlas sprite, looks_like chain, glyph fallback). */
  frameFor(m: Monster | { type: Monster['type']; uid: number; size: Monster['size'] }): { frame: TileFrame; height: number } {
    const def = m.type;
    const a = this.atlas;
    if (a) {
      const hit = a.lookupWithLooksLike(def.id, (id) => this.game.data.monsters[id]?.looks_like as string | undefined, { variantSeed: m.uid });
      if (hit?.fg) return { frame: toFrame(hit.fg), height: hit.fg.h / MON_PPM };
    }
    const frame = a ? toFrame(a.glyph(def.symbol, def.color)) : this.renderer.source.glyph(def.symbol, def.color);
    return { frame, height: GLYPH_HEIGHT[m.size] };
  }

  private create(m: Monster): MonView {
    const { frame, height } = this.frameFor(m);
    const h = this.renderer.sprites.add({ x: m.x, y: m.y, z: m.z, frame, height });
    const v = { h, frame, height, typeId: m.type.id };
    this.views.set(m, v);
    return v;
  }

  private refresh(m: Monster, v: MonView): void {
    const { frame, height } = this.frameFor(m);
    v.frame = frame;
    v.height = height;
    v.typeId = m.type.id;
    v.h.setFrame(frame, height);
  }

  private drop(m: Monster): void {
    const v = this.views.get(m);
    if (!v) return;
    v.h.remove();
    this.views.delete(m);
  }

  private died(m: Monster, c: CorpseRecord | null): void {
    const v = this.views.get(m);
    const f = v ? { frame: v.frame, height: v.height } : this.frameFor(m);
    this.drop(m);
    if (!c) return;
    // Keep the body as a sprite that crumples to the ground; it lives as long as the corpse item.
    const h = this.renderer.sprites.add({ x: c.x, y: c.y, z: c.z, frame: f.frame, height: f.height });
    h.flash(0xff2020, 0.15);
    this.corpses.set(c, { h, rec: c, frame: f.frame, height: f.height, t: 0 });
  }

  /** Body sprite part-way (k = 0..1) through falling: squashed vertically, widened as if lying down. */
  private fallen(c: CorpseRecord, frame: TileFrame, height: number, k: number): SpriteHandle {
    const hgt = height * (1 - (1 - FALLEN) * k * k);
    return this.renderer.sprites.add({ x: c.x, y: c.y, z: c.z, frame, height: hgt, width: (frame.w / MON_PPM) * (1 + 0.5 * k) });
  }

  private dropCorpse(c: CorpseRecord): void {
    const v = this.corpses.get(c);
    if (!v) return;
    v.h.remove();
    this.corpses.delete(c);
  }

  update(game: Game, dt: number): void {
    const p = game.player;
    // Live monsters: only those in the bubble have sprites.
    for (const m of this.sys.active) {
      if (m.dead) continue;
      let v = this.views.get(m);
      if (!v) v = this.create(m);
      // Walk bob and a stumbling sway (a fraction of a level so the billboard lifts in metres).
      const bob = m.moving ? Math.abs(Math.sin(m.walkPhase * Math.PI)) * 0.07 : 0;
      const sway = m.has('STUMBLES') && m.moving ? Math.sin(m.wobble) * 0.06 : 0;
      const downed = m.hasEffect('downed');
      v.h.set(m.x + sway * Math.cos(p.yaw), m.y + sway * Math.sin(p.yaw), m.z + bob / LEVEL_HEIGHT);
      v.h.setVisible(Math.abs(m.z - p.z) <= 1);
      v.h.setFrame(v.frame, downed ? v.height * 0.5 : v.height);
    }
    for (const [m] of this.views) if (m.dead || m.dormant) this.drop(m);

    // Corpses: crumple animation, then persist until the item is gone.
    this.corpseCheck -= dt;
    const check = this.corpseCheck <= 0;
    if (check) this.corpseCheck = 1;
    for (const [c, v] of this.corpses) {
      if (check && !this.sys.corpseValid(c)) {
        this.dropCorpse(c);
        continue;
      }
      if (v.t < FALL_TIME) {
        v.t = Math.min(FALL_TIME, v.t + dt);
        v.h.remove();
        v.h = this.fallen(c, v.frame, v.height, v.t / FALL_TIME);
      }
    }

    // Projectiles (acid globs, bile, thrown items).
    for (const h of this.projectiles) h.remove();
    this.projectiles.length = 0;
    for (const pr of this.sys.projectiles) {
      const frame = this.atlas ? toFrame(this.atlas.glyph(pr.glyph.symbol, pr.glyph.color)) : this.renderer.source.glyph(pr.glyph.symbol, pr.glyph.color);
      this.projectiles.push(this.renderer.sprites.add({ x: pr.x, y: pr.y, z: pr.z, frame, height: 0.35, anchor: 'center', lift: 1.1 }));
    }

    // Gunfire: muzzle flash light + a spark where the bullet stopped.
    for (const h of this.tracerSprites) h.remove();
    this.tracerSprites.length = 0;
    const tracers = this.combat?.tracers ?? [];
    const shots = this.combat?.shots ?? 0;
    if (shots > this.lastShots) {
      this.muzzle ??= this.renderer.lights.add({ x: p.x, y: p.y, z: p.z, color: 0xffd080, intensity: 2, radius: 8, height: 1.4 });
      this.muzzle.set(p.x, p.y, p.z);
      this.muzzle.intensity = 2;
      this.muzzleT = 0.06;
    }
    this.lastShots = shots;
    for (const t of tracers) {
      const frame = this.atlas ? toFrame(this.atlas.glyph('*', 'yellow')) : this.renderer.source.glyph('*', 'yellow');
      this.tracerSprites.push(this.renderer.sprites.add({ x: t.x1, y: t.y1, z: t.z, frame, height: 0.3, anchor: 'center', lift: 1.2 }));
    }
    if (this.muzzle) {
      this.muzzleT -= dt;
      if (this.muzzleT <= 0) this.muzzle.intensity = 0;
    }
    this.sys.playerLight = () => (this.renderer.flashlightOn ? 60 : 0);
    this.decals.update(dt);
  }
}

/**
 * Flat blood/bile/acid decals on the floor for fields the monster system adds. Fields other
 * than fire aren't drawn by the chunk mesher, so this layer scans loaded chunks near the
 * player for liquid-ish fields and rebuilds one merged mesh per texture page when they change.
 */
export class DecalLayer {
  readonly group = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private sig = '';
  private timer = 0;
  static readonly TYPES = new Set(['fd_blood', 'fd_bile', 'fd_acid', 'fd_gibs_flesh', 'fd_blood_veggy', 'fd_blood_insect', 'fd_blood_invertebrate', 'fd_gibs_insect']);

  constructor(private game: Game, private atlas: () => Atlas | null) {
    this.group.name = 'decals';
  }

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    const a = this.atlas();
    if (!a) return;
    const p = this.game.player;
    const R = 40;
    const list: { x: number; y: number; z: number; type: string; i: number }[] = [];
    for (const c of this.game.map.loadedChunks()) {
      if (c.fields.size === 0 || Math.abs(c.z - p.z) > 1) continue;
      const X = c.cx * 24, Y = c.cy * 24;
      if (X + 24 < p.x - R || X > p.x + R || Y + 24 < p.y - R || Y > p.y + R) continue;
      for (const [k, fl] of c.fields) for (const f of fl) {
        if (!DecalLayer.TYPES.has(f.type)) continue;
        list.push({ x: X + (k % 24), y: Y + Math.floor(k / 24), z: c.z, type: f.type, i: f.intensity });
      }
    }
    const sig = list.map((d) => `${d.x},${d.y},${d.z},${d.type},${d.i}`).join(';');
    if (sig === this.sig) return;
    this.sig = sig;
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.meshes = [];
    const byTex = new Map<THREE.Texture, number[][]>();
    for (const d of list) {
      const hit = a.lookup(d.type, { variantSeed: d.x * 7349 + d.y * 3163 });
      const fr = hit?.fg ?? hit?.bg;
      if (!fr) continue;
      let arr = byTex.get(fr.texture);
      if (!arr) byTex.set(fr.texture, (arr = []));
      // Stronger fields cover more of the tile.
      const s = 0.55 + 0.15 * Math.min(3, d.i);
      const cx = d.x + 0.5, cy = d.y + 0.5, h = d.z * LEVEL_HEIGHT + 0.015;
      const x0 = cx - s / 2, x1 = cx + s / 2, y0 = cy - s / 2, y1 = cy + s / 2;
      const { u0, v0, u1, v1 } = fr.uv;
      arr.push([x0, h, y0, u0, v1, x1, h, y0, u1, v1, x1, h, y1, u1, v0, x0, h, y1, u0, v0]);
    }
    for (const [tex, quads] of byTex) {
      const pos = new Float32Array(quads.length * 12);
      const uv = new Float32Array(quads.length * 8);
      const nrm = new Float32Array(quads.length * 12);
      const idx: number[] = [];
      quads.forEach((q, n) => {
        for (let v = 0; v < 4; v++) {
          pos.set([q[v * 5], q[v * 5 + 1], q[v * 5 + 2]], n * 12 + v * 3);
          uv.set([q[v * 5 + 3], q[v * 5 + 4]], n * 8 + v * 2);
          nrm.set([0, 1, 0], n * 12 + v * 3);
        }
        const b = n * 4;
        idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      g.setIndex(idx);
      const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.4, transparent: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(g, mat);
      mesh.receiveShadow = true;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }
}
