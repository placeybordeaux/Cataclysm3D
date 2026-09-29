import type { Game } from './game';
import { hasFlag } from '../world/registry';
import { SECONDS_PER_DAY, SECONDS_PER_HOUR, CLOCK_SCALE } from '../core/time';
import { sunAltitudeAt } from './vision';
import { BODYTEMP } from './character';

// Waiting and sleeping, after CDDA's wait menu (game.cpp wait()) and sleep flow
// (Character::can_sleep, comfort_data in sleep.cpp). Both are game.activities with a clock
// warp. Sleep: you lie down, fall asleep once can_sleep() passes (comfort of the spot +
// how tired you are, rolled every 30 minutes), and wake when rested (Character.update),
// when a loud enough noise reaches you (sound.ts), or when something attacks you (combat
// should call player.wakeUp()).

/** CDDA comfort_level values. */
export const COMFORT = { impossible: -999, uncomfortable: -7, neutral: 0, slightly_comfortable: 3, comfortable: 5, very_comfortable: 10 } as const;
const SLEEPINESS_TIRED = 191;
/** Real seconds per game hour while asleep (≈ 16 real seconds for 8 hours). */
const SLEEP_REAL_PER_HOUR = 2;

export interface ComfortInfo {
  comfort: number;
  /** what you're lying on ("bed", "floor") */
  on: string;
}

/** comfort_data::human_comfort_at: furniture comfort, else terrain comfort (floors 1, ground 0). */
export function comfortAt(game: Game, x: number, y: number, z: number): ComfortInfo {
  const map = game.map;
  const f = map.furnAt(x, y, z), t = map.terAt(x, y, z);
  if (f.id !== 'f_null') {
    if (typeof f.comfort === 'number') return { comfort: f.comfort, on: f.name };
    if (f.move_cost_mod < 0) return { comfort: COMFORT.impossible, on: f.name };
  }
  if (hasFlag(t, 'DEEP_WATER') || hasFlag(t, 'NO_FLOOR')) return { comfort: COMFORT.impossible, on: t.name };
  const tc = typeof t.comfort === 'number' ? t.comfort : 0;
  // Bare, uneven ground outdoors is worse than a floor.
  return { comfort: tc, on: t.name };
}

/** CDDA's "This is a comfortable place to sleep." / "It's hard to get to sleep on this X." */
export function comfortMessage(ci: ComfortInfo): { text: string; good: boolean } {
  if (ci.comfort > COMFORT.neutral) return { text: 'This is a comfortable place to sleep.', good: true };
  if (ci.comfort >= -2) return { text: `It's a little hard to get to sleep on this ${ci.on}.`, good: false };
  return { text: `It's hard to get to sleep on this ${ci.on}.`, good: false };
}

/** Character::can_sleep roll (without the 30-minute rate limit, which callers apply). */
export function canSleepRoll(game: Game): boolean {
  const p = game.player;
  let sleepy = comfortAt(game, p.tileX, p.tileY, p.z).comfort;
  if (p.sleepiness < SLEEPINESS_TIRED + 1) sleepy -= Math.trunc((SLEEPINESS_TIRED + 1 - p.sleepiness) / 4);
  else sleepy += Math.trunc((p.sleepiness - SLEEPINESS_TIRED + 1) / 16);
  sleepy -= 2 * Math.max(0, p.stim);
  sleepy += p.rng.int(-8, 8);
  return sleepy > 0;
}

// ------------------------------------------------------------------ waiting

export interface WaitOption {
  key: string;
  label: string;
  /** game seconds to wait from now */
  seconds: (game: Game) => number;
}

