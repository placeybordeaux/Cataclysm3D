import type { ArmorPortion, ItemDef } from '../data/types';
import { applyHealActor, type HealActor } from './healing';
import type { Rng } from '../core/rng';
import { ALL_PARTS, BODY_PARTS, isBodyPart, MAIN_PARTS, type BodyPartId, type MainPartId } from './bodyparts';
import type { Character } from './character';
import { asArray, Item, type ItemJSON } from './item';
import { cddaText, toSeconds } from './units';
import { unwieldyWarning } from './combat';
import {
  bodyLocs, canMove, carriedAs, consumeItem, consumeNew, handlingCost, L, locate, moveItem, registerInventorySlots, spawnItem, transaction,
  unloadItem, type InvSlots, type Loc, type MoveResult,
} from './moves';

// A character's belongings on Cataclysm: Bright Nights' model (character.cpp, inventory.cpp,
// docs/BN_DATA_MODEL.md §4, docs/INVENTORY_MODEL.md):
//
//  - hands: the wielded item;
//  - worn: clothing, sorted innermost layer first. Worn items with `storage` (backpacks,
//    jeans, vests) don't hold anything themselves: together they give the carrying volume;
//  - items: the flat carried inventory. Its volume must fit that capacity; worn and wielded
//    items don't count toward it (they do toward weight).
//
// Containers (bottles, cans, bags), holsters, bandoliers and magazines hold their own things.
// The lists are read-only here: every change goes through src/game/moves.ts. The actions below
// (pick up, wield, wear, eat, reload...) are the BN actions built on those moves, returning
// {ok, msg, moves} with BN's wording; the message is also sent to the owner.

export interface ActionResult {
  ok: boolean;
  msg: string;
  /** BN moves the action takes (100 moves = 1 turn); long ones become activities. */
  moves: number;
  /** Machine-readable reason when !ok (see moves.ts WhyNot). */
  code?: string;
}

/** BN layer_level order, innermost first. */
export const LAYERS = ['PERSONAL', 'UNDERWEAR', 'REGULAR', 'WAIST', 'OUTER', 'BELTED', 'AURA'] as const;
export type Layer = (typeof LAYERS)[number];

/** Worn items per type (game_constants.h MAX_WORN_PER_TYPE). */
export const MAX_WORN_PER_TYPE = 2;

export interface InventoryJSON {
  wielded: ItemJSON | null;
  worn: ItemJSON[];
  /** carried inventory (absent in pre-BN saves: their pockets are migrated by src/save/items.ts) */
  items?: ItemJSON[];
}

/**
 * Tool-quality usages (tool_qualities.json `usages`: an AXE 1 tool can CHOP_TREE, a DIG 1
 * tool can MAKEMOUND...). Registered by the system that handles them (src/game/nature.ts),
 * so an item only becomes "activatable" for usages somebody implements.
 */
export const qualityUsages: { quality: string; level: number; type: string }[] = [];

/** Normalized use_action list: strings become { type }; then usages granted by qualities. */
export function useActions(def: ItemDef): { type: string; [k: string]: any }[] {
  const raw = def.use_action;
  const list = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  const out = list.map((u) => (typeof u === 'string' ? { type: u } : (u as { type: string })));
  if (qualityUsages.length && def.qualities?.length) {
    for (const [q, lvl] of def.qualities as [string, number][])
      for (const u of qualityUsages) if (u.quality === q && lvl >= u.level && !out.some((o) => o.type === u.type)) out.push({ type: u.type });
  }
  return out;
}

/** material ids of an item (["steel"] or [{type, portion}]). */
export function materialIds(def: ItemDef): string[] {
  return (def.material ?? []).map((m) => (typeof m === 'string' ? m : (m as { type: string }).type));
}

/** item::get_layer: the type's layer (from flags at load), else the flags. */
export function itemLayer(it: Item): Layer {
  const l = it.def.layer;
  if (l && (LAYERS as readonly string[]).includes(l)) return l as Layer;
  for (const [f, layer] of [['PERSONAL', 'PERSONAL'], ['SKINTIGHT', 'UNDERWEAR'], ['WAIST', 'WAIST'], ['OUTER', 'OUTER'], ['BELTED', 'BELTED'], ['AURA', 'AURA']] as const)
    if (it.hasFlag(f)) return layer;
  return 'REGULAR';
}

/** Parts an armor portion covers. */
function portionCovers(p: ArmorPortion): BodyPartId[] {
  return asArray(p.covers as string | string[] | undefined).filter(isBodyPart);
}

/** The item's armor portion for a body part (BN armor_portion_data; the last matching wins, like BN). */
export function armorPortion(it: Item, bp: BodyPartId): ArmorPortion | undefined {
  let out: ArmorPortion | undefined;
  for (const p of it.def.armor ?? []) if (portionCovers(p).includes(bp)) out = p;
  return out;
}

export function covers(it: Item, bp: BodyPartId): boolean {
  return armorPortion(it, bp) !== undefined;
}

/** item::is_non_rigid for armor: soft, or some portion's encumbrance grows with contents. */
function isNonRigidArmor(it: Item): boolean {
  if (!it.def.armor?.length) return false;
  return !it.def.rigid || it.def.armor.some((p) => p.encumbrance !== p.max_encumbrance);
}

/**
 * Power draw in W. BN's JSON gives a bare integer in **milliwatts** (item.cpp: "power_draw in
 * mW / 1000000 to give kJ (battery unit) per second"); strings like "1560 mW" also parse.
 * Reading the integer as watts drained a flashlight's battery ~1000× too fast.
 */
function powerDrawW(v: unknown): number {
  if (typeof v === 'number') return v * 0.001;
  if (typeof v !== 'string') return 0;
  const m = /^\s*([\d.]+)\s*(mW|W|kW)\s*$/.exec(v);
  if (!m) throw new Error(`Bad power_draw "${v}"`);
  return parseFloat(m[1]) * (m[2] === 'mW' ? 0.001 : m[2] === 'W' ? 1 : 1000);
}

