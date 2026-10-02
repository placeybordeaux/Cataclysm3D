import { describe, expect, it } from 'vitest';
import { findPath } from '../src/game/pathfind';
import type { Grid } from '../src/game/los';

function grid(blocked = new Set<string>()): Grid {
  return {
    ter: () => ({ id: 'floor', move_cost: 2 }),
    furn: () => ({ id: 'f_null', move_cost_mod: 0 }),
    moveCost: (x: number, y: number) => blocked.has(`${x},${y}`) ? 0 : 2,
  } as unknown as Grid;
}

describe('A* scratch lifetime', () => {
  it('observes map edits and size changes without mutating earlier returned paths', () => {
    const blocked = new Set<string>();
    const g = grid(blocked);
    const original = findPath(g, 0, 0, 6, 0, 0);
    const snapshot = structuredClone(original);
    blocked.add('3,0');
    const detour = findPath(g, 0, 0, 6, 0, 0);
    expect(detour.complete).toBe(true);
    expect(detour.tiles).not.toContainEqual([3, 0]);
    findPath(g, -40, -30, 45, 35, 0, { maxNodes: 300 });
    expect(findPath(g, 0, 0, 6, 0, 0)).toEqual(detour);
    blocked.clear();
    expect(findPath(g, 0, 0, 6, 0, 0)).toEqual(snapshot);
    expect(original).toEqual(snapshot);
  });

  it('isolates nested searches from grid callbacks', () => {
    const g = grid();
    const expected = findPath(g, 0, 0, 8, 4, 0);
    const nestedExpected = findPath(g, -12, 8, 15, -3, 0);
    const getTerrain = g.ter.bind(g);
    let nested = false;
    g.ter = (x, y, z) => {
      if (!nested) {
        nested = true;
        expect(findPath(grid(), -12, 8, 15, -3, 0)).toEqual(nestedExpected);
      }
      return getTerrain(x, y, z);
    };
    expect(findPath(g, 0, 0, 8, 4, 0)).toEqual(expected);
    expect(nested).toBe(true);
  });

  it('releases the shared workspace after a grid callback throws', () => {
    const g = grid();
    const expected = findPath(g, 0, 0, 8, 4, 0);
    g.ter = () => { throw new Error('grid failure'); };
    expect(() => findPath(g, 0, 0, 8, 4, 0)).toThrow('grid failure');
    expect(findPath(grid(), 0, 0, 8, 4, 0)).toEqual(expected);
  });

  it('handles exceptional searches beyond the retained capacity', () => {
    expect(findPath(grid(), 0, 0, 600, 600, 0, { maxNodes: 2 }).expanded).toBe(2);
    expect(findPath(grid(), 0, 0, 2, 0, 0).tiles).toEqual([[1, 0], [2, 0]]);
  });
});