function untilHour(h: number): (game: Game) => number {
  return (game) => {
    const now = game.clock.seconds;
    const day = Math.floor(now / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    let t = day + h * SECONDS_PER_HOUR;
    if (t <= now + 60) t += SECONDS_PER_DAY;
    return t - now;
  };
}

/** Time until the sun crosses `alt` degrees going up (dawn) or down (dusk). */
function untilSun(alt: number, rising: boolean): (game: Game) => number {
  return (game) => {
    const start = game.clock.seconds;
    let prev = sunAltitudeAt(start);
    for (let dt = 300; dt <= SECONDS_PER_DAY + 600; dt += 300) {
      const a = sunAltitudeAt(start + dt);
      if (rising ? prev < alt && a >= alt : prev > alt && a <= alt) return dt;
      prev = a;
    }
    return SECONDS_PER_DAY;
  };
}

/** CDDA wait menu (without the heartbeat-accurate entries that need turn-based play). */
export const WAIT_OPTIONS: WaitOption[] = [
  { key: '1', label: 'Wait 20 heartbeats', seconds: () => 20 },
  { key: '2', label: 'Wait 60 heartbeats', seconds: () => 60 },
  { key: '3', label: 'Wait 5 minutes', seconds: () => 300 },
  { key: '4', label: 'Wait 30 minutes', seconds: () => 1800 },
  { key: '5', label: 'Wait 1 hour', seconds: () => 3600 },
  { key: '6', label: 'Wait 2 hours', seconds: () => 7200 },
  { key: '7', label: 'Wait 3 hours', seconds: () => 10800 },
  { key: '8', label: 'Wait 6 hours', seconds: () => 21600 },
  { key: 'd', label: 'Wait until dawn', seconds: untilSun(-6, true) },
  { key: 'n', label: 'Wait until noon', seconds: untilHour(12) },
  { key: 'k', label: 'Wait until dusk', seconds: untilSun(-6, false) },
  { key: 'm', label: 'Wait until midnight', seconds: untilHour(24) },
  { key: 'w', label: 'Wait till weather changes', seconds: () => -1 },
];

/** Wait `seconds` of game time as an interruptible activity. */
export function waitFor(game: Game, seconds: number, label = 'waiting'): boolean {
  if (game.player.dead) return false;
  if (seconds < 0) {
    // until weather changes: poll every 5 min, cap 24 h
    const start = game.weather?.id;
    return game.activities.start({
      name: label, duration: SECONDS_PER_DAY,
      onProgress: () => {
        if (game.weather?.id !== start) {
          const a = game.activities.current;
          if (a) a.elapsed = a.spec.duration;
        }
      },
      onComplete: () => game.message('You finish waiting.'),
    });
  }
  return game.activities.start({
    name: label,
    duration: seconds,
    onComplete: () => game.message('You finish waiting.'),
  });
}

// ------------------------------------------------------------------ sleeping

const SLEEP_ACTIVITY = 'sleeping';

/** Lie down to sleep here (`$`). Returns false if you can't sleep at this spot. */
export function goToSleep(game: Game): boolean {
  const p = game.player;
  if (p.dead) return false;
  if (p.isAsleep()) return true;
  const ci = comfortAt(game, p.tileX, p.tileY, p.z);
  if (ci.comfort <= COMFORT.impossible) {
    game.message("You can't sleep here.");
    return false;
  }
  p.tryToSleep();
  const m = comfortMessage(ci);
  game.message(m.text, m.good ? 'c_green' : 'c_light_red');
  return startSleepActivity(game);
}

function startSleepActivity(game: Game): boolean {
  const p = game.player;
  let sinceCheck = 1800; // check immediately
  let awakeFor = 0;
  const ok = game.activities.start({
    name: SLEEP_ACTIVITY,
    duration: 24 * SECONDS_PER_HOUR,
    warp: SECONDS_PER_HOUR / CLOCK_SCALE / SLEEP_REAL_PER_HOUR,
    interruptible: false,
    onProgress: (dt) => {
      const a = game.activities.current;
      if (p.dead) {
        if (a) a.elapsed = a.spec.duration;
        return;
      }
      if (p.isAsleep()) {
        awakeFor = 0;
        return;
      }
      if (!p.hasEffect('lying_down') && awakeFor > 0) {
        // Woke up (rested, noise, attack) or gave up trying.
        if (a) a.elapsed = a.spec.duration;
        return;
      }
      awakeFor += dt;
      sinceCheck += dt;
      if (sinceCheck >= 1800) {
        sinceCheck = 0;
        if (canSleepRoll(game)) p.fallAsleep();
      }
      if (awakeFor > 2 * SECONDS_PER_HOUR && !p.isAsleep()) {
        game.message("You try to sleep, but you just can't.", 'c_yellow');
        p.removeEffect('lying_down');
        if (a) a.elapsed = a.spec.duration;
      }
    },
    onComplete: () => {
      p.removeEffect('lying_down');
    },
    onCancel: () => {
      p.removeEffect('lying_down');
    },
  });
  return ok;
}

/**
 * player_activity::get_distractions for the survivor's own body: freezing / overheating
 * (any part past VERY_COLD / VERY_HOT) and dangerous dehydration (thirst > 520). CDDA's
 * starvation distraction needs its starvation counter, which we don't model.
 */
export function survivalDistraction(game: Game): string | null {
  const p = game.player;
  if (p.dead) return null;
  for (const bp of Object.keys(p.bodyTemp) as (keyof typeof p.bodyTemp)[]) {
    const t = p.bodyTemp[bp];
    if (t > BODYTEMP.VERY_HOT) return 'You are overheating!';
    if (t < BODYTEMP.VERY_COLD) return 'You are freezing!';
  }
  if (p.thirst > 520) return 'You are dangerously dehydrated!';
  return null;
}

/** Keeps the clock warped while asleep even if the activity was cancelled (collapsing from exhaustion, WASD). */
export function installRest(game: Game): void {
  game.activities.distractionChecks.push(() => survivalDistraction(game));
  game.systems.push({
    name: 'sleepwatch',
    update(g) {
      const p = g.player;
      if (p.isAsleep() && !p.dead && !g.activities.current) startSleepActivity(g);
    },
  });
}
