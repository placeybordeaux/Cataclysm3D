import { describe, expect, it } from 'vitest';
import { RoomMap, roomKind, type TileClass } from '../../src/render/rooms';
import { buildingState, paintBlotch, paintCalendar, paintClock, paintGraffiti, paintGrime, paintHandprint, paintPicture, paintPoster, paintRug, paintWallTile } from '../../src/render/dressing';

/** ASCII plan: # wall, + door, . covered floor, , uncovered floor, ' ' open air. */
function plan(rows: string[], furn: Record<string, string> = {}) {
  const at = (x: number, y: number) => rows[y]?.[x] ?? ' ';
  return {
    cls: (x: number, y: number): TileClass => (at(x, y) === '#' ? 'wall' : at(x, y) === '+' ? 'opening' : at(x, y) === '.' || at(x, y) === ',' ? 'floor' : 'other'),
    covered: (x: number, y: number) => at(x, y) === '.',
    furn: (x: number, y: number) => furn[`${x},${y}`] ?? 'f_null',
  };
}

describe('rooms', () => {
  it('splits a house into rooms at walls and doors, and a porch is not a room', () => {
    const q = plan([
      '#######,,',
      '#..#..#,,',
      '#..+..#,,',
      '#######,,',
      '#...+...,', // porch: covered but open to the yard on the right
      '#####...,',
    ], { '1,1': 'f_bed', '5,2': 'f_toilet' });
    const m = new RoomMap(q, -5, -5, 20, 20, 0);
    const a = m.room(1, 1)!, b = m.room(4, 2)!;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a.seed).not.toBe(b.seed);
    expect(m.room(2, 2)).toBe(a);
    expect(a.tiles).toBe(4);
    expect(a.kind).toBe('bedroom');
    expect(b.kind).toBe('bathroom');
    expect(m.room(6, 4)).toBeNull(); // porch
    expect(m.room(7, 0)).toBeNull(); // yard
    // same room from a scan anchored elsewhere (neighbouring chunk) gets the same seed
    const m2 = new RoomMap(q, 0, 0, 30, 30, 0);
    expect(m2.room(2, 1)!.seed).toBe(a.seed);
  });

  it('kinds', () => {
    expect(roomKind(['f_oven', 'f_table'])).toBe('kitchen');
    expect(roomKind(['f_sofa'])).toBe('living');
    expect(roomKind([])).toBe('other');
  });
});

describe('set dressing painters', () => {
  it('paint deterministic images of their size', () => {
    expect(paintPicture(16, 12, 3).data).toEqual(paintPicture(16, 12, 3).data);
    for (const img of [paintPicture(16, 12, 1), paintPoster(15, 20, 2), paintCalendar(10, 14, 1), paintClock(10), paintBlotch(22, 30, 1, 'stain'), paintBlotch(16, 12, 2, 'peel'),
      paintBlotch(20, 24, 3, 'blood'), paintHandprint(1), paintGraffiti(36, 18, 4), paintGrime(1, 2, false), paintGrime(0, 1, true), paintRug(40, 60, 2), paintWallTile([200, 200, 200])])
      expect(img.w * img.h).toBeGreaterThan(0);
    // decals are cut out (some clear texels), rugs are solid
    expect(paintClock(10).data.some((v, i) => i % 4 === 3 && v === 0)).toBe(true);
    expect(paintRug(20, 20, 1).data.every((v, i) => i % 4 !== 3 || v === 255)).toBe(true);
  });

  it('building states cover kept, dirty and wrecked houses', () => {
    const levels = new Set<number>();
    let violent = 0;
    for (let s = 0; s < 400; s++) {
      const st = buildingState(s * 7919);
      levels.add(st.level);
      if (st.violent) violent++;
    }
    expect([...levels].sort()).toEqual([0, 1, 2]);
    expect(violent).toBeGreaterThan(10);
    expect(violent).toBeLessThan(120);
  });
});
