// How ui2 plugs into whatever hosts it: the 3D game (src/ui2/install.ts) or the standalone
// showcase page. ui2 counts its open "surfaces" (windows, modals, menus opened from gameplay);
// the first one activates the host (game: free the cursor, route keys to ui2, maybe pause),
// the last one deactivates it (game: re-capture the mouse). Keys go through one router:
// topmost handler first (menu > modal > drag > top window), then global shortcuts.

export interface Ui2Host {
  /** First surface opened: start sending keydowns to `route` (true = handled). */
  activate(route: (e: KeyboardEvent) => boolean): void;
  /** Last surface closed. */
  deactivate(): void;
  /** Whether a pausing surface (inventory-type window) is open and the settings want a pause. */
  setPaused(paused: boolean): void;
}

export interface Ui2Settings {
  /** Tactical pause while inventory-type windows are open (the Accessible preset's default). */
  pauseInInventory: boolean;
  /** The v1 letter-list inventory screens instead of the ui2 ones (Options > "Inventory screens"). */
  classicInventory?: boolean;
}

const SETTINGS_KEY = 'cdda3d.ui2.settings';
export const settings: Ui2Settings = { pauseInInventory: true, ...loadSettings() };

function loadSettings(): Partial<Ui2Settings> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Ui2Settings>;
  } catch {
    return {};
  }
}
export function saveSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // not persisted
  }
  updatePause();
}

let host: Ui2Host | null = null;
const surfaces = new Set<{ pauses: boolean }>();
type KeyHandler = (e: KeyboardEvent) => boolean;
const keyStack: KeyHandler[] = [];
const shortcuts = new Map<string, (e: KeyboardEvent) => void>();
let active = false;

export function setHost(h: Ui2Host): void {
  if (host && active) host.deactivate();
  host = h;
  active = false;
  if (surfaces.size) activate();
}

/** A standalone page (showcase): ui2 keys straight from the document, no cursor juggling. */
export function standaloneHost(): Ui2Host {
  window.addEventListener('keydown', (e) => {
    // Typing in a count field: only Esc/Enter belong to ui2.
    if (e.target instanceof HTMLInputElement && e.key !== 'Escape' && e.key !== 'Enter') return;
    if (routeKey(e)) e.preventDefault();
  });
  return { activate: () => {}, deactivate: () => {}, setPaused: () => {} };
}

/** Register an open surface; call the returned function when it closes. */
export function acquireSurface(opts: { pauses?: boolean } = {}): () => void {
  const s = { pauses: !!opts.pauses };
  surfaces.add(s);
  if (!active) activate();
  updatePause();
  return () => {
    if (!surfaces.delete(s)) return;
    updatePause();
    if (!surfaces.size && active) {
      active = false;
      host?.deactivate();
    }
  };
}

export function surfacesOpen(): number {
  return surfaces.size;
}

function activate(): void {
  if (!host) return;
  active = true;
  host.activate(routeKey);
}

function updatePause(): void {
  const want = settings.pauseInInventory && [...surfaces].some((s) => s.pauses);
  host?.setPaused(want);
}

let overlays = 0;

/**
 * Push a key handler on top; returns a remover. `overlay` marks keyboard-modal things (menus,
 * dialogs, drags): while one is up, widgets with their own element-level key handling (lists,
 * grids, tabs) must leave keys alone — check overlayOpen() — or a focused list would eat the
 * arrows meant for the context menu over it.
 */
export function pushKeys(fn: KeyHandler, opts: { overlay?: boolean } = {}): () => void {
  keyStack.push(fn);
  if (opts.overlay) overlays++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (opts.overlay) overlays--;
    const i = keyStack.lastIndexOf(fn);
    if (i >= 0) keyStack.splice(i, 1);
  };
}

export function overlayOpen(): boolean {
  return overlays > 0;
}

/**
 * Global ui2 shortcut, e.g. shortcut('Tab', toggleInventory). Used when no window/menu handled
 * the key. `e.key` values; one handler per key.
 */
export function shortcut(key: string, fn: (e: KeyboardEvent) => void): () => void {
  if (shortcuts.has(key)) throw new Error(`ui2 shortcut ${key} already taken`);
  shortcuts.set(key, fn);
  return () => shortcuts.delete(key);
}

export function routeKey(e: KeyboardEvent): boolean {
  for (let i = keyStack.length - 1; i >= 0; i--) if (keyStack[i](e)) return true;
  const s = shortcuts.get(e.key);
  if (s && !e.repeat) {
    s(e);
    return true;
  }
  // While ui2 owns the keyboard, gameplay keys do nothing (you can't swing while dragging).
  return active;
}
