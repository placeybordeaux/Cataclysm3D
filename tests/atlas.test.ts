import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AtlasIndex } from '../src/render/atlasTypes';
import { AtlasLookup, CONN, cddaColor, glyphIndex, mixSeed, pickVariant, pointSeed, rotationAndSubtile } from '../src/render/atlasIndex';

const index = JSON.parse(readFileSync('public/atlas/atlas.json', 'utf8')) as AtlasIndex;
const atlas = new AtlasLookup(index);
const frame = (i: number) => index.frames[i];

describe('atlas.json', () => {
  it('has sane pages and frames', () => {
    expect(index.tileSize).toBe(32);
    for (const p of index.pages) {
      expect(Math.log2(p.w) % 1).toBe(0);
      expect(Math.log2(p.h) % 1).toBe(0);
    }
    for (const f of index.frames) {
      const p = index.pages[f.page];
      expect(f.x - index.padding).toBeGreaterThanOrEqual(0);
      expect(f.y - index.padding).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w + index.padding).toBeLessThanOrEqual(p.w);
      expect(f.y + f.h + index.padding).toBeLessThanOrEqual(p.h);
    }
  });

  it('t_wall is a multitile with center/edge/corner/t_connection', () => {
    const t = index.tiles.t_wall;
    expect(t.rotates).toBe(true);
    for (const k of ['center', 'edge', 'corner', 't_connection', 'end_piece', 'unconnected'] as const) expect(t.multitile?.[k]?.fg).toBeTruthy();
    expect(t.multitile!.corner!.fg![0].sprites).toHaveLength(4);
    expect(t.multitile!.edge!.fg![0].sprites).toHaveLength(2);
  });

  it('mon_zombie resolves to a 32x48 human_body_plus frame with a shadow bg', () => {
    const r = atlas.lookup('mon_zombie', { variantSeed: 7 })!;
    const f = frame(r.fg!.frame);
    expect([f.w, f.h, f.ox, f.oy]).toEqual([32, 48, 0, -16]);
    expect(r.bg).toBeTruthy();
  });

  it('items have sprites', () => {
    for (const id of ['2x4', 'hammer']) {
      const r = atlas.lookup(id);
      expect(r?.fg, id).toBeTruthy();
    }
    // small (20x20) items sit centered-ish via their sheet offset
    const h = frame(atlas.lookup('hammer')!.fg!.frame);
    expect(h.w).toBeLessThanOrEqual(32);
  });
});

describe('variant selection', () => {
  it('is deterministic by seed and follows weights', () => {
    const a = atlas.lookup('mon_zombie', { variantSeed: 12345 });
    const b = atlas.lookup('mon_zombie', { variantSeed: 12345 });
    expect(a).toEqual(b);
    const seen = new Set<number>();
    for (let s = 0; s < 200; s++) seen.add(atlas.lookup('t_grass', { variantSeed: pointSeed(s, s * 3) })!.fg!.frame);
    expect(seen.size).toBe(index.tiles.t_grass.fg!.length);
  });

  it('pickVariant matches CDDA weighted_int_list', () => {
    const list = [
      { weight: 3, sprites: [0] },
      { weight: 1, sprites: [1] },
      { weight: 5, sprites: [2] },
    ];
    // (randi % 9) + 1 → cumulative [3,4,9]
    expect([0, 2, 3, 4, 8, 9].map((r) => pickVariant(list, r)!.sprites[0])).toEqual([0, 0, 1, 2, 2, 0]);
  });

  it('mixSeed is the lookup3 final mix (unsigned)', () => {
    expect(mixSeed(0)).toBe(0);
    const v = mixSeed(pointSeed(10, 20));
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(2 ** 32);
    expect(mixSeed(pointSeed(10, 20))).toBe(v);
  });
});

