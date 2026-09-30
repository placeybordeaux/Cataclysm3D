// Real-input scenario for vehicles v3 phase 1 (src/game/chassis, docs/VEHICLES.md "v3 phase 1"):
// a pickup, a box van and a bus, each mapped onto its chassis template, driven through a town
// with real W / S / V / e presses through xdotool. `cdda.*` only sets the scene (the vehicle at
// the wheel on a town road, the lane ahead cleared of wrecks) and reads the result. Checks:
// the template (drawn body = collision body = the template's outline), the driver sits on the
// template's seat, the drive covers the road without a scratch, and `e` climbs out through a
// door to stand outside the body. Plugged into tools/realinput.ts (run: --only chassisdrive).

import type { DriveCtx } from './realinput_drive';

type Scenario = [name: string, what: string, run: () => Promise<void>];

const CASES: [proto: string, template: string, holdMs: number][] = [
  ['pickup', 'pickup', 4200],
  ['cube_van', 'box_truck', 4800],
  ['bus', 'bus', 6500],
];

export function chassisScenarios(c: DriveCtx): Scenario[] {
  const { js, check, shot, sleep } = c;
  const camera = async (mode: 'first' | 'third' | 'top') => {
    for (let i = 0; i < 4 && (await js<string>(`cdda.renderer.rig.mode`)) !== mode; i++) {
      await c.x().key('v');
      await sleep(250);
    }
    return (await js<string>(`cdda.renderer.rig.mode`)) === mode;
  };

  return [
    ['chassisdrive', 'vehicles v3: a pickup, a box van and a bus on chassis templates driven through town (drawn = collision body, seated on the template seat, e gets out)', async () => {
      for (const [proto, template, holdMs] of CASES) {
        // --- setup: the town nearest the start, a straight N-S road, at the wheel -------------
        const set = await js<Record<string, any> | string>(`(() => {
          const vs = cdda.vehicleSystem, p = cdda.game.player;
          if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); }
          const s = cdda.startLocation();
          const town = cdda.cities().filter((t) => t.size >= 4).sort((a, b) => Math.hypot(a.x - s.omx, a.y - s.omy) - Math.hypot(b.x - s.omx, b.y - s.omy))[0];
          if (!town) return 'no town';
          cdda.teleportOmt(town.x, town.y);
          const r = cdda.roadTrip(${JSON.stringify(proto)}, 3, 12);
          if (!r) return 'no straight road in town';
          const v = vs.driving;
          window.__cd = { uid: v.uid, y0: v.y };
          const cx = Math.floor(v.x / 24), cy = Math.floor(v.y / 24);
          for (let dy = -5; dy <= 2; dy++) for (let dx = -1; dx <= 1; dx++) cdda.game.map.chunk(cx + dx, cy + dy, 0);
          cdda.clearMonsters();
          window.__cdClear = () => {
            // The lane ahead (the body's width + 1 m, 75 m): wrecks moved off it, parked cars
            // beside it stay. Facing north: mount y runs east.
            const b = vs.bodyRect(v), w0 = v.mountToWorld(0, b.y0)[0] - 0.5, w1 = v.mountToWorld(0, b.y1)[0] + 0.5;
            vs.flushPending();
            for (const o of [...vs.list]) {
              if (o === v) continue;
              const ob = vs.bodyRect(o) ?? { x0: o.bounds()[0] - 0.5, x1: o.bounds()[2] + 0.5, y0: o.bounds()[1] - 0.5, y1: o.bounds()[3] + 0.5 };
              const pts = [[ob.x0, ob.y0], [ob.x1, ob.y0], [ob.x0, ob.y1], [ob.x1, ob.y1]].map(([a, c]) => o.mountToWorld(a, c));
              const ox0 = Math.min(...pts.map((q) => q[0])), ox1 = Math.max(...pts.map((q) => q[0])), oy1 = Math.max(...pts.map((q) => q[1])), oy0 = Math.min(...pts.map((q) => q[1]));
              if (ox1 > w0 && ox0 < w1 && oy1 > window.__cd.y0 - 80 && oy0 < window.__cd.y0 + 8) vs.remove(o);
            }
          };
          window.__cdClear();
          const ch = cdda.chassis(v.uid);
          const seat = ch.seats.find((s) => s.driver);
          const [sx, sy] = v.mountToWorld(seat.at[0], seat.at[1]);
          return { uid: v.uid, template: ch.template, body: ch.body, rect: vs.bodyRect(v), seatOff: Math.hypot(p.x - sx, p.y - sy), hp: v.parts.reduce((a, q) => a + q.hp, 0), protoOk: v.protoId === ${JSON.stringify(proto)} };
        })()`);
        if (!check(`${proto}: setup: at the wheel on a town road, lane ahead clear`, typeof set !== 'string' && set.protoOk, set)) continue;
        const s = set as Record<string, any>;
        check(`${proto}: mapped onto the ${template} template`, s.template === template, s.template);
        check(`${proto}: collision body is the template's outline`, JSON.stringify(s.rect) === JSON.stringify(s.body), { rect: s.rect, body: s.body });
        await c.toGameplay();
        await sleep(500);
        // the drawn body: the model's skinned shell (built once a frame has rendered), mount space
        const d = await js<Record<string, number> | null>(`(() => { const v = cdda.vehicleSystem.list.find((q) => q.uid === ${s.uid}), e = cdda.renderer.vehicleView.entries.get(v);
          const m = e && e.skinMeshes && e.skinMeshes[0]; if (!m) return null;
          m.geometry.computeBoundingBox(); const bb = m.geometry.boundingBox;
          return { x0: bb.min.x, x1: bb.max.x, y0: bb.min.z, y1: bb.max.z }; })()`);
        // The shell the renderer draws stays within 10 cm of the collision outline (the outline
        // is 4 cm wider for the wheels; bumpers / mirrors are separate parts).
        const near = d && Math.abs(d.x0 - s.body.x0) < 0.1 && Math.abs(d.x1 - s.body.x1) < 0.1 && Math.abs(d.y0 - s.body.y0) < 0.1 && Math.abs(d.y1 - s.body.y1) < 0.1;
        check(`${proto}: drawn body = collision body (shell within 10 cm of it)`, !!near, { drawn: d, body: s.body });
        check(`${proto}: sitting on the template's driver's seat`, s.seatOff < 1e-6, s.seatOff);

        // --- drive: W held (engine on from roadTrip), then brake ------------------------------
        await camera('third');
        // (chunks streamed in meanwhile may have placed more wrecks)
        await js(`window.__cdClear()`);
        await c.x().hold('w', holdMs);
        await shot(`chassisdrive_${proto}_chase`);
        // Space: the brakes (S would brake and then reverse once stopped)
        for (let i = 0; i < 12 && Math.abs(await js<number>(`cdda.vehicleSystem.driving?.velocity ?? 0`)) > 0.2; i++) await c.x().hold('space', 400);
        const r = await js<Record<string, any>>(`(() => { const vs = cdda.vehicleSystem, v = vs.list.find((q) => q.uid === ${s.uid});
          return { dist: window.__cd.y0 - v.y, v: v.velocity, hp: v.parts.reduce((a, q) => a + q.hp, 0), log: cdda.ui.log().slice(-3) }; })()`);
        check(`${proto}: drove ~40+ m up the road through town without a scratch`, r.dist > 35 && r.hp === s.hp && Math.abs(r.v) < 0.5, r);
        await camera('first');

        // --- e: climb out through a door, standing outside the template body ------------------
        await c.x().key('e');
        await sleep(500);
        const out = await js<Record<string, any>>(`(() => { const vs = cdda.vehicleSystem, v = vs.list.find((q) => q.uid === ${s.uid}), p = cdda.game.player;
          const b = vs.bodyRect(v), [lx, ly] = v.worldToMount(p.x, p.y);
          return { driving: !!vs.driving, inside: lx >= b.x0 && lx <= b.x1 && ly >= b.y0 && ly <= b.y1, on: vs.playerOn()?.v?.uid ?? null, log: cdda.ui.log().slice(-2) }; })()`);
        check(`${proto}: e climbs out through a door and you stand outside the body`, !out.driving && !out.inside && out.on === null, out);
      }
    }],
  ];
}
