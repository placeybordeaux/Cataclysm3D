import { describe, expect, it } from 'vitest';
import { parseQuantity } from '../tools/extract/units';
import { prepareObject } from '../tools/extract/prepare';

describe('parseQuantity', () => {
  it.each([
    ['250 ml', 'volume', 250],
    ['1 L', 'volume', 1000],
    ['1 L 500 ml', 'volume', 1500],
    ['-25ml', 'volume', -25],
    ['10 g', 'mass', 10],
    ['1 kg', 'mass', 1000],
    ['500 mg', 'mass', 0.5],
    ['30 cm', 'length', 30],
    ['57 mm', 'length', 5.7],
    ['2 meter', 'length', 200],
    ['30 m', 'time', 1800],
    ['1 h 30 m', 'time', 5400],
    ['10 s', 'time', 10],
    ['2 d', 'time', 172800],
    ['3 days', 'time', 259200],
    ['5 turns', 'time', 5],
    ['10 kJ', 'energy', 10],
    ['500 J', 'energy', 0.5],
    ['5 W', 'power', 5],
    ['2 USD 50 cent', 'money', 250],
    ['1 kUSD', 'money', 100000],
    ['-50 cent', 'money', -50],
    ['40 dB', 'sound', 40], // BN reload_noise_volume
    ['10 days 19 hours', 'time', 932400], // BN spoils_in
  ] as const)('%s', (s, dim, value) => {
    const q = parseQuantity(s);
    expect(q?.dim).toBe(dim);
    expect(q?.value).toBeCloseTo(value, 9);
  });

  it('rejects non-quantities and mixed dimensions', () => {
    expect(parseQuantity('2d6')).toBeNull();
    expect(parseQuantity('hello')).toBeNull();
    expect(parseQuantity('1 L 5 g')).toBeNull();
    expect(parseQuantity('')).toBeNull();
  });

  it('flags unspaced strings so ids like "9mm" are not converted', () => {
    expect(parseQuantity('9mm')?.spaced).toBe(false);
    expect(parseQuantity('9 mm')?.spaced).toBe(true);
  });
});

describe('prepareObject', () => {
  it('converts quantities, flattens translations, drops comments', () => {
    const o = prepareObject({
      id: 'x',
      type: 'ITEM',
      '//': 'comment',
      name: { str: 'knife', str_pl: 'knives', '//~': 'note' },
      description: { str: 'Sharp.' },
      weight: '1 kg',
      volume: '250 ml',
      ammo: ['9mm'],
      relative: { weight: '-25g' },
      pocket_data: [{ max_contains_volume: '1 L', '//2': 'x' }],
      ascii_picture: 'knife',
    });
    expect(o).toEqual({
      id: 'x',
      type: 'ITEM',
      name: 'knife',
      name_plural: 'knives',
      description: 'Sharp.',
      weight: 1000,
      volume: 250,
      ammo: ['9mm'],
      relative: { weight: -25 },
      pocket_data: [{ max_contains_volume: 1000 }],
    });
  });

  it('defaults plurals like CDDA (append s; str_sp is invariant)', () => {
    expect(prepareObject({ name: { str: 'plank' } }).name_plural).toBe('planks');
    expect(prepareObject({ name: { str_sp: 'sheep' } }).name_plural).toBe('sheep');
    expect(prepareObject({ name: 'wall' }).name_plural).toBe('walls');
  });
});
