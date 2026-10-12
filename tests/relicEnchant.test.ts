// Relic passive effects of wielded, worn and carried items, and climate control
// (src/game/relicEnchant.ts, src/game/enchantValues.ts, Character.climateCorrected;
// docs/BN_POWER_ARMOR.md). Real BN data: items/tool_armor.json (thermal_cooling CLIMATE_CONTROL
// 1250), items/armor/power_armor.json (exo STRENGTH +2, CLIMATE_CONTROL 2000), items/fake.json
// (clairvoyance_plus_plus_rod: WIELD), artifact/debug_artifacts.json (debug_active_relic_test:
// HELD+ACTIVE INT/PER; radiation_triangle: HELD+ABOVEGROUND; chaos_dagger: no conditions),
// items/armor/eyewear.json (test_enchanted_hawkeye: WORN PERCEPTION +5),
// legacy_artifact_passive.json (AEP_STR_UP: "has": "WIELD", STRENGTH +4),
// enchantment_conditions.json and enchantment_values.json (the CLIMATE_CONTROL suffix tree).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import { attachBodyMods } from '../src/game/bodymods';
import { BODYTEMP, Character } from '../src/game/character';
import { MAIN_PARTS } from '../src/game/bodyparts';
import { createItem, Item } from '../src/game/item';
import { L, spawnItem } from '../src/game/moves';
import { enchantLookupIds, enchantValueTree } from '../src/game/enchantValues';
import { enchantmentActive, inClimateControl, relicEnchantments, relicInfo, timeOfDay, type CharacterWorld } from '../src/game/relicEnchant';
import { vehicleMountInside } from '../src/game/characterWorld';
import { Vehicle } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { itemInfo } from '../src/ui/iteminfo';
import { loadNodeData } from '../tools/lib/node_data';

const { game: data } = loadNodeData();

function bare(d: GameData = data): Character {
  const c = new Character(d, { seed: 5 });
  for (const it of [...c.inv.topLevel()]) c.inv.drop(it);
  return c;
}
function world(over: Partial<CharacterWorld> = {}): CharacterWorld {
  return {
    seconds: () => 12 * 3600, outside: () => true, z: () => 0, divable: () => false, onFungus: () => false,
    vehicleClimateControl: () => false, ...over,
  };
}
const wear = (c: Character, id: string, active = false): Item => {
  const it = createItem(c.data, id);
  it.active = active;
  const r = c.inv.wear(it, null);
  expect(r.ok, r.msg).toBe(true);
  return it;
};
/** Into the inventory, with a worn backpack to hold it (a bare character's only free spot is the hands). */
function carry(c: Character, it: Item): void {
  if (!c.inv.worn.some((w) => w.typeId === 'backpack')) wear(c, 'backpack');
  expect(c.inv.giveNew(it)?.kind).toBe('inv');
}
/**
 * The real data with one extra item: a real tinfoil hat whose passive effect uses `conditions`
 * (BN's own condition ids from enchantment_conditions.json). No BN item uses the time-of-day,
 * shelter, depth or water conditions, so these cover them.
 */
function withProbe(conditions: string[], extra: Record<string, unknown> = {}): GameData {
  const items = { ...data.items };
  items.probe_hat = {
    ...data.items.tinfoil_hat, id: 'probe_hat',
    relic_data: { passive_effects: [{ conditions, values: [{ value: 'PERCEPTION', add: 3 }] }] }, ...extra,
  } as (typeof items)[string];
  return { ...data, items };
}

describe('BN enchantment value tree (enchantment_value.cpp define_child_enchantments)', () => {
  it('builds CLIMATE_CONTROL children with BN parents, the torso counting the base value twice', () => {
    const tree = enchantValueTree(data);
    expect(tree.get('CLIMATE_CONTROL_COOLING_TORSO')!.parents).toEqual(['CLIMATE_CONTROL_COOLING', 'CLIMATE_CONTROL_TORSO']);
    expect(tree.get('CLIMATE_CONTROL_TORSO')!.parents).toEqual(['CLIMATE_CONTROL']);
    expect(tree.get('CLIMATE_CONTROL_COOLING_ARM_L')!.parents).toEqual(['CLIMATE_CONTROL_COOLING_ARM', 'CLIMATE_CONTROL_ARM_L']);
    expect(tree.get('CLIMATE_CONTROL_ARM_L')!.parents).toEqual(['CLIMATE_CONTROL_ARM']);
    expect(tree.get('CLIMATE_CONTROL_ARM')!.parents).toEqual([]);
    const count = (v: string, id: string) => enchantLookupIds(data, v)!.filter((x) => x === id).length;
    expect(count('CLIMATE_CONTROL_COOLING_TORSO', 'CLIMATE_CONTROL')).toBe(2);
    expect(count('CLIMATE_CONTROL_HEATING_HEAD', 'CLIMATE_CONTROL')).toBe(2);
    expect(count('CLIMATE_CONTROL_COOLING_LEG_R', 'CLIMATE_CONTROL')).toBe(1);
    expect(count('CLIMATE_CONTROL_COOLING_LEG_R', 'CLIMATE_CONTROL_LEG')).toBe(1);
    // Single-set values keep their plain chain.
    expect(enchantLookupIds(data, 'HEALTH_POINTS_ARM_L')).toEqual(['HEALTH_POINTS_ARM_L', 'HEALTH_POINTS_ARM', 'HEALTH_POINTS']);
    expect(enchantLookupIds(data, 'PAIN_GAIN')).toEqual(['PAIN_GAIN', 'PAIN']);
  });
});

