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

// Billboards for monsters, their corpses and projectiles (blood/bile/acid decals are drawn by
// render/worldFx.ts from the map fields the monster system adds). Runs as a
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

/**
 * Billboards closer than this (horizontal metres from the camera) are drawn as if they stood
 * at this distance, so a zombie in your face stays a readable sprite instead of a wall of
 * giant texels.
 */
export const NEAR_CLAMP = { dist: 1.2 };

/**
 * Point-blank sprite handling: scale a billboard about the eye point so it projects exactly
 * like the same sprite pushed back to NEAR_CLAMP.dist along the view ray, while keeping its real
 * depth (it never sinks into the wall behind it). Returns the height scale and how far (m)
 * to lift the sprite's foot. cam = camera position in three.js coords (x, height, y).
 */
export function nearClamp(cam: { x: number; y: number; z: number }, x: number, y: number, floorH: number): { scale: number; lift: number } {
  const d = Math.hypot(x - cam.x, y - cam.z);
  if (d >= NEAR_CLAMP.dist) return { scale: 1, lift: 0 };
  const s = Math.max(d, 0.2) / NEAR_CLAMP.dist;
  return { scale: s, lift: (cam.y - floorH) * (1 - s) };
}

/** Knock-back/stagger: how far a hard-hit sprite is shoved, and for how long (s). */
const KICK_DIST = 0.28;
const KICK_TIME = 0.3;

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
  private kicks = new Map<Monster, { dx: number; dy: number; t: number; amt: number }>();

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
  }

  /**
   * Visual stagger: shove the sprite away from (fx, fy) and let it rock back. Purely
   * cosmetic — CDDA only moves monsters on specific techniques.
   */
  kick(m: Monster, fx: number, fy: number, strength = 1): void {
    const d = Math.hypot(m.x - fx, m.y - fy) || 1;
    this.kicks.set(m, { dx: (m.x - fx) / d, dy: (m.y - fy) / d, t: 0, amt: KICK_DIST * Math.min(1.5, strength) });
  }

  /** A monster's current billboard frame and height (m), or undefined without one. */
  spriteOf(m: Monster): { frame: TileFrame; height: number } | undefined {
    const v = this.views.get(m);
    return v && { frame: v.frame, height: v.height };
  }

  flash(m: Monster, color: number, seconds: number): void {
    this.views.get(m)?.h.flash(color, seconds);
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
    const cam = this.renderer.rig.camera.position;
    // Live monsters: only those in the bubble have sprites.
    for (const m of this.sys.active) {
      if (m.dead) continue;
      let v = this.views.get(m);
      if (!v) v = this.create(m);
      // Walk bob and a stumbling sway (a fraction of a level so the billboard lifts in metres).
      const bob = m.moving ? Math.abs(Math.sin(m.walkPhase * Math.PI)) * 0.07 : 0;
      const sway = m.has('STUMBLES') && m.moving ? Math.sin(m.wobble) * 0.06 : 0;
      const downed = m.hasEffect('downed');
      // Stagger: out fast, back slowly, with a slight squash at the peak of the shove.
      let kx = 0, ky = 0, squash = 1;
      const k = this.kicks.get(m);
      if (k) {
        k.t += dt;
        const u = k.t / KICK_TIME;
        if (u >= 1) this.kicks.delete(m);
        else {
          const a = k.amt * (u < 0.25 ? u / 0.25 : 1 - (u - 0.25) / 0.75);
          kx = k.dx * a;
          ky = k.dy * a;
          squash = 1 - 0.08 * Math.sin(Math.min(1, u * 2) * Math.PI);
        }
      }
      const x = m.x + sway * Math.cos(p.yaw) + kx, y = m.y + sway * Math.sin(p.yaw) + ky;
      const near = nearClamp(cam, x, y, m.z * LEVEL_HEIGHT);
      v.h.set(x, y, m.z + (bob * near.scale + near.lift) / LEVEL_HEIGHT);
      v.h.setVisible(Math.abs(m.z - p.z) <= 1);
      v.h.setFrame(v.frame, (downed ? v.height * 0.5 : v.height) * squash * near.scale);
    }
    for (const [m] of this.views) if (m.dead || m.dormant) this.drop(m);
    for (const [m] of this.kicks) if (m.dead || m.dormant) this.kicks.delete(m);

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
  }
}
