import { describe, expect, it, vi } from 'vitest';
import { Rng } from '../src/core/rng';
import { expandItemGroup, possibleItems, type SpawnedItem } from '../src/data/itemgroups';
import { resetWarnings, warnedIds } from '../src/data/warn';
import type { GameData, ItemDef, ItemGroupDef } from '../src/data/types';
import { normalizeGroupObject, normalizeGroupRef } from '../tools/extract/itemgroup';

function item(id: string, extra: Partial<ItemDef> = {}): ItemDef {
  return {
    id, type: 'GENERIC', subtypes: [], name: id, name_plural: id + 's', category: 'other', weight: 1, volume: 1,
    material: [], flags: [], symbol: '?', color: 'white', to_hit: -2, ...extra,
  };
}

function data(groups: Record<string, ItemGroupDef>, items: ItemDef[] = []): GameData {
  const all = ['a', 'b', 'c', 'bag', 'box', 'bottle', 'water', 'pen', 'ink'].map((i) => item(i)).concat(items);
  return {
    terrain: {}, furniture: {}, monsters: {}, monsterGroups: {}, recipes: [], misc: {},
    items: Object.fromEntries(all.map((i) => [i.id, i])), itemGroups: groups,
  };
}

const coll = (entries: ItemGroupDef['entries'], extra: Partial<ItemGroupDef> = {}): ItemGroupDef => ({ subtype: 'collection', entries, ...extra });
const dist = (entries: ItemGroupDef['entries'], extra: Partial<ItemGroupDef> = {}): ItemGroupDef => ({ subtype: 'distribution', entries, ...extra });

function tally(runs: number, f: (rng: Rng) => SpawnedItem[]): Record<string, number> {
  const rng = new Rng(1234);
  const t: Record<string, number> = {};
  for (let i = 0; i < runs; i++) for (const it of f(rng)) t[it.id] = (t[it.id] ?? 0) + it.count;
  return t;
}

