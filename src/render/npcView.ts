import type { Game, GameSystem } from '../game/game';
import type { Npc } from '../game/npc';
import type { NpcSystem } from '../game/npcai';
import { LEVEL_HEIGHT } from '../world/coords';
import { loadAtlas, type Atlas, type FrameRef } from './atlas';
import { AtlasTextureSource } from './atlasSource';
import type { Renderer } from './renderer';
import type { SpriteHandle } from './sprites';
import type { TileFrame } from './textureSource';

// Billboards for NPCs: CDDA's npc_male / npc_female body with the worn clothing and wielded
// item overlays stacked on top (like the tileset draws characters), composited once per
// outfit. Dead NPCs crumple like monster corpses and stay while their corpse item does.

const HEIGHT = 1.75;
const FALL_TIME = 0.35;

interface View {
  h: SpriteHandle;
  key: string;
  frame: TileFrame;
}

interface Body {
  h: SpriteHandle;
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

export class NpcView implements GameSystem {
  readonly name = 'npc-view';
  private atlas: Atlas | null = null;
  private views = new Map<Npc, View>();
  private bodies: Body[] = [];
  private shots: SpriteHandle[] = [];
  private bodyCheck = 0;

  constructor(readonly game: Game, readonly renderer: Renderer, readonly sys: NpcSystem) {
    loadAtlas().then(
      (a) => {
        this.atlas = a;
        for (const [n, v] of this.views) this.refresh(n, v, true);
      },
      () => {},
    );
    sys.onHurt.push((n) => this.views.get(n)?.h.flash(0xff2a2a, 0.18));
    sys.onRemoved.push((n) => this.drop(n));
    sys.onDied.push((n) => this.died(n));
  }

  private looksLike = (id: string) => this.game.data.items[id]?.looks_like as string | undefined;

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

  private refresh(n: Npc, v: View, force = false): void {
    const { key, frame } = this.frameFor(n);
    if (!force && key === v.key) return;
    v.key = key;
    v.frame = frame;
    v.h.setFrame(frame, HEIGHT);
  }

  private drop(n: Npc): void {
    const v = this.views.get(n);
    if (!v) return;
    v.h.remove();
    this.views.delete(n);
  }

  private died(n: Npc): void {
    const v = this.views.get(n);
    const frame = v?.frame ?? this.frameFor(n).frame;
    this.drop(n);
    this.bodies.push({ h: this.renderer.sprites.add({ x: n.x, y: n.y, z: n.z, frame, height: HEIGHT }), npc: n, frame, t: 0 });
  }

  update(game: Game, dt: number): void {
    const p = game.player;
    let outfitCheck = false;
    this.bodyCheck -= dt;
    if (this.bodyCheck <= 0) {
      this.bodyCheck = 0.5;
      outfitCheck = true;
    }
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
        v = { h: this.renderer.sprites.add({ x: n.x, y: n.y, z: n.z, frame, height: HEIGHT }), key, frame };
        this.views.set(n, v);
      } else if (outfitCheck) this.refresh(n, v);
      const bob = n.moving ? Math.abs(Math.sin(n.walkPhase * Math.PI)) * 0.06 : 0;
      v.h.set(n.x, n.y, n.z + bob / LEVEL_HEIGHT);
      v.h.setVisible(Math.abs(n.z - p.z) <= 1);
      const downed = n.effects.has('downed') || n.isAsleep();
      v.h.setFrame(v.frame, HEIGHT * (downed ? 0.5 : 1));
    }
    // Bodies: fall over, then stay while the corpse item lies there.
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i];
      if (b.t < FALL_TIME) {
        b.t = Math.min(FALL_TIME, b.t + dt);
        const k = b.t / FALL_TIME;
        b.h.remove();
        b.h = this.renderer.sprites.add({ x: b.npc.x, y: b.npc.y, z: b.npc.z, frame: b.frame, height: HEIGHT * (1 - 0.7 * k * k), width: (b.frame.w / 32) * (1 + 0.5 * k) });
      } else if (outfitCheck) {
        const items = game.map.itemsAt(b.npc.tileX, b.npc.tileY, b.npc.z) as { vars?: Record<string, unknown> }[];
        if (!items.some((it) => it.vars?.npc === b.npc.uid)) {
          b.h.remove();
          this.bodies.splice(i, 1);
        }
      }
    }
    for (const h of this.shots) h.remove();
    this.shots.length = 0;
    for (const s of this.sys.shots) {
      const frame = this.atlas ? toFrame(this.atlas.glyph('*', 'yellow')) : this.renderer.source.glyph('*', 'yellow');
      this.shots.push(this.renderer.sprites.add({ x: s.x1, y: s.y1, z: s.z, frame, height: 0.3, anchor: 'center', lift: 1.2 }));
    }
  }
}

function toFrame(r: FrameRef): TileFrame {
  return { texture: r.texture, uv: [r.uv.u0, r.uv.v0, r.uv.u1, r.uv.v1], w: r.w, h: r.h, ppm: 32 };
}
