// Run via heavy --kind gpu --mem 2 -- nix-shell --run 'npx tsx tools/perf-backends.ts'.
// Synthetic A/B: identical geometry, unbatched/instanced, all three renderer paths.
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
const output = opt('--out', '/tmp/cdda-backends.json');
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
await server.listen();
const port = (server.httpServer!.address() as { port: number }).port;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
const results: unknown[] = [];
let gpu: unknown;
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true,
    args: ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  const system = await browser.target().createCDPSession();
  gpu = (await system.send('SystemInfo.getInfo')).gpu;
  await system.detach();
  await page.setViewport({ width: 1920, height: 1080 });
  for (const ratio of opt('--ratios', '1,2').split(',').map(Number)) {
    for (const batch of [0, 1]) for (const backend of ['webgl', 'webgl-fallback', 'webgpu']) {
      await page.goto(`http://127.0.0.1:${port}/tools/perf-backends.html?backend=${backend}&batch=${batch}&ratio=${ratio}&count=1000`);
      await page.waitForFunction('window.probeResult || window.probeError', { timeout: 120_000 });
      const result = await page.evaluate('window.probeResult ?? { error: window.probeError }');
      results.push({ backend, batch, ratio, result });
      console.log(JSON.stringify(results.at(-1)));
    }
  }
} finally { await browser?.close(); await server.close(); }
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ date: new Date().toISOString(), gpu, note: 'Synthetic submission benchmark; no game shaders, shadows, postprocessing or simulation. CPU timings are submission only, not GPU completion. Chromium launched with --enable-unsafe-webgpu; this verifies the experimental path, not default browser availability.', results }, null, 2));
