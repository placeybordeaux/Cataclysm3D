// The quick start must wake you up inside the evac shelter. Wave-3 playtest: on some seeds a
// later special's road connection paved over the shelter's overmap tile, so the "shelter"
// start was a bare road end (seed 743667900) with a zombie in view.
import { describe, expect, it } from 'vitest';
import { WorldGenerator } from '../src/world/worldgen';
import { loadNodeData } from '../tools/lib/node_data';

describe('start shelter survives road building', () => {
  const { game, wg } = loadNodeData();
  it('the start OMT is a shelter on every seed tried (incl. the one that broke)', () => {
    const bad: string[] = [];
    for (const seed of [743667900, ...Array.from({ length: 20 }, (_, i) => 1000 + i * 7919)]) {
      const gen = new WorldGenerator(seed, wg, game);
      const sp = gen.overmap.findSpecial('Evac Shelter', { x: 0, y: 0 });
      if (!sp) continue;
      const o = gen.overmap.omtAt(sp.x, sp.y, 0);
      if (!o.id.startsWith('shelter')) bad.push(`${seed}: ${o.id}`);
    }
    expect(bad).toEqual([]);
    // ~100 ms of overmap generation per seed; slower when the whole suite runs in parallel.
  }, 60_000);
});
