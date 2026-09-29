import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { Character } from '../src/game/character';
import { createItem, inNewContainer } from '../src/game/item';
import { itemKey, type InventoryScope } from '../src/game/inventory_view';
import { census, L, spawnItem, type Loc } from '../src/game/moves';
import { BnInventoryModel, takeAllOrder } from '../src/ui2/bn/model';
import { isAccepted } from '../src/ui2/logic/dnd';
import { FIXTURE_ITEMS, makeData } from './fixtures/gamedata';
import { FakeGround } from './fixtures/ground';

// The ui2 adapter over the BN item model (src/ui2/bn/model.ts): what the inventory screens
// show and do. The screens only ever call this model, so a random walk over its operations
// (drags between every place, quick moves, splits, take all, the menu actions) must conserve
// items exactly like the moves API underneath.

const data = makeData();

function world(seed = 3) {
  const who = new Character(data, { seed });
  const map = new FakeGround();
  map.furn.set('1,0,0', { id: 'f_locker', name: 'locker', max_volume: 4000 });
  who.groundLoc = () => L.ground(map, 0, 0, 0);
  const trunk = { items: [], def: { name: 'trunk', size: 20000 } };
  const scope: InventoryScope = { who, map, at: { x: 0, y: 0, z: 0 }, cargo: [{ part: trunk, label: "Sedan's trunk" }] };
  const model = new BnInventoryModel(() => scope);
  const locs = (): Loc[] => [L.hands(who), L.worn(who), L.inv(who), ...[-1, 0, 1].flatMap((y) => [-1, 0, 1].map((x) => L.ground(map, x, y, 0))), L.cargo(trunk)];
  return { who, map, scope, model, trunk, locs };
}

const here = (w: ReturnType<typeof world>) => L.ground(w.map, 0, 0, 0);

describe('BnInventoryModel views', () => {
  it('groups identical items into one stack, keeps charge stacks whole, sorts the inventory by category', () => {
    const w = world();
    w.who.inv.wear(createItem(data, 'backpack'), null);
    for (let i = 0; i < 3; i++) w.who.inv.giveNew(createItem(data, 'pipe'));
    w.who.inv.giveNew(createItem(data, '9mm', { count: 40 }));
    w.who.inv.giveNew(createItem(data, 'crowbar'));
    w.model.refresh();
    const inv = w.model.contents('inv');
    const pipes = inv.find((v) => v.typeId === 'pipe')!;
    expect(pipes.count).toBe(3);
    expect(inv.find((v) => v.typeId === '9mm')!.count).toBe(40);
    expect(inv.length).toBe(3);
    expect(w.model.contents('worn:torso').map((v) => v.typeId)).toEqual(['backpack']);
    expect(w.model.contents('worn:head')).toEqual([]);
    expect(inv.every((v) => v.category && !/_/.test(v.category) && v.category !== v.category.toUpperCase())).toBe(true);
  });

  it('names places the way a player says them', () => {
    const w = world();
    spawnItem(createItem(data, 'rock'), L.ground(w.map, 1, 0, 0));
    w.model.refresh();
    expect(w.model.where('ground:1,0,0')).toBe('In the locker (east)');
    expect(w.model.where('inv')).toBe('In your inventory');
    expect(w.model.name('cargo:0')).toBe("Sedan's trunk");
  });
});

