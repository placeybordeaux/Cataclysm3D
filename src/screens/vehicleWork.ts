import './vehicleWork.css';
import type { Game } from '../game/game';
import type { Vehicle } from '../game/vehicle';
import { adoptVehicle, mountReasons, projectedVehicle, queueVehicleStrip, queueVehicleWork, startVehicleWork, vehicleWorkReasons, vehicleWorkRequirement, type VehicleWorkOrder } from '../game/vehicleWork';
import { button, h, openPanel } from '../ui2';
import { section } from './common';

/** A requirements-aware queue for the selected chassis square. */
export function openVehicleWorkPanel(game: Game, v: Vehicle, mx: number, my: number): void {
  const panel = openPanel({ id: 'vehicle-work', group: 'vehicle', title: `Work on ${v.name}`, width: 'min(820px, 94vw)', pauses: true, onKey });
  panel.el.classList.add('ix-veh-win', 'ix-vehicle-work');
  let kind: VehicleWorkOrder['kind'] = 'removal';
  let part = '';
  let filter = '';
  let stripReport: string[] = [];
  const content = h('div');
  panel.body.append(content);
  function onKey(e: KeyboardEvent): boolean {
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement && (e.key === 'Enter' || e.key === ' ')) { active.click(); return true; }
    if (active instanceof HTMLSelectElement) {
      const index = active.selectedIndex;
      const next = e.key === 'ArrowDown' ? Math.min(active.options.length - 1, index + 1)
        : e.key === 'ArrowUp' ? Math.max(0, index - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? active.options.length - 1 : null;
      if (next !== null) {
        const label = active.getAttribute('aria-label');
        active.selectedIndex = next;
        active.dispatchEvent(new Event('change'));
        content.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)?.focus();
        return true;
      }
      if (e.key === 'Enter') return true;
    }
    if (e.key === 'Tab') {
      const nodes = [...content.querySelectorAll<HTMLElement>('button:not(:disabled), select, input')];
      const index = nodes.indexOf(active as HTMLElement);
      nodes[(index + (e.shiftKey ? -1 : 1) + nodes.length) % nodes.length]?.focus();
      return true;
    }
    return false;
  }
  function draw() {
    const projected = projectedVehicle(v);
    const candidates = kind === 'install'
      ? Object.values(v.vdata.parts).filter(d => !mountReasons(projected, d, mx, my).length)
      : [...projected.partsAt(mx, my)].sort((a,b)=>Number(a.def.location==='structure')-Number(b.def.location==='structure')).map(p => p.def);
    const matching = candidates.filter(d => !filter || d.name.toLowerCase().includes(filter.toLowerCase()));
    if (!matching.some(d => d.id === part)) part = matching[0]?.id ?? '';
    const pickKind = h('select', { attrs: { 'aria-label': 'Work type' } });
    for (const [id, label] of [['removal', 'Remove / salvage'], ['repair', 'Repair'], ['install', 'Install']] as const) {
      const option = h('option', { attrs: { value: id }, text: label });
      if (kind === id) option.selected = true;
      pickKind.append(option);
    }
    pickKind.onchange = () => { kind = pickKind.value as typeof kind; part = ''; draw(); };
    const search = h('input', { attrs: { type: 'search', value: filter, placeholder: 'Filter parts', 'aria-label': 'Filter vehicle parts' } });
    search.onchange = () => { filter = search.value; draw(); };
    const picker = h('select', { attrs: { 'aria-label': 'Vehicle part' } });
    for (const def of matching) {
      const option = h('option', { attrs: { value: def.id }, text: def.name });
      if (part === def.id) option.selected = true;
      picker.append(option);
    }
    picker.onchange = () => { part = picker.value; draw(); };
    const order = { kind, part, mx, my, elapsed: 0 };
    const reasons = part ? vehicleWorkReasons(game, projected, order, true) : ['No matching part for this square'];
    const req = vehicleWorkRequirement(game, projected, order);
    const jobs = v.workOrders.map((job, i) => h('div', { class: 'ix-veh-facts' },
      h('span', { text: `${i + 1}. ${job.kind}: ${v.vdata.parts[job.part]?.name ?? job.part} (${job.mx},${job.my}) — ${Math.round(job.elapsed)} / ${Math.round(vehicleWorkRequirement(game, v, job)?.seconds ?? 0)} s` }),
      h('span', { class: 'ui2-small', text: vehicleWorkReasons(game, projectedVehicle(v, v.workOrders.slice(0, i)), job).join('; ') }),
      button('Discard', () => { v.workOrders.splice(i, 1); draw(); }, { small: true, disabled: game.activities.current?.spec.target === v ? 'Stop work before editing the queue' : undefined }),
    ));
    content.replaceChildren(
      h('p', { text: `Chassis square ${mx},${my}. Nearby ground and carried supplies are available. Part work keeps BN skills, tools and material requirements.` }),
      h('p', { text: `After queued work: ${projected.parts.length} ${projected.parts.length===1?'part':'parts'}, ${projected.parts.length?Math.round(projected.mass()):0} kg (currently ${v.parts.length} ${v.parts.length===1?'part':'parts'}, ${Math.round(v.mass())} kg). Preview assumes successful jobs and empty intact installations. Check each queued job's warnings; supplies must already be available.` }),
      !v.adopted ? button('Adopt this vehicle', () => { game.message(adoptVehicle(game, v)); draw(); }, { disabled: v.locked ? 'Unlock first' : undefined }) : h('p', { text: 'Your adopted vehicle. Strip fittings first; dismantle frames at a garage. The final frame removes the empty vehicle.' }),
      button('Queue stripping fittings across vehicle', () => {
        const report = queueVehicleStrip(game, v);
        stripReport = report.blocked;
        game.message(`Queued ${report.queued} removals; ${report.blocked.length} fittings need attention.`);
        draw();
      }, { disabled: !v.adopted ? 'Adopt first' : game.activities.current?.spec.target === v ? 'Stop work before editing the queue' : undefined }),
      ...stripReport.map(reason => h('p', { class: 'ui2-small', text: reason })),
      h('div', {}, section('Plan work'), h('div', { class: 'ix-work-pickers' }, pickKind, search, picker),
        h('p', { text: req ? `Work time: ${Math.round(req.seconds)} game seconds.` : 'No work recipe.' }),
        ...reasons.map(reason => h('p', { class: 'ui2-small', text: reason })),
        button('Add to work queue', () => { game.message(queueVehicleWork(game, v, order)); draw(); }, { disabled: reasons.length ? reasons.join('; ') : undefined }),
      ),
      h('div', {}, section('Queued work'), ...jobs,
        button(v.workOrders.some(j => j.elapsed > 0) ? 'Resume queued work' : 'Start queued work', () => { if (startVehicleWork(game, v)) panel.close(); }, { disabled: !v.workOrders.length ? 'Queue work first' : undefined }),
      ),
    );
  }
  draw();
}
