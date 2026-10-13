// Times the page's *other* callbacks (timers, other requestAnimationFrame loops, idle callbacks,
// event listeners) so a stall between two frames can be told apart from our main loop's work.
//
// Why: the user's Firefox trace (2026-10-13) had 120-300 ms frame intervals of which our loop
// was a fraction; the rest happened between frames, where the telemetry saw nothing. A setInterval
// that refreshes a big DOM panel, a route-trail rAF loop forcing layout, or a worker message
// handler all land there, and so do GC and the browser's own layout/paint/GPU waits. With these
// callbacks timed, what is left over is the browser's (GC, layout, presentation).
//
// Installed at module evaluation (main.ts imports this first) so timers registered by any later
// install are wrapped. `?perf=off` leaves every API untouched. Cost: two performance.now() per
// callback; a callback's source text is only read when it was slow.

export type TaskKind = 'timeout' | 'interval' | 'raf' | 'idle' | 'event';

export interface TaskRecord {
  /** performance.now() at the end of the callback */
  t: number;
  ms: number;
  kind: TaskKind;
  /** function name, or the start of its source text for anonymous callbacks; events: `type:` prefix */
  src: string;
}

/** Callbacks at least this long are kept with their source (ms). */
export const SLOW_TASK_MS = 4;
const CAP = 4000;

export const tasks = {
  installed: false,
  /** ms spent in wrapped callbacks since the last take() (all of them, slow or not) */
  busyMs: 0,
  count: 0,
  /** slow callbacks, oldest first, capped (ring) */
  slow: [] as TaskRecord[],
  slowN: 0,
  /** the main loop's rAF callback: not a task (frameStats times it) */
  main: null as FrameRequestCallback | null,
  /** Per-frame totals since the previous call (telemetry samples once per frame). */
  take(): { ms: number; n: number } {
    const r = { ms: this.busyMs, n: this.count };
    this.busyMs = 0;
    this.count = 0;
    return r;
  },
  /** Slow callbacks recorded at or after `t0` (performance.now() time), oldest first. */
  since(t0: number): TaskRecord[] {
    const out: TaskRecord[] = [];
    const n = this.slow.length;
    const start = this.slowN > CAP ? this.slowN % CAP : 0;
    for (let i = 0; i < n; i++) {
      const r = this.slow[(start + i) % n];
      if (r.t >= t0) out.push(r);
    }
    return out;
  },
};

function describe(fn: unknown): string {
  if (typeof fn !== 'function') return String(fn);
  if (fn.name && fn.name !== 'bound ') return fn.name;
  try {
    return Function.prototype.toString.call(fn).replace(/\s+/g, ' ').slice(0, 90);
  } catch {
    return '(anonymous)';
  }
}

function record(t0: number, kind: TaskKind, fn: unknown, prefix = ''): void {
  const t = performance.now();
  const ms = t - t0;
  tasks.busyMs += ms;
  tasks.count++;
  if (ms < SLOW_TASK_MS) return;
  const r: TaskRecord = { t, ms: Math.round(ms * 10) / 10, kind, src: prefix + describe(fn) };
  if (tasks.slow.length < CAP) tasks.slow.push(r);
  else tasks.slow[tasks.slowN % CAP] = r;
  tasks.slowN++;
}

/** Patch the global scheduling APIs once. Throws if called twice (a double wrap would double count). */
export function installTaskTiming(win: Window & typeof globalThis = window): void {
  if (tasks.installed) throw new Error('installTaskTiming: already installed');
  tasks.installed = true;
  const wrapTimer = (name: 'setTimeout' | 'setInterval', kind: TaskKind) => {
    const orig = win[name].bind(win) as (h: TimerHandler, ms?: number, ...a: unknown[]) => number;
    (win as unknown as Record<string, unknown>)[name] = (h: TimerHandler, ms?: number, ...a: unknown[]) => {
      if (typeof h !== 'function') return orig(h, ms, ...a);
      return orig(function (this: unknown, ...args: unknown[]) {
        const t0 = performance.now();
        try {
          return (h as (...x: unknown[]) => unknown).apply(this, args);
        } finally {
          record(t0, kind, h);
        }
      }, ms, ...a);
    };
  };
  wrapTimer('setTimeout', 'timeout');
  wrapTimer('setInterval', 'interval');
  const raf = win.requestAnimationFrame.bind(win);
  win.requestAnimationFrame = (cb: FrameRequestCallback) => {
    if (cb === tasks.main) return raf(cb);
    return raf((now) => {
      const t0 = performance.now();
      try {
        cb(now);
      } finally {
        record(t0, 'raf', cb);
      }
    });
  };
  if (typeof win.requestIdleCallback === 'function') {
    const ric = win.requestIdleCallback.bind(win);
    win.requestIdleCallback = (cb: IdleRequestCallback, opts?: IdleRequestOptions) =>
      ric((d) => {
        const t0 = performance.now();
        try {
          cb(d);
        } finally {
          record(t0, 'idle', cb);
        }
      }, opts);
  }
  // Event listeners: one wrapper per listener function (the same function may be added for several
  // types or targets), so removeEventListener finds it again. Listener objects stay unwrapped.
  const proto = win.EventTarget.prototype;
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  const wrapped = new WeakMap<EventListener, EventListener>();
  proto.addEventListener = function (this: EventTarget, type: string, l: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) {
    if (typeof l !== 'function') return add.call(this, type, l, o);
    let w = wrapped.get(l);
    if (!w) {
      const fn = l;
      w = function (this: unknown, e: Event) {
        const t0 = performance.now();
        try {
          return fn.call(this, e);
        } finally {
          record(t0, 'event', fn, `${e.type}: `);
        }
      };
      wrapped.set(l, w);
    }
    return add.call(this, type, w, o);
  };
  proto.removeEventListener = function (this: EventTarget, type: string, l: EventListenerOrEventListenerObject | null, o?: boolean | EventListenerOptions) {
    return remove.call(this, type, (typeof l === 'function' && wrapped.get(l)) || l, o);
  };
}

// Module side effect, on purpose: everything imported after this module schedules through the
// wrappers. Not in Node (tests) and not with ?perf=off.
if (typeof window !== 'undefined' && typeof location !== 'undefined' && new URLSearchParams(location.search).get('perf') !== 'off') installTaskTiming();
