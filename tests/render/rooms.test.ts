import { describe, expect, it } from 'vitest';
import { RoomMap, RoomCache, roomKind, type TileClass } from '../../src/render/rooms';
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

  it('follows a large loaded warehouse beyond either initial margin to one shared anchor and finish', () => {
    const rows = ['#'.repeat(82), ...Array.from({ length: 40 }, () => '#' + '.'.repeat(80) + '#'), '#'.repeat(82)];
    const q = { ...plan(rows, { '1,1': 'f_warehouse_shelf' }), available: (x: number, y: number) => x >= 0 && y >= 0 && x < 82 && y < 42 };
    const west = new RoomMap(q, -14, -14, 38, 38, 0).room(2, 2)!;
    const east = new RoomMap(q, 34, -14, 86, 38, 0).room(70, 2)!;
    expect(west.tiles).toBe(3200);
    expect(east.seed).toBe(west.seed);
    expect(east.kind).toBe('shop');
    expect([east.ax, east.ay, east.x1, east.y1]).toEqual([1, 1, 80, 40]);
  });
  it.each([40000, -40000])('keeps world coordinates intact outside packed-key range (%i)', offset => {
    const base = plan(['#####', '#...#', '#####']);
    const q = { cls: (x: number, y: number) => base.cls(x - offset, y - offset), covered: (x: number, y: number) => base.covered(x - offset, y - offset), furn: () => 'f_null' };
    const m = new RoomMap(q, offset, offset, offset + 5, offset + 3, 0);
    const r = m.room(offset + 1, offset + 1)!;
    expect(r.tiles).toBe(3);
    expect([r.ax, r.ay, r.x1, r.y1]).toEqual([offset + 1, offset + 1, offset + 3, offset + 1]);
    expect(m.has(r, offset + 3, offset + 1)).toBe(true);
  });
  it('does not invent a partial finish when connected tiles are unavailable', () => {
    const rows = ['########', '#......#', '#......#', '########'];
    const q = { ...plan(rows), available: (x: number) => x < 4 };
    expect(new RoomMap(q, 0, 0, 4, 4, 0).room(1, 1)).toBeNull();
  });
  it('bounds an invalid infinite covered region', () => {
    let reads = 0;
    const q = { available: () => true, cls: (): TileClass => { reads++; return 'floor'; }, covered: () => true, furn: () => 'f_null' };
    const m = new RoomMap(q, 0, 0, 24, 24, 0);
    expect(m.room(1, 1)).toBeNull();
    expect(reads).toBeLessThan(50000);
  });
  it('reuses completed rooms and invalidates boundary or roof dependency changes', () => {
    let revision = 0, reads = 0;
    const rows = ['#####', '#...#', '#####'];
    const base = plan(rows);
    const q = { ...base, cls: (x: number, y: number) => { reads++; return base.cls(x, y); },
      dependencyKey: () => 'column', validateSnapshot: () => { const before = revision; return () => revision === before; } };
    const cache = new RoomCache();
    const first = new RoomMap(q, 0, 0, 5, 3, 0, cache).room(1, 1)!;
    const before = reads;
    expect(new RoomMap(q, 0, 0, 5, 3, 0, cache).room(3, 1)).toBe(first);
    expect(reads).toBe(before);
    revision++;
    expect(new RoomMap(q, 0, 0, 5, 3, 0, cache).room(3, 1)).not.toBe(first);
    expect(reads).toBeGreaterThan(before);
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