describe('drops', () => {
  it('drag three of five pipes to the ground: three separate moves, census unchanged', () => {
    const w = world();
    w.who.inv.wear(createItem(data, 'backpack'), null);
    for (let i = 0; i < 5; i++) w.who.inv.giveNew(createItem(data, 'pipe'));
    w.model.refresh();
    const before = census(w.locs()).counts;
    const beans = w.model.contents('inv').find((v) => v.typeId === 'pipe')!;
    expect(w.model.check(beans.id, 'ground:0,0,0', 3)).toEqual({ kind: 'ok', count: 3 });
    expect(w.model.move(beans.id, 'ground:0,0,0', 3).ok).toBe(true);
    expect(w.model.contents('ground:0,0,0')[0].count).toBe(3);
    expect(w.model.contents('inv')[0].count).toBe(2);
    expect(census(w.locs()).counts).toEqual(before);
  });

  it('hands: swap verdict with the displaced weapon; wear via a body-part slot', () => {
    const w = world();
    w.who.inv.wear(createItem(data, 'backpack'), null);
    w.who.inv.wield(createItem(data, 'crowbar'), null);
    spawnItem(createItem(data, 'pipe'), here(w));
    spawnItem(createItem(data, 'hat_hard'), here(w));
    w.model.refresh();
    const pipe = w.model.contents('ground:0,0,0').find((v) => v.typeId === 'pipe')!;
    const v = w.model.check(pipe.id, 'hands', 1);
    expect(v.kind).toBe('swap');
    expect(w.model.move(pipe.id, 'hands', 1).ok).toBe(true);
    expect(w.who.inv.wielded?.typeId).toBe('pipe');
    const hat = w.model.contents('ground:0,0,0').find((x) => x.typeId === 'hat_hard')!;
    expect(w.model.check(hat.id, 'worn:head', 1).kind).toBe('ok');
    expect(w.model.move(hat.id, 'worn:head', 1).ok).toBe(true);
    expect(w.model.contents('worn:head').map((x) => x.typeId)).toEqual(['hat_hard']);
  });

  it('liquids: refused loose into the inventory, pour by dragging a bottle onto a jar, spilling asks first', () => {
    const w = world();
    w.who.inv.wear(createItem(data, 'backpack'), null);
    const bottle = inNewContainer(data, createItem(data, 'water_clean', { charges: 2 }), 'bottle_plastic').container;
    w.who.inv.giveNew(bottle);
    const jar = createItem(data, 'jar_glass');
    w.who.inv.giveNew(jar);
    w.model.refresh();
    const before = census(w.locs()).counts;
    const bottleView = w.model.contents('inv').find((v) => v.typeId === 'bottle_plastic')!;
    expect(w.model.dropLabel(bottleView.id, `in:${itemKey(jar)}`)).toBe('Pour into glass jar');
    expect(isAccepted(w.model.check(bottleView.id, `in:${itemKey(jar)}`, 1))).toBe(true);
    expect(w.model.move(bottleView.id, `in:${itemKey(jar)}`, 1).ok).toBe(true);
    expect(jar.contents[0]?.typeId).toBe('water_clean');
    expect(bottle.hasContents()).toBe(false);
    const water = w.model.contents(`in:${itemKey(jar)}`)[0];
    expect(w.model.check(water.id, 'inv', 1)).toMatchObject({ kind: 'reject' });
    expect(w.model.confirmFor(water.id, 'ground:0,0,0', 1)).toMatch(/Pour 1 .* on the ground/);
    expect(census(w.locs()).counts).toEqual(before);
  });

  it('v1 bug scenario: unloading a bag (in hands) into the inventory / onto the ground via the model conserves', () => {
    const w = world();
    w.who.inv.wear(createItem(data, 'backpack'), null);
    const bag = inNewContainer(data, createItem(data, 'rock', { count: 1 }), 'bag_canvas').container;
    spawnItem(createItem(data, 'can_beans'), L.in(bag), { force: true });
    spawnItem(bag, here(w));
    w.model.refresh();
    const before = census(w.locs()).counts;
    const bagView = w.model.contents('ground:0,0,0')[0];
    expect(w.model.move(bagView.id, 'hands', 1).ok).toBe(true);
    // every item inside, dragged one by one: some to the inventory, the rest to the ground
    const inside = () => w.model.contents(`in:${itemKey(bag)}`);
    let i = 0;
    while (inside().length && i++ < 10) w.model.move(inside()[0].id, i % 2 ? 'inv' : 'ground:0,0,0', inside()[0].count);
    expect(inside().length).toBe(0);
    // and the Empty action on what's left
    const hands = w.model.contents('hands')[0];
    const acts = w.model.actions(hands, 'hands');
    expect(acts.some((a) => 'label' in a && a.label === 'Put away')).toBe(true);
    expect(census(w.locs()).counts).toEqual(before);
    expect(census(w.locs()).aliased).toEqual([]);
  });

  it('take all: takes what fits, says what stayed and why', () => {
    const w = world();
    w.who.inv.wear(createItem(data, 'jeans'), null); // small storage
    spawnItem(createItem(data, '9mm', { count: 20 }), L.ground(w.map, 1, 0, 0));
    spawnItem(createItem(data, 'backpack'), L.ground(w.map, 1, 0, 0));
    spawnItem(createItem(data, 'water_clean', { charges: 2 }), L.ground(w.map, 1, 0, 0), { force: true });
    w.model.refresh();
    const before = census(w.locs()).counts;
    const r = w.model.takeAll('ground:1,0,0');
    expect(r.taken.some((t) => t.name.includes('9x19'))).toBe(true);
    expect(r.left.some((l) => l.name.includes('backpack') && /room/.test(l.reason))).toBe(true);
    expect(r.left.some((l) => /container/.test(l.reason))).toBe(true);
    expect(census(w.locs()).counts).toEqual(before);
  });

  it('take all takes the useful things first: food, medicine and tools before a pile of clothes (QA_V2 #4)', () => {
    const w = world();
    w.who.inv.wear(createItem(data, 'jeans'), null); // small storage
    const at = L.ground(w.map, 1, 0, 0);
    // Listed first, bulky and cheap: in list order they filled the pockets.
    for (let i = 0; i < 12; i++) spawnItem(createItem(data, 'socks'), at);
    spawnItem(createItem(data, 'chocolate'), at);
    spawnItem(createItem(data, 'aspirin'), at);
    spawnItem(createItem(data, 'lighter'), at);
    w.model.refresh();
    const before = census(w.locs()).counts;
    const r = w.model.takeAll('ground:1,0,0');
    for (const want of ['chocolate', 'aspirin', 'lighter']) expect(r.taken.map((t) => t.name).join(', ')).toContain(want);
    expect(r.left.some((l) => l.name.includes('sock') && /room/.test(l.reason))).toBe(true);
    expect(census(w.locs()).counts).toEqual(before);
    // …while the same socks alone do fit: in list order they took the room first.
    const w2 = world();
    w2.who.inv.wear(createItem(data, 'jeans'), null);
    for (let i = 0; i < 12; i++) spawnItem(createItem(data, 'socks'), L.ground(w2.map, 1, 0, 0));
    w2.model.refresh();
    expect(w2.model.takeAll('ground:1,0,0').taken.some((t) => t.name.includes('sock'))).toBe(true);
  });

  it('takeAllOrder: food, ammo, tools/weapons, then the rest; bulky and cheap last within a tier', () => {
    const mk = (id: string, count?: number) => createItem(data, id, count ? { count } : {});
    const order = takeAllOrder([mk('hoodie'), mk('rock'), mk('9mm', 20), mk('crowbar'), mk('chocolate'), mk('socks')]).map((i) => i.typeId);
    expect(order[0]).toBe('chocolate');
    expect(order[1]).toBe('9mm');
    expect(order.slice(2, 4).sort()).toEqual(['crowbar', 'rock']); // a rock is a hammer (HAMMER 1)
    expect(order.indexOf('hoodie')).toBeGreaterThan(order.indexOf('crowbar'));
  });
});

