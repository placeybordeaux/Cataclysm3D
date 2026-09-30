import type { Input } from '../core/input';
import { setCloseKeys } from '../ui2/host';
import {
  MENU_ACTIONS, diffBindings, keyIndex, keyLabel, mergeBindings, movementChars, movementLabel, MOVEMENT_CODES, QWERTY_MOVEMENT_CHARS,
  unreachableActions, withLayoutFallbacks, type Bindings,
} from './keymap';

// Single source of truth for key bindings. Systems register *actions* by id; the default
// key for each action lives in DEFAULT_BINDINGS below so conflicts are visible in one place
// and the `?` help screen can list everything. Keys are KeyboardEvent.key values (so "E" means
// shift+e), except movement which uses held physical codes in Game.
//
// First-person movement owns the physical W/A/S/D keys *with or without Shift* (Shift = run,
// so Shift+W is "run forward", never "W"), plus Space. CDDA actions on those letters move:
// wield w→"z", wear W→"O", activate a/A→"u"… see comments on each entry.
//
// Players can rebind any action but `menu` (Options > Key bindings, src/ui/keybind_ui.ts);
// their changes are stored in localStorage as a diff over these defaults. On layouts where a
// default key sits on a movement key (AZERTY's z and q) a stand-in is added (keymap.ts
// LAYOUT_ALTERNATES). Everything that shows a key to the player must ask keyFor()/label().

export { MOVEMENT_CODES } from './keymap';

export interface Action {
  id: string;
  /** Human description for the help screen, CDDA wording where it exists. */
  name: string;
  handler: () => void;
}

export const DEFAULT_BINDINGS: Record<string, string[]> = {
  // --- world interaction ---
  interact: ['e'], // CDDA 'e' examine; also opens/closes doors under the crosshair
  pickup: ['g', ','],
  drop: ['q'], // CDDA 'd' (taken by strafe)
  fire: ['f'], // CDDA 'f' fire (also LMB when wielding a gun)
  reload: ['r'],
  unload: ['U'],
  throw: ['t'], // CDDA/BN 't' throw (was G here until grab took BN's G)
  grab: ['G'], // BN 'G' grab: drag furniture / push carts by walking (src/grab.ts)
  look: ['x'],
  flashlight: ['F'],
  stairs_up: ['<'],
  stairs_down: ['>'],
  crouch: ['c'], // also cruise control while driving (src/ui/vehicle_ui.ts)
  camera_mode: ['v'],
  butcher: ['B'],
  smash: ['X'], // CDDA 's' smash (taken by move back)
  // --- menus ---
  inventory: ['i'],
  wield: ['z'], // CDDA 'w'
  wear: ['O'], // CDDA 'W' (Shift+W is run-forward)
  takeoff: ['T'],
  eat: ['E'],
  apply: ['u'], // CDDA 'a' activate (a/A are strafe / run-strafe)
  read: ['R'],
  craft: ['&'],
  construct: ['*'],
  disassemble: ['('],
  character: ['@'],
  map: ['m'],
  messages: ['P'],
  wait: ['|'],
  sleep: ['$'],
  help: ['?'],
  menu: ['Escape'],
  save: ['F5'], // quicksave (Shift+S is run-backward)
  fullscreen: ['F11'], // fullscreen with keyboard lock, so Esc no longer drops mouse capture
  // --- vehicles (src/ui/vehicle_ui.ts); WASD/Space drive while at the controls ---
  control_vehicle: ['^'], // CDDA '^': take the controls / vehicle controls menu
  vehicle_engine: ['k'], // ignition (CDDA controls menu 's')
  vehicle_headlights: ['h'], // CDDA controls menu 'h'
  vehicle_horn: ['n'], // CDDA controls menu 'n'
  chat: ['C'], // CDDA 'C' chat: talk to nearby NPCs / order followers
  missions: ['M'], // CDDA 'M' mission log
  // --- body modifications (src/ui/mutbio_ui.ts) ---
  bionics: ['p'], // CDDA 'p' view/activate bionics
  mutations: ['['], // CDDA '[' view/activate mutations
  // --- combat depth (src/combatdepth.ts) ---
  martial_arts: ['_'], // CDDA '_' pick a martial arts style
  fire_mode: ['b'], // CDDA 'F' select_fire_mode (F is the flashlight here)
  // --- scores (src/ui/achievements_ui.ts) ---
  achievements: [')'], // CDDA ')' diary / achievements / scores
  // --- ui2 (src/ui2/install.ts, src/ui2/bn): mouse-first inventory ---
  inventory2: ['Tab'],
  // hotbar slots in gameplay (src/ui2/bn/install.ts): use / wield / eat what's bound there
  hotbar_1: ['1'], hotbar_2: ['2'], hotbar_3: ['3'], hotbar_4: ['4'], hotbar_5: ['5'],
  hotbar_6: ['6'], hotbar_7: ['7'], hotbar_8: ['8'], hotbar_9: ['9'], hotbar_0: ['0'],
  world_menu: ['o'], // context menu for what's under the crosshair (RMB is guard/aim while captured)
  // --- tactical pause (src/pause.ts): works in menus too; Space is the side-step, P the message log ---
  tactical_pause: ['`', 'Pause'],
  // --- progression (src/progression): tips, recipes, places, unlock progress ---
  journal: ['J'],
  // --- performance overlay (src/perf/install.ts): Shift+F3 saves the last 60 s ---
  perf_overlay: ['F3'],
  // --- inside menus only (keymap.ts MENU_ACTIONS): never fires in gameplay, where Space side-steps ---
  close_menu: [' '], // closes the top window/menu; advertised instead of Esc, which frees the mouse
};

