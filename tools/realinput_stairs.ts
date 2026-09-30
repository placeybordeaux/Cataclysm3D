// Real-input stairs scenarios (docs/STAIRS.md), run from tools/realinput.ts:
//   --only stairs      walk up and down the evac shelter's flight (held W through xdotool), run
//                      up, turn round with the mouse, the `<` shortcut, a zombie that follows you
//                      up, a basement spiral and the roof ladder
//
// Everything the player does is OS-level input; cdda.* only places the survivor at the foot
// of a flight (setup), spawns the zombie and reads state. Seed 1 (the realinput default):
// the shelter's 2x2 basement stairs, house_16_west's basement pocket stair, the shelter's
// roof ladder.

import type { XInput } from './lib/realinput';

export interface StairsCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

interface Climb { z: number; x: number; y: number; eye: number; climbing: boolean; shape: string | null }
const READ = `(() => { const p = cdda.game.player, c = cdda.stairs.climb(); return { z: p.z, x: p.x, y: p.y, eye: p.z * 2.6 + cdda.stairs.liftOf(p), climbing: !!c, shape: c ? c.shape : null }; })()`;

export function stairsScenarios(c: StairsCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  /** Hold a key until the survivor is off the flight on level z (or time out); samples the eye height. */
  const climbTo = async (keys: string[], z: number, maxMs = 8000) => {
    const x = c.x();
    for (const k of keys) await x.down(k);
    const t0 = Date.now();
    const eyes: number[] = [];
    let s = await js<Climb>(READ), rode = false;
    while (Date.now() - t0 < maxMs) {
      await sleep(50);
      s = await js<Climb>(READ);
      eyes.push(s.eye);
      rode ||= s.climbing;
      if (s.z === z && !s.climbing && rode) break;
    }
    for (const k of [...keys].reverse()) await x.up(k);
    return { s, ms: Date.now() - t0, eyes, rode };
  };
  const monotonic = (a: number[], up: boolean) => a.every((v, i) => i === 0 || (up ? v >= a[i - 1] - 1e-6 : v <= a[i - 1] + 1e-6));
  const maxJump = (a: number[]) => a.reduce((m, v, i) => (i ? Math.max(m, Math.abs(v - a[i - 1])) : m), 0);
  /** Setup: stand on a flight's bottom (or top) landing looking onto it. */
  const stand = (x: number, y: number, z: number, top = false) =>
    js<{ shape: string; z: number } | null>(`(() => { cdda.godMode(true); cdda.setHour(12); cdda.stairs.setVariant('flight'); cdda.teleport(${x} + 0.5, ${y} + 0.5, ${z}); cdda.step(0.1); const d = cdda.stairs.standAt(${x}, ${y}, ${z}, ${top}); cdda.game.player.pitch = -0.1; return d; })()`);

  return [
    ['stairs', 'walk up and down stairs with held keys: the shelter flight (up, back down, run up, `<`), a zombie following you up, a basement spiral, the roof ladder', async () => {
      await toGameplay();
      // --- the shelter's basement flight: up
      const d = await stand(1287, 947, -1);
      check('the shelter basement stairs are a modelled flight', d?.shape === 'straight', d);
      await sleep(400);
      await shot('stairs_bottom');
      const up = await climbTo(['w'], 0);
      check('holding W walks you up the flight onto the ground floor', up.s.z === 0 && !up.s.climbing, up.s);
      check('climbing takes a moment (no teleport)', up.ms > 900 && up.rode, up.ms);
      check('the eye rises smoothly', monotonic(up.eyes, true) && maxJump(up.eyes) < 0.5, { jump: maxJump(up.eyes) });
      await shot('stairs_top');
      // --- turn round with the mouse (~180°) and walk back down
      await c.x().move(1257, 0, 20);
      await sleep(200);
      const down = await climbTo(['w'], -1);
      check('turning round and walking into the stairwell takes you back down', down.s.z === -1 && !down.s.climbing, down.s);
      check('the eye falls smoothly', monotonic(down.eyes, false) && maxJump(down.eyes) < 0.5, { jump: maxJump(down.eyes) });
      // --- running up: faster, but not twice as fast
      await stand(1287, 947, -1);
      const run = await climbTo(['Shift_L', 'w'], 0);
      check('running up works and is faster', run.s.z === 0 && run.ms < up.ms * 0.95, { run: run.ms, walk: up.ms });
      // --- the `<` key climbs by itself
      await stand(1287, 947, -1);
      await c.x().key('less');
      const auto = await climbTo([], 0, 6000);
      check('`<` at the foot of the flight climbs it by itself', auto.s.z === 0 && auto.rode, auto.s);

      // --- a zombie follows you up
      await stand(1287, 947, -1);
      const uid = await js<number>(`(() => { cdda.clearMonsters(40); const p = cdda.game.player; const id = cdda.spawnMonster('mon_zombie', 0, 2); const m = cdda.game.monsters.all.find((z) => z.uid === id); m.anger = 100; return id; })()`);
      await sleep(800);
      await climbTo(['w'], 0);
      // walk a few steps away from the stairwell and wait
      await c.x().hold('w', 700);
      let zz = -1, rode = false;
      for (let i = 0; i < 60 && zz !== 0; i++) {
        await sleep(200);
        const r = await js<{ z: number; climbing: boolean } | null>(`(() => { const m = cdda.game.monsters.all.find((z) => z.uid === ${uid}); return m ? { z: m.z, climbing: cdda.stairs.liftOf(m) !== 0 } : null; })()`);
        if (!r) break;
        zz = r.z;
        rode ||= r.climbing;
        if (r.climbing) await shot('stairs_zombie_climbing');
      }
      check('the zombie follows you up the flight (climbing it, not teleporting)', zz === 0 && rode, { zz, rode });
      await js(`cdda.clearMonsters(40)`);

      // --- a basement pocket stair (spiral) and the roof ladder
      const sp = await stand(1076, 873, -1);
      check('house_16 basement stair is a spiral', sp?.shape === 'spiral', sp);
      await shot('stairs_spiral_bottom');
      const spu = await climbTo(['w'], 0);
      check('up the spiral', spu.s.z === 0 && spu.rode && monotonic(spu.eyes, true), spu.s);
      await shot('stairs_spiral_top');
      const ld = await stand(1294, 954, 0);
      check('the shelter roof ladder is a ladder', ld?.shape === 'ladder', ld);
      const lu = await climbTo(['Shift_L', 'w'], 1, 10000);
      check('up the ladder (slower, running does not help much)', lu.s.z === 1 && lu.ms > up.ms, { ladder: lu.ms, stairs: up.ms });
      await shot('stairs_roof');
      await js(`(() => { cdda.stairs.setVariant('flight'); cdda.godMode(false); })()`);
    }],
  ];
}
