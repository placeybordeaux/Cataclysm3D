// Real-input deep lab (docs/WORLD_TRANSPORT.md "Full z range"), run from tools/realinput.ts:
//   --only deeplab     climb down BN's classic lab from its z0 bunker to its bottom level, z-10
//                      on seed 1 (genVersion 3 grows lab_basement to BN's OVERMAP_DEPTH)
//
// cdda.* only finds the lab, places the survivor at the top of each level's way down (the lab
// rooms between flights are locked doors and turrets, not what this checks) and reads state;
// every descent is real keys: W held down a modelled flight, or `>` on a plain stair tile.

import type { XInput } from './lib/realinput';

export interface DeepLabCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

interface Lab { x: number; y: number; bottom: number; levels: number[] }
interface Stand { ok: boolean; shape?: string; z?: number; x?: number; y?: number; why?: string }

export function deepLabScenarios(c: DeepLabCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  const where = () => js<{ z: number; x: number; y: number; climbing: boolean; omt: string }>(`(() => { const p = cdda.game.player; return { z: p.z, x: p.tileX, y: p.tileY, climbing: !!cdda.stairs.climb(), omt: cdda.omtAt().type }; })()`);
  return [
    ['deeplab', 'climb down the classic lab with real keys, level by level, from the z0 bunker to its bottom (z-10, below the old -7 floor)', async () => {
      await toGameplay();
      // Setup: the nearest classic lab ("Lab" special) whose basement reaches z-10 and has a way
      // down on every level. BN's lab.lua puts stairs only on t_thconc_floor, so now and then a
      // lab_stairs room's floor plan has none and the lab dead-ends (seed 1's start lab at z-1;
      // genVersion 2 labs too): those are skipped, and counted.
      const pick = await js<{ lab: Lab | null; tried: number; deadEnds: string[] }>(`(() => {
        const p = cdda.game.player, ox = Math.floor(p.x / 24), oy = Math.floor(p.y / 24), m = cdda.game.map;
        const downIn = (cx, cy, z) => {
          for (let ly = 0; ly < 24; ly++) for (let lx = 0; lx < 24; lx++) if ((m.terAt(cx * 24 + lx, cy * 24 + ly, z).flags ?? []).includes('GOES_DOWN')) return true;
          return false;
        };
        const bunkers = [];
        for (let r = 0; r <= 100; r++)
          for (let dy = -r; dy <= r; dy++)
            for (let dx = -r; dx <= r; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
              const o = cdda.omtAt(ox + dx, oy + dy, 0);
              if (o.special === 'Lab' && o.type === 'lab_stairs') bunkers.push({ x: ox + dx, y: oy + dy });
            }
        const deadEnds = [];
        let tried = 0;
        for (const b of bunkers) {
          tried++;
          const levels = [], stairs = {};
          for (let z = -1; z >= -10; z--) {
            for (let dy = -16; dy <= 16; dy++) for (let dx = -16; dx <= 16; dx++) {
              const o = cdda.omtAt(b.x + dx, b.y + dy, z);
              if (o.special !== 'Lab') continue;
              if (!levels.includes(z)) levels.push(z);
              if (o.type === 'lab_stairs') (stairs[z] ??= []).push([b.x + dx, b.y + dy]);
            }
          }
          const bottom = Math.min(...levels);
          if (bottom !== -10) continue;
          let dead = null;
          for (let z = -1; z > bottom && dead === null; z--) if (!(stairs[z] ?? []).some(([cx, cy]) => downIn(cx, cy, z))) dead = z;
          if (dead !== null) { deadEnds.push(b.x + ',' + b.y + ' at z' + dead); continue; }
          return { lab: { ...b, bottom, levels }, tried, deadEnds };
        }
        return { lab: null, tried, deadEnds };
      })()`);
      const lab = pick.lab;
      console.log('  deeplab candidates:', pick.tried, 'dead ends skipped:', pick.deadEnds.join('; ') || 'none');
      if (!check('found a classic lab whose basement reaches z-10 with stairs on every level', !!lab, pick)) return;
      check('…with every level from z-1 to z-10', lab!.levels.length === 10, lab!.levels);
      await js(`(() => { cdda.godMode(true); cdda.setHour(12); cdda.clearMonsters(60); cdda.stairs.setVariant('flight'); })()`);

      let z = 0;
      const visited: { z: number; shape: string; ms: number }[] = [];
      // stairs that refused ("The way is blocked.": furniture on the landing the stair search
      // picked below) are noted and the next staircase on the level is tried, as a player would
      const blocked: string[] = [];
      let tried: string[] = [];
      while (z > lab!.bottom) {
        // Setup: the top of a way down from level z inside the lab (any lab_stairs room's stairs,
        // or the bunker's at z0), the survivor facing onto it.
        const st = await js<Stand>(`(() => {
          const m = cdda.game.map, L = ${JSON.stringify(lab)}, z = ${z}, skip = new Set(${JSON.stringify(tried)});
          // first pass: stairs whose landing below is clear (a lab bench or turret on it says "The
          // way is blocked."); second: any (a modelled flight's top sits over its own run)
          for (const strict of [true, false]) for (let dy = -16; dy <= 16; dy++) for (let dx = -16; dx <= 16; dx++) {
            const ox = L.x + dx, oy = L.y + dy, o = cdda.omtAt(ox, oy, z);
            if (o.special !== 'Lab' || (z < 0 && o.type !== 'lab_stairs')) continue;
            for (let ly = 0; ly < 24; ly++) for (let lx = 0; lx < 24; lx++) {
              const x = ox * 24 + lx, y = oy * 24 + ly;
              if (!(m.terAt(x, y, z).flags ?? []).includes('GOES_DOWN')) continue;
              if ((strict && !m.passable(x, y, z - 1)) || skip.has(x + ',' + y)) continue;
              cdda.teleport(x + 0.5, y + 0.5, z);
              cdda.step(0.05);
              cdda.clearMonsters(40);
              const d = cdda.stairs.standAt(x, y, z - 1, true);
              const p = cdda.game.player;
              if (!d) { p.x = x + 0.5; p.y = y + 0.5; p.z = z; }
              p.pitch = -0.3;
              return { ok: true, shape: d ? d.shape : 'tile', z: p.z, x, y };
            }
          }
          return { ok: false, why: 'no stairs down on level ' + z };
        })()`);
        if (!check(`level ${z}: found its way down`, st.ok && st.z === z, st)) return;
        await toGameplay();
        if (st.shape === 'tile') {
          // the stair index only links a flight once the level below is built: ask again now the
          // surroundings have settled
          const again = await js<{ shape: string } | null>(`(() => { const d = cdda.stairs.standAt(${st.x}, ${st.y}, ${z - 1}, true); if (d) cdda.game.player.pitch = -0.3; return d; })()`);
          if (again) st.shape = again.shape;
          await sleep(200);
        }
        const t0 = Date.now();
        // A modelled flight is walked down with W held; a plain stair tile (or a ladder) takes `>`.
        const walk = st.shape !== 'tile' && st.shape !== 'ladder';
        if (walk) await c.x().down('w');
        else await c.x().key('greater');
        let s = await where();
        while (Date.now() - t0 < 10000 && !(s.z === z - 1 && !s.climbing)) {
          await sleep(80);
          s = await where();
        }
        if (walk) await c.x().up('w');
        const how = `level ${z} → ${z - 1} by ${walk ? 'W down the ' + st.shape : '>'}`;
        if (s.z !== z - 1) {
          const log = await js<string[]>('cdda.ui.log().slice(-10)');
          if (log.some((l) => /way is blocked/.test(l)) && tried.length < 6) {
            blocked.push(`${st.x},${st.y},${z}`);
            tried.push(`${st.x},${st.y}`);
            continue;
          }
          check(how, false, { s, st, log });
          return;
        }
        check(how, true);
        tried = [];
        visited.push({ z: z - 1, shape: st.shape!, ms: Date.now() - t0 });
        z = s.z;
        if (z <= -8) await shot(`deeplab_z${z}`);
      }
      const end = await where();
      check('standing on the lab\'s bottom level, z-10', end.z === -10, end);
      check('…in a lab OMT', /^lab/.test(end.omt), end);
      // the bottom level is drawn: the chunk under you and its neighbours are built, nothing unbuilt in view
      await sleep(1500);
      const drawn = await js<{ built: boolean; topZ: number }>(`(() => {
        const p = cdda.game.player, cm = cdda.renderer.chunks;
        // chunkManager.ts key()
        const e = cm.entries.get(((p.z + 16) * 4096 + (Math.floor(p.x / 24) + 2048)) * 4096 + (Math.floor(p.y / 24) + 2048));
        return { built: !!e?.shown, topZ: cdda.game.map.topZ() };
      })()`);
      check('the z-10 chunk you stand in is built and shown', drawn.built, drawn);
      await shot('deeplab_bottom');
      // look round with the mouse
      for (let i = 0; i < 2; i++) {
        await c.x().move(500, 0, 10);
        await sleep(400);
        await shot(`deeplab_bottom_look${i}`);
      }
      console.log('  deeplab blocked stairs (tried the next):', blocked.join(' ') || 'none');
      console.log('  deeplab descents:', visited.map((v) => `${v.z}:${v.shape}:${v.ms}ms`).join(' '));
      await js(`(() => { cdda.godMode(false); })()`);
    }],
  ];
}
