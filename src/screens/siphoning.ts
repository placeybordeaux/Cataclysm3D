import { cddaText } from '../game/units';
import type { Game } from '../game/game';
import type { Vehicle, VehiclePart } from '../game/vehicle';
import { siphonReason, siphonTargets, siphonVehicleTargets, startSiphoning, startSiphoningToVehicle, tankMlPerCharge } from '../game/siphoning';
import { h, button, openPanel } from '../ui2';
import { distinctVehicleNames } from '../game/vehicleNames';

export function openSiphonPanel(game: Game, vehicle: Vehicle, tank: VehiclePart): void {
  const name = cddaText(game.data.items[tank.fuelType ?? '']?.name) || 'liquid';
  const panel = openPanel({ id: 'siphon', group: 'vehicle', title: `Siphon ${name}`, width: 'min(650px, 94vw)', pauses: true,
    onKey: e => {
      if (e.key === 'Enter' && document.activeElement instanceof HTMLButtonElement) { document.activeElement.click(); return true; }
      if (e.key === 'Tab') {
        const choices = [...panel.body.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = choices.indexOf(document.activeElement as HTMLButtonElement);
        choices[(index + (e.shiftKey ? -1 : 1) + choices.length) % choices.length]?.focus();
        return true;
      }
      return false;
    },
  });
  const reason = siphonReason(game, vehicle, tank);
  panel.body.append(h('p', { text: `${(tank.charges / 1000).toFixed(2)} L in this tank. A hose transfers 0.67 L per game second. Movement interrupts siphoning.` }));
  if (reason) { panel.body.append(h('p', { text: reason })); return; }
  const targets = siphonTargets(game, vehicle, tank);
  const vehicles = siphonVehicleTargets(game, vehicle, tank);
  // two Cars (or the Car you're siphoning from and another) read the same: say which
  const names = distinctVehicleNames(game, vehicles.map(t => t.vehicle), [vehicle]);
  for (const t of vehicles) {
    const litres = Math.min(tank.charges, t.roomMl) / 1000;
    panel.body.append(button(`Fill nearby vehicle: ${names.get(t.vehicle)} (${litres.toFixed(2)} L)`, () => {
      if (startSiphoningToVehicle(game, vehicle, tank, t.vehicle)) panel.close();
    }));
  }
  if (!targets.length && !vehicles.length) panel.body.append(h('p', { text: 'No suitable container or vehicle with room is within reach. Carry a sealed container, put a watertight bucket on nearby ground, or park the other vehicle next to this one and stand between them.' }));
  for (const target of targets) {
    const litres = Math.min(tank.charges, target.room * tankMlPerCharge(vehicle, tank)) / 1000;
    panel.body.append(button(`Fill ${target.item.baseName()} (${target.where}, ${litres.toFixed(2)} L)`, () => {
      if (startSiphoning(game, vehicle, tank, target.item)) panel.close();
    }));
  }
  // BN's liquid menu opens with its first entry highlighted: Enter takes it at once.
  panel.body.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}
