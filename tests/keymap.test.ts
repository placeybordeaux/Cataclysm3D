import { describe, expect, it } from 'vitest';
import {
  addBinding, applyBinding, checkBinding, diffBindings, findConflicts, keyIndex, mergeBindings, movementChars, movementLabel,
  normalizeKey, QWERTY_MOVEMENT_CHARS, unreachableActions, withLayoutFallbacks,
} from '../src/ui/keymap';
import { DEFAULT_BINDINGS, Keys } from '../src/ui/keys';
import { lockLostAction, lockPaused, type LockLossState } from '../src/ui/pointer';
import type { Input } from '../src/core/input';

const AZERTY = new Map([['KeyQ', 'a'], ['KeyW', 'z'], ['KeyA', 'q'], ['KeyS', 's'], ['KeyD', 'd'], ['KeyZ', 'w'], ['KeyM', ',']]);
const DVORAK = new Map([['KeyW', ','], ['KeyA', 'a'], ['KeyS', 'o'], ['KeyD', 'e']]);

describe('normalizeKey', () => {
  const ev = (key: string, code: string, capsLock = false, shiftKey = false) => ({ key, code, capsLock, shiftKey });
  it('undoes CapsLock on letters (Caps+i is inventory, not I)', () => {
    expect(normalizeKey(ev('I', 'KeyI', true))).toBe('i');
    expect(normalizeKey(ev('e', 'KeyE', true, true))).toBe('E');
    expect(normalizeKey(ev('E', 'KeyE', false, true))).toBe('E');
  });
  it('leaves non-letters alone with CapsLock', () => {
    expect(normalizeKey(ev('&', 'Digit7', true))).toBe('&');
    expect(normalizeKey(ev('Escape', 'Escape', true))).toBe('Escape');
  });
  it('maps non-Latin letters to the Latin letter of the key (Russian layout)', () => {
    expect(normalizeKey(ev('ш', 'KeyI'))).toBe('i');
    expect(normalizeKey(ev('Ш', 'KeyI', false, true))).toBe('I');
  });
  it('keeps real punctuation on letter keys (AZERTY KeyM is ",")', () => {
    expect(normalizeKey(ev(',', 'KeyM'))).toBe(',');
  });
});

describe('keyboard layouts', () => {
  it('QWERTY: w a s d (and caps) and Space are movement', () => {
    expect(movementChars(null)).toEqual(new Set(QWERTY_MOVEMENT_CHARS));
    expect(movementLabel(null)).toBe('WASD');
  });
  it('AZERTY: z q s d are movement, labelled ZQSD', () => {
    const m = movementChars(AZERTY);
    for (const k of ['z', 'Z', 'q', 'Q', 's', 'd', ' ']) expect(m.has(k), k).toBe(true);
    expect(m.has('w')).toBe(false);
    expect(m.has('a')).toBe(false);
    expect(movementLabel(AZERTY)).toBe('ZQSD');
  });
  it('AZERTY: wield (z) and drop (q) get their QWERTY-position stand-ins w and a', () => {
    const blocked = movementChars(AZERTY);
    expect(unreachableActions(DEFAULT_BINDINGS, blocked).sort()).toEqual(['drop', 'wield']);
    const b = withLayoutFallbacks(DEFAULT_BINDINGS, blocked);
    expect(b.wield).toEqual(['z', 'w']);
    expect(b.drop).toEqual(['q', 'a']);
    expect(unreachableActions(b, blocked)).toEqual([]);
    expect(findConflicts(b)).toEqual([]);
  });
  it('QWERTY needs no stand-ins', () => {
    expect(withLayoutFallbacks(DEFAULT_BINDINGS, movementChars(null))).toEqual(DEFAULT_BINDINGS);
    expect(unreachableActions(DEFAULT_BINDINGS, movementChars(null))).toEqual([]);
  });
  it('Dvorak: e (interact) lands on a movement key and is reported', () => {
    expect(unreachableActions(DEFAULT_BINDINGS, movementChars(DVORAK))).toContain('interact');
  });
});

