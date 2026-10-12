import { describe, expect, it } from 'vitest';
import { Overmap, REGION } from '../src/world/overmap/overmap';
import { CUBE_DIRS, rotateDir } from '../src/world/overmap/mutable';
import { parseOterId } from '../src/world/overmap/oter';
import { WorldGenerator } from '../src/world/worldgen';
import { hasFlag } from '../src/world/registry';
import { CHUNK } from '../src/world/coords';
import type { CubeDir } from '../src/world/worldgen_data';
import { loadNodeData, makeMap } from '../tools/lib/node_data';

const { game, wg } = loadNodeData();
const data = wg.overmap;
const MUTABLE = (data.mutableWildSpecials ?? []).filter((id) => data.mutables?.[id]);
const MINES = (data.mutableWildSpecials ?? []).filter((id) => !data.mutables?.[id]);
const DISPLACE: Record<CubeDir, [number, number, number]> = {
  north: [0, -1, 0], east: [1, 0, 0], south: [0, 1, 0], west: [-1, 0, 0], above: [0, 0, 1], below: [0, 0, -1],
};
const OPP: Record<CubeDir, CubeDir> = { north: 'south', east: 'west', south: 'north', west: 'east', above: 'below', below: 'above' };

/** 3x3 regions around the origin. Seeds 3 and 4 between them hold every mutable special. */
function block(seed: number, version?: number) {
  const om = new Overmap(seed, data, version);
  for (let ry = -1; ry <= 1; ry++) for (let rx = -1; rx <= 1; rx++) om.omtAt(rx * REGION, ry * REGION, 0);
  return om;
}

