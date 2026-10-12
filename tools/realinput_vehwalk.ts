// Real-input scenario for being inside vehicles (src/game/vehwalk.ts, docs/VEHICLES.md "Inside
// vehicles"): W / A / S / D / e are real key presses through xdotool; `cdda.*` only sets the scene
// (a vehicle on a road with you at the wheel or beside its door, where you look) and reads the
// result. Checks, per the interior model the vehicle gets from its data:
//  - car (in / out only): e at the driver's door drives, e at the wheel gets you out, nothing
//    leaves you standing in the cabin;
//  - RV (a deck): e at the wheel keeps you in the driver's seat, S / A / D hop station to
//    station quickly (not a BN seat-cell crawl), the eye on the drawn floor under the roof,
//    a door station gets you out;
//  - M1 Abrams (crew stations): e at the wheel -> driver's station, W to the gunner, on to a
//    hatch (head out over the turret), e climbs out onto the road.
// Plugged into tools/realinput.ts (run: --only vehwalk; --params "vehwalk=free" or
// "vehwalk=allstations" runs the other variants: the checks then just log what happened).

import type { DriveCtx } from './realinput_drive';

type Scenario = [name: string, what: string, run: () => Promise<void>];

// Page-side: where you are (station, eye, vehicle) and a per-frame position sampler.
const HELPERS = `(() => {
  if (window.__vw) return;
  const vs = cdda.vehicleSystem, g = cdda.game;
  let rec = null;
  const frame = () => {
    if (rec) {
      const p = g.player, at = vs.stations.view();
      rec.push({ t: performance.now(), x: p.x, y: p.y, eye: cdda.renderer.rig.camera.position.y, kind: at ? at.station.kind : null });
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const where = () => {
    const p = g.player, at = vs.stations.view(), on = vs.playerOn();
    const v = at?.v ?? vs.driving ?? on?.v ?? null;
    const e = v ? cdda.renderer.vehicleView?.entries?.get(v) : null;
    return { driving: !!vs.driving, at: at ? { kind: at.station.kind, cell: [at.station.mx, at.station.my], cabin: at.cabin } : null,
      on: on ? on.v.uid : null, x: +p.x.toFixed(2), y: +p.y.toFixed(2), eye: +cdda.renderer.rig.camera.position.y.toFixed(2),
      deckY: e?.deckY ?? null, roofY: e?.roofY ?? null, turretTop: e?.turretTop ?? null, mode: vs.stations.mode,
      log: cdda.ui.log().slice(-2) };
  };
  // Which of W/A/S/D points from where you are toward the nearest station with a door beside it
  // (or, standing at one, out through its door): the key a player would press, looking ahead.
  const keyToDoor = () => {
    const at = vs.stations.view(); if (!at) return null;
    const v = at.v, s = at.station, list = vs.stations.stations(v), p = g.player;
    let tx, ty;
    if (s.exits.length) { [tx, ty] = [s.x + s.exits[0].out[0], s.y + s.exits[0].out[1]]; }
    else {
      const t = list.filter((q) => q.exits.length && q.kind !== 'driver').sort((a, b) => Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(b.x - s.x, b.y - s.y))[0];
      if (!t) return null; [tx, ty] = [t.x, t.y];
    }
    const [ax, ay] = v.mountToWorld(s.x, s.y), [bx, by] = v.mountToWorld(tx, ty);
    const dx = bx - ax, dy = by - ay, sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    const fwd = dx * sin - dy * cos, right = dx * cos + dy * sin;
    return Math.abs(fwd) >= Math.abs(right) ? (fwd > 0 ? 'w' : 's') : right > 0 ? 'd' : 'a';
  };
  window.__vw = { keyToDoor, where, start: () => { rec = []; }, stop: () => { const r = rec ?? []; rec = null; return r; } };
})()`;

