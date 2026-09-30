// Rooftop views (docs/PERF.md "Above ground"): stand on the roof of a 3+ storey building in
// town and look down at the street. The report that started it: "if you are many z levels up
// it renders the ground as an odd white thing" — only one level below the player was built,
// so the street was never drawn. Hosts its own Vite server and Chromium, like look-shots.ts.
//
//   ~/claude-stuff/bin/heavy --kind gpu --mem 2 -- nix-shell --run 'npx tsx tools/zlevel-shots.ts --gpu'
//
// Options:
//   --out <dir>       where shots go (default docs/screenshots/wave3/zlevels)
//   --tag <name>      file name prefix (default "after")
//   --size WxH        viewport (default 1720x652: half the user's 3440x1304)
//   --gpu             ANGLE/Vulkan instead of SwiftShader (run with heavy --kind gpu)
//   --look <id>       visual style (default voxel, the user's)
//   --radius <n>      draw radius in chunks (default 8 = 168 m, the user's)
//   --z <n>           roof level to stand on (default 3)
//   --params <q>      extra URL query
//   --bench <sec>     after the shots, look around for <sec> seconds and print the streaming /
//                     frame cost (cdda.perf.summary)
//   --check           fail (exit 1) unless the lower half of every shot shows a real street:
//                     not a flat, uniform sheet of colour
//   --print <expr>    log the JSON of <expr> after the view is set up
//   --hover           the rooftop's pale lines: put a railing at the roof edge, open the inventory
//                     (real keyboard), hover the railing with the mouse and check the ui2 outline
//                     hugs it (1 m, not a storey-high box rising past the eye), then close the
//                     inventory and check the outline is gone
//   --dry-run, --help
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const opt = (n: string, d: string) => {
  const i = argv.indexOf(n);
  if (i < 0) return d;
  const v = argv[i + 1];
  if (v === undefined) throw new Error(`${n} needs a value`);
  argv.splice(i, 2);
  return v;
};
const out = opt('--out', 'docs/screenshots/wave3/zlevels');
const tag = opt('--tag', 'after');
const size = opt('--size', '1720x652').split('x').map(Number);
const look = opt('--look', 'voxel');
const radius = Number(opt('--radius', '8'));
const roofZ = Number(opt('--z', '3'));
const params = opt('--params', '');
const bench = Number(opt('--bench', '0'));
const printJs = opt('--print', '');
const gpu = argv.includes('--gpu');
const check = argv.includes('--check');
const hover = argv.includes('--hover');
const dry = argv.includes('--dry-run');
for (const a of argv) if (!['--gpu', '--check', '--dry-run', '--hover'].includes(a)) throw new Error(`unknown argument ${a}`);
if (!Number.isInteger(radius) || radius < 2) throw new Error(`--radius ${radius}: expected an integer >= 2`);
if (!Number.isInteger(roofZ) || roofZ < 1) throw new Error(`--z ${roofZ}: expected an integer >= 1`);

// Each view: yaw/pitch from the roof edge. 'down' = the street below, 'out' = across town.
/** --check: a lower frame more uniform than this is the flat sheet (see flatShare) */
const FLAT_MAX = 0.4;

// Only the street views are pixel-checked: 'side' may be mostly the (real, uniform) roof.
const VIEWS: { name: string; dyaw: number; pitch: number; street: boolean }[] = [
  { name: 'down', dyaw: 0, pitch: -35, street: true },
  { name: 'out', dyaw: 0, pitch: -12, street: true },
  { name: 'side', dyaw: 70, pitch: -20, street: false },
];
if (dry) {
  for (const v of VIEWS) console.log(`would capture ${out}/${tag}_${v.name}.jpg at ${size.join('x')} (look ${look}, radius ${radius}, z ${roofZ}${gpu ? ', gpu' : ''})`);
  process.exit(0);
}

