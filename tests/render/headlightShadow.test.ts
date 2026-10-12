import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createHeadlight, HEADLIGHT_SPOTS, pickHeadlightSpots, prepareHeadlightShadow } from '../../src/render/headlightShadow';

function map(light: THREE.SpotLight, compare: boolean) {
  const target = new THREE.WebGLRenderTarget(1024, 1024);
  target.depthTexture = new THREE.DepthTexture(1024, 1024);
  target.depthTexture.compareFunction = compare ? THREE.LessEqualCompare : null;
  light.shadow.map = target;
  light.shadow.needsUpdate = false;
  return target;
}

describe('headlight occlusion shadows', () => {
  it('retains its shadow count while switching off and avoids redrawing inactive maps', () => {
    const light = createHeadlight();
    prepareHeadlightShadow(light, THREE.BasicShadowMap);
    expect(light.castShadow).toBe(true);
    expect(light.shadow.needsUpdate).toBe(true); // allocate even when first seen off
    const target = map(light, false);
    light.intensity = 45;
    prepareHeadlightShadow(light, THREE.BasicShadowMap);
    expect(light.shadow.autoUpdate).toBe(true);
    light.intensity = 0;
    prepareHeadlightShadow(light, THREE.BasicShadowMap);
    expect(light.castShadow).toBe(true);
    expect(light.shadow.autoUpdate).toBe(false);
    expect(light.shadow.needsUpdate).toBe(false);
    expect(light.shadow.map).toBe(target);
    target.dispose();
  });

  it('replaces incompatible shadow textures on a mode change, including while off', () => {
    const light = createHeadlight();
    const basic = map(light, false), dispose = vi.spyOn(basic, 'dispose');
    prepareHeadlightShadow(light, THREE.PCFShadowMap);
    expect(dispose).toHaveBeenCalledOnce();
    expect(light.shadow.map).toBeNull();
    expect(light.shadow.needsUpdate).toBe(true);
    const pcf = map(light, true);
    prepareHeadlightShadow(light, THREE.PCFShadowMap);
    expect(light.shadow.map).toBe(pcf);
    prepareHeadlightShadow(light, THREE.BasicShadowMap);
    expect(light.shadow.map).toBeNull();
  });
});


describe('headlight spot slots', () => {
  // Regression: one spot, and the car you drive always took it, so switching your own lights
  // on put out the beam of every other car on the road.
  it("keeps another car's spot when your own headlights come on", () => {
    expect(HEADLIGHT_SPOTS).toBeGreaterThanOrEqual(2);
    const own = 'own', near = 'near', far = 'far';
    expect(pickHeadlightSpots([{ v: near, d: 20 }], own)).toEqual([near]);
    expect(pickHeadlightSpots([{ v: far, d: 40 }, { v: near, d: 20 }, { v: own, d: 0 }], own)).toEqual([own, near]);
  });

  it('gives the car you drive a spot even when others are nearer the camera', () => {
    expect(pickHeadlightSpots([{ v: 'a', d: 3 }, { v: 'b', d: 4 }, { v: 'own', d: 6 }], 'own', 2)).toEqual(['own', 'a']);
  });

  it('on foot, the nearest lit cars share the spots', () => {
    expect(pickHeadlightSpots([{ v: 'c', d: 30 }, { v: 'a', d: 10 }, { v: 'b', d: 20 }], null, 2)).toEqual(['a', 'b']);
    expect(pickHeadlightSpots([], null, 2)).toEqual([]);
  });
});
