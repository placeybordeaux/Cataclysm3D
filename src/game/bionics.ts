import type { GameData } from '../data/types';
import { BODY_PARTS, isBodyPart, MAIN_PARTS, type BodyPartId, type MainPartId } from './bodyparts';
import type { Character } from './character';
import { createItem, type Item } from './item';
import { cddaText } from './units';

// Compact Bionic Modules (CDDA bionics.cpp / bionics.json). Data-driven core:
//   - power storage (`capacity`, kJ), activation/upkeep/trigger costs (act_cost, react_cost
//     every `time` s, trigger_cost), `occupied_bodyparts` slot capacity (body_part
//     bionic_slots), `enchantments` (ALWAYS / ACTIVE), `active_flags`, `protec` armor,
//     `encumbrance`, `fake_weapon` (wielded while active), `passive_pseudo_items` /
//     `toggled_pseudo_items` (tool qualities for crafting), `mutation_conflicts`,
//     `required_bionic`, `included_bionics`, `fuel_options` power sources.
//   - installation: Character::bionics_pl_skill / bionics_adjusted_skill / bionic_manip_cos
//     success chance and bionics_install_failure consequences (pain, faulty CBM, damage).
// Hardcoded behaviour (what JSON can't express) for the common CBMs: battery / metabolic /
// torsion-ratchet power generation, painkiller, repair nanobots, Power Overload weakness,
// flashlight light and night vision (via the vision hooks in src/game/vision.ts).
// Units: power in kJ (the extractor converts "0.5 J" to 0.0005), time in game seconds.

export interface BionicDef {
  id: string;
  name?: string | { str: string };
  description?: string;
  occupied_bodyparts?: [string, number][];
  capacity?: number;
  dupes_allowed?: boolean;
  act_cost?: number;
  deact_cost?: number;
  react_cost?: number;
  trigger_cost?: number;
  /** Seconds between upkeep charges (CDDA charge_time); 0 = no upkeep. */
  time?: number;
  flags?: string[];
  active_flags?: string[];
  fake_weapon?: string;
  passive_pseudo_items?: string[];
  toggled_pseudo_items?: string[];
  enchantments?: ({ condition?: unknown; values?: { value: string; add?: number; multiply?: number }[] } | string)[];
  protec?: [string, Record<string, number>][];
  encumbrance?: [string, number][];
  fuel_options?: string[];
  fuel_efficiency?: number;
  passive_fuel_efficiency?: number;
  mutation_conflicts?: string[];
  canceled_mutations?: string[];
  required_bionic?: string;
  upgraded_bionic?: string;
  available_upgrades?: string[];
  included_bionics?: string[];
  included?: boolean;
  auto_deactivates?: string[];
  activated_on_install?: boolean;
}

export interface InstalledBionic {
  id: string;
  powered: boolean;
  /** Seconds until the next upkeep/fuel tick. */
  chargeTimer: number;
  /** Installed as part of another bionic (included_bionics): not removable/listed alone. */
  included?: boolean;
}

export interface BionicStateJSON {
  bionics: InstalledBionic[];
  power: number;
}

export interface InstallResult {
  ok: boolean;
  /** Success chance in percent (bionic_manip_cos). */
  chance: number;
  /** chance - rng(0, 99): > 0 succeeds; the failure level derives from how far below. */
  success: number;
  /** bionics_install_failure fail_type (0 = no incident … 5 = damaged body parts). */
  failType?: number;
  messages: string[];
  /** Faulty CBM installed by a botched operation. */
  faulty?: string;
  /** The CBM is returned (used, needs re-sterilizing) — caller drops it on the ground. */
  dropCbm?: boolean;
}

/** Bionics that turn "fuel" into power: CDDA fuel_options, handled in burnFuel(). */
const POWER_SOURCE_FUELS = new Set(['battery', 'metabolism', 'muscle']);

export class BionicIndex {
  readonly defs = new Map<string, BionicDef>();
  readonly faulty: string[] = [];
  /** body part id → bionic slot count (body_part.bionic_slots). */
  readonly slots = new Map<string, number>();

