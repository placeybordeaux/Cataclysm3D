import type { Game } from '../game/game';
import { SECONDS_PER_DAY } from '../core/time';
import { applySave, decodeSave, encodeJson, encodeSave, SaveError, serializeGame, storedSize, type ApplyResult, type SaveFile, type SaveMeta, type StoredSave } from './format';
import type { KVBackend, SyncStorage } from './storage';
import { runAchievementNames } from '../game/achievements';

// Slots, saving, loading, permadeath and the memorial. Platform-agnostic: storage is a
// KVBackend (IndexedDB in the browser, in-memory in tests) plus an optional synchronous
// store for the page-unload fallback. Browser wiring (menus, reloads) is in install.ts.
//
// Keys in the backend:
//   meta/<slot>   SaveMeta (small; listed on the title screen without decompressing)
//   save/<slot>   StoredSave (gzip bytes or JSON text)
//   memorial      MemorialEntry[] (dead characters, newest last)

export interface MemorialEntry {
  name: string;
  profession?: string;
  scenario?: string;
  male?: boolean;
  cause: string;
  /** Game seconds survived. */
  survived: number;
  kills: number;
  /** Top kills: [monster id, count]. */
  topKills: [string, number][];
  /** Monster id -> display name, for the memorial screen. */
  killNames?: Record<string, string>;
  /** metres */
  distance: number;
  /** "Spring, day 3 14:05" at death. */
  gameTime: string;
  /** Date.now() at death. */
  diedAt: number;
  seed: number;
  /** Achievements completed during this life (names). */
  achievements?: string[];
}

export interface SaveManagerOptions {
  backend: KVBackend;
  /** Synchronous last-resort store (localStorage) for saving on page unload. */
  sync?: SyncStorage | null;
  /** World generator kind ('world' | 'test'), recorded so a load rebuilds the same world. */
  gen: string;
  /** Profession / scenario names chosen at character creation (UI state). */
  build?: () => { profession?: string; scenario?: string } | undefined;
  compress?: boolean;
}

const EMERGENCY_META = 'cdda3d.emergency.meta';
const EMERGENCY_DATA = 'cdda3d.emergency.data';

