import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Input } from '../src/core/input';

// Input against stand-in window/document/canvas (tests run in node): enough to dispatch key
// events and watch pointer-lock requests.
type Listener = (e: unknown) => void;
function fakeDom() {
  const on = () => {
    const map = new Map<string, Listener[]>();
    return {
      map,
      addEventListener: (t: string, f: Listener) => map.set(t, [...(map.get(t) ?? []), f]),
      removeEventListener: () => {},
      fire: (t: string, e: unknown) => (map.get(t) ?? []).forEach((f) => f(e)),
    };
  };
  const win = on(), doc = on(), cv = on();
  const requests: number[] = [];
  const canvas = {
    ...cv,
    // Chrome right after the player's Esc unlock: refused for ~1.25 s.
    requestPointerLock: () => {
      requests.push(performance.now());
      return Promise.reject(new Error('The user has exited the lock before this request was completed / cannot be acquired immediately after the user has exited the lock'));
    },
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', { ...doc, pointerLockElement: null, hasFocus: () => true, hidden: false });
  vi.stubGlobal('HTMLInputElement', class {});
  vi.stubGlobal('HTMLTextAreaElement', class {});
  const key = (k: string, code = k) => win.fire('keydown', { key: k, code, target: null, repeat: false, shiftKey: false, getModifierState: () => false, preventDefault: () => {} });
  const keyup = (code: string) => win.fire('keyup', { code });
  return { canvas: canvas as unknown as HTMLCanvasElement, requests, key, keyup };
}

describe('Input pointer-lock retry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a menu closed with Esc does not grab the mouse back by itself a moment later', async () => {
    const dom = fakeDom();
    const input = new Input(dom.canvas);
    input.wantLock = true;
    // A menu that closes on Esc and asks for the lock from inside that key (framework close()).
    const release = input.capture((e) => {
      if (e.key === 'Escape') {
        release();
        input.tryLock();
      }
      return true;
    });
    dom.key('Escape');
    await vi.advanceTimersByTimeAsync(3000);
    expect(dom.requests.length).toBe(1);
  });

  it('a refused key press (any other key) is retried once the cooldown is over', async () => {
    const dom = fakeDom();
    const input = new Input(dom.canvas);
    input.wantLock = true;
    dom.key('w', 'KeyW');
    await vi.advanceTimersByTimeAsync(1400);
    expect(dom.requests.length).toBe(2);
  });
});

describe('Input: the key that closes the last menu', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('is not seen as held by gameplay until released (Space would side-step)', () => {
    const dom = fakeDom();
    const input = new Input(dom.canvas);
    const release = input.capture((e) => {
      if (e.key === ' ') release();
      return true;
    });
    dom.key(' ', 'Space');
    expect(input.captured).toBe(false);
    expect(input.held.has('Space')).toBe(false);
    // Auto-repeat while still held: still not gameplay input.
    dom.key(' ', 'Space');
    expect(input.held.has('Space')).toBe(false);
    dom.keyup('Space');
    dom.key(' ', 'Space');
    expect(input.held.has('Space')).toBe(true);
  });
  it('a key closing one menu of two is not swallowed', () => {
    const dom = fakeDom();
    const input = new Input(dom.canvas);
    input.capture(() => true);
    const top = input.capture((e) => {
      if (e.key === ' ') top();
      return true;
    });
    dom.key(' ', 'Space');
    expect(input.captured).toBe(true);
    expect(input.held.has('Space')).toBe(true);
  });
});