describe('conservation through the UI model', () => {
  const SEEDS = Number(process.env.UI_CONSERVATION_SEEDS ?? 40);
  const STEPS = Number(process.env.UI_CONSERVATION_STEPS ?? 120);
  it(`${SEEDS} seeds × ${STEPS} random drags / quick moves / take-alls / menu actions`, () => {
    let moved = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const w = world(seed);
      const rng = new Rng(seed);
      w.who.inv.wear(createItem(data, rng.oneIn(2) ? 'backpack' : 'jeans'), null);
      if (rng.oneIn(2)) w.who.inv.wear(createItem(data, 'holster'), null);
      const tiles = [[0, 0], [1, 0], [0, 1], [-1, -1]];
      for (let i = 0; i < 25; i++) {
        const id = rng.pick(FIXTURE_ITEMS);
        const def = data.items[id];
        const it = def.count_by_charges ? createItem(data, id, { charges: rng.int(1, 30) }) : createItem(data, id);
        const [x, y] = rng.pick(tiles);
        spawnItem(it, rng.oneIn(5) ? L.cargo(w.trunk) : L.ground(w.map, x, y, 0), { force: true });
      }
      w.model.refresh();
      const base = census(w.locs()).counts;
      const log: string[] = [];
      let eaten = new Map<string, number>();
      for (let step = 0; step < STEPS; step++) {
        const all = [...w.model.all()];
        if (!all.length) break;
        const pick = rng.pick(all);
        const locKeys = ['hands', 'worn', 'inv', 'worn:torso', 'worn:head', 'ground:0,0,0', 'ground:1,0,0', 'ground:-1,-1,0', 'cargo:0', ...all.map((a) => w.model.insideOf(a.view)).filter((x): x is string => !!x)];
        const op = rng.int(0, 9);
        const count = rng.int(1, pick.view.count);
        const before = census(w.locs()).counts;
        let consumed = false;
        if (op <= 5) {
          const to = rng.pick(locKeys);
          log.push(`drag ${pick.view.name}×${count} ${pick.loc} → ${to}`);
          const v = w.model.check(pick.view.id, to, count);
          if (isAccepted(v) && w.model.move(pick.view.id, to, v.count).ok) moved++;
        } else if (op === 6) {
          const to = w.model.quickMoveTarget(pick.view, pick.loc);
          log.push(`quick ${pick.view.name} → ${to}`);
          if (to) w.model.move(pick.view.id, to, pick.view.count);
        } else if (op === 7) {
          const src = rng.pick(['ground:0,0,0', 'ground:1,0,0', 'cargo:0']);
          log.push(`take all ${src}`);
          w.model.takeAll(src);
        } else {
          // A menu action (not the ones that open other UI).
          const acts = w.model.actions(pick.view, pick.loc).filter((a): a is { label: string; action: () => void } => 'label' in a && !('disabled' in a && a.disabled) && 'action' in a && !!a.action && !('key' in a && a.key === 'A') && !/Bind|some|Pour|Examine|Read|Open/.test(a.label));
          if (acts.length) {
            const a = rng.pick(acts);
            log.push(`menu ${a.label} ${pick.view.name}`);
            consumed = /^(Eat|Drink)/.test(a.label);
            a.action();
          }
        }
        w.model.refresh();
        const after = census(w.locs());
        if (after.aliased.length) throw new Error(`seed ${seed}: aliased after ${log.slice(-5).join(' | ')}`);
        if (consumed) {
          // eating/using may use up some of a type: never create any
          for (const [t, n] of after.counts) if (n > (before.get(t) ?? 0)) throw new Error(`seed ${seed}: ${t} grew ${before.get(t)}→${n} after ${log.slice(-3).join(' | ')}`);
          for (const [t, n] of before) eaten.set(t, (eaten.get(t) ?? 0) + n - (after.counts.get(t) ?? 0));
        } else {
          for (const t of new Set([...before.keys(), ...after.counts.keys()])) {
            if ((before.get(t) ?? 0) !== (after.counts.get(t) ?? 0)) throw new Error(`seed ${seed}: ${t} ${before.get(t)}→${after.counts.get(t)} after ${log.slice(-5).join(' | ')}`);
          }
        }
      }
      // Totals: the start minus what was consumed.
      const end = census(w.locs()).counts;
      for (const [t, n] of base) expect((end.get(t) ?? 0) + (eaten.get(t) ?? 0)).toBe(n);
      eaten = new Map();
    }
    // the walk must really move things, not just bounce off refusals
    expect(moved).toBeGreaterThan((SEEDS * STEPS) / 8);
  });
});
