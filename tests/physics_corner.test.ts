// Corner rounding in moveWithCollision (wave-3 playtest: stuck walking west past a lone tree).
import { describe, expect, it } from 'vitest';
import { moveWithCollision } from '../src/game/physics';

const mapWith = (blocked: [number, number][]) =>
  ({
    passable: (x: number, y: number) => !blocked.some(([bx, by]) => bx === x && by === y),
    // No vehicles here: the sub-tile vehicle-body hooks physics.ts consults never block.
    collideShapes: () => false,
    shapedTile: () => false,
  }) as never;

/** Walk `frames` steps of (dx, dy) from (x, y). */
function walk(map: never, x: number, y: number, dx: number, dy: number, frames: number): [number, number] {
  for (let i = 0; i < frames; i++) [x, y] = moveWithCollision(map, x, y, 0, dx, dy);
  return [x, y];
}

describe('moveWithCollision corner rounding', () => {
  it('walking straight west past a tree corner slides around it instead of stopping', () => {
    // tree at tile (10, 9); walker 0.21 into row 10, heading west from x = 12.5
    const map = mapWith([[10, 9]]);
    const [x, y] = walk(map, 12.5, 10.21, -0.05, 0, 80);
    expect(x).toBeLessThan(9);
    expect(y).toBeGreaterThan(10.21);
    expect(y).toBeLessThan(10.6);
  });

  it('also when heading almost (not exactly) west, as a mouse-aimed player does', () => {
    const map = mapWith([[10, 9]]);
    const [x] = walk(map, 12.5, 10.21, -0.05, -0.0005, 80);
    expect(x).toBeLessThan(9);
  });

  it('a wall still stops you (no nudge through a row of blocked tiles)', () => {
    const map = mapWith([[10, 8], [10, 9], [10, 10], [10, 11], [10, 12]]);
    const [x] = walk(map, 12.5, 10.21, -0.05, 0, 80);
    expect(x).toBeGreaterThan(11.29);
    expect(x).toBeLessThan(11.36);
  });

  it('open ground is unchanged', () => {
    const [x, y] = walk(mapWith([]), 5, 5, 0.05, 0, 20);
    expect(x).toBeCloseTo(6, 5);
    expect(y).toBe(5);
  });
});
