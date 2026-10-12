// Real-input scenario for vehicle turrets (src/game/turret.ts, src/turrets.ts; docs/VEHICLES.md
// "Turrets"): an M1 Abrams on a road, the survivor at the wheel with empty hands, the 120 mm
// unloaded and a few rounds in the ammo rack beside the gunner. Real keys and mouse (xdotool):
// e at the wheel -> driver's station, W/A/S/D hops to the gunner, e mans the 120 mm, r loads it
// from the rack, a left click fires it at a zombie, then the commander's M2 on auto at another.
// `cdda.*` only sets the scene up (tank, rounds, zombies, which way you start out looking) and
// reads the results (turret state, the zombies, the log). Screenshots: the panel before / after
// loading, the shot (flash, smoke, tracer) at a few delays, third person, the M2 burst, your
// body seated at the cupola and standing in a hatch (third person), F5 at the hatch and a load
// putting you back there, the controls volley swinging the turret round before it fires, and
// the dashboard's governed speed.
// Plugged into tools/realinput.ts (run: --only turret [--gpu] [--shots dir]).

import type { DriveCtx } from './realinput_drive';

type Scenario = [name: string, what: string, run: () => Promise<void>];

const HELPERS = `(() => {
  if (window.__tu) return;
  const vs = cdda.vehicleSystem, g = cdda.game;
  const where = () => {
    const at = vs.stations.view();
    const s = cdda.turrets.session();
    return { driving: !!vs.driving, at: at ? { kind: at.station.kind, cell: [at.station.mx, at.station.my], turret: at.station.turret } : null,
      manned: s ? s.part.def.id : null, reloadLeft: s ? +s.reloadLeft.toFixed(2) : 0,
      eye: +cdda.renderer.rig.camera.position.y.toFixed(2), log: cdda.ui.log().slice(-3) };
  };
  // the station of the abrams carrying a turret part id
  const stationOf = (id) => {
    const at = vs.stations.view(); if (!at) return -1;
    return vs.stations.stations(at.v).findIndex((s) => s.turret && at.v.partsAt(s.mx, s.my).some((p) => p.def.id === id));
  };
  // which of W/A/S/D (as you look now) points from your station toward station i
  const keyTo = (i) => {
    const at = vs.stations.view(); if (!at) return null;
    const v = at.v, s = at.station, t = vs.stations.stations(v)[i], p = g.player;
    const [ax, ay] = v.mountToWorld(s.x, s.y), [bx, by] = v.mountToWorld(t.x, t.y);
    const dx = bx - ax, dy = by - ay, sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    const fwd = dx * sin - dy * cos, right = dx * cos + dy * sin;
    return Math.abs(fwd) >= Math.abs(right) ? (fwd > 0 ? 'w' : 's') : right > 0 ? 'd' : 'a';
  };
  window.__tu = { where, stationOf, keyTo };
})()`;

