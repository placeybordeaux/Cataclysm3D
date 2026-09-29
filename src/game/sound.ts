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
  /** Noises the survivor was told about (for the HUD's compass marks), newest last. */
  heard: HeardNoise[];
}

/** A noise the survivor heard and got a message for (see recentHeard()). */
export interface HeardNoise {
  x: number;
  y: number;
  z: number;
  /** Volume at the survivor's ear (CDDA units, ~ tiles of range left). */
  volume: number;
  description: string;
  /** Sound-clock seconds. */
  t: number;
}

const states = new WeakMap<Game, SoundState>();
function state(game: Game): SoundState {
  let s = states.get(game);
  if (!s) states.set(game, (s = { now: 0, nextId: 1, sounds: [], rng: new Rng(game.seed ^ 0x50d), lastMsg: new Map(), heard: [] }));
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

/** Noises the survivor heard (with a message) in the last `maxAge` real seconds, oldest first. */
export function recentHeard(game: Game, maxAge = 2.5): (HeardNoise & { age: number })[] {
  const st = state(game);
  return st.heard.filter((h) => st.now - h.t <= maxAge).map((h) => ({ ...h, age: st.now - h.t }));
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

/**
 * A CDDA sound description as the object of "You hear …": onomatopoeia ("thump!", "Smack!",
 * "BOOM!") becomes "a thump" / "a boom"; phrases ("a loud crash!", "the engine starting") keep
 * their words without the trailing punctuation.
 */
export function noisePhrase(desc: string): string {
  const d = trimPunct(desc.trim());
  if (!d) return 'a noise';
  if (/^[A-Za-z-]+$/.test(d) && !/^(a|an|the|some)$/i.test(d)) {
    const w = d.toLowerCase();
    return `${/^[aeiou]/.test(w) ? 'an' : 'a'} ${w}`;
  }
  return d;
}

/**
 * "You hear a thump to the north, 12 m away." Playtest: "You hear thump! ×21" while nothing
 * visible happened, with no way to tell where. Every heard noise now says where it came from.
 */
export function hearingLine(desc: string, dx: number, dy: number, dz: number): string {
  const what = noisePhrase(desc);
  const floor = dz > 0 ? (dz === 1 ? 'one floor up' : `${dz} floors up`) : dz < 0 ? (dz === -1 ? 'one floor down' : `${-dz} floors down`) : '';
  if (dx === 0 && dy === 0) return `You hear ${what} ${dz > 0 ? 'above you' : dz < 0 ? 'below you' : 'right here'}.`;
  const d = Math.round(Math.hypot(dx, dy));
  const where = d <= 2 ? 'right next to you' : `${d} m away`;
  return `You hear ${what} to the ${directionName(dx, dy)}, ${where}${floor ? `, ${floor}` : ''}.`;
}

/** Seconds a repeat of the same noise from the same direction stays out of the log. */
export const NOISE_REPEAT_QUIET = 6;

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
  const text = atPlayer ? `From your position you hear ${trimPunct(desc)}.` : hearingLine(desc, s.x - me.x, s.y - me.y, s.z - me.z);
  if (!atPlayer) {
    st.heard.push({ x: s.x, y: s.y, z: s.z, volume: heard, description: desc, t: st.now });
    if (st.heard.length > 32) st.heard.splice(0, st.heard.length - 32);
  }
  // Collapse repeats: the same noise from the same direction (a zombie pounding a door, or
  // walking along a fence) is told once per NOISE_REPEAT_QUIET seconds, not on every blow.
  const key = `${desc}@${atPlayer ? 'here' : directionName(s.x - me.x, s.y - me.y, s.z - me.z)}`;
  const last = st.lastMsg.get(key);
  if (last !== undefined && st.now - last < NOISE_REPEAT_QUIET) return;
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
