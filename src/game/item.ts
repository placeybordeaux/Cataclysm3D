import type { GameData, ItemDef, MeleeAccuracy, PocketData } from '../data/types';
import type { MapItem } from '../world/map';
import type { SpawnedItem } from '../data/itemgroups';
import { warnOnce } from '../data/warn';
import { cddaText, toGrams, toMl, toSeconds } from './units';

// Item instances (CDDA item.cpp / item_pocket.cpp, simplified). An Item is one ItemDef plus
// mutable state: charges (stack size for count-by-charges items like ammo and liquids),
// damage (-1000..4000 like CDDA's damage_), rot (seconds of rot points), active state,
// and pockets holding other Items. Pockets are the CDDA pocket_data list: CONTAINER
// (bottles, backpacks, jeans pockets), MAGAZINE (rounds in a magazine or tube) and
// MAGAZINE_WELL (the slot in a gun that takes a magazine).

export const MAX_ITEM_DAMAGE = 4000;
export const MIN_ITEM_DAMAGE = -1000;

export type PocketType = NonNullable<PocketData['pocket_type']>;

export type { SpawnedItem };

export interface ItemJSON {
  typeId: string;
  charges?: number;
  damage?: number;
  rot?: number;
  active?: boolean;
  sealed?: boolean;
  vars?: Record<string, string | number>;
  /** One array per pocket, in pocket_data order. */
  pockets?: ItemJSON[][];
}

export interface FitResult {
  ok: boolean;
  reason?: string;
  /** For count-by-charges items: how many charges fit. */
  charges?: number;
}

export function hasSubtype(def: ItemDef, sub: string): boolean {
  return def.type === sub || (def.subtypes?.includes(sub) ?? false);
}

export function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** CDDA itype::count_by_charges: ammo, non-solid comestibles, or "stackable". */
export function countByCharges(def: ItemDef): boolean {
  if (def.stackable) return true;
  if (hasSubtype(def, 'AMMO')) return true;
  if (hasSubtype(def, 'COMESTIBLE') && def.phase !== undefined && def.phase !== 'solid') return true;
  return false;
}

/** CDDA itype::charges_default. */
export function defaultCharges(def: ItemDef): number {
  if (hasSubtype(def, 'TOOL') && (def.initial_charges ?? 0) > 0) return def.initial_charges!;
  if (def.charges !== undefined && def.charges > 0) return def.charges;
  if (hasSubtype(def, 'AMMO') && (def.count ?? 0) > 0) return def.count!;
  return countByCharges(def) ? 1 : 0;
}

const GRIP = { bad: 0, none: 1, solid: 2, weapon: 3 } as const;
const LENGTH = { hand: 0, short: 1, long: 2 } as const;
const SURFACE = { point: 0, line: 1, any: 2, every: 3 } as const;
const BALANCE = { clumsy: 0, uneven: 1, neutral: 2, good: 3 } as const;

/** item_factory.cpp melee_accuracy::sum_values: base -2 plus offsets (-7 total). */
export function toHitFromAccuracy(a: MeleeAccuracy): number {
  return -7 + GRIP[a.grip ?? 'weapon'] + LENGTH[a.length ?? 'hand'] + SURFACE[a.surface ?? 'any'] + BALANCE[a.balance ?? 'neutral'];
}

export class Pocket {
  contents: Item[] = [];
  readonly maxVolume: number;
  readonly maxWeight: number;
  constructor(readonly data: PocketData, readonly owner: Item) {
    // Pocket data may still hold CDDA unit strings if the extractor didn't touch it.
    this.maxVolume = toMl(data.max_contains_volume, Infinity);
    this.maxWeight = toGrams(data.max_contains_weight, Infinity);
  }
  get type(): PocketType {
    return this.data.pocket_type ?? 'CONTAINER';
  }
  get empty(): boolean {
    return this.contents.length === 0;
  }
  /**
   * Running totals while a batch of inserts is in progress (see beginBatch). Summing the
   * contents on every canContain made filling one container quadratic: a shop's 500
   * welding rods took seconds. Only valid between beginBatch/endBatch, when nothing but
   * insert() touches the contents.
   */
  private batch: { v: number; w: number; liquid: boolean } | null = null;
  volumeUsed(): number {
    if (this.batch) return this.batch.v;
    let v = 0;
    for (const it of this.contents) v += it.volume();
    return v;
  }
  private rawWeightUsed(): number {
    if (this.batch) return this.batch.w;
    let w = 0;
    for (const it of this.contents) w += it.weight();
    return w;
  }
  weightUsed(): number {
    return this.rawWeightUsed() * (this.data.weight_multiplier ?? 1);
  }
  hasLiquid(): boolean {
    return this.batch ? this.batch.liquid : this.contents.some((c) => c.isLiquid());
  }
  /** Start caching volume/weight totals for a run of insert() calls (fromSpawned). */
  beginBatch(): void {
    this.batch = null;
    this.batch = { v: this.volumeUsed(), w: this.rawWeightUsed(), liquid: this.hasLiquid() };
  }
  endBatch(): void {
    this.batch = null;
  }
  volumeRemaining(): number {
    return this.maxVolume - this.volumeUsed();
  }
  weightRemaining(): number {
    return this.maxWeight - this.weightUsed();
  }
  /** Rounds allowed of a given ammo type in a MAGAZINE pocket. */
  ammoLimit(ammoType: string): number {
    return this.data.ammo_restriction?.[ammoType] ?? 0;
  }
  ammoCount(): number {
    let n = 0;
    for (const it of this.contents) if (it.isAmmo()) n += it.charges;
    return n;
  }

