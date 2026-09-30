// The reload helper (src/game/reloadhelp.ts): a failed reload says what the item takes, with
// examples (recently seen > common in BN spawn data > any), and tells the failure modes apart.
// Real BN data (public/data), so the examples are the ones a player would meet.
import { describe, expect, it } from 'vitest';
import type { Input } from '../src/core/input';
import { Character } from '../src/game/character';
import { Game } from '../src/game/game';
import { createItem, loadAmmo } from '../src/game/item';
import { LootMemory } from '../src/game/loot';
import { L, spawnItem } from '../src/game/moves';
import {
  commonness, explainNoReload, pickExamples, placePhrase, reloadHintsFor, reloadNeeds, setReloadHints, takesLine, type ReloadHints,
} from '../src/game/reloadhelp';
import { SeenItems } from '../src/game/seenitems';
import { applySave, serializeGame } from '../src/save/format';
import { installSeenItems } from '../src/ui2/loot/seen';
import { TestGenerator } from '../src/world/testgen';
import { loadNodeData } from '../tools/lib/node_data';

const { game: data } = loadNodeData();

function survivor(): { c: Character; log: string[] } {
  const c = new Character(data, { seed: 3 });
  const log: string[] = [];
  c.onMessage = (t) => log.push(t);
  c.inv.wear(createItem(data, 'backpack'), null);
  return { c, log };
}
const give = (c: Character, id: string, opts = {}) => {
  const it = createItem(data, id, opts);
  expect(c.inv.giveNew(it)).not.toBeNull();
  return it;
};
/** A flashlight with its battery taken out. */
const bareFlashlight = () => {
  const f = createItem(data, 'flashlight');
  expect(f.magazine).toBeNull();
  return f;
};
const hintsWith = (seen: SeenItems, here = { x: 100, y: 100, z: 0 }): ReloadHints => ({ seen, here });