export function turretScenarios(c: DriveCtx): Scenario[] {
  const { js, check, shot, sleep } = c;
  const camera = async (mode: 'first' | 'third' | 'top') => {
    for (let i = 0; i < 4 && (await js<string>(`cdda.renderer.rig.mode`)) !== mode; i++) {
      await c.x().key('v');
      await sleep(250);
    }
    return (await js<string>(`cdda.renderer.rig.mode`)) === mode;
  };
  const gate = async () => {
    for (let i = 0; i < 300 && (await js<boolean>('!!window.cdda?.loadGate?.().closed')); i++) await sleep(100);
  };
  const where = () => js<Record<string, any>>(`window.__tu.where()`);
  const state = () => js<Record<string, any>[]>(`cdda.turrets.state()`);
  const tur = async (id: string) => (await state()).find((t) => t.part === id)!;
  /** Hop with real W/A/S/D until at the station carrying `id` (the key re-chosen each hop from where you look). */
  const hopTo = async (id: string) => {
    const hops: string[] = [];
    for (let i = 0; i < 8; i++) {
      const want = await js<number>(`window.__tu.stationOf(${JSON.stringify(id)})`);
      const here = await where();
      if (here.at?.turret && (await js<boolean>(`(() => { const at = cdda.vehicleSystem.stations.view(); return at.v.partsAt(at.station.mx, at.station.my).some((p) => p.def.id === ${JSON.stringify(id)}); })()`))) break;
      const k = await js<string | null>(`window.__tu.keyTo(${want})`);
      if (!k) break;
      hops.push(k);
      await c.x().key(k);
      await sleep(900);
    }
    return hops;
  };
  /** Face world (x, y) at height h from the eye (setup), then nudge the view with the real mouse. */
  const face = async (x: number, y: number, h: number) => {
    await js(`(() => { const p = cdda.game.player, eye = cdda.renderer.rig.camera.position.y;
      p.yaw = Math.atan2(${x} - p.x, -(${y} - p.y)); p.pitch = Math.atan2(${h} - eye, Math.hypot(${x} - p.x, ${y} - p.y)); })()`);
    await c.x().move(6, 0, 3);
    await c.x().move(-6, 0, 3);
    await sleep(200);
  };
  /**
   * Face a zombie's body (setup). A fixed height can miss it: when the zombies lay downed, a ray
   * from a gunner's eye 3 m up at 0.35 m over the prone body grazed past it and landed on the road
   * ~26 m out (the "blast 26-28 m away, zombie at full hp" flake), and manning a gun moves the eye
   * to its sight. Sweep the height along the real crosshair ray (PlayerCombat.castAim) from the
   * eye as it is now and lay the view on the middle of what meets the body.
   */
  const faceBody = async (z: { uid: number; x: number; y: number }) => {
    const h = await js<number | null>(`(() => {
      const m = cdda.monsterSystem.all.find((q) => q.uid === ${z.uid}), p = cdda.game.player, c = cdda.combat;
      const o = c.aimRay({ x: 0, y: 0, rx: 0, ry: 0 }, 80).o, d = Math.hypot(${z.x} - o.x, ${z.y} - o.y);
      const yaw = Math.atan2(${z.x} - o.x, -(${z.y} - o.y)), hits = [];
      for (let h = 0; h <= 1.8; h += 0.02) if (c.castAim(yaw, Math.atan2(h - o.h, d), 80, undefined, o).hit === m) hits.push(h);
      if (!hits.length) return null;
      const h = hits[Math.floor(hits.length / 2)];
      p.yaw = yaw; p.pitch = Math.atan2(h - o.h, d);
      return +h.toFixed(2);
    })()`);
    if (h === null) await face(z.x, z.y, 0.35);
    else {
      await c.x().move(6, 0, 3);
      await c.x().move(-6, 0, 3);
      await sleep(200);
    }
    return h;
  };

  return [
    ['turret', 'vehicle turrets: Abrams driver -> gunner (real W/A/S/D), e mans the 120 mm, r loads it from the rack, LMB fires at a zombie; the commander\'s M2 on auto; governed dashboard', async () => {
      await js(HELPERS);
      // --- set up: an Abrams on a straight road, you at the wheel, hands empty --------------------
      const s = await js<Record<string, any> | string>(`(() => {
        const vs = cdda.vehicleSystem, g = cdda.game;
        if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); }
        vs.stations.leave();
        const r = cdda.roadTrip('tank_m1_abrams'); if (!r) return 'no road';
        const v = vs.driving;
        v.velocity = 0; v.engineOn = false;
        for (const o of [...vs.list]) if (o !== v && Math.hypot(o.x - v.x, o.y - v.y) < 40) vs.remove(o);
        cdda.clearMonsters();
        cdda.godMode(true);
        const w = g.player.inv.wielded; if (w) g.player.inv.drop(w);
        return { uid: v.uid, facing: v.facing, x: v.x, y: v.y, wielded: g.player.inv.wielded?.typeId ?? null };
      })()`);
      if (typeof s === 'string') return void check('turret: set up', false, s);
      // the 120 mm empty, two HEAT and an APFSDS in the rack beside the gunner, the M2 on a full belt
      // (cdda.turrets.stock: spawnItem / ammoConsume, the item API's creation and use-up)
      const stock = await js<Record<string, any>>(`cdda.turrets.stock(${s.uid})`);
      console.log(`  stocked: ${JSON.stringify(stock)}`);
      // screenshots land ~250 ms after the click: keep the 2-frame muzzle flash up that long for them
      await js(`cdda.turretFx.hold = 0.45`);
      await gate();
      await c.toGameplay();
      await camera('first');
      await sleep(500);
      console.log(`  setup: ${JSON.stringify(s)}`);
      check('turret: hands empty for the gun', s.wielded === null, s);

      // --- e at the wheel -> driver's station, hop to the gunner -----------------------------------
      await c.x().key('e');
      await sleep(500);
      const drv = await where();
      check("turret: e at the wheel -> the driver's station", drv.at?.kind === 'driver', drv);
      // the turret is aft of the driver: look back down the hull
      await js(`(() => { const v = cdda.vehicleSystem.stations.view().v; cdda.game.player.yaw = (v.facing + 270) * Math.PI / 180; cdda.game.player.pitch = -0.1; })()`);
      const hops = await hopTo('mounted_tank_manual');
      const gunner = await where();
      console.log(`  hops to the gunner: ${hops.join(' ')} -> ${JSON.stringify(gunner)}`);
      check('turret: W/A/S/D reach the 120 mm gunner station', !!gunner.at?.turret, { hops, gunner });

      // --- a zombie 20 m ahead of the hull; man the gun -------------------------------------------
      // (standing and held in place, not downed: a prone body is a sliver from 3 m up, and the M2's
      // sway and burst kick carried rounds off it about one run in four)
      const z1 = await js<{ uid: number; x: number; y: number }>(`(() => {
        const v = cdda.vehicleSystem.stations.view().v, [x, y] = v.mountToWorld(22, 0), p = cdda.game.player;
        const uid = cdda.spawnMonster('mon_zombie', x - p.x, y - p.y);
        const m = cdda.monsterSystem.active.find((q) => q.uid === uid); const mx = m.x, my = m.y; (window.__tuPins ??= []).push(setInterval(() => { if (!m.dead) { m.x = mx; m.y = my; m.attackCooldown = 5; } }, 16));
        return { uid, x: m.x, y: m.y };
      })()`);
      await faceBody(z1);
      await shot('turret_gunner_station');
      await c.x().key('e');
      await sleep(400);
      const manned = await where();
      check('turret: e at the gunner station mans the 120 mm', manned.manned === 'mounted_tank_manual', manned);
      const empty = await tur('mounted_tank_manual');
      check('turret: the 120 mm starts empty, rounds in reach in the rack', empty.ammo === 0 && empty.choices.length > 0, empty);
      await shot('turret_manned_empty_panel');
      // --- r loads it from the rack --------------------------------------------------------------
      await c.x().key('r');
      await sleep(300);
      const reloading = await where();
      await shot('turret_reloading');
      for (let i = 0; i < 40 && (await where()).reloadLeft > 0; i++) await sleep(150);
      const loaded = await tur('mounted_tank_manual');
      check('turret: r loads a 120 mm round from the rack (takes a few seconds)', loaded.ammo === 1 && reloading.reloadLeft > 1, { loaded, reloading });
      const h1 = await faceBody(z1);
      check('setup: the crosshair is on the zombie', h1 !== null, { h1 });
      await sleep(1500); // let the turret come round
      await shot('turret_loaded_aimed');
      // --- LMB fires ------------------------------------------------------------------------------
      const shotsBefore = loaded.shots;
      await c.x().clickHere(1);
      await sleep(30);
      await shot('turret_fire_flash');
      await sleep(150);
      await shot('turret_fire_smoke');
      await sleep(700);
      await shot('turret_fire_after');
      const after = await tur('mounted_tank_manual');
      const z1s = await js<Record<string, any> | null>(`(() => { const m = cdda.monsterSystem.all.find((q) => q.uid === ${z1.uid}); return m ? { hp: m.hp, dead: m.dead } : null; })()`);
      console.log(`  after the shot: ${JSON.stringify({ after, z1s, log: (await where()).log })}`);
      check('turret: LMB fires the 120 mm (one round gone, turret fired)', after.ammo === 0 && after.shots === shotsBefore + 1, after);
      check('turret: the 120 mm round kills the zombie', !z1s || z1s.dead || z1s.hp <= 0, z1s);
      // third person: reload the AP round and fire it, seen from behind the tank
      await c.x().key('r');
      for (let i = 0; i < 40 && (await where()).reloadLeft > 0; i++) await sleep(150);
      await camera('third');
      await sleep(400);
      await shot('turret_3p_loaded');
      await c.x().clickHere(1);
      await sleep(40);
      await shot('turret_3p_flash');
      await sleep(400);
      await shot('turret_3p_smoke');
      await camera('first');

      // --- e stands down; hop to the commander's M2 ----------------------------------------------
      await c.x().key('e');
      await sleep(300);
      check('turret: e again stands down', (await where()).manned === null, await where());
      await js(`(() => { const v = cdda.vehicleSystem.stations.view().v; cdda.game.player.yaw = (v.facing + 90) * Math.PI / 180; cdda.game.player.pitch = -0.05; })()`);
      const hops2 = await hopTo('mounted_browning');
      const cmd = await where();
      check("turret: hop to the commander's M2 station", !!cmd.at?.turret && (await js<boolean>(`(() => { const at = cdda.vehicleSystem.stations.view(); return at.v.partsAt(at.station.mx, at.station.my).some((p) => p.def.id === 'mounted_browning'); })()`)), { hops2, cmd });
      const z2 = await js<{ uid: number; x: number; y: number }>(`(() => {
        const v = cdda.vehicleSystem.stations.view().v, [x, y] = v.mountToWorld(16, 5), p = cdda.game.player;
        const uid = cdda.spawnMonster('mon_zombie', x - p.x, y - p.y);
        const m = cdda.monsterSystem.active.find((q) => q.uid === uid); const mx = m.x, my = m.y; (window.__tuPins ??= []).push(setInterval(() => { if (!m.dead) { m.x = mx; m.y = my; m.attackCooldown = 5; } }, 16));
        return { uid, x: m.x, y: m.y };
      })()`);
      await faceBody(z2);
      await c.x().key('e');
      await sleep(300);
      // auto: fire_mode until the M2 is on its 3-round mode (real key)
      for (let i = 0; i < 3 && (await js<number>(`cdda.turrets.session().gun.vars.gun_mode === 'AUTO' ? 1 : 0`)) === 0; i++) {
        await c.x().key(await js<string>(`cdda.game.keys.keyFor('fire_mode')`));
        await sleep(200);
      }
      // (manning the M2 puts the eye at its sight: lay the view on the body again from there)
      const h2 = await faceBody(z2);
      check('setup: the crosshair is on the second zombie', h2 !== null, { h2 });
      await sleep(600); // let the M2 come round
      const m2a = await tur('mounted_browning');
      await shot('turret_m2_manned');
      await c.x().buttonDown(1);
      await sleep(60);
      await shot('turret_m2_burst');
      await sleep(900);
      await c.x().buttonUp(1);
      await sleep(300);
      await shot('turret_m2_after');
      // BN's per-shot malfunction roll can jam it: r clears the jam (as with a gun in hand), then hold again
      if ((await js<boolean>(`!!cdda.turrets.session()?.gun.vars.jammed`))) {
        console.log('  the M2 jammed: r clears it');
        await c.x().key('r');
        await sleep(1300);
        check('turret: r clears a jammed turret gun', !(await js<boolean>(`!!cdda.turrets.session()?.gun.vars.jammed`)));
        await c.x().buttonDown(1);
        await sleep(900);
        await c.x().buttonUp(1);
        await sleep(300);
      }
      const m2b = await tur('mounted_browning');
      const z2s = await js<Record<string, any> | null>(`(() => { const m = cdda.monsterSystem.all.find((q) => q.uid === ${z2.uid}); return m ? { hp: m.hp, hpMax: m.hpMax, dead: m.dead } : null; })()`);
      console.log(`  M2: ${JSON.stringify({ before: m2a.ammo, after: m2b.ammo, z2s })}`);
      check('turret: holding LMB on the M2 fires bursts from its belt', m2a.ammo - m2b.ammo >= 3, { before: m2a.ammo, after: m2b.ammo });
      check('turret: the M2 hurts the zombie', !z2s || z2s.dead || z2s.hp < z2s.hpMax, z2s);
      await js(`(() => { for (const t of window.__tuPins ?? []) clearInterval(t); window.__tuPins = []; })()`);
      await c.x().key('e');
      await sleep(300);

      // --- your body at the stations in third person: seated at the cupola, standing in a hatch -----
      type RC = { kind: string | null; visible: boolean; alive: boolean; handErr: number; footErr: number; hip: [number, number, number]; ageMs: number } | null;
      const rider = () => js<RC>(`cdda.renderer.vehicleView.riderCheck()`);
      await camera('third');
      await sleep(500);
      const seat = await rider();
      const seatEye = await js<number>(`cdda.renderer.rig.stationEye`);
      await shot('turret_3p_commander_seated');
      check('turret: third person at the commander\'s seat draws your body seated there (hips ~0.7 m under the eye, not standing through the seat)', !!seat && seat.visible && seat.alive && seat.ageMs < 500 && Math.abs(seatEye - 0.66 - seat.hip[1]) < 0.12, { seat, seatEye });
      // the gunner's view in third person frames what you aim at: the crosshair ray from the
      // camera meets the eye's look ray out ahead, not 2 m above it
      const frame = await js<Record<string, number>>(`(() => { const cam = cdda.renderer.rig.camera, p = cdda.game.player, e = cam.matrixWorld.elements;
        const fx = -e[8], fy = -e[9], fz = -e[10], eye = cdda.renderer.rig.stationEye;
        const look = { x: Math.sin(p.yaw) * Math.cos(p.pitch), y: Math.sin(p.pitch), z: -Math.cos(p.yaw) * Math.cos(p.pitch) };
        const t = look.y < -0.01 ? Math.min(45, (eye - cdda.game.player.z * 2.6 - cdda.renderer.rig.lift) / -look.y) : 45;
        const ax = p.x + look.x * t, ay = eye + look.y * t, az = p.y + look.z * t;
        const dx = ax - cam.position.x, dy = ay - cam.position.y, dz = az - cam.position.z, d = Math.hypot(dx, dy, dz);
        return { miss: Math.acos(Math.min(1, (dx * fx + dy * fy + dz * fz) / d)) * 180 / Math.PI, camUp: cam.position.y - eye, pitchCam: Math.asin(fy) * 180 / Math.PI, pitchLook: p.pitch * 180 / Math.PI }; })()`);
      check('turret: the third-person gunner camera is laid on the aim point (crosshair within 1 deg of where the eye looks, 45 m out)', frame.miss < 1 && frame.camUp > 1.5, frame);
      // hop to a hatch with real W/A/S/D: head and shoulders out
      const hatchIdx = await js<number>(`(() => { const at = cdda.vehicleSystem.stations.view(); const list = cdda.vehicleSystem.stations.stations(at.v);
        let best = -1, bd = Infinity; list.forEach((s, i) => { if (s.kind !== 'hatch') return; const d = Math.hypot(s.x - at.station.x, s.y - at.station.y); if (d < bd) { bd = d; best = i; } }); return best; })()`);
      for (let i = 0; i < 6 && (await where()).at?.kind !== 'hatch'; i++) {
        const k = await js<string | null>(`window.__tu.keyTo(${hatchIdx})`);
        if (!k) break;
        await c.x().key(k);
        await sleep(900);
      }
      const hatchAt = await where();
      await sleep(300);
      const hatch = await rider();
      await shot('turret_3p_hatch');
      check('turret: at a hatch in third person your body stands in it, head and shoulders out', hatchAt.at?.kind === 'hatch' && !!hatch && hatch.visible && hatch.ageMs < 500, { hatchAt, hatch });
      // F5 (quicksave) at the hatch, hop away, load: back at the hatch, not the nearest station
      const savedAt = await js<{ i: number; kind: string }>(`(() => { const s = cdda.vehicleSystem.stations; return { i: s.at.i, kind: s.current().kind }; })()`);
      await c.x().key('F5');
      await sleep(800);
      await c.x().key(await js<string>(`window.__tu.keyTo(${await js<number>(`(() => { const at = cdda.vehicleSystem.stations.view(); return cdda.vehicleSystem.stations.stations(at.v).findIndex((s) => s.kind === 'driver'); })()`)})`) ?? 's');
      await sleep(900);
      const moved = await js<number>(`cdda.vehicleSystem.stations.at?.i ?? -1`);
      await js(`(async () => { await cdda.save.load(); })()`);
      await sleep(1500);
      await gate();
      const loadedAt = await js<{ i: number; kind: string } | null>(`(() => { const s = cdda.vehicleSystem.stations; return s.at ? { i: s.at.i, kind: s.current().kind } : null; })()`);
      check('turret: the station you saved at (a hatch) is where you are after loading', loadedAt?.i === savedAt.i && loadedAt?.kind === 'hatch' && moved !== savedAt.i, { savedAt, moved, loadedAt });
      await c.toGameplay();
      await camera('first');

      // --- the controls volley traverses the turret before it fires ------------------------------
      const drvIdx0 = await js<number>(`(() => { const at = cdda.vehicleSystem.stations.view(); return cdda.vehicleSystem.stations.stations(at.v).findIndex((s) => s.kind === 'driver'); })()`);
      for (let i = 0; i < 6 && (await where()).at?.kind !== 'driver'; i++) {
        const k = await js<string | null>(`window.__tu.keyTo(${drvIdx0})`);
        if (!k) break;
        await c.x().key(k);
        await sleep(900);
      }
      await c.x().key('e');
      await sleep(500);
      const uidNow = await js<number>(`cdda.vehicleSystem.driving?.uid ?? -1`);
      await js(`cdda.turrets.stock(${uidNow}, { loadMain: '120mm_usable_heat' })`);
      // a zombie 30 m off the tank's rear quarter: the gun has to come ~150 deg round
      const z3 = await js<{ uid: number; x: number; y: number }>(`(() => {
        const v = cdda.vehicleSystem.driving, [x, y] = v.mountToWorld(-30, 12), p = cdda.game.player;
        const uid = cdda.spawnMonster('mon_zombie', x - p.x, y - p.y);
        const m = cdda.monsterSystem.active.find((q) => q.uid === uid); m.addEffect('downed', 600);
        return { uid, x: m.x, y: m.y };
      })()`);
      await face(z3.x, z3.y, 0.35);
      for (let i = 0; i < 4 && (await js<string>(`cdda.renderer.rig.driveCam`)) !== 'top'; i++) {
        await c.x().key('v');
        await sleep(250);
      }
      const before = await tur('mounted_tank_manual');
      await c.x().key(await js<string>(`cdda.game.keys.keyFor('fire')`));
      const t0 = Date.now();
      await sleep(120);
      const right = await tur('mounted_tank_manual');
      check('turret: f at the controls does not fire the 120 mm while it is still laid down the hull', right.shots === before.shots && right.ammo === 1, { before, right });
      let firedAfter = -1, frameN = 0;
      const yaws: number[] = [];
      while (Date.now() - t0 < 8000) {
        const t = await tur('mounted_tank_manual');
        yaws.push(t.yaw);
        if (frameN < 6 && Date.now() - t0 > frameN * 700) await shot(`turret_volley_traverse_${frameN++}`);
        if (t.shots > before.shots) { firedAfter = Date.now() - t0; break; }
        await sleep(120);
      }
      await sleep(200);
      await shot('turret_volley_fired');
      const turned = Math.abs(Math.atan2(Math.sin(yaws[yaws.length - 1] - before.yaw), Math.cos(yaws[yaws.length - 1] - before.yaw))) * 180 / Math.PI;
      check('turret: the volley swings the turret round (~45 deg/s) and fires when it gets there', firedAfter > 1500 && firedAfter < 7000 && turned > 100, { firedAfter, turned, log: (await where()).log });
      for (let i = 0; i < 4 && (await js<string>(`cdda.renderer.rig.driveCam`)) !== 'cockpit'; i++) {
        await c.x().key('v');
        await sleep(250);
      }
      await c.x().key('e');
      await sleep(500);

      // --- dashboard: the governed figures --------------------------------------------------------
      const drvIdx = await js<number>(`(() => { const at = cdda.vehicleSystem.stations.view(); return cdda.vehicleSystem.stations.stations(at.v).findIndex((s) => s.kind === 'driver'); })()`);
      for (let i = 0; i < 6 && (await where()).at?.kind !== 'driver'; i++) {
        const k = await js<string | null>(`window.__tu.keyTo(${drvIdx})`);
        if (!k) break;
        await c.x().key(k);
        await sleep(900);
      }
      await c.x().key('e');
      await sleep(500);
      await c.x().key(await js<string>(`cdda.game.keys.keyFor('vehicle_engine')`));
      await sleep(800);
      const dash = await js<Record<string, any>>(`(() => { const v = cdda.vehicleSystem.driving; const lim = v && cdda.vehicleSystem.speedLimits(v);
        const el = [...document.querySelectorAll('div')].find((d) => /mph/.test(d.textContent ?? '') && d.offsetParent && d.children.length < 40 && (d.textContent ?? '').length < 400);
        return { driving: !!v, engine: v?.engineOn, top: lim ? Math.round(lim.top * 2.23694) : null, safe: lim ? Math.round(lim.safe * 2.23694) : null, text: el?.textContent ?? null }; })()`);
      console.log(`  dashboard: ${JSON.stringify(dash)}`);
      check("turret: the dashboard reads the governed speed (~45 mph), not CDDA's 150", dash.driving && dash.top !== null && dash.top < 50 && !/1[2-5]\d mph/.test(dash.text ?? ''), dash);
      await shot('turret_dashboard');
      await js(`cdda.godMode(false); cdda.turretFx.hold = 0`);
    }],
  ];
}