// In the page: the nearest town's tallest-enough building with a flat roof at `roofZ`, standing
// 1.5 tiles from its edge that faces the most open air (a street), facing out.
const SETUP = `async (roofZ) => {
  const c = window.cdda;
  c.godMode(true);
  c.setWeather('clear');
  c.setCameraMode('first');
  c.setHour(16.4);
  const hide = (root) => { for (const el of root.children) { if (el.tagName === 'CANVAS') continue; if (el.querySelector('canvas')) hide(el); else el.style.visibility = 'hidden'; } };
  hide(document.body);
  const s = c.startLocation();
  const towns = c.cities().filter((t) => t.size >= 4).sort((a, b) => Math.hypot(a.x - s.omx, a.y - s.omy) - Math.hypot(b.x - s.omx, b.y - s.omy));
  const m = c.game.map;
  const solid = (x, y, z) => { const t = m.terAt(x, y, z); return t && t.id !== 't_open_air' && t.id !== 't_null'; };
  for (const town of towns.slice(0, 3)) {
    const cands = [];
    for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) {
      const X = town.x + dx, Y = town.y + dy;
      const o = c.omtAt(X, Y, roofZ - 1);
      if (o && !/open_air|^$/.test(o.id)) cands.push([X, Y, Math.hypot(dx, dy)]);
    }
    cands.sort((a, b) => a[2] - b[2]);
    for (const [X, Y] of cands) {
      c.teleportOmt(X, Y, 0);
      c.settle();
      const x0 = X * 24, y0 = Y * 24;
      let best = null;
      for (let y = y0 + 2; y < y0 + 22; y++) for (let x = x0 + 2; x < x0 + 22; x++) {
        if (!solid(x, y, roofZ) || solid(x, y, roofZ + 1)) continue;
        if (m.terAt(x, y, roofZ).move_cost <= 0) continue;
        // an edge: open air (at the roof's level and down to the ground) 2 tiles away
        for (const [ex, ey, yaw] of [[0, -1, 0], [1, 0, 90], [0, 1, 180], [-1, 0, 270]]) {
          if (solid(x + ex * 2, y + ey * 2, roofZ) || solid(x + ex * 2, y + ey * 2, roofZ - 1)) continue;
          if (!solid(x - ex, y - ey, roofZ)) continue;
          let open = 0;
          for (let k = 2; k < 14; k++) if (!solid(x + ex * k, y + ey * k, 1)) open++;
          if (!best || open > best.open) best = { x, y, yaw, open, omt: c.omtAt(X, Y, 0).id };
        }
      }
      if (best && best.open >= 8) {
        c.teleport(best.x + 0.5, best.y + 0.5, roofZ);
        c.look(best.yaw, -20);
        c.settle();
        return best;
      }
    }
  }
  throw new Error('no ' + (roofZ) + '-level roof with a street view in the three nearest towns');
}`;

/**
 * The lower part of the frame (below the horizon when looking down): the share of it taken by
 * its single most common colour (4 bits per channel). The broken view was a flat sheet of haze
 * over most of it (share ~0.6-0.8); a drawn street is a mix of road, verges, walls and shadow.
 */
function flatShare(png: PNG): number {
  const bins = new Map<number, number>();
  let n = 0;
  for (let y = Math.floor(png.height * 0.55); y < png.height; y += 2)
    for (let x = 0; x < png.width; x += 2) {
      const i = (y * png.width + x) * 4;
      const k = (png.data[i] >> 4) * 256 + (png.data[i + 1] >> 4) * 16 + (png.data[i + 2] >> 4);
      bins.set(k, (bins.get(k) ?? 0) + 1);
      n++;
    }
  return Math.max(...bins.values()) / n;
}

const chrome = process.env.CHROME_PATH;
if (!chrome) throw new Error('CHROME_PATH not set: run inside nix-shell');
mkdirSync(out, { recursive: true });
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
await server.listen();
const port = (server.httpServer!.address() as { port: number }).port;
const gl = gpu
  ? ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu']
  : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', ...gl, `--window-size=${size[0]},${size[1]}`] });
