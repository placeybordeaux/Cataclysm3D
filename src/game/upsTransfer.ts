import { loadAmmo, type Item } from './item';

/**
 * Carried UPS → carried UPS-charged devices (BN `Character::process_items`, character_turn.cpp).
 *
 * BN units, read from the loader rather than assumed:
 * - `ups_recharge_rate` (item_factory.cpp load_tool; default 5 in itype.h `islot_tool`) is the
 *   most *useful* charges one UPS hands out per turn. A BN turn is one second (calendar.h:
 *   `from_turns` and `from_seconds` are the same duration). UPS_off: 5/s; adv_UPS_off: 10/s.
 * - `ups_eff_mult` (default 1; adv_UPS_off 2) multiplies the UPS's own charges into useful
 *   charges: `charges_of(itype_UPS)` counts `ammo_remaining * ups_eff_mult` and
 *   `Character::use_charges(itype_UPS, n)` removes `n / ups_eff_mult` real charges.
 * - One battery charge is 1 kJ.
 *
 * Conservation is in useful kJ: for every UPS, `stored * ups_eff_mult` falls by exactly what the
 * devices gain. There is no loss term in BN; the "efficiency" of the advanced UPS is that each of
 * its charges is worth `ups_eff_mult` useful kJ. Nothing is delivered without being drawn.
 *
 * Adaptations: BN rounds `used % ups_eff_mult` randomly (x_in_y); this port keeps the exact
 * fraction as `vars.recharge_kj` on the actual battery (the UPS's magazine, or the integral
 * UPS/device), the same credit the vehicle chargers use (recharging.ts), so it survives saves.
 * BN's `use_charges` drains UPSes in visit order regardless of which one earned the turn's
 * budget; here each UPS pays only for the useful charge it contributed.
 */

/** BN itype.h islot_tool defaults. */
export const UPS_DEFAULT_RECHARGE_RATE = 5;
export const UPS_DEFAULT_EFF_MULT = 1;

const EPS = 1e-9;

/** The item actually holding the charge: an installed magazine, else the item itself. */
export function energyStorage(it: Item): Item {
  return it.magazine ?? it;
}
function credit(storage: Item): number {
  return Math.max(0, Number(storage.vars.recharge_kj) || 0);
}
function setCredit(storage: Item, kj: number): void {
  // An exact zero is removed so a topped-up battery stacks with its siblings again.
  if (kj < EPS) delete storage.vars.recharge_kj;
  else storage.vars.recharge_kj = kj;
}
/** Whole charges plus the saved fractional credit, in kJ. */
export function storedEnergy(storage: Item): number {
  return storage.ammoRemaining() + credit(storage);
}
/** Room for more battery energy, in kJ (0 when it holds something else). */
export function energyRoom(storage: Item): number {
  const loaded = storage.ammoData();
  if (loaded && loaded.id !== 'battery') return 0;
  if (!storage.ammoTypes().includes('battery')) return 0;
  return Math.max(0, storage.ammoCapacity() - storedEnergy(storage));
}
/** Remove exactly `kj` from a battery, breaking a whole charge into credit when needed. */
export function drawEnergy(storage: Item, kj: number): void {
  if (kj <= 0) return;
  const have = storedEnergy(storage);
  if (kj > have + EPS) throw new Error(`drawEnergy ${kj} kJ from ${storage.typeId} holding ${have}`);
  const c = credit(storage);
  if (kj <= c + EPS) { setCredit(storage, c - kj); return; }
  const whole = Math.min(storage.ammoRemaining(), Math.ceil(kj - c - EPS));
  const consumed = storage.ammoConsume(whole);
  setCredit(storage, Math.max(0, c + consumed - kj));
}
/** Add exactly `kj` (which must fit) to a battery; whole kJ become charges, the rest credit. */
export function addEnergy(storage: Item, kj: number): void {
  if (kj <= 0) return;
  if (kj > energyRoom(storage) + EPS) throw new Error(`addEnergy ${kj} kJ into ${storage.typeId} with room ${energyRoom(storage)}`);
  const total = credit(storage) + kj;
  const added = loadAmmo(storage, 'battery', Math.floor(total + EPS));
  setCredit(storage, Math.max(0, total - added));
}