  /** Whether `it` (or how many of its charges) can go in, following item_pocket.cpp rules. */
  canContain(it: Item): FitResult {
    if (it === this.owner) return { ok: false, reason: "can't put an item into itself" };
    switch (this.type) {
      case 'MAGAZINE': {
        if (!it.isAmmo()) return { ok: false, reason: 'not ammunition' };
        const at = it.def.ammo_type ?? '';
        const limit = this.ammoLimit(asArray(at)[0]);
        if (limit <= 0) return { ok: false, reason: 'wrong ammo type' };
        const other = this.contents.find((c) => c.typeId !== it.typeId);
        if (other) return { ok: false, reason: 'already contains different ammo' };
        const room = limit - this.ammoCount();
        if (room <= 0) return { ok: false, reason: 'full' };
        return { ok: true, charges: Math.min(room, it.charges) };
      }
      case 'MAGAZINE_WELL': {
        if (!this.empty) return { ok: false, reason: 'already has a magazine' };
        if (!this.acceptsMagazine(it)) return { ok: false, reason: 'incompatible magazine' };
        return { ok: true, charges: it.countByCharges ? it.charges : undefined };
      }
      case 'CONTAINER':
        return this.canContainInContainer(it);
      default:
        return { ok: false, reason: `can't store items in ${this.type} pocket` };
    }
  }

  acceptsMagazine(mag: Item): boolean {
    const ir = this.data.item_restriction;
    if (ir && ir.includes(mag.typeId)) return true;
    const fr = this.data.flag_restriction;
    if (fr && fr.some((f) => mag.hasFlag(f))) return true;
    return false;
  }

  private canContainInContainer(it: Item): FitResult {
    const d = this.data;
    const liquid = it.isLiquid();
    if (liquid && !d.watertight) return { ok: false, reason: "can't contain liquid" };
    // A liquid pocket holds one liquid and nothing else, as in CDDA.
    if (this.hasLiquid() && (!liquid || this.contents.some((c) => c.typeId !== it.typeId)))
      return { ok: false, reason: "can't mix liquid with contained item" };
    if (liquid && this.contents.some((c) => !c.isLiquid())) return { ok: false, reason: "can't put liquid into container with items" };
    if (d.item_restriction && !d.item_restriction.includes(it.typeId)) return { ok: false, reason: 'item restricted' };
    if (d.flag_restriction && !d.flag_restriction.some((f) => it.hasFlag(f))) return { ok: false, reason: 'item restricted' };
    if (d.holster && !this.empty && !this.contents.every((c) => c.stacksWith(it)))
      return { ok: false, reason: 'holster already full' };
    if (!liquid) {
      const perItemVol = it.countByCharges ? it.unitVolume() : it.volume();
      if (d.max_item_volume !== undefined && perItemVol > toMl(d.max_item_volume)) return { ok: false, reason: 'item too big for opening' };
      if (d.min_item_volume !== undefined && it.volume() < toMl(d.min_item_volume)) return { ok: false, reason: 'item too small' };
      const len = it.def.longest_side;
      if (len !== undefined && d.max_item_length !== undefined && len > d.max_item_length) return { ok: false, reason: 'item too long' };
      if (len !== undefined && d.min_item_length !== undefined && len < d.min_item_length) return { ok: false, reason: 'item too short' };
    }
    const volLeft = this.volumeRemaining();
    const wtLeft = this.weightRemaining() / (d.weight_multiplier ?? 1);
    if (it.countByCharges) {
      const uv = it.unitVolume();
      const uw = it.unitWeight();
      let n = it.charges;
      if (uv > 0) n = Math.min(n, Math.floor(volLeft / uv + 1e-9));
      if (uw > 0) n = Math.min(n, Math.floor(wtLeft / uw + 1e-9));
      if (n <= 0) return { ok: false, reason: volLeft < uv ? 'not enough space' : 'too heavy' };
      return { ok: true, charges: n };
    }
    if (it.volume() > volLeft) return { ok: false, reason: 'not enough space' };
    if (it.weight() > wtLeft) return { ok: false, reason: 'too heavy' };
    return { ok: true };
  }

