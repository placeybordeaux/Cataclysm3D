import type { ArmorPortion, ItemDef } from '../data/types';
import type { Rng } from '../core/rng';
import { BODY_PARTS, isBodyPart, MAIN_PARTS, type BodyPartId, type MainPartId } from './bodyparts';
import type { Character } from './character';
import { asArray, Item, type ItemJSON, type Pocket } from './item';
import { cddaText, toSeconds } from './units';

// Wielded/worn items and everything carried in their pockets (CDDA Character inventory +
// outfit, simplified). Nothing is carried "loose": like modern CDDA, items live in the
// pockets of worn clothing/backpacks, or in your hands.
//
// Actions return an ActionResult with CDDA's message wording and a move cost; the message
// is also sent to the owner's message sink so callers can ignore it.

export interface ActionResult {
  ok: boolean;
  msg: string;
  /** CDDA moves the action takes (100 moves = 1 turn); long ones become activities. */
  moves: number;
  /** Items that had to be put on the ground as a side effect (caller places them). */
  dropped?: Item[];
  /**
   * consume()/use(): the passed item is used up entirely. Items in the inventory are
   * already removed; if it came from the map the caller removes it there.
   */
  usedUp?: boolean;
}

/** CDDA layer_level order, innermost first. */
export const LAYERS = ['PERSONAL', 'SKINTIGHT', 'NORMAL', 'WAIST', 'OUTER', 'BELTED', 'AURA'] as const;
export type Layer = (typeof LAYERS)[number];

export interface InventoryJSON {
  wielded: ItemJSON | null;
  worn: ItemJSON[];
}

/** Normalized use_action list: strings become { type }. */
export function useActions(def: ItemDef): { type: string; [k: string]: any }[] {
  const raw = def.use_action;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((u) => (typeof u === 'string' ? { type: u } : (u as { type: string })));
}

/** material ids of an item (CDDA allows ["steel"] or [{type, portion}]). */
export function materialIds(def: ItemDef): string[] {
  return (def.material ?? []).map((m) => (typeof m === 'string' ? m : (m as { type: string }).type));
}

export function itemLayer(it: Item, portion?: ArmorPortion): Layer {
  const l = portion?.layers?.[0];
  if (l && (LAYERS as readonly string[]).includes(l)) return l as Layer;
  for (const f of ['PERSONAL', 'SKINTIGHT', 'WAIST', 'OUTER', 'BELTED', 'AURA'] as const) if (it.hasFlag(f)) return f;
  return 'NORMAL';
}

/** Parts an armor portion covers (hands/feet listed separately, like CDDA). */
function portionCovers(p: ArmorPortion): BodyPartId[] {
  // Some CDDA items give a single string instead of a list.
  return asArray(p.covers as string | string[] | undefined).filter(isBodyPart);
}

/**
 * The item's armor data for a whole body part. CDDA splits clothing into sub-location
 * portions (torso_upper/torso_lower, foot_sole...); we merge them per part: the highest
 * coverage and encumbrance, and the materials of the best-covering portion that lists any.
 */
export function armorPortion(it: Item, bp: BodyPartId): ArmorPortion | undefined {
  const list = (it.def.armor ?? []).filter((p) => portionCovers(p).includes(bp));
  if (list.length <= 1) return list[0];
  const enc = (p: ArmorPortion) => asArray(p.encumbrance);
  const withMat = list.filter((p) => p.material?.length).sort((a, b) => (b.coverage ?? 0) - (a.coverage ?? 0))[0];
  return {
    ...list[0],
    coverage: Math.max(...list.map((p) => p.coverage ?? 0)),
    encumbrance: [Math.max(...list.map((p) => enc(p)[0] ?? 0)), Math.max(...list.map((p) => enc(p)[1] ?? enc(p)[0] ?? 0))],
    material: withMat?.material,
  };
}

export function covers(it: Item, bp: BodyPartId): boolean {
  return armorPortion(it, bp) !== undefined;
}

/** Items whose storage makes them "the" backpack: only one may be worn (our simplification). */
function isBackpackLike(it: Item): boolean {
  return it.hasFlag('BELTED') && covers(it, 'torso') && it.containerVolumeCapacity() >= 5000;
}

