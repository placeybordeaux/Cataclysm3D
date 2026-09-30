// Walking route to a map destination (src/ui/route.ts).
import { describe, expect, it } from 'vitest';
import { omtCost, planOmtRoute } from '../src/ui/route';

/** A tiny overmap from rows of chars: r road, f forest, F thick forest, ~ river, . field, h house. */
function world(rows: string[]) {
  const T: Record<string, string> = { r: 'road', f: 'forest', F: 'forest_thick', '~': 'river_center', '.': 'field', h: 'house' };
  return (x: number, y: number) => {
    const c = rows[y]?.[x];
    return c === undefined ? Infinity : omtCost(T[c]);
  };
}

describe('overmap route', () => {
  it('goes round by the road rather than through thick forest', () => {
    const cost = world([
      'rrrrrrr',
      'rFFFFFr',
      'hFFFFFh',
    ]);
    const route = planOmtRoute(cost, { x: 0, y: 2 }, { x: 6, y: 2 })!;
    expect(route[0]).toEqual({ x: 0, y: 2 });
    expect(route[route.length - 1]).toEqual({ x: 6, y: 2 });
    expect(route.some((o) => o.y === 0)).toBe(true);
    expect(route.every((o) => !(o.y === 1 && o.x > 0 && o.x < 6))).toBe(true);
  });

  it('never crosses open water, and gives up (null) when there is no way across', () => {
    const cost = world([
      '..~..',
      '..~..',
      '..~..',
    ]);
    expect(planOmtRoute(cost, { x: 0, y: 1 }, { x: 4, y: 1 }, 500)).toBeNull();
    const bridged = world([
      '..~..',
      '..r..',
      '..~..',
    ]);
    const r = planOmtRoute(bridged, { x: 0, y: 1 }, { x: 4, y: 1 })!;
    expect(r.some((o) => o.x === 2 && o.y === 1)).toBe(true);
  });

  it('costs: road cheapest, water impassable, buildings walkable', () => {
    expect(omtCost('road')).toBe(1);
    expect(omtCost('river_center')).toBe(Infinity);
    expect(omtCost('lake_surface')).toBe(Infinity);
    expect(omtCost('house')).toBeLessThan(omtCost('forest'));
    expect(omtCost('forest_thick')).toBeGreaterThan(omtCost('forest'));
  });
});
