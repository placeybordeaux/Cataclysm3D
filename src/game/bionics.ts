import type { GameData } from '../data/types';
import { BODY_PARTS, isBodyPart, MAIN_PARTS, type BodyPartId, type MainPartId } from './bodyparts';
import type { Character } from './character';
import { createItem, type Item } from './item';
import { cddaText } from './units';

// Compact Bionic Modules, Cataclysm: Bright Nights rules (bionics.cpp, iexamine.cpp autodoc,
// game_inventory.cpp install menus, bionics.json). Data-driven core:
//   - power: `capacity` (kJ) raises the stored max power level on install (lowered by some
//     failed operations), act_cost / deact_cost, react_cost every `time` turns while on,
//     trigger_cost / kcal_trigger_cost for the hardcoded CBMs.
//   - `fake_item`: a BIONIC_WEAPON flag wields it while active (bionic claws); otherwise it is
//     a crafting pseudo tool, always there for passive CBMs and while powered for toggled ones
//     (Integrated Toolset). `stat_bonus` is permanent; bash/cut/bullet_protec are flat armor
//     under the clothes; `bio_enchantments` (conditions ACTIVE/INACTIVE, values add/multiply/
//     max) and named `enchantments`; `canceled_mutations`, `required_bionics`,
//     `included_bionics`, `upgraded_bionic` / `available_upgrades`, MULTIINSTALL,
//     INITIALLY_ACTIVATE, fuel_options power sources.
//   - body-part slots only count when the CBM_SLOTS_ENABLED option is on (off in BN).
//   - installation: bionics_pl_skill / bionics_adjusted_skill / bionic_manip_cos; BN always
//     installs the CBM and a failed roll adds complications on top (damage to the operated
//     parts, a faulty CBM, or lost power capacity). Self-installation needs the
//     MANUAL_BIONIC_INSTALLATION option (off): otherwise an Autodoc does it, with anesthesia
//     (requirement "anesthetic" × difficulty × 2 × 7) unless the patient feels no pain.
// Hardcoded behaviour: metabolic / battery / torsion-ratchet power, painkiller, repair
// nanobots, Power Overload weakness. Light and night vision come from the LUMINATION /
// NIGHT_VISION enchantment values (src/game/vision.ts hooks).
// Units: power in kJ (the extractor converts "0.5 J" to 0.0005), time in game seconds.

type EnchantValue = { value: string; add?: number; multiply?: number; max?: number };
type Enchantment = { condition?: unknown; conditions?: unknown[]; values?: EnchantValue[] };

export interface BionicDef {
  id: string;
  name?: string | { str: string };
  description?: string;
  occupied_bodyparts?: [string, number][];
  capacity?: number;
  act_cost?: number;
  deact_cost?: number;
  react_cost?: number;
  trigger_cost?: number;
  kcal_trigger_cost?: number;
  /** Turns between upkeep charges (BN charge_time); 0 = no upkeep. */
  time?: number;
  flags?: string[];
  fake_item?: string;
  stat_bonus?: [string, number][];
  bash_protec?: [string, number][];
  cut_protec?: [string, number][];
  bullet_protec?: [string, number][];
  env_protec?: [string, number][];
  bio_enchantments?: Enchantment[];
  enchantments?: (Enchantment | string)[];
  encumbrance?: [string, number][];
  fuel_options?: string[];
  fuel_efficiency?: number;
  passive_fuel_efficiency?: number;
  canceled_mutations?: string[];
  required_bionics?: string[];
  upgraded_bionic?: string;
  available_upgrades?: string[];
  included_bionics?: string[];
  included?: boolean;
  starting_bionic?: boolean;
  points?: number;
}

export interface InstalledBionic {
  id: string;
  powered: boolean;
  /** Turns until the next upkeep/fuel tick. */
  chargeTimer: number;
  /** Installed as part of another bionic (included_bionics): not removable/listed alone. */
  included?: boolean;
}

export interface BionicStateJSON {
  bionics: InstalledBionic[];
  power: number;
  /** Character::max_power_level (kJ). Missing in v1 saves: the sum of capacities. */
  maxPower?: number;
}

