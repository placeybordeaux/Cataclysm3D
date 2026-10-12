import type { Game } from '../game/game';
import { WORLDGEN_VERSION } from '../world/overmap/overmap';
import { saveRegistry, type LoadContext } from './registry';

// The save file: versioned JSON, one section per registered saveable (src/save/registry.ts),
// gzip-compressed when the platform has CompressionStream.
//
// Version history:
//   1  initial format

export const SAVE_FORMAT = 'cdda3d-save';
export const SAVE_VERSION = 1;
/** Oldest version this build can read (bump when dropping a migration). */
export const MIN_SAVE_VERSION = 1;

/** Shown in slot lists without decompressing the save. */
export interface SaveMeta {
  slot: string;
  name: string;
  profession?: string;
  male?: boolean;
  seed: number;
  gen: string;
  /** Overmap generation version (world/overmap/overmap.ts WORLDGEN_VERSION); absent = 1. */
  genVersion?: number;
  /** Days since the cataclysm (game clock). */
  day: number;
  /** "Spring, day 3 14:05" */
  time: string;
  /** Date.now() at save. */
  savedAt: number;
  version: number;
  /** Stored size in bytes (compressed if compressed). */
  bytes?: number;
  /** Uncompressed JSON length. */
  rawBytes?: number;
}

export interface SaveFile {
  format: typeof SAVE_FORMAT;
  version: number;
  meta: SaveMeta;
  world: { seed: number; gen: string; genVersion?: number };
  sections: Record<string, unknown>;
}

/** A save that can't be used; `message` is meant for the player. */
export class SaveError extends Error {
  constructor(message: string, readonly kind: 'corrupt' | 'version' | 'world' | 'missing' = 'corrupt') {
    super(message);
    this.name = 'SaveError';
  }
}

export function serializeGame(game: Game, meta: Omit<SaveMeta, 'version' | 'savedAt' | 'seed' | 'day' | 'time'> & { savedAt?: number }): SaveFile {
  const sections: Record<string, unknown> = {};
  for (const [key, s] of saveRegistry(game).sorted()) sections[key] = s.save();
  const clock = game.clock;
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    meta: { ...meta, seed: game.seed, day: clock.day, time: clock.format(), savedAt: meta.savedAt ?? Date.now(), version: SAVE_VERSION },
    world: { seed: game.seed, gen: meta.gen, genVersion: meta.genVersion },
    sections,
  };
}

/** Structural checks; throws SaveError with a player-facing message. */
export function validateSaveFile(f: unknown): SaveFile {
  if (!f || typeof f !== 'object') throw new SaveError('The save file is empty or not JSON.');
  const s = f as Partial<SaveFile>;
  if (s.format !== SAVE_FORMAT) throw new SaveError('This is not a CDDA-3D save file.');
  if (typeof s.version !== 'number') throw new SaveError('The save file has no version number.');
  if (s.version > SAVE_VERSION)
    throw new SaveError(`This save was made by a newer version of the game (save format v${s.version}; this build reads up to v${SAVE_VERSION}).`, 'version');
  if (s.version < MIN_SAVE_VERSION)
    throw new SaveError(`This save is too old to load (save format v${s.version}; oldest supported is v${MIN_SAVE_VERSION}).`, 'version');
  if (!s.world || typeof s.world.seed !== 'number' || typeof s.world.gen !== 'string') throw new SaveError('The save file has no world information.');
  const gv = s.world.genVersion;
  if (gv !== undefined && (!Number.isInteger(gv) || gv < 1)) throw new SaveError('The save file has a broken world version.');
  if (gv !== undefined && gv > WORLDGEN_VERSION)
    throw new SaveError(`This save's world was made by a newer version of the game (world v${gv}; this build makes up to v${WORLDGEN_VERSION}).`, 'version');
  if (!s.sections || typeof s.sections !== 'object') throw new SaveError('The save file has no game data.');
  if (!s.meta || typeof s.meta.slot !== 'string') throw new SaveError('The save file has no slot information.');
  return s as SaveFile;
}