export class Inventory {
  private readonly s: InvSlots;
  private activeAcc = new WeakMap<Item, number>();
  /**
   * use_action handlers owned by other systems, keyed by use_action type (e.g. crafting
   * registers 'firestarter', which needs the map). Consulted for types use() doesn't know.
   */
  readonly useHandlers = new Map<string, (it: Item, ua: { type: string; [k: string]: any }) => ActionResult>();
  /**
   * Hooks for body modifications (src/game/mutations.ts, bionics.ts): extra reasons an item
   * can't be worn (restricts_gear), extra encumbrance per part, flat natural armor, extra
   * tool-quality providers (bionic pseudo tools), checks/effects around consuming, and carrying
   * modifiers (mutation packmule_modifier / weight_capacity_modifier, bionic weight bonuses).
   */
  readonly wearChecks: ((it: Item) => string | null)[] = [];
  readonly extraEncumbrance: ((bp: BodyPartId) => number)[] = [];
  readonly naturalArmor: ((bp: BodyPartId, dtype: string) => number)[] = [];
  readonly qualityProviders: (() => Item[])[] = [];
  readonly consumeChecks: ((food: Item) => string | null)[] = [];
  readonly onConsume: ((portion: Item) => string | void)[] = [];
  readonly carryModifiers: (() => { volume?: number; weight?: number; weightBonus?: number })[] = [];

  constructor(readonly owner: Character) {
    const s: InvSlots = { wielded: null, worn: [], items: [], sortWorn: () => this.sortWorn() };
    this.s = s;
    registerInventorySlots(this, s);
  }

  /** The wielded item (change it with wield()/unwield() or moves.ts). */
  get wielded(): Item | null {
    return this.s.wielded;
  }
  /** Worn items, innermost layer first. */
  get worn(): readonly Item[] {
    return this.s.worn;
  }
  /** The carried inventory (BN `inv`): everything not worn or wielded. */
  get items(): readonly Item[] {
    return this.s.items;
  }

  private say(ok: boolean, msg: string, moves = 0, code?: string): ActionResult {
    if (msg) this.owner.msg(msg, ok ? undefined : 'c_light_red');
    return { ok, msg, moves, ...(code ? { code } : {}) };
  }
  /** A move's result as an action result (the move already messaged unless quiet). */
  private res(r: MoveResult, say = true): ActionResult {
    if (say && r.msg) this.owner.msg(r.msg, r.ok ? undefined : 'c_light_red');
    return { ok: r.ok, msg: r.msg, moves: r.moves, ...(r.code ? { code: r.code } : {}) };
  }

  // ------------------------------------------------------------ queries
  /** wielded + worn + carried (top-level items). */
  topLevel(): Item[] {
    return [...(this.s.wielded ? [this.s.wielded] : []), ...this.s.worn, ...this.s.items];
  }
  /** Every item on the character, including everything inside (and the top-level ones). */
  allItems(): Item[] {
    const out: Item[] = [];
    for (const t of this.topLevel()) for (const it of t.walk()) out.push(it);
    return out;
  }
  /** The carried inventory (not worn, not wielded). */
  carried(): readonly Item[] {
    return this.s.items;
  }
  /** Does the character have `it` anywhere (hands, worn, inventory, inside any of those)? */
  has(it: Item): boolean {
    return carriedAs(this.owner, it) !== null;
  }
  /** `from` as given (null = a new item), or where `it` is on you when omitted. */
  private source(it: Item, from: Loc | null | undefined): Loc | null | 'missing' {
    if (from !== undefined) return from;
    return this.locOf(it) ?? 'missing';
  }
  /** Where `it` sits directly (hands, worn, inventory, or inside one of the character's items). */
  locOf(it: Item): Loc | null {
    return locate(it, bodyLocs(this.owner));
  }
  /** The ground under the owner (set by the game for the player and NPCs). */
  groundHere(): Loc | null {
    return this.owner.groundLoc?.() ?? null;
  }

  /** Character::weight_carried: worn + inventory + wielded. */
  weightCarried(): number {
    let w = 0;
    for (const t of this.topLevel()) w += t.weight();
    return w;
  }
  /**
   * Character::weight_capacity: 13 kg + Str x 4 kg, x mutation modifiers, + CARRY_WEIGHT
   * enchantments, x every worn item's weight_capacity_modifier, + worn weight_capacity_bonus.
   */
  weightCapacity(): number {
    let w = (13000 + this.owner.str * 4000) * this.owner.mutationValue('weight_capacity_modifier');
    let bonus = 0;
    for (const m of this.carryModifiers) {
      const r = m();
      w *= r.weight ?? 1;
      bonus += r.weightBonus ?? 0;
    }
    w = this.owner.byEnchant(w, 'CARRY_WEIGHT');
    for (const it of this.s.worn) {
      w *= it.def.weight_capacity_modifier ?? 1;
      bonus += it.def.weight_capacity_bonus ?? 0;
    }
    return Math.max(0, w + bonus);
  }
  /** Character::volume_capacity: Σ worn storage x packmule_modifier + CARRY_STORAGE. */
  volumeCapacity(): number {
    let v = 0;
    for (const t of this.s.worn) v += t.def.storage ?? 0;
    v *= this.owner.mutationValue('packmule_modifier');
    for (const m of this.carryModifiers) v *= m().volume ?? 1;
    return Math.max(0, this.owner.byEnchant(v, 'CARRY_STORAGE'));
  }
  /** Character::volume_carried: the carried inventory only (worn and wielded don't count). */
  volumeCarried(): number {
    let v = 0;
    for (const t of this.s.items) v += t.volume();
    return v;
  }
  /** Would `it` fit in the inventory (volume) and stay within 4x weight capacity? */
  canCarry(it: Item): boolean {
    return this.volumeCarried() + it.volume() <= this.volumeCapacity() && this.weightCarried() + it.weight() <= this.weightCapacity() * 4;
  }
  /** Worn items covering a body part, outermost first (the order attacks meet them). */
  wornCovering(bp: BodyPartId): Item[] {
    return this.s.worn.filter((w) => covers(w, bp)).reverse();
  }