  /**
   * Insert as much of `it` as fits. Returns the part that did not fit (the same object,
   * with reduced charges) or null when everything went in. Charge items merge into an
   * existing stack of the same type.
   */
  insert(it: Item): Item | null {
    const fit = this.canContain(it);
    if (!fit.ok) return it;
    if (it.countByCharges && fit.charges !== undefined && this.type !== 'MAGAZINE_WELL') {
      const n = fit.charges;
      const target = this.contents.find((c) => c.stacksWith(it));
      if (target) {
        const b = this.batch;
        const v0 = b ? target.volume() : 0, w0 = b ? target.weight() : 0;
        target.charges += n;
        if (b) (b.v += target.volume() - v0), (b.w += target.weight() - w0);
      } else this.push(n === it.charges ? it : it.split(n));
      if (n === it.charges) {
        if (target) it.charges = 0;
        return null;
      }
      if (target) it.charges -= n;
      return it;
    }
    this.push(it);
    return null;
  }

  private push(it: Item): void {
    this.contents.push(it);
    const b = this.batch;
    if (b) {
      b.v += it.volume();
      b.w += it.weight();
      if (it.isLiquid()) b.liquid = true;
    }
  }

  remove(it: Item): boolean {
    const i = this.contents.indexOf(it);
    if (i < 0) return false;
    this.contents.splice(i, 1);
    return true;
  }
}

export class Item implements MapItem {
  typeId: string;
  def: ItemDef;
  /** Stack size (count-by-charges) or tool charges; 0 for plain items. */
  charges = 0;
  /** CDDA damage_: -1000 (reinforced) .. 0 (intact) .. 4000 (destroyed). */
  damage = 0;
  /** Accumulated rot in seconds-at-65F equivalents (CDDA rot). */
  rot = 0;
  active = false;
  /** Factory-sealed container: contents don't spoil (sealed_data) until opened. */
  sealed = false;
  vars: Record<string, string | number> = {};
  pockets: Pocket[];

  constructor(readonly data: GameData, def: ItemDef) {
    this.typeId = def.id;
    this.def = def;
    this.pockets = (def.pocket_data ?? []).map((p) => new Pocket(p, this));
    this.charges = defaultCharges(def);
    this.sealed = !!def.sealed && this.pockets.some((p) => p.type === 'CONTAINER');
  }

  // --- classification ---
  get countByCharges(): boolean {
    return countByCharges(this.def);
  }
  isAmmo(): boolean {
    return hasSubtype(this.def, 'AMMO');
  }
  isGun(): boolean {
    return hasSubtype(this.def, 'GUN');
  }
  isMagazine(): boolean {
    return hasSubtype(this.def, 'MAGAZINE');
  }
  isTool(): boolean {
    return hasSubtype(this.def, 'TOOL');
  }
  isComestible(): boolean {
    return hasSubtype(this.def, 'COMESTIBLE');
  }
  isArmor(): boolean {
    return hasSubtype(this.def, 'ARMOR') || (this.def.armor?.length ?? 0) > 0;
  }
  isBook(): boolean {
    return hasSubtype(this.def, 'BOOK');
  }
  isLiquid(): boolean {
    return this.def.phase === 'liquid';
  }
  isContainer(): boolean {
    return this.pockets.some((p) => p.type === 'CONTAINER');
  }
  hasFlag(f: string): boolean {
    return this.def.flags?.includes(f) ?? false;
  }

  // --- weight & volume ---
  /** Units the def's volume refers to (CDDA stack_size). */
  stackSize(): number {
    return this.def.stack_size ?? Math.max(1, defaultCharges(this.def));
  }
  unitWeight(): number {
    return this.def.weight;
  }
  unitVolume(): number {
    return this.def.volume / this.stackSize();
  }
  /** Grams including contents (item::weight). */
  weight(): number {
    if (this.countByCharges) return this.unitWeight() * this.charges;
    let w = this.def.weight;
    for (const p of this.pockets) w += p.weightUsed();
    return w;
  }
  /** ml including non-rigid pocket contents (item::volume). */
  volume(): number {
    if (this.countByCharges) return Math.ceil(this.unitVolume() * this.charges);
    let v = this.def.volume;
    for (const p of this.pockets) {
      if (p.type === 'MAGAZINE_WELL') {
        const well = toMl(p.data.magazine_well, 0);
        for (const c of p.contents) v += Math.max(0, c.volume() - well);
      } else if (p.type === 'CONTAINER' && !p.data.rigid) {
        v += p.volumeUsed() * (p.data.volume_multiplier ?? 1);
      }
    }
    return v;
  }
  /** CDDA item::count(): charges for stacks, else 1. */
  count(): number {
    return this.countByCharges ? this.charges : 1;
  }

