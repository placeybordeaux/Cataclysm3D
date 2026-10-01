import type { Page } from 'puppeteer-core';
import { PNG } from 'pngjs';

// "Is the world actually drawn?" (docs/PERF.md). A broken shader or a bad texture binding can
// make every lit material fail to draw while draw calls and triangles still go through: the
// image is sky, the far ground ring and stand-ins, and every functional check still passes (it
// happened: the flashlight shadow change, 2026-10-01). The test is relative, not artistic:
// screenshot the view, hide the chunk meshes (and their merged batches), screenshot again. If
// the world is drawn, hiding it changes a large part of the image; if it isn't, nothing changes.

export interface WorldDrawn {
  /** share of pixels that changed when the chunk meshes were hidden (0..1) */
  changed: number;
  ok: boolean;
}

/** Threshold: a normal street view changes 40-90 % of its pixels; a blank one under 2 %. */
export const WORLD_DRAWN_MIN = 0.15;

const shot = async (page: Page): Promise<PNG> => PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png' })));

const frames = (page: Page, n: number) =>
  page.evaluate(`new Promise((r) => { let k = ${n}; const f = () => (--k > 0 ? requestAnimationFrame(f) : r(null)); requestAnimationFrame(f); })`);

export async function worldDrawn(page: Page): Promise<WorldDrawn> {
  await frames(page, 3);
  const a = await shot(page);
  await page.evaluate(`(() => {
    const r = cdda.renderer;
    window.__wdHidden = [r.chunks.group, ...r.scene.children.filter((o) => o.name === 'chunk batches')].filter((g) => g.visible);
    for (const g of window.__wdHidden) g.visible = false;
  })()`);
  await frames(page, 3);
  const b = await shot(page);
  await page.evaluate(`(() => { for (const g of window.__wdHidden ?? []) g.visible = true; })()`);
  if (a.width !== b.width || a.height !== b.height) throw new Error('worldDrawn: screenshot sizes differ');
  let changed = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n * 4; i += 4) {
    const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (d > 30) changed++;
  }
  const share = changed / n;
  return { changed: +share.toFixed(3), ok: share >= WORLD_DRAWN_MIN };
}
