// Real-input towing scenario, run from tools/realinput.ts:
//   --only towing   for a pickup and then the M1 Abrams: a cleared paved lot, the tower parked
//                   facing north with a car 2.6 m behind it, a heavy duty tow cable carried.
//                   Standing in the gap: the world menu → Examine the tower → click its rear
//                   square → "Attach a tow cable here"; turn round with the mouse (the loose end
//                   is drawn from the hook to your hand); the world menu → Examine the Car → its
//                   front square → "Attach the tow cable's loose end here". Then at the wheel,
//                   W held (V: top-down), D held through a right-angle turn, W on, a frame every
//                   ~0.4 s: the cable sags while slack, goes straight, the car swings in behind.
//                   Last, parked: Examine → "Detach the tow cable" gives the cable back.
//                   (src/game/towing.ts, src/towing.ts, src/render/towFx.ts, docs/VEHICLES.md "Towing")
//
// Keys and mouse are OS-level input; cdda.* only clears the lot, parks the vehicles, hands out
// the cable, stands you in the gap, seats you at the wheel and reads state.

import { settleWorld, type XInput } from './lib/realinput';

export interface TowingCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

// Setup only: pave a 88 x 88 m lot of open fields near the start,
// park `proto` at its south end facing north and a car 2.6 m of paint behind it, give a backpack
// and a tow cable. window.__tw keeps the uids.
const setup = (proto: string) => `(() => {
  const g = cdda.game, p = g.player, m = g.map, vs = cdda.vehicleSystem;
  if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); }
  for (const l of [...vs.towing.links]) vs.towing.unlink(l, 'drop');
  cdda.godMode(true); cdda.setHour(12); cdda.clearMonsters(80);
  const H = 44;
  // A 4 x 4 block of open-field OMTs near the start, from the overmap (generating candidate
  // areas to look at them cost the page gigabytes): paved over, nothing above it.
  const gen = (x0, y0) => { for (let cy = Math.floor((y0 - H) / 24); cy <= Math.floor((y0 + H) / 24); cy++) for (let cx = Math.floor((x0 - H) / 24); cx <= Math.floor((x0 + H) / 24); cx++) for (let dz = 0; dz <= 1; dz++) m.chunk(cx, cy, p.z + dz); };
  let spot = window.__twSpot ?? null;
  if (!spot) {
    const px = Math.floor(p.x / 24), py = Math.floor(p.y / 24);
    const field = (x, y) => /^field/.test(cdda.omtAt(x, y, p.z).id);
    outer: for (let r = 2; r < 40; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      let ok = true;
      for (let j = 0; j < 4 && ok; j++) for (let i = 0; i < 4 && ok; i++) ok = field(px + dx + i, py + dy + j);
      if (ok) { spot = [(px + dx) * 24 + 48, (py + dy) * 24 + 48]; break outer; }
    }
  }
  if (!spot) return 'no 4x4 block of fields within 40 OMTs';
  window.__twSpot = spot;
  const [ox, oy] = spot, z = p.z;
  gen(ox, oy);
  for (const v of [...vs.list]) if (Math.abs(v.x - ox) < H + 10 && Math.abs(v.y - oy) < H + 10) vs.remove(v);
  for (let y = oy - H; y <= oy + H; y++) for (let x = ox - H; x <= ox + H; x++) {
    // (only what changes: every edit re-meshes its chunk, and four levels of a 90 m lot is a lot of meshing)
    if (m.terAt(x, y, z).id !== 't_pavement') m.setTer(x, y, z, 't_pavement');
    if (m.furnAt(x, y, z).id !== 'f_null') m.setFurn(x, y, z, 'f_null');
    if (m.terAt(x, y, z + 1).id !== 't_open_air') m.setTer(x, y, z + 1, 't_open_air');
    for (const it of [...m.itemsAt(x, y, z)]) m.removeItem(x, y, z, it);
  }
  const north = (id, x, y) => {
    let v = null;
    for (const f of [270, 90, 0, 180]) {
      v = vs.spawn(id, x, y, z, f, { fuel: 100, status: 0, force: true });
      const [fx, fy] = v.mountToWorld(1, 0);
      if (Math.abs(fx - v.x) < 0.1 && fy < v.y - 0.5) break;
      vs.remove(v); v = null;
    }
    if (!v) throw new Error('no facing points ' + id + ' north');
    v.x = x + 0.5; v.y = y + 0.5; v.velocity = 0; v.engineOn = false; v.locked = false;
    for (const q of v.parts) if (q.def.flags.includes('OPENABLE')) q.open = false;
    v.version++; vs.reindex(v);
    return v;
  };
  const t = north(${JSON.stringify(proto)}, ox, oy + 25);
  const tb = vs.physRect(t), car = north('car', ox, oy + 40), cb = vs.physRect(car);
  // facing north: mount -x is south. Car's nose 2.6 m south of the tower's tail.
  car.y = t.y - tb.x0 + 2.6 + cb.x1; vs.reindex(car); car.version++;
  if (!p.inv.worn.some((i) => i.typeId === 'backpack')) cdda.giveItem('backpack', { wear: true });
  if (!cdda.towing.carried()) cdda.towing.giveCable();
  // stand in the gap, looking north at the tower's tail
  Object.assign(p, { x: t.x, y: t.y - tb.x0 + 1.3, z, yaw: 0, pitch: -0.45 });
  window.__tw = { tower: t.uid, car: car.uid, towerName: t.name };
  return JSON.stringify({ ox, oy, tower: t.name, mass: [Math.round(t.mass()), Math.round(car.mass())], gap: car.y - cb.x1 - (t.y - tb.x0) });
})()`;

