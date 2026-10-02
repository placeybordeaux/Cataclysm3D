import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GameMap } from '../../src/world/map';
import { CHUNK, LEVEL_HEIGHT, MIN_Z, MAX_Z } from '../../src/world/coords';
import type { TerrainDef } from '../../src/data/types';
import { LightMap, lmUniforms } from '../../src/render/lightmap';
import { LM_FUNCS, patchBandedLambert, worldMaterials } from '../../src/render/materials';
import terrain from '../../public/data/terrain.json';

function world() {
  const map = new GameMap(1);
  for (const definition of Object.values(terrain)) map.terrain.add(definition as TerrainDef);
  map.generator = { generate(m, chunk) { chunk.ter.fill(m.terrain.index(chunk.z <= 0 ? 't_floor' : 't_open_air')); } };
  for (let z = -1; z <= 1; z++) for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) map.chunk(x, y, z);
  return map;
}

describe('multi-level light maps', () => {
  it('keeps upstairs and basement illumination stable when the player crosses levels', () => {
    const map = new LightMap(world());
    map.naturalLevel = 100;
    const sources = [{ x: 12, y: 12, z: -1, lum: 60, color: 0xff0000, flicker: false, phase: 0 }];
    map.update(12, 12, 0, 0.1, 0, sources.values());
    const upstairs = map.exactLightAt(12, 12, 0)!;
    const downstairs = map.exactLightAt(12, 12, -1)!;
    expect(upstairs).toBeCloseTo(100);
    expect(downstairs).toBeCloseTo(67);
    const before = (lmUniforms.tLightMapBelow.value as THREE.DataTexture).image.data!.slice();
    const version = map.texture.version;
    map.update(12, 12, 0, 0.1, 0, sources.values());
    expect(map.texture.version).toBe(version); // unchanged level cache avoids another upload
    map.update(12, 12, -1, 0.1, 0, sources.values());
    expect(map.exactLightAt(12, 12, 0)).toBeCloseTo(upstairs);
    expect(map.exactLightAt(12, 12, -1)).toBeCloseTo(downstairs);
    expect(map.texture.image.data).toEqual(before);
    expect(lmUniforms.uLmLevel.value.x).toBe(-LEVEL_HEIGHT);
  });

  it('consumes a one-shot source iterator once and keeps each level isolated', () => {
    const map = new LightMap(world());
    const sources = function* () {
      yield { x: 12, y: 12, z: 0, lum: 50, color: 0x00ff00, flicker: false, phase: 0 };
      yield { x: 12, y: 12, z: -1, lum: 90, color: 0xff0000, flicker: false, phase: 0 };
    };
    map.update(12, 12, 0, 0.1, 0, sources());
    const offset = (map.field.index(12, 12)) * 4;
    const current = map.texture.image.data!;
    const below = (lmUniforms.tLightMapBelow.value as THREE.DataTexture).image.data!;
    expect(current[offset]).toBe(0);
    expect(current[offset + 1]).toBeGreaterThan(0);
    expect(below[offset]).toBeGreaterThan(0);
    expect(below[offset + 1]).toBe(0);
    expect(map.stats.sources).toBe(2);
    expect(map.stats.rebuilds).toBe(3);
    expect(map.stats.naturalMs).toBeGreaterThan(0);
  });

  it('changes static-light identity when an equal lamp is on a different level', () => {
    const map = world();
    map.terrain.add({ id: 't_testlamp', name: 'lamp', move_cost: 2, flags: ['TRANSPARENT'], symbol: '.', color: 'white', light_emitted: 40 });
    for (const z of [-1, 1]) map.chunk(0, 0, z)!.ter[12 * CHUNK + 12] = map.terrain.index('t_testlamp');
    const lights = new LightMap(map);
    lights.update(12, 12, -2, 0.1, 0, []);
    const old = lights.statics;
    expect(old).toHaveLength(1);
    expect(old[0].z).toBe(-1);
    lights.update(12, 12, 2, 0.1, 0, []);
    expect(lights.statics).not.toBe(old);
    expect(lights.statics).toHaveLength(1);
    expect(lights.statics[0].z).toBe(1);
  });

  it('disables unavailable maps at world bounds and invalidates adjacent cached levels', () => {
    const map = new LightMap(world());
    map.update(12, 12, MIN_Z, 0.1, 0, []);
    expect(lmUniforms.uLmAdjacent.value.x).toBe(0);
    map.update(12, 12, MAX_Z, 0.1, 0, []);
    expect(lmUniforms.uLmAdjacent.value.y).toBe(0);
    map.invalidate();
    expect(map.exactLightAt(12, 12, MAX_Z - 1)).toBeNull();
  });

  it('selects one level per world position without blending through a slab', () => {
    expect(LM_FUNCS).toContain('texelFetch(tLightMapBelow, c, 0)');
    expect(LM_FUNCS).toContain('texelFetch(tLightMapAbove, c, 0)');
    expect(LM_FUNCS).not.toContain('mix(');
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(5, 8, 2);
    camera.rotation.set(0.5, 0.8, 0.3);
    camera.updateMatrixWorld();
    const viewUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorldInverse, 1);
    const viewPoint = new THREE.Vector3(3, -2, 9).applyMatrix4(camera.matrixWorldInverse);
    expect(viewPoint.dot(viewUp) + camera.position.y).toBeCloseTo(-2);
    // Inspect the patched direct-light chunk through a complete Lambert program.
    const compiled = { ...THREE.ShaderLib.lambert, uniforms: {} } as THREE.WebGLProgramParametersWithUniforms;
    patchBandedLambert(compiled);
    expect(compiled.fragmentShader).toContain('lmPointLevelGate(pointLight.position, geometryPosition)');
    expect(compiled.fragmentShader).toContain('dot(sourcePosition, viewMatrix[1].xyz) + cameraPosition.y');
  });

  it('casts structural slab shadows from both sides', () => {
    const { mat } = worldMaterials(new THREE.Texture());
    expect(mat.side).toBe(THREE.FrontSide);
    expect(mat.shadowSide).toBe(THREE.DoubleSide);
  });
});
