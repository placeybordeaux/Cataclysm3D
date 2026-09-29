import { describe, expect, it } from 'vitest';
import { castOctant, displayIrradiance, LightField, lightFalloff, OCTANTS, OPEN_AIR } from '../../src/render/lightfield';

// Map legend: '#' opaque wall (roofed), '.' open sky, ',' roofed floor, '+' roofed opening
// (window/door: transparent, covered), '@' marks a spot the test refers to (roofed floor).
function field(rows: string[], ox = 0, oy = 0): { f: LightField; at: (ch: string) => [number, number][] } {
  const size = Math.max(rows.length, ...rows.map((r) => r.length));
  const f = new LightField(size);
  f.ox = ox;
  f.oy = oy;
  f.outside.fill(1);
  const marks = new Map<string, [number, number][]>();
  rows.forEach((r, y) =>
    [...r].forEach((ch, x) => {
      const i = y * size + x;
      f.opaque[i] = ch === '#' ? 1 : 0;
      f.outside[i] = ch === '.' ? 1 : 0;
      if (!marks.has(ch)) marks.set(ch, []);
      marks.get(ch)!.push([x + ox, y + oy]);
    }));
  return { f, at: (ch) => marks.get(ch) ?? [] };
}

describe('lightFalloff', () => {
  it('matches CDDA light_calc (lum / (exp(t*d) * d))', () => {
    expect(lightFalloff(100, 0)).toBe(100);
    expect(lightFalloff(100, 4)).toBeCloseTo(100 / (Math.exp(OPEN_AIR * 4) * 4), 6);
    expect(lightFalloff(50, 2)).toBeLessThan(lightFalloff(50, 1));
  });
});

describe('castOctant (shadowcasting)', () => {
  it('lights an open area once per octant and stops at walls', () => {
    const { f } = field([
      '.........',
      '.........',
      '....#....',
      '.........',
      '.........',
    ]);
    const seen = new Set<string>();
    for (const o of OCTANTS) castOctant(f.blocks, 4, 4, 8, o, (x, y) => seen.add(`${x},${y}`));
    // the wall itself is lit, the tiles straight behind it (seen from (4,4)) are not
    expect(seen.has('4,2')).toBe(true);
    expect(seen.has('4,1')).toBe(false);
    expect(seen.has('4,0')).toBe(false);
    // open tiles off to the side are
    expect(seen.has('1,1')).toBe(true);
    expect(seen.has('7,1')).toBe(true);
  });
});

describe('LightField artificial light', () => {
  const room = [
    '...........',
    '.#########.',
    '.#,,,,,,,#.',
    '.#,,,@,,,#.',
    '.#,,,,,,,#.',
    '.#########.',
    '...........',
  ];

  it('keeps a lamp inside a closed room: nothing leaks through the walls', () => {
    const { f, at } = field(room, 100, 200);
    const [[lx, ly]] = at('@');
    f.computeArtificial([{ x: lx, y: ly, lum: 60, r: 1, g: 1, b: 1 }]);
    expect(f.artificialAt(lx, ly)).toBe(60);
    expect(f.artificialAt(lx + 2, ly)).toBeGreaterThan(5);
    // walls are lit on their inner face
    expect(f.artificialAt(lx, ly - 2)).toBeGreaterThan(0);
    // every outdoor tile stays dark
    for (const [x, y] of at('.')) expect(f.artificialAt(x, y)).toBe(0);
  });

  it('lets light out through an opening, in a cone', () => {
    const rows = room.slice();
    rows[1] = '.####+####.';
    const { f, at } = field(rows);
    const [[lx, ly]] = at('@');
    f.computeArtificial([{ x: lx, y: ly, lum: 60, r: 1, g: 1, b: 1 }]);
    // straight out of the doorway is lit, far round the side of the house is not
    expect(f.artificialAt(lx, 0)).toBeGreaterThan(0);
    expect(f.artificialAt(0, 6)).toBe(0);
    expect(f.artificialAt(10, 6)).toBe(0);
  });

  it('sums overlapping sources and colours by source', () => {
    const { f } = field(['.....', '.....', '.....']);
    f.computeArtificial([
      { x: 0, y: 1, lum: 20, r: 1, g: 0, b: 0 },
      { x: 4, y: 1, lum: 20, r: 0, g: 0, b: 1 },
    ]);
    const i = f.index(2, 1);
    expect(f.art[i * 3]).toBeCloseTo(lightFalloff(20, 2), 5);
    expect(f.art[i * 3 + 2]).toBeCloseTo(lightFalloff(20, 2), 5);
    expect(f.art[i * 3 + 1]).toBe(0);
    // display copy falls off faster (inverse square) than the CDDA value
    expect(f.disp[i * 3]).toBeLessThan(f.art[i * 3]);
  });
});

describe('LightField natural light', () => {
  it('outdoors is full, a sealed room only gets the indoor ambient', () => {
    const { f, at } = field([
      '.......',
      '.#####.',
      '.#,,,#.',
      '.#,@,#.',
      '.#,,,#.',
      '.#####.',
      '.......',
    ]);
    f.computeNatural();
    for (const [x, y] of at('.')) expect(f.naturalAt(x, y)).toBe(1);
    for (const [x, y] of [...at(','), ...at('@')]) expect(f.naturalAt(x, y)).toBeCloseTo(f.indoorAmbient, 6);
  });

  it('daylight enters through a window and fades into the room', () => {
    const { f } = field([
      '.........',
      '.###+###.',
      '.#,,,,,#.',
      '.#,,,,,#.',
      '.#,,,,,#.',
      '.#,,,,,#.',
      '.#,,,,,#.',
      '.#######.',
      '.........',
    ]);
    f.computeNatural();
    const win = f.naturalAt(4, 1), near = f.naturalAt(4, 2), far = f.naturalAt(4, 6), corner = f.naturalAt(2, 6);
    expect(win).toBe(1);
    expect(near).toBeGreaterThan(0.8);
    expect(far).toBeLessThan(near);
    expect(far).toBeGreaterThan(f.indoorAmbient);
    expect(corner).toBeLessThanOrEqual(far);
  });

  it('bounce light reaches round a corner, but not through walls', () => {
    const { f } = field([
      '...........',
      '.###+#####.',
      '.#,,,#,,,#.',
      '.#,,,#,,,#.',
      '.#,,,,,,,#.',
      '.#########.',
      '...........',
    ]);
    f.computeNatural();
    // (7,2): east room, no line of sight to the window; lit only by bounce via the gap at y=4
    const east = f.naturalAt(7, 2);
    expect(east).toBeGreaterThan(f.indoorAmbient);
    expect(east).toBeLessThan(f.naturalAt(3, 2));
  });
});

describe('displayIrradiance', () => {
  it('is 0 in the dark, monotonic and saturating', () => {
    expect(displayIrradiance(0)).toBe(0);
    let prev = 0;
    for (const l of [1, 3.5, 10, 40, 100, 400]) {
      const v = displayIrradiance(l);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
    expect(displayIrradiance(100)).toBeCloseTo(3.2, 5);
    expect(displayIrradiance(400) / displayIrradiance(100)).toBeLessThan(2);
  });
});
