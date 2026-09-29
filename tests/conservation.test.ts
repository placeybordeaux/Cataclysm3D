import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { Character } from '../src/game/character';
import { createItem, fromSpawned, inNewContainer, Item, loadAmmo } from '../src/game/item';
import { census, isAt, L, locate, moveItem, spawnItem, transaction, unloadItem, walkLocs, type Cargo, type Loc, type StockOwner } from '../src/game/moves';
import { sanitizeInventoryJSON, sanitizeItemJSON } from '../src/save/items';
import { FIXTURE_ITEMS, makeData } from './fixtures/gamedata';
import { FakeGround } from './fixtures/ground';

// Item conservation, property-tested (docs/DESIGN_V2.md "Invariants over anecdotes"; the v1
// build duplicated items when unloading a bag). A small world — two characters, a few ground
// tiles (one a locker with limited room), a vehicle trunk, a shop's stock — is filled with real
// BN items, then thousands of seeded random operations run on it: raw moves between any two
// places (including invalid ones), the characters' actions (pick up, drop, wield, wear, take
// off, reload, unload bags/guns/magazines onto the ground or into the inventory, eat), stale
// operations on things that have moved since, transactions that fail halfway, dry runs, and
// save/load round trips. After every operation:
//
//   census (quantity per item type, charges-aware, rounds in guns counted as ammo) is exactly
//   what it was, except for explicit consumption (eating: exactly the portion eaten);
//   no item object is reachable from two places; no empty stack lingers anywhere.
//
// Failures print the seed and the last operations: rerun with that seed to debug.

const data = makeData();
const SEEDS = Number(process.env.CONSERVATION_SEEDS ?? 120);
const STEPS = Number(process.env.CONSERVATION_STEPS ?? 160);

interface World {
  rng: Rng;
  ground: FakeGround;
  a: Character;
  b: Character;
  trunk: Cargo & { version: number };
  shop: StockOwner;
  tiles: [number, number, number][];
  log: string[];
}

function makeWorld(seed: number): World {
  const rng = new Rng(seed);
  const ground = new FakeGround();
  ground.furn.set('2,0,0', { id: 'f_locker', name: 'locker', max_volume: 4000 });
  const mk = (s: number, x: number) => {
    const c = new Character(data, { seed: s });
    c.groundLoc = () => L.ground(ground, x, 0, 0);
    return c;
  };
  const w: World = {
    rng, ground, a: mk(seed, 0), b: mk(seed + 1, 1),
    trunk: { items: [], def: { name: 'trunk', size: 20000 }, version: 0 },
    shop: { stock: [], name: 'Shopkeeper' },
    tiles: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]],
    log: [],
  };
  // Everything starts on the ground, in the trunk or on the shelf, and some of it gets worn.
  const spots: Loc[] = [...w.tiles.map(([x, y, z]) => L.ground(ground, x, y, z)), L.cargo(w.trunk, w.trunk), L.stock(w.shop)];
  for (let i = 0; i < 40; i++) {
    for (const it of randomItem(rng)) spawnItem(it, rng.pick(spots), { force: true });
  }
  for (const c of [w.a, w.b]) {
    for (const id of ['backpack', 'jeans', 'holster', 'bandolier_pistol', 'purse']) if (rng.oneIn(2)) c.inv.wear(createItem(data, id), null);
  }
  return w;
}

/** A random new item, sometimes filled: bottles of water, loaded guns and magazines, bags of stuff. */
function randomItem(rng: Rng): Item[] {
  const id = rng.pick(FIXTURE_ITEMS);
  const def = data.items[id];
  if (def.count_by_charges) {
    const it = createItem(data, id, { charges: rng.int(1, def.phase === 'liquid' ? 12 : 60) });
    if (it.isLiquid()) return fromSpawned(data, { id, count: 1, charges: it.charges });
    return [it];
  }
  const it = createItem(data, id);
  if (it.isGun() || it.isMagazine()) {
    if (rng.oneIn(2)) {
      const ammo = it.takesMagazines() ? undefined : (it.isMagazine() ? def.magazine?.default_ammo : undefined);
      void ammo;
      const load = rng.int(1, 40);
      if (it.takesMagazines()) {
        const mag = createItem(data, it.magazineDefault() ?? it.magazineCompatible()[0]);
        loadAmmo(mag, mag.def.magazine?.default_ammo ?? '9mm', load);
        spawnItem(mag, L.mag(it));
      } else {
        const t = it.ammoTypes()[0];
        const am = { '9mm': '9mm', '38': '38_special', '357mag': '357mag_fmj', shot: 'shot_00', battery: 'battery' }[t ?? ''] ?? '';
        if (am) loadAmmo(it, am, load);
      }
    }
  }
  if (it.isContainer() && rng.oneIn(2)) {
    const fill = rng.pick(['water_clean', '9mm', 'rock', 'can_beans', 'crowbar', 'aspirin']);
    const inner = createItem(data, fill, data.items[fill].count_by_charges ? { charges: rng.int(1, 10) } : {});
    const r = inNewContainer(data, inner, id);
    return [r.container];
  }
  return [it];
}

