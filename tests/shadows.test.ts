import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DEFAULT_SHADOW_MODE, SHADOW_MODES, SHADOW_MODE_NAMES, ShadowRig, SunStepper, lightBasis, snapToGrid, snappedCenter } from '../src/render/shadows';
import { LightManager, SkyState } from '../src/render/lights';

const DEG = Math.PI / 180;
const sunAt = (azDeg: number, altDeg: number) =>
  new THREE.Vector3(-Math.sin(azDeg * DEG) * Math.cos(altDeg * DEG), Math.sin(altDeg * DEG), Math.cos(azDeg * DEG) * Math.cos(altDeg * DEG)).normalize();

describe('texel snapping', () => {
  it('rounds to multiples of the step and rejects bad steps', () => {
    expect(snapToGrid(0.26, 0.1)).toBeCloseTo(0.3);
    expect(snapToGrid(-0.26, 0.1)).toBeCloseTo(-0.3);
    expect(() => snapToGrid(1, 0)).toThrow();
  });

  it('builds an orthonormal basis matching three lookAt (x = up cross dir)', () => {
    const d = sunAt(30, 40), r = new THREE.Vector3(), u = new THREE.Vector3();
    lightBasis(d, r, u);
    expect(r.dot(u)).toBeCloseTo(0);
    expect(r.dot(d)).toBeCloseTo(0);
    expect(u.dot(d)).toBeCloseTo(0);
    // three's camera lookAt points -z at the target, so its x axis is up x (eye - target) = up x dir
    const cameraish = new THREE.Matrix4().lookAt(d, new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
    const x = new THREE.Vector3().setFromMatrixColumn(cameraish, 0);
    expect(x.distanceTo(r)).toBeLessThan(1e-9);
  });

  it('keeps the centre on the texel grid wherever the focus moves (far from the origin too)', () => {
    const d = sunAt(40, 25), texel = 40 / 1024;
    const r = new THREE.Vector3(), u = new THREE.Vector3();
    lightBasis(d, r, u);
    const c = new THREE.Vector3();
    for (const f of [new THREE.Vector3(3.1, 1.7, -2.2), new THREE.Vector3(5123.37, 1.7, -8812.9)]) {
      snappedCenter(f, d, texel, c);
      const kx = c.dot(r) / texel, ky = c.dot(u) / texel;
      expect(Math.abs(kx - Math.round(kx))).toBeLessThan(1e-3);
      expect(Math.abs(ky - Math.round(ky))).toBeLessThan(1e-3);
      // within half a texel of the focus in the map plane, same depth along the light
      expect(Math.abs(c.dot(r) - f.dot(r))).toBeLessThanOrEqual(texel / 2 + 1e-9);
      expect(c.dot(d)).toBeCloseTo(f.dot(d));
    }
  });

  it('why legacy shimmered: with the sun turning 0.005 deg the grid slides far from the origin', () => {
    const texel = 60 / 768, f = new THREE.Vector3(5000, 1.7, -8000);
    const r0 = new THREE.Vector3(), r1 = new THREE.Vector3(), u = new THREE.Vector3();
    lightBasis(sunAt(40, 25), r0, u);
    lightBasis(sunAt(40.005, 25), r1, u);
    // the focus's coordinate along the texel axis jumps by more than a texel in one update
    expect(Math.abs(f.dot(r1) - f.dot(r0))).toBeGreaterThan(texel);
  });
});

describe('sun quantisation', () => {
  it('holds the direction until the sun has moved a step, then dissolves over fadeSec', () => {
    const st = new SunStepper(0.5, 1);
    // a low sun, so azimuth degrees are nearly arc degrees
    expect(st.update(1 / 60, sunAt(0, 5))).toBe(true); // first update snaps
    expect(st.share).toBe(0);
    let steps = 0;
    const held0 = st.dirs[st.cur].clone();
    // the sun turning 0.1 deg per real second (a game day per real hour): a step every ~5 s
    for (let i = 1; i <= 60 * 12; i++) {
      if (st.update(1 / 60, sunAt(i * 0.1 / 60, 5))) steps++;
      if (i === 60 * 4) expect(st.dirs[st.cur].equals(held0)).toBe(true);
    }
    expect(steps).toBe(2);
    expect(st.fading).toBe(false);
  });

  it('dissolves linearly and finishes a running dissolve when stepping again', () => {
    const st = new SunStepper(1, 1);
    st.update(0, sunAt(0, 40));
    expect(st.update(0.25, sunAt(2, 40))).toBe(true);
    expect(st.cur).toBe(1);
    expect(st.share).toBeCloseTo(0.25);
    st.update(0.25, sunAt(2, 40));
    expect(st.share).toBeCloseTo(0.5);
    // another step mid-dissolve: slot 1 becomes fully shown, the new sun goes to slot 0
    expect(st.update(0.25, sunAt(4, 40))).toBe(true);
    expect(st.cur).toBe(0);
    expect(st.share).toBeCloseTo(0.75);
    st.update(10, sunAt(4, 40));
    expect(st.share).toBe(0);
  });

  it('snaps without a dissolve when fadeSec is 0; rejects bad settings', () => {
    const st = new SunStepper(1, 0);
    st.update(0, sunAt(0, 40));
    st.update(0.01, sunAt(3, 40));
    expect(st.share).toBe(1);
    expect(() => new SunStepper(0, 1)).toThrow();
    expect(() => new SunStepper(1, -1)).toThrow();
  });
});

describe('shadow rig', () => {
  it('has the modes, a sane default and fails loudly on unknown names', () => {
    expect(SHADOW_MODE_NAMES).toEqual(['legacy', 'stable', 'cascades', 'smooth']);
    expect(SHADOW_MODES[DEFAULT_SHADOW_MODE]).toBeTruthy();
    const rig = new ShadowRig(new THREE.Group(), () => ({ size: 768, extent: 30 }));
    expect(() => rig.setMode('blob' as never)).toThrow();
  });

  it('creates one light for legacy, two for stable, four for the cascaded modes, in shader order', () => {
    const g = new THREE.Group();
    const rig = new ShadowRig(g, () => ({ size: 768, extent: 30 }));
    for (const [name, n] of [['legacy', 1], ['stable', 2], ['cascades', 4], ['smooth', 4]] as const) {
      rig.setMode(name);
      expect(rig.lights.length).toBe(n);
      expect(g.children.filter((o) => (o as THREE.DirectionalLight).isDirectionalLight).length).toBe(n);
      expect(rig.lights.every((l) => l.castShadow && !l.shadow.autoUpdate)).toBe(true);
    }
    expect(rig.uRig.value.x).toBe(2);
    expect(rig.uRig.value.y).toBe(2);
  });

  it('stable modes: walking redraws on the timer only and the held sun does not follow every frame', () => {
    const rig = new ShadowRig(new THREE.Group(), () => ({ size: 768, extent: 30 }));
    rig.setMode('cascades');
    const col = new THREE.Color(1, 1, 1), focus = new THREE.Vector3(5000, 1.7, -8000);
    rig.update(1 / 60, sunAt(10, 40), focus, col, 1);
    const d0 = rig.lights[0].position.clone().sub(rig.lights[0].target.position).normalize();
    let redraws = 0;
    for (let i = 0; i < 60; i++) {
      focus.x += 3 / 60;
      if (rig.update(1 / 60, sunAt(10 + (i * 0.1) / 60, 40), focus, col, 1)) redraws++;
    }
    const d1 = rig.lights[0].position.clone().sub(rig.lights[0].target.position).normalize();
    expect(d1.distanceTo(d0)).toBeLessThan(1e-9);
    // near map at 20 Hz, far map at 5 Hz: about 20 frames a second with a redraw
    expect(redraws).toBeGreaterThan(15);
    expect(redraws).toBeLessThan(25);
  });

  it('LightManager exposes the rig and keeps the legacy look size', () => {
    const lm = new LightManager();
    lm.shadows.setMode('legacy');
    lm.setShadow(2048, 40);
    expect(lm.sun.shadow.mapSize.x).toBe(2048);
    expect(lm.sun.shadow.camera.right).toBe(40);
    const sky = new SkyState();
    sky.update(12);
    lm.update(1 / 60, sky, new THREE.Vector3(), new THREE.PerspectiveCamera());
    expect(lm.shadowDue).toBe(true);
  });
});
