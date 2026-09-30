// Pure key-binding logic (no DOM, unit-tested in tests/keymap.test.ts): which KeyboardEvent.key
// value an event stands for, which characters a keyboard layout puts on the movement keys,
// merging the player's rebinds over the defaults, and whether a new binding is allowed.
// src/ui/keys.ts wires this to the game; src/ui/keybind_ui.ts is the editor.

export type Bindings = Record<string, string[]>;

/** Physical keys reserved for movement; they never trigger actions, whatever the modifiers. */
export const MOVEMENT_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight']);

/**
 * Keys the UI itself owns: every window closes on Esc/Backspace (and `close_menu`, Space), lists move with the arrows,
 * Enter confirms, Tab switches tabs. Binding an action to one of them would make it fire only
 * in gameplay and do something else in every menu, so the editor refuses them.
 */
export const RESERVED_KEYS = new Set([
  'Escape', 'Backspace', 'Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Home', 'End', 'Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock',
  'Dead', 'Unidentified', 'Process', 'F12',
]);

/**
 * Actions that only mean something inside menus (`close_menu`, default Space). They live in the
 * same bindings table so Options > Key bindings can rebind them, but they never dispatch in
 * gameplay and don't conflict with gameplay keys: Space is the side-step on foot *and* closes
 * every menu, the same way Backspace already did. Closing with Esc is what we avoid advertising:
 * outside fullscreen the browser takes Esc to release the captured mouse.
 */
export const MENU_ACTIONS = new Set(['close_menu']);

/** Actions whose key can't be changed (the pause menu must stay on Esc so nobody gets locked in). */
export const FIXED_ACTIONS = new Set(['menu']);

/** What US QWERTY puts on the movement keys; used until the browser reports the real layout. */
export const QWERTY_MOVEMENT_CHARS = new Set(['w', 'a', 's', 'd', 'W', 'A', 'S', 'D', ' ']);

/**
 * Characters produced by the movement keys on a layout (from navigator.keyboard.getLayoutMap(),
 * which maps code → unshifted character: AZERTY gives KeyW→"z", KeyA→"q"). Letters also block
 * their uppercase (Shift is run, so Shift+Z on AZERTY is run-forward).
 */
export function movementChars(layout: ReadonlyMap<string, string> | null): Set<string> {
  if (!layout || layout.size === 0) return new Set(QWERTY_MOVEMENT_CHARS);
  const out = new Set<string>([' ']);
  for (const code of MOVEMENT_CODES) {
    const ch = layout.get(code);
    if (!ch) continue;
    out.add(ch);
    out.add(ch.toLowerCase());
    out.add(ch.toUpperCase());
  }
  return out;
}

/** Label for the four movement keys on this layout, forward/left/back/right: "WASD", "ZQSD". */
export function movementLabel(layout: ReadonlyMap<string, string> | null): string {
  if (!layout || layout.size === 0) return 'WASD';
  const k = ['KeyW', 'KeyA', 'KeyS', 'KeyD'].map((c) => layout.get(c));
  if (k.some((x) => !x || x.length !== 1)) return 'WASD';
  return k.join('').toUpperCase();
}

export interface KeyEventLike {
  key: string;
  code: string;
  shiftKey: boolean;
  /** e.getModifierState('CapsLock') */
  capsLock: boolean;
}

/**
 * The key an event should count as for bindings and menu hotkeys:
 * - CapsLock flips letter case back (with CapsLock on, `i` arrives as "I", which is a different
 *   CDDA action; Shift+letter with CapsLock arrives lowercase and means the uppercase one);
 * - a non-Latin letter (Cyrillic, Greek…) on a KeyX key becomes that Latin letter, so players
 *   on those layouts still have every letter command.
 */
export function normalizeKey(e: KeyEventLike): string {
  const k = e.key;
  if (k.length !== 1) return k;
  if (/^[a-zA-Z]$/.test(k)) {
    if (!e.capsLock) return k;
    return k === k.toLowerCase() ? k.toUpperCase() : k.toLowerCase();
  }
  const m = /^Key([A-Z])$/.exec(e.code);
  // Only letters: punctuation on a Key* code (AZERTY's KeyM is ",") is the real character.
  if (m && k.toLowerCase() !== k.toUpperCase() && k.charCodeAt(0) > 127) return e.shiftKey ? m[1] : m[1].toLowerCase();
  return k;
}

