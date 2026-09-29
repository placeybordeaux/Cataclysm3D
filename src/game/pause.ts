import type { Game } from './game';

// Tactical pause state machine (docs/DESIGN_V2.md: "a tactical pause is always available").
// Several things can hold the simulation still at once and must not undo each other:
//
//   manual  the player's toggle key: on until pressed again (or the survivor dies)
//   <auto>  named holds, e.g. 'menus' while an inventory-type ui2 window is open and the
//           difficulty wants menus to pause; released when that window closes
//
// game.tacticalPause (read by Game.frame) is true while any of them holds. Closing the
// inventory therefore never cancels a pause the player asked for, and un-pausing by key while
// the Accessible inventory is open leaves time stopped until the window closes.
// Mouse-look keeps working while paused (Game.frame applies it before the pause check).

export type PauseListener = (paused: boolean, p: TacticalPause) => void;

export class TacticalPause {
  private manualOn = false;
  private holds = new Set<string>();
  private listeners: PauseListener[] = [];

  constructor(private readonly game: Game) {}

  /** Paused for any reason. */
  get paused(): boolean {
    return this.manualOn || this.holds.size > 0;
  }
  /** Paused because the player pressed the key. */
  get manual(): boolean {
    return this.manualOn;
  }
  /** Named automatic holds currently in force. */
  reasons(): string[] {
    return [...this.holds];
  }

  /** The pause key. Returns the new manual state. */
  toggle(): boolean {
    this.setManual(!this.manualOn);
    return this.manualOn;
  }

  setManual(on: boolean): void {
    if (on && this.game.player.dead) on = false;
    if (on === this.manualOn) return;
    this.manualOn = on;
    this.sync();
  }

  /** Add or release an automatic hold. */
  hold(reason: string, on: boolean): void {
    if (!reason) throw new Error('pause hold needs a reason');
    const had = this.holds.has(reason);
    if (on === had) return;
    if (on) this.holds.add(reason);
    else this.holds.delete(reason);
    this.sync();
  }

  /** Drop everything (death, quitting to the title screen). */
  clear(): void {
    this.manualOn = false;
    this.holds.clear();
    this.sync();
  }

  onChange(fn: PauseListener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private sync(): void {
    this.game.tacticalPause = this.paused;
    // Listeners hear every change of reason too (the banner text differs), not only on/off.
    for (const l of [...this.listeners]) l(this.paused, this);
  }
}

const pauses = new WeakMap<Game, TacticalPause>();

/** The game's tactical pause (created on first use). */
export function tacticalPauseOf(game: Game): TacticalPause {
  let p = pauses.get(game);
  if (!p) pauses.set(game, (p = new TacticalPause(game)));
  return p;
}