  // --- contents ---
  allContents(): Item[] {
    const out: Item[] = [];
    for (const p of this.pockets) out.push(...p.contents);
    return out;
  }
  /** Depth-first walk over this item and everything inside it. */
  *walk(): Generator<Item> {
    yield this;
    for (const p of this.pockets) for (const c of p.contents) yield* c.walk();
  }
  containerPockets(): Pocket[] {
    return this.pockets.filter((p) => p.type === 'CONTAINER');
  }
  /** Try to store `it` in any container pocket; returns leftover or null. */
  put(it: Item | null): Item | null {
    for (const p of this.containerPockets()) {
      if (!it) return null;
      it = p.insert(it);
    }
    return it;
  }
  canContain(it: Item): FitResult {
    let best: FitResult = { ok: false, reason: this.containerPockets().length ? 'not enough space' : 'not a container' };
    for (const p of this.containerPockets()) {
      const r = p.canContain(it);
      if (r.ok && (!it.countByCharges || (r.charges ?? 0) >= it.charges)) return r;
      if (r.ok) best = r;
      else if (!best.ok) best = r;
    }
    return best;
  }
  /** Remove an item from wherever it is inside this one. */
  removeContent(it: Item): boolean {
    for (const p of this.pockets) {
      if (p.remove(it)) return true;
      for (const c of p.contents) if (c.removeContent(it)) return true;
    }
    return false;
  }
  /** Volume available in container pockets (for "you can't carry that much"). */
  containerVolumeCapacity(): number {
    let v = 0;
    for (const p of this.containerPockets()) v += p.maxVolume;
    return v;
  }
  containerVolumeUsed(): number {
    let v = 0;
    for (const p of this.containerPockets()) v += p.volumeUsed();
    return v;
  }

  // --- stacks ---
  /** item::stacks_with, simplified: same type and state, no contents. */
  stacksWith(o: Item): boolean {
    if (o.typeId !== this.typeId || o.damage !== this.damage || o.active !== this.active) return false;
    if (this.allContents().length || o.allContents().length) return false;
    // CDDA compares rot at hour granularity so fresh food from one batch stacks.
    if (Math.floor(this.rot / 3600) !== Math.floor(o.rot / 3600)) return false;
    return JSON.stringify(this.vars) === JSON.stringify(o.vars);
  }
  /** Merge `o` into this stack if allowed; returns success. */
  merge(o: Item): boolean {
    if (!this.countByCharges || !this.stacksWith(o)) return false;
    this.charges += o.charges;
    o.charges = 0;
    return true;
  }
  /** Split `n` charges into a new item. */
  split(n: number): Item {
    if (!this.countByCharges) throw new Error(`split() on non-charge item ${this.typeId}`);
    if (n <= 0 || n > this.charges) throw new Error(`split(${n}) of ${this.charges} ${this.typeId}`);
    const c = new Item(this.data, this.def);
    c.charges = n;
    c.damage = this.damage;
    c.rot = this.rot;
    c.active = this.active;
    c.vars = { ...this.vars };
    this.charges -= n;
    return c;
  }

  // --- damage ---
  /** 0 intact, 1-4 damaged, 5 destroyed (itype::damage_level). */
  damageLevel(): number {
    if (this.damage === 0) return 0;
    if (this.countByCharges) return 5;
    return Math.max(0, Math.min(5, Math.floor(1 + (4 * this.damage) / MAX_ITEM_DAMAGE)));
  }
  /** Adds damage (clamped); returns true if the item got destroyed. */
  mod_damage(amount: number): boolean {
    this.damage = Math.max(MIN_ITEM_DAMAGE, Math.min(MAX_ITEM_DAMAGE, this.damage + amount));
    return this.damage >= MAX_ITEM_DAMAGE;
  }

