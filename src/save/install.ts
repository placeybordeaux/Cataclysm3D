import type { Game } from '../game/game';
import type { DebugApi } from '../debug';
import type { MonsterSystem } from '../game/monai';
import type { Spawner } from '../game/spawner';
import type { UiContext } from '../ui/context';
import { registerOption } from '../ui/options';
import { registerCoreSaveables } from './builtins';
import { SaveError, type SaveFile } from './format';
import { readSlot, SaveManager } from './manager';
import { registerSaveable } from './registry';
import { browserLocalStorage, IndexedDbBackend, MemoryBackend, type KVBackend } from './storage';
import { openLoadMenu, openMemorial, showLoadError } from './ui';

// Browser wiring for saves: game.save/load/hasSave for the menus, autosave, the unload
// fallback, permadeath, and the boot-time load.
//
// Loading a save whose world (seed/generator) differs from the running page's can't happen in
// place — the seed is baked into the Game — so load() stashes the slot in sessionStorage and
// reloads; main.ts calls takePendingLoad() before building the Game, builds the saved world,
// and applies the save instead of showing the title screen. Same-world loads apply in place.

const PENDING_KEY = 'cdda3d.pendingLoad';
const AUTOSAVE_KEY = 'cdda3d.autosaveHours';
const AUTOSAVE_CHOICES = [0, 1, 2, 6, 12, 24];

let backendSingleton: KVBackend | null = null;
/** The page's save storage: IndexedDB, or memory (saves vanish on reload) when unavailable. */
export function defaultBackend(): KVBackend {
  if (!backendSingleton) {
    if (IndexedDbBackend.available()) backendSingleton = new IndexedDbBackend();
    else {
      console.warn('IndexedDB unavailable: saves will not survive a reload');
      backendSingleton = new MemoryBackend();
    }
  }
  return backendSingleton;
}

export interface PendingLoad {
  slot: string;
  file: SaveFile | null;
  /** Why the file couldn't be read (shown after boot, with an offer to delete). */
  error?: string;
}

/**
 * Boot: a load requested before the last reload. Read it now so main.ts can build the Game
 * for the save's world. Consumes the request (a crash while loading won't loop).
 */
const HOT_KEY = 'cdda3d.hotReload';

export async function takePendingLoad(): Promise<PendingLoad | null> {
  // Dev only: Vite full-reloaded the page after a code edit; resume the snapshot taken just
  // before (see installSave), so editing code doesn't throw you back to the title screen.
  if (import.meta.hot) {
    try {
      // Not removed until the resumed game is running (startSession): another edit saved while
      // this boot is still loading reloads again, and must resume the same snapshot.
      const hot = sessionStorage.getItem(HOT_KEY);
      if (hot) {
        const file = JSON.parse(hot) as SaveFile;
        return { slot: file.meta.slot, file };
      }
    } catch (e) {
      sessionStorage.removeItem(HOT_KEY);
      console.warn(`hot-reload resume failed: ${(e as Error).message}`);
    }
  }
  let slot: string | null = null;
  try {
    slot = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    return null;
  }
  if (!slot) return null;
  try {
    return { slot, file: await readSlot(defaultBackend(), browserLocalStorage(), slot) };
  } catch (e) {
    return { slot, file: null, error: e instanceof SaveError ? e.message : `Unexpected error: ${(e as Error).message}` };
  }
}

export interface SaveHandle {
  manager: SaveManager;
  /** Boot: apply a pending load. Returns true when the game is running from the save. */
  applyPending(p: PendingLoad): Promise<boolean>;
  /** A character is now being played (new game started or save loaded). */
  startSession(): void;
  /** Leaving without saving (quit to title): no unload save. */
  endSession(): void;
}

const handles = new WeakMap<Game, SaveHandle>();
export const saveHandle = (game: Game): SaveHandle | undefined => handles.get(game);

/** Title screen "Memorial" entry. */
export function openMemorialFor(game: Game): void {
  const h = handles.get(game);
  if (h) void openMemorial(h.manager);
}

/** Quit to the title screen without the unload save (the Esc menu warns progress is lost). */
export function quitToTitle(game: Game): void {
  handles.get(game)?.endSession();
  location.reload();
}