describe('expandItemGroup', () => {
  it('collection: each entry independently with prob%', () => {
    const d = data({ g: coll([{ item: 'a' }, { item: 'b', prob: 25 }]) });
    const t = tally(4000, (rng) => expandItemGroup(d, 'g', rng));
    expect(t.a).toBe(4000);
    expect(t.b / 4000).toBeGreaterThan(0.22);
    expect(t.b / 4000).toBeLessThan(0.28);
  });

  it('distribution: exactly one entry, weighted by prob', () => {
    const d = data({ g: dist([{ item: 'a', prob: 30 }, { item: 'b', prob: 10 }]) });
    const rng = new Rng(7);
    let a = 0;
    for (let i = 0; i < 4000; i++) {
      const r = expandItemGroup(d, 'g', rng);
      expect(r).toHaveLength(1);
      if (r[0].id === 'a') a++;
    }
    expect(a / 4000).toBeGreaterThan(0.72);
    expect(a / 4000).toBeLessThan(0.78);
  });

  it('count ranges stack into one SpawnedItem; nested groups and inline sub-groups recurse', () => {
    const d = data({
      inner: dist([{ item: 'c' }]),
      g: coll([{ item: 'a', count: [2, 4] }, { group: 'inner', count: 2 }, { distribution: [{ item: 'b' }] }]),
    });
    const rng = new Rng(3);
    for (let i = 0; i < 50; i++) {
      const r = expandItemGroup(d, 'g', rng);
      const a = r.find((x) => x.id === 'a')!;
      expect(a.count).toBeGreaterThanOrEqual(2);
      expect(a.count).toBeLessThanOrEqual(4);
      expect(r.find((x) => x.id === 'c')!.count).toBe(2);
      expect(r.find((x) => x.id === 'b')!.count).toBe(1);
    }
  });

  it('charges: fixed, ranged, and capped by the item capacity', () => {
    const d = data({ g: coll([{ item: 'pen', charges: [1, -1], 'ammo-item': 'ink' }, { item: 'a', charges: 5 }]) }, [item('pen', { max_charges: 10 })]);
    const rng = new Rng(9);
    for (let i = 0; i < 50; i++) {
      const r = expandItemGroup(d, 'g', rng);
      const pen = r.find((x) => x.id === 'pen')!;
      expect(pen.charges).toBeGreaterThanOrEqual(1);
      expect(pen.charges).toBeLessThanOrEqual(10);
      expect(pen.ammo).toBe('ink');
      expect(r.find((x) => x.id === 'a')!.charges).toBe(5);
    }
  });

  it('containers: group container-item, entry container-item, entry-wrapper, contents', () => {
    const d = data({
      g1: coll([{ item: 'a' }, { item: 'b' }], { 'container-item': 'bag' }),
      g2: coll([{ item: 'water', count: 2, 'container-item': 'bottle' }]),
      g3: coll([{ item: 'a', count: 3, 'entry-wrapper': 'box' }]),
      g4: coll([{ item: 'bag', 'contents-item': ['a', 'a'], 'contents-group': ['g1'] }]),
    });
    const rng = new Rng(1);
    expect(expandItemGroup(d, 'g1', rng)).toEqual([{ id: 'bag', count: 1, contents: [{ id: 'a', count: 1 }, { id: 'b', count: 1 }] }]);
    expect(expandItemGroup(d, 'g2', rng)).toEqual([
      { id: 'bottle', count: 1, contents: [{ id: 'water', count: 1 }] },
      { id: 'bottle', count: 1, contents: [{ id: 'water', count: 1 }] },
    ]);
    expect(expandItemGroup(d, 'g3', rng)).toEqual([{ id: 'box', count: 1, contents: [{ id: 'a', count: 3 }] }]);
    expect(expandItemGroup(d, 'g4', rng)).toEqual([{
      id: 'bag', count: 1,
      contents: [{ id: 'a', count: 2 }, { id: 'bag', count: 1, contents: [{ id: 'a', count: 1 }, { id: 'b', count: 1 }] }],
    }]);
  });

  it('inline group definitions work as refs; unknown ids and recursion warn once and are skipped', () => {
    resetWarnings();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = data({ loop: coll([{ group: 'loop' }, { item: 'a' }]) });
    const rng = new Rng(5);
    expect(expandItemGroup(d, coll([{ item: 'b' }]), rng)).toEqual([{ id: 'b', count: 1 }]);
    expect(expandItemGroup(d, 'nope', rng)).toEqual([]);
    expect(expandItemGroup(d, 'nope', rng)).toEqual([]);
    expect(expandItemGroup(d, 'loop', rng)).toEqual([{ id: 'a', count: 1 }]);
    expect(expandItemGroup(d, coll([{ item: 'mystery' }]), rng)).toEqual([{ id: 'mystery', count: 1 }]);
    expect(warnedIds()).toEqual(expect.arrayContaining(['itemgroup:nope', 'itemgroup-recursion:loop', 'item:mystery']));
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('is deterministic for a seed and skips holiday entries', () => {
    const d = data({ g: dist([{ item: 'a' }, { item: 'b' }, { item: 'c', event: 'halloween', prob: 1000 }]) });
    const r1 = expandItemGroup(d, 'g', new Rng(42));
    const r2 = expandItemGroup(d, 'g', new Rng(42));
    expect(r1).toEqual(r2);
    expect(tally(500, (rng) => expandItemGroup(d, 'g', rng)).c).toBeUndefined();
  });

  it('possibleItems lists everything reachable', () => {
    const d = data({ inner: dist([{ item: 'c' }]), g: coll([{ item: 'a', prob: 1 }, { group: 'inner' }, { collection: [{ item: 'b' }] }]) });
    expect([...possibleItems(d, 'g')].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('item group normalization (extractor)', () => {
  it('folds legacy items/groups arrays and old subtype into entries', () => {
    const g = normalizeGroupObject({
      id: 'x', type: 'item_group', items: ['a', ['b', 10], { item: 'c', 'count-min': 2, 'count-max': 3 }], groups: [['grp', 50]],
    });
    expect(g).toEqual({
      id: 'x', subtype: 'distribution',
      entries: [{ item: 'a' }, { item: 'b', prob: 10 }, { item: 'c', count: [2, 3] }, { group: 'grp', prob: 50 }],
    });
  });

  it('caps collection probs at 100, drops prob <= 0, normalizes container-item objects', () => {
    const g = normalizeGroupObject({
      subtype: 'collection',
      entries: [
        { item: 'a', prob: 150 },
        { item: 'b', prob: 0 },
        { item: 'c', 'container-item': { item: 'box', variant: 'red' }, 'contents-item': 'a' },
        {},
      ],
    });
    expect(g.entries).toEqual([
      { item: 'a' },
      { item: 'c', 'entry-wrapper': 'box', 'container-variant': 'red', 'contents-item': ['a'] },
    ]);
  });

  it('inline refs: arrays become groups of the call-site default subtype', () => {
    expect(normalizeGroupRef('grp', 'collection')).toBe('grp');
    expect(normalizeGroupRef([{ item: 'a', damage: [1, 2] }], 'distribution')).toEqual({ subtype: 'distribution', entries: [{ item: 'a', damage: [1, 2] }] });
  });
});
