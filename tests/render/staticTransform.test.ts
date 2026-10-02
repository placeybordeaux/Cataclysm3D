import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { freezeLocalTransforms } from '../../src/render/staticTransform';

describe('static local transforms', () => {
  it('avoids static world-matrix work while dynamic siblings still move', () => {
    const scene = new THREE.Scene();
    scene.matrixAutoUpdate = false;
    const chunks = new THREE.Group();
    chunks.matrixAutoUpdate = false;
    scene.add(chunks);
    const chunk = new THREE.Group();
    const tree = new THREE.Mesh();
    tree.position.set(3, 4, 5);
    chunk.add(tree);
    freezeLocalTransforms(chunk);
    chunks.add(chunk);
    const moving = new THREE.Object3D();
    scene.add(moving);
    scene.updateMatrixWorld();
    const staticMultiply = vi.spyOn(tree.matrixWorld, 'multiplyMatrices');
    const staticCompose = vi.spyOn(tree.matrix, 'compose');
    for (let i = 1; i <= 10; i++) {
      moving.position.x = i;
      scene.updateMatrixWorld();
      expect(moving.matrixWorld.elements[12]).toBe(i);
      expect(tree.matrixWorld.elements.slice(12, 15)).toEqual([3, 4, 5]);
    }
    expect(staticMultiply).not.toHaveBeenCalled();
    expect(staticCompose).not.toHaveBeenCalled();
  });

  it('preserves manual local matrices and reacts to changed parent world transforms', () => {
    const parent = new THREE.Group();
    const subtree = new THREE.Group();
    subtree.position.set(2, 0, 0);
    const mesh = new THREE.Mesh();
    mesh.matrixAutoUpdate = false;
    mesh.matrix.makeTranslation(0, 7, 0);
    subtree.add(mesh);
    freezeLocalTransforms(subtree);
    parent.add(subtree);
    parent.position.set(10, 0, 0);
    parent.updateMatrixWorld();
    expect(mesh.matrixWorld.elements.slice(12, 15)).toEqual([12, 7, 0]);
    parent.position.set(20, 0, 0);
    parent.updateMatrixWorld();
    expect(mesh.matrixWorld.elements.slice(12, 15)).toEqual([22, 7, 0]);
    expect(mesh.matrixWorldAutoUpdate).toBe(true);
  });

  it('initializes newly attached static replacements without forcing the whole scene', () => {
    const scene = new THREE.Scene();
    scene.matrixAutoUpdate = false;
    const chunk = new THREE.Group();
    freezeLocalTransforms(chunk);
    scene.add(chunk);
    scene.updateMatrixWorld();
    const replacement = new THREE.Mesh();
    replacement.position.set(-5, 2, 9);
    freezeLocalTransforms(replacement);
    chunk.add(replacement);
    scene.updateMatrixWorld();
    expect(replacement.matrixWorld.elements.slice(12, 15)).toEqual([-5, 2, 9]);
  });
});