describe('item enchantment conditions (enchantment_condition.cpp)', () => {
  it('every passive effect in the data uses conditions the port implements', () => {
    let n = 0;
    for (const id of Object.keys(data.items)) if (relicEnchantments(data, id)) n++;
    expect(n).toBeGreaterThan(50);
  });

  it('WORN + ACTIVE: the exoskeleton counts only worn and switched on', () => {
    const c = bare();
    const exo = createItem(data, 'power_armor_exo_1_on');
    exo.active = true;
    c.inv.giveNew(exo);
    expect(c.enchant('STRENGTH').add).toBe(0);
    expect(c.inv.wear(exo, c.inv.locOf(exo)).ok).toBe(true);
    expect(c.enchant('STRENGTH').add).toBe(2);
    exo.active = false;
    expect(c.enchant('STRENGTH').add).toBe(0);
  });

  it('WORN: a worn test hawkeye adds PERCEPTION +5; in a pocket it does nothing', () => {
    const c = bare();
    const glasses = createItem(data, 'test_enchanted_hawkeye');
    carry(c, glasses);
    c.update(1);
    const per = c.per;
    expect(c.enchant('PERCEPTION').add).toBe(0);
    expect(c.inv.wear(glasses, c.inv.locOf(glasses)).ok).toBe(true);
    c.update(1);
    expect(c.per).toBe(per + 5);
  });

  it('WIELD: the clairvoyance rod only while wielded, not carried', () => {
    const c = bare();
    const rod = createItem(data, 'clairvoyance_plus_plus_rod');
    carry(c, rod);
    expect(c.enchant('CLAIRVOYANCE').max).toBe(0);
    expect(c.inv.wield(rod, c.inv.locOf(rod)).ok).toBe(true);
    expect(c.enchant('CLAIRVOYANCE').max).toBe(10);
  });

  it('legacy "has": WIELD on a named enchantment (AEP_STR_UP) raises STR when wielded', () => {
    const d = withProbe([]);
    d.items.probe_rock = { ...data.items.rock, id: 'probe_rock', relic_data: { passive_effects: [{ id: 'AEP_STR_UP' }] } } as (typeof d.items)[string];
    const c = bare(d);
    c.update(1);
    const str = c.str;
    const rock = createItem(d, 'probe_rock');
    carry(c, rock);
    c.update(1);
    expect(c.str).toBe(str);
    expect(c.inv.wield(rock, c.inv.locOf(rock)).ok).toBe(true);
    c.update(1);
    expect(c.str).toBe(str + 4);
  });

  it('HELD + ACTIVE: an active relic counts anywhere on you, nested in a container too', () => {
    const c = bare();
    const relic = createItem(data, 'debug_active_relic_test_on');
    const bag = createItem(data, 'bag_plastic');
    const r = spawnItem(relic, L.in(bag));
    expect(r.ok, r.msg).toBe(true);
    carry(c, bag);
    relic.active = true;
    // The Cube of Shame: INTELLIGENCE and PERCEPTION -2 while held and active.
    expect(c.enchant('INTELLIGENCE').add).toBe(-2);
    expect(c.enchant('PERCEPTION').add).toBe(-2);
    relic.active = false;
    expect(c.enchant('INTELLIGENCE').add).toBe(0);
  });

  it('no conditions (always): a carried chaos dagger counts', () => {
    const c = bare();
    carry(c, createItem(data, 'chaos_dagger'));
    expect(c.enchant('MELEE_DAMAGE_DARK').multiply).toBe(2);
  });

  it('nothing inside a gun or magazine is visited (visitable.cpp visit_internal)', () => {
    const c = bare();
    const gun = createItem(data, 'glock_19');
    const dagger = createItem(data, 'chaos_dagger');
    (gun as unknown as { _contents: Item[] })._contents.push(dagger);
    carry(c, gun);
    expect(c.enchant('MELEE_DAMAGE_DARK').multiply).toBe(0);
  });

  it('HELD + ABOVEGROUND (radiation triangle): z >= 0 only, and needs a world', () => {
    const c = bare();
    const tri = createItem(data, 'radiation_triangle');
    const e = relicEnchantments(data, 'radiation_triangle')![0];
    expect(() => enchantmentActive(c, e, tri, 'carried')).toThrow(/needs Character.world/);
    let z = 0;
    c.world = world({ z: () => z });
    expect(enchantmentActive(c, e, tri, 'carried')).toBe(true);
    z = -1;
    expect(enchantmentActive(c, e, tri, 'carried')).toBe(false);
  });

  it('INSIDE / OUTSIDE / UNDERGROUND / UNDERWATER / INACTIVE follow the character and the item', () => {
    const cases: [string, Partial<CharacterWorld>, boolean, boolean?][] = [
      ['OUTSIDE', { outside: () => true }, true], ['OUTSIDE', { outside: () => false }, false],
      ['INSIDE', { outside: () => false }, true], ['INSIDE', { outside: () => true }, false],
      ['UNDERGROUND', { z: () => -1 }, true], ['UNDERGROUND', { z: () => 0 }, false],
      ['ABOVEGROUND', { z: () => 2 }, true],
      ['UNDERWATER', { divable: () => true }, true], ['UNDERWATER', { divable: () => false }, false],
      ['INACTIVE', {}, true, false], ['INACTIVE', {}, false, true], ['ACTIVE', {}, true, true],
    ];
    for (const [cond, w, expected, active] of cases) {
      const c = bare(withProbe([cond]));
      c.world = world(w);
      wear(c, 'probe_hat', active ?? false);
      expect(c.enchant('PERCEPTION').add, `${cond} ${JSON.stringify(Object.keys(w))}`).toBe(expected ? 3 : 0);
    }
  });

  it('DAY / DAWN / DUSK / NIGHT use sunrise and sunset with a one-hour twilight (calendar.cpp)', () => {
    // Spring day 1 (equinox): sunrise ~6:00, sunset ~18:00 (src/game/sun.ts).
    const h = (x: number) => x * 3600;
    expect(timeOfDay(h(12))).toEqual({ day: true, dawn: false, dusk: false, night: false });
    expect(timeOfDay(h(6.5))).toMatchObject({ day: false, dawn: true, night: false });
    expect(timeOfDay(h(18.5))).toMatchObject({ day: false, dusk: true, night: false });
    expect(timeOfDay(h(23))).toMatchObject({ day: false, night: true });
    let t = h(12);
    const c = bare(withProbe(['DAY']));
    c.world = world({ seconds: () => t });
    wear(c, 'probe_hat');
    expect(c.enchant('PERCEPTION').add).toBe(3);
    t = h(23);
    expect(c.enchant('PERCEPTION').add).toBe(0);
    const n = bare(withProbe(['NIGHT', 'WORN']));
    n.world = world({ seconds: () => h(23) });
    wear(n, 'probe_hat');
    expect(n.enchant('PERCEPTION').add).toBe(3);
  });

  it('fails loudly on a condition id the data does not define, naming the item', () => {
    const c = bare(withProbe(['RAINING']));
    expect(() => c.inv.giveNew(createItem(c.data, 'probe_hat')) && c.enchant('PERCEPTION')).toThrow(/item probe_hat: unknown enchantment condition "RAINING"/);
  });
});

