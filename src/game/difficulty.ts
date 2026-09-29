import type { Game } from './game';
import { BALANCE, NEUTRAL_SURVIVOR } from './balance';
import { setFeelDifficulty, type FeelDifficulty } from './combatfeel';
import { setClockRate } from '../core/time';
import type { Difficulty } from '../progression/difficulty';

// Difficulty presets (docs/DESIGN_V2.md decision 3, numbers and reasons in docs/BALANCE.md):
// every balance knob of the game in one object. *Accessible* is the default, *Classic* keeps
// Bright Nights' numbers except where real time breaks them (those adaptations are the
// CITY_HORDE_REALTIME / SPAWN_REALTIME / FEEL classic constants, not new ones), *Custom* is
// whatever the player set.
//
// The new-game flow (src/progression) records which preset a run uses and calls
// progression/difficulty.ts `difficultyHooks`; src/difficulty.ts hooks in and calls
// applyDifficultySettings here. The full settings (Custom's values) are saved per world in the
// `difficulty` save section. Everything in this file is DOM-free and unit-tested
// (tests/difficulty.test.ts).

export type PresetId = Exclude<Difficulty, 'custom'>;
export type { Difficulty };

export interface DifficultySettings {
  // --- monsters & world (apply to chunks generated from now on, like BN world options)
  /**
   * Non-horde hostile spawns (house zombies, mapgen monsters), on top of the Zombie density
   * option. BN 1; Classic 0.75 is the real-time easing CDDA-3D always had (SPAWN_REALTIME).
   */
  spawnScale: number;
  /** City hordes as a share of BN's 80 zombies per city size (Classic: CITY_HORDE_REALTIME 0.2). */
  hordeScale: number;
  /** No hostile spawns this close (tiles) to the survivor when a chunk generates. */
  safeRadius: number;
  /** The safe radius also keeps dormant (playing-dead) zombies away. */
  dormantSafe: boolean;
  /** Monster walking speed (BN MONSTER_SPEED / 100). */
  monsterSpeed: number;
  /** Monster hit points (BN MONSTER_RESILIENCE / 100), for monsters spawned from now on. */
  monsterResilience: number;
  /** Items in newly generated map areas (BN ITEM_SPAWNRATE). */
  itemSpawnRate: number;
  // --- combat
  /** Combat feel preset: telegraph lengths, parry window, dodge bonus (src/game/combatfeel.ts). */
  feel: FeelDifficulty;
  /** Damage you take in vehicle crashes and run-overs. */
  crashDamage: number;
  /** Chance per turn that a bleeding wound costs HP. */
  bleed: number;
  // --- survival
  hunger: number;
  thirst: number;
  /** Sleepiness gained while awake. */
  fatigue: number;
  /** Natural healing and medicine. */
  healing: number;
  /** How hard cold air and wind chill pull body temperature down. */
  cold: number;
  // --- time
  /** Real minutes per game day are 60 × dayLength (the clock runs at CLOCK_SCALE / dayLength). */
  dayLength: number;
  /** Tactical pause while inventory, crafting and other menus are open (else only the Esc menu pauses). */
  pauseInMenus: boolean;
  // --- death
  /** Death deletes the save (BN). Off: the last save survives and can be loaded again. */
  permadeath: boolean;
}

const CLASSIC: DifficultySettings = {
  spawnScale: 0.75, hordeScale: 0.2, safeRadius: 10, dormantSafe: false, monsterSpeed: 1, monsterResilience: 1, itemSpawnRate: 1,
  feel: 'classic', crashDamage: 1, bleed: 1,
  hunger: 1, thirst: 1, fatigue: 1, healing: 1, cold: 1,
  dayLength: 1, pauseInMenus: false, permadeath: true,
};

const ACCESSIBLE: DifficultySettings = {
  spawnScale: 0.45, hordeScale: 0.1, safeRadius: 24, dormantSafe: true, monsterSpeed: 0.9, monsterResilience: 0.7, itemSpawnRate: 1,
  feel: 'accessible', crashDamage: 0.5, bleed: 0.5,
  hunger: 0.75, thirst: 0.75, fatigue: 1, healing: 2, cold: 0.7,
  dayLength: 1, pauseInMenus: true, permadeath: false,
};

