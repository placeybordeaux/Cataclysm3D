import { expect, it } from 'vitest';
import { Chunk, GameMap } from '../../src/world/map';
import { roomDependencySnapshot } from '../../src/render/roomDependencies';

it('invalidates actual room map dependencies for terrain, furniture, roof and chunk lifecycle', () => {
  const map = new GameMap(1);
  map.terrain.add({ id: 't_floor', flags: [], move_cost: 2 } as any);
  map.terrain.add({ id: 't_wall', flags: [], move_cost: 0 } as any);
  map.furniture.add({ id: 'f_table', flags: [], move_cost_mod: 0 } as any);
  const floor = map.chunk(0, 0, 0)!;
  const snapshot = () => roomDependencySnapshot(map, 0, 1, 1);
  let valid = snapshot();
  map.setTer(1, 1, 0, 't_wall');
  expect(valid()).toBe(false);
  valid = snapshot();
  map.setFurn(1, 1, 0, 'f_table');
  expect(valid()).toBe(false);
  valid = snapshot();
  const roof = map.chunk(0, 0, 3)!;
  expect(valid()).toBe(false); // previously missing roof column loads
  valid = snapshot();
  map.setTer(1, 1, 3, 't_floor');
  expect(valid()).toBe(false);
  valid = snapshot();
  map.evictChunk(roof);
  expect(valid()).toBe(false);
  map.putChunk(roof);
  valid = snapshot();
  const replacement = new Chunk(0, 0, 3);
  replacement.version = roof.version;
  map.putChunk(replacement);
  expect(valid()).toBe(false); // equal version, distinct identity
  valid = snapshot();
  map.evictChunk(floor);
  expect(valid()).toBe(false);
  valid = snapshot();
  map.chunk(1, 0, 0); // unrelated column does not invalidate
  expect(valid()).toBe(true);
});
