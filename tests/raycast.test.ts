import { describe, expect, it } from 'vitest';
import type { FurnitureDef, TerrainDef } from '../src/data/types';
import { dirFromYawPitch, raycastTiles, type RayMap } from '../src/game/raycast';
import { LEVEL_HEIGHT } from '../src/world/coords';
import { NULL_FURN, NULL_TER } from '../src/world/registry';

const ter = (id: string, move_cost: number, flags: string[] = []): TerrainDef =>
  ({ id, name: id, symbol: '.', color: 'c_white', move_cost, flags }) as TerrainDef;
const FLOOR = ter('t_floor', 2, ['TRANSPARENT', 'INDOORS']);
const GRASS = ter('t_grass', 2, ['TRANSPARENT']);
const WALL = ter('t_wall', 0, ['WALL']);
const FENCE = ter('t_chainfence', 0, ['TRANSPARENT', 'THIN_OBSTACLE']);
const ROOF = ter('t_flat_roof', 2, ['TRANSPARENT']);
const AIR = ter('t_open_air', 2, ['TRANSPARENT', 'NO_FLOOR']);
const TABLE = { id: 'f_table', name: 'table', symbol: '#', color: 'c_red', move_cost_mod: 2, flags: ['TRANSPARENT', 'FLAT_SURF'] } as FurnitureDef;

/** A tiny sparse world: grass everywhere at z0, open air above, plus overrides. */
function world(over: Record<string, TerrainDef> = {}, furn: Record<string, FurnitureDef> = {}): RayMap {
  return {
    terAt: (x, y, z) => over[`${x},${y},${z}`] ?? (z === 0 ? GRASS : z > 0 ? AIR : NULL_TER),
    furnAt: (x, y, z) => furn[`${x},${y},${z}`] ?? NULL_FURN,
    hasFloor(x, y, z) {
      const t = this.terAt(x, y, z);
      return t.id !== 't_null' && !t.flags.includes('NO_FLOOR');
    },
  };
}

const EYE = 1.6;

