import type { Game } from './game';
import type { GameMap } from '../world/map';
import { tileKey } from '../world/coords';
import { Rng } from '../core/rng';
import { bresenham, playerCanSee } from './vision';

// World noise, after CDDA sounds.cpp. Anything that makes noise calls emitSound(); monsters
// ask soundsHeardAt()/recentSounds() what they could hear, and the player hears (message
// log, waking up, activity interruption) inside emitSound itself, like process_sound_markers.
//
// Volume is in CDDA sound units (≈ tiles of range). Heard volume = volume − weather
// attenuation − sound_distance (Chebyshev + 5× vertical, much more underground).
// Deviation: CDDA ignores walls for hearing; we muffle 3 units per opaque tile on the line
// (max 12) so a closed room actually dampens a gunshot, as the design asks.

/** CDDA sounds::sound_t. Decides whether the player gets a message (describe_sound). */
export type SoundCategory =
  | 'background' | 'weather' | 'music' | 'movement' | 'speech' | 'electronic_speech'
  | 'activity' | 'destructive_activity' | 'alarm' | 'combat' | 'alert' | 'order' | 'sensory';

export interface WorldSound {
  id: number;
  x: number;
  y: number;
  z: number;
  volume: number;
  description: string;
  category: SoundCategory;
  source?: unknown;
  /** Real seconds (sound clock) when it was emitted; see recentSounds(). */
  t: number;
}

export interface SoundOpts {
  source?: unknown;
  /** Default 'combat' (bashing, gunshots — the common callers). */
  category?: SoundCategory;
  /** Passed through to the audio system (src/audio/soundEvents.ts); '' = already played. */
  sfxId?: string;
  sfxVariant?: string;
  /** Don't print "You hear …" for this one (CDDA `ambient`). */
  ambient?: boolean;
}

interface SoundState {
  now: number;
  nextId: number;
  sounds: WorldSound[];
  rng: Rng;
  lastMsg: Map<string, number>;
}

const states = new WeakMap<Game, SoundState>();
function state(game: Game): SoundState {
  let s = states.get(game);
  if (!s) states.set(game, (s = { now: 0, nextId: 1, sounds: [], rng: new Rng(game.seed ^ 0x50d), lastMsg: new Map() }));
  return s;
}

/** How long (real seconds) a sound stays queryable by recentSounds(). */
export const SOUND_MEMORY = 1.0;
const MUFFLE_PER_WALL = 3;
const MUFFLE_MAX = 12;

/** CDDA sound_distance(): rl_dist + 5× vertical, much more when underground. */
export function soundDistance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const lower = Math.min(a.z, b.z), upper = Math.max(a.z, b.z);
  const vd = upper - lower;
  let va = vd;
  if (lower < 0 && vd > 0) {
    va += 4;
    va += (Math.min(-lower, vd) - 1) * 20;
  }
  va *= 5;
  return Math.max(Math.abs(Math.floor(a.x) - Math.floor(b.x)), Math.abs(Math.floor(a.y) - Math.floor(b.y))) + va;
}

/** Volume lost to walls between two tiles (same z only; cross-level uses sound_distance). */
export function wallMuffle(map: GameMap, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  if (Math.floor(a.z) !== Math.floor(b.z)) return 0;
  let n = 0;
  const ax = Math.floor(a.x), ay = Math.floor(a.y), bx = Math.floor(b.x), by = Math.floor(b.y);
  for (const [x, y] of bresenham(ax, ay, bx, by)) {
    if ((x === ax && y === ay) || (x === bx && y === by)) continue;
    if (map.opaque(x, y, a.z)) n += MUFFLE_PER_WALL;
    if (n >= MUFFLE_MAX) return MUFFLE_MAX;
  }
  return n;
}

function weatherAttn(game: Game): number {
  return game.weather?.soundAttn ?? 0;
}

/**
 * The volume a listener at `at` perceives (≤ 0 = inaudible). `hearing` is CDDA's
 * hearing_ability multiplier (1 = normal; monsters without HEARS return 0 by not calling).
 */
export function heardVolume(game: Game, s: WorldSound | { x: number; y: number; z: number; volume: number }, at: { x: number; y: number; z: number }, hearing = 1): number {
  return Math.floor((s.volume - weatherAttn(game)) * hearing) - soundDistance(s, at) - wallMuffle(game.map, s, at);
}

/** Sounds emitted in the last `maxAge` real seconds (monsters poll this every tick). */
export function recentSounds(game: Game, maxAge = SOUND_MEMORY): WorldSound[] {
  const st = state(game);
  return st.sounds.filter((s) => st.now - s.t <= maxAge);
}

/** Recent sounds audible at a position, loudest first, with the volume heard there. */
export function soundsHeardAt(game: Game, x: number, y: number, z: number, hearing = 1, maxAge = SOUND_MEMORY): { sound: WorldSound; volume: number }[] {
  const out: { sound: WorldSound; volume: number }[] = [];
  for (const s of recentSounds(game, maxAge)) {
    const v = heardVolume(game, s, { x, y, z }, hearing);
    if (v > 0) out.push({ sound: s, volume: v });
  }
  return out.sort((a, b) => b.volume - a.volume);
}

