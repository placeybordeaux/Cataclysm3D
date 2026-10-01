import type { DebugApi } from '../debug';
import { installSkyLeak } from '../render/skyLeak';
import type { Game } from '../game/game';
import type { Renderer } from '../render/renderer';
import type { ChunkPrefetcher } from '../world/prefetch';
import { frameStats } from '../perfDebug';
import { look } from '../render/look';
import { registerOption, registeredOptions } from '../ui/options';
import { ModelFactory } from '../render/furniture/index';
import { SurfacePainter } from '../render/surfaces';
import { Dresser } from '../render/dressing';
import { RoomMap } from '../render/rooms';
import { Telemetry, type MeshKind } from './telemetry';
import { PerfOverlay } from './overlay';
import { ringToFrames, summarize, type PerfDump } from './analyze';
import { installPlaceholders } from '../render/placeholders';
import { installChunkBatch } from '../render/chunkBatch';

// Wires the telemetry (telemetry.ts) into the running game and gives the player and us ways
// to use it (docs/PERF.md):
//   F3              toggle the performance overlay (also Options > Performance overlay, ?perf=1)
//   Shift+F3        download the last 60 s as JSON (tools/perf-report.ts explains it)
//   cdda.perf.*     dump() / summary() / download() / show() / detail() / reset()
//   tsx tools/live.ts perf [out.json]   the same dump from the terminal (dev server)
// ?perf=off disables recording entirely (nothing sampled, no hooks installed beyond the probe).

const OVERLAY_KEY = 'cdda3d.perfOverlay';

export interface PerfApi {
  tel: Telemetry;
  show(on?: boolean): boolean;
  detail(on?: boolean): boolean;
  /** GPU timer queries without the overlay (false where the extension is missing, e.g. Firefox) */
  gpu(on?: boolean): boolean;
  dump(seconds?: number): PerfDump;
  summary(seconds?: number): ReturnType<typeof summarize>;
  download(seconds?: number): string;
  reset(): void;
}

