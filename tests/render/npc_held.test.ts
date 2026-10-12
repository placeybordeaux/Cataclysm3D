import { describe, expect, it } from 'vitest';
import { npcOutfitKey } from '../../src/render/npcView';

describe('NPC held model refresh identity', () => {
  it('refreshes distinct items and empty hands even without wielded overlays', () => {
    const layers = ['npc_male'];
    expect(npcOutfitKey(layers, 'm4a1')).not.toBe(npcOutfitKey(layers));
    expect(npcOutfitKey(layers, 'm4a1')).not.toBe(npcOutfitKey(layers, 'ak47'));
    expect(npcOutfitKey(layers, 'm4a1')).toBe(npcOutfitKey([...layers], 'm4a1'));
  });
});
