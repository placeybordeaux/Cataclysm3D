// Real-input scenarios for looting (src/ui2/loot): the crosshair quick-loot panel, the area
// loot window, pile markers, searched-container memory — and `lootsweep`, which sweeps the
// same room (the evac shelter's cupboards, a pile on the floor, two lockers: 6 places) with
// each Options > "Looting style" and reports how many key presses / clicks / mouse aims and
// how long each took. Everything the player does is xdotool; `cdda.*` only sets the scene
// (a rucksack, a pile, standing at the two spots) and reads state. Plugged into
// tools/realinput.ts (run: --only lootquick,lootarea,lootsweep).

import type { Page } from 'puppeteer-core';
import type { XInput } from './lib/realinput';

export interface LootCtx {
  page: () => Page;
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  /** Reload the game page and quick-start a new survivor (the same seed: the same shelter). */
  fresh: () => Promise<void>;
  size: [number, number];
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

/** Report of the sweep comparison, printed at the end and kept for docs. */
export const sweepReport: { style: string; aims: number; keys: number; clicks: number; walks: number; seconds: number; emptied: number; taken: number }[] = [];

export function lootScenarios(c: LootCtx): Scenario[] {
  const { js, check, shot, sleep } = c;
  const x = () => c.x();
  let tally = { aims: 0, keys: 0, clicks: 0, walks: 0 };
  const key = async (k: string) => {
    tally.keys++;
    await x().key(k);
    await sleep(250);
  };
  const click = async (p: { x: number; y: number }) => {
    tally.clicks++;
    await x().click(p.x, p.y);
    await sleep(300);
  };

  // --- scene: the shelter the quick start puts you in. Cupboards along the north wall at
  // (o.x-2..o.x, o.y-3), lockers down the west wall at (o.x-2, o.y+4 / +5); o = the start tile.
  const SETUP = `(() => {
    const g = cdda.game, p = g.player;
    const o = { x: p.tileX, y: p.tileY, z: p.z };
    window.__lootO = o;
    cdda.giveItem('rucksack', { wear: true });
    // A second bag: the sweep is about looting, not about a full backpack.
    cdda.giveItem('duffelbag', { wear: true });
    return o;
  })()`;
  const O = () => js<{ x: number; y: number; z: number }>('window.__lootO');
  /** Stand at a tile (a walk: the same for every style, so it's teleported and counted apart). */
  const standAt = async (dx: number, dy: number) => {
    tally.walks++;
    await js(`(() => { const o = window.__lootO, p = cdda.game.player; p.x = o.x + ${dx} + 0.5; p.y = o.y + ${dy} + 0.5; })()`);
    await sleep(300);
  };
  /** Turn with the real mouse until the crosshair is on tile (o + dx, o + dy). */
  const aim = async (dx: number, dy: number, h = 0.7) => {
    tally.aims++;
    for (let i = 0; i < 3; i++) {
      const d = await js<{ dyaw: number; dpitch: number; sens: number; ok: boolean }>(`(() => {
        const o = window.__lootO, g = cdda.game, p = g.player;
        const tx = o.x + ${dx} + 0.5, ty = o.y + ${dy} + 0.5;
        const yaw = Math.atan2(tx - p.x, -(ty - p.y));
        const dist = Math.hypot(tx - p.x, ty - p.y);
        const pitch = Math.atan2(${h} - 1.6, dist);
        let dyaw = yaw - p.yaw; dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
        const t = cdda.target();
        return { dyaw, dpitch: pitch - p.pitch, sens: g.mouseSensitivity, ok: !!t && t.x === o.x + ${dx} && t.y === o.y + ${dy} };
      })()`);
      if ((d.ok && Math.abs(d.dyaw) < 0.15) || (Math.abs(d.dyaw) < 0.04 && Math.abs(d.dpitch) < 0.04)) break;
      await x().move(d.dyaw / d.sens, -d.dpitch / d.sens, 6);
      await sleep(150);
    }
    const t = await js<{ x: number; y: number } | null>('cdda.target()');
    const o = await O();
    return !!t && t.x === o.x + dx && t.y === o.y + dy;
  };
  /** Everything on the survivor and on the swept tiles, by type (charges counted). */
  const CENSUS = `(() => {
    const o = window.__lootO, g = cdda.game, p = g.player, out = {};
    const add = (it) => { for (const i of it.walk()) out[i.typeId] = (out[i.typeId] ?? 0) + i.count(); };
    for (const it of p.inv.topLevel()) add(it);
    const tiles = [[-2,-3],[-1,-3],[0,-3],[0,-2],[-2,4],[-2,5]];
    for (const [dx, dy] of tiles) for (const it of g.map.itemsAt(o.x + dx, o.y + dy, o.z)) add(it);
    return out;
  })()`;
  const sameCounts = (a: Record<string, number>, b: Record<string, number>) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => (a[k] ?? 0) !== (b[k] ?? 0));
  const sourcesLeft = () => js<number[]>(`(() => { const o = window.__lootO, g = cdda.game; return [[-2,-3],[-1,-3],[0,-3],[0,-2],[-2,4],[-2,5]].map(([dx,dy]) => g.map.itemsAt(o.x+dx, o.y+dy, o.z).length); })()`);
  const pile = () => js(`(() => { const o = window.__lootO, p = cdda.game.player; const dx = o.x - p.tileX, dy = o.y - p.tileY;
    cdda.inv2.spawn('glock_19', dx, dy - 2); cdda.inv2.spawn('pipe', dx, dy - 2); cdda.inv2.spawn('9mm', dx, dy - 2, { charges: 30 }); cdda.inv2.spawn('bandages', dx, dy - 2, { charges: 3 }); })()`);
  const panel = () => js<{ key: string; title: string; mode: string; sel: number; rows: { typeId: string; name: string; count: number }[]; text: string } | null>('cdda.loot.panel()');

