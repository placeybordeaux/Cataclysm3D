import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { Character } from '../src/game/character';
import { createItem } from '../src/game/item';
import type { Item } from '../src/game/item';
import type { InventoryScope } from '../src/game/inventory_view';
import { census, L, spawnItem, type Loc } from '../src/game/moves';
import { LOOT_CATEGORIES, LootMemory, lootCategory, lootValue, notableItem, takeOrder } from '../src/game/loot';
import { BnInventoryModel } from '../src/ui2/bn/model';
import { areaGroups } from '../src/ui2/loot/area';
import { FIXTURE_ITEMS, makeData } from './fixtures/gamedata';
import { FakeGround } from './fixtures/ground';

// Looting (src/game/loot.ts, src/ui2/loot, BnInventoryModel.take): the smart Take all, the area
// window's merged view and its takes, the crosshair panel's single takes, the memory of
// searched containers — and item conservation over random sequences of all of them, the same
// bar the inventory screens and the moves API are held to.

const data = makeData();

function world(seed = 3) {
  const who = new Character(data, { seed });
  const map = new FakeGround();
  map.furn.set('1,0,0', { id: 'f_locker', name: 'locker', max_volume: 4000 });
  map.furn.set('0,1,0', { id: 'f_cupboard', name: 'cupboard', max_volume: 40000 });
  who.groundLoc = () => L.ground(map, 0, 0, 0);
  const trunk = { items: [], def: { name: 'trunk', size: 20000 } };
  const scope: InventoryScope = { who, map, at: { x: 0, y: 0, z: 0 }, reach: 1, cargo: [{ part: trunk, label: "Sedan's trunk" }] };
  const model = new BnInventoryModel(() => scope);
  const locs = (): Loc[] => [L.hands(who), L.worn(who), L.inv(who), ...[-1, 0, 1].flatMap((y) => [-1, 0, 1].map((x) => L.ground(map, x, y, 0))), L.cargo(trunk)];
  return { who, map, scope, model, trunk, locs };
}
const put = (w: ReturnType<typeof world>, id: string, x: number, y: number, n = 1): Item[] => {
  const out: Item[] = [];
  for (let i = 0; i < n; i++) {
    const it = data.items[id].count_by_charges ? createItem(data, id, { charges: 1 }) : createItem(data, id);
    spawnItem(it, L.ground(w.map, x, y, 0), { force: true });
    out.push(it);
  }
  return out;
};
const where = (w: ReturnType<typeof world>, typeId: string) => w.who.inv.items.filter((i) => i.typeId === typeId).reduce((a, i) => a + i.count(), 0);

describe('what loot is worth', () => {
  it('a gun is notable over rags; value counts what a container holds; categories are the filter chips', () => {
    const glock = createItem(data, 'glock_19');
    const rag = createItem(data, 'rag');
    expect(notableItem([rag, glock, rag])).toBe(glock);
    const bag = createItem(data, 'bag_canvas');
    const empty = lootValue(bag);
    spawnItem(createItem(data, 'aspirin', { charges: 20 }), L.in(bag), { force: true });
    expect(lootValue(bag)).toBeGreaterThan(empty);
    expect(lootCategory(glock)).toBe('weapons');
    expect(lootCategory(createItem(data, '9mm', { charges: 10 }))).toBe('ammo');
    expect(lootCategory(createItem(data, 'jeans'))).toBe('clothing');
    for (const id of FIXTURE_ITEMS) expect(LOOT_CATEGORIES).toContain(lootCategory(createItem(data, id)));
  });

  it('takeOrder: the most value per share of the room left goes first', () => {
    const pots = [createItem(data, 'pot'), createItem(data, 'pot')];
    const glock = createItem(data, 'glock_19');
    const order = takeOrder([...pots, glock], { volume: 3000, weight: 20000 });
    expect(order[0]).toBe(glock);
  });
});