export const DIFFICULTY_PRESETS: Readonly<Record<PresetId, Readonly<DifficultySettings>>> = Object.freeze({
  accessible: Object.freeze({ ...ACCESSIBLE }),
  classic: Object.freeze({ ...CLASSIC }),
});

// ------------------------------------------------------------------ knob table (UI + validation)

export interface Knob {
  key: keyof DifficultySettings;
  name: string;
  group: 'Monsters & world' | 'Combat' | 'Survival' | 'Time' | 'Death';
  desc: string;
  /** Allowed values, in cycling order. */
  choices: readonly (number | boolean | string)[];
  format?: (v: number | boolean | string) => string;
  /** Takes effect only for map areas generated later. */
  newAreasOnly?: boolean;
}

const pct = (v: number | boolean | string) => `${Math.round((v as number) * 100)}%`;
const yesNo = (v: number | boolean | string) => (v ? 'yes' : 'no');
const MULTS = [0, 0.25, 0.5, 0.6, 0.75, 0.85, 0.9, 1, 1.25, 1.5, 2, 3] as const;

export const KNOBS: readonly Knob[] = [
  { key: 'spawnScale', name: 'Zombies in buildings', group: 'Monsters & world', newAreasOnly: true, choices: [0.25, 0.35, 0.45, 0.6, 0.75, 1, 1.5], format: pct, desc: 'Monsters placed by map generation (house zombies, monsters in shops…), on top of Zombie density.  Bright Nights is 100%; Classic eases it to 75% for real-time play.' },
  { key: 'hordeScale', name: 'City hordes', group: 'Monsters & world', newAreasOnly: true, choices: [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1], format: pct, desc: 'Street hordes in towns as a share of Bright Nights\' 80 zombies per city size.  Classic 20%.' },
  { key: 'safeRadius', name: 'Safe radius', group: 'Monsters & world', newAreasOnly: true, choices: [0, 5, 10, 16, 24, 32, 48], format: (v) => `${v} m`, desc: 'No hostile monster is placed this close to you when an area is generated (the evac shelter\'s surroundings in particular).' },
  { key: 'dormantSafe', name: 'Safe radius: corpses too', group: 'Monsters & world', newAreasOnly: true, choices: [false, true], format: yesNo, desc: 'The safe radius also keeps away dormant zombies (corpses that get up when you come close).' },
  { key: 'monsterSpeed', name: 'Monster speed', group: 'Monsters & world', choices: [0.75, 0.8, 0.85, 0.9, 1, 1.1, 1.25], format: pct, desc: 'How fast monsters walk (Bright Nights MONSTER_SPEED).  Their swings keep Bright Nights\' rate.' },
  { key: 'monsterResilience', name: 'Monster toughness', group: 'Monsters & world', newAreasOnly: true, choices: [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.25, 1.5], format: pct, desc: 'Hit points of monsters that appear from now on (Bright Nights MONSTER_RESILIENCE).  Classic 100%.' },
  { key: 'itemSpawnRate', name: 'Item spawn rate', group: 'Monsters & world', newAreasOnly: true, choices: [0.25, 0.5, 0.75, 1, 1.5, 2, 3], format: pct, desc: 'Items found in newly explored places (Bright Nights ITEM_SPAWNRATE).' },
  { key: 'feel', name: 'Combat timing', group: 'Combat', choices: ['accessible', 'classic'], format: (v) => (v === 'accessible' ? 'forgiving' : 'tight'), desc: 'forgiving: longer enemy wind-ups, wider parry window, bigger side-step dodge bonus.  tight: Bright Nights\' swing rate with short tells.' },
  { key: 'bleed', name: 'Bleeding', group: 'Combat', choices: MULTS.filter((v) => v > 0 && v <= 2), format: pct, desc: 'How quickly bleeding wounds cost health.' },
  { key: 'crashDamage', name: 'Crash damage', group: 'Combat', choices: [0.25, 0.5, 0.75, 1, 1.5], format: pct, desc: 'Damage you take in vehicle crashes and from being run over.' },
  { key: 'hunger', name: 'Hunger rate', group: 'Survival', choices: MULTS.filter((v) => v > 0 && v <= 2), format: pct, desc: 'Calories burned per hour.  100% = Bright Nights (2500 kcal a day).' },
  { key: 'thirst', name: 'Thirst rate', group: 'Survival', choices: MULTS.filter((v) => v > 0 && v <= 2), format: pct, desc: 'How quickly you get thirsty.  100% = Thirsty after about 10 hours.' },
  { key: 'fatigue', name: 'Tiredness rate', group: 'Survival', choices: MULTS.filter((v) => v > 0 && v <= 2), format: pct, desc: 'How quickly you get tired while awake.' },
  { key: 'healing', name: 'Healing rate', group: 'Survival', choices: [0.5, 0.75, 1, 1.5, 2, 3], format: pct, desc: 'Natural healing and the effect of bandages and disinfectant.' },
  { key: 'cold', name: 'Cold', group: 'Survival', choices: [0.5, 0.6, 0.7, 0.85, 1, 1.25], format: pct, desc: 'How hard cold air and wind pull your body temperature down.  Heat is unchanged.' },
  { key: 'dayLength', name: 'Day length', group: 'Time', choices: [0.5, 0.75, 1, 1.5, 2], format: (v) => `${Math.round(60 * (v as number))} min`, desc: 'Real minutes a game day takes while you play (sleeping and crafting still skip time).  Hunger and thirst follow the game clock, so a longer day also spreads them out.' },
  { key: 'pauseInMenus', name: 'Pause in menus', group: 'Time', choices: [true, false], format: yesNo, desc: 'Time stops while the inventory, crafting and other menus are open.  Off: only the Esc menu (and the tactical pause key) stop time.' },
  { key: 'permadeath', name: 'Permadeath', group: 'Death', choices: [true, false], format: yesNo, desc: 'Death deletes your save (Bright Nights).  Off: your last save is kept and can be loaded again from the main menu.' },
];

