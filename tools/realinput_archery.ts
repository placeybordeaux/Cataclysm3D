// Real-input archery scenario (docs/COMBAT_FEEL.md "Ranged: archery"), run from tools/realinput.ts:
//   --only archery
// Wield a longbow with arrows, hold RMB to draw and aim at a zombie 8 m away, loose with LMB,
// then at 20 m; every miss must say why at the crosshair; no muzzle flash; the arrow takes time
// to get there; then walk the arrows and take them back with quick loot (r), and check every
// arrow is in the inventory, still lying about, stuck in the dead zombie's spot, or broke.
//
// cdda.* only sets the scene (an open stretch of road, the bow, a zombie standing still, the
// aim — aiming is the combat suites' job) and reads state; drawing, loosing and looting are
// OS-level mouse and key input through xdotool.

import type { XInput } from './lib/realinput';

export interface ArcheryCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

/** An open stretch (a clear 5-wide corridor north of the spot), the bow, arrows, a zombie `d` m north. */
const SETUP = (d: number, first: boolean) => `(() => {
  const g = cdda.game, p = g.player, grid = g.monsters.grid;
  // These checks are about BN's dice (aim levels, spread, why-missed lines): the Classic dice
  // aim model. Free aim has its own suite (realinput_aim.ts).
  cdda.setAimModel('dice');
  cdda.clearMonsters(60);
  ${first ? `cdda.giveItem('backpack', { wear: true }); cdda.giveItem('longbow', { wield: true }); cdda.giveItem('arrow_wood', { count: 20 });
  p.str_base = 10; p.resetStats(); cdda.loot.setStyle('quick');
  window.__broke = 0; g.events.on('message', (m) => { if (/breaks\\.$/.test(m.text)) window.__broke++; });
  const clear = (x, y) => { for (let s = -2; s <= 26; s++) for (let w = -2; w <= 2; w++) { const tx = x + w, ty = y - s; if (!grid.passable(tx, ty, p.z) || grid.opaque(tx, ty, p.z)) return false; } return true; };
  outer: for (let r = 0; r < 120; r += 2) for (let a = 0; a < 24; a++) { const x = Math.floor(p.x + Math.cos(a / 24 * 6.283) * r), y = Math.floor(p.y + Math.sin(a / 24 * 6.283) * r); if (clear(x, y)) { window.__spot = [x + 0.5, y + 0.5]; break outer; } }` : ''}
  if (!window.__spot) return null;
  p.x = window.__spot[0]; p.y = window.__spot[1]; p.stamina = p.staminaMax(); p.recoil = 3000;
  const uid = cdda.spawnMonster('mon_zombie', 0, -${d});
  const m = g.monsters.all.find((z) => z.uid === uid); m.hp = 400; window.__m = m;
  const mx = m.x, my = m.y; clearInterval(window.__pin); window.__pin = setInterval(() => { if (!m.dead) { m.x = mx; m.y = my; m.attackCooldown = 1; } }, 16);
  return { spot: window.__spot, d: Math.hypot(m.x - p.x, m.y - p.y) };
})()`;

/** Aim at the zombie's chest (setup, not input). */
const AIM = `(() => { const m = window.__m, p = cdda.game.player; p.yaw = Math.atan2(m.x - p.x, -(m.y - p.y)); p.pitch = Math.atan2(1.15 - 1.6, Math.hypot(m.x - p.x, m.y - p.y)); })()`;

const ARROWS = `(() => {
  const g = cdda.game, p = g.player; let n = 0;
  const add = (it) => { for (const i of it.walk()) { if (i.typeId === 'arrow_wood') n += i.count(); if (i.ammoId === 'arrow_wood') n += i.charges; } };
  for (const it of p.inv.topLevel()) add(it);
  const carried = n;
  const s = window.__spot; let ground = 0; const piles = [];
  for (let y = Math.floor(s[1]) - 40; y <= Math.floor(s[1]) + 5; y++) for (let x = Math.floor(s[0]) - 8; x <= Math.floor(s[0]) + 8; x++) {
    let k = 0; for (const it of g.map.itemsAt(x, y, p.z)) if (it.typeId === 'arrow_wood') k += it.count();
    if (k) { ground += k; piles.push([x, y, k]); }
  }
  const stuck = window.__m && !window.__m.dead ? window.__m.stuck.items.reduce((a, i) => a + i.count(), 0) : 0;
  return { carried, ground, stuck, broke: window.__broke ?? 0, piles, flying: cdda.combat.flights.length };
})()`;