interface Read {
  link: { dist: number; taut: boolean; tensionKN: number; towedFacing: number; towerFacing: number; towedMph: number } | null;
  loose: unknown; carried: unknown; mph: number; facing: number; carY: number; carX: number; act: string | null; cables: number; log: string[];
}
const READ = `(() => {
  const vs = cdda.vehicleSystem, s = window.__tw, by = (u) => vs.list.find((q) => q.uid === u);
  const t = by(s.tower), car = by(s.car), l = cdda.towing.links()[0] ?? null;
  return { link: l, loose: cdda.towing.loose(), carried: cdda.towing.carried(), mph: t.velocity * 2.2369363, facing: t.facing, carX: car.x, carY: car.y,
    act: cdda.game.activities.current?.spec.name ?? null, cables: cdda.renderer.scene.getObjectByName('towFx')?.children.filter((c) => c.name === 'towCable').length ?? 0,
    log: cdda.ui.log().slice(-4) };
})()`;

export function towingScenarios(c: TowingCtx): Scenario[] {
  const { js, check, shot, sleep } = c;
  const read = () => js<Read>(READ);
  const keyFor = (action: string) => js<string>(`cdda.game.keys.keysFor(${JSON.stringify(action)})[0]`);
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
  /** The vehicle panel's diagram square (mx, my) of the open panel. */
  const clickCell = async (mx: number, my: number, what: string) => {
    const r = await js<{ x: number; y: number } | null>(`(() => {
      const e = document.querySelector('#ui2 .ix-vcell[data-mx="${mx}"][data-my="${my}"]');
      if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!check(what, !!r)) return false;
    await c.x().click(r!.x, r!.y);
    await sleep(400);
    return true;
  };
  const examine = async (name: string, tag: string) => {
    await c.x().key(await keyFor('world_menu'));
    await sleep(500);
    await shot(`${tag}_world_menu`);
    return click('#ui2 .ui2-menu-row', `^Examine the ${name}`, `the world menu offers "Examine the ${name}"`);
  };
  /** Turn with the real mouse until the yaw is within 0.12 rad of `target`. */
  const turnTo = async (target: number) => {
    for (let i = 0; i < 12; i++) {
      const yaw = await js<number>(`cdda.game.player.yaw`);
      const d = Math.atan2(Math.sin(target - yaw), Math.cos(target - yaw));
      if (Math.abs(d) < 0.12) return true;
      await c.x().move(Math.max(-400, Math.min(400, d * 260)), 0, 8);
      await sleep(120);
    }
    return false;
  };
  /**
   * Tilt the view with the real mouse to `target` pitch. (Setting cdda.game.player.pitch from
   * the debug API while the mouse is captured hung the page in this scenario, 4 runs out of 4,
   * towing code on or off: see the report. A player tilts with the mouse anyway.)
   */
  const lookPitch = async (target: number) => {
    for (let i = 0; i < 12; i++) {
      const pitch = await js<number>(`cdda.game.player.pitch`);
      const d = target - pitch;
      if (Math.abs(d) < 0.06) return true;
      await c.x().move(0, Math.max(-300, Math.min(300, -d * 260)), 6);
      await sleep(120);
    }
    return false;
  };
  const camera = async (mode: 'first' | 'third' | 'top') => {
    for (let i = 0; i < 4 && (await js<string>(`cdda.renderer.rig.mode`)) !== mode; i++) {
      await c.x().key('v');
      await sleep(250);
    }
    return (await js<string>(`cdda.renderer.rig.mode`)) === mode;
  };

  const towRun = async (proto: string, tag: string) => {
    await camera('first');
    const s = await js<string>(setup(proto));
    if (!check(`${tag}: setup (paved lot, ${proto} with a car 2.6 m behind, cable carried)`, s.startsWith('{'), s)) return;
    const name = await js<string>(`window.__tw.towerName`);
    const w = await settleWorld(js);
    if (!w.ok) check(`${tag}: the lot finished loading`, false, w);
    await c.toGameplay();
    await shot(`${tag}_01_gap`);

    // --- first end on the tower's tail (the world menu, the panel, a click on its rear square)
    const hookA = await js<{ uid: number; mx: number; my: number; side: string } | undefined>(`cdda.towing.reach().find((h) => h.uid === window.__tw.tower)`);
    if (!check(`${tag}: the tower's ${'rear'} is in reach from the gap`, hookA?.side === 'rear', await js(`cdda.towing.reach()`))) return;
    if (!(await examine(name, `${tag}_02`))) return;
    await clickCell(hookA!.mx, hookA!.my, `${tag}: the panel shows the tower's rear square`);
    await shot(`${tag}_03_panel_attach`);
    if (!(await click('#ui2 button', '^Attach a tow cable here', `${tag}: the panel offers "Attach a tow cable here, the rear (this vehicle will tow)"`))) return;
    let r = await read();
    check(`${tag}: one end on the tower, the loose end carried`, !!r.loose && !!r.carried, r);
    await c.toGameplay();

    // --- turn round (real mouse) and hook the loose end on the car's nose
    // a quarter turn first (mouse), to see the loose end run from the hook to your hand
    await turnTo(Math.PI / 2);
    await lookPitch(-0.6);
    await sleep(300);
    r = await read();
    check(`${tag}: the loose end is drawn from the hook to your hand`, r.cables === 1, r);
    await shot(`${tag}_04_loose_end`);
    check(`${tag}: turned round to face the car (mouse)`, await turnTo(Math.PI));
    await lookPitch(-0.45);
    const hookB = await js<{ uid: number; mx: number; my: number; side: string } | undefined>(`cdda.towing.reach().find((h) => h.uid === window.__tw.car)`);
    if (!check(`${tag}: the car's front is in reach`, hookB?.side === 'front', await js(`cdda.towing.reach()`))) return;
    if (!(await examine('Car', `${tag}_05`))) return;
    await clickCell(hookB!.mx, hookB!.my, `${tag}: the panel shows the car's front square`);
    await shot(`${tag}_06_panel_loose_end`);
    if (!(await click('#ui2 button', "^Attach the tow cable's loose end here", `${tag}: the panel offers "Attach the tow cable's loose end here"`))) return;
    r = await read();
    check(`${tag}: linked (the tower tows the car); the cable left your pack`, !!r.link && !r.carried && !r.loose && r.log.some((m) => /You link up the/.test(m)), r);
    await c.toGameplay();
    // look down at the slack cable on the road
    await lookPitch(-0.75);
    await sleep(400);
    await shot(`${tag}_07_slack_cable`);

    // --- drive: seated at the wheel (setup), then real W / D
    const seat = await js<unknown>(`cdda.enterVehicle(window.__tw.tower)`);
    check(`${tag}: at the wheel of the ${name} (setup)`, !!seat, seat);
    await c.toGameplay();
    check(`${tag}: top-down camera (V)`, await camera('top'));
    // zoom out (mouse wheel) so the tower and the car both stay in the frame
    await c.x().wheel('down', 6);
    const car0 = await read();
    let maxDist = 0, frame = 0, tautSeen = false, slackSeen = false;
    const snap = async (what: string) => {
      const q = await read();
      if (q.link) {
        maxDist = Math.max(maxDist, q.link.dist);
        if (q.link.taut) tautSeen = true;
        else slackSeen = true;
      }
      await shot(`${tag}_drive_${String(frame++).padStart(2, '0')}_${what}`);
      return q;
    };
    await c.x().down('w');
    try {
      for (let i = 0; i < 9; i++) (await snap('straight'), await sleep(250));
      const f0 = (await read()).facing;
      await c.x().down('d');
      try {
        for (let i = 0; i < 40; i++) {
          const q = await snap('turn');
          if (Math.abs(((q.facing - f0 + 540) % 360) - 180) >= 88) break;
          await sleep(200);
        }
      } finally {
        await c.x().up('d');
      }
      for (let i = 0; i < 7; i++) (await snap('after_turn'), await sleep(250));
    } finally {
      await c.x().up('w');
    }
    // (the alignment is read before braking: braking slackens the cable and the car may roll in at an angle)
    const rolling = await read();
    await c.x().hold('Space', 2500);
    r = await read();
    const turned = r.link ? Math.abs(((r.link.towerFacing - car0.facing + 540) % 360) - 180) : 0;
    check(`${tag}: still linked after the drive and the right-angle turn`, !!r.link, r);
    check(`${tag}: the cable was slack at first and went taut`, slackSeen && tautSeen, { slackSeen, tautSeen });
    check(`${tag}: never stretched past its length (max hook distance under 7.3 m)`, maxDist < 7.3, { maxDist });
    check(`${tag}: the tower turned ~90 deg and the car swung in behind it (within 15 deg, still rolling)`, turned > 70 && !!rolling.link && Math.abs(((rolling.link.towedFacing - rolling.link.towerFacing + 540) % 360) - 180) < 15, { turned, link: rolling.link });
    check(`${tag}: the car was towed over 20 m`, Math.hypot(r.carX - car0.carX, r.carY - car0.carY) > 20, { from: [car0.carX, car0.carY], to: [r.carX, r.carY] });
    await camera('third');
    await shot(`${tag}_08_parked_chase`);
    await camera('first');

    // --- detach it: the panel's "Detach the tow cable" (5 s), the cable back in your pack
    await js(`(() => { const vs = cdda.vehicleSystem; if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); }
      const l = vs.towing.links[0]; if (!l) return; const [hx, hy] = vs.towing.hookWorld(l.tower, l.a); const b = vs.physRect(l.tower);
      const [bx, by] = l.tower.mountToWorld(b.x0 - 1.1, (b.y0 + b.y1) / 2); const p = cdda.game.player;
      Object.assign(p, { x: bx, y: by }); window.__twYaw = Math.atan2(hx - bx, -(hy - by)); })()`);
    await c.toGameplay();
    await turnTo(await js<number>(`window.__twYaw`));
    await lookPitch(-0.25);
    if (!(await examine(name, `${tag}_09`))) return;
    if (!(await click('#ui2 button', '^Detach the tow cable', `${tag}: the panel offers "Detach the tow cable"`))) return;
    for (let i = 0; i < 40 && (await read()).act; i++) await sleep(250);
    r = await read();
    check(`${tag}: detached: no link, the cable back with you`, !r.link && !!r.carried && r.log.some((m) => /detach the tow cable/.test(m)), r);
    await c.toGameplay();
  };

  return [
    ['towing', 'tow cable: attach through the vehicle panel, the loose end drawn to your hand, a pickup and then the Abrams tow a car through a right-angle turn (frame sequences), detach', async () => {
      await towRun('pickup', 'tow_pickup');
      await towRun('tank_m1_abrams', 'tow_abrams');
    }],
  ];
}
