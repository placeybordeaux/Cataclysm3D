import type { Material, Mesh, Object3D } from 'three';
import { patchNormalOutput } from './materials';

/** Patch every material before installing static geometry, including hidden children and
 * custom extraObjects. Static chunk materials are replaced by rebuilding the subtree. */
export function patchStaticMaterials(root: Object3D): void {
  root.traverse(object => {
    const material = (object as Mesh).material as Material | Material[] | undefined;
    if (Array.isArray(material)) for (const entry of material) patchNormalOutput(entry);
    else if (material) patchNormalOutput(material);
  });
}
