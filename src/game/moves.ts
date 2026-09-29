import type { MapItem } from '../world/map';
import type { Character } from './character';
import { ammoRoom, asArray, containerRefusal, containerRoomFor, holsterRefusal, Item } from './item';
import { gunmodCompatible, isGunmod, removableReason } from './gunmods';

// The one place items change location (docs/INVENTORY_MODEL.md). Every item is in exactly one
// place: in someone's hands, worn, in their carried inventory, inside another item (container
// contents, a gun's magazine slot, a gunmod slot), on a map tile, in vehicle cargo or in an NPC
// shop's stock. Every action that moves items — pick up, drop, wield, wear, take off, unload,
// reload, insert, trade, crafting, butchery — goes through moveItem(), which
//
//  1. checks the item really is at `from` (a stale UI entry fails instead of cloning it),
//  2. applies BN's rules for the destination (containers hold one load, liquids need a sealed
//     container when carried, holsters/bandoliers/magazines take what their actor allows,
//     carried volume/weight limits, ...) and returns the CDDA/BN message when it can't,
//  3. detaches exactly the moved quantity (splitting a stack) and attaches it (merging into an
//     identical stack), recording an undo log, so a check that fails afterwards or a failing step
//     of a multi-step transaction() restores the exact previous state.
//
// Quantity only appears through spawnItem() (creation: item groups, crafting results, debug)
// and disappears through consumeItem() (eating, crafting components, firing). The raw slots
// (Item._contents/_magazine/_gunmods, Inventory raw lists, map/cargo/stock arrays) are only
// touched here; tests/moves_lint.test.ts enforces that and tests/conservation.test.ts
// property-tests that nothing is ever duplicated or lost.

/** What the ground needs to be (GameMap satisfies it; tests use a tiny fake). */
export interface Ground {
  itemsAt(x: number, y: number, z: number): readonly MapItem[];
  addItem(x: number, y: number, z: number, item: MapItem): void;
  removeItem(x: number, y: number, z: number, item: MapItem): boolean;
  /** Optional: re-insert at a list position, so an undone move restores the tile's order too. */
  insertItemAt?(x: number, y: number, z: number, index: number, item: MapItem): void;
  furnAt?(x: number, y: number, z: number): { id: string; name?: unknown; max_volume?: number; flags?: string[] };
}
/** A vehicle CARGO part (src/game/vehicle.ts VehiclePart satisfies it). */
export interface Cargo {
  items: Item[];
  def: { name: string; size?: number };
}
/** An NPC's shop stock (src/game/npc.ts Npc satisfies it). */
export interface StockOwner {
  stock: Item[];
  name: string;
}

export type Loc =
  | { kind: 'hands'; who: Character }
  | { kind: 'worn'; who: Character }
  | { kind: 'inv'; who: Character }
  /** contents of a container / holster / bandolier / magazine, or the rounds of an integral magazine */
  | { kind: 'in'; host: Item }
  /** the detachable magazine slot of a gun or tool */
  | { kind: 'mag'; host: Item }
  /** installed gunmods */
  | { kind: 'mod'; host: Item }
  | { kind: 'ground'; map: Ground; x: number; y: number; z: number }
  | { kind: 'cargo'; part: Cargo; vehicle?: { version: number; name?: string } }
  | { kind: 'stock'; owner: StockOwner };

/** Location constructors. */
export const L = {
  hands: (who: Character): Loc => ({ kind: 'hands', who }),
  worn: (who: Character): Loc => ({ kind: 'worn', who }),
  inv: (who: Character): Loc => ({ kind: 'inv', who }),
  in: (host: Item): Loc => ({ kind: 'in', host }),
  mag: (host: Item): Loc => ({ kind: 'mag', host }),
  mod: (host: Item): Loc => ({ kind: 'mod', host }),
  ground: (map: Ground, x: number, y: number, z: number): Loc => ({ kind: 'ground', map, x, y, z }),
  cargo: (part: Cargo, vehicle?: { version: number; name?: string }): Loc => ({ kind: 'cargo', part, vehicle }),
  stock: (owner: StockOwner): Loc => ({ kind: 'stock', owner }),
};

/** Machine-readable reason codes (the UI's "why can't I"). */
export type WhyNot =
  | 'stale' | 'same_place' | 'inside_itself' | 'not_allowed' | 'no_room' | 'too_heavy' | 'hands_full'
  | 'cant_wield' | 'cant_wear' | 'cant_take_off' | 'cant_unwield' | 'liquid' | 'wrong_container'
  | 'mixed_load' | 'not_watertight' | 'needs_seal' | 'wrong_ammo' | 'full' | 'incompatible';

export interface MoveOpts {
  /** Charges to move (count_by_charges only). Default: the whole stack. */
  count?: number;
  /** Move as much as fits instead of failing when not all of it does (pouring, loading rounds). */
  partial?: boolean;
  /** Whose rules, capacity and messages apply (defaults to the character of from/to). */
  actor?: Character;
  /** No messages to the actor. */
  quiet?: boolean;
  /** Check only: nothing changes (the result says what would happen). */
  dryRun?: boolean;
  /** System moves (a mutation pushing clothes off, bionics): skip from-side restrictions and capacity. */
  force?: boolean;
}

