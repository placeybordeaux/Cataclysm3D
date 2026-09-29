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

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
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
  /** Push a modal handler; returns a release function. Releases pointer lock so menus get the mouse. */
  capture(h: KeyHandler): () => void {
    this.captureStack.push(h);
    this.held.clear();
    if (document.pointerLockElement) document.exitPointerLock();
    return () => {
      const i = this.captureStack.lastIndexOf(h);
      if (i >= 0) this.captureStack.splice(i, 1);
    };
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