  const setStyle = (s: string) => js(`cdda.loot.setStyle(${JSON.stringify(s)})`);

  const sweep = async (style: 'tabs' | 'quick' | 'area') => {
    await c.fresh();
    await c.toGameplay();
    await js(SETUP);
    await setStyle(style);
    await standAt(-1, -2);
    await pile();
    tally = { aims: 0, keys: 0, clicks: 0, walks: 1 };
    const before = await js<Record<string, number>>(CENSUS);
    const t0 = Date.now();
    const at1: [number, number][] = [[-2, -3], [-1, -3], [0, -3], [0, -2]];
    const at2: [number, number][] = [[-2, 4], [-2, 5]];
    if (style === 'area') {
      await key('g');
      await key('r');
      await sleep(300);
      await shot(`lootsweep_area_first_spot`);
      await standAt(-1, 4);
      await sleep(500);
      await key('r');
      await sleep(300);
      await shot(`lootsweep_area_second_spot`);
      await key('g');
    } else {
      for (const [spot, list] of [[[-1, -2], at1], [[-1, 4], at2]] as [[number, number], [number, number][]][]) {
        if (spot[1] === 4) await standAt(...spot);
        for (const [dx, dy] of list) {
          const ok = await aim(dx, dy);
          if (!ok) check(`${style}: the crosshair reaches (${dx}, ${dy})`, false);
          if (style === 'quick') {
            await key('r');
          } else {
            await key('e');
            await sleep(400);
            const take = await js<{ x: number; y: number } | null>('cdda.ui2.textRect("Take all")');
            if (take) await click(take);
            else check(`${style}: the inventory opened on (${dx}, ${dy}) with Take all`, false);
            await key('Tab');
            await sleep(900);
            const s = await js<{ locked: boolean }>('cdda.ui2.state()');
            if (!s.locked) {
              // Chrome refuses a re-lock right after an unlock; a click resumes (a real player's too).
              await sleep(900);
              await click({ x: c.size[0] / 2, y: c.size[1] / 2 });
            }
          }
        }
      }
    }
    const seconds = (Date.now() - t0) / 1000;
    const after = await js<Record<string, number>>(CENSUS);
    const left = await sourcesLeft();
    const taken = await js<number>('cdda.game.player.inv.items.length');
    check(`${style}: nothing duplicated or lost over the sweep`, sameCounts(before, after).length === 0, sameCounts(before, after));
    check(`${style}: every place was looted (what's left stayed for a reason)`, left.filter((n) => n > 0).length <= 1, left);
    sweepReport.push({ style, ...tally, seconds: Math.round(seconds * 10) / 10, emptied: left.filter((n) => n === 0).length, taken });
    await c.toGameplay();
  };

