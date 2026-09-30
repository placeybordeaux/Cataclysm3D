// Real-input integration check for the Options screen (wave-3 QA, docs/QA_WAVE3.md), run from
// tools/realinput.ts:  --only options
// Six areas each added Options entries (creatures, first-person hands, furniture, surfaces, trees,
// vehicle look/width, haze, draw distance, form lighting, aim model, title, activity progress,
// route guide, rest menus, ...). This walks every row of Esc > Options with the arrow keys the
// way a player would: each value must change on → and come back to where it started (a cycle,
// or ← for sliders), with no page error, no duplicated row, and the game still drawing frames.
// Rows ending in "…" open another screen and are left to their own scenarios (rebind).

import type { XInput } from './lib/realinput';

export interface QaCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  errors: () => string[];
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

/** Entries a player would expect after wave 3 (a missing one means an install didn't run). */
const EXPECTED = [
  'Creatures', 'First-person hands', 'Furniture', 'Surfaces', 'Trees', 'Vehicle look', 'Vehicle width',
  'Distance haze', 'Draw distance', 'Form lighting', 'Aim model', 'Title screen', 'Activity progress',
  'Route guide', 'Rest menus', 'Visual style',
];
/** Toggling these leaves the session in a different state than a player expects mid-suite. */
const SKIP = new Set(['Fullscreen']);

const ROWS = `[...document.querySelectorAll('#ui2 .op-row')].map((r) => ({ name: r.dataset.name, value: r.querySelector('.op-val')?.textContent ?? '' }))`;

export function qaScenarios(c: QaCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  const value = async (name: string) =>
    js<string>(`(${ROWS}).find((r) => r.name === ${JSON.stringify(name)})?.value ?? '<gone>'`);
  // three.js counts rendered frames; the Options window pauses the game but not the renderer.
  const frames = () => js<number>(`cdda.renderer.three.info.render.frame`);
  return [
    ['options', 'Options: every entry (wave-3 variant switches included) changes with → and comes back; no errors, no duplicate rows', async () => {
      await toGameplay();
      await sleep(800);
      const x = c.x();
      await x.key('Escape');
      await sleep(400);
      await x.key('o');
      await sleep(600);
      const rows = await js<{ name: string; value: string }[]>(ROWS);
      check('Options opens with rows', rows.length > 10, rows.length);
      const names = rows.map((r) => r.name);
      const dup = names.filter((n, i) => names.indexOf(n) !== i);
      check('no duplicated Options rows', dup.length === 0, dup);
      const missing = EXPECTED.filter((n) => !names.includes(n));
      check('every wave-3 switch is listed', missing.length === 0, missing);
      await shot('options-all');
      for (let i = 0; i < rows.length; i++) {
        const { name, value: v0 } = rows[i];
        if (i > 0) await x.key('Down');
        if (name.endsWith('…') || SKIP.has(name)) continue;
        const errs0 = c.errors().length;
        const seen = [v0];
        const wait = name === 'Visual style' || name === 'Trees' || name === 'Surfaces' || name === 'Furniture' ? 900 : 150;
        const press = async (k: string) => {
          await x.key(k);
          await sleep(wait);
          return value(name);
        };
        // A cycle comes back to v0 on →. A slider (volumes, sensitivity) clamps at its ends and its
        // steps needn't retrace exactly (×1.15, or 35 % → 50 %), so it passes if it moves at all and
        // is walked back with ← afterwards (to about where it was).
        let cycle = false;
        let rights = 0;
        for (; rights < 10; rights++) {
          const v = await press('Right');
          if (v === v0) {
            cycle = rights > 0;
            rights++;
            break;
          }
          seen.push(v);
        }
        if (!cycle) {
          if (seen.length === 1) {
            // already at the top of a slider
            seen.push(await press('Left'));
            await press('Right');
          } else {
            for (let j = 0; j < rights; j++) await x.key('Left');
            await sleep(wait);
          }
        }
        const changed = new Set(seen).size > 1;
        const errs = c.errors().slice(errs0);
        check(`${name}: ${seen.join(' → ')}${cycle ? '' : ' (slider)'}`, changed && errs.length === 0, { changed, cycle, errs: errs.slice(0, 2) });
      }
      const f0 = await frames();
      await sleep(500);
      check('the game still draws after cycling everything', (await frames()) !== f0);
      await x.key('Escape');
      await sleep(300);
      await x.key('Escape');
      await toGameplay();
    }],
  ];
}
