import { meleeAimLift, nearClamp } from './monsterView';
import type { Game, GameSystem } from '../game/game';
import type { Npc } from '../game/npc';
import type { NpcSystem } from '../game/npcai';
import { LEVEL_HEIGHT } from '../world/coords';
import { loadAtlas, type Atlas, type FrameRef } from './atlas';
import { AtlasTextureSource } from './atlasSource';
import type { Renderer } from './renderer';
import type { SpriteHandle } from './sprites';
import type { TileFrame } from './textureSource';
import { charLayers, charSettings, frameKey, spriteInfo, type CharLayers } from './chars';
import { bodyShapeOf, weaponOf } from './chars/archetype';
import { CreatureModel, FallingBody } from './chars/creature';
import { makeRig, type Rig } from './chars/rig';
import { FxMeshes } from './chars/fxMeshes';
import { cardsOn } from './cards';

// NPCs: CDDA's npc_male / npc_female body with the worn clothing and wielded item overlays
// stacked on top (like the tileset draws characters), composited once per outfit. In 'model'
// mode (render/chars, docs/CHARACTERS.md) that composite is the paint source for a 3D person
// in the same clothes; in 'billboard' mode it is drawn as is. Dead NPCs crumple like monster
// corpses and stay while their corpse item does.

const HEIGHT = 1.75;
const FALL_TIME = 0.35;

interface View {
  h: SpriteHandle | null;
  c: CreatureModel | null;
  key: string;
  frame: TileFrame;
  /** attackCooldown last update: a jump means it just swung/fired */
  cool: number;
}

interface Body {
  h: SpriteHandle | null;
  body: FallingBody | null;
  npc: Npc;
  frame: TileFrame;
  t: number;
}

/** Atlas ids for an NPC's layers: body, worn items (inner to outer), wielded item. */
export function npcLayers(atlas: Atlas | null, n: Npc, looksLike: (id: string) => string | undefined): string[] {
  const g = n.male ? 'male' : 'female';
  const ids = [`npc_${g}`];
  const overlay = (kind: 'worn' | 'wielded', itemId: string): string | null => {
    for (let id: string | undefined = itemId, i = 0; id && i < 4; id = looksLike(id), i++) {
      for (const k of [`overlay_${g}_${kind}_${id}`, `overlay_${kind}_${id}`]) if (!atlas || atlas.lookup(k)) return k;
    }
    return null;
  };
  for (const it of n.inv.worn) {
    const k = overlay('worn', it.typeId);
    if (k) ids.push(k);
  }
  if (n.inv.wielded) {
    const k = overlay('wielded', n.inv.wielded.typeId);
    if (k) ids.push(k);
  }
  return ids;
}

/** Build buckets: [height scale, girth]. */
const BUILDS: [number, number][] = [[1, 1], [0.94, 0.9], [1.05, 1.0], [0.98, 1.18], [1.04, 1.1], [0.92, 1.05]];
/** A range of skin tones (UltiCa draws every NPC with the same body sprite). */
const SKINS: [number, number, number][] = [[236, 200, 176], [222, 178, 146], [196, 150, 112], [168, 118, 84], [128, 86, 58], [92, 62, 44], [212, 170, 128]];
const HAIR_COLORS: [number, number, number][] = [[30, 24, 20], [66, 44, 28], [104, 70, 40], [170, 128, 70], [200, 170, 110], [140, 60, 30], [150, 146, 140], [52, 40, 36]];
const HAIRS_M: NonNullable<Parameters<typeof makeRig>[0]['hair']>[] = ['short', 'short', 'none', 'short', 'long', 'none'];
const HAIRS_F: NonNullable<Parameters<typeof makeRig>[0]['hair']>[] = ['long', 'ponytail', 'long', 'short', 'ponytail', 'long'];

/**
 * How an NPC looks beyond their clothes, stable per NPC (their uid): build, skin tone, hair
 * colour and style — or the headgear they wear (caps, hats, helmets, from worn item ids).
 * Neighbouring uids land on different entries, so a group never looks cloned.
 */
