// What counts as a place to loot, for the looting UIs: storage furniture (lockers, dressers,
// fridges: CDDA CONTAINER furniture hides what's inside), piles on the floor or on a table,
// corpses (items too), and open vehicle cargo within reach.

import type { FurnitureDef } from '../../data/types';
import type { Game } from '../../game/game';
import { targetTile } from '../../game/targeting';
import { hasFlag } from '../../world/registry';
import { nearbyCargo } from '../bn/install';

/**
 * Storage furniture whose contents you can't see from outside. A potted plant's 10 L of soil
 * isn't one (interact.ts draws the same line for its "Look in" entry).
 */
export function isLootContainer(f: FurnitureDef): boolean {
  if (f.id === 'f_null' || !hasFlag(f, 'CONTAINER') || hasFlag(f, 'PLANT')) return false;
  return !(typeof f.max_volume === 'number' && f.max_volume <= 10000);
}

export interface LootTarget {
  /** Inventory-model place key: "ground:x,y,z" or "cargo:<n>". */
  key: string;
  x: number;
  y: number;
  z: number;
  /** "Kitchen cupboard", "Pile on the floor", "Sedan's trunk". */
  title: string;
  container: boolean;
}

/** The lootable place under the crosshair within reach, or null (a door, a wall, nothing). */
export function lootTargetAt(game: Game): LootTarget | null {
  const t = targetTile(game);
  if (!t) return null;
  const map = game.map;
  const vs = game.vehicles;
  const occ = vs?.at(t.x, t.y, t.z);
  if (occ) {
    const cargo = nearbyCargo(game);
    const i = cargo.findIndex((c) => c.vehicle === occ.v && occ.v.partsAt(occ.mx, occ.my).some((q) => q === (c.part as unknown)));
    if (i >= 0) return { key: `cargo:${i}`, x: t.x, y: t.y, z: t.z, title: cap(cargo[i].label), container: true };
    return null;
  }
  const f = map.furnAt(t.x, t.y, t.z);
  const n = map.itemsAt(t.x, t.y, t.z).length;
  const container = isLootContainer(f);
  if (!n && !container) return null;
  if (hasFlag(f, 'PLANT')) return null;
  const title = f.id !== 'f_null' ? cap(f.name) : n === 1 ? 'On the floor' : 'Pile on the floor';
  return { key: `ground:${t.x},${t.y},${t.z}`, x: t.x, y: t.y, z: t.z, title, container };
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
