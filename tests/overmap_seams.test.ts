// Tunnels that cross region edges (genVersion 3, seams.ts): both halves of a crossing come from the
// seed alone, line up exactly, join their regions' networks and render as one track.
import { describe, expect, it } from 'vitest';
import { hashString } from '../src/core/rng';
import { Overmap, REGION } from '../src/world/overmap/overmap';
import { tunnelSeams } from '../src/world/overmap/seams';
import { WorldGenerator } from '../src/world/worldgen';
import { CHUNK } from '../src/world/coords';
import { hasFlag } from '../src/world/registry';
import { loadNodeData, makeMap } from '../tools/lib/node_data';

const { game, wg } = loadNodeData();
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
const SEEDS = [1, 42, 743667900];

function regionHash(om: Overmap, rx: number, ry: number): number {
  const parts: string[] = [];
  for (let z = -7; z <= 1; z++)
    for (let y = 0; y < REGION; y++)
      for (let x = 0; x < REGION; x++) {
        const o = om.omtAt(rx * REGION + x, ry * REGION + y, z);
        parts.push(o.special ? `${o.id}@${o.special.def}:${o.special.uid}` : o.id);
      }
  return hashString(parts.join('|'));
}

/** Every tile pair across the region edges inside the 3x3 block around region 0,0, plus the
 *  block's outer edges (which generate the neighbour). Yields [a, b, dir a->b]. */
function* edgePairs(): Generator<[number, number, number, number, number]> {
  for (let ry = -1; ry <= 1; ry++)
    for (let rx = -1; rx <= 1; rx++)
      for (let k = 0; k < REGION; k++) {
        // east edge of (rx, ry) and south edge of (rx, ry)
        yield [(rx + 1) * REGION - 1, ry * REGION + k, (rx + 1) * REGION, ry * REGION + k, 1];
        yield [rx * REGION + k, (ry + 1) * REGION - 1, rx * REGION + k, (ry + 1) * REGION, 2];
      }
}

