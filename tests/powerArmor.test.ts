// BN power armor (src/game/powerArmor.ts, docs/BN_POWER_ARMOR.md). Real BN data:
// items/armor/power_armor.json (power_armor_exo_1: set_transform, set_charges 2; _on: power_draw
// 2250000 mW; helmet_basic_on 500000 mW; plating_1: set_transformed), bionics.json
// (bio_power_armor_interface fuel_efficiency 2, _mkII 4), UPS_off (items/tool/electronics.json).
import { describe, expect, it } from 'vitest';
import { attachBodyMods } from '../src/game/bodymods';
import { Character } from '../src/game/character';
import { createItem, Item, loadAmmo } from '../src/game/item';
import { L, spawnItem } from '../src/game/moves';
import { DRAW_VAR, powerArmorStatusLine } from '../src/game/powerArmor';
import { loadNodeData } from '../tools/lib/node_data';

const { game: data } = loadNodeData();

function survivor(): { c: Character; log: string[] } {
  const c = new Character(data, { seed: 7 });
  const log: string[] = [];
  c.onMessage = (t) => log.push(t);
  // Power armor can't go over other gear: start bare.
  for (const it of [...c.inv.topLevel()]) c.inv.drop(it);
  return { c, log };
}
function ups(charges: number): Item {
  const u = createItem(data, 'UPS_off');
  const bat = createItem(data, 'heavy_battery_cell');
  bat.ammoConsume(bat.ammoRemaining());
  loadAmmo(bat, 'battery', charges);
  expect(spawnItem(bat, L.mag(u)).ok).toBe(true);
  expect(u.ammoRemaining()).toBe(charges);
  return u;
}
const wear = (c: Character, id: string) => {
  const it = createItem(data, id);
  const r = c.inv.wear(it, null);
  expect(r.ok, r.msg).toBe(true);
  return it;
};
/** Exoskeleton + heavy plating + basic helmet, worn. */
function suit(c: Character) {
  return { exo: wear(c, 'power_armor_exo_1'), plating: wear(c, 'power_armor_plating_1'), helmet: wear(c, 'power_armor_helmet_basic') };
}
function withInterface(c: Character, id = 'bio_power_armor_interface', power = 1000, on = true) {
  const bio = attachBodyMods(c).bio;
  bio.add(id);
  bio.maxPowerLevel = 2000;
  bio.power = power;
  if (on) expect(bio.activate(id)).toBe(true);
  return bio;
}
/** Simulate `seconds` of game time in frames, like Character.update does. */
function run(c: Character, seconds: number, frame = 0.1) {
  for (let t = 0; t < seconds - 1e-9; t += frame) c.inv.update(frame);
}
const upsKj = (c: Character) => c.inv.upsCharges();
const owed = (...its: Item[]) => its.reduce((n, it) => n + Number(it.vars[DRAW_VAR] ?? 0), 0);

describe('power armor wearing rules (BN Character::can_wear)', () => {
  it('blocks power armor over other gear, parts without an exoskeleton, doubles and gear over it', () => {
    const { c } = survivor();
    const shirt = createItem(data, 'tshirt');
    expect(c.inv.wear(shirt, null).ok).toBe(true);
    expect(c.inv.canWear(createItem(data, 'power_armor_exo_1')).reason).toBe("Can't wear power armor over other gear!");
    expect(c.inv.takeOff(shirt).ok).toBe(true);
    expect(c.inv.canWear(createItem(data, 'power_armor_helmet_basic')).reason).toBe('You can only wear power armor components with power armor!');
    expect(c.inv.canWear(createItem(data, 'power_armor_plating_1')).reason).toBe('You can only wear power armor components with power armor!');
    wear(c, 'power_armor_exo_1');
    expect(c.inv.canWear(createItem(data, 'power_armor_exo_2')).reason).toBe("Can't wear multiple exoskeletons!");
    expect(c.inv.canWear(createItem(data, 'tshirt')).reason).toBe("Can't wear t-shirt with power armor!");
    wear(c, 'power_armor_plating_1');
    expect(c.inv.canWear(createItem(data, 'power_armor_plating_2')).reason).toBe("Can't wear overlapping sets of plating!");
    wear(c, 'power_armor_helmet_basic');
    expect(c.inv.canWear(createItem(data, 'power_armor_helmet_light')).reason).toBe("Can't wear externals over one another!");
  });
});