/** Power draw in W (extractor units) or a raw CDDA string like "1560 mW". */
function powerDrawW(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return 0;
  const m = /^\s*([\d.]+)\s*(mW|W|kW)\s*$/.exec(v);
  if (!m) throw new Error(`Bad power_draw "${v}"`);
  return parseFloat(m[1]) * (m[2] === 'mW' ? 0.001 : m[2] === 'W' ? 1 : 1000);
}

export class Inventory {
  wielded: Item | null = null;
  /** Worn items, sorted innermost layer first. */
  worn: Item[] = [];
  private activeAcc = new WeakMap<Item, number>();
  /**
   * use_action handlers owned by other systems, keyed by use_action type (e.g. crafting
   * registers 'firestarter', which needs the map). Consulted for types use() doesn't know.
   */
  readonly useHandlers = new Map<string, (it: Item, ua: { type: string; [k: string]: any }) => ActionResult>();
  /**
   * Hooks for body modifications (src/game/mutations.ts, bionics.ts): extra reasons an item
   * can't be worn (restricts_gear), extra encumbrance per part, flat natural armor, extra
   * tool-quality providers (bionic pseudo tools), and checks/effects around consuming
   * (mutagen vitamins, syringes).
   */
  readonly wearChecks: ((it: Item) => string | null)[] = [];
  readonly extraEncumbrance: ((bp: BodyPartId) => number)[] = [];
  readonly naturalArmor: ((bp: BodyPartId, dtype: string) => number)[] = [];
  readonly qualityProviders: (() => Item[])[] = [];
  readonly consumeChecks: ((food: Item) => string | null)[] = [];
  readonly onConsume: ((portion: Item) => string | void)[] = [];

  constructor(readonly owner: Character) {}

  private say(ok: boolean, msg: string, moves = 0, extra: Partial<ActionResult> = {}): ActionResult {
    if (msg) this.owner.msg(msg, ok ? undefined : 'c_light_red');
    return { ok, msg, moves, ...extra };
  }

  // ------------------------------------------------------------ queries
  /** wielded + worn (top-level items). */
  topLevel(): Item[] {
    return this.wielded ? [this.wielded, ...this.worn] : [...this.worn];
  }
  /** Every carried item including nested contents (and the top-level ones). */
  allItems(): Item[] {
    const out: Item[] = [];
    for (const t of this.topLevel()) for (const it of t.walk()) out.push(it);
    return out;
  }
  /** Items stored in worn/wielded container pockets (what CDDA's inventory screen lists). */
  carried(): Item[] {
    const out: Item[] = [];
    for (const t of this.topLevel()) for (const p of t.containerPockets()) out.push(...p.contents);
    return out;
  }
  has(it: Item): boolean {
    return this.allItems().includes(it);
  }
  weightCarried(): number {
    let w = 0;
    for (const t of this.topLevel()) w += t.weight();
    return w;
  }
  /** Creature::weight_capacity (13 kg) + str * 4 kg, times CARRY_WEIGHT enchantments. */
  weightCapacity(): number {
    return Math.max(0, this.owner.byEnchant(13000 + this.owner.str_base * 4000, 'CARRY_WEIGHT'));
  }
  volumeCapacity(): number {
    let v = 0;
    for (const t of this.worn) v += t.containerVolumeCapacity();
    return v;
  }
  volumeCarried(): number {
    let v = 0;
    for (const t of this.worn) v += t.containerVolumeUsed();
    return v;
  }
  /** Worn items covering a body part, outermost first (the order attacks meet them). */
  wornCovering(bp: BodyPartId): Item[] {
    return this.worn.filter((w) => covers(w, bp)).reverse();
  }

