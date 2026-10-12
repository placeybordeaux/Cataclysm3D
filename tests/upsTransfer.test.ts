// Carried UPS → carried UPS-charged devices (src/game/upsTransfer.ts, BN Character::process_items).
// Real BN data: UPS_off (ups_recharge_rate default 5, ups_eff_mult default 1) and adv_UPS_off
// (ups_recharge_rate 10, ups_eff_mult 2, data/json/items/tool/electronics.json).
import { describe, expect, it } from 'vitest';
import { Character } from '../src/game/character';
import { createItem, inNewContainer, Item, loadAmmo } from '../src/game/item';
import { L, spawnItem } from '../src/game/moves';
import {
  addEnergy, belongingsOf, drawEnergy, energyStorage, storedEnergy, transferCarriedUps, upsEffMult, upsRechargeRate,
  upsStatusLine, upsUsefulEnergy,
} from '../src/game/upsTransfer';
import { BnInventoryModel } from '../src/ui2/bn/model';
import { loadNodeData } from '../tools/lib/node_data';

const { game: data } = loadNodeData();

function survivor(): { c: Character; log: string[] } {
  const c = new Character(data, { seed: 7 });
  const log: string[] = [];
  c.onMessage = (t) => log.push(t);
  // Nothing from a start kit may supply or soak up UPS charge.
  for (const it of [...c.inv.topLevel()]) c.inv.drop(it);
  expect(c.inv.wear(createItem(data, 'backpack'), null).ok).toBe(true);
  return { c, log };
}
const give = (c: Character, it: Item) => {
  expect(c.inv.giveNew(it)).not.toBeNull();
  return it;
};
/** A UPS_off holding a heavy battery with `charges` kJ. */
function ups(charges: number): Item {
  const u = createItem(data, 'UPS_off');
  const bat = createItem(data, 'heavy_battery_cell');
  loadAmmo(bat, 'battery', charges);
  expect(spawnItem(bat, L.mag(u)).ok).toBe(true);
  expect(u.ammoRemaining()).toBe(charges);
  return u;
}
function advUps(charges: number): Item {
  const u = createItem(data, 'adv_UPS_off', { charges });
  expect(u.ammoRemaining()).toBe(charges);
  return u;
}
/** A budget wrist computer (USE_UPS, integral 600 kJ, NO_RELOAD) holding `charges`. */
const exo = (charges = 0) => createItem(data, 'wrist_comp_budget', { charges });
const b = (c: Character) => belongingsOf(c.inv);
const step = (c: Character, s: number) => transferCarriedUps(b(c), s);

