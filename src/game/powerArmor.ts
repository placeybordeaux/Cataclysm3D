import type { Character } from './character';
import type { ActionResult } from './inventory';
import { covers, powerDrawW, useActions } from './inventory';
import { ALL_PARTS, type BodyPartId } from './bodyparts';
import type { Item } from './item';
import { cddaText } from './units';
import { explainNoPower, reloadHintsFor } from './reloadhelp';

// Bright Nights power armor (docs/BN_POWER_ARMOR.md). BN sources, Cataclysm-BN/src:
//  - iuse_actor.cpp set_transform_iuse::use: the exoskeleton's on/off switch. It checks
//    `set_charges` (bionic power through a powered armor interface, else the item's own charge
//    plus carried UPS), runs iuse_transform::use on itself, then transforms every worn item with
//    `flag` (POWERARMOR_EXTERNAL: plating, helmets) whose active state equals `turn_off`.
//  - set_transformed_iuse: those pieces can't be used directly ("Activate via main piece.").
//  - item.cpp item::process_tool: per-turn energy. power_draw is mW, energy = power_draw ×
//    seconds / 1e6 kJ. Paid from the item's own charge, then (power armor only) bionic power
//    through the interface, then a carried UPS when USE_UPS. Unpaid energy: "You need a UPS or
//    Bionic Power Interface to run the %s!", the worn flagged pieces turn off, the item reverts.
//    A restricted set_transformed piece with no active POWERARMOR_EXO worn reverts too.
//  - character.cpp has_charges / use_charges(itype_bio_armor): bionic cost = kJ / fuel_efficiency
//    of the best powered BIONIC_ARMOR_INTERFACE bionic (Mk I: 2, Mk II: 4, bionics.json).
//  - character.cpp Character::can_wear: the POWERARMOR_* wearing rules.
//  - Active state effects are what BN data gives: the `_on` item type (encumbrance, protection,
//    flags, power_draw) and relic passive_effects with conditions [WORN, ACTIVE] (STRENGTH,
//    CLIMATE_CONTROL), applied by src/game/relicEnchant.ts.

const EXO = 'POWERARMOR_EXO';
const EXTERNAL = 'POWERARMOR_EXTERNAL';
const PLATING = 'POWERARMOR_PLATING';
const MOD = 'POWERARMOR_MOD';
const COMPATIBLE = 'POWERARMOR_COMPATIBLE';
/** The unpaid kJ fraction of an item's power draw: kept on the item so it survives saves. */
export const DRAW_VAR = 'power_armor_kj';

type UseAction = { type: string; [k: string]: any };

/** item::is_power_armor */
export function isPowerArmor(it: Item): boolean {
  return it.hasFlag(EXO) || it.hasFlag(EXTERNAL) || it.hasFlag(MOD);
}

/** Bionic power as the armor interface sees it (installed by src/game/bodymods.ts). */
export interface ArmorInterfacePower {
  /** fuel_efficiency of the best *powered* BIONIC_ARMOR_INTERFACE bionic; 0 when none is powered. */
  efficiency(): number;
  /** Stored bionic power, kJ. */
  power(): number;
  /** Spend bionic power, kJ. */
  drain(kj: number): void;
}
const interfaces = new WeakMap<Character, ArmorInterfacePower>();
export function setArmorInterface(c: Character, power: ArmorInterfacePower): void {
  interfaces.set(c, power);
}
/** character_funcs::can_interface_armor: the interface power source, or null. */
export function armorInterface(c: Character): ArmorInterfacePower | null {
  const i = interfaces.get(c);
  return i && i.efficiency() > 0 ? i : null;
}

/** "%s" / "%1$s" filled with the item name (BN string_format). */
function fill(template: string, name: string): string {
  return template.replace(/%1\$s|%s/g, name);
}

function partsOf(it: Item): BodyPartId[] {
  return ALL_PARTS.filter((bp) => covers(it, bp));
}
function overlaps(a: Item, b: Item): boolean {
  return partsOf(a).some((bp) => covers(b, bp));
}

/** Character::is_wearing_power_armor(nullptr): a worn exoskeleton or power armor on the head. */
export function isWearingPowerArmor(worn: readonly Item[]): boolean {
  return worn.some((e) => isPowerArmor(e) && (e.hasFlag(EXO) || covers(e, 'head')));
}
/** Character::is_wearing_active_power_armor */
export function isWearingActivePowerArmor(worn: readonly Item[]): boolean {
  return worn.some((e) => e.hasFlag(EXO) && e.active);
}

