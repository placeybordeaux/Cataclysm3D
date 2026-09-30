import { describe, expect, it } from 'vitest';
import { buildCutoutMips } from '../src/render/cutoutMips';
import { applyForm, form, FORMS, FORM_NAMES, setForm } from '../src/render/formLight';
import { LightManager, SkyState } from '../src/render/lights';
import { shared } from '../src/render/materials';
import * as THREE from 'three';

describe('form lighting presets', () => {
  it('defaults to toon; soft keeps the v2 numbers', () => {
    expect(form.name).toBe('toon');
    expect(FORMS.soft).toMatchObject({ bands: 5, key: 1, ambient: 1, fillMode: 'opposite', spriteCurve: 0 });
  });

  it('get bolder in order: fewer bands, less ambient against the key', () => {
    const [a, b, c] = FORM_NAMES.map((n) => FORMS[n]);
    expect(a.bands).toBeGreaterThan(b.bands);
    expect(b.bands).toBeGreaterThan(c.bands);
    expect(a.ambient / a.key).toBeGreaterThan(b.ambient / b.key);
    expect(b.ambient / b.key).toBeGreaterThan(c.ambient / c.key);
    // ambient floor: shadow sides never go black
    for (const f of [a, b, c]) expect(f.ambient).toBeGreaterThanOrEqual(0.5);
  });

  it('side fill comes from 90 degrees to the sun, independent of the camera', () => {
    setForm('toon');
    const lm = new LightManager();
    const sky = new SkyState();
    sky.update(15);
    const cam = new THREE.PerspectiveCamera();
    const focus = new THREE.Vector3(10, 1.6, 10);
    lm.update(0.016, sky, focus, cam);
    const f1 = lm.fill.position.clone().sub(lm.fill.target.position).normalize();
    const hs = new THREE.Vector2(sky.sunDir.x, sky.sunDir.z).normalize();
    expect(Math.abs(hs.dot(new THREE.Vector2(f1.x, f1.z).normalize()))).toBeLessThan(1e-6);
    cam.rotation.y = 2;
    cam.updateMatrixWorld();
    lm.update(0.016, sky, focus, cam);
    const f2 = lm.fill.position.clone().sub(lm.fill.target.position).normalize();
    expect(f2.distanceTo(f1)).toBeLessThan(1e-6);
    expect(lm.fill.intensity).toBeGreaterThan(0);
  });

  it('pushes bands and sprite curvature to the shaders', () => {
    setForm('bold');
    applyForm();
    expect(shared.uBands.value).toBe(3);
    expect(shared.uSpriteCurve.value).toBeGreaterThan(0);
    setForm('toon');
    applyForm();
  });

  it('unknown names fail loudly', () => {
    expect(() => setForm('flat' as never)).toThrow(/unknown form/);
  });
});

describe('cutout mips', () => {
  // 4x4, one opaque texel column (a 1-texel "blade") at x = 1
  const blade = () => {
    const d = new Uint8Array(4 * 4 * 4);
    for (let y = 0; y < 4; y++) {
      const i = (y * 4 + 1) * 4;
      d[i] = d[i + 1] = d[i + 2] = 200;
      d[i + 3] = 255;
    }
    return d;
  };

  it('keeps thin features with minCover 1, drops them with 3', () => {
    const keep = buildCutoutMips(blade(), 4, 1);
    expect(keep.map((l) => l.length / 4)).toEqual([16, 4, 1]);
    expect(keep[1][3]).toBe(255); // block (0,0) had the blade
    expect(keep[1][4 * 1 + 3]).toBe(0); // block (1,0) did not
    expect(keep[2][3]).toBe(255);
    expect(buildCutoutMips(blade(), 4, 3)[1][3]).toBe(0);
  });

  it('alpha is binary and colour averages only the opaque texels', () => {
    const m = buildCutoutMips(blade(), 4, 1)[1];
    for (let i = 3; i < m.length; i += 4) expect([0, 255]).toContain(m[i]);
    expect(m[0]).toBe(200);
  });
});