/** The character's belongings in BN process_items order: wielded, carried, then worn. */
export interface Belongings {
  wielded: Item | null;
  carried: readonly Item[];
  worn: readonly Item[];
}
/**
 * Every item on the character except unfinished crafts and everything escrowed inside them
 * (components of an in-progress craft are not yours to draw from or charge; npcneeds.ts prunes
 * the same way). Order: wielded, carried, worn, each followed by its contents.
 */
export function usableBelongings(b: Belongings): Item[] {
  const out: Item[] = [];
  forEachUsable(b, it => { out.push(it); });
  return out;
}
/** usableBelongings without the array: this runs every frame for every character. */
export function forEachUsable(b: Belongings, fn: (it: Item) => void): void {
  const visit = (it: Item) => {
    if (it.isCraft()) return;
    fn(it);
    for (const child of it.allContents()) visit(child);
  };
  if (b.wielded) visit(b.wielded);
  for (const it of b.carried) visit(it);
  for (const it of b.worn) visit(it);
}

export function isUps(it: Item): boolean {
  return it.hasFlag('IS_UPS');
}
export function upsEffMult(ups: Item): number {
  const m = ups.def.ups_eff_mult as number | undefined;
  if (m === undefined) return UPS_DEFAULT_EFF_MULT;
  if (!Number.isFinite(m) || m <= 0) throw new Error(`${ups.typeId}: bad ups_eff_mult ${m}`);
  return m;
}
export function upsRechargeRate(ups: Item): number {
  const r = ups.def.ups_recharge_rate as number | undefined;
  if (r === undefined) return UPS_DEFAULT_RECHARGE_RATE;
  if (!Number.isFinite(r) || r < 0) throw new Error(`${ups.typeId}: bad ups_recharge_rate ${r}`);
  return r;
}
/** Useful kJ a UPS can still give (BN charges_of(itype_UPS) for one UPS). */
export function upsUsefulEnergy(ups: Item): number {
  return storedEnergy(energyStorage(ups)) * upsEffMult(ups);
}
/** Draw `useful` kJ from one UPS; it gives up `useful / ups_eff_mult` of its own charge. */
function drawUseful(ups: Item, useful: number): void {
  drawEnergy(energyStorage(ups), useful / upsEffMult(ups));
}

/** Total useful UPS charge carried, rounded down so callers never act on a fraction. */
export function carriedUpsCharges(items: readonly Item[]): number {
  let n = 0;
  for (const it of items) if (isUps(it)) n += upsUsefulEnergy(it);
  return Math.floor(n + EPS);
}
/** Draw up to `n` useful charges from carried UPSes in order (BN use_charges(itype_UPS)). */
export function drawCarriedUps(items: readonly Item[], n: number): number {
  let left = n;
  for (const it of items) {
    if (left <= EPS) break;
    if (!isUps(it)) continue;
    const take = Math.min(left, upsUsefulEnergy(it));
    if (take <= 0) continue;
    drawUseful(it, take);
    left -= take;
  }
  return n - Math.max(0, left);
}

/**
 * BN needs_elec_charges plus the USE_UPS gate: a device that runs on a UPS, is not full, and
 * either has no magazine slot or holds a RECHARGE magazine. A device whose magazine well is
 * empty is skipped: BN ammo_set would conjure a default magazine, which would create an item.
 */
export function upsChargeTarget(it: Item): Item | null {
  if (!it.hasFlag('USE_UPS') || isUps(it)) return null;
  const mag = it.magazineCurrent();
  if (mag && !mag.hasFlag('RECHARGE')) return null;
  if (!mag && it.takesMagazines()) return null;
  const storage = energyStorage(it);
  return energyRoom(storage) > EPS ? storage : null;
}

export interface UpsTransferResult {
  /** Useful kJ moved into devices. */
  delivered: number;
  /** Devices that wanted charge this step. */
  wanting: Item[];
  /** Devices that received some. */
  charged: Item[];
}

/**
 * Move charge from carried UPSes into carried UPS-charged devices for `seconds` of game time.
 * Each UPS offers at most `ups_recharge_rate * seconds` useful kJ and never more than it holds;
 * devices fill in order (wielded, carried incl. nested, worn) up to capacity.
 */
