import { describe, expect, it } from 'vitest';
import { applyModifier, FAMILY_HOOKS, familyOf, ITEM_TYPES, mergeInherited, objectIds, resolveFamily } from '../tools/extract/cdda';
import { prepareObject } from '../tools/extract/prepare';
import { RequirementResolver, parseRequirementLists } from '../tools/extract/requirements';

describe('copy-from resolution (BN rules)', () => {
  // Shaped like BN data/json/items/ammo/223.json (223 -> bp_223), trimmed.
  const objs = [
    {
      id: '223', type: 'AMMO', name: { str_sp: '.223' }, weight: '12 g', price: '2 USD 80 cent',
      flags: ['IRREPLACEABLE_CONSUMABLE'], damage: { damage_type: 'bullet', amount: 42, armor_penetration: 18 },
      dispersion: 30, recoil: 1500, effects: ['COOKOFF'],
    },
    {
      id: '556', 'copy-from': '223', type: 'AMMO', name: { str_sp: '5.56 M855' },
      relative: { damage: { damage_type: 'bullet', amount: -3, armor_penetration: 10 }, dispersion: 20 },
      proportional: { recoil: 1.1 }, extend: { effects: ['INCENDIARY'] },
    },
    {
      id: 'reloaded_556', 'copy-from': '556', type: 'AMMO', name: { str_sp: '5.56, reloaded' },
      proportional: { price: 0.7, damage: { damage_type: 'bullet', amount: 0.9 }, dispersion: 1.1, weight: 0.5 },
      extend: { effects: ['RECYCLED'] }, delete: { flags: ['IRREPLACEABLE_CONSUMABLE'] },
    },
    { abstract: 'base_thing', type: 'GENERIC', weight: '1 kg', flags: ['A'] },
    { id: 'thing', 'copy-from': 'base_thing', type: 'GENERIC' },
  ];
  const r = resolveFamily(objs, FAMILY_HOOKS.ITEM, prepareObject);

  it('inherits, applies relative/proportional/extend/delete in chains', () => {
    const a = r.byId.get('556')!;
    expect(a.weight).toBe(12);
    expect(a.price).toBe(280);
    expect(a.damage).toEqual({ damage_type: 'bullet', amount: 39, armor_penetration: 28 });
    expect(a.dispersion).toBe(50);
    expect(a.recoil).toBe(1650); // 1500 * 1.1 = 1650.0000000000002 in double, truncated
    expect(a.effects).toEqual(['COOKOFF', 'INCENDIARY']);
    const b = r.byId.get('reloaded_556')!;
    // BN: money is int cents and `val * double` truncates (280 * 0.7 rounds to exactly 196.0)
    expect(b.price).toBe(196);
    expect(b.damage.amount).toBeCloseTo(35.1, 5);
    expect(b.dispersion).toBe(55);
    expect(b.weight).toBe(6);
    expect(b.flags).toEqual([]);
    expect(b.effects).toEqual(['COOKOFF', 'INCENDIARY', 'RECYCLED']);
    expect(b.name).toBe('5.56, reloaded');
    // item_factory load_definition: a real parent's id becomes looks_like
    expect(b.looks_like).toBe('556');
  });

  it('keeps abstracts out of byId but lets children use them', () => {
    expect(r.byId.has('base_thing')).toBe(false);
    expect(r.abstracts.has('base_thing')).toBe(true);
    expect(r.byId.get('thing')).toMatchObject({ id: 'thing', weight: 1000, flags: ['A'] });
    expect(r.byId.get('thing')!.looks_like).toBeUndefined(); // abstract ids never have sprites
  });

  it('items (assign()) let relative beat an explicit value; generic_factory is explicit-first', () => {
    const parent = { id: 'p', weight: 100, volume: 1000 };
    const child = { id: 'c', weight: 5, relative: { weight: 10 }, volume: 7, proportional: { volume: 2 } };
    expect(mergeInherited(parent, child, { modifierFirst: true })).toMatchObject({ weight: 110, volume: 2000 });
    expect(mergeInherited(parent, child, {})).toMatchObject({ weight: 5, volume: 7 });
    // generic_factory optional(): proportional is tried before relative and only one applies
    expect(mergeInherited({ id: 'p', hp: 10 }, { id: 'c', proportional: { hp: 2 }, relative: { hp: 5 } }, {}).hp).toBe(20);
  });

  it('item volumes accept legacy ints (x 250 ml), also in relative, never in proportional', () => {
    const o = prepareObject({ id: 'x', type: 'TOOL', volume: 2, relative: { volume: 1 }, proportional: { volume: 2 }, container_data: { contains: 4 } });
    expect(o).toMatchObject({ volume: 500, relative: { volume: 250 }, proportional: { volume: 2 }, container_data: { contains: 1000 } });
    expect(prepareObject({ id: 'b', type: 'BOOK', time: 40 }).time).toBe(2400); // minutes
    expect(prepareObject({ id: 'b', type: 'BOOK', time: '40 m' }).time).toBe(2400);
    expect(prepareObject({ id: 'f', type: 'COMESTIBLE', spoils_in: 2 }).spoils_in).toBe(7200); // hours
    expect(prepareObject({ type: 'recipe', result: 'r', time: 500 }).time).toBe(5); // moves
    expect(prepareObject({ id: 'k', type: 'furniture', keg_capacity: 4 }).keg_capacity).toBe(1000);
    // non-item volumes (speech "volume" is a sound level) are left alone
    expect(prepareObject({ type: 'speech', volume: 8 }).volume).toBe(8);
  });

  it('qualities extend/delete behave like the C++ map', () => {
    const parent = { id: 'p', qualities: [['CUT', 1], ['HAMMER', 2]] };
    const ext = mergeInherited(parent, { id: 'c', extend: { qualities: [['CUT', 2], ['SAW_M', 1]] } });
    expect(ext.qualities).toEqual([['CUT', 2], ['HAMMER', 2], ['SAW_M', 1]]);
    // delete_qualities_from_json only removes an exact (id, level) match
    expect(mergeInherited(parent, { id: 'c', delete: { qualities: [['CUT', 2], ['HAMMER', 2]] } }).qualities).toEqual([['CUT', 1]]);
  });

  it('copy-from of its own id extends the previous definition', () => {
    const g = resolveFamily([
      { id: 'g', type: 'terrain', flags: ['a'] },
      { id: 'g', type: 'terrain', 'copy-from': 'g', extend: { flags: ['b'] } },
    ]);
    expect(g.byId.get('g')!.flags).toEqual(['a', 'b']);
  });

  it('a self copy-from with nothing before it is discarded with a warning (BN "circular dependency")', () => {
    const g = resolveFamily([{ id: 'PAIN_GOOD', type: 'enchantment_value', 'copy-from': 'PAIN_GOOD', increase_good: true }]);
    expect(g.byId.has('PAIN_GOOD')).toBe(false);
    expect(g.warnings[0]).toMatch(/PAIN_GOOD/);
  });

  it('aliases resolve to the canonical object (terrain-walls.json t_wall)', () => {
    const g = resolveFamily([{ id: 't_wall', type: 'terrain', alias: ['t_wall_h', 't_wall_v'], move_cost: 0 }]);
    expect(g.byId.get('t_wall_h')).toBe(g.byId.get('t_wall'));
    expect(g.byId.get('t_wall')!.alias).toBeUndefined();
  });

  it('fails loudly on unknown parents and cycles', () => {
    expect(() => resolveFamily([{ id: 'x', type: 'terrain', 'copy-from': 'nope' }])).toThrow(/unknown id "nope"/);
    expect(() => resolveFamily([
      { id: 'a', type: 'terrain', 'copy-from': 'b' },
      { id: 'b', type: 'terrain', 'copy-from': 'a' },
    ])).toThrow(/cycle/);
  });

  it('honours notInherited / mergeObjects hooks', () => {
    const parent = { id: 'p', oxytorch: { result: 't_x' }, bash: { str_min: 1, str_max: 2, sound: 'x' } };
    const child = { id: 'c', bash: { str_max: 9 } };
    const m = mergeInherited(parent, child, FAMILY_HOOKS.terrain);
    expect(m).toEqual({ id: 'c', bash: { str_min: 1, str_max: 9, sound: 'x' } });
    // BN inherits open/close (DDA reset them)
    expect(mergeInherited({ id: 'p', open: 't_door_o' }, { id: 'c' }, FAMILY_HOOKS.terrain).open).toBe('t_door_o');
  });

  it('relative on maps and quality pairs, proportional on monster armor', () => {
    expect(applyModifier({ bash: 5 }, { bash: 2, cut: 1 }, 'relative')).toEqual({ bash: 7, cut: 1 });
    expect(applyModifier([['CUT', 1], ['HAMMER', 2]], [['CUT', 1]], 'relative')).toEqual([['CUT', 2], ['HAMMER', 2]]);
    expect(applyModifier({ bash: 2, cut: 4 }, 1.5, 'proportional')).toEqual({ bash: 3, cut: 6 });
    expect(applyModifier([{ damage_type: 'cut', amount: 4 }], [{ damage_type: 'cut', amount: 2 }], 'relative'))
      .toEqual([{ damage_type: 'cut', amount: 6 }]);
    expect(applyModifier(12, 0.9, 'proportional', 'weight')).toBe(10.8); // mg resolution
  });

  it('ids: arrays, abstracts, recipes, name-keyed types, families', () => {
    expect(objectIds({ type: 'terrain', id: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(objectIds({ type: 'MONSTER', abstract: 'm' })).toEqual(['m']);
    expect(objectIds({ type: 'recipe', result: 'x', id_suffix: 's' })).toEqual(['x_s']);
    expect(objectIds({ type: 'uncraft', result: 'x' })).toEqual(['x']);
    expect(objectIds({ type: 'nested_category', id: 'nc' })).toEqual(['nc']);
    expect(objectIds({ type: 'monstergroup', name: 'GROUP_ZOMBIE' })).toEqual(['GROUP_ZOMBIE']);
    expect(objectIds({ type: 'profession', ident: 'waste_ranger' })).toEqual(['waste_ranger']);
    expect(familyOf('CONTAINER')).toBe('ITEM');
    expect(ITEM_TYPES).not.toContain('ITEM'); // modern DDA's single item type is not BN
    expect(() => objectIds({ type: 'recipe' })).toThrow(/result/);
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