/** localStorage key for the player's rebinds (a diff over DEFAULT_BINDINGS). */
export const KEYS_STORAGE = 'cdda3d.keys';

function loadOverrides(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(KEYS_STORAGE);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class Keys {
  private actions = new Map<string, Action>();
  /** The player's bindings (defaults + rebinds), before layout stand-ins. */
  private user: Bindings;
  /** What actually dispatches: user bindings plus layout stand-ins. */
  private effective: Bindings = {};
  private byKey = new Map<string, string>();
  /** Characters the current layout puts on movement keys (never actions). */
  private blocked: Set<string> = new Set(QWERTY_MOVEMENT_CHARS);
  private layout: Map<string, string> | null = null;
  /** Called after bindings or the detected layout change (HUD prompts re-read keyFor()). */
  onChange: (() => void) | null = null;
  /**
   * The key of the last triggered action and the input.keySeq it happened at. A window opened
   * before any other key is pressed (screens may open a frame later, after loading icons)
   * closes on that same key again — i opens and closes the inventory — so players don't need
   * Esc, which in a browser also releases the captured mouse.
   */
  static opening: { key: string; seq: number } | null = null;
  /** Open key-binding screens: while > 0, keys that work inside menus (tactical pause) don't. */
  static rebinding = 0;
  private static input: Input | null = null;
  /** The game's bindings (legacy windows read the close key from here). */
  static current: Keys | null = null;
  /** Keys that close menus besides Esc/Bksp/the opening key (`close_menu`, Space by default). */
  static closeKeys(): string[] {
    return Keys.current ? Keys.current.keysFor('close_menu') : [' '];
  }
  /** The opening key for a window being created now, or null. */
  static openingKey(): string | null {
    const o = Keys.opening;
    return o && Keys.input && o.seq === Keys.input.keySeq ? o.key : null;
  }

  constructor(input: Input) {
    Keys.input = input;
    let over: Record<string, unknown> = {};
    try {
      over = loadOverrides();
      this.user = mergeBindings(DEFAULT_BINDINGS, over);
      keyIndex(this.user);
    } catch (e) {
      // Stored rebinds that don't parse or conflict: say so and use the defaults rather than
      // guessing which half of a conflict the player meant.
      console.warn(`ignoring stored key bindings: ${(e as Error).message}`);
      this.user = mergeBindings(DEFAULT_BINDINGS, {});
    }
    this.rebuild();
    this.register('close_menu', 'Close the menu or window (as do the key that opened it and Bksp)', () => {});
    Keys.current = this;
    setCloseKeys(() => this.keysFor('close_menu'));
    input.onPress((e) => {
      // AltGr (Ctrl+Alt on Windows) types @ [ | on many layouts: that's a character, not a shortcut.
      if ((e.ctrlKey || e.metaKey || e.altKey) && !e.getModifierState?.('AltGraph')) return false;
      if (MOVEMENT_CODES.has(e.code)) return false;
      // Holding a key must not re-fire it: a held `i` would flicker the inventory open/shut.
      if (e.repeat) return this.byKey.has(e.key);
      const id = this.byKey.get(e.key);
      const a = id && this.actions.get(id);
      if (!a) return false;
      Keys.opening = { key: e.key, seq: input.keySeq };
      a.handler();
      return true;
    });
    // Learn the layout from movement presses too (Firefox has no getLayoutMap): an AZERTY
    // player's first step forward tells us "z" is a movement key.
    input.onMovementKey = (code, key) => {
      if (key.length !== 1 || this.layout?.get(code) === key.toLowerCase()) return;
      this.setLayout(new Map([...(this.layout ?? QWERTY_LAYOUT), [code, key.toLowerCase()]]));
    };
  }

  /** Ask the browser for the keyboard layout (Chrome/Edge); harmless no-op elsewhere. */
  async detectLayout(): Promise<void> {
    const kb = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
    if (!kb?.getLayoutMap) return;
    try {
      const m = await kb.getLayoutMap();
      this.setLayout(new Map(m));
    } catch {
      // not allowed in this frame / browser: keep the QWERTY assumption
    }
  }

  /** Use this layout (code → unshifted character) for movement labels and blocked keys. */
  setLayout(layout: Map<string, string>): void {
    this.layout = layout;
    this.blocked = movementChars(layout);
    this.rebuild();
  }

  private rebuild(): void {
    this.effective = withLayoutFallbacks(this.user, this.blocked);
    this.byKey = keyIndex(this.effective);
    for (const k of this.blocked) this.byKey.delete(k);
    this.onChange?.();
  }

  /** Register the handler for an action id listed in DEFAULT_BINDINGS (throws if unlisted). */
  register(id: string, name: string, handler: () => void): void {
    if (!DEFAULT_BINDINGS[id]) throw new Error(`Action ${id} has no entry in DEFAULT_BINDINGS (src/ui/keys.ts)`);
    this.actions.set(id, { id, name, handler });
  }

  /** The registered action for an id (lets a system layer a context-dependent meaning over
   *  an existing key, like C = cruise control while driving, crouch on foot). */
  action(id: string): Action | undefined {
    return this.actions.get(id);
  }

  /** For the help screen: [reachable keys, name] for every registered action. */
  list(): [string[], string][] {
    return [...this.actions.values()].map((a) => [this.keysFor(a.id), a.name]);
  }

  /** [id, name] of every registered action, in DEFAULT_BINDINGS order (the rebinding screen). */
  actionList(): { id: string; name: string }[] {
    return Object.keys(DEFAULT_BINDINGS).filter((id) => this.actions.has(id)).map((id) => ({ id, name: this.actions.get(id)!.name }));
  }

  /** Whether some system registered a handler for the action. */
  has(id: string): boolean {
    return this.actions.has(id);
  }

  /** The handler currently registered for an action (to wrap it, e.g. `e` talking to NPCs). */
  handler(id: string): (() => void) | undefined {
    return this.actions.get(id)?.handler;
  }

  /** Keys that trigger the action on this keyboard (unreachable ones left out). */
  keysFor(id: string): string[] {
    // Menu actions are pressed inside menus, where the movement keys (Space) are free.
    return (this.effective[id] ?? []).filter((k) => MENU_ACTIONS.has(id) || !this.blocked.has(k));
  }

  /** The key to show for an action, e.g. in "[e] Open door"; '?' when it has none. */
  keyFor(id: string): string {
    return this.keysFor(id)[0] ?? '?';
  }

  /** keyFor() as a display label ("Esc", "Space"…); "unbound" when nothing triggers it. */
  label(id: string): string {
    const k = this.keysFor(id)[0];
    return k === undefined ? 'unbound' : keyLabel(k);
  }

  /** "WASD", or the letters at those positions on this layout ("ZQSD" on AZERTY). */
  movementKeys(): string {
    return movementLabel(this.layout);
  }

  /** Characters on movement keys for the current layout. */
  blockedChars(): ReadonlySet<string> {
    return this.blocked;
  }

  /** Current bindings as the player set them (for the editor). */
  bindings(): Bindings {
    return Object.fromEntries(Object.entries(this.user).map(([id, k]) => [id, [...k]]));
  }

  /** Registered actions with no key the player can press. */
  unreachable(): string[] {
    return unreachableActions(this.effective, this.blocked).filter((id) => this.actions.has(id));
  }

  /** Replace all bindings (validated: throws on conflicts) and persist the diff. */
  setBindings(b: Bindings): void {
    keyIndex(b);
    this.user = mergeBindings(DEFAULT_BINDINGS, b);
    try {
      const diff = diffBindings(DEFAULT_BINDINGS, this.user);
      if (Object.keys(diff).length) localStorage.setItem(KEYS_STORAGE, JSON.stringify(diff));
      else localStorage.removeItem(KEYS_STORAGE);
    } catch {
      // storage blocked: bindings last for this session only
    }
    this.rebuild();
  }

  resetBindings(): void {
    this.setBindings(mergeBindings(DEFAULT_BINDINGS, {}));
  }
}

/** US QWERTY letters at the movement positions (the starting guess for the layout map). */
const QWERTY_LAYOUT: ReadonlyMap<string, string> = new Map([['KeyW', 'w'], ['KeyA', 'a'], ['KeyS', 's'], ['KeyD', 'd']]);
