import { describe, expect, it } from 'vitest';
import { GameMap, type Chunk } from '../src/world/map';
import type { TerrainDef } from '../src/data/types';
import { openMapJournal } from '../src/world/mapJournal';
import { createItem } from '../src/game/item';
import { spawnOnGround } from '../src/game/moves';
import { makeData } from './fixtures/gamedata';

// The style gallery's map undo (src/world/mapJournal.ts, docs/GALLERY.md): scenes edit the
// world (planted trees, fires, loot, corpses) and the next scene must find it as generated.

const data = makeData();

function world() {
  const map = new GameMap(1);
  // the fixture data has no terrain: two stand-in defs are enough for the registry
  const ters = ['t_gallery_a', 't_gallery_b'];
  for (const id of ters) map.terrain.add({ id, move_cost: 2, flags: [] } as unknown as TerrainDef);
  // a generator that writes through the public setters, like mapgen does
  map.generator = { generate: (m: GameMap, c: Chunk) => m.setTer(c.cx * 24, c.cy * 24, c.z, ters[0]) };
  return { map, ters };
}

describe('map journal (gallery scene undo)', () => {
  it('rolls terrain, furniture, items and fields of existing chunks back; generation is not journaled', () => {
    const { map, ters } = world();
    map.chunk(0, 0, 0); // exists before the scene
    const before = map.terAt(3, 3, 0).id;
    const j = openMapJournal(map);
    map.setTer(3, 3, 0, ters[1]);
    map.addField(4, 4, 0, 'fd_fire', 2);
    spawnOnGround(map, 5, 5, 0, createItem(data, Object.keys(data.items)[0]));
    // a chunk generated during the scene: its generation writes must not be snapshotted
    map.chunk(2, 0, 0);
    expect(map.terAt(48, 0, 0).id).toBe(ters[0]);
    expect(j.rollback()).toBe(1);
    expect(map.terAt(3, 3, 0).id).toBe(before);
    expect(map.fieldsAt(4, 4, 0)).toEqual([]);
    expect(map.itemsAt(5, 5, 0)).toEqual([]);
    expect(map.terAt(48, 0, 0).id).toBe(ters[0]);
    // keeps journaling after a rollback; close restores the plain methods
    map.setTer(3, 3, 0, ters[1]);
    expect(j.rollback()).toBe(1);
    j.close();
    map.setTer(3, 3, 0, ters[1]);
    expect(j.rollback()).toBe(0);
    expect(map.terAt(3, 3, 0).id).toBe(ters[1]);
  });
});
