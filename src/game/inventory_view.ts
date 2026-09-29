import type { BodyPartId } from './bodyparts';
import { ALL_PARTS, BODY_PARTS } from './bodyparts';
import type { Character } from './character';
import { covers, itemLayer, useActions, type Layer } from './inventory';
import type { Item } from './item';
import { cddaText } from './units';
import {
  canMove, carriedAs, isAt, itemsAt, L, locate, locName, unloadItem, type Cargo, type Ground, type Loc, type MoveResult, type WhyNot,
} from './moves';

// What the inventory screens need, UI-free (docs/INVENTORY_MODEL.md "For the UI"): a structured
// view of everything within reach — hands, clothes by body part with their storage, the carried
// inventory grouped by category, containers with fill bars, the ground / furniture / vehicle
// cargo around — plus stable string keys for items and places, a drop verdict that says why a
// move can't happen (the ui2 DropVerdict shape), and the action list for an item with BN move
// costs and "why not" reasons. The screens call moveItem / the Inventory actions to act; they
// never touch item lists.

// ------------------------------------------------------------------ keys

const ids = new WeakMap<Item, string>();
let nextId = 1;
/** A stable id for an item object (for DOM keys and drag payloads). Not saved. */
export function itemKey(it: Item): string {
  let id = ids.get(it);
  if (!id) ids.set(it, (id = `i${nextId++}`));
  return id;
}

/**
 * A string for a place, the ui2 InventoryModel's `loc`: "hands", "worn", "inv", "in:<itemKey>",
 * "mag:<itemKey>", "mod:<itemKey>", "ground:x,y,z", "cargo:<n>", "stock". Resolve it back with
 * resolveLocKey in the same InventoryScope.
 */
export function locKey(loc: Loc, scope?: InventoryScope): string {
  switch (loc.kind) {
    case 'hands': case 'worn': case 'inv':
      return loc.who === scope?.who || !scope ? loc.kind : `${loc.kind}@other`;
    case 'in': case 'mag': case 'mod':
      return `${loc.kind}:${itemKey(loc.host)}`;
    case 'ground':
      return `ground:${loc.x},${loc.y},${loc.z}`;
    case 'cargo':
      return `cargo:${scope?.cargo?.findIndex((c) => c.part === loc.part) ?? -1}`;
    case 'stock':
      return 'stock';
  }
}

/** What an inventory screen can reach: whose inventory, the ground around, cargo, a shop. */
export interface InventoryScope {
  who: Character;
  map?: Ground;
  /** The tile the character stands on (defaults to who.groundLoc). */
  at?: { x: number; y: number; z: number };
  /** Tiles around `at` that count as within reach (BN pickup range 1 = the 8 neighbours). */
  reach?: number;
  /** Vehicle cargo parts within reach, with a label ("trunk", "Pickup truck's box"). */
  cargo?: { part: Cargo; vehicle?: { version: number; name?: string }; label: string }[];
  /** A trading partner's shelf. */
  stock?: { owner: { stock: Item[]; name: string } };
}

/** Every top-level place in scope. */
export function scopeLocs(s: InventoryScope): Loc[] {
  const out: Loc[] = [L.hands(s.who), L.worn(s.who), L.inv(s.who)];
  const at = originOf(s);
  if (s.map && at) {
    const r = s.reach ?? 1;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) out.push(L.ground(s.map, at.x + dx, at.y + dy, at.z));
  }
  for (const c of s.cargo ?? []) out.push(L.cargo(c.part, c.vehicle));
  if (s.stock) out.push(L.stock(s.stock.owner));
  return out;
}

function originOf(s: InventoryScope): { x: number; y: number; z: number } | null {
  if (s.at) return s.at;
  const g = s.who.groundLoc?.();
  return g && g.kind === 'ground' ? { x: g.x, y: g.y, z: g.z } : null;
}

