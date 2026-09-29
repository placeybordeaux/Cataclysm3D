import { describe, expect, it } from 'vitest';
import { proxySprites } from '../../src/render/monsterView';

describe('stand-in sprites for monsters without tileset art', () => {
  it('maps zombie variants to their kind, then to a generic zombie', () => {
    expect(proxySprites('mon_zombie_soldier_camo_1', 'Z', ['ZOMBIE', 'HUMAN'])[0]).toBe('mon_zombie_soldier');
    expect(proxySprites('mon_zombie_nurse', 'Z', ['ZOMBIE', 'HUMAN'])[0]).toBe('mon_zombie_medical');
    expect(proxySprites('mon_zombie_dancer', 'Z', ['ZOMBIE', 'HUMAN'])).toEqual(['mon_zombie']);
  });
  it('uses a giant cousin for small critters and a species silhouette otherwise', () => {
    expect(proxySprites('mon_spider_wolf', '.', ['SPIDER'])).toEqual(['mon_spider_wolf_giant']);
    expect(proxySprites('mon_tankbot', 'R', ['ROBOT'])[0]).toBe('mon_riotbot');
    expect(proxySprites('mon_feral_prepper', '@', ['HUMAN'])[0]).toBe('mon_feral_human_pipe');
  });
  it('keeps the glyph for debug monsters', () => {
    expect(proxySprites('debug_mon', 'X', ['DEBUG'])).toEqual([]);
  });
});
