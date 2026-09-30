import type { Game, GameSystem } from './game';
import { clockScale } from '../core/time';

// Long actions (crafting, reading, butchering, constructing, waiting, sleeping) in CDDA take
// minutes to hours of game time. In real time we play them as a short progress bar while the
// clock is warped, and interrupt them the way CDDA does when danger appears.
//
// Usage:  game.activities.start({ name: 'crafting a spear', duration: 1800, onComplete: () => … })

export interface ActivitySpec {
  /** Shown in the progress bar: "crafting wooden spear". */
  name: string;
  /** Total game seconds. */
  duration: number;
  /** Called every tick with game seconds elapsed this tick (e.g. reading grants xp). */
  onProgress?: (gameDt: number, fraction: number) => void;
  onComplete: () => void;
  /** Called on interruption/cancel with the fraction done (CDDA keeps partial craft progress). */
  onCancel?: (fraction: number, reason: string) => void;
  /**
   * Clock warp while active. Default aims to finish in ~2-8 real seconds. Sleep/wait set
   * their own (large) warp.
   */
  warp?: number;
  /** Whether danger interrupts it (sleeping is interrupted by noise via other means). */
  interruptible?: boolean;
  /** What kind of work ('craft', 'construction', 'read', 'disassemble'…), for UIs that show more. */
  kind?: string;
  /** The thing being worked on (the in-progress craft item, the book…). */
  target?: unknown;
  /** Map tile the work happens at (a construction site), for an in-world progress bar. */
  at?: { x: number; y: number; z: number };
  /** A richer UI draws this activity's progress; the plain HUD bar can stay out of the way. */
  customUi?: boolean;
}

const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];

export class Activity {
  elapsed = 0;
  /** Distractions already present when the activity started (CDDA "ignore" them for this one). */
  readonly ignored = new Set<string>();
  /**
   * Movement keys already held when the activity started (still walking up to the fireplace
   * as you press e): they don't cancel it until released and pressed again. Playtest: "I try
   * to start a fire and it just says I stopped" — the held W cancelled it on the next tick.
   */
  readonly heldAtStart = new Set<string>();
  constructor(readonly spec: ActivitySpec) {}
  get fraction(): number {
    return Math.min(1, this.elapsed / Math.max(1, this.spec.duration));
  }
}

export class ActivityManager implements GameSystem {
  readonly name = 'activities';
  current: Activity | null = null;
  /**
   * Danger sources register here (monster system: "You see a zombie!"). Returns a reason
   * string to interrupt, or null.
   */
  readonly dangerChecks: (() => string | null)[] = [];
  /**
   * CDDA player_activity::get_distractions for the survivor's own state ("You are freezing!",
   * "You are dangerously dehydrated!"). Unlike dangerChecks they never stop an activity from
   * starting (you must be able to craft a blanket while freezing), and one already present at
   * the start is ignored for that activity; a new one interrupts it, so a long wait outdoors
   * at night stops when the cold turns dangerous instead of running on until you die.
   */
  readonly distractionChecks: (() => string | null)[] = [];

  constructor(private game: Game) {}

  start(spec: ActivitySpec): boolean {
    if (this.current) this.cancel('You stop what you were doing.');
    const danger = spec.interruptible === false ? null : this.danger();
    if (danger) {
      this.game.message(danger, 'c_red');
      return false;
    }
    this.current = new Activity(spec);
    for (const k of MOVE_KEYS) if (this.game.input.held.has(k)) this.current.heldAtStart.add(k);
    for (const r of this.distractions()) this.current.ignored.add(r);
    this.game.clock.warp = spec.warp ?? defaultWarp(spec.duration);
    return true;
  }

  cancel(reason: string): void {
    const a = this.current;
    if (!a) return;
    this.current = null;
    this.game.clock.warp = 1;
    this.game.message(reason, 'c_yellow');
    a.spec.onCancel?.(a.fraction, reason);
  }

  private distractions(): string[] {
    const out: string[] = [];
    for (const d of this.distractionChecks) {
      const r = d();
      if (r) out.push(r);
    }
    return out;
  }

  private danger(): string | null {
    for (const d of this.dangerChecks) {
      const r = d();
      if (r) return r;
    }
    return null;
  }

  update(_game: Game, _realDt: number, gameDt: number): void {
    const a = this.current;
    if (!a) return;
    if (a.spec.interruptible !== false) {
      const d = this.danger();
      if (d) return this.cancel(d);
      const fresh = this.distractions().find((r) => !a.ignored.has(r));
      if (fresh) return this.cancel(fresh);
    }
    // Movement cancels activities, like CDDA's "You stop crafting."
    const held = this.game.input.held;
    for (const k of a.heldAtStart) if (!held.has(k)) a.heldAtStart.delete(k);
    if (!this.game.input.captured && MOVE_KEYS.some((k) => held.has(k) && !a.heldAtStart.has(k))) {
      return this.cancel(`You stop ${a.spec.name}.`);
    }
    a.elapsed += gameDt;
    a.spec.onProgress?.(gameDt, a.fraction);
    if (a.elapsed >= a.spec.duration) {
      this.current = null;
      this.game.clock.warp = 1;
      a.spec.onComplete();
    }
  }
}

/** Warp so an activity of `duration` game seconds takes ~2–8 real seconds. */
export function defaultWarp(duration: number): number {
  // clockScale() (not CLOCK_SCALE): with a longer day the activity still takes ~2–8 real s.
  const realAtNormal = duration / clockScale();
  const target = Math.min(8, Math.max(2, Math.sqrt(realAtNormal)));
  return Math.max(1, realAtNormal / target);
}