export function archeryScenarios(c: ArcheryCtx): Scenario[] {
  const { js, check, shot, sleep } = c;
  const x = () => c.x();
  const why = () => js<string>(`(() => { const w = document.querySelector('.combat-why'); return w && w.style.display !== 'none' ? w.textContent : ''; })()`);
  const readout = () => js<string>(`document.querySelector('.aim-level')?.textContent ?? ''`);

  /**
   * One real shot: hold RMB until fully drawn and aimed (`holdMs`), LMB, let go of RMB. Returns
   * the resolved outcome and the crosshair's reason (polled while the arrow flies).
   */
  const loose = async (holdMs: number, tag: string, shotName?: string) => {
    await js(AIM);
    await js(`window.__ev = []; window.__evOn || (window.__evOn = cdda.game.events.on('playerAttack', (e) => window.__ev.push({ o: e.outcome, r: e.reason ?? '', landed: !!e.landed, t: performance.now() })))`);
    await x().buttonDown(3);
    await sleep(holdMs);
    await js(AIM);
    const drawn = await js<{ draw: boolean; full: boolean; readout: string; recoil: number; spreadR: number }>(`(() => { const d = cdda.combat.draw; const c = document.querySelector('.combat-hud circle[stroke-dasharray]'); return { draw: !!d, full: !!d && d.t >= d.full, readout: document.querySelector('.aim-level')?.textContent ?? '', recoil: Math.round(cdda.game.player.recoil), spreadR: c ? +c.getAttribute('r') : 0 }; })()`);
    if (shotName) await shot(shotName);
    const t0 = await js<number>('performance.now()');
    const flash0 = await js<number>('cdda.combat.flashShots');
    await x().clickHere(1);
    await sleep(40);
    const inAir = await js<number>('cdda.combat.flights.length');
    await x().buttonUp(3);
    let reason = '';
    for (let i = 0; i < 20; i++) {
      await sleep(60);
      reason ||= await why();
      if ((await js<number>('cdda.combat.flights.length')) === 0 && i > 3) break;
    }
    reason ||= await why();
    const ev = await js<{ o: string; r: string; landed: boolean; t: number }[]>('window.__ev');
    const hit = ev.find((e) => e.o === 'hit' || e.o === 'crit' || e.o === 'kill');
    const miss = ev.find((e) => e.o === 'miss');
    const first = ev.find((e) => !e.landed || e.o !== 'whiff');
    const flash = (await js<number>('cdda.combat.flashShots')) - flash0;
    console.log(`    ${tag}: drawn=${drawn.full} recoil=${drawn.recoil} spread=${drawn.spreadR}px readout="${drawn.readout}" inAir=${inAir} → ${hit ? hit.o : miss ? 'miss' : 'no hit'}${reason ? ` "${reason}"` : ''} after ${first ? Math.round(first.t - t0) : '-'} ms`);
    return { drawn, inAir, hit: !!hit, miss: !hit, reason, travelMs: first ? first.t - t0 : -1, flash, events: ev };
  };

  return [
    ['archery', 'longbow: RMB draws and aims, LMB looses; the arrow flies (no flash, not instant), misses say why at 8 m and 20 m; arrows are recovered (conserved)', async () => {
      await c.toGameplay();
      const s = await js<{ spot: number[]; d: number } | null>(SETUP(8, true));
      if (!check('found an open stretch to shoot on', !!s, s)) return;
      await sleep(600);
      const before = await js<{ carried: number }>(ARROWS);
      await js(AIM);
      await sleep(300);
      await shot('archery_rest');
      const info = await js<string>(`cdda.ui.log().slice(-4).join(' | ')`);

      // --- 8 m: the first shot, watched closely
      const s1 = await loose(1500, '8 m #1', 'archery_drawn_8m');
      check('holding RMB draws the bow fully and aims (readout shows the aim level and the distance)', s1.drawn.full && /Careful|Precise|Regular/.test(s1.drawn.readout) && /8 m/.test(s1.drawn.readout), s1.drawn);
      check('LMB looses an arrow that is in the air (not hitscan)', s1.inAir > 0 || s1.travelMs >= 60, { inAir: s1.inAir, ms: s1.travelMs });
      check('no muzzle flash for a bow', s1.flash === 0, s1.flash);
      const shots8 = [s1];
      const reasons: string[] = [];
      if (s1.reason) reasons.push(s1.reason);
      let savedWhy = false;
      for (let i = 2; i <= 8 && !shots8.some((q) => q.hit); i++) {
        await sleep(400);
        const q = await loose(1300, `8 m #${i}`);
        shots8.push(q);
        if (q.reason) reasons.push(q.reason);
        if (q.miss && q.reason && !savedWhy) {
          await shot('archery_why_8m');
          savedWhy = true;
        }
      }
      const misses8 = shots8.filter((q) => q.miss);
      check('every miss at 8 m says why near the crosshair', misses8.every((q) => !!q.reason), misses8.map((q) => q.reason));
      check('an arrow hits the zombie at 8 m within 8 shots', shots8.some((q) => q.hit), shots8.map((q) => q.reason || (q.hit ? 'hit' : '?')));
      await sleep(500);
      await shot('archery_after_8m');

      // --- 20 m
      await js(SETUP(20, false));
      await sleep(500);
      const shots20 = [];
      for (let i = 1; i <= 5; i++) {
        const q = await loose(i === 1 ? 2200 : 1400, `20 m #${i}`, i === 1 ? 'archery_drawn_20m' : undefined);
        shots20.push(q);
        if (q.reason) reasons.push(q.reason);
        if (i === 1 && q.miss) await shot('archery_why_20m');
        await sleep(300);
      }
      const misses20 = shots20.filter((q) => q.miss);
      check('every miss at 20 m says why near the crosshair', misses20.every((q) => !!q.reason), misses20.map((q) => q.reason));
      check('at 20 m the arrow takes visibly longer to arrive (≥ 250 ms)', shots20.some((q) => q.travelMs >= 250), shots20.map((q) => Math.round(q.travelMs)));
      // A snap shot (LMB alone: drawn and loosed at once, no aiming) right after moving.
      await js(`cdda.game.player.recoil = 3000`);
      let snapWhy = '';
      for (let i = 0; i < 4 && !snapWhy; i++) {
        await js(AIM);
        await js(`cdda.game.player.recoil = 3000; window.__ev = []`);
        await x().clickHere(1);
        for (let k = 0; k < 20 && !snapWhy; k++) {
          await sleep(60);
          const ev = await js<{ o: string; r: string }[]>('window.__ev');
          if (ev.some((e) => e.o === 'hit' || e.o === 'crit')) break;
          snapWhy = ev.find((e) => e.o === 'miss')?.r ?? '';
        }
        if (snapWhy) await shot('archery_why_snap');
        await sleep(600);
      }
      console.log(`    snap shot: "${snapWhy}"`);
      check('an unaimed snap shot that misses says to hold RMB and aim', !snapWhy || /unsteady aim — hold RMB/.test(snapWhy), snapWhy);
      // Too weak for the longbow: RMB refuses to draw and the crosshair says what it takes.
      await js(`(() => { const p = cdda.game.player; window.__str = p.str_base; p.str_base = 4; p.resetStats(); })()`);
      await x().buttonDown(3);
      await sleep(250);
      const weak = await why();
      const weakDraw = await js<boolean>('!!cdda.combat.draw');
      await shot('archery_too_weak');
      await x().buttonUp(3);
      await js(`(() => { const p = cdda.game.player; p.str_base = window.__str; p.resetStats(); })()`);
      check('too weak to draw: no draw, and the crosshair says "too weak to draw this bow (Str 10 needed)"', !weakDraw && /too weak to draw this bow \(Str 10 needed\)/.test(weak), { weak, weakDraw });
      await sleep(1200);
      console.log(`    reasons seen: ${[...new Set(reasons)].join(' | ')}  (${info})`);
      await shot('archery_landed');
      const mid = await js<{ carried: number; ground: number; stuck: number; broke: number; piles: number[][] }>(ARROWS);
      check('fired arrows are lying about, stuck in the zombie, or broke (none vanished)', mid.carried + mid.ground + mid.stuck + mid.broke === before.carried, { before: before.carried, mid });

      // --- recover: the zombie falls (its arrows drop), then walk the piles and take them (quick loot, r)
      await js(`(() => { const m = window.__m; clearInterval(window.__pin); cdda.game.monsters.die(m, 'player'); })()`);
      await sleep(300);
      const piles = (await js<{ piles: number[][] }>(ARROWS)).piles;
      let aimedOk = 0;
      for (const [px, py] of piles.slice(0, 12)) {
        // Stand a step south of the pile (setup, like the loot suite's standAt), then aim with the real mouse.
        await js(`(() => { const p = cdda.game.player; p.x = ${px} + 0.5; p.y = ${py} + 1.5; })()`);
        await sleep(200);
        for (let i = 0; i < 3; i++) {
          const d = await js<{ dyaw: number; dpitch: number; sens: number }>(`(() => { const g = cdda.game, p = g.player; const tx = ${px} + 0.5, ty = ${py} + 0.5;
            const yaw = Math.atan2(tx - p.x, -(ty - p.y)); const pitch = Math.atan2(0 - 1.6, Math.hypot(tx - p.x, ty - p.y));
            let dyaw = yaw - p.yaw; dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw)); return { dyaw, dpitch: pitch - p.pitch, sens: g.mouseSensitivity }; })()`);
          if (Math.abs(d.dyaw) < 0.04 && Math.abs(d.dpitch) < 0.04) break;
          await x().move(d.dyaw / d.sens, -d.dpitch / d.sens, 6);
          await sleep(150);
        }
        const t = await js<{ x: number; y: number } | null>('cdda.target()');
        if (t && t.x === px && t.y === py) aimedOk++;
        await x().key('r');
        await sleep(350);
      }
      await sleep(300);
      const after = await js<{ carried: number; ground: number; stuck: number; broke: number; piles: number[][] }>(ARROWS);
      console.log(`    arrows: ${before.carried} carried before; after the fight ${mid.carried} carried, ${mid.ground} on the ground, ${mid.stuck} stuck, ${mid.broke} broke; after picking up ${after.carried} carried, ${after.ground} left (${aimedOk}/${Math.min(12, piles.length)} piles aimed)`);
      await shot('archery_recovered');
      check('conservation: carried + left on the ground + broken == what you started with', after.carried + after.ground + after.broke === before.carried, { before: before.carried, after });
      check('quick loot (r at the crosshair) brings arrows back', after.carried > mid.carried, { mid: mid.carried, after: after.carried });
      await js(`cdda.clearMonsters(60)`);
    }],
  ];
}
