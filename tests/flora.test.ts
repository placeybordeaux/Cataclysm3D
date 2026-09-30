import { describe, expect, it } from 'vitest';
import { layoutOf, speciesOf, wantsFlora3d, flora, setFlora } from '../src/render/flora';
import { paintBark, paintFringe, paintLeaves, paintNeedles } from '../src/render/floraArt';

describe('flora species', () => {
  it('maps terrain ids to families', () => {
    expect(speciesOf('t_tree_pine', false).family).toBe('conifer');
    expect(speciesOf('t_tree_deadpine', false).family).toBe('deadconifer');
    expect(speciesOf('t_tree_dead', false).family).toBe('dead');
    expect(speciesOf('t_tree_birch', false)).toMatchObject({ family: 'birch', bark: 'birch' });
    expect(speciesOf('t_tree_apple', false).family).toBe('fruit');
    expect(speciesOf('t_tree_maple', false).family).toBe('round');
    expect(speciesOf('t_tree_young', true).family).toBe('sapling');
    expect(speciesOf('t_shrub_rose', true).family).toBe('bush');
    expect(speciesOf('t_underbrush', true).family).toBe('underbrush');
  });

  it('seasonal dots: blossom in spring, fruit later, none when harvested or in winter', () => {
    const apple = speciesOf('t_tree_apple', false);
    expect(apple.dots?.('spring')?.cols[0]).toEqual([246, 242, 236]);
    expect(apple.dots?.('autumn')?.cols[0]).toEqual([196, 36, 30]);
    expect(apple.dots?.('winter')).toBeUndefined();
    expect(speciesOf('t_tree_apple_harvested', false).dots?.('autumn')).toBeUndefined();
    expect(speciesOf('t_tree_cherry', false).dots?.('spring')?.cols[0]).toEqual([240, 178, 200]);
    expect(speciesOf('t_shrub_rose', true).dots?.('summer')?.n).toBeGreaterThan(0);
    expect(speciesOf('t_shrub_rose_harvested', true).dots).toBeUndefined();
  });
});

describe('flora layouts', () => {
  it('are deterministic per (family, variant) so near, middle and far builds agree', () => {
    expect(layoutOf('round', 1, false)).toBe(layoutOf('round', 1, false));
    expect(JSON.stringify(layoutOf('round', 0, false))).not.toBe(JSON.stringify(layoutOf('round', 2, false)));
  });

  it('families have their own silhouettes', () => {
    const round = layoutOf('round', 0, false), conifer = layoutOf('conifer', 0, false), birch = layoutOf('birch', 0, false);
    expect(round.lumps.length).toBeGreaterThanOrEqual(8);
    expect(conifer.cones.length).toBe(5);
    expect(conifer.lumps.length).toBe(0);
    // conifer tiers narrow toward the top
    for (let i = 1; i < conifer.cones.length; i++) expect(conifer.cones[i].r).toBeLessThan(conifer.cones[i - 1].r);
    // birch: taller, narrower crown than a round tree
    const w = (L: typeof round) => Math.max(...L.lumps.map((l) => Math.hypot(l.c[0], l.c[2]) + l.r[0]));
    expect(w(birch)).toBeLessThan(w(round));
    // root flare: the trunk is widest at the foot
    expect(round.trunk!.radii[0]).toBeGreaterThan(round.trunk!.radii[2]);
  });

  it('bare crowns trade leaf lumps for limbs and twigs', () => {
    const bare = layoutOf('round', 0, true);
    expect(bare.lumps.length).toBe(0);
    expect(bare.twigs.length).toBeGreaterThan(4);
    expect(bare.limbs.length).toBeGreaterThan(layoutOf('round', 0, false).limbs.length);
  });
});

describe('flora art', () => {
  const ramp = [[20, 30, 15], [50, 80, 30], [80, 110, 45], [120, 150, 60]] as [number, number, number][] as never;
  it('paints opaque tiling leaves/needles/bark at 32 texels and a cutout fringe', () => {
    for (const img of [paintLeaves(ramp, 1), paintNeedles(ramp, 1), paintBark('birch', [200, 200, 200], 1), paintBark('furrow', [80, 60, 40], 1)]) {
      expect(img.w).toBe(32);
      for (let i = 3; i < img.data.length; i += 4) expect(img.data[i]).toBe(255);
    }
    const f = paintFringe(ramp, 1);
    let clear = 0;
    for (let i = 3; i < f.data.length; i += 4) if (f.data[i] === 0) clear++;
    expect(clear).toBeGreaterThan(100);
    expect(f.data[(16 * 32 + 16) * 4 + 3]).toBe(255);
  });

  it('flowers are deliberate dots in the flower colour', () => {
    const img = paintLeaves(ramp, 3, { cols: [[206, 30, 52]], n: 20, size: 2 });
    let hits = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 206 && img.data[i + 1] === 30) hits++;
    expect(hits).toBeGreaterThan(20);
  });
});

describe('flora switch', () => {
  it('models: every distance in 3D; clumps: near only, bare trees stay billboards', () => {
    setFlora('models');
    expect(wantsFlora3d(true, false, true)).toBe(true);
    expect(wantsFlora3d(false, true, false)).toBe(false);
    setFlora('clumps');
    expect(wantsFlora3d(true, false, false)).toBe(false);
    expect(wantsFlora3d(true, true, true)).toBe(false);
    expect(wantsFlora3d(true, true, false)).toBe(true);
    setFlora('models');
    expect(flora.name).toBe('models');
    expect(() => setFlora('ferns' as never)).toThrow(/unknown flora/);
  });
});
