import { describe, expect, it } from 'vitest';
import { hotbarLabel } from '../src/ui2/hotbar';

describe('hotbar labels (QA_V2 #5: pre-bound slots were unlabeled icons)', () => {
  it('names a bound slot by its head noun, short enough to sit under the icon', () => {
    expect(hotbarLabel('long pointy stick')).toBe('stick');
    expect(hotbarLabel('bottle of water')).toBe('water');
    expect(hotbarLabel('chef knife')).toBe('knife');
    expect(hotbarLabel('smartphone (off)')).toBe('smartp…');
    expect(hotbarLabel('granola bar', 8)).toBe('bar');
    expect(hotbarLabel('flashlight')).toBe('flashl…');
    expect(hotbarLabel('bat')).toBe('bat');
  });
});
