import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createHeadlight, prepareHeadlightShadow } from '../../src/render/headlightShadow';

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