  // ------------------------------------------------------------ taking & placing
  /**
   * Put a newly created item (crafting output, a harvest, a gift) into the inventory. Returns
   * null when it went in, else the item back (still unplaced: the caller drops it). Never pass
   * an item that is somewhere already: move it with moveItem.
   */
  stashNew(it: Item): Item | null {
    return spawnItem(it, L.inv(this.owner), { actor: this.owner, quiet: true }).ok ? null : it;
  }
  /** A new item: inventory, else hands, else the ground under the owner. Returns where it went. */
  giveNew(it: Item): Loc | null {
    for (const to of [L.inv(this.owner), L.hands(this.owner), this.groundHere()]) {
      if (to && spawnItem(it, to, { actor: this.owner, quiet: true }).ok) return to;
    }
    return null;
  }

  /**
   * Pick up (BN pickup): into the inventory, or into your hands if it doesn't fit and they're
   * free. On failure nothing moves.
   */
  pickUp(it: Item, from: Loc, count?: number): ActionResult {
    const r = moveItem(it, from, L.inv(this.owner), { count, actor: this.owner, quiet: true });
    if (r.ok) return this.res({ ...r, msg: `You pick up: ${r.item && r.item !== it && it.countByCharges ? `${it.baseName(r.moved)} (${r.moved})` : r.item?.name() ?? it.name()}`, moves: 100 });
    if (r.code === 'no_room' && !this.s.wielded) {
      const w = moveItem(it, from, L.hands(this.owner), { count, actor: this.owner, quiet: true });
      if (w.ok) return this.res(w);
    }
    return this.res(r);
  }

  /** Drop an item you carry (anywhere on you) onto the ground under you, or `to`. */
  drop(it: Item, to: Loc | null = this.groundHere(), count?: number): ActionResult {
    const from = this.locOf(it);
    if (!from) return this.say(false, `You don't have that item.`, 0, 'stale');
    if (it.hasFlag('BIONIC_WEAPON') || it.hasFlag('INTEGRATED') || it.hasFlag('NO_DROP')) return this.say(false, `You cannot drop your ${it.name()}.`, 0, 'not_allowed');
    if (!to) return this.say(false, `There's nowhere to put your ${it.name()}.`, 0, 'no_room');
    return this.res(moveItem(it, from, to, { count, actor: this.owner, quiet: true }));
  }

  /** Character::can_wield. */
  canWield(it: Item): { ok: boolean; reason?: string } {
    const cur = this.s.wielded;
    if (cur && cur !== it && (cur.hasFlag('NO_UNWIELD') || cur.hasFlag('BIONIC_WEAPON'))) return { ok: false, reason: `You cannot unwield your ${cur.name()}.` };
    if (it.isLiquid()) return { ok: false, reason: "Can't wield spilt liquids." };
    if (this.owner.brokenArms() >= 2) return { ok: false, reason: 'You need at least one arm to even consider wielding something.' };
    if (this.owner.brokenArms() === 1 && (it.hasFlag('ALWAYS_TWOHAND') || it.weight() > this.owner.str * 250))
      return { ok: false, reason: it.hasFlag('ALWAYS_TWOHAND') ? `The ${it.name()} can't be wielded with only one arm.` : `You are too weak to wield ${it.name()} with only one arm.` };
    if ((it.hasFlag('ALWAYS_TWOHAND') || it.weight() > this.owner.str * 250) && this.s.worn.some((w) => w.hasFlag('RESTRICT_HANDS')))
      return { ok: false, reason: 'Something you are wearing hinders the use of both hands.' };
    return { ok: true };
  }

  /**
   * Wield `it` from `from` (default: wherever it is on you). The current weapon goes to your
   * inventory, or is dropped at your feet when it doesn't fit (BN dispose_item: store / drop).
   * All or nothing. `from` defaults to wherever `it` is on you; pass null for a new item.
   */
  wield(it: Item, from?: Loc | null): ActionResult {
    if (this.s.wielded === it) return this.say(false, `You're already wielding the ${it.name()}.`, 0, 'same_place');
    const src = this.source(it, from);
    if (src === 'missing') return this.say(false, `You don't have that item.`, 0, 'stale');
    const can = this.canWield(it);
    if (!can.ok) return this.say(false, can.reason!, 0, 'cant_wield');
    let dropped: Item | null = null;
    let out: MoveResult | null = null;
    const r = transaction(() => {
      const old = this.s.wielded;
      if (old) {
        let away = moveItem(old, L.hands(this.owner), L.inv(this.owner), { actor: this.owner, quiet: true });
        const g = this.groundHere();
        if (!away.ok && away.code === 'no_room' && g) {
          away = moveItem(old, L.hands(this.owner), g, { actor: this.owner, quiet: true });
          if (away.ok) dropped = old;
        }
        if (!away.ok) return (out = away);
      }
      return (out = moveItem(it, src, L.hands(this.owner), { actor: this.owner, quiet: true }));
    });
    void r;
    const res = out as MoveResult | null;
    if (!res || !res.ok) return this.res(res ?? { ok: false, msg: `You can't wield the ${it.name()}.`, moves: 0, moved: 0 });
    const d = dropped as Item | null;
    const msg = d ? `You drop your ${d.name()} and wield your ${it.name()}.` : res.msg;
    const result = this.say(true, msg, res.moves);
    // Real time leaves no turn to reconsider a bad weapon, so say so up front.
    const warn = unwieldyWarning(this.owner, it);
    if (warn) this.owner.msg(warn, 'c_yellow');
    return result;
  }

  /** Put the wielded item into the inventory. */
  unwield(): ActionResult {
    const w = this.s.wielded;
    if (!w) return this.say(false, 'You are already empty-handed.', 0, 'same_place');
    const r = moveItem(w, L.hands(this.owner), L.inv(this.owner), { actor: this.owner, quiet: true });
    if (!r.ok && r.code === 'no_room') return this.say(false, `You have no space to store your ${w.name()}.`, 0, r.code);
    return this.res(r);
  }

