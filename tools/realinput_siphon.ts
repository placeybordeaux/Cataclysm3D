// Real-input siphoning scenario, run from tools/realinput.ts:
//   --only siphon   two cars parked side by side, gasoline in car A only, a hose and an empty
//                   jerrycan carried. Walk up to A on the side away from its tank, the world menu
//                   → Examine the Car: "Siphon gasoline …" is listed whatever square the
//                   crosshair picked; siphon into the jerrycan (hose drawn tank → hands, fuel
//                   conserved); from 5 m away the panel says to stand next to the car and Refill
//                   is greyed out; between the cars "Fill nearby vehicle: the red Car to your left" siphons A → B (hose
//                   tank → tank); then Refill pours the jerrycan into B (a stream, all at the end)
//                   (src/game/siphoning.ts, src/game/vehicleRefill.ts, src/render/hoseFx.ts,
//                   docs/SIPHONING.md)
//
// Keys and mouse are OS-level input; cdda.* only clears a lot, parks the cars, puts fuel in A,
// hands out the hose and the can, moves the survivor between phases and reads state.

import { settleWorld, slowNextActivity, type XInput } from './lib/realinput';

export interface SiphonCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

interface Fuel { a: number; b: number; can: number; act: string | null; hose: boolean; px: number; py: number; reachA: boolean; reachB: boolean; log: string[] }

/** 20 L in car A; the jerrycan holds 10 L. */
const START_ML = 20000;

// Setup only: a cleared pavement lot near the start, car A (gasoline) and car B (empty), both
// facing north, B five tiles west of A (a 2.8 m gap between the bodies), so A's tank side (BN car: tank at mount -2,-1, the left
// rear) faces B. `window.__sp` keeps the uids and the lot origin.
const SETUP = `(() => {
  const g = cdda.game, p = g.player, m = g.map, vs = cdda.vehicleSystem;
  // Every monster, not just those within 60 tiles: a zombie bashing a door 69 m off is heard,
  // and a heard noise interrupts the (slowed, so long) siphoning like any activity.
  cdda.godMode(true); cdda.setHour(12); cdda.clearMonsters();
  const grid = g.monsters.grid;
  const clear = (x0, y0) => { for (let y = y0 - 9; y <= y0 + 9; y++) for (let x = x0 - 12; x <= x0 + 10; x++) if (!grid.passable(x, y, p.z) || grid.opaque(x, y, p.z) || g.creatureAt(x, y, p.z)) return false; return true; };
  let spot = null;
  outer: for (let r = 6; r < 160; r += 2) for (let a = 0; a < 32; a++) { const x = Math.floor(p.x + Math.cos(a / 32 * 6.283) * r), y = Math.floor(p.y + Math.sin(a / 32 * 6.283) * r); if (clear(x, y)) { spot = [x, y]; break outer; } }
  if (!spot) return 'no clear lot';
  const [ox, oy] = spot, z = p.z;
  for (const v of [...vs.list]) if (Math.abs(v.x - ox) < 24 && Math.abs(v.y - oy) < 24) vs.remove(v);
  for (let y = oy - 9; y <= oy + 9; y++) for (let x = ox - 12; x <= ox + 10; x++) {
    m.setTer(x, y, z, 't_pavement'); m.setFurn(x, y, z, 'f_null');
    for (const it of [...m.itemsAt(x, y, z)]) m.removeItem(x, y, z, it);
  }
  const park = (x, y) => {
    let v = null;
    // facing that points mount +x (the bonnet) north: try each, keep the one that does
    for (const f of [270, 90, 0, 180]) {
      v = vs.spawn('car', x, y, z, f, { fuel: 0, status: 2, force: true });
      const [fx, fy] = v.mountToWorld(1, 0);
      if (Math.abs(fx - v.x) < 0.1 && fy < v.y - 0.5) break;
      vs.remove(v); v = null;
    }
    if (!v) throw new Error('no facing points the car north');
    v.x = x + 0.5; v.y = y + 0.5; v.velocity = 0; v.engineOn = false;
    for (const q of v.parts) { if (q.def.id.startsWith('door')) q.open = false; if (q.def.flags?.includes?.('FLUIDTANK') || q.fuelType === 'gasoline') q.charges = 0; }
    v.version++; vs.reindex(v);
    return v;
  };
  const a = park(ox, oy), b = park(ox - 5, oy);
  const tanks = (v) => v.parts.filter((q) => q.fuelType === 'gasoline' && q.def.capacity);
  const ta = tanks(a);
  if (ta.length !== 1) return 'car A has ' + ta.length + ' gasoline tanks';
  ta[0].charges = ${START_ML}; a.version++;
  for (const it of p.inv.allItems()) if (it.typeId === 'hose' || it.typeId === 'jerrycan') throw new Error('start kit already has ' + it.typeId);
  cdda.giveItem('backpack', { wear: true });
  const r1 = cdda.giveItem('hose'), r2 = cdda.giveItem('jerrycan');
  window.__sp = { a: a.uid, b: b.uid, ox, oy, z, tankA: a.mountToWorld(ta[0].mx, ta[0].my) };
  return JSON.stringify({ ox, oy, r1, r2, facing: a.facing, tankA: window.__sp.tankA, bodyA: vs.bodyRect(a) });
})()`;

