// Repro for the pitch hang: set cdda.game.player.pitch to a range of values (debug API) and move the
// real mouse to the pitch limits, in each camera mode, watching the JS heap. A value that hangs the
// page shows as a timed-out evaluate.
//   nix-shell --run '~/claude-stuff/bin/heavy --mem 3 --name pitch-repro -- npx tsx tools/dev/pitch-repro.ts [--headless]'
import { createServer } from 'vite';
import type { Page } from 'puppeteer-core';
import { launchBrowser, startXvfb, XInput, settleWorld, fitWindow } from '../lib/realinput';

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('usage: tsx tools/dev/pitch-repro.ts [--values a,b,...] [--modes first,third,top] [--drive] [--station]');
  process.exit(0);
}
const opt = (n: string, d: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const W = 960, H = 540;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const values = opt('--values', '0,-0.5,-1.5,1.5,-1.5707963,1.5707963,-1.6,2,-3.2,-60,60,1e9,NaN,Infinity,-Infinity').split(',');
const modes = opt('--modes', 'first,third,top').split(',');

await startXvfb(W + 40, H + 200);
const vite = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
await vite.listen();
const port = (vite.httpServer!.address() as { port: number }).port;
const browser = await launchBrowser('chromium', W, H);
const page: Page = (await browser.pages())[0] ?? (await browser.newPage());
const x = new XInput(page);
page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 300)));
page.on('error', (e) => console.log('page crashed', String(e)));
const cdp = await page.createCDPSession();
if (argv.includes('--early')) await cdp.send('Debugger.enable');

// On a hang: pause the busy main thread through the debugger and print where it is.
async function stack(): Promise<void> {
  const paused = new Promise<any>((res) => cdp.once('Debugger.paused', res));
  await withTimeout(cdp.send('Debugger.pause'), 5000);
  const ev = await withTimeout(paused, 10000);
  if (ev === 'TIMEOUT') return void console.log('  (no pause)');
  for (const f of ev.callFrames.slice(0, 25)) console.log(`    at ${f.functionName || '<anon>'} ${f.url.replace(/^.*?\/\/[^/]+/, '')}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`);
}
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> => Promise.race([p, sleep(ms).then(() => 'TIMEOUT' as const)]);
const js = async <T>(code: string, ms = 8000): Promise<T | 'TIMEOUT'> =>
  withTimeout((page.evaluate(code) as Promise<T>).catch((e) => `THREW: ${String((e as Error).message).split('\n')[0]}` as T), ms);
const heap = async () => {
  const r = await withTimeout(cdp.send('Runtime.getHeapUsage') as Promise<{ usedSize: number }>, 5000);
  return r === 'TIMEOUT' ? 'TIMEOUT' : +(r.usedSize / 1e6).toFixed(1);
};

await page.goto(`http://127.0.0.1:${port}/?seed=1&realinput=1&menu=1`);
await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 240_000 });
await fitWindow(page, 'chromium', W, H);
await x.click(W / 2, 20);
await x.key('s');
await sleep(800);
await x.key('Return');
await sleep(3000);
await settleWorld(js as never);
console.log('lock', await js('!!document.pointerLockElement'), 'heap', await heap());

const setMode = async (mode: string) => {
  for (let i = 0; i < 4 && (await js<string>('cdda.renderer.rig.mode')) !== mode; i++) {
    await x.key('v');
    await sleep(250);
  }
  return js<string>('cdda.renderer.rig.mode');
};

async function probe(label: string): Promise<boolean> {
  for (const mode of modes) {
    console.log(`\n== ${label} / ${mode}: mode now ${await setMode(mode)}`);
    for (const v of values) {
      const before = await heap();
      const r = await js(`(() => { cdda.game.player.pitch = ${v}; return 1; })()`);
      if (argv.includes('--early') && v === 'NaN') { await sleep(150); await stack(); await cdp.send('Debugger.resume'); }
      await sleep(1500);
      const after = await heap();
      const p = await js<number>('cdda.game.player.pitch', 4000);
      console.log(`  pitch=${v.padEnd(11)} set:${r} heap ${before} -> ${after}  now ${p}`);
      if (after === 'TIMEOUT' || p === 'TIMEOUT') {
        console.log('  HUNG');
        await stack();
        return false;
      }
      await js('cdda.game.player.pitch = 0');
    }
    // real mouse to the limits: straight up then straight down, held for a while each
    for (const dy of [-4000, 8000]) {
      const before = await heap();
      await x.move(0, dy, 20);
      const samples: unknown[] = [];
      for (let i = 0; i < 6; i++) {
        await sleep(2500);
        await x.move(0, Math.sign(dy) * 200, 4); // keep pushing against the limit
        samples.push(await heap());
      }
      console.log(`  mouse dy ${dy} (15 s held): pitch ${await js('cdda.game.player.pitch', 4000)} cam ${await js('cdda.renderer.rig.mode')} heap ${before} -> ${samples.join(' ')}`);
      if (samples.includes('TIMEOUT')) return false;
    }
    await x.move(0, -4000, 10);
  }
  return true;
}

let ok = argv.includes('--skip-foot') ? true : await probe('on foot');
if (ok && argv.includes('--drive')) {
  console.log(await js(`(() => { const r = cdda.roadTrip('car'); return !!r; })()`));
  await sleep(2000);
  await settleWorld(js as never);
  ok = await probe('driving');
}
if (ok && argv.includes('--station')) {
  console.log(await js(`(() => { const vs = cdda.vehicleSystem; if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); } vs.stations.leave(); return !!cdda.roadTrip('tank_m1_abrams'); })()`));
  await sleep(2000);
  await settleWorld(js as never);
  const kinds = await js<{ i: number; kind: string }[]>(`(() => { const vs = cdda.vehicleSystem, v = vs.driving; window.__tank = v; v.velocity = 0; vs.releaseControls(); const seen = new Set(); return vs.stations.stations(v).map((s, i) => ({ i, kind: s.kind })).filter((s) => !seen.has(s.kind) && seen.add(s.kind)); })()`);
  console.log('stations', kinds);
  for (const k of kinds as { i: number; kind: string }[]) {
    if (!ok) break;
    console.log(await js(`(() => { const vs = cdda.vehicleSystem; vs.stations.enter(window.__tank, ${k.i}); return vs.stations.view()?.station.kind ?? null; })()`));
    await sleep(500);
    ok = await probe(`tank ${k.kind}`);
  }
}
console.log(ok ? 'no hang' : 'HANG reproduced');
await withTimeout(browser.close(), 5000);
await vite.close();
process.exit(0);