export function npcLook(n: Npc): { build: number; skin: [number, number, number]; hairColor: [number, number, number]; hair: NonNullable<Parameters<typeof makeRig>[0]['hair']>; hat?: [number, number, number] } {
  const u = n.uid;
  const worn = n.inv.worn.map((w) => w.typeId).join(' ');
  const head = /helmet|hardhat|kevlar_helm|motorbike/.exec(worn) ? 'helmet' : /(^|[ _])(cap|beanie|hood|toque|balaclava)/.exec(worn) ? 'cap' : /hat(\b|_)|fedora|cowboy|stetson|tophat|sombrero/.exec(worn) ? 'hat' : null;
  const hairs = n.male !== false ? HAIRS_M : HAIRS_F;
  return {
    build: (u * 7 + 3) % BUILDS.length,
    skin: SKINS[(u * 5 + 1) % SKINS.length],
    hairColor: HAIR_COLORS[(u * 3 + 2) % HAIR_COLORS.length],
    hair: head ?? hairs[(u * 11 + 5) % hairs.length],
    hat: head === 'helmet' ? [70, 80, 60] : head ? ([[120, 40, 36], [40, 60, 110], [60, 60, 64], [120, 100, 70]] as [number, number, number][])[u % 4] : undefined,
  };
}

function seedOf(uid: number): number {
  const x = Math.sin(uid * 91.345 + 12.7) * 24634.6345;
  return x - Math.floor(x);
}

export class NpcView implements GameSystem {
  readonly name = 'npc-view';
  private atlas: Atlas | null = null;
  private views = new Map<Npc, View>();
  private bodies: Body[] = [];
  private shots: SpriteHandle[] = [];
  private bodyCheck = 0;
  private chars: CharLayers | null = null;
  private fx: FxMeshes | null = null;
  private rigs = new Map<string, Rig>();

  constructor(readonly game: Game, readonly renderer: Renderer, readonly sys: NpcSystem) {
    loadAtlas().then(
      (a) => {
        this.atlas = a;
        for (const [n, v] of this.views) this.refresh(n, v, true);
      },
      () => {},
    );
    sys.onHurt.push((n) => {
      const v = this.views.get(n);
      v?.h?.flash(0xff2a2a, 0.18);
      v?.c?.flash(0xff2a2a, 0.18);
    });
    sys.onRemoved.push((n) => this.drop(n));
    sys.onDied.push((n) => this.died(n));
    charSettings.listeners.push(() => this.rebuildAll());
  }

  private looksLike = (id: string) => this.game.data.items[id]?.looks_like as string | undefined;

  private get models(): boolean {
    return charSettings.mode === 'model';
  }

  private layers(): CharLayers {
    return (this.chars ??= charLayers(this.renderer));
  }

  private rigFor(n: Npc): Rig {
    // survivors are people: the humanoid body at BN's human volume, women a touch smaller,
    // holding whatever they wield, in their own build and hair (npcLook)
    const male = n.male !== false;
    const weapon = weaponOf(n.inv.wielded);
    const look = npcLook(n);
    const key = `${male ? 'm' : 'f'}:${weapon}:${look.build}:${look.hair}`;
    let r = this.rigs.get(key);
    if (!r) {
      const base = bodyShapeOf({ id: male ? 'npc_male' : 'npc_female', bodytype: 'human', species: ['HUMAN'], volume: 62500 });
      const [sc, gi] = BUILDS[look.build];
      r = makeRig({ ...base, scale: (male ? 1 : 0.95) * sc, girth: (male ? 1 : 0.92) * gi, weapon, hair: look.hair });
      this.rigs.set(key, r);
    }
    return r;
  }

  private skinFor(rig: Rig, frame: TileFrame, n?: Npc) {
    const look = n ? npcLook(n) : null;
    return this.layers().store.get(rig, {
      key: frameKey(frame), info: () => spriteInfo(frame),
      opts: look ? { person: { skin: look.skin, hair: look.hairColor, bald: look.hair === 'none', hat: look.hat } } : undefined,
    });
  }