/** The place a key names, or null when it no longer exists (a container that was dropped out of reach). */
export function resolveLocKey(key: string, s: InventoryScope): Loc | null {
  if (key === 'hands') return L.hands(s.who);
  if (key === 'worn') return L.worn(s.who);
  if (key === 'inv') return L.inv(s.who);
  if (key === 'stock') return s.stock ? L.stock(s.stock.owner) : null;
  const [kind, arg] = key.split(':');
  if (kind === 'ground' && s.map) {
    const [x, y, z] = arg.split(',').map(Number);
    return L.ground(s.map, x, y, z);
  }
  if (kind === 'cargo') {
    const c = s.cargo?.[Number(arg)];
    return c ? L.cargo(c.part, c.vehicle) : null;
  }
  if (kind === 'in' || kind === 'mag' || kind === 'mod') {
    const host = findItem(arg, s);
    return host ? { kind, host } : null;
  }
  return null;
}

/** An item in scope by key, with where it is. */
export function findItemLoc(key: string, s: InventoryScope): { item: Item; loc: Loc } | null {
  for (const root of scopeLocs(s)) {
    const visit = (loc: Loc): { item: Item; loc: Loc } | null => {
      for (const it of itemsAt(loc)) {
        if (itemKey(it) === key) return { item: it, loc };
        const r = visit(L.in(it)) ?? visit(L.mag(it)) ?? visit(L.mod(it));
        if (r) return r;
      }
      return null;
    };
    const r = visit(root);
    if (r) return r;
  }
  return null;
}
function findItem(key: string, s: InventoryScope): Item | null {
  return findItemLoc(key, s)?.item ?? null;
}

// ------------------------------------------------------------------ the view

export interface Fill {
  /** ml (or rounds for magazines, charges for tools) used / available */
  used: number;
  max: number;
  unit: 'ml' | 'rounds' | 'charges' | 'items';
}

export interface ItemNode {
  key: string;
  item: Item;
  /** Where it is (moves.ts), and the same as a string. */
  loc: Loc;
  locKey: string;
  typeId: string;
  name: string;
  /** Stack size (1 for a single item). */
  count: number;
  /** Whole stack including contents, g / ml. */
  weight: number;
  volume: number;
  category: string;
  /** Ammo / battery / liquid amount. */
  charges?: { cur: number; max: number; label?: string };
  /** 0..1, undefined when undamaged items don't show a bar. */
  condition?: number;
  /** "W" wielded, "E" worn, "rotten", "old", "sealed"… */
  badges: string[];
  /** Body parts it covers (clothes). */
  covers?: BodyPartId[];
  /** A container / holster / bandolier / magazine: its inside, as a place with a fill bar. */
  inside?: { key: string; loc: Loc; fill: Fill; items: ItemNode[]; label: string };
  /** A gun/tool's magazine slot. */
  magazine?: { key: string; loc: Loc; item: ItemNode | null };
}

export interface WornView {
  node: ItemNode;
  layer: Layer;
  /** Carrying volume this item adds (BN storage) and its share of what's carried now. */
  storage?: { capacity: number; used: number };
}

export interface BodyPartView {
  id: BodyPartId;
  name: string;
  encumbrance: number;
  warmth: number;
  /** Worn items covering it, innermost first. */
  worn: ItemNode[];
}

export interface PlaceView {
  key: string;
  loc: Loc;
  /** "under you", "north", "the locker", "trunk". */
  label: string;
  /** Storage furniture / cargo capacity, ml (null: unlimited). */
  fill: Fill | null;
  items: ItemNode[];
}

export interface InventoryView {
  hands: { key: string; item: ItemNode | null };
  worn: WornView[];
  bodyParts: BodyPartView[];
  /** The carried inventory, grouped by item category in BN's category order. */
  carried: { key: string; groups: { category: string; items: ItemNode[] }[] };
  nearby: PlaceView[];
  totals: {
    /** carried inventory volume / capacity (worn storage), ml */
    volume: [number, number];
    /** everything carried (worn + wielded + inventory) / capacity, g; over 4x capacity you can't pick up more */
    weight: [number, number];
    maxWeight: number;
  };
}

const DIRS: Record<string, string> = {
  '0,0': 'under you', '0,-1': 'north', '1,-1': 'northeast', '1,0': 'east', '1,1': 'southeast',
  '0,1': 'south', '-1,1': 'southwest', '-1,0': 'west', '-1,-1': 'northwest',
};

function categoryName(it: Item): string {
  const cat = it.data.misc?.item_category?.[it.def.category];
  return cddaText(cat?.name_header) || cddaText(cat?.name) || it.def.category || 'other';
}
function categoryRank(it: Item): number {
  return (it.data.misc?.item_category?.[it.def.category]?.sort_rank as number | undefined) ?? 0;
}

