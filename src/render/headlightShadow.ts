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

/**
 * Shadowed headlight spots in the scene. Fixed at startup: each one is a spot shadow every
 * material is compiled for, so the count never changes at runtime (no recompiles), and each
 * lit one redraws a 1024 map per frame. Two = the car you drive plus the nearest other one.
 */
export const HEADLIGHT_SPOTS = 2;

/**
 * Which lit vehicles get the headlight spots, best first: the one you drive (its beam is the
 * road you're about to drive on), then the rest by distance. With a single spot and yours
 * always first, switching your own lights on put out every other car's beam.
 */
export function pickHeadlightSpots<T>(lit: readonly { v: T; d: number }[], driving: T | null, n = HEADLIGHT_SPOTS): T[] {
  return [...lit]
    .sort((a, b) => (a.v === driving ? -1 : b.v === driving ? 1 : a.d - b.d))
    .slice(0, n)
    .map((l) => l.v);
}