  // ------------------------------------------------------------ clothing
  /** Character::can_wear (the parts that apply without power armor). */
  canWear(it: Item): { ok: boolean; reason?: string } {
    if (!it.isArmor()) return { ok: false, reason: `Putting on a ${it.name()} would be tricky.` };
    if (this.s.worn.includes(it)) return { ok: false, reason: 'You are already wearing that.' };
    for (const check of this.wearChecks) {
      const reason = check(it);
      if (reason) return { ok: false, reason };
    }
    if (it.hasFlag('RESTRICT_HANDS') && this.owner.brokenArms() >= 1) return { ok: false, reason: "You don't have enough arms to wear that." };
    const w = this.s.wielded;
    if (it.hasFlag('RESTRICT_HANDS') && (this.s.worn.some((x) => x.hasFlag('RESTRICT_HANDS')) || (w && (w.hasFlag('ALWAYS_TWOHAND') || w.weight() > this.owner.str * 250))))
      return { ok: false, reason: "You don't have a hand free to wear that." };
    for (const x of this.s.worn) if (x.hasFlag('ONLY_ONE') && x.typeId === it.typeId) return { ok: false, reason: `Can't wear more than one ${it.name()}!` };
    if (this.s.worn.filter((x) => x.typeId === it.typeId).length >= MAX_WORN_PER_TYPE)
      return { ok: false, reason: `Can't wear ${MAX_WORN_PER_TYPE + 1} or more ${it.baseName(MAX_WORN_PER_TYPE + 1)} at once.` };
    const exempt = (f: string[]) => f.some((x) => it.hasFlag(x));
    const shoeLike = (x: Item, bp: BodyPartId) => covers(x, bp) && !['BELTED', 'PERSONAL', 'AURA', 'SEMITANGIBLE', 'SKINTIGHT'].some((f) => x.hasFlag(f)) && !(x.hasFlag('OVERSIZE') && x.hasFlag('OUTER'));
    for (const foot of ['foot_l', 'foot_r'] as const) {
      if (covers(it, foot) && this.s.worn.some((x) => shoeLike(x, foot)) && !(it.hasFlag('OVERSIZE') && it.hasFlag('OUTER')) && !exempt(['SKINTIGHT', 'BELTED', 'PERSONAL', 'AURA', 'SEMITANGIBLE']))
        return { ok: false, reason: "You're already wearing footwear!" };
    }
    const helmet = (x: Item) => covers(x, 'head') && !['HELMET_COMPAT', 'SKINTIGHT', 'PERSONAL', 'AURA', 'SEMITANGIBLE', 'OVERSIZE'].some((f) => x.hasFlag(f));
    if (helmet(it) && this.s.worn.some(helmet)) return { ok: false, reason: "You can't wear that with other headgear!" };
    return { ok: true };
  }

  /** Put on `it` from `from` (default: wherever it is on you; null: a new item). */
  wear(it: Item, from?: Loc | null): ActionResult {
    const src = this.source(it, from);
    if (src === 'missing') return this.say(false, `You don't have that item.`, 0, 'stale');
    return this.res(moveItem(it, src, L.worn(this.owner), { actor: this.owner, quiet: true }));
  }

  /**
   * Take off: into the inventory if it still fits once its storage is gone, else into your
   * hands if they're free, else dropped (BN takeoff: "No room in inventory for your X. Drop it?").
   */
  takeOff(it: Item): ActionResult {
    if (!this.s.worn.includes(it)) return this.say(false, 'You are not wearing that item.', 0, 'stale');
    const from = L.worn(this.owner);
    const tries: Loc[] = [L.inv(this.owner), L.hands(this.owner)];
    const g = this.groundHere();
    if (g) tries.push(g);
    let last: MoveResult | null = null;
    for (const to of tries) {
      if (to.kind === 'hands' && this.s.wielded) continue;
      const r = moveItem(it, from, to, { actor: this.owner, quiet: true });
      if (r.ok) return this.say(true, to.kind === 'ground' ? `You take off your ${it.name()} and drop it.` : `You take off your ${it.name()}.`, 250);
      last = r;
      if (r.code !== 'no_room' && r.code !== 'too_heavy' && r.code !== 'hands_full' && r.code !== 'cant_wield') break;
    }
    return this.res(last ?? { ok: false, msg: `You can't take off your ${it.name()}.`, moves: 0, moved: 0 });
  }

  /** Character::item_wear_cost: handling cost scaled by layer and encumbrance. */
  wearCost(it: Item): number {
    let mv = handlingCost(this.owner, it);
    const l = itemLayer(it);
    if (l === 'UNDERWEAR') mv *= 1.5;
    else if (l === 'WAIST' || l === 'OUTER') mv /= 1.5;
    else if (l === 'BELTED') mv /= 2;
    const parts = ALL_PARTS.filter((bp) => covers(it, bp));
    const avg = parts.length ? parts.reduce((s, bp) => s + this.itemEncumbrance(it, bp), 0) / parts.length : 0;
    mv *= Math.max(avg / 10, 1);
    return Math.round(mv);
  }

  private sortWorn(): void {
    const idx = (w: Item) => LAYERS.indexOf(itemLayer(w));
    // stable: items on one layer keep the order they were put on in
    this.s.worn.sort((a, b) => idx(a) - idx(b));
  }