/** Fill of an item's inside, in the unit that fits it. */
export function fillOf(it: Item): Fill | null {
  if (it.isMagazine() || it.isBandolier()) return { used: it.ammoRemaining(), max: it.ammoCapacity(), unit: 'rounds' };
  if (it.isContainer()) {
    let used = 0;
    for (const c of it.contents) used += c.volume();
    return { used, max: it.containerCapacity(), unit: 'ml' };
  }
  if (it.isHolster()) return { used: it.contents.length, max: it.def.holster!.multi, unit: 'items' };
  return null;
}

/** The view of one item and what's inside it. */
export function itemNode(it: Item, loc: Loc, scope?: InventoryScope): ItemNode {
  const badges: string[] = [];
  if (loc.kind === 'hands') badges.push('W');
  if (loc.kind === 'worn') badges.push('E');
  if (it.goesBad() && it.rotten()) badges.push('rotten');
  else if (it.goesBad() && it.goingBad()) badges.push('old');
  if (it.def.container_data?.unseals_into && it.hasContents()) badges.push('sealed');
  if (it.active) badges.push('active');
  const cap = it.ammoCapacity();
  const n: ItemNode = {
    key: itemKey(it), item: it, loc, locKey: locKey(loc, scope), typeId: it.typeId, name: it.name(), count: it.count(),
    weight: it.weight(), volume: it.volume(), category: categoryName(it), badges,
    condition: it.damage > 0 && !it.countByCharges ? Math.max(0, 1 - it.damage / 4000) : undefined,
    covers: it.isArmor() ? ALL_PARTS.filter((bp) => covers(it, bp)) : undefined,
  };
  if (cap > 0 && (it.isGun() || it.isTool() || it.isMagazine() || it.isBandolier())) n.charges = { cur: it.ammoRemaining(), max: cap, label: it.ammoData() ? cddaText(it.ammoData()!.name) : undefined };
  const fill = fillOf(it);
  if (fill || it.hasContents()) {
    const inLoc = L.in(it);
    n.inside = { key: locKey(inLoc, scope), loc: inLoc, fill: fill ?? { used: it.contents.length, max: it.contents.length, unit: 'items' }, items: it.contents.map((c) => itemNode(c, inLoc, scope)), label: it.baseName() };
  }
  if (it.takesMagazines() && !it.isMagazine()) {
    const magLoc = L.mag(it);
    n.magazine = { key: locKey(magLoc, scope), loc: magLoc, item: it.magazine ? itemNode(it.magazine, magLoc, scope) : null };
  }
  return n;
}

