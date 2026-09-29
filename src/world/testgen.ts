import type { Chunk, ChunkGenerator, GameMap } from './map';
import { CHUNK } from './coords';
import { Rng, hashSeed } from '../core/rng';

// Placeholder generator used until the real overmap + JSON mapgen lands:
// grass/dirt ground with a small house in chunk (0,0). Kept for renderer/physics tests
// (?gen=test).

export class TestGenerator implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    const rng = new Rng(hashSeed(map.seed, c.cx, c.cy, c.z));
    const T = (id: string) => map.terrain.index(id);
    const F = (id: string) => map.furniture.index(id);
    const air = T('t_open_air');
    if (c.z > 0) {
      c.ter.fill(air);
      if (c.z === 1 && c.cx === 0 && c.cy === 0) {
        for (let y = 4; y <= 12; y++) for (let x = 4; x <= 14; x++) c.ter[y * CHUNK + x] = T('t_flat_roof');
      }
      c.empty = false;
      return;
    }
    if (c.z < 0) {
      c.ter.fill(T('t_rock'));
      c.empty = false;
      return;
    }
    const grass = T('t_grass'), dirt = T('t_dirt'), tree = T('t_tree');
    for (let i = 0; i < CHUNK * CHUNK; i++) c.ter[i] = rng.oneIn(6) ? dirt : grass;
    for (let i = 0; i < 6; i++) c.ter[rng.int(0, CHUNK * CHUNK - 1)] = tree;
    if (c.cx === 0 && c.cy === 0) {
      const wall = T('t_wall'), floor = T('t_floor');
      for (let y = 4; y <= 12; y++)
        for (let x = 4; x <= 14; x++) {
          const edge = y === 4 || y === 12 || x === 4 || x === 14;
          c.ter[y * CHUNK + x] = edge ? wall : floor;
        }
      c.ter[12 * CHUNK + 9] = T('t_door_c');
      c.ter[4 * CHUNK + 7] = T('t_window');
      c.ter[8 * CHUNK + 14] = T('t_window');
      c.furn[6 * CHUNK + 6] = F('f_table');
      c.furn[6 * CHUNK + 7] = F('f_chair');
      c.furn[10 * CHUNK + 12] = F('f_bed');
      c.furn[5 * CHUNK + 12] = F('f_fridge');
    }
    c.empty = false;
  }
}