describe('raycastTiles', () => {
  it('vehicle columns block the ray (creatures in the same tile win ties)', () => {
    const m = world({ '5,2,0': WALL });
    const car = (x: number, y: number) => (x === 5 && y === 5 ? 1.6 : 0);
    const hit = raycastTiles(m, { x: 5.5, y: 8.5, h: EYE - 0.3 }, dirFromYawPitch(0, 0), { vehicleAt: car });
    expect(hit?.kind).toBe('vehicle');
    expect([hit!.x, hit!.y]).toEqual([5, 5]);
    // looking over the roof (eye above 1.6 m, level) reaches the wall behind
    expect(raycastTiles(m, { x: 5.5, y: 8.5, h: EYE + 0.1 }, dirFromYawPitch(0, 0), { vehicleAt: car })?.kind).toBe('terrain');
    const zed = raycastTiles(m, { x: 5.5, y: 8.5, h: EYE - 0.3 }, dirFromYawPitch(0, 0), { vehicleAt: car, creatureAt: (x, y) => (x === 5 && y === 5 ? 'zed' : null) });
    expect(zed?.kind).toBe('creature');
  });

  it('looking north hits the first wall tile', () => {
    const m = world({ '5,2,0': WALL });
    const hit = raycastTiles(m, { x: 5.5, y: 8.5, h: EYE }, dirFromYawPitch(0, 0));
    expect(hit?.kind).toBe('terrain');
    expect([hit!.x, hit!.y, hit!.z]).toEqual([5, 2, 0]);
    expect(hit!.dist).toBeCloseTo(5.5);
    expect(hit!.terrain.id).toBe('t_wall');
  });

  it('looking down hits the floor of the current level a few tiles ahead', () => {
    const m = world();
    const pitch = -Math.atan(EYE / 3); // floor 3 m ahead
    const hit = raycastTiles(m, { x: 0.5, y: 0.5, h: EYE }, dirFromYawPitch(Math.PI / 2, pitch)); // east
    expect(hit?.kind).toBe('floor');
    expect(hit!.x).toBe(3);
    expect(hit!.y).toBe(0);
    expect(hit!.point.h).toBeCloseTo(0);
  });

  it('a 1 m fence is hit when looking down at it and looked over when looking up', () => {
    const m = world({ '0,-3,0': FENCE });
    const down = raycastTiles(m, { x: 0.5, y: 0.5, h: EYE }, dirFromYawPitch(0, -0.2));
    expect(down?.kind).toBe('terrain');
    expect(down!.y).toBe(-3);
    const up = raycastTiles(m, { x: 0.5, y: 0.5, h: EYE }, dirFromYawPitch(0, 0.05), { maxDist: 20 });
    expect(up).toBeNull();
    // throughTransparent ignores see-through obstacles (for sight lines)
    const through = raycastTiles(m, { x: 0.5, y: 0.5, h: EYE }, dirFromYawPitch(0, -0.2), { throughTransparent: true });
    expect(through?.kind).toBe('floor');
  });

  it('furniture is a low box: tables are hit when looking down onto them', () => {
    const m = world({}, { '2,0,0': TABLE });
    const hit = raycastTiles(m, { x: 0.5, y: 0.5, h: EYE }, dirFromYawPitch(Math.PI / 2, -0.35));
    expect(hit?.kind).toBe('furniture');
    expect(hit!.x).toBe(2);
    expect(hit!.point.h).toBeLessThanOrEqual(0.8 + 1e-9);
    expect(hit!.furniture.id).toBe('f_table');
  });

  it('creatures are found through the callback and win ties over the tile behind', () => {
    const m = world({ '0,-5,0': WALL });
    const zombie = { name: 'zombie' };
    const hit = raycastTiles(m, { x: 0.5, y: 0.5, h: EYE }, dirFromYawPitch(0, 0), {
      creatureAt: (x, y, z) => (x === 0 && y === -3 && z === 0 ? zombie : null),
    });
    expect(hit?.kind).toBe('creature');
    expect(hit!.creature).toBe(zombie);
    expect(hit!.y).toBe(-3);
  });

  it('indoors, looking up hits the ceiling (the floor of the level above)', () => {
    const m = world({ '0,0,1': ROOF, '0,-1,1': ROOF });
    const hit = raycastTiles(m, { x: 0.5, y: 0.5, h: EYE }, dirFromYawPitch(0, 1.2));
    expect(hit?.kind).toBe('ceiling');
    expect(hit!.z).toBe(1);
    expect(hit!.point.h).toBeCloseTo(LEVEL_HEIGHT);
  });

  it('the origin cell is skipped by default (standing in a doorway)', () => {
    const m = world({ '0,0,0': WALL, '0,-2,0': WALL });
    expect(raycastTiles(m, { x: 0.5, y: 0.5, h: EYE }, dirFromYawPitch(0, 0))!.y).toBe(-2);
    expect(raycastTiles(m, { x: 0.5, y: 0.5, h: EYE }, dirFromYawPitch(0, 0), { skipOrigin: false })!.y).toBe(0);
  });

  it('works for negative coordinates and diagonal rays', () => {
    const m = world({ '-4,-4,0': WALL });
    const hit = raycastTiles(m, { x: -0.5, y: -0.5, h: EYE }, { x: -1, y: -1, h: 0 });
    expect(hit?.kind).toBe('terrain');
    expect([hit!.x, hit!.y]).toEqual([-4, -4]);
  });

  it('standing over a climbable counter, looking down into it picks that counter, not the next one', () => {
    const COUNTER = { id: 'f_cupboard', name: 'cupboard', symbol: '#', color: 'c_white', move_cost_mod: 1, flags: ['CONTAINER', 'MOUNTABLE', 'FLAT_SURF'] } as FurnitureDef;
    const m = world({}, { '5,5,0': COUNTER, '6,5,0': COUNTER });
    // player's centre 0.3 m into the counter at (5,5), near its east edge, looking north-east and down
    const down = raycastTiles(m, { x: 5.8, y: 5.7, h: EYE }, dirFromYawPitch(Math.PI / 5, -1.2));
    expect(down?.kind).toBe('furniture');
    expect([down!.x, down!.y]).toEqual([5, 5]);
    // looking level over it still reaches past (the origin is not a wall)
    expect(raycastTiles(m, { x: 5.8, y: 5.7, h: EYE }, dirFromYawPitch(Math.PI / 2, 0), { maxDist: 5 })).toBeNull();
    // other passable furniture in the origin cell (flowers, rugs) is still skipped
    const FLOWER = { id: 'f_dandelion', name: 'dandelion', symbol: '"', color: 'c_yellow', move_cost_mod: 0, flags: ['TRANSPARENT'] } as FurnitureDef;
    const m2 = world({}, { '5,5,0': FLOWER });
    expect(raycastTiles(m2, { x: 5.5, y: 5.5, h: EYE }, dirFromYawPitch(0, -1.3))?.kind).toBe('floor');
  });

  it('returns null past maxDist and rejects a zero direction', () => {
    const m = world({ '0,-50,0': WALL });
    expect(raycastTiles(m, { x: 0.5, y: 0.5, h: EYE }, dirFromYawPitch(0, 0), { maxDist: 10 })).toBeNull();
    expect(() => raycastTiles(m, { x: 0, y: 0, h: 0 }, { x: 0, y: 0, h: 0 })).toThrow();
  });
});
