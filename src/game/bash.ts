import type { Game } from './game';
import type { Character } from './character';
import type { BashInfo, FurnitureDef, TerrainDef } from '../data/types';
import type { Chunk } from '../world/map';
import { CHUNK, chunkOf, localOf } from '../world/coords';
import { hasFlag } from '../world/registry';
import { expandItemGroup } from '../data/itemgroups';
import { Rng } from '../core/rng';
import { fromSpawned } from './item';
import { spawnOnGround } from './moves';
import { emitSound, soundClock } from './sound';
import { sfx } from '../audio/sfx';
import { frontTile, targetTile, type TargetTile } from './targeting';
import { ACTION_SCALE } from '../core/time';

// Bashing terrain and furniture, after CDDA map::bash_ter_furn (map.cpp). Modern CDDA keeps
// persistent per-tile "map damage": each hit deals max(0, str × profile − str_min) and the
// thing breaks once accumulated damage reaches str_max. So a weak survivor can't hurt a
// wooden door at all, and a strong one with a crowbar takes a dozen blows.
//
//   bash(game, x, y, z, strength | {bash: n, cut: m}, { silent?, byPlayer?, destroy?, bashFloor? })
//     → { didBash, success, canBash, sound, volume, target }
// Monsters: bash(game, x, y, z, monsterBashStrength, { source: monster }).

export type BashStrength = number | Record<string, number>;

export interface BashOpts {
  /** No sound event (CDDA `silent`). */
  silent?: boolean;
  /** The player did it (messages, sound source). */
  byPlayer?: boolean;
  /** Always succeeds (fire, explosions: CDDA `destroy`). */
  destroy?: boolean;
  /** Allow bashing floors (bash_below terrain). */
  bashFloor?: boolean;
  /** Who's bashing, passed to the sound event. */
  source?: unknown;
}

export interface BashResult {
  /** Something was hit (even if it didn't break). */
  didBash: boolean;
  /** It broke. */
  success: boolean;
  /** The hit did damage (keep smashing and it will break). */
  canBash: boolean;
  /** CDDA sound description ("glass breaking!", "whump!") or '' */
  sound: string;
  volume: number;
  /** Name of what was bashed ("window", "dresser"), '' if nothing */
  target: string;
}

const mapDamage = new WeakMap<Chunk, Map<number, number>>();
const rngs = new WeakMap<Game, Rng>();
function rng(game: Game): Rng {
  let r = rngs.get(game);
  if (!r) rngs.set(game, (r = new Rng(game.seed ^ 0xba5)));
  return r;
}

function damageSlot(game: Game, x: number, y: number, z: number): { map: Map<number, number>; i: number } | null {
  const c = game.map.chunk(chunkOf(x), chunkOf(y), z);
  if (!c) return null;
  let m = mapDamage.get(c);
  if (!m) mapDamage.set(c, (m = new Map()));
  return { map: m, i: localOf(y) * CHUNK + localOf(x) };
}

/** Per-chunk accumulated bash damage (local tile index -> damage), for save/load. */
export function chunkMapDamage(c: Chunk): Map<number, number> | undefined {
  return mapDamage.get(c);
}
export function setChunkMapDamage(c: Chunk, m: Map<number, number>): void {
  mapDamage.set(c, m);
}

/** Accumulated bash damage on a tile (CDDA get_map_damage). */
export function getMapDamage(game: Game, x: number, y: number, z: number): number {
  const s = damageSlot(game, x, y, z);
  return s?.map.get(s.i) ?? 0;
}

function num(v: unknown, dflt: number): number {
  return typeof v === 'number' ? v : dflt;
}

/** bash_damage_profile::damage_from: Σ max(0, str[type] × profile[type] − armor). */
export function damageFrom(game: Game, str: Record<string, number>, profileId: string | undefined, armor: number): number {
  const prof = (game.data.misc.bash_damage_profile?.[profileId ?? 'default']?.profile ?? { bash: 1 }) as Record<string, number>;
  let ret = 0;
  for (const [type, amt] of Object.entries(str)) {
    const mult = prof[type];
    if (mult === undefined) continue;
    ret += Math.max(0, Math.floor(amt * mult - armor));
  }
  return ret;
}

/** The terrain a destroyed tile turns into when its bash data has no ter_set. */
function emptiedTerrain(game: Game, x: number, y: number, z: number): string {
  const map = game.map;
  const below = map.terAt(x, y, z - 1);
  if (z <= 0 && below.id === 't_null') return 't_dirt';
  if (hasFlag(below, 'SUPPORTS_ROOF') && typeof below.roof === 'string' && map.terrain.has(below.roof)) return below.roof;
  if (z === 0) return map.terrain.has('t_dirt') ? 't_dirt' : 't_open_air';
  return 't_open_air';
}

