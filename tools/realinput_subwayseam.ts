// Real-input cross-region subway scenario, run from tools/realinput.ts:
//   --only subwayseam   a subway tunnel that crosses a region edge (genVersion 3, seams.ts):
//                       walking along the track with a held W carries the survivor from one
//                       region's tunnel into the neighbour's, still at z−2 (docs/WORLD_TRANSPORT.md).
//
// Keys are OS-level input; cdda.* only finds the seam, stands the survivor in the tunnel a few
// tiles short of it facing across, and reads state.

import { settleWorld, type XInput } from './lib/realinput';

export interface SubwaySeamCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

const REGION = 96, CHUNK = 24;

export function subwaySeamScenarios(c: SubwaySeamCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  const where = () => js<{ x: number; y: number; z: number }>(`(() => { const p = cdda.game.player; return { x: p.tileX, y: p.tileY, z: p.z }; })()`);
  return [
    ['subwayseam', 'a subway tunnel across a region edge: held W walks the track from one region into the next at z−2', async () => {
      await toGameplay();
      // Find a crossing on the start region's edges, then a lane of passable tiles through it.
      const spot = await js<{ from: [number, number]; to: [number, number]; edge: number; axis: 'x' | 'y'; dir: number; omt: string } | { error: string }>(`(() => {
        const R = ${REGION}, C = ${CHUNK}, DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
        const edges = [];
        for (let k = 0; k < R; k++) edges.push([k, 0, 0], [R - 1, k, 1], [k, R - 1, 2], [0, k, 3]);
        for (const [ax, ay, d] of edges) {
          const a = cdda.omtAt(ax, ay, -2), b = cdda.omtAt(ax + DX[d], ay + DY[d], -2);
          if (a.type !== 'subway' || !(a.line & (1 << d)) || b.type !== 'subway' || !(b.line & (1 << ((d + 2) % 4)))) continue;
          const m = cdda.game.map;
          m.chunk(ax, ay, -2);
          m.chunk(ax + DX[d], ay + DY[d], -2);
          // tile coordinates of the seam line: the first tile past the edge along d
          const edgeX = d === 1 ? (ax + 1) * C : d === 3 ? ax * C - 1 : 0;
          const edgeY = d === 2 ? (ay + 1) * C : d === 0 ? ay * C - 1 : 0;
          for (let k = 2; k < C - 2; k++) {
            const lane = (s) => DX[d] ? [edgeX + DX[d] * s, ay * C + k] : [ax * C + k, edgeY + DY[d] * s];
            let ok = true;
            for (let s = -8; s <= 6 && ok; s++) { const [x, y] = lane(s); ok = m.passable(x, y, -2); }
            if (ok) return { from: lane(-7), to: lane(6), edge: DX[d] ? edgeX : edgeY, axis: DX[d] ? 'x' : 'y', dir: DX[d] + DY[d], omt: a.id + ' | ' + b.id };
          }
        }
        return { error: 'no walkable subway crossing on the start region edges' };
      })()`);
      if ('error' in spot) {
        check('found a subway tunnel crossing a region edge', false, spot);
        return;
      }
      check('found a subway tunnel crossing a region edge', true, spot.omt);
      const [fx, fy] = spot.from, [tx, ty] = spot.to;
      await js(`(() => { cdda.godMode(true); cdda.teleport(${fx} + 0.5, ${fy} + 0.5, -2); cdda.clearMonsters(40); cdda.faceTile(${tx}, ${ty}); cdda.game.player.pitch = 0; cdda.step(0.05); })()`);
      const w = await settleWorld(js);
      if (!w.ok) check('the surroundings finished loading', false, w);
      const regionOf = (p: { x: number; y: number }) => `${Math.floor(p.x / CHUNK / REGION)},${Math.floor(p.y / CHUNK / REGION)}`;
      const start = await where();
      await shot('subwayseam_before');
      // Walk in short holds, re-facing along the lane, until well past the edge.
      const past = (p: { x: number; y: number }) => (spot.axis === 'x' ? p.x : p.y) * spot.dir >= (spot.edge + 3 * spot.dir) * spot.dir;
      let p = start;
      for (let i = 0; i < 12 && !past(p); i++) {
        await js(`cdda.faceTile(${tx}, ${ty})`);
        await c.x().hold('w', 700);
        await sleep(150);
        p = await where();
      }
      await shot('subwayseam_after');
      check('held W walks through the seam into the neighbouring region', past(p) && regionOf(p) !== regionOf(start), { start, end: p, edge: spot.edge });
      check('…staying in the tunnel at z−2', p.z === -2, p);
      await js(`(() => { cdda.godMode(false); })()`);
    }],
  ];
}