describe('bindings', () => {
  it('defaults are conflict-free', () => {
    expect(findConflicts(DEFAULT_BINDINGS)).toEqual([]);
    expect(() => keyIndex(DEFAULT_BINDINGS)).not.toThrow();
  });
  it('merge applies overrides, drops unknown ids and never moves the menu key', () => {
    const b = mergeBindings(DEFAULT_BINDINGS, { wear: ['W'], nosuch: ['y'], menu: ['p'] });
    expect(b.wear).toEqual(['W']);
    expect(b.nosuch).toBeUndefined();
    expect(b.menu).toEqual(['Escape']);
  });
  it('merge throws on a malformed override', () => {
    expect(() => mergeBindings(DEFAULT_BINDINGS, { wear: 'W' })).toThrow(/bad key binding/);
    expect(() => mergeBindings(DEFAULT_BINDINGS, { wear: [''] })).toThrow();
  });
  it('keyIndex throws on a key bound twice', () => {
    expect(() => keyIndex({ a: ['x'], b: ['x'] })).toThrow(/bound to both/);
  });
  it('diff stores only changes', () => {
    const b = applyBinding(DEFAULT_BINDINGS, 'wear', 'W');
    expect(diffBindings(DEFAULT_BINDINGS, b)).toEqual({ wear: ['W'] });
    expect(diffBindings(DEFAULT_BINDINGS, DEFAULT_BINDINGS)).toEqual({});
  });
  it('applyBinding moves a key from its old action; addBinding appends', () => {
    const b = applyBinding(DEFAULT_BINDINGS, 'wear', 'i');
    expect(b.wear).toEqual(['i']);
    expect(b.inventory).toEqual([]);
    const c = addBinding(DEFAULT_BINDINGS, 'pickup', 'y');
    expect(c.pickup).toEqual(['g', ',', 'y']);
    expect(findConflicts(c)).toEqual([]);
  });
});

describe('checkBinding', () => {
  const ev = (key: string, code: string, mods: { ctrlKey?: boolean; altKey?: boolean; altGraph?: boolean } = {}) => ({ key, code, ...mods });
  it('refuses movement keys by physical code and by character', () => {
    expect(checkBinding(DEFAULT_BINDINGS, 'wear', ev('W', 'KeyW'))).toMatchObject({ ok: false, reason: 'movement' });
    expect(checkBinding(DEFAULT_BINDINGS, 'wear', ev(' ', 'Space'))).toMatchObject({ ok: false, reason: 'movement' });
    expect(checkBinding(DEFAULT_BINDINGS, 'wear', ev('Shift', 'ShiftLeft'))).toMatchObject({ ok: false, reason: 'movement' });
    // AZERTY: "z" typed on physical W
    expect(checkBinding(DEFAULT_BINDINGS, 'wear', ev('z', 'KeyW'), movementChars(AZERTY))).toMatchObject({ ok: false, reason: 'movement' });
  });
  it('refuses keys every menu uses, and browser shortcuts', () => {
    for (const k of ['Escape', 'Backspace', 'Enter', 'Tab', 'ArrowUp']) expect(checkBinding(DEFAULT_BINDINGS, 'wear', ev(k, k))).toMatchObject({ ok: false, reason: 'reserved' });
    expect(checkBinding(DEFAULT_BINDINGS, 'wear', ev('q', 'KeyQ', { ctrlKey: true }))).toMatchObject({ ok: false, reason: 'modifier' });
  });
  it('allows AltGr characters (Ctrl+Alt on Windows)', () => {
    expect(checkBinding(DEFAULT_BINDINGS, 'wear', ev('{', 'Digit7', { ctrlKey: true, altKey: true, altGraph: true }))).toEqual({ ok: true });
  });
  it('never rebinds the menu key', () => {
    expect(checkBinding(DEFAULT_BINDINGS, 'menu', ev('p', 'KeyP'))).toMatchObject({ ok: false, reason: 'fixed' });
  });
  it('reports which action a taken key would be moved from', () => {
    expect(checkBinding(DEFAULT_BINDINGS, 'wear', ev('i', 'KeyI'))).toEqual({ ok: true, replaces: 'inventory' });
    expect(checkBinding(DEFAULT_BINDINGS, 'wear', ev('y', 'KeyY'))).toEqual({ ok: true });
  });
});

