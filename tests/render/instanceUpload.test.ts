import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { WebGLAttributes } from 'three/src/renderers/webgl/WebGLAttributes.js';
import { touchInstanceRange } from '../../src/render/instanceUpload';
import { SpriteLayer } from '../../src/render/sprites';
import { CharLayer, type SkinStore } from '../../src/render/chars/charLayer';
import { makeRig } from '../../src/render/chars/rig';
import { bodyShapeOf } from '../../src/render/chars/archetype';
import type { TileFrame } from '../../src/render/textureSource';

const frame: TileFrame = { texture: new THREE.Texture(), uv: [0, 0, 1, 1], w: 16, h: 16 };
const attrs = (mesh: THREE.InstancedMesh) => [mesh.instanceMatrix, ...Object.values(mesh.geometry.attributes).filter(a => (a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute)] as THREE.BufferAttribute[];
const uploaded = (mesh: THREE.InstancedMesh) => attrs(mesh).forEach(a => a.clearUpdateRanges());

describe('instance GPU upload spans', () => {
  it('sends only changed bytes through Three WebGLAttributes after allocation', () => {
    const transfers: { offset: number; count: number }[] = [];
    const gl = {
      FLOAT: 5126, createBuffer: () => ({}), bindBuffer() {}, bufferData() {},
      bufferSubData(_target: number, offset: number, _data: Float32Array, _start: number, count: number) { transfers.push({ offset, count }); },
    } as unknown as WebGL2RenderingContext;
    const gpu = new WebGLAttributes(gl);
    const a = new THREE.BufferAttribute(new Float32Array(256 * 16), 16);
    gpu.update(a, 34962); // Initial bufferData must allocate the capacity.
    touchInstanceRange(a, 16, 16);
    touchInstanceRange(a, 32, 16);
    gpu.update(a, 34962);
    expect(transfers).toEqual([{ offset: 64, count: 32 }]);
    expect(a.updateRanges).toHaveLength(0);
    touchInstanceRange(a, 112, 16);
    gpu.update(a, 34962);
    expect(transfers[1]).toEqual({ offset: 448, count: 16 });
  });

  it('retains pending writes across skipped renders and resets after upload', () => {
    const a = new THREE.BufferAttribute(new Float32Array(128), 4);
    touchInstanceRange(a, 32, 4);
    const range = a.updateRanges[0];
    touchInstanceRange(a, 4, 4);
    touchInstanceRange(a, 16, 4);
    expect(a.updateRanges).toEqual([{ start: 4, count: 32 }]);
    expect(a.updateRanges[0]).toBe(range);
    a.clearUpdateRanges(); // WebGLAttributes consumes pending ranges after bufferSubData.
    touchInstanceRange(a, 80, 4);
    expect(a.updateRanges).toEqual([{ start: 80, count: 4 }]);
    const version = a.version;
    touchInstanceRange(a, 0, 0);
    expect(a.version).toBe(version);
  });

  it('uploads only changed sprites, including swap removal and growth', () => {
    const layer = new SpriteLayer(() => { throw new Error('explicit frames only'); }, false);
    const sprites = Array.from({ length: 3 }, (_, i) => layer.add({ x: i, y: 0, z: 0, frame }));
    let mesh = layer.group.children[0] as THREE.InstancedMesh;
    uploaded(mesh);
    sprites[1].set(7, 8, 0);
    for (const a of attrs(mesh)) expect(a.updateRanges).toEqual([{ start: a.itemSize, count: a.itemSize }]);
    expect(mesh.instanceMatrix.array[28]).toBe(7);
    uploaded(mesh);
    sprites[0].remove();
    expect(mesh.count).toBe(2);
    expect(mesh.instanceMatrix.array[12]).toBe(2);
    for (const a of attrs(mesh)) expect(a.updateRanges).toEqual([{ start: 0, count: a.itemSize }]);
    uploaded(mesh);
    sprites[1].remove(); // tail removal changes count, with no changed buffer values.
    for (const a of attrs(mesh)) expect(a.updateRanges).toHaveLength(0);
    const cap = mesh.instanceMatrix.count;
    for (let i = 1; i <= cap; i++) layer.add({ x: 100 + i, y: 0, z: 0, frame });
    mesh = layer.group.children[0] as THREE.InstancedMesh;
    expect(mesh.instanceMatrix.count).toBe(cap * 2);
    expect(mesh.instanceMatrix.array[12]).toBe(2);
    for (const a of attrs(mesh)) expect(a.updateRanges).toEqual([{ start: 0, count: mesh.count * a.itemSize }]);
  });

  it('uploads only active character parts and skips an empty page', () => {
    const layer = new CharLayer(false);
    const rig = makeRig(bodyShapeOf({ id: 'mon_zombie', bodytype: 'human' }));
    const inst = layer.add(rig, { page: 0, rects: new Int32Array(rig.parts.length * 5), refs: 0 });
    const store = { upload() {}, texture: () => frame.texture } as unknown as SkinStore;
    layer.flush(0, store);
    const mesh = layer.group.children[0] as THREE.InstancedMesh;
    for (const a of attrs(mesh)) {
      expect(a.updateRanges).toEqual([{ start: 0, count: rig.parts.length * a.itemSize }]);
      expect(a.updateRanges[0].count).toBeLessThan(a.array.length);
    }
    uploaded(mesh);
    const versions = attrs(mesh).map(a => a.version);
    inst.remove();
    layer.flush(0, store);
    expect(mesh.count).toBe(0);
    expect(attrs(mesh).map(a => a.version)).toEqual(versions);
    layer.dispose();
  });
});
