import type { Game } from './game';

// The "Zombie density" world option (CDDA's SPAWN_DENSITY world slider). One value per world:
// chosen at character creation (remembered as the default for the next new game), kept in the
// save, adjustable later in Options (then it only affects chunks generated from then on,
// like CDDA's world options). The spawner (src/game/spawner.ts) owns the live value; the UI
// reaches it through this module so it needn't know about the monster system.

export const DENSITY_CHOICES = [0.5, 1, 2] as const;
const STORAGE_KEY = 'cdda3d.zombieDensity';

export interface DensityHost {
  get(): number;
  set(v: number): void;
}

const hosts = new WeakMap<Game, DensityHost>();

export function registerDensityHost(game: Game, host: DensityHost): void {
  hosts.set(game, host);
}

export function zombieDensity(game: Game): DensityHost | undefined {
  return hosts.get(game);
}

/** Density a new game starts with (the last one chosen), 1 when unset. */
export function defaultDensity(): number {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    return (DENSITY_CHOICES as readonly number[]).includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

export function setDefaultDensity(v: number): void {
  if (!(DENSITY_CHOICES as readonly number[]).includes(v)) throw new Error(`zombie density ${v} is not one of ${DENSITY_CHOICES.join('/')}`);
  try {
    localStorage.setItem(STORAGE_KEY, String(v));
  } catch {
    // storage blocked: the choice just isn't remembered
  }
}

/** Next choice in the list (wrapping), for ←/→ style option cycling. */
export function cycleDensity(cur: number, dir: 1 | -1): number {
  const list = DENSITY_CHOICES as readonly number[];
  const i = list.indexOf(cur);
  return list[((i < 0 ? 1 : i) + dir + list.length) % list.length];
}

export function densityLabel(v: number): string {
  return `${v.toFixed(1)}x`;
}
