import type { Game } from './game';
import { hasFlag } from '../world/registry';
import { SECONDS_PER_DAY, SECONDS_PER_HOUR, clockScale } from '../core/time';
import { sunAltitudeAt } from './vision';
import { BODYTEMP, THIRST } from './character';

// Waiting and sleeping, after CDDA's wait menu (game.cpp wait()) and sleep flow
// (Character::can_sleep, comfort_data in sleep.cpp). Both are game.activities with a clock
// warp. Sleep: you lie down, fall asleep once can_sleep() passes (comfort of the spot +
// how tired you are, rolled every 30 minutes), and wake when rested (Character.update),
// when a loud enough noise reaches you (sound.ts), or when something attacks you (combat
// should call player.wakeUp()).

/** CDDA comfort_level values. */
export const COMFORT = { impossible: -999, uncomfortable: -7, neutral: 0, slightly_comfortable: 3, comfortable: 5, very_comfortable: 10 } as const;
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

/**
 * character_funcs::roll_can_sleep for the survivor's spot (without the 30-minute limiter, which
 * Character.rollCanSleep applies when the lying_down effect rolls).
 */
export function canSleepRoll(game: Game): boolean {
  const p = game.player;
  p.sleepComfort = comfortAt(game, p.tileX, p.tileY, p.z).comfort;
  return p.rateSleepSpot() + p.rng.int(-8, 8) > 0;
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
  // CDDA says "heartbeats" for its 1-second turns; there are no turns here (docs/ADAPTATION.md).
  { key: '1', label: 'Wait 20 seconds', seconds: () => 20 },
  { key: '2', label: 'Wait 1 minute', seconds: () => 60 },
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
  p.sleepComfort = ci.comfort;
  p.tryToSleep();
  const m = comfortMessage(ci);
  game.message(m.text, m.good ? 'c_green' : 'c_light_red');
  sleepHints(game, ci);
  return startSleepActivity(game);
}

// ------------------------------------------------------------------ first-nights guidance

/** Each hint is shown this many times per session, then the survivor is assumed to know. */
const HINT_TIMES = 3;
const hintCounts = new WeakMap<Game, Record<'bed' | 'cold', number>>();

/** Log a survival hint the first few times (messages only: never a popup over the onboarding tips). */
export function survivalHint(game: Game, kind: 'bed' | 'cold'): boolean {
  let n = hintCounts.get(game);
  if (!n) hintCounts.set(game, (n = { bed: 0, cold: 0 }));
  if (n[kind] >= HINT_TIMES) return false;
  n[kind]++;
  game.message(kind === 'bed' ? "You'd sleep better in a bed, or with a blanket or sleeping bag." : "It's cold.  Find warmer clothes, or build a fire.", 'c_light_cyan');
  return true;
}

const SHIVER_WAKE = ['Your shivering prevents you from sleeping.', 'You wake up shivering violently, aching from the cold!'];

/** Chilly or colder anywhere (the sidebar's "Chilly" / "Very cold!" / "Freezing!"). */
function feelsCold(game: Game): boolean {
  const p = game.player;
  return Object.values(p.bodyTemp).some((t) => t < BODYTEMP.COLD);
}

/**
 * Lying down somewhere hard or cold: point at what CDDA's sleep comfort rewards (beds,
 * bedding, blankets) and at warmth, the two things that keep a first night from going wrong.
 */
function sleepHints(game: Game, ci: ComfortInfo): void {
  const p = game.player;
  const bedding = (p.env.floorItemWarmth ?? 0) > 0 || p.inv.worn.some((it) => /sleeping_bag|blanket|quilt|duvet|bedroll/.test(it.typeId));
  // Only on bare ground/floor: on a straw bed (comfort 2) BN already says "This is a comfortable
  // place to sleep", and "you'd sleep better in a bed" right after it contradicted it (playtest).
  if (ci.comfort <= COMFORT.neutral && !bedding) survivalHint(game, 'bed');
  if (feelsCold(game)) survivalHint(game, 'cold');
}

/**
 * BN's "You try to sleep, but you just can't." plus the reason when it's simply that you aren't
 * tired: after a long sleep a newcomer lay down at 23:00 twice and got only this line (playtest,
 * round 6). Sleepiness builds while awake; waiting it out is the fix.
 */
function cantSleep(game: Game): void {
  const notTired = game.player.sleepinessDescription() === '';
  game.message(notTired ? "You try to sleep, but you just can't: you aren't tired yet. Stay up a few more hours, then try again." : "You try to sleep, but you just can't.", 'c_yellow');
}

function startSleepActivity(game: Game): boolean {
  const p = game.player;
  let awakeFor = 0;
  let slept = false;
  const ok = game.activities.start({
    name: SLEEP_ACTIVITY,
    duration: 24 * SECONDS_PER_HOUR,
    warp: SECONDS_PER_HOUR / clockScale() / SLEEP_REAL_PER_HOUR,
    interruptible: false,
    onProgress: (dt) => {
      const a = game.activities.current;
      if (p.dead) {
        if (a) a.elapsed = a.spec.duration;
        return;
      }
      if (p.isAsleep()) {
        awakeFor = 0;
        slept = true;
        return;
      }
      if (!p.hasEffect('lying_down') && awakeFor > 0) {
        // Woke up (rested, noise, attack: those say so themselves) or lying_down ran out
        // without ever dropping off, which would otherwise end the activity in silence.
        if (!slept) cantSleep(game);
        if (a) a.elapsed = a.spec.duration;
        return;
      }
      awakeFor += dt;
      // lying_down rolls roll_can_sleep itself (Character.rollCanSleep, every 30 minutes);
      // keep the comfort of the spot it rates current.
      p.sleepComfort = comfortAt(game, p.tileX, p.tileY, p.z).comfort;
      if (awakeFor > 2 * SECONDS_PER_HOUR && !p.isAsleep()) {
        cantSleep(game);
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
 * (any part past VERY_COLD / VERY_HOT) and dangerous dehydration (BN Parched, thirst > 600). CDDA's
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
  if (p.thirst > THIRST.PARCHED) return 'You are dangerously dehydrated!';
  return null;
}

/** Keeps the clock warped while asleep even if the activity was cancelled (collapsing from exhaustion, WASD). */
export function installRest(game: Game): void {
  game.activities.distractionChecks.push(() => survivalDistraction(game));
  // Woken by the cold (Character.update's shivering wake-ups): say what would help, right
  // after that message. Keyed on the message because the sleep activity may roll the survivor
  // back to sleep within the same tick, so there's no clean awake/asleep edge to watch.
  let shivered = false;
  game.events.on('message', (m) => {
    if (SHIVER_WAKE.includes(m.text)) shivered = true;
  });
  game.systems.push({
    name: 'sleepwatch',
    update(g) {
      const p = g.player;
      if (p.isAsleep() && !p.dead && !g.activities.current) startSleepActivity(g);
      if (shivered) {
        shivered = false;
        survivalHint(g, 'cold');
      }
    },
  });
}
