// Real-input grab and hotbar scenarios, run from tools/realinput.ts:
//   --only grab      BN `G` grab with OS-level keys: push a dresser (it slides, you follow),
//                    into a wall (collides), let go, the `o` menu's "Grab the chair", pull the
//                    chair (hold S), push a shopping cart, a safe too heavy to budge, save and
//                    load (F5) while holding the dresser
//   --only hotbow    a longbow bound to a hotbar slot: the key wields it (was: worn), RMB draws,
//                    the key again puts it away; a jacket on the next slot is worn
//
// cdda.* only builds the test room, places things and reads state; every action is a key or
// mouse event through xdotool.

import type { XInput } from './lib/realinput';

export interface GrabCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

interface GrabRead {
  grab: { kind: string; dx: number; dy: number } | null;
  name: string | null;
  px: number;
  py: number;
  furn: Record<string, string>;
  cart: number | null;
  standIns: number;
  log: string[];
  banner: string;
}

/**
 * A floored room around the survivor (setup): 12×9 tiles of floor, a wall along x = +7, nothing
 * else. Origin `window.__o` = the survivor's tile at setup; looking east.
 */
const ROOM = `(() => {
  const g = cdda.game, p = g.player, m = g.map;
  cdda.godMode(true); cdda.setHour(12); cdda.clearMonsters(40);
  p.str_base = 10; p.resetStats(); p.stamina = p.staminaMax();
  // an open stretch nearby (the shelter's stairwell and its NPCs would get in the way)
  const grid = g.monsters.grid;
  const clear = (x0, y0) => { for (let y = y0 - 6; y <= y0 + 6; y++) for (let x = x0 - 5; x <= x0 + 9; x++) if (!grid.passable(x, y, p.z) || grid.opaque(x, y, p.z) || g.creatureAt(x, y, p.z)) return false; return true; };
  let spot = null;
  outer: for (let r = 0; r < 120; r += 2) for (let a = 0; a < 24; a++) { const x = Math.floor(p.x + Math.cos(a / 24 * 6.283) * r), y = Math.floor(p.y + Math.sin(a / 24 * 6.283) * r); if (clear(x, y)) { spot = [x, y]; break outer; } }
  if (!spot) return null;
  const [ox, oy] = spot, z = p.z;
  for (const v of [...(g.vehicles?.list ?? [])]) if (Math.abs(v.x - ox) < 16 && Math.abs(v.y - oy) < 16) g.vehicles.remove(v);
  for (let y = oy - 5; y <= oy + 5; y++) for (let x = ox - 4; x <= ox + 8; x++) {
    m.setTer(x, y, z, x === ox + 7 ? 't_wall' : 't_floor');
    m.setFurn(x, y, z, 'f_null');
    for (const it of [...m.itemsAt(x, y, z)]) m.removeItem(x, y, z, it);
  }
  window.__o = [ox, oy, z];
  p.x = ox + 0.5; p.y = oy + 0.5; p.yaw = Math.PI / 2; p.pitch = -0.35;
  return window.__o;
})()`;

/** Put the survivor on (dx, dy) from the origin, looking east (setup). */
const at = (dx: number, dy: number, yaw = 'Math.PI / 2') => `(() => { const [ox, oy] = window.__o, p = cdda.game.player; p.x = ox + ${dx} + 0.5; p.y = oy + ${dy} + 0.5; p.yaw = ${yaw}; p.pitch = -0.35; })()`;
const put = (dx: number, dy: number, id: string) => `(() => { const [ox, oy, z] = window.__o; cdda.game.map.setFurn(ox + ${dx}, oy + ${dy}, z, '${id}'); })()`;

const READ = `(() => {
  const g = cdda.game, p = g.player, [ox, oy, z] = window.__o, s = cdda.grab.state();
  const furn = {};
  for (let y = oy - 5; y <= oy + 5; y++) for (let x = ox - 4; x <= ox + 7; x++) { const f = g.map.furnAt(x, y, z).id; if (f !== 'f_null') furn[(x - ox) + ',' + (y - oy)] = f; }
  const cart = (g.vehicles?.list ?? []).find((v) => v.protoId === 'shopping_cart' && Math.abs(v.x - ox) < 12 && Math.abs(v.y - oy) < 12);
  const banner = [...document.querySelectorAll('#ui2 *')].map((e) => e.textContent ?? '').find((t) => /^Holding the /.test(t)) ?? '';
  return { grab: s.grab, name: s.name, px: p.tileX - ox, py: p.tileY - oy, furn, cart: cart ? Math.floor(cart.x) - ox : null, standIns: s.standIns, log: cdda.ui.log().slice(-12), banner };
})()`;

