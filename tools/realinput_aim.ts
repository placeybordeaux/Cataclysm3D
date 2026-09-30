// Real-input aim-model scenarios (docs/COMBAT_FEEL.md "Aim models"), run from tools/realinput.ts:
//   --only aim          pistol, rifle, shotgun, longbow and a bat at skill 0 and 5, free aim vs classic dice
//   --only aimtiming    the timing model: breath flash, bow ring, active reload, melee beat
//
// A "player" in the loop: the view is pointed at a zombie's chest once (setup, like the other
// combat suites), then everything the player does is OS-level input through xdotool — RMB held
// to aim or draw, LMB to fire, R to reload, Shift to hold breath. For free aim the player
// watches the *drawn* crosshair (the .hud-cross element's on-screen position, what a human
// sees) and clicks when it is over the zombie, like a person timing a shot. Under classic dice
// it clicks once the aim readout says Careful/Precise (or after 1.5 s). Hit rates, damage per
// hit and the crosshair lines are printed; screenshots go to --shots.
//
// cdda.* is only used for setup (weapon, skills, the pinned zombie, the model) and to read state.

import type { XInput } from './lib/realinput';

export interface AimCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

const WEAPONS: Record<string, { gun: string; mag?: string; ammo: string; skill: string; melee?: boolean }> = {
  pistol: { gun: 'glock_19', mag: 'glockmag', ammo: '9mm', skill: 'pistol' },
  rifle: { gun: 'ar15', mag: 'stanag30', ammo: '223', skill: 'rifle' },
  shotgun: { gun: 'remington_870', ammo: 'shot_00', skill: 'shotgun' },
  bow: { gun: 'longbow', ammo: 'arrow_wood', skill: 'archery' },
  bat: { gun: 'bat', ammo: '', skill: 'bashing', melee: true },
};

/** An open stretch, the weapon at `skill`, a zombie `d` m north that stays put (hp high so it takes every shot). */
const SETUP = (weapon: string, skill: number, d: number, model: string) => `(() => {
  const g = cdda.game, p = g.player, grid = g.monsters.grid;
  cdda.setAimModel('${model}');
  cdda.clearMonsters(60);
  if (!window.__aimSpot) {
    cdda.giveItem('backpack', { wear: true });
    const clear = (x, y) => { for (let s = -2; s <= 26; s++) for (let w = -2; w <= 2; w++) { const tx = x + w, ty = y - s; if (!grid.passable(tx, ty, p.z) || grid.opaque(tx, ty, p.z)) return false; } return true; };
    outer: for (let r = 0; r < 120; r += 2) for (let a = 0; a < 24; a++) { const x = Math.floor(p.x + Math.cos(a / 24 * 6.283) * r), y = Math.floor(p.y + Math.sin(a / 24 * 6.283) * r); if (clear(x, y)) { window.__aimSpot = [x + 0.5, y + 0.5]; break outer; } }
  }
  if (!window.__aimSpot) return null;
  const W = ${JSON.stringify(WEAPONS)}['${weapon}'];
  p.str_base = 10; p.dex_base = 8; p.per_base = 8; p.resetStats();
  for (const s of ['gun', 'pistol', 'rifle', 'shotgun', 'archery', 'bashing', 'melee']) p.setSkill(s, ${skill});
  if (p.inv.wielded?.typeId !== W.gun) cdda.giveItem(W.gun, { wield: true });
  const gun = p.inv.wielded;
  if (W.gun === 'longbow') cdda.giveItem(W.ammo, { count: 40 });
  else if (W.ammo && gun) {
    // Spare magazines / rounds in the pack, then the reload key's own code loads the gun (setup).
    if (W.mag) for (let i = 0; i < 3; i++) cdda.giveItem(W.mag, { ammo: W.ammo });
    cdda.giveItem(W.ammo, { count: 60 });
    if (gun.ammoRemaining() <= 0) g.keys.handler('reload')?.();
    cdda.combat.cooldown = 0; cdda.renderer.viewmodel?.freeze(null);
  }
  p.x = window.__aimSpot[0]; p.y = window.__aimSpot[1]; p.stamina = p.staminaMax(); p.recoil = 3000; p.crouching = false;
  if (cdda.aimHud) cdda.aimHud.trail = 1.5;
  const uid = cdda.spawnMonster('mon_zombie', 0, -${d});
  const m = g.monsters.all.find((z) => z.uid === uid); m.hp = 100000; window.__m = m;
  const mx = m.x, my = m.y; clearInterval(window.__pin); window.__pin = setInterval(() => { if (!m.dead) { m.x = mx; m.y = my; m.attackCooldown = 5; m.windup = null; } }, 16);
  return { gun: gun?.typeId ?? null, ammo: gun?.isGun() ? gun.ammoRemaining() : -1, d: Math.hypot(m.x - p.x, m.y - p.y) };
})()`;

