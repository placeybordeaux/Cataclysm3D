// A small in-memory item store for the ui2 showcase and the placeholder inventory: named
// locations (ground, hands, worn slots) plus every container item's contents. Pure (no DOM),
// and property-tested for item conservation (tests/ui2.test.ts): no sequence of moves, splits
// and swaps may create or destroy an item — the v1 bag-unload duplication bug in miniature.
//
// It's also the reference for how a real screen should talk to ui2: ask `check()` while
// hovering (drives the valid/invalid feedback), call `move()` on drop, re-render on change.

import { checkDrop, isAccepted, type ContainerRules, type DropVerdict } from '../logic/dnd';
import { canMerge, splitCounts, type ItemView } from '../logic/items';

/** 'ground', 'hands', 'worn:torso', … or `in:<itemId>` for the inside of a container item. */
export type LocId = string;

export interface RootLocation {
  id: LocId;
  name: string;
  rules: ContainerRules;
  items: ItemView[];
}

export type MoveResult =
  | { ok: true; moved: number; verdict: DropVerdict; movedId: string }
  | { ok: false; reason: string };

export const insideOf = (itemId: string): LocId => `in:${itemId}`;

export class MockStore {
  private roots = new Map<LocId, RootLocation>();
  private nextId = 1;
  private listeners: (() => void)[] = [];

  constructor(roots: RootLocation[]) {
    for (const r of roots) {
      if (this.roots.has(r.id)) throw new Error(`MockStore: duplicate location ${r.id}`);
      this.roots.set(r.id, r);
    }
    // Instance ids must be unique across the whole store, or find() would be ambiguous.
    const seen = new Set<string>();
    this.walk((it) => {
      if (seen.has(it.id)) throw new Error(`MockStore: duplicate item id ${it.id}`);
      seen.add(it.id);
    });
  }

  onChange(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => (this.listeners = this.listeners.filter((f) => f !== fn));
  }
  private changed(): void {
    for (const f of this.listeners) f();
  }

  newId(): string {
    return `m${this.nextId++}`;
  }

  rootIds(): LocId[] {
    return [...this.roots.keys()];
  }

  name(loc: LocId): string {
    const r = this.roots.get(loc);
    if (r) return r.name;
    const it = this.containerItem(loc);
    return it.name;
  }

  contents(loc: LocId): ItemView[] {
    const r = this.roots.get(loc);
    if (r) return r.items;
    const it = this.containerItem(loc);
    return (it.contents ??= []);
  }

  rules(loc: LocId): ContainerRules {
    const r = this.roots.get(loc);
    if (r) return r.rules;
    const box = this.containerItem(loc);
    return {
      maxVolume: box.capacity!.volume,
      maxWeight: box.capacity!.weight,
      accepts: (item) => (item.id === box.id || contains(item, box.id) ? `Can't put ${item.name} inside itself` : null),
    };
  }

  /** Item and the location holding it, or null. */
  find(itemId: string): { item: ItemView; loc: LocId } | null {
    let hit: { item: ItemView; loc: LocId } | null = null;
    this.walk((it, loc) => {
      if (!hit && it.id === itemId) hit = { item: it, loc };
    });
    return hit;
  }

  /** What would happen if `count` of the item were dropped into `to`. */
  check(itemId: string, to: LocId, count: number): DropVerdict {
    const src = this.find(itemId);
    if (!src) throw new Error(`MockStore.check: no item ${itemId}`);
    if (src.loc === to) return { kind: 'noop' };
    return checkDrop(this.rules(to), this.contents(to), src.item, count, (displaced) => {
      // The displaced item goes back where the dragged one came from, which by then has
      // `count` fewer of it (or none, if the whole stack moved).
      const left = this.contents(src.loc).flatMap((c) => (c.id !== itemId ? [c] : c.count > count ? [{ ...c, count: c.count - count }] : []));
      const back = checkDrop(this.rules(src.loc), left, displaced, displaced.count);
      return isAccepted(back) && back.count === displaced.count ? null : `won't fit in ${this.name(src.loc)}`;
    });
  }

  move(itemId: string, to: LocId, count: number): MoveResult {
    const src = this.find(itemId);
    if (!src) return { ok: false, reason: 'That item is gone' };
    const verdict = this.check(itemId, to, count);
    if (!isAccepted(verdict)) return { ok: false, reason: verdict.kind === 'reject' ? verdict.reason : 'Already there' };
    const n = verdict.count;
    const from = this.contents(src.loc);
    let moving: ItemView;
    if (n === src.item.count) {
      from.splice(from.indexOf(src.item), 1);
      moving = src.item;
    } else {
      const { take, rest } = splitCounts(src.item.count, n);
      src.item.count = rest;
      moving = { ...src.item, id: this.newId(), count: take, badges: src.item.badges?.slice() };
    }
    const target = this.contents(to);
    if (verdict.kind === 'swap') {
      target.splice(target.indexOf(verdict.displaced), 1);
      this.insert(from, verdict.displaced);
    }
    const movedId = this.insert(target, moving);
    this.changed();
    return { ok: true, moved: n, verdict, movedId };
  }

  /** Split `take` off a stack into a new stack in the same place; returns the new id. */
  split(itemId: string, take: number): string {
    const src = this.find(itemId);
    if (!src) throw new Error(`MockStore.split: no item ${itemId}`);
    const { rest } = splitCounts(src.item.count, take);
    if (rest === 0) return itemId;
    src.item.count = rest;
    const part: ItemView = { ...src.item, id: this.newId(), count: take };
    const list = this.contents(src.loc);
    list.splice(list.indexOf(src.item) + 1, 0, part);
    this.changed();
    return part.id;
  }

  /** Remove an item entirely (used up / eaten). Returns what was removed. */
  consume(itemId: string, count = 1): ItemView {
    const src = this.find(itemId);
    if (!src) throw new Error(`MockStore.consume: no item ${itemId}`);
    const { rest } = splitCounts(src.item.count, count);
    if (rest === 0) {
      const list = this.contents(src.loc);
      list.splice(list.indexOf(src.item), 1);
    } else src.item.count = rest;
    this.changed();
    return { ...src.item, count };
  }

  /** Count per typeId over every location, recursively (the conservation invariant). */
  totals(): Map<string, number> {
    const m = new Map<string, number>();
    this.walk((it) => m.set(it.typeId, (m.get(it.typeId) ?? 0) + it.count));
    return m;
  }

  /** Visit every item: roots first, then depth-first into containers. */
  walk(fn: (it: ItemView, loc: LocId) => void): void {
    const rec = (items: ItemView[], loc: LocId) => {
      for (const it of items.slice()) {
        fn(it, loc);
        if (it.contents) rec(it.contents, insideOf(it.id));
      }
    };
    for (const r of this.roots.values()) rec(r.items, r.id);
  }

  private containerItem(loc: LocId): ItemView {
    if (!loc.startsWith('in:')) throw new Error(`MockStore: unknown location ${loc}`);
    const f = this.find(loc.slice(3));
    if (!f) throw new Error(`MockStore: container ${loc} is gone`);
    if (!f.item.capacity) throw new Error(`MockStore: ${f.item.name} is not a container`);
    return f.item;
  }

  private insert(list: ItemView[], it: ItemView): string {
    const into = list.find((c) => canMerge(c, it));
    if (into) {
      into.count += it.count;
      return into.id;
    }
    list.push(it);
    return it.id;
  }
}

function contains(outer: ItemView, id: string): boolean {
  return (outer.contents ?? []).some((c) => c.id === id || contains(c, id));
}