export class SaveManager {
  /** Slot of the running character; null until its first save (or after death). */
  slot: string | null = null;
  /** A character is being played (autosave and unload saves apply). */
  active = false;
  /** Cached slot list (hasSave() must answer synchronously for the menus). */
  slots: SaveMeta[] = [];
  /** Last save's sizes, for diagnostics (cdda.save.stats()). */
  last: { bytes: number; rawBytes: number; ms: number; chunks: number } | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly game: Game, readonly opts: SaveManagerOptions) {
    game.events.on('playerDied', (e) => void this.onDeath(e.cause));
  }

  get backend(): KVBackend {
    return this.opts.backend;
  }

  /** Serialize operations: two overlapping saves must not interleave their writes. */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  hasSave(): boolean {
    return this.slots.length > 0;
  }

  async refresh(): Promise<SaveMeta[]> {
    await this.recoverEmergency();
    const keys = await this.backend.keys('meta/');
    const metas: SaveMeta[] = [];
    for (const k of keys) {
      const m = await this.backend.get<SaveMeta>(k);
      if (m) metas.push(m);
    }
    metas.sort((a, b) => b.savedAt - a.savedAt);
    this.slots = metas;
    // Unload-time saves are stored as plain JSON (gzip is async); compress them now.
    for (const m of metas) if (this.opts.compress !== false && m.rawBytes && m.bytes === m.rawBytes) void this.compact(m.slot).catch(() => undefined);
    return metas;
  }

  private compact(slot: string): Promise<void> {
    return this.queue(async () => {
      const stored = await this.backend.get<StoredSave>(`save/${slot}`);
      const meta = await this.backend.get<SaveMeta>(`meta/${slot}`);
      if (stored?.enc !== 'json' || !meta) return;
      const enc = await encodeJson(stored.data);
      if (enc.stored.enc !== 'gzip') return;
      await this.backend.put(`save/${slot}`, enc.stored);
      const m2 = { ...meta, bytes: storedSize(enc.stored) };
      await this.backend.put(`meta/${slot}`, m2);
      this.slots = this.slots.map((x) => (x.slot === slot ? m2 : x));
    });
  }

  newSlotId(): string {
    const name = this.game.player.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'survivor';
    return `${name}-${this.game.seed}-${Date.now().toString(36)}`;
  }

  private meta(slot: string): Omit<SaveMeta, 'version' | 'savedAt' | 'seed' | 'day' | 'time'> {
    const p = this.game.player;
    const b = this.opts.build?.();
    return { slot, name: p.name, profession: b?.profession, male: p.male, gen: this.opts.gen };
  }

  /** Snapshot the game now (synchronous), without writing it anywhere. */
  snapshot(slot = this.slot ?? this.newSlotId()): SaveFile {
    return serializeGame(this.game, this.meta(slot));
  }

  /** Save the running character to its slot (creating one on first save). */
  save(): Promise<SaveMeta> {
    if (this.game.player.dead) return Promise.reject(new SaveError('The dead cannot save.'));
    const t0 = performance.now();
    // Snapshot synchronously so the saved state is the state at the moment of the request.
    this.slot ??= this.newSlotId();
    const file = this.snapshot(this.slot);
    return this.queue(async () => {
      const { stored, rawBytes } = await encodeSave(file, { compress: this.opts.compress });
      const meta: SaveMeta = { ...file.meta, bytes: storedSize(stored), rawBytes };
      // Data before meta: a listed slot always has its data.
      await this.backend.put(`save/${meta.slot}`, stored);
      await this.backend.put(`meta/${meta.slot}`, meta);
      this.clearEmergency(meta.slot);
      const chunks = (file.sections.map as { chunks?: unknown[] } | undefined)?.chunks?.length ?? 0;
      this.last = { bytes: meta.bytes!, rawBytes, ms: performance.now() - t0, chunks };
      this.slots = [meta, ...this.slots.filter((m) => m.slot !== meta.slot)];
      return meta;
    });
  }

  /** Read and validate a slot's save. Throws SaveError. */
  read(slot: string): Promise<SaveFile> {
    return readSlot(this.backend, this.opts.sync ?? null, slot);
  }

  /** Apply an already read save to this game and make its slot current. */
  apply(file: SaveFile): ApplyResult {
    const r = applySave(this.game, file);
    this.slot = file.meta.slot;
    this.active = true;
    return r;
  }

  async delete(slot: string): Promise<void> {
    await this.queue(async () => {
      await this.backend.delete(`meta/${slot}`);
      await this.backend.delete(`save/${slot}`);
    });
    this.clearEmergency(slot);
    this.slots = this.slots.filter((m) => m.slot !== slot);
  }

  // ---------------------------------------------------------------- permadeath & memorial

  async memorial(): Promise<MemorialEntry[]> {
    return (await this.backend.get<MemorialEntry[]>('memorial')) ?? [];
  }

  /** CDDA deletes a dead character's save and adds them to the memorial. */
  async onDeath(cause: string): Promise<void> {
    const wasActive = this.active;
    this.active = false;
    const slot = this.slot;
    this.slot = null;
    if (slot) await this.delete(slot);
    // A character that never started (title screen backdrop) isn't memorialized.
    if (!wasActive && !slot) return;
    const g = this.game;
    const stats = g.stats;
    const b = this.opts.build?.();
    const top = Object.entries(stats.kills).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const entry: MemorialEntry = {
      name: g.player.name, profession: b?.profession, scenario: b?.scenario, male: g.player.male, cause,
      survived: g.clock.seconds - stats.startSeconds, kills: stats.totalKills(), topKills: top,
      killNames: Object.fromEntries(top.map(([id]) => [id, g.data.monsters[id]?.name ?? id])),
      distance: stats.distanceWalked, gameTime: g.clock.format(), diedAt: Date.now(), seed: g.seed,
    };
    const ach = runAchievementNames.get(g)?.();
    if (ach?.length) entry.achievements = ach;
    await this.queue(async () => {
      const list = await this.memorial();
      list.push(entry);
      await this.backend.put('memorial', list);
    });
  }

  // ---------------------------------------------------------------- page unload fallback

  /**
   * Best-effort synchronous save for page unload: IndexedDB writes may not finish before the
   * page dies, so the uncompressed JSON also goes to localStorage, and the next boot moves it
   * into IndexedDB if it's newer. Returns the JSON size, or 0 when nothing was written.
   */
  saveSync(): number {
    if (!this.active || this.game.player.dead) return 0;
    this.slot ??= this.newSlotId();
    const file = this.snapshot(this.slot);
    const json = JSON.stringify(file);
    // Kick off the real save too; it wins if the page lives long enough.
    void this.queue(async () => {
      await this.backend.put(`save/${file.meta.slot}`, { enc: 'json', data: json } satisfies StoredSave);
      await this.backend.put(`meta/${file.meta.slot}`, { ...file.meta, bytes: json.length, rawBytes: json.length });
    }).catch(() => undefined);
    const sync = this.opts.sync;
    if (!sync) return 0;
    try {
      sync.setItem(EMERGENCY_DATA, json);
      sync.setItem(EMERGENCY_META, JSON.stringify({ ...file.meta, bytes: json.length, rawBytes: json.length }));
      return json.length;
    } catch (e) {
      // Over quota (~5 MB): the IndexedDB write above is all we have.
      console.warn(`unload save: localStorage fallback failed for ${json.length} bytes: ${(e as Error).message}`);
      this.clearEmergency(file.meta.slot);
      return 0;
    }
  }

  private clearEmergency(slot: string): void {
    const sync = this.opts.sync;
    if (!sync) return;
    try {
      const m = sync.getItem(EMERGENCY_META);
      if (m && (JSON.parse(m) as SaveMeta).slot !== slot) return;
      sync.removeItem(EMERGENCY_META);
      sync.removeItem(EMERGENCY_DATA);
    } catch {
      // corrupt entry: drop it
      sync.removeItem(EMERGENCY_META);
      sync.removeItem(EMERGENCY_DATA);
    }
  }

  recoverEmergency(): Promise<void> {
    return recoverEmergency(this.backend, this.opts.sync ?? null);
  }

  // ---------------------------------------------------------------- autosave

  /** Game hours between autosaves; 0 = off. */
  autosaveHours = 6;
  private sinceAutosave = 0;

  /** Adds the autosave system; `onSaved` gets each autosave's result (UI message). */
  installAutosave(onSaved?: (ok: boolean, err?: unknown) => void): void {
    this.game.systems.push({
      name: 'autosave',
      update: (_g, _dt, gameDt) => {
        if (!this.active || this.autosaveHours <= 0) {
          this.sinceAutosave = 0;
          return;
        }
        this.sinceAutosave += gameDt;
        if (this.sinceAutosave < this.autosaveHours * 3600) return;
        this.sinceAutosave = 0;
        this.save().then(() => onSaved?.(true), (e) => onSaved?.(false, e));
      },
    });
  }
}