describe('switching power armor on (BN set_transform_iuse)', () => {
  it('needs power: no UPS and no interface keeps it off with BN\'s message', () => {
    const { c, log } = survivor();
    const { exo } = suit(c);
    const r = c.inv.use(exo);
    expect(r.ok).toBe(false);
    expect(log.at(-1)).toMatch(/^You need a UPS or a bionic armor interface to power this\./);
    expect(exo.typeId).toBe('power_armor_exo_1');
    expect(exo.active).toBe(false);
  });

  it('set_charges is 2: a UPS with 1 useful kJ is not enough, 2 is', () => {
    const { c } = survivor();
    const { exo } = suit(c);
    const u = ups(1);
    expect(c.inv.giveNew(u)).not.toBeNull();
    expect(c.inv.use(exo).ok).toBe(false);
    u.magazine!.ammoConsume(1);
    loadAmmo(u.magazine!, 'battery', 2);
    expect(c.inv.use(exo).ok).toBe(true);
  });

  it('must be worn (iuse_transform need_worn)', () => {
    const { c, log } = survivor();
    wear(c, 'backpack');
    expect(c.inv.giveNew(ups(100))).not.toBeNull();
    // Too big for the backpack: held in the hands.
    const exo = createItem(data, 'power_armor_exo_1');
    const w = c.inv.wield(exo, null);
    expect(w.ok, w.msg).toBe(true);
    expect(c.inv.use(exo).ok).toBe(false);
    expect(log.at(-1)).toBe('You need to wear the prototype power armor exoskeleton before activating it.');
  });

  it('engages the exoskeleton and switches the worn plating and helmet on, with BN messages', () => {
    const { c, log } = survivor();
    const { exo, plating, helmet } = suit(c);
    expect(c.inv.giveNew(ups(100))).not.toBeNull();
    const before = log.length;
    expect(c.inv.use(exo).ok).toBe(true);
    expect(log.slice(before)).toEqual([
      'The prototype power armor exoskeleton engages.',
      // Worn order (innermost layer first, as BN's worn list): the helmet, then the OUTER plating.
      'The power armor helmet seals shut and beeps once.',
      'The heavy power armor plating feels lighter.',
    ]);
    expect([exo.typeId, plating.typeId, helmet.typeId]).toEqual(['power_armor_exo_1_on', 'power_armor_plating_1_on', 'power_armor_helmet_basic_on']);
    expect([exo.active, plating.active, helmet.active]).toEqual([true, true, true]);
    // Turning it off reverts the active pieces (turn_off: true).
    const mid = log.length;
    expect(c.inv.use(exo).ok).toBe(true);
    expect(log.slice(mid)).toEqual([
      'The prototype power armor exoskeleton (active) disengages.',
      'The power armor helmet (active) powers down.',
      'The heavy power armor plating (active) feels heavier.',
    ]);
    expect([exo.typeId, plating.typeId, helmet.typeId]).toEqual(['power_armor_exo_1', 'power_armor_plating_1', 'power_armor_helmet_basic']);
    expect([exo.active, plating.active, helmet.active]).toEqual([false, false, false]);
  });

  it('pieces refuse direct activation (set_transformed restricted)', () => {
    const { c, log } = survivor();
    const { plating } = suit(c);
    expect(c.inv.giveNew(ups(100))).not.toBeNull();
    expect(c.inv.use(plating).ok).toBe(false);
    expect(log.at(-1)).toBe('Activate via main piece.');
    expect(plating.typeId).toBe('power_armor_plating_1');
  });

  it('active state effects come from BN data: _on encumbrance and protection, +2 STRENGTH while worn and active', () => {
    const { c } = survivor();
    const { exo, plating } = suit(c);
    expect(c.inv.giveNew(ups(100))).not.toBeNull();
    const enc = () => [c.inv.itemEncumbrance(exo, 'torso'), c.inv.itemEncumbrance(plating, 'torso')];
    expect(enc()).toEqual([30, 30]);
    expect(c.enchant('STRENGTH').add).toBe(0);
    const strOff = (c.update(1), c.str);
    expect(c.inv.use(exo).ok).toBe(true);
    expect(enc()).toEqual([10, 20]);
    expect(c.enchant('STRENGTH').add).toBe(2);
    c.update(1);
    expect(c.str).toBe(strOff + 2);
    expect(exo.def.environmental_protection).toBe(16);
  });
});

