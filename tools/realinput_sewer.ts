// Real-input sewer scenario, run from tools/realinput.ts:
//   --only sewer   a town manhole (genVersion 2 overmap): the cover is shut (no stairwell cut
//                  through it); `e` → Pry open lifts it with a crowbar; `>` climbs down the
//                  ladder into the sewer (z−1); `<` climbs back out (docs/WORLD_TRANSPORT.md).
//
// Keys are OS-level input; cdda.* only hands out the crowbar, finds the manhole, stands the
// survivor next to it facing it, and reads state.

import { settleWorld, type XInput } from './lib/realinput';

export interface SewerCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

export function sewerScenarios(c: SewerCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  const menuText = () => js<string>(`[...document.querySelectorAll('.cdda-window')].map((w) => w.textContent).join(' | ')`);
  const logTail = (n = 6) => js<string[]>(`cdda.ui.log().slice(-${n})`);
  const where = () => js<{ x: number; y: number; z: number; under: string }>(`(() => { const p = cdda.game.player; return { x: p.tileX, y: p.tileY, z: p.z, under: cdda.game.map.terAt(p.tileX, p.tileY, p.z).id }; })()`);
  /** Press `e`, then the menu letter of the entry starting with `label` (null if absent). */
  const choose = async (label: string) => {
    await c.x().key('e');
    await sleep(300);
    const letter = await js<string | null>(`(() => {
      for (const row of document.querySelectorAll('.cdda-window .menu-entry[data-i]')) {
        const k = row.querySelector('.hotkey');
        if (k && (row.textContent || '').slice(k.textContent.length).trim().startsWith(${JSON.stringify(label)})) return k.textContent;
      }
      return null;
    })()`);
    if (!letter) {
      const text = await menuText();
      // No menu: with one action on offer `e` does it straight away (the [e] prompt).
      if (!text) {
        await sleep(600);
        return { ok: true, text: '' };
      }
      await c.x().key('Escape');
      await sleep(200);
      return { ok: false, text };
    }
    await c.x().key(letter);
    await sleep(600);
    return { ok: true, text: '' };
  };

  return [
    ['sewer', 'a manhole: the cover stays shut, e → Pry open lifts it, > climbs down into the sewer, < climbs back out', async () => {
      await toGameplay();
      const spot = await js<{ cover: [number, number]; stand: [number, number] } | { error: string }>(`(() => {
        const g = cdda.game, m = g.map;
        cdda.giveItem('crowbar');
        const h = cdda.findOmt('road_nesw_manhole', 60);
        if (!h) return { error: 'no manhole within 60 OMTs' };
        cdda.teleportOmt(h.x, h.y, 0);
        cdda.step(0.2);
        for (let ly = 0; ly < 24; ly++) for (let lx = 0; lx < 24; lx++) {
          const x = h.x * 24 + lx, y = h.y * 24 + ly;
          if (m.terAt(x, y, 0).id !== 't_manhole_cover') continue;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
            if (m.passable(x + dx, y + dy, 0)) return { cover: [x, y], stand: [x + dx, y + dy] };
        }
        return { error: 'manhole OMT without a cover tile' };
      })()`);
      if ('error' in spot) {
        check('found a town manhole', false, spot);
        return;
      }
      const [cx, cy] = spot.cover, [sx, sy] = spot.stand;
      await js(`(() => { cdda.godMode(true); cdda.teleport(${sx} + 0.5, ${sy} + 0.5, 0); cdda.clearMonsters(120); cdda.faceTile(${cx}, ${cy}); cdda.game.player.pitch = -0.6; cdda.step(0.05); })()`);
      const w = await settleWorld(js);
      if (!w.ok) check('the surroundings finished loading', false, w);
      const linkShut = await js<unknown>(`cdda.stairs.at(${cx}, ${cy}, 0) ?? cdda.stairs.at(${cx}, ${cy}, -1)`);
      check('the closed cover is not cut open into a stairwell (no ladder link through it yet)', linkShut === null, linkShut);
      await shot('sewer_cover');
      // Prying can fail on a bad roll (difficulty 4): try a few times, like a player would.
      let pried = false, menu = '';
      for (let i = 0; i < 8 && !pried; i++) {
        const r = await choose('Pry open');
        if (!r.ok) menu = r.text;
        pried = (await js<string>(`cdda.game.map.terAt(${cx}, ${cy}, 0).id`)) === 't_manhole';
      }
      check('e → Pry open lifts the manhole cover (t_manhole)', pried, { menu, log: await logTail() });
      check('…with BN\'s message', (await logTail(12)).some((m) => /You lift the manhole cover/.test(m)), await logTail(12));
      await shot('sewer_open');
      // Step onto the open manhole (real keys: face it and walk) then climb down.
      await js(`cdda.faceTile(${cx}, ${cy}); cdda.game.player.pitch = 0;`);
      await c.x().hold('w', 350);
      await sleep(300);
      if ((await where()).z === 0) {
        await c.x().key('greater');
        await sleep(2500);
      }
      const down = await where();
      check('> climbs down the ladder into the sewer (z−1, on the ladder)', down.z === -1, down);
      await shot('sewer_below');
      await c.x().key('less');
      await sleep(2500);
      const up = await where();
      check('< climbs back out to the street (z0)', up.z === 0, up);
      await js(`(() => { cdda.godMode(false); })()`);
    }],
  ];
}