const READ = `(() => {
  const vs = cdda.vehicleSystem, g = cdda.game, p = g.player, s = window.__sp;
  const by = (u) => vs.list.find((q) => q.uid === u);
  const gas = (v) => v.parts.filter((q) => q.fuelType === 'gasoline').reduce((n, q) => n + q.charges, 0);
  const can = p.inv.allItems().find((i) => i.typeId === 'jerrycan');
  return { a: gas(by(s.a)), b: gas(by(s.b)), can: can?.contents[0]?.charges ?? 0, act: g.activities.current?.spec.name ?? null,
    hose: !!cdda.renderer.scene.getObjectByName('hoseFx')?.visible, px: p.x, py: p.y,
    reachA: cdda.reaches(by(s.a)), reachB: cdda.reaches(by(s.b)), log: cdda.ui.log().slice(-4) };
})()`;

export function siphonScenarios(c: SiphonCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  const read = () => js<Fuel>(READ);
  const keyFor = (action: string) => js<string>(`cdda.game.keys.keysFor(${JSON.stringify(action)})[0]`);
  /** Centre of the first visible ui2 element of `sel` whose text matches `re` (and is enabled). */
  const rectOf = (sel: string, re: string, enabled = true) =>
    js<{ x: number; y: number; text: string } | null>(`(() => {
      const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => new RegExp(${JSON.stringify(re)}).test(b.textContent ?? '') && (!${enabled} || !b.disabled) && b.getBoundingClientRect().width > 0);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.left + Math.min(60, r.width / 2)), y: Math.round(r.top + r.height / 2), text: e.textContent };
    })()`);
  const buttons = () => js<string[]>(`[...document.querySelectorAll('#ui2 button')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.textContent + (b.disabled ? ' [disabled' + (b.title ? ': ' + b.title : '') + ']' : ''))`);
  const click = async (sel: string, re: string, what: string) => {
    const r = await rectOf(sel, re);
    if (!check(what, !!r, await buttons())) return false;
    await c.x().click(r!.x, r!.y);
    await sleep(500);
    return true;
  };
  /** The load gate holds the game while the edited lot's chunks rebuild: wait it out. */
  const settle = async () => {
    const w = await settleWorld(js);
    if (!w.ok) check('the lot finished loading (load gate open, chunks built)', false, w);
  };
  /** Setup: stand at world (x, y) looking at (tx, ty), a little down. */
  const stand = async (x: number, y: number, tx: number, ty: number, pitch = -0.3) => {
    await js(`(() => { const p = cdda.game.player; Object.assign(p, { x: ${x}, y: ${y}, yaw: Math.atan2(${tx} - ${x}, -(${ty} - ${y})), pitch: ${pitch} }); })()`);
    await settle();
  };
  /** World menu on what the crosshair looks at → Examine the Car (the vehicle panel). */
  const examine = async (shotName: string) => {
    await c.x().key(await keyFor('world_menu'));
    await sleep(500);
    await shot(shotName);
    return click('#ui2 .ui2-menu-row', '^Examine the Car', 'the world menu offers "Examine the Car"');
  };
  /**
   * Mid-activity screenshots at the cameras a player has: first person as left, then the mouse
   * turns to look at the hose's `toward` end, then the shoulder and top-down cameras
   * (camera_mode, cycled back to first person). The activity's clock warp would end it in 2–8
   * real seconds, so setup slows the clock (24 game s per real s at warp 1) to about real time for the pictures
   * and speeds it up after. The slowing starts with the activity itself (`slowNextActivity`, armed
   * before the click or key that starts it): set here, after closing the menu, it came too late
   * on a busy machine and the activity had already finished.
   */
  const during = async (name: string, toward: 'from' | 'to') => {
    const seen: Fuel[] = [];
    const look = async (tag: string) => {
      const f = await read();
      seen.push(f);
      if (f.act) await shot(`${name}_${tag}`);
    };
    await sleep(500);
    await look('a_first_person');
    // How far to turn (yaw, pitch) to look a little below that end of the hose from eye height.
    const turn = await js<[number, number]>(`(() => {
      const s = cdda.game.activities.current?.spec.hose, p = cdda.game.player, e = s?.${toward}();
      if (!e) return [0, 0];
      const d = Math.atan2(e.x - p.x, -(e.y - p.y)) - p.yaw;
      return [Math.atan2(Math.sin(d), Math.cos(d)), Math.atan2(e.h - 1.6, Math.hypot(e.x - p.x, e.y - p.y)) - 0.15 - p.pitch];
    })()`);
    const sens = await js<number>('cdda.game.mouseSensitivity');
    await c.x().move(Math.round(turn[0] / sens), Math.round(-turn[1] / sens), 12);
    await sleep(500);
    await look('b_looking_at_hose');
    const cam = await keyFor('camera_mode');
    for (const tag of ['c_shoulder', 'd_top_down']) {
      await c.x().key(cam);
      await sleep(700);
      await look(tag);
    }
    await c.x().key(cam);
    await sleep(300);
    check(`${name}: back in first person`, (await js<string>('cdda.renderer.cameraMode')) === 'first', await js('cdda.renderer.cameraMode'));
    await js(`cdda.game.activities.current && (cdda.game.clock.warp = 30)`);
    return seen;
  };
  const finish = async () => {
    const end = Date.now() + 20000;
    while (Date.now() < end && (await js<boolean>(`!!cdda.game.activities.current`))) await sleep(250);
    await sleep(300);
    return read();
  };

  return [
    ['siphon', 'siphon car A into a jerrycan and into car B with a hose, refill B from the can; the hose and pour are drawn; fuel conserved; too far says so', async () => {
      await toGameplay();
      const set = await js<string>(SETUP);
      // cdda.reaches: the game's own hose reach rule, for reading state only.
      await js(`(async () => { const { playerReaches } = await import('/src/game/refuel.ts'); cdda.reaches = (v) => playerReaches(cdda.game, v); })()`);
      const sp = await js<{ ox: number; oy: number; tankA: [number, number] } | undefined>(`window.__sp`);
      if (!check('setup: two cars on a cleared lot, 20 L in A, hose and empty jerrycan carried', !!sp, set)) return;
      console.log('   setup', set);
      const f0 = await read();
      check('A holds 20 L, B and the can are empty', f0.a === START_ML && f0.b === 0 && f0.can === 0, f0);
      const { ox, oy } = sp!;

      // --- 1. walk up to A's right (east) side, away from its tank, and siphon into the can
      await stand(ox + 7.5, oy + 2, ox + 0.5, oy + 2);
      await sleep(600);
      await c.x().down('w');
      for (let i = 0; i < 40 && !(await read()).reachA; i++) await sleep(100);
      await c.x().up('w');
      await sleep(400);
      const f1 = await read();
      check('walking toward A brings the hose within reach of it', f1.reachA, f1);
      check('…from the side away from its tank', f1.px > ox + 1.5, f1);
      await shot('siphon_01_beside_car_a');
      if (!(await examine('siphon_02_world_menu'))) return;
      await shot('siphon_03_vehicle_panel');
      const sel = await js<string>(`[...document.querySelectorAll('#ui2 .ui2-win')].map((w) => w.textContent).join(' ').match(/Square -?\\d+,-?\\d+[^A-Z]*/)?.[0] ?? ''`);
      check('the selected square is not the tank\'s (-2,-1)', !/Square -2,-1/.test(sel), sel);
      if (!(await click('#ui2 button', '^Siphon gasoline \\(20\\.0 L in the', 'the vehicle panel lists "Siphon gasoline (20.0 L in the …)"'))) return;
      await shot('siphon_04_siphon_panel');
      await slowNextActivity(js, 0.04);
      if (!(await click('#ui2 button', '^Fill (plastic )?jerrycan', 'the siphon panel offers "Fill jerrycan (…)"'))) return;
      await toGameplay();
      const mid1 = await during('siphon_05_into_can', 'from');
      check('the hose is drawn while siphoning into the can', mid1.some((f) => f.act && f.hose), mid1);
      check('mid-siphon: no fuel made or lost', mid1.every((f) => f.a + f.b + f.can === START_ML), mid1);
      const f2 = await finish();
      check('the can took 10 L from A, nothing else changed', f2.can === 10000 && f2.a === 10000 && f2.b === 0, f2);
      check('BN-rate message: You siphon 10.00 L into the plastic jerrycan.', f2.log.some((l) => /You siphon 10\.00 L into the (plastic )?jerrycan\./.test(l)), f2.log);
      check('the hose is gone when the activity ends', !f2.hose, f2);

      // --- 2. too far: 5 m east of A
      await stand(ox + 6.5, oy + 0.5, ox + 0.5, oy + 0.5);
      await sleep(500);
      if (await examine('siphon_06_far_world_menu')) {
        const refill = await buttons();
        check('from 5 m, Refill is greyed out', refill.some((b) => /^Refill from your (plastic )?jerrycan .*\[disabled/.test(b)), refill);
        if (await click('#ui2 button', '^Siphon gasoline', 'from 5 m the Siphon action is still listed')) {
          await shot('siphon_07_too_far');
          const txt = await js<string>(`[...document.querySelectorAll('#ui2 .ui2-win')].map((w) => w.textContent).join(' ')`);
          check('…and its panel says "Stand next to the Car to reach it with the hose."', txt.includes('Stand next to the Car to reach it with the hose.'), txt.slice(0, 300));
          check('…with no fill buttons', !(await rectOf('#ui2 button', '^Fill ')), await buttons());
        }
      }
      await toGameplay();

      // --- 3. between the cars: siphon A → B through the hose
      await stand(ox - 1.6, oy + 4.5, ox - 1.6, oy + 0.5, -0.25);
      await sleep(400);
      await c.x().down('w');
      for (let i = 0; i < 80 && (await read()).py > oy + 0.9; i++) await sleep(100);
      await c.x().up('w');
      await sleep(300);
      await stand((await read()).px, (await read()).py, ox + 0.5, oy - 0.5, -0.3);
      await sleep(400);
      const f3 = await read();
      check('between the cars the hose reaches both', f3.reachA && f3.reachB, f3);
      if (await examine('siphon_08_between_world_menu')) {
        if (await click('#ui2 button', '^Siphon gasoline \\(10\\.0 L', 'A lists "Siphon gasoline (10.0 L …)"')) {
          await shot('siphon_09_siphon_panel_vehicle');
          const focused = await js<string>(`document.activeElement?.textContent ?? ''`);
          check('the panel offers "Fill nearby vehicle: the <colour> Car <direction> (10.00 L)", focused', /^Fill nearby vehicle: the (\w+ )?Car (ahead|to your left|to your right|behind you)( \(\d+ m\))? \(10\.00 L\)/.test(focused), { focused, buttons: await buttons() });
          // Keyboard this time: Enter takes the focused choice.
          await slowNextActivity(js, 0.04);
          await c.x().key('Return');
          await sleep(500);
          if (check('Enter starts siphoning into the other car', /^siphoning gasoline into the (\w+ )?Car/.test((await read()).act ?? ''), await read())) {
            await toGameplay();
            const mid2 = await during('siphon_10_car_to_car', 'from');
            check('the hose is drawn while siphoning car to car', mid2.some((f) => f.act && f.hose), mid2);
            check('mid-transfer: no fuel made or lost', mid2.every((f) => f.a + f.b + f.can === START_ML), mid2);
            const f4 = await finish();
            check('B took A\'s last 10 L', f4.a === 0 && f4.b === 10000 && f4.can === 10000, f4);
            check('message: You siphon 10.00 L into the <colour> Car <direction>.', f4.log.some((l) => /You siphon 10\.00 L into the (\w+ )?Car( (ahead|to your left|to your right|behind you))?( \(\d+ m\))?\./.test(l)), f4.log);
          }
        }
      }
      await toGameplay();

      // --- 4. refill B from the jerrycan: turn to B
      const p4 = await read();
      await stand(p4.px, p4.py, ox - 5.5, oy - 0.5, -0.3);
      await sleep(400);
      if (await examine('siphon_11_world_menu_b')) {
        const before = await read();
        await slowNextActivity(js, 0.04);
        if (await click('#ui2 button', '^Refill from your (plastic )?jerrycan \\(10\\.00 L gasoline\\)', 'B offers "Refill from your (plastic )?jerrycan (10.00 L gasoline)"')) {
          await toGameplay();
          const mid3 = await during('siphon_12_pour', 'to');
          check('the pour stream is drawn mid-refill', mid3.some((f) => f.act && f.hose), mid3);
          check('mid-pour: nothing moved yet (BN pours at the end)', mid3.filter((f) => f.act).every((f) => f.b === before.b && f.can === before.can), mid3);
          const f5 = await finish();
          check('the jerrycan emptied into B', f5.can === 0 && f5.b === 20000 && f5.a === 0, f5);
          check('message: You pour 10.00 L of gasoline into the Car.', f5.log.some((l) => /You pour 10\.00 L of gasoline into the Car\./.test(l)), f5.log);
        }
      }
      await toGameplay();
    }],
  ];
}