/** Keys against a stand-in Input: records the press handler, like the real one does. */
function fakeKeys() {
  let press: ((e: KeyboardEvent) => boolean | void) | null = null;
  const input = { keySeq: 0, onMovementKey: null, onPress: (h: (e: KeyboardEvent) => boolean | void) => (press = h) } as unknown as Input;
  const keys = new Keys(input);
  const fired: string[] = [];
  for (const id of Object.keys(DEFAULT_BINDINGS)) keys.register(id, id, () => fired.push(id));
  const send = (key: string, code: string, mods: Partial<KeyboardEvent> = {}) => {
    (input as { keySeq: number }).keySeq++;
    return press!({ key, code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, getModifierState: () => false, ...mods } as unknown as KeyboardEvent);
  };
  return { keys, input, fired, send };
}

describe('Keys dispatch', () => {
  it('movement keys never trigger actions, with or without Shift', () => {
    const { fired, send } = fakeKeys();
    send('W', 'KeyW', { shiftKey: true });
    send('a', 'KeyA');
    send(' ', 'Space');
    expect(fired).toEqual([]);
  });
  it('fires the bound action once; held-key repeats are swallowed', () => {
    const { fired, send } = fakeKeys();
    send('i', 'KeyI');
    expect(send('i', 'KeyI', { repeat: true })).toBe(true);
    expect(fired).toEqual(['inventory']);
  });
  it('ignores browser shortcuts but not AltGr characters', () => {
    const { fired, send } = fakeKeys();
    send('i', 'KeyI', { ctrlKey: true });
    send('@', 'KeyQ', { ctrlKey: true, altKey: true, getModifierState: ((m: string) => m === 'AltGraph') as KeyboardEvent['getModifierState'] });
    expect(fired).toEqual(['character']);
  });
  it('learns AZERTY from a movement press and adds the stand-ins', () => {
    const { keys, input, fired, send } = fakeKeys();
    expect(keys.keyFor('wield')).toBe('z');
    input.onMovementKey!('KeyW', 'z');
    input.onMovementKey!('KeyA', 'q');
    expect(keys.movementKeys()).toBe('ZQSD');
    expect(keys.keyFor('wield')).toBe('w');
    expect(keys.keyFor('drop')).toBe('a');
    send('w', 'KeyZ');
    send('a', 'KeyQ');
    expect(fired).toEqual(['wield', 'drop']);
  });
  it('rebinding takes effect and label() follows it', () => {
    const { keys, fired, send } = fakeKeys();
    keys.setBindings(applyBinding(keys.bindings(), 'wear', 'y'));
    expect(keys.label('wear')).toBe('y');
    send('O', 'KeyO', { shiftKey: true });
    send('y', 'KeyY');
    expect(fired).toEqual(['wear']);
    expect(() => keys.setBindings({ ...keys.bindings(), eat: ['y'] })).toThrow();
    keys.resetBindings();
    expect(keys.label('wear')).toBe('O');
    expect(keys.label('menu')).toBe('Esc');
  });
});

describe('pointer lock policy', () => {
  const base: LockLossState = { active: true, wantLock: true, locked: false, expected: false, sinceEscapeMs: Infinity, focused: true, windowOpen: false };
  it('an unlock in gameplay is the Esc the browser ate: open the pause menu', () => {
    expect(lockLostAction(base)).toBe('openMenu');
  });
  it('an unlock with a menu open closes that menu (Esc in the menu)', () => {
    expect(lockLostAction({ ...base, windowOpen: true })).toBe('closeTop');
  });
  it('focus loss pauses without touching menus', () => {
    expect(lockLostAction({ ...base, focused: false, windowOpen: true })).toBe('pause');
    expect(lockLostAction({ ...base, focused: false })).toBe('pause');
  });
  it('ignores unlocks we caused, ones the page already handled, and off-policy states', () => {
    expect(lockLostAction({ ...base, expected: true })).toBe('ignore');
    expect(lockLostAction({ ...base, sinceEscapeMs: 40 })).toBe('ignore');
    expect(lockLostAction({ ...base, wantLock: false })).toBe('ignore');
    expect(lockLostAction({ ...base, active: false })).toBe('ignore');
    expect(lockLostAction({ ...base, locked: true })).toBe('ignore');
  });
  it('pauses behind the resume hint only in gameplay without the lock and no menu', () => {
    const s = { active: true, wantLock: true, locked: false, captured: false };
    expect(lockPaused(s)).toBe(true);
    expect(lockPaused({ ...s, captured: true })).toBe(false);
    expect(lockPaused({ ...s, locked: true })).toBe(false);
    expect(lockPaused({ ...s, wantLock: false })).toBe(false);
  });
});