export function knob(key: keyof DifficultySettings): Knob {
  const k = KNOBS.find((x) => x.key === key);
  if (!k) throw new Error(`no difficulty knob ${key}`);
  return k;
}

export function formatKnob(k: Knob, v: number | boolean | string): string {
  return k.format ? k.format(v) : String(v);
}

/** Next allowed value (wrapping); a value not in the list snaps to its nearest neighbour. */
export function cycleKnob(k: Knob, cur: number | boolean | string, dir: 1 | -1): number | boolean | string {
  const list = k.choices;
  const i = list.indexOf(cur);
  if (i < 0 && typeof cur === 'number') {
    const nums = list as readonly number[];
    const next = dir > 0 ? nums.find((v) => v > cur) : [...nums].reverse().find((v) => v < cur);
    return next ?? (dir > 0 ? nums[0] : nums[nums.length - 1]);
  }
  return list[((i < 0 ? 0 : i) + dir + list.length) % list.length];
}

/**
 * Checks a settings object loaded from a save or storage: every key present with the right
 * type and a sane range. Throws (the caller decides whether to fall back and say so).
 */
export function validateSettings(s: unknown): DifficultySettings {
  if (!s || typeof s !== 'object') throw new Error('difficulty settings: not an object');
  const o = s as Record<string, unknown>;
  for (const k of KNOBS) {
    const v = o[k.key];
    const want = typeof k.choices[0];
    if (typeof v !== want) throw new Error(`difficulty settings: ${k.key} should be a ${want}, got ${JSON.stringify(v)}`);
    if (want === 'string' && !k.choices.includes(v as string)) throw new Error(`difficulty settings: ${k.key} = ${JSON.stringify(v)} is not one of ${k.choices.join('/')}`);
    if (want === 'number' && !((v as number) >= 0 && (v as number) <= 100)) throw new Error(`difficulty settings: ${k.key} = ${v} out of range`);
  }
  if (!((o.dayLength as number) > 0)) throw new Error('difficulty settings: dayLength must be > 0');
  const out = {} as Record<string, unknown>;
  for (const k of KNOBS) out[k.key] = o[k.key];
  return out as unknown as DifficultySettings;
}

