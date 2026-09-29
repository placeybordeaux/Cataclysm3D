// Keyboard/mouse state. Gameplay reads held keys each tick; UI menus subscribe to
// discrete key presses. When a menu is open it captures keys (see Input.capture) so
// e.g. pressing "e" inside the inventory doesn't also trigger "examine".

import { normalizeKey, MOVEMENT_CODES } from '../ui/keymap';

export type KeyHandler = (e: KeyboardEvent) => boolean | void;

/** How menus treat the mouse: keep it captured (keyboard menus) or free the cursor to point and click. */
export type MenuCursor = 'captured' | 'free';

export class Input {
  /**
   * Physical codes currently held. Tracked while menus are open too (keyups always arrive), so
   * a key released inside a menu is never left "stuck", and one still held when the menu
   * closes keeps working. Gameplay ignores it while a menu is open.
   */
  readonly held = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  mouseButtons = 0;
  private pressHandlers: KeyHandler[] = [];
  /** Stack of modal handlers; top of stack gets keys exclusively. */
  private captureStack: KeyHandler[] = [];
  private clicks: number[] = [];
  /**
   * True while the player is in gameplay and the mouse should be captured (false on the
   * title screen). Menus keep the capture so closing them drops you straight back into
   * mouse-look; only the browser's own Esc handling or focus loss releases it.
   */
  wantLock = false;
  /** Options > Menu cursor: 'free' releases the lock while a menu is open (see framework.ts). */
  menuCursor: MenuCursor = 'captured';
  /** The top window wants mouse-look to keep working (look mode); set by the UI framework. */
  menuMouseLook = false;
  /** We released the lock ourselves (free-cursor menu); the next unlock isn't an Esc. */
  expectUnlock = false;
  /** Real-time of the last Escape keydown we handled (see pointer-lock loss handling). */
  lastEscape = -1;
  /** Increments on every keydown; lets a window know whether its opening key was the last one pressed. */
  keySeq = 0;
  /** Movement key pressed with the character it typed (lets Keys learn the keyboard layout). */
  onMovementKey: ((code: string, key: string) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      // Everyone downstream (bindings, menu hotkeys) sees the CapsLock-/layout-normalized key.
      const key = normalizeKey({ key: e.key, code: e.code, shiftKey: e.shiftKey, capsLock: !!e.getModifierState?.('CapsLock') });
      if (key !== e.key) Object.defineProperty(e, 'key', { value: key });
      this.keySeq++;
      if (e.key === 'Escape') this.lastEscape = performance.now();
      this.held.add(e.code);
      if (MOVEMENT_CODES.has(e.code) && !e.repeat) this.onMovementKey?.(e.code, e.key);
      const top = this.captureStack[this.captureStack.length - 1];
      if (top) {
        if (top(e) !== false) e.preventDefault();
        return;
      }
      // Back in gameplay after losing the lock (Esc closed a menu, alt-tab): any key is a user
      // gesture, so it resumes mouse-look as well as doing what it does.
      if (this.wantLock && !this.locked && e.key !== 'Escape') this.tryLock();
      for (const h of this.pressHandlers) if (h(e) === true) { e.preventDefault(); break; }
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    // Focus loss eats the keyups and mouseups of whatever was held: forget it all.
    const release = () => {
      this.held.clear();
      this.mouseButtons = 0;
    };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', () => document.hidden && release());
    document.addEventListener('pointerlockchange', () => {
      if (!this.locked) this.mouseButtons = 0;
    });
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.canvas) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    canvas.addEventListener('mousedown', (e) => {
      if (this.captureStack.length) return;
      if (document.pointerLockElement !== canvas) {
        // A click on the view resumes mouse-look; it is never also an attack.
        this.tryLock(true);
        return;
      }
      this.mouseButtons |= 1 << e.button;
      this.clicks.push(e.button);
    });
    window.addEventListener('mouseup', (e) => (this.mouseButtons &= ~(1 << e.button)));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Global (non-modal) key press listener. Return true to consume. */
  onPress(h: KeyHandler): void {
    this.pressHandlers.push(h);
  }
  /**
   * Push a modal handler; returns a release function. Pointer lock is kept unless the player
   * chose free-cursor menus: menus are keyboard-driven (CDDA style), and releasing the lock
   * would otherwise need a click to get back into mouse-look after every menu.
   */
  capture(h: KeyHandler, opts: { timeFlows?: boolean } = {}): () => void {
    this.captureStack.push(h);
    if (opts.timeFlows) this.flowing.add(h);
    // Buttons held when a menu opens would otherwise keep swinging once it closes.
    this.mouseButtons = 0;
    return () => {
      const i = this.captureStack.lastIndexOf(h);
      if (i >= 0) this.captureStack.splice(i, 1);
    };
  }
  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }
  /**
   * Try to re-enter mouse-look. Only succeeds inside a user gesture (key/click handler) and
   * not within ~1.25 s of the browser's own Esc unlock (Chrome: "cannot be acquired
   * immediately after the user has exited the lock"). A refusal for that reason is retried once
   * the cooldown is over — the key press still counts as the user's gesture then (transient
   * activation lasts ~5 s) — so Esc-close-menu-then-W resumes by itself a moment later.
   * `force` asks even when wantLock is off (a click on the view always means "let me look around").
   */
  tryLock(force = false): void {
    if ((!this.wantLock && !force) || this.locked) return;
    const req = this.canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
    // Chrome returns a promise that rejects when the lock is refused; that's routine, not an
    // uncaught error. Recent refusals are kept for tools/realinput.ts.
    req?.catch?.((e: unknown) => {
      this.lockRefusals.push(`${performance.now().toFixed(0)} ${String(e)}`);
      if (this.lockRefusals.length > 20) this.lockRefusals.shift();
      if (!/immediately after/.test(String(e)) || this.retryTimer) return;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = 0;
        // Still wanted: nothing opened meanwhile (a menu keeps its own lock state).
        if ((this.wantLock || force) && !this.locked && !this.captured) this.tryLock(force);
      }, 1300);
    });
  }
  /** Recent pointer-lock refusals ("<ms> <error>"), for debugging and tools/realinput.ts. */
  readonly lockRefusals: string[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | 0 = 0;
  /** Free the cursor for a menu (free-cursor mode); the unlock is not treated as Esc. */
  releaseForMenu(): void {
    if (!this.locked) return;
    this.expectUnlock = true;
    document.exitPointerLock();
  }
  get captured(): boolean {
    return this.captureStack.length > 0;
  }
  /** Handlers captured with timeFlows (ui2 windows: the sim runs unless game.tacticalPause). */
  private flowing = new WeakSet<KeyHandler>();
  /** The top capture lets game time keep running (a ui2 window, not a legacy menu). */
  get captureTimeFlows(): boolean {
    const top = this.captureStack[this.captureStack.length - 1];
    return !!top && this.flowing.has(top);
  }
  consumeMouse(): [number, number] {
    const r: [number, number] = [this.mouseDX, this.mouseDY];
    this.mouseDX = this.mouseDY = 0;
    return r;
  }
  consumeClicks(): number[] {
    const c = this.clicks;
    this.clicks = [];
    return c;
  }
}