/** Days survived, for lists. */
export const daysOf = (seconds: number) => seconds / SECONDS_PER_DAY;

/** Read and validate a slot's save (after recovering an unload-time copy). Throws SaveError. */
export async function readSlot(backend: KVBackend, sync: SyncStorage | null, slot: string): Promise<SaveFile> {
  await recoverEmergency(backend, sync);
  const stored = await backend.get<StoredSave>(`save/${slot}`);
  if (!stored) throw new SaveError(`No save data for "${slot}".`, 'missing');
  const file = await decodeSave(stored);
  if (file.meta.slot !== slot) throw new SaveError(`The save in slot "${slot}" claims to be "${file.meta.slot}".`);
  return file;
}

/** Move an unload-time save from localStorage into the backend if it is the newest copy. */
export async function recoverEmergency(backend: KVBackend, sync: SyncStorage | null): Promise<void> {
  if (!sync) return;
  const rawMeta = sync.getItem(EMERGENCY_META);
  const data = sync.getItem(EMERGENCY_DATA);
  const drop = () => {
    sync.removeItem(EMERGENCY_META);
    sync.removeItem(EMERGENCY_DATA);
  };
  if (!rawMeta || !data) {
    if (rawMeta || data) drop();
    return;
  }
  let meta: SaveMeta;
  try {
    meta = JSON.parse(rawMeta);
  } catch {
    return drop();
  }
  const cur = await backend.get<SaveMeta>(`meta/${meta.slot}`);
  if (!cur || cur.savedAt < meta.savedAt) {
    await backend.put(`save/${meta.slot}`, { enc: 'json', data } satisfies StoredSave);
    await backend.put(`meta/${meta.slot}`, meta);
  }
  drop();
}