export function vehwalkScenarios(c: DriveCtx): Scenario[] {
  const { js, check, shot, sleep } = c;
  const camera = async (mode: 'first' | 'third' | 'top') => {
    for (let i = 0; i < 4 && (await js<string>(`cdda.renderer.rig.mode`)) !== mode; i++) {
      await c.x().key('v');
      await sleep(250);
    }
    return (await js<string>(`cdda.renderer.rig.mode`)) === mode;
  };
  /** The load gate (src/loadgate) holds the game and swallows keys after a teleport. */
  const gate = async () => {
    for (let i = 0; i < 300 && (await js<boolean>('!!window.cdda?.loadGate?.().closed')); i++) await sleep(100);
  };
  const where = () => js<Record<string, any>>(`window.__vw.where()`);
  /** A fresh `proto` on a straight road, you at the wheel, engine off, nothing near. */
  const atWheel = async (proto: string) => {
    const s = await js<Record<string, any> | string>(`(() => {
      const vs = cdda.vehicleSystem;
      if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); }
      vs.stations.leave();
      const r = cdda.roadTrip(${JSON.stringify(proto)}); if (!r) return 'no road';
      const v = vs.driving;
      v.velocity = 0; v.engineOn = false;
      for (const o of [...vs.list]) if (o !== v && Math.hypot(o.x - v.x, o.y - v.y) < 30) vs.remove(o);
      cdda.clearMonsters();
      return { uid: v.uid, facing: v.facing };
    })()`);
    await gate();
    await c.toGameplay();
    await camera('first');
    await sleep(500);
    return s;
  };
  /** Press `key` once (a tap) and wait for the hop to land; returns the station after and the hop's duration. */
  const hop = async (key: string) => {
    await js(`window.__vw.start()`);
    await c.x().key(key);
    await sleep(900);
    const rec = await js<{ t: number; x: number; y: number; eye: number; kind: string | null }[]>(`window.__vw.stop()`);
    const moving = rec.filter((s, i) => i > 0 && Math.hypot(s.x - rec[i - 1].x, s.y - rec[i - 1].y) > 1e-3);
    const secs = moving.length > 1 ? (moving[moving.length - 1].t - moving[0].t) / 1000 : 0;
    const dist = rec.length ? Math.hypot(rec[rec.length - 1].x - rec[0].x, rec[rec.length - 1].y - rec[0].y) : 0;
    const w = await where();
    return { kind: w.at?.kind ?? null, secs: +secs.toFixed(2), dist: +dist.toFixed(2), eye: w.eye, w };
  };
  /** Tap keys from `keys` (cycling) until the station is `kind`; returns the hops made. */
  const hopUntil = async (kind: string, keys: string[], max = 10) => {
    const hops: Record<string, any>[] = [];
    for (let i = 0; i < max; i++) {
      if ((await where()).at?.kind === kind) break;
      const h = await hop(keys[i % keys.length]);
      hops.push({ key: keys[i % keys.length], kind: h.kind, secs: h.secs, dist: h.dist, eye: h.eye });
    }
    return hops;
  };

  return [
    ['vehwalk', 'inside vehicles: car in/out at the wheel, RV station to station, M1 Abrams driver -> gunner -> hatch -> out (real W/A/S/D/e)', async () => {
      await js(HELPERS);
      const mode = await js<string>(`cdda.vehicleSystem.stations.mode`);
      const strict = mode === 'stations';
      const log = (k: string, o: unknown) => console.log(`  ${k}: ${JSON.stringify(o)}`);
      console.log(`  vehwalk mode: ${mode}`);

      // --- car: in and out only ------------------------------------------------------------
      {
        const s = await atWheel('car');
        if (typeof s === 'string') return void check('car: set up', false, s);
        await shot(`vehwalk_${mode}_car_wheel`);
        await c.x().key('e');
        await sleep(500);
        const out = await where();
        log('car e at the wheel', out);
        if (mode === 'allstations') {
          // cars hop seat to seat in this variant: e kept you in the driver's seat
          check("car (allstations): e at the wheel keeps you in the driver's seat", out.at?.kind === 'driver', out);
          await js(`cdda.game.player.yaw = Math.PI; cdda.game.player.pitch = -0.2`);
          const hops = [await hop('w'), await hop('a'), await hop('d')].map((h) => ({ kind: h.kind, secs: h.secs, dist: h.dist, eye: h.eye }));
          log('car seat hops', hops);
          check('car (allstations): W/A/D hop between the seats', hops.some((h) => h.dist > 0.5 && h.kind === 'seat'), hops);
          await shot(`vehwalk_${mode}_car_backseat`);
          await c.x().key('e');
          await sleep(500);
          const o = await where();
          check('car (allstations): e from a seat by a door gets out', o.at === null && o.on === null, o);
        } else check('car: e at the wheel gets you out (not standing in the cabin)', !out.driving && out.at === null && out.on === null, out);
        await shot(`vehwalk_${mode}_car_out`);
        // back in: stand by the driver's door looking at it, e
        await js(`(() => { const vs = cdda.vehicleSystem, v = vs.list.find((q) => q.uid === ${s.uid}), p = cdda.game.player;
          const [sx, sy] = vs.driverSeatWorld(v), b = vs.bodyRect(v), c = v.controls();
          const side = c.my <= 0 ? b.y0 - 1.1 : b.y1 + 1.1; const [wx, wy] = v.mountToWorld(c.mx, side);
          p.x = wx; p.y = wy; p.yaw = Math.atan2(sx - wx, -(sy - wy)); p.pitch = -0.2; })()`);
        await sleep(400);
        await shot(`vehwalk_${mode}_car_door`);
        await c.x().key('e');
        await sleep(600);
        const back = await where();
        log('car e at the door', back);
        check('car: e at the driver door takes the wheel', back.driving, back);
        // W while seated but not driving (let go from the vehicle menu): no cabin walk
        if (strict) {
          await js(`cdda.vehicleSystem.releaseControls()`);
          for (let i = 0; i < 20 && !(await where()).at; i++) await sleep(100);
          const before = await where();
          await c.x().hold('w', 700);
          await sleep(200);
          const after = await where();
          log('car W while seated', { before, after });
          check('car: let go of the wheel you sit in the seat; W does not walk the cabin', before.at?.kind === 'driver' && after.at?.kind === 'driver' && Math.hypot(after.x - before.x, after.y - before.y) < 0.05, { before, after });
          await c.x().key('e');
          await sleep(500);
          const o2 = await where();
          check('car: e from the seat gets out', o2.at === null && o2.on === null, o2);
        }
      }

      // --- RV: station to station ----------------------------------------------------------
      {
        const s = await atWheel('rv');
        if (typeof s === 'string') return void check('rv: set up', false, s);
        await c.x().key('e');
        await sleep(500);
        const seat = await where();
        log('rv e at the wheel', seat);
        if (strict) check("rv: e at the wheel keeps you in the driver's seat", !seat.driving && seat.at?.kind === 'driver', seat);
        await shot(`vehwalk_${mode}_rv_driver`);
        // the RV faces north: look down it toward the tail, then walk / hop
        await js(`cdda.game.player.yaw = Math.PI; cdda.game.player.pitch = -0.12`);
        await sleep(200);
        const hops = [];
        for (let i = 0; i < 4; i++) {
          const h = await hop('w');
          hops.push({ kind: h.kind, secs: h.secs, dist: h.dist, eye: h.eye });
          if (i === 1) await shot(`vehwalk_${mode}_rv_aisle`);
          if (i === 2) {
            await camera('third');
            await shot(`vehwalk_${mode}_rv_aisle_3p`);
            await camera('first');
          }
        }
        const w = await where();
        log('rv hops (W toward the tail)', { hops, deckY: w.deckY, roofY: w.roofY });
        if (strict) {
          const moved = hops.filter((h) => h.dist > 0.3);
          check('rv: W hops station to station down the RV', moved.length >= 3 && new Set(hops.map((h) => h.kind)).size >= 2, hops);
          check('rv: each hop lands within ~0.8 s (not a 4x seat-cell crawl)', moved.every((h) => h.secs <= 0.85), moved);
          const standing = hops.filter((h) => h.kind === 'deck');
          check('rv: standing in the aisle the eye is on the drawn floor, under the roof', standing.length > 0 && standing.every((h) => h.eye > (w.deckY ?? 0) + 1.3 && h.eye < (w.roofY ?? 9)), { standing, deckY: w.deckY, roofY: w.roofY });
        }
        await shot(`vehwalk_${mode}_rv_back`);
        if (strict) {
          // to the side door: hop toward the nearest spot beside it, then step out through it
          const toDoor: Record<string, any>[] = [];
          for (let i = 0; i < 10 && (await where()).at; i++) {
            const k = await js<string | null>(`window.__vw.keyToDoor()`);
            if (!k) break;
            if ((await where()).at?.kind !== 'driver' && (await js<boolean>(`!!cdda.vehicleSystem.stations.current()?.exits.length`))) await shot(`vehwalk_${mode}_rv_by_door`);
            const h = await hop(k);
            toDoor.push({ key: k, kind: h.kind, secs: h.secs, dist: h.dist });
          }
          const out = await where();
          log('rv hops to the door and out', { toDoor, out });
          check('rv: hopping to the side door and on through it gets you out onto the road', out.at === null && out.on === null && !out.driving, { toDoor, out });
          await js(`(() => { const vs = cdda.vehicleSystem, v = vs.list.find((q) => q.uid === ${s.uid}), p = cdda.game.player; p.yaw = Math.atan2(v.x - p.x, -(v.y - p.y)); p.pitch = 0.05; })()`);
          await sleep(300);
          await shot(`vehwalk_${mode}_rv_out`);
        }
      }

      // --- M1 Abrams: driver -> gunner -> hatch -> out --------------------------------------
      {
        const s = await atWheel('tank_m1_abrams');
        if (typeof s === 'string') return void check('abrams: set up', false, s);
        await shot(`vehwalk_${mode}_abrams_wheel`);
        await c.x().key('e');
        await sleep(500);
        const drv = await where();
        log('abrams e at the wheel', drv);
        if (strict) check("abrams: e at the wheel -> the driver's station (head out of the driver's hatch)", drv.at?.kind === 'driver' && drv.eye > (drv.deckY ?? 9), drv);
        await shot(`vehwalk_${mode}_abrams_driver`);
        // facing north: the turret is aft (south); look back at it
        await js(`cdda.game.player.yaw = Math.PI; cdda.game.player.pitch = -0.1`);
        await sleep(200);
        const toGun = await hopUntil('gunner', ['w', 'w', 'a', 'd'], 6);
        const gun = await where();
        log('abrams hops to the gunner', { toGun, gun });
        if (strict) check('abrams: W from the driver reaches a gunner station', gun.at?.kind === 'gunner' && gun.eye > (gun.deckY ?? 9), { toGun, gun });
        await js(`cdda.game.player.yaw = 0; cdda.game.player.pitch = -0.1`);
        await sleep(200);
        await shot(`vehwalk_${mode}_abrams_gunner`);
        await camera('third');
        await shot(`vehwalk_${mode}_abrams_gunner_3p`);
        await camera('first');
        const toHatch = await hopUntil('hatch', ['a', 'd', 's', 'w'], 8);
        const hatch = await where();
        log('abrams hops to a hatch', { toHatch, hatch });
        if (strict) check('abrams: on to a hatch, head out above the turret', hatch.at?.kind === 'hatch' && hatch.eye > (hatch.turretTop ?? 9), { toHatch, hatch });
        await shot(`vehwalk_${mode}_abrams_hatch`);
        await c.x().key('e');
        await sleep(600);
        const out = await where();
        log('abrams e at the hatch', out);
        if (strict) check('abrams: e at the hatch climbs out onto the road beside the hull', out.at === null && out.on === null && !out.driving && out.eye < 1.8, out);
        await js(`(() => { const vs = cdda.vehicleSystem, v = vs.list.find((q) => q.uid === ${s.uid}), p = cdda.game.player; p.yaw = Math.atan2(v.x - p.x, -(v.y - p.y)); p.pitch = 0.05; })()`);
        await sleep(300);
        await shot(`vehwalk_${mode}_abrams_out`);
      }
    }],
  ];
}
