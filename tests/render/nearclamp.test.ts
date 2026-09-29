import { describe, expect, it } from 'vitest';
import { nearClamp, NEAR_CLAMP } from '../../src/render/monsterView';

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
});
