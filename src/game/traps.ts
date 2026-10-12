import type { Game } from './game';
import { CHUNK, chunkOf, localOf, tileKey } from '../world/coords';
import { createItem } from './item';
import { spawnOnGround } from './moves';
import type { BodyPartId } from './bodyparts';
import { emitSound } from './sound';
import { detonate, type BlastData } from './blast';
import type { MonsterSystem } from './monai';

/** trapfunc.cpp get_basic_explosion_data. */
export const BASIC_EXPLOSION: BlastData = {
  damage: 40, radius: 3, fire: false,
  fragment: { impact: [{ type: 'bullet', amount: 80, armor_penetration: 0, armor_multiplier: 3 }], range: 6 },
};

// Traps from mapgen (chunk.traps: tile index → CDDA trap id, data in misc.trap), after
// trapfunc.cpp. Stepping onto a trap tile triggers it unless you notice and avoid it
// (Character::avoid_trap: dice(3, dex + 1.5 × dodge) vs dice(3 or 6, avoidance)).
// Implemented actions: bubble, glass, beartrap, board, caltrops, caltrops_glass, tripwire,
// pit, spike_pit, glass_pit, landmine, boobytrap, sinkhole; others (funnels, cots, lab/portal traps)
// are inert here.

export interface TrapDef {
  id: string;
  name: string;
  symbol?: string;
  color?: string;
  visibility?: number;
  avoidance?: number;
  difficulty?: number;
  action?: string;
  drops?: string[];
  flags?: string[];
  [k: string]: unknown;
}

export function trapDef(game: Game, id: string): TrapDef | undefined {
  return game.data.misc.trap?.[id] as TrapDef | undefined;
}

export function trapAt(game: Game, x: number, y: number, z: number): string | null {
  if (!game.map.hasChunk(chunkOf(x), chunkOf(y), z)) return null;
  const c = game.map.chunk(chunkOf(x), chunkOf(y), z);
  return c?.traps.get(localOf(y) * CHUNK + localOf(x)) ?? null;
}

export function setTrap(game: Game, x: number, y: number, z: number, id: string | null): void {
  const c = game.map.chunk(chunkOf(x), chunkOf(y), z);
  if (!c) return;
  const i = localOf(y) * CHUNK + localOf(x);
  if (id) {
    if (!trapDef(game, id)) throw new Error(`unknown trap ${id}`);
    c.traps.set(i, id);
  } else c.traps.delete(i);
  c.version++;
}

interface TState {
  known: Set<string>;
  lastTile: string;
  escapeT: number;
}
const tstates = new WeakMap<Game, TState>();
function tstate(game: Game): TState {
  let s = tstates.get(game);
  if (!s) tstates.set(game, (s = { known: new Set(), lastTile: '', escapeT: 0 }));
  return s;
}

/** Trap tiles ("x,y,z") the player has discovered; mutable, for save/load. */
export function knownTraps(game: Game): Set<string> {
  return tstate(game).known;
}

/** Does the player know about / can see this trap? (visibility −1 = obvious, low = easy) */
export function playerSeesTrap(game: Game, x: number, y: number, z: number): boolean {
  const id = trapAt(game, x, y, z);
  if (!id) return false;
  const def = trapDef(game, id);
  if (!def) return false;
  if (tstate(game).known.has(tileKey(x, y, z))) return true;
  const vis = def.visibility ?? 0;
  return vis < 0 || vis <= Math.floor(game.player.per / 2);
}

function feet(game: Game): BodyPartId {
  return game.player.rng.oneIn(2) ? 'leg_l' : 'leg_r';
}

