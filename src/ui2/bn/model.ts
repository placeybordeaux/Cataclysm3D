// The real ui2 InventoryModel over the BN item model (docs/INVENTORY_MODEL.md "For the UI").
// No DOM: the screens (src/ui2/bn/screen.ts) render it, the tests drive it directly.
//
// Locations are inventory_view.ts locKeys ("hands", "worn", "inv", "in:<key>", "mag:<key>",
// "ground:x,y,z", "cargo:<n>") plus "worn:<bodypart>" for the paper doll's slots (the worn
// items covering that part; dropping there means Wear).
//
// Identical items that aren't one BN stack (three cans of beans are three items) are shown
// as one ItemView with count 3; its id is the first item's key and moving n of it moves n
// items, one move each. A count_by_charges stack (ammo, food, liquids) is one item whose
// count is its charges. Every change goes through moves.ts (moveItem / the Inventory
// actions), so what the UI does is exactly what the conservation tests prove safe.

import { freshnessText } from '../../game/freshness';
import { ACTION_SCALE } from '../../core/time';
import type { BodyPartId } from '../../game/bodyparts';
import { ALL_PARTS, BODY_PARTS } from '../../game/bodyparts';
import type { Character } from '../../game/character';
import { covers, itemLayer, useActions } from '../../game/inventory';
import {
  inventoryView, itemActions, itemKey, itemNode, locKey, resolveLocKey, scopeLocs, verdict,
  type InventoryScope, type InventoryView, type ItemAction, type PlaceView, type Verdict,
} from '../../game/inventory_view';
import type { Item } from '../../game/item';
import { carriedAs, isAt, itemsAt, L, moveItem, transaction, type Loc, type MoveResult } from '../../game/moves';
import { cddaText } from '../../game/units';
import { takeOrder } from '../../game/loot';
import { hotbarChoice } from '../../game/hotbar_choice';
import { reloadHintsFor, seenLine, takesLine } from '../../game/reloadhelp';
import type { DropVerdict } from '../logic/dnd';
import { fmtVolume, type Badge, type ItemStat, type ItemView } from '../logic/items';
import type { MenuItem } from '../menu';
import type { Capacity, InventoryModel, MoveOutcome } from '../model';

/** Side effects the model needs from whoever shows it (all optional for tests). */
export interface BnHooks {
  notify?(text: string, tone?: 'good' | 'bad' | 'warn' | 'info'): void;
  /** The liquid menu for `liquid` sitting at `from` (unload / pour out of a container). */
  liquid?(liquid: Item, from: Loc, source: Item | null): void;
  /** Expand / open a container's contents. */
  openContainer?(loc: string, item: ItemView): void;
  /** Examine: the full item info. */
  examine?(it: Item): void;
  bindHotbar?(slot: number, item: ItemView): void;
  /** "Drop some…" / "Move how many…". */
  askCount?(item: ItemView, verb: string): Promise<number | null>;
  /** Other systems' item actions (gunmods), already as menu entries. */
  extraActions?(it: Item, loc: Loc): MenuItem[];
  /** Run an action that takes `moves` BN moves: now (paused) or after a progress bar. */
  perform?(label: string, moves: number, fn: () => void): void;
  /**
   * An item action that starts a timed activity (read, disassemble, continue a craft) just ran.
   * The screens close so the work actually runs — under the inventory's pause it sat frozen.
   */
  activityStarted?(): void;
}

interface Entry {
  view: ItemView;
  /** The item(s) the view stands for: one charges stack, or n identical items. */
  items: Item[];
  loc: Loc;
  locKey: string;
}

/** What "Take all" did: what came along, what stayed and why. */
export interface TakeAllResult {
  taken: { name: string; count: number }[];
  left: { name: string; count: number; reason: string }[];
}

const PART_SLOTS: BodyPartId[] = ALL_PARTS;

/** Item actions that are a moment's handling (timed by perform), not an activity of their own. */
const QUICK = new Set(['wield', 'unwield', 'wear', 'takeoff', 'eat', 'drink', 'reload', 'unload', 'drop', 'pickup', 'activate']);

/** BN move cost → real seconds (100 moves = one turn; ACTION_SCALE turns per real second). */
export function movesToSeconds(moves: number): number {
  return moves / 100 / ACTION_SCALE;
}

