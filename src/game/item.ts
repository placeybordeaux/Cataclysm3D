import type { GameData, ItemDef } from '../data/types';
import type { MapItem } from '../world/map';
import { ammoCapacity as defAmmoCapacity, chargesPerVolume, defaultAmmo, type SpawnedItem } from '../data/itemgroups';
import { warnOnce } from '../data/warn';
import { cddaText, toMl, toSeconds } from './units';

// Item instances on Cataclysm: Bright Nights' model (item.cpp, item_contents.cpp; see
// docs/BN_DATA_MODEL.md §3 and docs/INVENTORY_MODEL.md). An Item is one ItemDef plus state:
//
//  - charges: the stack size of a count_by_charges item (ammo, food, liquids), or the rounds in
//    a gun/tool's *integral* magazine (with `ammoId`, BN's curammo);
//  - contents: what the item holds. A CONTAINER holds one stack of one type; a holster up to
//    `multi` items; a bandolier or magazine one stack of rounds. Item groups may put other
//    things in anything ("contents-item"), like BN's put_in;
//  - magazine: the detachable magazine inserted into a gun or tool (BN keeps it in contents;
//    a slot of its own keeps "what is loaded" unambiguous);
//  - gunmods: installed gun mods.
//
// Where an item *is* (hands, worn, inventory, inside another item, map tile, vehicle cargo) is
// owned by src/game/moves.ts. The `_contents`/`_magazine`/`_gunmods` fields are the raw slots:
// only this file (factories, splitting, deserialisation) and moves.ts may change them, which
// tests/moves_lint.test.ts checks. Everything else goes through moveItem().

export const MAX_ITEM_DAMAGE = 4000;
export const MIN_ITEM_DAMAGE = -1000;

export type { SpawnedItem };

export interface ItemJSON {
  typeId: string;
  charges?: number;
  /** integral magazine: loaded ammo item id (BN curammo) */
  ammo?: string;
  damage?: number;
  rot?: number;
  active?: boolean;
  vars?: Record<string, string | number>;
  /** per-item flags (FIT, item group custom-flags) */
  flags?: string[];
  contents?: ItemJSON[];
  magazine?: ItemJSON;
  gunmods?: ItemJSON[];
  /** @deprecated pre-BN saves: DDA pocket lists; src/save/items.ts migrates them */
  pockets?: ItemJSON[][];
  /** @deprecated pre-BN saves */
  sealed?: boolean;
}

export function hasSubtype(def: ItemDef, sub: string): boolean {
  return def.type === sub || (def.subtypes?.includes(sub) ?? false);
}

export function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** itype::count_by_charges: stackable, AMMO or COMESTIBLE (the extractor computes it). */
export function countByCharges(def: ItemDef): boolean {
  return !!def.count_by_charges;
}

/** itype::charges_default: tool initial_charges, comestible charges, ammo count; 1 for other stacks. */
export function defaultCharges(def: ItemDef): number {
  if (hasSubtype(def, 'TOOL')) return def.initial_charges ?? 0;
  if (hasSubtype(def, 'COMESTIBLE') && (def.charges ?? 0) > 0) return def.charges!;
  if (hasSubtype(def, 'AMMO') && (def.count ?? 0) > 0) return def.count!;
  return countByCharges(def) ? 1 : 0;
}

/** Charges of `def` fitting in `ml` (item::charges_per_volume); whole items for non-stacks. */
export { chargesPerVolume };

export class Item implements MapItem {
  typeId: string;
  def: ItemDef;
  /** count_by_charges: stack size. Integral-magazine guns/tools: rounds loaded (of ammoId). */
  charges = 0;
  /** BN curammo: ammo item id in an integral magazine (null when empty). */
  ammoId: string | null = null;
  /** -1000 (reinforced) .. 0 (intact) .. 4000 (destroyed), BN damage_. */
  damage = 0;
  /** Accumulated rot in seconds-at-65F equivalents. */
  rot = 0;
  active = false;
  vars: Record<string, string | number> = {};
  /** Flags this item carries on top of its type's (FIT, custom-flags from item groups). */
  flags: string[] = [];
  /** @internal raw slot: item.ts / moves.ts only (tests/moves_lint.test.ts) */
  _contents: Item[] = [];
  /** @internal raw slot: item.ts / moves.ts only */
  _magazine: Item | null = null;
  /** @internal raw slot: item.ts / moves.ts only */
  _gunmods: Item[] = [];