  /**
   * item::get_encumber: a portion's encumbrance; a worn soft storage item (backpack) also grows
   * with the carried volume (its share of the storage), and soft items with what they hold.
   */
  itemEncumbrance(it: Item, bp: BodyPartId): number {
    const p = armorPortion(it, bp);
    if (!p) return 0;
    let contents = 0;
    for (const c of it.contents) contents += c.volume();
    const nonRigid = isNonRigidArmor(it);
    if (nonRigid && this.s.worn.includes(it) && p.max_encumbrance !== 0) {
      let rigid = 0, soft = 0;
      for (const w of this.s.worn) (isNonRigidArmor(w) ? (soft += w.def.storage ?? 0) : (rigid += w.def.storage ?? 0));
      const carried = this.volumeCarried();
      if (carried > rigid && soft > 0) contents += Math.floor(((it.def.storage ?? 0) * (carried - rigid)) / soft);
    }
    let enc = p.encumbrance;
    if (nonRigid) {
      if (p.max_encumbrance === 0) enc += Math.floor(contents / 500);
      else {
        const cap = (it.def.storage ?? 0) + it.containerCapacity() + (it.def.holster ? it.def.holster.max_volume * it.def.holster.multi : 0);
        if (cap > 0) enc += Math.floor(((p.max_encumbrance - p.encumbrance) * contents) / cap);
      }
    }
    if (it.hasFlag('FIT') && it.hasFlag('VARSIZE')) enc = Math.max(Math.floor(enc / 2), enc - 10);
    return enc;
  }

  /** Total encumbrance on a part: items + BN layering penalty (Character::item_encumb). */
  encumbrance(bp: BodyPartId): number {
    let armor = 0;
    let penalty = 0;
    const perLayer = LAYERS.map(() => ({ max: 0, total: 0 }));
    let highest = 0;
    for (const w of this.s.worn) {
      if (!covers(w, bp)) continue;
      const layer = LAYERS.indexOf(itemLayer(w));
      let e = this.itemEncumbrance(w, bp);
      let layering = Math.min(10, Math.max(2, e));
      if (w.hasFlag('SEMITANGIBLE')) (e = 0), (layering = 0);
      if (w.hasFlag('COMPACT') || (w.hasFlag('FIT') && e <= 10)) layering = 0;
      highest = Math.max(highest, layer);
      // layer_details::layer: every piece but the most encumbering one counts
      for (let l = layer; l <= highest; l++) {
        if (!layering) continue;
        const d = perLayer[l];
        const before = d.total;
        if (layering > d.max) (d.total += d.max), (d.max = layering);
        else d.total += layering;
        penalty += d.total - before;
      }
      armor += e;
    }
    let total = Math.max(0, armor) + penalty;
    for (const f of this.extraEncumbrance) total += f(bp);
    return total;
  }

  warmth(bp: BodyPartId): number {
    let w = 0;
    for (const it of this.s.worn) if (covers(it, bp)) w += it.def.warmth ?? 0;
    return w;
  }

  /**
   * Resistance of one worn item vs a damage type — BN item.cpp phys_resist: the average of
   * the materials' `<type>_resist`, times effective thickness (material_thickness minus the
   * damage level, at least 1); stab is 0.8 × cut. BN has no per-portion materials, so the
   * body part only matters for coverage (handled by the caller).
   */
  armorResist(it: Item, _bp: BodyPartId, dtype: string, _rng?: Rng): number {
    if (dtype === 'stab') return Math.trunc(0.8 * this.armorResist(it, _bp, 'cut'));
    if (dtype !== 'bash' && dtype !== 'cut' && dtype !== 'bullet') return 0;
    const mats = this.owner.data.misc?.material ?? {};
    const ids = materialIds(it.def);
    if (!ids.length) return 0;
    let resist = 0;
    for (const m of ids) resist += Number(mats[m]?.[`${dtype}_resist`] ?? 0);
    resist /= ids.length;
    const thickness = Number(it.def.material_thickness ?? 1);
    const effThickness = Math.max(1, thickness - Math.max(0, it.damageLevel()));
    return Math.round(resist * effThickness);
  }

  /**
   * Character::absorb_hit: each worn item covering the part, outermost first, gets a
   * coverage roll; if it's hit it removes max(resist - penetration, 0) * armor_mult.
   */
  absorbHit(
    bp: BodyPartId,
    units: { type: string; amount: number; armor_penetration?: number; armor_multiplier?: number }[],
    rng: Rng,
  ): { type: string; amount: number }[] {
    const out = units.map((u) => ({ ...u, armor_penetration: u.armor_penetration ?? 0 }));
    for (const it of this.wornCovering(bp)) {
      const coverage = armorPortion(it, bp)?.coverage ?? 0;
      if (rng.int(0, 99) >= coverage) continue;
      for (const u of out) {
        if (u.amount <= 0) continue;
        const res = this.armorResist(it, bp, u.type, rng);
        const mitigation = Math.max(res - u.armor_penetration, 0) * (u.armor_multiplier ?? 1);
        u.armor_penetration = Math.max(0, u.armor_penetration - res);
        u.amount = Math.max(0, u.amount - mitigation);
      }
    }
    // Mutation/bionic armor is under the clothes (passive_absorb_hit after worn armor).
    for (const f of this.naturalArmor) {
      for (const u of out) {
        if (u.amount <= 0) continue;
        const res = f(bp, u.type);
        if (res <= 0) continue;
        u.amount = Math.max(0, u.amount - Math.max(res - u.armor_penetration, 0) * (u.armor_multiplier ?? 1));
        u.armor_penetration = Math.max(0, u.armor_penetration - res);
      }
    }
    return out.map((u) => ({ type: u.type, amount: u.amount }));
  }