/** Make a noise. Emits the `sound` event, remembers it for monsters, and lets the player hear it. */
export function emitSound(
  game: Game, pos: { x: number; y: number; z: number }, volume: number, description: string, opts: SoundOpts = {},
): WorldSound {
  const st = state(game);
  const s: WorldSound = {
    id: st.nextId++, x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), volume, description,
    category: opts.category ?? 'combat', source: opts.source, t: st.now,
  };
  st.sounds.push(s);
  if (st.sounds.length > 256) st.sounds = st.sounds.filter((o) => st.now - o.t <= SOUND_MEMORY);
  game.events.emit('sound', { x: s.x, y: s.y, z: s.z, volume, description, source: opts.source, sfxId: opts.sfxId, sfxVariant: opts.sfxVariant });
  playerHears(game, s, opts.ambient ?? false);
  return s;
}

/** CDDA direction_name for the message "From the north-east you hear …". */
export function directionName(dx: number, dy: number, dz = 0): string {
  if (dx === 0 && dy === 0) return dz > 0 ? 'above' : dz < 0 ? 'below' : 'here';
  const a = Math.atan2(dx, -dy); // 0 = north, clockwise
  const names = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return names[i];
}

const trimPunct = (s: string) => s.replace(/[.!?\s]+$/, '');

/** describe_sound(): which categories get a log line (from the player's own tile vs elsewhere). */
function describes(cat: SoundCategory, fromPlayer: boolean, rng: Rng): boolean {
  if (fromPlayer) return cat === 'electronic_speech' || cat === 'alarm';
  switch (cat) {
    case 'background': case 'weather': case 'sensory': case 'music': case 'movement': case 'activity': case 'destructive_activity':
      return rng.oneIn(100);
    default:
      return true;
  }
}

function playerHears(game: Game, s: WorldSound, ambient: boolean): void {
  const p = game.player;
  if (p.dead) return;
  const me = { x: p.tileX, y: p.tileY, z: p.z };
  const heard = heardVolume(game, s, me);
  const atPlayer = s.x === me.x && s.y === me.y && s.z === me.z;
  const fromPlayer = s.source === p || atPlayer;
  if (heard <= 0 && !atPlayer) return;
  const st = state(game);

  // Waking up: dice(2, 15) < heard volume (HEAVYSLEEPER rolls more dice).
  if (p.isAsleep()) {
    if (fromPlayer) return;
    const dice = p.hasTrait('HEAVYSLEEPER2') ? 6 : p.hasTrait('HEAVYSLEEPER') ? 3 : 2;
    if (st.rng.dice(dice, 15) < heard) {
      p.wakeUp();
      game.message('Something is making noise.', 'c_yellow');
    } else return;
  }

  // Distraction: noise you can't see the source of interrupts long actions ("Heard a crash!").
  const act = game.activities.current;
  if (!ambient && !fromPlayer && act && act.spec.interruptible !== false && !playerCanSee(game, s.x, s.y, s.z)
    && s.category !== 'movement' && s.category !== 'background' && s.category !== 'weather') {
    game.activities.cancel(`Heard ${trimPunct(s.description || 'a noise')}!`);
  }

  if (ambient || !describes(s.category, atPlayer, st.rng)) return;
  const desc = s.description || 'a noise';
  let text: string;
  if (atPlayer) text = `From your position you hear ${desc}`;
  else if (playerCanSee(game, s.x, s.y, s.z)) text = `You hear ${desc}`;
  else text = `From the ${directionName(s.x - me.x, s.y - me.y, s.z - me.z)} you hear ${desc}`;
  // Collapse spam from repeated identical noises (a zombie pounding a door).
  const key = `${text}@${tileKey(s.x, s.y, s.z)}`;
  const last = st.lastMsg.get(key);
  if (last !== undefined && st.now - last < 1.5) return;
  st.lastMsg.set(key, st.now);
  if (st.lastMsg.size > 200) st.lastMsg.clear();
  game.message(text, s.category === 'combat' || s.category === 'alarm' ? 'c_light_red' : undefined);
}

/**
 * CDDA Character::footstep_sound(): 6 (3 if stealthy) × movement-mode multiplier
 * (run 1.5, crouch 0.5).
 */
export function footstepVolume(running: boolean, crouching: boolean, stealthy = false): number {
  const base = stealthy ? 3 : 6;
  return Math.round(base * (running ? 1.5 : crouching ? 0.5 : 1));
}

/** Advances the sound clock and makes the player's footsteps (one per tile walked). */
export function installSound(game: Game): void {
  const st = state(game);
  let lx = game.player.x, ly = game.player.y, lz = game.player.z;
  let acc = 0;
  game.systems.push({
    name: 'sound',
    update(g, realDt) {
      st.now += realDt;
      if (st.sounds.length && st.now - st.sounds[0].t > SOUND_MEMORY * 4) st.sounds = st.sounds.filter((o) => st.now - o.t <= SOUND_MEMORY);
      const p = g.player;
      const moved = Math.hypot(p.x - lx, p.y - ly);
      if (p.z !== lz || moved > 2) acc = 0;
      else acc += moved;
      lx = p.x; ly = p.y; lz = p.z;
      if (acc >= 1) {
        acc -= 1;
        const running = p.running && p.canRun();
        const vol = footstepVolume(running, p.crouching, p.hasTrait('LIGHTSTEP'));
        // Audio plays its own footsteps (src/audio/install.ts), so this one is silent there.
        emitSound(g, { x: p.x, y: p.y, z: p.z }, vol, 'footsteps', { category: 'movement', source: p, sfxId: '' });
      }
    },
  });
}

/** Test/debug: the sound clock (real seconds since install). */
export function soundClock(game: Game): number {
  return state(game).now;
}