export function grabScenarios(c: GrabCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  const read = () => js<GrabRead>(READ);
  /** Hold keys for `ms`, sampling state; returns the samples. */
  const hold = async (keys: string[], ms: number) => {
    const x = c.x();
    for (const k of keys) await x.down(k);
    const t0 = Date.now();
    const seen: GrabRead[] = [];
    while (Date.now() - t0 < ms) {
      await sleep(120);
      seen.push(await read());
    }
    for (const k of [...keys].reverse()) await x.up(k);
    await sleep(400);
    return seen;
  };
  const where = (r: GrabRead, id: string) => Object.entries(r.furn).find(([, f]) => f === id)?.[0] ?? null;

  return [
    ['grab', 'G grabs; walking pushes a dresser (slides, you follow), a wall stops it, G lets go; o-menu grab + pull a chair; push a shopping cart; a safe too heavy; save/load while holding', async () => {
      await toGameplay();
      const o = await js<number[] | null>(ROOM);
      check('test room built (setup)', !!o, o);
      // --- push a dresser east
      await js(put(1, 0, 'f_dresser'));
      // the room may be a walk from where you woke: let its chunks mesh before looking
      await sleep(2500);
      await c.x().key('G');
      await sleep(250);
      let r = await read();
      check('G on the dresser in front grabs it', r.grab?.kind === 'furniture' && r.name === 'dresser' && r.log.some((l) => /You grab the dresser\./.test(l)), r);
      check('the HUD says what you hold and how to let go', /Holding the dresser/.test(r.banner), r.banner);
      await shot('grab_holding');
      const push = await hold(['w'], 1500);
      r = await read();
      const dAt = where(r, 'f_dresser');
      check('holding W pushes the dresser east tile by tile and you follow behind it', !!dAt && +dAt.split(',')[0] >= 3 && r.px === +dAt.split(',')[0] - 1 && r.py === 0, { dAt, px: r.px });
      check('the dresser slides (a stand-in model glides between tiles)', push.some((s) => s.standIns > 0), push.map((s) => s.standIns));
      check('pushing takes BN time (~0.6 s a tile at Str 10), not a teleport', +(dAt ?? '0,0').split(',')[0] <= 5, dAt);
      await shot('grab_pushed');
      // --- into the wall at x = 7
      await hold(['w'], 3500);
      r = await read();
      check('the wall stops it: "The dresser collides with something." and it stays put', where(r, 'f_dresser') === '6,0' && r.log.some((l) => /The dresser collides with something\./.test(l)), { at: where(r, 'f_dresser'), log: r.log });
      check('bumping the wall is said once, not spammed while W is held', r.log.filter((l) => /collides/.test(l)).length <= 2, r.log);
      await c.x().key('G');
      await sleep(250);
      r = await read();
      check('G again lets go ("You release the dresser.")', !r.grab && r.log.some((l) => /You release the dresser\./.test(l)) && !r.banner, r);
      const standInsLeft = await js<number>('cdda.grab.state().standIns');
      await sleep(800);
      check('no stand-in lingers once the chunk mesh has the dresser', (await js<number>('cdda.grab.state().standIns')) === 0, standInsLeft);

      // --- the `o` menu: grab a chair, then pull it (hold S)
      await js(at(0, -3));
      await js(put(1, -3, 'f_chair'));
      await sleep(300);
      await c.x().key('o');
      await sleep(400);
      const menu = await js<string[][]>('cdda.ui2.state().menu');
      check('the o menu on the chair offers "Grab the chair (drag it)"', menu.flat().some((t) => /Grab the chair/.test(t ?? '')), menu);
      const rect = await js<{ x: number; y: number } | null>(`cdda.ui2.textRect('Grab the chair')`);
      if (rect) await c.x().click(rect.x, rect.y);
      await sleep(300);
      await toGameplay();
      r = await read();
      check('clicking it grabs the chair', r.name === 'chair', r);
      await hold(['s'], 1300);
      r = await read();
      const cAt = where(r, 'f_chair');
      check('holding S (walking backwards) pulls the chair after you', !!cAt && +cAt.split(',')[0] <= 0 && r.px === +cAt.split(',')[0] - 1, { cAt, px: r.px });
      await shot('grab_pulled_chair');
      await c.x().key('G');
      await sleep(200);

      // --- a shopping cart
      await js(at(0, 3));
      const cart = await js<unknown>(`cdda.spawnVehicle('shopping_cart', 1, 0, 0, { force: true })`);
      check('a shopping cart stands in front (setup)', !!cart, cart);
      await sleep(400);
      await c.x().key('G');
      await sleep(250);
      r = await read();
      check('G grabs the shopping cart', r.grab?.kind === 'vehicle' && /Shopping Cart/.test(r.name ?? ''), r);
      await hold(['w'], 1400);
      r = await read();
      await js('(() => { cdda.game.player.pitch = -0.6; })()');
      check('walking pushes the cart ahead of you', (r.cart ?? 0) >= 3 && r.px === (r.cart ?? 0) - 1, { cart: r.cart, px: r.px });
      await shot('grab_cart');
      await c.x().key('G');
      await sleep(200);

      // --- too heavy: a safe at Str 8
      await js(at(0, -1));
      await js(put(1, -1, 'f_safe_c'));
      await js('(() => { const p = cdda.game.player; p.str_base = 8; p.resetStats(); })()');
      await sleep(300);
      await c.x().key('G');
      await sleep(250);
      r = await read();
      check('grabbing the safe warns "It feels really heavy."', r.log.some((l) => /You grab the safe\. It feels really heavy\./.test(l)), r.log);
      await hold(['w'], 900);
      r = await read();
      check("at Str 8 the safe won't budge (BN: too heavy / you strain yourself)", where(r, 'f_safe_c') === '1,-1' && r.log.some((l) => /too heavy for you to budge|strain yourself/.test(l)), { at: where(r, 'f_safe_c'), log: r.log });
      await c.x().key('G');
      await js('(() => { const p = cdda.game.player; p.str_base = 10; p.resetStats(); })()');

      // --- save and load while holding the dresser (it's against the wall: pull it back west)
      await js(at(5, 0));
      await sleep(200);
      await c.x().key('G');
      await sleep(250);
      r = await read();
      check('grabbed the dresser again', r.name === 'dresser', r);
      await c.x().key('F5');
      await sleep(1500);
      const loaded = await js<boolean>('(async () => { await cdda.save.load(); return true; })()').catch(() => false);
      await sleep(1500);
      await toGameplay();
      r = await read();
      check('after save + load you still hold the dresser', r.grab?.kind === 'furniture' && r.name === 'dresser', { loaded, r });
      await hold(['s'], 900);
      r = await read();
      check('and walking backwards still pulls it', where(r, 'f_dresser') !== '6,0', r.furn);
      await c.x().key('G');
    }],

    ['hotbow', 'hotbar: a bound longbow is wielded by its key (not worn), RMB draws it, the key again puts it away; a bound jacket is worn', async () => {
      await toGameplay();
      const setup = await js<string>(`(() => {
        const g = cdda.game, p = g.player;
        cdda.godMode(true); cdda.setHour(12); cdda.clearMonsters(40);
        p.str_base = 10; p.resetStats();
        if (p.inv.wielded) p.inv.unwield();
        cdda.giveItem('backpack', { wear: true });
        cdda.giveItem('longbow'); cdda.giveItem('arrow_wood', { count: 10 }); cdda.giveItem('jacket_light');
        const inv = cdda.inv2; inv.model.refresh(true);
        const view = (id) => [...inv.model.all()].find((a) => a.view.typeId === id && inv.model.onBody(a.loc))?.view;
        inv.hotbar.bind(2, view('longbow')); inv.hotbar.bind(3, view('jacket_light'));
        return [view('longbow')?.name, view('jacket_light')?.name].join(' / ');
      })()`);
      check('longbow and jacket bound to slots 3 and 4 (setup)', /longbow/.test(setup), setup);
      await c.x().key('3');
      await sleep(900);
      const st = await js<{ w: string | null; worn: string[] }>('(() => { const i = cdda.game.player.inv; return { w: i.wielded?.typeId ?? null, worn: i.worn.map((x) => x.typeId) }; })()');
      check('pressing 3 wields the longbow (it used to be worn)', st.w === 'longbow' && !st.worn.includes('longbow'), st);
      await c.x().buttonDown(3);
      await sleep(1200);
      const draw = await js<boolean>('!!cdda.combat.draw');
      await shot('hotbar_bow_drawn');
      await c.x().buttonUp(3);
      check('holding RMB draws the bow', draw, draw);
      await sleep(300);
      await c.x().key('3');
      await sleep(900);
      const away = await js<string | null>('cdda.game.player.inv.wielded?.typeId ?? null');
      check('pressing 3 again puts it away', away === null, away);
      await c.x().key('4');
      await sleep(1500);
      const worn = await js<string[]>('cdda.game.player.inv.worn.map((x) => x.typeId)');
      check('pressing 4 wears the jacket', worn.includes('jacket_light'), worn);
    }],
  ];
}