  // ------------------------------------------------------------ tools & crafting queries
  /** Carried items plus pseudo tools from qualityProviders (bionic toolsets). */
  private qualityItems(): Item[] {
    const out = this.allItems();
    for (const f of this.qualityProviders) out.push(...f());
    return out;
  }
  maxQuality(id: string): number {
    let best = 0;
    for (const it of this.qualityItems()) best = Math.max(best, it.qualityLevel(id));
    return best;
  }
  hasQuality(id: string, level = 1): boolean {
    return this.maxQuality(id) >= level;
  }
  findByQuality(id: string, level = 1): Item[] {
    return this.qualityItems().filter((it) => it.qualityLevel(id) >= level);
  }
  /** Items of a type usable as material: the wielded item, the inventory and what's inside them (not worn clothes). */
  private usable(): { item: Item; loc: Loc }[] {
    const out: { item: Item; loc: Loc }[] = [];
    const visit = (loc: Loc, list: readonly Item[]) => {
      for (const it of list) {
        out.push({ item: it, loc });
        if (it.contents.length) visit(L.in(it), it.contents);
      }
    };
    visit(L.hands(this.owner), this.s.wielded ? [this.s.wielded] : []);
    visit(L.inv(this.owner), this.s.items);
    // things inside worn holsters/bandoliers are carried too
    for (const w of this.s.worn) if (w.contents.length) visit(L.in(w), w.contents);
    return out;
  }
  /** Count by type: charges for stackables, items otherwise (not worn clothes). */
  countOf(typeId: string): number {
    let n = 0;
    for (const { item } of this.usable()) if (item.typeId === typeId) n += item.count();
    return n;
  }
  hasAmount(typeId: string, n: number): boolean {
    return this.countOf(typeId) >= n;
  }
  /** Use up n of a type (Character::use_amount): consumed, returned for inspection. */
  useAmount(typeId: string, n: number): Item[] {
    if (!this.hasAmount(typeId, n)) throw new Error(`useAmount: need ${n} ${typeId}, have ${this.countOf(typeId)}`);
    const out: Item[] = [];
    for (const { item, loc } of this.usable()) {
      if (n <= 0) break;
      if (item.typeId !== typeId || item.hasContents()) continue;
      const take = Math.min(n, item.count());
      const piece = consumeItem(item, loc, item.countByCharges ? take : undefined);
      if (piece) {
        out.push(piece);
        n -= take;
      }
    }
    return out;
  }

  // ------------------------------------------------------------ eating & drinking
  /** The comestible to consume from `it` (itself, or the contents of a container). */
  comestibleIn(it: Item): Item | null {
    if (it.isComestible()) return it;
    for (const c of it.contents) if (c.isComestible()) return c;
    return null;
  }

  /**
   * Eat/drink one portion (consumption.cpp, simplified): kcal & water go to the stomach,
   * "fun" becomes morale, stim/fatigue apply, consume_drug use_actions add effects. `it` may be
   * the food or a container holding it; `from` is where `it` is (default: found on you).
   */
  consume(it: Item, from?: Loc | null): ActionResult {
    const food = this.comestibleIn(it);
    const c = this.owner;
    if (!food) return this.say(false, "That doesn't look edible.", 0, 'not_allowed');
    const src = this.source(it, from);
    if (src === 'missing') return this.say(false, `You don't have that item.`, 0, 'stale');
    // null: `it` is new (a crafted drink handed straight to your mouth)
    const foodLoc: Loc | null = food === it ? src : L.in(it);
    for (const check of this.consumeChecks) {
      const reason = check(food);
      if (reason) return this.say(false, reason, 0, 'not_allowed');
    }
    const liquid = food.isLiquid();
    const def = food.def;
    const unitVol = food.countByCharges ? Math.ceil(food.unitVolume()) : food.volume();
    const water = (def.quench ?? 0) * 5;
    const solids = Math.max(0, unitVol - (liquid ? unitVol : water));
    if (def.comestible_type !== 'MED' && c.stomachContains() + solids + (liquid ? unitVol : 0) > 2500 && c.hungerState() === 'Engorged')
      return this.say(false, `You're full already and will be forcing yourself to ${liquid ? 'drink' : 'eat'}.`, 0, 'not_allowed');
    const portion = foodLoc ? consumeItem(food, foodLoc, food.countByCharges ? 1 : undefined) : consumeNew(food, food.countByCharges ? 1 : undefined);
    if (!portion) return this.say(false, `You don't have that item.`, 0, 'stale');
    // NO_INGEST (mutagens, injected drugs) bypasses the stomach.
    // BN: a drink quenches by its `quench` only (a 250 ml mutagen doesn't count as 250 ml of water)
    if (!portion.hasFlag('NO_INGEST')) c.ingest(def.calories ?? 0, solids, water);
    if (def.stim) c.stim += def.stim;
    const fatigue = (def.fatigue_mod ?? def.sleepiness_mod) as number | undefined;
    if (fatigue) c.sleepiness -= fatigue;
    // fun_for: rot sours taste; morale lasts 2 h, decaying after 1 h.
    let fun = def.fun ?? 0;
    const rel = portion.relativeRot();
    if (rel > 1) {
      const rottedness = Math.min(1, Math.max(0.1, 2 * rel - 2));
      fun -= rottedness * 10;
      fun = fun > 0 ? fun * (1 - rottedness) : fun * (1 + rottedness);
    }
    fun = Math.trunc(fun);
    if (fun < 0) c.morale.add('morale_food_bad', fun, fun * 6, 7200, 3600, false, portion.typeId);
    else if (fun > 0) c.morale.add('morale_food_good', fun, fun * 3, 7200, 3600, false, portion.typeId);
    let msg = '';
    const extra: string[] = [];
    for (const f of this.onConsume) {
      const m = f(portion);
      if (m) extra.push(m);
    }
    for (const ua of useActions(def)) {
      if (ua.type === 'consume_drug') {
        for (const e of (ua.effects ?? []) as { id: string; duration: number | string; bp?: string; intensity?: number }[])
          c.addEffect(e.id, toSeconds(e.duration), { bp: e.bp && isBodyPart(e.bp) ? e.bp : undefined, intensity: e.intensity });
        if (ua.activation_message) msg = cddaText(ua.activation_message).replace('%s', portion.name());
      }
    }
    if (!msg) msg = `You ${liquid ? 'drink' : 'eat'} your ${portion.name()}${portion.rotten() ? ' (rotten)' : ''}.`;
    if (extra.length) msg = [msg, ...extra].join('  ');
    const moves = liquid ? 100 : Math.max(100, Math.min(1000, Math.floor(unitVol / 5) * 10));
    return this.say(true, msg, moves);
  }

