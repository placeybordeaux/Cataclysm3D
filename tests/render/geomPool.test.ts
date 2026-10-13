import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GeomBuilder, geomPoolStats } from '../../src/render/geometry';
import type { TileFrame } from '../../src/render/textureSource';

// GeomBuilder's growable buffers go back to a pool after build() (src/render/geometry.ts):
// reused arrays hold the previous chunk's data, so a build must only ever see its own.

const frame = { texture: new THREE.Texture(), uv: [0, 0, 1, 1], w: 16, h: 16 } as unknown as TileFrame;

function boxes(n: number, seed: number): THREE.BufferGeometry {
  const b = new GeomBuilder();
  for (let i = 0; i < n; i++) b.box(i + seed, 0, 0, i + seed + 1, 1 + (i % 3), 1, 63, frame, frame, 0);
  return b.build();
}

const dump = (g: THREE.BufferGeometry) => Object.fromEntries([...Object.entries(g.attributes).map(([k, a]) => [k, Array.from(a.array as ArrayLike<number>)]), ['index', Array.from(g.index!.array)]]);

describe('geometry builder pool', () => {
  it('builds the same geometry from reused buffers as from fresh ones, and reuses them', () => {
    // a big build first fills the pool with large arrays full of its data
    const big = dump(boxes(3000, 7));
    const reusedBefore = geomPoolStats.reused;
    const small1 = dump(boxes(5, 100));
    expect(geomPoolStats.reused).toBeGreaterThan(reusedBefore);
    const again = dump(boxes(3000, 7));
    expect(again).toEqual(big);
    expect(dump(boxes(5, 100))).toEqual(small1);
    // 3000 boxes = 72000 vertices: 32-bit indices; 5 boxes: 16-bit
    expect(boxes(3000, 1).index!.array).toBeInstanceOf(Uint32Array);
    expect(boxes(5, 1).index!.array).toBeInstanceOf(Uint16Array);
  });
  it('fails loudly when a built builder is used again', () => {
    const b = new GeomBuilder();
    b.box(0, 0, 0, 1, 1, 1, 63, frame, frame, 0);
    b.build();
    expect(() => b.box(0, 0, 0, 1, 1, 1, 63, frame, frame, 0)).toThrow();
  });
});
