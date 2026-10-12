// Real-input "right mouse readies" melee (docs/COMBAT_FEEL.md "Ready stance"), run from
// tools/realinput.ts --only stance [--shots dir]:
//   - LMB alone with a bat does not swing (the crosshair says why)
//   - RMB held raises the bat (and the fists), walking slows to FEEL.readyMoveMul, releasing restores it
//   - RMB + LMB swings and hits a zombie; letting go of RMB mid-swing still lands that blow
//   - Shift + movement while readied lowers the weapon and runs; releasing Shift raises it again
//   - Esc (pointer lock lost) drops the stance; back in play it needs a fresh RMB press
//   - Options' "Swing any time (classic)" brings LMB-from-the-hip swings back
//
// Everything the player does is OS-level input through xdotool (keys, both mouse buttons).
// cdda.* is only used for setup (weapon, god mode, the pinned zombie, the view pointed at it,
// switching the melee control and the hands renderer) and to read state.

import type { XInput } from './lib/realinput';

export interface StanceCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

interface Feel {
  melee: string;
  ready: boolean;
  canSwing: boolean | null;
  moveSpeedMul: number;
  guarding: boolean;
  swing: unknown;
}

/** Midday, no monsters, god mode, a bat, standing in the middle of an open stretch 9 m long each way. */
const SETUP = `(() => {
  const g = cdda.game, p = g.player, grid = g.monsters.grid;
  cdda.setHour(12);
  cdda.godMode(true);
  cdda.clearMonsters(60);
  cdda.setMeleeControl('ready');
  if (!window.__stanceSpot) {
    const clear = (x, y) => { for (let s = -9; s <= 9; s++) for (let w = -2; w <= 2; w++) { const tx = x + w, ty = y + s; if (!grid.passable(tx, ty, p.z) || grid.opaque(tx, ty, p.z) || g.map.furnAt(tx, ty, p.z).id !== 'f_null') return false; } return true; };
    outer: for (let r = 0; r < 160; r += 2) for (let a = 0; a < 24; a++) { const x = Math.floor(p.x + Math.cos(a / 24 * 6.283) * r), y = Math.floor(p.y + Math.sin(a / 24 * 6.283) * r); if (clear(x, y)) { window.__stanceSpot = [x + 0.5, y + 0.5]; break outer; } }
  }
  if (!window.__stanceSpot) return null;
  if (p.inv.wielded?.typeId !== 'bat') { if (p.inv.wielded) p.inv.drop(p.inv.wielded); cdda.giveItem('bat', { wield: true }); }
  p.x = window.__stanceSpot[0]; p.y = window.__stanceSpot[1]; p.yaw = 0; p.pitch = 0; p.stamina = p.staminaMax(); p.crouching = false;
  return { spot: window.__stanceSpot, wielded: p.inv.wielded?.typeId ?? null };
})()`;

const FEEL_STATE = `(() => { const f = cdda.feelState(); return { melee: f.melee, ready: f.ready, canSwing: f.canSwing, moveSpeedMul: f.moveSpeedMul, guarding: f.guarding, swing: f.swing }; })()`;

