// Overlap resolution / escape in src/game/physics.ts (fallfix: a roof-gutter fall left the
// player's circle overlapping a brick wall one level down and every move was refused, freezing
// them — see src/game/zlevels.ts fallIfUnsupported and docs on `resolveOverlap`).
import { describe, expect, it } from 'vitest';
import { CREATURE_RADIUS, moveWithCollision, nudgeOutOfOverlap, overlapsSolid, resolveOverlap } from '../src/game/physics';

const mapWith = (blocked: [number, number][]) =>
  ({ collideShapes: () => false, shapedTile: () => false, passable: (x: number, y: number) => !blocked.some(([bx, by]) => bx === x && by === y) }) as never;

describe('overlapsSolid', () => {
  it('is false in the open and true inside a wall tile', () => {
    const map = mapWith([[6, 5]]);
    expect(overlapsSolid(map, 5.5, 5.5, 0)).toBe(false);
    // 0.05 from the (6,5) wall's west edge, radius 0.3: well inside it.
    expect(overlapsSolid(map, 5.95, 5.5, 0)).toBe(true);
  });
});

describe('resolveOverlap', () => {
  it('leaves a clear position untouched', () => {
    const map = mapWith([]);
    expect(resolveOverlap(map, 5.3, 5.7, 0)).toEqual([5.3, 5.7]);
  });

  it('pushes clear of a single overlapping wall tile (the roof-gutter fallfix case)', () => {
    // The reported bug: landing at x = 1186.98 with a brick wall at tile 1187 on the floor
    // below. Reproduced at smaller coordinates: wall at tile (6, 5), player wedged at x = 5.95.
    const map = mapWith([[6, 5]]);
    expect(overlapsSolid(map, 5.95, 5.5, 0)).toBe(true);
    const [x, y] = resolveOverlap(map, 5.95, 5.5, 0);
    expect(overlapsSolid(map, x, y, 0)).toBe(false);
    expect(x).toBeLessThan(5.95); // pushed away from the wall, not into it
    expect(y).toBe(5.5);
  });

  it('wedged in a corner, pushes clear of both walls', () => {
    const map = mapWith([[4, 5], [5, 4]]); // walls west and north of home tile (5, 5)
    const [x, y] = resolveOverlap(map, 5.1, 5.1, 0);
    expect(overlapsSolid(map, x, y, 0)).toBe(false);
  });

  it('gives up and snaps to the tile centre when no escape exists', () => {
    // A 1x1 room walled on all four sides, with a radius too big for the tile to ever clear
    // (r = 0.6 > half the tile width): pushing off one wall always drives it into the opposite
    // one. The tile itself (5, 5) is passable, so the centre is the only sane fallback.
    const map = mapWith([[4, 5], [6, 5], [5, 4], [5, 6]]);
    const [x, y] = resolveOverlap(map, 5.3, 5.3, 0, 0.6);
    expect(x).toBe(5.5);
    expect(y).toBe(5.5);
  });
});

describe('nudgeOutOfOverlap (passive safety net)', () => {
  it('creeps clear over a few frames instead of teleporting', () => {
    const map = mapWith([[6, 5]]);
    let [x, y] = [5.95, 5.5];
    expect(overlapsSolid(map, x, y, 0)).toBe(true);
    const step1 = nudgeOutOfOverlap(map, x, y, 0, 1 / 30);
    // One frame shouldn't jump the whole way clear (a visible teleport), just move a little.
    expect(step1[0]).toBeLessThan(x);
    expect(step1[0]).toBeGreaterThan(x - 0.2);
    [x, y] = step1;
    for (let i = 0; i < 60 && overlapsSolid(map, x, y, 0); i++) [x, y] = nudgeOutOfOverlap(map, x, y, 0, 1 / 30);
    expect(overlapsSolid(map, x, y, 0)).toBe(false);
  });

  it('is a no-op once clear', () => {
    const map = mapWith([]);
    expect(nudgeOutOfOverlap(map, 5.3, 5.7, 0, 1 / 30)).toEqual([5.3, 5.7]);
  });
});

describe('moveWithCollision: walking out of an overlap', () => {
  it('a move that reduces the overlap is allowed even though the destination is still blocked', () => {
    const map = mapWith([[6, 5]]);
    const start: [number, number] = [5.95, 5.5];
    expect(overlapsSolid(map, ...start, 0)).toBe(true);
    const [x] = moveWithCollision(map, start[0], start[1], 0, -0.1, 0);
    expect(x).toBeLessThan(5.95); // moved, even though still inside the wall's penetration radius
  });

  it('a move that would deepen the overlap is refused', () => {
    const map = mapWith([[6, 5]]);
    const [x] = moveWithCollision(map, 5.95, 5.5, 0, 0.1, 0);
    expect(x).toBe(5.95); // pushing further into the wall doesn't move you
  });

  it('walking consistently away from the wall reaches open ground within a handful of frames', () => {
    const map = mapWith([[6, 5]]);
    let [x, y] = [5.95, 5.5];
    for (let i = 0; i < 10; i++) [x, y] = moveWithCollision(map, x, y, 0, -CREATURE_RADIUS, 0);
    expect(overlapsSolid(map, x, y, 0)).toBe(false);
  });

  it('normal (non-overlapping) collision is unaffected', () => {
    const map = mapWith([[6, 5]]);
    // Walking toward the wall from open ground still stops at its edge as before.
    let [x, y] = [5.0, 5.5];
    for (let i = 0; i < 20; i++) [x, y] = moveWithCollision(map, x, y, 0, 0.05, 0);
    expect(x).toBeLessThan(6 - CREATURE_RADIUS + 0.01);
    expect(overlapsSolid(map, x, y, 0)).toBe(false);
  });
});
