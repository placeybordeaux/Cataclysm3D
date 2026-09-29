import { describe, expect, it, vi } from 'vitest';
import { Rng } from '../src/core/rng';
import { expandItemGroup, possibleItems, type SpawnedItem } from '../src/data/itemgroups';
import { resetWarnings, warnedIds } from '../src/data/warn';
import type { GameData, ItemDef, ItemGroupDef } from '../src/data/types';
import { mergeItemGroups, normalizeGroupObject, normalizeGroupRef } from '../tools/extract/itemgroup';
import { normalizeItem } from '../tools/extract/normalize';
import { prepareObject } from '../tools/extract/prepare';

// Item rows are trimmed copies of real BN JSON (~/code/Cataclysm-BN/data/json/...), run
// through the extractor's own prepare + normalizeItem so they have the shipped shape.
const bn = (o: Record<string, unknown>): ItemDef => normalizeItem(prepareObject({ name: o.id, ...o }));
const ITEMS: ItemDef[] = [
  ...['a', 'b', 'c', 'bag', 'box', 'pen_ink'].map((id) => bn({ id, type: 'GENERIC', volume: '250 ml' })),
  // items/containers.json
  bn({ id: 'bottle_plastic', type: 'CONTAINER', volume: '500 ml', contains: '500 ml', seals: true, watertight: true }),
  bn({ id: 'jar_glass', type: 'CONTAINER', volume: '750 ml', contains: '750 ml', seals: true, watertight: true }),
  // items/comestibles/drink.json: water spawns in its default container, a plastic bottle
  bn({ id: 'water', type: 'COMESTIBLE', volume: '250 ml', phase: 'liquid', container: 'bottle_plastic', ammo_data: { ammo_type: 'water' } }),
  // items/ammo/9mm.json + items/magazine/9mm.json + items/gun/9mm.json (glock_19)
  bn({ id: '9mm', type: 'AMMO', volume: '250 ml', count: 50, ammo_type: '9mm' }),
  bn({ id: '9mmfmj', type: 'AMMO', volume: '250 ml', count: 50, ammo_type: '9mm' }),
  bn({ id: 'glockmag', type: 'MAGAZINE', volume: '250 ml', ammo_type: '9mm', capacity: 15 }),
  bn({ id: 'glock_19', type: 'GUN', volume: '500 ml', ammo: '9mm', skill: 'pistol', magazine_well: '250 ml', magazines: [['9mm', ['glockmag']]] }),
  // a revolver-style integral magazine (items/gun/38.json sw_619: clip_size 7)
  bn({ id: 'sw_619', type: 'GUN', volume: '750 ml', ammo: '38', skill: 'pistol', clip_size: 7 }),
  bn({ id: '38_special', type: 'AMMO', volume: '250 ml', count: 50, ammo_type: '38' }),
  // a tool with integral charges (items/tool/misc: "pen" style: max_charges + ammo)
  bn({ id: 'pen', type: 'TOOL', volume: '10 ml', ammo: 'ink', max_charges: 10 }),
];
const MISC = { ammunition_type: { '9mm': { default: '9mm' }, '38': { default: '38_special' }, ink: { default: 'pen_ink' }, water: { default: 'water' } } };

