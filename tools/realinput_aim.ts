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
const SETUP = (weapon: string, skill: number, d: number, model: string, mon = 'mon_zombie', facing: number | null = null) => `(() => {
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
  const uid = cdda.spawnMonster('${mon}', 0, -${d}); window.__uid = uid;
  const m = g.monsters.all.find((z) => z.uid === uid); m.hp = 100000; window.__m = m;
  const mx = m.x, my = m.y; clearInterval(window.__pin); window.__pin = setInterval(() => { if (!m.dead) { m.x = mx; m.y = my; m.attackCooldown = 5; m.windup = null; ${facing === null ? '' : `m.facing = ${facing}; m.aggroCharacter = false; m.anger = 0;`} } }, 16);
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
  // The chest as drawn: the model's torso box when there is one (it rides the ground relief), else 1.1 m.
  const t = cdda.modelPart?.(m.uid, 'torso'); const cx = t ? t.x : m.x, cy = t ? t.y : m.y, ch = t ? t.h : z + 1.1;
  const c = new V(cx, ch, cy).project(cam), e = new V(cx, ch, cy);
  const p = cdda.game.player; const d = Math.hypot(m.x - p.x, m.y - p.y);
  // a point one body-radius to the side, perpendicular to the view
  const sx = -(m.y - p.y) / d, sy = (m.x - p.x) / d; e.x += sx * m.radius; e.z += sy * m.radius; const ep = e.project(cam);
  const W = innerWidth, H = innerHeight;
  const tx = (c.x + 1) / 2 * W, ty = (1 - c.y) / 2 * H, rad = Math.abs((ep.x - c.x) / 2 * W);
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, tx, ty, rad };
})()`;

/** Point the drawn camera's centre at a world point (game coords; iterate: an over-the-shoulder camera moves as it turns). */
const AIM_POINT = (pt: string) => `(() => {
  const P = ${pt}; if (!P) return false;
  const p = cdda.game.player, cam = cdda.renderer.rig.camera;
  for (let i = 0; i < 4; i++) {
    cdda.renderer.render(0);
    const c = cam.position; const dx = P.x - c.x, dy = P.y - c.z, dh = P.h - c.y;
    p.yaw = Math.atan2(dx, -dy); p.pitch = Math.atan2(dh, Math.hypot(dx, dy));
  }
  return true;
})()`;

