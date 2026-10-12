import type { Game } from '../game/game';
import { has, type Vehicle, type VehiclePart } from '../game/vehicle';
import { isColdCargo, FRIDGE_C, FREEZER_C } from '../game/vehicleStorage';
import { faucetTanks, startFaucetDrink, startFaucetFill, vehicleFacilityReason } from '../game/vehicleFacilities';
import { siphonTargets, tankMlPerCharge } from '../game/siphoning';
import { button, h, openPanel } from '../ui2';
import { cddaText } from '../game/units';
import { openCraftingScreen } from '../ui/craft2/crafting_screen';
import { openRest } from '../ui/rest_ui';
import { vehicleBedding, vehicleMountSpot, vehicleYouAreIn } from '../game/vehicleRest';
import { playerComfort } from '../game/rest';

export function openVehicleFacilities(game: Game, v: Vehicle, openCargo?: (part: VehiclePart) => void): void {
  const panel = openPanel({ id: 'vehicle.facilities', group: 'vehicle', title: `${v.name}: facilities`, width: 'min(650px, 94vw)', pauses: true,
    onKey: e => {
      if (e.key === 'Enter' && document.activeElement instanceof HTMLButtonElement && panel.body.contains(document.activeElement)) { document.activeElement.click(); return true; }
      if (e.key === 'Tab') {
        const buttons = [...panel.body.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(i + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus(); return true;
      }
      return false;
    },
  });
  panel.body.append(h('p', { text: 'Use installed tools, workbenches, beds, cold storage and clean water from faucets without a hose. Facilities are reachable from the driver’s seat, including while moving; outside, stand near the facility of a parked vehicle. Beds and seats need you inside, stopped.' }));
  appendSleeping(game, v, panel);
  for (const part of v.parts.filter(isColdCargo)) {
    const freezer = has(part, 'FREEZER'), flag = freezer ? 'FREEZER' : 'FRIDGE';
    const reason = vehicleFacilityReason(game, v, part, flag);
    const watts = Math.max(0, -(part.def.epower ?? 0));
    const powered = part.enabled && part.hp > 0 && v.fuelLeft('battery') > 0;
    const status = part.hp <= 0 ? 'Broken' : part.enabled ? powered ? 'Cooling' : 'Enabled, no battery power' : 'Off';
    panel.body.append(h('h3', { text: part.def.name }), h('p', { text: `${status} · ${watts} W · ${freezer ? FREEZER_C : FRIDGE_C}°C maximum when powered · ${part.items.length} cargo item${part.items.length === 1 ? '' : 's'}.` }));
    if (reason) panel.body.append(h('p', { text: reason }));
    panel.body.append(button(`${part.enabled ? 'Disable' : 'Enable'} ${part.def.name}`, () => {
      const reason = vehicleFacilityReason(game, v, part, flag);
      if (reason) { game.message(reason, 'c_yellow'); return; }
      part.enabled = !part.enabled; v.version++;
      panel.close(); openVehicleFacilities(game, v, openCargo);
    }, { disabled: reason ?? false }));
    if (openCargo) panel.body.append(button(`Open ${part.def.name} cargo`, () => { panel.close(); openCargo(part); }, { disabled: reason ?? false }));
  }
  for (const part of v.parts.filter(p => has(p, 'CRAFTER'))) {
    panel.body.append(h('h3', { text: part.def.name }));
    const reason = vehicleFacilityReason(game, v, part, 'CRAFTER');
    const tools = (part.def.integratedTools ?? []).map(id => cddaText(game.data.items[id]?.name) || id);
    panel.body.append(h('p', { text: reason ?? `${tools.join(', ')} · ${Math.floor(v.fuelLeft('battery'))} shared battery charges available (1 kJ each).` }));
    if (!reason && tools.length) panel.body.append(button('Craft with installed tools…', () => { panel.close(); openCraftingScreen(game); }));
  }
  for (const part of v.parts.filter(p => has(p, 'WORKBENCH'))) {
    const wb = part.def.workbench;
    panel.body.append(h('h3', { text: part.def.name }));
    const reason = part.hp <= 0 ? 'This facility is broken or missing.' : vehicleFacilityReason(game, v, part, 'WORKBENCH');
    if (wb) panel.body.append(h('p', { text: `Workbench: ${Math.round(wb.multiplier * 100)}% crafting speed for work up to ${wb.mass / 1000} kg and ${wb.volume / 1000} L; heavier or bulkier work goes slower. The crafting screen picks the best bench in reach.` }));
    if (reason) panel.body.append(h('p', { text: reason }));
    else panel.body.append(button(`Craft at the ${part.def.name}…`, () => { panel.close(); openCraftingScreen(game); }));
  }
  for (const faucet of v.parts.filter(p => has(p, 'FAUCET'))) {
    panel.body.append(h('h3', { text: faucet.def.name }));
    const reason = vehicleFacilityReason(game, v, faucet, 'FAUCET');
    if (reason) { panel.body.append(h('p', { text: reason })); continue; }
    const tanks = faucetTanks(v);
    if (!tanks.length) panel.body.append(h('p', { text: 'No clean water in an intact tank.' }));
    for (const tank of tanks) {
      panel.body.append(h('p', { text: `${tank.def.name} (${tank.mx},${tank.my}): ${(tank.charges / 1000).toFixed(2)} L clean water` }));
      panel.body.append(button('Drink one portion from the faucet (250 ml)', () => {
        if (startFaucetDrink(game, v, faucet, tank)) panel.close();
      }));
      const targets = siphonTargets(game, v, tank);
      if (!targets.length) panel.body.append(h('p', { text: 'Carry a sealed container with room, or set a watertight container on nearby ground.' }));
      for (const target of targets) {
        const litres = Math.min(tank.charges, target.room * tankMlPerCharge(v, tank)) / 1000;
        panel.body.append(button(`Fill ${target.item.baseName()} (${target.where}, ${litres.toFixed(2)} L)`, () => {
          if (startFaucetFill(game, v, faucet, tank, target.item)) panel.close();
        }));
      }
    }
  }
}

/** Beds and seats (BN comfort and bedding warmth), and the way into the Rest window. */
function appendSleeping(game: Game, v: Vehicle, panel: { body: HTMLElement; close(): void }): void {
  const mounts = new Map<string, VehiclePart>();
  for (const q of v.parts) if (has(q, 'BED') && !mounts.has(`${q.mx},${q.my}`)) mounts.set(`${q.mx},${q.my}`, q);
  if (!mounts.size) return;
  panel.body.append(h('h3', { text: 'Beds' }));
  // One line per kind of spot ("bed ×5: comfort 4…"): an RV has many identical beds.
  const lines = new Map<string, number>();
  for (const q of mounts.values()) {
    const s = vehicleMountSpot(v, q.mx, q.my);
    const warm = vehicleBedding(s).bedding;
    const text = q.hp <= 0 ? `${q.def.name}: broken` : `${q.def.name}: comfort ${s.comfort}, bedding ${warm >= 0 ? '+' : ''}${warm.toFixed(1)} °C`;
    lines.set(text, (lines.get(text) ?? 0) + 1);
  }
  for (const [text, n] of lines) panel.body.append(h('p', { text: n > 1 ? text.replace(':', ` ×${n}:`) + '.' : text + '.' }));
  const inside = vehicleYouAreIn(game)?.v === v;
  const ci = inside ? playerComfort(game) : null;
  const reason = !inside ? `Get into the ${v.name} to sleep in it.` : ci?.refuse;
  if (reason) panel.body.append(h('p', { text: reason }));
  panel.body.append(button(ci?.vehicle ? `Rest on the ${ci.vehicle.board?.def.name ?? 'seat'}…` : 'Rest…', () => { panel.close(); openRest(game, 'sleep'); }, { disabled: reason ?? false }));
}