  // ------------------------------------------------------------ containers
  /** Where `it` would go (first worn container pocket that fits all of it). */
  findPocketFor(it: Item): Pocket | null {
    for (const w of [...this.worn].reverse()) {
      for (const p of w.containerPockets()) {
        const r = p.canContain(it);
        if (r.ok && (!it.countByCharges || (r.charges ?? 0) >= it.charges)) return p;
      }
    }
    return null;
  }
  /** Store into worn containers, merging stacks; returns what did not fit. */
  stash(it: Item): Item | null {
    const whole = this.findPocketFor(it);
    if (whole) return whole.insert(it);
    let left: Item | null = it;
    for (const w of [...this.worn].reverse()) {
      if (!left) break;
      left = w.put(left);
    }
    return left;
  }
  canStash(it: Item): boolean {
    return this.findPocketFor(it) !== null;
  }
  /** Detach an item from wherever it is (hands, body, a pocket). */
  remove(it: Item): boolean {
    if (this.wielded === it) {
      this.wielded = null;
      return true;
    }
    const i = this.worn.indexOf(it);
    if (i >= 0) {
      this.worn.splice(i, 1);
      return true;
    }
    for (const t of this.topLevel()) if (t.removeContent(it)) return true;
    return false;
  }

  // ------------------------------------------------------------ pick up / drop / wield
  /** Pick up an item from the map. On failure the item stays where it was. */
  pickUp(it: Item): ActionResult {
    const moves = 100 + Math.min(200, Math.floor(it.volume() / 20));
    if (this.weightCarried() + it.weight() > this.weightCapacity() * 4)
      return this.say(false, `The ${it.name()} is too heavy to carry.`);
    if (this.canStash(it)) {
      this.stash(it);
      return this.say(true, `You pick up: ${it.name()}`, moves);
    }
    if (!this.wielded) {
      const w = this.canWield(it);
      if (!w.ok) return this.say(false, w.reason!);
      this.wielded = it;
      return this.say(true, `You wield your ${it.name()}.`, moves);
    }
    return this.say(false, `There's no room in your inventory for the ${it.name()}.`);
  }

  /** Remove an item so the caller can put it on the map (result.dropped). */
  drop(it: Item): ActionResult {
    if (it.hasFlag('BIONIC_WEAPON') || it.hasFlag('INTEGRATED')) return this.say(false, `You cannot drop your ${it.name()}.`);
    if (!this.remove(it)) return this.say(false, `You don't have that item.`);
    return this.say(true, `You drop your ${it.name()}.`, 100, { dropped: [it] });
  }

  canWield(it: Item): { ok: boolean; reason?: string } {
    if (this.wielded?.hasFlag('BIONIC_WEAPON') && this.wielded !== it) return { ok: false, reason: `You cannot unwield your ${this.wielded.name()}.` };
    if (it.isLiquid()) return { ok: false, reason: "You can't wield spilt liquids." };
    if (this.owner.brokenArms() >= 2) return { ok: false, reason: "You can't wield anything with two broken arms." };
    if (this.owner.brokenArms() === 1 && (it.weight() > this.owner.str * 250 || it.hasFlag('ALWAYS_TWOHAND')))
      return { ok: false, reason: `You can't wield the ${it.name()} with only one arm.` };
    return { ok: true };
  }

  /** Wield `it` (from inventory or map). The old weapon is stashed, or dropped if no room. */
  wield(it: Item): ActionResult {
    if (this.wielded === it) return this.say(false, `You're already wielding the ${it.name()}.`);
    const can = this.canWield(it);
    if (!can.ok) return this.say(false, can.reason!);
    const dropped: Item[] = [];
    this.remove(it);
    if (this.wielded) {
      const old = this.wielded;
      this.wielded = null;
      if (this.stash(old)) dropped.push(old);
    }
    this.wielded = it;
    // item::on_wield_cost, simplified: base 100 + volume penalty.
    const moves = 100 + Math.min(200, Math.floor(it.volume() / 20));
    return this.say(true, `You wield your ${it.name()}.`, moves, dropped.length ? { dropped } : {});
  }

  unwield(): ActionResult {
    const w = this.wielded;
    if (!w) return this.say(false, 'You are already empty-handed.');
    // Bionic weapons are retracted through the bionics menu (CDDA NO_UNWIELD).
    if (w.hasFlag('BIONIC_WEAPON')) return this.say(false, `You cannot unwield your ${w.name()}.`);
    if (!this.canStash(w)) return this.say(false, `You have no space to store your ${w.name()}.`);
    this.wielded = null;
    this.stash(w);
    return this.say(true, `You put away your ${w.name()}.`, 100);
  }