/** Point the view at the zombie's chest (setup, not input: the combat suites all start aimed). */
const AIM = `(() => { const m = window.__m, p = cdda.game.player; const d = Math.hypot(m.x - p.x, m.y - p.y); p.yaw = Math.atan2(m.x - p.x, -(m.y - p.y)); p.pitch = Math.atan2(1.1 - 1.6, d); })()`;

/**
 * What the player sees: where the drawn crosshair is, and where the zombie's chest and its
 * half-width are on screen (projected with the live camera).
 */
const LOOK = `(() => {
  const cross = document.querySelector('.hud-cross'); const r = cross.getBoundingClientRect();
  const m = window.__m, cam = cdda.renderer.rig.camera, V = cam.position.constructor;
  const LH = 2.6, z = m.z * LH;
  const c = new V(m.x, z + 1.1, m.y).project(cam), e = new V(m.x, z + 1.1, m.y);
  const p = cdda.game.player; const d = Math.hypot(m.x - p.x, m.y - p.y);
  // a point one body-radius to the side, perpendicular to the view
  const sx = -(m.y - p.y) / d, sy = (m.x - p.x) / d; e.x += sx * m.radius; e.z += sy * m.radius; const ep = e.project(cam);
  const W = innerWidth, H = innerHeight;
  const tx = (c.x + 1) / 2 * W, ty = (1 - c.y) / 2 * H, rad = Math.abs((ep.x - c.x) / 2 * W);
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, tx, ty, rad };
})()`;