describe('carried UPS transfer: BN units', () => {
  it('reads the source rates and efficiency from the extracted items', () => {
    expect(upsRechargeRate(createItem(data, 'UPS_off'))).toBe(5);
    expect(upsEffMult(createItem(data, 'UPS_off'))).toBe(1);
    expect(upsRechargeRate(createItem(data, 'adv_UPS_off'))).toBe(10);
    expect(upsEffMult(createItem(data, 'adv_UPS_off'))).toBe(2);
  });

  it('a UPS gives 5 useful kJ per second, 1:1 from its battery', () => {
    const { c } = survivor();
    const u = give(c, ups(100));
    const suit = give(c, exo());
    step(c, 1);
    expect(suit.ammoRemaining()).toBe(5);
    expect(u.ammoRemaining()).toBe(95);
    step(c, 3);
    expect(suit.ammoRemaining()).toBe(20);
    expect(u.ammoRemaining()).toBe(80);
  });

  it('an advanced UPS gives 10 useful kJ per second for 5 of its own charges (efficiency 2)', () => {
    const { c } = survivor();
    const u = give(c, advUps(100));
    const suit = give(c, exo());
    expect(upsUsefulEnergy(u)).toBe(200);
    step(c, 1);
    expect(suit.ammoRemaining()).toBe(10);
    expect(u.ammoRemaining()).toBe(95);
  });

  it('keeps fractional energy on both batteries across a save, with no rounding leak', () => {
    const { c } = survivor();
    const u = give(c, ups(100));
    const suit = give(c, exo());
    step(c, 0.3); // 1.5 kJ
    expect(suit.ammoRemaining()).toBe(1);
    expect(suit.vars.recharge_kj).toBeCloseTo(0.5);
    expect(storedEnergy(energyStorage(u))).toBeCloseTo(98.5);
    const saved = JSON.parse(JSON.stringify(c.inv.toJSON()));
    const { c: c2 } = survivor();
    c2.inv.load(saved);
    const [u2] = c2.inv.allItems().filter((i) => i.typeId === 'UPS_off');
    const [suit2] = c2.inv.allItems().filter((i) => i.typeId === 'wrist_comp_budget');
    expect(storedEnergy(energyStorage(u2))).toBeCloseTo(98.5, 9);
    expect(storedEnergy(suit2)).toBeCloseTo(1.5, 9);
    step(c2, 0.1); // 0.5 kJ more: exactly 2 charges, no credit left over
    expect(suit2.ammoRemaining()).toBe(2);
    expect(suit2.vars.recharge_kj).toBeUndefined();
    expect(storedEnergy(energyStorage(u2))).toBeCloseTo(98, 9);
  });

  it('the advanced UPS keeps half-charges exactly instead of BN\'s random rounding', () => {
    const { c } = survivor();
    const u = give(c, advUps(10));
    const suit = give(c, exo());
    step(c, 0.1); // 1 useful kJ = 0.5 of its own charge
    expect(suit.ammoRemaining()).toBe(1);
    expect(u.ammoRemaining()).toBe(9);
    expect(u.vars.recharge_kj).toBeCloseTo(0.5);
    expect(Item.fromJSON(data, u.toJSON()).vars.recharge_kj).toBeCloseTo(0.5);
    step(c, 0.1);
    expect(u.ammoRemaining()).toBe(9);
    expect(u.vars.recharge_kj).toBeUndefined();
  });
});

describe('carried UPS transfer: limits and conservation', () => {
  it('stops at device capacity and leaves the rest in the UPS', () => {
    const { c } = survivor();
    const u = give(c, ups(1000));
    const suit = give(c, exo(598));
    step(c, 10);
    expect(suit.ammoRemaining()).toBe(600);
    expect(u.ammoRemaining()).toBe(998);
    expect(step(c, 10).delivered).toBe(0);
  });

  it('a finite UPS delivers exactly what it holds and no more', () => {
    const { c } = survivor();
    const u = give(c, ups(3));
    const suit = give(c, exo());
    step(c, 100);
    expect(suit.ammoRemaining()).toBe(3);
    expect(u.ammoRemaining()).toBe(0);
    expect(storedEnergy(energyStorage(u))).toBe(0);
    expect(step(c, 100).delivered).toBe(0);
  });

  it('rates add across several UPSes, each paying only for what it gave', () => {
    const { c } = survivor();
    const a = give(c, ups(100));
    const adv = give(c, advUps(100));
    const suit = give(c, exo());
    step(c, 1); // 5 + 10 useful
    expect(suit.ammoRemaining()).toBe(15);
    expect(a.ammoRemaining()).toBe(95);
    expect(adv.ammoRemaining()).toBe(95);
  });

  it('conserves useful energy over many irregular steps (UPS stored × efficiency + devices)', () => {
    const { c } = survivor();
    const sources = [give(c, ups(37)), give(c, advUps(23))];
    const devices = [give(c, exo(0)), give(c, exo(590))];
    const total = () => sources.reduce((n, u) => n + upsUsefulEnergy(u), 0) + devices.reduce((n, d) => n + storedEnergy(d), 0);
    const start = total();
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 400; i++) {
      step(c, rnd() * 0.7);
      expect(total()).toBeCloseTo(start, 6);
      for (const u of sources) expect(storedEnergy(energyStorage(u))).toBeGreaterThanOrEqual(0);
      for (const d of devices) expect(storedEnergy(d)).toBeLessThanOrEqual(d.ammoCapacity() + 1e-9);
    }
    // Everything the UPSes held has moved (37 + 2×23 = 83 useful kJ; 10 + 600 room).
    expect(sources.every((u) => storedEnergy(energyStorage(u)) < 1e-6)).toBe(true);
    expect(devices[0].ammoRemaining() + devices[1].ammoRemaining()).toBe(590 + 83);
  });

  it('drawEnergy refuses to take more than a battery holds; addEnergy refuses to overfill', () => {
    const bat = createItem(data, 'heavy_battery_cell');
    loadAmmo(bat, 'battery', 2);
    expect(() => drawEnergy(bat, 2.5)).toThrow();
    const full = exo(600);
    expect(() => addEnergy(full, 1)).toThrow();
  });
});

