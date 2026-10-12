// Real-input regression: switching your own headlights on (the real H key, at the wheel) must
// not put out another car's. The renderer has a fixed light budget (one shadowed spot per
// headlight slot, a small point-light pool) and the car you drive always wins it, so the
// other car's beam vanished from the road the moment you turned yours on.
//
// `cdda.*` only sets the scene: a car at the wheel on a straight road at midnight, a second
// car parked ahead in the other lane facing you with its lights on, and toggles the OTHER
// car's lights to measure what its beam adds. The other car's beam is the pixels it brightens
// with your lights off (A - B); with yours on (C - D) the same pixels must still gain most of
// that light. Shots go to shots/headlights/. Plugged into tools/realinput.ts (--only headlightshare).

import type { Page } from 'puppeteer-core';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { XInput } from './lib/realinput';

export interface HeadlightCtx {
  page: () => Page;
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

const OUT = 'shots/headlights';

export function headlightScenarios(c: HeadlightCtx): Scenario[] {
  const { js, check, sleep } = c;
  const grab = async (name: string): Promise<PNG> => {
    await sleep(600);
    const bytes = await c.page().screenshot({ type: 'png' });
    mkdirSync(resolve(OUT), { recursive: true });
    writeFileSync(resolve(OUT, `${name}.png`), bytes);
    return PNG.sync.read(Buffer.from(bytes));
  };
  const other = (on: boolean) => js(`(() => { const o = cdda.vehicleSystem.list.find((q) => q.uid === window.__hlOther); o.lightsOn = ${on}; })()`);
  /** Lit headlight spots (range over 50 m: materials.ts HEADLIGHT_MIN_RANGE) and which car each one sits on. */
  const spots = () => js<{ on: string; d: number }[]>(`(() => {
    const vs = cdda.vehicleSystem, own = vs.driving, o = vs.list.find((q) => q.uid === window.__hlOther), out = [];
    cdda.renderer.scene.traverse((l) => {
      if (!l.isSpotLight || l.distance <= 50 || !(l.intensity > 0)) return;
      const d = (v) => Math.hypot(l.position.x - v.x, l.position.z - v.y);
      out.push(d(own) < d(o) ? { on: 'own', d: +d(own).toFixed(1) } : { on: 'other', d: +d(o).toFixed(1) });
    });
    return out;
  })()`);
  return [
    ['headlightshare', "turning your own headlights on (H) leaves another car's headlights lighting the road", async () => {
      await c.toGameplay();
      const setup = await js<{ own: number; other: number } | null>(`(() => {
        const vs = cdda.vehicleSystem;
        if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); }
        const r = cdda.roadTrip('car'); if (!r) return null;
        const v = vs.driving;
        for (const o of [...vs.list]) if (o !== v && Math.hypot(o.x - v.x, o.y - v.y) < 60) vs.remove(o);
        cdda.clearMonsters(80);
        cdda.setHour(0);
        cdda.renderer.timeScale = 0;
        v.addFuel('battery', 1e9);
        if (v.lightsOn) vs.toggleHeadlights(v);
        // facing north (270); the other car 22 m ahead in the oncoming lane, facing you (90)
        const o = vs.spawn('car', Math.floor(v.x - 4), Math.floor(v.y - 22), v.z, 90, { fuel: 100, status: 0, force: true });
        o.addFuel('battery', 1e9);
        o.lightsOn = true;
        window.__hlOther = o.uid;
        return { own: v.uid, other: o.uid };
      })()`);
      if (!check('a car at the wheel on a road, another parked ahead with its lights on', !!setup, setup)) return;
      // chase camera: both cars and the road between them in view
      for (let i = 0; i < 4 && (await js<string>(`cdda.renderer.rig.mode`)) !== 'third'; i++) {
        await c.x().key('v');
        await sleep(250);
      }
      await sleep(2500);
      const a = await grab('A_other_on_own_off');
      await other(false);
      const b = await grab('B_other_off_own_off');
      await other(true);
      await sleep(300);
      const before = await spots();
      check('own lights off: a headlight spot sits on the other car', before.some((s) => s.on === 'other'), before);

      await c.x().key('h');
      await sleep(400);
      const ownOn = await js<boolean>(`cdda.vehicleSystem.driving?.lightsOn ?? false`);
      if (!check('H turned your own headlights on', ownOn, await js(`cdda.ui.log().slice(-3)`))) return;
      const cc = await grab('C_other_on_own_on');
      const after = await spots();
      await other(false);
      const d = await grab('D_other_off_own_on');
      await other(true);
      check('own lights on: one spot on your car, one still on the other car', after.some((s) => s.on === 'own') && after.some((s) => s.on === 'other'), after);

      // Luma gain the other car's lights give each pixel, with your lights off and on.
      const luma = (p: PNG, i: number) => 0.2126 * p.data[i] + 0.7152 * p.data[i + 1] + 0.0722 * p.data[i + 2];
      let mask = 0, gainOff = 0, gainOn = 0;
      // rows 40..H-60: skip the HUD strips at the top and bottom
      for (let y = 40; y < a.height - 60; y++)
        for (let x = 0; x < a.width; x++) {
          const i = (y * a.width + x) * 4;
          const g = luma(a, i) - luma(b, i);
          if (g < 12) continue;
          mask++;
          gainOff += g;
          gainOn += Math.max(0, luma(cc, i) - luma(d, i));
        }
      const kept = gainOff ? gainOn / gainOff : 0;
      const detail = { mask, gainOff: Math.round(gainOff), gainOn: Math.round(gainOn), kept: +kept.toFixed(2) };
      console.log('    headlight share:', JSON.stringify(detail));
      check('the other car lights a patch of road to begin with', mask > 2000, detail);
      check("with yours on, the other car's beam keeps at least half its light", kept >= 0.5, detail);

      await c.x().key('h');
      await js(`(() => {
        const vs = cdda.vehicleSystem, o = vs.list.find((q) => q.uid === window.__hlOther);
        if (o) vs.remove(o);
        cdda.renderer.timeScale = 1;
        if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); }
      })()`);
    }],
  ];
}