function data(groups: Record<string, ItemGroupDef>): GameData {
  return {
    terrain: {}, furniture: {}, monsters: {}, monsterGroups: {}, recipes: [], misc: MISC,
    items: Object.fromEntries(ITEMS.map((i) => [i.id, i])), itemGroups: groups,
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

describe('expandItemGroup (BN item_group.cpp)', () => {
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

  it('items spawn in their default container; liquids fill it (item::in_container)', () => {
    const d = data({ g: coll([{ item: 'water' }]), jar: coll([{ item: 'water', 'container-item': 'jar_glass' }]), nul: coll([{ item: 'water', 'container-item': 'null' }]) });
    const rng = new Rng(1);
    // 500 ml bottle / 250 ml per charge
    expect(expandItemGroup(d, 'g', rng)).toEqual([{ id: 'bottle_plastic', count: 1, contents: [{ id: 'water', count: 1, charges: 2 }] }]);
    expect(expandItemGroup(d, 'jar', rng)).toEqual([{ id: 'jar_glass', count: 1, contents: [{ id: 'water', count: 1, charges: 3 }] }]);
    // "container-item": "null" makes a null container, so the default one is used (Item_modifier::modify)
    expect(expandItemGroup(d, 'nul', rng)[0].id).toBe('bottle_plastic');
    // explicit charges win over the fill
    expect(expandItemGroup(d, coll([{ item: 'water', charges: 1 }]), rng)[0].contents).toEqual([{ id: 'water', count: 1, charges: 1 }]);
  });

  it('charges: [min, -1] means up to the ammo capacity; tools get their default ammo', () => {
    const d = data({ g: coll([{ item: 'pen', charges: [1, -1] }, { item: 'sw_619', charges: [2, -1], 'ammo-item': '38_special' }, { item: 'a', charges: 5 }]) });
    const rng = new Rng(9);
    for (let i = 0; i < 50; i++) {
      const r = expandItemGroup(d, 'g', rng);
      const pen = r.find((x) => x.id === 'pen')!;
      expect(pen.charges).toBeGreaterThanOrEqual(1);
      expect(pen.charges).toBeLessThanOrEqual(10);
      expect(pen.ammo).toBe('pen_ink');
      const gun = r.find((x) => x.id === 'sw_619')!;
      expect(gun.charges).toBeGreaterThanOrEqual(2);
      expect(gun.charges).toBeLessThanOrEqual(7);
      expect(gun.ammo).toBe('38_special');
      // generic items cannot have charges: nothing is set
      expect(r.find((x) => x.id === 'a')!.charges).toBeUndefined();
    }
  });

  it('a magazine-fed gun with charges gets its default magazine, loaded (item::ammo_set)', () => {
    const d = data({ g: coll([{ item: 'glock_19', charges: 10 }]), m: coll([{ item: 'glockmag', charges: [15, 15], 'ammo-item': '9mmfmj' }]) });
    const rng = new Rng(2);
    expect(expandItemGroup(d, 'g', rng)).toEqual([{ id: 'glock_19', count: 1, contents: [{ id: 'glockmag', count: 1, charges: 10, ammo: '9mm' }] }]);
    expect(expandItemGroup(d, 'm', rng)).toEqual([{ id: 'glockmag', count: 1, charges: 15, ammo: '9mmfmj' }]);
  });

  it('group "ammo"/"magazine" chances load guns that spawned empty', () => {
    const d = data({
      mag: coll([{ item: 'glock_19' }], { magazine: 100 }),
      both: coll([{ item: 'glock_19' }], { ammo: 100, magazine: 100 }),
      integral: coll([{ item: 'sw_619' }], { ammo: 100 }),
      nested: coll([{ collection: [{ item: 'sw_619' }] }], { ammo: 100 }),
    });
    const rng = new Rng(4);
    expect(expandItemGroup(d, 'mag', rng)).toEqual([{ id: 'glock_19', count: 1, contents: [{ id: 'glockmag', count: 1 }] }]);
    expect(expandItemGroup(d, 'both', rng)).toEqual([{ id: 'glock_19', count: 1, contents: [{ id: 'glockmag', count: 1, charges: 15, ammo: '9mm' }] }]);
    expect(expandItemGroup(d, 'integral', rng)).toEqual([{ id: 'sw_619', count: 1, charges: 7, ammo: '38_special' }]);
    expect(expandItemGroup(d, 'nested', rng)).toEqual([{ id: 'sw_619', count: 1, charges: 7, ammo: '38_special' }]);
  });

  it('container-item wraps each item; contents-item / contents-group fill each item', () => {
    const d = data({
      inner: coll([{ item: 'a' }, { item: 'b' }]),
      g: coll([{ item: 'a', count: 2, 'container-item': 'box' }]),
      g2: coll([{ item: 'bag', 'contents-item': ['a', 'a'], 'contents-group': ['inner'], 'custom-flags': ['auto_wield'] }]),
    });
    const rng = new Rng(1);
    const box = { id: 'box', count: 1, contents: [{ id: 'a', count: 1 }] };
    expect(expandItemGroup(d, 'g', rng)).toEqual([box, box]);
    expect(expandItemGroup(d, 'g2', rng)).toEqual([{
      id: 'bag', count: 1, flags: ['auto_wield'],
      contents: [{ id: 'a', count: 3 }, { id: 'b', count: 1 }],
    }]);
  });

  it('unknown ids and recursion warn once and are skipped; inline groups work as refs', () => {
    resetWarnings();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = data({ loop: coll([{ group: 'loop' }, { item: 'a' }]) });
    const rng = new Rng(5);
    expect(expandItemGroup(d, coll([{ item: 'b' }]), rng)).toEqual([{ id: 'b', count: 1 }]);
    expect(expandItemGroup(d, 'nope', rng)).toEqual([]);
    expect(expandItemGroup(d, 'nope', rng)).toEqual([]);
    expect(expandItemGroup(d, 'loop', rng)).toEqual([{ id: 'a', count: 1 }]);
    expect(expandItemGroup(d, coll([{ item: 'mystery' }]), rng)).toEqual([]);
    expect(warnedIds()).toEqual(expect.arrayContaining(['itemgroup:nope', 'itemgroup-recursion:loop', 'item:mystery']));
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('is deterministic for a seed; possibleItems lists everything reachable', () => {
    const d = data({ inner: dist([{ item: 'c' }]), g: coll([{ item: 'a', prob: 1 }, { group: 'inner' }, { collection: [{ item: 'b' }] }]) });
    expect(expandItemGroup(d, 'g', new Rng(42))).toEqual(expandItemGroup(d, 'g', new Rng(42)));
    expect([...possibleItems(d, 'g')].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('item group normalization (extractor, item_factory.cpp load_item_group)', () => {
  it('subtype "old" is a distribution that reads only "items" objects / [id, prob] pairs', () => {
    // shaped like itemgroups/activities_hobbies.json "games" (no subtype, pairs)
    const g = normalizeGroupObject({ id: 'x', type: 'item_group', items: [['b', 10], { item: 'c', 'count-min': 2, 'count-max': 3 }] });
    expect(g).toEqual({ id: 'x', subtype: 'distribution', entries: [{ item: 'b', prob: 10 }, { item: 'c', count: [2, 3] }] });
    expect(() => normalizeGroupObject({ id: 'x', items: ['a'] })).toThrow(/"old"/);
    expect(() => normalizeGroupObject({ id: 'x', entries: [{ item: 'a' }] })).toThrow(/only reads "items"/);
  });

  it('distribution/collection read entries, items and groups (strings, pairs, objects)', () => {
    const g = normalizeGroupObject({ id: 'y', subtype: 'collection', entries: [{ item: 'a', prob: 150 }, { item: 'z', prob: 0 }, {}], items: ['b', ['c', 5]], groups: [['grp', 50]] });
    // collection probs are capped at 100, prob <= 0 and empty entries dropped
    expect(g.entries).toEqual([{ item: 'a' }, { item: 'b' }, { item: 'c', prob: 5 }, { group: 'grp', prob: 50 }]);
  });

  it('modifiers: min/max forms, containers, contents, ammo; DDA-only keys fail loudly', () => {
    const [e] = normalizeGroupObject({
      subtype: 'collection',
      entries: [{ item: 'a', charges: [1, -1], 'damage-min': 1, 'container-item': 'box', 'contents-item': 'b', 'ammo-item': '9mm', 'custom-flags': 'FIT', active: true }],
    }).entries;
    expect(e).toEqual({ item: 'a', charges: [1, -1], damage: [1, 0], 'container-item': 'box', 'contents-item': ['b'], 'ammo-item': '9mm', 'custom-flags': ['FIT'], active: true });
    expect(() => normalizeGroupObject({ subtype: 'collection', entries: [{ item: 'a', 'entry-wrapper': 'box' }] })).toThrow(/not BN/);
    expect(() => normalizeGroupObject({ subtype: 'collection', entries: [{ item: 'a', 'container-item': { item: 'box' } }] })).toThrow(/must be an id/);
    expect(() => normalizeGroupObject({ subtype: 'collection', entries: [{ item: 'a', 'container-item': 'x', 'container-group': 'y' }] })).toThrow(/only one/);
    expect(() => normalizeGroupObject({ id: 'g', subtype: 'collection', 'container-item': 'box', entries: [] })).toThrow(/not BN/);
  });

  it('inline refs: objects default to the call-site subtype, arrays are entry lists', () => {
    expect(normalizeGroupRef('grp', 'collection')).toBe('grp');
    expect(normalizeGroupRef([{ item: 'a', damage: [1, 2] }], 'distribution')).toEqual({ subtype: 'distribution', entries: [{ item: 'a', damage: [1, 2] }] });
    expect(normalizeGroupRef({ items: ['a'] }, 'collection')).toEqual({ subtype: 'collection', entries: [{ item: 'a' }] });
  });

  it('repeated ids append; "purge" resets; "delete" drops the first matching entry; subtypes must agree', () => {
    const g = mergeItemGroups([
      { id: 'light_reading', subtype: 'distribution', entries: [{ item: 'a' }, { item: 'b' }] },
      { id: 'light_reading', subtype: 'distribution', entries: [{ item: 'c' }], delete: [{ item: 'a' }] },
      { id: 'p', subtype: 'collection', entries: [{ item: 'a' }] },
      { id: 'p', subtype: 'collection', purge: true, entries: [{ item: 'b' }] },
    ]);
    expect(g.light_reading.entries).toEqual([{ item: 'b' }, { item: 'c' }]);
    expect(g.p.entries).toEqual([{ item: 'b' }]);
    expect(() => mergeItemGroups([{ id: 'x', subtype: 'collection', entries: [] }, { id: 'x', subtype: 'distribution', entries: [] }])).toThrow(/already defined/);
  });
});