  // ------------------------------------------------------------ clothing
  /** Character::can_wear (the subset that applies to humans without mutations). */
  canWear(it: Item): { ok: boolean; reason?: string } {
    if (!it.isArmor()) return { ok: false, reason: `Putting on a ${it.name()} would be tricky.` };
    if (this.worn.includes(it)) return { ok: false, reason: 'You are already wearing that.' };
    const maxWorn = (it.def.max_worn as number | undefined) ?? 2;
    const same = this.worn.filter((w) => w.typeId === it.typeId).length;
    if (maxWorn === 1 && same >= 1) return { ok: false, reason: `Can't wear more than one ${it.name()}!` };
    if (same >= maxWorn) return { ok: false, reason: `Can't wear ${maxWorn} or more ${it.baseName(2)} at once.` };
    for (const w of this.worn) {
      const sharesPart = (it.def.armor ?? []).some((p) => portionCovers(p).some((bp) => covers(w, bp)));
      if (!sharesPart) continue;
      const oneLayer = it.hasFlag('ONE_PER_LAYER') || w.hasFlag('ONE_PER_LAYER') || (isBackpackLike(it) && isBackpackLike(w));
      if (oneLayer && itemLayer(w) === itemLayer(it)) return { ok: false, reason: `${it.name()} conflicts with ${w.name()}!` };
    }
    if (it.hasFlag('RESTRICT_HANDS') && this.wielded && (this.wielded.hasFlag('ALWAYS_TWOHAND') || this.wielded.weight() > 5000))
      return { ok: false, reason: "You don't have a hand free to wear that." };
    for (const check of this.wearChecks) {
      const reason = check(it);
      if (reason) return { ok: false, reason };
    }
    return { ok: true };
  }

  wear(it: Item): ActionResult {
    const can = this.canWear(it);
    if (!can.ok) return this.say(false, can.reason!);
    this.remove(it);
    this.worn.push(it);
    this.sortWorn();
    // Character::item_wear_cost: 250 moves scaled by the item's encumbrance (simplified).
    const moves = 250 + 10 * Math.max(0, ...(it.def.armor ?? []).map((p) => asArray(p.encumbrance)[0] ?? 0));
    return this.say(true, `You put on your ${it.name()}.`, moves);
  }

  /** Take off: goes to your inventory if it fits, otherwise into your hands, else dropped. */
  takeOff(it: Item): ActionResult {
    const i = this.worn.indexOf(it);
    if (i < 0) return this.say(false, 'You are not wearing that item.');
    if (it.hasFlag('INTEGRATED')) return this.say(false, `You can't take off your ${it.name()}; it's part of you.`);
    this.worn.splice(i, 1);
    const dropped: Item[] = [];
    if (this.canStash(it)) this.stash(it);
    else if (!this.wielded) this.wielded = it;
    else dropped.push(it);
    return this.say(true, `You take off your ${it.name()}.`, 250, dropped.length ? { dropped } : {});
  }

  private sortWorn(): void {
    const idx = (w: Item) => LAYERS.indexOf(itemLayer(w));
    this.worn.sort((a, b) => idx(a) - idx(b));
  }

  /** Encumbrance an item adds to a part: [base, full] interpolated by pocket fill. */
  itemEncumbrance(it: Item, bp: BodyPartId): number {
    const p = armorPortion(it, bp);
    if (!p) return 0;
    const [base, full] = (() => {
      const e = asArray(p.encumbrance);
      return [e[0] ?? 0, e[1] ?? e[0] ?? 0];
    })();
    let enc = base;
    const cap = it.containerPockets().filter((q) => !q.data.rigid).reduce((s, q) => s + q.maxVolume, 0);
    if (full > base && cap > 0 && Number.isFinite(cap)) {
      const used = it.containerPockets().filter((q) => !q.data.rigid).reduce((s, q) => s + q.volumeUsed(), 0);
      enc = base + (full - base) * Math.min(1, used / cap);
    }
    for (const q of it.containerPockets()) if (!q.empty && q.data.extra_encumbrance) enc += q.data.extra_encumbrance;
    return Math.round(enc);
  }

