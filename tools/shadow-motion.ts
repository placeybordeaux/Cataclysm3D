// Shadow motion benchmark (docs/SHADOWS.md): for every shadow mode (src/render/shadows.ts)
// and scenario, renders frame sequences with fixed time steps and measures how much of the
// sun-shadow factor changes per frame *without* the camera moving (cdda.shadowMotion: each
// frame is drawn with the maps before and after their update, same camera, same wind). Also
// writes side-by-side animated GIFs of the modes, heat maps of where shadows changed on their
// own, and frame times. Hosts its own Vite server and GPU Chromium like tools/bench-stream.ts.
// Run inside nix-shell, on the GPU:
//
//   ~/claude-stuff/bin/heavy --kind gpu --mem 2 --name "cdda3d shadow-motion" -- npx tsx tools/shadow-motion.ts
//
// Options: --modes legacy,stable,cascades,smooth  --views street,forest  --scenarios still,time,walk,pan
//          --frames N (default 90)  --size WxH (default 3440x1304)  --look voxel  --port N (default 5170)
//          --out DIR (default docs/screenshots/wave3/shadows)  --no-gifs  --no-bench  --no-stills
//          --only-stills  --json  --dry-run  --help
//
// Stills: still-<view>.png (the four modes, 2x2, the low-res image at 2x) and
// mask-<view>.png (the same with only the sun-shadow factor: black = shadow).
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const opt = (n: string, d: string) => {
  const i = argv.indexOf(n);
  return i < 0 ? d : argv[i + 1];
};
const modes = opt('--modes', 'legacy,stable,cascades,smooth').split(',');
const views = opt('--views', 'street,forest').split(',');
const frames = Number(opt('--frames', '90'));
const size = opt('--size', '3440x1304').split('x').map(Number);
const lookName = opt('--look', 'voxel');
const port = Number(opt('--port', '5170'));
const outDir = resolve(opt('--out', 'docs/screenshots/wave3/shadows'));
const gifs = !argv.includes('--no-gifs');
const onlyStills = argv.includes('--only-stills');
const stills = !argv.includes('--no-stills');
const bench = !argv.includes('--no-bench') && !onlyStills;

// camera/time per scenario. still: nothing moves but the wind; time: the clock at normal play
// speed (a game day per real hour); walk: 3 m/s (a speed-100 walk) along the view with time
// running; pan: turning 40 deg/s with time running; sweep: the clock 20x, to show the sun
// steps in a short clip.
const SCEN: Record<string, { walk: number; pan: number; time: number; frames?: number }> = {
  still: { walk: 0, pan: 0, time: 0 },
  time: { walk: 0, pan: 0, time: 1 },
  walk: { walk: 3, pan: 0, time: 1 },
  pan: { walk: 0, pan: 40, time: 1 },
  sweep: { walk: 0, pan: 0, time: 20, frames: 150 },
};
const scenarios = opt('--scenarios', 'still,time,walk,pan').split(',');
for (const s of scenarios) if (!SCEN[s]) throw new Error(`unknown scenario ${s} (${Object.keys(SCEN).join(', ')})`);
// which clips become GIFs (view:scenario) and the crop (fractions of the low-res image)
const GIF_CLIPS: { view: string; scen: string; crop: [number, number, number, number] }[] = [
  { view: 'street', scen: 'time', crop: [0.3, 0.5, 0.3, 0.35] },
  { view: 'street', scen: 'walk', crop: [0.3, 0.5, 0.3, 0.35] },
  { view: 'forest', scen: 'time', crop: [0.3, 0.45, 0.3, 0.35] },
  { view: 'forest', scen: 'pan', crop: [0.35, 0.45, 0.3, 0.35] },
  { view: 'street', scen: 'sweep', crop: [0.3, 0.5, 0.3, 0.35] },
];

if (argv.includes('--dry-run')) {
  for (const v of views) for (const s of scenarios) console.log(`would measure ${modes.join('/')} in ${v}/${s}: ${frames} frames at ${size.join('x')} (${lookName})`);
  if (gifs) for (const g of GIF_CLIPS) console.log(`would write ${join(outDir, `${g.view}-${g.scen}.gif`)}`);
  process.exit(0);
}
const chrome = process.env.CHROME_PATH;
if (!chrome) throw new Error('CHROME_PATH not set: run inside nix-shell');
if (port === 5173) throw new Error('5173 is the user\'s own game tab: pick another --port');