describe('climate control (Character::temp_corrected_by_climate_control)', () => {
  it('moves the convergent temperature toward BODYTEMP_NORM by the per-part enchantment, in legacy units', () => {
    const c = bare();
    wear(c, 'power_armor_exo_1_on', true);
    // CLIMATE_CONTROL 2000 = 4 °C; counted twice on the torso and head (BN value tree).
    expect(c.climateCorrected(45, 'torso')).toBeCloseTo(37, 9);
    expect(c.climateCorrected(50, 'torso')).toBeCloseTo(42, 9);
    expect(c.climateCorrected(45, 'arm_l')).toBeCloseTo(41, 9);
    expect(c.climateCorrected(30, 'leg_r')).toBeCloseTo(34, 9);
    expect(c.climateCorrected(36, 'leg_r')).toBeCloseTo(37, 9);
    expect(c.climateCorrected(37, 'torso')).toBe(37);

    // The cooling suit's per-part values: torso/arm/leg 1250 (2.5 °C) each, nothing doubled.
    const s = bare();
    wear(s, 'thermal_cooling_suit_on', true);
    expect(s.climateCorrected(45, 'torso')).toBeCloseTo(42.5, 9);
    expect(s.climateCorrected(45, 'arm_r')).toBeCloseTo(42.5, 9);
    expect(s.climateCorrected(45, 'head')).toBe(45);
  });

  it('a worn CLIMATE_CONTROL-flagged item is climate control: 1250 (2.5 °C) on every part', () => {
    const d = withProbe([], { flags: ['CLIMATE_CONTROL'], relic_data: undefined });
    const c = bare(d);
    expect(inClimateControl(c)).toBe(false);
    wear(c, 'probe_hat');
    expect(inClimateControl(c)).toBe(true);
    expect(c.climateCorrected(45, 'leg_l')).toBeCloseTo(42.5, 9);
    expect(c.climateCorrected(20, 'head')).toBeCloseTo(22.5, 9);
  });

  it('a powered, enclosed vehicle tile is climate control (vehicle::refresh_insides + total power)', () => {
    const vd = JSON.parse(readFileSync('public/data/vehicles.json', 'utf8')) as VehicleDataFile;
    const v = new Vehicle(vd, 'car');
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) v.addPart(vd.parts.roof, x, y);
    expect(vehicleMountInside(v, 0, 0)).toBe(true);
    expect(vehicleMountInside(v, 1, 0)).toBe(false);
    const open = new Vehicle(vd, 'car');
    open.addPart(vd.parts.roof, 0, 0);
    open.addPart(vd.parts.roof, 0, 1);
    open.addPart(vd.parts.roof, 0, -1);
    open.addPart(vd.parts.windshield, 1, 0);
    const door = open.addPart(vd.parts.door, -1, 0);
    expect(vehicleMountInside(open, 0, 0)).toBe(true);
    door.open = true;
    expect(vehicleMountInside(open, 0, 0)).toBe(false);
    const c = bare();
    c.world = world({ vehicleClimateControl: () => true });
    expect(inClimateControl(c)).toBe(true);
  });

  function powered(): { c: Character; exo: Item } {
    const c = bare();
    const bio = attachBodyMods(c).bio;
    bio.add('bio_power_armor_interface_mkII');
    bio.maxPowerLevel = 5000;
    bio.power = 5000;
    expect(bio.activate('bio_power_armor_interface_mkII')).toBe(true);
    const exo = wear(c, 'power_armor_exo_1');
    expect(c.inv.use(exo).ok).toBe(true);
    expect(exo.active).toBe(true);
    return { c, exo };
  }
  const settle = (c: Character, seconds = 3600) => {
    for (let t = 0; t < seconds; t += 60) c.update(60);
  };

  it('a running exoskeleton keeps you comfortable at -20 °C where the switched-off one leaves you very cold', () => {
    const off = bare();
    wear(off, 'power_armor_exo_1');
    off.env = { temperature: -20, wind: 0, precipitation: false };
    settle(off);
    expect(off.bodyTempDescription()).toBe('Very cold!');

    const { c, exo } = powered();
    c.env = { temperature: -20, wind: 0, precipitation: false };
    settle(c);
    expect(exo.active).toBe(true);
    expect(c.bodyTempDescription()).toBe('Comfortable');
    for (const p of MAIN_PARTS) expect(c.bodyTemp[p], p).toBeGreaterThan(BODYTEMP.COLD);
  }, 30000);

  it('and in 30 °C sun, where the switched-off exoskeleton is too hot', () => {
    const off = bare();
    wear(off, 'power_armor_exo_1');
    off.env = { temperature: 30, wind: 0, precipitation: false, sun: 1 };
    settle(off);
    expect(['Warm', 'Very hot!']).toContain(off.bodyTempDescription());

    const { c } = powered();
    c.env = { temperature: 30, wind: 0, precipitation: false, sun: 1 };
    settle(c);
    expect(c.bodyTempDescription()).toBe('Comfortable');
    for (const p of MAIN_PARTS) expect(c.bodyTemp[p], p).toBeLessThanOrEqual(BODYTEMP.HOT);
  }, 30000);
});

describe('item info (item::enchantment_info)', () => {
  it('lists conditions and effects, and whether they apply to you now', () => {
    const c = bare();
    const exo = wear(c, 'power_armor_exo_1');
    const info = relicInfo(c, exo);
    expect(info).toHaveLength(1);
    expect(info[0].condition).toBe('While active and While worn');
    expect(info[0].inEffect).toBe(false);
    expect(info[0].lines.map((l) => l.text)).toEqual(['Affects Strength (+2)', 'Keeps you comfortable against All temperatures ( All Bodyparts ) (+4 °C)']);
    exo.active = true;
    expect(relicInfo(c, exo)[0].inEffect).toBe(true);
    const html = itemInfo(exo, c);
    expect(html).toContain('While active and While worn');
    expect(html).toContain('(in effect)');
    // Not on you: no in-effect note.
    const loose = createItem(data, 'test_enchanted_hawkeye');
    expect(relicInfo(c, loose)[0].inEffect).toBeNull();
  });
});