  // --- melee (item.cpp damage_melee / attack_time / get_to_hit) ---
  meleeDamage(type: 'bash' | 'cut' | 'stab' | string): number {
    const md = this.def.melee_damage;
    let base = md?.[type] ?? 0;
    if (!md) {
      if (type === 'bash') base = this.def.bashing ?? 0;
      else if (type === 'cut') base = this.def.cutting ?? 0;
    }
    if (!this.countByCharges) base = Math.max(0, base * (1 - 0.1 * Math.max(0, this.damageLevel() - 1)));
    if (type === 'bash' && this.hasFlag('REDUCED_BASHING')) base *= 0.5;
    return base;
  }
  toHit(): number {
    const t = this.def.to_hit;
    if (t === undefined) return 0;
    return typeof t === 'number' ? t : toHitFromAccuracy(t as MeleeAccuracy);
  }
  /** item::attack_time: 65 + (volume/62.5ml + weight/60g) / count. */
  attackTime(): number {
    return Math.floor(65 + (this.volume() / 62.5 + this.weight() / 60) / Math.max(1, this.count()));
  }
  /** Weapon skill used: the damage type with the highest melee damage (item::melee_skill). */
  meleeSkill(): 'bashing' | 'cutting' | 'stabbing' {
    const b = this.meleeDamage('bash'), c = this.meleeDamage('cut'), s = this.meleeDamage('stab');
    if (c > b && c >= s) return 'cutting';
    if (s > b && s > c) return 'stabbing';
    return 'bashing';
  }

  // --- tools ---
  qualityLevel(id: string): number {
    let best = 0;
    for (const [q, l] of this.def.qualities ?? []) if (q === id && l > best) best = l;
    return best;
  }

  // --- guns, magazines, ammo ---
  /** Ammo types this item accepts (gun "ammo", magazine/tool "ammo_type"/"ammo"). */
  ammoTypes(): string[] {
    if (this.isGun() || this.isTool()) return asArray(this.def.ammo ?? (this.def.tool_ammo as string[] | undefined));
    if (this.isMagazine()) return asArray(this.def.ammo_type);
    return [];
  }
  magazineWell(): Pocket | undefined {
    return this.pockets.find((p) => p.type === 'MAGAZINE_WELL');
  }
  magazineCurrent(): Item | undefined {
    return this.magazineWell()?.contents[0];
  }
  magazinePockets(): Pocket[] {
    return this.pockets.filter((p) => p.type === 'MAGAZINE');
  }
  /** Legacy charge tools (max_charges without pockets) keep energy in `charges`. */
  private usesLegacyCharges(): boolean {
    return !this.countByCharges && (this.def.max_charges ?? 0) > 0 && !this.magazineWell() && this.magazinePockets().length === 0;
  }
  ammoRemaining(): number {
    if (this.usesLegacyCharges()) return this.charges;
    let n = 0;
    for (const p of this.magazinePockets()) n += p.ammoCount();
    const mag = this.magazineCurrent();
    if (mag) n += mag.ammoRemaining();
    return n;
  }
  ammoCapacity(): number {
    if (this.usesLegacyCharges()) return this.def.max_charges!;
    let n = 0;
    for (const p of this.magazinePockets()) {
      const loaded = p.contents[0]?.def.ammo_type;
      const lim = p.data.ammo_restriction ?? {};
      n += loaded !== undefined ? (lim[asArray(loaded)[0]] ?? 0) : Math.max(0, ...Object.values(lim));
    }
    const mag = this.magazineCurrent();
    if (mag) n += mag.ammoCapacity();
    return n;
  }
  /** Def of the loaded ammo, if any. */
  ammoData(): ItemDef | undefined {
    for (const p of this.magazinePockets()) if (p.contents[0]) return p.contents[0].def;
    return this.magazineCurrent()?.ammoData();
  }
  /** Removes up to n rounds/charges; returns how many were used. */
  ammoConsume(n: number): number {
    if (this.usesLegacyCharges()) {
      const used = Math.min(n, this.charges);
      this.charges -= used;
      return used;
    }
    let left = n;
    for (const p of this.magazinePockets()) {
      for (const c of [...p.contents]) {
        const take = Math.min(left, c.charges);
        c.charges -= take;
        left -= take;
        if (c.charges <= 0) p.remove(c);
        if (left <= 0) return n;
      }
    }
    const mag = this.magazineCurrent();
    if (mag && left > 0) left -= mag.ammoConsume(left);
    return n - left;
  }
  acceptsMagazine(mag: Item): boolean {
    return this.magazineWell()?.acceptsMagazine(mag) ?? false;
  }
  /** Whether loose `ammo` can be loaded into this item's own MAGAZINE pockets. */
  acceptsAmmo(ammo: Item): boolean {
    return this.magazinePockets().some((p) => p.canContain(ammo).ok);
  }

