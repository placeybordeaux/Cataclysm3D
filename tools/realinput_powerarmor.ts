// Real-input power armor scenario, run from tools/realinput.ts:
//   --only powerarmor   i → right-click the worn exoskeleton → Activate: it engages with the plating
//                       and helmet (BN messages); its tooltip says it draws from the UPS; a wait
//                       drains the UPS at 2.75 kJ/s (exo + helmet). Right-click the plating → Turn
//                       off says "Activate via main piece.". p → switch the Power Armor Interface
//                       on: the next wait is paid from bionic power at half cost and the UPS is
//                       untouched. With both nearly empty the suit shuts down with BN's message;
//                       Activate then refuses (src/game/powerArmor.ts, docs/BN_POWER_ARMOR.md).
//
// Keys and mouse are OS-level input; cdda.* only hands out the suit, the UPS and the CBM, sets
// the battery / bionic power levels for the failure case, clears monsters and reads state.

import type { XInput } from './lib/realinput';

export interface PowerArmorCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

interface Suit { exo: string; plating: string; helmet: string; active: boolean[]; ups: number; owed: number; bio: number; clock: number; str: number }

export function powerArmorScenarios(c: PowerArmorCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  const logTail = (n = 4) => js<string[]>(`cdda.ui.log().slice(-${n})`);
  const suit = () => js<Suit>(`(() => {
    const p = cdda.game.player, w = p.inv.worn;
    const f = (re) => w.find((i) => re.test(i.typeId));
    const exo = f(/^power_armor_exo_1/), plating = f(/^power_armor_plating_1/), helmet = f(/^power_armor_helmet_basic/);
    return { exo: exo.typeId, plating: plating.typeId, helmet: helmet.typeId, active: [exo.active, plating.active, helmet.active],
      ups: p.inv.upsCharges(), owed: [exo, helmet].reduce((n, i) => n + Number(i.vars.power_armor_kj ?? 0), 0),
      bio: cdda.bionics().power, clock: cdda.game.clock.seconds, str: p.str };
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
  /** i is open: right-click `typeId` → `label`. */
  const itemMenu = async (typeId: string, label: string, shotName: string) => {
    const r = await js<{ x: number; y: number } | null>(`cdda.inv2.rectOf(${JSON.stringify(typeId)}, '#ui2')`);
    check(`the ${typeId} is listed in the inventory`, !!r, r);
    if (!r) return false;
    await c.x().click(r.x, r.y, 3);
    await sleep(400);
    const row = await menuRow(`^${label}$`);
    await shot(shotName);
    check(`its right-click menu has "${label}"`, !!row, await js(`[...document.querySelectorAll('#ui2 .ui2-menu-row')].map((e) => e.textContent)`));
    if (!row) return false;
    await c.x().click(row.x, row.y);
    await sleep(500);
    return true;
  };
  /** i is open: hover `typeId` and read the tooltip's note. */
  const tooltip = async (typeId: string, shotName: string) => {
    const r = await js<{ x: number; y: number } | null>(`cdda.inv2.rectOf(${JSON.stringify(typeId)}, '#ui2')`);
    if (!r) return '';
    await c.x().moveTo(r.x + 5, r.y + 2, 4);
    await sleep(1300);
    const note = await js<string>(`[...document.querySelectorAll('.ui2-itemtip-note')].map((e) => e.textContent).join(' | ')`);
    await shot(shotName);
    return note;
  };
  /** l → 1: the shortest wait in the Rest window, until it is over. */
  const wait = async () => {
    await key('wait');
    await sleep(500);
    await c.x().key('1');
    const end = Date.now() + 30000;
    await sleep(600);
    while (Date.now() < end && (await js<boolean>(`!!cdda.game.activities.current`))) await sleep(250);
    await sleep(300);
  };

  return [
    ['powerarmor', 'i → Activate the worn exoskeleton: plating + helmet switch on, the UPS pays 2.75 kJ/s; p → interface on: bionic power pays half; empty → it shuts down', async () => {
      await toGameplay();
      // Setup only: strip the start kit, wear the suit, carry a UPS with 300 kJ.
      const setup = await js<string>(`(async () => {
        const { createItem, loadAmmo } = await import('/src/game/item.ts');
        const { L, spawnItem } = await import('/src/game/moves.ts');
        cdda.godMode(true); cdda.setHour(12); cdda.clearMonsters(60);
        const p = cdda.game.player, data = cdda.game.data;
        if (p.inv.wielded) p.inv.drop(p.inv.wielded);
        for (const it of [...p.inv.worn, ...p.inv.items]) p.inv.drop(it);
        const out = ['power_armor_exo_1', 'power_armor_plating_1', 'power_armor_helmet_basic'].map((id) => cdda.giveItem(id, { wear: true }));
        const ups = createItem(data, 'UPS_off');
        const bat = createItem(data, 'heavy_battery_cell');
        bat.ammoConsume(bat.ammoRemaining());
        loadAmmo(bat, 'battery', 300);
        if (!spawnItem(bat, L.mag(ups)).ok) throw new Error('battery did not go into the UPS');
        if (!p.inv.giveNew(ups)) throw new Error('no room for the UPS');
        return out.join(' / ');
      })()`);
      const s0 = await suit();
      check('setup: the suit is worn and off, a UPS holds 300 kJ', s0.exo === 'power_armor_exo_1' && s0.ups === 300 && !s0.active.some(Boolean), { setup, s0 });

      await openInventory();
      const tipOff = await tooltip('power_armor_exo_1', 'powerarmor_1_tooltip_off');
      check('the exoskeleton tooltip says it is off and how to power it', /Off: Activate it to power the suit/.test(tipOff), tipOff);
      if (!(await itemMenu('power_armor_exo_1', 'Activate', 'powerarmor_2_activate_menu'))) return;
      const msgOn = (await logTail(3)).join(' | ');
      check('BN messages: the exoskeleton engages, the helmet seals, the plating feels lighter',
        /The prototype power armor exoskeleton engages\. \| The power armor helmet seals shut and beeps once\. \| The heavy power armor plating feels lighter\./.test(msgOn), msgOn);
      const s1 = await suit();
      check('all three pieces are now their active types', s1.exo === 'power_armor_exo_1_on' && s1.plating === 'power_armor_plating_1_on' && s1.helmet === 'power_armor_helmet_basic_on' && s1.active.every(Boolean), s1);
      const tipOn = await tooltip('power_armor_exo_1_on', 'powerarmor_3_tooltip_on_ups');
      check('the tooltip says it draws 2.25 kJ/s from the UPS', /On: draws 2\.25 kJ\/s from your UPS/.test(tipOn), tipOn);
      // Examine shows the relic passive effects (BN item::enchantment_info, src/game/relicEnchant.ts).
      if (!(await itemMenu('power_armor_exo_1_on', 'Examine', 'powerarmor_3b_examine_menu'))) return;
      const card = await js<string>(`document.querySelector('#ui2 .bn-examine')?.textContent ?? document.querySelector('.bn-examine')?.textContent ?? ''`);
      await shot('powerarmor_3c_examine_enchantments');
      check('Examine lists the passive effects: "While active and While worn (in effect)", Strength +2, climate control +4 °C',
        /While active and While worn \(in effect\)/.test(card) && /Affects Strength \(\+2\)/.test(card) && /Keeps you comfortable against .* \(\+4 °C\)/.test(card), card.slice(card.indexOf('While') - 20, card.indexOf('While') + 160));
      const cc = await js<{ torso: number; arm: number; at45: number }>(`(() => { const p = cdda.game.player;
        return { torso: p.enchant('CLIMATE_CONTROL_COOLING_TORSO').add, arm: p.enchant('CLIMATE_CONTROL_COOLING_ARM_L').add, at45: p.climateCorrected(45, 'arm_l') }; })()`);
      check('climate control is on: 4000 legacy (8 °C) on the torso, 2000 (4 °C) on the arms; 45 °C → 41 °C on an arm', cc.torso === 4000 && cc.arm === 2000 && Math.abs(cc.at45 - 41) < 1e-9, cc);
      await c.x().key('Escape');
      await sleep(400);
      // A piece can't be switched on its own.
      if (!(await itemMenu('power_armor_plating_1_on', 'Turn off', 'powerarmor_4_plating_menu'))) return;
      const msgPiece = (await logTail(1))[0];
      check('BN: the plating says "Activate via main piece."', msgPiece === 'Activate via main piece.', msgPiece);
      await closeInventory();
      check('active power armor adds +2 Strength (relic passive effect, WORN + ACTIVE)', (await suit()).str === s0.str + 2, { before: s0.str, after: (await suit()).str });

      const e1 = await suit();
      await wait();
      const e2 = await suit();
      const dt = e2.clock - e1.clock;
      check('a wait drains the UPS at 2.75 kJ/s (paid + owed = draw × time)', dt > 0 && Math.abs(e1.ups - e2.ups + e2.owed - e1.owed - 2.75 * dt) < 1e-6, { dt, e1, e2 });

      // The armor interface: installed by setup, switched on for real in the bionics panel.
      await js(`(() => { cdda.installBionic('bio_power_storage'); cdda.installBionic('bio_power_armor_interface'); cdda.givePower(100); })()`);
      await key('bionics');
      await sleep(800);
      const sw = await js<{ x: number; y: number } | null>(`(() => {
        const row = [...document.querySelectorAll('#ui2 .ix-switch')][0];
        if (!row) return null;
        const b = row.getBoundingClientRect();
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
      })()`);
      check('the bionics panel shows a switch for the Power Armor Interface', !!sw, sw);
      if (!sw) return;
      await c.x().click(sw.x, sw.y);
      await sleep(400);
      await shot('powerarmor_5_interface_on');
      const on = await js<boolean>(`cdda.bionics().installed.some((b) => b.id === 'bio_power_armor_interface' && b.powered)`);
      check('clicking the switch powers the interface', on);
      await toGameplay();
      await openInventory();
      const tipBio = await tooltip('power_armor_exo_1_on', 'powerarmor_6_tooltip_on_bionic');
      check('the tooltip now says it runs on bionic power through the interface', /from your bionic power through your armor interface/.test(tipBio), tipBio);
      await closeInventory();
      const b1 = await suit();
      await wait();
      const b2 = await suit();
      const bdt = b2.clock - b1.clock;
      check('the interface pays first: the UPS is untouched, bionic power drops by draw / 2',
        b2.ups === b1.ups && bdt > 0 && Math.abs(2 * (b1.bio - b2.bio) + b2.owed - b1.owed - 2.75 * bdt) < 1e-3, { bdt, b1, b2 });

      // Failure: both sources nearly empty (setup sets the levels); the suit shuts itself down.
      await js(`(() => { const p = cdda.game.player; const bat = p.inv.allItems().find((i) => i.typeId === 'heavy_battery_cell');
        bat.ammoConsume(bat.ammoRemaining() - 3); delete bat.vars.recharge_kj; cdda.givePower(-cdda.bionics().power + 1); })()`);
      await wait();
      const s3 = await suit();
      const log = await js<string[]>(`cdda.ui.log()`);
      check('out of power: everything reverts and switches off', s3.exo === 'power_armor_exo_1' && s3.plating === 'power_armor_plating_1' && s3.helmet === 'power_armor_helmet_basic' && !s3.active.some(Boolean), s3);
      check('BN message: You need a UPS or Bionic Power Interface to run the …!', log.some((l) => /^You need a UPS or Bionic Power Interface to run the (prototype power armor exoskeleton|power armor helmet) \(active\)!$/.test(l)), log.slice(-6));
      await shot('powerarmor_7_shut_down');
      check('nothing made or lost: the UPS and bionic power are spent', s3.ups === 0 && s3.bio < 0.5, s3);
      await openInventory();
      if (!(await itemMenu('power_armor_exo_1', 'Activate', 'powerarmor_8_activate_again'))) return;
      const msgNo = (await logTail(1))[0];
      check('Activate with no power refuses with BN\'s message', /^You need a UPS or a bionic armor interface to power this\./.test(msgNo), msgNo);
      check('…and the suit stays off', !(await suit()).active.some(Boolean));
      await shot('powerarmor_9_refused');
      await closeInventory();
    }],
  ];
}
