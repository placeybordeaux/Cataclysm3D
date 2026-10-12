// Real-input carried-UPS charging scenario, run from tools/realinput.ts:
//   --only upscharge   i → right-click a handheld game → Use ▸ Enable UPS charging; l → 1 waits
//                      20 s and the game fills from the carried UPS at 5 kJ/s (no energy made or
//                      lost); its tooltip says it is charging; Use ▸ Disable UPS charging stops
//                      it; a nearly empty UPS runs dry with one message and the tooltip says why
//                      (src/game/upsTransfer.ts, docs/UPS_TRANSFER.md)
//
// Keys and mouse are OS-level input; cdda.* only hands out the UPS and the game, clears
// monsters, drains the UPS battery for the failure case and reads state.

import { waitFor, type XInput } from './lib/realinput';

export interface UpsCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

interface Energy { game: number; gameCredit: number; ups: number; upsCredit: number; flag: boolean; clock: number }

export function upsScenarios(c: UpsCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  const logTail = (n = 4) => js<string[]>(`cdda.ui.log().slice(-${n})`);
  const energy = () => js<Energy>(`(() => {
    const p = cdda.game.player, all = p.inv.allItems();
    const g = all.find((i) => i.typeId === 'portable_game'), b = all.find((i) => i.typeId === 'heavy_battery_cell');
    return { game: g.ammoRemaining(), gameCredit: Number(g.vars.recharge_kj ?? 0), ups: b.ammoRemaining(), upsCredit: Number(b.vars.recharge_kj ?? 0),
      flag: g.flags.includes('USE_UPS'), clock: cdda.game.clock.seconds };
  })()`);
  const key = async (action: string) => c.x().key(await js<string>(`cdda.game.keys.keysFor(${JSON.stringify(action)})[0]`));
  const menuRow = (re: string) =>
    js<{ x: number; y: number } | null>(`(() => {
      const e = [...document.querySelectorAll('#ui2 .ui2-menu-row')].find((r) => new RegExp(${JSON.stringify(re)}).test(r.querySelector('.ui2-menu-label > span')?.textContent ?? ''));
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.left + Math.min(60, b.width / 2)), y: Math.round(b.top + b.height / 2) };
    })()`);
  const openInventory = async () => {
    await key('inventory2');
    await sleep(800);
  };
  const closeInventory = async () => {
    await c.x().key('Tab');
    await sleep(300);
    await toGameplay();
  };
  /** i is open: right-click the game → Use ▸ `label`. */
  const useMenu = async (label: string, shotName: string) => {
    const r = await js<{ x: number; y: number } | null>(`cdda.inv2.rectOf('portable_game', '#ui2')`);
    check('the handheld game is listed in the inventory', !!r, r);
    if (!r) return false;
    await c.x().click(r.x, r.y, 3);
    await sleep(400);
    const use = await menuRow('^Use$');
    check('its right-click menu has Use ▸', !!use, await js(`cdda.ui2.state().menu`));
    if (!use) return false;
    // Hover Use ▸ and let its submenu open (it does after ~140 ms on hover). A click that lands
    // after the hover opened it can hit the submenu's first row if it was placed over the
    // pointer (it plays the game: "You can't do anything interesting…"); click only if hovering
    // didn't open it.
    const want = `^${label}$`;
    await c.x().moveTo(use.x, use.y, 3);
    let row = await waitFor<{ x: number; y: number } | null>(js, `(() => { const e = [...document.querySelectorAll('#ui2 .ui2-menu-row')].find((r) => new RegExp(${JSON.stringify(want)}).test(r.querySelector('.ui2-menu-label > span')?.textContent ?? '')); return e ? 1 : null; })()`, 1500);
    if (!row) await c.x().click(use.x, use.y);
    await sleep(200);
    row = await menuRow(want);
    await shot(shotName);
    check(`Use ▸ lists "${label}"`, !!row, await js(`[...document.querySelectorAll('#ui2 .ui2-menu-row')].map((e) => e.textContent)`));
    if (!row) return false;
    await c.x().click(row.x, row.y);
    await sleep(500);
    return true;
  };
  /** i is open: hover the game's row and read the tooltip's info note. */
  const tooltip = async (shotName: string) => {
    const r = await js<{ x: number; y: number } | null>(`cdda.inv2.rectOf('portable_game', '#ui2')`);
    if (!r) return '';
    // Come in from off the row: a pointer already resting on it (the last hover was the same
    // row) sends no pointerover, and no tooltip opens. Then wait for the note, not a fixed delay.
    await c.x().moveTo(r.x + 5, r.y - 60, 2);
    await sleep(150);
    await c.x().moveTo(r.x + 5, r.y + 2, 4);
    // (one tooltip element is reused and only hidden between hovers, so it still holds the last
    // item's text: read it only while shown, and only when it is the game's)
    const NOTE = `(() => { const t = document.querySelector('.ui2-tip'); if (!t || t.style.display === 'none' || !/handheld game/.test(t.textContent ?? '')) return ''; return [...t.querySelectorAll('.ui2-itemtip-note.tone-info')].map((e) => e.textContent).join(' | '); })()`;
    const note = await waitFor<string>(js, NOTE, 3000);
    await shot(shotName);
    return note;
  };
  /** l → 1: wait 20 seconds through the Rest window, until the wait is over. */
  const wait20 = async () => {
    await key('wait');
    await sleep(500);
    await c.x().key('1');
    const end = Date.now() + 20000;
    await sleep(600);
    while (Date.now() < end && (await js<boolean>(`!!cdda.game.activities.current`))) await sleep(250);
    await sleep(300);
  };

  return [
    ['upscharge', 'i → Use ▸ Enable UPS charging; a 20 s wait charges the handheld game from the carried UPS at 5 kJ/s; Disable stops it; an empty UPS says so', async () => {
      await toGameplay();
      // Setup only: a UPS holding a heavy battery with exactly 1000 kJ, and an empty handheld game.
      const setup = await js<string>(`(async () => {
        const { createItem, loadAmmo } = await import('/src/game/item.ts');
        const { L, spawnItem } = await import('/src/game/moves.ts');
        cdda.godMode(true); cdda.setHour(12); cdda.clearMonsters(60);
        const p = cdda.game.player, data = cdda.game.data;
        for (const it of p.inv.allItems()) if (it.hasFlag('IS_UPS') || it.hasFlag('USE_UPS')) throw new Error('start kit already has UPS gear: ' + it.typeId);
        cdda.giveItem('backpack', { wear: true });
        const ups = createItem(data, 'UPS_off');
        const bat = createItem(data, 'heavy_battery_cell');
        bat.ammoConsume(bat.ammoRemaining());
        loadAmmo(bat, 'battery', 1000);
        if (!spawnItem(bat, L.mag(ups)).ok) throw new Error('battery did not go into the UPS');
        if (!p.inv.giveNew(ups)) throw new Error('no room for the UPS');
        const game = createItem(data, 'portable_game', { charges: 0 });
        if (!p.inv.giveNew(game)) throw new Error('no room for the game');
        return ups.ammoRemaining() + ' kJ / game ' + game.ammoRemaining();
      })()`);
      const loaded = (await energy()).ups;
      check('setup: a UPS with 1000 kJ and an empty handheld game', loaded === 1000, { setup, loaded });
      const e0 = await energy();
      check('UPS charging starts off for the handheld game', !e0.flag && e0.game === 0, e0);

      await openInventory();
      const tipOff = await tooltip('upscharge_1_tooltip_off');
      check('the tooltip says UPS charging is off and where to turn it on', /UPS charging is off: Use ▸ Enable UPS charging/.test(tipOff), tipOff);
      if (!(await useMenu('Enable UPS charging', 'upscharge_2_enable_menu'))) return;
      const msgOn = (await logTail(3)).join(' | ');
      check('BN message: you will recharge it using any available UPS', /You will recharge the handheld game system using any available Unified Power System\./.test(msgOn), msgOn);
      const e1 = await energy();
      check('the game now carries its own USE_UPS tag', e1.flag, e1);
      await closeInventory();

      await wait20();
      const e2 = await energy();
      const dt = e2.clock - e1.clock;
      const got = e2.game + e2.gameCredit;
      check('a 20 s wait charged it at 5 kJ per game second', dt >= 20 && Math.abs(got - Math.min(200, 5 * dt)) < 0.01, { dt, e1, e2 });
      check('…and the UPS lost exactly what the game gained', Math.abs(e2.ups + e2.upsCredit + got - 1000) < 1e-6, e2);

      // Gameplay runs the clock at 24 game s per real s, so the second or two between the wait
      // and the inventory (which pauses) can top the 200 kJ game right up, and a full game's
      // tooltip rightly says "Fully charged.". Setup: with the inventory open (time paused), take
      // it back to half before hovering it. (The inventory's 400 ms poll sees that change and
      // re-renders its rows, often while the pointer rests on the game waiting for its tooltip:
      // this also covers src/ui2/tooltip.ts finding the replacement row under the pointer.)
      await openInventory();
      await js(`(() => { const g = cdda.game.player.inv.allItems().find((i) => i.typeId === 'portable_game'); if (g.ammoRemaining() > 100) g.ammoConsume(g.ammoRemaining() - 100); })()`);
      const tipOn = await tooltip('upscharge_3_tooltip_charging');
      check('the tooltip says it is charging from your UPS, with its charge', /Charging from your UPS \(\d+\/200/.test(tipOn), tipOn);
      if (!(await useMenu('Disable UPS charging', 'upscharge_4_disable_menu'))) return;
      const msgOff = (await logTail(3)).join(' | ');
      check('BN message: you will no longer recharge it via UPS', /You will no longer recharge the handheld game system via UPS\./.test(msgOff), msgOff);
      await closeInventory();
      const e3 = await energy();
      await wait20();
      const e4 = await energy();
      check('disabled: a 20 s wait leaves both batteries alone', e4.game === e3.game && e4.ups === e3.ups && !e4.flag, { e3, e4 });

      // Failure: a nearly flat UPS (setup drains its battery to 2 kJ), the game re-enabled for real.
      await js(`(() => { const b = cdda.game.player.inv.allItems().find((i) => i.typeId === 'heavy_battery_cell');
        b.ammoConsume(b.ammoRemaining() - 2); delete b.vars.recharge_kj; })()`);
      await js(`(() => { const g = cdda.game.player.inv.allItems().find((i) => i.typeId === 'portable_game'); g.ammoConsume(g.ammoRemaining()); delete g.vars.recharge_kj; })()`);
      await openInventory();
      if (!(await useMenu('Enable UPS charging', 'upscharge_5_reenable_menu'))) return;
      await closeInventory();
      await wait20();
      const e5 = await energy();
      check('a 2 kJ UPS gives 2 kJ and stops', e5.game === 2 && e5.ups === 0 && e5.upsCredit < 1e-9, e5);
      const dry = (await js<string[]>(`cdda.ui.log()`)).filter((l) => /no charge left/.test(l));
      check('one message says the UPS ran dry', dry.length === 1 && /Your UPS has no charge left for your handheld game system\./.test(dry[0]), dry);
      await openInventory();
      const tipDry = await tooltip('upscharge_6_tooltip_out_of_charge');
      check('the tooltip says why it is not charging', /Not charging: your UPS is out of charge\./.test(tipDry), tipDry);
      await closeInventory();
    }],
  ];
}