/** Every place items can be in this world, and all the in-item places reachable from them. */
function roots(w: World): Loc[] {
  return [
    L.hands(w.a), L.worn(w.a), L.inv(w.a), L.hands(w.b), L.worn(w.b), L.inv(w.b),
    ...w.tiles.map(([x, y, z]) => L.ground(w.ground, x, y, z)), L.cargo(w.trunk, w.trunk), L.stock(w.shop),
  ];
}
function everything(w: World): { item: Item; loc: Loc }[] {
  return [...walkLocs(roots(w))];
}
function counts(w: World): Map<string, number> {
  const c = census(roots(w));
  expect(c.aliased.map((i) => i.typeId), 'an item object is in two places').toEqual([]);
  return c.counts;
}
function diff(before: Map<string, number>, after: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const d = (after.get(k) ?? 0) - (before.get(k) ?? 0);
    if (d) out[k] = d;
  }
  return out;
}

/** A random destination: any root, or inside / the magazine slot / the mod slot of any item. */
function randomLoc(w: World): Loc {
  const all = everything(w);
  const r = w.rng.int(0, 9);
  if (r < 4 || !all.length) return w.rng.pick(roots(w));
  const host = w.rng.pick(all).item;
  return r < 8 ? L.in(host) : r < 9 ? L.mag(host) : L.mod(host);
}

type Op = (w: World) => { name: string; consumed?: Record<string, number> } | null;

const describeLoc = (l: Loc) => (l.kind === 'ground' ? `ground ${l.x}` : l.kind === 'in' || l.kind === 'mag' || l.kind === 'mod' ? `${l.kind}(${l.host.typeId})` : l.kind === 'hands' || l.kind === 'worn' || l.kind === 'inv' ? `${l.kind}(${l.who === undefined ? '?' : 'c'})` : l.kind);