describe('cross-region tunnels (genVersion 3)', () => {
  it('derives seams from the seed alone, the same for both neighbours of an edge', () => {
    for (const seed of SEEDS)
      for (let ry = -2; ry <= 2; ry++)
        for (let rx = -2; rx <= 2; rx++) {
          const mine = tunnelSeams(seed, rx, ry, REGION);
          // my east seams are my east neighbour's west seams, at the same y
          const east = tunnelSeams(seed, rx + 1, ry, REGION).filter((s) => s.side === 3).map((s) => [s.y, s.connection]);
          expect(mine.filter((s) => s.side === 1).map((s) => [s.y, s.connection])).toEqual(east);
          const south = tunnelSeams(seed, rx, ry + 1, REGION).filter((s) => s.side === 0).map((s) => [s.x, s.connection]);
          expect(mine.filter((s) => s.side === 2).map((s) => [s.x, s.connection])).toEqual(south);
          for (const s of mine) expect(Math.min(s.x, s.y, REGION - 1 - s.x, REGION - 1 - s.y)).toBe(0);
        }
  });

  it('generates a region the same whichever neighbours generated first', () => {
    for (const seed of SEEDS) {
      const alone = new Overmap(seed, wg.overmap);
      const crowded = new Overmap(seed, wg.overmap);
      for (const [x, y] of [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]]) crowded.omtAt(x * REGION, y * REGION, -2);
      expect(regionHash(crowded, 1, 1), `seed ${seed}`).toBe(regionHash(alone, 1, 1));
      // and the neighbours don't change when the middle generated before them
      const after = new Overmap(seed, wg.overmap);
      after.omtAt(REGION, REGION, -2);
      expect(regionHash(after, 2, 1), `seed ${seed}`).toBe(regionHash(new Overmap(seed, wg.overmap), 2, 1));
    }
  }, 120_000);

  it('lines seam tunnels up exactly across region edges; only subways cross, at z-2', () => {
    let crossings = 0;
    for (const seed of SEEDS) {
      const om = new Overmap(seed, wg.overmap);
      for (let z = -7; z <= -1; z++)
        for (const [ax, ay, bx, by, d] of edgePairs()) {
          const a = om.omtAt(ax, ay, z), b = om.omtAt(bx, by, z);
          const aOut = a.line >= 0 && /^(sewer|subway)$/.test(a.type) && !!(a.line & (1 << d));
          const bIn = b.line >= 0 && /^(sewer|subway)$/.test(b.type) && !!(b.line & (1 << ((d + 2) % 4)));
          expect(aOut, `${a.id} at ${ax},${ay},${z} vs ${b.id} across the edge, seed ${seed}`).toBe(bIn);
          if (!aOut) continue;
          expect(b.type).toBe(a.type);
          expect(`${a.type}@${z}`).toBe('subway@-2');
          crossings++;
        }
      // every seam the seed asks for exists
      for (let ry = -1; ry <= 1; ry++)
        for (let rx = -1; rx <= 1; rx++)
          for (const s of tunnelSeams(seed, rx, ry, REGION)) {
            const o = om.omtAt(rx * REGION + s.x, ry * REGION + s.y, s.z);
            expect(o.type === s.terrain && !!(o.line & (1 << s.side)), `seam ${s.side} of region ${rx},${ry}, seed ${seed}`).toBe(true);
          }
    }
    expect(crossings).toBeGreaterThan(SEEDS.length * 3);
  }, 120_000);

  it('leaves genVersion 2 without a tunnel across a region edge', () => {
    const om = new Overmap(42, wg.overmap, 2);
    for (const z of [-1, -2])
      for (const [ax, ay, , , d] of edgePairs()) {
        const a = om.omtAt(ax, ay, z);
        expect(a.line >= 0 && /^(sewer|subway)$/.test(a.type) && !!(a.line & (1 << d))).toBe(false);
      }
  }, 60_000);

  it('joins stations to stations in other regions', () => {
    let stations = 0, reaching = 0;
    for (const seed of SEEDS) {
      const om = new Overmap(seed, wg.overmap);
      const LO = -REGION, HI = 2 * REGION, z = -2;
      const comp = new Map<string, number>();
      let n = 0;
      for (let y = LO; y < HI; y++)
        for (let x = LO; x < HI; x++) {
          if (comp.has(`${x},${y}`) || om.omtAt(x, y, z).type !== 'subway') continue;
          comp.set(`${x},${y}`, ++n);
          const st: [number, number][] = [[x, y]];
          while (st.length) {
            const [cx, cy] = st.pop()!;
            const o = om.omtAt(cx, cy, z);
            for (let d = 0; d < 4; d++) {
              const nx = cx + DX[d], ny = cy + DY[d];
              if (nx < LO || ny < LO || nx >= HI || ny >= HI || comp.has(`${nx},${ny}`)) continue;
              const nb = om.omtAt(nx, ny, z);
              if (o.type === 'subway' ? !(o.line & (1 << d)) : !(nb.type === 'subway' && nb.line & (1 << ((d + 2) % 4)))) continue;
              comp.set(`${nx},${ny}`, n);
              st.push([nx, ny]);
            }
          }
        }
      const regionsOf = new Map<number, Set<string>>();
      const found: [number, string][] = [];
      for (let y = LO; y < HI; y++)
        for (let x = LO; x < HI; x++) {
          if (!/sub_station/.test(om.omtAt(x, y, z).type)) continue;
          const k = comp.get(`${x},${y}`), region = `${Math.floor(x / REGION)},${Math.floor(y / REGION)}`;
          expect(k, `station ${x},${y} on a network, seed ${seed}`).toBeDefined();
          found.push([k!, region]);
          (regionsOf.get(k!) ?? regionsOf.set(k!, new Set()).get(k!)!).add(region);
        }
      stations += found.length;
      reaching += found.filter(([k, r]) => [...regionsOf.get(k)!].some((o) => o !== r)).length;
    }
    // genVersion 2: none (per-region networks); measured 68-100% per seed with seams
    expect(reaching / stations).toBeGreaterThan(0.6);
  }, 120_000);

  it('renders track straight across a seam', () => {
    const seed = 42;
    const map = makeMap(game, seed);
    const gen = new WorldGenerator(seed, wg, game);
    gen.stats.quiet = true;
    map.generator = gen;
    const om = gen.overmap;
    let checked = 0;
    for (const s of tunnelSeams(seed, 0, 0, REGION)) {
      const [ax, ay] = [s.x, s.y], [bx, by] = [s.x + DX[s.side], s.y + DY[s.side]];
      expect(om.omtAt(ax, ay, s.z).type).toBe('subway');
      expect(om.omtAt(bx, by, s.z).type).toBe('subway');
      map.chunk(ax, ay, s.z);
      map.chunk(bx, by, s.z);
      // the edge tiles of the two OMTs facing each other: rail on one side meets rail on the other
      let rails = 0, met = 0;
      for (let k = 0; k < CHUNK; k++) {
        const tx = DX[s.side] === 0 ? ax * CHUNK + k : DX[s.side] > 0 ? ax * CHUNK + CHUNK - 1 : ax * CHUNK;
        const ty = DY[s.side] === 0 ? ay * CHUNK + k : DY[s.side] > 0 ? ay * CHUNK + CHUNK - 1 : ay * CHUNK;
        const a = hasFlag(map.terAt(tx, ty, s.z), 'RAIL'), b = hasFlag(map.terAt(tx + DX[s.side], ty + DY[s.side], s.z), 'RAIL');
        if (a) rails++;
        if (a && b) met++;
        expect(a, `rail continuity at ${tx},${ty} across the seam`).toBe(b);
      }
      expect(rails, `track reaches the seam at ${ax},${ay}`).toBeGreaterThan(0);
      expect(met).toBe(rails);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    expect([...gen.stats.unsupported.keys()].filter((k) => /builtin mapgen (sewer|subway)/.test(k))).toEqual([]);
  }, 60_000);
});