  /** Ranged damage per shot: ammo + gun bonus, minus 2 per damage level (item::gun_damage). */
  gunDamage(): { type: string; amount: number; armor_penetration: number }[] {
    const out = new Map<string, { type: string; amount: number; armor_penetration: number }>();
    const add = (units: { damage_type: string; amount: number; armor_penetration?: number }[] | undefined) => {
      for (const u of units ?? []) {
        const e = out.get(u.damage_type) ?? { type: u.damage_type, amount: 0, armor_penetration: 0 };
        e.amount += u.amount;
        e.armor_penetration += u.armor_penetration ?? 0;
        out.set(u.damage_type, e);
      }
    };
    add(asArray(this.ammoData()?.damage));
    add(asArray(this.def.ranged_damage));
    const penalty = 2 * Math.max(0, this.damageLevel() - 1);
    return [...out.values()].map((e) => ({ ...e, amount: Math.max(0, e.amount - penalty) }));
  }
  /** Sound of a shot: gun loudness + ammo loudness (ranged.cpp item::gun_noise). */
  gunNoise(burst = false): { volume: number; sound: string } {
    let noise = this.def.loudness ?? 0;
    const ammo = this.ammoData();
    if (ammo) noise += ammoLoudness(ammo);
    noise = Math.max(0, noise);
    if (noise <= 0) return { volume: 0, sound: '' };
    if (noise < 10) return { volume: noise, sound: burst ? 'Brrrip!' : 'plink!' };
    if (noise < 150) return { volume: noise, sound: burst ? 'Brrrap!' : 'bang!' };
    if (noise < 175) return { volume: noise, sound: burst ? 'P-p-p-pow!' : 'blam!' };
    return { volume: noise, sound: burst ? 'Kaboom!' : 'kerblam!' };
  }

  // --- food ---
  spoilTime(): number {
    return toSeconds(this.def.spoils_in, 0);
  }
  goesBad(): boolean {
    return this.isComestible() && this.spoilTime() > 0;
  }
  relativeRot(): number {
    return this.goesBad() ? this.rot / this.spoilTime() : 0;
  }
  rotten(): boolean {
    return this.relativeRot() > 1;
  }
  /** CDDA is_going_bad: past 90% of shelf life. */
  goingBad(): boolean {
    return this.relativeRot() > 0.9;
  }
  /**
   * Advance rot by dt game seconds at tempC (item::calc_rot). Contents of sealed containers
   * use the pocket's spoil multiplier.
   */
  processRot(dt: number, tempC: number, spoilMult = 1): void {
    if (this.goesBad() && this.relativeRot() <= 2) this.rot += (spoilMult * dt * hourlyRotpoints(tempC)) / 3600;
    for (const p of this.pockets) {
      const mult = this.sealed ? (p.data.sealed_data?.spoil_multiplier ?? 1) : (p.data.spoil_multiplier ?? 1);
      for (const c of p.contents) c.processRot(dt, tempC, spoilMult * mult);
    }
  }

  /** Change type in place (CDDA item::convert), e.g. flashlight -> flashlight_on. */
  convert(newId: string): void {
    const def = this.data.items[newId];
    if (!def) throw new Error(`convert: unknown item ${newId}`);
    const old = this.pockets;
    this.def = def;
    this.typeId = newId;
    this.pockets = (def.pocket_data ?? []).map((p) => new Pocket(p, this));
    // Carry contents across pockets of the same kind (e.g. the battery in a flashlight).
    for (const p of old) for (const c of p.contents) {
      const dst = this.pockets.find((q) => q.type === p.type && q.canContain(c).ok);
      if (dst) dst.insert(c);
    }
  }