/** Everything within reach, structured for the inventory screens. */
export function inventoryView(s: InventoryScope): InventoryView {
  const who = s.who, inv = who.inv;
  const hands = L.hands(who);
  const wornLoc = L.worn(who);
  const cap = inv.volumeCapacity(), carriedVol = inv.volumeCarried();
  const worn: WornView[] = inv.worn.map((w) => {
    const v: WornView = { node: itemNode(w, wornLoc, s), layer: itemLayer(w) };
    const st = w.def.storage ?? 0;
    if (st > 0) v.storage = { capacity: st, used: cap > 0 ? Math.round((st * Math.min(carriedVol, cap)) / cap) : 0 };
    return v;
  });
  const bodyParts: BodyPartView[] = ALL_PARTS.map((bp) => ({
    id: bp, name: BODY_PARTS[bp].name, encumbrance: inv.encumbrance(bp), warmth: inv.warmth(bp),
    worn: worn.filter((w) => covers(w.node.item, bp)).map((w) => w.node),
  }));
  const invLoc = L.inv(who);
  const groups = new Map<string, { rank: number; items: ItemNode[] }>();
  for (const it of inv.items) {
    const c = categoryName(it);
    if (!groups.has(c)) groups.set(c, { rank: categoryRank(it), items: [] });
    groups.get(c)!.items.push(itemNode(it, invLoc, s));
  }
  const nearby: PlaceView[] = [];
  const at = originOf(s);
  if (s.map && at) {
    const r = s.reach ?? 1;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const loc = L.ground(s.map, at.x + dx, at.y + dy, at.z);
        const items = itemsAt(loc);
        const f = s.map.furnAt?.(at.x + dx, at.y + dy, at.z);
        const storage = f && typeof f.max_volume === 'number' && f.max_volume > 0 ? f.max_volume : null;
        if (!items.length && !storage) continue;
        const dir = DIRS[`${dx},${dy}`] ?? `${dx},${dy}`;
        const label = f && f.id !== 'f_null' ? `${locName(loc).replace(/^the /, '')} (${dir})` : dir;
        nearby.push({ key: locKey(loc, s), loc, label, fill: storage ? { used: items.reduce((a, i) => a + i.volume(), 0), max: storage, unit: 'ml' } : null, items: items.map((i) => itemNode(i, loc, s)) });
      }
  }
  for (const c of s.cargo ?? []) {
    const loc = L.cargo(c.part, c.vehicle);
    nearby.push({ key: locKey(loc, s), loc, label: c.label, fill: { used: c.part.items.reduce((a, i) => a + i.volume(), 0), max: c.part.def.size ?? 0, unit: 'ml' }, items: c.part.items.map((i) => itemNode(i, loc, s)) });
  }
  if (s.stock) {
    const loc = L.stock(s.stock.owner);
    nearby.push({ key: 'stock', loc, label: `${s.stock.owner.name}'s goods`, fill: null, items: s.stock.owner.stock.map((i) => itemNode(i, loc, s)) });
  }
  return {
    hands: { key: locKey(hands, s), item: inv.wielded ? itemNode(inv.wielded, hands, s) : null },
    worn,
    bodyParts,
    carried: { key: locKey(invLoc, s), groups: [...groups].sort((a, b) => a[1].rank - b[1].rank || a[0].localeCompare(b[0])).map(([category, g]) => ({ category, items: g.items })) },
    nearby,
    totals: { volume: [carriedVol, cap], weight: [inv.weightCarried(), inv.weightCapacity()], maxWeight: inv.weightCapacity() * 4 },
  };
}

// ------------------------------------------------------------------ "can I?" and actions

/** ui2's DropVerdict shape: what dropping `count` of an item on a place would do. */
export type Verdict =
  | { kind: 'ok'; count: number; moves: number }
  | { kind: 'partial'; count: number; moves: number; reason: string }
  | { kind: 'reject'; reason: string; code?: WhyNot }
  | { kind: 'noop' };

/**
 * Would moving `count` (default: all) of `it` from `from` to `to` work for `who`? A dry run of
 * the real move: the same rules, the same reasons. Cheap enough for every drag hover.
 */
export function verdict(who: Character, it: Item, from: Loc, to: Loc, count?: number): Verdict {
  const n = count ?? it.count();
  const r: MoveResult = canMove(it, from, to, { actor: who, count: n, partial: true });
  if (!r.ok) return r.code === 'same_place' ? { kind: 'noop' } : { kind: 'reject', reason: r.msg, code: r.code };
  if (r.moved < n) {
    const why = canMove(it, from, to, { actor: who, count: n });
    return { kind: 'partial', count: r.moved, moves: r.moves, reason: why.msg };
  }
  return { kind: 'ok', count: r.moved, moves: r.moves };
}

export interface ItemAction {
  id: 'wield' | 'unwield' | 'wear' | 'takeoff' | 'eat' | 'drink' | 'activate' | 'read' | 'reload' | 'unload' | 'drop' | 'pickup' | 'open';
  label: string;
  /** BN moves (100 = 1 s of game time); the UI shows it as time. */
  moves: number;
  /** Why it can't be done now (the action stays visible, greyed). */
  disabled?: string;
  primary?: boolean;
  /** Run it. Returns the Inventory action result. */
  run(): { ok: boolean; msg: string };
}

/**
 * The actions for an item where it is, in BN's order, the obvious one marked primary (what
 * double-click does). Uses the same rules as the actions themselves for the disabled reasons.
 */
