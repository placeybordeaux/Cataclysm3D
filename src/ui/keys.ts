import type { Input } from '../core/input';

// Single source of truth for key bindings. Systems register *actions* by id; the default
// key for each action lives in DEFAULT_BINDINGS below so conflicts are visible in one place
// and the `?` help screen can list everything. Keys are KeyboardEvent.key values (so "E" means
// shift+e), except movement which uses held physical codes in Game.
//
// First-person movement owns the physical W/A/S/D keys *with or without Shift* (Shift = run,
// so Shift+W is "run forward", never "W"), plus Space. CDDA actions on those letters move:
// wield w→"z", wear W→"O", activate a/A→"u"… see comments on each entry.

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
  throw: ['G'], // CDDA 't' throw
  look: ['x'],
  flashlight: ['F'],
  stairs_up: ['<'],
  stairs_down: ['>'],
  crouch: ['c'],
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
};

/** Physical keys reserved for movement; they never trigger actions, whatever the modifiers. */
export const MOVEMENT_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight']);

export class Keys {
  private actions = new Map<string, Action>();
  private byKey = new Map<string, string>();
  /**
   * The key of the last triggered action and the input.keySeq it happened at. A window opened
   * before any other key is pressed (screens may open a frame later, after loading icons)
   * closes on that same key again — i opens and closes the inventory — so players don't need
   * Esc, which in a browser also releases the captured mouse.
   */
  static opening: { key: string; seq: number } | null = null;
  private static input: Input | null = null;
  /** The opening key for a window being created now, or null. */
  static openingKey(): string | null {
    const o = Keys.opening;
    return o && Keys.input && o.seq === Keys.input.keySeq ? o.key : null;
  }

  constructor(input: Input) {
    Keys.input = input;
    for (const [id, keys] of Object.entries(DEFAULT_BINDINGS)) for (const k of keys) this.byKey.set(k, id);
    input.onPress((e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      if (MOVEMENT_CODES.has(e.code)) return false;
      const id = this.byKey.get(e.key);
      const a = id && this.actions.get(id);
      if (!a) return false;
      Keys.opening = { key: e.key, seq: input.keySeq };
      a.handler();
      return true;
    });
  }

  /** Register the handler for an action id listed in DEFAULT_BINDINGS (throws if unlisted). */
  register(id: string, name: string, handler: () => void): void {
    if (!DEFAULT_BINDINGS[id]) throw new Error(`Action ${id} has no entry in DEFAULT_BINDINGS (src/ui/keys.ts)`);
    this.actions.set(id, { id, name, handler });
  }

  /** For the help screen: [keys, name] for every registered action. */
  list(): [string[], string][] {
    return [...this.actions.values()].map((a) => [DEFAULT_BINDINGS[a.id], a.name]);
  }

  /** Whether some system registered a handler for the action. */
  has(id: string): boolean {
    return this.actions.has(id);
  }

  /** The handler currently registered for an action (to wrap it, e.g. `e` talking to NPCs). */
  handler(id: string): (() => void) | undefined {
    return this.actions.get(id)?.handler;
  }

  keyFor(id: string): string {
    return DEFAULT_BINDINGS[id]?.[0] ?? '?';
  }
}