/** The preset whose values these are, or 'custom'. */
export function matchingPreset(s: DifficultySettings): Difficulty {
  for (const id of Object.keys(DIFFICULTY_PRESETS) as PresetId[]) {
    const p = DIFFICULTY_PRESETS[id];
    if (KNOBS.every((k) => p[k.key] === s[k.key])) return id;
  }
  return 'custom';
}

// ------------------------------------------------------------------ remembered Custom rules

const CUSTOM_KEY = 'cdda3d.difficulty.custom';

/** The Custom rules last used (a new Custom game starts from them); Accessible's when none. */
export function storedCustom(): DifficultySettings {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (raw) return validateSettings(JSON.parse(raw));
  } catch (e) {
    if (typeof localStorage !== 'undefined') console.warn(`ignoring stored custom difficulty: ${(e as Error).message}`);
  }
  return { ...ACCESSIBLE };
}

export function storeCustom(s: DifficultySettings): void {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(validateSettings(s)));
  } catch {
    // storage blocked: Custom still works for this world (it is in the save)
  }
}

// ------------------------------------------------------------------ applying to a game

/**
 * What a game exposes for the knobs that live in other systems. src/difficulty.ts registers
 * the real ones; a test can register fakes.
 */
export interface DifficultyTargets {
  /** Spawner options (src/game/spawner.ts SpawnerOptions). */
  spawner?: { opts: { realtimeScale: number; cityHordeScale: number; safeRadius: number; dormantSafe?: boolean } };
  /** ui2's "pause while inventory-type windows are open" (src/ui2/host.ts settings). */
  setPauseInInventory?: (on: boolean) => void;
}

export interface DifficultyState {
  preset: Difficulty;
  settings: DifficultySettings;
}

const states = new WeakMap<Game, DifficultyState>();
const targets = new WeakMap<Game, DifficultyTargets>();

export function registerDifficultyTargets(game: Game, t: DifficultyTargets): void {
  targets.set(game, { ...targets.get(game), ...t });
}

/** The difficulty in force, or null until something applied one (then everything is at BN's 1). */
export function difficultyState(game: Game): DifficultyState | null {
  return states.get(game) ?? null;
}

/** Settings for a preset id; Custom uses `custom` (default: the stored Custom rules). */
export function settingsFor(d: Difficulty, custom?: DifficultySettings): DifficultySettings {
  if (d === 'custom') return { ...(custom ?? storedCustom()) };
  const p = DIFFICULTY_PRESETS[d];
  if (!p) throw new Error(`unknown difficulty preset ${d}`);
  return { ...p };
}

/**
 * Put `settings` in force for this game, everywhere it matters, right now. Spawn knobs affect
 * chunks generated afterwards (already placed monsters stay); needs, healing, cold, speed,
 * feel, clock and pause behaviour change immediately.
 */
export function applyDifficultySettings(game: Game, preset: Difficulty, settings: DifficultySettings): void {
  const s = validateSettings(settings);
  states.set(game, { preset, settings: s });
  const t = targets.get(game) ?? {};
  if (t.spawner) {
    t.spawner.opts.realtimeScale = s.spawnScale;
    t.spawner.opts.cityHordeScale = s.hordeScale;
    t.spawner.opts.safeRadius = s.safeRadius;
    t.spawner.opts.dormantSafe = s.dormantSafe;
  }
  game.map.itemSpawnRate = s.itemSpawnRate;
  BALANCE.monsterSpeed = s.monsterSpeed;
  BALANCE.crashDamage = s.crashDamage;
  BALANCE.monsterResilience = s.monsterResilience;
  setFeelDifficulty(s.feel);
  game.player.balance = { ...NEUTRAL_SURVIVOR, hunger: s.hunger, thirst: s.thirst, fatigue: s.fatigue, healing: s.healing, bleed: s.bleed, cold: s.cold };
  setClockRate(1 / s.dayLength);
  // Legacy (curses-style) windows pause through pauseInMenus; ui2 windows through its setting.
  // The Esc menu pauses either way (src/ui/menus.ts).
  game.pauseInMenus = s.pauseInMenus;
  t.setPauseInInventory?.(s.pauseInMenus);
}

/** Whether a death should delete the save (SaveManager.onDeath). */
export function permadeath(game: Game): boolean {
  return states.get(game)?.settings.permadeath ?? true;
}
