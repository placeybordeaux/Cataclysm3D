import { describe, expect, it } from 'vitest';
import { CameraRig } from '../src/render/camera';
import {
  approachAngle, chaseOffsets, chasePose, chaseReach, eyeHeightFor, headingFromFacing, rideShake, speedFov, wrapAngle, type DriveView,
} from '../src/render/driveCamera';

const view = (over: Partial<DriveView> = {}): DriveView => ({
  x: 10, y: 10, base: 0, heading: 0, eyeX: 10, eyeY: 9, eyeH: 1.2, length: 6, width: 4, speed: 0, rough: 0, ...over,
});

describe('drive camera math', () => {
  it('heading: vehicle facing (east = 0, clockwise) to player yaw (north = 0, clockwise)', () => {
    expect(headingFromFacing(270)).toBeCloseTo(2 * Math.PI); // facing north
    expect(Math.sin(headingFromFacing(0))).toBeCloseTo(1); // east: forward +x
    expect(-Math.cos(headingFromFacing(90))).toBeCloseTo(1); // south: forward +y
  });

  it('wraps and eases angles the short way round', () => {
    expect(Math.abs(wrapAngle(3 * Math.PI))).toBeCloseTo(Math.PI);
    expect(wrapAngle(-0.5)).toBeCloseTo(-0.5);
    // from just left of north to just right of it: crosses 0, not the long way through south
    expect(approachAngle(-0.1, 2 * Math.PI + 0.1, 0.5)).toBeCloseTo(0);
  });

  it('chase camera sits behind the car, above it, looking down at the road ahead', () => {
    const v = view({ heading: 0 }); // pointing north (-y)
    const { dist, rise } = chaseOffsets(v.length);
    const p = chasePose(v, v.heading, dist, rise);
    expect(p.y).toBeGreaterThan(v.y + 5); // behind = south
    expect(p.x).toBeCloseTo(v.x);
    expect(p.h).toBeGreaterThan(2);
    expect(p.pitch).toBeLessThan(0);
    expect(p.pitch).toBeGreaterThan(-0.5); // still sees the horizon
  });

  it('chase camera looks further ahead at speed and widens the FOV', () => {
    const slow = chasePose(view({ speed: 0 }), 0, 8, 3.6);
    const fast = chasePose(view({ speed: 25 }), 0, 8, 3.6);
    expect(fast.pitch).toBeGreaterThan(slow.pitch);
    expect(speedFov(64, 0, 10)).toBe(64);
    expect(speedFov(64, 12.5, 10)).toBeCloseTo(69);
    expect(speedFov(64, 60, 10)).toBe(74);
  });

  it('bigger vehicles get a longer, higher chase camera and a higher driver eye', () => {
    expect(chaseOffsets(12).dist).toBeGreaterThan(chaseOffsets(6).dist);
    expect(chaseOffsets(12).rise).toBeGreaterThan(chaseOffsets(6).rise);
    expect(eyeHeightFor(6, 1070)).toBeCloseTo(1.2);
    expect(eyeHeightFor(12, 2500)).toBeGreaterThan(1.4);
    expect(eyeHeightFor(12, 2500)).toBeLessThan(1.8); // under the drawn roof
  });

  it('chase camera pulls in before a wall behind the car', () => {
    const v = view({ heading: 0 }); // behind = +y
    expect(chaseReach(v, 0, 8, () => false)).toBe(8);
    const d = chaseReach(v, 0, 8, (_x, y) => y >= 15); // wall 5 m behind the centre
    expect(d).toBeLessThan(5);
    expect(d).toBeGreaterThanOrEqual(v.length / 2);
  });

  it('ride shake: none standing still, subtle on pavement, stronger off-road', () => {
    let road = 0, dirt = 0;
    for (let t = 0; t < 2; t += 0.05) {
      expect(rideShake(t, 0, 1).dh).toBeCloseTo(0, 9);
      road = Math.max(road, Math.abs(rideShake(t, 20, 0).dh));
      dirt = Math.max(dirt, Math.abs(rideShake(t, 20, 1).dh));
    }
    expect(road).toBeGreaterThan(0);
    expect(road).toBeLessThan(0.01);
    expect(dirt).toBeGreaterThan(road * 4);
  });
});

describe('CameraRig driving modes', () => {
  it('defaults to chase while driving, cycles chase -> cockpit -> top, and keeps the on-foot mode', () => {
    const rig = new CameraRig();
    rig.footMode = 'first';
    rig.driveCam = 'chase';
    expect(rig.mode).toBe('first');
    rig.drive = view();
    expect(rig.mode).toBe('third'); // chase
    expect(rig.cycle()).toBe('first'); // cockpit
    expect(rig.driveCam).toBe('cockpit');
    expect(rig.cycle()).toBe('top');
    rig.drive = null;
    expect(rig.mode).toBe('first'); // on foot: untouched by the driving cycle
    rig.cycle();
    expect(rig.footMode).toBe('third');
    rig.drive = view();
    expect(rig.mode).toBe('top'); // the driving choice was remembered
  });

  it('cockpit camera sits at the driver eye and turns with the car', () => {
    const rig = new CameraRig();
    rig.snapRotation = false;
    rig.driveCam = 'cockpit';
    rig.drive = view({ heading: Math.PI / 2, eyeX: 3, eyeY: 4, eyeH: 1.22 });
    const player = { x: 3, y: 4, z: 0, yaw: Math.PI / 2, pitch: 0, crouching: false } as never;
    const map = { opaque: () => false, passable: () => true } as never;
    rig.update(1 / 60, player, map, 16 / 9, 360);
    expect(rig.camera.position.x).toBeCloseTo(3, 1);
    expect(rig.camera.position.z).toBeCloseTo(4, 1);
    expect(rig.camera.position.y).toBeCloseTo(1.22, 1);
    expect(rig.camera.fov).toBeGreaterThanOrEqual(70);
  });
});
