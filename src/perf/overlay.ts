import type { Telemetry } from './telemetry';

// The F3 performance overlay: a frame-time graph (stacked by where the time went, with the
// streaming state underneath) and a few lines of numbers. Drawn from the telemetry ring, so
// what you see is exactly what a Shift+F3 dump will contain. Text refreshes at 4 Hz (reading
// numbers that change every frame is impossible anyway); the graph every frame.

const W = 360, H = 96;
// stacked bar colours, bottom to top
const STACK: [string, string, (t: Telemetry, i: number) => number][] = [
  ['sim', '#6fa8dc', (t, i) => t.ring.cols.sim[i]],
  // mapgen inside the frame (whoever asked for the chunk); the chunk manager's remainder is meshing
  ['mapgen', '#e06666', (t, i) => t.ring.cols.genSync[i]],
  ['mesh', '#f6b26b', (t, i) => Math.max(0, t.ring.cols.chunkCreate[i] + t.ring.cols.chunkBuild[i] + t.ring.cols.chunkSig[i] - t.ring.cols.genSync[i])],
  ['grass/sky', '#93c47d', (t, i) => t.ring.cols.grass[i] + t.ring.cols.skyline[i] + t.ring.cols.decor[i]],
  ['light', '#ffd966', (t, i) => t.ring.cols.lightmap[i]],
  ['draw', '#b4a7d6', (t, i) => t.ring.cols.draw[i]],
  ['other', '#999999', (t, i) => t.ring.cols.other[i] + t.ring.cols.scene[i] + t.ring.cols.sprites[i] + t.ring.cols.beforeRender[i]],
];

export class PerfOverlay {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private text: HTMLPreElement;
  private textT = 0;
  visible = false;

  constructor(private tel: Telemetry, private hint: () => string, private extra: () => string[] = () => []) {
    const el = (this.el = document.createElement('div'));
    el.id = 'perf-overlay';
    Object.assign(el.style, {
      position: 'fixed', left: '8px', top: '8px', zIndex: '9999', pointerEvents: 'none', display: 'none',
      background: 'rgba(8,10,14,0.78)', color: '#ddd', font: '11px/1.35 monospace', padding: '6px 8px',
      borderRadius: '4px', whiteSpace: 'pre',
    } satisfies Partial<CSSStyleDeclaration>);
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.canvas.style.display = 'block';
    this.ctx = this.canvas.getContext('2d')!;
    this.text = document.createElement('pre');
    this.text.style.margin = '4px 0 0';
    this.text.style.font = 'inherit';
    const legend = document.createElement('div');
    legend.innerHTML = STACK.map(([n, c]) => `<span style="color:${c}">■</span>${n}`).join(' ') + ' <span style="color:#f44">▮</span>hole in view';
    el.append(this.canvas, legend, this.text);
    document.body.appendChild(el);
  }

  show(on: boolean): void {
    this.visible = on;
    this.el.style.display = on ? 'block' : 'none';
    this.textT = 0;
  }

  /** Once per frame, after telemetry sampled it. */
  update(now: number): void {
    if (!this.visible) return;
    this.drawGraph();
    if (now - this.textT > 250) {
      this.textT = now;
      this.text.textContent = this.lines().join('\n');
    }
  }

