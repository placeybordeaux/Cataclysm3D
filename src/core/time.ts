// Two clocks exist on purpose:
//  - "action time": movement/combat run in real time, scaled by ACTION_SCALE so that one
//    CDDA turn (100 moves) takes 1/ACTION_SCALE real seconds.
//  - "world time": the calendar (hunger, day/night, crafting durations) in game seconds,
//    advancing CLOCK_SCALE game-seconds per real second, faster while waiting/crafting.
// This mirrors how CDDA reads (you out-walk a speed-70 zombie) while keeping a 24h day
// playable (~1 real hour per game day at the default scale).

/** CDDA turns per real second for movement/combat. Speed 100 walker => 3 tiles/s. */
export const ACTION_SCALE = 3;
/**
 * CDDA turns per real second for melee swings (player and monsters). Slower than movement on
 * purpose: at 3 turns/s a plain zombie swung 2+ times a second and a pack shredded you before
 * you could react; at 2 you still out-walk it but a fight reads blow by blow.
 */
export const MELEE_SCALE = 2;
/** Game seconds per real second while playing normally. */
export const CLOCK_SCALE = 24;

export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_DAY = 86400;
/** CDDA default season length is 91 days. */
export const DAYS_PER_SEASON = 91;

export class GameClock {
  /** Game seconds since cataclysm start. CDDA default start: spring, day 1, 8:00. */
  seconds = 8 * SECONDS_PER_HOUR;
  /** Multiplier applied on top of CLOCK_SCALE (e.g. 50 while waiting/sleeping). */
  warp = 1;

  advanceReal(realDt: number): number {
    const dt = realDt * CLOCK_SCALE * this.warp;
    this.seconds += dt;
    return dt;
  }
  get day(): number {
    return Math.floor(this.seconds / SECONDS_PER_DAY);
  }
  get hourOfDay(): number {
    return (this.seconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR;
  }
  get season(): 'spring' | 'summer' | 'autumn' | 'winter' {
    return (['spring', 'summer', 'autumn', 'winter'] as const)[Math.floor(this.day / DAYS_PER_SEASON) % 4];
  }
  format(): string {
    const h = Math.floor(this.hourOfDay);
    const m = Math.floor((this.seconds % SECONDS_PER_HOUR) / 60);
    const dayOfSeason = (this.day % DAYS_PER_SEASON) + 1;
    return `${this.season[0].toUpperCase()}${this.season.slice(1)}, day ${dayOfSeason} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