  constructor(readonly data: GameData, def: ItemDef) {
    this.typeId = def.id;
    this.def = def;
    this.charges = defaultCharges(def);
    // A tool that spawns with charges holds its default ammo (item::item -> ammo_set).
    if (this.charges > 0 && !this.countByCharges && this.hasIntegralMagazine()) this.ammoId = defaultAmmo(data, def) ?? null;
  }

  // --- slots (read-only views; change them through src/game/moves.ts)
  get contents(): readonly Item[] {
    return this._contents;
  }
  get magazine(): Item | null {
    return this._magazine;
  }
  get gunmods(): readonly Item[] {
    return this._gunmods;
  }

  // --- classification ---
  get countByCharges(): boolean {
    return this.def.count_by_charges;
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
  /** BN is_container: holds one stack (container_data). */
  isContainer(): boolean {
    return !!this.def.container_data;
  }
  isHolster(): boolean {
    return !!this.def.holster;
  }
  isBandolier(): boolean {
    return !!this.def.bandolier;
  }
  /** BN is_watertight_container: watertight and resealable (carries liquids anywhere). */
  isWatertight(): boolean {
    const c = this.def.container_data;
    return !!c && c.watertight && c.seals;
  }
  /** BN is_bucket: watertight, doesn't seal: liquids stay in only on the ground or in hand. */
  isBucket(): boolean {
    const c = this.def.container_data;
    return !!c && c.watertight && !c.seals && !c.unseals_into;
  }
  /** Something in it (container, holster, bandolier, magazine rounds). */
  hasContents(): boolean {
    return this._contents.length > 0;
  }
  hasFlag(f: string): boolean {
    return (this.def.flags?.includes(f) ?? false) || this.flags.includes(f);
  }

  // --- weight & volume (item::weight / item::volume) ---
  stackSize(): number {
    return Math.max(1, this.def.stack_size ?? 1);
  }
  unitWeight(): number {
    return this.def.weight;
  }
  /** ml of one charge (fractional; the stack's volume rounds up as a whole). */
  unitVolume(): number {
    return this.def.volume / this.stackSize();
  }
  /** Grams including what it holds. */
  weight(): number {
    if (this.countByCharges) return this.unitWeight() * this.charges;
    let w = this.def.weight;
    if (this.isGun()) for (const m of this._gunmods) w *= (m.def.weight_multiplier as number | undefined) ?? 1;
    if (this.ammoId && this.charges > 0 && !this.isMagazine()) w += this.charges * (this.data.items[this.ammoId]?.weight ?? 0);
    if (this.isGun()) for (const m of this._gunmods) w += m.def.integral_weight ?? m.weight();
    if (this._magazine) w += this._magazine.weight();
    for (const c of this._contents) w += c.weight();
    return w;
  }
  /** ml; a soft (non-rigid) item grows by what it holds; a magazine sticks out past the well. */
  volume(): number {
    if (this.countByCharges) return Math.ceil((this.def.volume * this.charges) / this.stackSize());
    let v = this.def.volume;
    if (!this.def.rigid) for (const c of this._contents) v += c.volume();
    if (this._magazine) v += Math.max(0, this._magazine.volume() - (this.def.magazine_well ?? 0));
    if (this.isGun()) {
      for (const m of this._gunmods) v *= (m.def.volume_multiplier as number | undefined) ?? 1;
      for (const m of this._gunmods) v += m.def.integral_volume ?? m.volume();
      v = Math.max(Math.round(v), Math.ceil(this.def.volume / 100));
    }
    return v;
  }
  /** item::count(): charges for stacks, else 1. */
  count(): number {
    return this.countByCharges ? this.charges : 1;
  }

  // --- contents ---
  /** Depth-first walk over this item and everything in it (contents, magazine, gunmods). */
  *walk(): Generator<Item> {
    yield this;
    for (const c of this._contents) yield* c.walk();
    if (this._magazine) yield* this._magazine.walk();
    for (const m of this._gunmods) yield* m.walk();
  }
  /** Everything directly held (contents, magazine, gunmods). */
  allContents(): Item[] {
    return [...this._contents, ...(this._magazine ? [this._magazine] : []), ...this._gunmods];
  }
  /** ml a CONTAINER holds (container_data.contains). */
  containerCapacity(): number {
    return this.def.container_data?.contains ?? 0;
  }

  // --- stacks ---
  /** item::stacks_with: same type and state, nothing inside. */
  stacksWith(o: Item): boolean {
    if (o === this) return false;
    if (o.typeId !== this.typeId || o.damage !== this.damage || o.active !== this.active) return false;
    if (this._contents.length || o._contents.length || this._magazine || o._magazine) return false;
    if (this._gunmods.length || o._gunmods.length) return false;
    if (this.ammoId !== o.ammoId || (!this.countByCharges && this.charges !== o.charges)) return false;
    // Rot compares at hour granularity so fresh food from one batch stacks.
    if (Math.floor(this.rot / 3600) !== Math.floor(o.rot / 3600)) return false;
    if (this.flags.join() !== o.flags.join()) return false;
    return JSON.stringify(this.vars) === JSON.stringify(o.vars);
  }
  /**
   * @internal item.ts / moves.ts: split `n` charges off into a new item. Conserves the total
   * (the new item is not placed anywhere; the caller must put it somewhere).
   */
  _split(n: number): Item {
    if (!this.countByCharges) throw new Error(`split() on non-charge item ${this.typeId}`);
    if (!Number.isInteger(n) || n <= 0 || n > this.charges) throw new Error(`split(${n}) of ${this.charges} ${this.typeId}`);
    const c = new Item(this.data, this.def);
    c.charges = n;
    c.damage = this.damage;
    c.rot = this.rot;
    c.active = this.active;
    c.vars = { ...this.vars };
    c.flags = [...this.flags];
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

  // --- melee (item.cpp damage_melee / attack_cost / get_to_hit) ---
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
    return this.def.to_hit ?? 0;
  }
  /** item::attack_cost: 65 + (volume/62.5ml + weight/60g) / count. */
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

  // --- guns, magazines, ammo (item::ammo_*) ---
  /** Ammunition types this item takes (gun/tool `ammo`, magazine `ammo_type`). */
  ammoTypes(): string[] {
    for (const m of this._gunmods) {
      const mod = m.def.ammo_modifier as string[] | string | undefined;
      if (mod) return asArray(mod);
    }
    if (this.isGun() || this.isTool()) return this.def.ammo ?? [];
    if (this.isMagazine()) return this.def.magazine?.ammo_type ?? asArray(this.def.ammo_type);
    return [];
  }
  /**
   * Magazines this gun/tool takes into its magazine slot (item::magazine_compatible), without
   * speedloaders: those only refill an integral magazine (their rounds are loose ammo to it).
   */
  magazineCompatible(): string[] {
    const out: string[] = [];
    for (const t of this.ammoTypes()) out.push(...(this.def.magazines?.[t] ?? []));
    return [...new Set(out)].filter((id) => !this.data.items[id]?.flags.includes('SPEEDLOADER'));
  }
  /** item::magazine_default for the first ammo type (never a speedloader / stripper clip). */
  magazineDefault(): string | undefined {
    const t = this.ammoTypes()[0];
    const m = t ? this.def.magazine_default?.[t] : undefined;
    return m && !this.data.items[m]?.flags.includes('SPEEDLOADER') ? m : undefined;
  }
  /** item::magazine_integral: rounds sit in the item itself (gun clip_size / tool max_charges, no magazine). */
  hasIntegralMagazine(): boolean {
    if (this.magazineDefault()) return false;
    if (this.isGun()) return (this.def.clip_size ?? 0) > 0;
    if (this.isTool()) return (this.def.max_charges ?? 0) > 0;
    return false;
  }
  /** Takes detachable magazines (a magazine well). */
  takesMagazines(): boolean {
    return this.magazineCompatible().length > 0;
  }
  magazineCurrent(): Item | null {
    return this._magazine;
  }
  acceptsMagazine(mag: Item): boolean {
    return mag.isMagazine() && this.magazineCompatible().includes(mag.typeId);
  }
  /** Can loose rounds of `ammo` go straight into this item (integral magazine, magazine, bandolier)? */
  acceptsAmmo(ammo: Item): boolean {
    if (!ammo.isAmmo()) return false;
    const t = asArray(ammo.def.ammo_type)[0];
    if (this.isBandolier()) return this.def.bandolier!.ammo.includes(t ?? '');
    if (this.isMagazine() || this.hasIntegralMagazine()) return this.ammoTypes().includes(t ?? '');
    return false;
  }
  ammoRemaining(): number {
    if (this._magazine) return this._magazine.ammoRemaining();
    if (this.isMagazine() || this.isBandolier()) {
      let n = 0;
      for (const c of this._contents) n += c.charges;
      return n;
    }
    if (this.isTool() || this.isGun()) return this.charges;
    return 0;
  }
  ammoCapacity(): number {
    if (this._magazine) return this._magazine.ammoCapacity();
    if (this.isBandolier()) return this.def.bandolier!.capacity;
    let res = defAmmoCapacity(this.def);
    if (this.isGun() || this.isTool()) for (const m of this._gunmods) res *= (m.def.capacity_multiplier as number | undefined) ?? 1;
    return Math.floor(res);
  }
  /** Def of the loaded ammo, if any (item::ammo_data). */
  ammoData(): ItemDef | undefined {
    if (this._magazine) return this._magazine.ammoData();
    if (this.isAmmo()) return this.def;
    if (this.isMagazine() || this.isBandolier()) return this._contents[0]?.def;
    return this.ammoId ? this.data.items[this.ammoId] : undefined;
  }
  /**
   * Fire/use up to n rounds or charges (item::ammo_consume). This destroys them: it is an
   * explicit consumption, not a move. Returns how many were used.
   */
  ammoConsume(n: number): number {
    if (n < 0) throw new Error(`ammoConsume(${n}) on ${this.typeId}`);
    if (this._magazine) return this._magazine.ammoConsume(n);
    if (this.isMagazine() || this.isBandolier()) {
      let need = n;
      while (need > 0 && this._contents.length) {
        const e = this._contents[0];
        if (need >= e.charges) {
          need -= e.charges;
          this._contents.shift();
        } else {
          e.charges -= need;
          need = 0;
        }
      }
      return n - need;
    }
    if (this.isTool() || this.isGun()) {
      const q = Math.min(n, this.charges);
      this.charges -= q;
      if (this.charges === 0) this.ammoId = null;
      return q;
    }
    return 0;
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
    for (const m of this._gunmods) {
      noise += (m.def.loudness_modifier as number | undefined) ?? 0;
      noise *= (m.def.loudness_multiplier as number | undefined) ?? 1;
    }
    noise = Math.max(0, Math.trunc(noise));
    // Launchers, bows and crossbows have their own sounds whatever their loudness.
    const at = new Set(this.ammoTypes());
    if (at.has('40x46mm') || at.has('40x53mm')) return { volume: 8, sound: 'Thunk!' };
    if (at.has('12mm') || at.has('metal_rail')) return { volume: 24, sound: 'tz-CRACKck!' };
    if (['flammable', '66mm', '120mm', '84x246mm', 'm235', 'atgm', 'RPG-7', 'homebrew_rocket'].some((a) => at.has(a))) return { volume: 4, sound: 'Fwoosh!' };
    if (at.has('arrow')) return { volume: noise, sound: 'whizz!' };
    if (at.has('strange_arrow')) return { volume: noise, sound: 'Crack!' };
    if (at.has('bolt') || at.has('bolt_ballista')) return { volume: noise, sound: 'thonk!' };
    if (at.has('atlatl')) return { volume: noise, sound: 'swoosh!' };
    const fx = new Set([...asArray(ammo?.effects as string[] | undefined), ...asArray(this.def.ammo_effects as string[] | undefined)]);
    if (fx.has('LASER') || fx.has('PLASMA')) return { volume: noise, sound: noise < 20 ? 'Fzzt!' : noise < 40 ? 'Pew!' : noise < 60 ? 'Tsewww!' : 'Kra-kow!' };
    if (fx.has('LIGHTNING')) return { volume: noise, sound: noise < 20 ? 'Bzzt!' : noise < 40 ? 'Bzap!' : noise < 60 ? 'Bzaapp!' : 'Kra-koom!' };
    if (fx.has('WHIP')) return { volume: noise, sound: 'Crack!' };
    if (fx.has('LIQUID')) return { volume: noise, sound: 'Splash!' };
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
  /** BN is_going_bad: past 90% of shelf life. */
  goingBad(): boolean {
    return this.relativeRot() > 0.9;
  }
  /**
   * Advance rot by dt game seconds at tempC (item::calc_rot). Contents of a container that
   * `preserves` (sealed cans, jars) don't rot.
   */
  processRot(dt: number, tempC: number): void {
    if (this.goesBad() && this.relativeRot() <= 2) this.rot += (dt * hourlyRotpoints(tempC)) / 3600;
    if (this.def.container_data?.preserves) return;
    for (const c of this._contents) c.processRot(dt, tempC);
  }

  /** Change type in place (item::convert), e.g. flashlight -> flashlight_on. Keeps what it holds. */
  convert(newId: string): void {
    const def = this.data.items[newId];
    if (!def) throw new Error(`convert: unknown item ${newId}`);
    this.def = def;
    this.typeId = newId;
  }

  // --- display (item::tname / display_name, simplified) ---
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
  /**
   * BN display name: "damaged pipe", "9x19mm JHP (50)", "Glock 19 (12/15)",
   * "clean water (plastic bottle) (2/2)", "holster with 2 items".
   */
  name(quantity = 1): string {
    let s = this.label(quantity);
    let amt = '';
    const inner = this._contents;
    if (this.isContainer() && inner.length === 1) {
      const c = inner[0];
      s = `${c.label(c.count())} (${s})`;
      if (c.countByCharges) amt = ` (${c.charges}/${c.charges + Math.max(0, containerRoomFor(this, c))})`;
    } else if (inner.length && !this.isMagazine() && !this.isBandolier()) {
      const stacks = inner.length;
      s = `${s} with ${stacks} item${stacks === 1 ? '' : 's'}`;
    } else if (this.ammoCapacity() > 0 && (this.isGun() || this.isTool() || this.isMagazine() || this.isBandolier())) {
      amt = ` (${this.ammoRemaining()}/${this.ammoCapacity()})`;
    } else if (this.countByCharges && this.charges > 1) amt = ` (${this.charges})`;
    return s + amt;
  }
  /** The name without amounts: "damaged pipe", "canned beans (old)". */
  label(quantity = 1): string {
    let s = this.baseName(quantity);
    const adj = this.damageAdjective();
    if (adj) s = `${adj} ${s}`;
    if (this.goesBad()) {
      if (this.rotten()) s += ' (rotten)';
      else if (this.goingBad()) s += ' (old)';
    }
    if (this.active && !this.typeId.endsWith('_on') && !this.goesBad()) s += ' (active)';
    return s;
  }

  // --- serialization ---
  toJSON(): ItemJSON {
    const j: ItemJSON = { typeId: this.typeId };
    if (this.charges) j.charges = this.charges;
    if (this.ammoId) j.ammo = this.ammoId;
    if (this.damage) j.damage = this.damage;
    if (this.rot) j.rot = this.rot;
    if (this.active) j.active = true;
    if (Object.keys(this.vars).length) j.vars = { ...this.vars };
    if (this.flags.length) j.flags = [...this.flags];
    if (this._contents.length) j.contents = this._contents.map((c) => c.toJSON());
    if (this._magazine) j.magazine = this._magazine.toJSON();
    if (this._gunmods.length) j.gunmods = this._gunmods.map((m) => m.toJSON());
    return j;
  }
  /** Rebuild from toJSON output. Unknown ids throw: src/save/items.ts sanitizes first. */
  static fromJSON(data: GameData, j: ItemJSON): Item {
    const def = data.items[j.typeId];
    if (!def) throw new Error(`Item.fromJSON: unknown item ${j.typeId}`);
    if (j.pockets) throw new Error(`Item.fromJSON: ${j.typeId} has DDA pockets; migrate with src/save/items.ts`);
    const it = new Item(data, def);
    it.charges = j.charges ?? 0;
    it.ammoId = j.ammo ?? null;
    it.damage = j.damage ?? 0;
    it.rot = j.rot ?? 0;
    it.active = !!j.active;
    it.vars = { ...(j.vars ?? {}) };
    it.flags = [...(j.flags ?? [])];
    it._contents = (j.contents ?? []).map((c) => Item.fromJSON(data, c));
    it._magazine = j.magazine ? Item.fromJSON(data, j.magazine) : null;
    it._gunmods = (j.gunmods ?? []).map((m) => Item.fromJSON(data, m));
    return it;
  }
}

/**
 * Units of `it` (charges for stacks, whole items otherwise) a CONTAINER can still take: one
 * type per container ("You can't mix loads"), liquids only if watertight, up to its volume
 * (item::get_remaining_capacity_for_liquid / charges_per_volume). Location rules (sealing,
 * buckets, soft containers growing into carrying space) are applied by moves.ts. Returns 0 when
 * it can't take any; see containerRefusal for the reason.
 */
export function containerRoomFor(container: Item, it: Item): number {
  return containerRefusal(container, it) ? 0 : containerRoomRaw(container, it);
}

function containerRoomRaw(container: Item, it: Item): number {
  const cap = container.containerCapacity();
  const inside = container.contents;
  if (it.countByCharges) {
    const total = chargesPerVolume(it.def, cap);
    return Math.max(0, total - (inside[0]?.charges ?? 0));
  }
  let used = 0;
  for (const c of inside) used += c.volume();
  return Math.max(0, Math.floor((cap - used) / Math.max(1, it.volume())));
}

/** Why a CONTAINER can't take `it` at all (null: it can, maybe not all of it). */
export function containerRefusal(container: Item, it: Item): string | null {
  const cd = container.def.container_data;
  if (!cd) return `The ${container.baseName()} can't hold anything.`;
  if (it === container) return "You can't put something inside itself.";
  if (it.isLiquid() && !cd.watertight) return `That ${container.baseName()} isn't water-tight.`;
  const inside = container.contents;
  if (inside.length && (inside[0].typeId !== it.typeId || (it.countByCharges && !inside[0].stacksWith(it) && !sameLoad(inside[0], it))))
    return `You can't mix loads in your ${container.baseName()}.`;
  if (containerRoomRaw(container, it) <= 0) return `Your ${container.baseName()} can't hold any more ${it.baseName(2)}.`;
  return null;
}

/** Liquids and food of one type merge in a container even when their rot differs (weighted rot). */
function sameLoad(a: Item, b: Item): boolean {
  return a.typeId === b.typeId && a.damage === b.damage && a.active === b.active && !a.hasContents() && !b.hasContents();
}

/** Why a holster can't take `obj` (holster_actor::can_holster / store), or null. */
export function holsterRefusal(holster: Item, obj: Item): string | null {
  const h = holster.def.holster;
  if (!h) return `The ${holster.baseName()} isn't a holster.`;
  if (obj === holster) return "You can't put something inside itself.";
  if (holster.contents.length >= h.multi) return `Your ${holster.baseName()} is full.`;
  // (min_volume can still be a "250ml" string in extracted data)
  if (obj.volume() > toMl(h.max_volume)) return `Your ${obj.baseName()} is too big to fit in your ${holster.baseName()}.`;
  if (obj.volume() < toMl(h.min_volume)) return `Your ${obj.baseName()} is too small to fit in your ${holster.baseName()}.`;
  if (h.max_weight > 0 && obj.weight() > h.max_weight) return `Your ${obj.baseName()} is too heavy to fit in your ${holster.baseName()}.`;
  if (obj.active) return `You don't think putting your ${obj.baseName()} in your ${holster.baseName()} is a good idea.`;
  const skill = obj.isGun() ? (obj.def.skill ?? '') : '';
  if (!h.flags.some((f) => obj.hasFlag(f)) && !(skill && h.skills.includes(skill))) return `You can't put your ${obj.baseName()} in your ${holster.baseName()}.`;
  return null;
}

/** Rounds of `ammo` a bandolier / magazine / integral magazine can still take, and why not. */
export function ammoRoom(host: Item, ammo: Item): { room: number; why?: string } {
  if (!ammo.isAmmo()) return { room: 0, why: `The ${ammo.baseName()} isn't ammunition.` };
  if (!host.acceptsAmmo(ammo)) return { room: 0, why: `You can't load ${ammo.baseName(2)} into your ${host.baseName()}.` };
  const loaded = host.ammoData();
  if (host.ammoRemaining() > 0 && loaded && loaded.id !== ammo.typeId) return { room: 0, why: `You can't mix loads in your ${host.baseName()}.` };
  const room = host.ammoCapacity() - host.ammoRemaining();
  if (room <= 0) return { room: 0, why: `Your ${host.baseName()} is already fully loaded!` };
  return { room };
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

// ------------------------------------------------------------------ creation
// Everything below *creates* items (spawning, crafting results, debug). Creation is one of the
// two places the conservation invariant allows quantity to appear (the other side being
// explicit consumption); see docs/INVENTORY_MODEL.md.

export interface CreateItemOpts {
  /** Stack size for count-by-charges items (alias of charges). */
  count?: number;
  charges?: number;
  damage?: number;
  /** Fill magazines/guns/tools with this ammo id ('default' = the item's default ammo). */
  ammo?: string;
  /** How many rounds to load with `ammo` (default: full). */
  ammoCount?: number;
}

/** misc.ammunition_type[type].default, e.g. "9mm" -> "9mm", "battery" -> "battery". */
export function defaultAmmoId(data: GameData, ammoType: string): string | undefined {
  return (data.misc?.ammunition_type?.[ammoType]?.default as string | undefined) ?? (data.items[ammoType] ? ammoType : undefined);
}

/**
 * Spawn-time loading: create up to `n` rounds of `ammoId` inside `it` (its integral magazine,
 * its magazine's contents, a bandolier), inserting the default magazine into an empty
 * magazine-fed gun or tool first. Creates the rounds out of nothing: only for new items (item
 * groups, NPC kits, debug), never for reloading, which moves real rounds (moves.ts).
 */
export function loadAmmo(it: Item, ammoId: string, n = Infinity): number {
  const data = it.data;
  const adef = data.items[ammoId];
  if (!adef) {
    warnOnce('item', ammoId);
    return 0;
  }
  if (!it._magazine && it.takesMagazines() && !it.isMagazine()) {
    const dm = it.magazineDefault() ?? it.magazineCompatible()[0];
    if (dm && data.items[dm]) it._magazine = new Item(data, data.items[dm]);
  }
  const host = it._magazine ?? it;
  const probe = new Item(data, adef);
  probe.charges = 1;
  if (!host.acceptsAmmo(probe) && !(host.isTool() && host.hasIntegralMagazine())) return 0;
  const cur = host.ammoData();
  if (host.ammoRemaining() > 0 && cur && cur.id !== ammoId) return 0;
  const want = Math.max(0, Math.min(n, host.ammoCapacity() - host.ammoRemaining()));
  if (want <= 0) return 0;
  if (host.isMagazine() || host.isBandolier()) {
    if (host._contents[0]) host._contents[0].charges += want;
    else {
      probe.charges = want;
      host._contents.push(probe);
    }
  } else {
    host.charges += want;
    host.ammoId = ammoId;
  }
  return want;
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
    if (it.countByCharges) it.charges = n;
    else if (it.hasIntegralMagazine() || (def.max_charges ?? 0) > 0) {
      it.charges = n;
      if (n > 0 && !it.ammoId) it.ammoId = defaultAmmo(data, def) ?? null;
      if (n === 0) it.ammoId = null;
    } else if (opts.count !== undefined && opts.count !== 1) throw new Error(`createItem: ${id} is not count-by-charges; create ${opts.count} separate items`);
  }
  if (opts.damage) it.damage = opts.damage;
  if (it.hasFlag('SPAWN_ACTIVE')) it.active = true;
  if (def.magazine && def.magazine.count > 0 && def.magazine.default_ammo && opts.ammo === undefined) loadAmmo(it, def.magazine.default_ammo, def.magazine.count);
  if (opts.ammo) {
    const ammoId = opts.ammo === 'default' ? defaultLoad(it) : opts.ammo;
    if (!ammoId) throw new Error(`createItem: no default ammo for ${id}`);
    loadAmmo(it, ammoId, opts.ammoCount);
  }
  return it;
}

/** The ammo a fresh gun/tool/magazine is loaded with: its (default magazine's) default ammo. */
export function defaultLoad(it: Item): string | undefined {
  const data = it.data;
  const magId = it.magazine?.typeId ?? it.magazineDefault();
  const magDef = magId ? data.items[magId] : undefined;
  return defaultAmmo(data, magDef ?? it.def) ?? defaultAmmoId(data, it.ammoTypes()[0] ?? '');
}

/**
 * Wrap a new item in `containerId` as item groups and crafting do (item::in_container). Liquids
 * and stacks fill it to capacity; what doesn't fit is returned as `rest`.
 */
export function inNewContainer(data: GameData, it: Item, containerId: string): { container: Item; rest: Item | null } {
  const cdef = data.items[containerId];
  if (!cdef) throw new Error(`inNewContainer: unknown container ${containerId}`);
  const c = new Item(data, cdef);
  if (!cdef.container_data) {
    // BN put_in: anything can hold spawned contents
    c._contents.push(it);
    return { container: c, rest: null };
  }
  const room = containerRoomRaw(c, it);
  if (it.countByCharges) {
    if (room <= 0) return { container: c, rest: it };
    if (room >= it.charges) {
      c._contents.push(it);
      return { container: c, rest: null };
    }
    c._contents.push(it._split(room));
    return { container: c, rest: it };
  }
  c._contents.push(it);
  return { container: c, rest: null };
}

/**
 * Turn item-group output (src/data/itemgroups.ts) into Items. Non-stackable items with
 * count > 1 become several Items; stackable ones become one stack. `contents` go into the
 * item: a compatible magazine into the magazine slot, everything else into its contents.
 * Guns, tools and magazines with `charges` get that many rounds of `ammo` (or the default).
 * A loose liquid at the top level goes into its default container, as many as it takes (BN
 * map::spawn_item -> item::in_its_container); inside an explicit container it stays as given.
 */
export function fromSpawned(data: GameData, s: SpawnedItem, topLevel = true): Item[] {
  const def = data.items[s.id];
  if (!def) {
    warnOnce('item', s.id);
    return [];
  }
  const out: Item[] = [];
  const apply = (it: Item) => {
    if (s.damage) it.damage = Math.max(MIN_ITEM_DAMAGE, Math.min(MAX_ITEM_DAMAGE, s.damage));
    if (s.active || it.hasFlag('SPAWN_ACTIVE')) it.active = true;
    if (s.flags?.length) it.flags = [...new Set([...it.flags, ...s.flags])];
    if (s.snippet) it.vars.snippet = s.snippet;
  };
  if (countByCharges(def)) {
    const it = new Item(data, def);
    it.charges = (s.charges ?? defaultCharges(def)) * Math.max(1, s.count);
    if (it.charges <= 0) return [];
    apply(it);
    if (topLevel && it.isLiquid() && def.container && data.items[def.container]?.container_data) {
      let left: Item | null = it;
      for (let guard = 0; left && guard < 100; guard++) {
        const w = inNewContainer(data, left, def.container);
        if (!w.container.hasContents()) break;
        out.push(w.container);
        left = w.rest;
      }
      if (left) out.push(left);
      return out;
    }
    out.push(it);
    return out;
  }
  for (let i = 0; i < Math.max(1, s.count); i++) {
    const it = new Item(data, def);
    apply(it);
    for (const cs of s.contents ?? []) {
      for (const c of fromSpawned(data, cs, false)) {
        if (!it._magazine && c.isMagazine() && it.acceptsMagazine(c)) it._magazine = c;
        else it._contents.push(c);
      }
    }
    if (s.charges !== undefined && s.charges > 0) {
      if (it.isMagazine() || it.hasIntegralMagazine() || it.isBandolier()) {
        const ammoId = s.ammo ?? it.ammoData()?.id ?? defaultAmmo(data, def) ?? defaultAmmoId(data, it.ammoTypes()[0] ?? '');
        if (ammoId) loadAmmo(it, ammoId, s.charges);
      } else if (it.isTool()) it.charges = Math.min(s.charges, def.max_charges ?? s.charges);
    }
    out.push(it);
  }
  return out;
}
