// Real-input NPC line-of-fire scenario (docs/COMBAT_FEEL.md "NPCs in the line of fire"), run
// from tools/realinput.ts:
//   --only npcfire
// Free aim. 1) Shotgun at a zombie with a neutral survivor standing just off the line in front of
// it: the click fires without an "attack?" question (the crosshair is on the zombie), the pellets
// on the survivor's side hit the survivor, the rest fly on to the zombie, none counts twice, and
// the neutral stays neutral (a stray hit, BN). 2) The crosshair on the neutral: LMB asks first;
// "n" fires nothing, "y" makes them hostile and the next click hits them. 3) A longbow at them:
// the arrow strikes the person and drops at their feet (every arrow accounted for).
//
// cdda.* only sets the scene (weapons, the pinned zombie and person, pointing the view, as the
// other combat suites do) and reads state; firing, drawing and answering are OS-level input.

import type { XInput } from './lib/realinput';

export interface NpcFireCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

/** An open stretch, a 870 with buckshot, a zombie 9 m north and a neutral survivor 5 m north, `off` m east of the line. */
const SETUP = (off: number) => `(() => {
  const g = cdda.game, p = g.player, grid = g.monsters.grid;
  cdda.setAimModel('sway');
  cdda.clearMonsters(60);
  if (!window.__nfSpot) {
    cdda.giveItem('backpack', { wear: true });
    const clear = (x, y) => { for (let s = -2; s <= 16; s++) for (let w = -2; w <= 2; w++) { const tx = x + w, ty = y - s; if (!grid.passable(tx, ty, p.z) || grid.opaque(tx, ty, p.z)) return false; } return true; };
    outer: for (let r = 0; r < 120; r += 2) for (let a = 0; a < 24; a++) { const x = Math.floor(p.x + Math.cos(a / 24 * 6.283) * r), y = Math.floor(p.y + Math.sin(a / 24 * 6.283) * r); if (clear(x, y)) { window.__nfSpot = [x + 0.5, y + 0.5]; break outer; } }
  }
  if (!window.__nfSpot) return null;
  p.x = window.__nfSpot[0]; p.y = window.__nfSpot[1]; p.stamina = p.staminaMax(); p.recoil = 0; p.crouching = false;
  p.str_base = 10; p.dex_base = 8; p.per_base = 8; p.resetStats();
  for (const s of ['gun', 'shotgun', 'archery']) p.setSkill(s, 5);
  if (p.inv.wielded) p.inv.drop(p.inv.wielded);
  cdda.giveItem('remington_870', { wield: true });
  cdda.giveItem('shot_00', { count: 40 });
  const gun = p.inv.wielded;
  for (let i = 0; i < 6; i++) { const b = gun.ammoRemaining(); g.keys.handler('reload')?.(); if (gun.ammoRemaining() <= b) break; }
  cdda.combat.cooldown = 0; cdda.renderer.viewmodel?.freeze(null);
  const sys = cdda.npcSystem;
  for (const n of sys.npcs) if (!n.dead && Math.hypot(n.x - p.x, n.y - p.y) < 30) sys.remove(n);
  const zid = cdda.spawnMonster('mon_zombie', 0, -9);
  const m = g.monsters.all.find((z) => z.uid === zid); m.hp = 100000; window.__m = m;
  const nid = cdda.spawnNpc('NC_SCAVENGER', 0, -5, { attitude: 'NULL' });
  const n = sys.npcByUid(nid); window.__n = n;
  if (n.inv.wielded) n.inv.drop(n.inv.wielded);
  for (const k of Object.keys(n.hp)) n.hp[k].cur = n.hp[k].max = 1000;
  n.x = p.x + ${off}; n.y = p.y - 5;
  const mx = m.x, my = m.y; clearInterval(window.__nfPin);
  window.__nfPin = setInterval(() => {
    if (!m.dead) { m.x = mx; m.y = my; m.attackCooldown = 5; m.windup = null; }
    const q = window.__n; if (q && !q.dead) { q.x = window.__nfAt[0]; q.y = window.__nfAt[1]; q.attackCooldown = 5; q.moving = false; q.facing = Math.PI; }
  }, 16);
  window.__nfAt = [n.x, n.y];
  window.__nfEv = [];
  if (window.__nfGame !== g) { window.__nfGame = g; g.events.on('playerAttack', (e) => window.__nfEv.push({ o: e.outcome, r: e.reason ?? '', t: e.target === window.__m ? 'zombie' : e.target ? 'other' : 'none', d: e.damage })); }
  return { name: n.name, nd: Math.hypot(n.x - p.x, n.y - p.y), md: Math.hypot(m.x - p.x, m.y - p.y) };
})()`;