export interface MoveResult {
  ok: boolean;
  msg: string;
  /** BN moves the action costs (100 = one turn). */
  moves: number;
  code?: WhyNot;
  /** Quantity moved (charges for stacks, 1 otherwise). */
  moved: number;
  /** The item as it now exists at `to` (a split part, or the stack it merged into). */
  item?: Item;
}

const fail = (code: WhyNot, msg: string): MoveResult => ({ ok: false, msg, moves: 0, code, moved: 0 });

// ------------------------------------------------------------------ undo log / transactions

type Undo = () => void;
let txStack: Undo[][] = [];

/**
 * Run several moves as one: if `fn` returns false (or throws), every move it made is undone
 * exactly, in reverse order. Returns what fn returned.
 */
export function transaction<T>(fn: () => T): T {
  const log: Undo[] = [];
  txStack.push(log);
  let ok = false;
  try {
    const r = fn();
    ok = r !== false && !(typeof r === 'object' && r !== null && (r as { ok?: boolean }).ok === false);
    return r;
  } finally {
    txStack.pop();
    if (!ok) for (let i = log.length - 1; i >= 0; i--) log[i]();
    else if (txStack.length) txStack[txStack.length - 1].push(...log);
  }
}

function record(log: Undo[], u: Undo): void {
  log.push(u);
}

// ------------------------------------------------------------------ raw slot access

/** Raw Inventory slots (inventory.ts exposes them only to this module). */
export interface InvSlots {
  wielded: Item | null;
  worn: Item[];
  items: Item[];
  sortWorn(): void;
}
const invSlots = new WeakMap<object, InvSlots>();
/** @internal inventory.ts registers each Inventory's raw slots here. */
export function registerInventorySlots(inv: object, slots: InvSlots): void {
  invSlots.set(inv, slots);
}
function slotsOf(who: Character): InvSlots {
  const s = invSlots.get(who.inv);
  if (!s) throw new Error('moves: inventory slots not registered');
  return s;
}

/** Items directly at a location (not nested). */
export function itemsAt(loc: Loc): readonly Item[] {
  switch (loc.kind) {
    case 'hands': {
      const w = slotsOf(loc.who).wielded;
      return w ? [w] : [];
    }
    case 'worn':
      return slotsOf(loc.who).worn;
    case 'inv':
      return slotsOf(loc.who).items;
    case 'in':
      return loc.host._contents;
    case 'mag':
      return loc.host._magazine ? [loc.host._magazine] : [];
    case 'mod':
      return loc.host._gunmods;
    case 'ground':
      return loc.map.itemsAt(loc.x, loc.y, loc.z) as readonly Item[];
    case 'cargo':
      return loc.part.items;
    case 'stock':
      return loc.owner.stock;
  }
}

/** Is `it` directly at `loc`? */
export function isAt(it: Item, loc: Loc): boolean {
  return itemsAt(loc).includes(it);
}

function sameLoc(a: Loc, b: Loc): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'hands': case 'worn': case 'inv':
      return a.who === (b as typeof a).who;
    case 'in': case 'mag': case 'mod':
      return a.host === (b as typeof a).host;
    case 'ground': {
      const g = b as typeof a;
      return a.map === g.map && a.x === g.x && a.y === g.y && a.z === g.z;
    }
    case 'cargo':
      return a.part === (b as typeof a).part;
    case 'stock':
      return a.owner === (b as typeof a).owner;
  }
}

function touch(loc: Loc): void {
  if (loc.kind === 'cargo' && loc.vehicle) loc.vehicle.version++;
}

/** Remove `it` from `loc`; records how to put it back. */
function rawDetach(loc: Loc, it: Item, log: Undo[]): void {
  const arr = (list: Item[]) => {
    const i = list.indexOf(it);
    if (i < 0) throw new Error(`moves: ${it.typeId} not at ${loc.kind}`);
    list.splice(i, 1);
    record(log, () => list.splice(i, 0, it));
  };
  switch (loc.kind) {
    case 'hands': {
      const s = slotsOf(loc.who);
      if (s.wielded !== it) throw new Error('moves: not wielded');
      s.wielded = null;
      record(log, () => (s.wielded = it));
      return;
    }
    case 'worn': {
      const s = slotsOf(loc.who);
      arr(s.worn);
      return;
    }
    case 'inv':
      return arr(slotsOf(loc.who).items);
    case 'in':
      return arr(loc.host._contents);
    case 'mag': {
      const h = loc.host;
      if (h._magazine !== it) throw new Error('moves: not the magazine');
      h._magazine = null;
      record(log, () => (h._magazine = it));
      return;
    }
    case 'mod':
      return arr(loc.host._gunmods);
    case 'ground': {
      const { map, x, y, z } = loc;
      const i = map.itemsAt(x, y, z).indexOf(it);
      if (!map.removeItem(x, y, z, it)) throw new Error(`moves: ${it.typeId} not on the ground at ${x},${y},${z}`);
      record(log, () => (map.insertItemAt ? map.insertItemAt(x, y, z, i, it) : map.addItem(x, y, z, it)));
      return;
    }
    case 'cargo':
      arr(loc.part.items);
      touch(loc);
      return;
    case 'stock':
      return arr(loc.owner.stock);
  }
}