function dropBashItems(game: Game, x: number, y: number, z: number, info: BashInfo): void {
  if (!info.items) return;
  for (const sp of expandItemGroup(game.data, info.items, rng(game)))
    for (const it of fromSpawned(game.data, sp)) spawnOnGround(game.map, x, y, z, it);
}

function addFieldIfKnown(game: Game, x: number, y: number, z: number, f: unknown): void {
  if (!Array.isArray(f) || typeof f[0] !== 'string') return;
  if (!game.data.misc.field_type?.[f[0]]) return;
  game.map.addField(x, y, z, f[0], Math.max(1, Math.min(3, num(f[1], 1))));
}

function playBashSfx(x: number, y: number, z: number, success: boolean, id: string, sound: string, glass: boolean): void {
  sfx.smash({ x: x + 0.5, y: y + 0.5, z }, { success, targetId: id, glass: glass || /glass/i.test(sound) });
}

/** map::bash on terrain/furniture at (x, y, z). */
export function bash(game: Game, x: number, y: number, z: number, strength: BashStrength, opts: BashOpts = {}): BashResult {
  const map = game.map;
  const str = typeof strength === 'number' ? { bash: strength } : strength;
  const res: BashResult = { didBash: false, success: false, canBash: false, sound: '', volume: 0, target: '' };
  const ter = map.terAt(x, y, z);
  const furn = map.furnAt(x, y, z);
  let def: TerrainDef | FurnitureDef | null = null;
  let isFurn = false;
  if (furn.id !== 'f_null' && furn.bash) {
    def = furn;
    isFurn = true;
  } else if (ter.bash) def = ter;
  let info = def?.bash;
  // Floors only break when asked to (smashing downward / explosions).
  if (!isFurn && info && info.bash_below && !opts.bashFloor && !opts.destroy) info = undefined;
  const src = opts.source ?? (opts.byPlayer ? game.player : undefined);
  const emit = (sound: string, volume: number, success: boolean, id: string, glass = false) => {
    res.sound = sound;
    res.volume = volume;
    if (opts.silent || !sound) return;
    playBashSfx(x, y, z, success, id, sound, glass);
    // Monsters still hear it, but the survivor's own smashing isn't narrated back as
    // "You hear whack!" after every swing (the smash messages already say what happened).
    emitSound(game, { x, y, z }, volume, sound, { category: 'combat', source: src, sfxId: '', ambient: src === game.player });
  };

  if (!info || !def) {
    if (!map.passable(x, y, z) && ter.id !== 't_null') {
      res.didBash = true;
      res.target = ter.name;
      emit('thump!', 18, false, ter.id);
    }
    return res;
  }
  res.target = def.name;
  const glass = hasFlag(def, 'WINDOW') || /glass/i.test(String(info.sound ?? ''));
  const strMin = num(info.str_min, 0), strMax = num(info.str_max, strMin);
  let success = !!opts.destroy;
  if (!opts.destroy) {
    let min = strMin, hp = strMax;
    const supported = (info.str_min_supported !== undefined || info.str_max_supported !== undefined) && hasFlag(map.terAt(x, y, z - 1), 'SUPPORTS_ROOF');
    if (supported) {
      min = num(info.str_min_supported, min);
      hp = num(info.str_max_supported, hp);
    }
    const slot = damageSlot(game, x, y, z);
    const dealt = damageFrom(game, str, typeof info.profile === 'string' ? info.profile : undefined, min);
    const prior = slot?.map.get(slot.i) ?? 0;
    if (dealt + prior >= hp) {
      success = true;
      slot?.map.delete(slot.i);
    } else if (dealt > 0) {
      res.canBash = true;
      slot?.map.set(slot.i, prior + dealt);
    }
  }
  res.didBash = true;

  if (!success) {
    emit(String(info.sound_fail ?? 'thump!'), num(info.sound_fail_vol, 12), false, def.id, false);
    addFieldIfKnown(game, x, y, z, info.hit_field);
    return res;
  }

  res.success = true;
  const volume = opts.destroy ? strMin * 2 : num(info.sound_vol, Math.min(Math.floor(strMin * 1.5), strMax));
  if (isFurn) {
    const f = info.furn_set && map.furniture.has(info.furn_set) ? info.furn_set : 'f_null';
    map.setFurn(x, y, z, f);
    const c = map.chunk(chunkOf(x), chunkOf(y), z);
    c?.signs.delete(localOf(y) * CHUNK + localOf(x));
  } else {
    const next = info.ter_set && info.ter_set !== 't_null' && map.terrain.has(info.ter_set) ? info.ter_set : emptiedTerrain(game, x, y, z);
    map.setTer(x, y, z, next);
  }
  dropBashItems(game, x, y, z, info);
  addFieldIfKnown(game, x, y, z, info.hit_field);
  addFieldIfKnown(game, x, y, z, info.destroyed_field);
  game.events.emit('mapChanged', { x, y, z });
  emit(String(info.sound ?? ''), volume, true, def.id, glass);
  return res;
}

