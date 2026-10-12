import { describe, expect, it } from 'vitest';
import { ItemGesture, gestureClass } from '../../src/render/chars/itemGesture';

const action = { kind: 'eat' as const, item: { typeId: 'food', def: {} as never, isGun: () => false }, moves: 100 };
describe('cosmetic item gesture lifecycle', () => {
  it('waits for menus, lifts then restores without touching the real item', () => {
    const g = new ItemGesture();
    g.start(action);
    expect(g.update(5, true)).toBe(action);
    expect(g.elapsed).toBe(0);
    g.update(.6, false);
    expect(g.lift).toBeCloseTo(1);
    expect(g.update(.61, false)).toBeNull();
    expect(action.item.typeId).toBe('food');
  });
  it('replaces a queued gesture and clears pending actions on loading', () => {
    const g = new ItemGesture();
    g.start(action); g.update(.4, false);
    const next = { ...action, kind: 'drink' as const };
    g.start(next);
    expect(g.elapsed).toBe(0);
    expect(g.action).toBe(next);
    g.clear();
    expect(g.update(.1, false)).toBeNull();
  });
});

it('food keywords cannot turn a chocolate bar into a weapon', () => {
  expect(gestureClass({ typeId: 'chocolate', def: { name: 'chocolate bar' } }, 'eat')).toBe('generic');
  expect(gestureClass({ typeId: 'flashlight' }, 'use')).toBe('flashlight');
});