export function aimScenarios(c: AimCtx): Scenario[] {
  const { js, check, shot, sleep } = c;
  const x = () => c.x();
  const why = () => js<string>(`(() => { const w = document.querySelector('.combat-why'); return w && w.style.display !== 'none' ? w.textContent : ''; })()`);
  const listen = () => js(`window.__ev = []; window.__evOn || (window.__evOn = cdda.game.events.on('playerAttack', (e) => window.__ev.push({ k: e.kind, o: e.outcome, r: e.reason ?? '', d: e.damage, landed: !!e.landed })))`);

  /** Free aim: wait (up to maxMs) until the drawn crosshair sits on the chest, then click. Returns ms waited. */
  const clickWhenOn = async (maxMs: number, share = 0.6) => {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const l = await js<{ cx: number; cy: number; tx: number; ty: number; rad: number }>(LOOK);
      if (Math.hypot(l.cx - l.tx, (l.cy - l.ty) * 0.5) <= l.rad * share) break;
      await sleep(8);
    }
    await x().clickHere(1);
    return Date.now() - t0;
  };

  /** One configuration: n shots (or swings) by real input; outcomes from the playerAttack events. */
  const series = async (weapon: string, skill: number, model: string, n: number, tag: string, shotName?: string) => {
    const w = WEAPONS[weapon];
    const s = await js<{ gun: string | null; ammo: number; d: number } | null>(SETUP(weapon, skill, w.melee ? 1.0 : 12, model));
    if (!s) return null;
    await sleep(300);
    await js(AIM);
    await listen();
    const shots0 = await js<number>('cdda.combat.shots');
    const waits: number[] = [];
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      await js(AIM);
      if (w.melee) {
        await x().clickHere(1);
        await sleep(900);
      } else {
        await x().buttonDown(3);
        // Settle: ADS / full draw (a bow draws ~1 s at skill 0).
        await sleep(weapon === 'bow' ? 1300 : 500);
        if (shotName && i === 1) await shot(`${shotName}_aiming`);
        if (model === 'dice') {
          const t0 = Date.now();
          while (Date.now() - t0 < 1500 && !/Careful|Precise/.test(await js<string>(`document.querySelector('.aim-level')?.textContent ?? ''`))) await sleep(40);
          await x().clickHere(1);
          waits.push(Date.now() - t0);
        } else waits.push(await clickWhenOn(2500));
        await sleep(weapon === 'bow' ? 900 : 250);
        const line = await why();
        if (line) lines.push(line);
        if (shotName && i === 1) await shot(`${shotName}_after`);
        await x().buttonUp(3);
        await sleep(weapon === 'shotgun' ? 900 : 350);
        if (i % 5 === 4 && !w.melee) {
          // Keep it loaded (real key; the reload time elapses).
          await x().key('r');
          await sleep(weapon === 'shotgun' ? 2800 : 2200);
        }
      }
    }
    await sleep(300);
    const ev = await js<{ k: string; o: string; r: string; d: number; landed: boolean }[]>('window.__ev');
    const mine = ev.filter((e) => (w.melee ? e.k === 'melee' : e.k === 'gun'));
    const hits = mine.filter((e) => e.o === 'hit' || e.o === 'crit' || e.o === 'kill');
    const shots = w.melee ? n : (await js<number>('cdda.combat.shots')) - shots0;
    // Guns: a shot that didn't hit is a miss however it resolved (a hitscan round "lands" in the dirt).
    const misses = w.melee ? mine.filter((e) => e.o === 'miss' || e.o === 'whiff') : { length: Math.max(0, shots - hits.length) };
    const dmg = hits.reduce((a, e) => a + e.d, 0);
    const res = { weapon, skill, model, attempts: w.melee ? n : shots, hits: hits.length, misses: misses.length, dmgPerHit: hits.length ? +(dmg / hits.length).toFixed(1) : 0, waitMs: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0, shots, lines: [...new Set([...lines, ...mine.map((e) => e.r).filter(Boolean)])].slice(0, 4) };
    console.log(`    ${tag}: ${res.hits}/${n} hit, ${res.misses} missed, ${res.dmgPerHit} dmg/hit, ${res.waitMs} ms aiming; lines: ${res.lines.join(' | ')}`);
    return res;
  };

  return [
    ['aim', 'free aim vs classic dice by real input: pistol, rifle, shotgun, longbow and a bat at skill 0 and 5 (hit rate, damage, what the crosshair says)', async () => {
      await c.toGameplay();
      const rows: NonNullable<Awaited<ReturnType<typeof series>>>[] = [];
      for (const model of ['sway', 'dice'])
        for (const weapon of ['pistol', 'rifle', 'shotgun', 'bow', 'bat'])
          for (const skill of [0, 5]) {
            const r = await series(weapon, skill, model, weapon === 'bat' ? 8 : 6, `${model} ${weapon} skill ${skill}`, model === 'sway' && skill === 0 && weapon !== 'bat' ? `aim_${weapon}_s0` : model === 'sway' && weapon === 'pistol' ? 'aim_pistol_s5' : undefined);
            if (!check(`${model} ${weapon} ${skill}: set up`, !!r)) continue;
            rows.push(r!);
          }
      const free = rows.filter((r) => r.model === 'sway');
      check('free aim: a shot or swing timed on the target never misses', free.every((r) => r.misses === 0), free.map((r) => `${r.weapon}${r.skill}:${r.misses}`));
      check('free aim: skill 5 hits harder than skill 0 (every weapon)', ['pistol', 'rifle', 'shotgun', 'bow', 'bat'].every((w) => {
        const a = free.find((r) => r.weapon === w && r.skill === 0), b = free.find((r) => r.weapon === w && r.skill === 5);
        return !!a && !!b && b.dmgPerHit > a.dmgPerHit;
      }), free.map((r) => `${r.weapon}${r.skill}:${r.dmgPerHit}`));
      check('free aim: no "miss:" / "wide:" dice reasons on the crosshair', free.every((r) => r.lines.every((l) => !/^(miss|wide):|clumsy|skill too low/.test(l))), free.flatMap((r) => r.lines));
      const dice = rows.filter((r) => r.model === 'dice');
      check('classic dice still misses at skill 0 (the comparison model is intact)', dice.some((r) => r.skill === 0 && r.misses > 0), dice.map((r) => `${r.weapon}${r.skill}:${r.misses}`));
      // A headshot: the view on the head, a timed click; the crosshair says why it hit hard.
      await js(SETUP('pistol', 5, 10, 'sway'));
      await sleep(300);
      await js(`(() => { const m = window.__m, p = cdda.game.player; const d = Math.hypot(m.x - p.x, m.y - p.y); p.yaw = Math.atan2(m.x - p.x, -(m.y - p.y)); p.pitch = Math.atan2(1.52 - 1.6, d); })()`);
      await x().buttonDown(3);
      await sleep(600);
      await x().clickHere(1);
      await sleep(120);
      await shot('aim_headshot');
      await x().buttonUp(3);
      const head = await js<{ zone: string; text: string } | null>('cdda.aimState().lastHit');
      check('a shot with the crosshair on the head is a headshot, and the crosshair says ×2', head?.zone === 'head' && /HEADSHOT ×2/.test(head.text), head);
      console.log('\n    | model | weapon | skill | hit | missed | dmg/hit | aiming ms |');
      for (const r of rows) console.log(`    | ${r.model} | ${r.weapon} | ${r.skill} | ${r.hits}/${r.attempts} | ${r.misses} | ${r.dmgPerHit} | ${r.waitMs} |`);
    }],
    ['aimtiming', 'timing model by real input: hold breath with Shift while aiming (flash), active reload, bow release ring, melee beat', async () => {
      await c.toGameplay();
      // Screenshots need ~0.4 s, longer than a timing window: they're taken in a second pass with
      // the simulation frozen (tactical pause) once the moment is reached, never between a cue and the click.
      const frozenShot = async (name: string) => {
        await js('cdda.game.tacticalPause = true');
        await shot(name);
        await js('cdda.game.tacticalPause = false');
      };
      const readout = () => js<string>(`document.querySelector('.aim-level')?.textContent ?? ''`);
      // --- breath: RMB, then Shift; the readout says NOW during the perfect window: click.
      await js(SETUP('pistol', 0, 12, 'timing'));
      await sleep(300);
      await js(AIM);
      await x().buttonDown(3);
      await sleep(500);
      await listen();
      await x().down('Shift_L');
      let saw = '';
      for (let i = 0; i < 60 && !/NOW/.test(saw); i++) {
        saw = await readout();
        if (!/NOW/.test(saw)) await sleep(10);
      }
      await x().clickHere(1);
      check('Shift while aiming holds the breath and the readout flashes NOW', /NOW/.test(saw), saw);
      check('holding Shift while aiming does not run', !(await js<boolean>('cdda.game.player.running')));
      await sleep(300);
      const perfect = await js<{ perfect: boolean; text: string } | null>('cdda.aimState().lastHit');
      check('a shot on the flash is perfect (×1.25)', !!perfect?.perfect && /perfect ×1.25/.test(perfect.text), perfect);
      await x().up('Shift_L');
      await sleep(1600);
      // (the screenshot pass: hold the breath again and freeze on NOW)
      await x().down('Shift_L');
      for (let i = 0; i < 60 && !/NOW/.test(await readout()); i++) await sleep(10);
      await frozenShot('timing_breath_now');
      await x().up('Shift_L');
      await x().buttonUp(3);
      // --- active reload: fire one, R, then R again when the marker is in the bright band.
      await sleep(1600);
      await x().clickHere(1);
      await sleep(300);
      await x().key('r');
      type R = { reload: { t: number; dur: number; band: { start: number; end: number } } | null; perfectNext: boolean };
      let st = await js<R>('cdda.aimState()');
      if (st.reload) {
        const target = ((st.reload.band.start + st.reload.band.end) / 2) * st.reload.dur;
        while ((st = await js<R>('cdda.aimState()')).reload && st.reload!.t < target - 0.03) await sleep(8);
        await x().key('r', 0);
        await sleep(100);
        const s2 = await js<R>('cdda.aimState()');
        check('reload pressed again in the bright band: a perfect reload ("next shot steady")', s2.perfectNext, s2);
        // screenshot pass
        await sleep(400);
        await x().clickHere(1);
        await sleep(300);
        await x().key('r');
        st = await js<R>('cdda.aimState()');
        if (st.reload) {
          while ((st = await js<R>('cdda.aimState()')).reload && st.reload!.t < st.reload!.band.start * st.reload!.dur) await sleep(8);
          await frozenShot('timing_reload_band');
        }
      } else check('the reload started an active-reload bar', false, st);
      // --- bow ring: draw (RMB), loose (LMB) as the closing ring meets the reticle.
      await js(SETUP('bow', 0, 12, 'timing'));
      await sleep(300);
      await js(AIM);
      await listen();
      await x().buttonDown(3);
      let ring = false;
      for (let i = 0; i < 300 && !ring; i++) {
        ring = await js<boolean>(`(() => { const d = cdda.combat.draw; return !!d && d.t >= d.full && d.heldFull >= 0.5; })()`);
        if (!ring) await sleep(8);
      }
      await x().clickHere(1);
      await sleep(900);
      const bowHit = await js<{ perfect: boolean; text: string } | null>('cdda.aimState().lastHit');
      check('a bow loosed as the ring meets the reticle is perfect', !!bowHit?.perfect, bowHit);
      await x().buttonUp(3);
      await sleep(600);
      await x().buttonDown(3);
      for (let i = 0; i < 300; i++) {
        if (await js<boolean>(`(() => { const d = cdda.combat.draw; return !!d && d.t >= d.full && d.heldFull >= 0.3; })()`)) break;
        await sleep(8);
      }
      await frozenShot('timing_bow_ring');
      await x().buttonUp(3);
      // --- melee beat: a bat; click again just before the next swing is ready.
      await js(SETUP('bat', 0, 1.0, 'timing'));
      await sleep(300);
      await js(AIM);
      await x().clickHere(1);
      await sleep(50);
      for (let i = 0; i < 200; i++) {
        if (await js<boolean>('cdda.combat.cooldown > 0 && cdda.combat.cooldown <= 0.07')) break;
        await sleep(5);
      }
      await x().clickHere(1);
      await sleep(150);
      check('a click on the beat chains a perfect swing', await js<boolean>('!!cdda.combat.swing?.perfect'));
      await sleep(600);
      console.log(`    melee beat line: ${await why()}`);
    }],
  ];
}
