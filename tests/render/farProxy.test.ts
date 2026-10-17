import { describe, expect, it } from 'vitest';
import { WorldGenerator } from '../../src/world/worldgen';
import { CHUNK, LEVEL_HEIGHT } from '../../src/world/coords';
import type { Chunk, GameMap } from '../../src/world/map';
import type { TerrainDef } from '../../src/data/types';
import { buildColumnQuads, overmapTopOf, tileLook } from '../../src/render/farProxy';
import { loadNodeData, makeMap } from '../../tools/lib/node_data';

// Far proxies (docs/FAR_LOD.md) are built from columns a second generator writes into a
// scratch map. That is only right if the scratch column is the very terrain the live map
// makes when you get there, whatever was generated before it on either side.

const { game, wg } = loadNodeData();
const SEED = 1;

/** The nearest few town building columns (multi-storey first) around the origin. */
function townColumns(gen: WorldGenerator, n: number): [number, number][] {
  const out: [number, number][] = [];
  const city = gen.overmap.closestCity(0, 0, 1);
  if (!city) throw new Error('no city near the origin for seed 1');
  const ox = city.x, oy = city.y;
  for (let r = 0; r < 12 && out.length < n; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || out.length >= n) continue;
        const id = gen.overmap.omtAt(ox + dx, oy + dy, 0).id;
        if (/^(house|s_|bank|office|apartment|church|school)/.test(id)) out.push([ox + dx, oy + dy]);
      }
  return out;
}

function column(map: GameMap, cx: number, cy: number, top: number): Chunk[] {
  const out: Chunk[] = [];
  for (let z = 0; z <= top; z++) out.push(map.chunk(cx, cy, z)!);
  return out;
}

describe('far proxies', () => {
  it('scratch columns match the live map, whatever was generated first', () => {
    const live = makeMap(game, SEED);
    const lg = new WorldGenerator(SEED, wg, game);
    lg.stats.quiet = true;
    live.generator = lg;
    const scratch = makeMap(game, SEED);
    const sg = new WorldGenerator(SEED, wg, game, lg.genVersion, lg.overmap);
    sg.stats.quiet = true;
    scratch.generator = sg;
    const cols = townColumns(lg, 6);
    expect(cols.length).toBe(6);
    const top = (cx: number, cy: number) => overmapTopOf((x, y, z) => lg.overmap.omtAt(x, y, z), cx, cy);
    // live generates in one order, scratch in the reverse (and drops each column after it,
    // as the proxy layer does)
    const liveCols = new Map(cols.map(([cx, cy]) => [`${cx},${cy}`, column(live, cx, cy, top(cx, cy))]));
    for (const [cx, cy] of [...cols].reverse()) {
      const s = column(scratch, cx, cy, top(cx, cy));
      const l = liveCols.get(`${cx},${cy}`)!;
      for (let z = 0; z < s.length; z++) {
        expect(Array.from(s[z].ter), `ter ${cx},${cy},${z}`).toEqual(Array.from(l[z].ter));
        expect(Array.from(s[z].furn), `furn ${cx},${cy},${z}`).toEqual(Array.from(l[z].furn));
      }
      for (let z = s.length - 1; z >= 0; z--) scratch.evictChunk(s[z]);
      sg.forgetColumn(cx, cy);
    }
  });

  it('builds a town column into boxes at storey heights with the tiles\' colours', () => {
    const map = makeMap(game, SEED);
    const gen = new WorldGenerator(SEED, wg, game);
    gen.stats.quiet = true;
    map.generator = gen;
    const [[cx, cy]] = townColumns(gen, 1);
    const top = overmapTopOf((x, y, z) => gen.overmap.omtAt(x, y, z), cx, cy);
    const levels = column(map, cx, cy, top).map((c) => (c.empty ? null : c));
    const looks = new Map<number, ReturnType<typeof tileLook>>();
    const look = (i: number, _z: number) => {
      let L = looks.get(i);
      if (!L) looks.set(i, (L = tileLook(map.terrain.get(i) as TerrainDef, null, 1)));
      return L;
    };
    const q = buildColumnQuads(cx, cy, levels, look);
    expect(q.length % 18).toBe(0);
    const quads = q.length / 18;
    // a house is tens of boxes, never one quad per tile face (24 x 24 x levels)
    expect(quads).toBeGreaterThan(10);
    expect(quads).toBeLessThan(1500);
    let maxH = -Infinity, minX = Infinity, maxX = -Infinity;
    for (let o = 0; o < q.length; o += 18) {
      for (let v = 0; v < 4; v++) {
        maxH = Math.max(maxH, q[o + v * 3 + 1]);
        minX = Math.min(minX, q[o + v * 3]);
        maxX = Math.max(maxX, q[o + v * 3]);
      }
      // unit normals, colours in 0..1
      expect(Math.hypot(q[o + 12], q[o + 13], q[o + 14])).toBeCloseTo(1, 5);
      for (let k = 15; k < 18; k++) expect(q[o + k]).toBeGreaterThanOrEqual(0);
    }
    // walls stand at least a storey; nothing leaves the column
    expect(maxH).toBeGreaterThanOrEqual(LEVEL_HEIGHT - 0.01);
    expect(minX).toBeGreaterThanOrEqual(cx * CHUNK);
    expect(maxX).toBeLessThanOrEqual(cx * CHUNK + CHUNK);
    // 2x2 cells: fewer boxes for the outer ring
    expect(buildColumnQuads(cx, cy, levels, look, 2).length).toBeLessThan(q.length);
  });
});