/** Put `it` at `loc` (no rules). */
function rawAttach(loc: Loc, it: Item, log: Undo[]): void {
  const arr = (list: Item[]) => {
    list.push(it);
    record(log, () => {
      const i = list.lastIndexOf(it);
      if (i >= 0) list.splice(i, 1);
    });
  };
  switch (loc.kind) {
    case 'hands': {
      const s = slotsOf(loc.who);
      if (s.wielded) throw new Error('moves: hands full');
      s.wielded = it;
      record(log, () => (s.wielded = null));
      return;
    }
    case 'worn': {
      const s = slotsOf(loc.who);
      const before = [...s.worn];
      s.worn.push(it);
      s.sortWorn();
      record(log, () => s.worn.splice(0, s.worn.length, ...before));
      return;
    }
    case 'inv':
      return arr(slotsOf(loc.who).items);
    case 'in':
      return arr(loc.host._contents);
    case 'mag': {
      const h = loc.host;
      if (h._magazine) throw new Error('moves: magazine slot full');
      h._magazine = it;
      record(log, () => (h._magazine = null));
      return;
    }
    case 'mod':
      return arr(loc.host._gunmods);
    case 'ground': {
      const { map, x, y, z } = loc;
      map.addItem(x, y, z, it);
      record(log, () => map.removeItem(x, y, z, it));
      return;
    }
    case 'cargo':
      arr(loc.part.items);
      touch(loc);
      return;
    case 'stock':
      return arr(loc.owner.stock);
  }
}

/** Take `n` of `it` out of `loc`: the item itself, or a split part. */
function takeFrom(loc: Loc, it: Item, n: number, log: Undo[]): Item {
  if (!it.countByCharges || n >= it.charges) {
    rawDetach(loc, it, log);
    return it;
  }
  const piece = it._split(n);
  record(log, () => (it.charges += n));
  return piece;
}

/** Where a stack of `it` merges at `loc` (identical state), if anywhere. */
function mergeTarget(loc: Loc, it: Item): Item | null {
  if (!it.countByCharges) return null;
  if (loc.kind === 'hands' || loc.kind === 'worn' || loc.kind === 'mag' || loc.kind === 'mod') return null;
  if (loc.kind === 'in') {
    const first = loc.host._contents[0];
    // A container / bandolier / magazine holds one load: rounds or liquid merge into it.
    return first && first.typeId === it.typeId && !first.hasContents() ? first : null;
  }
  return itemsAt(loc).find((o) => o.stacksWith(it)) ?? null;
}

/** Put `piece` at `loc`, merging stacks; returns the item that now holds it. */
function putAt(loc: Loc, piece: Item, log: Undo[]): Item {
  if (loc.kind === 'in' && isIntegralHost(loc.host) && piece.isAmmo()) {
    const h = loc.host;
    const [c0, a0] = [h.charges, h.ammoId];
    h.charges += piece.charges;
    h.ammoId = piece.typeId;
    // the piece stops existing as an object: its rounds are the host's charges now
    const n = piece.charges;
    piece.charges = 0;
    record(log, () => {
      h.charges = c0;
      h.ammoId = a0;
      piece.charges = n;
    });
    return h;
  }
  const target = mergeTarget(loc, piece);
  if (target) {
    const [c0, r0, n] = [target.charges, target.rot, piece.charges];
    // BN fill_with: a container's load takes the weighted average rot
    if (target.charges + n > 0) target.rot = (target.rot * target.charges + piece.rot * n) / (target.charges + n);
    target.charges += n;
    piece.charges = 0;
    touch(loc);
    record(log, () => {
      target.charges = c0;
      target.rot = r0;
      piece.charges = n;
    });
    return target;
  }
  rawAttach(loc, piece, log);
  return piece;
}

function isIntegralHost(h: Item): boolean {
  return !h.isContainer() && !h.isMagazine() && !h.isBandolier() && !h.isHolster() && h.hasIntegralMagazine();
}

// ------------------------------------------------------------------ queries

/** The character whose body/inventory `loc` is part of (directly), if any. */
function locOwner(loc: Loc | null): Character | null {
  return loc && (loc.kind === 'hands' || loc.kind === 'worn' || loc.kind === 'inv') ? loc.who : null;
}

/**
 * Where `host` sits relative to `who`: 'hands' / 'worn' / 'inv' for the top-level item that
 * (transitively) contains it, or null when `who` doesn't carry it.
 */
export function carriedAs(who: Character, host: Item): 'hands' | 'worn' | 'inv' | null {
  const s = slotsOf(who);
  const inTree = (top: Item) => {
    for (const x of top.walk()) if (x === host) return true;
    return false;
  };
  if (s.wielded && inTree(s.wielded)) return 'hands';
  for (const w of s.worn) if (inTree(w)) return 'worn';
  for (const i of s.items) if (inTree(i)) return 'inv';
  return null;
}

/** Search `scope` for the location holding `it` directly. */
export function locate(it: Item, scope: Loc[]): Loc | null {
  const visit = (loc: Loc): Loc | null => {
    const here = itemsAt(loc);
    if (here.includes(it)) return loc;
    for (const x of here) {
      const r = visit(L.in(x)) ?? visit(L.mag(x)) ?? visit(L.mod(x));
      if (r) return r;
    }
    return null;
  };
  for (const s of scope) {
    const r = visit(s);
    if (r) return r;
  }
  return null;
}

