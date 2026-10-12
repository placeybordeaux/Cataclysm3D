// Real-input scenarios for the interaction screens (src/screens): dialogue, trade, missions,
// vehicles, bionics / mutations / martial arts, the Autodoc and achievements. Every action a
// player takes goes through xdotool (keys, clicks, drags); `cdda.*` only sets the scene
// (spawn an NPC, give items, seat you at the wheel) and reads state. Plugged into
// tools/realinput.ts's scenario list (run: --only talk,trade,missions,vehicle,body,autodoc,scores).

import type { Page } from 'puppeteer-core';
import { calmSurroundings, waitFor, type XInput } from './lib/realinput';

export interface ScreensCtx {
  page: () => Page;
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

interface U { surfaces: number; tacticalPause: boolean; locked: boolean; panels: string[]; menu: string[][] }

export function screenScenarios(c: ScreensCtx): Scenario[] {
  const { js, check, shot, sleep } = c;
  const u = () => js<U>('cdda.ui2.state()');
  /** Centre of the first element matching a selector (page coords), or null. */
  const at = (sel: string) => js<[number, number] | null>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
  const clickSel = async (sel: string, button = 1) => {
    const p = await at(sel);
    if (!p) return false;
    await c.x().click(p[0], p[1], button);
    await sleep(150);
    return true;
  };
  const drag = async (from: [number, number], to: [number, number]) => {
    const x = c.x();
    await x.moveTo(from[0], from[1], 2);
    await x.buttonDown(1);
    await x.moveTo(to[0], to[1], 14);
    await sleep(80);
    await x.buttonUp(1);
    await sleep(250);
  };
  const waitPanel = async (id: string, open = true, ms = 3000) => {
    const end = Date.now() + ms;
    let v = await u();
    while (v.panels.includes(id) !== open && Date.now() < end) {
      await sleep(80);
      v = await u();
    }
    return v;
  };

  /**
   * The crosshair prompt once it shows `want` (it follows the target on the HUD's own frame, so
   * right after a setup teleport it can still name the last thing looked at). Waits up to 4 s;
   * returns whatever it says then, so the caller's check reports a wrong prompt as it is.
   */
  const reEsc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const promptShowing = async (want: string): Promise<string> => {
    const expr = `document.querySelector('.hud-prompt')?.textContent ?? ''`;
    await waitFor(js, `new RegExp(${JSON.stringify(want)}).test(${expr})`, 4000);
    return js<string>(expr);
  };

  /** Close whatever ui2 panels a failed step left open, then back to captured gameplay. */
  const reset = async () => {
    for (let i = 0; i < 6 && (await u()).panels.length; i++) {
      await c.x().key('Escape');
      await sleep(150);
    }
    await c.toGameplay();
    // Nothing hostile near (a bandit from the town shot the survivor dead mid-suite once, and
    // every screen scenario after that ran on the death screen).
    await calmSurroundings(js);
  };

  return [
    ['talk', 'dialogue: e talks, cursor freed + paused, typewriter skips, 1-9 answer, Esc leaves', async () => {
      await reset();
      await js(`cdda.ui2.settings.pauseInInventory = true; cdda.ui2.saveSettings(); cdda.screens.prefs.speed = 'slow'`);
      await js(`(() => { const uid = cdda.spawnNpc('NC_SCAVENGER', 0, -2, { attitude: 'NULL' }); cdda.faceNpc(uid); cdda.game.player.pitch = -0.05; return uid; })()`);
      await c.toGameplay();
      // e must land on the NPC: wait until the crosshair says so (not a fixed sleep).
      await promptShowing('Talk to');
      // Watch for the typewriter from the page itself: a short greeting at 30 chars/s can be
      // fully typed before a poll from here sees it (the old check read the DOM once, after the
      // panel showed, and failed whenever the line was already out).
      await js(`(() => {
        window.__typing = { seen: false };
        const look = () => { if (document.querySelector('#ui2 .ix-said.typing')) window.__typing.seen = true; };
        window.__typingObs?.disconnect();
        window.__typingObs = new MutationObserver(look);
        window.__typingObs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
      })()`);
      await c.x().key('e');
      let v = await waitPanel('talk');
      check('e on an NPC opens the conversation panel', v.panels.includes('talk'), v.panels);
      check('…with the cursor free and time paused (Accessible)', !v.locked && v.tacticalPause, v);
      const typing = await js<{ seen: boolean }>(`(window.__typingObs.disconnect(), window.__typing)`);
      check('the NPC line types itself out', typing.seen, typing);
      await shot('talk_typing');
      await c.x().key('space');
      await sleep(150);
      check('Space completes the line', !(await js<boolean>(`!!document.querySelector('#ui2 .ix-said.typing')`)));
      const keys = await js<string[]>(`[...document.querySelectorAll('#ui2 .ix-resp .ix-resp-key')].map(k => k.textContent)`);
      check('answers are numbered 1…', keys[0] === '1' && keys.length >= 2, keys);
      await shot('talk_answers');
      const before = await js<number>(`cdda.screens.dialogue().panel.body.querySelectorAll('.ix-line').length`);
      // Pick the first answer that isn't "leave", by its number key.
      const i = await js<number>(`[...document.querySelectorAll('#ui2 .ix-resp')].findIndex(b => !b.classList.contains('unavailable') && !/Bye|leave|go now/i.test(b.textContent))`);
      await c.x().key(String(Math.max(0, i) + 1));
      await sleep(400);
      v = await u();
      const after = v.panels.includes('talk') ? await js<number>(`cdda.screens.dialogue().panel.body.querySelectorAll('.ix-line').length`) : before + 1;
      check('a number key answers (the history grows)', after > before, { before, after });
      // Layout switch from the title bar (mouse).
      if (v.panels.includes('talk')) {
        await clickSel('#ui2 .ix-layout-btn');
        check('the title-bar button switches the layout', await js<boolean>(`!!document.querySelector('#ui2 .ix-dlg.layout-book')`));
        await shot('talk_book');
        await clickSel('#ui2 .ix-layout-btn');
        // Space skips the typing here (it isn't the close key in a conversation); Bksp leaves.
        await c.x().key('space');
        await sleep(300);
        v = await u();
        check('Space skips, it does not leave the conversation', v.panels.includes('talk'), v.panels);
        await c.x().key('BackSpace');
        v = await waitPanel('talk', false);
        check('Bksp leaves the conversation', !v.panels.includes('talk') && !v.tacticalPause, v);
      }
      await js(`cdda.screens.prefs.speed = 'normal'`);
    }],
    ['trade', 'trade: drag goods onto the table with the real mouse, make the deal, items conserved', async () => {
      await reset();
      await js(`(() => { const uid = cdda.spawnNpc('evac_merchant', 0, -2); cdda.faceNpc(uid); for (let i = 0; i < 12; i++) cdda.giveItem('FMCNote'); cdda.__tradeNpc = uid; })()`);
      // Setup opens the screen (the dialogue route is covered by 'talk'); everything after is real input.
      await js(`cdda.trade(cdda.__tradeNpc)`);
      let v = await waitPanel('trade');
      check('the trade panel opens with a free cursor', v.panels.includes('trade') && !v.locked, v);
      await shot('trade_open');
      const counts = () => js<{ player: Record<string, number>; total: Record<string, number> }>(`(() => {
        const p = cdda.game.player, n = cdda.npcSystem.npcByUid(cdda.__tradeNpc);
        const tally = (list, o) => { for (const it of list) for (const x of it.walk()) o[x.typeId] = (o[x.typeId] ?? 0) + x.count(); return o; };
        const player = tally([...p.inv.carried(), ...p.inv.worn, ...(p.inv.wielded ? [p.inv.wielded] : [])], {});
        const npc = tally([...n.inv.carried(), ...n.inv.worn, ...(n.inv.wielded ? [n.inv.wielded] : []), ...n.stock], {});
        const ground = tally(cdda.game.map.itemsAt(p.tileX, p.tileY, p.z), {});
        const total = {}; for (const o of [player, npc, ground]) for (const [k, c] of Object.entries(o)) total[k] = (total[k] ?? 0) + c;
        return { player, total };
      })()`);
      const before = await counts();
      // Their cheapest good onto "You get".
      const row = await js<{ i: number; name: string } | null>(`(() => { const list = document.querySelector('#ui2 [data-testid="trade-theirs"]').getBoundingClientRect(); const all = [...document.querySelectorAll('#ui2 [data-testid="trade-theirs"] .ix-trow')]; const rows = all.filter(r => { const b = r.getBoundingClientRect(); return b.top >= list.top && b.bottom <= list.bottom; }); if (!rows.length) return null; const price = (r) => parseFloat(r.querySelector('.ix-trow-price').textContent.replace(/[^0-9.]/g, '')); let best = 0; rows.forEach((r, i) => { if (price(r) < price(rows[best])) best = i; }); return { i: all.indexOf(rows[best]), name: rows[best].querySelector('.ix-trow-name').textContent }; })()`);
      const from = row ? await js<[number, number]>(`(() => { const r = document.querySelectorAll('#ui2 [data-testid="trade-theirs"] .ix-trow')[${row.i}].getBoundingClientRect(); return [Math.round(r.left + 40), Math.round(r.top + r.height / 2)]; })()`) : null;
      const getZone = await at('#ui2 [data-testid="trade-get"]');
      if (from && getZone) await drag(from, getZone);
      const asked = await js<number>(`cdda.screens.trade().session.theirs.filter(e => e.count > 0).length`);
      check(`dragging "${row?.name}" onto "You get" asks for it`, asked === 1, asked);
      // Notes onto "You give" (drag the notes row).
      const notes = await js<[number, number] | null>(`(() => { const r = [...document.querySelectorAll('#ui2 [data-testid="trade-yours"] .ix-trow')].find(e => /Merch|note/i.test(e.textContent)); if (!r) return null; const b = r.getBoundingClientRect(); return [Math.round(b.left + 40), Math.round(b.top + b.height / 2)]; })()`);
      const giveZone = await at('#ui2 [data-testid="trade-give"]');
      if (notes && giveZone) await drag(notes, giveZone);
      const offered = await js<number>(`cdda.screens.trade().session.yours.filter(e => e.count > 0).length`);
      check('dragging your notes onto "You give" offers them', offered >= 1, offered);
      const ok = await js<boolean>(`cdda.screens.trade().session.canAccept().ok`);
      await shot('trade_offer');
      await clickSel('#ui2 [data-testid="trade-deal"]');
      v = await waitPanel('trade', false);
      const after = await counts();
      if (ok) check('"Make the deal" goes through and closes the screen', !v.panels.includes('trade'), v.panels);
      check('no item was created or lost by the trade', JSON.stringify(Object.entries(after.total).sort()) === JSON.stringify(Object.entries(before.total).sort()), { before: before.total, after: after.total });
      if (ok) check('what you asked for is yours now', Object.keys(after.player).some((k) => (after.player[k] ?? 0) > (before.player[k] ?? 0)), { before: before.player, after: after.player });
      if (v.panels.includes('trade')) await c.x().key('Escape');
    }],
    ['missions', 'mission log: M opens it (free cursor), tabs by mouse, M closes', async () => {
      await reset();
      await js(`(() => { const id = Object.keys(cdda.npcSystem.nd.missions).find(k => cdda.npcSystem.nd.missions[k].goal === 'MGOAL_FIND_ITEM'); const n = cdda.npcSystem.nearest(40); const uid = cdda.giveMission(id, n?.uid); const m = cdda.npcSystem.missions.get(uid); m.target = { x: Math.floor(cdda.game.player.x / 24) + 5, y: Math.floor(cdda.game.player.y / 24) - 3, z: 0 }; })()`);
      await c.x().key('M');
      let v = await waitPanel('missions');
      check('M opens the mission log', v.panels.includes('missions') && !v.locked, v);
      const rows = await js<number>(`document.querySelectorAll('#ui2 [data-testid="mission-list"] .ix-mrow').length`);
      check('the active job is listed', rows >= 1, rows);
      await clickSel('#ui2 .ix-mtarget .ui2-btn');
      check('Track marks it for the map', await js<boolean>(`cdda.screens.markers().some(m => m.kind === 'mission' && m.tracked)`));
      await shot('missions');
      await c.x().key('M');
      v = await waitPanel('missions', false);
      check('M closes it again', !v.panels.includes('missions'), v.panels);
    }],
    ['vehicle', 'vehicle: ^ at the wheel opens the panel, diagram click, engine button, driving HUD', async () => {
      await reset();
      // A car on a straight road, you at the wheel with the engine running (setup only).
      const trip = await js<unknown>(`JSON.stringify(cdda.roadTrip('car'))`);
      check('setup: a car on a road', trip !== 'null', trip);
      await c.toGameplay();
      await sleep(600);
      check('the driving HUD shows while at the wheel', await js<boolean>(`getComputedStyle(document.querySelector('#ui2 .ix-drivehud')).display !== 'none'`));
      await shot('drive_hud');
      await c.x().key('asciicircum');
      let v = await waitPanel('vehicle');
      check('^ at the wheel opens the vehicle panel', v.panels.includes('vehicle') && !v.locked, v);
      const cells = await js<number>(`document.querySelectorAll('#ui2 .ix-vcell').length`);
      check('the parts diagram has a square per mount', cells >= 8, cells);
      const second = await at('#ui2 .ix-vcell:not(.selected)');
      if (second) await c.x().click(second[0], second[1]);
      await sleep(200);
      check('clicking a square selects it', await js<boolean>(`!!document.querySelector('#ui2 .ix-vcell.selected')`));
      await shot('vehicle_panel');
      const was = await js<boolean>(`cdda.vehicleSystem.driving.engineOn`);
      const btn = await js<[number, number] | null>(`(() => { const b = [...document.querySelectorAll('#ui2 .ix-veh-controls .ui2-btn')].find(e => /engine/i.test(e.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
      if (btn) await c.x().click(btn[0], btn[1]);
      await sleep(300);
      check('the engine button starts/stops the engine', (await js<boolean>(`cdda.vehicleSystem.driving.engineOn`)) !== was);
      await c.x().key('space');
      v = await waitPanel('vehicle', false);
      check('Space closes it', !v.panels.includes('vehicle'), v.panels);
      await js(`cdda.exitVehicle()`);
    }],
    ['getin', "vehicle: walking up to the driver's door says '[e] Drive the Car'; e gets in, e gets out; o lists the rest", async () => {
      await reset();
      // Setup only: a car on a road with its doors shut, you outside the driver's door looking at it.
      const name = await js<string | null>(`(() => {
        const r = cdda.roadTrip('car'); if (!r) return null;
        const vs = cdda.vehicleSystem, v = vs.driving; vs.releaseControls(); v.velocity = 0; v.engineOn = false;
        for (const q of v.parts) if (q.def.id.startsWith('door')) q.open = false;
        const d = v.parts.find((q) => q.def.id === 'door_front_left');
        const [dx, dy] = v.mountToWorld(d.mx + 0.5, d.my + 0.5), [ox, oy] = v.mountToWorld(d.mx + 0.5, d.my - 1.1);
        const p = cdda.game.player; Object.assign(p, { x: ox, y: oy, z: v.z, yaw: Math.atan2(dx - ox, -(dy - oy)), pitch: -0.2 });
        window.__getin = v.uid; return v.name; })()`);
      check('setup: a car with you by the driver door', !!name, name);
      await c.toGameplay();
      const prompt = await promptShowing(`Drive the ${reEsc(String(name))}`);
      check(`the crosshair prompt says "[e] Drive the ${name}"`, prompt.includes(`Drive the ${name}`), prompt);
      await shot('getin_prompt');
      await c.x().key('o');
      await sleep(300);
      const menu = (await u()).menu.flat().join(' | ');
      check('o (context menu) offers Drive and Examine (the parts panel)', /Drive the/.test(menu) && /Examine/.test(menu), menu);
      await shot('getin_menu');
      await c.x().key('Escape');
      await c.toGameplay();
      await c.x().key('e');
      await sleep(300);
      const drv = await js<{ driving: boolean; msgs: string[] }>(`({ driving: cdda.vehicleSystem.driving?.uid === window.__getin, msgs: cdda.ui.log().slice(-3) })`);
      check('e at the driver door gets in and takes the controls', drv.driving, drv);
      await c.x().key('e');
      await sleep(300);
      const out = await js<{ driving: boolean; inside: boolean }>(`({ driving: !!cdda.vehicleSystem.driving, inside: !!cdda.vehicleAt(0, 0) })`);
      check('e again (stopped) climbs out onto the road', !out.driving && !out.inside, out);
    }],
    ['carside', 'vehicle body collision: W into a car\'s side and tail stops at the paint (no invisible wall); e from there drives', async () => {
      await reset();
      // Setup only: a parked car on a road, you 3 m off its left side (then its tail), facing it.
      const setup = (where: 'side' | 'tail') => js<string | null>(`(() => {
        const vs = cdda.vehicleSystem;
        let v = vs.list.find((q) => q.uid === window.__carside);
        if (!v) {
          const r = cdda.roadTrip('car'); if (!r) return null;
          v = vs.driving; vs.releaseControls(); v.velocity = 0; v.engineOn = false;
          window.__carside = v.uid;
        }
        for (const q of v.parts) if (q.def.id.startsWith('door')) q.open = false;
        v.version++;
        const b = vs.bodyRect(v); if (!b) return 'no body shape';
        const mid = (b.y0 + b.y1) / 2, cx = (b.x0 + b.x1) / 2;
        const side = ${JSON.stringify(where)} === 'side';
        const [tx, ty] = side ? v.mountToWorld(-0.4, b.y0) : v.mountToWorld(b.x0, mid);
        const [ox, oy] = side ? v.mountToWorld(-0.4, b.y0 - 3) : v.mountToWorld(b.x0 - 3, mid);
        const p = cdda.game.player; Object.assign(p, { x: ox, y: oy, z: v.z, yaw: Math.atan2(tx - ox, -(ty - oy)), pitch: -0.1 });
        void cx; return v.name; })()`);
      // distance from you to the body outline (0 = touching the paint)
      const gap = () => js<number>(`(() => { const vs = cdda.vehicleSystem, v = vs.list.find((q) => q.uid === window.__carside), b = vs.bodyRect(v), p = cdda.game.player;
        const [lx, ly] = v.worldToMount(p.x, p.y); const dx = Math.max(b.x0 - lx, 0, lx - b.x1), dy = Math.max(b.y0 - ly, 0, ly - b.y1); return Math.hypot(dx, dy); })()`);
      const name = await setup('side');
      check('setup: a parked car, you 3 m off its side', !!name && name !== 'no body shape', name);
      await c.toGameplay();
      await c.x().hold('w', 2200);
      await sleep(200);
      const side = await gap();
      check('walking into the side stops at the paint (gap < 0.45 m, the old invisible wall was ~1 m)', side < 0.45 && side > 0.2, side);
      await shot('carside_side');
      const prompt = await promptShowing(`Drive the ${reEsc(String(name))}`);
      check(`from there the crosshair offers "Drive the ${name}"`, prompt.includes(`Drive the ${name}`), prompt);
      await c.x().key('e');
      await sleep(300);
      check('e gets in', await js<boolean>(`cdda.vehicleSystem.driving?.uid === window.__carside`));
      await c.x().key('e');
      await sleep(300);
      await setup('tail');
      await c.toGameplay();
      await c.x().hold('w', 2200);
      await sleep(200);
      const tail = await gap();
      check('walking into the tail stops at the bumper', tail < 0.45 && tail > 0.2, tail);
      await shot('carside_tail');
    }],
    ['cardoors', "vehicle doors (playtest): e at an open passenger door drives; ^ from beside the car; no camera through the roof in the doorway; doors shut when you drive off", async () => {
      await reset();
      // Setup only: a parked car on a road, doors shut; `place` stands you `off` m outside a door, facing it.
      const place = (door: string, off: number, open: boolean) => js<string | null>(`(() => {
        const vs = cdda.vehicleSystem;
        let v = vs.list.find((q) => q.uid === window.__cardoors);
        if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); }
        if (!v) {
          const r = cdda.roadTrip('car'); if (!r) return null;
          v = vs.driving; vs.releaseControls(); v.velocity = 0; v.engineOn = false;
          window.__cardoors = v.uid;
          // earlier scenarios' road trips parked cars on the same spot: clear them away
          for (const o of [...vs.list]) if (o !== v && Math.hypot(o.x - v.x, o.y - v.y) < 12) vs.remove(o);
        }
        for (const q of v.parts) if (q.def.id.startsWith('door')) q.open = false;
        const d = v.parts.find((q) => q.def.id === ${JSON.stringify(door)});
        d.open = ${open};
        v.version++;
        const b = vs.bodyRect(v), side = d.my < 0.5 ? -1 : 1, edge = side < 0 ? b.y0 : b.y1;
        const [tx, ty] = v.mountToWorld(d.mx, edge), [ox, oy] = v.mountToWorld(d.mx - 0.1, edge + side * ${off});
        const p = cdda.game.player; Object.assign(p, { x: ox, y: oy, z: v.z, yaw: Math.atan2(tx - ox, -(ty - oy)), pitch: -0.15 });
        return v.name; })()`);
      const name = await place('door_front_right', 0.9, true);
      check('setup: a car, you by its open passenger door', !!name, name);
      await c.toGameplay();
      let prompt = await promptShowing(`Drive the ${reEsc(String(name))}[^]*More`);
      check(`an open passenger door offers "Drive the ${name}" (closing is under More…)`, prompt.includes(`Drive the ${name}`) && prompt.includes('More'), prompt);
      await shot('cardoors_open_prompt');
      await c.x().key('e');
      await sleep(300);
      check('e there gets in and takes the controls', await js<boolean>(`cdda.vehicleSystem.driving?.uid === window.__cardoors`));
      await c.x().key('k'); // start the engine
      await sleep(300);
      await c.x().hold('w', 1600);
      await sleep(200);
      const doors = await js<{ moving: number; open: string[] }>(`(() => { const v = cdda.vehicleSystem.driving; return { moving: v.velocity, open: v.parts.filter((q) => q.def.id.startsWith('door') && q.open).map((q) => q.def.id) }; })()`);
      check('driving off shuts the doors', doors.moving > 1 && !doors.open.length, doors);
      await place('door_front_left', 1.0, false);
      await c.toGameplay();
      await sleep(300);
      await c.x().key('asciicircum');
      await sleep(300);
      const ctl = await js<{ driving: boolean; log: string[] }>(`({ driving: cdda.vehicleSystem.driving?.uid === window.__cardoors, log: cdda.ui.log().slice(-2) })`);
      check('^ from beside the (closed) driver door takes the controls', ctl.driving, ctl);
      await place('door_front_left', -0.25, true);
      await c.toGameplay();
      await sleep(400);
      const cam = await js<{ camY: number; roof: number }>(`(() => { const v = cdda.vehicleSystem.list.find((q) => q.uid === window.__cardoors); return { camY: cdda.renderer.camera.position.y, roof: v.z * 2.6 + 1.62 }; })()`);
      check('standing in the doorway the camera stays under the roof', cam.camY < cam.roof - 0.1, cam);
      await shot('cardoors_doorway');
      // Inside the body vehwalk.ts seats you at a station (docs/VEHICLES.md "Inside vehicles"): in
      // the driver's doorway that is the wheel, whose prompt reads "Driver's seat: drive from here".
      prompt = await promptShowing(`Drive the ${reEsc(String(name))}|drive from here`);
      check('…and it still offers to drive', prompt.includes(`Drive the ${name}`) || /drive from here/.test(prompt), prompt);
    }],
    ['refuel', 'gas pump: e on a pump by a parked car fills it up (BN fill rate), the tank gauge rises', async () => {
      await reset();
      // Setup only: a car on a road with an empty tank, a gasoline pump beside it (the fuel as
      // mapgen leaves it: a liquid item on the pump tile), you next to the pump looking at it.
      const setup = await js<{ name: string; fuel: number } | null>(`(() => {
        const r = cdda.roadTrip('car'); if (!r) return null;
        const vs = cdda.vehicleSystem, v = vs.driving; vs.releaseControls(); v.velocity = 0; v.engineOn = false;
        v.drainFuel('gasoline', 1e9); v.version++;
        cdda.clearMonsters(); // pumping is an activity: nearby zombies would (rightly) stop it
        const b = vs.bodyRect(v);
        const [px, py] = v.mountToWorld(0, b.y0 - 1.1), tx = Math.floor(px), ty = Math.floor(py);
        const m = cdda.game.map; m.setTer(tx, ty, v.z, 't_gas_pump');
        window.__pump = [tx, ty, v.z]; window.__fuelcar = v.uid;
        const [ox, oy] = v.mountToWorld(-1.2, b.y0 - 1.2);
        const p = cdda.game.player; Object.assign(p, { x: ox, y: oy, z: v.z, yaw: Math.atan2(tx + 0.5 - ox, -(ty + 0.5 - oy)), pitch: -0.25 });
        cdda.spawnItem('gasoline', tx - p.tileX, ty - p.tileY, { count: 15000 });
        return { name: v.name, fuel: v.fuelLeft('gasoline') }; })()`);
      check('setup: an empty car beside a gas pump', !!setup && setup.fuel === 0, setup);
      const stocked = await js<number>(`(() => { const [x, y, z] = window.__pump; const g = cdda.game; const it = g.map.itemsAt(x, y, z).find((i) => i.typeId === 'gasoline'); return it ? it.charges : 0; })()`);
      check('setup: the pump holds gasoline', stocked > 0, stocked);
      await c.toGameplay();
      const prompt = await promptShowing('Fill up the Car');
      check('the crosshair on the pump offers "Fill up the Car"', /Fill up the Car/.test(prompt), prompt);
      await shot('refuel_prompt');
      await c.x().key('e');
      await sleep(8000);
      const after = await js<{ fuel: number; busy: boolean; log: string[] }>(`(() => { const v = cdda.vehicleSystem.list.find((q) => q.uid === window.__fuelcar); return { fuel: v.fuelLeft('gasoline'), busy: !!cdda.game.activities.current, log: cdda.ui.log().slice(-2) }; })()`);
      check('e pumps the pump dry into the tank (15 L)', after.fuel === 15000 && !after.busy, after);
    }],
    ['body', 'bionics (p), mutations ([), martial arts (_): panels, switches by mouse', async () => {
      await reset();
      await js(`cdda.installBionic('bio_power_storage'); cdda.installBionic('bio_flashlight'); cdda.givePower(100)`);
      await c.x().key('p');
      let v = await waitPanel('bionics');
      check('p opens the bionics panel', v.panels.includes('bionics') && !v.locked, v);
      const sw = await at('#ui2 .ix-switch');
      if (sw) await c.x().click(sw[0], sw[1]);
      await sleep(200);
      check('clicking the switch turns the bionic on', await js<boolean>(`cdda.bionics().installed.some(b => b.id === 'bio_flashlight' && b.powered)`));
      await shot('bionics');
      await c.x().key('p');
      v = await waitPanel('bionics', false);
      check('p closes it', !v.panels.includes('bionics'), v.panels);
      await js(`cdda.mutate('NIGHTVISION')`);
      await c.x().key('bracketleft');
      v = await waitPanel('mutations');
      check('[ opens mutations', v.panels.includes('mutations'), v.panels);
      await shot('mutations');
      await c.x().key('Escape');
      await waitPanel('mutations', false);
      await c.x().key('underscore');
      v = await waitPanel('martialarts');
      check('_ opens martial arts', v.panels.includes('martialarts'), v.panels);
      await shot('martialarts');
      await c.x().key('Escape');
      await waitPanel('martialarts', false);
    }],
    ['autodoc', 'Autodoc: e on it, odds + risks shown, Operate asks once, the operation starts', async () => {
      await reset();
      await js(`(() => { const p = cdda.game.player; while (cdda.vehicleAt(0, 0) || cdda.vehicleAt(0, -1)) p.x += 3; cdda.spawnAutodoc(0, -1); p.yaw = 0; p.pitch = -0.6; cdda.giveCbm('bio_ears'); cdda.installBionic('bio_painkiller'); })()`);
      await sleep(400);
      await c.x().key('e');
      let v = await waitPanel('autodoc');
      if (!v.panels.includes('autodoc')) {
        check('e on the Autodoc opens the surgery screen', false, v.panels);
        return;
      }
      check('e on the Autodoc opens the surgery screen', true);
      const odds = await js<string>(`document.querySelector('#ui2 .ix-odds')?.textContent ?? ''`);
      check('the chosen CBM shows its odds', /\d+%/.test(odds), odds);
      check('…and what can go wrong', await js<boolean>(`document.querySelectorAll('#ui2 .ix-risks li').length === 3 || /No risk/.test(document.querySelector('#ui2 .ix-odds').textContent)`));
      await shot('autodoc');
      const btn = await js<[number, number] | null>(`(() => { const b = [...document.querySelectorAll('#ui2 [data-testid="autodoc-detail"] .ui2-btn')].find(e => /Begin/.test(e.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
      if (btn) await c.x().click(btn[0], btn[1]);
      await sleep(300);
      await shot('autodoc_confirm');
      const dialog = await js<string>(`document.querySelector('#ui2 .ui2-dialog')?.textContent ?? ''`);
      check('Begin asks once, restating the odds', /success|risk/i.test(dialog), dialog);
      await c.x().key(/complications/.test(dialog) ? 'y' : 'Return');
      await sleep(400);
      v = await u();
      check('agreeing starts the operation (the screen closes)', !v.panels.includes('autodoc'), v.panels);
      check('…and the Autodoc begins (time warps through the operation)', await js<boolean>(`cdda.ui.log().some(l => /configuring the Autodoc/.test(l))`), await js(`cdda.ui.log().slice(-3)`));
    }],
    ['scores', 'achievements: ) opens the journal-style panel, tabs by keys', async () => {
      await reset();
      await c.x().key('parenright');
      let v = await waitPanel('achievements');
      check(') opens the achievements panel', v.panels.includes('achievements') && !v.locked, v);
      check('achievements are journal cards', (await js<number>(`document.querySelectorAll('#ui2 .pg-entry.ix-ach').length`)) > 0);
      await shot('achievements');
      await c.x().key('Right');
      await c.x().key('parenright');
      v = await waitPanel('achievements', false);
      check(') closes it', !v.panels.includes('achievements'), v.panels);
    }],
  ];
}