describe('what an item takes (real BN items)', () => {
  // [id, kind, Takes line] — the words are what a player reads on the tooltip / look card.
  const table: [string, string, string | RegExp][] = [
    ['flashlight', 'magazine', 'Takes: a light disposable battery or a light battery.'],
    ['heavy_flashlight', 'magazine', 'Takes: a light disposable battery or a light battery.'],
    ['wearable_light', 'magazine', 'Takes: a light battery.'], // headlamp: rechargeable only
    ['survivor_light', 'magazine', 'Takes: a light battery (high-capacity) or a light battery.'],
    ['UPS_off', 'magazine', 'Takes: a heavy battery or a heavy battery (high-capacity).'],
    ['smart_phone', 'recharge', /^Recharged, not reloaded/],
    ['exosuit_survivor', 'ups', /^Runs on a UPS you carry \(it can't be reloaded\)\. A UPS takes a heavy battery/],
    ['exosuit_military', 'ups', /^Runs on a UPS you carry/],
    ['power_armor_basic', 'ups', /^Runs on a UPS you carry/],
    ['power_armor_exo_2', 'ups', /^Runs on a UPS you carry/],
    ['glock_19', 'magazine', 'Takes: a Glock magazine, a Glock 17 22-round magazine or 5 other magazines (9x19mm).'],
    ['sw_619', 'ammo', 'Takes: .357 magnum or .38 (a .38/.357 7-round speedloader loads it faster).'],
    ['compbow', 'ammo', 'Takes: arrows.'],
    ['longbow', 'ammo', 'Takes: arrows.'],
    ['crossbow', 'ammo', 'Takes: bolts.'],
    ['glockmag', 'ammo', 'Takes: 9x19mm.'],
    ['light_battery_cell', 'ammo', /^Rechargeable: it needs a battery charger/],
    ['light_disposable_cell', 'ammo', ''],
    ['knife_combat', 'none', ''],
  ];
  it.each(table)('%s: %s', (id, kind, line) => {
    const it = createItem(data, id);
    expect(reloadNeeds(it).kind).toBe(kind);
    if (line === '') expect(takesLine(it)).toBeNull();
    else if (typeof line === 'string') expect(takesLine(it)).toBe(line);
    else expect(takesLine(it)).toMatch(line);
  });

  it('commonness comes from BN item groups: disposable light batteries beat rechargeable ones', () => {
    const c = commonness(data);
    expect(c.get('light_disposable_cell')!).toBeGreaterThan(c.get('light_battery_cell')!);
    expect(c.get('9mm')!).toBeGreaterThan(0);
  });
});

describe('example selection: recently seen > common > any', () => {
  const ids = reloadNeeds(createItem(data, 'flashlight')).ids;

  it('nothing seen: the most common first', () => {
    const ex = pickExamples(data, ids, null);
    expect(ex.map((e) => [e.id, e.via])).toEqual([['light_disposable_cell', 'common'], ['light_battery_cell', 'common']]);
  });

  it('a recently seen one comes first, with where it was', () => {
    const seen = new SeenItems();
    seen.record('light_battery_cell', 2, 72, 72, 0, 'in a dresser', 1000);
    const ex = pickExamples(data, ids, hintsWith(seen));
    expect(ex[0]).toMatchObject({ id: 'light_battery_cell', via: 'seen' });
    expect(ex[1]).toMatchObject({ id: 'light_disposable_cell', via: 'common' });
    expect(placePhrase(ex[0].sighting!, { x: 100, y: 100, z: 0 })).toBe('in a dresser 40 m northwest');
  });

  it('newer sightings beat older ones; a sighting known to be gone is skipped', () => {
    const seen = new SeenItems();
    seen.record('light_disposable_cell', 1, 101, 100, 0, 'on the ground', 10);
    seen.record('light_battery_cell', 1, 130, 100, 0, 'on a table', 5000);
    const h = hintsWith(seen);
    expect(pickExamples(data, ids, h)[0].id).toBe('light_battery_cell');
    h.stillThere = (s) => s.id !== 'light_battery_cell';
    expect(pickExamples(data, ids, h).map((e) => [e.id, e.via])).toEqual([['light_disposable_cell', 'seen'], ['light_battery_cell', 'common']]);
  });

  it('items that never spawn still come up, last', () => {
    const c = commonness(data);
    const arrows = reloadNeeds(createItem(data, 'compbow')).ids;
    const never = arrows.find((id) => !c.get(id));
    expect(never).toBeDefined();
    const ex = pickExamples(data, [never!, arrows.find((id) => (c.get(id) ?? 0) > 0)!], null);
    expect(ex.map((e) => e.via)).toEqual(['common', 'any']);
    expect(ex[1].id).toBe(never);
  });
});

describe('failed reloads say what it takes and which failure it is', () => {
  it('flashlight, no battery: names the light batteries (was: "You don\'t have a magazine to reload your flashlight (off)!")', () => {
    const { c } = survivor();
    c.inv.wield(bareFlashlight(), null);
    const r = c.inv.reload();
    expect(r.ok).toBe(false);
    expect(r.msg).toBe('Your flashlight takes a light disposable battery or a light battery. You have none. The light disposable battery is the most common.');
  });

  it('…and once you have seen one, where it is', () => {
    const { c } = survivor();
    const seen = new SeenItems();
    seen.record('light_battery_cell', 2, 72, 72, 0, 'in a dresser', 100);
    setReloadHints(c, () => hintsWith(seen));
    c.inv.wield(bareFlashlight(), null);
    expect(c.inv.reload().msg).toBe('Your flashlight takes a light disposable battery or a light battery. You have none. You saw 2 light batteries in a dresser 40 m northwest.');
  });

  it('carried batteries all flat: says so, and that disposables come charged', () => {
    const { c } = survivor();
    const f = bareFlashlight();
    c.inv.wield(f, null);
    give(c, 'light_battery_cell');
    // the first reload puts the flat battery in (BN allows it) and says it's flat
    const r1 = c.inv.reload();
    expect(r1.msg).toMatch(/^You put the light battery in the flashlight\. Your light battery is flat\./);
    give(c, 'light_battery_cell');
    const r2 = c.inv.reload();
    expect(r2.ok).toBe(false);
    expect(r2.msg).toBe("Your light batteries are all flat. Rechargeable ones need a battery charger, and there's no charging in this version yet. Disposable ones come charged, like the light disposable battery.");
  });

  it('wrong battery size: you carry a medium battery, it takes a light one', () => {
    const { c } = survivor();
    c.inv.wield(bareFlashlight(), null);
    give(c, 'medium_battery_cell');
    expect(c.inv.reload().msg).toMatch(/^Your medium battery doesn't fit: the flashlight takes a light disposable battery or a light battery\./);
  });

  it('a charged battery works as before', () => {
    const { c } = survivor();
    const f = bareFlashlight();
    c.inv.wield(f, null);
    give(c, 'light_disposable_cell');
    expect(c.inv.reload().msg).toBe('You reload the flashlight (off).');
    expect(f.ammoRemaining()).toBe(300);
  });

  it('pistol with loose rounds but no magazine: needs a magazine, not ammo', () => {
    const { c } = survivor();
    const g = createItem(data, 'glock_19');
    c.inv.wield(g, null);
    give(c, '9mm', { charges: 30 });
    expect(c.inv.reload().msg).toMatch(/^You have 9x19mm JHPs, but the Glock 19 loads from a magazine: it takes a Glock magazine, a Glock 17 22-round magazine or 5 other magazines \(9x19mm\)\. The usual kinds: /);
  });

  it('pistol with an empty magazine and no rounds: the magazine is empty, here is the ammo', () => {
    const { c } = survivor();
    const g = createItem(data, 'glock_19');
    c.inv.wield(g, null);
    give(c, 'glockmag');
    const r = c.inv.reload();
    // BN puts the empty magazine in; the next reload explains
    expect(r.ok).toBe(true);
    give(c, 'glockmag');
    expect(c.inv.reload().msg).toMatch(/^Your Glock magazines are all empty\. You have no 9x19mm to fill them\. The usual kinds: 9x19mm/);
  });

  it('already full stays "already fully loaded"', () => {
    const { c } = survivor();
    const g = createItem(data, 'glock_19', { ammo: 'default' });
    c.inv.wield(g, null);
    expect(c.inv.reload().msg).toBe('The Glock 19 is already fully loaded!');
  });

  it('revolver: none carried names the calibres; holding the other calibre says unload first', () => {
    const { c } = survivor();
    const r = createItem(data, 'sw_619');
    c.inv.wield(r, null);
    expect(c.inv.reload().msg).toMatch(/^Your S&W 619 takes \.357 magnum or \.38 .*You have none\. The usual kinds: /);
    loadAmmo(r, '38_special', 3);
    give(c, '357mag_fmj', { charges: 10 });
    expect(c.inv.reload().msg).toBe('The S&W 619 still has .38 Specials in it: unload it first to load .357 magnum FMJs.');
  });

  it('bow and crossbow: arrows and bolts, with real examples', () => {
    const { c } = survivor();
    c.inv.wield(createItem(data, 'compbow'), null);
    expect(c.inv.reload().msg).toMatch(/^Your compound bow takes arrows\. You have none\. The usual kinds: .*arrow/);
    c.inv.wield(createItem(data, 'crossbow'), null);
    expect(c.inv.reload().msg).toMatch(/^Your crossbow takes bolts\. You have none\. The usual kinds: .*bolt/);
  });

  it('exo-suit and smartphone are not reloaded at all (BN NO_RELOAD)', () => {
    const { c } = survivor();
    const suit = createItem(data, 'exosuit_survivor');
    expect(c.inv.reload(suit).msg).toMatch(/^Your powered survivor suit can't be reloaded: it runs on a UPS you carry\. You don't have one\. .*A UPS takes a heavy battery/);
    const ups = give(c, 'UPS_off');
    expect(ups.ammoRemaining()).toBe(0);
    expect(c.inv.reload(suit).msg).toMatch(/^Your powered survivor suit runs on your UPS, and the UPS is flat\./);
    expect(c.inv.reload(createItem(data, 'smart_phone')).msg).toMatch(/^Your smartphone can't be reloaded: it's recharged/);
  });

  it('the NPC path (no hints) never mentions sightings', () => {
    const { c } = survivor();
    expect(reloadHintsFor(c)).toBeNull();
    expect(explainNoReload(bareFlashlight(), [], null)).not.toMatch(/saw/);
  });
});

describe('switching on without power (the hotbar / activate path)', () => {
  it('a dead flashlight says what it takes', () => {
    const { c } = survivor();
    const f = bareFlashlight();
    give(c, 'backpack');
    c.inv.giveNew(f);
    const r = c.inv.use(f);
    expect(r.ok).toBe(false);
    expect(r.msg).toBe("The flashlight's batteries are dead. Your flashlight takes a light disposable battery or a light battery. You have none. The light disposable battery is the most common.");
  });

  it('…or that you carry a charged battery to put in', () => {
    const { c } = survivor();
    const f = bareFlashlight();
    c.inv.giveNew(f);
    give(c, 'light_disposable_cell');
    expect(c.inv.use(f).msg).toBe("The flashlight's batteries are dead. You have a light disposable battery with charge: reload the flashlight with it.");
  });

  it('a USE_UPS exo-suit draws from the UPS you carry (BN units_remaining)', () => {
    const { c } = survivor();
    const suit = createItem(data, 'exosuit_survivor', { charges: 0 });
    c.inv.giveNew(suit);
    expect(c.inv.use(suit).msg).toMatch(/can't be reloaded: it runs on a UPS you carry/);
    const ups = give(c, 'UPS_off');
    const bat = createItem(data, 'heavy_battery_cell');
    loadAmmo(bat, 'battery', 50);
    expect(c.inv.giveNew(bat)).not.toBeNull();
    expect(c.inv.reload(ups).ok).toBe(true);
    expect(c.inv.upsCharges()).toBe(50);
    expect(c.inv.use(suit).ok).toBe(true);
    expect(c.inv.useUpsCharges(10)).toBe(10);
    expect(c.inv.upsCharges()).toBe(40);
  });
});

describe('the seen-items memory', () => {
  it('keeps the newest few places per type, and round-trips through JSON', () => {
    const m = new SeenItems();
    for (let i = 0; i < 5; i++) m.record('9mm', 10 + i, i, 0, 0, 'on the ground', i * 100);
    expect(m.sightings('9mm').map((s) => s.x)).toEqual([4, 3, 2]);
    m.record('light_battery_cell', 1, 5, 5, 1, 'in a dresser', 700);
    const back = SeenItems.fromJSON(JSON.parse(JSON.stringify(m.toJSON())));
    expect(back.sightings('9mm')).toEqual(m.sightings('9mm'));
    expect(back.sightings('light_battery_cell')).toEqual([{ id: 'light_battery_cell', n: 1, x: 5, y: 5, z: 1, where: 'in a dresser', t: 700 }]);
    expect(() => SeenItems.fromJSON({ v: 2, s: [] })).toThrow();
    expect(() => m.record('9mm', 0, 0, 0, 0, 'x', 0)).toThrow();
  });

  function world(): Game {
    const input = { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, capture: () => () => {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as unknown as Input;
    const game = new Game(data, 11, input);
    game.map.generator = new TestGenerator();
    game.player.x = 200.5;
    game.player.y = 200.5;
    game.player.z = 0;
    return game;
  }

  it('the scan remembers batteries in view (a searched dresser, the floor), not in unsearched drawers, and it saves', () => {
    const game = world();
    const mem = new LootMemory();
    const s = installSeenItems(game, () => mem);
    const p = game.player;
    const px = p.tileX, py = p.tileY;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      game.map.setTer(px + dx, py + dy, 0, 't_grass');
      game.map.setFurn(px + dx, py + dy, 0, 'f_null');
    }
    game.map.setFurn(px - 3, py - 3, 0, 'f_dresser');
    game.map.setFurn(px + 3, py, 0, 'f_dresser');
    spawnItem(createItem(data, 'light_battery_cell'), L.ground(game.map, px - 3, py - 3, 0));
    spawnItem(createItem(data, 'light_battery_cell'), L.ground(game.map, px - 3, py - 3, 0));
    spawnItem(createItem(data, 'medium_battery_cell'), L.ground(game.map, px + 3, py, 0));
    spawnItem(createItem(data, '9mm', { charges: 20 }), L.ground(game.map, px, py + 2, 0));
    mem.mark(px - 3, py - 3, 0, 2);
    s.scan();
    expect(s.seen().sightings('light_battery_cell')).toMatchObject([{ n: 2, x: px - 3, y: py - 3, where: 'in a dresser' }]);
    expect(s.seen().sightings('9mm')).toMatchObject([{ n: 20, where: 'on the ground' }]);
    expect(s.seen().sightings('medium_battery_cell')).toEqual([]); // that dresser wasn't searched

    // the flashlight's failure message now points at the dresser
    p.inv.wear(createItem(data, 'backpack'), null);
    p.inv.wield(bareFlashlight(), null);
    expect(p.inv.reload().msg).toMatch(/You saw 2 light batteries in a dresser 4 m northwest\.$/);

    // saved with the game, back after a load
    const file = serializeGame(game, { slot: 'r', name: 'x', gen: 'test' });
    expect((file.sections.seenItems as { s: unknown[] }).s.length).toBe(2);
    const g2 = world();
    const s2 = installSeenItems(g2, () => new LootMemory());
    applySave(g2, file);
    expect(s2.seen().sightings('light_battery_cell')).toMatchObject([{ n: 2, where: 'in a dresser' }]);

    // someone took them: the next message doesn't send you there
    game.map.itemsAt(px - 3, py - 3, 0).splice(0);
    expect(p.inv.reload().msg).not.toMatch(/You saw/);
  });
});