/** Short display name for a key value. */
export function keyLabel(k: string): string {
  const names: Record<string, string> = {
    Escape: 'Esc', ' ': 'Space', Backspace: 'Bksp', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Enter: 'Enter', Delete: 'Del', Insert: 'Ins',
  };
  return names[k] ?? k;
}

/**
 * Defaults with the player's rebinds on top. Overrides for actions that no longer exist (an
 * old save of the settings) are dropped; an override that is not a list of strings is a bug in
 * whoever wrote it, so it throws.
 */
export function mergeBindings(defaults: Bindings, overrides: Record<string, unknown>): Bindings {
  const out: Bindings = {};
  for (const [id, keys] of Object.entries(defaults)) out[id] = [...keys];
  for (const [id, keys] of Object.entries(overrides)) {
    if (!(id in defaults) || FIXED_ACTIONS.has(id)) continue;
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || !k)) throw new Error(`bad key binding for ${id}: ${JSON.stringify(keys)}`);
    out[id] = [...(keys as string[])];
  }
  return out;
}

/** Only the entries that differ from the defaults (what gets stored). */
export function diffBindings(defaults: Bindings, current: Bindings): Bindings {
  const out: Bindings = {};
  for (const [id, keys] of Object.entries(current)) {
    const d = defaults[id] ?? [];
    if (keys.length !== d.length || keys.some((k, i) => k !== d[i])) out[id] = [...keys];
  }
  return out;
}

/** key → action id. Throws on a key bound to two actions (bindings must be conflict-free). */
export function keyIndex(b: Bindings): Map<string, string> {
  const m = new Map<string, string>();
  for (const [id, keys] of Object.entries(b)) {
    if (MENU_ACTIONS.has(id)) continue; // their own scope: see menuKeyCheck
    for (const k of keys) {
      const prev = m.get(k);
      if (prev && prev !== id) throw new Error(`key ${JSON.stringify(k)} is bound to both ${prev} and ${id}`);
      m.set(k, id);
    }
  }
  return m;
}

/** Every key bound to more than one action. */
export function findConflicts(b: Bindings): { key: string; actions: string[] }[] {
  const by = new Map<string, string[]>();
  for (const [id, keys] of Object.entries(b)) if (!MENU_ACTIONS.has(id)) for (const k of new Set(keys)) by.set(k, [...(by.get(k) ?? []), id]);
  return [...by].filter(([, ids]) => ids.length > 1).map(([key, actions]) => ({ key, actions }));
}

export type BindCheck =
  | { ok: true; replaces?: string }
  | { ok: false; reason: 'fixed' | 'reserved' | 'movement' | 'modifier'; message: string };

/**
 * Can `key` (from a keydown with physical `code`) be bound to action `id`? A key already used
 * by another action is allowed and reported in `replaces` — the editor moves it, like CDDA's
 * keybinding screen asks to.
 */
export function checkBinding(
  b: Bindings,
  id: string,
  ev: { key: string; code: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; altGraph?: boolean },
  blockedChars: ReadonlySet<string> = QWERTY_MOVEMENT_CHARS,
): BindCheck {
  if (FIXED_ACTIONS.has(id)) return { ok: false, reason: 'fixed', message: 'This action always uses Esc.' };
  if (MENU_ACTIONS.has(id)) return menuKeyCheck(b, id, ev);
  if (MOVEMENT_CODES.has(ev.code) || blockedChars.has(ev.key))
    return { ok: false, reason: 'movement', message: 'That key moves you (movement keys, Space and Shift never trigger actions).' };
  if ((ev.ctrlKey || ev.altKey || ev.metaKey) && !ev.altGraph)
    return { ok: false, reason: 'modifier', message: 'Ctrl/Alt/Meta combinations belong to the browser.' };
  if (RESERVED_KEYS.has(ev.key)) return { ok: false, reason: 'reserved', message: `${keyLabel(ev.key)} is used by every menu.` };
  for (const [other, keys] of Object.entries(b)) if (other !== id && !MENU_ACTIONS.has(other) && keys.includes(ev.key)) return { ok: true, replaces: other };
  return { ok: true };
}

