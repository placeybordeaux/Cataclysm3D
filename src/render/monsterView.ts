import { appearanceSeed } from './appearanceSeed';
import type { Game, GameSystem } from '../game/game';
import { monsterSize, type Monster } from '../game/monster';
import type { CorpseRecord, MonsterSystem } from '../game/monai';
import type { PlayerCombat } from '../game/playercombat';
import { sfx } from '../audio/sfx';
import { CHUNK, LEVEL_HEIGHT } from '../world/coords';
import { loadAtlas, type Atlas, type FrameRef } from './atlas';
import type { Renderer } from './renderer';
import type { SpriteHandle } from './sprites';
import type { TileFrame } from './textureSource';
import type { LightHandle } from './lights';
import { charLayers, charSettings, frameKey, spriteInfo, type CharLayers } from './chars';
import { bodyShapeOf } from './chars/archetype';
import { CreatureModel, DEATH_TOTAL as MODEL_DEATH_TOTAL, FallingBody } from './chars/creature';
import { makeRig, type Rig } from './chars/rig';
import { FxMeshes } from './chars/fxMeshes';
import { cardsOn } from './cards';
import { cddaColor } from './atlasIndex';
import type { MonsterDef } from '../data/types';
import { liftOf } from '../game/stairwalk';
import { flies, floorKnown } from '../game/standing';
import { warnOnce } from '../data/warn';

// Billboards for monsters, their corpses and projectiles (blood/bile/acid decals are drawn by
// render/worldFx.ts from the map fields the monster system adds). Runs as a
// GameSystem (30 Hz) so `cdda.step()` + `cdda.settle()` screenshots see the same state the
// simulation has; movement at 30 Hz reads fine in the pixel-art style.
//
// Combat feel (src/game/combatfeel.ts) is mostly read here, straight off the monster:
//  - a telegraphed blow (`m.windup`) rears the sprite back and up, flashes it warm at the start
//    and hot just before it lands, then lunges it forward when the blow resolves
//  - hits rock it away (kick, scaled by the blow's share of max HP), squash it and shiver it
//    while it flinches; hit-stop holds the struck sprite still for a few frames
//  - downed monsters lie flat; the dead stagger along the killing blow, fall, bounce and thud
//
// Scale: UltiCa human sprites are 32x48 px for a ~1.75 m person, so MON_PPM px per metre.
//
// Two ways to draw a creature (charSettings.mode, docs/CHARACTERS.md): 'model' = a low-poly
// procedural body (render/chars) textured from the sprite, turning to face where it goes and
// posed at a stepped frame rate; 'billboard' = the sprite itself, always facing the camera.
// Both get the same combat-feel inputs computed below.

const MON_PPM = 48 / 1.75;
/** Dormant monsters are drawn out to the draw distance, capped here (m). */
export const FAR_FIGURE_MAX = 130;
const GLYPH_HEIGHT = { tiny: 0.45, small: 0.8, medium: 1.7, large: 2.3, huge: 3.2 } as const;
/** Fallen corpses: squashed to this fraction of standing height, this much wider. */
const FALLEN = 0.3;
const FALLEN_WIDE = 1.5;
/** Death: stagger along the killing blow, then fall, then a small bounce (s). */
const DIE_STAGGER = 0.1;
const DIE_FALL = 0.32;
const DIE_BOUNCE = 0.14;
const DIE_TOTAL = DIE_STAGGER + DIE_FALL + DIE_BOUNCE;
/** Lying down / getting up takes this long (s). */
const DOWN_TIME = 0.22;

interface MonView {
  /** billboard mode */
  h: SpriteHandle | null;
  /** model mode */
  c: CreatureModel | null;
  frame: TileFrame;
  height: number;
  typeId: string;
  /** 0 standing .. 1 lying (downed). */
  down: number;
  /** Hit-stop: sim seconds the sprite holds where it is. */
  hold: number;
  /** Second (hotter) telegraph flash already fired for the current wind-up. */
  warned: boolean;
}