let failed = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: size[0], height: size[1] });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[page error] ${m.text()}`); });
  page.on('pageerror', (e) => { failed++; console.log(`[page exception] ${(e as Error).stack ?? e}`); });
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/?seed=1&skipmenu=1&look=${look}&radius=${radius}${params ? '&' + params : ''}`, { waitUntil: 'load' });
  await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 180_000 });
  const err = await page.evaluate('window.cddaError');
  if (err) throw new Error(`game failed to boot:\n${err}`);
  const spot = (await page.evaluate(`(${SETUP})(${roofZ})`)) as { x: number; y: number; yaw: number; omt: string };
  console.log(`roof: ${JSON.stringify(spot)}`);
  for (const v of VIEWS) {
    await page.evaluate(`cdda.look(${spot.yaw + v.dyaw}, ${v.pitch}); cdda.renderer.flushChunks()`);
    await new Promise((r) => setTimeout(r, 1200));
    if (printJs) console.log(`  ${v.name}: ${JSON.stringify(await page.evaluate(`(async () => { const cdda = window.cdda; return (${printJs}); })()`))}`);
    const png = PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png' })));
    const file = resolve(`${out}/${tag}_${v.name}.jpg`);
    await page.screenshot({ path: file as `${string}.jpeg`, type: 'jpeg', quality: 85, clip: { x: 0, y: 0, width: size[0], height: size[1], scale: 0.5 } });
    const share = flatShare(png);
    const ok = !v.street || share < FLAT_MAX;
    console.log(`  ${v.name}: most common colour covers ${(share * 100).toFixed(0)}% of the lower frame ${v.street ? (ok ? 'ok' : 'FLAT') : '(not checked)'} -> ${file}`);
    if (check && !ok) failed++;
  }
  if (hover) {
    // the railing one tile ahead, at the roof edge; the camera pitched down at it
    const at = (await page.evaluate(`(() => {
      const c = window.cdda, p = c.game.player;
      const f = [[0, -1], [1, 0], [0, 1], [-1, 0]][Math.round(${spot.yaw} / 90) % 4];
      const x = Math.floor(p.x) + f[0], y = Math.floor(p.y) + f[1];
      c.game.map.setTer(x, y, p.z, 't_railing');
      c.look(${spot.yaw}, -45);
      c.renderer.flushChunks();
      return { x, y, z: p.z };
    })()`)) as { x: number; y: number; z: number };
    await new Promise((r) => setTimeout(r, 500));
    await page.mouse.click(size[0] / 2, size[1] / 2);
    await page.keyboard.press('i');
    await new Promise((r) => setTimeout(r, 800));
    const scr = (await page.evaluate(`(() => {
      const c = window.cdda, cam = c.renderer.camera;
      const v = cam.position.clone().set(${at.x} + 0.5, ${at.z} * 2.6 + 0.5, ${at.y} + 0.5).project(cam);
      const r = c.renderer.three.domElement.getBoundingClientRect();
      return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
    })()`)) as { x: number; y: number };
    // real motion (movementX != 0), after the 400 ms unlock grace
    for (let i = 0; i <= 10; i++) {
      await page.mouse.move(scr.x - 40 + i * 4, scr.y + (i % 2));
      await new Promise((r) => setTimeout(r, 60));
    }
    await new Promise((r) => setTimeout(r, 300));
    const boxState = `(() => { let b = null; window.cdda.renderer.scene.traverse((o) => { if (o.isLineSegments && o.renderOrder === 999) b = o; }); return b && { visible: b.visible, h: +b.scale.y.toFixed(2), x: b.position.x, z: b.position.z }; })()`;
    const on = (await page.evaluate(boxState)) as { visible: boolean; h: number } | null;
    const file = resolve(`${out}/${tag}_hover.jpg`);
    await page.screenshot({ path: file as `${string}.jpeg`, type: 'jpeg', quality: 85, clip: { x: 0, y: 0, width: size[0], height: size[1], scale: 0.5 } });
    await page.keyboard.press('i');
    await new Promise((r) => setTimeout(r, 500));
    const off = (await page.evaluate(boxState)) as { visible: boolean } | null;
    const okOn = !!on?.visible && on.h <= 1.05, okOff = !off?.visible;
    console.log(`  hover railing: outline ${JSON.stringify(on)} ${okOn ? 'ok' : 'WRONG'}; after closing: ${JSON.stringify(off)} ${okOff ? 'ok' : 'STILL SHOWN'} -> ${file}`);
    if (!okOn || !okOff) failed++;
  }
  if (bench > 0) {
    // the same look-around on the roof, then on the street below it (what the roof view should
    // cost: about what the street costs, since it shows about the same world)
    const [ex, ey] = [[0, -1], [1, 0], [0, 1], [-1, 0]][Math.round(spot.yaw / 90) % 4];
    for (const where of ['roof', 'street'] as const) {
      if (where === 'street') await page.evaluate(`cdda.teleport(${spot.x + ex * 4} + 0.5, ${spot.y + ey * 4} + 0.5, 0); cdda.renderer.flushChunks()`);
      await new Promise((r) => setTimeout(r, 1500));
      // what arriving costs to mesh: every wanted chunk rebuilt at once
      const rebuild = await page.evaluate(`(() => { const r = window.cdda.renderer; r.chunks.invalidateAll(); const t0 = performance.now(); r.flushChunks(); return Math.round(performance.now() - t0); })()`);
      await new Promise((r) => setTimeout(r, 1500));
      await page.evaluate('cdda.perf?.reset?.()');
      const t0 = Date.now();
      // a full turn pitched down at the street, then out over the town
      while (Date.now() - t0 < bench * 1000) {
        const f = (Date.now() - t0) / (bench * 1000);
        await page.evaluate(`cdda.look(${spot.yaw} + ${f} * 720, ${f < 0.5 ? (where === 'roof' ? -30 : -8) : -2})`);
        await new Promise((r) => setTimeout(r, 50));
      }
      const r = (await page.evaluate(`(() => { const s = cdda.perf.summary(); const st = cdda.renderStats(); const lv = {}; cdda.renderer.chunks.forEachEntry((e) => { lv[e.z] = (lv[e.z] ?? 0) + 1; }); return { interval: s.interval, loop: s.loop, draw: s.sections.draw, scene: s.sections.scene, entries: lv, calls: st.calls, triangles: st.triangles, geometries: st.geometries }; })()`)) as Record<string, unknown>;
      console.log(`bench ${tag} ${where}: full rebuild of every wanted chunk ${rebuild} ms; ${JSON.stringify(r)}`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}
if (failed) {
  console.log(`${failed} failure(s)`);
  process.exit(1);
}
