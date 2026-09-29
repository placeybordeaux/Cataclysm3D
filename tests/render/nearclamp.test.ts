import { describe, expect, it } from 'vitest';
import { MELEE_AIM, meleeAimLift, nearClamp, NEAR_CLAMP } from '../../src/render/monsterView';

describe('point-blank sprite clamp', () => {
  const cam = { x: 10, y: 1.6, z: 20 }; // three.js coords: x, height, tile y

  it('leaves sprites beyond the clamp distance alone', () => {
    expect(nearClamp(cam, 10, 20 - NEAR_CLAMP.dist - 0.01, 0)).toEqual({ scale: 1, lift: 0 });
  });

  it('projects a close sprite exactly like the same sprite pushed back to the clamp distance', () => {
    const d = 0.6, H = 1.75;
    const { scale, lift } = nearClamp(cam, 10, 20 - d, 0);
    // Angle (from the eye) to the sprite's top and foot must equal those at NEAR_CLAMP.
    const angle = (h: number, dist: number) => Math.atan2(h - cam.y, dist);
    expect(angle(lift + H * scale, d)).toBeCloseTo(angle(H, NEAR_CLAMP.dist), 6);
    expect(angle(lift, d)).toBeCloseTo(angle(0, NEAR_CLAMP.dist), 6);
  });

  it('puts the upper chest of a creature at arm\'s length on the crosshair (eye level)', () => {
    const d = 0.9, H = 1.75;
    const aim = meleeAimLift(d, cam.y, H);
    expect(aim).toBeGreaterThan(0);
    const { scale, lift } = nearClamp(cam, 10, 20 - d, aim);
    // drawn point at MELEE_AIM.frac of the height, as monsterView composes it
    const y = aim + lift + H * MELEE_AIM.frac * scale;
    expect(y).toBeCloseTo(cam.y, 6);
  });

  it('fades the aim lift out before the feet come into view', () => {
    expect(meleeAimLift(MELEE_AIM.none, 1.6, 1.75)).toBe(0);
    expect(meleeAimLift(5, 1.6, 1.75)).toBe(0);
    expect(meleeAimLift(1.8, 1.6, 1.75)).toBeLessThan(meleeAimLift(1.0, 1.6, 1.75));
    // a crouched eye over a tall creature: no negative lift
    expect(meleeAimLift(1, 1.0, 2.3)).toBe(0);
  });
});
