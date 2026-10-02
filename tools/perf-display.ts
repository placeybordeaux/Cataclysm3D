// Target a 360p scene while comparing presentation pixel ratios on a 2x
// display. Run via heavy --kind gpu --mem 2 -- nix-shell --run 'npx tsx tools/perf-display.ts'.
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PERF_PAGE } from './lib/perfRoutes';

const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
await server.listen();
const port = (server.httpServer!.address() as { port: number }).port;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
const output = '/tmp/cdda-perf-display';
mkdirSync(output, { recursive: true });
const results: unknown[] = [];
const verifyOnly = process.argv.includes('--verify-only');
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true,
    args: ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu'] });
  let page = await browser.newPage();
  page.on('dialog', dialog => void dialog.accept());
  page.setDefaultNavigationTimeout(240_000);
  page.on('pageerror', error => console.error(String(error)));
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${port}/?seed=1&skipmenu=1&px=360`);
  await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 240_000 });
  if (await page.evaluate('window.cddaError')) throw new Error(String(await page.evaluate('window.cddaError')));
  if (!verifyOnly) {
    await page.evaluate(PERF_PAGE);
    await page.evaluate("__perfBench.place({ ...__perfBench.pick('city'), lead: -4 }); cdda.exitVehicle(); cdda.perf.gpu(true)");
    await new Promise(resolve => setTimeout(resolve, 30_000));
  }
  // Reverse the order in the second pass to expose cache/load drift.
  for (const ratio of verifyOnly ? [] : [0, 1, .5, .5, 1, 0]) {
    await page.evaluate(`cdda.renderer.pixelRatio=${ratio}; cdda.renderer.resize()`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    await page.evaluate('cdda.perf.reset()');
    await new Promise(resolve => setTimeout(resolve, 6000));
    const dump = await page.evaluate('cdda.perf.dump(6)') as { meta: unknown; frames: unknown };
    const summary = await page.evaluate('cdda.perf.summary()');
    results.push({ ratio, summary, meta: dump.meta });
    const stats = summary as { interval: { mean: number; p99: number }; sections: { gpu?: number; draw?: number } };
    console.log(JSON.stringify({ ratio, interval: stats.interval, gpuMs: stats.sections.gpu, drawMs: stats.sections.draw }));
    writeFileSync(`${output}/results.json`, JSON.stringify(results, null, 2));
    // Capture outside the timing window.
    await page.screenshot({ path: `${output}/ratio-${ratio}.png` });
  }
  // Persisted option and URL precedence are part of the user-facing setting.
  await page.evaluate("localStorage.setItem('cdda3d.options', JSON.stringify({pixelRatio:1}))");
  // A fresh tab shares storage while releasing the dense benchmark scene and workers.
  await page.close();
  page = await browser.newPage();
  page.on('dialog', dialog => void dialog.accept());
  page.setDefaultNavigationTimeout(90_000);
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${port}/?seed=1&skipmenu=1&px=360`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.cdda?.ready', { timeout: 240_000 });
  if (await page.evaluate('cdda.renderer.pixelRatio') !== 1) throw new Error('Stored pixel ratio did not restore');
  await page.goto(`http://127.0.0.1:${port}/?seed=1&skipmenu=1&px=360&pixelRatio=1.5`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.cdda?.ready', { timeout: 240_000 });
  if (await page.evaluate('cdda.renderer.pixelRatio') !== 1.5) throw new Error('URL pixel ratio did not override stored option');
  await page.evaluate("cdda.ui.open('options')");
  if (!(await page.evaluate("document.body.textContent.includes('Display pixel ratio')"))) throw new Error('Display pixel ratio absent from Options');
  await page.screenshot({ path: `${output}/options.png` });
  console.log('Stored pixel ratio and URL precedence pass');
} finally { await browser?.close(); await server.close(); }
if (!verifyOnly) writeFileSync(`${output}/results.json`, JSON.stringify(results, null, 2));