/** Character::can_wear, the power armor part (BN wording). Null when allowed. */
export function powerArmorWearBlocker(worn: readonly Item[], it: Item): string | null {
  if (!isPowerArmor(it)) {
    // Only headgear can be worn with power armor, except other power armor components.
    if (!it.hasFlag(COMPATIBLE) && isWearingPowerArmor(worn) && worn.some((e) => overlaps(e, it))) return `Can't wear ${it.name()} with power armor!`;
    return null;
  }
  for (const e of worn) {
    if (overlaps(e, it) && !e.hasFlag(COMPATIBLE) && !isPowerArmor(e)) return "Can't wear power armor over other gear!";
    if (e.hasFlag(EXO) && it.hasFlag(EXO)) return "Can't wear multiple exoskeletons!";
  }
  if (!it.hasFlag(EXO) && !isWearingPowerArmor(worn)) return 'You can only wear power armor components with power armor!';
  if (it.hasFlag(EXTERNAL) && !it.hasFlag(PLATING)) {
    for (const e of worn) {
      if (e.hasFlag(EXO) && overlaps(e, it)) return "Can't wear externals over an exoskeleton!";
      if (e.hasFlag(EXTERNAL) && overlaps(e, it)) return "Can't wear externals over one another!";
    }
  }
  if (it.hasFlag(PLATING)) {
    for (const e of worn) if (e.hasFlag(PLATING) && overlaps(e, it)) return "Can't wear overlapping sets of plating!";
  }
  if (it.hasFlag(MOD)) {
    // The port has no left/right item sides, so BN's per-side allowance for sided mods doesn't apply.
    for (const bp of partsOf(it)) {
      const attached = worn.some((e) => covers(e, bp) && (e.hasFlag(EXO) || e.hasFlag(EXTERNAL)) && !e.hasFlag(PLATING));
      if (!attached) return 'Nothing to attach the mod to!';
    }
    for (const bp of partsOf(it)) {
      const mods = worn.filter((e) => covers(e, bp) && e.hasFlag(MOD)).length;
      if (mods >= (bp === 'torso' ? 3 : 2)) return "Can't wear any more mods on that body part!";
    }
  }
  return null;
}

/** The single use_action of `type` an item has, if any. */
function actionOf(it: Item, type: string): UseAction | undefined {
  return useActions(it.def).find((u) => u.type === type);
}

/**
 * iuse_transform::use for the power armor actions. `bypass` is set_transformed_iuse::bypass: the
 * exoskeleton switching its pieces, which skips the "Activate via main piece." restriction.
 */
function transform(c: Character, it: Item, ua: UseAction): ActionResult {
  // Fail loudly on transform features power armor JSON doesn't use, instead of ignoring them.
  for (const k of ['need_charges', 'transform_charges', 'need_fire', 'container', 'ammo_qty', 'random_ammo_qty', 'countdown', 'need_wielding', 'qualities_needed'])
    if (ua[k] !== undefined) throw new Error(`${ua.type} on ${it.typeId}: "${k}" is not supported`);
  const possess = c.inv.has(it);
  const name = it.name();
  if (possess && ua.need_worn && !c.inv.worn.includes(it)) return fail(c, `You need to wear the ${name} before activating it.`);
  const target = ua.target as string;
  if (!c.data.items[target]) throw new Error(`${ua.type} target ${target} missing for ${it.typeId}`);
  const msg = possess && ua.msg ? fill(cddaText(ua.msg), name) : '';
  if (msg) c.msg(msg);
  it.convert(target);
  it.active = !!ua.active;
  return { ok: true, msg, moves: (ua.moves as number | undefined) ?? 0 };
}

function fail(c: Character, msg: string): ActionResult {
  c.msg(msg, 'c_light_red');
  return { ok: false, msg, moves: 0 };
}

/** Switch every worn `flag` piece whose active state equals `wasActive` (set_transform's loop). */
function switchPieces(c: Character, flag: string, wasActive: boolean): void {
  for (const e of [...c.inv.worn]) {
    if (!e.hasFlag(flag) || e.active !== wasActive) continue;
    const ua = actionOf(e, 'set_transformed');
    if (!ua) throw new Error(`${e.typeId}: expected a set_transformed use_action`);
    transform(c, e, ua);
  }
}

/** item::units_remaining for the set_charges check without an interface: own charge + carried UPS. */
function unitsRemaining(c: Character, it: Item): number {
  const own = it.ammoRemaining();
  return own + (isPowerArmor(it) || it.hasFlag('USE_UPS') ? c.inv.upsCharges() : 0);
}

/** set_transform_iuse::use: the exoskeleton's Activate / Turn off. */
export function useSetTransform(c: Character, it: Item, ua: UseAction): ActionResult {
  const setCharges = Math.max(0, Number(ua.set_charges ?? 0));
  if (setCharges > 0) {
    const chargesMsg = fill(ua.set_charges_msg !== undefined ? cddaText(ua.set_charges_msg) : 'The %s is empty!', it.name());
    const iface = armorInterface(c);
    // BN: with a powered interface only bionic power counts here (Character::has_power), even if a
    // UPS is carried.
    const short = isPowerArmor(it) && iface ? !(iface.power() > 0) : unitsRemaining(c, it) < setCharges;
    if (short) {
      // What it takes and where you saw some (reloadhelp.ts), as for any tool that won't switch on.
      const why = c.inv.has(it) && !(isPowerArmor(it) && iface) ? explainNoPower(it, c.inv.allItems(), reloadHintsFor(c)) : '';
      return fail(c, [chargesMsg, why].filter(Boolean).join(' '));
    }
  }
  const r = transform(c, it, ua);
  if (!r.ok) return r;
  switchPieces(c, String(ua.flag), !!ua.turn_off);
  return r;
}

