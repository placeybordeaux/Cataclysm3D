import type { Game } from './game';
import { TICK } from './game';

// Fast-forward for timed activities (reading, crafting, waiting, sleeping, butchering…).
// User: "I'd kind of want to be able to accelerate reading a bit more, maybe add a button to
// make time pass faster (if possible on the machine while reading?)".
//
// An activity already warps the clock (src/game/activity.ts: 2–8 real s for a craft or a
// chapter, 2 real s per game hour asleep). Fast-forward multiplies that by running *more
// ticks per real second* (Game.simSpeed), never longer ticks: every tick is exactly the tick
// ×1 would have run, so interrupts (a zombie in view, a noise, the cold), monster AI, fields,
// fire and needs come out identical at ×8, and the moment something interrupts, the speed
// drops back to ×1 for the rest of that very frame.
//
// "If possible on the machine": WarpGovernor watches what a tick costs and what the rest of
// the frame (drawing) costs, and caps the speed so a frame stays under ~25 ms. The ring shows
// "×8 (capped ×5)" when it bites.

/** The speeds the key steps through. ×16 is there for long sleeps on a fast machine; the cap decides. */
export const SPEED_STEPS = [1, 2, 4, 8, 16] as const;

/** Next speed in the cycle; past the top it wraps back to ×1. */
export function nextSpeed(cur: number): number {
  const i = SPEED_STEPS.findIndex((s) => s > cur);
  return i < 0 ? 1 : SPEED_STEPS[i];
}

/**
 * Caps the fast-forward speed so our main loop stays under `budgetMs` per drawn frame.
 * Pure (no clock, no DOM): fed per frame with what the simulation and the drawing cost.
 *
 * The cap falls at once when a frame would go over budget and rises one step at a time after
 * `riseAfter` seconds of room, so it settles instead of oscillating between two speeds.
 */
export class WarpGovernor {
  budgetMs = 25;
  /** Never cap below this (×1 must always be possible) or above this. */
  readonly max: number;
  /** Seconds of headroom before the cap goes up by one. */
  riseAfter = 0.5;
  /** Smoothed cost of one simulation tick, ms. */
  tickMs = 0;
  /** Smoothed cost of the rest of a drawn frame (drawing, streaming), ms. */
  otherMs = 0;
  /** Smoothed real frame interval, s. */
  frameS = 1 / 60;
  cap: number;
  private room = 0;

  constructor(max: number = SPEED_STEPS[SPEED_STEPS.length - 1]) {
    this.max = max;
    this.cap = max;
  }

  /** The speed the machine can afford right now (integer, 1..max). */
  affordable(): number {
    if (this.tickMs <= 0) return this.max;
    // Ticks one frame needs at ×1: a frame of frameS seconds holds frameS / TICK ticks.
    const ticksAt1 = Math.max(this.frameS, 1 / 240) / TICK;
    const fit = Math.max(0, this.budgetMs - this.otherMs) / this.tickMs;
    return Math.max(1, Math.min(this.max, Math.floor(fit / ticksAt1)));
  }

  /**
   * One frame: `simMs` spent running `ticks` simulation ticks, `otherMs` on the rest of the
   * frame (null when this frame wasn't drawn: it says nothing about drawing cost), `frameS`
   * since the previous frame.
   */
  observe(simMs: number, ticks: number, otherMs: number | null, frameS: number): void {
    if (!(frameS > 0) || !Number.isFinite(simMs)) throw new Error(`WarpGovernor.observe: bad sample sim=${simMs} frame=${frameS}`);
    const k = 0.2;
    if (ticks > 0) this.tickMs = this.tickMs ? this.tickMs + (simMs / ticks - this.tickMs) * k : simMs / ticks;
    if (otherMs !== null) this.otherMs = this.otherMs ? this.otherMs + (otherMs - this.otherMs) * k : otherMs;
    // A long hitch (GC, a tab switch) says nothing about the steady frame rate.
    this.frameS += (Math.min(frameS, 0.1) - this.frameS) * k;
    const can = this.affordable();
    if (can < this.cap) {
      this.cap = can;
      this.room = 0;
    } else if (can > this.cap) {
      this.room += frameS;
      if (this.room >= this.riseAfter) {
        this.cap++;
        this.room = 0;
      }
    } else this.room = 0;
  }
}

/** The need states that are a step for the worse (Sated / Hydrated aren't). */
const HUNGRY = /hungry|famished|starving/i;
const THIRSTY = /thirsty|dehydrated|parched/i;

export type WarpKeyMode = 'cycle' | 'hold';

/**
 * The fast-forward state for one game: what the player asked for, what the machine allows,
 * and the per-tick safety checks that drop it back to ×1.
 */
export class TimeWarp {
  /** What the player picked (the key / the ring's » / the Rest window). */
  requested = 1;
  /** Hold mode: the key is down. */
  holding = false;
  keyMode: WarpKeyMode = 'cycle';
  readonly governor = new WarpGovernor();
  /** Why it last dropped to ×1 ("You see a zombie!"), for the ring; cleared on the next raise. */
  dropped: string | null = null;
  /** A speed for the activity about to start (the Rest window's "Speed" picks it before waiting). */
  private armed = 0;
  private armedTicks = 0;
  /** Need states at the last tick (null before the first one: nothing to compare yet). */
  private hunger: string | null = null;
  private thirst: string | null = null;
  private wasAsleep = false;
  private hp = -1;

  constructor(private game: Game) {}