/** The character's carrying spots (hands, worn, inventory). */
export function bodyLocs(who: Character): Loc[] {
  return [L.hands(who), L.worn(who), L.inv(who)];
}

/** Human-readable name of a location ("your backpack", "the ground", "the locker"). */
export function locName(loc: Loc): string {
  switch (loc.kind) {
    case 'hands': return 'your hands';
    case 'worn': return 'your body';
    case 'inv': return 'your inventory';
    case 'in': case 'mag': case 'mod': return `the ${loc.host.baseName()}`;
    case 'ground': {
      const f = loc.map.furnAt?.(loc.x, loc.y, loc.z);
      return f && f.id !== 'f_null' && typeof f.name === 'string' ? `the ${f.name}` : 'the ground';
    }
    case 'cargo': return `the ${loc.part.def.name}`;
    case 'stock': return `${loc.owner.name}'s stock`;
  }
}

/** Volume capacity of a ground tile, if it is limited (storage furniture's max_volume). */
function groundCapacity(loc: Extract<Loc, { kind: 'ground' }>): number | null {
  const f = loc.map.furnAt?.(loc.x, loc.y, loc.z);
  return f && typeof f.max_volume === 'number' && f.max_volume > 0 ? f.max_volume : null;
}

function volumeOf(list: readonly Item[]): number {
  let v = 0;
  for (const i of list) v += i.volume();
  return v;
}

// ------------------------------------------------------------------ rules

interface Plan {
  /** units accepted (<= requested) */
  n: number;
}

/** Static rules for taking `n` of `it` out of `from`. */
function checkFrom(it: Item, from: Loc, opts: MoveOpts): MoveResult | null {
  if (opts.force) return null;
  if (from.kind === 'hands' && (it.hasFlag('NO_UNWIELD') || it.hasFlag('BIONIC_WEAPON'))) return fail('cant_unwield', `You cannot unwield your ${it.name()}.`);
  if (from.kind === 'worn') {
    if (it.hasFlag('INTEGRATED')) return fail('cant_take_off', `You can't take off your ${it.name()}; it's part of you.`);
    if (it.hasFlag('NO_TAKEOFF')) return fail('cant_take_off', "You can't take that item off.");
  }
  if (from.kind === 'mod') {
    const why = removableReason(from.host, it);
    if (why) return fail('not_allowed', why);
  }
  if (from.kind === 'in' && from.host.isContainer() && it.isLiquid() && it.hasFlag('FROZEN')) return fail('not_allowed', "The liquid can't be unloaded in its current state!");
  return null;
}

/** Static rules for putting `n` of `it` at `to`; returns how many are accepted, or a failure. */
function checkTo(it: Item, n: number, to: Loc, opts: MoveOpts, actor: Character | null): Plan | MoveResult {
  const partialOk = (room: number, why: string, code: WhyNot): Plan | MoveResult => {
    if (room <= 0) return fail(code, why);
    if (room < n && !opts.partial) return fail(code, why);
    return { n: Math.min(n, room) };
  };
  switch (to.kind) {
    case 'hands': {
      if (slotsOf(to.who).wielded) return fail('hands_full', `You're already holding your ${slotsOf(to.who).wielded!.name()}.`);
      const w = to.who.inv.canWield(it);
      if (!w.ok) return fail('cant_wield', w.reason!);
      return { n };
    }
    case 'worn': {
      if (it.countByCharges) return fail('cant_wear', `Putting on a ${it.name()} would be tricky.`);
      const w = to.who.inv.canWear(it);
      if (!w.ok) return fail('cant_wear', w.reason!);
      return { n };
    }
    case 'inv': {
      if (it.isLiquid()) return fail('liquid', 'Spilt liquids cannot be picked back up.  Try mopping them up instead.');
      if (holdsLooseLiquid(it)) return fail('needs_seal', `That ${it.baseName()} must be on the ground or held to hold contents!`);
      return { n };
    }
    case 'in': {
      const h = to.host;
      if (h === it || [...it.walk()].includes(h)) return fail('inside_itself', "You can't put something inside itself.");
      if (h.isContainer()) {
        const why = containerRefusal(h, it);
        if (why) return fail(why.includes('mix') ? 'mixed_load' : why.includes('water-tight') ? 'not_watertight' : 'full', why);
        if (it.isLiquid() && !h.isWatertight()) {
          // BN get_remaining_capacity_for_liquid(allow_bucket): an unsealable container takes
          // liquid only as a bucket, and a bucket only on the ground or in your hands.
          if (!h.isBucket()) return fail('needs_seal', `You can't seal that ${h.baseName()}!`);
          const where = actor ? carriedAs(actor, h) : null;
          if (where === 'inv' || where === 'worn') return fail('needs_seal', `That ${h.baseName()} must be on the ground or held to hold contents!`);
        }
        return partialOk(containerRoomFor(h, it), `Your ${h.baseName()} can't hold any more ${it.baseName(2)}.`, 'full');
      }
      if (h.isHolster()) {
        const why = holsterRefusal(h, it);
        if (why) return fail('not_allowed', why);
        return { n };
      }
      if (h.isBandolier() || h.isMagazine() || isIntegralHost(h)) {
        const r = ammoRoom(h, it);
        if (!r.room) return fail(r.why?.includes('mix') ? 'mixed_load' : r.why?.includes('fully') ? 'full' : 'wrong_ammo', r.why ?? "It won't fit.");
        return partialOk(r.room, `Your ${h.baseName()} can't hold any more ${it.baseName(2)}.`, 'full');
      }
      if (h.takesMagazines() && it.isAmmo()) return fail('wrong_container', `Your ${h.baseName()} takes a magazine, not loose ${it.baseName(2)}.`);
      return fail('wrong_container', `That ${h.baseName()} won't hold ${it.name()}.`);
    }
    case 'mag': {
      const h = to.host;
      if (!h.takesMagazines()) return fail('incompatible', `Your ${h.baseName()} doesn't take magazines.`);
      if (!it.isMagazine() || !h.acceptsMagazine(it)) return fail('incompatible', `The ${it.baseName()} doesn't fit your ${h.baseName()}.`);
      if (h._magazine) return fail('full', `Your ${h.baseName()} already has a ${h._magazine.baseName()} in it.`);
      return { n };
    }
    case 'mod': {
      if (!isGunmod(it)) return fail('incompatible', `The ${it.baseName()} is not a gunmod.`);
      const ok = gunmodCompatible(to.host, it);
      if (!ok.ok) return fail('incompatible', `Your ${to.host.baseName()} ${ok.reason}.`);
      return { n };
    }
    case 'ground': {
      const cap = groundCapacity(to);
      if (cap !== null) {
        const free = cap - volumeOf(itemsAt(to));
        const per = it.countByCharges ? it.unitVolume() : it.volume();
        const room = per > 0 ? Math.floor(free / per + 1e-9) : n;
        return partialOk(it.countByCharges ? room : room >= 1 ? 1 : 0, `The ${locName(to).replace(/^the /, '')} is full.`, 'no_room');
      }
      return { n };
    }
    case 'cargo': {
      const cap = to.part.def.size ?? 0;
      const free = cap - volumeOf(to.part.items);
      const per = it.countByCharges ? it.unitVolume() : it.volume();
      const room = per > 0 ? Math.floor(free / per + 1e-9) : n;
      return partialOk(it.countByCharges ? room : room >= 1 ? 1 : 0, `The ${to.part.def.name} is full.`, 'no_room');
    }
    case 'stock':
      return { n };
  }
}