  // ------------------------------------------------------------ using items
  /**
   * Activate/use an item: heal (bandages, disinfectant), transform (flashlight on/off),
   * consume_drug (pills). `bp` targets medical items; otherwise the worst wound is chosen.
   */
  use(it: Item, bp?: BodyPartId, actionIndex = 0, from?: Loc | null): ActionResult {
    const src = this.source(it, from);
    return this.useFrom(it, bp, actionIndex, src === 'missing' ? null : src);
  }
  private useFrom(it: Item, bp: BodyPartId | undefined, actionIndex: number, from: Loc | null): ActionResult {
    const acts = useActions(it.def);
    if (acts.length === 0) return this.say(false, `You can't do anything interesting with your ${it.name()}.`);
    // Items with several use_actions (a refillable lighter lights up *or* starts a fire): the
    // UI asks which; the first is the default.
    const ua = acts[Math.min(actionIndex, acts.length - 1)];
    switch (ua.type) {
      case 'heal':
        return this.useHeal(it, ua, bp, from);
      case 'transform':
        return this.useTransform(it, ua);
      case 'consume_drug':
        return this.consume(it, from);
      default: {
        for (const a of [ua, ...acts]) {
          const h = this.useHandlers.get(a.type);
          if (h) return h(it, a);
        }
        return this.say(false, `You can't do anything interesting with your ${it.name()}.`);
      }
    }
  }

  private useTransform(it: Item, ua: { [k: string]: any }): ActionResult {
    const need = (ua.need_charges as number | undefined) ?? 0;
    if (need > 0 && it.ammoRemaining() < need) return this.say(false, cddaText(ua.need_charges_msg) || `Your ${it.name()} has no power.`);
    const target = ua.target as string;
    if (!this.owner.data.items[target]) throw new Error(`transform target ${target} missing for ${it.typeId}`);
    it.convert(target);
    it.active = !!(ua.active || it.def.power_draw || it.def.turns_per_charge || it.hasFlag('SPAWN_ACTIVE'));
    return this.say(true, cddaText(ua.msg) || `You activate your ${it.name()}.`, (ua.moves as number | undefined) ?? 0);
  }

  /** heal_actor (src/game/healing.ts): treat yourself, then use up the item. */
  private useHeal(it: Item, ua: { [k: string]: any }, bp: BodyPartId | undefined, from: Loc | null): ActionResult {
    const r = applyHealActor(this.owner, it.name(), ua as HealActor, bp);
    if (!r.ok) return this.say(false, r.msg);
    this.useUp(it, from);
    return this.say(true, r.msg, r.moves);
  }

  /** Use up one charge or the whole item after a single-use action. */
  private useUp(it: Item, from: Loc | null): void {
    if (!it.countByCharges && (it.def.max_charges ?? 0) > 0 && it.charges > 1 && !it.hasFlag('SINGLE_USE')) {
      it.ammoConsume(1);
      return;
    }
    if (from) consumeItem(it, from, it.countByCharges ? 1 : undefined);
  }

  // ------------------------------------------------------------ reloading
  /** Character::item_reload_cost */
  reloadCost(target: Item, ammo: Item, qty: number): number {
    let mv = Math.min(200, Math.floor(ammo.isMagazine() ? ammo.volume() / 20 : (ammo.unitVolume() * qty) / 20));
    if (ammo.hasFlag('MAG_BULKY')) mv *= 1.5;
    const perRound = target.isGun() ? (target.def.reload ?? 100) : target.isMagazine() ? (target.def.magazine?.reload_time ?? 100) : 100;
    const cost = perRound * (ammo.isMagazine() ? 1 : qty);
    const sk = target.isGun() ? (target.def.skill ?? 'gun') : 'gun';
    mv += cost / (1 + Math.min(this.owner.getSkill(sk) * 0.1, 1));
    if (target.hasFlag('STR_RELOAD')) mv -= this.owner.str * 20;
    return Math.max(25, Math.round(mv));
  }

  /** Everything carried with where it sits (for picking ammo and magazines). */
  private everything(): { item: Item; loc: Loc }[] {
    const out: { item: Item; loc: Loc }[] = [];
    const visit = (loc: Loc, list: readonly Item[]) => {
      for (const it of list) {
        out.push({ item: it, loc });
        if (it.contents.length) visit(L.in(it), it.contents);
        if (it.magazine) visit(L.mag(it), [it.magazine]);
      }
    };
    visit(L.hands(this.owner), this.s.wielded ? [this.s.wielded] : []);
    visit(L.worn(this.owner), this.s.worn);
    visit(L.inv(this.owner), this.s.items);
    return out;
  }

  /** Loose rounds you carry that `target` takes, loaded type first, then biggest stack. */
  private looseAmmoFor(target: Item): { item: Item; loc: Loc }[] {
    const loaded = target.ammoData()?.id;
    return this.everything()
      // rounds already in a magazine stay there, except a speedloader's: that's what it is for
      .filter(({ item, loc }) => item.isAmmo() && item.charges > 0 && target.acceptsAmmo(item) && !(loc.kind === 'in' && (loc.host === target || (loc.host.isMagazine() && !loc.host.hasFlag('SPEEDLOADER')))))
      .filter(({ item }) => !loaded || target.ammoRemaining() === 0 || item.typeId === loaded)
      .sort((a, b) => Number(b.item.typeId === loaded) - Number(a.item.typeId === loaded) || b.item.charges - a.item.charges);
  }

  /** Fill `target` (magazine, integral magazine, bandolier) from loose rounds you carry. */
  private fillFromLoose(target: Item): { loaded: number; ammo?: Item; moves: number } {
    let loaded = 0, moves = 0;
    let used: Item | undefined;
    for (const { item, loc } of this.looseAmmoFor(target)) {
      if (target.ammoRemaining() >= target.ammoCapacity()) break;
      const probe = item;
      const r = moveItem(item, loc, L.in(target), { partial: true, actor: this.owner, quiet: true });
      if (!r.ok) continue;
      loaded += r.moved;
      moves += this.reloadCost(target, probe, r.moved);
      used ??= probe;
    }
    return { loaded, ammo: used, moves };
  }

