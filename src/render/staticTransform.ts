import type { Object3D } from 'three';

/** Snapshot a static subtree's local transforms once. World transforms stay automatic:
 * attaching it beneath a moved parent still updates descendants correctly. Animation of
 * the baked trees/terrain lives in shader uniforms, not Object3D transforms. */
export function freezeLocalTransforms(root: Object3D): void {
  root.traverse(object => {
    // Preserve matrices explicitly authored by callers with matrixAutoUpdate=false.
    if (object.matrixAutoUpdate) object.updateMatrix();
    object.matrixAutoUpdate = false;
    object.matrixWorldNeedsUpdate = true;
  });
}