export interface InstallResult {
  /** The CBM went in (BN installs it even when the roll fails). */
  ok: boolean;
  /** Success chance in percent (bionic_manip_cos). */
  chance: number;
  /** chance - rng(0, 99): > 0 is a clean operation; the complication level derives from how far below. */
  success: number;
  /** bionics_install_failure fail_type (0-1 minor damage, 2-3 damage, 4-5 faulty CBM / lost capacity). */
  failType?: number;
  messages: string[];
  /** Faulty CBM installed by a botched operation. */
  faulty?: string;
}

/** Bionics that turn "fuel" into power: BN fuel_options, handled in burnFuel(). */
const POWER_SOURCE_FUELS = new Set(['battery', 'metabolism', 'muscle']);

export class BionicIndex {
  readonly defs = new Map<string, BionicDef>();
  readonly faulty: string[] = [];
  /** body part id → bionic slot count (body_part.bionic_slots). */
  readonly slots = new Map<string, number>();
  /** BN game_balance options. */
  readonly slotsEnabled: boolean;
  readonly manualInstall: boolean;
  /** requirement "anesthetic": anesthesia kit charges per unit (BN: 3). */
  readonly anesthesiaPerUnit: { tool: string; count: number }[];

  constructor(readonly data: GameData) {
    for (const b of Object.values((data.misc?.bionic ?? {}) as Record<string, BionicDef>)) {
      this.defs.set(b.id, b);
      if (b.flags?.includes('BIONIC_FAULTY')) this.faulty.push(b.id);
    }
    for (const bp of Object.values((data.misc?.body_part ?? {}) as Record<string, { id: string; bionic_slots?: number }>))
      if (bp.bionic_slots !== undefined) this.slots.set(bp.id, bp.bionic_slots);
    const opts = (data.misc?.external_option ?? {}) as Record<string, { value?: unknown }>;
    this.slotsEnabled = opts.CBM_SLOTS_ENABLED?.value === true;
    this.manualInstall = opts.MANUAL_BIONIC_INSTALLATION?.value === true;
    const req = (data.misc?.requirement as Record<string, { tools?: { id: string; count: number }[][] }> | undefined)?.anesthetic;
    this.anesthesiaPerUnit = req?.tools?.[0]?.map((t) => ({ tool: t.id, count: t.count })) ?? [{ tool: 'anesthetic_kit', count: 3 }];
  }
  def(id: string): BionicDef | undefined {
    return this.defs.get(id);
  }
  name(id: string): string {
    return cddaText(this.defs.get(id)?.name) || id;
  }
  /** The bionic a CBM item installs (islot_bionic id: `bionic_id`, else the item id). */
  bionicOf(itemId: string): string {
    return String(this.data.items[itemId]?.bionic_id ?? itemId);
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

/**
 * Character::bionics_pl_skill: int*4 + most*4 + important*3 + least*1 (+profession bonuses);
 * `skillLevel` >= 0 overrides it as 12 × level (Autodoc install programs use 10).
 */
export function bionicsPlSkill(c: Character, autodoc: boolean, skillLevel = -1): number {
  const [most, important, least] = autodoc ? ['firstaid', 'computer', 'electronics'] : ['electronics', 'firstaid', 'mechanics'];
  let pl = skillLevel === -1 ? c.int * 4 + c.getSkill(most) * 4 + c.getSkill(important) * 3 + c.getSkill(least) : 12 * skillLevel;
  if (c.hasTrait('PROF_MED')) pl += 3;
  if (c.hasTrait('PROF_AUTODOC')) pl += 7;
  return Math.trunc(pl);
}

/** Character::bionics_adjusted_skill (no "assisted" effect or surgery furniture bonus). */
export function bionicsAdjustedSkill(pl: number): number {
  return pl - Math.min(40, pl - pl / 10);
}

export function bionicSuccessChance(c: Character, autodoc: boolean, difficulty: number, skillLevel = -1): number {
  return bionicManipCos(bionicsAdjustedSkill(bionicsPlSkill(c, autodoc, skillLevel)), difficulty);
}

export class BionicState {
  readonly idx: BionicIndex;
  bionics: InstalledBionic[] = [];
  /** Stored bionic power, kJ. */
  power = 0;
  /** Character::max_power_level, kJ: raised by `capacity` on install, lowered by complications. */
  maxPowerLevel = 0;
  private msg(t: string, color?: string) {
    this.c.msg(t, color);
  }
  private acc = 0;
  private pseudoCache: { key: string; items: Item[] } = { key: '', items: [] };
  /** Called after install/remove/toggle so views can refresh. */
  onChanged: (() => void) | null = null;
  /** Removes a mutation canceled by a new bionic (set by the installer to MutationState). */
  cancelMutation: ((id: string) => void) | null = null;

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
  maxPower(): number {
    return this.maxPowerLevel;
  }
  modPower(kj: number): void {
    this.power = Math.max(0, Math.min(this.maxPower(), this.power + kj));
  }
  hasFlag(flag: string): boolean {
    return this.bionics.some((b) => this.def(b.id)?.flags?.includes(flag));
  }
  /** bionic_data::activated: toggled, costs power to activate, or charges over time. */
  activatable(b: InstalledBionic): boolean {
    const d = this.def(b.id);
    if (!d) return false;
    return !!(d.flags?.includes('BIONIC_TOGGLED') || (d.act_cost ?? 0) > 0 || (d.time ?? 0) > 0);
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
  /** Character::bionic_installation_issues (only with CBM_SLOTS_ENABLED). */
  installationIssues(id: string): Map<string, number> {
    const out = new Map<string, number>();
    if (!this.idx.slotsEnabled) return out;
    const up = this.def(id)?.upgraded_bionic;
    for (const [bp, need] of this.def(id)?.occupied_bodyparts ?? []) {
      let lacked = need - (this.slotsMax(bp) - this.slotsUsed(bp));
      if (up) lacked -= (this.def(up)?.occupied_bodyparts ?? []).find(([p]) => p === bp)?.[1] ?? 0;
      if (lacked > 0) out.set(bp, lacked);
    }
    return out;
  }

  /** The Autodoc menu's get_denial / install_bionic_actor::can_use: null when the CBM can go in. */
  installBlocker(it: Item | string): string | null {
    const itemId = typeof it === 'string' ? it : it.typeId;
    const id = this.idx.bionicOf(itemId);
    const d = this.def(id);
    if (!d) return `${itemId} is not a bionic module.`;
    if (typeof it !== 'string' && it.vars.cbm_salvaged) return 'CBM is not sterile.';
    if (!d.flags?.includes('MULTIINSTALL') && this.has(id)) return 'CBM is already installed.';
    const missing = (d.required_bionics ?? []).filter((r) => !this.has(r));
    if (missing.length) return `CBM requires prior installation of ${missing.map((r) => this.name(r)).join(', ')}.`;
    if ((d.available_upgrades ?? []).some((u) => this.has(u))) return 'Superior version installed.';
    const issues = this.installationIssues(id);
    if (issues.size) {
      return 'Not enough space for bionic installation!' + [...issues].map(([bp, n]) => ` ${partName(bp)}: ${n} more slot(s) needed.`).join('');
    }
    return null;
  }

  // ------------------------------------------------------------------ anesthesia
  /** has_enough_anesthesia: requirement "anesthetic" × difficulty × 2 × 7 (kit charges). */
  anesthesiaNeeded(itemId: string): number {
    const per = this.idx.anesthesiaPerUnit[0]?.count ?? 3;
    return per * this.idx.difficulty(itemId) * 2 * 7;
  }
  /**
   * Items next to the patient that count as the crafting inventory (BN has_enough_anesthesia
   * reads crafting_inventory: carried + nearby). Set by the installer; tests leave it null.
   */
  nearbyItems: (() => Item[]) | null = null;
  private anesthesiaKits(): Item[] {
    return [...this.c.inv.allItems(), ...(this.nearbyItems?.() ?? [])].filter((it) => it.qualityLevel('ANESTHESIA') > 0);
  }
  /** Anesthetic charges in anesthesia kits carried or at hand. */
  anesthesiaAvailable(): number {
    let n = 0;
    for (const it of this.anesthesiaKits()) n += it.ammoRemaining();
    return n;
  }
  /** cbm_needs_anesthesia: Sensory Dulling or pain immunity make it unnecessary. */
  needsAnesthesia(): boolean {
    return !this.has('bio_painkiller') && !this.c.hasTrait('NOPAIN') && !this.c.hasTrait('DEBUG_BIONICS');
  }
  consumeAnesthesia(n: number): void {
    for (const it of this.anesthesiaKits()) {
      if (n <= 0) return;
      n -= it.ammoConsume(Math.min(n, it.ammoRemaining()));
    }
  }

  // ------------------------------------------------------------------ install / remove
  successChance(itemId: string, autodoc: boolean, skillLevel = -1): number {
    if (this.c.hasTrait('DEBUG_BIONICS')) return 100;
    return bionicSuccessChance(this.c, autodoc, this.idx.difficulty(itemId), skillLevel);
  }

  /**
   * Character::install_bionics + perform_install (the operation's end): practices skills for
   * self-installs, installs the CBM and, when the roll fails, bionics_install_failure. `roll`
   * overrides rng(0, 99) for tests; `skillLevel` is the Autodoc install-program override.
   */
  install(itemId: string, opts: { autodoc?: boolean; roll?: number; skillLevel?: number } = {}): InstallResult {
    const autodoc = !!opts.autodoc;
    const skillLevel = opts.skillLevel ?? -1;
    const id = this.idx.bionicOf(itemId);
    const d = this.def(id);
    if (!d) throw new Error(`install: ${itemId} is not a bionic module`);
    const difficulty = this.idx.difficulty(itemId);
    const chance = this.successChance(itemId, autodoc, skillLevel);
    if (!autodoc) {
      this.c.practice('electronics', Math.trunc((100 - chance) * 1.5));
      this.c.practice('firstaid', Math.trunc(100 - chance));
      this.c.practice('mechanics', Math.trunc((100 - chance) * 0.5));
    }
    const success = chance - (opts.roll ?? this.c.rng.int(0, 99));
    const messages: string[] = [];
    const say = (t: string, col?: string) => (messages.push(t), this.msg(t, col));
    const up = d.upgraded_bionic && this.has(d.upgraded_bionic) ? d.upgraded_bionic : null;
    if (up) {
      this.remove(up);
      say(`Upgraded ${this.name(up)} to ${this.name(id)}.`, 'c_light_green');
    } else say(`Installed ${this.name(id)}.`, 'c_light_green');
    this.add(id);
    for (const m of d.canceled_mutations ?? []) if (this.c.hasTrait(m)) this.cancelMutation?.(m);
    if (success > 0) return { ok: true, chance, success, messages };
    const pl = bionicsPlSkill(this.c, autodoc, skillLevel);
    return { ok: true, chance, success, messages, ...this.installFailure(id, difficulty, success, bionicsAdjustedSkill(pl), say) };
  }

  /** Character::bionics_install_failure + do_damage_for_bionic_failure */
  private installFailure(id: string, difficulty: number, success: number, adjusted: number, say: (t: string, c?: string) => void): Partial<InstallResult> {
    const failureLevel = Math.trunc(Math.sqrt((Math.abs(success) * 4 * difficulty) / Math.max(0.01, adjusted)));
    let failType = Math.min(5, failureLevel);
    if (this.c.hasTrait('PROF_MED') || this.c.hasTrait('PROF_AUTODOC')) {
      say('Your training helps to minimize the complications.');
      if (failType > 3) failType = this.c.rng.int(1, 3);
    }
    const out: Partial<InstallResult> = { failType };
    const damage = (lo: number, hi: number) => {
      const hurt = new Set<MainPartId>();
      for (const [bp, n] of this.def(id)?.occupied_bodyparts ?? []) if (n > 0 && isBodyPart(bp)) hurt.add(BODY_PARTS[bp].main);
      // No body part (power storage): the torso.
      if (!hurt.size) hurt.add('torso');
      for (const bp of hurt) {
        let dmg = this.c.rng.int(lo, Math.max(lo, hi));
        const hp = this.c.hp[bp].cur;
        if (dmg >= hp && (bp === 'head' || bp === 'torso')) {
          this.c.addEffect('infected', 3600, { bp });
          say(`Your ${BODY_PARTS[bp].name} is infected.`, 'c_red');
          dmg = Math.trunc(hp * 0.8);
        }
        this.c.applyDamage(bp, dmg);
        say(`Your ${BODY_PARTS[bp].name} is ${dmg > 15 ? 'severely ' : ''}damaged.`, 'c_red');
      }
    };
    if (failType <= 1) damage(2, 5);
    else if (failType <= 3) damage(5, difficulty * 5);
    else {
      const valid = this.idx.faulty.filter((f) => !this.has(f));
      if (valid.length) {
        const f = this.c.rng.pick(valid);
        this.add(f);
        out.faulty = f;
        say(`Complication in installation caused a malfunction - ${this.name(f)}.  Uninstall it to clear the malfunction.`, 'c_red');
      } else if (this.maxPowerLevel > 0) {
        say('You lose power capacity!', 'c_red');
        this.maxPowerLevel = Math.max(0, this.c.rng.int(0, Math.max(0, Math.trunc(this.maxPowerLevel) - 25)));
        this.power = Math.min(this.power, this.maxPowerLevel);
      } else damage(5, difficulty * 5);
    }
    return out;
  }

  /** Character::add_bionic (+ capacity, INITIALLY_ACTIVATE, included bionics). */
  add(id: string, included = false): void {
    const d = this.def(id);
    if (!d) {
      console.warn(`Unknown bionic "${id}"`);
      return;
    }
    if (!d.flags?.includes('MULTIINSTALL') && this.has(id)) {
      console.warn(`Tried to install bionic ${id} that is already installed`);
      return;
    }
    if (d.capacity) {
      this.maxPowerLevel += d.capacity;
      this.msg(`Increased storage capacity by ${d.capacity}.`, 'c_light_green');
    }
    this.bionics.push({ id, powered: false, chargeTimer: 0, ...(included ? { included: true } : {}) });
    if (d.flags?.includes('INITIALLY_ACTIVATE')) this.activate(id, true);
    for (const inc of d.included_bionics ?? []) this.add(inc, true);
    this.onChanged?.();
  }
  /** Character::remove_bionic (+ its capacity and included bionics). */
  remove(id: string): void {
    const i = this.bionics.findIndex((b) => b.id === id);
    if (i < 0) return;
    if (this.bionics[i].powered) this.deactivate(id, true);
    this.bionics.splice(i, 1);
    this.maxPowerLevel = Math.max(0, this.maxPowerLevel - (this.def(id)?.capacity ?? 0));
    for (const inc of this.def(id)?.included_bionics ?? []) {
      const j = this.bionics.findIndex((b) => b.id === inc && b.included);
      if (j >= 0) {
        this.maxPowerLevel = Math.max(0, this.maxPowerLevel - (this.def(inc)?.capacity ?? 0));
        this.bionics.splice(j, 1);
      }
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
    if (b.powered) return false;
    const cost = d.act_cost ?? 0;
    if (!free && cost > this.power) {
      this.msg(`You don't have the power to activate your ${this.name(id)}.`, 'c_light_red');
      return false;
    }
    // burn_fuel(start): a fuel-powered source needs fuel to start.
    if (!free && d.fuel_options?.length && !d.fuel_options.includes('muscle') && !this.hasFuel(d)) {
      this.msg(`Your ${this.name(id)} does not have enough fuel to start.`, 'c_light_red');
      return false;
    }
    const weapon = !!(d.flags?.includes('BIONIC_WEAPON') && d.fake_item);
    if (weapon) {
      const inv = this.c.inv;
      if (!this.c.data.items[d.fake_item!]) {
        console.warn(`Unknown fake_item ${d.fake_item} on ${id}`);
        return false;
      }
      if (inv.wielded?.hasFlag('NO_UNWIELD')) {
        this.msg(`Deactivate your ${inv.wielded.name()} first!`, 'c_light_red');
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
    }
    if (!free) this.power -= cost;
    b.powered = !!d.flags?.includes('BIONIC_TOGGLED') || (d.time ?? 0) > 0;
    if ((d.time ?? 0) > 0) b.chargeTimer = d.time!;
    if (!free) this.msg(`You activate your ${this.name(id)}.`);
    if (weapon) this.c.inv.wielded = createItem(this.c.data, d.fake_item!);
    this.onChanged?.();
    return true;
  }
  private hasFuel(d: BionicDef): boolean {
    const fuel = d.fuel_options?.[0];
    if (fuel === 'metabolism') return this.c.storedKcal - 0.8 * this.c.maxStoredKcal() > 0;
    if (fuel === 'battery') return !!this.batterySource();
    return true;
  }
  /** Character::deactivate_bionic */
  deactivate(id: string, force = false): boolean {
    const b = this.bionics.find((x) => x.id === id && x.powered);
    const d = this.def(id);
    if (!b || !d) return false;
    if (!force) {
      if (!d.flags?.includes('BIONIC_TOGGLED')) {
        this.msg(`You can't deactivate your ${this.name(id)} manually!`, 'c_light_red');
        return false;
      }
      const cost = d.deact_cost ?? 0;
      if (cost > this.power) {
        this.msg(`You don't have the power to deactivate your ${this.name(id)}.`, 'c_light_red');
        return false;
      }
      this.power -= cost;
      this.msg(`You deactivate your ${this.name(id)}.`);
    }
    b.powered = false;
    if (d.flags?.includes('BIONIC_WEAPON') && d.fake_item) {
      const w = this.c.inv.wielded;
      if (w && w.typeId === d.fake_item) {
        this.c.inv.wielded = null;
        this.msg(`You withdraw your ${w.name()}.`);
      }
    }
    this.onChanged?.();
    return true;
  }
  toggle(id: string): boolean {
    return this.isActive(id) ? this.deactivate(id) : this.activate(id);
  }

  // ------------------------------------------------------------------ effects
  /** Enchantments of installed bionics that currently apply (conditions ACTIVE/INACTIVE). */
  private *activeEnchantments(): Generator<Enchantment> {
    const named = this.c.data.misc?.enchantment as Record<string, Enchantment> | undefined;
    for (const b of this.bionics) {
      const d = this.def(b.id);
      if (!d) continue;
      for (const raw of [...(d.bio_enchantments ?? []), ...(d.enchantments ?? [])]) {
        const e = typeof raw === 'string' ? named?.[raw] : raw;
        if (!e) continue;
        const conds = [...(e.conditions ?? []), ...(e.condition !== undefined ? [e.condition] : [])];
        if (conds.includes('ACTIVE') && !b.powered) continue;
        if (conds.includes('INACTIVE') && b.powered) continue;
        yield e;
      }
    }
  }

  /** Enchantment provider for Character.enchantProviders: stat_bonus + enchantment add/multiply. */
  enchant(value: string): { add: number; multiply: number } | null {
    let add = 0, multiply = 0, any = false;
    for (const e of this.activeEnchantments()) {
      for (const v of e.values ?? []) {
        if (v.value !== value) continue;
        add += v.add ?? 0;
        multiply += v.multiply ?? 0;
        any = true;
      }
    }
    const stat = STAT_VALUES[value];
    if (stat) {
      for (const b of this.bionics)
        for (const [s, n] of this.def(b.id)?.stat_bonus ?? []) {
          if (s !== stat) continue;
          add += n;
          any = true;
        }
    }
    // Power Overload: short-circuits muscles above 75% charge (suffer.cpp).
    if (value === 'STRENGTH' && this.has('bio_power_weakness') && this.maxPower() > 0 && this.power >= this.maxPower() * 0.75) {
      add -= 3;
      any = true;
    }
    return any ? { add, multiply } : null;
  }
  /** enchantment::calc_bonus(value, 0): Σ add + the largest `max` (LUMINATION, NIGHT_VISION). */
  enchantBonus(value: string): number {
    let add = 0, max = 0;
    for (const e of this.activeEnchantments()) {
      for (const v of e.values ?? []) {
        if (v.value !== value) continue;
        add += v.add ?? 0;
        max = Math.max(max, v.max ?? 0);
      }
    }
    return add + max;
  }

  /** Character::bionic_armor_bonus: cut_protec for cut/stab, bash_protec, bullet_protec. */
  armor(bp: BodyPartId, dtype: string): number {
    const key = dtype === 'cut' || dtype === 'stab' ? 'cut_protec' : dtype === 'bash' ? 'bash_protec' : dtype === 'bullet' ? 'bullet_protec' : null;
    if (!key) return 0;
    let n = 0;
    for (const b of this.bionics) for (const [p, v] of this.def(b.id)?.[key] ?? []) if (p === bp) n += v;
    return n;
  }
  encumbrance(bp: BodyPartId): number {
    let n = 0;
    for (const b of this.bionics) for (const [p, e] of this.def(b.id)?.encumbrance ?? []) if (p === bp) n += e;
    return n;
  }
  /**
   * Crafting pseudo tools (Character::crafting_inventory): the `fake_item` of every
   * non-weapon CBM that is passive or powered (cached by state).
   */
  pseudoItems(): Item[] {
    const ids: string[] = [];
    for (const b of this.bionics) {
      const d = this.def(b.id);
      if (!d?.fake_item || d.flags?.includes('BIONIC_WEAPON') || d.flags?.includes('BIONIC_GUN')) continue;
      if (!d.flags?.includes('BIONIC_TOGGLED') || b.powered) ids.push(d.fake_item);
    }
    const key = ids.join(',');
    if (key !== this.pseudoCache.key) {
      this.pseudoCache = { key, items: ids.filter((id) => this.c.data.items[id]).map((id) => createItem(this.c.data, id)) };
    }
    return this.pseudoCache.items;
  }
  /** Luminance from powered bionics (LUMINATION enchantment: Cranial Flashlight 300). */
  light(): number {
    return Math.max(0, this.enchantBonus('LUMINATION'));
  }
  /** Night vision range (NIGHT_VISION enchantment: Implanted Night Vision 10). */
  nightVisionRange(): number {
    return Math.max(0, this.enchantBonus('NIGHT_VISION'));
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

  /** process_bionic for every installed bionic, per game second (one BN turn). */
  update(gameDt: number): void {
    if (this.c.dead || gameDt <= 0 || !this.bionics.length) return;
    this.acc += gameDt;
    let n = Math.floor(this.acc);
    this.acc -= n;
    // Long clock warps (sleep) process in bulk but keep per-turn semantics.
    while (n-- > 0) this.perTurn();
  }

  private perTurn(): void {
    for (const b of [...this.bionics]) {
      const d = this.def(b.id);
      if (!d || !b.powered) continue;
      if (b.chargeTimer > 0) b.chargeTimer--;
      else if ((d.time ?? 0) > 0) {
        if (d.flags?.includes('BIONIC_POWER_SOURCE')) {
          this.burnFuel(b, d);
          b.chargeTimer = Math.max(0, d.time! - 1);
        } else {
          // attempt_recharge: no upkeep cost, or not enough power, powers it down.
          const cost = d.react_cost ?? 0;
          if (cost <= 0 || this.power < cost) {
            this.msg(`Your ${this.name(b.id)} powers down.`);
            this.deactivate(b.id, true);
            continue;
          }
          this.power -= cost;
          b.chargeTimer = d.time! - 1;
        }
      }
      if (!b.powered) continue;
      if (b.id === 'bio_painkiller') this.painkiller(d);
      if (b.id === 'bio_nanobots') this.nanobots(b, d);
    }
  }

  private batterySource(): Item | undefined {
    return this.c.inv.allItems().find((it) => it.isMagazine() && it.ammoData()?.ammo_type === 'battery' && it.ammoRemaining() > 0);
  }

  /** Character::burn_fuel for powered sources (safe fuel: turn off at full). */
  private burnFuel(b: InstalledBionic, d: BionicDef): void {
    const fuel = d.fuel_options?.[0];
    if (!fuel || fuel === 'muscle' || !POWER_SOURCE_FUELS.has(fuel)) return;
    const eff = d.fuel_efficiency ?? 1;
    // fuel_energy: 1 kcal of metabolism (4.184 kJ), 1 kJ per battery charge.
    const energy = fuel === 'metabolism' ? 4.184 : 1;
    if (this.power + energy * eff > this.maxPower()) {
      this.msg(fuel === 'metabolism' ? `Your ${this.name(b.id)} turns off to not waste calories.` : `Your ${this.name(b.id)} turns off to not waste fuel.`);
      this.deactivate(b.id, true);
      return;
    }
    if (fuel === 'metabolism') {
      if (this.c.storedKcal - 0.8 * this.c.maxStoredKcal() <= 0) {
        this.msg(`Stored calories are below the safe threshold, your ${this.name(b.id)} shuts down to preserve your health.`);
        this.deactivate(b.id, true);
        return;
      }
      this.c.modStoredKcal(-1);
      this.modPower(energy * eff);
    } else if (fuel === 'battery') {
      const src = this.batterySource();
      if (!src) {
        this.msg(`Your ${this.name(b.id)} runs out of fuel and turn off.`);
        this.deactivate(b.id, true);
        return;
      }
      src.ammoConsume(1);
      this.modPower(energy * eff);
    }
  }

  /** bio_painkiller: raise painkiller toward pain (max 150), 1 per turn for trigger_cost. */
  private painkiller(d: BionicDef): void {
    const cost = d.trigger_cost ?? 0;
    const pkill = this.c.painkiller;
    const pain = this.c.pain;
    if (pkill < Math.min(150, pain)) {
      this.c.modPainkiller(1);
      this.power = Math.max(0, this.power - cost);
    }
    if (pkill >= 150 && pain > pkill && this.c.stim > -150) {
      this.c.modPain(-1);
      this.c.stim -= 1;
      this.power = Math.max(0, this.power - cost);
    }
  }

  /**
   * bio_nanobots: shuts down below 85% of max kcal + kcal_trigger_cost; every 30 turns one
   * bleed intensity (essential parts first); every 2 minutes 1 HP on each damaged part
   * (lowest first) for trigger_cost power and kcal_trigger_cost kcal each.
   */
  private nanobots(b: InstalledBionic, d: BionicDef): void {
    const kcalTrigger = d.kcal_trigger_cost ?? 0;
    const threshold = kcalTrigger > 0 ? 0.85 * this.c.maxStoredKcal() + kcalTrigger : 0;
    if (this.c.storedKcal < threshold) {
      this.msg(`Your ${this.name(b.id)} shut down to conserve calories.`, 'c_yellow');
      this.deactivate(b.id, true);
      return;
    }
    const turn = this.c.turn;
    if (turn % 30 === 0) {
      const essential = (bp: string | null) => bp === 'head' || bp === 'torso';
      const bleeding = this.c.effects.all().filter((e) => e.id === 'bleed');
      bleeding.sort((a, z) => Number(essential(z.bp)) - Number(essential(a.bp)));
      const e = bleeding[0];
      if (e) {
        const where = e.bp ? BODY_PARTS[e.bp].name : 'body';
        if (e.intensity > 1) {
          this.msg(`Your ${this.name(b.id)} slow the bleeding on your ${where}`);
          e.setIntensity(e.intensity - 1);
        } else {
          this.msg(`Your ${this.name(b.id)} staunch the bleeding on your ${where}`);
          this.c.effects.remove('bleed', e.bp ?? undefined);
        }
      }
    }
    if (turn % 120 === 0) {
      const hpOf = (p: MainPartId) => this.c.hp[p].cur - (p === 'head' || p === 'torso' ? 10 : 0);
      const damaged = MAIN_PARTS.filter((p) => this.c.hp[p].cur > 0 && this.c.hp[p].cur < this.c.hp[p].max).sort((a, z) => hpOf(a) - hpOf(z));
      for (const p of damaged) {
        if (this.c.storedKcal < threshold || this.power < (d.trigger_cost ?? 0)) return;
        this.c.heal(p, 1);
        this.power -= d.trigger_cost ?? 0;
        this.c.modStoredKcal(-kcalTrigger);
      }
    }
  }

  toJSON(): BionicStateJSON {
    return { bionics: this.bionics.map((b) => ({ ...b })), power: this.power, maxPower: this.maxPowerLevel };
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
    this.maxPowerLevel = j.maxPower ?? this.bionics.reduce((n, b) => n + (this.def(b.id)?.capacity ?? 0), 0);
    this.power = Math.min(j.power, this.maxPower());
    this.onChanged?.();
  }
}

/** BN stat_bonus keys by enchantment value. */
const STAT_VALUES: Record<string, string> = { STRENGTH: 'STR', DEXTERITY: 'DEX', INTELLIGENCE: 'INT', PERCEPTION: 'PER' };

function partName(bp: string): string {
  return isBodyPart(bp) ? BODY_PARTS[bp].name : bp;
}
