// Real-input special spawns scenario, run from tools/realinput.ts:
//   --only antcolony   walk up to an anthill (genVersion 3 overmap): its GROUP_ANT colony
//                      (BN overmap_special_spawns) comes out as the hill's submaps enter the
//                      reality bubble, and the colony's population drains (docs/WORLD_TRANSPORT.md).
//
// Movement is OS-level input (holding W); cdda.* only finds the anthill, stands the survivor just
// outside the colony's spread facing it, turns on god mode and reads state.

import { settleWorld, type XInput } from './lib/realinput';

export interface SpawnsCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

interface Colony { x: number; y: number; uid: number; group: string | null; groups: number; population: number; unspent: number; reach: number }

export function spawnsScenarios(c: SpawnsCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  const ANTS = `new Set(['mon_ant', 'mon_ant_larva', 'mon_ant_soldier', 'mon_ant_queen'])`;
  const ants = () => js<{ n: number; seen: number; nearest: number | null; uid: number | null }>(`(() => {
    const sys = cdda.monsterSystem, p = cdda.game.player, A = ${ANTS};
    let n = 0, seen = 0, nearest = null, uid = null;
    for (const m of sys.all) {
      if (m.dead || !A.has(m.type.id)) continue;
      n++;
      if (!sys.playerSees(m)) continue;
      seen++;
      const d = Math.hypot(m.x - p.x, m.y - p.y);
      if (nearest === null || d < nearest) (nearest = d), (uid = m.uid);
    }
    return { n, seen, nearest, uid };
  })()`);

  return [
    ['antcolony', 'walk (W) up to an anthill: its colony spawns as its submaps enter the bubble and the population drains', async () => {
      await toGameplay();
      const setup = await js<{ colony: Colony; start: [number, number] } | { error: string }>(`(() => {
        const col = cdda.specialSpawns('Anthill', 3);
        if (!col) return { error: 'no Anthill within 3 regions' };
        if (!col.groups) return { error: 'the anthill placed no monster groups (genVersion < 3?)', col };
        // Approach from the side with the most open ground on the overmap, starting one submap
        // beyond where the bubble (5 submaps) first touches the colony's furthest group.
        const D = Math.ceil((col.reach + 7) / 2);
        let best = null;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          let score = 0;
          for (let k = 1; k <= D; k++) {
            const t = cdda.omtAt(col.x + dx * k, col.y + dy * k, 0).type;
            score += t === 'field' ? 2 : t === 'forest' ? 1 : 0;
          }
          if (!best || score > best.score) best = { score, dx, dy };
        }
        const sx = col.x + best.dx * D, sy = col.y + best.dy * D;
        cdda.setHour(12);
        cdda.godMode(true);
        cdda.teleportOmt(sx, sy, 0);
        cdda.step(0.2);
        cdda.clearMonsters(80);
        cdda.faceTile(col.x * 24 + 12, col.y * 24 + 12);
        cdda.game.player.pitch = 0;
        return { colony: col, start: [sx, sy] };
      })()`);
      if ('error' in setup) {
        check('found an anthill with a colony group', false, setup);
        return;
      }
      const col0 = setup.colony;
      check(`the anthill holds a ${col0.group} colony (${col0.groups} submap groups, population ${col0.population})`, col0.group === 'GROUP_ANT' && col0.population > 0, col0);
      const w = await settleWorld(js);
      if (!w.ok) check('the surroundings finished loading', false, w);
      const before = await js<Colony>(`cdda.specialSpawns('Anthill', 3)`);
      check('standing outside its spread, none of the colony has come out yet', before.unspent === before.population, before);
      await shot('antcolony_start');

      // Walk toward the hill in 5 s stretches (re-aimed between them, as a player steers).
      const trace: { t: number; unspent: number; ants: number; seen: number; dist: number }[] = [];
      let firstSeen: number | null = null;
      for (let i = 0; i < 12; i++) {
        await js(`cdda.faceTile(${col0.x * 24 + 12}, ${col0.y * 24 + 12}); cdda.game.player.pitch = 0;`);
        await c.x().hold('w', 5000);
        const col = await js<Colony>(`cdda.specialSpawns('Anthill', 3)`);
        const a = await ants();
        const dist = await js<number>(`Math.hypot(cdda.game.player.x - ${col0.x * 24 + 12}, cdda.game.player.y - ${col0.y * 24 + 12})`);
        trace.push({ t: (i + 1) * 5, unspent: col.unspent, ants: a.n, seen: a.seen, dist: Math.round(dist) });
        if (a.seen && firstSeen === null) {
          firstSeen = i;
          await js(`cdda.faceMonster(${a.uid}); cdda.game.player.pitch = -0.05;`);
          await sleep(300);
          await shot('antcolony_first_ants');
        }
        if (dist < 30) break;
      }
      console.log('    walk trace:', JSON.stringify(trace));
      const last = trace[trace.length - 1];
      check('walking in, the colony materialises: its unspent population drains step by step',
        last.unspent < before.unspent && trace.every((s, i) => i === 0 || s.unspent <= trace[i - 1].unspent), trace);
      check('ants are out in the world around the survivor', last.ants > 0, trace);
      check('…and the survivor sees some of them arrive', firstSeen !== null, trace);
      const a = await ants();
      if (a.uid !== null) {
        await js(`cdda.faceMonster(${a.uid}); cdda.game.player.pitch = -0.05;`);
        await sleep(300);
      }
      await shot('antcolony_near_hill');
      const stats = await js<unknown>(`cdda.monGroupStats()`);
      console.log('    group stats:', JSON.stringify(stats));
      await js(`cdda.godMode(false)`);
    }],
  ];
}