export function installPerf(game: Game, renderer: Renderer, api: DebugApi, prefetch?: ChunkPrefetcher): PerfApi {
  const params = new URLSearchParams(location.search);
  const chunks = renderer.chunks;
  const three = renderer.three;
  const glInfo = { calls: 0, triangles: 0, geometries: 0, textures: 0, programs: 0 };
  const tel = new Telemetry({
    player: () => game.player,
    view: () => {
      const cam = renderer.rig.camera;
      const hfov = 2 * Math.atan(Math.tan(((cam.fov * Math.PI) / 180) / 2) * cam.aspect);
      return { fx: chunks.forward.x, fy: chunks.forward.y, hfov };
    },
    chunks,
    fogFar: () => renderer.pipeline.options.fogFar,
    prefetch,
    gl: glInfo,
  });
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  if (mem) tel.heapMB = () => mem.usedJSHeapSize / 1048576;
  if (params.get('perf') === 'off') tel.recording = false;
  chunks.probe = tel;

  // ---- mapgen timing: exclusive time per generated chunk (upper levels generate the one
  //      below first, nested inside), and the onChunkGenerated hooks (spawns, tracking).
  const map = game.map;
  const gen = map.generator;
  if (gen) {
    const orig = gen.generate.bind(gen);
    const stack: number[] = [];
    gen.generate = (m, c) => {
      const t0 = performance.now();
      stack.push(0);
      try {
        orig(m, c);
      } finally {
        const tot = performance.now() - t0;
        const child = stack.pop()!;
        if (stack.length) stack[stack.length - 1] += tot;
        tel.generated(c.cx, c.cy, c.z, tot - child, !!prefetch?.inPrefetch, c.omt?.id);
      }
    };
  }
  let hookT = 0;
  map.onChunkGenerated.unshift(() => void (hookT = performance.now()));
  map.onChunkGenerated.push(() => tel.hooks(performance.now() - hookT));
  map.onChunkEvicted.push((c) => tel.event({ t: performance.now() - tel.t0, k: 'evict', cx: c.cx, cy: c.cy, z: c.z }));

  // ---- per-kind mesher timing (detail): wrap the prototypes of the mesher's helpers
  let unpatch: (() => void) | null = null;
  const patchKinds = (): (() => void) => {
    const undo: (() => void)[] = [];
    const stack: number[] = [];
    const wrap = (proto: Record<string, unknown>, kind: MeshKind) => {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const d = Object.getOwnPropertyDescriptor(proto, name)!;
        const fn = d.value as ((...a: unknown[]) => unknown) | undefined;
        // generators return at once (their work happens on next()): timing the call means nothing
        if (typeof fn !== 'function' || fn.constructor.name === 'GeneratorFunction') continue;
        proto[name] = function (this: unknown, ...args: unknown[]) {
          const t0 = performance.now();
          stack.push(0);
          try {
            return fn.apply(this, args);
          } finally {
            const tot = performance.now() - t0;
            const child = stack.pop()!;
            if (stack.length) stack[stack.length - 1] += tot;
            tel.kind(kind, tot - child);
          }
        };
        undo.push(() => void (proto[name] = fn));
      }
    };
    wrap(ModelFactory.prototype as unknown as Record<string, unknown>, 'kModels');
    wrap(SurfacePainter.prototype as unknown as Record<string, unknown>, 'kSurfaces');
    wrap(Dresser.prototype as unknown as Record<string, unknown>, 'kDressing');
    wrap(RoomMap.prototype as unknown as Record<string, unknown>, 'kRooms');
    return () => undo.forEach((f) => f());
  };
  const setDetail = (on: boolean) => {
    if (on && !unpatch) unpatch = patchKinds();
    else if (!on && unpatch) {
      unpatch();
      unpatch = null;
    }
    tel.detail = on;
    return on;
  };

  // ---- GPU time per frame (EXT_disjoint_timer_query_webgl2: Chromium; Firefox hides it by
  //      default). Only while the overlay shows; results arrive a few frames late.
  const gl = three.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  const inflight: WebGLQuery[] = [];
  let gpuOn = false;
  if (ext) {
    const pipe = renderer.pipeline;
    const origRender = pipe.render.bind(pipe);
    let inside = false;
    pipe.render = ((...args: Parameters<typeof pipe.render>) => {
      if (!gpuOn || inside || inflight.length > 4) return origRender(...args);
      const q = gl.createQuery()!;
      inside = true;
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      try {
        return origRender(...args);
      } finally {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        inside = false;
        inflight.push(q);
      }
    }) as typeof pipe.render;
  }
  const pollGpu = () => {
    while (inflight.length) {
      const q = inflight[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      inflight.shift();
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      if (!gl.getParameter(ext!.GPU_DISJOINT_EXT)) tel.gpuMs = ns / 1e6;
      gl.deleteQuery(q);
    }
  };

  // ---- overlay
  const hint = () => `${game.keys.label('perf_overlay')} hide · Shift+${game.keys.label('perf_overlay')} save last 60 s${lastDump ? `  (saved ${lastDump})` : ''}`;
  let lastDump = '';
  const overlay = new PerfOverlay(tel, hint, () => [`stand-ins ${placeholders.enabled ? placeholders.stats.shown : 'off'}   batches ${batcher.enabled ? `${batcher.stats.batches} (${batcher.stats.hidden} meshes -> ${batcher.stats.merged})` : 'off'}   schedule ${chunks.schedule}   prefetch ${prefetch ? `${prefetch.stats.prefetched} idle / ${prefetch.stats.sync} in frame` : 'off'}`]);
  const show = (on: boolean) => {
    overlay.show(on);
    setDetail(on);
    gpuOn = on && !!ext;
    return on;
  };

  frameStats.sink = (workMs, now, loopMs, sec) => {
    const info = three.info;
    glInfo.calls = info.render.calls;
    glInfo.triangles = info.render.triangles;
    glInfo.geometries = info.memory.geometries;
    glInfo.textures = info.memory.textures;
    glInfo.programs = info.programs?.length ?? 0;
    if (inflight.length) pollGpu();
    tel.sample(workMs, now, loopMs, sec);
    overlay.update(now);
  };

  // ---- dump
  const meta = (): Record<string, unknown> => {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const canvas = three.domElement;
    return {
      date: new Date().toISOString(),
      url: location.href,
      userAgent: navigator.userAgent,
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      cores: navigator.hardwareConcurrency,
      window: `${innerWidth}x${innerHeight}`,
      dpr: devicePixelRatio,
      canvas: `${canvas.width}x${canvas.height}`,
      lowres: `${renderer.pipeline.lowW}x${renderer.pipeline.lowH}`,
      seed: game.map.seed,
      look: look.name,
      radius: chunks.radius,
      lodRadius: chunks.lodRadius,
      midRadius: chunks.midRadius,
      levels: [chunks.levelsBelow, chunks.levelsAbove],
      budgetMs: chunks.budgetMs,
      urgentBudgetMs: chunks.urgentBudgetMs,
      prefetch: prefetch ? { ...prefetch.opts, enabled: prefetch.enabled } : null,
      detail: tel.detail,
      gpuTimer: !!ext,
      options: Object.fromEntries(registeredOptions().map((o) => {
        try {
          return [o.name, o.value()];
        } catch (e) {
          return [o.name, `error: ${String(e)}`];
        }
      })),
      eventsDropped: Math.max(0, tel.evN - tel.events.length),
    };
  };
  const dump = (seconds = 60): PerfDump => {
    const frames = ringToFrames(tel.ring, seconds);
    const t0 = frames.t[0] ?? 0;
    return { version: 1, meta: meta(), frames, events: tel.eventList().filter((e) => e.t >= t0) };
  };
  const download = (seconds = 60): string => {
    const d = dump(seconds);
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const name = `cdda3d-perf-${stamp}.json`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(d)], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    lastDump = name;
    const s = summarize(d);
    game.message(`Performance log saved: ${name} (${s.seconds} s, ${s.findings[0]})`);
    return name;
  };

  // ---- controls
  game.keys.register('perf_overlay', 'Performance overlay (Shift: save the last 60 s)', () => {
    if (game.input.held.has('ShiftLeft') || game.input.held.has('ShiftRight')) {
      download();
      return;
    }
    const on = show(!overlay.visible);
    try {
      localStorage.setItem(OVERLAY_KEY, on ? '1' : '0');
    } catch {
      // storage blocked: not persisted
    }
  });
  registerOption({
    name: 'Performance overlay',
    value: () => (overlay.visible ? 'on' : 'off'),
    change: () => {
      const on = show(!overlay.visible);
      try {
        localStorage.setItem(OVERLAY_KEY, on ? '1' : '0');
      } catch {
        // storage blocked
      }
    },
    desc: `Frame time, where it goes, and how far ahead the world is built (${game.keys.label('perf_overlay')} in game). Shift+${game.keys.label('perf_overlay')} saves the last 60 seconds to a file you can send with a bug report.`,
  });
  let initial = params.get('perf') === '1';
  try {
    if (!params.has('perf')) initial = localStorage.getItem(OVERLAY_KEY) === '1';
  } catch {
    // storage blocked
  }
  if (initial) show(true);

  // ---- stand-ins for unbuilt chunks (render/placeholders.ts)
  const placeholders = installPlaceholders(renderer, () => game.player, api as unknown as Record<string, unknown>);

  // ---- far chunks merged per block: fewer draw calls (render/chunkBatch.ts)
  const batcher = installChunkBatch(renderer, () => game.player, api as unknown as Record<string, unknown>);

  // ---- streaming schedule (chunkManager.ts): 'need' (default) or 'distance' (wave 3), for A/B
  const sched = params.get('stream');
  if (sched) {
    if (sched !== 'need' && sched !== 'distance') throw new Error(`?stream=${sched}: expected need or distance`);
    chunks.schedule = sched;
  }
  api.streamSchedule = (mode?: 'need' | 'distance') => {
    if (mode !== undefined && mode !== 'need' && mode !== 'distance') throw new Error(`streamSchedule: 'need' or 'distance', not ${String(mode)}`);
    if (mode) chunks.schedule = mode;
    return chunks.schedule;
  };

  // ---- sky-leak probe (render/skyLeak.ts): tools/skyleak.ts asserts nothing the map has is missing
  installSkyLeak(game, renderer, api as unknown as Record<string, unknown>);

  // ---- which levels exist (src/world/levels.ts): 'world' (default, per-column extent) or 'window'
  const lvq = params.get('levels');
  if (lvq) {
    if (lvq !== 'world' && lvq !== 'window') throw new Error(`?levels=${lvq}: expected world or window`);
    chunks.levels.policy.mode = lvq;
  }
  api.drawLevels = (mode?: 'world' | 'window') => {
    if (mode !== undefined && mode !== 'world' && mode !== 'window') throw new Error(`drawLevels: 'world' or 'window', not ${String(mode)}`);
    if (mode) chunks.levels.policy.mode = mode;
    return chunks.levels.policy.mode;
  };

  const perf: PerfApi = {
    tel,
    show: (on = !overlay.visible) => show(on),
    detail: (on = !tel.detail) => setDetail(on),
    gpu: (on = !gpuOn) => (gpuOn = on && !!ext),
    dump,
    summary: (seconds = 60) => summarize(dump(seconds)),
    download,
    reset: () => tel.reset(),
  };
  api.perf = perf;
  return perf;
}
