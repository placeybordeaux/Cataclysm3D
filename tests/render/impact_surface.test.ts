import { GameMap } from '../../src/world/map';
import { describe, expect, it } from 'vitest';
import { impactSurface } from '../../src/render/impactSurface';
import type { LoadedRayMap } from '../../src/render/impactSurface';
import type { TerrainDef } from '../../src/data/types';
import { NULL_FURN } from '../../src/world/registry';
import { LEVEL_HEIGHT } from '../../src/world/coords';

const floor = { id: 't_floor', move_cost: 2, flags: ['TRANSPARENT'] } as TerrainDef;
const wall = { id: 't_wall', move_cost: 0, flags: ['WALL'] } as TerrainDef;
const air = { id: 't_open_air', move_cost: 2, flags: ['NO_FLOOR', 'TRANSPARENT'] } as TerrainDef;
const world = (walls: (x: number, y: number) => boolean, roof = false): LoadedRayMap => ({
  hasChunk: () => true,
  terAt: (x,y,z) => z === 0 ? walls(x,y) ? wall : floor : roof && z === 1 ? floor : air,
  furnAt: () => NULL_FURN,
  hasFloor: (_x,_y,z) => z === 0 || roof && z === 1,
});
const from = { x: .5, y: .5, h: 1.6 };

describe('verified cosmetic impact surfaces', () => {
  it('aligns marks to east/west/north/south faces and offsets outside the solid', () => {
    const east = impactSurface(world(x => x === 3), from, { x: 3, y: .5, h: 1.6 })!;
    expect(east.normal).toEqual([-1,0,0]); expect(east.x).toBeCloseTo(2.992);
    const west = impactSurface(world(x => x === -3), from, { x: -2, y: .5, h: 1.6 })!;
    expect(west.normal).toEqual([1,0,0]); expect(west.x).toBeCloseTo(-1.992);
    const south = impactSurface(world((_x,y) => y === 3), from, { x: .5, y: 3, h: 1.6 })!;
    expect(south.normal).toEqual([0,-1,0]);
    const north = impactSurface(world((_x,y) => y === -3), from, { x: .5, y: -2, h: 1.6 })!;
    expect(north.normal).toEqual([0,1,0]);
  });
  it('uses floor/ceiling normals in up coordinates, including upper levels', () => {
    const ground = impactSurface(world(() => false), from, { x: .5, y: .5, h: 0 })!;
    expect(ground.normal).toEqual([0,0,1]); expect(ground.h).toBeCloseTo(.008);
    const roof = impactSurface(world(() => false,true), from, { x: .5, y: .5, h: LEVEL_HEIGHT })!;
    expect(roof.normal).toEqual([0,0,-1]); expect(roof.h).toBeCloseTo(LEVEL_HEIGHT-.008);
  });
  it('rejects unresolved air, a different wall earlier on the path and zero length', () => {
    expect(impactSurface(world(() => false),from,{x:3,y:.5,h:1.6})).toBeNull();
    expect(impactSurface(world(x=>x===3),from,{x:7,y:.5,h:1.6})).toBeNull();
    expect(impactSurface(world(()=>false),from,from)).toBeNull();
  });
});

it('never generates or loads chunks while looking for a cosmetic mark', () => {
  const map = new GameMap(1);
  const id = map.terrain.add(floor);
  let generated = 0;
  map.generator = { generate: (_map,c) => { generated++; c.ter.fill(id); } };
  map.chunk(0,0,0);
  const before = [...map.loadedChunks()].length;
  expect(impactSurface(map,{x:.5,y:.5,h:1.6},{x:60,y:.5,h:1.6})).toBeNull();
  expect(generated).toBe(1);
  expect([...map.loadedChunks()]).toHaveLength(before);
});

it('accepts only a small verified floor extension for cosmetic height approximation', () => {
  const map = world(() => false);
  const hit = impactSurface(map,from,{x:.5,y:.5,h:.2});
  expect(hit?.normal).toEqual([0,0,1]);
  expect(impactSurface(map,from,{x:.5,y:.5,h:.6})).toBeNull();
});