/** A bucket-like container (watertight, not sealable) holding liquid can't go in a pack. */
function holdsLooseLiquid(it: Item): boolean {
  const c = it.def.container_data;
  if (!c || !it.hasContents()) return false;
  if (!it.contents.some((x) => x.isLiquid())) return false;
  return !c.seals && !c.unseals_into;
}

// ------------------------------------------------------------------ costs & messages

/** Character::item_handling_cost: base + 1 move per 20 ml (max 200) + hand encumbrance. */
export function handlingCost(who: Character | null, it: Item, base = 100, penalties = true): number {
  let mv = base;
  if (penalties) mv += Math.min(200, Math.floor(it.volume() / 20));
  if (who) {
    const l = who.inv.encumbrance('hand_l'), r = who.inv.encumbrance('hand_r');
    mv += it.hasFlag('ALWAYS_TWOHAND') ? l + r : Math.min(l, r);
  }
  return Math.max(0, Math.min(400, mv));
}

function costOf(it: Item, from: Loc | null, to: Loc, actor: Character | null): number {
  if (to.kind === 'worn') return actor ? actor.inv.wearCost(it) : 250;
  // BN wield: worn things (a slung rifle) come to hand at half the inventory penalty
  if (to.kind === 'hands' && from?.kind === 'worn') return handlingCost(actor, it, 50);
  if (from?.kind === 'worn') return 250;
  if (to.kind === 'hands') {
    // Drawing from a worn holster is quick (holster_actor draw_cost).
    if (from?.kind === 'in' && from.host.def.holster && actor && carriedAs(actor, from.host) === 'worn') return from.host.def.holster.draw_cost;
    return handlingCost(actor, it, 100);
  }
  if (to.kind === 'in' && to.host.def.holster) return to.host.def.holster.draw_cost;
  if (to.kind === 'in' && to.host.def.bandolier) return to.host.def.bandolier.draw_cost * Math.max(1, it.count());
  if (to.kind === 'ground' || to.kind === 'cargo') return 100;
  if (from?.kind === 'ground' || from?.kind === 'cargo') return 100;
  return handlingCost(actor, it);
}