const server = await createServer({ server: { port, strictPort: true, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({
  executablePath: chrome, headless: true, protocolTimeout: 900_000,
  args: ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', `--window-size=${size[0]},${size[1]}`],
});
type Stat = { mean: number; p95: number; max: number; framesChanged: number } | null;
type Res = { mode: string; swim: Stat; swimOfShadow: Stat; shadowed: Stat; total: Stat; flicker: Stat; mapRenders: number; png: string[]; maskPng: string[]; heatPng?: string };
const results: Record<string, Record<string, Record<string, Omit<Res, 'png' | 'maskPng' | 'heatPng'>>>> = {};
const perf: Record<string, Record<string, { msPerFrame: number; redrawMs: number }>> = {};
const tmp = join(tmpdir(), `shadow-motion-${process.pid}`);
mkdirSync(tmp, { recursive: true });
mkdirSync(outDir, { recursive: true });
// ImageMagick labels need a font file (a bare nix-shell has no default)
const FONT = (() => {
  try {
    return execFileSync('fc-match', ['-f', '%{file}', 'sans']).toString().trim();
  } catch {
    return '';
  }
})();
if (!FONT) console.log('fc-match found no font: montages will be unlabelled (order: ' + modes.join(', ') + ')');
const label = (files: string[]) => files.flatMap((f, i) => (FONT ? ['-label', modes[i], f] : [f]));
const fontArgs = () => (FONT ? ['-font', FONT] : []);
const savePng = (dataUrl: string, file: string) => writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
try {
  const page = await browser.newPage();
  await page.setViewport({ width: size[0], height: size[1] });
  page.on('pageerror', (e) => console.log(`[page exception] ${(e as Error).stack ?? e}`));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/?seed=1&skipmenu=1&look=${lookName}`, { waitUntil: 'load' });
  await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 180_000 });
  await page.evaluate(readFileSync(resolve('tools/look-views.js'), 'utf8'));
  for (const view of views) {
    results[view] = {};
    perf[view] = {};
    await page.evaluate(`lookView(${JSON.stringify(view)})`);
    await page.evaluate('window.cdda.settle()');
    await new Promise((r) => setTimeout(r, 2500));
    // freeze the live loop's clock/wind drift between runs: every run starts from here
    const hour = await page.evaluate('window.cdda.game.clock.seconds') as number;
    if (stills) {
      const shots: string[] = [], masks: string[] = [];
      for (const mode of modes) {
        const r = await page.evaluate(`(() => {
          const c = window.cdda;
          c.setShadows(${JSON.stringify(mode)});
          c.game.clock.seconds = ${hour};
          for (let i = 0; i < 90; i++) c.renderer.render(1 / 60);
          return c.shadowMotion({ frames: 1, time: 0, capture: true, captureMask: true });
        })()`) as Res;
        const f = join(tmp, `still-${view}-${mode}.png`), fm = join(tmp, `mask-${view}-${mode}.png`);
        savePng(r.png[0], f);
        savePng(r.maskPng[0], fm);
        shots.push(f);
        masks.push(fm);
      }
      for (const [name, files] of [['still', shots], ['mask', masks]] as const)
        execFileSync('magick', ['montage', ...fontArgs(), ...label(files), '-tile', '2x', '-geometry', '+4+4', '-pointsize', '18', '-filter', 'point', '-resize', '200%', join(outDir, `${name}-${view}.png`)]);
      console.log(`wrote still-${view}.png, mask-${view}.png`);
    }
    if (onlyStills) continue;
    for (const scen of [...scenarios, ...(gifs && GIF_CLIPS.some((g) => g.view === view && g.scen === 'sweep') ? ['sweep'] : [])]) {
      results[view][scen] = {};
      const clip = GIF_CLIPS.find((g) => g.view === view && g.scen === scen);
      const s = SCEN[scen];
      const heatShots: string[] = [];
      for (const mode of modes) {
        const r = await page.evaluate(`(() => {
          const c = window.cdda;
          c.setShadows(${JSON.stringify(mode)});
          c.game.clock.seconds = ${hour};
          c.renderer.render(0.016); c.renderer.render(0.016);
          // let a sun step (and its dissolve) finish before measuring
          for (let i = 0; i < 90; i++) c.renderer.render(1 / 60);
          return c.shadowMotion(${JSON.stringify({ frames: s.frames ?? frames, walk: s.walk, pan: s.pan, time: s.time, capture: gifs && !!clip, crop: clip?.crop, heat: true })});
        })()`) as Res;
        const { png, maskPng, heatPng, ...rest } = r;
        void maskPng;
        if (scen !== 'sweep') results[view][scen][mode] = rest;
        const f = (x: Stat) => (x ? `${x.mean.toFixed(3)}% (p95 ${x.p95.toFixed(3)}, frames ${x.framesChanged}%)` : '-');
        console.log(`${view}/${scen}/${mode}: swim ${f(r.swim)}  of-shadow ${f(r.swimOfShadow)}  total ${f(r.total)}  flicker ${f(r.flicker)}  renders ${r.mapRenders}`);
        if (png.length) {
          const d = join(tmp, `${view}-${scen}-${mode}`);
          mkdirSync(d, { recursive: true });
          png.forEach((u, i) => savePng(u, join(d, `${String(i).padStart(4, '0')}.png`)));
        }
        if (heatPng) {
          const hf = join(tmp, `heat-${view}-${scen}-${mode}.png`);
          savePng(heatPng, hf);
          heatShots.push(hf);
        }
      }
      // GIFs: the first 60 frames (1 s) of each clip at 30 fps; the sweep (20x time) at 20 fps
      if (clip && gifs) makeGif(view, scen, Math.min(s.frames ?? frames, scen === 'sweep' ? 150 : 60), scen === 'sweep' ? 3 : 2);
      if (heatShots.length && scen !== 'sweep') {
        // 2x2 heat maps: red = shadow changed while the camera was held
        execFileSync('magick', ['montage', ...fontArgs(), ...label(heatShots), '-tile', '2x', '-geometry', '+4+4', '-pointsize', '16', '+dither', '-colors', '48', join(outDir, `heat-${view}-${scen}.png`)]);
      }
    }
    if (bench) {
      for (const mode of modes) {
        perf[view][mode] = await page.evaluate(`(() => {
          const c = window.cdda;
          c.setShadows(${JSON.stringify(mode)});
          for (let i = 0; i < 30; i++) c.renderer.render(1 / 60);
          const b = c.benchRender(90);
          // a frame that redraws every map (a sun step, a teleport)
          const gl = c.renderer.three.getContext();
          const px = new Uint8Array(4);
          let t = 0;
          for (let i = 0; i < 10; i++) {
            c.renderer.lights.shadows.invalidate();
            const t0 = performance.now();
            c.renderer.render(1 / 60);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            t += performance.now() - t0;
          }
          return { msPerFrame: b.msPerFrame, redrawMs: +(t / 10).toFixed(1) };
        })()`) as { msPerFrame: number; redrawMs: number };
        console.log(`perf ${view}/${mode}: ${JSON.stringify(perf[view][mode])}`);
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
}
writeFileSync(join(outDir, 'metrics.json'), JSON.stringify({ size, look: lookName, frames, results, perf }, null, 1));
printTables();
rmSync(tmp, { recursive: true, force: true });

function makeGif(view: string, scen: string, n: number, every: number): void {
  // one frame = the four modes side by side (2x2), labelled; every `every`th frame, in real time
  const frameFiles: string[] = [];
  for (let i = 0; i < n; i += every) {
    const tiles = modes.map((m) => join(tmp, `${view}-${scen}-${m}`, `${String(i).padStart(4, '0')}.png`));
    const out = join(tmp, `m-${view}-${scen}-${String(i).padStart(4, '0')}.png`);
    execFileSync('magick', ['montage', ...fontArgs(), ...label(tiles), '-tile', '2x', '-geometry', '+2+2', '-pointsize', '14', '-background', '#202020', '-fill', '#e0e0e0', out]);
    frameFiles.push(out);
  }
  const gif = join(outDir, `${view}-${scen}.gif`);
  // nearest-neighbour 2x (the game's own upscale), a shared 96-colour palette keeps it small
  execFileSync('magick', ['-delay', String((100 * every) / 60), '-loop', '0', ...frameFiles, '-filter', 'point', '-resize', '200%', '+dither', '-colors', '64', '-layers', 'Optimize', gif]);
  console.log(`wrote ${gif}`);
}

function printTables(): void {
  if (argv.includes('--json')) console.log(JSON.stringify({ results, perf }, null, 1));
  const cell = (x: Stat) => (x ? `${x.mean.toFixed(3)} / ${x.framesChanged.toFixed(0)}%` : '-');
  console.log('\nShadow change with the camera held, % of pixels per frame (mean / frames with any change):\n');
  console.log(`| view | scenario | ${modes.join(' | ')} |`);
  console.log(`|---|---|${modes.map(() => '---').join('|')}|`);
  for (const v of Object.keys(results))
    for (const s of Object.keys(results[v])) console.log(`| ${v} | ${s} | ${modes.map((m) => cell(results[v][s][m]?.swim ?? null)).join(' | ')} |`);
  if (Object.keys(perf).length) {
    console.log(`\nFrame time at ${size.join('x')} (ms/frame, GPU-synchronised; redraw = a frame that redraws every map):\n`);
    console.log(`| view | ${modes.join(' | ')} |`);
    console.log(`|---|${modes.map(() => '---').join('|')}|`);
    for (const v of Object.keys(perf)) console.log(`| ${v} | ${modes.map((m) => (perf[v][m] ? `${perf[v][m].msPerFrame} (redraw ${perf[v][m].redrawMs})` : '-')).join(' | ')} |`);
  }
}