describe('smart Take all', () => {
  it('takes the valuable small things before the bulky cheap ones when room runs short (QA #4)', () => {
    const w = world();
    w.who.inv.wear(createItem(data, 'backpack'), null);
    // Listed first: bulky cheap pots that would fill the pockets in list order.
    put(w, 'pot', 0, 1, Math.ceil(w.who.inv.volumeCapacity() / createItem(data, 'pot').volume()) + 1);
    put(w, 'glock_19', 0, 1);
    put(w, 'aspirin', 0, 1);
    w.model.refresh();
    const before = census(w.locs()).counts;
    const r = w.model.takeAll('ground:0,1,0');
    expect(where(w, 'glock_19')).toBe(1);
    expect(r.taken.some((t) => /aspirin/i.test(t.name))).toBe(true);
    expect(r.left.some((l) => /pot/.test(l.name) && /room/.test(l.reason))).toBe(true);
    expect(census(w.locs()).counts).toEqual(before);
  });

  it('never takes past the weight limit (overburdened): says so, charges stacks come partly', () => {
    const w = world();
    w.who.inv.wear(createItem(data, 'rucksack'), null);
    put(w, 'crowbar', 1, 0, 3);
    put(w, 'remington_870', -1, 0, 12);
    const rocks = createItem(data, '9mm', { charges: 500 });
    spawnItem(rocks, L.ground(w.map, 0, 0, 0), { force: true });
    w.model.refresh();
    const before = census(w.locs()).counts;
    const r = w.model.take(['ground:1,0,0', 'ground:-1,0,0', 'ground:0,0,0']);
    expect(w.who.inv.weightCarried()).toBeLessThanOrEqual(w.who.inv.weightCapacity());
    expect(r.left.some((l) => /overburden|weight limit|room/.test(l.reason))).toBe(true);
    expect(r.taken.length).toBeGreaterThan(0);
    expect(census(w.locs()).counts).toEqual(before);
    expect(census(w.locs()).aliased).toEqual([]);
  });

  it('take all of one type across places leaves everything else', () => {
    const w = world();
    w.who.inv.wear(createItem(data, 'backpack'), null);
    put(w, 'rag', 1, 0, 2);
    put(w, 'rag', -1, 0, 3);
    put(w, 'rock', -1, 0, 2);
    w.model.refresh();
    const before = census(w.locs()).counts;
    const g = areaGroups(w.model).find((x) => x.typeId === 'rag')!;
    expect(g.count).toBe(5);
    expect(g.sources.map((s) => s.key).sort()).toEqual(['ground:-1,0,0', 'ground:1,0,0']);
    const r = w.model.take(g.sources.map((s) => s.key), (it) => it.typeId === 'rag');
    expect(r.taken).toEqual([{ name: expect.stringMatching(/rag/), count: 5 }]);
    expect(where(w, 'rag')).toBe(5);
    expect(new Set(w.map.itemsAt(-1, 0, 0).map((i) => (i as unknown as Item).typeId))).toEqual(new Set(['rock']));
    expect(census(w.locs()).counts).toEqual(before);
  });

  it('a place that went out of reach is reported, not an error', () => {
    const w = world();
    const r = w.model.take(['cargo:7']);
    expect(r.taken).toEqual([]);
    expect(r.left[0].reason).toMatch(/out of reach/);
  });
});

describe('area loot view', () => {
  it('merges every place in reach by type, best category first, with where each lies', () => {
    const w = world();
    put(w, 'glock_19', 1, 0);
    put(w, 'can_beans', 0, 1, 2);
    put(w, 'can_beans', -1, -1);
    spawnItem(createItem(data, '9mm', { charges: 30 }), L.cargo(w.trunk), { force: true });
    w.model.refresh();
    const g = areaGroups(w.model);
    expect(g[0].typeId).toBe('glock_19');
    const beans = g.find((x) => x.typeId === 'can_beans')!;
    expect(beans.count).toBe(3);
    expect(beans.sources.map((s) => s.label).sort()).toEqual(['cupboard (south)', 'northwest']);
    expect(g.find((x) => x.typeId === '9mm')!.sources[0].label).toBe("Sedan's trunk");
    expect(areaGroups(w.model, 'food').map((x) => x.typeId)).toEqual(['can_beans']);
  });
});

describe('memory of searched containers', () => {
  it('unsearched → searched → empty; saves and loads; refuses a garbled section', () => {
    const m = new LootMemory();
    expect(m.state(1, 2, 0)).toBe('unsearched');
    m.mark(1, 2, 0, 3);
    expect(m.state(1, 2, 0)).toBe('searched');
    const v = m.version;
    m.mark(1, 2, 0, 3);
    expect(m.version).toBe(v);
    m.mark(1, 2, 0, 0);
    expect(m.state(1, 2, 0)).toBe('empty');
    const back = LootMemory.fromJSON(JSON.parse(JSON.stringify(m.toJSON())));
    expect(back.state(1, 2, 0)).toBe('empty');
    expect(back.size).toBe(1);
    expect(() => LootMemory.fromJSON({ v: 2, seen: [] })).toThrow();
    expect(() => LootMemory.fromJSON({ v: 1, seen: [['nope', 1]] })).toThrow();
  });
});

