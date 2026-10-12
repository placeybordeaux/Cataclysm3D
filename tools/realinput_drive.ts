// Real-input scenario for driving collision against the drawn car body (src/game/vehicles.ts
// bodyContacts, docs/VEHICLES.md "Collision"): W/S/V are real key presses through xdotool;
// `cdda.*` only sets the scene (a car on a road, a parked car or wall placed ahead, a trip to
// the refugee center) and reads the result. Plugged into tools/realinput.ts
// (run: --only drivecollide).

import type { XInput } from './lib/realinput';

export interface DriveCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

// Page-side helpers, installed once: world AABB of a vehicle's drawn body (vehicles here are
// axis-aligned), part HP totals, and a fresh car at the wheel on a clear road.
const HELPERS = `(() => {
  if (window.__dc) return;
  const vs = cdda.vehicleSystem;
  const aabb = (v) => {
    const b = vs.bodyRect(v);
    const pts = [[b.x0, b.y0], [b.x0, b.y1], [b.x1, b.y0], [b.x1, b.y1]].map(([a, c]) => v.mountToWorld(a, c));
    return { x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), y1: Math.max(...pts.map((p) => p[1])) };
  };
  const hp = (v) => v.parts.reduce((a, p) => a + p.hp, 0);
  const byUid = (u) => vs.list.find((q) => q.uid === u);
  /** A car on a straight road, you at the wheel (engine running), nothing else within 40 m. */
  const trip = () => {
    if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); }
    const r = cdda.roadTrip('car'); if (!r) return null;
    const v = vs.driving;
    for (const o of [...vs.list]) if (o !== v && Math.hypot(o.x - v.x, o.y - v.y) < 40) vs.remove(o);
    cdda.clearMonsters();
    return v;
  };
  /** Park a pristine car at (x, y) facing f (grids may overlap others'; bodies don't). */
  const park = (x, y, f, fuel = 0) => {
    const v = vs.spawn('car', Math.floor(x), Math.floor(y), cdda.game.player.z, f, { fuel, status: 2, force: true });
    v.x = x; v.y = y; v.velocity = 0; v.engineOn = false;
    for (const q of v.parts) if (q.def.id.startsWith('door')) q.open = false;
    v.version++; vs.reindex(v);
    return v;
  };
  /** Stand beside world point (x, y), \`d\` m off along (nx, ny), looking at it (setup for a shot). */
  const view = (x, y, nx, ny, d = 4.5) => {
    if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); }
    const p = cdda.game.player, ox = x + nx * d, oy = y + ny * d;
    Object.assign(p, { x: ox, y: oy, yaw: Math.atan2(x - ox, -(y - oy)), pitch: -0.32 });
  };
  window.__dc = { aabb, hp, byUid, trip, park, view };
})()`;