  private drawGraph(): void {
    const { ctx, tel } = this;
    const r = tel.ring;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, W, H);
    // 50 ms full scale; guides at 16.7 and 33.3 ms
    const y = (ms: number) => H - 12 - Math.min(1, ms / 50) * (H - 14);
    const n = Math.min(r.size, W);
    for (let k = 0; k < n; k++) {
      const i = r.back(k);
      const x = W - 1 - k;
      let acc = 0;
      for (const [, color, f] of STACK) {
        const v = f(tel, i);
        if (!(v > 0)) continue;
        ctx.fillStyle = color;
        ctx.fillRect(x, y(acc + v), 1, y(acc) - y(acc + v));
        acc += v;
      }
      // the frame interval (what the player feels) as a dot over the work stack
      const iv = r.cols.interval[i];
      if (iv > 0) {
        ctx.fillStyle = iv > 33.4 ? '#ff4040' : iv > 20 ? '#ffb040' : '#ffffff';
        ctx.fillRect(x, y(iv), 1, 1.5);
      }
      // streaming strip: red = unbuilt chunk in clear view, orange = in the fog, grey = building
      const hv = r.cols.holesVis[i], hf = r.cols.holesFog[i];
      ctx.fillStyle = hv > 0 ? '#ff3030' : hf > 0 ? '#c07020' : r.cols.building[i] > 0 ? '#555' : '#1d2a1d';
      ctx.fillRect(x, H - 8, 1, 8);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    for (const ms of [16.7, 33.3]) {
      ctx.beginPath();
      ctx.moveTo(0, y(ms) + 0.5);
      ctx.lineTo(W, y(ms) + 0.5);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('16.7', 2, y(16.7) - 2);
    ctx.fillText('33', 2, y(33.3) - 2);
  }

  /** Mean / p99 / max over the last `sec` seconds of a channel. */
  private stat(ch: keyof Telemetry['ring']['cols'], sec: number): { mean: number; p50: number; p99: number; max: number; last: number } {
    const r = this.tel.ring;
    const tEnd = r.t[r.back(0)];
    const xs: number[] = [];
    for (let k = 0; k < r.size; k++) {
      const i = r.back(k);
      if (r.t[i] < tEnd - sec * 1000) break;
      const v = r.cols[ch][i];
      if (Number.isFinite(v)) xs.push(v);
    }
    if (!xs.length) return { mean: NaN, p50: NaN, p99: NaN, max: NaN, last: NaN };
    const last = xs[0];
    xs.sort((a, b) => a - b);
    return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, p50: xs[Math.floor(xs.length / 2)], p99: xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.99))], max: xs[xs.length - 1], last };
  }

  private lines(): string[] {
    const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
    const S = (c: Parameters<PerfOverlay['stat']>[0]) => this.stat(c, 5);
    const iv = S('interval'), loop = S('loop');
    const m = (c: Parameters<PerfOverlay['stat']>[0]) => f(S(c).mean, 2);
    const gen = S('genSync'), genPre = S('genPre'), genN = S('genSyncN'), genPreN = S('genPreN');
    const r = this.tel.ring.cols, i = this.tel.ring.back(0);
    const kinds = Number.isFinite(r.kModels[i])
      ? `mesh kinds   models ${m('kModels')} surfaces ${m('kSurfaces')} dressing ${m('kDressing')} rooms ${m('kRooms')} (ms/frame, 5 s)`
      : '';
    const hz = 1000 / Math.max(1, iv.p50);
    const runway = r.speed[i] > 1.5 ? `${f(r.runwayS[i])} s (${f(r.runwayM[i], 0)} m ahead at ${f(r.speed[i])} m/s = ${f(r.speed[i] * 2.237, 0)} mph)` : 'standing';
    const gpu = S('gpu');
    const out = [
      `frame  p50 ${f(iv.p50)}  p99 ${f(iv.p99)}  worst ${f(iv.max)} ms  (${f(hz, 0)} fps)   loop p50 ${f(loop.p50)} p99 ${f(loop.p99)}   gpu ${f(gpu.mean, 2)} ms`,
      `cpu ms/frame  sim ${m('sim')}  mapgen ${m('chunkCreate')}  mesh ${m('chunkBuild')} (data ${m('mesh')} trees ${m('trees')})  grass ${m('grass')}  sky ${m('skyline')}  light ${m('lightmap')}  draw ${m('draw')}`,
      ...(kinds ? [kinds] : []),
      `mapgen  in-frame ${f(genN.mean * hz, 1)}/s ${f(gen.mean * hz, 0)} ms/s  idle ${f(genPreN.mean * hz, 1)}/s ${f(genPre.mean * hz, 0)} ms/s  backlog ${f(r.prefetchQ[i], 0)}`,
      `stream  wanted ${f(r.wanted[i], 0)}  built ${f(r.built[i], 0)}  queue ${f(r.pending[i], 0)}  building ${f(r.building[i], 0)}  oldest ${f(r.oldestMs[i] / 1000)} s  budget ${f(r.budget[i])} ms`,
      `holes   in view ${f(r.holesVis[i], 0)}  in fog ${f(r.holesFog[i], 0)}  anywhere ${f(r.holesAll[i], 0)}   runway ${runway}`,
      `gpu     calls ${f(r.calls[i], 0)}  tris ${f(r.triangles[i] / 1e6, 2)}M  geometries ${f(r.geometries[i], 0)}  textures ${f(r.textures[i], 0)}  heap ${f(r.heapMB[i], 0)} MB`,
      ...this.extra(),
      this.hint(),
    ];
    return out;
  }
}