describe('carried UPS transfer: which items', () => {
  it('charges a device stowed in a bag, but never a UPS or a non-UPS device', () => {
    const { c } = survivor();
    give(c, ups(100));
    const smart = give(c, createItem(data, 'smart_phone', { charges: 0 })); // RECHARGE, not USE_UPS
    const { container: bag } = inNewContainer(data, exo(), 'bag_canvas');
    give(c, bag);
    const inBag = bag.contents[0];
    const other = give(c, advUps(10));
    step(c, 1); // 5 from the UPS + 10 from the advanced one, which is a source, not a target
    expect(inBag.ammoRemaining()).toBe(15);
    expect(smart.ammoRemaining()).toBe(0);
    expect(other.ammoRemaining()).toBe(5);
  });

  it('never touches an unfinished craft: neither its escrowed UPS nor its escrowed device', () => {
    const { c } = survivor();
    const craft = createItem(data, 'craft');
    craft.vars = { craft_recipe: 'fixture', craft_progress: 0.5 };
    const escrowUps = ups(100);
    const escrowDev = exo();
    expect(spawnItem(escrowUps, L.in(craft), { force: true }).ok).toBe(true);
    expect(spawnItem(escrowDev, L.in(craft), { force: true }).ok).toBe(true);
    const { container: bag } = inNewContainer(data, craft, 'bag_canvas');
    give(c, bag);
    const before = JSON.stringify(craft.toJSON());
    const mine = give(c, exo());
    expect(step(c, 10).delivered).toBe(0);
    expect(c.inv.upsCharges()).toBe(0);
    expect(c.inv.useUpsCharges(5)).toBe(0);
    give(c, ups(50));
    step(c, 10);
    expect(mine.ammoRemaining()).toBe(50);
    expect(JSON.stringify(craft.toJSON())).toBe(before);
  });

  it('magazine-fed: only a rechargeable magazine, never an empty well', () => {
    const { c } = survivor();
    give(c, ups(100));
    const lit = createItem(data, 'flashlight');
    lit.flags.push('USE_UPS');
    give(c, lit);
    expect(lit.magazine).toBeNull();
    step(c, 1);
    expect(lit.magazine).toBeNull(); // no battery conjured
    const disp = createItem(data, 'light_disposable_cell', { charges: 0 });
    disp.ammoConsume(disp.ammoRemaining());
    expect(spawnItem(disp, L.mag(lit)).ok).toBe(true);
    step(c, 1);
    expect(lit.ammoRemaining()).toBe(0);
    c.inv.unload(lit);
    const cell = createItem(data, 'light_battery_cell');
    expect(spawnItem(cell, L.mag(lit)).ok).toBe(true);
    step(c, 1);
    expect(cell.ammoRemaining()).toBe(5);
  });
});