/** "ENTRY TOOLS" → "Entry tools", unknown ids "TOOLS_ENTRY" → "Tools entry". */
export function humanCategory(it: Item): string {
  const cat = it.data.misc?.item_category?.[it.def.category];
  const raw = cddaText(cat?.name) || cddaText(cat?.name_header) || it.def.category || 'other';
  const special: Record<string, string> = { 'OTHER TOOLS': 'Tools', 'CHEMICAL STUFF': 'Chemicals', 'OTHER': 'Other' };
  if (special[raw]) return special[raw];
  const s = raw.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function categoryRank(it: Item): number {
  return (it.data.misc?.item_category?.[it.def.category]?.sort_rank as number | undefined) ?? 0;
}

/** Can these be shown as one stack? (separate identical items, nothing inside) */
function groupable(a: Item, b: Item): boolean {
  if (a.countByCharges || b.countByCharges || a.typeId !== b.typeId) return false;
  if (!a.hasContents() && !b.hasContents() && !a.magazine && !b.magazine) return a.stacksWith(b);
  // Twenty-five sealed rations in a cupboard read as one line: containers group when they're
  // identical down to what they hold (the saved form says exactly that).
  return JSON.stringify(a.toJSON()) === JSON.stringify(b.toJSON());
}

export class BnInventoryModel implements InventoryModel {
  private entries = new Map<string, Entry>();
  private byLoc = new Map<string, ItemView[]>();
  private listeners = new Set<() => void>();
  private sig = '';
  private checkCache = new Map<string, DropVerdict>();
  view!: InventoryView;
  /** Shift-click target for carried items: the loot panel's source ("ground:…", "cargo:0"). */
  lootTarget: string | null = null;

  constructor(private scopeFn: () => InventoryScope, public hooks: BnHooks = {}) {
    this.rebuild();
  }

  get scope(): InventoryScope {
    return this.scopeFn();
  }
  get who(): Character {
    return this.scope.who;
  }

  // ------------------------------------------------------------------ building the views

  /** Re-read the world. Fires onChange when anything visible differs (or always with `force`). */
  refresh(force = false): void {
    const before = this.sig;
    this.rebuild();
    if (force || this.sig !== before) this.emit();
  }

  private emit(): void {
    for (const f of [...this.listeners]) f();
  }

  private rebuild(): void {
    const s = this.scope;
    this.view = inventoryView(s);
    this.entries.clear();
    this.byLoc.clear();
    this.checkCache.clear();
    const sig: string[] = [];
    for (const root of scopeLocs(s)) this.index(root, s, sig);
    // The doll slots: worn items covering each part, innermost first.
    const worn = this.byLoc.get('worn') ?? [];
    for (const bp of PART_SLOTS) this.byLoc.set(`worn:${bp}`, worn.filter((v) => covers(this.entries.get(v.id)!.items[0], bp)));
    // The carried inventory reads best by category (BN's inventory order).
    const inv = this.byLoc.get('inv');
    if (inv) inv.sort((a, b) => {
      const ia = this.entries.get(a.id)!.items[0], ib = this.entries.get(b.id)!.items[0];
      return categoryRank(ia) - categoryRank(ib) || humanCategory(ia).localeCompare(humanCategory(ib)) || a.name.localeCompare(b.name);
    });
    const t = this.view.totals;
    sig.push(`T${t.volume.join('/')},${t.weight.join('/')}`);
    this.sig = sig.join('|');
  }

  private index(loc: Loc, s: InventoryScope, sig: string[]): void {
    const key = locKey(loc, s);
    const list = itemsAt(loc);
    const views: ItemView[] = [];
    const groups: Item[][] = [];
    for (const it of list) {
      const g = groups.find((gr) => groupable(gr[0], it));
      if (g) g.push(it);
      else groups.push([it]);
    }
    for (const g of groups) {
      const v = this.toView(g, loc, s);
      this.entries.set(v.id, { view: v, items: g, loc, locKey: key });
      views.push(v);
      sig.push(`${key}>${g.map(itemKey).join(',')}:${v.count}:${v.charges?.cur ?? ''}:${v.condition ?? ''}`);
      for (const it of g) {
        if (it.hasContents() || it.isContainer() || it.isHolster() || it.isBandolier() || it.isMagazine()) this.index(L.in(it), s, sig);
        if (it.takesMagazines() && !it.isMagazine()) this.index(L.mag(it), s, sig);
      }
    }
    this.byLoc.set(key, views);
  }

  private toView(g: Item[], loc: Loc, s: InventoryScope): ItemView {
    const it = g[0];
    const node = itemNode(it, loc, s);
    const count = it.countByCharges ? it.charges : g.length;
    const badges: Badge[] = [];
    for (const b of node.badges) {
      if (b === 'W') badges.push({ text: 'W', tone: 'accent', title: 'Wielded' });
      else if (b === 'E') badges.push({ text: 'E', tone: 'info', title: 'Worn' });
      else if (b === 'rotten') badges.push({ text: '!', tone: 'bad', title: 'Rotten' });
      else if (b === 'old') badges.push({ text: '!', tone: 'warn', title: 'Going bad' });
      else if (b === 'sealed') badges.push({ text: '▪', tone: 'info', title: 'Sealed' });
      else if (b === 'active') badges.push({ text: '*', tone: 'good', title: 'Active (on)' });
    }
    if (it.isLiquid()) badges.push({ text: '~', tone: 'info', title: 'Liquid: needs a container' });
    const inside = node.inside;
    const v: ItemView = {
      id: itemKey(it),
      typeId: it.typeId,
      name: g.length > 1 ? it.name(g.length) : it.countByCharges ? it.baseName(Math.max(1, count)) : it.name(),
      count,
      stackable: it.countByCharges || g.length > 1,
      // per unit, so ItemView's totals (unit × count) are the stack's
      weight: it.countByCharges ? it.weight() / Math.max(1, it.charges) : it.weight(),
      volume: it.countByCharges ? it.volume() / Math.max(1, it.charges) : it.volume(),
      category: humanCategory(it),
      condition: node.condition,
      charges: node.charges ?? (inside && inside.fill.unit === 'ml' && inside.items.some((n) => n.item.isLiquid())
        ? { cur: inside.fill.used, max: inside.fill.max, label: inside.items[0].item.baseName() } : undefined),
      badges,
      description: cddaText(it.def.description) || undefined,
      note: freshnessText(it) ?? undefined,
      takes: this.takes(it),
      icon: { typeId: it.typeId, looksLike: it.def.looks_like, symbol: it.def.symbol, color: it.def.color },
      covers: node.covers,
      stats: this.stats(it),
    };
    if (inside && inside.fill.unit === 'ml') v.capacity = { volume: inside.fill.max, weight: Infinity };
    if (inside?.items.length) v.contents = inside.items.map((n) => ({ id: n.key, typeId: n.typeId, name: n.name, count: n.count, stackable: false, weight: n.weight / Math.max(1, n.count), volume: n.volume / Math.max(1, n.count) }));
    return v;
  }

  /** "Takes: a light battery or …" plus where you last saw one, for anything that reloads. */
  private takes(it: Item): string | undefined {
    const t = takesLine(it);
    if (!t) return undefined;
    const s = seenLine(it, reloadHintsFor(this.who));
    return s ? `${t} ${s}` : t;
  }

  private stats(it: Item): ItemStat[] {
    const out: ItemStat[] = [];
    const d = it.def;
    if (it.isArmor()) {
      const bp = ALL_PARTS.find((p) => covers(it, p));
      if (bp) out.push({ label: 'Encumbrance', value: this.who.inv.itemEncumbrance(it, bp), better: 'lower' });
      const portion = d.armor?.find((p) => p.covers.length);
      if (portion) out.push({ label: 'Coverage', value: portion.coverage, unit: '%', better: 'higher' });
      if (d.warmth) out.push({ label: 'Warmth', value: d.warmth as number, better: 'higher' });
      if (d.storage) out.push({ label: 'Storage', value: (d.storage as number) / 1000, unit: ' L', digits: 2, better: 'higher' });
    }
    const md = d.melee_damage ?? {};
    if (!it.isArmor() || md.bash || md.cut || md.stab) {
      if (md.bash) out.push({ label: 'Bash', value: md.bash, better: 'higher' });
      if (md.cut) out.push({ label: 'Cut', value: md.cut, better: 'higher' });
      if (md.stab) out.push({ label: 'Pierce', value: md.stab, better: 'higher' });
      if (md.bash || md.cut || md.stab) out.push({ label: 'To-hit', value: d.to_hit ?? 0, better: 'higher' });
    }
    if (it.isComestible()) {
      if (d.calories) out.push({ label: 'Calories', value: d.calories });
      if (d.quench) out.push({ label: 'Quench', value: d.quench });
    }
    return out;
  }

  // ------------------------------------------------------------------ lookups

  entry(id: string): Entry | null {
    return this.entries.get(id) ?? null;
  }
  /** The first real item of a view. */
  itemOf(id: string): Item | null {
    return this.entries.get(id)?.items[0] ?? null;
  }
  locOf(id: string): string | null {
    return this.entries.get(id)?.locKey ?? null;
  }
  /** Every view in scope (flat), with its location key. */
  *all(): Generator<{ view: ItemView; loc: string; item: Item }> {
    for (const e of this.entries.values()) yield { view: e.view, loc: e.locKey, item: e.items[0] };
  }
  /** The view of a real item, if it's in scope. */
  viewOfItem(it: Item): { view: ItemView; loc: string } | null {
    for (const e of this.entries.values()) if (e.items.includes(it)) return { view: e.view, loc: e.locKey };
    return null;
  }

  /** The item a location key is inside ("in:" / magazine well), or null for hands, worn, ground… */
  hostOf(key: string): Item | null {
    const l = this.resolve(key);
    return l && (l.kind === 'in' || l.kind === 'mag') ? l.host : null;
  }

  private resolve(key: string): Loc | null {
    if (key.startsWith('worn:')) return L.worn(this.who);
    return resolveLocKey(key, this.scope);
  }

  /** Nearby sources (tiles, furniture, cargo) with labels and fill, from the view. */
  nearby(): PlaceView[] {
    return this.view.nearby;
  }

  // ------------------------------------------------------------------ InventoryModel

  contents(loc: string): ItemView[] {
    const v = this.byLoc.get(loc);
    if (v) return v;
    // A container that exists but was empty when indexed has no entry list; one that's gone throws
    // (containerView shows "(gone)" and its panel closes).
    if (!this.resolve(loc)) throw new Error(`no such place: ${loc}`);
    return [];
  }

  name(loc: string): string {
    if (loc === 'hands') return 'Hands';
    if (loc === 'worn') return 'Worn';
    if (loc === 'inv') return 'Inventory';
    if (loc.startsWith('worn:')) return BODY_PARTS[loc.slice(5) as BodyPartId]?.name ?? loc;
    const p = this.view.nearby.find((n) => n.key === loc);
    if (p) return p.label.charAt(0).toUpperCase() + p.label.slice(1);
    const l = this.resolve(loc);
    if (!l) throw new Error(`no such place: ${loc}`);
    if (l.kind === 'in' || l.kind === 'mag' || l.kind === 'mod') return l.host.baseName();
    if (l.kind === 'ground') return this.groundWords(l.x, l.y, l.z).replace(/^On the /, '').replace(/^./, (c) => c.toUpperCase());
    return loc;
  }

  capacity(loc: string): Capacity | null {
    const t = this.view.totals;
    if (loc === 'inv') return { volume: t.volume, weight: [t.weight[0], t.weight[1]] };
    const p = this.view.nearby.find((n) => n.key === loc);
    if (p) return p.fill ? { volume: [p.fill.used, p.fill.max], weight: [0, Infinity] } : null;
    const l = this.resolve(loc);
    if (l?.kind === 'in' && l.host.isContainer()) {
      const used = l.host.contents.reduce((a, c) => a + c.volume(), 0);
      return { volume: [used, l.host.containerCapacity()], weight: [l.host.contents.reduce((a, c) => a + c.weight(), 0), Infinity] };
    }
    return null;
  }

  insideOf(item: ItemView): string | null {
    const it = this.itemOf(item.id);
    if (!it) return null;
    if (it.isContainer() || it.isHolster() || it.isBandolier() || it.isMagazine() || it.hasContents()) return `in:${itemKey(it)}`;
    return null;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  where(loc: string): string {
    if (loc === 'hands') return 'In your hands';
    if (loc === 'worn' || loc.startsWith('worn:')) return 'Worn';
    if (loc === 'inv') return 'In your inventory';
    const p = this.view.nearby.find((n) => n.key === loc);
    if (p) return p.key.startsWith('cargo:') ? `In the ${p.label}` : /\(/.test(p.label) ? `In the ${p.label}` : p.label === 'under you' ? 'On the ground under you' : `On the ground (${p.label})`;
    const l = this.resolve(loc);
    if (l?.kind === 'ground') return this.groundWords(l.x, l.y, l.z);
    if (l && (l.kind === 'in' || l.kind === 'mag')) {
      const on = carriedAs(this.who, l.host);
      return `In ${on ? 'your' : 'the'} ${l.host.baseName()}${l.kind === 'mag' ? ' (magazine well)' : ''}`;
    }
    return loc;
  }

  /** "On the ground under you" / "On the ground (north)" for a tile nobody listed. */
  private groundWords(x: number, y: number, z: number): string {
    const at = this.scope.at ?? { x, y, z };
    const dx = Math.sign(x - at.x), dy = Math.sign(y - at.y);
    if (!dx && !dy && z === at.z) return 'On the ground under you';
    const dirs: Record<string, string> = { '0,-1': 'north', '1,-1': 'northeast', '1,0': 'east', '1,1': 'southeast', '0,1': 'south', '-1,1': 'southwest', '-1,0': 'west', '-1,-1': 'northwest' };
    return `On the ground (${dirs[`${dx},${dy}`] ?? 'nearby'})`;
  }

  /** Is `loc` on the survivor (hands, worn, inventory, or inside something carried)? */
  onBody(loc: string): boolean {
    if (loc === 'hands' || loc === 'worn' || loc === 'inv' || loc.startsWith('worn:')) return true;
    const l = this.resolve(loc);
    return !!l && (l.kind === 'in' || l.kind === 'mag' || l.kind === 'mod') && carriedAs(this.who, l.host) !== null;
  }

  // ------------------------------------------------------------------ drops

  /** A liquid (loose, i.e. being poured) — dropping it on the ground spills it. */
  isLiquid(id: string): boolean {
    return !!this.itemOf(id)?.isLiquid();
  }

  /** Text for a confirm before the move, or null: spilling a liquid on the ground. */
  confirmFor(id: string, to: string, count: number): string | null {
    const it = this.itemOf(id);
    if (!it || !it.isLiquid()) return null;
    const l = this.resolve(to);
    if (l?.kind !== 'ground' && l?.kind !== 'cargo') return null;
    return `Pour ${count} ${it.baseName(count)} (${fmtVolume(it.unitVolume() * count)}) out on the ground? It can't be picked up again.`;
  }

  /** The ghost label: what a drop there does ("Wear", "Pour into jug", "Drop"). */
  dropLabel(id: string, to: string): string {
    const it = this.itemOf(id);
    const l = this.resolve(to);
    if (!it || !l) return 'Move';
    if (to === 'hands') return this.who.inv.wielded ? `Wield (${this.who.inv.wielded.baseName()} goes away)` : 'Wield';
    if (l.kind === 'worn') return 'Wear';
    if (it.isLiquid()) return l.kind === 'in' ? `Pour into ${l.host.baseName()}` : l.kind === 'ground' || l.kind === 'cargo' ? 'Spill' : 'Move';
    if (this.pourSource(it, l)) return `Pour into ${(l as { host: Item }).host.baseName()}`;
    if (l.kind === 'inv') return this.onBody(this.locOf(id) ?? '') ? 'Put in inventory' : 'Pick up';
    if (l.kind === 'ground') return this.onBody(this.locOf(id) ?? '') ? 'Drop' : 'Move here';
    if (l.kind === 'cargo') return 'Store';
    if (l.kind === 'in') return l.host.isHolster() ? `Holster in ${l.host.baseName()}` : `Put in ${l.host.baseName()}`;
    if (l.kind === 'mag') return `Insert into ${l.host.baseName()}`;
    return 'Move';
  }

  /**
   * Dragging a bottle of water onto a jug means "pour it in", not "put the bottle in the
   * jug". Returns the liquid to pour when that reading applies.
   */
  private pourSource(it: Item, to: Loc): Item | null {
    if (to.kind !== 'in' || !to.host.isContainer() || it.isLiquid()) return null;
    const liquid = it.contents.find((c) => c.isLiquid());
    if (!liquid || it.contents.length !== 1) return null;
    return canMoveDry(liquid, L.in(it), to, this.who) ? liquid : null;
  }

  check(itemId: string, to: string, count: number): DropVerdict {
    const ck = `${itemId}>${to}>${count}`;
    const hit = this.checkCache.get(ck);
    if (hit) return hit;
    const v = this.checkUncached(itemId, to, count);
    this.checkCache.set(ck, v);
    return v;
  }

  private checkUncached(itemId: string, to: string, count: number): DropVerdict {
    const e = this.entries.get(itemId);
    if (!e) return { kind: 'reject', reason: 'That item is no longer there.' };
    const it = e.items[0];
    const dest = this.resolve(to);
    if (!dest) return { kind: 'reject', reason: 'That place is out of reach now.' };
    if (e.locKey === to || (to.startsWith('worn:') && e.loc.kind === 'worn')) return { kind: 'noop' };
    if (to === 'inv' && it.isLiquid()) return { kind: 'reject', reason: 'Liquids need a container: drop it on a bottle, jug or canteen.' };
    if (to === 'hands' && this.who.inv.wielded && this.who.inv.wielded !== it) {
      const w = this.who.inv.canWield(it);
      if (!w.ok) return { kind: 'reject', reason: w.reason! };
      if (e.items.length > 1 && count > 1) return { kind: 'reject', reason: 'You can wield only one.' };
      const cur = this.viewOfItem(this.who.inv.wielded);
      return cur ? { kind: 'swap', count: 1, displaced: cur.view } : { kind: 'ok', count: 1 };
    }
    const pour = this.pourSource(it, dest);
    if (pour) return toDrop(verdict(this.who, pour, L.in(it), dest));
    if (e.items.length === 1 || count === 1) {
      if ((dest.kind === 'hands' || dest.kind === 'worn') && count > 1 && !it.countByCharges) return { kind: 'partial', count: 1, reason: `Only one at a time` };
      return toDrop(verdict(this.who, it, e.loc, dest, it.countByCharges ? count : undefined));
    }
    // n separate items: try them in a transaction that is always rolled back.
    let n = 0;
    let why = '';
    transaction(() => {
      for (const one of e.items.slice(0, count)) {
        const r = moveItem(one, e.loc, dest, { actor: this.who, quiet: true });
        if (!r.ok) {
          why = r.code === 'same_place' ? '' : r.msg;
          break;
        }
        n++;
        if (dest.kind === 'hands' || dest.kind === 'worn') break;
      }
      return false;
    });
    if (n === 0) return why ? { kind: 'reject', reason: why } : { kind: 'noop' };
    if (n < count) return { kind: 'partial', count: n, reason: why || `Only ${n} of ${count}` };
    return { kind: 'ok', count };
  }

  /** Real seconds a move would take (for the progress bar). */
  moveCost(itemId: string, to: string, count: number): number {
    const e = this.entries.get(itemId);
    const dest = this.resolve(to);
    if (!e || !dest) return 0;
    const v = verdict(this.who, e.items[0], e.loc, dest, e.items[0].countByCharges ? count : undefined);
    const per = 'moves' in v ? v.moves : 100;
    return per * (e.items[0].countByCharges ? 1 : count);
  }

  move(itemId: string, to: string, count: number): MoveOutcome {
    const e = this.entries.get(itemId);
    if (!e) return { ok: false, reason: 'That item is no longer there.' };
    const dest = this.resolve(to);
    if (!dest) return { ok: false, reason: 'That place is out of reach now.' };
    const who = this.who;
    const it = e.items[0];
    let out: MoveOutcome;
    try {
      if (dest.kind === 'hands') out = asOutcome(who.inv.wield(it, e.loc));
      else if (dest.kind === 'worn') out = asOutcome(who.inv.wear(it, e.loc));
      else {
        const pour = this.pourSource(it, dest);
        if (pour) out = asOutcome(moveItem(pour, L.in(it), dest, { actor: who, partial: true }));
        else if (it.countByCharges || e.items.length === 1) out = asOutcome(moveItem(it, e.loc, dest, { actor: who, partial: true, count: it.countByCharges ? Math.min(count, it.charges) : undefined }));
        else {
          let n = 0;
          let last: MoveResult | null = null;
          for (const one of e.items.slice(0, count)) {
            last = moveItem(one, e.loc, dest, { actor: who, quiet: n > 0 });
            if (!last.ok) break;
            n++;
          }
          out = n === 0 ? { ok: false, reason: last?.msg ?? 'Nothing moved.' } : n < count ? { ok: true } : { ok: true };
          if (n > 0 && n < count && last) this.hooks.notify?.(`Moved ${n} of ${count}: ${last.msg}`, 'warn');
        }
      }
    } finally {
      this.refresh(true);
    }
    return out;
  }

  /** BN has no in-place split (a stack re-merges where it lands): Ctrl-click moves some. */
  split(itemId: string, count: number): void {
    const loc = this.locOf(itemId);
    const e = this.entries.get(itemId);
    if (!loc || !e) return;
    const to = this.quickMoveTarget(e.view, loc);
    if (to) this.move(itemId, to, count);
  }

  quickMoveTarget(item: ItemView, loc: string): string | null {
    if (this.onBody(loc)) {
      if (this.lootTarget && this.resolve(this.lootTarget)) return this.lootTarget;
      const g = this.who.inv.groundHere();
      return g ? locKey(g, this.scope) : null;
    }
    // Nearby → carried. A liquid can't go loose into the inventory: into a carried container.
    const it = this.itemOf(item.id);
    if (it?.isLiquid()) {
      for (const c of this.who.inv.allItems()) if (c.isContainer() && canMoveDry(it, this.entries.get(item.id)!.loc, L.in(c), this.who)) return `in:${itemKey(c)}`;
      return null;
    }
    return 'inv';
  }

  compareWith(item: ItemView, loc: string): ItemView | null {
    const it = this.itemOf(item.id);
    if (!it || loc === 'hands' || loc === 'worn' || loc.startsWith('worn:')) return null;
    if (it.isArmor()) {
      const layer = itemLayer(it);
      const same = this.who.inv.worn.find((w) => itemLayer(w) === layer && ALL_PARTS.some((bp) => covers(w, bp) && covers(it, bp)));
      return same ? this.viewOfItem(same)?.view ?? null : null;
    }
    if (it.isComestible() || it.isAmmo()) return null;
    const w = this.who.inv.wielded;
    return w && (it.def.melee_damage && Object.keys(it.def.melee_damage).length) ? this.viewOfItem(w)?.view ?? null : null;
  }

  use(item: ItemView, loc: string): void {
    const p = this.primary(item, loc);
    if (p && 'action' in p && p.action) void p.action();
  }

  /** The double-click action as a menu entry, or null. */
  primary(item: ItemView, loc: string): MenuItem | null {
    return this.actions(item, loc).find((a) => 'label' in a && a.primary && !a.disabled && 'action' in a && !!a.action) ?? null;
  }

  /**
   * A hotbar press: the quick-draw rule (src/game/hotbar_choice.ts), not the double-click one —
   * a longbow is wielded, not worn. Returns false when the rule has no answer (caller falls back
   * to primary()). A disabled choice reports its reason instead of doing something else.
   */
  hotbarUse(item: ItemView): boolean {
    const e = this.entries.get(item.id);
    if (!e) return false;
    const it = e.items[0];
    const a = hotbarChoice(this.who, it, e.loc);
    if (!a) return false;
    if (a.disabled) {
      this.hooks.notify?.(a.disabled, 'bad');
      return true;
    }
    this.runAction(a, it)();
    return true;
  }

  /** Run a BN item action (itemActions) through perform() so it takes its time. */
  private runAction(a: ItemAction, it: Item): () => void {
    return () => {
      const go = () => {
        const r = a.run();
        if (!r.ok && r.msg) this.hooks.notify?.(r.msg, 'bad');
        this.refresh(true);
      };
      if (this.hooks.perform && a.moves > 0) this.hooks.perform(`${a.label}: ${it.baseName()}`, a.moves, go);
      else go();
    };
  }

  actions(item: ItemView, locStr: string): MenuItem[] {
    const e = this.entries.get(item.id);
    if (!e) return [{ label: 'That item is no longer there.', disabled: 'Moved or used up' }];
    const it = e.items[0];
    const loc = e.loc;
    const who = this.who;
    const out: MenuItem[] = [];
    const secs = (moves: number) => movesToSeconds(moves);
    const acts = itemActions(who, it, loc);
    const container = it.isContainer() || it.isHolster() || it.isBandolier();
    const liquidInside = it.contents.find((c) => c.isLiquid()) ?? null;
    let anyPrimary = acts.some((a) => a.primary && !a.disabled);
    if (container && it.hasContents() && !liquidInside && this.hooks.openContainer) {
      out.push({ label: 'Open', key: 'O', time: 0, primary: !anyPrimary || it.isArmor(), action: () => this.hooks.openContainer!(`in:${itemKey(it)}`, item) });
      anyPrimary = true;
    }
    for (const a of acts) {
      if (a.id === 'unload' && liquidInside) {
        out.push({ label: `Pour out / into…`, key: 'U', time: secs(a.moves), action: () => this.hooks.liquid?.(liquidInside, L.in(it), it) });
        continue;
      }
      if (a.id === 'unload') {
        out.push({
          label: a.label, key: 'U', time: secs(a.moves), disabled: a.disabled ?? false,
          action: () => {
            const go = () => {
              const r = who.inv.unload(it);
              if (!r.ok && r.msg && !r.liquids.length) this.hooks.notify?.(r.msg, 'bad');
              for (const l of r.liquids) this.hooks.liquid?.(l, L.in(it), it);
              this.refresh(true);
            };
            if (this.hooks.perform && a.moves > 0) this.hooks.perform(`Emptying the ${it.baseName()}`, a.moves, go);
            else go();
          },
        });
        continue;
      }
      if (a.id === 'activate') {
        const uas = useActions(it.def);
        if (uas.length > 1) {
          out.push({
            label: 'Use', key: 'A', time: secs(a.moves),
            submenu: uas.map((ua, i) => ({ label: cddaText(ua.menu_text) || ua.type.replace(/_/g, ' '), action: () => { const r = who.inv.use(it, undefined, i, loc); if (!r.ok && r.msg) this.hooks.notify?.(r.msg, 'bad'); this.refresh(true); } })),
          });
          continue;
        }
      }
      const keys: Record<string, string> = { eat: 'E', drink: 'E', wear: 'W', takeoff: 'T', wield: 'Z', unwield: 'Z', activate: 'A', reload: 'R', drop: 'D', pickup: 'G' };
      // Quick handling actions take real seconds here; the ones other systems add (reading,
      // disassembling, continuing a craft) start activities that warp game time themselves, so
      // they run at once and show their game time.
      const quick = QUICK.has(a.id);
      out.push({ label: a.label, key: keys[a.id], time: quick ? secs(a.moves) : a.moves / 100, primary: !!a.primary && !a.disabled, disabled: a.disabled ?? false, danger: false, note: a.note, noteTone: a.noteTone, action: quick ? this.runAction(a, it) : () => { const r = a.run(); if (!r.ok && r.msg) this.hooks.notify?.(r.msg, 'bad'); this.refresh(true); if (r.ok) this.hooks.activityStarted?.(); } });
    }
    // Hands: double-click puts it away.
    if (loc.kind === 'hands' && !out.some((m) => 'primary' in m && m.primary)) {
      const pa = out.find((m) => 'label' in m && m.label === 'Put away');
      if (pa && 'label' in pa && !pa.disabled) pa.primary = true;
    }
    // Put in ▸ carried containers that would take it.
    if (!it.isLiquid() && loc.kind !== 'worn') {
      const boxes = who.inv.allItems().filter((c) => c !== it && (c.isContainer() || c.isHolster()) && !(loc.kind === 'in' && loc.host === c) && canMoveDry(it, loc, L.in(c), who));
      if (boxes.length)
        out.push({
          label: 'Put in', key: 'P',
          submenu: boxes.map((c) => ({ label: c.name(), icon: { typeId: c.typeId, looksLike: c.def.looks_like, symbol: c.def.symbol, color: c.def.color }, action: () => void this.move(item.id, `in:${itemKey(c)}`, item.count) })),
        });
    }
    if (it.isLiquid()) {
      out.push({ label: 'Pour…', key: 'U', action: () => this.hooks.liquid?.(it, loc, loc.kind === 'in' ? loc.host : null) });
    }
    if (item.count > 1 && this.hooks.askCount) {
      const to = this.quickMoveTarget(item, locStr);
      if (to)
        out.push({
          label: this.onBody(locStr) ? 'Drop some…' : 'Take some…', key: 'S',
          action: async () => {
            const n = await this.hooks.askCount!(item, this.onBody(locStr) ? 'Drop' : 'Take');
            if (n) {
              const r = this.move(item.id, to, n);
              if (!r.ok) this.hooks.notify?.(r.reason, 'bad');
            }
          },
        });
    }
    if (this.onBody(locStr) && this.hooks.bindHotbar)
      out.push({ label: 'Bind to hotbar', key: 'B', submenu: Array.from({ length: 10 }, (_, i) => ({ label: `Slot ${(i + 1) % 10}`, key: String((i + 1) % 10), action: () => this.hooks.bindHotbar!(i, item) })) });
    const extra = this.hooks.extraActions?.(it, loc) ?? [];
    if (extra.length) out.push({ separator: true }, ...extra);
    if (this.hooks.examine) out.push({ separator: true }, { label: 'Examine', key: 'X', action: () => this.hooks.examine!(it) });
    return out;
  }

  // ------------------------------------------------------------------ looting

  /**
   * Take everything from a nearby source into the inventory (liquids into carried containers
   * where they fit). Smart: the most value per share of the room you have left goes first
   * (src/game/loot.ts takeOrder), and nothing is taken past your weight limit (you'd be
   * overburdened), so what stays is the heavy, bulky, cheap stuff — with why.
   */
  takeAll(source: string): TakeAllResult {
    return this.take([source]);
  }

  /**
   * The smart take over several places (the area loot window's "Take all", "Take all of this
   * type"): each item is its own moveItem, so conservation holds exactly as for a drag.
   */
  take(sources: string[], filter?: (it: Item) => boolean): TakeAllResult {
    const res: TakeAllResult = { taken: [], left: [] };
    const who = this.who;
    const inv = L.inv(who);
    const cands: { it: Item; from: Loc }[] = [];
    for (const key of sources) {
      const from = this.resolve(key);
      if (!from) {
        res.left.push({ name: 'everything there', count: 0, reason: 'That place is out of reach now.' });
        continue;
      }
      for (const it of itemsAt(from)) if (!filter || filter(it)) cands.push({ it, from });
    }
    // One line per kind of thing (and per reason it stayed): a cupboard of ten single jackets
    // listed "Left emergency jacket: no room" ten times, and "7 folded emergency blanket".
    // Names are pluralised for the totals at the end.
    const byName = new Map<string, Item>();
    const add = (list: { name: string; count: number; reason?: string }[], it: Item, count: number, reason?: string) => {
      const name = lootName(it, 1);
      byName.set(name, it);
      const x = list.find((e) => e.name === name && e.reason === reason);
      if (x) x.count += count;
      else list.push(reason === undefined ? { name, count } : { name, count, reason });
    };
    const room = () => ({ volume: who.inv.volumeCapacity() - who.inv.volumeCarried(), weight: who.inv.weightCapacity() - who.inv.weightCarried() });
    const fromOf = new Map(cands.map((c) => [c.it, c.from]));
    for (const it of takeOrder(cands.map((c) => c.it), room())) {
      const from = fromOf.get(it)!;
      if (!isAt(it, from)) continue;
      const n = it.count();
      if (it.isLiquid()) {
        let left = n;
        for (const c of who.inv.allItems()) {
          if (left <= 0 || !c.isContainer()) continue;
          const r = moveItem(it, from, L.in(c), { actor: who, partial: true, quiet: true });
          if (r.ok) left -= r.moved;
        }
        if (n - left > 0) add(res.taken, it, n - left);
        if (left > 0) add(res.left, it, left, 'no container for it');
        continue;
      }
      // Stay within the weight you can carry without slowing down: past it, "take all" would
      // quietly overburden you (BN lets you pick up to 4×: that stays a choice made by hand).
      const wLeft = room().weight;
      let count: number | undefined;
      if (it.weight() > wLeft) {
        const k = it.countByCharges && it.unitWeight() > 0 ? Math.floor(wLeft / it.unitWeight()) : 0;
        if (k <= 0) {
          add(res.left, it, n, wLeft <= 0 ? 'you are at your weight limit' : 'too heavy: would overburden you');
          continue;
        }
        count = k;
      }
      const r = moveItem(it, from, inv, { actor: who, partial: true, quiet: true, count });
      if (r.ok) {
        add(res.taken, it, r.moved);
        if (r.moved < n) add(res.left, it, n - r.moved, count !== undefined && r.moved === count ? 'too heavy: would overburden you' : shortReason(r.msg || 'no room'));
      } else add(res.left, it, n, shortReason(r.msg));
    }
    for (const e of [...res.taken, ...res.left]) if (byName.has(e.name)) e.name = lootName(byName.get(e.name)!, e.count);
    if (res.taken.length) who.msg(`You take ${res.taken.map((t) => (t.count > 1 ? `${t.count} ${t.name}` : t.name)).join(', ')}.`);
    this.refresh(true);
    return res;
  }

  /** BN moves a take would cost (100 per thing picked up, like BN's pickup), for the progress bar. */
  takeCost(sources: string[], filter?: (it: Item) => boolean): number {
    let n = 0;
    for (const key of sources) {
      const from = this.resolve(key);
      if (from) for (const it of itemsAt(from)) if (!filter || filter(it)) n++;
    }
    return n * 100;
  }
}

/** "There's no room in your inventory for the X." → "no room in your inventory". */
function shortReason(msg: string): string {
  if (/no room/i.test(msg)) return 'no room in your inventory';
  if (/too heavy/i.test(msg)) return 'too heavy';
  if (/liquid/i.test(msg)) return 'needs a container';
  return msg.replace(/\.$/, '');
}

/**
 * What a take report calls a thing: a bag of rations is "protein rations (small resealable
 * plastic bags)" — what you wanted first — not just the bags; anything else its own name.
 */
function lootName(it: Item, n: number): string {
  const inner = it.isContainer() && it.contents.length === 1 ? it.contents[0] : null;
  return inner ? `${inner.baseName(n)} (${it.baseName(n)})` : it.baseName(n);
}

function canMoveDry(it: Item, from: Loc, to: Loc, who: Character): boolean {
  const v = verdict(who, it, from, to);
  return v.kind === 'ok' || v.kind === 'partial';
}

function toDrop(v: Verdict): DropVerdict {
  if (v.kind === 'ok') return { kind: 'ok', count: v.count };
  if (v.kind === 'partial') return { kind: 'partial', count: v.count, reason: v.reason };
  if (v.kind === 'noop') return { kind: 'noop' };
  return { kind: 'reject', reason: v.reason };
}

function asOutcome(r: { ok: boolean; msg: string }): MoveOutcome {
  return r.ok ? { ok: true } : { ok: false, reason: r.msg || "It won't go there." };
}