const OPS: [number, Op][] = [
  // raw moves, valid or not, whole or partial
  [30, (w) => {
    const all = everything(w);
    if (!all.length) return null;
    const { item, loc } = w.rng.pick(all);
    const to = randomLoc(w);
    const count = item.countByCharges && w.rng.oneIn(2) ? w.rng.int(1, item.charges) : undefined;
    const r = moveItem(item, loc, to, { count, partial: w.rng.oneIn(2), actor: w.rng.pick([w.a, w.b, undefined]) });
    return { name: `move ${item.typeId}${count ? ` x${count}` : ''} ${describeLoc(loc)} -> ${describeLoc(to)}: ${r.ok ? 'ok' : r.code}` };
  }],
  // character actions
  [8, (w) => {
    const c = w.rng.pick([w.a, w.b]);
    const here = w.rng.pick(w.tiles);
    const list = w.ground.itemsAt(...here) as Item[];
    if (!list.length) return null;
    const it = w.rng.pick(list);
    const r = c.inv.pickUp(it, L.ground(w.ground, ...here), it.countByCharges && w.rng.oneIn(2) ? w.rng.int(1, it.charges) : undefined);
    return { name: `pickUp ${it.typeId}: ${r.ok ? 'ok' : r.code}` };
  }],
  [6, (w) => {
    const c = w.rng.pick([w.a, w.b]);
    const mine = [...walkLocs([L.hands(c), L.worn(c), L.inv(c)])];
    if (!mine.length) return null;
    const { item } = w.rng.pick(mine);
    const r = c.inv.drop(item, c.inv.groundHere(), item.countByCharges && w.rng.oneIn(2) ? w.rng.int(1, item.charges) : undefined);
    return { name: `drop ${item.typeId}: ${r.ok ? 'ok' : r.code}` };
  }],
  [6, (w) => {
    const c = w.rng.pick([w.a, w.b]);
    const all = everything(w);
    if (!all.length) return null;
    const { item, loc } = w.rng.pick(all);
    const r = c.inv.wield(item, loc);
    return { name: `wield ${item.typeId} from ${describeLoc(loc)}: ${r.ok ? 'ok' : r.code}` };
  }],
  [5, (w) => {
    const c = w.rng.pick([w.a, w.b]);
    const all = everything(w).filter((x) => x.item.isArmor());
    if (!all.length) return null;
    const { item, loc } = w.rng.pick(all);
    const r = c.inv.wear(item, loc);
    return { name: `wear ${item.typeId}: ${r.ok ? 'ok' : r.code}` };
  }],
  [4, (w) => {
    const c = w.rng.pick([w.a, w.b]);
    if (!c.inv.worn.length) return null;
    const it = w.rng.pick(c.inv.worn);
    const r = c.inv.takeOff(it);
    return { name: `takeOff ${it.typeId}: ${r.ok ? 'ok' : r.code}` };
  }],
  [3, (w) => {
    const c = w.rng.pick([w.a, w.b]);
    const r = c.inv.unwield();
    return { name: `unwield: ${r.ok ? 'ok' : r.code}` };
  }],
  // unload: bags/containers/guns/magazines, on the ground or carried, into the inventory or onto the ground
  [10, (w) => {
    const c = w.rng.pick([w.a, w.b]);
    const all = everything(w).filter((x) => x.item.hasContents() || x.item.magazine || x.item.ammoRemaining() > 0);
    if (!all.length) return null;
    const { item } = w.rng.pick(all);
    const how = w.rng.int(0, 2);
    const r = how === 0 ? c.inv.unload(item) : unloadItem(item, how === 1 ? [L.inv(c)] : [c.inv.groundHere()!], { actor: c, pourLiquids: true });
    return { name: `unload ${item.typeId} (${['inv+ground', 'inv', 'ground'][how]}): ${r.ok ? 'ok' : r.code}` };
  }],
  [5, (w) => {
    const c = w.rng.pick([w.a, w.b]);
    const guns = [...walkLocs([L.hands(c), L.worn(c), L.inv(c)])].filter((x) => x.item.isGun() || x.item.isMagazine() || x.item.isBandolier());
    if (!guns.length) return null;
    const { item } = w.rng.pick(guns);
    const r = c.inv.reload(item);
    return { name: `reload ${item.typeId}: ${r.ok ? 'ok' : r.code}` };
  }],
  // eating: the one operation that may lower the census, by exactly one portion
  [4, (w) => {
    const c = w.rng.pick([w.a, w.b]);
    const food = everything(w).filter((x) => c.inv.comestibleIn(x.item) && c.inv.has(x.item));
    if (!food.length) return null;
    const { item, loc } = w.rng.pick(food);
    const f = c.inv.comestibleIn(item)!;
    const id = f.typeId;
    c.thirst = 200;
    c.storedKcal = 0;
    const r = c.inv.consume(item, loc);
    return { name: `eat ${id}: ${r.ok ? 'ok' : r.code}`, consumed: r.ok ? { [id]: -1 } : {} };
  }],
  // stale: an operation on an item that has moved since the "UI" looked at it
  [6, (w) => {
    const all = everything(w);
    if (all.length < 2) return null;
    const a = w.rng.pick(all), b = w.rng.pick(all);
    moveItem(b.item, b.loc, randomLoc(w), { force: w.rng.oneIn(3) });
    const staleLoc = a.loc;
    const wasAt = isAt(a.item, staleLoc);
    const dest = randomLoc(w);
    const r = w.rng.oneIn(2) ? moveItem(a.item, staleLoc, dest) : w.a.inv.wield(a.item, staleLoc);
    if (!wasAt && r.ok) throw new Error(`a stale location was accepted: ${a.item.typeId} ${describeLoc(staleLoc)} -> ${describeLoc(dest)} ${r.msg}`);
    return { name: `stale ${a.item.typeId} from ${describeLoc(staleLoc)}: ${r.ok ? 'ok' : r.code}` };
  }],
  // a transaction that moves things and then fails: everything goes back exactly
  [4, (w) => {
    const before = JSON.stringify(snapshot(w));
    const txlog: string[] = [];
    transaction(() => {
      for (let i = 0; i < 4; i++) {
        const all = everything(w);
        if (!all.length) break;
        const { item, loc } = w.rng.pick(all);
        const to = randomLoc(w);
        const rr = moveItem(item, loc, to, { partial: true, count: item.countByCharges ? w.rng.int(1, item.charges) : undefined });
        txlog.push(`${item.typeId} ${describeLoc(loc)}->${describeLoc(to)} ${rr.ok}`);
      }
      return false;
    });
    const after = JSON.stringify(snapshot(w));
    if (after !== before) {
      // show where the world differs from before the transaction
      let i = 0;
      while (after[i] === before[i]) i++;
      throw new Error(`rollback left a difference:\n${before.slice(Math.max(0, i - 200), i + 200)}\n----\n${after.slice(Math.max(0, i - 200), i + 200)}\nmoves: ${txlog.join('; ')}`);
    }
    return { name: 'failed transaction' };
  }],
  // dry runs change nothing
  [3, (w) => {
    const before = JSON.stringify(snapshot(w));
    const all = everything(w);
    if (!all.length) return null;
    const { item, loc } = w.rng.pick(all);
    moveItem(item, loc, randomLoc(w), { dryRun: true, partial: true });
    expect(JSON.stringify(snapshot(w))).toBe(before);
    return { name: 'dry run' };
  }],
  // save and load everything
  [2, (w) => {
    saveLoad(w);
    return { name: 'save/load' };
  }],
];

