// The progression handle of a game, for code that must not pull in the UI toolkit (the
// death screen, node tests of src/ui). install.ts sets it.

import type { Game } from '../game/game';
import type { ProgressionHandle } from './install';

const handles = new WeakMap<Game, ProgressionHandle>();

export function progressionOf(game: Game): ProgressionHandle | undefined {
  return handles.get(game);
}

export function setProgression(game: Game, h: ProgressionHandle): void {
  handles.set(game, h);
}