function messageFor(name: string, from: Loc | null, to: Loc, host = ''): string {
  switch (to.kind) {
    case 'hands':
      return from?.kind === 'in' && from.host.def.holster ? `You draw your ${name}.` : `You wield your ${name}.`;
    case 'worn':
      return `You put on your ${name}.`;
    case 'inv':
      if (from?.kind === 'worn') return `You take off your ${name}.`;
      if (from?.kind === 'hands') return `You put away your ${name}.`;
      if (from?.kind === 'in' || from?.kind === 'mag' || from?.kind === 'mod') return `You take the ${name} out of the ${host}.`;
      if (from?.kind === 'ground' || from?.kind === 'cargo' || from?.kind === 'stock') return `You pick up: ${name}`;
      return `You put the ${name} in your inventory.`;
    case 'in':
      if (to.host.def.holster) return `You holster your ${name}.`;
      if (to.host.isContainer() && !to.host.hasContents()) return `You put the ${name} in your ${to.host.baseName()}.`;
      return `You put the ${name} in your ${to.host.baseName()}.`;
    case 'mag':
      return `You insert the ${name} into your ${to.host.baseName()}.`;
    case 'mod':
      return `You attach the ${name} to your ${to.host.baseName()}.`;
    case 'ground':
      return from?.kind === 'in' && !locOwnerIsBody(from) ? `You put the ${name} on ${locName(to)}.` : `You drop your ${name}.`;
    case 'cargo':
      return `You put the ${name} into the ${to.part.def.name}.`;
    case 'stock':
      return `You hand over the ${name}.`;
  }
}
function locOwnerIsBody(l: Loc): boolean {
  return l.kind === 'hands' || l.kind === 'worn' || l.kind === 'inv';
}

// ------------------------------------------------------------------ capacity (after the fact)

interface Load {
  who: Character;
  vol: number;
  wt: number;
}
function loadOf(who: Character): Load {
  return { who, vol: who.inv.volumeCarried(), wt: who.inv.weightCarried() };
}
/** A move may not make carried volume or weight worse past the limits (BN can_pick_volume/weight). */
function overLimit(before: Load, name: string): MoveResult | null {
  const inv = before.who.inv;
  const vol = inv.volumeCarried();
  if (vol > before.vol && vol > inv.volumeCapacity()) return fail('no_room', `There's no room in your inventory for the ${name}.`);
  const wt = inv.weightCarried();
  if (wt > before.wt && wt > inv.weightCapacity() * 4) return fail('too_heavy', `The ${name} is too heavy to carry.`);
  return null;
}

// ------------------------------------------------------------------ the move

/**
 * Move `it` (or `opts.count` of a stack) from `from` to `to`. `from = null` means `it` is new
 * and not anywhere yet (use spawnItem for that). Never duplicates or loses quantity: on any
 * failure nothing changes.
 */
export function moveItem(it: Item, from: Loc | null, to: Loc, opts: MoveOpts = {}): MoveResult {
  const actor = opts.actor ?? locOwner(to) ?? locOwner(from) ?? null;
  if (from) {
    if (!isAt(it, from)) return fail('stale', `The ${it.name()} is no longer there.`);
    if (sameLoc(from, to)) return fail('same_place', `The ${it.name()} is already there.`);
  } else assertUnplaced(it, to, actor);
  const want = opts.count ?? it.count();
  if (!Number.isInteger(want) || want <= 0 || want > it.count()) throw new Error(`moveItem: bad count ${opts.count} for ${it.typeId} x${it.count()}`);
  if (!it.countByCharges && want !== 1) throw new Error(`moveItem: count ${want} of non-stack ${it.typeId}`);
  if (it.countByCharges && it.charges <= 0) throw new Error(`moveItem: empty stack ${it.typeId}`);
  if (from) {
    const f = checkFrom(it, from, opts);
    if (f) return f;
  }
  // Probe the destination with the part that would move (its volume/weight decide).
  const probe = it.countByCharges && want < it.charges ? cloneStack(it, want) : it;
  const plan = checkTo(probe, want, to, opts, actor);
  if ('ok' in plan) return plan;
  const n = plan.n;

  const log: Undo[] = [];
  // Everyone whose load could change: the actor (who may hold the host container) and the
  // owners of both ends.
  const chars = new Set<Character>();
  for (const c of [actor, locOwner(from), locOwner(to)]) if (c) chars.add(c);
  const before = opts.force ? [] : [...chars].map(loadOf);
  const name = it.countByCharges ? cloneStack(it, n).name() : it.name();
  const hostName = from && (from.kind === 'in' || from.kind === 'mag' || from.kind === 'mod') ? from.host.baseName() : '';

  let piece: Item;
  let placed: Item;
  try {
    piece = from ? takeFrom(from, it, n, log) : takeNew(it, n, log);
    if (from?.kind === 'in') unseal(from.host, log);
    placed = putAt(to, piece, log);
    if (to.kind === 'in') unseal(to.host, log);
  } catch (e) {
    undoAll(log);
    throw e;
  }
  for (const b of before) {
    const over = overLimit(b, name);
    if (over) {
      undoAll(log);
      return over;
    }
  }
  const res: MoveResult = { ok: true, msg: messageFor(name, from, to, hostName), moves: costOf(piece, from, to, actor), moved: n, item: placed };
  if (opts.dryRun) {
    undoAll(log);
    return res;
  }
  const tx = txStack[txStack.length - 1];
  if (tx) tx.push(...log);
  if (!opts.quiet && actor) actor.msg(res.msg);
  return res;
}

/** Would the move work? (moveItem with dryRun; nothing changes, no message.) */
export function canMove(it: Item, from: Loc | null, to: Loc, opts: MoveOpts = {}): MoveResult {
  return moveItem(it, from, to, { ...opts, dryRun: true, quiet: true });
}

/** Place a newly created item (creation: item groups, crafting results, debug). */
export function spawnItem(it: Item, to: Loc, opts: MoveOpts = {}): MoveResult {
  return moveItem(it, null, to, opts);
}

