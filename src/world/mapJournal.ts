import { CHUNK } from './coords';
import type { Chunk, Field, GameMap, MapItem } from './map';

// Debug-only undo for map edits (the style gallery, src/gallery): its scenes plant trees in a
// field, light fires, drop loot and leave corpses on the street, and the next scene must not
// find them there. While a journal is open, the first edit to an existing chunk (outside
// mapgen: generating a chunk writes through the same methods) snapshots its terrain,
// furniture, items and fields; `rollback` puts every touched chunk back as it was.
// Items are restored by list (not through moves.ts): items a scene created are simply dropped,
// which is fine for a debug page but would break item conservation anywhere else.

interface Snap {
  chunk: Chunk;
  ter: Uint16Array;
  furn: Uint16Array;
  items: [number, MapItem[]][];
  fields: [number, Field[]][];
}

const MUTATORS = ['setTer', 'setFurn', 'addItem', 'insertItemAt', 'removeItem', 'addField'] as const;

export interface MapJournal {
  /** Undo every edit since the journal opened (or the last rollback); keeps journaling. */
  rollback(): number;
  /** Stop journaling (the map methods go back to the originals). */
  close(): void;
}

export function openMapJournal(map: GameMap): MapJournal {
  const snaps = new Map<Chunk, Snap>();
  let generating = 0;
  const gen = map.generator;
  const origGenerate = gen?.generate;
  if (gen && origGenerate)
    gen.generate = (m, c) => {
      generating++;
      try {
        origGenerate.call(gen, m, c);
      } finally {
        generating--;
      }
    };
  const floor = (v: number) => Math.floor(v / CHUNK);
  const touch = (x: number, y: number, z: number) => {
    if (generating) return;
    const cx = floor(x), cy = floor(y);
    if (!map.hasChunk(cx, cy, z)) return; // the original call generates it: pristine
    const c = map.chunk(cx, cy, z)!;
    if (snaps.has(c)) return;
    snaps.set(c, {
      chunk: c, ter: c.ter.slice(), furn: c.furn.slice(),
      items: [...c.items].map(([k, l]) => [k, [...l]]),
      fields: [...c.fields].map(([k, l]) => [k, l.map((f) => ({ ...f }))]),
    });
  };
  const m = map as unknown as Record<string, (...a: unknown[]) => unknown>;
  const originals = new Map<string, (...a: unknown[]) => unknown>();
  for (const name of MUTATORS) {
    const orig = m[name];
    originals.set(name, orig);
    m[name] = function (this: unknown, x: unknown, y: unknown, z: unknown, ...rest: unknown[]) {
      touch(x as number, y as number, z as number);
      return orig.call(map, x, y, z, ...rest);
    };
  }
  return {
    rollback() {
      const n = snaps.size;
      for (const s of snaps.values()) {
        const c = s.chunk;
        c.ter.set(s.ter);
        c.furn.set(s.furn);
        c.items.clear();
        for (const [k, l] of s.items) c.items.set(k, l);
        c.fields.clear();
        for (const [k, l] of s.fields) c.fields.set(k, l);
        c.version++;
      }
      snaps.clear();
      return n;
    },
    close() {
      for (const [name, f] of originals) m[name] = f;
      if (gen && origGenerate) gen.generate = origGenerate;
    },
  };
}
