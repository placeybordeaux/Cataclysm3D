// What the survivor has recently *seen* lying around: ammo, magazines and batteries on the
// floor, on counters, in the drawers they looked into. The reload helper (reloadhelp.ts) uses it
// to answer "my flashlight is dead, where did I see batteries?" with a place ("you saw 2 light
// batteries in a dresser 40 m northwest") instead of a bare "no ammo".
//
// Deliberately small: only reload-relevant items are remembered (ammo, magazines, UPSes), a few
// places per item type, and the oldest types fall out past a cap, so the save stays tiny. It is
// a memory, not the map: a sighting can be stale (someone took the batteries), and callers check
// the tile again when it's loaded (SeenItems.prune).

import type { Item } from './item';

export interface Sighting {
  /** item type id */
  id: string;
  /** how many were there (rounds for loose ammo, items otherwise) */
  n: number;
  x: number;
  y: number;
  z: number;
  /** "in a dresser", "on the floor" — how the place read when seen */
  where: string;
  /** game-clock seconds when last seen */
  t: number;
}

export interface SeenItemsJSON {
  v: 1;
  s: [id: string, n: number, x: number, y: number, z: number, where: string, t: number][];
}

/** Places kept per item type (the most recent ones). */
const PER_TYPE = 3;
/** Item types kept overall (least recently seen dropped first). */
const MAX_TYPES = 400;

/** Is this worth remembering for the reload helper? */
export function reloadRelevant(it: Item): boolean {
  return it.isAmmo() || it.isMagazine() || it.hasFlag('IS_UPS');
}

export class SeenItems {
  private by = new Map<string, Sighting[]>();
  /** Bumped on every change. */
  version = 0;

  /** Remember `n` of `id` at a tile (replaces what was remembered there for that type). */
  record(id: string, n: number, x: number, y: number, z: number, where: string, t: number): void {
    if (!(n > 0)) throw new Error(`SeenItems.record: bad count ${n} for ${id}`);
    const list = this.by.get(id) ?? [];
    const i = list.findIndex((s) => s.x === x && s.y === y && s.z === z);
    if (i >= 0) {
      const s = list[i];
      // Seen again with nothing new: don't churn the version (the scan runs every second).
      if (s.n === n && s.where === where && t - s.t < 60) return;
      list.splice(i, 1);
    }
    list.unshift({ id, n, x, y, z, where, t });
    if (list.length > PER_TYPE) list.length = PER_TYPE;
    // Map order = recency: re-insert so the least recently seen type is first to go.
    this.by.delete(id);
    this.by.set(id, list);
    while (this.by.size > MAX_TYPES) this.by.delete(this.by.keys().next().value!);
    this.version++;
  }

  /** The tile no longer holds `id` (looked again and it's gone). */
  forget(id: string, x: number, y: number, z: number): void {
    const list = this.by.get(id);
    if (!list) return;
    const keep = list.filter((s) => !(s.x === x && s.y === y && s.z === z));
    if (keep.length === list.length) return;
    if (keep.length) this.by.set(id, keep);
    else this.by.delete(id);
    this.version++;
  }

  /** Drop sightings that `stillThere` says are gone (only asked about tiles it can check). */
  prune(stillThere: (s: Sighting) => boolean | undefined): void {
    for (const list of [...this.by.values()]) for (const s of list) if (stillThere(s) === false) this.forget(s.id, s.x, s.y, s.z);
  }

  sightings(id: string): readonly Sighting[] {
    return this.by.get(id) ?? [];
  }

  get size(): number {
    return this.by.size;
  }

  toJSON(): SeenItemsJSON {
    const s: SeenItemsJSON['s'] = [];
    for (const list of this.by.values()) for (const x of list) s.push([x.id, x.n, x.x, x.y, x.z, x.where, x.t]);
    return { v: 1, s };
  }

  static fromJSON(j: unknown): SeenItems {
    const m = new SeenItems();
    const o = j as SeenItemsJSON | null;
    if (!o || o.v !== 1 || !Array.isArray(o.s)) throw new Error(`SeenItems.fromJSON: unknown format ${JSON.stringify(j)?.slice(0, 80)}`);
    // Oldest first so the newest end up most recent in both the per-type lists and the map order.
    const rows = [...o.s].sort((a, b) => a[6] - b[6]);
    for (const [id, n, x, y, z, where, t] of rows) m.record(id, n, x, y, z, where, t);
    m.version = 0;
    return m;
  }
}