  /**
   * Reload a gun, tool or magazine ('r'). Magazine-fed items get the fullest compatible
   * magazine you carry (filling an empty one from loose rounds first); the old magazine goes to
   * your inventory (or your feet). Integral magazines and magazines load loose rounds.
   */
  reload(target: Item | null = this.s.wielded): ActionResult {
    if (!target) return this.say(false, "You're not wielding anything.");
    if (target.takesMagazines() && !target.isMagazine()) {
      const cur = target.magazine;
      const mags = this.everything().filter(({ item }) => item !== cur && item.isMagazine() && target.acceptsMagazine(item) && item !== target);
      mags.sort((a, b) => b.item.ammoRemaining() - a.item.ammoRemaining());
      const best = mags[0];
      let fillCost = 0;
      if (best && best.item.ammoRemaining() === 0 && !cur?.ammoRemaining()) {
        const f = this.fillFromLoose(best.item);
        fillCost = f.moves;
      }
      if (best && best.item.ammoRemaining() > (cur?.ammoRemaining() ?? -1)) {
        let dropped = false;
        const r = transaction(() => {
          if (cur) {
            let away = moveItem(cur, L.mag(target), L.inv(this.owner), { actor: this.owner, quiet: true, force: false });
            const g = this.groundHere();
            if (!away.ok && g) {
              away = moveItem(cur, L.mag(target), g, { actor: this.owner, quiet: true });
              dropped = away.ok;
            }
            if (!away.ok) return away;
          }
          // re-locate: moving the old magazine may have changed nothing about the new one's spot
          const from = locate(best.item, bodyLocs(this.owner)) ?? best.loc;
          return moveItem(best.item, from, L.mag(target), { actor: this.owner, quiet: true });
        });
        if (!r.ok) return this.res(r);
        void dropped;
        return this.say(true, `You reload the ${target.baseName()}.`, fillCost + this.reloadCost(target, best.item, 1));
      }
      if (cur && cur.ammoRemaining() < cur.ammoCapacity()) return this.reloadMagazine(cur);
      if (cur) return this.say(false, `The ${target.baseName()} is already fully loaded!`);
      return this.say(false, `You don't have a magazine to reload your ${target.baseName()}!`);
    }
    if (target.isMagazine() || target.hasIntegralMagazine() || target.isBandolier()) return this.reloadMagazine(target);
    return this.say(false, `You can't reload the ${target.baseName()}.`);
  }

  private reloadMagazine(target: Item): ActionResult {
    if (target.ammoRemaining() >= target.ammoCapacity()) return this.say(false, `The ${target.baseName()} is already fully loaded!`);
    const { loaded, ammo, moves } = this.fillFromLoose(target);
    if (!loaded || !ammo) return this.say(false, `You don't have any ammo to reload your ${target.baseName()}!`);
    return this.say(true, `You reload the ${target.baseName()} with ${ammo.baseName(2)}.`, moves);
  }

  /**
   * Unload (BN unload_item): a container's contents, a gun's magazine or the rounds in a
   * magazine go to your inventory, else your feet. Liquids are returned for the liquid menu.
   */
  unload(target: Item): ActionResult & { liquids: Item[] } {
    const dests: Loc[] = [L.inv(this.owner)];
    const g = this.groundHere();
    if (g) dests.push(g);
    const r = unloadItem(target, dests, { actor: this.owner, quiet: true });
    if (r.msg) this.owner.msg(r.msg, r.ok ? undefined : 'c_light_red');
    return { ok: r.ok, msg: r.msg, moves: r.moves, liquids: r.liquids, ...(r.code ? { code: r.code } : {}) };
  }

  /** Could `it` move from `from` to `to` for this character? (UI: "why can't I".) */
  canMoveTo(it: Item, from: Loc | null, to: Loc): MoveResult {
    return canMove(it, from, to, { actor: this.owner });
  }

  // ------------------------------------------------------------ time
  /** Active items drain charges (power_draw in W, 1 battery charge = 1 kJ; or turns_per_charge). */
  update(dt: number): void {
    for (const it of this.allItems()) {
      if (!it.active) continue;
      const w = powerDrawW(it.def.power_draw);
      const perCharge = w > 0 ? 1000 / w : (it.def.turns_per_charge ?? 0);
      if (perCharge <= 0) continue;
      let acc = (this.activeAcc.get(it) ?? 0) + dt;
      while (acc >= perCharge) {
        acc -= perCharge;
        // Turns off as soon as the last charge is spent (or if it had none to begin with).
        if (it.ammoConsume(1) === 0 || it.ammoRemaining() === 0) {
          const revert = it.def.revert_to;
          const name = it.label();
          if (revert && this.owner.data.items[revert]) it.convert(revert);
          it.active = false;
          this.owner.msg(`Your ${name} runs out of power.`);
          acc = 0;
          break;
        }
      }
      this.activeAcc.set(it, acc);
    }
  }

  /** Rot carried food (caller supplies the ambient temperature). */
  processRot(dt: number, tempC: number): void {
    for (const t of this.topLevel()) t.processRot(dt, tempC);
  }

  toJSON(): InventoryJSON {
    return { wielded: this.s.wielded?.toJSON() ?? null, worn: this.s.worn.map((w) => w.toJSON()), items: this.s.items.map((i) => i.toJSON()) };
  }
  /** Replace everything with saved state (the old belongings are discarded: this is a load). */
  load(j: InventoryJSON): void {
    const data = this.owner.data;
    this.s.wielded = j.wielded ? Item.fromJSON(data, j.wielded) : null;
    this.s.worn.splice(0, this.s.worn.length, ...j.worn.map((w) => Item.fromJSON(data, w)));
    this.s.items.splice(0, this.s.items.length, ...(j.items ?? []).map((w) => Item.fromJSON(data, w)));
    this.sortWorn();
  }
}