describe('multitile connections (cata_tiles get_rotation_and_subtile)', () => {
  const { N, E, S, W } = CONN;
  it('maps neighbour masks to subtiles and rotations', () => {
    expect(rotationAndSubtile(0)).toEqual({ subtile: 'unconnected', rotation: 0 });
    expect(rotationAndSubtile(N | E | S | W)).toEqual({ subtile: 'center', rotation: 0 });
    expect(rotationAndSubtile(N | S)).toEqual({ subtile: 'edge', rotation: 0 });
    expect(rotationAndSubtile(E | W)).toEqual({ subtile: 'edge', rotation: 1 });
    // corners: CDDA order [nw, ne, se, sw] sprites → rotation picks the drawn corner
    expect(rotationAndSubtile(S | E)).toEqual({ subtile: 'corner', rotation: 0 });
    expect(rotationAndSubtile(S | W)).toEqual({ subtile: 'corner', rotation: 1 });
    expect(rotationAndSubtile(N | W)).toEqual({ subtile: 'corner', rotation: 2 });
    expect(rotationAndSubtile(N | E)).toEqual({ subtile: 'corner', rotation: 3 });
    expect(rotationAndSubtile(E | S | W).subtile).toBe('t_connection');
    expect(rotationAndSubtile(E | S | W).rotation).toBe(0);
    expect(rotationAndSubtile(N)).toEqual({ subtile: 'end_piece', rotation: 2 });
    expect(rotationAndSubtile(S)).toEqual({ subtile: 'end_piece', rotation: 0 });
  });

  it('t_wall picks the right pre-drawn sprite', () => {
    const w = index.tiles.t_wall.multitile!;
    const edgeNS = atlas.lookup('t_wall', { connections: N | S })!;
    expect(edgeNS.subtile).toBe('edge');
    expect(edgeNS.fg!.frame).toBe(w.edge!.fg![0].sprites[0]);
    const edgeEW = atlas.lookup('t_wall', { connections: E | W })!;
    expect(edgeEW.fg!.frame).toBe(w.edge!.fg![0].sprites[1]);
    expect(edgeEW.fg!.rotate).toBe(0);
    const corner = atlas.lookup('t_wall', { connections: N | W })!;
    expect(corner.fg!.frame).toBe(w.corner!.fg![0].sprites[2]);
    // no connection info → base tile
    expect(atlas.lookup('t_wall')!.subtile).toBeUndefined();
  });
});

describe('resolution order', () => {
  it('prefers seasonal tiles', () => {
    expect(atlas.lookup('t_grass', { season: 'winter' })!.id).toBe('t_grass_season_winter');
    expect(atlas.lookup('t_grass', { season: 'spring' })!.id).toBe('t_grass');
  });
  it('follows looks_like chains', () => {
    const ll: Record<string, string> = { my_fake_thing: 'my_other_fake', my_other_fake: 'hammer' };
    expect(atlas.lookup('my_fake_thing')).toBeNull();
    expect(atlas.lookupWithLooksLike('my_fake_thing', (id) => ll[id])!.id).toBe('hammer');
    const loop: Record<string, string> = { a_loop: 'b_loop', b_loop: 'a_loop' };
    expect(atlas.lookupWithLooksLike('a_loop', (id) => loop[id])).toBeNull();
  });
  it('rotation only applies to rotating tiles', () => {
    expect(index.tiles.f_chair.rotates).toBe(true);
    const chairE = atlas.lookup('f_chair', { rotation: 1 })!;
    expect(chairE.fg!.frame).toBe(index.tiles.f_chair.fg![0].sprites[1]);
    expect(atlas.lookup('hammer', { rotation: 1 })!.fg!.rotate).toBe(0);
    expect(atlas.lookup('hammer', { rotation: 1, alwaysRotate: true })!.fg!.rotate).toBe(1);
  });
  it('animated tiles advance with time', () => {
    const frames = new Set<number>();
    for (let t = 0; t < 184 * 17; t += 17) frames.add(atlas.lookup('mon_fungal_blossom', { timeMs: t })!.fg!.frame);
    expect(frames.size).toBe(index.tiles.mon_fungal_blossom.fg!.length);
  });
});

describe('ascii fallback helpers', () => {
  it('maps symbols to cp437', () => {
    expect(glyphIndex('Z')).toBe(90);
    expect(glyphIndex('#')).toBe(35);
    expect(glyphIndex('│')).toBe(179);
    expect(glyphIndex('LINE_OXOX')).toBe(196);
    expect(glyphIndex('░')).toBe(176);
    expect(glyphIndex('\u{1F600}')).toBe(63);
  });
  it('parses CDDA colors', () => {
    expect(cddaColor('c_red')).toEqual([255, 0, 0]);
    expect(cddaColor('light_gray')).toEqual([150, 150, 150]);
    expect(cddaColor('c_white_red')).toEqual([255, 255, 255]);
    expect(cddaColor('h_dark_gray')).toEqual([99, 99, 99]);
    expect(() => cddaColor('c_chartreuse')).toThrow();
  });
});
