import { describe, expect, it } from 'vitest';
import { recipeName } from '../src/game/crafting';

describe('recipe names', () => {
  it('fill CDDA "%s" names with the result (the crafting list showed "%s in jar")', () => {
    const data = { items: { dogfood: { id: 'dogfood', name: { str: 'dog food' } } } } as never;
    expect(recipeName(data, { id: 'x', name: '%s in jar', result: 'dogfood' } as never)).toBe('dog food in jar');
    expect(recipeName(data, { id: 'y', name: 'plain', result: 'dogfood' } as never)).toBe('plain');
  });
});
