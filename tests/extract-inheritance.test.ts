import { describe, expect, it } from 'vitest';
import { applyModifier, mergeInherited, objectIds, resolveFamily } from '../tools/extract/cdda';
import { prepareObject } from '../tools/extract/prepare';
import { RequirementResolver, parseRequirementLists } from '../tools/extract/requirements';

describe('copy-from resolution', () => {
  // Mirrors the 223 / 556 / reloaded_556 example in doc/JSON/JSON_INHERITANCE.md
  const objs = [
    {
      id: '223', type: 'ITEM', subtypes: ['AMMO'], name: { str_sp: '.223' }, weight: '12 g', price: '2 USD 80 cent',
      flags: ['IRREPLACEABLE_CONSUMABLE'], damage: { damage_type: 'bullet', amount: 39, armor_penetration: 2, barrels: [{ barrel_length: '28 mm', amount: 13 }] },
      dispersion: 30, recoil: 1500, effects: ['COOKOFF'],
    },
    {
      id: '556', 'copy-from': '223', type: 'ITEM', name: { str_sp: '5.56 M855' },
      relative: { damage: { damage_type: 'bullet', amount: -3, armor_penetration: 10 }, dispersion: 20 },
      proportional: { recoil: 1.1 }, extend: { effects: ['INCENDIARY'] },
    },
    {
      id: 'reloaded_556', 'copy-from': '556', type: 'ITEM', name: { str_sp: '5.56, reloaded' },
      proportional: { price: 0.7, damage: { damage_type: 'bullet', amount: 0.9 }, dispersion: 1.1, weight: 0.5 },
      extend: { effects: ['RECYCLED'] }, delete: { flags: ['IRREPLACEABLE_CONSUMABLE'] },
    },
    { abstract: 'base_thing', type: 'ITEM', weight: '1 kg', flags: ['A'] },
    { id: 'thing', 'copy-from': 'base_thing', type: 'ITEM' },
  ];
  const r = resolveFamily(objs, {}, prepareObject);

  it('inherits, applies relative/proportional/extend/delete in chains', () => {
    const a = r.byId.get('556')!;
    expect(a.weight).toBe(12);
    expect(a.price).toBe(280);
    expect(a.damage).toEqual({ damage_type: 'bullet', amount: 36, armor_penetration: 12, barrels: [{ barrel_length: 2.8, amount: 10 }] });
    expect(a.dispersion).toBe(50);
    expect(a.recoil).toBe(1650);
    expect(a.effects).toEqual(['COOKOFF', 'INCENDIARY']);
    const b = r.byId.get('reloaded_556')!;
    expect(b.price).toBe(196); // 280 * 0.7f truncated
    expect(b.damage.amount).toBeCloseTo(32.4, 5);
    expect(b.damage.barrels[0].amount).toBeCloseTo(9, 5);
    expect(b.dispersion).toBe(55);
    expect(b.weight).toBe(6);
    expect(b.flags).toEqual([]);
    expect(b.effects).toEqual(['COOKOFF', 'INCENDIARY', 'RECYCLED']);
    expect(b.name).toBe('5.56, reloaded');
  });

  it('keeps abstracts out of byId but lets children use them', () => {
    expect(r.byId.has('base_thing')).toBe(false);
    expect(r.abstracts.has('base_thing')).toBe(true);
    expect(r.byId.get('thing')).toMatchObject({ id: 'thing', weight: 1000, flags: ['A'] });
  });

  it('copy-from of its own id extends the previous definition', () => {
    const g = resolveFamily([
      { id: 'g', type: 'item_group', items: ['a'] },
      { id: 'g', type: 'item_group', 'copy-from': 'g', extend: { items: ['b'] } },
    ]);
    expect(g.byId.get('g')!.items).toEqual(['a', 'b']);
  });

  it('fails loudly on unknown parents and cycles', () => {
    expect(() => resolveFamily([{ id: 'x', type: 'terrain', 'copy-from': 'nope' }])).toThrow(/unknown id "nope"/);
    expect(() => resolveFamily([
      { id: 'a', type: 'terrain', 'copy-from': 'b' },
      { id: 'b', type: 'terrain', 'copy-from': 'a' },
    ])).toThrow(/cycle/);
  });

  it('honours notInherited / mergeObjects hooks', () => {
    const parent = { id: 'p', open: 't_open', bash: { str_min: 1, str_max: 2, sound: 'x' } };
    const child = { id: 'c', bash: { str_max: 9 } };
    const m = mergeInherited(parent, child, { notInherited: ['open'], mergeObjects: ['bash'] });
    expect(m).toEqual({ id: 'c', bash: { str_min: 1, str_max: 9, sound: 'x' } });
  });

  it('relative on maps and quality pairs, proportional on monster armor', () => {
    expect(applyModifier({ bash: 5 }, { bash: 2, cut: 1 }, 'relative')).toEqual({ bash: 7, cut: 1 });
    expect(applyModifier([['CUT', 1], ['HAMMER', 2]], [['CUT', 1]], 'relative')).toEqual([['CUT', 2], ['HAMMER', 2]]);
    expect(applyModifier({ bash: 2, cut: 4 }, 1.5, 'proportional')).toEqual({ bash: 3, cut: 6 });
    expect(applyModifier([{ damage_type: 'cut', amount: 4 }], [{ damage_type: 'cut', amount: 2 }], 'relative'))
      .toEqual([{ damage_type: 'cut', amount: 6 }]);
  });

  it('ids: arrays, abstracts, recipes', () => {
    expect(objectIds({ type: 'terrain', id: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(objectIds({ type: 'MONSTER', abstract: 'm' })).toEqual(['m']);
    expect(objectIds({ type: 'recipe', result: 'x', variant: 'v', id_suffix: 's' })).toEqual(['x_v_s']);
    expect(objectIds({ type: 'uncraft', result: 'x' })).toEqual(['x']);
    expect(objectIds({ type: 'practice', id: 'prac' })).toEqual(['prac']);
  });
});

describe('requirements', () => {
  const defs = new Map([
    ['glue', parseRequirementLists({ components: [[['superglue', 1], ['duct_tape', 50]]] }, 'glue')],
    ['sewing', parseRequirementLists({ tools: [[['sewing_kit', 1], ['tailors_kit', 1]]], qualities: [{ id: 'SEW', level: 1 }] }, 'sewing')],
    ['nested', parseRequirementLists({ components: [[['glue', 2, 'LIST'], ['rope', 1]]] }, 'nested')],
  ]);
  const r = new RequirementResolver(defs, (m) => {
    throw new Error(m);
  });

  it('inlines LIST entries scaled by count and appends `using` requirements scaled', () => {
    const out = r.expand(parseRequirementLists({ components: [[['nested', 1, 'LIST'], ['superglue', 1]]] }, 't'), [['sewing', 3]], 't');
    // superglue appears via the list (count 2) and directly (count 1): the cheaper alternative wins
    expect(out.components).toEqual([[{ id: 'superglue', count: 1 }, { id: 'duct_tape', count: 100 }, { id: 'rope', count: 1 }]]);
    expect(out.tools).toEqual([[{ id: 'sewing_kit', count: 3 }, { id: 'tailors_kit', count: 3 }]]);
    expect(out.qualities).toEqual([[{ id: 'SEW', level: 1 }]]);
  });

  it('parses bare tool ids and bare qualities as one-alternative groups', () => {
    const p = parseRequirementLists({ tools: [['hammer', 'rock']], qualities: [{ id: 'CUT' }, [{ id: 'SAW_W', level: 2 }, { id: 'AXE', level: 1 }]] }, 't');
    expect(p.tools).toEqual([[{ id: 'hammer', count: -1 }, { id: 'rock', count: -1 }]]);
    expect(p.qualities).toEqual([[{ id: 'CUT', level: 1 }], [{ id: 'SAW_W', level: 2 }, { id: 'AXE', level: 1 }]]);
  });
});