  constructor(readonly data: GameData) {
    for (const b of Object.values((data.misc?.bionic ?? {}) as Record<string, BionicDef>)) {
      this.defs.set(b.id, b);
      if (b.flags?.includes('BIONIC_FAULTY')) this.faulty.push(b.id);
    }
    for (const bp of Object.values((data.misc?.body_part ?? {}) as Record<string, { id: string; bionic_slots?: number }>))
      if (bp.bionic_slots !== undefined) this.slots.set(bp.id, bp.bionic_slots);
  }
  def(id: string): BionicDef | undefined {
    return this.defs.get(id);
  }
  name(id: string): string {
    return cddaText(this.defs.get(id)?.name) || id;
  }
  /** CBM item difficulty (islot_bionic difficulty). */
  difficulty(itemId: string): number {
    return Number(this.data.items[itemId]?.difficulty ?? 0);
  }
  isCbm(it: Item): boolean {
    return it.def.subtypes?.includes('BIONIC_ITEM') || it.def.type === 'BIONIC_ITEM';
  }
}

const indices = new WeakMap<GameData, BionicIndex>();
export function bionicIndex(data: GameData): BionicIndex {
  let i = indices.get(data);
  if (!i) indices.set(data, (i = new BionicIndex(data)));
  return i;
}

/** bionic_manip_cos: 50% when adjusted skill == 4 * difficulty, ~80% ceiling for hard CBMs. */
export function bionicManipCos(adjustedSkill: number, difficulty: number): number {
  if (difficulty <= 0) return 100;
  const p = adjustedSkill / (4 * difficulty);
  if (p <= 0) return 0;
  return Math.trunc((100 * p) / (p + Math.sqrt(1 / p)));
}

/** Character::bionics_pl_skill: int*4 + most*4 + important*3 + least*1 (+profession bonuses). */
export function bionicsPlSkill(c: Character, autodoc: boolean): number {
  const [most, important, least] = autodoc ? ['firstaid', 'computer', 'electronics'] : ['electronics', 'firstaid', 'mechanics'];
  let pl = c.int * 4 + c.getSkill(most) * 4 + c.getSkill(important) * 3 + c.getSkill(least);
  if (c.hasTrait('PROF_MED')) pl += 3;
  if (c.hasTrait('PROF_AUTODOC')) pl += 7;
  return Math.round(pl);
}

/** Character::bionics_adjusted_skill (no "assisted" effect or surgery furniture bonus). */
export function bionicsAdjustedSkill(pl: number): number {
  return pl - Math.min(40, pl - pl / 10);
}

export function bionicSuccessChance(c: Character, autodoc: boolean, difficulty: number): number {
  return bionicManipCos(bionicsAdjustedSkill(bionicsPlSkill(c, autodoc)), difficulty);
}

export class BionicState {
  readonly idx: BionicIndex;
  bionics: InstalledBionic[] = [];
  /** Stored bionic power, kJ. */
  power = 0;
  /** Messages to the owner. */
  private msg(t: string, color?: string) {
    this.c.msg(t, color);
  }
  private acc = 0;
  private pseudoCache: { key: string; items: Item[] } = { key: '', items: [] };
  /** Called after install/remove/toggle so views can refresh. */
  onChanged: (() => void) | null = null;

  constructor(readonly c: Character) {
    this.idx = bionicIndex(c.data);
  }

