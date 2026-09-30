// The hotbar's quick-draw rule over representative real BN items (user report: "When I have long
// bow in my quick bar and press it, it wears it. The expectation is that it wields it.").
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import { Character } from '../src/game/character';
import { hotbarChoice, isWieldWeapon } from '../src/game/hotbar_choice';
import { itemActions } from '../src/game/inventory_view';
import { createItem, inNewContainer, type Item } from '../src/game/item';
import { L, locate, type Loc } from '../src/game/moves';
import { FakeGround } from './fixtures/ground';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const data: GameData = {
  terrain: {}, furniture: {}, items: load('items.json'), itemGroups: {}, monsters: {}, monsterGroups: {}, recipes: [], misc: load('misc.json'),
};

function carrier(): Character {
  const c = new Character(data, { seed: 3 });
  // strong enough for a longbow (min_strength 10): the table is about the choice, not the stats
  c.str_base = 12;
  const map = new FakeGround();
  c.groundLoc = () => L.ground(map, 0, 0, 0);
  c.inv.wear(createItem(data, 'backpack'), null);
  return c;
}
function carry(c: Character, it: Item): Loc {
  c.inv.giveNew(it);
  const loc = locate(it, [L.hands(c), L.worn(c), L.inv(c)]);
  if (!loc) throw new Error(`could not carry ${it.typeId}`);
  return loc;
}
const water = () => inNewContainer(data, createItem(data, 'water_clean', { charges: 1 }), 'bottle_plastic').container;

describe('hotbar quick-draw rule', () => {
  const table: [string, () => Item, string][] = [
    ['longbow', () => createItem(data, 'longbow'), 'wield'],
    ['compbow', () => createItem(data, 'compbow'), 'wield'],
    ['recurbow', () => createItem(data, 'recurbow'), 'wield'],
    ['crossbow', () => createItem(data, 'crossbow'), 'wield'],
    ['sling', () => createItem(data, 'sling'), 'wield'],
    ['glock_19', () => createItem(data, 'glock_19'), 'wield'],
    ['ar15', () => createItem(data, 'ar15'), 'wield'],
    ['machete', () => createItem(data, 'machete'), 'wield'],
    ['bat', () => createItem(data, 'bat'), 'wield'],
    ['spear_wood', () => createItem(data, 'spear_wood'), 'wield'],
    ['knife_combat', () => createItem(data, 'knife_combat'), 'wield'],
    ['crowbar', () => createItem(data, 'crowbar'), 'wield'],
    ['backpack', () => createItem(data, 'rucksack'), 'wear'],
    ['jacket_light', () => createItem(data, 'jacket_light'), 'wear'],
    ['holster', () => createItem(data, 'holster'), 'wear'],
    ['shield_wooden', () => createItem(data, 'shield_wooden'), 'wear'],
    ['flashlight', () => createItem(data, 'flashlight'), 'activate'],
    ['water bottle', water, 'drink'],
    ['chocolate', () => createItem(data, 'chocolate'), 'eat'],
    ['bandages', () => createItem(data, 'bandages'), 'eat'],
  ];
  for (const [name, make, want] of table) {
    it(`${name} (carried) → ${want}`, () => {
      const c = carrier();
      const it = make();
      const a = hotbarChoice(c, it, carry(c, it));
      expect(a?.id).toBe(want);
    });
  }

  it('the old double-click rule wore the longbow; the hotbar wields it and it ends up in hand', () => {
    const c = carrier();
    const bow = createItem(data, 'longbow');
    const loc = carry(c, bow);
    expect(itemActions(c, bow, loc).find((a) => a.primary)?.id).toBe('wear');
    const a = hotbarChoice(c, bow, loc)!;
    expect(a.disabled).toBeUndefined();
    expect(a.run().ok).toBe(true);
    expect(c.inv.wielded).toBe(bow);
  });

  it('a longbow slung on your back is wielded, not taken off', () => {
    const c = carrier();
    const bow = createItem(data, 'longbow');
    c.inv.wear(bow, null);
    expect(c.inv.worn).toContain(bow);
    const a = hotbarChoice(c, bow, L.worn(c))!;
    expect(a.id).toBe('wield');
    expect(a.run().ok).toBe(true);
    expect(c.inv.wielded).toBe(bow);
    expect(c.inv.worn).not.toContain(bow);
  });

  it('pressing again when wielded puts it away (the toggle), worn clothes come off, a worn holster draws', () => {
    const c = carrier();
    const bat = createItem(data, 'bat');
    c.inv.wield(bat, null);
    expect(hotbarChoice(c, bat, L.hands(c))?.id).toBe('unwield');
    const jacket = createItem(data, 'jacket_light');
    c.inv.wear(jacket, null);
    expect(hotbarChoice(c, jacket, L.worn(c))?.id).toBe('takeoff');
    const holster = createItem(data, 'holster');
    c.inv.wear(holster, null);
    expect(hotbarChoice(c, holster, L.worn(c))?.id).toBe('activate');
  });

  it('a weapon too strong to wield says why instead of being worn', () => {
    const c = carrier();
    c.str_base = 4;
    const bow = createItem(data, 'longbow');
    const a = hotbarChoice(c, bow, carry(c, bow));
    expect(a?.id).toBe('wield');
    // either wieldable (BN lets weak characters hold a bow, it just draws badly) or a reason
    if (a?.disabled) expect(a.disabled.length).toBeGreaterThan(0);
  });

  it('an empty bottle has no quick-draw answer (the caller falls back to double-click)', () => {
    const c = carrier();
    const b = createItem(data, 'bottle_plastic');
    expect(hotbarChoice(c, b, carry(c, b))).toBeNull();
  });

  it('weapon classification follows BN (guns incl. bows; weapon_category or melee > MELEE_STAT; not armor)', () => {
    const is = (id: string) => isWieldWeapon(createItem(data, id));
    expect(['longbow', 'crossbow', 'sling', 'slingshot', 'glock_19', 'bat', 'pipe', 'hammer', 'machete'].filter((id) => !is(id))).toEqual([]);
    expect(['helmet_army', 'shield_wooden', 'backpack', 'flashlight', 'bottle_plastic'].filter(is)).toEqual([]);
  });
});
