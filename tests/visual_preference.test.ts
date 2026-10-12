import { afterEach, describe, expect, it, vi } from 'vitest';
import { visualPreference, storeVisualPreference } from '../src/render/visualPreference';
import { cutoutMipsOn, registerCutout, setCutoutMips } from '../src/render/cutoutMips';
import * as THREE from 'three';

afterEach(() => { vi.unstubAllGlobals(); setCutoutMips(true); });
describe('visual preferences', () => {
  it('persists defaults, validates stale stored values and gives session URL precedence', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    vi.stubGlobal('location', { search: '' });
    storeVisualPreference('props', 'billboard');
    expect(visualPreference('props', ['cards', 'billboard'], 'cards')).toBe('billboard');
    vi.stubGlobal('location', { search: '?props=cards' });
    expect(visualPreference('props', ['cards', 'billboard'], 'cards')).toBe('cards');
    expect(values.get('cdda3d.visual.props')).toBe('billboard');
    vi.stubGlobal('location', { search: '?props=bad' });
    expect(() => visualPreference('props', ['cards', 'billboard'], 'cards')).toThrow('expected cards|billboard');
    vi.stubGlobal('location', { search: '' });
    storeVisualPreference('props', 'retired');
    expect(visualPreference('props', ['cards', 'billboard'], 'cards')).toBe('cards');
  });
  it('works with storage blocked', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(() => storeVisualPreference('props', 'cards')).not.toThrow();
    expect(visualPreference('props', ['cards', 'billboard'], 'cards')).toBe('cards');
  });
  it('applies the selected cutout mode to textures created after the switch', () => {
    setCutoutMips(false);
    const texture = new THREE.Texture();
    registerCutout(texture);
    expect(cutoutMipsOn()).toBe(false);
    expect(texture.minFilter).toBe(THREE.NearestFilter);
    setCutoutMips(true);
    expect(texture.minFilter).toBe(THREE.NearestMipmapNearestFilter);
  });
});
