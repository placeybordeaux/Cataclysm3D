// Real-input sunken lab scenario, run from tools/realinput.ts:
//   --only sunkenlab   genVersion 3 lakes (docs/WORLD_TRANSPORT.md "Lakes in depth"): reloads
//                      the page on seed 24, whose start region holds BN's sunken_lab; from the
//                      lake surface above it `>` dives, `>` swims down the water cubes to the lake
//                      bed (z−5), `e` opens the entrance's bulkhead door, held W walks into the
//                      dry room, `>` takes its stairs to the airlock (z−6) that opens on the labs.
//                      Reloads the original page afterwards.
//
// Keys are OS-level input; cdda.* only finds the lab, stands the survivor in the water above it
// (with the dive already agreed to: cdda.dive) facing the door, keeps them from drowning on the
// way (godMode), and reads state.

import { settleWorld, type XInput } from './lib/realinput';
import type { Page } from 'puppeteer-core';

export interface SunkenLabCtx {
  page: () => Page;
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  gameUrl: () => string;
  quickStart: () => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

/** tools/dev/probe_lakes.ts --scan: seed 24's start region has a sunken lab at OMT 21,14. */
const SEED = 24;
const CHUNK = 24;

export function sunkenLabScenarios(c: SunkenLabCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  const where = () => js<{ x: number; y: number; z: number; ter: string; underwater: boolean; swimming: boolean; oxygen: number }>(`(() => {
    const p = cdda.game.player, s = cdda.swim();
    return { x: p.tileX, y: p.tileY, z: p.z, ter: cdda.game.map.terAt(p.tileX, p.tileY, p.z).id, underwater: s.underwater, swimming: s.swimming, oxygen: s.oxygen };
  })()`);
  const logTail = (n = 4) => js<string[]>(`cdda.ui.log().slice(-${n})`);
  const reload = async (url: string) => {
    await c.page().goto(url);
    await c.page().waitForFunction('window.cdda?.ready', { timeout: 240_000 });
    await c.quickStart();
    await toGameplay();
  };
  const press = async (k: string) => {
    await c.x().key(k);
    await sleep(350);
  };
  /** Wait for the chunks round the new spot (the load gate holds the game, and keys, until then). */
  const settle = async (what: string) => {
    const w = await settleWorld(js, { timeoutMs: 120_000 });
    if (!w.ok) check(`the surroundings finished loading (${what})`, false, w);
  };
  /** `>`/`<` once the world is settled. One press only: a key pressed while the load gate holds
   *  the game is queued and runs later, so wait (up to 20 s) for z or the log to change instead. */
  const vertical = async (k: string, what: string) => {
    await settle(what);
    const before = JSON.stringify([(await where()).z, await logTail(1)]);
    await press(k);
    for (let i = 0; i < 100 && JSON.stringify([(await where()).z, await logTail(1)]) === before; i++) await sleep(200);
  };
  /** Face the door at (x, y) on the player's level and open it with `e` (picking Open if a menu comes up). */
  const openDoor = async (x: number, y: number) => {
    const ter = () => js<string>(`cdda.game.map.terAt(${x}, ${y}, cdda.game.player.z).id`);
    await js(`cdda.faceTile(${x}, ${y}); cdda.game.player.pitch = 0;`);
    await press('e');
    if (/_c$/.test(await ter())) {
      const letter = await js<string | null>(`(() => {
        for (const row of document.querySelectorAll('.cdda-window .menu-entry[data-i]')) {
          const k = row.querySelector('.hotkey');
          if (k && (row.textContent || '').slice(k.textContent.length).trim().startsWith('Open')) return k.textContent;
        }
        return null;
      })()`);
      if (letter) await press(letter);
    }
    return ter();
  };

  return [
    ['sunkenlab', 'seed 24: > dives into the lake, > swims down to the bed, e opens the sunken lab door, W walks in, > takes the stairs to the airlock', async () => {
      const original = c.gameUrl();
      await reload(original.replace(/([?&])seed=\d+/, `$1seed=${SEED}`));
      const lab = await js<{ x: number; y: number; rot: number } | null>(`cdda.findSpecial('sunken_lab', 1)`);
      if (!check(`seed ${SEED} has a sunken_lab near the start`, !!lab, lab)) return reload(original);
      // The entrance (z−5) is a cross of bulkhead rooms with doors at the ends of its arms; find a
      // door with lake bed outside it and the room inside, and stand in the water above the bed.
      const spot = await js<{ door: [number, number]; bed: [number, number]; inside: [number, number] } | { error: string }>(`(() => {
        const m = cdda.game.map, X = ${lab!.x} * ${CHUNK}, Y = ${lab!.y} * ${CHUNK};
        m.chunk(${lab!.x}, ${lab!.y}, -5);
        for (let y = Y; y < Y + ${CHUNK}; y++) for (let x = X; x < X + ${CHUNK}; x++) {
          if (m.terAt(x, y, -5).id !== 't_door_metal_bulkhead_c') continue;
          for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
            const out = m.terAt(x + dx, y + dy, -5).id, inn = m.terAt(x - dx, y - dy, -5).id;
            if (/^t_lake_(bed|moss)$/.test(out) && inn === 't_bulkhead_floor' && m.terAt(x + dx, y + dy, -4).id === 't_water_cube') return { door: [x, y], bed: [x + dx, y + dy], inside: [x - dx, y - dy] };
          }
        }
        return { error: 'no outer bulkhead door on the lake bed' };
      })()`);
      if ('error' in spot) {
        check('the sunken lab entrance has a door onto the lake bed', false, spot);
        return reload(original);
      }
      const [bx, by] = spot.bed, [dx, dy] = spot.door;
      await js(`(() => {
        cdda.godMode(true);
        cdda.clearMonsters(60);
        cdda.teleport(${bx} + 0.5, ${by} + 0.5, 0);
        cdda.dive(${bx}, ${by});
        cdda.faceTile(${dx}, ${dy});
        cdda.game.player.pitch = 0;
        cdda.step(0.05);
      })()`);
      await settle('the lake surface');
      let p = await where();
      // (a heavier load than the quick-start kit sinks you at once, BN swim_speed >= 500; then `>`
      // swims straight down and the dive step below doesn't apply)
      check('standing in the lake above the lab, swimming at the surface', p.z === 0 && p.ter === 't_water_dp' && p.swimming && !p.underwater, p);
      await shot('sunkenlab_surface');

      await vertical('greater', 'dive');
      p = await where();
      check('> dives under without changing level', p.z === 0 && p.underwater, { p, log: await logTail(2) });
      for (let z = -1; z >= -5; z--) {
        await vertical('greater', `z${z + 1}`);
        p = await where();
        if (!check(`> swims down to z${z}`, p.z === z && p.underwater, { p, log: await logTail(2) })) return reload(original);
      }
      check('…onto the lake bed', /^t_lake_(bed|moss)$/.test(p.ter), p.ter);
      await vertical('greater', 'the bed');
      check('> on the bed: no more water below', (await where()).z === -5 && (await logTail(1))[0].includes('no more water beneath you'), await logTail(1));
      const o1 = (await where()).oxygen;
      await sleep(1000);
      check('holding your breath down there', (await where()).oxygen < o1, [o1, (await where()).oxygen]);
      await shot('sunkenlab_bed');

      const doorNow = await openDoor(dx, dy);
      check('e opens the bulkhead door', doorNow === 't_door_metal_bulkhead_o', { doorNow, log: await logTail(2) });

      // Walk in: through the door to the room tile past it, re-facing between short holds.
      const [ix, iy] = spot.inside;
      for (let i = 0; i < 10; i++) {
        p = await where();
        if (p.x === ix && p.y === iy) break;
        await js(`cdda.faceTile(${ix}, ${iy}); cdda.game.player.pitch = 0;`);
        await c.x().hold('w', 500);
        await sleep(150);
      }
      p = await where();
      check('held W swims through the door into the dry room', p.z === -5 && p.ter === 't_bulkhead_floor' && !p.swimming, { p, log: await logTail(3) });
      await shot('sunkenlab_entrance');

      // The room's stairs: walk onto the nearest one, then >.
      const stairs = await js<[number, number] | null>(`(() => {
        const m = cdda.game.map, p = cdda.game.player;
        let best = null, bd = 1e9;
        for (let y = p.tileY - 12; y <= p.tileY + 12; y++) for (let x = p.tileX - 12; x <= p.tileX + 12; x++) {
          if (m.terAt(x, y, -5).id !== 't_stairs_down') continue;
          const d = Math.hypot(x - p.tileX, y - p.tileY);
          if (d < bd) { bd = d; best = [x, y]; }
        }
        return best;
      })()`);
      if (!check('the entrance room has stairs down', !!stairs)) return reload(original);
      // Down the arm: its inner door is two tiles in from the outer one (BN lake.json's cross),
      // then the central room; walk tile by tile to the nearest stair.
      const vx = ix - dx, vy = iy - dy;
      const inner: [number, number] = [dx + 2 * vx, dy + 2 * vy];
      check('e opens the arm\'s inner door', !/_c$/.test(await openDoor(inner[0], inner[1])), inner);
      const walkTo = async (tx: number, ty: number) => {
        for (let i = 0; i < 8; i++) {
          p = await where();
          if (p.x === tx && p.y === ty) return true;
          await js(`cdda.faceTile(${tx}, ${ty}); cdda.game.player.pitch = 0;`);
          await c.x().hold('w', 250);
          await sleep(100);
        }
        p = await where();
        return p.x === tx && p.y === ty;
      };
      let [cx, cy] = [inner[0] + vx, inner[1] + vy];
      await walkTo(inner[0], inner[1]);
      await walkTo(cx, cy);
      while (cx !== stairs![0] || cy !== stairs![1]) {
        cx += Math.sign(stairs![0] - cx);
        cy += Math.sign(stairs![1] - cy);
        if (!(await walkTo(cx, cy))) break;
      }
      check('walked onto the stairs', p.x === stairs![0] && p.y === stairs![1], { p, stairs });
      await vertical('greater', 'the entrance room');
      await sleep(1500); // a modelled flight takes a moment to walk
      p = await where();
      const omt = await js<{ type: string; special?: string }>(`cdda.omtAt()`);
      check('> takes the stairs down into the airlock (z−6)', p.z === -6 && omt.type === 'lake_bed_lab_entrance_airlock', { p, omt, log: await logTail(3) });
      await shot('sunkenlab_airlock');
      await js(`cdda.godMode(false)`);
      await reload(original);
    }],
  ];
}