  // --- display (item_tname.cpp, simplified) ---
  baseName(quantity = 1): string {
    if (quantity !== 1 && this.def.name_plural) return this.def.name_plural;
    return cddaText(this.def.name, quantity !== 1);
  }
  damageAdjective(): string {
    const lvl = this.damageLevel();
    if (this.damage < 0) return this.isGun() ? 'accurized' : 'reinforced';
    if (lvl === 0 || this.countByCharges) return '';
    const mat = this.data.misc?.material?.[this.def.material?.[0] ?? ''];
    const adj = mat?.dmg_adj as unknown[] | undefined;
    const list = adj && adj.length >= 4 ? adj.map((a) => cddaText(a)) : ['lightly damaged', 'damaged', 'very damaged', 'thoroughly damaged'];
    return list[Math.min(lvl, 4) - 1];
  }
  /** CDDA-style display name: "damaged pipe", "9x19mm JHP (50)", "plastic bottle > clean water (2)". */
  name(quantity = 1): string {
    let s = this.baseName(quantity);
    const adj = this.damageAdjective();
    if (adj) s = `${adj} ${s}`;
    if (this.countByCharges && this.charges > 1) s += ` (${this.charges})`;
    else if (this.isMagazine() || this.usesLegacyCharges()) s += ` (${this.ammoRemaining()}${this.isMagazine() ? '/' + this.ammoCapacity() : ''})`;
    else if (this.isGun() && (this.magazineWell() || this.magazinePockets().length)) {
      const cap = this.ammoCapacity();
      if (cap > 0) s += ` (${this.ammoRemaining()}/${cap})`;
    }
    if (this.goesBad()) {
      if (this.rotten()) s += ' (rotten)';
      else if (this.goingBad()) s += ' (old)';
    }
    if (this.active && !this.typeId.endsWith('_on') && !this.goesBad()) s += ' (active)';
    if (this.sealed) s += ' (sealed)';
    if (this.isContainer()) {
      const inner = this.containerPockets().flatMap((p) => p.contents);
      if (inner.length === 1) s += ` > ${inner[0].name()}`;
      else if (inner.length > 1) s += ` > ${inner.length} items`;
    }
    return s;
  }

  // --- serialization ---
  toJSON(): ItemJSON {
    const j: ItemJSON = { typeId: this.typeId };
    if (this.charges) j.charges = this.charges;
    if (this.damage) j.damage = this.damage;
    if (this.rot) j.rot = this.rot;
    if (this.active) j.active = true;
    if (this.sealed) j.sealed = true;
    if (Object.keys(this.vars).length) j.vars = { ...this.vars };
    if (this.pockets.some((p) => !p.empty)) j.pockets = this.pockets.map((p) => p.contents.map((c) => c.toJSON()));
    return j;
  }
  static fromJSON(data: GameData, j: ItemJSON): Item {
    const def = data.items[j.typeId];
    if (!def) throw new Error(`Item.fromJSON: unknown item ${j.typeId}`);
    const it = new Item(data, def);
    it.charges = j.charges ?? 0;
    it.damage = j.damage ?? 0;
    it.rot = j.rot ?? 0;
    it.active = !!j.active;
    it.sealed = !!j.sealed;
    it.vars = { ...(j.vars ?? {}) };
    (j.pockets ?? []).forEach((list, i) => {
      const p = it.pockets[i];
      if (!p) throw new Error(`Item.fromJSON: ${j.typeId} has no pocket #${i}`);
      p.contents = list.map((c) => Item.fromJSON(data, c));
    });
    return it;
  }
}

/** item_factory.cpp: ammo without explicit loudness = range*2 + (damage + ap)*2. */
export function ammoLoudness(ammo: ItemDef): number {
  if (ammo.loudness !== undefined && ammo.loudness >= 0) return ammo.loudness;
  let l = (ammo.range ?? 0) * 2;
  for (const d of asArray(ammo.damage)) l += (d.amount + (d.armor_penetration ?? 0)) * 2;
  return l;
}

/** item_degrade.cpp calc_hourly_rotpoints_at_temp, converted to Celsius input. */
export function hourlyRotpoints(tempC: number): number {
  const f = tempC * 1.8 + 32;
  if (f <= 32) return 0;
  if (f < 38) return 600 * Math.pow(2, -27 / 16) * (f - 32);
  if (f < 105) return 3600 * Math.pow(2, (f - 65) / 16);
  return 3600 * Math.pow(2, (105 - 65) / 16);
}

export interface CreateItemOpts {
  /** Stack size for count-by-charges items (alias of charges). */
  count?: number;
  charges?: number;
  damage?: number;
  /** Fill magazines/guns/tools with this ammo id ('default' = the ammo type's default). */
  ammo?: string;
  /** How many rounds to load with `ammo` (default: full). */
  ammoCount?: number;
}

/** misc.ammunition_type[type].default, e.g. "9mm" -> "9mm", "battery" -> "battery". */
export function defaultAmmoId(data: GameData, ammoType: string): string | undefined {
  return (data.misc?.ammunition_type?.[ammoType]?.default as string | undefined) ?? (data.items[ammoType] ? ammoType : undefined);
}

/**
 * Load up to `n` rounds of `ammoId` into an item: its own MAGAZINE pockets, else the
 * inserted magazine, else its pocket's default_magazine (created). Returns rounds loaded.
 */