describe('BN mutable specials on real data', () => {
  const oms = [block(4), block(3)];
  const reports = oms.flatMap((om) => om.mutableReports.map((r) => ({ om, r })));

  it('extracted the mutable specials we place', () => {
    expect(MUTABLE.sort()).toEqual(['Acid Anthill', 'Anthill', 'Ice Lab', 'Lab with Anthill', 'Slime Pit', 'stream_mutable']);
    expect(data.mutables?.mine_tunnel).toBeDefined();
    expect(MINES.sort()).toEqual(['Amigara mine', 'Mine Entrance', 'Spiral mine', 'Wyrms mine']);
  });

  it('places every one of them, with every mandatory join met', () => {
    for (const id of [...MUTABLE, 'mine_tunnel']) expect(reports.filter(({ r }) => r.def === id).length, id).toBeGreaterThan(0);
    for (const { r } of reports) {
      expect(r.openMandatory, `${r.def} ${r.uid}`).toBe(0);
      expect(r.bnUnresolved).toBe(false);
    }
  });

  it('joins check out independently: each mandatory face meets the opposite join of a neighbouring piece', () => {
    let checked = 0;
    for (const { om, r } of reports) {
      const def = data.mutables![r.def];
      const at = new Map(r.pieces.map((p) => [`${p.x},${p.y},${p.z}`, p]));
      const oppositeOf = (id: string) => def.joins.find((j) => j.id === id)?.opposite ?? id;
      for (const p of r.pieces) {
        const ter = def.overmaps[p.overmap];
        // what the overmap holds there now (plain rock written by a special stays unowned)
        const want = parseOterId(ter.overmap, data.terrains).type;
        if (want !== 'empty_rock') expect(om.omtAt(p.x, p.y, p.z).type).toBe(want);
        for (const d of CUBE_DIRS) {
          const tj = ter.joins[d];
          if (!tj || tj.type !== 'mandatory') continue;
          const dir = rotateDir(d, p.rot);
          const [dx, dy, dz] = DISPLACE[dir];
          const n = at.get(`${p.x + dx},${p.y + dy},${p.z + dz}`);
          expect(n, `${r.def}: ${p.overmap}@${p.x},${p.y},${p.z} ${dir} leads nowhere`).toBeDefined();
          const back = CUBE_DIRS.find((nd) => rotateDir(nd, n!.rot) === OPP[dir] && def.overmaps[n!.overmap].joins[nd]);
          expect(back, `${r.def}: ${n!.overmap} has no join facing back`).toBeDefined();
          const nj = def.overmaps[n!.overmap].joins[back!]!;
          expect([tj.id, ...(tj.alternatives ?? [])].map(oppositeOf)).toContain(nj.id);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('anthills: an entrance on land over a tunnel hub, a queen in every nest', () => {
    for (const { r } of reports.filter(({ r: x }) => x.def === 'Anthill' || x.def === 'Acid Anthill')) {
      const root = r.pieces[0];
      expect(root.overmap).toBe('surface');
      expect(root.z).toBe(0);
      expect(r.pieces.some((p) => p.overmap === 'below_entrance' && p.x === root.x && p.y === root.y && p.z === -1)).toBe(true);
      expect(r.pieces.filter((p) => p.overmap === 'queen')).toHaveLength(1);
    }
  });

  it('Lab with Anthill grows its lab_basement under the stairs and an anthill beside it', () => {
    const { om, r } = reports.find(({ r: x }) => x.def === 'Lab with Anthill')!;
    const root = r.pieces[0];
    expect(om.omtAt(root.x, root.y, 0).type).toBe('lab_stairs');
    expect(om.omtAt(root.x, root.y, -1).type).toBe('lab_core');
    expect(r.pieces.some((p) => p.overmap === 'surface' && p.z === 0)).toBe(true);
  });

  it('every mine gets its mine_tunnel next to the shaft, running down to a finale', () => {
    let mines = 0;
    for (const om of oms)
    for (let ry = -1; ry <= 1; ry++)
      for (let rx = -1; rx <= 1; rx++)
        for (let y = 0; y < REGION; y++)
          for (let x = 0; x < REGION; x++) {
            const o = om.omtAt(rx * REGION + x, ry * REGION + y, 0);
            const s = o.special;
            if (!s || !MINES.includes(s.def) || s.x !== rx * REGION + x || s.y !== ry * REGION + y) continue;
            mines++;
            const t = om.mutableReports.find((r) => r.def === 'mine_tunnel' && r.pieces[0].x === s.x && r.pieces[0].y === s.y);
            expect(t, `${s.def}@${s.x},${s.y}`).toBeDefined();
            expect(t!.pieces[0]).toMatchObject({ overmap: 'above_entrance', z: -1 });
            expect(t!.pieces[1]).toMatchObject({ overmap: 'stairs_up', x: s.x, y: s.y, z: -2 });
            expect(t!.pieces.filter((p) => p.overmap === 'finale')).toHaveLength(1);
          }
    expect(mines).toBeGreaterThan(3);
  });

  it('asks for the subway connections Ice Lab train depots and mines declare', () => {
    const reqs: { connection: string; uid: number; z: number }[] = [];
    for (const om of oms) for (let ry = -1; ry <= 1; ry++) for (let rx = -1; rx <= 1; rx++) reqs.push(...(om as any).region(rx, ry).connectionRequests);
    for (const { r } of reports.filter(({ r: x }) => x.def === 'Ice Lab')) {
      const depots = r.pieces.filter((p) => p.overmap === 'lab_train_depot').length;
      expect(reqs.filter((q) => q.uid === r.uid && q.connection === 'subway_tunnel').length).toBe(depots);
    }
    expect(reqs.some((q) => q.connection === 'subway_tunnel' && q.z === -2)).toBe(true);
  });

  it('does not depend on the order regions are generated in', () => {
    const other = new Overmap(4, data);
    for (let ry = 1; ry >= -1; ry--) for (let rx = 1; rx >= -1; rx--) other.omtAt(rx * REGION, ry * REGION, 0);
    const ids = (o: Overmap) => {
      const out: string[] = [];
      for (let z = 0; z >= -4; z--) for (let y = -REGION; y < 2 * REGION; y += 3) for (let x = -REGION; x < 2 * REGION; x += 3) out.push(o.omtAt(x, y, z).id);
      return out.join();
    };
    expect(ids(other)).toBe(ids(oms[0]));
  });

  it('genVersion 1 places none of them', () => {
    expect(block(4, 1).mutableReports).toHaveLength(0);
  });
});

describe('BN mutable specials render and connect', () => {
  it('an anthill has a way down and the tunnel below a way back up (join-conditioned slope)', () => {
    const seed = 3;
    const map = makeMap(game, seed);
    const gen = new WorldGenerator(seed, wg, game);
    gen.stats.quiet = true;
    map.generator = gen;
    for (let ry = -1; ry <= 1; ry++) for (let rx = -1; rx <= 1; rx++) gen.overmap.omtAt(rx * REGION, ry * REGION, 0);
    const r = gen.overmap.mutableReports.find((x) => x.def === 'Anthill')!;
    const { x, y } = r.pieces[0];
    const count = (z: number, flag: string) => {
      const c = map.chunk(x, y, z)!;
      expect(c.omt?.source).toBe('json');
      let n = 0;
      for (let ly = 0; ly < CHUNK; ly++) for (let lx = 0; lx < CHUNK; lx++) if (hasFlag(map.terAt(x * CHUNK + lx, y * CHUNK + ly, z), flag)) n++;
      return n;
    };
    expect(count(0, 'GOES_DOWN')).toBeGreaterThan(0);
    expect(count(-1, 'GOES_UP')).toBeGreaterThan(0);
  });
});
