// BN diggability comes from digging_results, not DDA's DIGGABLE flag (wave-3 playtest).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isDiggable } from '../src/world/registry';

const terrain = JSON.parse(readFileSync(new URL('../public/data/terrain.json', import.meta.url), 'utf8'));

describe('isDiggable (BN ter_t::is_diggable)', () => {
  it('grass and dirt are diggable; pavement and walls are not', () => {
    expect(isDiggable(terrain.t_grass)).toBe(true);
    expect(isDiggable(terrain.t_dirt)).toBe(true);
    expect(isDiggable(terrain.t_pavement)).toBe(false);
    expect(isDiggable(terrain.t_brick_wall)).toBe(false);
  });
  it('the old flag still counts', () => {
    expect(isDiggable({ flags: ['DIGGABLE'] })).toBe(true);
    expect(isDiggable({ flags: [] })).toBe(false);
  });
});