describe('conservation through the looting flows', () => {
  const SEEDS = Number(process.env.LOOT_CONSERVATION_SEEDS ?? 40);
  const STEPS = Number(process.env.LOOT_CONSERVATION_STEPS ?? 60);
  it(`${SEEDS} seeds × ${STEPS} random quick takes / take alls / area takes by type and category / drops`, () => {
    let taken = 0;
    const sources = ['ground:0,0,0', 'ground:1,0,0', 'ground:0,1,0', 'ground:-1,-1,0', 'cargo:0'];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const w = world(seed);
      const rng = new Rng(seed);
      w.who.inv.wear(createItem(data, rng.pick(['backpack', 'jeans', 'rucksack'])), null);
      const tiles = [[0, 0], [1, 0], [0, 1], [-1, -1]];
      for (let i = 0; i < 30; i++) {
        const id = rng.pick(FIXTURE_ITEMS);
        const def = data.items[id];
        const it = def.count_by_charges ? createItem(data, id, { charges: rng.int(1, 60) }) : createItem(data, id);
        const [x, y] = rng.pick(tiles);
        spawnItem(it, rng.oneIn(5) ? L.cargo(w.trunk) : L.ground(w.map, x, y, 0), { force: true });
      }
      w.model.refresh();
      const base = census(w.locs()).counts;
      const log: string[] = [];
      for (let step = 0; step < STEPS; step++) {
        const op = rng.int(0, 5);
        const invBefore = w.who.inv.items.length;
        if (op === 0) {
          // Quick loot: the selected row of the aimed place → the inventory (or a carried container).
          const src = rng.pick(sources);
          const rows = w.model.contents(src);
          if (!rows.length) continue;
          const r = rng.pick(rows);
          const to = w.model.quickMoveTarget(r, src);
          log.push(`quick ${r.name} from ${src} → ${to}`);
          if (to) {
            const v = w.model.check(r.id, to, r.count);
            if (v.kind === 'ok' || v.kind === 'partial') w.model.move(r.id, to, v.count);
          }
        } else if (op === 1) {
          const src = rng.pick(sources);
          log.push(`take all ${src}`);
          w.model.takeAll(src);
        } else if (op === 2) {
          const g = areaGroups(w.model);
          if (!g.length) continue;
          const pick = rng.pick(g);
          log.push(`area take type ${pick.typeId}`);
          w.model.take(pick.sources.map((s) => s.key), (it) => it.typeId === pick.typeId);
        } else if (op === 3) {
          const cat = rng.pick([...LOOT_CATEGORIES]);
          log.push(`area take all ${cat}`);
          w.model.take(sources, (it) => lootCategory(it) === cat);
        } else {
          // Put things back so the walk keeps having something to take.
          const carried = [...w.model.all()].filter((a) => a.loc === 'inv');
          if (!carried.length) continue;
          const a = rng.pick(carried);
          const to = rng.pick(sources);
          log.push(`drop ${a.view.name} → ${to}`);
          const v = w.model.check(a.view.id, to, a.view.count);
          if (v.kind === 'ok' || v.kind === 'partial') w.model.move(a.view.id, to, v.count);
        }
        if (op <= 3 && w.who.inv.items.length > invBefore) taken++;
        w.model.refresh();
        const after = census(w.locs());
        if (after.aliased.length) throw new Error(`seed ${seed}: aliased after ${log.slice(-4).join(' | ')}`);
        for (const t of new Set([...base.keys(), ...after.counts.keys()]))
          if ((base.get(t) ?? 0) !== (after.counts.get(t) ?? 0)) throw new Error(`seed ${seed}: ${t} ${base.get(t)}→${after.counts.get(t)} after ${log.slice(-4).join(' | ')}`);
      }
    }
    // The walk must really loot, not bounce off refusals.
    expect(taken).toBeGreaterThan(SEEDS * 4);
  });
});