  /** Total encumbrance on a part: items + CDDA layering penalty (layer_details::layer). */
  encumbrance(bp: BodyPartId): number {
    let total = 0;
    const byLayer = new Map<Layer, number[]>();
    for (const w of this.worn) {
      const p = armorPortion(w, bp);
      if (!p) continue;
      const e = this.itemEncumbrance(w, bp);
      total += e;
      const l = itemLayer(w, p);
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l)!.push(Math.max(2, e));
    }
    // Every item on a layer except the most encumbering one counts double.
    for (const list of byLayer.values()) {
      if (list.length < 2) continue;
      total += list.reduce((a, b) => a + b, 0) - Math.max(...list);
    }
    for (const f of this.extraEncumbrance) total += f(bp);
    return total;
  }

  warmth(bp: BodyPartId): number {
    let w = 0;
    for (const it of this.worn) if (covers(it, bp)) w += it.def.warmth ?? 0;
    return w;
  }

  /** Resistance of one worn item on a part vs a damage type (item::resist, simplified). */
  armorResist(it: Item, bp: BodyPartId, dtype: string, rng?: Rng): number {
    const mats = this.owner.data.misc?.material ?? {};
    const resistOf = (mat: string): number => {
      const r = mats[mat]?.resist as Record<string, number> | undefined;
      if (!r) return 0;
      if (r[dtype] !== undefined) return r[dtype];
      // damage_types.json: stab derives from cut * 0.8 when a material has no stab resist.
      if (dtype === 'stab' && r.cut !== undefined) return r.cut * 0.8;
      return 0;
    };
    const p = armorPortion(it, bp);
    let resist = 0;
    if (p?.material?.length) {
      for (const m of p.material) {
        const cover = m.covered_by_mat ?? 100;
        if (rng && rng.int(0, 99) >= cover) continue;
        resist += resistOf(m.type) * (m.thickness ?? 1) * (rng ? 1 : cover / 100);
      }
    } else {
      const ids = materialIds(it.def);
      if (ids.length) resist = (ids.reduce((s, m) => s + resistOf(m), 0) / ids.length) * (it.def.material_thickness ?? 1);
    }
    // damage_adjusted_armor_resist: damaged armor protects less (faults ignored).
    return Math.max(0, resist * (1 - 0.1 * Math.max(0, it.damageLevel() - 1)));
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
    // Mutation/bionic armor is under the clothes (CDDA passive_absorb_hit after worn armor).
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
  /** Count by type: charges for stackables, items otherwise. */
  countOf(typeId: string): number {
    let n = 0;
    for (const it of this.allItems()) if (it.typeId === typeId) n += it.count();
    return n;
  }
  hasAmount(typeId: string, n: number): boolean {
    return this.countOf(typeId) >= n;
  }
  /** Remove n of a type (splitting stacks) and return the removed items. */
  useAmount(typeId: string, n: number): Item[] {
    if (!this.hasAmount(typeId, n)) throw new Error(`useAmount: need ${n} ${typeId}, have ${this.countOf(typeId)}`);
    const out: Item[] = [];
    for (const it of this.allItems()) {
      if (n <= 0) break;
      if (it.typeId !== typeId) continue;
      if (it.countByCharges && it.charges > n) {
        out.push(it.split(n));
        n = 0;
      } else {
        this.remove(it);
        out.push(it);
        n -= it.count();
      }
    }
    return out;
  }

  // ------------------------------------------------------------ eating & drinking
  /** The comestible to consume from `it` (itself, or the contents of a container). */
  comestibleIn(it: Item): Item | null {
    if (it.isComestible()) return it;
    for (const p of it.containerPockets()) for (const c of p.contents) if (c.isComestible()) return c;
    return null;
  }

  /**
   * Eat/drink one portion (consumption.cpp, simplified): kcal & water go to the stomach,
   * "fun" becomes morale, stim/sleepiness_mod apply, consume_drug use_actions add effects.
   * `it` may be the food itself or a container holding it; empty wrappers stay behind.
   */
  consume(it: Item): ActionResult {
    const food = this.comestibleIn(it);
    const c = this.owner;
    if (!food) return this.say(false, "That doesn't look edible.");
    for (const check of this.consumeChecks) {
      const reason = check(food);
      if (reason) return this.say(false, reason);
    }
    const liquid = food.isLiquid();
    const portion = food.countByCharges ? food.split(Math.min(1, food.charges)) : food;
    const def = portion.def;
    const water = (def.quench ?? 0) * 5;
    const solids = Math.max(0, portion.volume() - (liquid ? portion.volume() : water));
    if (def.comestible_type !== 'MED' && c.stomachContains() + solids + (liquid ? portion.volume() : 0) > 2500 && c.hungerState() === 'Engorged') {
      if (food.countByCharges && portion !== food) food.charges += portion.charges;
      return this.say(false, `You're full already and will be forcing yourself to ${liquid ? 'drink' : 'eat'}.`);
    }
    // Remove what we consumed from wherever it was.
    if (portion === food) {
      if (!this.remove(food) && it !== food) it.removeContent(food);
    } else if (food.charges <= 0) {
      this.remove(food);
      it.removeContent(food);
    }
    // NO_INGEST (mutagens, injected drugs) bypasses the stomach.
    if (!portion.hasFlag('NO_INGEST')) c.ingest(def.calories ?? 0, solids, liquid ? Math.max(water, portion.volume()) : water);
    if (def.stim) c.stim += def.stim;
    if (def.sleepiness_mod) c.sleepiness -= def.sleepiness_mod;
    // Character::fun_for: rot sours taste; morale lasts 2 h, decaying after 1 h.
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
    const moves = liquid ? 100 : Math.max(100, Math.min(1000, Math.floor(portion.volume() / 5) * 10));
    return this.say(true, msg, moves, { usedUp: it === food && (portion === food || food.charges <= 0) });
  }

  // ------------------------------------------------------------ using items
  /**
   * Activate/use an item: heal (bandages, disinfectant), transform (flashlight on/off),
   * consume_drug (pills). `bp` targets medical items; otherwise the worst wound is chosen.
   */
  use(it: Item, bp?: BodyPartId): ActionResult {
    const acts = useActions(it.def);
    if (acts.length === 0) return this.say(false, `You can't do anything interesting with your ${it.name()}.`);
    const ua = acts[0];
    switch (ua.type) {
      case 'heal':
        return this.useHeal(it, ua, bp);
      case 'transform':
        return this.useTransform(it, ua);
      case 'consume_drug':
        return this.consume(it);
      default: {
        for (const a of acts) {
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

  /** heal_actor::finish_using, simplified to the player treating themselves. */
  private useHeal(it: Item, ua: { [k: string]: any }, target?: BodyPartId): ActionResult {
    const c = this.owner;
    const skill = c.getSkill('firstaid');
    const bleed = (ua.bleed as number) ?? 0;
    const bite = (ua.bite as number) ?? 0;
    const infect = (ua.infect as number) ?? 0;
    const bandages = (ua.bandages_power as number) ?? 0;
    const disinfectant = (ua.disinfectant_power as number) ?? 0;
    const limbPower = (ua.limb_power as number) ?? 0;
    // Pick the part: most bleeding, then bitten/infected, then most damaged main part.
    let part: MainPartId | undefined = target ? BODY_PARTS[target].main : undefined;
    if (!part) {
      const score = (p: MainPartId) =>
        (bleed ? c.effects.intensity('bleed', p) * 100 : 0) +
        (bite && c.effects.has('bite', p) ? 50 : 0) + (infect && c.effects.has('infected', p) ? 50 : 0) +
        (c.hp[p].max - c.hp[p].cur);
      part = [...MAIN_PARTS].sort((a, b) => score(b) - score(a))[0];
    }
    const msgs: string[] = [];
    let did = false;
    const bleedEff = c.effects.get('bleed', part);
    if (bleed > 0 && bleedEff) {
      // get_stopbleed_level: CDDA scales by first aid skill / 2, which makes bandages useless
      // at skill 0; we treat skill 0 as a multiplier of 1 so unskilled survivors can bandage.
      const level = Math.round(bleed * Math.max(1, skill / 2));
      if (3 * level > bleedEff.intensity) {
        bleedEff.setDuration(bleedEff.duration - level * bleedEff.type.intDurFactor);
        if (bleedEff.duration <= 0) {
          c.effects.remove('bleed', part);
          msgs.push('You stop the bleeding.');
        } else msgs.push("You reduce the bleeding, but it's not stopped yet.");
      } else msgs.push('Your dressing is too ineffective for a bleeding of this extent, and you fail to stop it.');
      did = true;
    }
    if (bite > 0 && c.effects.has('bite', part) && c.rng.next() < bite) {
      c.effects.remove('bite', part);
      msgs.push('You clean the wound.');
      did = true;
    }
    if (infect > 0 && c.effects.has('infected', part) && c.rng.next() < infect) {
      c.effects.remove('infected', part);
      msgs.push('You disinfect the wound.');
      did = true;
    }
    const hurt = c.hp[part].max - c.hp[part].cur;
    if (bandages > 0 && hurt > 0 && !c.effects.has('bandaged', part)) {
      const level = Math.round(bandages + ((ua.bandages_scaling as number) ?? 0.25 * bandages) * skill);
      const e = c.addEffect('bandaged', 1, { bp: part });
      e.setDuration(e.type.intDurFactor * level);
      msgs.push(`You bandage your ${BODY_PARTS[part].name}.`);
      did = true;
    }
    if (disinfectant > 0 && hurt > 0 && !c.effects.has('disinfected', part)) {
      const e = c.addEffect('disinfected', 1, { bp: part });
      e.setDuration(e.type.intDurFactor * disinfectant);
      msgs.push(`You disinfect your ${BODY_PARTS[part].name}.`);
      did = true;
    }
    if (limbPower > 0 && hurt > 0) {
      const power = part === 'head' ? ((ua.head_power as number) ?? 0.8 * limbPower) : part === 'torso' ? ((ua.torso_power as number) ?? 1.5 * limbPower) : limbPower;
      const scaling = ((ua.limb_scaling as number) ?? 0.25 * limbPower) * skill;
      c.heal(part, power + scaling);
      did = true;
    }
    if (!did) return this.say(false, `Your ${BODY_PARTS[part].name} doesn't need treatment with the ${it.name()}.`);
    c.practice('firstaid', 3 + bleed / 3);
    const usedUp = this.consumeUse(it);
    return this.say(true, msgs.join(' ') || `You use your ${it.name()}.`, (ua.move_cost as number) ?? 500, { usedUp });
  }

  /** Use up one charge or the whole item after a single-use action; true if it's gone. */
  private consumeUse(it: Item): boolean {
    if (it.countByCharges && it.charges > 1) it.charges--;
    else if ((it.def.max_charges ?? 0) > 0 && it.charges > 1 && !it.hasFlag('SINGLE_USE')) it.charges--;
    else {
      this.remove(it);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ reloading
  /** Character::item_reload_cost */
  reloadCost(target: Item, ammo: Item, qty: number): number {
    let mv = Math.min(200, Math.floor(ammo.isMagazine() ? ammo.volume() / 20 : (ammo.unitVolume() * qty) / 20));
    if (ammo.hasFlag('MAG_BULKY')) mv *= 1.5;
    const cost = target.isGun() ? (target.def.reload ?? 100) * qty : (target.def.reload_time ?? 100) * qty;
    const sk = target.isGun() ? (target.def.skill ?? 'gun') : 'gun';
    mv += cost / (1 + Math.min(this.owner.getSkill(sk) * 0.1, 1));
    if (target.hasFlag('STR_RELOAD')) mv -= this.owner.str * 20;
    return Math.max(25, Math.round(mv));
  }

  /** Loose ammo in inventory usable by `target`, preferring what's already loaded. */
  private looseAmmoFor(target: Item): Item[] {
    const types = target.ammoTypes();
    const loaded = target.ammoData()?.id;
    return this.carried()
      .flatMap((c) => [...c.walk()])
      .filter((a) => a.isAmmo() && types.includes(asArray(a.def.ammo_type)[0] ?? '') && a.charges > 0)
      .sort((a, b) => (b.typeId === loaded ? 1 : 0) - (a.typeId === loaded ? 1 : 0) || b.charges - a.charges);
  }

  private removeCharges(src: Item, n: number): Item {
    if (src.charges > n) return src.split(n);
    this.remove(src);
    return src;
  }

  /** Fill an item's own MAGAZINE pockets from loose ammo. Returns rounds loaded. */
  private fillFromLoose(target: Item): { loaded: number; ammo?: Item } {
    let loaded = 0;
    let used: Item | undefined;
    for (const ammo of this.looseAmmoFor(target)) {
      for (const p of target.magazinePockets()) {
        const fit = p.canContain(ammo);
        if (!fit.ok || !fit.charges) continue;
        const n = fit.charges;
        const part = this.removeCharges(ammo, n);
        const left = p.insert(part);
        if (left) this.stash(left);
        loaded += n;
        used ??= part;
      }
    }
    return { loaded, ammo: used };
  }

  /**
   * Reload a gun or magazine ('r'). Guns with a magazine well swap in the fullest
   * compatible magazine you carry (stashing the old one), or top up the inserted
   * magazine from loose rounds; guns/magazines with internal storage load loose rounds.
   */
  reload(target: Item | null = this.wielded): ActionResult {
    if (!target) return this.say(false, "You're not wielding anything.");
    const well = target.magazineWell();
    if (well) {
      const cur = target.magazineCurrent();
      const mags = this.carried()
        .flatMap((c) => [...c.walk()])
        .filter((m) => m !== cur && m.isMagazine() && target.acceptsMagazine(m))
        .sort((a, b) => b.ammoRemaining() - a.ammoRemaining());
      const best = mags[0];
      if (best && best.ammoRemaining() > (cur?.ammoRemaining() ?? -1)) {
        const dropped: Item[] = [];
        this.remove(best);
        if (cur) {
          well.remove(cur);
          if (this.stash(cur)) dropped.push(cur);
        }
        well.insert(best);
        return this.say(true, `You reload the ${target.baseName()}.`, this.reloadCost(target, best, 1), dropped.length ? { dropped } : {});
      }
      if (cur && cur.ammoRemaining() < cur.ammoCapacity()) return this.reloadMagazine(cur);
      if (cur) return this.say(false, `The ${target.baseName()} is already fully loaded!`);
      return this.say(false, `You don't have a magazine to reload your ${target.baseName()}!`);
    }
    if (target.magazinePockets().length) return this.reloadMagazine(target);
    return this.say(false, `You can't reload the ${target.baseName()}.`);
  }

  private reloadMagazine(target: Item): ActionResult {
    if (target.ammoRemaining() >= target.ammoCapacity()) return this.say(false, `The ${target.baseName()} is already fully loaded!`);
    const { loaded, ammo } = this.fillFromLoose(target);
    if (!loaded || !ammo) return this.say(false, `You don't have any ammo to reload your ${target.baseName()}!`);
    return this.say(true, `You reload the ${target.baseName()} with ${ammo.baseName(2)}.`, this.reloadCost(target, ammo, loaded));
  }

  /** Take the magazine out of a gun, or the rounds out of a magazine, into inventory. */
  unload(target: Item): ActionResult {
    const dropped: Item[] = [];
    const mag = target.magazineCurrent();
    if (mag) {
      target.magazineWell()!.remove(mag);
      if (this.stash(mag)) dropped.push(mag);
      return this.say(true, `You unload your ${target.baseName()}.`, 100, dropped.length ? { dropped } : {});
    }
    let any = false;
    for (const p of target.magazinePockets()) {
      for (const a of [...p.contents]) {
        p.remove(a);
        if (this.stash(a)) dropped.push(a);
        any = true;
      }
    }
    if (!any) return this.say(false, `Your ${target.baseName()} isn't loaded.`);
    return this.say(true, `You unload your ${target.baseName()}.`, 100, dropped.length ? { dropped } : {});
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
          const name = it.name();
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
    return { wielded: this.wielded?.toJSON() ?? null, worn: this.worn.map((w) => w.toJSON()) };
  }
  load(j: InventoryJSON): void {
    const data = this.owner.data;
    this.wielded = j.wielded ? Item.fromJSON(data, j.wielded) : null;
    this.worn = j.worn.map((w) => Item.fromJSON(data, w));
  }
}