describe('carried UPS transfer: player-facing', () => {
  it('Enable/disable UPS charging (BN TOGGLE_UPS_CHARGING) decides whether a game is charged', () => {
    const { c, log } = survivor();
    give(c, ups(100));
    const game = give(c, createItem(data, 'portable_game', { charges: 0 }));
    expect(upsStatusLine(game, b(c))).toMatch(/UPS charging is off/);
    c.update(1);
    expect(game.ammoRemaining()).toBe(0);
    const idx = (game.def.use_action as unknown[]).indexOf('TOGGLE_UPS_CHARGING');
    expect(c.inv.use(game, undefined, idx).ok).toBe(true);
    expect(log.at(-1)).toBe('You will recharge the handheld game system using any available Unified Power System.');
    expect(upsStatusLine(game, b(c))).toMatch(/^Charging from your UPS \(0\/200\)/);
    c.update(2);
    expect(game.ammoRemaining()).toBe(10);
    expect(c.inv.use(game, undefined, idx).ok).toBe(true);
    expect(log.at(-1)).toBe('You will no longer recharge the handheld game system via UPS.');
    c.update(2);
    expect(game.ammoRemaining()).toBe(10);
    // The choice is the item's own tag, so it survives a save.
    c.inv.use(game, undefined, idx);
    expect(Item.fromJSON(data, game.toJSON()).hasFlag('USE_UPS')).toBe(true);
  });

  it('says once when the UPS runs dry while a device still wants charge', () => {
    const { c, log } = survivor();
    const u = give(c, ups(4));
    const suit = give(c, exo());
    expect(upsStatusLine(u, b(c))).toBe('UPS: 4 kJ usable; charges UPS-powered devices you carry at up to 5 kJ/s.');
    c.update(0.5);
    c.update(1);
    c.update(1);
    c.update(1);
    expect(suit.ammoRemaining()).toBe(4);
    expect(log.filter((l) => /no charge left/.test(l))).toEqual(['Your UPS has no charge left for your wrist computer.']);
    expect(upsStatusLine(suit, b(c))).toBe('Not charging: your UPS is out of charge.');
  });

  it('reload on a UPS-charged device with a charged UPS carried says so (not "You don\'t have one")', () => {
    const { c } = survivor();
    give(c, ups(100));
    const suit = give(c, exo());
    expect(c.inv.whyNoReload(suit)).toBe("Your wrist computer can't be reloaded: it runs on the UPS you carry.");
  });

  it('describes an advanced UPS with its efficiency', () => {
    const { c } = survivor();
    const u = give(c, advUps(5));
    expect(upsStatusLine(u, b(c))).toBe('UPS: 10 kJ usable; charges UPS-powered devices you carry at up to 10 kJ/s. UPS efficiency ×2.');
  });

  // Real-input QA (upscharge): a charging game's tooltip never opened when its row was replaced
  // during the hover delay. The inventory polls model.refresh() every 400 ms and every list
  // re-renders all its rows on onChange, so a refresh must only fire when something shown changed.
  it('the inventory model stays quiet over a charging device until its charge really changes', () => {
    const { c } = survivor();
    give(c, ups(1000));
    const game = give(c, createItem(data, 'portable_game', { charges: 0 }));
    c.inv.use(game, undefined, (game.def.use_action as unknown[]).indexOf('TOGGLE_UPS_CHARGING'));
    c.update(1);
    const model = new BnInventoryModel(() => ({ who: c }));
    let changes = 0;
    model.onChange(() => changes++);
    const row = () => model.contents('inv').find((v) => v.typeId === 'portable_game')!;
    const before = row();
    expect(before.note).toMatch(/^Charging from your UPS \(5\/200\)/);
    for (let i = 0; i < 20; i++) model.refresh();
    expect(changes).toBe(0);
    expect(row().id).toBe(before.id);
    expect(row().note).toBe(before.note);
    // A real transfer changes what the rows show (both batteries' charges): one onChange.
    c.update(1);
    model.refresh();
    expect(changes).toBe(1);
    expect(row().charges?.cur).toBe(game.ammoRemaining());
  });
});

describe('direct UPS draw (USE_UPS tools running on a carried UPS)', () => {
  it('counts and draws an advanced UPS at its efficiency (regression: it used to count 1:1)', () => {
    const { c } = survivor();
    const u = give(c, advUps(100));
    expect(c.inv.upsCharges()).toBe(200);
    expect(c.inv.useUpsCharges(10)).toBe(10);
    expect(u.ammoRemaining()).toBe(95);
    expect(c.inv.useUpsCharges(1)).toBe(1);
    expect(u.ammoRemaining()).toBe(94);
    expect(u.vars.recharge_kj).toBeCloseTo(0.5);
    expect(c.inv.upsCharges()).toBe(189);
  });

  it('an active exo-suit with an empty cell runs on the advanced UPS at half the UPS charge', () => {
    const { c } = survivor();
    const u = give(c, advUps(10));
    const suit = createItem(data, 'exosuit_survivor_on', { charges: 0 });
    suit.active = true;
    give(c, suit);
    // 500 W: the suit needs 1 kJ every 2 s. The transfer refills its cell first, so measure
    // the UPS: in 8 s the suit used 4 kJ = 2 advanced-UPS charges; the rest sits in the suit.
    c.update(8);
    expect(upsUsefulEnergy(u) + storedEnergy(suit)).toBeCloseTo(20 - 4, 6);
  });
});