/** The whole world's items as JSON, per place, in order (for "nothing changed" checks). */
function snapshot(w: World): unknown {
  return roots(w).map((l) => [l.kind, (l.kind === 'hands' ? (l.who.inv.wielded ? [l.who.inv.wielded] : []) : l.kind === 'worn' ? l.who.inv.worn : l.kind === 'inv' ? l.who.inv.items : l.kind === 'ground' ? (l.map.itemsAt(l.x, l.y, l.z) as Item[]) : l.kind === 'cargo' ? l.part.items : l.kind === 'stock' ? l.owner.stock : []).map((i) => i.toJSON())]);
}

/** Serialize every place and rebuild it from JSON (through the save sanitizers). */
function saveLoad(w: World): void {
  const warn = (m: string) => {
    throw new Error(`save/load warned: ${m}`);
  };
  for (const c of [w.a, w.b]) {
    const j = JSON.parse(JSON.stringify(c.inv.toJSON()));
    c.inv.load(sanitizeInventoryJSON(data, j, warn));
  }
  const reload = (list: Item[]) => list.map((i) => Item.fromJSON(data, sanitizeItemJSON(data, JSON.parse(JSON.stringify(i.toJSON())), warn)!));
  for (const [x, y, z] of w.tiles) {
    const k = `${x},${y},${z}`;
    const list = w.ground.tiles.get(k);
    if (list) w.ground.tiles.set(k, reload(list as Item[]));
  }
  w.trunk.items = reload(w.trunk.items);
  w.shop.stock = reload(w.shop.stock);
}

/** Structural invariants every reachable item must satisfy. */
function checkShape(w: World): void {
  for (const { item, loc } of everything(w)) {
    if (item.countByCharges) expect(item.charges, `${item.typeId} empty stack at ${describeLoc(loc)}`).toBeGreaterThan(0);
    if (loc.kind === 'mag') expect(loc.host.acceptsMagazine(item) || loc.host.takesMagazines(), `${item.typeId} in ${loc.host.typeId}'s magazine slot`).toBe(true);
    if (!item.countByCharges && item.ammoId) expect(item.charges).toBeLessThanOrEqual(Math.max(item.ammoCapacity(), item.charges));
    expect(locate(item, roots(w)), `${item.typeId} can't be found where it is`).not.toBeNull();
  }
  for (const c of [w.a, w.b]) for (const t of c.inv.worn) expect(t.isArmor()).toBe(true);
}

const STATS = new Map<string, number>();
describe('item conservation (property test)', () => {
  const totalWeight = OPS.reduce((s, [wt]) => s + wt, 0);
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}: ${STEPS} random operations conserve every item`, () => {
      const w = makeWorld(seed);
      let before = counts(w);
      const trail: string[] = [];
      for (let step = 0; step < STEPS; step++) {
        let r = w.rng.next() * totalWeight;
        const op = OPS.find(([wt]) => (r -= wt) < 0)![1];
        let res: ReturnType<Op>;
        try {
          res = op(w);
        } catch (e) {
          throw new Error(`seed ${seed} step ${step}: ${(e as Error).message}\n${trail.slice(-12).join('\n')}`);
        }
        if (!res) continue;
        trail.push(res.name);
        if (process.env.CONSERVATION_STATS) {
          const key = res.name.split(' ')[0] + (res.name.endsWith(': ok') || !res.name.includes(': ') ? ' ok' : ' fail');
          STATS.set(key, (STATS.get(key) ?? 0) + 1);
        }
        const after = counts(w);
        const d = diff(before, after);
        expect(d, `seed ${seed} step ${step}: ${res.name}\n${trail.slice(-12).join('\n')}`).toEqual(res.consumed ?? {});
        before = after;
        if (step % 20 === 0) checkShape(w);
      }
      checkShape(w);
    });
  }
  if (process.env.CONSERVATION_STATS) it('stats', () => console.log([...STATS].sort().map(([k, v]) => `${k}: ${v}`).join('\n')));
});
