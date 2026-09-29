// The survivor's own map marks: notes placed on the map (right-click on the map screen) and
// one destination the compass points to. Saved with the character (section 'mapnotes').
// UI-free; the map screen (overmap_ui.ts) edits it and the HUD compass reads it.

import type { Game } from '../game/game';
import { registerSaveable } from '../save/registry';

export interface MapNote {
  /** OMT coordinates. */
  x: number;
  y: number;
  z: number;
  text: string;
  /** Marker style: CDDA-like note glyphs. */
  kind: 'note' | 'danger' | 'loot' | 'home';
}

export interface MapMarks {
  notes: MapNote[];
  /** OMT the compass points at; null = none. */
  destination: { x: number; y: number; z: number; label: string } | null;
}

const marks = new WeakMap<Game, MapMarks>();

export function mapMarks(game: Game): MapMarks {
  let m = marks.get(game);
  if (!m) marks.set(game, (m = { notes: [], destination: null }));
  return m;
}

export function noteAt(game: Game, x: number, y: number, z: number): MapNote | undefined {
  return mapMarks(game).notes.find((n) => n.x === x && n.y === y && n.z === z);
}

/** Add or replace the note on an OMT (empty text removes it). */
export function setNote(game: Game, note: MapNote): void {
  const m = mapMarks(game);
  m.notes = m.notes.filter((n) => !(n.x === note.x && n.y === note.y && n.z === note.z));
  if (note.text.trim()) m.notes.push({ ...note, text: note.text.trim().slice(0, 80) });
}

export function removeNote(game: Game, x: number, y: number, z: number): void {
  const m = mapMarks(game);
  m.notes = m.notes.filter((n) => !(n.x === x && n.y === y && n.z === z));
}

const KINDS = new Set(['note', 'danger', 'loot', 'home']);

export function installMapMarks(game: Game): void {
  registerSaveable<MapMarks>(game, 'mapnotes', {
    order: 72,
    save: () => {
      const m = mapMarks(game);
      return { notes: m.notes.map((n) => ({ ...n })), destination: m.destination && { ...m.destination } };
    },
    load: (j, ctx) => {
      const m = mapMarks(game);
      m.notes = [];
      for (const n of j.notes ?? []) {
        if (typeof n?.x !== 'number' || typeof n.y !== 'number' || typeof n.text !== 'string') {
          ctx.warn(`mapnotes: dropped a malformed note ${JSON.stringify(n)}`);
          continue;
        }
        m.notes.push({ x: n.x, y: n.y, z: n.z ?? 0, text: n.text, kind: KINDS.has(n.kind) ? n.kind : 'note' });
      }
      m.destination = j.destination && typeof j.destination.x === 'number' ? { ...j.destination } : null;
    },
    missing: () => {
      const m = mapMarks(game);
      m.notes = [];
      m.destination = null;
    },
  });
}