describe('power armor energy (BN item::process_tool)', () => {
  it('draws 2.25 kJ/s (exo) + 0.5 kJ/s (helmet) from a carried UPS, energy conserved', () => {
    const { c } = survivor();
    const { exo, helmet } = suit(c);
    expect(c.inv.giveNew(ups(1000))).not.toBeNull();
    expect(c.inv.use(exo).ok).toBe(true);
    run(c, 100);
    // Paid + still owed = exactly power × time (2.75 kJ/s × 100 s).
    expect(1000 - upsKj(c) + owed(exo, helmet)).toBeCloseTo(275, 6);
    expect(owed(exo, helmet)).toBeLessThan(2);
  });

  it('a powered armor interface pays first, at kJ / fuel_efficiency of bionic power; the UPS is untouched', () => {
    const { c } = survivor();
    const { exo, helmet } = suit(c);
    expect(c.inv.giveNew(ups(1000))).not.toBeNull();
    const bio = withInterface(c, 'bio_power_armor_interface', 1000);
    expect(c.inv.use(exo).ok).toBe(true);
    run(c, 100);
    expect(upsKj(c)).toBe(1000);
    expect(2 * (1000 - bio.power) + owed(exo, helmet)).toBeCloseTo(275, 6);
    expect(powerArmorStatusLine(c, exo)).toMatch(/from your bionic power through your armor interface/);
  });

  it('the Mk. II interface is four times as efficient', () => {
    const { c } = survivor();
    const { exo, helmet } = suit(c);
    const bio = withInterface(c, 'bio_power_armor_interface_mkII', 1000);
    expect(c.inv.use(exo).ok).toBe(true);
    run(c, 100);
    expect(4 * (1000 - bio.power) + owed(exo, helmet)).toBeCloseTo(275, 6);
  });

  it('an unpowered interface does nothing: the UPS pays', () => {
    const { c } = survivor();
    const { exo } = suit(c);
    expect(c.inv.giveNew(ups(1000))).not.toBeNull();
    const bio = withInterface(c, 'bio_power_armor_interface', 1000, false);
    expect(c.inv.use(exo).ok).toBe(true);
    run(c, 10);
    expect(bio.power).toBe(1000);
    expect(upsKj(c)).toBeLessThan(1000);
  });

  it('a powered interface with no bionic power refuses to switch on, even with a UPS (BN has_power check)', () => {
    const { c, log } = survivor();
    const { exo } = suit(c);
    expect(c.inv.giveNew(ups(1000))).not.toBeNull();
    withInterface(c, 'bio_power_armor_interface', 0);
    expect(c.inv.use(exo).ok).toBe(false);
    expect(log.at(-1)).toBe('You need a UPS or a bionic armor interface to power this.');
  });

  it('bionic power runs out → the UPS takes over', () => {
    const { c } = survivor();
    const { exo, helmet } = suit(c);
    expect(c.inv.giveNew(ups(1000))).not.toBeNull();
    const bio = withInterface(c, 'bio_power_armor_interface', 10);
    expect(c.inv.use(exo).ok).toBe(true);
    run(c, 20);
    // 10 kJ of bionic power paid 20 kJ of draw; the rest (55 − 20) came from the UPS.
    expect(bio.power).toBeLessThan(0.5);
    expect(2 * (10 - bio.power) + (1000 - upsKj(c)) + owed(exo, helmet)).toBeCloseTo(55, 6);
    expect(exo.active).toBe(true);
  });

  it('turns off when power runs out: BN message, pieces off, exoskeleton reverts', () => {
    const { c, log } = survivor();
    const { exo, plating, helmet } = suit(c);
    expect(c.inv.giveNew(ups(10))).not.toBeNull();
    expect(c.inv.use(exo).ok).toBe(true);
    run(c, 10);
    expect(upsKj(c)).toBe(0);
    expect([exo.typeId, plating.typeId, helmet.typeId]).toEqual(['power_armor_exo_1', 'power_armor_plating_1', 'power_armor_helmet_basic']);
    expect([exo.active, plating.active, helmet.active]).toEqual([false, false, false]);
    expect(log).toContain('You need a UPS or Bionic Power Interface to run the prototype power armor exoskeleton (active)!');
    expect(log).toContain('The heavy power armor plating (active) feels heavier.');
    // Nothing keeps drawing afterwards.
    const o = owed(exo, helmet);
    run(c, 10);
    expect(owed(exo, helmet)).toBe(o);
  });

  it('pieces turn off once no active exoskeleton is worn', () => {
    const { c, log } = survivor();
    const { exo, plating } = suit(c);
    expect(c.inv.giveNew(ups(1000))).not.toBeNull();
    expect(c.inv.use(exo).ok).toBe(true);
    expect(c.inv.takeOff(exo).ok).toBe(true);
    c.inv.update(0.1);
    expect(plating.typeId).toBe('power_armor_plating_1');
    expect(plating.active).toBe(false);
    expect(log).toContain('The heavy power armor plating (active) feels heavier.');
  });

  it('toggling does not dodge the bill: the unpaid fraction stays on the item', () => {
    const { c } = survivor();
    const { exo, helmet } = suit(c);
    expect(c.inv.giveNew(ups(1000))).not.toBeNull();
    for (let i = 0; i < 50; i++) {
      expect(c.inv.use(exo).ok).toBe(true);
      c.inv.update(0.2);
      expect(c.inv.use(exo).ok).toBe(true);
    }
    expect(1000 - upsKj(c) + owed(exo, helmet)).toBeCloseTo(50 * 0.2 * 2.75, 6);
  });

  it('saves and loads the active state and the unpaid fraction', () => {
    const { c } = survivor();
    const { exo } = suit(c);
    expect(c.inv.giveNew(ups(1000))).not.toBeNull();
    expect(c.inv.use(exo).ok).toBe(true);
    run(c, 3.3);
    const used = 1000 - upsKj(c);
    const j = JSON.parse(JSON.stringify(c.inv.toJSON()));
    const { c: d } = survivor();
    d.inv.load(j);
    const exo2 = d.inv.worn.find((w) => w.typeId === 'power_armor_exo_1_on')!;
    const helm2 = d.inv.worn.find((w) => w.typeId === 'power_armor_helmet_basic_on')!;
    expect(exo2.active && helm2.active).toBe(true);
    expect(d.inv.worn.find((w) => w.typeId === 'power_armor_plating_1_on')?.active).toBe(true);
    expect(owed(exo2, helm2)).toBeCloseTo(owed(exo, c.inv.worn.find((w) => w.typeId === 'power_armor_helmet_basic_on')!), 9);
    run(d, 6.7);
    expect(used + (upsKj(c) - upsKj(d)) + owed(exo2, helm2)).toBeCloseTo(27.5, 6);
  });
});

