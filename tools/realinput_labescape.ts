// Real-input lab escape start (docs/WORLD_TRANSPORT.md), run from tools/realinput.ts:
//   --only labescape   title → New Game (n) → the Evacuee card → scenario "Lab Patient" picked
//                      with the mouse → Enter; you wake in an experiment cell of the classic
//                      lab's lab_escape_cells, four or more floors down, and can look around it
//
// cdda.* only wipes the profile and turns Classic mode on (setup, like the newgame scenario)
// and reads state; the picker, the scenario choice and the start are real clicks and keys.

import type { Page } from 'puppeteer-core';
import type { XInput } from './lib/realinput';

export interface LabEscapeCtx {
  page: () => Page;
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  size: [number, number];
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

export function labEscapeScenarios(c: LabEscapeCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  const panels = () => js<string[]>(`[...document.querySelectorAll('#ui2 .ui2-win .ui2-title-text')].map((t) => t.textContent ?? '')`);
  const waitFor = async (f: () => Promise<boolean>, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await f()) return true;
      await sleep(100);
    }
    return f();
  };
  return [
    ['labescape', 'New Game → Lab Patient scenario (mouse) → wake in a lab escape cell below z-4', async () => {
      const page = c.page(), x = c.x();
      const [W] = c.size;
      // Setup: a clean profile with Classic mode on, so the lab scenarios are offered.
      await js(`(() => { const wipe = () => { localStorage.removeItem('cdda3d.progression'); localStorage.removeItem('cdda3d.achievements'); }; wipe(); addEventListener('pagehide', wipe); return 1; })()`);
      await page.goto(page.url());
      await page.waitForFunction('window.cdda?.ready', { timeout: 240_000 });
      await js(`cdda.progression.classic(true)`);
      await x.click(W / 2, 20);
      await x.key('n');
      check('n opens the start picker', await waitFor(async () => (await panels()).includes('New Game'), 3000));
      // The Evacuee card (first, selected) offers its scenarios as a segmented control.
      const at = await js<[number, number] | null>(`(() => { const b = document.querySelector('#ui2 .pg-seg [data-value="lab_chal"]'); if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
      if (!check('the Evacuee card offers the Lab Patient scenario', !!at)) return;
      await x.click(at![0], at![1]);
      await sleep(250);
      const on = await js<string>(`document.querySelector('#ui2 .pg-seg .on')?.dataset.value ?? ''`);
      const desc = await js<string>(`document.querySelector('#ui2 .pg-desc')?.textContent ?? ''`);
      check('clicking it selects it', on === 'lab_chal', on);
      check('its description says where you start', /Locked Lab/.test(desc), desc.slice(-80));
      await shot('labescape_picker');
      await x.key('Return');
      const started = await waitFor(async () => !(await panels()).length && (await js<boolean>('!!document.pointerLockElement')), 20000);
      check('Enter starts the game with the mouse captured', started);
      await toGameplay();
      const where = await js<{ z: number; type: string; special?: string; ly: number }>(`(() => { const p = cdda.game.player, o = cdda.omtAt(); return { z: p.z, type: o.type, special: o.special, ly: Math.floor(p.y) - Math.floor(p.y / 24) * 24 }; })()`);
      check('you wake in a lab_escape_cells OMT of the classic lab', where.type === 'lab_escape_cells' && where.special === 'Lab', where);
      check('four or more floors down', where.z <= -4, where.z);
      check('inside one of the cells (rows 17-22 of the OMT)', where.ly >= 17 && where.ly <= 22, where.ly);
      const msgs = await js<string[]>('cdda.ui.log()');
      check('the wake-up message names the cell', msgs.some((m) => /locked cell deep in a science lab/.test(m)), msgs.slice(-3));
      await shot('labescape_cell');
      // Look round the cell with the mouse.
      for (let i = 0; i < 3; i++) {
        await x.move(300, 0);
        await sleep(400);
        await shot(`labescape_look_${i}`);
      }
      await js(`cdda.progression.classic(false)`);
    }],
  ];
}
