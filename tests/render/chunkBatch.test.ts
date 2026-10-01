import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ChunkBatcher, markBatchable, mergeIndexed } from '../../src/render/chunkBatch';
import { CHUNK } from '../../src/world/coords';

// Far-chunk draw-call batching (docs/PERF.md): merged per block and material, undone the moment
// a member is rebuilt or comes near, never merging while the player moves fast.

let now = 0;
beforeEach(() => {
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

const matA = new THREE.MeshLambertMaterial(), matB = new THREE.MeshLambertMaterial();
function quad(x: number, y: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([x, 0, y, x + 1, 0, y, x + 1, 0, y + 1, x, 0, y + 1]), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(12).fill(1), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2, 0, 2, 3]), 1));
  return g;
}
function chunkGroup(cx: number, cy: number, z = 0): THREE.Group {
  const g = new THREE.Group();
  g.name = `chunk ${cx},${cy},${z}`;
  for (const m of [matA, matB]) {
    const mesh = new THREE.Mesh(quad(cx * CHUNK, cy * CHUNK), m);
    markBatchable(mesh);
    g.add(mesh);
  }
  return g;
}
const visibleMeshes = (root: THREE.Object3D) => {
  let n = 0;
  root.traverseVisible((o) => void ((o as THREE.Mesh).isMesh && n++));
  return n;
};

describe('mergeIndexed', () => {
  it('concatenates attributes and offsets the indices', () => {
    const m = mergeIndexed([quad(0, 0), quad(5, 5)])!;
    expect(m.attributes.position.count).toBe(8);
    expect([...m.index!.array]).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    expect(m.attributes.position.getX(4)).toBe(5);
  });
  it('refuses different layouts', () => {
    const odd = quad(0, 0);
    odd.deleteAttribute('color');
    expect(mergeIndexed([quad(0, 0), odd])).toBeNull();
  });
});

describe('ChunkBatcher', () => {
  /** chunks of a 3x3 block (block 3: columns 3..5) far from a player at the origin */
  function world() {
    const chunks = new THREE.Group();
    for (let cy = 3; cy <= 5; cy++) for (let cx = 3; cx <= 5; cx++) chunks.add(chunkGroup(cx, cy));
    const b = new ChunkBatcher();
    b.budgetMs = 1e9;
    const run = (frames: number, speed = 0, x = 12, y = 12) => {
      for (let i = 0; i < frames; i++) {
        b.update(x, y, chunks, false, speed);
        now += 16;
      }
    };
    return { chunks, b, run };
  }

  it('merges a settled far block into one mesh per material', () => {
    const { chunks, b, run } = world();
    run(150);
    expect(b.stats.batches).toBe(1);
    expect(b.group.children.length).toBe(2);
    expect(visibleMeshes(chunks)).toBe(0);
    expect((b.group.children[0] as THREE.Mesh).geometry.attributes.position.count).toBe(9 * 4);
  });

  it('does not merge while the player drives fast', () => {
    const { b, run } = world();
    run(150, 20);
    expect(b.stats.batches).toBe(0);
  });

  it('undoes the merge the moment a member is rebuilt, and re-merges later', () => {
    const { chunks, b, run } = world();
    run(150);
    const old = chunks.children[4];
    chunks.remove(old);
    chunks.add(chunkGroup(4, 4));
    run(1);
    // the rebuilt chunk shows on its own, the other eight are merged again without it
    expect(visibleMeshes(chunks)).toBe(2);
    run(400);
    expect(visibleMeshes(chunks)).toBe(0);
    expect(b.group.children.length).toBe(2);
  });

  it("leaves the player's own 3x3 alone", () => {
    const { chunks, b, run } = world();
    run(150, 0, 4 * CHUNK + 12, 4 * CHUNK + 12);
    // the block is all within one chunk of the player: nothing merged
    expect(b.stats.batches).toBe(0);
    expect(visibleMeshes(chunks)).toBe(18);
  });
});