/** set_transformed_iuse::use: a piece the exoskeleton switches. */
export function useSetTransformed(c: Character, it: Item, ua: UseAction): ActionResult {
  // `restricted` defaults to true and no BN item sets it false.
  if (ua.restricted !== false) return fail(c, 'Activate via main piece.');
  return transform(c, it, ua);
}

/** Pay one kJ of `it`'s draw: own charge, then the armor interface (power armor), then a UPS. */
function payKj(c: Character, it: Item): boolean {
  if (it.ammoRemaining() > 0) return it.ammoConsume(1) > 0;
  const iface = isPowerArmor(it) ? armorInterface(c) : null;
  if (iface) {
    const cost = 1 / iface.efficiency();
    if (iface.power() >= cost) {
      iface.drain(cost);
      return true;
    }
  }
  if (it.hasFlag('USE_UPS') && c.inv.upsCharges() >= 1) return c.inv.useUpsCharges(1) >= 1;
  return false;
}

/** process_tool's out-of-power branch: message, pieces off, the item reverts. */
function runOut(c: Character, it: Item): void {
  if (it.hasFlag('USE_UPS')) c.msg(`You need a UPS or Bionic Power Interface to run the ${it.name()}!`, 'c_yellow');
  const st = actionOf(it, 'set_transform');
  if (st) switchPieces(c, String(st.flag), true);
  const revert = it.def.revert_to;
  if (revert) {
    if (!c.data.items[revert]) throw new Error(`revert_to ${revert} missing for ${it.typeId}`);
    it.convert(revert);
  }
  it.active = false;
}

/**
 * Inventory.activeProcessors entry: handles active power armor (and restricted set_transformed
 * pieces) each frame. Returns false for everything else.
 */
export function processPowerArmor(c: Character, it: Item, dt: number): boolean {
  const piece = actionOf(it, 'set_transformed');
  if (piece && piece.restricted !== false) {
    const dep = String(piece.dependencies ?? EXO);
    if (!c.inv.worn.some((e) => e.active && e.hasFlag(dep))) {
      transform(c, it, piece);
      return true;
    }
  }
  if (!isPowerArmor(it)) return false;
  const w = powerDrawW(it.def.power_draw);
  if (w <= 0) return true;
  // Deterministic stand-in for BN's x_in_y rounding of the sub-kJ remainder: the fraction is a
  // debt kept on the item, paid once it reaches a whole kJ (also across on/off toggles).
  let owed = Number(it.vars[DRAW_VAR] ?? 0) + (w * dt) / 1000;
  while (owed >= 1 && it.active) {
    owed -= 1;
    if (!payKj(c, it)) runOut(c, it);
  }
  if (owed > 1e-9) it.vars[DRAW_VAR] = owed;
  else delete it.vars[DRAW_VAR];
  return true;
}

/** Tooltip line: is this power armor piece running, and on what. */
export function powerArmorStatusLine(c: Character, it: Item): string | null {
  if (!isPowerArmor(it)) return null;
  const worn = c.inv.worn.includes(it);
  if (actionOf(it, 'set_transformed')) {
    return it.active ? 'On: runs while the exoskeleton is on.' : 'Switches on with a running power armor exoskeleton: activate the exoskeleton.';
  }
  if (!actionOf(it, 'set_transform')) return null;
  if (!it.active) return worn ? 'Off: Activate it to power the suit from a UPS you carry or a Power Armor Interface CBM.' : 'Wear it, then Activate it to power the suit.';
  const kw = powerDrawW(it.def.power_draw) / 1000;
  const iface = armorInterface(c);
  if (iface && iface.power() >= 1 / iface.efficiency())
    return `On: draws ${kw} kJ/s from your bionic power through your armor interface (${(kw / iface.efficiency()).toFixed(2)} kJ/s of bionic power).`;
  const ups = c.inv.upsCharges();
  if (it.hasFlag('USE_UPS') && ups >= 1) return `On: draws ${kw} kJ/s from your UPS (${ups} kJ left).`;
  return 'On, but nothing can power it: it will shut down.';
}

/**
 * Hook power armor into a character: wear rules, use actions, per-frame draw. The suits' relic
 * passive effects (STRENGTH, CLIMATE_CONTROL…) come through src/game/relicEnchant.ts like any
 * other item's.
 */
export function installPowerArmor(c: Character): void {
  const inv = c.inv;
  inv.wearChecks.push((it) => powerArmorWearBlocker(inv.worn, it));
  inv.useHandlers.set('set_transform', (it, ua) => useSetTransform(c, it, ua));
  inv.useHandlers.set('set_transformed', (it, ua) => useSetTransformed(c, it, ua));
  inv.activeProcessors.push((it, dt) => processPowerArmor(c, it, dt));
}
