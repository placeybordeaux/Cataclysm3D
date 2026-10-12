import type { Game, GameSystem } from './game';
import type { MonsterSystem } from './monai';
import type { Item } from './item';
import { asArray } from './item';
import { consumeItem, L, type Loc } from './moves';
import { emitSound } from './sound';
import { blastFromJson, detonate, type BlastSource } from './blast';
import { ACTION_SCALE } from '../core/time';
import { warnOnce } from '../data/warn';

// Armed explosives, BN explosion_iuse (iuse_actor.cpp) on an active tool: a grenade with its pin
// pulled (`grenade` → transform → `grenade_act`, 5 charges), lit dynamite or a pipe bomb. Each turn
// item::process_tool burns turns_per_charge's charge and ticks the actor (use(t = true): its
// sound_msg, "Tick.", at sound_volume); the tick that finds no charges left calls
// trigger_explosion: the actor's `explosion` goes off where the item is (explosion.cpp, blast.ts)
// and the item is destroyed. The pin can't be put back (no_deactivate_msg).
//
// A turn of fuse is a combat turn (1 / ACTION_SCALE real seconds, as every action in a fight), so a
// grenade's five turns are 1.7 s: pull the pin (`a`/use), then `t` throws it. Held, it goes off on
// whoever holds it; thrown, where it landed. The survivor's items, and explosives an NPC armed and
// threw at once (npcai.ts alt attack: BN npc::alt_attack); an NPC never holds a live one.
// Sound volumes are BN's dB taken as the port's volume, as for explosions themselves.
// Not modelled: the actor's flashbang, fields, EMP and scrambler parts (none on the explosives
// with an `explosion`; warned once if met).

interface ExplosionActor {
  type: 'explosion';
  explosion?: unknown;
  sound_volume?: number;
  sound_msg?: string;
  no_deactivate_msg?: string;
  do_flashbang?: boolean;
  fields_type?: string;
  emp_blast_radius?: number;
  scrambler_blast_radius?: number;
}

/** The item's `explosion` use action (BN explosion_iuse), if it has one. */
export function explosionActor(it: Item): ExplosionActor | null {
  for (const ua of asArray(it.def.use_action as unknown)) if (ua && typeof ua === 'object' && (ua as { type?: unknown }).type === 'explosion') return ua as ExplosionActor;
  return null;
}

/** Seconds of real time per turn of fuse. */
export const FUSE_TURN = 1 / ACTION_SCALE;

interface Armed {
  item: Item;
  /** Real seconds toward the next charge. */
  acc: number;
  /** Where it was last seen. */
  at: { x: number; y: number; z: number };
  /** Who set it off (the survivor unless an NPC threw it: npcai.ts alt attacks). */
  source?: BlastSource;
}

export class ArmedExplosives implements GameSystem {
  readonly name = 'armed-explosives';
  readonly armed = new Map<Item, Armed>();
  constructor(readonly game: Game, readonly monsters: () => MonsterSystem | null) {}

  /**
   * Inventory.activeProcessors entry: an active explosive in the survivor's hands or pack is ours
   * to burn (the generic power drain would only say it "runs out of power").
   */
  claim(it: Item): boolean {
    if (!it.active || !explosionActor(it)) return false;
    if (!this.armed.has(it)) {
      const p = this.game.player;
      this.armed.set(it, { item: it, acc: 0, at: { x: Math.floor(p.x), y: Math.floor(p.y), z: p.z } });
    }
    return true;
  }

  /** PlayerCombat.onThrown: a live explosive thrown before its fuse was ever processed lands at (x, y, z). */
  thrown(it: Item, x: number, y: number, z: number, source?: BlastSource): void {
    if (!it.active || !explosionActor(it)) return;
    const a = this.armed.get(it);
    if (a) {
      a.at = { x, y, z };
      if (source) a.source = source;
    } else this.armed.set(it, { item: it, acc: 0, at: { x, y, z }, source });
  }

  update(_game: Game, realDt: number): void {
    for (const a of [...this.armed.values()]) {
      const where = this.locate(a);
      if (!where) {
        this.armed.delete(a.item);
        continue;
      }
      a.acc += realDt;
      const turns = Math.trunc(a.item.def.turns_per_charge ?? 1) || 1;
      while (a.acc >= FUSE_TURN * turns) {
        a.acc -= FUSE_TURN * turns;
        if (a.item.charges > 0) a.item.charges--;
        if (this.tick(a, where)) break;
      }
    }
  }

  /** One tick of the actor: the ticking sound, and the explosion once the charges are gone. */
  private tick(a: Armed, where: { loc: Loc | null; x: number; y: number; z: number }): boolean {
    const act = explosionActor(a.item)!;
    if ((act.sound_volume ?? -1) >= 0) emitSound(this.game, { x: where.x, y: where.y, z: where.z }, act.sound_volume!, act.sound_msg || 'Tick.', { category: 'alarm' });
    if (a.item.charges > 0) return false;
    this.armed.delete(a.item);
    if (where.loc) consumeItem(a.item, where.loc);
    if (act.do_flashbang || act.fields_type || (act.emp_blast_radius ?? -1) >= 0 || (act.scrambler_blast_radius ?? -1) >= 0) warnOnce('explosion_iuse', a.item.typeId, `explosion actor of ${a.item.typeId}: only its explosion is modelled`);
    const blast = act.explosion ? blastFromJson(act.explosion) : null;
    if (act.explosion && !blast) throw new Error(`${a.item.typeId}: unreadable explosion ${JSON.stringify(act.explosion)}`);
    const source: BlastSource = a.source ?? 'player';
    if (blast) detonate(this.game, this.monsters(), where.x + 0.5, where.y + 0.5, where.z, blast, source);
    return true;
  }

  /** Where the item is now: in the survivor's belongings, or on the ground near where it was. */
  private locate(a: Armed): { loc: Loc | null; x: number; y: number; z: number } | null {
    const p = this.game.player;
    const held = p.inv.locOf(a.item);
    if (held) {
      a.at = { x: Math.floor(p.x), y: Math.floor(p.y), z: p.z };
      return { loc: held, ...a.at };
    }
    const map = this.game.map;
    // Thrown or dropped: it lies within a throw of where it was last seen.
    for (let r = 0; r <= 30; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          for (const dz of [0, -1, 1]) {
            const x = a.at.x + dx, y = a.at.y + dy, z = a.at.z + dz;
            if (!(map.itemsAt(x, y, z) as unknown[]).includes(a.item)) continue;
            a.at = { x, y, z };
            return { loc: L.ground(map, x, y, z), x, y, z };
          }
        }
    return null;
  }

  /** The survivor tries to use an armed explosive again: BN's no_deactivate_msg. */
  static refuse(it: Item): string {
    const act = explosionActor(it);
    const msg = act?.no_deactivate_msg || "You've already set the %s's timer you might want to get away from it.";
    return msg.replace('%s', it.baseName());
  }
}
