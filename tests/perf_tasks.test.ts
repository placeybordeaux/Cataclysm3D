import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTaskTiming, tasks } from '../src/perf/tasks';
import { summarize, type PerfDump } from '../src/perf/analyze';

// The page's other callbacks (src/perf/tasks.ts) and what the dump analysis makes of a long
// frame interval (src/perf/analyze.ts): the interval belongs to the previous frame's loop.

let now = 0;
beforeEach(() => {
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

/** Just enough of a window: timers and rAF queue callbacks we run by hand. */
function fakeWindow() {
  const queued: (() => void)[] = [];
  class ET {
    private ls = new Map<string, ((e: Event) => void)[]>();
    addEventListener(t: string, l: (e: Event) => void) {
      this.ls.set(t, [...(this.ls.get(t) ?? []), l]);
    }
    removeEventListener(t: string, l: (e: Event) => void) {
      this.ls.set(t, (this.ls.get(t) ?? []).filter((x) => x !== l));
    }
    fire(t: string) {
      for (const l of this.ls.get(t) ?? []) l({ type: t } as Event);
    }
  }
  const win = {
    EventTarget: ET,
    setTimeout: (f: () => void) => (queued.push(f), 1),
    setInterval: (f: () => void) => (queued.push(f), 2),
    requestAnimationFrame: (f: (t: number) => void) => (queued.push(() => f(now)), 3),
  };
  return { win: win as unknown as Window & typeof globalThis, queued, ET };
}

describe('task timing', () => {
  it('times other callbacks, names the slow ones, skips the main loop, and finds listeners again on remove', () => {
    const { win, queued, ET } = fakeWindow();
    installTaskTiming(win);
    expect(() => installTaskTiming(win)).toThrow(/already/);
    const main = () => void (now += 50);
    tasks.main = main;
    win.requestAnimationFrame(main);
    win.setInterval(function refreshHotbar() { now += 30; }, 500);
    win.setTimeout(() => void (now += 1), 0);
    for (const f of queued) f();
    // the main loop's 50 ms is frameStats' business, not a task
    expect(tasks.take()).toEqual({ ms: 31, n: 2 });
    expect(tasks.since(0).map((r) => [r.kind, r.src, r.ms])).toEqual([['interval', 'refreshHotbar', 30]]);

    const t = new ET();
    let calls = 0;
    const onMsg = () => void (calls++, now += 5);
    t.addEventListener('message', onMsg);
    t.fire('message');
    expect(tasks.since(0).at(-1)).toMatchObject({ kind: 'event', src: 'message: onMsg', ms: 5 });
    t.removeEventListener('message', onMsg);
    t.fire('message');
    expect(calls).toBe(1);
  });
});

describe('worst frames', () => {
  it('charge a long interval to the previous frame plus the time outside it', () => {
    // frame 1 runs a 100 ms loop; frame 2's interval (t1 -> t2) carries it, frame 3's is a
    // 120 ms gap with a short loop before it: time outside, of which 90 ms a slow callback
    const t = [0, 16, 120, 256];
    const d: PerfDump = {
      version: 1, meta: {}, events: [],
      frames: {
        t, interval: [null, 16, 104, 136], loop: [5, 100, 10, 5], wait: [1, 1, 1, 1],
        sim: [1, 90, 2, 1], draw: [3, 8, 6, 3], tasks: [0, 0, 0, 92],
      },
      tasks: [{ t: 200, ms: 90, kind: 'interval', src: 'refreshHotbar' }],
    };
    const s = summarize(d);
    const [a, b] = s.worstFrames;
    expect(a).toMatchObject({ interval: 136, loop: 10, outside: 125, tasks: 92 });
    expect(a.slow[0]).toMatch(/interval 90 ms refreshHotbar/);
    expect(b).toMatchObject({ interval: 104, loop: 100, split: { sim: 90, draw: 8 } });
    expect(s.outsideHitches).toEqual({ n: 1, ms: 125 });
    expect(s.slowTasks[0]).toMatchObject({ src: 'refreshHotbar', n: 1, max: 90 });
  });
});