export function stanceScenarios(c: StanceCtx): Scenario[] {
  const { js, check, shot, sleep } = c;
  const x = () => c.x();
  const feel = () => js<Feel>(FEEL_STATE);
  const why = () => js<string>(`(() => { const w = document.querySelector('.combat-why'); return w && w.style.display !== 'none' ? w.textContent : ''; })()`);
  const listen = () => js(`window.__stEv = []; if (window.__stEvGame !== cdda.game) { window.__stEvGame = cdda.game; cdda.game.events.on('playerAttack', (e) => e.kind === 'melee' && window.__stEv.push({ o: e.outcome, uid: e.target?.uid ?? null })); }`);
  const blows = () => js<{ o: string; uid: number | null }[]>('window.__stEv');
  /** Walk with a held key for `ms` and return metres covered. */
  const walk = async (key: string, ms: number) => {
    const p0 = await js<[number, number]>('[cdda.game.player.x, cdda.game.player.y]');
    await x().hold(key, ms);
    await sleep(80);
    const p1 = await js<[number, number]>('[cdda.game.player.x, cdda.game.player.y]');
    return Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  };
  const reset = async () => {
    const s = await js<{ spot: number[]; wielded: string | null } | null>(SETUP);
    check('setup: an open stretch and a bat', !!s && s.wielded === 'bat', s);
    await sleep(300);
  };
  /** A zombie pinned 1 m north that never swings back, and the view on its chest (setup). */
  const pinZombie = () => js<number>(`(() => {
    const g = cdda.game, p = g.player;
    const uid = cdda.spawnMonster('mon_zombie', 0, -1.0); const m = g.monsters.all.find((z) => z.uid === uid);
    m.hp = 100000; window.__stZ = m;
    const mx = m.x, my = m.y; clearInterval(window.__stPin);
    window.__stPin = setInterval(() => { if (!m.dead) { m.x = mx; m.y = my; m.attackCooldown = 5; m.windup = null; } }, 16);
    p.yaw = Math.atan2(m.x - p.x, -(m.y - p.y)); p.pitch = -0.25;
    return uid;
  })()`);
  const unpin = () => js(`(() => { clearInterval(window.__stPin); cdda.clearMonsters(60); })()`);

  return [
    ['stance', 'melee "right mouse readies" by real input: LMB alone does not swing, RMB raises + slows, RMB+LMB hits, Shift lowers to run, Esc drops it, the classic option restores hip swings', async () => {
      await c.toGameplay();
      await reset();
      await listen();
      // Ease of reading: the bat lowered (3D hands, the default).
      await js(`cdda.chars({ viewmodel: 'model' })`);
      await sleep(400);
      const f0 = await feel();
      check('default melee control is "ready"; nothing held: lowered, full walk speed', f0.melee === 'ready' && !f0.ready && f0.moveSpeedMul === 1, f0);
      await shot('stance_bat_lowered_3d');

      // --- LMB alone
      await x().clickHere(1);
      await sleep(150);
      const line = await why();
      await sleep(600);
      const f1 = await feel();
      check('LMB alone does not swing (no swing, no blow)', !f1.swing && (await blows()).length === 0, { f1, blows: await blows() });
      check('…and the crosshair says why ("hold right mouse to ready")', /hold right mouse to ready/.test(line), line);
      await shot('stance_lmb_refused');

      // --- RMB raises; walk speed drops, restored on release
      const free = await walk('s', 1500);
      await js(SETUP); // back to the middle of the stretch
      await sleep(200);
      await x().buttonDown(3);
      await sleep(350);
      const f2 = await feel();
      check('RMB held: readied, guarding, slower', f2.ready && f2.canSwing === true && f2.guarding && f2.moveSpeedMul < 0.8, f2);
      await shot('stance_bat_readied_3d');
      const readied = await walk('s', 1500);
      const ratio = readied / Math.max(0.01, free);
      const mul = await js<number>('cdda.feel.readyMoveMul');
      check(`backing off readied covers ~readyMoveMul of the distance (${readied.toFixed(2)} m vs ${free.toFixed(2)} m, ratio ${ratio.toFixed(2)}, readyMoveMul ${mul})`, Math.abs(ratio - mul) < 0.12, { readied, free, ratio, mul });

      // --- Shift + movement lowers to run; releasing Shift raises it again
      await js(SETUP);
      await sleep(200);
      await x().down('Shift');
      await x().down('w');
      await sleep(400);
      const fRun = await feel();
      await x().up('w');
      await x().up('Shift');
      await sleep(250);
      const fBack = await feel();
      check('Shift + W while readied: the weapon lowers and you run (full speed, no swing)', !fRun.ready && fRun.canSwing === false && fRun.moveSpeedMul === 1, fRun);
      check('…letting go of Shift with RMB still held raises it again', fBack.ready && fBack.moveSpeedMul < 0.8, fBack);
      await x().buttonUp(3);
      await sleep(250);
      const f3 = await feel();
      check('RMB released: lowered, full walk speed again', !f3.ready && f3.moveSpeedMul === 1 && !f3.guarding, f3);

      // --- RMB + LMB swings and hits a zombie
      await js(SETUP);
      const uid = await pinZombie();
      await sleep(500);
      await listen();
      await x().buttonDown(3);
      await sleep(200);
      for (let i = 0; i < 6 && !(await blows()).some((b) => (b.o === 'hit' || b.o === 'crit') && b.uid === uid); i++) {
        await js(`(() => { const m = window.__stZ, p = cdda.game.player; p.yaw = Math.atan2(m.x - p.x, -(m.y - p.y)); p.pitch = -0.25; })()`);
        await x().clickHere(1);
        if (i === 0) {
          await sleep(120);
          await shot('stance_bat_swing_3d');
        }
        await sleep(1100);
      }
      const hits = await blows();
      check('RMB + LMB swings at the zombie and hits it', hits.some((b) => (b.o === 'hit' || b.o === 'crit') && b.uid === uid), hits);
      check('…every blow went at that zombie', hits.length > 0 && hits.every((b) => b.uid === uid), hits);
      await x().buttonUp(3);
      await sleep(1200);

      // --- releasing RMB mid-swing: that swing still lands, no new one starts
      await listen();
      await x().buttonDown(3);
      await sleep(150);
      await x().clickHere(1);
      await sleep(60);
      await x().buttonUp(3);
      const fMid = await feel();
      await sleep(1300);
      await x().clickHere(1);
      await sleep(900);
      const mid = await blows();
      check('RMB let go right after the click: the swing in progress still resolves (one blow)', !!fMid.swing && mid.length === 1, { fMid, mid });

      // --- Esc while RMB is held: pointer lock goes, the stance drops; back in play it needs a fresh press
      await x().buttonDown(3);
      await sleep(250);
      const fPre = await feel();
      await x().key('Escape');
      await sleep(500);
      const fEsc = await feel();
      const lock = await js<boolean>('cdda.game.input.locked');
      check('Esc with RMB held: pointer lock released and the stance drops (full speed)', fPre.ready && !lock && !fEsc.ready && fEsc.moveSpeedMul === 1, { fPre, fEsc, lock });
      await x().buttonUp(3);
      await c.toGameplay();
      await sleep(200);
      const fRe = await feel();
      check('back in play: lowered until RMB is pressed again', !fRe.ready && fRe.moveSpeedMul === 1, fRe);
      await x().buttonDown(3);
      await sleep(250);
      check('…and a fresh RMB press readies again', (await feel()).ready, await feel());
      await x().buttonUp(3);

      // --- screenshots: sprite hands, and bare fists both ways
      await unpin();
      await js(SETUP);
      await js(`cdda.chars({ viewmodel: 'sprite' })`);
      await sleep(500);
      await shot('stance_bat_lowered_sprite');
      await x().buttonDown(3);
      await sleep(400);
      await shot('stance_bat_readied_sprite');
      await x().buttonUp(3);
      await js(`(() => { cdda.chars({ viewmodel: 'model' }); const p = cdda.game.player; p.inv.drop(p.inv.wielded); })()`);
      await sleep(500);
      await shot('stance_fists_lowered_3d');
      await x().buttonDown(3);
      await sleep(400);
      const fFist = await feel();
      await shot('stance_fists_readied_3d');
      await x().buttonUp(3);
      check('bare hands ready the same way', fFist.ready && fFist.moveSpeedMul < 0.8, fFist);

      // --- the classic option: LMB swings from the hip, RMB is a separate guard
      await js(SETUP);
      await js(`cdda.setMeleeControl('anytime')`);
      const uid2 = await pinZombie();
      await sleep(500);
      await listen();
      for (let i = 0; i < 4 && !(await blows()).some((b) => b.uid === uid2); i++) {
        await x().clickHere(1);
        await sleep(1100);
      }
      const classic = await blows();
      const fC = await feel();
      check('"Swing any time (classic)": LMB alone swings at the zombie', classic.some((b) => b.uid === uid2), classic);
      check('…without slowing you', fC.moveSpeedMul === 1 && !fC.ready, fC);
      await x().buttonDown(3);
      await sleep(250);
      const fG = await feel();
      await x().buttonUp(3);
      check('…and RMB is the old guard (guarding, guardMoveMul)', fG.guarding && Math.abs(fG.moveSpeedMul - (await js<number>('cdda.feel.guardMoveMul'))) < 1e-6, fG);
      await unpin();
      await js(`(() => { cdda.setMeleeControl('ready'); cdda.godMode(false); })()`);
    }],
  ];
}