// BN items/armor/exosuits: plain `transform` with need_worn and need_charges 1, relic passive_effects
// [WORN, ACTIVE]. Not power armor, but BN applies every item's enchantments.
describe('exo-suits (iuse_transform + relic passive effects)', () => {
  it('must be worn to switch on, then adds STRENGTH +4 and SPEED +25 (military) while worn and active', () => {
    const { c, log } = survivor();
    const suit = createItem(data, 'exosuit_military', { charges: 100 });
    const at = c.inv.giveNew(suit);
    expect(at).not.toBeNull();
    expect(c.inv.use(suit).ok).toBe(false);
    expect(log.at(-1)).toMatch(/^You need to wear the military exo-suit.* before activating it\.$/);
    expect(suit.active).toBe(false);

    const worn = c.inv.wear(suit, at);
    expect(worn.ok, worn.msg).toBe(true);
    c.update(1);
    const strOff = c.str, speedOff = c.speed;
    expect(c.enchant('STRENGTH').add).toBe(0);
    expect(c.inv.use(suit).ok).toBe(true);
    expect(suit.typeId).toBe('exosuit_military_on');
    expect(c.enchant('STRENGTH').add).toBe(4);
    expect(c.enchant('SPEED').add).toBe(25);
    c.update(1);
    expect(c.str).toBe(strOff + 4);
    expect(c.speed).toBeGreaterThan(speedOff);

    expect(c.inv.use(suit).ok).toBe(true);
    expect(suit.typeId).toBe('exosuit_military');
    expect(c.enchant('STRENGTH').add).toBe(0);
  });
});