/** Create `it` on a map tile (loot, butchery, debris, debug). Storage limits don't apply. */
export function spawnOnGround(map: Ground, x: number, y: number, z: number, it: Item): void {
  spawnItem(it, L.ground(map, x, y, z), { force: true, quiet: true });
}

/**
 * Place as much of a new stack as `to` takes. Returns the rest (still unplaced, the same
 * object) or null when all of it went — after which the caller must not touch `it` again.
 */
export function spawnSome(it: Item, to: Loc, opts: MoveOpts = {}): Item | null {
  const n = it.count();
  const r = spawnItem(it, to, { ...opts, partial: true });
  if (!r.ok) return it;
  return r.moved >= n ? null : it;
}

/**
 * Explicit consumption: remove `count` (charges; default all) of `it` from `from` and destroy
 * it. Returns the removed part (for effects: the portion eaten, the components used), or null
 * when `it` isn't there.
 */
export function consumeItem(it: Item, from: Loc, count?: number): Item | null {
  if (!isAt(it, from)) return null;
  // a stack already used up in place (burnt, fired) is only cleaned away
  if (it.countByCharges && it.charges <= 0 && count === undefined) {
    const log: Undo[] = [];
    rawDetach(from, it, log);
    txStack[txStack.length - 1]?.push(...log);
    return it;
  }
  const n = count ?? it.count();
  if (!Number.isInteger(n) || n <= 0 || n > it.count()) throw new Error(`consumeItem: bad count ${count} of ${it.typeId} x${it.count()}`);
  const log: Undo[] = [];
  const piece = takeFrom(from, it, n, log);
  if (from.kind === 'in') unseal(from.host, log);
  const tx = txStack[txStack.length - 1];
  if (tx) tx.push(...log);
  return piece;
}

/** Consume part (or all) of an item that isn't anywhere (a new crafting result). */
export function consumeNew(it: Item, count?: number): Item {
  const n = count ?? it.count();
  if (!Number.isInteger(n) || n <= 0 || n > it.count()) throw new Error(`consumeNew: bad count ${count} of ${it.typeId} x${it.count()}`);
  if (!it.countByCharges || n >= it.charges) return it;
  const piece = it._split(n);
  const tx = txStack[txStack.length - 1];
  if (tx) tx.push(() => (it.charges += n));
  return piece;
}

/** Destroy everything at `loc` matching `pred` (fires, disintegration). Returns what went. */
export function destroyWhere(loc: Loc, pred: (it: Item) => boolean): Item[] {
  const gone = itemsAt(loc).filter(pred);
  for (const it of gone) consumeItem(it, loc);
  return gone;
}

/** Charges-aware "is this the only place": new items must not already be reachable from `to`'s owner. */
function assertUnplaced(it: Item, to: Loc, actor: Character | null): void {
  const who = locOwner(to) ?? actor;
  if (who && carriedAs(who, it)) throw new Error(`moves: ${it.typeId} is already carried; pass its location as \`from\``);
  if (isAt(it, to)) throw new Error(`moves: ${it.typeId} is already at the destination`);
}

function takeNew(it: Item, n: number, log: Undo[]): Item {
  if (it.countByCharges && n < it.charges) {
    const piece = it._split(n);
    record(log, () => (it.charges += n));
    return piece;
  }
  return it;
}

function cloneStack(it: Item, n: number): Item {
  const c = new Item(it.data, it.def);
  c.charges = n;
  c.damage = it.damage;
  c.rot = it.rot;
  c.active = it.active;
  c.flags = [...it.flags];
  return c;
}

/** BN unseals_into: any change to a sealed can's contents opens it. */
function unseal(host: Item, log: Undo[]): void {
  const into = host.def.container_data?.unseals_into;
  if (!into || !host.data.items[into]) return;
  const old = host.typeId;
  host.convert(into);
  record(log, () => host.convert(old));
}

function undoAll(log: Undo[]): void {
  for (let i = log.length - 1; i >= 0; i--) log[i]();
  log.length = 0;
}

// ------------------------------------------------------------------ compound actions

/**
 * Unload `host` (BN avatar_funcs::unload_item): a container's / holster's / bandolier's
 * contents, a gun's magazine, or the rounds in a magazine or integral magazine. Each thing goes
 * to the first of `to` that takes it (BN: your inventory, else dropped at your feet); what no
 * destination takes stays where it was. Liquids never go to an inventory: unless a destination
 * is the ground they stay in `host` and are reported in `liquids`, so the caller can offer the
 * liquid menu (pour into a container, drink, pour out).
 */
