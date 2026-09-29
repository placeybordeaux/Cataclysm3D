// Keyboard/mouse state. Gameplay reads held keys each tick; UI menus subscribe to
// discrete key presses. When a menu is open it captures keys (see Input.capture) so
// e.g. pressing "e" inside the inventory doesn't also trigger "examine".

export type KeyHandler = (e: KeyboardEvent) => boolean | void;

export class Input {
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
  /** Real-time of the last Escape keydown we handled (see pointer-lock loss handling). */
  lastEscape = -1;
  /** Increments on every keydown; lets a window know whether its opening key was the last one pressed. */
  keySeq = 0;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      this.keySeq++;
      if (e.key === 'Escape') this.lastEscape = performance.now();
      const top = this.captureStack[this.captureStack.length - 1];
      if (top) {
        if (top(e) !== false) e.preventDefault();
        return;
      }
      this.held.add(e.code);
      for (const h of this.pressHandlers) if (h(e) === true) { e.preventDefault(); break; }
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    window.addEventListener('blur', () => this.held.clear());
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.canvas) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    canvas.addEventListener('mousedown', (e) => {
      if (this.captureStack.length) return;
      if (document.pointerLockElement !== canvas) {
        // Chrome returns a promise that rejects when the lock is refused (clicked again too
        // soon after Esc, document not focused); that's routine, not an uncaught error.
        const req = canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
        req?.catch?.(() => {});
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
   * Push a modal handler; returns a release function. Pointer lock is deliberately kept:
   * menus are keyboard-driven (CDDA style), and releasing the lock would force a click to
   * get back into mouse-look after every menu.
   */
  capture(h: KeyHandler): () => void {
    this.captureStack.push(h);
    this.held.clear();
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
   * not immediately after the browser's own Esc unlock; failures are expected and silent —
   * the "click to resume" overlay covers them.
   */
  tryLock(): void {
    if (!this.wantLock || this.locked) return;
    const req = this.canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
    req?.catch?.(() => {});
  }
  get captured(): boolean {
    return this.captureStack.length > 0;
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
