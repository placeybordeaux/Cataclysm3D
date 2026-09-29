// Difficulty preset chosen in the new-game flow (docs/DESIGN_V2.md decision 3). The new-game
// flow records the choice (per character, in the save) and calls the registered appliers.
// What a preset changes lives in src/game/difficulty.ts (the knobs) and src/difficulty.ts,
// which registers the applier:
//
//   difficultyHooks.push((d, game) => applyDifficultySettings(game, d, settingsFor(d)));
//
// Appliers run when a new game starts and again when a save loads.

import type { Game } from '../game/game';

export type Difficulty = 'accessible' | 'classic' | 'custom';

export interface DifficultyInfo {
  id: Difficulty;
  name: string;
  desc: string;
  /** Reason it can't be picked yet, or undefined. */
  unavailable?: string;
}

export const DIFFICULTIES: DifficultyInfo[] = [
  { id: 'accessible', name: 'Accessible', desc: 'Gentler early spawns, forgiving needs, clear warnings. Menus pause.' },
  { id: 'classic', name: 'Classic', desc: 'Bright Nights numbers, adapted only where real time breaks them.' },
  { id: 'custom', name: 'Custom', desc: 'Your own rules: spawns, monster speed, needs, healing, cold, day length, pausing, permadeath.  Starts from Accessible; edit them here or in Options > Difficulty.' },
];

/**
 * Opens the Custom rules editor (src/difficulty.ts sets it; the rules a new Custom game starts
 * with). Null until installed: the new-game flow then shows no edit button.
 */
export const customRulesEditor: { open: (() => void) | null } = { open: null };

export const DEFAULT_DIFFICULTY: Difficulty = 'accessible';

export const difficultyHooks: ((d: Difficulty, game: Game) => void)[] = [];

const current = new WeakMap<Game, Difficulty>();

export function difficultyOf(game: Game): Difficulty {
  return current.get(game) ?? DEFAULT_DIFFICULTY;
}

export function applyDifficulty(game: Game, d: Difficulty): void {
  if (!DIFFICULTIES.some((x) => x.id === d)) throw new Error(`unknown difficulty ${d}`);
  current.set(game, d);
  for (const h of difficultyHooks) h(d, game);
}

const PREF_KEY = 'cdda3d.difficulty';
/** The last preset picked (the next new game's default). */
export function preferredDifficulty(): Difficulty {
  try {
    const v = localStorage.getItem(PREF_KEY) as Difficulty | null;
    if (v && DIFFICULTIES.some((x) => x.id === v && !x.unavailable)) return v;
  } catch {
    // no storage: default
  }
  return DEFAULT_DIFFICULTY;
}
export function setPreferredDifficulty(d: Difficulty): void {
  try {
    localStorage.setItem(PREF_KEY, d);
  } catch {
    // not persisted
  }
}