interface CorpseView {
  h: SpriteHandle | null;
  body: FallingBody | null;
  rec: CorpseRecord;
  frame: TileFrame;
  height: number;
  t: number;
  /** Where the body starts falling from and the slide along the killing blow (tiles). */
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  heavy: boolean;
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

const proxyWarned = new Set<string>();
/**
 * Stand-in sprite ids (tried in order) for a monster the tileset has no art for: same kind
 * first (a zombie soldier variant -> the zombie soldier), then a generic silhouette by
 * species / CDDA symbol. Empty = keep the glyph (debug monsters). Pure, for tests.
 */
export function proxySprites(id: string, symbol: string, species: string[]): string[] {
  const rules: [RegExp, string[]][] = [
    [/soldier_camo|grenadier|military/, ['mon_zombie_soldier']],
    [/blackops/, ['mon_zombie_soldier_blackops_1', 'mon_zombie_soldier']],
    [/swat/, ['mon_zombie_swat', 'mon_zombie_cop']],
    [/nurse|surgeon|vivisector|medical/, ['mon_zombie_medical', 'mon_zombie_scientist']],
    [/foreman/, ['mon_zombie_technician', 'mon_zombie']],
    [/conjoiner|flesh_angel|zomblimp|zomballoon/, ['mon_zombie_brute', 'mon_zombie']],
    [/homunculus/, ['mon_zombie_child']],
    [/^mon_spider_(jumping|trapdoor|widow|wolf)$/, [`${id}_giant`]],
    [/^mon_(mosquito|dragonfly|slug|frog)$/, [`${id}_giant`]],
    [/shrew|mouse/, ['mon_sewer_rat', 'mon_rabbit']],
    [/^mon_bat_/, ['mon_bat']],
    [/triffid/, ['mon_triffid']],
    [/kraken/, ['mon_blob']],
    [/shade|suspended|anomaly/, ['mon_shadow']],
  ];
  if (/^debug_mon/.test(id)) return [];
  for (const [re, ids] of rules) if (re.test(id)) return ids;
  if (species.includes('ROBOT')) return ['mon_riotbot', 'mon_secubot'];
  if (species.includes('HUMAN') && symbol === '@') return ['mon_feral_human_pipe', 'mon_zombie'];
  if (species.includes('INSECT')) return ['mon_fly', 'mon_bee'];
  if (species.includes('SPIDER')) return ['mon_spider_web_s', 'mon_spider_web'];
  if (/[ZH@MSh]/.test(symbol)) return ['mon_zombie'];
  if (species.includes('MAMMAL') || /[Cd]/.test(symbol)) return ['mon_dog'];
  return [];
}

/**
 * Melee-range aim alignment: UltiCa people are drawn ~1.4-1.5 m to the top of the head while
 * the eye is at 1.6 m, so a zombie at arm's length (clamped to NEAR_CLAMP) had its head
 * well below the crosshair and newcomers "aimed at the head" over it (QA_V2 #24). Inside
 * `full` metres the sprite is raised so the point `frac` of its frame height (UltiCa frames
 * have empty rows on top: this is about the face)
 * sits at eye level, fading out by `none` metres, where its feet come back into view.
 * The camera raycast (game/raycast.ts CREATURE_HEIGHT slab) still covers the raised sprite.
 */
export const MELEE_AIM = { full: 1.3, none: 2.3, frac: 0.7 };

/** Extra lift (m) of a creature's foot at horizontal distance d; eyeAboveFoot = eye - foot. */
export function meleeAimLift(d: number, eyeAboveFoot: number, height: number): number {
  const t = Math.min(1, Math.max(0, (d - MELEE_AIM.full) / (MELEE_AIM.none - MELEE_AIM.full)));
  const k = 1 - t * t * (3 - 2 * t);
  if (k <= 0) return 0;
  // never more than 0.5 m (a crouched eye over a tall creature wants nothing: clamp at 0)
  return Math.min(0.5, Math.max(0, eyeAboveFoot - height * MELEE_AIM.frac)) * k;
}

/**
 * Telegraph pose for wind-up progress u (0 = just started, 1 = about to land): how far the
 * sprite rears back from its target (m) and how much taller/narrower it gets. Heavy blows
 * rear further. Pure, for tests.
 */
export function telegraphPose(u: number, heavy: boolean): { back: number; stretch: number; narrow: number } {
  const k = Math.min(1, Math.max(0, u));
  const e = k * k * (3 - 2 * k);
  return { back: e * (heavy ? 0.28 : 0.18), stretch: 1 + e * (heavy ? 0.13 : 0.1), narrow: 1 - e * 0.06 };
}

/** Death animation at time t: slide share (0..1), height and width multipliers. Pure, for tests. */
export function deathPose(t: number): { slide: number; hgt: number; wide: number; landed: boolean } {
  if (t < DIE_STAGGER) return { slide: (t / DIE_STAGGER) * 0.5, hgt: 1, wide: 1, landed: false };
  const f = Math.min(1, (t - DIE_STAGGER) / DIE_FALL);
  if (t < DIE_STAGGER + DIE_FALL) {
    const k = f * f; // accelerates like a body toppling
    return { slide: 0.5 + 0.5 * f, hgt: 1 - (1 - FALLEN) * k, wide: 1 + (FALLEN_WIDE - 1) * k, landed: false };
  }
  const b = Math.min(1, (t - DIE_STAGGER - DIE_FALL) / DIE_BOUNCE);
  return { slide: 1, hgt: FALLEN * (1 + 0.18 * Math.sin(b * Math.PI)), wide: FALLEN_WIDE, landed: true };
}

/** Knock-back/stagger: how far a hard-hit sprite is shoved, and for how long (s). */
const KICK_DIST = 0.28;
const KICK_TIME = 0.3;

function toFrame(r: FrameRef, flip = false): TileFrame {
  const uv: [number, number, number, number] = flip ? [r.uv.u1, r.uv.v0, r.uv.u0, r.uv.v1] : [r.uv.u0, r.uv.v0, r.uv.u1, r.uv.v1];
  return { texture: r.texture, uv, w: r.w, h: r.h, ppm: 32 };
}

/** Hash a uid to 0..1 (per-creature animation offset). */
function seedOf(uid: number): number {
  const x = Math.sin(uid * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** Per-frame time for creating monster visuals beyond 20 m (see update). */
const CREATE_MS = 4;

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
  private chars: CharLayers | null = null;
  private fx: FxMeshes | null = null;
  /** dormant monsters drawn as far figures (farFigures) */
  private far: Monster[] = [];
  private farSet = new Set<Monster>();
  private farScan = 0;
  private farRange = FAR_FIGURE_MAX;
  private rigs = new Map<string, Rig>();
  /** A body hit the ground (hitFx puts dust/blood there). */
  onBodyLanded: ((x: number, y: number, z: number, blood: string | null) => void) | null = null;

  constructor(readonly game: Game, readonly renderer: Renderer, readonly sys: MonsterSystem, readonly combat: PlayerCombat | null) {
    // only hides: showing waits for the next tick's update (src/render/surroundings.ts)
    renderer.chunks.afterUpdate.push(() => {
      const ch = renderer.chunks;
      for (const [m, v] of this.views) if (!ch.drawnAt(m.x, m.y, m.z)) (v.c?.inst.setVisible(false), v.h?.setVisible(false));
      for (const [c, v] of this.corpses) if (!ch.drawnAt(c.x, c.y, c.z)) (v.body?.inst.setVisible(false), v.h?.setVisible(false));
    });
    loadAtlas().then(
      (a) => {
        this.atlas = a;
        // Re-skin anything created with glyph fallbacks before the atlas arrived.
        for (const [m, v] of this.views) this.refresh(m, v);
        for (const [c, v] of this.corpses) this.remakeCorpse(c, v);
      },
      () => {},
    );
    sys.onHurt.push((m) => this.flash(m, 0xff2a2a, 0.18));
    sys.onDied.push((m, c) => this.died(m, c));
    sys.onRemoved.push((m) => this.drop(m));
    sys.onCorpseGone.push((c) => this.dropCorpse(c));
    sys.onCorpse.push((c) => {
      const def = game.data.monsters[c.monId];
      const f = this.frameFor({ type: def, uid: 0, size: monsterSize(def) });
      const v: CorpseView = { h: null, body: null, rec: c, frame: f.frame, height: f.height, t: DIE_TOTAL, x0: c.x, y0: c.y, dx: 0, dy: 0, heavy: false };
      this.makeCorpseVisual(v, def, 0, true);
      this.corpses.set(c, v);
    });
    sys.onSpawned.push((m) => {
      const v = this.views.get(m);
      if (v && v.typeId !== m.type.id) this.refresh(m, v);
    });
    game.events.on('monsterAttack', (e) => {
      const m = e.monster as Monster;
      const v = this.views.get(m);
      if (!v) return;
      const p = game.player;
      if (e.phase === 'windup') {
        v.warned = false;
        this.flash(m, 0xffd890, 0.14);
      } else if (e.phase === 'resolved' || e.phase === 'whiff') {
        // Lunge: shove the sprite toward its target (a kick from the far side).
        this.kick(m, 2 * m.x - p.x, 2 * m.y - p.y, e.heavy ? 0.9 : 0.6);
        v.c?.strike();
      }
    });
    game.events.on('playerAttack', (e) => {
      const m = e.target as Monster | undefined;
      const v = m && this.views.get(m);
      if (v && e.hitStop) v.hold = Math.max(v.hold, e.hitStop);
    });
    charSettings.listeners.push(() => this.rebuildAll());
  }

  private get models(): boolean {
    return charSettings.mode === 'model';
  }

  private layers(): CharLayers {
    return (this.chars ??= charLayers(this.renderer));
  }

  /** Procedural body for a monster type (shared by every monster of the type). */
  rigFor(def: MonsterDef): Rig {
    let r = this.rigs.get(def.id);
    if (!r) {
      const shape = bodyShapeOf({ id: def.id, bodytype: (def as { bodytype?: string }).bodytype, species: def.species, flags: def.flags, symbol: def.symbol, volume: def.volume, name: def.name, description: def.description });
      r = makeRig(shape, { turret: def.symbol === '2' || /turret/.test(def.id) });
      this.rigs.set(def.id, r);
    }
    return r;
  }

  private skinFor(rig: Rig, frame: TileFrame) {
    return this.layers().store.get(rig, { key: frameKey(frame), info: () => spriteInfo(frame) });
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

  /**
   * Where a monster's body is, for effects that aim at it (blood sprays, stuck arrows):
   * metres above its feet and its half-width. null = no view (billboard art span applies).
   */
  bodyOf(m: Monster): { bottom: number; top: number; radius: number } | null {
    const v = this.views.get(m);
    if (!v?.c) return null;
    const rig = v.c.rig;
    const core = rig.parts.find((p) => p.kind === 'core');
    const radius = core ? Math.max(0.08, Math.min(core.size[0], core.size[2]) * 0.55) : m.radius;
    return { bottom: rig.height * 0.15 + rig.hover, top: rig.height * 0.95 + rig.hover, radius };
  }

  /** The drawn 3D body of a monster (src/aim.ts: exact hit zones, the dodge hop), or null. */
  modelOf(m: Monster): CreatureModel['inst'] | null {
    return this.views.get(m)?.c?.inst ?? null;
  }

  flash(m: Monster, color: number, seconds: number): void {
    const v = this.views.get(m);
    v?.h?.flash(color, seconds);
    v?.c?.flash(color, seconds);
  }

  /** Sprite frame + height for a monster type (atlas sprite, looks_like chain, glyph fallback). */
  frameFor(m: Monster | { type: Monster['type']; uid: number; size: Monster['size'] }): { frame: TileFrame; height: number } {
    const def = m.type;
    const a = this.atlas;
    if (a) {
      const hit = a.lookupWithLooksLike(def.id, (id) => this.game.data.monsters[id]?.looks_like as string | undefined, { variantSeed: appearanceSeed(m) });
      if (hit?.fg) return { frame: toFrame(hit.fg), height: hit.fg.h / MON_PPM };
    }
    if (a) {
      // No art (BN-only monsters UltiCa never drew): a stand-in sprite of the same kind
      // reads as a creature; a floating CDDA letter read as a sign (QA_V2 #25).
      for (const id of proxySprites(def.id, def.symbol, def.species ?? [])) {
        const hit = a.lookup(id, { variantSeed: appearanceSeed(m) });
        if (!hit?.fg) continue;
        if (!proxyWarned.has(def.id)) {
          proxyWarned.add(def.id);
          console.warn(`monsterView: no sprite for ${def.id}, drawing ${id}`);
        }
        const h = hit.fg.h / MON_PPM;
        // small creatures borrow a giant's sprite: keep them their own size
        return { frame: toFrame(hit.fg), height: Math.min(h, h * (GLYPH_HEIGHT[m.size] / GLYPH_HEIGHT.medium)) };
      }
    }
    const frame = a ? toFrame(a.glyph(def.symbol, def.color)) : this.renderer.source.glyph(def.symbol, def.color);
    return { frame, height: GLYPH_HEIGHT[m.size] };
  }

  private create(m: Monster): MonView {
    const { frame, height } = this.frameFor(m);
    const v: MonView = { h: null, c: null, frame, height, typeId: m.type.id, down: 0, hold: 0, warned: false };
    this.makeVisual(m, v);
    this.views.set(m, v);
    return v;
  }

  private makeVisual(m: Monster, v: MonView): void {
    if (this.models) {
      const rig = this.rigFor(m.type);
      v.c = new CreatureModel(this.layers().live, rig, this.skinFor(rig, v.frame), seedOf(appearanceSeed(m)), m.x, m.y, m.facing);
    } else v.h = this.renderer.sprites.add({ x: m.x, y: m.y, z: m.z, frame: v.frame, height: v.height });
  }

  private dropVisual(v: MonView): void {
    v.h?.remove();
    v.c?.remove();
    v.h = null;
    v.c = null;
  }

  private refresh(m: Monster, v: MonView): void {
    const { frame, height } = this.frameFor(m);
    v.frame = frame;
    v.height = height;
    v.typeId = m.type.id;
    if (v.h) v.h.setFrame(frame, height);
    else if (v.c) {
      this.dropVisual(v);
      this.makeVisual(m, v);
    }
  }

  /** Display mode switched: rebuild every creature and body in the other style. */
  private rebuildAll(): void {
    for (const [m, v] of this.views) {
      this.dropVisual(v);
      this.makeVisual(m, v);
    }
    for (const [c, v] of this.corpses) this.remakeCorpse(c, v);
  }

  private remakeCorpse(c: CorpseRecord, v: CorpseView): void {
    const def = this.game.data.monsters[c.monId];
    const f = this.frameFor({ type: def, uid: 0, size: monsterSize(def) });
    v.frame = f.frame;
    v.height = f.height;
    v.h?.remove();
    v.body?.remove();
    v.h = null;
    v.body = null;
    v.t = Math.max(v.t, DIE_TOTAL);
    this.makeCorpseVisual(v, def, 0, true);
  }

  /** The lying (or about to fall) body: a billboard or a 3D body on the corpse layer. */
  private makeCorpseVisual(v: CorpseView, def: MonsterDef, uid: number, done: boolean): void {
    const c = v.rec;
    if (this.models) {
      const rig = this.rigFor(def);
      v.body = new FallingBody(this.layers().dead, rig, this.skinFor(rig, v.frame), seedOf(uid || Math.floor(c.x * 7 + c.y * 13)), v.x0, v.y0, c.z, c.facing, v.dx, v.dy, done);
    } else {
      v.h = this.renderer.sprites.add({ x: v.x0 + v.dx, y: v.y0 + v.dy, z: c.z, frame: v.frame, height: v.height });
      if (done) v.h.setSize((v.frame.w / MON_PPM) * FALLEN_WIDE, v.height * FALLEN);
    }
  }

  private drop(m: Monster): void {
    const v = this.views.get(m);
    if (!v) return;
    this.dropVisual(v);
    this.views.delete(m);
  }

  private died(m: Monster, c: CorpseRecord | null): void {
    const v = this.views.get(m);
    const f = v ? { frame: v.frame, height: v.height } : this.frameFor(m);
    this.drop(m);
    if (!c) return;
    // placeCorpse's onCorpse already made a lying body for this record (it runs before onDied);
    // replace it, or it stays behind as a second, orphaned body under the falling one.
    this.dropCorpse(c);
    // Keep the body as a sprite that staggers along the killing blow, topples and bounces; it
    // lives as long as the corpse item. Killed up close by the survivor: slide away from them.
    const p = this.game.player;
    const d = Math.hypot(m.x - p.x, m.y - p.y);
    const slide = d < 6 && d > 0.01 ? 0.35 : 0;
    const cv: CorpseView = {
      h: null, body: null, rec: c, frame: f.frame, height: f.height, t: 0, x0: m.x, y0: m.y,
      dx: slide ? ((m.x - p.x) / d) * slide : 0, dy: slide ? ((m.y - p.y) / d) * slide : 0, heavy: m.size === 'large' || m.size === 'huge',
    };
    // the dying body keeps the facing it had, so a 3D body falls from where it stood
    c.facing = m.facing;
    this.makeCorpseVisual(cv, m.type, appearanceSeed(m), false);
    if (cv.h) cv.h.set(m.x, m.y, c.z);
    cv.h?.flash(0xff2020, 0.15);
    cv.body?.inst.flash(0xff2020, 0.15);
    this.corpses.set(c, cv);
  }

  private dropCorpse(c: CorpseRecord): void {
    const v = this.corpses.get(c);
    if (!v) return;
    v.h?.remove();
    v.body?.remove();
    this.corpses.delete(c);
  }

  update(game: Game, dt: number): void {
    const p = game.player;
    const cam = this.renderer.rig.camera.position;
    // Live monsters: those in the bubble, plus dormant ones out to the draw distance (see farFigures).
    this.farScan -= dt;
    if (this.farScan <= 0) {
      this.farScan = 0.5;
      this.farFigures(p);
    }
    // Building a monster's body (rig, painted skin) is 1-5 ms; a load or a drive into a horde
    // asked for dozens in one frame (40-80 ms, docs/PERF.md). Beyond 20 m they appear over a
    // few frames instead: at most CREATE_MS of creation per frame, the first one always.
    let createMs = 0;
    for (const m of this.sys.active.length ? [...this.sys.active, ...this.far] : this.far) {
      if (m.dead) continue;
      let v = this.views.get(m);
      if (!v) {
        if (createMs > CREATE_MS && Math.hypot(m.x - p.x, m.y - p.y) > 20) continue;
        const c0 = performance.now();
        v = this.create(m);
        createMs += performance.now() - c0 + 0.01;
      }
      // drawn iff its level is (src/world/levels.ts) and the walls and floors around it are
      // on screen (src/render/surroundings.ts): never a zombie in mid-air before its building
      const visible = this.renderer.chunks.drawnAt(m.x, m.y, m.z);
      v.h?.setVisible(visible);
      // Hit-stop: the struck sprite holds exactly where the blow found it.
      if (v.hold > 0) {
        v.hold = Math.max(0, v.hold - dt);
        continue;
      }
      // Walk bob and a stumbling sway (a fraction of a level so the billboard lifts in metres).
      const bob = m.moving ? Math.abs(Math.sin(m.walkPhase * Math.PI)) * 0.07 : 0;
      const sway = m.has('STUMBLES') && m.moving ? Math.sin(m.wobble) * 0.06 : 0;
      v.down += ((m.hasEffect('downed') ? 1 : 0) - v.down) * Math.min(1, dt / DOWN_TIME * 3);
      // Stagger: out fast, back slowly, with a slight squash at the peak of the shove.
      let kx = 0, ky = 0, squash = 1, kickK = 0;
      const k = this.kicks.get(m);
      if (k) {
        k.t += dt;
        const u = k.t / KICK_TIME;
        if (u >= 1) this.kicks.delete(m);
        else {
          const a = k.amt * (u < 0.25 ? u / 0.25 : 1 - (u - 0.25) / 0.75);
          kx = k.dx * a;
          ky = k.dy * a;
          kickK = a / KICK_DIST;
          squash = 1 - 0.08 * Math.sin(Math.min(1, u * 2) * Math.PI);
        }
      }
      // Flinch: a quick shiver across the view while it reels.
      if (m.flinch > 0) {
        const j = Math.sin(this.sys.time * 60 + m.uid) * Math.min(0.05, m.flinch * 0.2);
        kx += j * Math.cos(p.yaw);
        ky += j * Math.sin(p.yaw);
      }
      // Telegraph: rear back from the survivor and draw up, hot flash just before it lands.
      let stretch = 1, narrow = 1;
      const w = m.windup;
      if (w) {
        const u = 1 - w.t / Math.max(1e-3, w.total);
        const tp = telegraphPose(u, w.kind === 'heavy');
        const d = Math.hypot(m.x - p.x, m.y - p.y) || 1;
        // A leap crouches instead of rearing up.
        if (w.kind === 'leap') stretch = 1 - 0.12 * Math.min(1, u * 1.5);
        else {
          kx += ((m.x - p.x) / d) * tp.back;
          ky += ((m.y - p.y) / d) * tp.back;
          stretch = tp.stretch;
          narrow = tp.narrow;
        }
        if (!v.warned && u >= 0.72) {
          v.warned = true;
          this.flash(m, 0xfff4d0, 0.12);
        }
      }
      if (v.c) {
        // 3D body: the pose carries the bob, telegraph and flinch; the sway and shoves move it.
        const x = m.x + kx + sway * Math.cos(m.facing), y = m.y + ky + sway * Math.sin(m.facing);
        const dP = Math.hypot(m.x - p.x, m.y - p.y);
        const fighting = m.z === p.z && m.attitude() === 'attack' && (!!w || dP < 2.5);
        v.c.update(dt, {
          x, y, z: m.z, facing: m.facing, target: fighting ? { x: p.x, y: p.y } : null,
          moving: m.moving, walkPhase: m.walkPhase,
          windup: w ? { elapsed: w.total - w.t, total: w.total, kind: w.kind } : null,
          flinch: Math.min(1, Math.max(m.flinch * 4, kickK)), down: v.down, visible,
          emph: m.attitude() === 'attack' ? 1 : 0, camDist: Math.hypot(x - cam.x, y - cam.z), lift: liftOf(m),
          // far figures dissolve over the last 12 m before the draw distance instead of popping
          fade: m.dormant ? Math.min(1, Math.max(0, (Math.hypot(m.x - p.x, m.y - p.y) - (this.farRange - 12)) / 12)) : 0,
          sy: 1 + (stretch - 1) * 0.5 - (1 - squash) * 0.5, sxz: 1 - (1 - narrow) * 0.5,
        });
        continue;
      }
      const h = v.h!;
      const x = m.x + sway * Math.cos(p.yaw) + kx, y = m.y + sway * Math.sin(p.yaw) + ky;
      // foot height as drawn (the sprite layer adds the look's ground relief itself)
      const climb = liftOf(m);
      const foot = m.z * LEVEL_HEIGHT + (this.renderer.groundAt?.(x, y, m.z) ?? 0) + climb;
      const aim = v.down > 0 || this.renderer.cameraMode !== 'first' ? 0 : meleeAimLift(Math.hypot(x - cam.x, y - cam.z), cam.y - foot, v.height);
      const near = nearClamp(cam, x, y, foot + aim);
      h.set(x, y, m.z + (bob * near.scale + aim + near.lift + climb) / LEVEL_HEIGHT);
      // Lying down: short and wide instead of the old half-height stand.
      const lie = v.down;
      const hgt = v.height * (1 - (1 - FALLEN) * lie) * squash * stretch * near.scale;
      const wid = (v.height * (v.frame.w / v.frame.h)) * (1 + (FALLEN_WIDE - 1) * lie) * (2 - squash) * narrow * near.scale;
      h.setSize(wid, hgt);
    }
    for (const [m] of this.views) if (m.dead || (m.dormant && !this.farSet.has(m))) this.drop(m);
    for (const [m] of this.kicks) if (m.dead || m.dormant) this.kicks.delete(m);

    // Corpses: stagger -> fall -> bounce, then persist until the item is gone.
    this.corpseCheck -= dt;
    const check = this.corpseCheck <= 0;
    if (check) this.corpseCheck = 1;
    for (const [c, v] of this.corpses) {
      if (check && !this.sys.corpseValid(c)) {
        this.dropCorpse(c);
        continue;
      }
      // a body lies on a floor: not before that floor (and the walls around it) is on screen
      const shown = this.renderer.chunks.drawnAt(c.x, c.y, c.z);
      v.body?.inst.setVisible(shown);
      v.h?.setVisible(shown);
      if (v.body) {
        if (v.body.t < MODEL_DEATH_TOTAL && v.body.update(dt)) this.landed(v, c);
        continue;
      }
      if (v.t < DIE_TOTAL && v.h) {
        const before = deathPose(v.t);
        v.t = Math.min(DIE_TOTAL, v.t + dt);
        const pose = deathPose(v.t);
        if (pose.landed && !before.landed) this.landed(v, c);
        v.h.set(v.x0 + v.dx * pose.slide, v.y0 + v.dy * pose.slide, c.z);
        v.h.setSize((v.frame.w / MON_PPM) * pose.wide, v.height * pose.hgt);
      }
    }

    // Projectiles (acid globs, bile, thrown items).
    for (const h of this.projectiles) h.remove();
    this.projectiles.length = 0;
    // (3D: a glob mesh in the glyph's colour flying along its path; billboards: the glyph)
    this.fx ??= cardsOn() ? new FxMeshes(this.renderer) : null;
    this.fx?.begin();
    for (const pr of this.sys.projectiles) {
      if (this.fx) {
        this.fx.place('glob', pr.x, pr.y, pr.z, 1.1, [pr.vx || 1e-3, pr.vy, 0], cddaColor(pr.glyph.color));
        continue;
      }
      const frame = this.atlas ? toFrame(this.atlas.glyph(pr.glyph.symbol, pr.glyph.color)) : this.renderer.source.glyph(pr.glyph.symbol, pr.glyph.color);
      this.projectiles.push(this.renderer.sprites.add({ x: pr.x, y: pr.y, z: pr.z, frame, height: 0.35, anchor: 'center', lift: 1.1 }));
    }

    // Gunfire: muzzle flash light + a spark where the bullet stopped.
    for (const h of this.tracerSprites) h.remove();
    this.tracerSprites.length = 0;
    const tracers = this.combat?.tracers ?? [];
    // Only burning powder lights the room: bows, slings, crossbows and air guns don't flash.
    const shots = this.combat?.flashShots ?? 0;
    if (shots > this.lastShots) {
      this.muzzle ??= this.renderer.lights.add({ x: p.x, y: p.y, z: p.z, color: 0xffd080, intensity: 2, radius: 8, height: 1.4 });
      this.muzzle.set(p.x, p.y, p.z);
      this.muzzle.intensity = 2;
      this.muzzleT = 0.06;
    }
    this.lastShots = shots;
    for (const t of tracers) {
      if (this.fx) {
        this.fx.place('spark', t.x1, t.y1, t.z, 1.2, [1, 0, 0], [255, 226, 120]);
        continue;
      }
      const frame = this.atlas ? toFrame(this.atlas.glyph('*', 'yellow')) : this.renderer.source.glyph('*', 'yellow');
      this.tracerSprites.push(this.renderer.sprites.add({ x: t.x1, y: t.y1, z: t.z, frame, height: 0.3, anchor: 'center', lift: 1.2 }));
    }
    this.fx?.end();
    if (this.muzzle) {
      this.muzzleT -= dt;
      if (this.muzzleT <= 0) this.muzzle.intensity = 0;
    }
    this.sys.playerLight = () => (this.renderer.flashlightOn ? 60 : 0);
  }

  /**
   * Dormant monsters (outside monai's ACTIVE_RADIUS reality bubble) aren't simulated, but a
   * horde 80 m down a long road should still be seen coming: they are drawn where they stand
   * (or drift) out to the draw distance, idling, with the same far-LOD silhouette and hostile
   * emphasis as live ones. Rescanned twice a second; sys.all can be long.
   */
  private farFigures(p: { x: number; y: number; z: number }): void {
    this.far.length = 0;
    this.farSet.clear();
    const range = Math.min(FAR_FIGURE_MAX, (this.renderer.chunks.radius + 0.5) * CHUNK);
    this.farRange = range;
    for (const m of this.sys.all) {
      // (the level extent only: whether its chunk is built yet is decided per frame in update)
      if (m.dead || !m.dormant || !this.renderer.chunks.levels.drawn(m.x, m.y, m.z)) continue;
      // a dormant figure indoors on another level is behind walls and floors (at most a glimpse
      // through a window): skipping them saved ~0.4 ms/frame in a city (docs/PERF.md)
      if (m.z !== p.z && this.renderer.chunks.covered(Math.floor(m.x), Math.floor(m.y), m.z)) continue;
      if (Math.hypot(m.x - p.x, m.y - p.y) > range) continue;
      // never a figure hanging in the air: placement keeps monsters on floors (standing.ts) and
      // monai settles strays within a second, so one seen here is a bug to report, not draw
      if (!flies(m.type) && floorKnown(this.game.map, m.tileX, m.tileY, m.z) === false) {
        warnOnce('unsupported-monster', m.type.id, `[monsters] ${m.type.id} at ${m.tileX},${m.tileY},${m.z} stands on no floor (dormant=${m.dormant})`);
        continue;
      }
      this.far.push(m);
      this.farSet.add(m);
    }
  }

  private landed(v: CorpseView, c: CorpseRecord): void {
    sfx.bodyFall({ x: v.x0 + v.dx, y: v.y0 + v.dy, z: c.z }, v.heavy);
    this.onBodyLanded?.(v.x0 + v.dx, v.y0 + v.dy, c.z, this.sys.bloodType(this.game.data.monsters[c.monId]));
  }
}

