import type { GameData } from '../data/types';
import { Item, type ItemJSON } from '../game/item';
import { legacyPocketData } from '../data/bncompat';

export type Warn = (msg: string) => void;

/**
 * Item.fromJSON that tolerates data drift between the build that saved and the one loading:
 * unknown item types are dropped (with their contents) and contents of pockets the item no
 * longer has are dropped, each with a warning, instead of failing the whole load.
 */
export function sanitizeItemJSON(data: GameData, j: ItemJSON, warn: Warn): ItemJSON | null {
  if (!j || typeof j.typeId !== 'string') {
    warn(`malformed item ${JSON.stringify(j)?.slice(0, 60)} dropped`);
    return null;
  }
  const def = data.items[j.typeId];
  if (!def) {
    warn(`unknown item "${j.typeId}" dropped`);
    return null;
  }
  if (!j.pockets) return j;
  const n = legacyPocketData(def).length; // TODO(BN inventory)
  const pockets = j.pockets.map((list, i) => {
    if (i >= n) {
      if (list.length) warn(`${j.typeId} lost pocket #${i}; ${list.length} item(s) dropped`);
      return [];
    }
    return list.map((c) => sanitizeItemJSON(data, c, warn)).filter((c): c is ItemJSON => !!c);
  }).slice(0, n);
  return { ...j, pockets };
}

export function loadItemSafe(data: GameData, j: ItemJSON, warn: Warn): Item | null {
  const clean = sanitizeItemJSON(data, j, warn);
  return clean ? Item.fromJSON(data, clean) : null;
}