/** Point the view at a chest (setup: the combat suites all start aimed). */
const AIM_AT = (who: string, h = 1.15) => `(() => { const m = ${who}, p = cdda.game.player; const d = Math.hypot(m.x - p.x, m.y - p.y); p.yaw = Math.atan2(m.x - p.x, -(m.y - p.y)); p.pitch = Math.atan2(${h} - 1.6, d); })()`;

/**
 * The angle (degrees, toward +x) from the zombie line at which a ray from the eye first enters the
 * neutral's drawn body (PlayerCombat.npcOnRay, the test every pellet uses), or null.
 */
const EDGE = `(() => {
  const c = cdda.combat, n = window.__n, ray = c.aimRay({ x: 0, y: 0, rx: 0, ry: 0 }, 30);
  for (let deg = -2; deg <= 8; deg += 0.05) {
    const yaw = ray.yaw + deg * Math.PI / 180;
    const h = c.npcOnRay(ray.o, yaw, ray.pitch, { x: ray.o.x + Math.sin(yaw) * 30, y: ray.o.y - Math.cos(yaw) * 30 });
    if (h && h.n === n) return deg;
  }
  return null;
})()`;

/** BN shot_00: shot.half_angle 3 (degrees, uniform; ranged.cpp get_pellet_target). */
const HALF_ANGLE = 3;
/** Where the neutral's near edge goes: well inside the cone, clear of the crosshair (and its sway). */
const EDGE_AT = 1.5;

const NPC = `(() => { const n = window.__n; return { att: n.attitude, hp: Object.values(n.hp).reduce((s, h) => s + h.cur, 0), dead: !!n.dead, x: n.x, y: n.y, tx: n.tileX, ty: n.tileY }; })()`;