  return [
    ['lootquick', 'quick loot: the crosshair panel lists a cupboard without leaving mouse-look; wheel selects, e takes one, r takes all, Tab opens it', async () => {
      await c.fresh();
      await c.toGameplay();
      await js(SETUP);
      await setStyle('quick');
      await standAt(-1, -2);
      await pile();
      await aim(0, -2);
      await sleep(300);
      let p = await panel();
      check('looking at the pile shows its items next to the crosshair (mouse still captured)', !!p && p.mode === 'quick' && p.rows.length >= 4 && (await js<boolean>('cdda.ui2.state().locked')), p?.text);
      check('the most valuable thing is on top? (the list is the pile, first row selected)', p?.sel === 0, p?.rows.map((r) => r.typeId));
      await shot('lootquick_pile');
      const c0 = await js<Record<string, number>>(CENSUS);
      await x().wheel('down', 1);
      await sleep(200);
      p = await panel();
      check('the wheel moves the selection', p?.sel === 1, p?.sel);
      const want = p!.rows[1].typeId;
      await key('e');
      await sleep(300);
      check('e takes the selected thing', (await js<string[]>(`cdda.game.player.inv.items.map((i) => i.typeId)`)).includes(want), want);
      p = await panel();
      check('the panel says what was taken', /Took/.test(p?.text ?? ''), p?.text);
      await key('r');
      await sleep(300);
      const pileLeft = await js<number>(`(() => { const o = window.__lootO; return cdda.game.map.itemsAt(o.x, o.y - 2, o.z).length; })()`);
      check('r takes the rest (Take all): the pile is gone', pileLeft === 0, pileLeft);
      await aim(-1, -3);
      await sleep(400);
      p = await panel();
      check('turning to a cupboard shows the cupboard at once, no open/close', p?.title === 'Cupboard' && p.rows.length > 0, p?.text);
      await shot('lootquick_cupboard');
      const o = await O();
      check('the cupboard now counts as searched (loot memory)', (await js<string>(`cdda.loot.searchState(${o.x - 1}, ${o.y - 3}, ${o.z})`)) === 'searched');
      await key('Tab');
      await sleep(600);
      const on = await js<string>(`document.querySelector('#ui2 [data-id="inv.nearby"] .ui2-tab.on')?.textContent ?? ''`);
      check('Tab opens the full inventory on that cupboard', /cupboard/i.test(on), on);
      await key('Tab');
      await sleep(900);
      await c.toGameplay();
      await key('r');
      await sleep(300);
      check('after r the cupboard is remembered empty', (await js<string>(`cdda.loot.searchState(${o.x - 1}, ${o.y - 3}, ${o.z})`)) === 'empty');
      check('census unchanged through quick loot', sameCounts(c0, await js(CENSUS)).length === 0, sameCounts(c0, await js(CENSUS)));
      // Step back and look at the wall of cupboards: what the markers say from across the room.
      await standAt(-1, 1);
      await aim(-1, -3, 1.6);
      await sleep(600);
      const marks = await js<{ key: string; text: string }[]>('cdda.loot.markers()');
      check('markers: the other cupboards show as "not searched", the emptied one as empty', marks.some((m) => /not searched/.test(m.text)) && marks.some((m) => /empty/.test(m.text)), marks);
      await shot('lootquick_markers');
    }],
    ['lootarea', 'area loot: g opens everything in reach merged by type; it stays open while you walk (WASD) and turn (right-drag); click a row takes that kind', async () => {
      await c.fresh();
      await c.toGameplay();
      await js(SETUP);
      await setStyle('area');
      await standAt(-1, -2);
      await pile();
      await aim(0, -3, 1.2);
      await sleep(300);
      const peek = await panel();
      check('the crosshair shows a read-only peek at what it points at', peek?.mode === 'peek' && peek.rows.length > 0, peek?.text);
      await key('g');
      await sleep(500);
      let a = await js<{ groups: { typeId: string; count: number; sources: string[] }[] } | null>('cdda.loot.area()');
      check('g opens "Loot nearby": the three cupboards and the pile, merged by type', !!a && a.groups.some((g) => g.sources.length >= 3) && a.groups.some((g) => g.typeId === 'glock_19'), a?.groups.map((g) => `${g.typeId}×${g.count}@${g.sources.length}`));
      await shot('lootarea_open');
      const c0 = await js<Record<string, number>>(CENSUS);
      const row = await js<{ x: number; y: number } | null>(`(() => { const e = document.querySelector('#ui2 .la-row[data-type="glock_19"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      if (row) await click(row);
      check('clicking the Glock row takes it', (await js<string[]>('cdda.game.player.inv.items.map((i) => i.typeId)')).includes('glock_19'));
      const y0 = await js<number>('cdda.game.player.y');
      await x().hold('s', 600);
      await sleep(200);
      const y1 = await js<number>('cdda.game.player.y');
      check('S walks backward with the window open', y1 > y0 + 0.3, { y0, y1 });
      const yaw0 = await js<number>('cdda.game.player.yaw');
      await x().moveTo(c.size[0] * 0.3, c.size[1] * 0.5);
      await x().buttonDown(3);
      await x().moveTo(c.size[0] * 0.3 + 200, c.size[1] * 0.5, 10);
      await x().buttonUp(3);
      await sleep(300);
      const yaw1 = await js<number>('cdda.game.player.yaw');
      const menu = await js<string[][]>('cdda.ui2.state().menu');
      check('holding the right mouse button on the world turns the view (no context menu)', Math.abs(yaw1 - yaw0) > 0.2 && !menu.length, { yaw0, yaw1, menu });
      await standAt(-1, 4);
      await sleep(600);
      a = await js('cdda.loot.area()');
      check('the list follows you: the lockers are in it now', !!a && a.groups.length > 0 && a.groups.every((g) => g.sources.every((s) => !/north/.test(s))), a?.groups.map((g) => g.sources.join('/')));
      await shot('lootarea_walked');
      await key('r');
      await sleep(400);
      const res = await js<string>(`document.querySelector('#ui2 .la-result')?.textContent ?? ''`);
      check('r takes all (smart) and says what stayed and why', /Took/.test(res), res);
      await shot('lootarea_takeall');
      const moved = await js<Record<string, number>>(CENSUS);
      check('census unchanged through area loot', sameCounts(c0, moved).length === 0, sameCounts(c0, moved));
      await key('g');
      await sleep(900);
      const s = await js<{ panels: string[]; locked: boolean }>('cdda.ui2.state()');
      check('g closes it and mouse-look is back', !s.panels.includes('loot.area') && s.locked, s);
    }],
    ['lootsweep', 'sweep a room (6 places: 3 cupboards, a pile, 2 lockers) in each looting style; count inputs and time', async () => {
      sweepReport.length = 0;
      for (const s of ['tabs', 'quick', 'area'] as const) await sweep(s);
      console.log('\n  style   aims keys clicks walks  inputs  seconds  emptied');
      for (const r of sweepReport) console.log(`  ${r.style.padEnd(6)} ${String(r.aims).padStart(5)} ${String(r.keys).padStart(4)} ${String(r.clicks).padStart(6)} ${String(r.walks).padStart(5)} ${String(r.aims + r.keys + r.clicks).padStart(7)} ${String(r.seconds).padStart(8)} ${String(r.emptied).padStart(8)}`);
      const by = Object.fromEntries(sweepReport.map((r) => [r.style, r.aims + r.keys + r.clicks]));
      check('quick loot needs fewer inputs than the inventory tabs', by.quick < by.tabs, by);
      check('area loot needs fewer inputs than the inventory tabs', by.area < by.tabs, by);
      await setStyle('quick');
    }],
  ];
}
