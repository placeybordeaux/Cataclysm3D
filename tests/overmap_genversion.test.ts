import { describe, expect, it } from 'vitest';
import { hashString } from '../src/core/rng';
import { Overmap, REGION } from '../src/world/overmap/overmap';
import { loadNodeData } from '../tools/lib/node_data';

const { wg } = loadNodeData();

/** Hash of every OMT id (and owning special) of a region, z -4..1. */
function regionHash(om: Overmap, rx: number, ry: number): number {
  const parts: string[] = [];
  for (let z = -4; z <= 1; z++)
    for (let y = 0; y < REGION; y++)
      for (let x = 0; x < REGION; x++) {
        const o = om.omtAt(rx * REGION + x, ry * REGION + y, z);
        parts.push(o.special ? `${o.id}@${o.special.def}:${o.special.uid}` : o.id);
      }
  return hashString(parts.join('|'));
}

// Overmaps are regenerated from the seed, never saved: a save made before the transport fixes
// runs genVersion 1 and must keep generating exactly the world it stored chunks of. These hashes
// were taken from the generator before any genVersion 2 change landed.
const GOLDEN: [number, number, number, number][] = [
  // [seed, rx, ry, hash]
  [1, 0, 0, 1912685701], [1, 1, 0, 3926513738], [1, -1, 1, 3314758486],
  [42, 0, 0, 2038333302], [42, 1, 0, 3209110474], [42, -1, 1, 3906381785],
  [743667900, 0, 0, 2035319563], [743667900, 1, 0, 3639482324], [743667900, -1, 1, 2478251053],
];

describe('overmap genVersion 1', () => {
  it('generates exactly what it generated before the transport fixes', () => {
    const out: [number, number, number, number][] = [];
    for (const seed of [1, 42, 743667900]) {
      const om = new Overmap(seed, wg.overmap, 1);
      for (const [rx, ry] of [[0, 0], [1, 0], [-1, 1]]) out.push([seed, rx, ry, regionHash(om, rx, ry)]);
    }
    expect(out).toEqual(GOLDEN);
  }, 120_000);

});

/** FNV-1a over every OMT id (z -3..1) of a region, tagged with the special that owns it. */
function regionHashFnv(om: Overmap, rx: number, ry: number): number {
  let h = 0x811c9dc5;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  };
  for (let z = -3; z <= 1; z++)
    for (let y = 0; y < REGION; y++)
      for (let x = 0; x < REGION; x++) {
        const o = om.omtAt(rx * REGION + x, ry * REGION + y, z);
        mix(o.id + (o.special ? `@${o.special.def}` : '') + ';');
      }
  return h >>> 0;
}

describe('overmap genVersion', () => {
  it('genVersion 1 generates exactly what it did before the transport work', () => {
    const got: Record<string, number> = {};
    for (const seed of [1, 42, 743667900]) {
      const om = new Overmap(seed, wg.overmap, 1);
      for (const [rx, ry] of [[0, 0], [1, 0], [-1, 1]]) got[`${seed}:${rx},${ry}`] = regionHashFnv(om, rx, ry);
    }
    // Recorded from transport-base (f074c22) before any genVersion 2 change. If this fails, a
    // change leaked into genVersion 1 (or regenerated data changed what v1 reads): saved worlds
    // would grow different buildings next to the chunks they already stored.
    expect(got).toEqual({
      '1:0,0': 2076798540, '1:1,0': 4003428536, '1:-1,1': 3503608614,
      '42:0,0': 1351114682, '42:1,0': 2942111390, '42:-1,1': 3737820447,
      '743667900:0,0': 2980860817, '743667900:1,0': 735919757, '743667900:-1,1': 1807069183,
    });
  });
});

describe('overmap genVersion 2', () => {
  it('generates exactly what it generated when genVersion 2 shipped (bn 4217385)', () => {
    // Worlds started on genVersion 2 regenerate their overmap from the seed like any other:
    // later changes must be gated on genVersion >= 3. Hashes over z -7..1 (labs go deep).
    const out: [number, number, number, number][] = [];
    for (const seed of [1, 42, 743667900]) {
      const om = new Overmap(seed, wg.overmap, 2);
      for (const [rx, ry] of [[0, 0], [1, 0], [-1, 1]]) {
        const parts: string[] = [];
        for (let z = -7; z <= 1; z++)
          for (let y = 0; y < REGION; y++)
            for (let x = 0; x < REGION; x++) {
              const o = om.omtAt(rx * REGION + x, ry * REGION + y, z);
              parts.push(o.special ? `${o.id}@${o.special.def}:${o.special.uid}` : o.id);
            }
        out.push([seed, rx, ry, hashString(parts.join('|'))]);
      }
    }
    expect(out).toEqual([
      [1, 0, 0, 2586729168], [1, 1, 0, 3859344790], [1, -1, 1, 3893360640],
      [42, 0, 0, 1555172508], [42, 1, 0, 935029921], [42, -1, 1, 2196657813],
      [743667900, 0, 0, 3680404015], [743667900, 1, 0, 1611241286], [743667900, -1, 1, 1253080853],
    ]);
  }, 120_000);
});