  /** Composite frame for the NPC's current outfit (memoised by the layer list). */
  frameFor(n: Npc): { key: string; frame: TileFrame } {
    const ids = npcLayers(this.atlas, n, this.looksLike);
    const key = ids.join('|');
    const src = this.renderer.source;
    const f = src instanceof AtlasTextureSource ? src.composite(ids) : null;
    return { key, frame: f ?? this.glyphFrame(n) };
  }

  private glyphFrame(n: Npc): TileFrame {
    const col = n.isEnemy() ? 'red' : n.isAlly() ? 'light_green' : 'white';
    if (this.atlas) {
      const r: FrameRef = this.atlas.glyph('@', col);
      return { texture: r.texture, uv: [r.uv.u0, r.uv.v0, r.uv.u1, r.uv.v1], w: r.w, h: r.h, ppm: 32 };
    }
    return this.renderer.source.glyph('@', col);
  }

  private makeVisual(n: Npc, v: View): void {
    if (this.models) {
      const rig = this.rigFor(n);
      v.c = new CreatureModel(this.layers().live, rig, this.skinFor(rig, v.frame, n), seedOf(n.uid), n.x, n.y, n.facing);
    } else v.h = this.renderer.sprites.add({ x: n.x, y: n.y, z: n.z, frame: v.frame, height: HEIGHT });
  }

  private refresh(n: Npc, v: View, force = false): void {
    const { key, frame } = this.frameFor(n);
    if (!force && key === v.key) return;
    v.key = key;
    v.frame = frame;
    if (v.h) v.h.setFrame(frame, HEIGHT);
    // a new outfit or weapon: rebuild from the new composite (the rig may differ too)
    if (v.c) {
      v.c.remove();
      v.c = null;
      this.makeVisual(n, v);
    }
  }

  private rebuildAll(): void {
    for (const [n, v] of this.views) {
      v.h?.remove();
      v.c?.remove();
      v.h = null;
      v.c = null;
      this.makeVisual(n, v);
    }
    for (const b of this.bodies) {
      b.h?.remove();
      b.body?.remove();
      b.h = null;
      b.body = null;
      b.t = FALL_TIME;
      this.makeBody(b, true);
    }
  }

  private drop(n: Npc): void {
    const v = this.views.get(n);
    if (!v) return;
    v.h?.remove();
    v.c?.remove();
    this.views.delete(n);
  }

  private makeBody(b: Body, done: boolean): void {
    const n = b.npc;
    if (this.models) {
      const rig = this.rigFor(n);
      const p = this.game.player;
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      const slide = !done && d < 6 && d > 0.01 ? 0.3 : 0;
      b.body = new FallingBody(this.layers().dead, rig, this.skinFor(rig, b.frame, n), seedOf(n.uid), n.x, n.y, n.z, n.facing,
        slide ? ((n.x - p.x) / d) * slide : 0, slide ? ((n.y - p.y) / d) * slide : 0, done);
    } else {
      const k = Math.min(1, b.t / FALL_TIME);
      b.h = this.renderer.sprites.add({ x: n.x, y: n.y, z: n.z, frame: b.frame, height: HEIGHT * (1 - 0.7 * k * k), width: (b.frame.w / 32) * (1 + 0.5 * k) });
    }
  }

  private died(n: Npc): void {
    const v = this.views.get(n);
    const frame = v?.frame ?? this.frameFor(n).frame;
    this.drop(n);
    const b: Body = { h: null, body: null, npc: n, frame, t: 0 };
    this.makeBody(b, false);
    b.body?.inst.flash(0xff2020, 0.15);
    this.bodies.push(b);
  }