export function transferCarriedUps(b: Belongings, seconds: number): UpsTransferResult {
  const res: UpsTransferResult = { delivered: 0, wanting: [], charged: [] };
  if (!(seconds > 0)) return res;
  let targets: { device: Item; storage: Item }[] | null = null;
  forEachUsable(b, it => {
    const storage = upsChargeTarget(it);
    if (storage) (targets ??= []).push({ device: it, storage });
  });
  if (!targets) return res;
  const wanted: { device: Item; storage: Item }[] = targets;
  res.wanting = wanted.map(t => t.device);
  const sources: { ups: Item; budget: number }[] = [];
  forEachUsable(b, ups => {
    if (isUps(ups)) sources.push({ ups, budget: Math.min(upsUsefulEnergy(ups), upsRechargeRate(ups) * seconds) });
  });
  let s = 0;
  for (const t of wanted) {
    let got = 0;
    for (let room = energyRoom(t.storage); room > EPS && s < sources.length;) {
      const src = sources[s];
      const e = Math.min(room, src.budget);
      if (e > 0) {
        drawUseful(src.ups, e);
        addEnergy(t.storage, e);
        src.budget -= e;
        room -= e;
        got += e;
      }
      if (src.budget <= EPS) s++;
    }
    if (got > 0) res.charged.push(t.device);
    res.delivered += got;
  }
  return res;
}

/** The belongings of anything with an Inventory-shaped `wielded`/`carried()`/`worn`. */
export function belongingsOf(inv: { wielded: Item | null; carried(): readonly Item[]; worn: readonly Item[] }): Belongings {
  return { wielded: inv.wielded, carried: inv.carried(), worn: inv.worn };
}

const kj = (n: number) => (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1));

/** Activate-menu text for TOGGLE_UPS_CHARGING, by the item's current state. */
export function upsToggleLabel(it: Item): string {
  return it.flags.includes('USE_UPS') ? 'Disable UPS charging' : 'Enable UPS charging';
}

/**
 * One tooltip line about UPS charging, or null when the item has nothing to do with it.
 * For a UPS: what it still holds and how fast it feeds devices. For a device: whether a carried
 * UPS is charging it right now and, if not, why.
 */
export function upsStatusLine(it: Item, b: Belongings): string | null {
  // Tooltips build this for every listed item: bail out before walking the belongings.
  if (!isUps(it) && !it.hasFlag('USE_UPS') && it.def.use_action === undefined) return null;
  if (isUps(it)) {
    const m = upsEffMult(it);
    const eff = m !== 1 ? ` UPS efficiency ×${m}.` : '';
    return `UPS: ${kj(upsUsefulEnergy(it))} kJ usable; charges UPS-powered devices you carry at up to ${kj(upsRechargeRate(it))} kJ/s.${eff}`;
  }
  const toggles = it.def.use_action !== undefined && JSON.stringify(it.def.use_action).includes('TOGGLE_UPS_CHARGING');
  if (!it.hasFlag('USE_UPS')) return toggles ? 'UPS charging is off: Use ▸ Enable UPS charging to top it up from a UPS you carry.' : null;
  if (it.isCraft()) return null;
  const storage = energyStorage(it);
  const mine = usableBelongings(b);
  if (!mine.includes(it)) return 'Charges from a UPS you carry.';
  const mag = it.magazineCurrent();
  if (mag && !mag.hasFlag('RECHARGE')) return `Its ${mag.name()} can't be recharged from a UPS.`;
  if (!mag && it.takesMagazines()) return 'No battery installed: a UPS can only charge a rechargeable one.';
  if (storage.ammoCapacity() <= 0) return 'Runs directly on a UPS you carry.';
  if (energyRoom(storage) <= EPS) return 'Fully charged.';
  const ups = mine.filter(isUps);
  if (!ups.length) return 'Not charging: you carry no UPS.';
  const useful = ups.reduce((n, u) => n + upsUsefulEnergy(u), 0);
  if (useful <= EPS) return 'Not charging: your UPS is out of charge.';
  const credit = storedEnergy(storage) - storage.ammoRemaining();
  return `Charging from your UPS (${storage.ammoRemaining()}/${storage.ammoCapacity()}${credit > 0.05 ? ` +${kj(credit)} kJ` : ''}).`;
}