/** How hard a character can smash (Character::smash_ability). */
export function smashAbility(c: Character): Record<string, number> {
  const bonus = c.str;
  const w = c.inv.wielded;
  if (w) {
    const out: Record<string, number> = {};
    const md = w.def.melee_damage ?? {};
    for (const [type, amt] of Object.entries(md)) {
      // Only bash converts strength (damage_type bash_conversion_factor = 1).
      const dmg = amt + (type === 'bash' ? bonus : 0);
      if (dmg > 0) out[type] = dmg;
    }
    if (!out.bash) out.bash = Math.max(1, w.meleeDamage('bash') + bonus);
    return out;
  }
  // Unarmed: best body part's bash armor + str × smash_efficiency (0.5), capped at str × 1.5.
  return { bash: Math.floor(Math.min(bonus * 0.5, bonus * 1.5)) };
}

const lastSmash = new WeakMap<Game, number>();

/**
 * The player's `X` smash at the aimed tile (or the tile in front). Returns null if there was
 * nothing to smash or the swing is still recovering.
 */
export function playerSmash(game: Game, target: TargetTile | null = targetTile(game) ?? frontTile(game)): BashResult | null {
  const p = game.player;
  if (p.dead || p.isAsleep()) return null;
  if (!target) return null;
  const now = soundClock(game);
  // Recovery between blows (real seconds): CDDA move cost = weapon attack_time × 0.8, 80 unarmed.
  const moves = p.inv.wielded ? p.inv.wielded.attackTime() * 0.8 : 80;
  const last = lastSmash.get(game);
  if (last !== undefined && now >= last && now - last < (moves / 100 / ACTION_SCALE) * 0.95) return null;
  const { x, y, z } = target;
  const map = game.map;
  const ter = map.terAt(x, y, z), furn = map.furnAt(x, y, z);
  const bashable = (furn.id !== 'f_null' && !!furn.bash) || (!!ter.bash && !ter.bash.bash_below) || !map.passable(x, y, z);
  if (!bashable) {
    game.message('There is nothing there to smash.');
    return null;
  }
  lastSmash.set(game, now);
  const str = smashAbility(p);
  if (!p.inv.wielded) {
    const name = furn.id !== 'f_null' && furn.bash ? furn.name : ter.name;
    game.message(`You use your right hand to smash the ${name}.`);
  }
  const res = bash(game, x, y, z, str, { byPlayer: true });
  if (res.didBash) {
    p.modStamina(-(p.inv.wielded ? 2 : 1) * 20);
    p.recoil = 3000;
    if (p.getSkill('melee') === 0 && p.rng.oneIn(4)) p.practice('melee', 1);
    if (res.success) game.message(`You smash the ${res.target}!`);
    else if (!res.canBash) game.message(`You don't seem to be damaging the ${res.target}.`, 'c_light_gray');
    // CDDA logs the fail sound ("whack!") on every blow that doesn't break it, so a tree that
    // takes five hits still tells you something is happening.
    else if (res.sound) game.message(res.sound, 'c_light_gray');
  }
  return res;
}

/** Keep smashing until it breaks (CDDA's "Keep smashing until destroyed?" bash activity). */
export function smashUntilBroken(game: Game, target: TargetTile): void {
  const tick = () => {
    const r = playerSmash(game, target);
    if (r && (r.success || !r.canBash)) return true;
    return false;
  };
  if (tick()) return;
  game.activities.start({
    name: 'smashing',
    duration: 3600,
    warp: 1,
    onProgress: () => {
      const r = playerSmash(game, target);
      if (r && (r.success || !r.canBash)) game.activities.current && (game.activities.current.elapsed = 1e9);
    },
    onComplete: () => {},
  });
}
