import { loadAmmo, type Item } from './item';
import { has, type Vehicle } from './vehicle';

/** BN map.cpp process_vehicle_items: a charger serves cargo on its own mount.
 * Accumulate fractional kJ instead of BN's random rounding, so progress survives saves
 * and does not depend on frame rate. One battery ammunition charge represents 1 kJ.
 */
export function rechargeVehicleCargo(v: Vehicle, seconds: number): number {
  if (seconds <= 0) return 0;
  let transferred = 0;
  const visit = (it: Item, watts: number): void => {
    const candidate = it.hasFlag('RECHARGE') || it.hasFlag('USE_UPS');
    const storage = it.magazine ?? it;
    // Never manufacture a missing magazine or recharge disposable/plutonium cells.
    const eligible = candidate && (!it.magazine || it.magazine.hasFlag('RECHARGE'))
      && storage.ammoTypes().includes('battery') && !(!it.magazine && it.takesMagazines());
    const room = eligible ? storage.ammoCapacity() - storage.ammoRemaining() : 0;
    if (room > 0 && (!storage.ammoData() || storage.ammoData()?.id === 'battery')) {
      const credit = Math.max(0, Number(storage.vars.recharge_kj) || 0);
      const energy = Math.min(room - credit, watts * seconds / 1000, v.fuelLeft('battery'));
      if (energy > 0) {
        const spent = v.drainFuel('battery', energy);
        const total = credit + spent;
        const added = loadAmmo(storage, 'battery', Math.floor(total + 1e-9));
        storage.vars.recharge_kj = Math.max(0, total - added);
        transferred += spent;
      }
    }
    // A magazine already charged through its host must not be charged twice.
    if (!eligible && it.magazine) visit(it.magazine, watts);
    for (const child of it.contents) visit(child, watts);
  };
  for (const cargo of v.parts) {
    if (cargo.hp <= 0 || !has(cargo, 'CARGO')) continue;
    const charger = v.partsAt(cargo.mx, cargo.my).find(p => has(p, 'RECHARGE') && p.enabled && p.hp > 0);
    if (!charger || (charger.def.bonus ?? 0) <= 0) continue;
    for (const it of cargo.items) visit(it, charger.def.bonus!);
  }
  return transferred;
}