/** Run a trap's effect on the player. Returns whether it actually went off. */
export function triggerTrap(game: Game, x: number, y: number, z: number): boolean {
  const id = trapAt(game, x, y, z);
  if (!id) return false;
  const def = trapDef(game, id);
  if (!def) return false;
  const p = game.player;
  const rng = p.rng;
  const st = tstate(game);
  const pos = { x, y, z };
  st.known.add(tileKey(x, y, z));
  const drop = (itemId: string) => {
    if (game.data.items[itemId]) spawnOnGround(game.map, x, y, z, createItem(game.data, itemId));
  };
  switch (def.action) {
    case 'bubble':
      game.message('You step on some bubble wrap!', 'c_yellow');
      emitSound(game, pos, 18, 'Pop!', { category: 'alarm', ambient: true });
      setTrap(game, x, y, z, null);
      return true;
    case 'glass':
    case 'caltrops_glass': {
      game.message(def.action === 'glass' ? 'You step on some glass!' : `You step on a sharp ${def.name}!`, 'c_yellow');
      const dmg = def.action === 'glass' ? Math.max(0, rng.int(-10, 5)) : rng.int(3, 10);
      if (dmg > 0) p.takeHit(feet(game), [{ type: 'cut', amount: dmg }]);
      emitSound(game, pos, 8, 'glass cracking!', { category: 'combat', ambient: true });
      setTrap(game, x, y, z, null);
      return true;
    }
    case 'beartrap': {
      emitSound(game, pos, 8, 'SNAP!', { category: 'combat', ambient: true });
      setTrap(game, x, y, z, null);
      const bp = feet(game);
      game.message(`A bear trap closes on your ${bp === 'leg_l' ? 'left' : 'right'} foot!`, 'c_red');
      p.addEffect('beartrap', 1, { bp, permanent: true });
      p.takeHit(bp, [{ type: 'bash', amount: 12 }, { type: 'cut', amount: 18 }]);
      return true;
    }
    case 'board':
    case 'caltrops': {
      const board = def.action === 'board';
      game.message(board ? `You step on a ${def.name}!` : `You step on a sharp ${def.name}!`, 'c_red');
      p.takeHit(feet(game), [{ type: 'cut', amount: board ? rng.int(3, 5) : rng.int(9, 15) }]);
      if (rng.chance(p.bodyweightKg() / (board ? 1 : 2))) {
        game.message(`You destroy the ${def.name} as you step on it!`);
        setTrap(game, x, y, z, null);
      }
      return true;
    }
    case 'tripwire':
      game.message('You trip over a tripwire!', 'c_red');
      p.addEffect('downed', rng.int(1, 3));
      if (rng.int(0, 10) > p.dodge()) p.takeHit('torso', [{ type: 'bash', amount: rng.int(1, 4) }]);
      return true;
    case 'pit':
    case 'spike_pit':
    case 'glass_pit': {
      game.message('You fall in a pit!', 'c_red');
      p.addEffect('in_pit', 1, { permanent: false });
      const spikes = def.action !== 'pit';
      const dmg = spikes ? rng.int(10, 20) : rng.int(6, 12);
      game.message(spikes ? `You land on ${def.action === 'glass_pit' ? 'glass shards' : 'spikes'}!` : 'You are hurt from falling into a pit!', 'c_red');
      for (const bp of ['leg_l', 'leg_r'] as BodyPartId[]) p.takeHit(bp, [{ type: spikes ? 'stab' : 'bash', amount: spikes ? dmg : dmg * 2 }]);
      if (!spikes) for (const bp of ['torso', 'arm_l', 'arm_r'] as BodyPartId[]) p.takeHit(bp, [{ type: 'bash', amount: dmg }]);
      return true;
    }
    case 'landmine':
    case 'boobytrap':
      // trapfunc::landmine / boobytrap: get_basic_explosion_data ("equivalent of grenade
      // explosion": 40 damage, radius 3, an 80-bullet ×3-armour fragment out to 6 tiles) on the
      // trap's tile, by explosion.cpp's rules (blast.ts); then the trap is gone.
      game.message(def.action === 'landmine' ? 'You trigger a land mine!' : 'You trigger a booby trap!', 'c_red');
      setTrap(game, x, y, z, null);
      detonate(game, (game as unknown as { monsters?: MonsterSystem }).monsters ?? null, x + 0.5, y + 0.5, z, BASIC_EXPLOSION, null);
      return true;
    case 'sinkhole':
      game.message('You step into a sinkhole!', 'c_red');
      setTrap(game, x, y, z, game.data.misc.trap?.tr_pit ? 'tr_pit' : null);
      return true;
    default:
      return false;
  }
}

/** Character::avoid_trap. */
export function avoidTrap(game: Game, def: TrapDef, seen: boolean): boolean {
  const p = game.player;
  const my = p.rng.dice(3, Math.max(1, Math.floor(p.dex + p.getSkill('dodge') * 1.5)));
  const av = Math.max(1, def.avoidance ?? 0);
  const trap = seen ? p.rng.dice(3, av) : p.rng.dice(6, av);
  return my >= trap;
}

/** Player movement onto trap tiles, and struggling out of a bear trap. */
export function installTraps(game: Game): void {
  const st = tstate(game);
  game.systems.push({
    name: 'traps',
    update(g, realDt) {
      const p = g.player;
      if (p.dead) return;
      const key = tileKey(p.tileX, p.tileY, p.z);
      // Caught in a bear trap: pinned to the tile until a strength roll frees you.
      if (p.hasEffect('beartrap')) {
        const cx = p.tileX + 0.5, cy = p.tileY + 0.5;
        const [ax, ay] = st.lastTile ? st.lastTile.split(',').map(Number) : [p.tileX, p.tileY];
        if (key !== st.lastTile && st.lastTile) {
          p.x = ax + 0.5;
          p.y = ay + 0.5;
        }
        const pushing = Math.hypot(p.x - cx, p.y - cy) > 0.05 || ['KeyW', 'KeyA', 'KeyS', 'KeyD'].some((k) => g.input.held.has(k));
        if (pushing && (st.escapeT -= realDt) <= 0) {
          st.escapeT = 0.5;
          if (p.rng.chance(p.str)) {
            p.removeEffect('beartrap');
            game.message('You free yourself from the bear trap!', 'c_green');
            if (g.data.items.beartrap) spawnOnGround(g.map, ax, ay, p.z, createItem(g.data, 'beartrap'));
          } else game.message('You are stuck in the bear trap!', 'c_light_red');
        }
        p.x = Math.min(Math.max(p.x, ax + 0.2), ax + 0.8);
        p.y = Math.min(Math.max(p.y, ay + 0.2), ay + 0.8);
        return;
      }
      if (key === st.lastTile) return;
      st.lastTile = key;
      const id = trapAt(g, p.tileX, p.tileY, p.z);
      if (!id) return;
      const def = trapDef(g, id);
      if (!def || !def.action) return;
      const seen = playerSeesTrap(g, p.tileX, p.tileY, p.z);
      if (avoidTrap(g, def, seen) && seen) {
        g.message(`You avoid the ${def.name}.`);
        return;
      }
      triggerTrap(g, p.tileX, p.tileY, p.z);
    },
  });
}
