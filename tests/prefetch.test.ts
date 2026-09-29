import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/world/map';
import { ChunkPrefetcher } from '../src/world/prefetch';

function setup() {
  const map = new GameMap(1);
  const order: string[] = [];
  map.generator = { generate: (_m, c) => void order.push(`${c.cx},${c.cy},${c.z}`) };
  const pos = { x: 12, y: 12, z: 0 };
  const pf = new ChunkPrefetcher(map, () => pos);
  pf.opts = { ...pf.opts, radius: 3, below: 0, above: 0 };
  return { map, order, pos, pf };
}

describe('ChunkPrefetcher', () => {
  it('generates the player chunk first, then outward, and stops when everything is there', () => {
    const { order, pf } = setup();
    pf.step();
    expect(order[0]).toBe('0,0,0');
    let n = 1;
    while (pf.step()) n++;
    expect(n).toBe(order.length);
    // radius 3 disc (dx²+dy² <= 3.5²): 37 chunks
    expect(order.length).toBe(37);
    expect(pf.stats.sync).toBe(0);
    expect(pf.step()).toBe(false);
  });

  it('leans toward the direction of travel', () => {
    const { order, pos, pf } = setup();
    pf.observe(0);
    pos.x += 10; // 10 tiles/s east
    pf.observe(1000);
    for (let i = 0; i < 12; i++) pf.step();
    const east = order.filter((k) => Number(k.split(',')[0]) > 0).length;
    const west = order.filter((k) => Number(k.split(',')[0]) < 0).length;
    expect(east).toBeGreaterThan(west);
  });

  it('counts chunks generated outside the prefetcher as sync', () => {
    const { map, pf } = setup();
    map.chunk(5, 5, 0);
    expect(pf.stats.sync).toBe(1);
    pf.step();
    expect(pf.stats.sync).toBe(1);
    expect(pf.stats.prefetched).toBe(1);
  });
});
