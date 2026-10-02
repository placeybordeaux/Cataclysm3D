import * as THREE from 'three';

/** A dipped headlight must be occluded by walls and floors, even when another
 * lamp lights the receiving tile. An aggregate artificial-light gate is insufficient. */
export function createHeadlight(): THREE.SpotLight {
  const light = new THREE.SpotLight(0xfff0d4, 0, 80, 0.5, 0.45, 0.5);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.camera.near = 0.1;
  light.shadow.camera.far = light.distance;
  // Perspective depth bias expands with distance and can detach shadows from slabs.
  light.shadow.bias = 0;
  light.shadow.normalBias = 0.002;
  return light;
}

/** Keep the shadow count fixed when switching headlights off. Inactive maps need
 * one valid allocation, including the comparison texture required by PCF mode. */
export function prepareHeadlightShadow(light: THREE.SpotLight, type: THREE.ShadowMapType): void {
  light.shadow.autoUpdate = light.intensity > 0;
  const depth = light.shadow.map?.depthTexture;
  const compare = type === THREE.PCFShadowMap;
  if (!depth || (depth.compareFunction !== null) !== compare) {
    light.shadow.map?.dispose();
    light.shadow.map = null;
    light.shadow.needsUpdate = true;
  }
}