export function driveScenarios(c: DriveCtx): Scenario[] {
  const { js, check, shot, sleep } = c;
  const log = () => js<string[]>(`cdda.ui.log().slice(-6)`);
  /** V until the camera is `mode` (driving: chase = third, cockpit = first, top-down = top). */
  const camera = async (mode: 'first' | 'third' | 'top') => {
    for (let i = 0; i < 4 && (await js<string>(`cdda.renderer.rig.mode`)) !== mode; i++) {
      await c.x().key('v');
      await sleep(250);
    }
    return (await js<string>(`cdda.renderer.rig.mode`)) === mode;
  };

  return [
    ['drivecollide', 'driving collision follows the drawn body: 0.3 m past a parked car, a squeeze in the refugee-center lot, rams stop where the paint touches', async () => {
      await js(HELPERS);

      // --- 1. past a parked car with 0.3 m between the paint -------------------------------
      const pass = await js<{ uid: number; puid: number; gap: number } | null>(`(() => {
        const { trip, park, aabb } = window.__dc;
        const v = trip(); if (!v) return null;
        const a = aabb(v), b = cdda.vehicleSystem.bodyRect(v);
        // facing north (270): mount y runs east; park its twin 0.3 m west of the paint, 14 m ahead
        const o = park(v.x - (a.x1 - a.x0) - 0.3, v.y - 14, v.facing);
        const ao = aabb(o);
        void b; return { uid: v.uid, puid: o.uid, gap: a.x0 - ao.x1 };
      })()`);
      check('setup: at the wheel on a road, a parked car ahead in the next lane, 0.3 m of air between the paint', !!pass && Math.abs(pass.gap - 0.3) < 0.02, pass);
      if (pass) {
        await c.toGameplay();
        const hp0 = await js<[number, number]>(`[window.__dc.hp(window.__dc.byUid(${pass.uid})), window.__dc.hp(window.__dc.byUid(${pass.puid}))]`);
        check('top-down camera (V)', await camera('top'));
        await c.x().hold('w', 2500);
        await shot('drivecollide_pass_top');
        await c.x().hold('w', 1200);
        await c.x().hold('s', 1600);
        await sleep(200);
        const r = await js<{ hp: [number, number]; past: number; v: number }>(`(() => { const { hp, byUid, aabb } = window.__dc, v = byUid(${pass.uid}), o = byUid(${pass.puid});
          return { hp: [hp(v), hp(o)], past: aabb(o).y0 - aabb(v).y1, v: v.velocity }; })()`);
        check('drove past without touching it (tail beyond its nose, no damage either side)', r.past > 0 && r.hp[0] === hp0[0] && r.hp[1] === hp0[1], { ...r, hp0, log: await log() });
        await camera('first');
      }

      // --- 1b. for comparison, the old whole-tile crashes (cdda.vehicleCrashes('tiles')): the
      // same pass scrapes the parked car with ~0.3 m of air between the paint. With the old
      // immovable-vehicle model too, so the parked car stays put and the air stays measurable
      // (momentum crashes would shove it off down the road). -------------------------------
      const old = await js<{ uid: number; puid: number } | null>(`(() => {
        cdda.vehicleCrashes('tiles');
        cdda.vehicleCrashModel('immovable');
        const { trip, park, aabb } = window.__dc;
        const v = trip(); if (!v) return null;
        const a = aabb(v), o = park(v.x - (a.x1 - a.x0) - 0.3, v.y - 14, v.facing);
        return { uid: v.uid, puid: o.uid };
      })()`);
      if (old) {
        await c.toGameplay();
        check('top-down camera (V)', await camera('top'));
        await c.x().hold('w', 3700);
        await sleep(300);
        const r = await js<{ gap: number; log: string[] }>(`(() => { const { byUid, aabb } = window.__dc, a = aabb(byUid(${old.uid})), o = aabb(byUid(${old.puid}));
          return { gap: a.x0 - o.x1, log: cdda.ui.log().slice(-3) }; })()`);
        check('whole tiles (the old way, for comparison): the same pass crashes with air between the paint', r.gap > 0.2 && r.log.some((m) => /rams into the /.test(m)), r);
        await shot('drivecollide_pass_tiles_top');
        await camera('first');
      }
      await js(`cdda.vehicleCrashes('body'); cdda.vehicleCrashModel('momentum')`);

      // --- 2. ram a parked car: the crash is where the bumpers meet ---------------------------
      const ram = await js<{ uid: number; puid: number; py: number } | null>(`(() => {
        const { trip, park } = window.__dc;
        const v = trip(); if (!v) return null;
        const o = park(v.x, v.y - 13, v.facing);
        return { uid: v.uid, puid: o.uid, py: o.y };
      })()`);
      check('setup: a parked car 13 m ahead in your lane', !!ram, ram);
      if (ram) {
        await c.toGameplay();
        const hp0 = await js<[number, number]>(`[window.__dc.hp(window.__dc.byUid(${ram.uid})), window.__dc.hp(window.__dc.byUid(${ram.puid}))]`);
        await c.x().hold('w', 3200);
        await sleep(300);
        const r = await js<{ gap: number; hp: [number, number]; v: number; shoved: number; log: string[] }>(`(() => { const { hp, byUid, aabb } = window.__dc, v = byUid(${ram.uid}), o = byUid(${ram.puid});
          return { gap: aabb(v).y0 - aabb(o).y1, hp: [hp(v), hp(o)], v: v.velocity, shoved: ${ram.py} - o.y, log: cdda.ui.log().slice(-4) }; })()`);
        // Momentum crashes (2026-10): the parked car is shoved down the road rather than acting
        // as a wall, so the bumpers part again; what must hold is that they never overlap.
        check('rammed it: the bumpers met without overlapping and the parked car was shoved ahead', r.gap > -0.005 && r.shoved > 0.5, r);
        check('both cars are damaged and the log says so', r.hp[0] < hp0[0] && r.hp[1] < hp0[1] && r.log.some((m) => /rams into the /.test(m)), { ...r, hp0 });
        await js(`(() => { const { byUid, aabb, view } = window.__dc, v = byUid(${ram.uid}), a = aabb(v); view((a.x0 + a.x1) / 2, a.y0, 1, 0.35); })()`);
        await sleep(600);
        await shot('drivecollide_ram_car');
      }

      // --- 3. ram a wall -------------------------------------------------------------------
      const wall = await js<{ uid: number; face: number } | null>(`(() => {
        const { trip } = window.__dc;
        const v = trip(); if (!v) return null;
        const wy = Math.floor(v.y - 12), m = cdda.game.map;
        for (let x = Math.floor(v.x) - 6; x <= Math.floor(v.x) + 6; x++) m.setTer(x, wy, v.z, 't_concrete_wall');
        return { uid: v.uid, face: wy + 1 };
      })()`);
      check('setup: a concrete wall across the road 12 m ahead', !!wall, wall);
      if (wall) {
        await c.toGameplay();
        await c.x().hold('w', 3200);
        await sleep(300);
        const r = await js<{ gap: number; v: number; log: string[] }>(`(() => { const { byUid, aabb } = window.__dc, v = byUid(${wall.uid});
          return { gap: aabb(v).y0 - ${wall.face}, v: v.velocity, log: cdda.ui.log().slice(-4) }; })()`);
        check('rammed the wall: stopped with the bumper on it (gap under 3 cm)', r.gap > -0.005 && r.gap < 0.03 && Math.abs(r.v) < 0.5 && r.log.some((m) => /rams into the .*wall/i.test(m)), r);
        await js(`(() => { const { byUid, aabb, view } = window.__dc, v = byUid(${wall.uid}), a = aabb(v); view((a.x0 + a.x1) / 2, a.y0, 1, 0.45); })()`);
        await sleep(600);
        await shot('drivecollide_ram_wall');
      }

      // --- 4. the refugee center's parking lot: through a gap between parked vehicles that the
      // body fits (a few cm to spare on each side) but its 4-tile grid would not -------------
      const lot = await js<{ uid: number; a: number; b: number; gap: number; width: number; through: boolean; room: number } | string>(`(() => {
        const vs = cdda.vehicleSystem, { aabb, park } = window.__dc, p = cdda.game.player;
        if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); }
        const f = cdda.findOmt('evac_center', 90); if (!f) return 'no refugee center';
        cdda.teleportOmt(f.x, f.y);
        for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) cdda.game.map.chunk(f.x + dx, f.y + dy, 0);
        vs.flushPending();
        cdda.clearMonsters();
        const probe = park(p.x, p.y, 270), W = aabb(probe).x1 - aabb(probe).x0; vs.remove(probe);
        const near = vs.list.filter((q) => q.z === 0 && Math.hypot(q.x - (f.x * 24 + 12), q.y - (f.y * 24 + 12)) < 160 && q.facing % 90 === 0 && vs.bodyRect(q));
        const boxes = near.map((q) => [q, aabb(q)]);
        const m = cdda.game.map;
        const clear = (x0, y0, x1, y1) => {
          for (let y = Math.floor(y0); y <= Math.floor(y1); y++) for (let x = Math.floor(x0); x <= Math.floor(x1); x++) {
            const t = m.terAt(x, y, 0), fu = m.furnAt(x, y, 0);
            if (t.move_cost <= 0 || fu.move_cost_mod < 0 || fu.id !== 'f_null') return false;
          }
          return boxes.every(([, b]) => b.x1 <= x0 || b.x0 >= x1 || b.y1 <= y0 || b.y0 >= y1);
        };
        const seen = [];
        // pairs side by side with a gap the body fits by 0.1..0.5 m a side; drive through along
        // the other axis
        for (const [A, a] of boxes) for (const [B, b] of boxes) {
          if (A === B) continue;
          for (const axis of ['x', 'y']) {
            const [lo, hi, s0, s1] = axis === 'x' ? ['x0', 'x1', 'y0', 'y1'] : ['y0', 'y1', 'x0', 'x1'];
            const gap = b[lo] - a[hi];
            if (gap < W + 0.2 || gap > W + 1.0) continue;
            const o0 = Math.max(a[s0], b[s0]), o1 = Math.min(a[s1], b[s1]);
            if (o1 - o0 < 0.8) continue;
            seen.push(\`\${A.protoId}|\${B.protoId} \${axis} gap \${gap.toFixed(2)} overlap \${(o1 - o0).toFixed(2)}\`);
            const c = (a[hi] + b[lo]) / 2, h = W / 2 + 0.05;
            for (const dir of [1, -1]) {
              // the nose starts 2 m before the pair (the body behind it); past it, at least 1 m
              // clear (in seed 1's refugee center the lot ends at a wall a few m on)
              const slab = (s0, s1) => axis === 'x' ? clear(c - h, Math.min(s0, s1), c + h, Math.max(s0, s1)) : clear(Math.min(s0, s1), c - h, Math.max(s0, s1), c + h);
              const start = dir > 0 ? o0 - 2 : o1 + 2, back = start - dir * 6.5, exit = dir > 0 ? o1 : o0;
              if (!slab(back, exit)) continue;
              let room = 0;
              while (room < 12 && slab(exit + dir * room, exit + dir * (room + 0.1))) room += 0.1;
              if (room < 1) continue;
              // along y (the pair side by side in x): facing 90 = south, 270 = north
              const facing = axis === 'x' ? (dir > 0 ? 90 : 270) : (dir > 0 ? 0 : 180);
              const v = park(p.x, p.y, facing, 100);
              const bb = aabb(v), cx = (bb.x0 + bb.x1) / 2 - v.x, cy = (bb.y0 + bb.y1) / 2 - v.y, len = axis === 'x' ? bb.y1 - bb.y0 : bb.x1 - bb.x0;
              const along = start - dir * len / 2;
              if (axis === 'x') { v.x = c - cx; v.y = along - cy; } else { v.x = along - cx; v.y = c - cy; }
              vs.reindex(v); v.version++;
              cdda.enterVehicle(v.uid);
              // progress, signed along the way you drive: body centre vs the pair's middle, tail vs
              // its far edge, nose vs whatever is beyond it, and vs where it came in (to back out)
              window.__lot = () => {
                const q = aabb(v), mid = axis === 'x' ? (q.y0 + q.y1) / 2 : (q.x0 + q.x1) / 2;
                return { centre: dir * mid - dir * (o0 + o1) / 2, tail: dir * mid - len / 2 - dir * exit, room: dir * exit + room - (dir * mid + len / 2), entry: dir * mid + len / 2 - dir * (dir > 0 ? o0 : o1), v: v.velocity };
              };
              return { uid: v.uid, a: A.uid, b: B.uid, gap, width: W, through: room > len + 0.6, room };
            }
          }
        }
        return \`no squeeze found in the lot (\${near.length} vehicles, W \${W.toFixed(2)}; blocked: \${seen.join('; ')})\`;
      })()`);
      check('setup: at the refugee center, lined up with a gap between two parked vehicles the body fits', typeof lot !== 'string', lot);
      if (typeof lot !== 'string') {
        check(`the gap (${lot.gap.toFixed(2)} m) is under the 4-tile grid's width but over the body's (${lot.width.toFixed(2)} m)`, lot.gap < 4 && lot.gap > lot.width, lot);
        await c.toGameplay();
        const hp0 = await js<number[]>(`[${lot.uid}, ${lot.a}, ${lot.b}].map((u) => window.__dc.hp(window.__dc.byUid(u)))`);
        // Creep through in short W taps, stopping halfway for the shots; all the way through when
        // there's room past the pair, else up to what's beyond it and then back out in reverse.
        type Lot = { centre: number; tail: number; room: number; entry: number; v: number };
        let st = await js<Lot>(`window.__lot()`);
        let shots = false;
        for (let i = 0; i < 80 && st.tail < 0.3 && st.room > 0.7; i++) {
          await c.x().hold('w', st.v > 1.5 ? 60 : 250);
          await sleep(120);
          st = await js<Lot>(`window.__lot()`);
          if (!shots && st.centre >= 0) {
            shots = true;
            await c.x().hold('s', 700);
            await sleep(300);
            await shot('drivecollide_lot_cockpit');
            check('top-down camera (V)', await camera('top'));
            await sleep(300);
            await shot('drivecollide_lot_top');
            await camera('first');
          }
        }
        await c.x().hold('s', 250);
        await sleep(400);
        st = await js<Lot>(`window.__lot()`);
        const hpNow = () => js<number[]>(`[${lot.uid}, ${lot.a}, ${lot.b}].map((u) => window.__dc.hp(window.__dc.byUid(u)))`);
        let hp = await hpNow();
        if (lot.through) check('squeezed through: tail past the pair, no damage to any of the three', st.tail > 0 && hp.every((h, i) => h === hp0[i]), { st, hp, hp0, log: await log() });
        else {
          check(`into the gap as far as it goes (${lot.room.toFixed(1)} m past the pair, less than a car): body in the gap, nose by what's beyond, no damage`, st.centre > 0 && st.room < 1 && hp.every((h, i) => h === hp0[i]), { st, hp, hp0, log: await log() });
          // S held: brake, then reverse back out the way it came
          for (let i = 0; i < 20 && st.entry > -0.5; i++) {
            await c.x().hold('s', 500);
            st = await js<Lot>(`window.__lot()`);
          }
          await c.x().hold('w', 300);
          await sleep(300);
          st = await js<Lot>(`window.__lot()`);
          hp = await hpNow();
          check('reversed back out of the gap without touching either side', st.entry < 0 && hp.every((h, i) => h === hp0[i]), { st, hp, hp0, log: await log() });
        }
        await js(`(() => { const vs = cdda.vehicleSystem; if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); } })()`);
      }
    }],
    ['crashmomentum', 'momentum crashes (vehicleImpact.ts): an Abrams clips and then rams a parked ambulance and keeps going, a car spins a parked car, a car into a parked tank stops hard', async () => {
      await js(HELPERS);
      // Page side: put a parked vehicle `ahead` m in front of the one you drive, `side` m to its
      // right, turned `turn` deg from it; read back what happened.
      await js(`(() => {
        const vs = cdda.vehicleSystem;
        const centre = (v) => { const b = vs.physRect(v); return v.mountToWorld((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2); };
        window.__cm = {
          centre,
          place(proto, ahead, side, turn) {
            const v = vs.driving, [cx, cy] = centre(v), a = v.facing * Math.PI / 180;
            const o = vs.spawn(proto, Math.floor(cx), Math.floor(cy), v.z, (v.facing + turn + 360) % 360, { fuel: 0, status: 2, force: true });
            o.engineOn = false; o.velocity = 0;
            for (const q of o.parts) if (q.def.id.startsWith('door')) q.open = false;
            const [ox, oy] = centre(o);
            o.x += cx + Math.cos(a) * ahead - Math.sin(a) * side - ox;
            o.y += cy + Math.sin(a) * ahead + Math.cos(a) * side - oy;
            o.version++; vs.reindex(o);
            return o.uid;
          },
          read(uid) {
            const v = vs.driving, o = window.__dc.byUid(uid), [vx, vy] = centre(v), [ox, oy] = centre(o);
            return { mph: v.velocity * 2.2369363, dist: Math.hypot(ox - vx, oy - vy), ox, oy, of: o.facing, oslide: cdda.vehicleMotion(uid).slideMph,
              torso: cdda.game.player.hp.torso.cur, dead: cdda.game.player.dead, hp: window.__dc.hp(v), ohp: window.__dc.hp(o) };
          },
        };
      })()`);
      type Read = { mph: number; dist: number; ox: number; oy: number; of: number; oslide: number; torso: number; dead: boolean; hp: number; ohp: number };
      const read = (uid: number) => js<Read>(`window.__cm.read(${uid})`);
      /**
       * Hold W (real key) until `uid` has been hit and `after` ms have passed, shooting a frame
       * sequence from `shotsFrom` m out; returns the state just before the hit, the slowest the
       * driven vehicle got in the second after it, and the end state.
       */
      const ramWithW = async (uid: number, tag: string, opts: { shotsFrom?: number; maxMs?: number; after?: number } = {}) => {
        const s0 = await read(uid);
        let pre = s0, minMph = Infinity, hitAt = 0, frame = 0, maxTurn = 0;
        const t0 = Date.now();
        await c.x().down('w');
        try {
          while (Date.now() - t0 < (opts.maxMs ?? 25000)) {
            const s = await read(uid);
            const hit = Math.hypot(s.ox - s0.ox, s.oy - s0.oy) > 0.05 || Math.abs(s.of - s0.of) > 0.5;
            if (!hit) pre = s;
            else if (!hitAt) hitAt = Date.now();
            if (hitAt) minMph = Math.min(minMph, s.mph);
            maxTurn = Math.max(maxTurn, Math.abs(((s.of - s0.of + 540) % 360) - 180));
            if (s.dist < (opts.shotsFrom ?? 14) && frame < 8 && (!hitAt || Date.now() - hitAt < 1500)) {
              await shot(`crash_${tag}_${frame++}`);
              continue;
            }
            if (hitAt && Date.now() - hitAt > (opts.after ?? 1500)) break;
            await sleep(60);
          }
        } finally {
          await c.x().up('w');
        }
        await sleep(400);
        await shot(`crash_${tag}_after`);
        return { pre, minMph, maxTurn, hit: !!hitAt, end: await read(uid) };
      };
      const trip = (proto: string) => js<boolean>(`(() => { const vs = cdda.vehicleSystem; if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); }
        if (!cdda.roadTrip('${proto}', 6)) return false; const v = vs.driving;
        for (const o of [...vs.list]) if (o !== v && Math.hypot(o.x - v.x, o.y - v.y) < 90) vs.remove(o);
        cdda.clearMonsters(); return true; })()`);
      check('crash model is momentum (the default)', (await js<string>(`cdda.vehicleCrashModel()`)) === 'momentum');

      // --- 1. Abrams clips a parked ambulance at an angle (its nose sticks into the lane) -----
      if (check('setup: at the wheel of an Abrams on a long straight road', await trip('tank_m1_abrams'))) {
        const amb = await js<number>(`window.__cm.place('ambulance', 62, -3.2, 35)`);
        await c.toGameplay();
        check('top-down camera (V)', await camera('top'));
        const r = await ramWithW(amb, 'tank_clips_ambulance', { shotsFrom: 16 });
        check('the Abrams got going under W and hit the ambulance', r.hit && r.pre.mph > 15, r);
        check('tank barely slowed (kept over 70% of its speed through the hit)', r.minMph > r.pre.mph * 0.7, r);
        check('ambulance shoved and spun (moved over 1.5 m, turned over 15 deg)', Math.hypot(r.end.ox - r.pre.ox, r.end.oy - r.pre.oy) > 1.5 && r.maxTurn > 15, r);
        check('driver unhurt (under 10 torso damage), alive', !r.end.dead && r.pre.torso - r.end.torso < 10, { r, log: await log() });
      }

      // --- 2. Abrams head-on into an ambulance parked across the lane: plows it --------------
      if (check('setup: Abrams again, ambulance broadside across the lane', await trip('tank_m1_abrams'))) {
        const amb = await js<number>(`window.__cm.place('ambulance', 62, 0, 90)`);
        await c.toGameplay();
        check('chase camera (V)', await camera('third'));
        const r = await ramWithW(amb, 'tank_plows_ambulance', { shotsFrom: 18, after: 2000 });
        check('head-on: the tank keeps going (over 70%) and pushes the ambulance down the road', r.hit && r.minMph > r.pre.mph * 0.7 && Math.hypot(r.end.ox - r.pre.ox, r.end.oy - r.pre.oy) > 4, r);
        check('driver alive and barely jolted', !r.end.dead && r.pre.torso - r.end.torso < 10, { r, log: await log() });
        check('the ambulance is damaged, the tank much less', r.pre.ohp - r.end.ohp > r.pre.hp - r.end.hp, r);
      }

      // --- 3. a car clips the tail of a parked car: it spins out -----------------------------
      if (check('setup: in a car, a parked car ahead overlapping a third of the lane', await trip('car'))) {
        const other = await js<number>(`window.__cm.place('car', 45, -1.5, 0)`);
        await c.toGameplay();
        check('top-down camera (V)', await camera('top'));
        const r = await ramWithW(other, 'car_spins_car', { shotsFrom: 12 });
        check('hit it at speed and it spun out (over 90 deg, W still held) and moved', r.hit && r.pre.mph > 15 && r.maxTurn > 90 && Math.hypot(r.end.ox - r.pre.ox, r.end.oy - r.pre.oy) > 1, r);
        check('the car was slowed but not stopped dead (glancing)', r.minMph < r.pre.mph - 2 && r.minMph > 3, r);
        check('driver alive', !r.end.dead, r);
      }

      // --- 4. a car into a parked tank: stops hard, the tank doesn't care --------------------
      if (check('setup: in a car, a parked Abrams across the lane ahead', await trip('car'))) {
        const tank = await js<number>(`window.__cm.place('tank_m1_abrams', 45, 0, 90)`);
        await c.toGameplay();
        check('chase camera (V)', await camera('third'));
        const r = await ramWithW(tank, 'car_into_tank', { shotsFrom: 14, after: 600 });
        const moved = Math.hypot(r.end.ox - r.pre.ox, r.end.oy - r.pre.oy);
        const msgs = await log();
        check('the car stopped hard (to under 3 mph) and the tank barely moved (under 0.5 m)', r.hit && r.pre.mph > 20 && r.minMph < 3 && moved < 0.5, { r, moved });
        check('the driver felt it (an impact message or torso damage)', r.pre.torso > r.end.torso || msgs.some((m) => /power of the impact|rams into the M1/.test(m)), { r, msgs });
      }
      await js(`(() => { const vs = cdda.vehicleSystem; if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); } })()`);
      await camera('first');
    }],
    ['riders', 'your body rides in the seat outside first person: hands on the bars / wheel, feet on pedals / pegs / floor, pedalling with speed, leaning with the bike; none in the cockpit view or the billboard mode', async () => {
      await js(HELPERS);
      await js(`cdda.chars('model')`);
      interface RC { kind: string | null; visible: boolean; alive: boolean; handErr: number; footErr: number; hip: [number, number, number]; ageMs: number }
      const rider = () => js<RC | null>(`cdda.renderer.vehicleView.riderCheck()`);
      const seated = (r: RC | null) => !!r && r.alive && r.visible && r.ageMs < 500 && r.handErr < 0.03 && r.footErr < 0.03;
      const entry = () => js<{ pedal: number; lean: number; v: number; steer: number }>(`(() => { const vv = cdda.renderer.vehicleView, v = cdda.vehicleSystem.driving, e = v && vv.entries.get(v);
        return e ? { pedal: e.pedalShown, lean: e.lean.rotation.x, v: v.velocity, steer: v.steer } : null; })()`);
      for (const proto of ['bicycle', 'motorcycle', 'car']) {
        // a fresh one on a clear road, you on it (setup only; everything after is real keys)
        const ok = await js<boolean>(`(() => { const vs = cdda.vehicleSystem; if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); }
          if (!cdda.roadTrip('${proto}')) return false; const v = vs.driving;
          for (const o of [...vs.list]) if (o !== v && Math.hypot(o.x - v.x, o.y - v.y) < 40) vs.remove(o);
          cdda.clearMonsters(); return !!v; })()`);
        check(`setup: on a ${proto} on a road`, ok);
        if (!ok) continue;
        await c.toGameplay();
        check(`${proto}: chase camera (V)`, await camera('third'));
        // the world streams in around the new spot before the first shot
        await sleep(proto === 'bicycle' ? 4000 : 1500);
        let r = await rider();
        const want = proto === 'car' ? 'seat' : proto;
        check(`${proto}, stopped: the body is in the seat (${want}), hands and feet on the controls`, seated(r) && r!.kind === want, r);
        await shot(`riders_${proto}_stopped`);
        // Mouse-look orbits the chase camera: swing round to a three-quarter view from the right
        // front to see the pose (the view keeps that offset while riding).
        const look = () => js<number>(`(() => { const d = cdda.game.player.yaw - (cdda.vehicleSystem.driving.facing + 90) * Math.PI / 180; return Math.atan2(Math.sin(d), Math.cos(d)); })()`);
        for (let i = 0; i < 30 && Math.abs(await look()) < 1.95; i++) await c.x().move(60, 0, 4);
        await sleep(300);
        await shot(`riders_${proto}_stopped_side`);
        if (proto === 'bicycle') {
          // the old look for comparison (cdda.vehicleRiders(false)): a riderless "ghost" bike
          await js(`cdda.vehicleRiders(false)`);
          await sleep(300);
          check('vehicleRiders(false): no body at the wheel (the old behaviour)', (await rider()) === null);
          await shot('riders_bicycle_before_ghost');
          await js(`cdda.vehicleRiders(true)`);
          await sleep(300);
        }
        await c.x().down('w');
        await sleep(proto === 'bicycle' ? 3500 : 2000);
        const e0 = await entry();
        await sleep(150);
        const e1 = await entry();
        r = await rider();
        check(`${proto}, riding straight: still seated`, seated(r), { r, e1 });
        if (proto === 'bicycle') check('bicycle: the pedals turn with the speed (stepped)', !!e0 && !!e1 && e1.v > 1 && e0.pedal !== e1.pedal, { e0, e1 });
        await shot(`riders_${proto}_straight`);
        await c.x().down('a');
        await sleep(proto === 'car' ? 450 : 900);
        const et = await entry();
        r = await rider();
        check(`${proto}, turning: still seated${proto === 'car' ? ' (hands follow the wheel)' : ', the bike leans into the turn'}`, seated(r) && (proto === 'car' || Math.abs(et?.lean ?? 0) > 0.03), { r, et });
        await shot(`riders_${proto}_turning`);
        await c.x().up('a');
        if (proto === 'car') {
          // straighten up and stop on the road for the top-down view
          await c.x().hold('d', 400);
          await c.x().up('w');
          await c.x().hold('s', 1800);
        }
        await c.x().up('w');
        // back behind it for the next one
        for (let i = 0; i < 30 && Math.abs(await look()) > 0.3; i++) await c.x().move(-60, 0, 4);
        if (proto === 'car') {
          check('car: top-down camera (V)', await camera('top'));
          await sleep(400);
          r = await rider();
          check('car, top-down: seated, seen through the missing roof', seated(r), r);
          await shot('riders_car_top');
          check('car: cockpit camera (V)', await camera('first'));
          await sleep(300);
          const fp = await js<{ rider: unknown; hands: boolean | null }>(`(() => { const vv = cdda.renderer.vehicleView, e = vv.entries.get(cdda.vehicleSystem.driving); return { rider: vv.riderCheck(), hands: e.cockpit ? e.cockpit.hands?.group.visible ?? null : null }; })()`);
          check('car, cockpit view: no body, the first-person fists are back on the wheel', fp.rider === null && fp.hands !== false, fp);
          await camera('third');
          await js(`cdda.chars('billboard')`);
          await sleep(300);
          check('billboard mode: no 3D rider (the old behaviour)', (await rider()) === null);
          await js(`cdda.chars('model')`);
        }
        await c.x().hold('s', 1500);
      }
      await js(`(() => { const vs = cdda.vehicleSystem; if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); } })()`);
      await camera('first');
    }],
  ];
}
