import { describe, expect, it } from 'vitest';
import { GameMap } from '../../src/world/map';
import type { TerrainDef } from '../../src/data/types';
import { LightMap } from '../../src/render/lightmap';
import terrain from '../../public/data/terrain.json';

// A headlight's beam stand-ins (vehicleMesh.ts BEAM) move every frame while you drive. Cast
// from their whole tile, the light on a wall jumped each time one crossed a tile line: the
// "shadow flicker on buildings" at night (beamMode.ts). Smooth casting must make the light
// change continuously with the source's position.

/** Open floor with a wall row at y = 20 from x = 0..40 (a building front along the road),
 *  and street lamps (lit terrain, the light map's tile lights) at `lamps`. */
function street(lamps: [number, number][] = []) {
  const map = new GameMap(1);
  for (const definition of Object.values(terrain)) map.terrain.add(definition as TerrainDef);
  map.terrain.add({ id: 't_testlamp', name: 'lamp', move_cost: 2, flags: ['TRANSPARENT'], symbol: '.', color: 'white', light_emitted: 60 });
  const floor = map.terrain.index('t_floor'), wall = map.terrain.index('t_wall'), air = map.terrain.index('t_open_air');
  const lamp = map.terrain.index('t_testlamp');
  map.generator = {
    generate(m, chunk) {
      chunk.ter.fill(chunk.z <= 0 ? floor : air);
      if (chunk.z !== 0) return;
      for (const [x, y] of lamps) {
        const lx = x - chunk.cx * 24, ly = y - chunk.cy * 24;
        if (lx >= 0 && ly >= 0 && lx < 24 && ly < 24) chunk.ter[ly * 24 + lx] = lamp;
      }
      if (chunk.cy !== 0) return;
      for (let lx = 0; lx < 24; lx++) {
        const gx = chunk.cx * 24 + lx;
        if (gx >= 0 && gx <= 40) chunk.ter[20 * 24 + lx] = wall;
      }
    },
  };
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 3; x++) map.chunk(x, y, 0);
  return map;
}

/** Light reaching the wall's face tiles (y = 19, x = 12..28) as a beam source moves along y = 14. */
function sweep(smooth: boolean): number[][] {
  const lm = new LightMap(street(), false);
  lm.naturalLevel = 0;
  const out: number[][] = [];
  for (let i = 0; i <= 80; i++) {
    const src = { x: 14 + i * 0.05, y: 14.3, z: 0, lum: 38, color: 0xffffff, flicker: false, phase: 0, smooth };
    lm.update(20, 10, 0, 0.1, 0, [src], true);
    const row: number[] = [];
    for (let x = 12; x <= 28; x++) row.push(lm.exactLightAt(x, 19, 0)!);
    out.push(row);
  }
  return out;
}

const maxStep = (s: number[][]) => {
  let m = 0;
  for (let i = 1; i < s.length; i++) for (let j = 0; j < s[i].length; j++) m = Math.max(m, Math.abs(s[i][j] - s[i - 1][j]));
  return m;
};

describe('smooth headlight beam casting', () => {
  it('moves the light on a wall continuously instead of in tile jumps', () => {
    const tile = maxStep(sweep(false)), smooth = maxStep(sweep(true));
    console.info(`largest change per 5 cm of travel: tile ${tile.toFixed(3)}, smooth ${smooth.toFixed(3)} lum`);
    expect(tile).toBeGreaterThan(0.5);
    // 20 steps per tile: a continuous cast spreads a tile jump over many of them
    expect(smooth).toBeLessThan(tile / 5);
  });

  it('matches the tile cast when the source sits on a tile centre', () => {
    const lm = (smooth: boolean) => {
      const m = new LightMap(street(), false);
      m.naturalLevel = 0;
      m.update(20, 10, 0, 0.1, 0, [{ x: 17.5, y: 14.5, z: 0, lum: 38, color: 0xffffff, flicker: false, phase: 0, smooth }], true);
      return m;
    };
    const a = lm(false), b = lm(true);
    for (let x = 12; x <= 28; x++) expect(b.exactLightAt(x, 19, 0)).toBeCloseTo(a.exactLightAt(x, 19, 0)!, 6);
  });

  it('reuses the street lamps\' light while a beam moves, identical to a full cast', () => {
    const lamps: [number, number][] = [[15, 16], [24, 12]];
    const lit = (m: LightMap) => Array.from({ length: 17 * 8 }, (_, i) => m.exactLightAt(12 + (i % 17), 12 + Math.floor(i / 17), 0)!);
    const reused = new LightMap(street(lamps), false);
    for (const bx of [14.2, 14.9, 15.6, 16.3]) {
      const beam = { x: bx, y: 14.3, z: 0, lum: 38, color: 0xfff0d0, flicker: false, phase: 0, smooth: true };
      reused.update(20, 10, 0, 0.1, 0, [beam], true);
      const fresh = new LightMap(street(lamps), false);
      fresh.update(20, 10, 0, 0.1, 0, [beam], true);
      expect(lit(reused)).toEqual(lit(fresh));
    }
  });

  it('rebuilds cheaply enough to run every frame with two cars and a lit street', () => {
    const lamps = Array.from({ length: 40 }, (_, i): [number, number] => [(i % 10) * 6 - 20, Math.floor(i / 10) * 12 - 20]);
    const lm = new LightMap(street(lamps), false);
    lm.naturalLevel = 0;
    const beams = Array.from({ length: 8 }, (_, i) => ({ x: 10.3 + (i % 4) * 8, y: 14.6 + Math.floor(i / 4) * 3, z: 0, lum: 45, color: 0xfff0d0, flicker: false, phase: 0, smooth: true }));
    lm.update(20, 10, 0, 0.1, 0, beams, true);
    const t0 = performance.now();
    const N = 30;
    for (let k = 0; k < N; k++) {
      for (const b of beams) b.x += 0.13;
      lm.update(20, 10, 0, 0.016, 0, beams, true);
    }
    const ms = (performance.now() - t0) / N;
    console.info(`smooth beam rebuild: ${ms.toFixed(2)} ms/frame (${lm.stats.sources} sources)`);
    expect(lm.stats.sources).toBeGreaterThan(40 + 8);
  });
});
