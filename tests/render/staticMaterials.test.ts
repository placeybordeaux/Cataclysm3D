import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { patchStaticMaterials } from '../../src/render/staticMaterials';
import { installChunkBatch } from '../../src/render/chunkBatch';

describe('static material preparation', () => {
  it('patches custom extras, hidden children, shader materials, and arrays once', () => {
    const root = new THREE.Group();
    const builtin = new THREE.MeshBasicMaterial();
    const customCompile = vi.fn();
    builtin.onBeforeCompile = customCompile;
    const shader = new THREE.ShaderMaterial({ fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }' });
    const child = new THREE.Mesh(new THREE.BufferGeometry(), [builtin, shader]);
    child.visible = false;
    root.add(child);
    patchStaticMaterials(root);
    expect(builtin.userData.mrt).toBe(true);
    expect(shader.userData.mrt).toBe(true);
    expect(shader.fragmentShader).toContain('gNormal');
    const version = builtin.version;
    const patchedCompile = builtin.onBeforeCompile;
    patchStaticMaterials(root);
    expect(builtin.version).toBe(version);
    expect(builtin.onBeforeCompile).toBe(patchedCompile);
    const source = { fragmentShader: 'void main() {}', vertexShader: '' } as THREE.WebGLProgramParametersWithUniforms;
    builtin.onBeforeCompile(source, {} as THREE.WebGLRenderer);
    expect(customCompile).toHaveBeenCalledOnce();
    expect(source.fragmentShader).toContain('gNormal');
  });

  it('patches each rebuilt chunk and later tree replacement independently', () => {
    const root = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const chunk = new THREE.Group();
      const material = new THREE.MeshBasicMaterial();
      chunk.add(new THREE.Mesh(new THREE.BufferGeometry(), material));
      patchStaticMaterials(chunk);
      root.clear();
      root.add(chunk);
      expect(material.userData.mrt).toBe(true);
      const extra = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
      patchStaticMaterials(extra);
      chunk.add(extra);
      expect(extra.material.userData.mrt).toBe(true);
    }
  });

  it('registers the exact batch root for exclusion from dynamic material scans', () => {
    const renderer = {
      scene: new THREE.Scene(), staticMaterialRoots: new Set<THREE.Object3D>(),
      beforeRender: [] as ((dt: number) => void)[],
      chunks: { group: new THREE.Group(), behind: false, curtained: false, vel: { x: 0, y: 0 } },
    };
    const batch = installChunkBatch(renderer, () => ({ x: 0, y: 0 }), {});
    expect(renderer.staticMaterialRoots.has(batch.group)).toBe(true);
  });
});
