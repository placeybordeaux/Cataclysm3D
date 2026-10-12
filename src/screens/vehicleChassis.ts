import type { Game } from '../game/game';
import { Item } from '../game/item';
import { chassisCells, chassisReasons, chassisRequirement, chassisSitePlan, continueChassis, cancelChassis, startChassis, type ChassisPlan } from '../game/vehicleChassis';
import { TEMPLATES, type TemplateId } from '../game/chassis/templates';
import { button, h, openPanel } from '../ui2';
import { section } from './common';
import './vehicleWork.css';

export function openVehicleChassisPanel(game: Game): void {
  const panel = openPanel({ id: 'vehicle-chassis', group: 'craft', title: 'Build a vehicle chassis', width: 'min(820px,94vw)', pauses: true, onKey });
  panel.el.classList.add('ix-vehicle-work');
  const x = game.player.tileX + 2, y = game.player.tileY, z = game.player.z;
  let template: TemplateId = 'frame';
  let frame = Object.values(game.vehicles?.vdata.parts ?? {}).find(p => p.id === 'frame_cross')?.id ?? '';
  let name = '';
  const content = h('div'); panel.body.append(content);
  function onKey(e: KeyboardEvent): boolean {
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement && e.key === 'Enter') { active.click(); return true; }
    if (active instanceof HTMLSelectElement && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      active.selectedIndex = e.key === 'Home' ? 0 : e.key === 'End' ? active.options.length-1 : Math.max(0, Math.min(active.options.length-1, active.selectedIndex + (e.key === 'ArrowDown' ? 1 : -1)));
      const label = active.getAttribute('aria-label'); active.dispatchEvent(new Event('change'));
      content.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)?.focus(); return true;
    }
    if (e.key === 'Tab') {
      const nodes = [...content.querySelectorAll<HTMLElement>('button:not(:disabled),select,input')];
      const i = nodes.indexOf(active as HTMLElement);
      nodes[(i + (e.shiftKey ? -1 : 1) + nodes.length) % nodes.length]?.focus(); return true;
    }
    return false;
  }
  function draw() {
    const plan: ChassisPlan = { template, frame, name, elapsed: 0 };
    const req = chassisRequirement(game, plan);
    const errors = chassisReasons(game, plan, x, y, z);
    const templateSelect = h('select', { attrs: { 'aria-label': 'Chassis template' } });
    for (const t of Object.values(TEMPLATES)) templateSelect.append(h('option', { attrs: { value: t.id }, text: t.name }));
    templateSelect.value = template; templateSelect.onchange = () => { template = templateSelect.value as TemplateId; draw(); };
    const frameSelect = h('select', { attrs: { 'aria-label': 'Initial frame' } });
    for (const p of Object.values(game.vehicles?.vdata.parts ?? {}).filter(p => p.location === 'structure' && p.flags.includes('INITIAL_PART')))
      frameSelect.append(h('option', { attrs: { value: p.id }, text: p.name }));
    frameSelect.value = frame; frameSelect.onchange = () => { frame = frameSelect.value; draw(); };
    const nameInput = h('input', { attrs: { 'aria-label': 'Vehicle name', placeholder: 'Vehicle name', value: name } });
    nameInput.onchange = () => { name = nameInput.value; draw(); };
    const sites: HTMLElement[] = [];
    for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) for (const item of game.map.itemsAt(game.player.tileX+dx, game.player.tileY+dy, z)) {
      if (!(item instanceof Item)) continue;
      const p = chassisSitePlan(item); if (!p) continue;
      const sx = game.player.tileX+dx, sy = game.player.tileY+dy;
      const why = chassisReasons(game, p, sx, sy, z, item);
      sites.push(h('div', {}, h('p', { text: `${p.name || TEMPLATES[p.template].name}: ${Math.round(p.elapsed)} / ${Math.round(chassisRequirement(game,p)?.seconds ?? 0)} game seconds (${sx},${sy}). ${why.join('; ')}` }),
        button('Resume chassis', () => { if (continueChassis(game,item,sx,sy,z)) panel.close(); }, { disabled: why.length ? why.join('; ') : undefined }),
        button('Cancel and return reserved supplies', () => { if (cancelChassis(game,item,sx,sy,z)) draw(); })));
    }
    content.replaceChildren(h('p', { text: `Build in a clear ground-level garage. The footprint starts two tiles east of you (${x},${y}) and extends east and south. Supplies move into an unfinished site; interruption keeps progress. Cancellation returns components; spent tool energy stays spent.` }),
      h('div', {}, templateSelect, frameSelect, nameInput),
      h('p', { text: `${chassisCells(template).length} frames. ${req ? Math.round(req.seconds) : '?'} game seconds. ${TEMPLATES[template].blurb}` }),
      ...errors.map(text => h('p', { class: 'ui2-small', text })),
      button('Reserve supplies and build chassis', () => { if (startChassis(game, plan, x, y, z)) panel.close(); }, { disabled: errors.length ? errors.join('; ') : undefined }),
      section('Unfinished chassis nearby'), ...sites);
  }
  draw();
}