  /** Whether fast-forward means anything now: a timed activity with a warped clock. */
  available(): boolean {
    return !!this.game.activities.current && this.game.clock.warp > 1 && !this.game.player.dead;
  }

  /** The speed asked for, before the machine's cap. */
  wanted(): number {
    if (!this.available()) return 1;
    return this.keyMode === 'hold' ? (this.holding ? SPEED_STEPS[SPEED_STEPS.length - 1] : 1) : this.requested;
  }

  /** The speed actually running. */
  effective(): number {
    return Math.min(this.wanted(), Math.max(1, this.governor.cap));
  }

  /** The key / the ring's »: next step (cycle mode). Returns the new requested speed. */
  cycle(): number {
    if (!this.available()) return 1;
    this.requested = nextSpeed(this.requested);
    this.dropped = null;
    this.apply();
    return this.requested;
  }

  set(speed: number): void {
    if (!SPEED_STEPS.includes(speed as (typeof SPEED_STEPS)[number])) throw new Error(`TimeWarp.set: ${speed} is not one of ${SPEED_STEPS.join(', ')}`);
    this.requested = speed;
    this.dropped = null;
    this.apply();
  }

  /** Start the next timed activity at this speed (it starts within a few ticks or the arm lapses). */
  arm(speed: number): void {
    if (!SPEED_STEPS.includes(speed as (typeof SPEED_STEPS)[number])) throw new Error(`TimeWarp.arm: ${speed} is not one of ${SPEED_STEPS.join(', ')}`);
    this.armed = speed;
    this.armedTicks = 0;
    if (this.available() && speed > 1) {
      this.set(speed);
      this.armed = 0;
    }
  }

  /** Back to ×1 now, saying why on the ring. */
  drop(reason: string): void {
    // The game's speed, not effective(): a cancel has already cleared the activity.
    const was = Math.max(this.game.simSpeed, this.requested);
    this.requested = 1;
    this.holding = false;
    this.armed = 0;
    if (was > 1) this.dropped = reason;
    this.apply();
  }

  /** Push the speed into the game loop. Called whenever anything above changes, and every tick. */
  apply(): void {
    this.game.simSpeed = this.effective();
  }

  /**
   * Per-tick safety (a GameSystem, after the activity manager): hunger/thirst getting worse,
   * waking up, the activity ending. Interrupts and damage come through hooks (install).
   */
  update(): void {
    const g = this.game;
    const p = g.player;
    if (this.armed) {
      if (this.available()) {
        this.set(this.armed);
        this.armed = 0;
      } else if (++this.armedTicks > 15) this.armed = 0;
    }
    const hunger = p.hungerState(), thirst = p.thirstDescription();
    const asleep = p.isAsleep();
    let hp = 0;
    for (const k in p.hp) hp += p.hp[k as keyof typeof p.hp].cur;
    if (this.effective() > 1) {
      // Hurt by something that doesn't announce itself as an attack (fire, a field, bleeding).
      if (this.hp >= 0 && hp < this.hp) this.drop('You were hurt!');
      // A new, worse need state: BN only stops at the dangerous ones (the distraction checks),
      // but at ×8 "Hungry" → "Very hungry" would fly past unread, so the speed drops to ×1.
      else if (this.hunger !== null && hunger !== this.hunger && HUNGRY.test(hunger)) this.drop(`You feel ${hunger.toLowerCase()}.`);
      else if (this.thirst !== null && thirst !== this.thirst && THIRSTY.test(thirst)) this.drop(`You feel ${thirst.toLowerCase()}.`);
      else if (this.wasAsleep && !asleep) this.drop('You wake up.');
    }
    this.hunger = hunger;
    this.thirst = thirst;
    this.wasAsleep = asleep;
    this.hp = hp;
    if (!this.available() && this.requested !== 1) this.requested = 1;
    this.apply();
  }
}

const warps = new WeakMap<Game, TimeWarp>();

/** The game's fast-forward (installed once per game; tests and the UI share it). */
export function timeWarp(game: Game): TimeWarp {
  const w = warps.get(game);
  if (!w) throw new Error('timeWarp: installTimeWarp(game) has not run');
  return w;
}

/**
 * Hook fast-forward into a game: a system after the activity manager, the cancel hook
 * (every interrupt drops to ×1), and BN's Character::on_hurt (being hurt stops what you are
 * doing: "You were attacked by the zombie!").
 */
export function installTimeWarp(game: Game): TimeWarp {
  if (warps.has(game)) throw new Error('installTimeWarp: already installed for this game');
  const w = new TimeWarp(game);
  warps.set(game, w);
  game.systems.push({ name: 'timewarp', update: () => w.update() });
  game.activities.cancelHooks.push((_a, reason) => w.drop(reason));
  game.events.on('playerHurt', (e) => {
    if (!(e.amount > 0) || game.player.dead) return;
    const a = game.activities.current;
    const src = e.source as { disp_name?: () => string; displayName?: () => string; name?: string } | undefined;
    const who = src?.displayName?.() ?? (typeof src?.name === 'string' ? src.name : null);
    const why = who ? `You were attacked by ${/^[A-Z]/.test(who) ? who : `the ${who}`}!` : 'You were hurt!';
    // BN on_hurt also wakes a sleeper (no narcosis here). Without it a zombie got six blows in
    // on a sleeping survivor before the noise woke them (found by the ×8 sleep test). The sleep
    // activity isn't cancelled: it ends itself once you're awake.
    if (game.player.isAsleep()) game.player.wakeUp();
    if (a && a.spec.interruptible !== false) game.activities.cancel(why);
    else w.drop(why);
  });
  return w;
}