export function aimScenarios(c: AimCtx): Scenario[] {
  const { js, check, shot, sleep } = c;
  const x = () => c.x();
  const why = () => js<string>(`(() => { const w = document.querySelector('.combat-why'); return w && w.style.display !== 'none' ? w.textContent : ''; })()`);
  // Own globals (the archery suite has its own listener on window.__ev), re-hooked if the game object was replaced.
  const listen = () => js(`window.__aimEv = []; if (window.__aimEvGame !== cdda.game) { window.__aimEvGame = cdda.game; cdda.game.events.on('playerAttack', (e) => window.__aimEv.push({ k: e.kind, o: e.outcome, r: e.reason ?? '', d: e.damage, landed: !!e.landed })); }`);

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
    const ev = await js<{ k: string; o: string; r: string; d: number; landed: boolean }[]>('window.__aimEv');
    const mine = ev.filter((e) => (w.melee ? e.k === 'melee' : e.k === 'gun'));
    const hits = mine.filter((e) => e.o === 'hit' || e.o === 'crit' || e.o === 'kill');
    const shots = w.melee ? n : (await js<number>('cdda.combat.shots')) - shots0;
    // Guns: a shot that didn't hit is a miss however it resolved (a hitscan round "lands" in the dirt).
    const misses = w.melee ? mine.filter((e) => e.o === 'miss' || e.o === 'whiff') : { length: Math.max(0, shots - hits.length) };
    const dmg = hits.reduce((a, e) => a + e.d, 0);
    // Plain body hits (no head/limb/graze/weak spot/glancing factor): what skill alone does to a hit.
    const plainHits = hits.filter((e) => !/HEAD|limb|legs|graze|weak|perfect|glancing|critical|beat/.test(e.r));
    const base = plainHits.length ? plainHits : hits;
    const plainDmg = base.length ? +(base.reduce((a, e) => a + e.d, 0) / base.length).toFixed(1) : 0;
    const res = { weapon, skill, model, attempts: w.melee ? n : shots, hits: hits.length, misses: misses.length, plainDmg, dmgPerHit: hits.length ? +(dmg / hits.length).toFixed(1) : 0, waitMs: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0, shots, lines: [...new Set([...lines, ...mine.map((e) => e.r).filter(Boolean)])].slice(0, 4) };
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
      // Skill 0 weaves wide and fast enough that a click's latency can carry it off the body
      // (that is the design: low skill = harder to aim); a steadier hand (skill 5) doesn't miss,
      // and even at skill 0 a timed shot lands more often than BN's dice.
      // Bows: the arrow is ~0.3 s in the air and the zombie's shamble moves its body meanwhile
      // (honest geometry), so allow one; guns and the bat never miss at skill 5.
      check('free aim, skill 5: a shot or swing timed on the target never misses (a bow at most once)', free.filter((r) => r.skill === 5).every((r) => r.misses <= (r.weapon === 'bow' ? 1 : 0)), free.map((r) => `${r.weapon}${r.skill}:${r.misses}`));
      const rate = (rs: typeof rows) => rs.reduce((a, r) => a + r.hits, 0) / Math.max(1, rs.reduce((a, r) => a + r.attempts, 0));
      const f0 = rate(free.filter((r) => r.skill === 0)), d0 = rate(rows.filter((r) => r.model === 'dice' && r.skill === 0));
      check('free aim, skill 0: timed shots land more often than classic dice', f0 > d0 + 0.2, { free: f0.toFixed(2), dice: d0.toFixed(2) });
      check('free aim: skill 5 hits harder than skill 0 (every weapon; plain body hits)', ['pistol', 'rifle', 'shotgun', 'bow', 'bat'].every((w) => {
        const a = free.find((r) => r.weapon === w && r.skill === 0), b = free.find((r) => r.weapon === w && r.skill === 5);
        return !!a && !!b && b.plainDmg > a.plainDmg;
      }), free.map((r) => `${r.weapon}${r.skill}:${r.plainDmg}`));
      check('free aim: no "miss:" / "wide:" dice reasons on the crosshair', free.every((r) => r.lines.every((l) => !/^(miss|wide):|clumsy|skill too low/.test(l))), free.flatMap((r) => r.lines));
      const dice = rows.filter((r) => r.model === 'dice');
      check('classic dice still misses at skill 0 (the comparison model is intact)', dice.some((r) => r.skill === 0 && r.misses > 0), dice.map((r) => `${r.weapon}${r.skill}:${r.misses}`));
      // A headshot: the view on the head, a timed click; the crosshair says why it hit hard.
      await js(SETUP('pistol', 5, 10, 'sway'));
      await sleep(300);
      await js(AIM_POINT(`cdda.modelPart(window.__uid, 'head') ?? (() => { const m = window.__m; return { x: m.x, y: m.y, h: 1.52 }; })()`));
      await x().buttonDown(3);
      await sleep(600);
      await js(AIM_POINT(`cdda.modelPart(window.__uid, 'head') ?? (() => { const m = window.__m; return { x: m.x, y: m.y, h: 1.52 }; })()`));
      await x().clickHere(1);
      await sleep(120);
      await shot('aim_headshot');
      await x().buttonUp(3);
      const head = await js<{ zone: string; text: string } | null>('cdda.aimState().lastHit');
      check('a shot with the crosshair on the head is a headshot, and the crosshair says ×2', head?.zone === 'head' && /HEADSHOT ×2/.test(head.text), head);
      console.log('\n    | model | weapon | skill | hit | missed | dmg/hit | aiming ms |');
      for (const r of rows) console.log(`    | ${r.model} | ${r.weapon} | ${r.skill} | ${r.hits}/${r.attempts} | ${r.misses} | ${r.dmgPerHit} | ${r.waitMs} |`);
    }],
    ['aimzones', 'free aim round 2: hit zones on the 3D models (zombie head, dog head side-on), third-person crosshair, the dodge hop', async () => {
      await c.toGameplay();
      const shootAtPart = async (part: string, n: number) => {
        const zones: string[] = [];
        for (let i = 0; i < n; i++) {
          await js(AIM_POINT(`cdda.modelPart(window.__uid, '${part}')`));
          await x().buttonDown(3);
          await sleep(700);
          await js(AIM_POINT(`cdda.modelPart(window.__uid, '${part}')`));
          await x().clickHere(1);
          await sleep(200);
          zones.push((await js<{ zone: string } | null>('cdda.aimState().lastHit'))?.zone ?? 'none');
          await js('cdda.combat.lastHit = null');
          await x().buttonUp(3);
          await sleep(500);
        }
        return zones;
      };
      // Zombie at 8 m, a skilled shooter (small weave): the model's head box is the head.
      await js(SETUP('rifle', 10, 8, 'sway'));
      await sleep(600);
      const zHead = await shootAtPart('head', 4);
      check('zombie: shots at the drawn head are headshots', zHead.every((z) => z === 'head'), zHead);
      await shot('zones_zombie_head');
      const zLeg = await shootAtPart('shinL', 3);
      // A shin is a hand's width and the zombie shambles: most shots land on it, none elsewhere.
      check('zombie: shots at a drawn shin hit the legs (or just miss it, never another zone)', zLeg.filter((z) => z === 'legs').length >= 2 && zLeg.every((z) => z === 'legs' || z === 'none'), zLeg);
      // A dog side-on at 7 m: its head is out in front, low.
      await js(SETUP('rifle', 10, 7, 'sway', 'mon_dog', Math.PI / 2));
      await sleep(800);
      const dHead = await shootAtPart('head', 4);
      check('dog side-on: shots at its drawn head are headshots', dHead.every((z) => z === 'head'), dHead);
      await shot('zones_dog_head');
      const dBody = await shootAtPart('body', 3);
      check('dog side-on: shots at its body hit the torso', dBody.every((z) => z === 'torso'), dBody);

      // --- third person: the crosshair is where the round goes.
      await js(SETUP('rifle', 10, 7, 'sway'));
      await sleep(400);
      await x().key('v');
      await sleep(400);
      const mode = await js<string>('cdda.renderer.cameraMode');
      check('V switches to the over-the-shoulder camera', mode === 'third', mode);
      await listen();
      let hits = 0;
      const lines: string[] = [];
      for (let i = 0; i < 5; i++) {
        await js(AIM_POINT(`(() => { const m = window.__m; return { x: m.x, y: m.y, h: 1.1 }; })()`));
        await x().buttonDown(3);
        await sleep(600);
        await js(AIM_POINT(`(() => { const m = window.__m; return { x: m.x, y: m.y, h: 1.1 }; })()`));
        await x().clickHere(1);
        await sleep(200);
        const h = await js<{ zone: string } | null>('cdda.aimState().lastHit');
        if (h) hits++;
        lines.push(h?.zone ?? 'miss');
        await js('cdda.combat.lastHit = null');
        await x().buttonUp(3);
        await sleep(400);
      }
      await shot('third_person');
      check('third person: shots with the crosshair on the chest hit (the round converges on the crosshair)', hits === 5, lines);
      // Beside it: a crosshair 0.6 m right of the body misses.
      await js(AIM_POINT(`(() => { const m = window.__m, p = cdda.game.player; const d = Math.hypot(m.x - p.x, m.y - p.y); return { x: m.x + (-(m.y - p.y) / d) * -0.7, y: m.y + ((m.x - p.x) / d) * -0.7, h: 1.1 }; })()`));
      await x().buttonDown(3);
      await sleep(600);
      await x().clickHere(1);
      await sleep(200);
      check('third person: the crosshair beside the body misses', !(await js('cdda.aimState().lastHit')));
      await x().buttonUp(3);
      await x().key('v');
      await x().key('v');
      await sleep(300);
      check('back in first person', (await js<string>('cdda.renderer.cameraMode')) === 'first');

      // --- dodge hop: a nimble zombie (dodge 30, setup) at arm's length; swing a bat.
      await js(SETUP('bat', 0, 1.0, 'sway'));
      await js(`(() => { const m = window.__m; m.type = { ...m.type, dodge: 30 }; clearInterval(window.__pin); m.attackCooldown = 99; })()`);
      await sleep(400);
      await js(AIM);
      await js(`window.__dodged = 0; window.__dOn || (window.__dOn = cdda.game.events.on('monsterDodge', () => window.__dodged++))`);
      let peak = 0;
      for (let i = 0; i < 6 && peak < 0.1; i++) {
        await js(AIM);
        await x().clickHere(1);
        for (let k = 0; k < 20; k++) {
          const l = await js<{ lift: number; fall: number } | null>('cdda.modelLift(window.__uid)');
          if (l && l.fall > 0.2) {
            peak = Math.max(peak, l.lift);
            await js('cdda.game.tacticalPause = true');
            await shot('dodge_hop');
            await js('cdda.game.tacticalPause = false');
            break;
          }
          await sleep(15);
        }
        await sleep(900);
        await js(`(() => { const m = window.__m, p = cdda.game.player; m.x = p.x; m.y = p.y - 1.0; })()`);
      }
      const dodged = await js<number>('window.__dodged');
      check('a dodge is a visible hop on the model (it springs up and leans away)', dodged > 0 && peak > 0.1, { dodged, peak });
    }],
    ['aimwide', 'free aim HUD at the ultrawide size (run with --size 3440x1304): crosshair, weave circle, readout, timing marks', async () => {
      await c.toGameplay();
      await js(SETUP('pistol', 0, 12, 'timing'));
      await sleep(500);
      await js(AIM);
      await x().buttonDown(3);
      await sleep(900);
      const geo = await js<{ W: number; H: number; cross: number[]; readout: number[] | null; env: number[] | null }>(`(() => {
        const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
        return { W: innerWidth, H: innerHeight, cross: r(document.querySelector('.hud-cross')), readout: r(document.querySelector('.aim-level')), env: r(document.querySelector('.aim-hud circle[stroke-dasharray]')) };
      })()`);
      console.log('    geometry', JSON.stringify(geo));
      const cx = geo.cross[0] + geo.cross[2] / 2, cy = geo.cross[1] + geo.cross[3] / 2;
      check('the crosshair weaves near the screen centre (within 8 % of the height)', Math.abs(cx - geo.W / 2) < geo.H * 0.08 && Math.abs(cy - geo.H / 2) < geo.H * 0.08, geo);
      check('the aim readout sits under the (weaving) crosshair, clear of it, on screen', !!geo.readout && geo.readout[1] >= geo.cross[1] + geo.cross[3] && geo.readout[1] < geo.H * 0.7, [geo.cross, geo.readout]);
      await shot('wide_pistol_aim');
      await x().down('Shift_L');
      for (let i = 0; i < 60 && !/NOW/.test(await js<string>(`document.querySelector('.aim-level')?.textContent ?? ''`)); i++) await sleep(10);
      await js('cdda.game.tacticalPause = true');
      await shot('wide_breath_now');
      await js('cdda.game.tacticalPause = false');
      await x().up('Shift_L');
      await x().clickHere(1);
      await sleep(250);
      await shot('wide_hit_line');
      await x().buttonUp(3);
    }],
    ['combat3', 'combat round 3: melee picks the zombie you visibly hit in a crowd, with zones; enemy rounds fly and whizz past; cover stops them; first-fight hints', async () => {
      await c.toGameplay();
      const frozenShot = async (name: string) => {
        await js('cdda.game.tacticalPause = true');
        await shot(name);
        await js('cdda.game.tacticalPause = false');
      };
      // --- a crowd of three at arm's length, a bat.
      await js(SETUP('bat', 0, 1.1, 'sway'));
      const uids = await js<number[]>(`(() => {
        const g = cdda.game, p = g.player; const uids = [window.__uid];
        for (const dx of [-0.75, 0.75]) uids.push(cdda.spawnMonster('mon_zombie', dx, -1.0));
        const ms = uids.map((u) => g.monsters.all.find((m) => m.uid === u));
        clearInterval(window.__pin);
        const pos = ms.map((m) => [m.x, m.y]);
        window.__crowd = ms;
        window.__pin = setInterval(() => ms.forEach((m, i) => { if (!m.dead) { m.x = pos[i][0]; m.y = pos[i][1]; m.hp = 100000; m.attackCooldown = 5; m.windup = null; m.facing = Math.atan2(p.x - m.x, -(p.y - m.y)); } }), 16);
        return uids;
      })()`);
      await sleep(700);
      await js(`window.__hitUids = []; window.__hitOn || (window.__hitOn = cdda.game.events.on('playerAttack', (e) => e.kind === 'melee' && window.__hitUids.push({ uid: e.target?.uid ?? null, r: e.reason ?? '', o: e.outcome })))`);
      const swingAt = async (uid: number, part: string) => {
        await js(AIM_POINT(`cdda.modelPart(${uid}, '${part}')`));
        await sleep(80);
        await js('window.__hitUids = []');
        await x().clickHere(1);
        await sleep(700);
        return js<{ uid: number | null; r: string; o: string }[]>('window.__hitUids');
      };
      const picks: string[] = [];
      let right = 0;
      for (const [i, part] of [[2, 'torso'], [1, 'torso'], [0, 'torso'], [2, 'torso'], [1, 'torso']] as const) {
        const h = await swingAt(uids[i], part);
        picks.push(`${i}:${h.map((e) => uids.indexOf(e.uid ?? -1)).join('/')}`);
        if (h.length && h[0].uid === uids[i]) right++;
      }
      check('in a crowd of three, the swing hits the zombie under the crosshair', right === 5, picks);
      const head = await swingAt(uids[0], 'head');
      await frozenShot('melee_crowd_head');
      check('a bat to the drawn head: HEAD ×1.5 on the crosshair', head.some((e) => /HEAD ×1\.5/.test(e.r)), head);
      let legs: { r: string }[] = [];
      for (let i = 0; i < 3 && !legs.length; i++) {
        await js(AIM_POINT(`cdda.modelPart(${uids[1]}, 'shinL')`));
        await js('cdda.game.player.pitch -= 0.02');
        await js('window.__hitUids = []');
        await x().clickHere(1);
        await sleep(700);
        legs = (await js<{ r: string }[]>('window.__hitUids')).filter((e) => /legs/.test(e.r));
      }
      check('a blow to the drawn legs: legs ×0.8 and it stumbles or goes down', legs.some((e) => /legs ×0\.8 · (stumbles|knocked down)/.test(e.r)), legs);
      await js('clearInterval(window.__pin); cdda.clearMonsters(60)');

      // --- enemy fire: a rifle turret 16 m off, god mode; its rounds fly (visible), miss, whizz past.
      await js(SETUP('pistol', 0, 3, 'sway'));
      await js(`(() => { clearInterval(window.__pin); cdda.clearMonsters(60); cdda.godMode(true);
        window.__near = 0; window.__nearOn || (window.__nearOn = cdda.game.events.on('nearMiss', () => window.__near++));
        window.__hurt = 0; window.__hurtOn || (window.__hurtOn = cdda.game.events.on('playerHurt', () => window.__hurt++));
        const uid = cdda.spawnMonster('mon_turret_rifle', 3, -16); const m = cdda.game.monsters.all.find((q) => q.uid === uid); m.aggroCharacter = true; window.__turret = m; })()`);
      await js(AIM_POINT('(() => { const m = window.__turret; return { x: m.x, y: m.y, h: 1.0 }; })()'));
      let seen = 0, pausedShot = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 9000) {
        const n = await js<number>('cdda.enemyFire().rounds.length');
        seen = Math.max(seen, n);
        // Freeze with a round about half way (a streak you can see between it and you).
        if (n > 0 && !pausedShot && (await js<boolean>('cdda.enemyFire().rounds.some((r) => r.s > 5 && r.s < 11)'))) {
          await frozenShot('enemy_rounds_in_flight');
          pausedShot = true;
        }
        await sleep(20);
      }
      const near = await js<number>('window.__near'), hurt = await js<number>('window.__hurt');
      console.log(`    turret: rounds in the air at once (max) ${seen}, near misses ${near}, hits ${hurt}`);
      if (!seen) console.log('    diag', await js<string>(`(() => { const m = window.__turret, g = cdda.game; return JSON.stringify({ dead: m.dead, active: g.monsters.active.includes(m), sees: m.seesPlayer, aggro: m.aggroCharacter, att: m.attitude(), friendly: m.friendly, clear: g.monsters.clearLine(m, g.player.x, g.player.y), specials: m.specials.map((s) => [s.def.id ?? s.def.type, +s.cooldown.toFixed(2)]), d: Math.hypot(m.x - g.player.x, m.y - g.player.y) }); })()`));
      check('the turret\'s rounds are in the air (not hitscan)', seen > 0, seen);
      check('some rounds hit, some visibly miss and whizz past (near-miss cue)', near > 0 && hurt > 0, { near, hurt });
      // Behind cover: a wall between you and the turret stops every round.
      await js(`(() => { const p = cdda.game.player, m = window.__turret; const d = Math.hypot(m.x - p.x, m.y - p.y);
        const wx = p.x + (m.x - p.x) / d * 1.5, wy = p.y + (m.y - p.y) / d * 1.5;
        window.__walls = [];
        for (let i = -1; i <= 1; i++) { const x = Math.floor(wx) + i, y = Math.floor(wy); window.__walls.push([x, y, p.z, cdda.game.map.terAt(x, y, p.z).id]); cdda.game.map.setTer(x, y, p.z, 't_brick_wall'); }
        window.__hurt = 0; window.__near = 0; })()`);
      await sleep(5000);
      const coverHurt = await js<number>('window.__hurt');
      check('behind a wall, no round gets through', coverHurt === 0, coverHurt);
      await js('cdda.clearMonsters(60); cdda.godMode(false); for (const [x, y, z, id] of window.__walls) cdda.game.map.setTer(x, y, z, id)');

      // --- first-fight hints, as a new player: fresh hint state.
      await js(`localStorage.removeItem('cdda3d.combatHints'); (() => { const r = cdda.combatHints.rules; r.state = { shown: {}, learned: {} }; r.current = null; })()`);
      await js(SETUP('pistol', 0, 12, 'sway'));
      await sleep(400);
      await js(AIM);
      const hint = () => js<string>(`(() => { const e = document.querySelector('.combat-hint'); return e && e.style.display !== 'none' ? e.textContent : ''; })()`);
      await x().buttonDown(3);
      let h1 = '';
      for (let i = 0; i < 30 && !h1; i++) {
        await sleep(50);
        h1 = await hint();
      }
      await frozenShot('hint_sway');
      if (!/sways/.test(h1)) console.log('    diag', await js<string>(`JSON.stringify({ hints: cdda.progression?.profile().options.hints, amp: cdda.aimState().ampDeg, target: !!cdda.combat.rangedTarget(35), rules: cdda.combatHints.rules.current, shown: cdda.combatHints.rules.state, rmb: cdda.game.input.mouseButtons })`));
      check('first time aiming a gun at a zombie: "Your aim sways" by the crosshair', /sways/.test(h1), h1);
      await sleep(3200);
      await js(AIM);
      let h2 = '';
      for (let i = 0; i < 6 && !/head/.test(h2); i++) {
        await js(AIM);
        await x().clickHere(1);
        await sleep(250);
        h2 = await hint();
        if (!/head/.test(h2)) await sleep(400);
      }
      if (/head/.test(h2)) await frozenShot('hint_headshot');
      check('after a body hit: "Aim for the head"', /head/.test(h2), h2);
      await x().buttonUp(3);
      // Melee: a zombie winds up at arm's length.
      await js(SETUP('bat', 0, 1.1, 'sway'));
      await js(`(() => { clearInterval(window.__pin); const m = window.__m; m.attackCooldown = 0; })()`);
      await js(AIM);
      let h3 = '';
      for (let i = 0; i < 80 && !/guard/.test(h3); i++) {
        await sleep(40);
        h3 = await hint();
      }
      if (/guard/.test(h3)) await frozenShot('hint_guard');
      check('a zombie winding up at arm\'s length: "Hold right mouse: guard"', /guard/.test(h3), h3);
      await x().buttonDown(3);
      await sleep(150);
      const after = await hint();
      check('raising the guard clears the hint', !/guard/.test(after), after);
      await x().buttonUp(3);
      const shown = await js<Record<string, number>>('cdda.combatHints.rules.state.shown');
      console.log('    hints shown', JSON.stringify(shown));
      await js('cdda.clearMonsters(60)');
    }],
    ['aimdebug', 'diagnosis: what the shot ray meets when the view is on a model part', async () => {
      await c.toGameplay();
      await js(SETUP('rifle', 10, 8, 'sway'));
      await sleep(800);
      for (const part of ['head', 'torso', 'shinL']) {
        await js(AIM_POINT(`cdda.modelPart(window.__uid, '${part}')`));
        await sleep(200);
        await js(AIM_POINT(`cdda.modelPart(window.__uid, '${part}')`));
        await sleep(60);
        const d = await js<unknown>(`JSON.stringify({ part: cdda.modelPart(window.__uid, '${part}'), dbg: cdda.aimDebug(window.__uid) })`);
        console.log(`    ${part}: ${d}`);
      }
      await x().key('v');
      await sleep(400);
      await js(AIM_POINT(`(() => { const m = window.__m; return { x: m.x, y: m.y, h: 1.1 }; })()`));
      await sleep(100);
      await js(AIM_POINT(`(() => { const m = window.__m; return { x: m.x, y: m.y, h: 1.1 }; })()`));
      console.log(`    third: ${await js<string>('JSON.stringify(cdda.aimDebug(window.__uid))')}`);
      await x().key('v');
      await x().key('v');
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
      // The arrow in the air carries the bonus (whether it then lands depends on the weave).
      let loosed: { perfect: boolean } | null = null;
      for (let i = 0; i < 40 && !loosed; i++) {
        loosed = await js<{ perfect: boolean } | null>('(() => { const f = cdda.combat.flights[0]; return f ? { perfect: !!f.perfect } : null; })()');
        if (!loosed) await sleep(10);
      }
      await sleep(900);
      check('a bow loosed as the ring meets the reticle is perfect', !!loosed?.perfect, loosed);
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