  // ------------------------------------------------------------------ queries
  has(id: string): boolean {
    return this.bionics.some((b) => b.id === id);
  }
  isActive(id: string): boolean {
    return this.bionics.some((b) => b.id === id && b.powered);
  }
  def(id: string): BionicDef | undefined {
    return this.idx.def(id);
  }
  name(id: string): string {
    return this.idx.name(id);
  }
  /** Character::get_max_power_level: sum of capacity. */
  maxPower(): number {
    let n = 0;
    for (const b of this.bionics) n += this.def(b.id)?.capacity ?? 0;
    return n;
  }
  modPower(kj: number): void {
    this.power = Math.max(0, Math.min(this.maxPower(), this.power + kj));
  }
  /** Active flags of powered bionics plus passive flags (e.g. WATCH, GLARE_RESIST). */
  hasFlag(flag: string): boolean {
    for (const b of this.bionics) {
      const d = this.def(b.id);
      if (!d) continue;
      if (d.flags?.includes(flag)) return true;
      if (b.powered && d.active_flags?.includes(flag)) return true;
    }
    return false;
  }
  /** Toggled/activated bionics (shown with a key in the menu). */
  activatable(b: InstalledBionic): boolean {
    const d = this.def(b.id);
    if (!d) return false;
    return !!(d.flags?.includes('BIONIC_TOGGLED') || d.act_cost || d.fake_weapon || d.toggled_pseudo_items?.length);
  }