export interface ApplyResult {
  warnings: string[];
}

/**
 * Load a save into `game`, which must be built for the same world (seed). Every registered
 * saveable is restored in load order; sections for systems this build doesn't have are
 * skipped with a warning. Throws SaveError; after a throw the game may be half-loaded, so
 * callers should start over (reload the page) rather than keep playing.
 */
export function applySave(game: Game, file: SaveFile): ApplyResult {
  validateSaveFile(file);
  if (file.world.seed !== game.seed) throw new SaveError(`This save belongs to world ${file.world.seed}, but the game was built for world ${game.seed}.`, 'world');
  const warnings: string[] = [];
  const seen = new Set<string>();
  const ctx: LoadContext = {
    game,
    data: game.data,
    version: file.version,
    warn: (msg) => {
      if (seen.has(msg)) return;
      seen.add(msg);
      warnings.push(msg);
    },
  };
  const reg = saveRegistry(game);
  // Nothing half-finished carries over: CDDA also drops the current activity on load.
  if (game.activities.current) game.activities.current = null;
  game.clock.warp = 1;
  for (const [key, s] of reg.sorted()) {
    try {
      if (key in file.sections) s.load(file.sections[key], ctx);
      else s.missing?.(ctx);
    } catch (e) {
      if (e instanceof SaveError) throw e;
      throw new SaveError(`The save's "${key}" data could not be loaded: ${(e as Error).message}`);
    }
  }
  for (const key of Object.keys(file.sections)) if (!reg.has(key)) ctx.warn(`save section "${key}" ignored (no such system in this build)`);
  if (warnings.length) console.warn(`save loaded with ${warnings.length} warning(s):\n  ${warnings.join('\n  ')}`);
  game.events.emit('gameLoaded', { slot: file.meta.slot });
  return { warnings };
}

// ------------------------------------------------------------------ bytes

export type StoredSave = { enc: 'gzip'; data: Uint8Array } | { enc: 'json'; data: string };

const hasCompression = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined' && typeof Response !== 'undefined';

async function pipe(bytes: BufferSource, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const body = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export async function encodeSave(file: SaveFile, opts: { compress?: boolean } = {}): Promise<{ stored: StoredSave; rawBytes: number }> {
  return encodeJson(JSON.stringify(file), opts);
}

export async function encodeJson(json: string, opts: { compress?: boolean } = {}): Promise<{ stored: StoredSave; rawBytes: number }> {
  if (opts.compress === false || !hasCompression()) return { stored: { enc: 'json', data: json }, rawBytes: json.length };
  const data = await pipe(new TextEncoder().encode(json), new CompressionStream('gzip'));
  return { stored: { enc: 'gzip', data }, rawBytes: json.length };
}

export async function decodeSave(stored: StoredSave | null | undefined): Promise<SaveFile> {
  if (!stored) throw new SaveError('The save data is missing.', 'missing');
  let json: string;
  try {
    if (stored.enc === 'gzip') {
      if (!hasCompression()) throw new Error('this browser cannot decompress gzip saves');
      // Browsers report a bad gzip stream as e.g. "Failed to fetch"; say what it means.
      const bytes = await pipe(stored.data as Uint8Array<ArrayBuffer>, new DecompressionStream('gzip')).catch(() => {
        throw new Error('the compressed data is corrupt or truncated');
      });
      json = new TextDecoder().decode(bytes);
    } else if (stored.enc === 'json') json = stored.data;
    else throw new Error(`unknown encoding ${(stored as { enc?: string }).enc}`);
  } catch (e) {
    throw new SaveError(`The save data is damaged (${(e as Error).message}).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new SaveError(`The save data is damaged (${(e as Error).message}).`);
  }
  return validateSaveFile(parsed);
}

export function storedSize(s: StoredSave): number {
  return s.enc === 'gzip' ? s.data.byteLength : s.data.length;
}