export function npcFireScenarios(c: NpcFireCtx): Scenario[] {
  const { js, check, shot, sleep } = c;
  const x = () => c.x();
  const confirmUp = () => js<string>(`[...document.querySelectorAll('.cdda-window')].map((w) => w.textContent ?? '').find((t) => /Really attack/.test(t)) ?? ''`);
  const pellets = (r: string) => Number(/^(\d+)\/\d+ pellets/.exec(r)?.[1] ?? 0);
  const ammo = () => js<number>('cdda.game.player.inv.wielded?.ammoRemaining() ?? -1');

  return [
    ['npcfire', 'free aim: buckshot pellets split between a neutral in front and the zombie behind (stray: stays neutral); aimed at the neutral asks first; an arrow hits a person and drops at their feet', async () => {
      await c.toGameplay();
      const s = await js<{ name: string; nd: number; md: number } | null>(SETUP(0.45));
      if (!check('found an open stretch to shoot on', !!s, s)) return;
      console.log(`    ${s!.name} at ${s!.nd.toFixed(1)} m, zombie at ${s!.md.toFixed(1)} m`);
      await sleep(900);
      await js(AIM_AT('window.__m'));
      await sleep(400);
      // BN's 00 buck cone is ±3° (about ±0.26 m at 5 m), so "just off the line" has to mean inside
      // it. The neutral's drawn body (arms, stance) decides where its edge is: measure it along the
      // pellets' own hit test and slide them sideways until it sits EDGE_AT° off the line.
      const edge0 = await js<number | null>(EDGE);
      if (edge0 !== null) await js(`(() => { window.__nfAt[0] -= ${(edge0 - EDGE_AT) * Math.PI / 180 * 5}; window.__n.x = window.__nfAt[0]; })()`);
      await sleep(300);
      await js(AIM_AT('window.__m'));
      const edge = await js<number | null>(EDGE);
      console.log(`    neutral's edge ${edge0?.toFixed(2)}° → ${edge?.toFixed(2)}° off the line (cone ±${HALF_ANGLE}°)`);
      check(`setup: the neutral stands inside the ${HALF_ANGLE}° cone, clear of the crosshair`, edge !== null && edge > 0.8 && edge < HALF_ANGLE - 0.8, { edge0, edge });
      await shot('npcfire_aim_past_neutral');

      // --- 1) pellets: fire at the zombie past the neutral's shoulder
      const npc0 = await js<{ att: string; hp: number }>(NPC);
      let split = 0, toNpc = 0, toZombie = 0, overfull = 0, asked = '';
      for (let i = 1; i <= 10 && !split; i++) {
        // Setup: a pellet reaches the neutral only on their side of the cone (about one in ten),
        // so keep firing, topped up with the reload key's own code when the tube runs dry.
        await js(`(() => { const g = cdda.game, gun = g.player.inv.wielded; if (gun.ammoRemaining() === 0) { for (let k = 0; k < 6; k++) { const b = gun.ammoRemaining(); g.keys.handler('reload')?.(); if (gun.ammoRemaining() <= b) break; } cdda.renderer.viewmodel?.freeze(null); } window.__nfEv = []; g.player.recoil = 0; cdda.combat.cooldown = 0; })()`);
        await js(AIM_AT('window.__m'));
        await sleep(350);
        await x().clickHere(1);
        await sleep(120);
        asked ||= await confirmUp();
        const ev = await js<{ o: string; r: string; t: string; d: number }[]>('window.__nfEv');
        const n = ev.filter((e) => e.t === 'none').reduce((a, e) => a + pellets(e.r), 0);
        const z = ev.filter((e) => e.t === 'zombie').reduce((a, e) => a + pellets(e.r), 0);
        console.log(`    shot ${i}: ${n} pellet(s) in the neutral, ${z} in the zombie  ${JSON.stringify(ev)}`);
        toNpc += n;
        toZombie += z;
        if (n + z > 5) overfull++;
        if (n > 0 && z > 0) {
          split++;
          await shot('npcfire_pellets_split');
        }
        await sleep(500);
      }
      const npc1 = await js<{ att: string; hp: number }>(NPC);
      const logTail = await js<string[]>('cdda.ui.log().slice(-12)');
      check('aimed at the zombie, the shot fires without an "attack?" question', !asked, asked);
      check('pellets on the neutral\'s side hit the neutral', toNpc > 0 && npc1.hp < npc0.hp, { toNpc, hp0: npc0.hp, hp1: npc1.hp });
      check('the rest fly on to the zombie: one shot split between both', split > 0, { toNpc, toZombie });
      check('no shot counts more than its five pellets', overfull === 0, overfull);
      check('a stray hit leaves the neutral neutral (BN: no on_attacked from a projectile)', npc1.att === 'NULL', npc1.att);
      check('the log says how many projectiles hit them', logTail.some((l) => l.startsWith(`${s!.name} is hit by`)), logTail);

      // --- 2) the crosshair on the neutral: asked first (BN target_ui), n = nothing, y = hostile, then the shot lands
      // Setup: top the gun up again (the reload key's own code) and stand the person in the line.
      await js(`(() => { const g = cdda.game, gun = g.player.inv.wielded; for (let i = 0; i < 6; i++) { const b = gun.ammoRemaining(); g.keys.handler('reload')?.(); if (gun.ammoRemaining() <= b) break; } cdda.combat.cooldown = 0; cdda.renderer.viewmodel?.freeze(null); window.__nfAt = [g.player.x, g.player.y - 5]; })()`);
      await sleep(300);
      await js(AIM_AT('window.__n'));
      await sleep(400);
      const a0 = await ammo();
      await x().clickHere(1);
      await sleep(400);
      const q1 = await confirmUp();
      await shot('npcfire_confirm_neutral');
      check('LMB with the crosshair on a neutral asks "Really attack …? They are not hostile."', /Really attack .*not hostile/.test(q1), q1);
      await x().key('n');
      await sleep(300);
      check('"n": nothing fired, still neutral', (await ammo()) === a0 && (await js<{ att: string }>(NPC)).att === 'NULL', { ammo: await ammo(), a0 });
      await c.toGameplay();
      await js(AIM_AT('window.__n'));
      await sleep(300);
      await x().clickHere(1);
      await sleep(400);
      const q2 = await confirmUp();
      await x().key('y');
      await sleep(300);
      const att = (await js<{ att: string }>(NPC)).att;
      check('"y": they turn on you (BN make_angry: hostile or fleeing)', !!q2 && (att === 'KILL' || att === 'FLEE_TEMP'), { q2, att });
      await c.toGameplay();
      const hpA = (await js<{ hp: number }>(NPC)).hp;
      await js(`window.__nfEv = []; cdda.game.player.recoil = 0; cdda.combat.cooldown = 0`);
      await js(AIM_AT('window.__n'));
      await sleep(350);
      await x().clickHere(1);
      await sleep(500);
      const hpB = (await js<{ hp: number }>(NPC)).hp;
      await shot('npcfire_hostile_hit');
      check('the next click shoots them (no question now)', hpB < hpA && !(await confirmUp()), { hpA, hpB });

      // --- 3) a longbow: the arrow strikes the person and drops at their feet
      await js(`(() => { const g = cdda.game, p = g.player; if (p.inv.wielded) p.inv.drop(p.inv.wielded); cdda.giveItem('longbow', { wield: true }); cdda.giveItem('arrow_wood', { count: 10 });
        window.__broke = 0; if (window.__nfBrokeGame !== g) { window.__nfBrokeGame = g; g.events.on('message', (m) => { if (/breaks\\.$/.test(m.text)) window.__broke++; }); } })()`);
      const ARROWS = `(() => { const g = cdda.game, p = g.player; let carried = 0, ground = 0, at = 0;
        for (const it of p.inv.allItems()) if (it.typeId === 'arrow_wood') carried += it.count();
        const s = window.__nfSpot, n = window.__n;
        for (let y = Math.floor(s[1]) - 30; y <= Math.floor(s[1]) + 3; y++) for (let x = Math.floor(s[0]) - 6; x <= Math.floor(s[0]) + 6; x++) for (const it of g.map.itemsAt(x, y, p.z)) if (it.typeId === 'arrow_wood') { ground += it.count(); if (x === n.tileX && y === n.tileY) at += it.count(); }
        return { carried, ground, at, broke: window.__broke }; })()`;
      await sleep(600);
      const ar0 = await js<{ carried: number; ground: number; at: number; broke: number }>(ARROWS);
      const hpC = (await js<{ hp: number }>(NPC)).hp;
      let arrowHit = false;
      for (let i = 1; i <= 4 && !arrowHit; i++) {
        await js(AIM_AT('window.__n', 1.25));
        await x().buttonDown(3);
        await sleep(1400);
        await js(AIM_AT('window.__n', 1.25));
        if (i === 1) await shot('npcfire_bow_drawn');
        await x().clickHere(1);
        await sleep(60);
        await x().buttonUp(3);
        await sleep(900);
        const tail = await js<string[]>('cdda.ui.log().slice(-4)');
        arrowHit = tail.some((l) => /^Your .*arrow.* (hits|glances off) /.test(l));
        console.log(`    arrow ${i}: ${tail.join(' | ')}`);
      }
      await sleep(400);
      await shot('npcfire_arrow_hit');
      const ar1 = await js<{ carried: number; ground: number; at: number; broke: number }>(ARROWS);
      const hpD = (await js<{ hp: number }>(NPC)).hp;
      check('an arrow strikes the person (log: "Your … arrow hits …")', arrowHit && hpD < hpC, { hpC, hpD });
      check('every arrow is carried, lying about or broke (none vanished)', ar1.carried + ar1.ground + ar1.broke === ar0.carried + ar0.ground + ar0.broke, { ar0, ar1 });
      check('the arrow that hit them lies at their feet (BN embeds only in monsters) or broke', ar1.at > ar0.at || ar1.broke > ar0.broke, { ar0, ar1 });
      // Clean up: the provoked survivor (1000 hp a part) would hunt you through the scenarios
      // after this one, and the 100000 hp zombie would stand there.
      await js(`(() => { clearInterval(window.__nfPin); const n = window.__n; if (n && !n.dead) cdda.npcSystem.remove(n); window.__n = null; cdda.clearMonsters(60); })()`);
    }],
  ];
}