/**
 * A menu-only action's key: Space (a movement key in play) is fine, but not a letter or digit
 * (every menu's hotkeys: the close key would pick an entry instead) nor a key menus already use
 * (Esc/Bksp close anyway, arrows move, Enter picks) nor the tactical pause, which runs first.
 */
function menuKeyCheck(b: Bindings, id: string, ev: { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; altGraph?: boolean }): BindCheck {
  if ((ev.ctrlKey || ev.altKey || ev.metaKey) && !ev.altGraph)
    return { ok: false, reason: 'modifier', message: 'Ctrl/Alt/Meta combinations belong to the browser.' };
  if (/^[\p{L}\p{N}]$/u.test(ev.key)) return { ok: false, reason: 'reserved', message: 'Menus use letters and digits as hotkeys; pick Space or a symbol key.' };
  if (RESERVED_KEYS.has(ev.key)) return { ok: false, reason: 'reserved', message: `${keyLabel(ev.key)} is used by every menu.` };
  if ((b.tactical_pause ?? []).includes(ev.key)) return { ok: false, reason: 'reserved', message: `${keyLabel(ev.key)} is the tactical pause, which works inside menus.` };
  for (const [other, keys] of Object.entries(b)) if (other !== id && MENU_ACTIONS.has(other) && keys.includes(ev.key)) return { ok: true, replaces: other };
  return { ok: true };
}

/** Whether two actions compete for keys (gameplay actions with each other, menu actions with each other). */
const sameScope = (a: string, b: string) => MENU_ACTIONS.has(a) === MENU_ACTIONS.has(b);

/** Bind `key` as the only key of `id`, taking it away from any other action. Returns a new map. */
export function applyBinding(b: Bindings, id: string, key: string): Bindings {
  const out: Bindings = {};
  for (const [other, keys] of Object.entries(b)) out[other] = other === id ? [key] : sameScope(id, other) ? keys.filter((k) => k !== key) : [...keys];
  return out;
}

/** Add `key` as an extra key for `id` (taken away from any other action). Returns a new map. */
export function addBinding(b: Bindings, id: string, key: string): Bindings {
  const out: Bindings = {};
  for (const [other, keys] of Object.entries(b)) out[other] = other === id ? [...keys.filter((k) => k !== key), key] : sameScope(id, other) ? keys.filter((k) => k !== key) : [...keys];
  return out;
}

/**
 * Where a layout puts an action's default key on a movement key (AZERTY: `z` wield and `q` drop
 * sit on the physical W and A), these keys stand in — each is the QWERTY letter at the same
 * physical spot, which is free on those layouts because W/A there aren't movement keys.
 */
export const LAYOUT_ALTERNATES: Record<string, string> = { wield: 'w', drop: 'a' };

/**
 * Bindings with layout stand-ins added: an action left with no reachable key gets its
 * LAYOUT_ALTERNATES key, when that key is itself reachable and unused.
 */
export function withLayoutFallbacks(b: Bindings, blocked: ReadonlySet<string>): Bindings {
  const out: Bindings = {};
  for (const [id, keys] of Object.entries(b)) out[id] = [...keys];
  const used = new Set(Object.values(b).flat());
  for (const [id, alt] of Object.entries(LAYOUT_ALTERNATES)) {
    const keys = out[id];
    if (!keys || keys.some((k) => !blocked.has(k)) || blocked.has(alt) || used.has(alt)) continue;
    keys.push(alt);
    used.add(alt);
  }
  return out;
}

/** Actions none of whose keys can be pressed on this layout (shown as a warning / in red). */
export function unreachableActions(b: Bindings, blocked: ReadonlySet<string>): string[] {
  // Menu actions are pressed inside menus, where movement keys (Space) are free.
  return Object.entries(b).filter(([id, keys]) => !MENU_ACTIONS.has(id) && !keys.some((k) => !blocked.has(k))).map(([id]) => id);
}
