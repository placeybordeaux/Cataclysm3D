import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bodyShapeOf } from '../../src/render/chars/archetype';
import { HUM, makeRig, type PoseIn } from '../../src/render/chars/rig';
import { CharLayer, type Skin } from '../../src/render/chars/charLayer';
import { twoBone, limbEnd, type RideIn, type V3 } from '../../src/render/chars/ridePose';

const base: PoseIn = { t: 0, phase: 0, gait: 0, windup: null, windKind: 'melee', strike: 0, down: 0, flinch: 0, dead: false, seed: 0.3 };

/** Pose the player's rig and read where its hand centres and ankles really land (built matrices). */
function solve(ride: RideIn) {
  const rig = makeRig({ ...bodyShapeOf({ id: 'player_male', bodytype: 'human', species: ['HUMAN'], volume: 62500 }), weapon: 'rifle' });
  const layer = new CharLayer(false);
  const skin: Skin = { page: 0, rects: new Int32Array(rig.parts.length * 5), refs: 0 };
  const inst = layer.add(rig, skin);
  inst.setPose({ ...base, ride });
  inst.build(null);
  const m = new THREE.Matrix4();
  const at = (part: number, y: number): V3 => {
    m.fromArray(inst.mats, part * 16);
    const v = new THREE.Vector3(0, y, 0).applyMatrix4(m);
    // world (x, height, map y) with the instance at the origin facing north: model space
    return [v.x, v.y, v.z];
  };
  return { rig, handR: at(HUM.handR, 0), handL: at(HUM.handL, 0), ankleR: at(HUM.shinR, -0.5), ankleL: at(HUM.shinL, -0.5), inst };
}

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('riding pose (two-bone IK)', () => {
  it('forward kinematics round-trips twoBone for arms and legs', () => {
    for (const knee of [false, true]) {
      for (const d of [[0.1, -0.3, -0.3], [-0.12, -0.45, -0.1], [0.05, -0.2, -0.4], [0.02, -0.5, 0.15]] as V3[]) {
        const a = twoBone(d, 0.3, 0.3, knee);
        const e = limbEnd([0, 0, 0], 0, a, 0.3, 0.3);
        expect(dist(e, d)).toBeLessThan(1e-3);
        // arms fold forward (the elbow points back), legs fold back (the knee points forward)
        expect(Math.sign(a.bend)).toBe(knee ? -1 : 1);
      }
    }
  });

  it('puts hands on bicycle grips and feet on pedals in the built rig', () => {
    // hips on a saddle ~0.92 m up (model origin = where the feet would stand), bars ahead
    const ride: RideIn = {
      lean: 0.55,
      hands: [[0.24, 1.0, -0.55], [-0.24, 1.0, -0.55]],
      feet: [[0.14, 0.35, -0.2], [-0.14, 0.55, -0.05]],
    };
    const r = solve(ride);
    expect(dist(r.handR, ride.hands[0])).toBeLessThan(0.01);
    expect(dist(r.handL, ride.hands[1])).toBeLessThan(0.01);
    expect(dist(r.ankleR, ride.feet[0])).toBeLessThan(0.01);
    expect(dist(r.ankleL, ride.feet[1])).toBeLessThan(0.01);
    // the rifle is stowed while both hands are on the bars
    const w = r.rig.parts.findIndex((p) => p.name === 'weapon');
    expect(r.inst.pose.scl[w * 3]).toBe(0);
  });

  it('reaches a steering wheel from a reclined car seat', () => {
    const ride: RideIn = {
      lean: -0.15,
      hands: [[0.16, 1.2, -0.38], [-0.16, 1.25, -0.36]],
      feet: [[0.12, 0.3, -0.5], [-0.12, 0.3, -0.5]],
    };
    const r = solve(ride);
    for (const [got, want] of [[r.handR, ride.hands[0]], [r.handL, ride.hands[1]], [r.ankleR, ride.feet[0]], [r.ankleL, ride.feet[1]]] as const) expect(dist(got, want)).toBeLessThan(0.01);
  });

  it('straightens toward targets out of reach instead of failing', () => {
    const ride: RideIn = { lean: 0, hands: [[0.2, 1.4, -2], [-0.2, 1.4, -2]], feet: [[0.1, -1, 0], [-0.1, -1, 0]] };
    const r = solve(ride);
    for (const v of [...r.handR, ...r.ankleR]) expect(Number.isFinite(v)).toBe(true);
    // arm pointing at the target: the hand is ahead of the shoulder, at full stretch
    expect(r.handR[2]).toBeLessThan(-0.4);
  });
});
