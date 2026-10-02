// Real-input "the world is drawn" smoke (docs/PERF.md): after the quick start, at the default
// settings (voxel look, smooth shadows), the street must actually be drawn — and still be with
// the flashlight switched on and off by the F key. A shadow-map binding error once left only the
// sky and the far ground ring on screen while every functional check passed. `cdda.*` only
// hands over a flashlight (with charge) and stands you in a street; F is a real key press.
// Plugged into tools/realinput.ts (run: --only worlddrawn).

import type { Page } from 'puppeteer-core';
import type { XInput } from './lib/realinput';
import { worldDrawn, WORLD_DRAWN_MIN } from './lib/worldDrawn';

export interface DrawnCtx {
  page: () => Page;
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

export function drawnScenarios(c: DrawnCtx): Scenario[] {
  const { js, check, shot, sleep } = c;
  const drawn = async (label: string) => {
    const d = await worldDrawn(c.page());
    check(`the world is drawn: ${label} (hiding the chunks changes ${Math.round(d.changed * 100)}% of the image, need ${WORLD_DRAWN_MIN * 100}%)`, d.ok, d);
  };
  return [
    ['worlddrawn', 'the street is actually drawn at the default look and shadows, and with the flashlight on and off (F)', async () => {
      await c.toGameplay();
      await js(`(() => {
        cdda.setHour(12);
        cdda.godMode(true);
        cdda.clearMonsters?.(60);
        cdda.giveItem('flashlight', { ammo: 'default' });
        const s = cdda.startLocation();
        const town = cdda.cities().filter((t) => t.size >= 4).sort((a, b) => Math.hypot(a.x - s.omx, a.y - s.omy) - Math.hypot(b.x - s.omx, b.y - s.omy))[0];
        cdda.teleportOmt(town.x, town.y);
        const h = cdda.findOmt('house', 40);
        cdda.teleportOmt(h.x, h.y, 0, 18, -1);
        cdda.look(-95, -2);
      })()`);
      // (a frame first: right after the teleport, pending still describes the old spot)
      await sleep(250);
      for (let i = 0; i < 120 && (await js<number>(`cdda.renderer.chunks.stats.pending`)) > 0; i++) await sleep(250);
      // (and the load gate's loading screen, src/loadgate: it covers the view and holds the F key)
      for (let i = 0; i < 120 && (await js<boolean>(`!!cdda.loadGate?.().closed`)); i++) await sleep(250);
      await sleep(800);
      await drawn('after the load');
      await c.x().key('F');
      await sleep(600);
      const on = await js<boolean>(`cdda.renderer.flashlightOn`);
      check('F switches the flashlight on', on, on);
      await drawn('flashlight on');
      await shot('worlddrawn_flashlight');
      await c.x().key('F');
      await sleep(600);
      check('F switches it off again', !(await js<boolean>(`cdda.renderer.flashlightOn`)));
      await drawn('flashlight off');
    }],
  ];
}