  // ------------------------------------------------------------------ slots
  slotsUsed(bp: string): number {
    let n = 0;
    for (const b of this.bionics) for (const [p, k] of this.def(b.id)?.occupied_bodyparts ?? []) if (p === bp) n += k;
    return n;
  }
  slotsMax(bp: string): number {
    return this.idx.slots.get(bp) ?? 0;
  }
  /** Character::bionic_installation_issues: parts lacking room → slots still needed. */
  installationIssues(id: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const [bp, need] of this.def(id)?.occupied_bodyparts ?? []) {
      const free = this.slotsMax(bp) - this.slotsUsed(bp);
      if (need > free) out.set(bp, need - free);
    }
    return out;
  }

  /** Character::is_installable (+ slot room): null when the CBM can go in. */
  installBlocker(it: Item | string): string | null {
    const itemId = typeof it === 'string' ? it : it.typeId;
    const id = itemId;
    const d = this.def(id);
    if (!d) return `${itemId} is not a bionic module.`;
    if (typeof it !== 'string' && it.vars.cbm_salvaged) return 'CBM already deployed.  Please reset to factory state.';
    if (this.has(id) && !d.dupes_allowed) return 'CBM is already installed.';
    if ((d.mutation_conflicts ?? []).some((m) => this.c.hasTrait(m))) return "CBM not compatible with patient's body.";
    if (d.required_bionic && !this.has(d.required_bionic)) return `CBM requires prior installation of ${this.name(d.required_bionic)}.`;
    if ((d.available_upgrades ?? []).some((u) => this.has(u))) return 'Superior version installed.';
    const issues = this.installationIssues(id);
    if (issues.size) {
      return 'Not enough space for bionic installation!' + [...issues].map(([bp, n]) => ` ${partName(bp)}: ${n} more slot(s) needed.`).join('');
    }
    return null;
  }

  // ------------------------------------------------------------------ anesthesia
  /** requirement "anesthetic" (6 charges) × difficulty × 2 × bodyweight/10 kg. */
  anesthesiaNeeded(itemId: string): number {
    const weight = Math.floor(this.c.bodyweightKg() / 10);
    return 6 * this.idx.difficulty(itemId) * 2 * weight;
  }
  /** Anesthetic charges carried in anesthesia kits. */
  anesthesiaAvailable(): number {
    let n = 0;
    for (const it of this.c.inv.allItems()) if (it.qualityLevel('ANESTHESIA') > 0) n += it.ammoRemaining();
    return n;
  }
  /** Sensory Dulling or pain immunity make anesthesia unnecessary (has_enough_anesth). */
  needsAnesthesia(): boolean {
    return !this.has('bio_painkiller') && !this.c.hasTrait('NOPAIN');
  }
  consumeAnesthesia(n: number): void {
    for (const it of this.c.inv.allItems()) {
      if (n <= 0) return;
      if (it.qualityLevel('ANESTHESIA') <= 0) continue;
      n -= it.ammoConsume(Math.min(n, it.ammoRemaining()));
    }
  }

  // ------------------------------------------------------------------ install / remove
  successChance(itemId: string, autodoc: boolean): number {
    if (this.c.hasTrait('DEBUG_BIONICS')) return 100;
    return bionicSuccessChance(this.c, autodoc, this.idx.difficulty(itemId));
  }

  /**
   * Roll an installation (Character::install_bionics + perform_install). Practices skills
   * for self-installs, applies success or bionics_install_failure. `roll` overrides
   * rng(0, 99) for tests. The caller consumes the CBM item and places dropCbm on the map.
   */
  install(itemId: string, opts: { autodoc?: boolean; roll?: number } = {}): InstallResult {
    const autodoc = !!opts.autodoc;
    const difficulty = this.idx.difficulty(itemId);
    const chance = this.successChance(itemId, autodoc);
    if (!autodoc) {
      this.c.practice('electronics', Math.trunc((100 - chance) * 1.5));
      this.c.practice('firstaid', Math.trunc(100 - chance));
      this.c.practice('mechanics', Math.trunc((100 - chance) * 0.5));
    }
    const success = chance - (opts.roll ?? this.c.rng.int(0, 99));
    const messages: string[] = [];
    const say = (t: string, col?: string) => (messages.push(t), this.msg(t, col));
    if (success > 0) {
      const d = this.def(itemId)!;
      const up = d.upgraded_bionic && this.has(d.upgraded_bionic) ? d.upgraded_bionic : null;
      if (up) {
        this.remove(up);
        say(`Successfully upgraded ${this.name(up)} to ${this.name(itemId)}.`, 'c_light_green');
      } else say(`Successfully installed ${this.name(itemId)}.`, 'c_light_green');
      this.add(itemId);
      for (const m of d.canceled_mutations ?? []) if (this.c.hasTrait(m)) this.cancelMutation?.(m);
      return { ok: true, chance, success, messages };
    }
    return { ok: false, chance, success, messages, ...this.installFailure(itemId, difficulty, success, say) };
  }
  /** Removes a mutation canceled by a new bionic (set by the installer to MutationState). */
  cancelMutation: ((id: string) => void) | null = null;

  /** Character::bionics_install_failure */
  private installFailure(id: string, difficulty: number, success: number, say: (t: string, c?: string) => void): Partial<InstallResult> {
    const adjusted = bionicsAdjustedSkill(bionicsPlSkill(this.c, false));
    const failureLevel = Math.trunc(Math.sqrt((Math.abs(success) * 4 * difficulty) / Math.max(0.01, adjusted)));
    let failType = Math.min(5, failureLevel);
    if (this.c.hasTrait('PROF_MED') || this.c.hasTrait('PROF_AUTODOC')) {
      say('Your training helps to minimize the complications.');
      if (failType > 3) failType = this.c.rng.int(1, 3);
    }
    say('The installation is a failure.');
    const out: Partial<InstallResult> = { failType };
    if (failType <= 0) {
      say('The installation fails without incident.');
      out.dropCbm = true;
    } else if (failType === 1) {
      say('It really hurts!', 'c_red');
      this.c.modPain(this.c.rng.int(10, 30));
      out.dropCbm = true;
    } else if (failType <= 3) {
      say('The installation is faulty!', 'c_red');
      let valid = this.idx.faulty.filter((f) => !this.has(f) && !this.def(f)?.dupes_allowed);
      if (!valid.length) valid = this.idx.faulty.filter((f) => this.def(f)?.dupes_allowed);
      if (valid.length) {
        const f = this.c.rng.pick(valid);
        this.add(f);
        out.faulty = f;
      }
    } else {
      const hurt = new Set<MainPartId>();
      for (const [bp] of this.def(id)?.occupied_bodyparts ?? []) {
        if (!isBodyPart(bp)) continue;
        const main = BODY_PARTS[bp].main;
        if (hurt.has(main)) continue;
        hurt.add(main);
        this.c.applyDamage(main, this.c.rng.int(25, 50));
        say(`Your ${BODY_PARTS[main].name} is damaged.`, 'c_red');
      }
      out.dropCbm = true;
    }
    return out;
  }

  /** Character::add_bionic (+ included bionics, activated_on_install). */
  add(id: string, included = false): void {
    const d = this.def(id);
    if (!d) {
      console.warn(`Unknown bionic "${id}"`);
      return;
    }
    this.bionics.push({ id, powered: false, chargeTimer: 0, ...(included ? { included: true } : {}) });
    for (const inc of d.included_bionics ?? []) this.add(inc, true);
    if (d.activated_on_install) this.activate(id, true);
    this.onChanged?.();
  }
  remove(id: string): void {
    const i = this.bionics.findIndex((b) => b.id === id);
    if (i < 0) return;
    if (this.bionics[i].powered) this.deactivate(id, true);
    this.bionics.splice(i, 1);
    for (const inc of this.def(id)?.included_bionics ?? []) {
      const j = this.bionics.findIndex((b) => b.id === inc && b.included);
      if (j >= 0) this.bionics.splice(j, 1);
    }
    this.power = Math.min(this.power, this.maxPower());
    this.onChanged?.();
  }

  // ------------------------------------------------------------------ activation
  /** Character::activate_bionic. Returns false (with a message) when it can't. */
  activate(id: string, free = false): boolean {
    const b = this.bionics.find((x) => x.id === id);
    const d = this.def(id);
    if (!b || !d) return false;
    if (b.powered) return true;
    const cost = d.act_cost ?? 0;
    if (!free && cost > this.power) {
      this.msg(`You don't have the power to activate your ${this.name(id)}.`, 'c_light_red');
      return false;
    }
    if (d.fake_weapon) {
      const inv = this.c.inv;
      if (!this.c.data.items[d.fake_weapon]) {
        console.warn(`Unknown fake_weapon ${d.fake_weapon} on ${id}`);
        return false;
      }
      if (inv.wielded?.hasFlag('BIONIC_WEAPON')) {
        this.msg(`Deactivate your ${inv.wielded.name()} first.`, 'c_light_red');
        return false;
      }
      if (inv.wielded) {
        const old = inv.wielded;
        inv.wielded = null;
        const left = inv.stash(old);
        if (left) {
          inv.wielded = old;
          this.msg(`You don't have room to put away your ${old.name()}.`, 'c_light_red');
          return false;
        }
      }
      inv.wielded = createItem(this.c.data, d.fake_weapon);
      this.msg(`You extend your ${inv.wielded.name()}.`);
    }
    if (!free) this.power -= cost;
    for (const other of d.auto_deactivates ?? []) if (this.isActive(other)) this.deactivate(other);
    b.powered = !!(d.flags?.includes('BIONIC_TOGGLED') || d.fake_weapon);
    b.chargeTimer = d.time ?? 0;
    if (!d.fake_weapon) this.msg(b.powered ? `You activate your ${this.name(id)}.` : `You use your ${this.name(id)}.`);
    this.onChanged?.();
    return true;
  }
  /** Character::deactivate_bionic */
  deactivate(id: string, force = false): boolean {
    const b = this.bionics.find((x) => x.id === id && x.powered);
    const d = this.def(id);
    if (!b || !d) return false;
    const cost = d.deact_cost ?? 0;
    if (!force && cost > this.power) {
      this.msg(`You don't have the power to deactivate your ${this.name(id)}.`, 'c_light_red');
      return false;
    }
    if (!force) this.power -= cost;
    b.powered = false;
    if (d.fake_weapon) {
      const w = this.c.inv.wielded;
      if (w && w.typeId === d.fake_weapon) {
        this.c.inv.wielded = null;
        this.msg(`You retract your ${w.name()}.`);
      }
    } else this.msg(`You deactivate your ${this.name(id)}.`);
    this.onChanged?.();
    return true;
  }
  toggle(id: string): boolean {
    return this.isActive(id) ? this.deactivate(id) : this.activate(id);
  }

  // ------------------------------------------------------------------ effects
  /** Enchantment provider for Character.enchantProviders (ALWAYS / ACTIVE conditions). */
  enchant(value: string): { add: number; multiply: number } | null {
    let add = 0, multiply = 0, any = false;
    type Ench = Exclude<NonNullable<BionicDef['enchantments']>[number], string>;
    const named = this.c.data.misc?.enchantment as Record<string, Ench> | undefined;
    for (const b of this.bionics) {
      for (const raw of this.def(b.id)?.enchantments ?? []) {
        const e = typeof raw === 'string' ? named?.[raw] : raw;
        if (!e) continue;
        const cond = e.condition;
        if (cond === 'ACTIVE' && !b.powered) continue;
        if (cond === 'INACTIVE' && b.powered) continue;
        for (const v of e.values ?? []) {
          if (v.value !== value) continue;
          add += v.add ?? 0;
          multiply += v.multiply ?? 0;
          any = true;
        }
      }
    }
    // Power Overload: short-circuits muscles above 75% charge (hardcoded in CDDA).
    if (value === 'STRENGTH' && this.has('bio_power_weakness') && this.maxPower() > 0 && this.power >= this.maxPower() * 0.75) {
      add -= 3;
      any = true;
    }
    return any ? { add, multiply } : null;
  }

  /** Flat armor: `protec` per body part (subdermal meshes, carbon filament). */
  armor(bp: BodyPartId, dtype: string): number {
    let n = 0;
    for (const b of this.bionics) for (const [p, res] of this.def(b.id)?.protec ?? []) if (p === bp) n += res[dtype] ?? 0;
    return n;
  }
  encumbrance(bp: BodyPartId): number {
    let n = 0;
    for (const b of this.bionics) for (const [p, e] of this.def(b.id)?.encumbrance ?? []) if (p === bp) n += e;
    return n;
  }
  /** Pseudo tools: passive ones always, toggled ones while powered (cached by state). */
  pseudoItems(): Item[] {
    const ids: string[] = [];
    for (const b of this.bionics) {
      const d = this.def(b.id);
      ids.push(...(d?.passive_pseudo_items ?? []));
      if (b.powered) ids.push(...(d?.toggled_pseudo_items ?? []));
    }
    const key = ids.join(',');
    if (key !== this.pseudoCache.key) {
      this.pseudoCache = { key, items: ids.filter((id) => this.c.data.items[id]).map((id) => createItem(this.c.data, id)) };
    }
    return this.pseudoCache.items;
  }
  /** Luminance from powered bionics (LUMINATION enchantment: Cranial Flashlight 60). */
  light(): number {
    return Math.max(0, this.enchant('LUMINATION')?.add ?? 0);
  }
  /** Night vision range (NIGHT_VISION active flag = +10 like CDDA's GNV). */
  nightVisionRange(): number {
    return this.hasFlag('NIGHT_VISION') ? 10 : 0;
  }

  // ------------------------------------------------------------------ time
  /** Walking with a torsion ratchet (game::on_move_effects): 1 kJ × efficiency per tile. */
  onMoved(tiles: number): void {
    if (tiles <= 0) return;
    for (const b of this.bionics) {
      const d = this.def(b.id);
      if (!d?.fuel_options?.includes('muscle')) continue;
      const eff = b.powered ? d.fuel_efficiency ?? 0 : d.passive_fuel_efficiency ?? 0;
      this.modPower(tiles * eff);
    }
  }

  /** process_bionic for every installed bionic, per game second. */
  update(gameDt: number): void {
    if (this.c.dead || gameDt <= 0 || !this.bionics.length) return;
    this.acc += gameDt;
    let n = Math.floor(this.acc);
    this.acc -= n;
    // Long clock warps (sleep) process in bulk but keep per-second semantics.
    while (n-- > 0) this.perSecond();
  }

  private perSecond(): void {
    for (const b of this.bionics) {
      const d = this.def(b.id);
      if (!d) continue;
      if (!b.powered) continue;
      if (b.id === 'bio_painkiller') this.painkiller(d);
      if (b.id === 'bio_nanobots') this.nanobots(d);
      b.chargeTimer = Math.max(0, b.chargeTimer - 1);
      if (b.chargeTimer > 0 || !(d.time ?? 0)) continue;
      b.chargeTimer = d.time ?? 0;
      if (d.flags?.includes('BIONIC_POWER_SOURCE') || d.fuel_options?.some((f) => POWER_SOURCE_FUELS.has(f))) {
        this.burnFuel(b, d);
        continue;
      }
      const cost = d.react_cost ?? 0;
      if (cost > this.power) {
        this.msg(`Your ${this.name(b.id)} powers down.`, 'c_light_red');
        this.deactivate(b.id, true);
        continue;
      }
      this.power -= cost;
    }
  }

  /** Character::burn_fuel for powered sources (safe-fuel: stop at full). */
  private burnFuel(b: InstalledBionic, d: BionicDef): void {
    const eff = d.fuel_efficiency ?? 1;
    const max = this.maxPower();
    if (max <= 0 || this.power + eff >= max) return;
    const fuel = d.fuel_options?.[0];
    if (fuel === 'metabolism') {
      // 1 kcal = 4.184 kJ; only above 80% of healthy fat reserves.
      if (this.c.storedKcal - 0.8 * this.c.healthyKcal() <= 0) return;
      this.c.storedKcal -= 1;
      this.modPower(4.184 * eff);
    } else if (fuel === 'battery') {
      // One battery charge (1 kJ) per tick from carried batteries (internal compartment in CDDA).
      const src = this.c.inv.allItems().find((it) => it.isMagazine() && it.ammoData()?.ammo_type === 'battery' && it.ammoRemaining() > 0);
      if (!src) return;
      src.ammoConsume(1);
      this.modPower(1 * eff);
    }
  }

  /** bio_painkiller: raise painkiller toward pain (max 150), 1 per tick for trigger_cost. */
  private painkiller(d: BionicDef): void {
    const cost = d.trigger_cost ?? 0;
    const maxPkill = Math.min(150, this.c.pain);
    if (this.c.painkiller < maxPkill && this.power >= cost) {
      this.c.modPainkiller(1);
      this.power -= cost;
    }
  }

  /** bio_nanobots: stop bleeding (15 kcal each) and heal 1 HP per minute (5 kcal). */
  private nanobots(d: BionicDef): void {
    const damaged = MAIN_PARTS.filter((p) => this.c.hp[p].cur > 0 && this.c.hp[p].cur < this.c.hp[p].max);
    const bleeding = this.c.effects.all().filter((e) => e.id === 'bleed');
    if (!damaged.length && !bleeding.length) {
      // Nothing to heal: refund the upkeep that the generic tick will charge.
      this.power += Math.min(d.react_cost ?? 0, this.maxPower() - this.power);
      return;
    }
    for (const e of bleeding) {
      if (this.c.storedKcal < 15) break;
      e.modDuration(-e.type.intDurFactor);
      this.c.storedKcal -= 15;
    }
    if (this.c.turn % 60 === 0 && damaged.length && this.c.storedKcal >= 5) {
      this.c.heal(this.c.rng.pick(damaged), 1);
      this.c.storedKcal -= 5;
    }
  }

  toJSON(): BionicStateJSON {
    return { bionics: this.bionics.map((b) => ({ ...b })), power: this.power };
  }
  load(j: BionicStateJSON, warn?: (m: string) => void): void {
    this.bionics = [];
    for (const b of j.bionics) {
      if (!this.def(b.id)) {
        warn?.(`dropped unknown bionic ${b.id}`);
        continue;
      }
      this.bionics.push({ ...b });
    }
    this.power = Math.min(j.power, this.maxPower());
    this.onChanged?.();
  }
}

function partName(bp: string): string {
  return isBodyPart(bp) ? BODY_PARTS[bp].name : bp;
}