export async function installSave(
  game: Game,
  opts: { api: DebugApi; genKind: string; worldgen: { resetPending(): void } | null; monsters: { sys: MonsterSystem; spawner: Spawner } | null },
): Promise<SaveHandle> {
  const { api } = opts;
  registerCoreSaveables(game, { monsters: opts.monsters, worldgen: opts.worldgen });
  const uiCtx = () => (api.ui as { ctx?: UiContext } | undefined)?.ctx;
  // Profession/scenario display names live in the UI context (chargen).
  registerSaveable<{ build: UiContext['build'] | null }>(game, 'ui', {
    order: 60,
    save: () => ({ build: uiCtx()?.build ?? null }),
    load: (d) => {
      const ctx = uiCtx();
      if (ctx) ctx.build = d.build ?? undefined;
    },
  });

  const mgr = new SaveManager(game, {
    backend: defaultBackend(),
    sync: browserLocalStorage(),
    gen: opts.genKind,
    build: () => uiCtx()?.build,
  });
  try {
    await mgr.refresh();
  } catch (e) {
    console.error('save list unavailable:', e);
  }

  try {
    const stored = Number(localStorage.getItem(AUTOSAVE_KEY));
    if (AUTOSAVE_CHOICES.includes(stored) && localStorage.getItem(AUTOSAVE_KEY) !== null) mgr.autosaveHours = stored;
  } catch {
    // storage blocked: default interval
  }
  mgr.installAutosave((ok, err) => {
    if (ok) game.message('Autosaved.', 'c_dark_gray');
    else game.message(`Autosave failed: ${(err as Error)?.message ?? err}`, 'c_light_red');
  });
  registerOption({
    name: 'Autosave',
    value: () => (mgr.autosaveHours ? `every ${mgr.autosaveHours} h` : 'off'),
    change: (d) => {
      const i = AUTOSAVE_CHOICES.indexOf(mgr.autosaveHours);
      mgr.autosaveHours = AUTOSAVE_CHOICES[(i + d + AUTOSAVE_CHOICES.length) % AUTOSAVE_CHOICES.length];
      try {
        localStorage.setItem(AUTOSAVE_KEY, String(mgr.autosaveHours));
      } catch {
        // not persisted
      }
    },
    desc: 'Save automatically every N in-game hours (a game day is about an hour of real time).',
  });

  const applyFile = (file: SaveFile): boolean => {
    try {
      const r = mgr.apply(file);
      game.message(`Welcome back, ${game.player.name}.`, 'c_light_gray');
      if (r.warnings.length) game.message(`The save loaded with ${r.warnings.length} problem(s); see the console.`, 'c_yellow');
      return true;
    } catch (e) {
      console.error(e);
      // Half-loaded: nothing sane to keep playing. Explain, then start over.
      void showLoadError(mgr, file.meta.slot, e instanceof SaveError ? e.message : `Unexpected error: ${(e as Error).message}`).then(() => location.reload());
      return false;
    }
  };

  /** Load a slot: in place when it's this page's world, otherwise via a reload. */
  const loadSlot = async (slot: string): Promise<boolean> => {
    let file: SaveFile;
    try {
      file = await mgr.read(slot);
    } catch (e) {
      await showLoadError(mgr, slot, e instanceof SaveError ? e.message : `Unexpected error: ${(e as Error).message}`);
      return false;
    }
    if (file.world.seed === game.seed && file.world.gen === opts.genKind) return applyFile(file);
    mgr.active = false;
    sessionStorage.setItem(PENDING_KEY, slot);
    location.reload();
    // The page is going away; never resolve so callers don't resume the old game meanwhile.
    return new Promise<boolean>(() => {});
  };

  game.save = async () => {
    await mgr.save();
    mgr.active = true;
  };
  game.load = async (slot?: string) => {
    await mgr.refresh().catch(() => undefined);
    const s = slot ?? (await openLoadMenu(mgr));
    return s ? loadSlot(s) : false;
  };
  game.hasSave = () => mgr.hasSave();

  // Page unload: synchronous fallback (see SaveManager.saveSync).
  const onUnload = () => {
    const n = mgr.saveSync();
    if (n) console.info(`unload save: ${n} bytes`);
  };
  window.addEventListener('pagehide', onUnload);

  // Dev only: snapshot the running game right before Vite reloads the page for a code edit.
  // Kept in sessionStorage (this tab only) and consumed by takePendingLoad on the next boot.
  if (import.meta.hot) {
    import.meta.hot.on('vite:beforeFullReload', () => {
      if (!mgr.active || game.player.dead) return;
      try {
        sessionStorage.setItem(HOT_KEY, JSON.stringify(mgr.snapshot(mgr.slot ?? 'hot-reload')));
      } catch (e) {
        console.warn(`hot-reload snapshot failed (game will restart): ${(e as Error).message}`);
      }
    });
  }

  const handle: SaveHandle = {
    manager: mgr,
    async applyPending(p) {
      if (!p.file) {
        await showLoadError(mgr, p.slot, p.error ?? 'The save could not be read.');
        return false;
      }
      return applyFile(p.file);
    },
    startSession() {
      if (import.meta.hot) sessionStorage.removeItem(HOT_KEY);
      mgr.active = !game.player.dead;
    },
    endSession() {
      mgr.active = false;
    },
  };
  handles.set(game, handle);

  api.save = {
    manager: mgr,
    /** Save now; resolves with the slot's metadata (sizes in bytes). */
    save: async () => {
      await game.save!();
      return mgr.slots[0];
    },
    list: async () => mgr.refresh(),
    /** Load a slot (in place if same world, else reloads the page). */
    load: (slot?: string) => loadSlot(slot ?? mgr.slot ?? mgr.slots[0]?.slot),
    /** Ask the next page load to load this slot (use with tools/shot.ts --reload). */
    queueLoad: (slot?: string) => {
      const s = slot ?? mgr.slot ?? mgr.slots[0]?.slot;
      if (!s) throw new Error('no save to queue');
      mgr.active = false;
      sessionStorage.setItem(PENDING_KEY, s);
      return s;
    },
    delete: (slot: string) => mgr.delete(slot),
    memorial: () => mgr.memorial(),
    openMemorial: () => openMemorial(mgr),
    /** Sizes of the last save and a fresh uncompressed snapshot. */
    stats: () => {
      const json = JSON.stringify(mgr.snapshot());
      const sections = Object.fromEntries(Object.entries(mgr.snapshot().sections).map(([k, v]) => [k, JSON.stringify(v).length]));
      return { last: mgr.last, snapshotBytes: json.length, sections, slot: mgr.slot, active: mgr.active };
    },
    unloadSave: () => mgr.saveSync(),
  };
  return handle;
}