  update(game: Game, dt: number): void {
    const p = game.player;
    let outfitCheck = false;
    this.bodyCheck -= dt;
    if (this.bodyCheck <= 0) {
      this.bodyCheck = 0.5;
      outfitCheck = true;
    }
    const cam = this.renderer.rig.camera.position;
    for (const n of this.sys.npcs) {
      if (n.dead) continue;
      const inBubble = this.sys.inBubble(n);
      let v = this.views.get(n);
      if (!inBubble) {
        if (v) this.drop(n);
        continue;
      }
      if (!v) {
        const { key, frame } = this.frameFor(n);
        v = { h: null, c: null, key, frame, cool: n.attackCooldown };
        this.makeVisual(n, v);
        this.views.set(n, v);
      } else if (outfitCheck) this.refresh(n, v);
      const downed = n.effects.has('downed') || n.isAsleep();
      const visible = Math.abs(n.z - p.z) <= 1;
      if (v.c) {
        if (n.attackCooldown > v.cool + 0.05) v.c.strike();
        v.cool = n.attackCooldown;
        v.c.update(dt, {
          x: n.x, y: n.y, z: n.z, facing: n.facing,
          target: n.goal.kind === 'fight' ? { x: n.goal.x, y: n.goal.y } : null,
          moving: n.moving, walkPhase: n.walkPhase, windup: null, flinch: 0,
          down: downed ? 1 : 0, visible, emph: n.isEnemy() ? 1 : 0,
          camDist: Math.hypot(n.x - cam.x, n.y - cam.z), sy: 1, sxz: 1,
        });
        continue;
      }
      const h = v.h!;
      const bob = n.moving ? Math.abs(Math.sin(n.walkPhase * Math.PI)) * 0.06 : 0;
      // Point-blank: draw as if at NEAR_CLAMP (see monsterView.ts nearClamp).
      // ...and raised to meet the crosshair at arm's length (monsterView.ts meleeAimLift)
      const foot = n.z * LEVEL_HEIGHT + (this.renderer.groundAt?.(n.x, n.y, n.z) ?? 0);
      const aim = downed || this.renderer.cameraMode !== 'first' ? 0 : meleeAimLift(Math.hypot(n.x - cam.x, n.y - cam.z), cam.y - foot, HEIGHT);
      const near = nearClamp(cam, n.x, n.y, foot + aim);
      h.set(n.x, n.y, n.z + (bob * near.scale + aim + near.lift) / LEVEL_HEIGHT);
      h.setVisible(visible);
      h.setFrame(v.frame, HEIGHT * (downed ? 0.5 : 1) * near.scale);
    }
    // Bodies: fall over, then stay while the corpse item lies there.
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i];
      if (b.body) b.body.update(dt);
      else if (b.t < FALL_TIME) {
        b.t = Math.min(FALL_TIME, b.t + dt);
        b.h?.remove();
        this.makeBody(b, false);
      }
      if (outfitCheck && (b.body || b.t >= FALL_TIME)) {
        const items = game.map.itemsAt(b.npc.tileX, b.npc.tileY, b.npc.z) as { vars?: Record<string, unknown> }[];
        if (!items.some((it) => it.vars?.npc === b.npc.uid)) {
          b.h?.remove();
          b.body?.remove();
          this.bodies.splice(i, 1);
        }
      }
    }
    for (const h of this.shots) h.remove();
    this.shots.length = 0;
    this.fx ??= cardsOn() ? new FxMeshes(this.renderer) : null;
    this.fx?.begin();
    for (const s of this.sys.shots) {
      // 3D: a spark mesh where the bullet stopped; billboards: the glyph
      if (this.fx) {
        this.fx.place('spark', s.x1, s.y1, s.z, 1.2, [1, 0, 0], [255, 226, 120]);
        continue;
      }
      const frame = this.atlas ? toFrame(this.atlas.glyph('*', 'yellow')) : this.renderer.source.glyph('*', 'yellow');
      this.shots.push(this.renderer.sprites.add({ x: s.x1, y: s.y1, z: s.z, frame, height: 0.3, anchor: 'center', lift: 1.2 }));
    }
    this.fx?.end();
  }
}

function toFrame(r: FrameRef): TileFrame {
  return { texture: r.texture, uv: [r.uv.u0, r.uv.v0, r.uv.u1, r.uv.v1], w: r.w, h: r.h, ppm: 32 };
}