export function itemActions(who: Character, it: Item, loc: Loc): ItemAction[] {
  const inv = who.inv;
  const out: ItemAction[] = [];
  const onMe = carriedAs(who, it) !== null;
  const food = inv.comestibleIn(it);
  const ground = inv.groundHere();
  const why = (to: Loc | null) => {
    if (!to) return 'There is nowhere to put it.';
    const r = canMove(it, loc, to, { actor: who });
    return r.ok ? undefined : r.msg;
  };
  const cost = (to: Loc | null) => (to ? canMove(it, loc, to, { actor: who }).moves : 0);
  if (food) {
    const drink = food.isLiquid();
    const r = drink ? 100 : 100 + Math.min(900, Math.floor(food.unitVolume() / 5) * 10);
    out.push({ id: drink ? 'drink' : 'eat', label: drink ? 'Drink' : 'Eat', moves: r, primary: true, run: () => inv.consume(it, loc) });
  }
  if (it.isArmor() && loc.kind !== 'worn') {
    const d = why(L.worn(who));
    out.push({ id: 'wear', label: 'Wear', moves: cost(L.worn(who)) || inv.wearCost(it), disabled: d, primary: !food && !d, run: () => inv.wear(it, loc) });
  }
  if (loc.kind === 'worn') {
    // taking off always finds a place (inventory, hands, else the ground): only body-bound items refuse
    const d = it.hasFlag('INTEGRATED') ? `You can't take off your ${it.name()}; it's part of you.` : it.hasFlag('NO_TAKEOFF') ? "You can't take that item off." : undefined;
    out.push({ id: 'takeoff', label: 'Take off', moves: 250, disabled: d, primary: !food, run: () => inv.takeOff(it) });
  }
  if (loc.kind === 'hands') out.push({ id: 'unwield', label: 'Put away', moves: cost(L.inv(who)), disabled: why(L.inv(who)), run: () => inv.unwield() });
  else {
    // wielding puts away (or drops) what's in your hands first, so only the item's own rules apply
    const w = inv.canWield(it);
    const d = w.ok ? (inv.wielded ? undefined : why(L.hands(who))) : w.reason;
    out.push({ id: 'wield', label: 'Wield', moves: inv.wielded ? 100 + Math.min(200, Math.floor(it.volume() / 20)) : cost(L.hands(who)), disabled: d, primary: !food && !it.isArmor() && !it.hasContents(), run: () => inv.wield(it, loc) });
  }
  const acts = useActions(it.def);
  if (acts.length) out.push({ id: 'activate', label: cddaText(acts[0].menu_text) || 'Activate', moves: 100, run: () => inv.use(it, undefined, 0, loc) });
  if (it.isBook()) out.push({ id: 'read', label: 'Read', moves: 0, run: () => ({ ok: false, msg: 'Reading is started from the read menu.' }) });
  if (it.isGun() || it.isMagazine() || it.takesMagazines() || it.hasIntegralMagazine() || it.isBandolier())
    out.push({ id: 'reload', label: 'Reload', moves: 100, disabled: it.ammoRemaining() >= it.ammoCapacity() && !it.takesMagazines() ? `The ${it.baseName()} is already fully loaded!` : undefined, run: () => inv.reload(it) });
  if (it.hasContents() || it.magazine || (it.ammoRemaining() > 0 && (it.hasIntegralMagazine() || it.isMagazine()))) {
    const probe = unloadItem(it, ground ? [L.inv(who), ground] : [L.inv(who)], { actor: who, dryRun: true, quiet: true });
    out.push({ id: 'unload', label: it.isContainer() ? 'Empty' : 'Unload', moves: probe.moves, disabled: probe.ok || probe.liquids.length ? undefined : probe.msg, run: () => inv.unload(it) });
  }
  if (loc.kind === 'ground' || loc.kind === 'cargo' || loc.kind === 'stock') {
    const d = why(L.inv(who));
    out.push({ id: 'pickup', label: 'Pick up', moves: cost(L.inv(who)) || 100, disabled: d, primary: !out.some((a) => a.primary) && !d, run: () => inv.pickUp(it, loc) });
  } else if (onMe) out.push({ id: 'drop', label: 'Drop', moves: cost(ground), disabled: why(ground), run: () => inv.drop(it, ground) });
  return out;
}

/** Re-find where an item is now (after other moves), within the scope. */
export function whereIs(it: Item, s: InventoryScope): Loc | null {
  return locate(it, scopeLocs(s));
}

/** Is the item still where a view said it was? (stale screens re-read the view when not) */
export function stillAt(node: ItemNode): boolean {
  return isAt(node.item, node.loc);
}
