// The load gate (user report: "it might be worth just having a loading screen that doesn't
// advance the game until stuff is loaded in"). Pure state machine, no DOM or three.js: the
// chunk manager reports what is missing around the player every frame
// (ChunkManager.missingAround) and this decides whether the game is held. src/loadgate/install.ts
// does the holding (a tactical-pause hold: no ticks, no monster moves, no clock), the overlay,
// the Options row and `?loadgate=`.
//
// "Needed" = the chunks on the player's level and the ones above and below whose nearest point
// is within `nearM` (40 m: what you can see clearly from where you stand, a zombie's lunge
// several times over). The player's own 3x3 on their level (`core`) is the hard case: a load,
// a teleport, a hot-reload restore, falling or climbing into an unbuilt level. Behind it there
// is nothing to look at.
//
// Not flickering during normal play:
//  - a hole in the needed ring must last `debounce` s before the gate closes (a chunk finishing
//    a frame or two late never shows a loading screen); the 3x3 closes it at once
//  - it opens only once the wider ring (`farM`, 64 m) is built too, so walking or driving on
//    doesn't put the next hole within 40 m at once, and it stays closed at least `minHold` s
//  - for `recloseWindow` s after opening, a new hole must last `recloseDebounce` s
//  - a gate that has held `maxHold` s gives up (a stuck build must never lock the game) and
//    stays off for `suppress` s; the install logs that loudly

export type GateMode = 'auto' | 'block' | 'soft' | 'off';
export const GATE_MODES: readonly GateMode[] = ['auto', 'block', 'soft', 'off'];
export const GATE_MODE_DESC: Record<GateMode, string> = {
  auto: 'Full loading screen when the area around you is missing (load, teleport, new level); a small "Loading surroundings" note over the frozen view when only part of it is',
  block: 'Always the full loading screen; the game waits',
  soft: 'The game waits under a small "Loading surroundings" note; you see the world fill in',
  off: 'Never wait (the old behaviour); creatures still appear only once the walls around them are drawn',
};

export function isGateMode(s: string): s is GateMode {
  return (GATE_MODES as readonly string[]).includes(s);
}

/** What the chunk manager reports (ChunkManager.missingAround). */
export interface GateInput {
  /** never-built chunks in the player's own 3x3 on their level */
  core: number;
  /** never-built wanted chunks within nearM on the player's level +-1 */
  near: number;
  /** the same within farM */
  far: number;
  /** wanted chunks within farM (the progress bar's whole) */
  wanted: number;
}

export interface GateTuning {
  nearM: number;
  farM: number;
  debounce: number;
  recloseWindow: number;
  recloseDebounce: number;
  minHold: number;
  maxHold: number;
  suppress: number;
}

export const GATE_TUNING: GateTuning = {
  nearM: 40,
  farM: 64,
  debounce: 0.25,
  recloseWindow: 3,
  recloseDebounce: 1,
  minHold: 0.4,
  maxHold: 20,
  suppress: 10,
};

/** How a closed gate shows itself. */
export type GateStyle = 'block' | 'soft';

export interface GateState {
  closed: boolean;
  style: GateStyle;
  /** why it closed: the player's own 3x3 or the ring around it */
  reason: 'core' | 'near' | null;
  /** seconds closed so far */
  held: number;
  /** 0..1 of the wider ring built */
  progress: number;
  /** this update gave up after maxHold */
  timedOut: boolean;
  /** this update closed / opened the gate */
  closedNow: boolean;
  openedNow: boolean;
}

export class LoadGate {
  mode: GateMode;
  readonly tune: GateTuning;
  private closed = false;
  private style: GateStyle = 'soft';
  private reason: GateState['reason'] = null;
  private held = 0;
  private holeFor = 0;
  private sinceOpen = Infinity;
  private suppressed = 0;
  /** closes and give-ups so far (debug / tests) */
  readonly counts = { closes: 0, timeouts: 0 };

  constructor(mode: GateMode = 'auto', tune: Partial<GateTuning> = {}) {
    this.mode = mode;
    this.tune = { ...GATE_TUNING, ...tune };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Advance by dt real seconds. `active` = gameplay is on (armed, survivor alive); inactive or
   * mode 'off' opens the gate at once.
   */
  update(dt: number, inp: GateInput, active = true): GateState {
    const t = this.tune;
    let closedNow = false, openedNow = false, timedOut = false;
    if (this.suppressed > 0) this.suppressed = Math.max(0, this.suppressed - dt);
    if (!active || this.mode === 'off') {
      if (this.closed) openedNow = true;
      this.closed = false;
      this.holeFor = 0;
      return this.state(inp, false, openedNow, false);
    }
    if (!this.closed) {
      this.sinceOpen += dt;
      this.holeFor = inp.near > 0 || inp.core > 0 ? this.holeFor + dt : 0;
      const wait = this.sinceOpen < t.recloseWindow ? t.recloseDebounce : t.debounce;
      if (this.suppressed <= 0 && (inp.core > 0 || this.holeFor >= wait)) {
        this.closed = true;
        closedNow = true;
        this.held = 0;
        this.reason = inp.core > 0 ? 'core' : 'near';
        this.style = this.mode === 'auto' ? (inp.core > 0 ? 'block' : 'soft') : this.mode;
        this.counts.closes++;
      }
    } else {
      this.held += dt;
      // auto: the 3x3 going missing while the soft note is up (a fall into an unbuilt level)
      // upgrades to the full screen; it never steps back down while closed (no flicker)
      if (this.mode === 'auto' && inp.core > 0 && this.style === 'soft') {
        this.style = 'block';
        this.reason = 'core';
      }
      if (this.mode !== 'auto') this.style = this.mode;
      if (inp.far === 0 && inp.core === 0 && this.held >= t.minHold) {
        this.open();
        openedNow = true;
      } else if (this.held >= t.maxHold) {
        this.open();
        openedNow = true;
        timedOut = true;
        this.suppressed = t.suppress;
        this.counts.timeouts++;
      }
    }
    return this.state(inp, closedNow, openedNow, timedOut);
  }

  private open(): void {
    this.closed = false;
    this.sinceOpen = 0;
    this.holeFor = 0;
  }

  private state(inp: GateInput, closedNow: boolean, openedNow: boolean, timedOut: boolean): GateState {
    const progress = inp.wanted > 0 ? Math.max(0, Math.min(1, 1 - inp.far / inp.wanted)) : 1;
    return { closed: this.closed, style: this.style, reason: this.closed ? this.reason : null, held: this.closed ? this.held : 0, progress, timedOut, closedNow, openedNow };
  }
}
