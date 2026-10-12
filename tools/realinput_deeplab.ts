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
      // Setup: the nearest classic lab ("Lab" special) and the levels its basement fills.
      const lab = await js<Lab | null>(`(() => {
        const p = cdda.game.player, ox = Math.floor(p.x / 24), oy = Math.floor(p.y / 24);
        let best = null;
        for (let r = 0; r <= 60 && !best; r++)
          for (let dy = -r; dy <= r && !best; dy++)
            for (let dx = -r; dx <= r; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
              const o = cdda.omtAt(ox + dx, oy + dy, 0);
              if (o.special === 'Lab' && o.type === 'lab_stairs') { best = { x: ox + dx, y: oy + dy }; break; }
            }
        if (!best) return null;
        const levels = [];
        for (let z = -1; z >= -10; z--) {
          let any = false;
          for (let dy = -16; dy <= 16 && !any; dy++) for (let dx = -16; dx <= 16; dx++) if (cdda.omtAt(best.x + dx, best.y + dy, z).special === 'Lab') { any = true; break; }
          if (any) levels.push(z);
        }
        return { ...best, bottom: Math.min(...levels), levels };
      })()`);
      if (!check('found the classic lab near the start', !!lab, lab)) return;
      check('its basement reaches z-10 (genVersion 3: BN depth, below the old -7 floor)', lab!.bottom === -10, lab);
      check('…with every level in between', lab!.levels.length === 10, lab!.levels);
      await js(`(() => { cdda.godMode(true); cdda.setHour(12); cdda.clearMonsters(60); cdda.stairs.setVariant('flight'); })()`);

      let z = 0;
      const visited: { z: number; shape: string; ms: number }[] = [];
      while (z > lab!.bottom) {
        // Setup: the top of a way down from level z inside the lab (any lab_stairs room's stairs,
        // or the bunker's at z0), the survivor facing onto it.
        const st = await js<Stand>(`(() => {
          const m = cdda.game.map, L = ${JSON.stringify(lab)}, z = ${z};
          for (let dy = -16; dy <= 16; dy++) for (let dx = -16; dx <= 16; dx++) {
            const ox = L.x + dx, oy = L.y + dy, o = cdda.omtAt(ox, oy, z);
            if (o.special !== 'Lab' || (z < 0 && o.type !== 'lab_stairs')) continue;
            for (let ly = 0; ly < 24; ly++) for (let lx = 0; lx < 24; lx++) {
              const x = ox * 24 + lx, y = oy * 24 + ly;
              if (!(m.terAt(x, y, z).flags ?? []).includes('GOES_DOWN')) continue;
              cdda.teleport(x + 0.5, y + 0.5, z);
              cdda.step(0.05);
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
        if (!check(`level ${z} → ${z - 1} by ${walk ? 'W down the ' + st.shape : '>'}`, s.z === z - 1, { s, st })) return;
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
      console.log('  deeplab descents:', visited.map((v) => `${v.z}:${v.shape}:${v.ms}ms`).join(' '));
      await js(`(() => { cdda.godMode(false); })()`);
    }],
  ];
}