export function unloadItem(host: Item, to: Loc | Loc[], opts: MoveOpts = {}): MoveResult & { liquids: Item[] } {
  const dests = Array.isArray(to) ? to : [to];
  const liquids: Item[] = [];
  const actor = opts.actor ?? dests.map(locOwner).find((c) => c) ?? null;
  const q: MoveOpts = { ...opts, quiet: true, actor: actor ?? undefined };
  const done = (r: MoveResult) => ({ ...r, liquids });
  const say = (r: MoveResult) => {
    if (r.ok && !opts.quiet && !opts.dryRun) actor?.msg(r.msg);
    return done(r);
  };
  /** First destination that takes it. */
  const send = (it: Item, from: Loc | null): MoveResult => {
    let last: MoveResult = fail('no_room', `There's nowhere to put the ${it.name()}.`);
    for (const d of dests) {
      if (it.isLiquid() && d.kind !== 'ground') continue;
      last = moveItem(it, from, d, q);
      if (last.ok) return last;
    }
    return last;
  };
  // Anything else holding things (item group contents-item, old saves) empties like a container.
  if (host.isContainer() || host.isHolster() || host.isBandolier() || (host.hasContents() && !host.isMagazine())) {
    if (!host.hasContents()) return done(fail('not_allowed', `The ${host.baseName()} is already empty!`));
    let moves = 0, moved = 0;
    let last: MoveResult | null = null;
    for (const c of [...host.contents]) {
      if (c.isLiquid() && !dests.some((d) => d.kind === 'ground')) {
        liquids.push(c);
        continue;
      }
      const r = send(c, L.in(host));
      last = r;
      if (r.ok) (moves += r.moves), (moved += r.moved);
    }
    if (!moved) return done(last ?? { ok: false, msg: '', moves: 0, moved: 0, code: 'liquid' });
    return say({ ok: true, msg: `You unload your ${host.baseName()}.`, moves, moved });
  }
  if (host.hasFlag('NO_UNLOAD')) return done(fail('not_allowed', `You can't unload a ${host.baseName()}!`));
  if (host.magazine) {
    const r = send(host.magazine, L.mag(host));
    if (!r.ok) return done(r);
    return say({ ...r, msg: `You unload your ${host.baseName()}.`, moves: Math.floor(((host.def.reload ?? 100) as number) / 2) });
  }
  if (host.isMagazine()) {
    const load = host.contents[0];
    if (!load) return done(fail('not_allowed', `Your ${host.baseName()} isn't loaded.`));
    const r = send(load, L.in(host));
    if (!r.ok) return done(r);
    return say({ ...r, msg: `You unload your ${host.baseName()}.`, moves: Math.min(200, Math.floor(((host.def.magazine?.reload_time ?? 100) * r.moved) / 2)) });
  }
  if (host.hasIntegralMagazine() && host.charges > 0 && host.ammoId && host.data.items[host.ammoId]) {
    // The rounds become an ammo item again (BN unload of an integral magazine): one step that
    // turns the host's charges into an item, then an ordinary move of that item.
    const rounds = new Item(host.data, host.data.items[host.ammoId]);
    const [c0, a0] = [host.charges, host.ammoId];
    rounds.charges = c0;
    host.charges = 0;
    host.ammoId = null;
    const restore = () => {
      host.charges = c0;
      host.ammoId = a0;
    };
    const r = send(rounds, null);
    if (!r.ok || opts.dryRun) {
      restore();
      return done(r);
    }
    const tx = txStack[txStack.length - 1];
    if (tx) tx.push(restore);
    return say({ ...r, msg: `You unload your ${host.baseName()}.`, moves: 100 });
  }
  if (host.hasIntegralMagazine() || host.takesMagazines())
    return done(fail('not_allowed', host.isTool() ? `Your ${host.baseName()} isn't charged.` : `Your ${host.baseName()} isn't loaded.`));
  return done(fail('not_allowed', `You can't unload a ${host.baseName()}!`));
}

/** Test/debug helper: every item reachable from `locs`, depth-first, with where it sits. */
export function* walkLocs(locs: Loc[]): Generator<{ item: Item; loc: Loc }> {
  const visit = function* (loc: Loc): Generator<{ item: Item; loc: Loc }> {
    for (const it of itemsAt(loc)) {
      yield { item: it, loc };
      yield* visit(L.in(it));
      yield* visit(L.mag(it));
      yield* visit(L.mod(it));
    }
  };
  for (const l of locs) yield* visit(l);
}

const unsealedFrom = new WeakMap<object, Map<string, string>>();
/** An opened can counts as the can it was (unseals_into changes the type, not the quantity). */
function sealedOriginal(it: Item): string {
  let m = unsealedFrom.get(it.data);
  if (!m) {
    m = new Map();
    for (const d of Object.values(it.data.items)) if (d.container_data?.unseals_into) m.set(d.container_data.unseals_into, d.id);
    unsealedFrom.set(it.data, m);
  }
  return m.get(it.typeId) ?? it.typeId;
}

/**
 * Quantity per item type (charges-aware; integral-magazine rounds count as their ammo type)
 * across `locs`, and every item object seen more than once (aliasing = duplication). The
 * conservation invariant is: census before == census after, minus explicit consumption.
 */
export function census(locs: Loc[]): { counts: Map<string, number>; aliased: Item[] } {
  const counts = new Map<string, number>();
  const seen = new Set<Item>();
  const aliased: Item[] = [];
  const add = (id: string, n: number) => n && counts.set(id, (counts.get(id) ?? 0) + n);
  for (const { item } of walkLocs(locs)) {
    if (seen.has(item)) aliased.push(item);
    seen.add(item);
    add(sealedOriginal(item), item.count());
    if (!item.countByCharges && item.ammoId && item.charges > 0) add(item.ammoId, item.charges);
  }
  return { counts, aliased };
}

export { asArray };