export function loadAmmo(it: Item, ammoId: string, n = Infinity): number {
  const data = it.data;
  if (!data.items[ammoId]) {
    warnOnce('item', ammoId);
    return 0;
  }
  const well = it.magazineWell();
  if (well && well.empty && it.magazinePockets().length === 0) {
    const dm = well.data.default_magazine;
    if (dm && data.items[dm]) well.insert(new Item(data, data.items[dm]));
  }
  const cap = it.ammoCapacity() - it.ammoRemaining();
  const want = Math.min(n, cap);
  if (want <= 0) return 0;
  const ammo = new Item(data, data.items[ammoId]);
  ammo.charges = want;
  let left: Item | null = ammo;
  for (const p of it.magazinePockets()) if (left) left = p.insert(left);
  const mag = it.magazineCurrent();
  if (left && mag) for (const p of mag.magazinePockets()) if (left) left = p.insert(left);
  return want - (left?.charges ?? 0);
}

/**
 * Create one item. Throws on unknown ids (callers expanding spawn data should use
 * fromSpawned, which warns and skips instead).
 */
export function createItem(data: GameData, id: string, opts: CreateItemOpts = {}): Item {
  const def = data.items[id];
  if (!def) throw new Error(`createItem: unknown item id "${id}"`);
  const it = new Item(data, def);
  const n = opts.charges ?? opts.count;
  if (n !== undefined) {
    if (!it.countByCharges && !(def.max_charges ?? 0) && opts.count !== undefined && opts.count !== 1)
      throw new Error(`createItem: ${id} is not count-by-charges; create ${opts.count} separate items`);
    if (it.countByCharges || (def.max_charges ?? 0) > 0) it.charges = n;
  }
  if (opts.damage) it.damage = opts.damage;
  if (it.hasFlag('SPAWN_ACTIVE')) it.active = true;
  if (opts.ammo) {
    const ammoId = opts.ammo === 'default' ? defaultAmmoId(data, it.ammoTypes()[0] ?? '') : opts.ammo;
    if (!ammoId) throw new Error(`createItem: no default ammo for ${id}`);
    loadAmmo(it, ammoId, opts.ammoCount);
  }
  return it;
}

/**
 * Turn item-group output (src/data/itemgroups.ts) into Items. Non-stackable items with
 * count > 1 become several Items; stackable ones become one stack. Guns/magazines/tools
 * with `charges` get that much ammo (`ammo` or the type's default), using the pocket's
 * default_magazine when nothing was placed in the well. Loose liquids are put into their
 * default container like CDDA does when spawning on the map.
 */
export function fromSpawned(data: GameData, s: SpawnedItem): Item[] {
  const def = data.items[s.id];
  if (!def) {
    warnOnce('item', s.id);
    return [];
  }
  const out: Item[] = [];
  if (countByCharges(def)) {
    const it = new Item(data, def);
    it.charges = (s.charges ?? defaultCharges(def)) * Math.max(1, s.count);
    if (it.isLiquid() && def.container && data.items[def.container]) {
      const c = new Item(data, data.items[def.container]);
      const left = c.put(it);
      out.push(c);
      if (left) out.push(left); // overflow spills as loose liquid; caller decides
    } else out.push(it);
    return out;
  }
  for (let i = 0; i < Math.max(1, s.count); i++) {
    const it = new Item(data, def);
    if (it.hasFlag('SPAWN_ACTIVE')) it.active = true;
    if (s.contents?.length) {
      // Nothing else sees `it` until it's built, so the pockets can keep running totals.
      for (const p of it.pockets) p.beginBatch();
      try {
        for (const cs of s.contents) {
          for (const c of fromSpawned(data, cs)) {
            const left = placeContent(it, c);
            if (left) warnOnce('fit', `${c.typeId}>${it.typeId}`, `fromSpawned: ${c.typeId} does not fit in ${it.typeId}`);
          }
        }
      } finally {
        for (const p of it.pockets) p.endBatch();
      }
    }
    if (s.charges !== undefined && s.charges > 0) {
      if ((def.max_charges ?? 0) > 0 && !it.magazineWell() && it.magazinePockets().length === 0) it.charges = Math.min(s.charges, def.max_charges!);
      else {
        const ammoId = s.ammo ?? (it.ammoData()?.id || defaultAmmoId(data, it.ammoTypes()[0] ?? ''));
        if (ammoId) loadAmmo(it, ammoId, s.charges);
      }
    }
    out.push(it);
  }
  return out;
}

/** Insert into whichever pocket accepts it (magazine well, magazine, container). */
export function placeContent(into: Item, it: Item): Item | null {
  let left: Item | null = it;
  for (const p of into.pockets) {
    if (!left) break;
    if (p.canContain(left).ok) left = p.insert(left);
  }
  return left;
}
